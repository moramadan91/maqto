use super::{command, err, matte, media_source_key, proxy_hash, sidecar, MediaServer, R};
use ort::{session::{builder::AutoDevicePolicy, RunOptions, Session}, value::Tensor};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering::Relaxed}, Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(test)]
const Q4: &str = "model_q4f16.onnx";
const MODEL: &str = "model_fp16.onnx";
const SHORT_SIDE: usize = 518;

fn session(path: &Path, cpu: bool) -> R<Session> {
    let mut builder = Session::builder(&matte::ort_env()?).map_err(err)?;
    if cpu {
        builder = builder.with_auto_device(AutoDevicePolicy::PreferCPU).map_err(err)?;
    }
    builder.commit_from_file(path).map_err(err)
}

fn depth_size(w: usize, h: usize) -> (usize, usize) {
    // Cap very wide frames to keep the transformer attention memory bounded.
    let scale = (SHORT_SIDE as f64 / w.min(h) as f64).min((2 * SHORT_SIDE) as f64 / w.max(h) as f64);
    let dim = |v: usize| ((v as f64 * scale / 14.).round() as usize).max(1) * 14;
    (dim(w), dim(h))
}

fn infer(session: &mut Session, rgb: &[u8], (w, h): (usize, usize), options: &RunOptions) -> R<Vec<f32>> {
    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];
    let mut input = vec![0.; 3 * w * h];
    for (channel, plane) in input.chunks_exact_mut(w * h).enumerate() {
        for (value, rgb) in plane.iter_mut().zip(rgb.chunks_exact(3)) {
            *value = (rgb[channel] as f32 / 255. - mean[channel]) / std[channel];
        }
    }
    let input = Tensor::from_array(([1, 3, h, w], input)).map_err(err)?;
    let outputs = session.run_with_options(ort::inputs!["pixel_values" => input], options).map_err(err)?;
    let (shape, values) = outputs.get("predicted_depth").ok_or("Missing depth output")?.try_extract_tensor::<f32>().map_err(err)?;
    if **shape != [1, h as i64, w as i64] || values.iter().any(|x| !x.is_finite()) {
        return Err(format!("Invalid depth output {shape:?}"));
    }
    Ok(values.to_vec())
}

const MODEL_URL: &str = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/";
static MODEL_TRANSFER: Mutex<()> = Mutex::new(());
static ACTIVE: Mutex<Option<Job>> = Mutex::new(None);

fn root(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("depth"))
}

#[tauri::command]
pub fn depth_ready(app: AppHandle) -> R<bool> {
    Ok(root(&app)?.join(MODEL).is_file())
}

#[tauri::command]
pub async fn depth_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _transfer = MODEL_TRANSFER.try_lock().map_err(|_| "Depth model transfer in progress")?;
        let path = root(&app)?.join(MODEL);
        if !path.is_file() {
            matte::fetch(&app, &format!("{MODEL_URL}{MODEL}"), &path, "depth_dl")?;
        }
        Ok(())
    }).await.map_err(err)?
}

#[tauri::command]
pub fn depth_remove(app: AppHandle) -> R<()> {
    let _transfer = MODEL_TRANSFER.try_lock().map_err(|_| "Depth model transfer in progress")?;
    if ACTIVE.lock().map_err(err)?.is_some() { return Err("Depth model is in use".into()); }
    super::remove_model_file(&root(&app)?.join(MODEL))
}

#[derive(Clone)]
struct Job {
    id: String,
    stop: Arc<AtomicBool>,
    options: Arc<RunOptions>,
}

impl Job {
    fn new(id: String) -> R<Self> {
        let _env = matte::ort_env()?;
        Ok(Self { id, stop: Arc::new(AtomicBool::new(false)), options: Arc::new(RunOptions::new().map_err(err)?) })
    }

    fn check(&self) -> R<()> {
        if self.stop.load(Relaxed) { Err("cancelled".into()) } else { Ok(()) }
    }

    // a terminated ORT run errors; report that as a cancel
    fn fail(&self, e: String) -> String { if self.stop.load(Relaxed) { "cancelled".into() } else { e } }
}

#[tauri::command]
pub fn depth_cancel(job: String) {
    if let Some(active) = ACTIVE.lock().unwrap().as_ref().filter(|active| active.id == job) {
        active.stop.store(true, Relaxed);
        let _ = active.options.terminate();
    }
}

struct ActiveJob;

impl Drop for ActiveJob {
    fn drop(&mut self) { *ACTIVE.lock().unwrap() = None; }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Focus {
    x: f32,
    y: f32,
    time: f64,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Motion { ZoomIn, LeftRight, Circle }

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Effects {
    blur: f32,
    range: f32,
    progressive: bool,
    focus: Option<Focus>,
    fog: f32,
    color: [u8; 3],
    parallax: f32,
    motion: Motion,
    motion_timing: Option<Vec<f32>>,
}

#[derive(Deserialize)]
struct Upscale { path: String, width: usize, height: usize }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    path: String,
    start: f64,
    len: f64,
    still: bool,
    fps: f64,
    width: usize,
    height: usize,
    tone_map: Option<String>,
    upscale: Option<Upscale>,
    effects: Effects,
}

impl Request {
    fn animated(&self) -> bool { !self.still || self.effects.parallax > 0. }

    fn render_size(&self) -> (usize, usize) {
        self.upscale.as_ref().map_or((self.width, self.height), |v| (v.width, v.height))
    }

    fn frame_count(&self) -> usize { (self.len * self.fps - 1e-6).ceil().max(1.) as usize }

    fn cache(&self, root: &Path) -> R<(PathBuf, PathBuf)> {
        let unit = |n: f32| (0. ..=1.).contains(&n);
        let fx = &self.effects;
        let valid_size = |w: usize, h: usize| {
            (1..=16384).contains(&w) && (1..=16384).contains(&h) && w * h <= 40_000_000
        };
        let (w, h) = self.render_size();
        if !self.start.is_finite() || self.start < 0. || !self.len.is_finite() || self.len <= 0.
            || !(1. ..=240.).contains(&self.fps) || self.frame_count() > 2_000_000
            || !valid_size(self.width, self.height) || !valid_size(w, h)
            || ![fx.blur, fx.range, fx.fog, fx.parallax].into_iter().all(unit)
            || fx.focus.as_ref().is_some_and(|f| !unit(f.x) || !unit(f.y) || !f.time.is_finite())
            || fx.motion_timing.as_ref().is_some_and(|timing| timing.len() != 65 || !timing.iter().copied().all(unit))
        {
            return Err("Invalid depth effects request".into());
        }
        let source = media_source_key(&self.path)?;
        let (len, fps) = if self.still { (0, 0) } else { (self.len.to_bits(), self.fps.to_bits()) };
        let depth = proxy_hash(("v1", MODEL, source, self.start.to_bits(), len, fps, self.width, self.height, &self.tone_map));
        let timing = self.animated().then(|| (self.len.to_bits(), self.fps.to_bits()));
        let upscale = self.upscale.as_ref().map(|v| media_source_key(&v.path)).transpose()?;
        let render = proxy_hash((depth.as_str(), timing, upscale, w, h, serde_json::to_string(&self.effects).map_err(err)?));
        let ext = if self.animated() { "mp4" } else { "png" };
        Ok((root.join(format!("{depth}.mkv")), root.join(format!("{render}.{ext}"))))
    }
}

fn allow(app: &AppHandle, out: &Path) -> String {
    let path = out.to_string_lossy().into_owned();
    app.state::<Arc<MediaServer>>().allow(&path);
    path
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cache {
    path: Option<String>,
    has_map: bool,
}

#[tauri::command]
pub fn depth_cached(app: AppHandle, request: Request) -> R<Cache> {
    let (depth, out) = request.cache(&root(&app)?)?;
    Ok(Cache { path: out.is_file().then(|| allow(&app, &out)), has_map: depth.is_file() })
}

#[tauri::command]
pub async fn depth_prepare(app: AppHandle, request: Request, job: String) -> R<String> {
    let job = Job::new(job)?;
    {
        let _transfer = MODEL_TRANSFER.try_lock().map_err(|_| "Depth model transfer in progress")?;
        let mut active = ACTIVE.lock().map_err(err)?;
        if active.is_some() { return Err("A depth job is already running".into()); }
        *active = Some(job.clone());
    }
    let guard = ActiveJob;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let root = root(&app)?;
        let (depth, out) = request.cache(&root)?;
        if !out.is_file() {
            let ffmpeg = sidecar("ffmpeg");
            let progress = |stage, p| { let _ = app.emit("depthprog", json!({ "job": job.id, "stage": stage, "p": p })); };
            let work = super::upscale::Scratch::new(&root)?;
            let tmp = work.0.join("map.mkv");
            if !depth.is_file() {
                make_depth(&ffmpeg, &request, &root.join(MODEL), &tmp, &job, |p| progress("map", p))?;
                job.check()?;
                if request.cache(&root)?.0 != depth { return Err("The source changed while estimating depth".into()); }
                fs::rename(tmp, &depth).map_err(err)?;
            }
            let tmp = work.0.join(out.file_name().unwrap());
            render(&ffmpeg, &request, &depth, &tmp, &job, |p| progress("render", p))?;
            job.check()?;
            if request.cache(&root)?.1 != out { return Err("The source changed while rendering depth effects".into()); }
            fs::rename(tmp, &out).map_err(err)?;
        }
        Ok(allow(&app, &out))
    }).await.map_err(err)?
}

struct Process(Child);

impl Process {
    fn start(cmd: &mut Command) -> R<Self> { cmd.spawn().map(Self).map_err(err) }

    fn finish(&mut self) -> R<()> {
        if self.0.wait().map_err(err)?.success() { Ok(()) }
        else { Err("FFmpeg depth processing failed".into()) }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn ffmpeg(path: &Path) -> Command {
    let mut cmd = command(path);
    cmd.args(["-v", "error", "-nostdin", "-y", "-filter_threads", "2"]);
    cmd
}

fn decode_source(bin: &Path, req: &Request, size: (usize, usize), format: &str, upscale: Option<&Upscale>) -> R<Process> {
    let mut cmd = ffmpeg(bin);
    if !req.still && upscale.is_none() { cmd.args(["-ss", &format!("{:.9}", req.start)]); }
    let path = upscale.map_or(&req.path, |v| &v.path);
    cmd.args(["-i", path, "-map", "0:V:0", "-an"]);
    let mut filters = Vec::new();
    if let Some(tone_map) = req.tone_map.as_ref().filter(|_| upscale.is_none()) { filters.push(tone_map.clone()); }
    if !req.still {
        filters.push(format!("fps={:.9}:start_time=0", req.fps));
        filters.push("tpad=stop_mode=clone:stop=-1".into());
    }
    filters.push(format!("scale={}:{}:flags=bicubic", size.0, size.1));
    Process::start(cmd.args(["-vf", &filters.join(","), "-frames:v", &if req.still { "1".into() } else { req.frame_count().to_string() },
        "-pix_fmt", format, "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "pipe:1"]).stdout(Stdio::piped()))
}

fn raw_input<'a>(cmd: &'a mut Command, (w, h): (usize, usize), fps: f64, format: &str) -> &'a mut Command {
    cmd.args(["-f", "rawvideo", "-pixel_format", format, "-video_size", &format!("{w}x{h}"),
        "-framerate", &format!("{fps:.9}"), "-i", "pipe:0"])
}

fn make_depth(bin: &Path, req: &Request, model: &Path, out: &Path, job: &Job, progress: impl Fn(f64)) -> R<()> {
    job.check()?;
    if !model.is_file() { return Err("Depth Anything V2 Small is missing".into()); }
    progress(0.);
    let size = depth_size(req.width, req.height);
    let total = if req.still { 1 } else { req.frame_count() };
    let mut decoder = decode_source(bin, req, size, "rgb24", None)?;
    let mut reader = BufReader::new(decoder.0.stdout.take().unwrap());
    let mut encoder = Process::start(raw_input(&mut ffmpeg(bin), size, if req.still { 1. } else { req.fps }, "gray")
        .args(["-c:v", "ffv1", "-pix_fmt", "gray"]).arg(out).stdin(Stdio::piped()))?;
    let mut writer = BufWriter::new(encoder.0.stdin.take().unwrap());
    let mut rgb = vec![0; size.0 * size.1 * 3];
    reader.read_exact(&mut rgb).map_err(err)?;
    let mut model_session = session(model, true)?;
    let first = infer(&mut model_session, &rgb, size, &job.options).map_err(|e| job.fail(e))?;
    let mut previous = normalize(&first);
    progress(1. / total as f64);
    let mut gray = vec![0; previous.len()];
    write_depth(&mut writer, &mut gray, &previous, &previous, 0.)?;
    for frame in (1..total).step_by(2) {
        job.check()?;
        reader.read_exact(&mut rgb).map_err(err)?;
        if frame + 1 == total {
            write_depth(&mut writer, &mut gray, &previous, &previous, 0.)?;
            break;
        }
        reader.read_exact(&mut rgb).map_err(err)?;
        let mut current = normalize(&infer(&mut model_session, &rgb, size, &job.options).map_err(|e| job.fail(e))?);
        for (new, old) in current.iter_mut().zip(&previous) { *new = mix(*old, *new, 0.65); }
        write_depth(&mut writer, &mut gray, &previous, &current, 0.5)?;
        write_depth(&mut writer, &mut gray, &current, &current, 0.)?;
        previous = current;
        progress((frame + 2) as f64 / total as f64);
    }
    writer.flush().map_err(err)?;
    drop(writer);
    job.check()?;
    decoder.finish()?;
    encoder.finish()?;
    progress(1.);
    Ok(())
}

fn normalize(values: &[f32]) -> Vec<f32> {
    let (min, max) = values.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), &n| (min.min(n), max.max(n)));
    if max - min < 1e-5 { return vec![0.5; values.len()]; }
    values.iter().map(|n| (n - min) / (max - min)).collect()
}

fn mix(a: f32, b: f32, t: f32) -> f32 { a + (b - a) * t }

fn write_depth(writer: &mut impl Write, gray: &mut [u8], a: &[f32], b: &[f32], t: f32) -> R<()> {
    for ((pixel, a), b) in gray.iter_mut().zip(a).zip(b) { *pixel = (255. * mix(*a, *b, t)).round() as u8; }
    writer.write_all(gray).map_err(err)
}

fn read_map(bin: &Path, path: &Path, skip: usize, limit: usize) -> R<Process> {
    let mut cmd = ffmpeg(bin);
    cmd.arg("-i").arg(path).args(["-vf", &format!("trim=start_frame={skip}"),
        "-frames:v", &limit.to_string(), "-f", "rawvideo", "-c:v", "rawvideo", "-threads", "1",
        "-pix_fmt", "gray", "pipe:1"]);
    Process::start(cmd.stdout(Stdio::piped()))
}

fn focus_depth(map: &[u8], (w, h): (usize, usize), focus: Option<&Focus>) -> f32 {
    if let Some(point) = focus {
        let x = point.x * (w - 1) as f32;
        let y = point.y * (h - 1) as f32;
        return sample_gray(map, w, h, x, y);
    }
    // Average across a region so isolated near pixels don't win autofocus.
    let mut nearest: f32 = 0.;
    for y in 0..=8 {
        for x in 0..=8 {
            let (left, top) = (x * w / 10, y * h / 10);
            let (right, bottom) = ((x + 2) * w / 10, (y + 2) * h / 10);
            let sum: u32 = (top..bottom).flat_map(|row| &map[row * w + left..row * w + right])
                .map(|&n| n as u32).sum();
            nearest = nearest.max(sum as f32 / (255 * (right - left) * (bottom - top)) as f32);
        }
    }
    nearest
}

fn focus_blur(depth: f32, focus: f32, range: f32, progressive: bool) -> f32 {
    let outside = ((depth - focus).abs() - range).max(0.);
    let falloff = if progressive { (1. - range).max(0.08) } else { 0.08 };
    (outside / falloff).min(1.)
}

fn band_weights(blur: f32) -> [f32; 4] {
    let level = blur.clamp(0., 1.) * 3.;
    std::array::from_fn(|i| (1. - (level - i as f32).abs()).max(0.))
}

fn motion_at(motion: Motion, t: f32) -> (f32, f32, f32) {
    let t = t.clamp(0., 1.);
    match motion {
        Motion::ZoomIn => (0., 0., t),
        Motion::LeftRight => (-(t * std::f32::consts::PI).cos(), 0., 0.),
        Motion::Circle => (f32::cos(t * std::f32::consts::TAU), f32::sin(t * std::f32::consts::TAU), 0.),
    }
}

fn parallax_displacement((x, y): (f32, f32), (dx, dy, zoom): (f32, f32, f32), amount: f32, depth: f32) -> (f32, f32) {
    let shift = amount * (0.25 + 0.75 * depth) * 0.045;
    (shift * (dx + zoom * (2. * x - 1.)), shift * (dy + zoom * (2. * y - 1.)))
}

fn sample_gray(map: &[u8], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let (x0, y0) = (x as usize, y as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (u, v) = (x.fract(), y.fract());
    let top = mix(map[y0 * w + x0] as f32, map[y0 * w + x1] as f32, u);
    let bottom = mix(map[y1 * w + x0] as f32, map[y1 * w + x1] as f32, u);
    mix(top, bottom, v) / 255.
}

fn blur_pass(src: &[u8], dst: &mut [u8], lines: usize, len: usize, line_step: usize, step: usize, radius: usize) {
    let scale = (2 * radius + 1) as u32;
    for line in 0..lines {
        let start = line * line_step;
        let idx = |i: usize| (start + i.min(len - 1) * step) * 4;
        let mut sums = [0; 3];
        for i in 0..=radius {
            let offset = idx(i);
            for c in 0..3 {
                sums[c] += src[offset + c] as u32 * if i == 0 { radius as u32 + 1 } else { 1 };
            }
        }
        for i in 0..len {
            let (point, add, sub) = (idx(i), idx(i + radius + 1), idx(i.saturating_sub(radius)));
            for c in 0..3 {
                dst[point + c] = ((sums[c] + scale / 2) / scale) as u8;
                sums[c] = sums[c] + src[add + c] as u32 - src[sub + c] as u32;
            }
        }
    }
}

struct FrameEffect<'a> {
    settings: &'a Effects,
    size: (usize, usize),
    map_size: (usize, usize),
    focus: f32,
    bands: [Vec<u8>; 3],
    scratch: Vec<u8>,
    moved: Vec<u8>,
}

impl FrameEffect<'_> {
    fn apply_bokeh_and_fog(&mut self, pixels: &mut [u8], map: &[u8], job: &Job) -> R<()> {
        let (w, h) = self.size;
        let (mw, mh) = self.map_size;
        let fx = self.settings;
        let depth = |x, y| sample_gray(map, mw, mh, x * (mw - 1) as f32, y * (mh - 1) as f32);
        let map_x = |x: usize| x as f32 / (w - 1).max(1) as f32;
        let map_y = |y: usize| y as f32 / (h - 1).max(1) as f32;
        if fx.blur > 0. {
            let radius = (fx.blur * w.min(h) as f32 * 0.038).round().max(1.);
            self.scratch.resize(pixels.len(), 0);
            for (i, band) in self.bands.iter_mut().enumerate() {
                job.check()?;
                band.resize(pixels.len(), 0);
                let r = (radius * (i + 1) as f32 / 3.).round().max(1.) as usize;
                blur_pass(pixels, &mut self.scratch, h, w, w, 1, r);
                blur_pass(&self.scratch, band, w, h, 1, w, r);
            }
        }
        if fx.blur > 0. || fx.fog > 0. {
            for (y, row) in pixels.chunks_exact_mut(w * 4).enumerate() {
                job.check()?;
                for (x, pixel) in row.chunks_exact_mut(4).enumerate() {
                    let d = depth(map_x(x), map_y(y));
                    let fog = fx.fog * (1. - d).powi(2);
                    let offset = (y * w + x) * 4;
                    let weights = band_weights(focus_blur(d, self.focus, fx.range, fx.progressive));
                    for (c, ch) in pixel[..3].iter_mut().enumerate() {
                        let mut value = *ch as f32;
                        if fx.blur > 0. {
                            value *= weights[0];
                            for (band, weight) in self.bands.iter().zip(&weights[1..]) {
                                value += band[offset + c] as f32 * weight;
                            }
                        }
                        *ch = mix(value, fx.color[c] as f32, fog).round() as u8;
                    }
                }
            }
        }
        Ok(())
    }

    fn warp(&mut self, pixels: &[u8], map: &[u8], time: f32, job: &Job) -> R<&[u8]> {
        let (w, h) = self.size;
        let (mw, mh) = self.map_size;
        let fx = self.settings;
        self.moved.resize(pixels.len(), 0);
        let motion = motion_at(fx.motion, time);
        for (y, row) in self.moved.chunks_exact_mut(w * 4).enumerate() {
            job.check()?;
            let v = y as f32 / (h - 1).max(1) as f32;
            for (x, pixel) in row.chunks_exact_mut(4).enumerate() {
                let u = x as f32 / (w - 1).max(1) as f32;
                let depth = sample_gray(map, mw, mh, u * (mw - 1) as f32, v * (mh - 1) as f32);
                let (dx, dy) = parallax_displacement((u, v), motion, fx.parallax, depth);
                // Clamp to the frame so the nearest edge pixels stretch into exposed borders.
                let sx = (u - dx).clamp(0., 1.) * (w - 1) as f32;
                let sy = (v - dy).clamp(0., 1.) * (h - 1) as f32;
                let (x0, y0) = (sx as usize, sy as usize);
                let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
                for (c, ch) in pixel.iter_mut().enumerate() {
                    let at = |x, y| pixels[(y * w + x) * 4 + c] as f32;
                    let top = mix(at(x0, y0), at(x1, y0), sx.fract());
                    let bottom = mix(at(x0, y1), at(x1, y1), sx.fract());
                    *ch = mix(top, bottom, sy.fract()).round() as u8;
                }
            }
        }
        Ok(&self.moved)
    }
}

fn render(bin: &Path, req: &Request, depth: &Path, out: &Path, job: &Job, progress: impl Fn(f64)) -> R<()> {
    job.check()?;
    progress(0.);
    let size = req.render_size();
    let map_size = depth_size(req.width, req.height);
    let mut gray = vec![0; map_size.0 * map_size.1];
    let total = if req.animated() { req.frame_count() } else { 1 };
    let picked_frame = req.effects.focus.as_ref()
        .filter(|_| !req.still).map_or(0, |f| (((f.time - req.start) * req.fps).round() as usize).min(total - 1));
    let mut maps = read_map(bin, depth, 0, if req.still { 1 } else { total })?;
    let mut reader = BufReader::new(maps.0.stdout.take().unwrap());
    reader.read_exact(&mut gray).map_err(err)?;
    let focus = if req.effects.blur == 0. {
        0.
    } else if picked_frame > 0 {
        let mut picked = read_map(bin, depth, picked_frame, 1)?;
        let mut picked_gray = vec![0; gray.len()];
        picked.0.stdout.take().unwrap().read_exact(&mut picked_gray).map_err(err)?;
        picked.finish()?;
        focus_depth(&picked_gray, map_size, req.effects.focus.as_ref())
    } else {
        focus_depth(&gray, map_size, req.effects.focus.as_ref())
    };
    let mut effect = FrameEffect {
        settings: &req.effects, size, map_size, focus,
        bands: Default::default(), scratch: Vec::new(), moved: Vec::new(),
    };
    let mut source = decode_source(bin, req, size, "rgba", req.upscale.as_ref())?;
    let mut input = BufReader::new(source.0.stdout.take().unwrap());
    let mut cmd = ffmpeg(bin);
    raw_input(&mut cmd, size, req.fps, "rgba");
    if req.animated() {
        cmd.args(["-vf", "scale=ceil(iw/2)*2:ceil(ih/2)*2:out_color_matrix=bt709,setsar=1",
            "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-g", "24", "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
            "-movflags", "+faststart"]);
    } else {
        cmd.args(["-frames:v", "1", "-threads", "1", "-update", "1"]);
    }
    let mut encoder = Process::start(cmd.arg(out).stdin(Stdio::piped()))?;
    let mut output = BufWriter::new(encoder.0.stdin.take().unwrap());
    let mut pixels = vec![0; size.0 * size.1 * 4];
    if req.still {
        input.read_exact(&mut pixels).map_err(err)?;
        effect.apply_bokeh_and_fog(&mut pixels, &gray, job)?;
    }
    for frame in 0..total {
        job.check()?;
        if !req.still {
            input.read_exact(&mut pixels).map_err(err)?;
            if frame > 0 { reader.read_exact(&mut gray).map_err(err)?; }
            effect.apply_bokeh_and_fog(&mut pixels, &gray, job)?;
        }
        let source_fraction = frame as f32 / (total - 1).max(1) as f32;
        let time = req.effects.motion_timing.as_ref().map_or(source_fraction, |timing| {
            let index = source_fraction * 64.;
            mix(timing[index as usize], timing[(index as usize + 1).min(64)], index.fract())
        });
        let rendered = if req.effects.parallax > 0. { effect.warp(&pixels, &gray, time, job)? } else { &pixels };
        output.write_all(rendered).map_err(err)?;
        if frame % (total / 100).max(1) == 0 { progress((frame + 1) as f64 / total as f64); }
    }
    output.flush().map_err(err)?;
    drop(output);
    job.check()?;
    source.finish()?;
    maps.finish()?;
    encoder.finish()?;
    progress(1.);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn focus_and_depth_bands() {
        assert_eq!(focus_blur(0.5, 0.5, 0., true), 0.);
        assert_eq!(focus_blur(0.55, 0.5, 0.1, false), 0.);
        assert_eq!(focus_blur(0., 0.9, 0.1, false), 1.);
        let near = focus_blur(0.7, 0.5, 0.1, true);
        let far = focus_blur(0.95, 0.5, 0.1, true);
        assert!(near > 0. && near < far && far < 1.);
        assert_eq!(band_weights(0.), [1., 0., 0., 0.]);
        assert_eq!(band_weights(0.5), [0., 0.5, 0.5, 0.]);
        assert_eq!(band_weights(1.), [0., 0., 0., 1.]);
        for i in 0..=100 {
            let weights = band_weights(i as f32 / 100.);
            assert!((weights.iter().sum::<f32>() - 1.).abs() < 1e-6);
            assert!(weights.iter().filter(|&&n| n > 0.).count() <= 2);
        }
    }

    #[test]
    fn parallax_bounds() {
        for motion in [Motion::ZoomIn, Motion::LeftRight, Motion::Circle] {
            for frame in 0..=100 {
                let camera = motion_at(motion, frame as f32 / 100.);
                for point in [(0., 0.), (0., 1.), (1., 0.), (1., 1.), (0.5, 0.5)] {
                    let near = parallax_displacement(point, camera, 1., 1.);
                    let far = parallax_displacement(point, camera, 1., 0.);
                    assert!(near.0.abs() <= 0.045 && near.1.abs() <= 0.045);
                    assert!(near.0.abs() >= far.0.abs() && near.1.abs() >= far.1.abs());
                    assert_eq!(parallax_displacement(point, camera, 0., 1.), (0., 0.));
                }
            }
        }
    }

    #[test]
    fn cached_render_smoke() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let model = root.join("../.models/depth").join(MODEL);
        let bin = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join(super::super::exe_name("ffmpeg"));
        if !model.is_file() || !bin.is_file() {
            eprintln!("SKIP depth render smoke: dev model or FFmpeg sidecar is missing");
            return;
        }
        let work = super::super::upscale::Scratch::new(&std::env::temp_dir()).unwrap();
        let fixture = work.0.join("source.mp4");
        assert!(ffmpeg(&bin).args(["-f", "lavfi", "-i", "testsrc2=s=96x64:r=4:d=2",
            "-c:v", "libx264"]).arg(&fixture).status().unwrap().success());
        let mut req: Request = serde_json::from_value(json!({
            "path": fixture, "start": 0.25, "len": 1.25, "still": false, "fps": 4, "width": 96, "height": 64,
            "effects": { "blur": 0.6, "range": 0.1, "progressive": true, "fog": 0.4, "color": [202, 220, 244],
                "focus": { "x": 0.5, "y": 0.7, "time": 0.75 }, "parallax": 1., "motion": "leftRight" }
        })).unwrap();
        let job = Job::new("test".into()).unwrap();
        let (map, output) = req.cache(&work.0).unwrap();
        make_depth(&bin, &req, &model, &map, &job, |_| {}).unwrap();
        render(&bin, &req, &map, &output, &job, |_| {}).unwrap();
        let (w, h) = depth_size(96, 64);
        let gray = ffmpeg(&bin).arg("-i").arg(&map)
            .args(["-pix_fmt", "gray", "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "pipe:1"]).output().unwrap();
        assert!(gray.status.success());
        let maps: Vec<_> = gray.stdout.chunks_exact(w * h).collect();
        assert_eq!(maps.len(), req.frame_count());
        assert!(maps[0].iter().zip(maps[1]).zip(maps[2]).all(|((&a, &b), &c)| {
            (i32::from(a) + i32::from(c) - 2 * i32::from(b)).abs() <= 2
        }));
        let video = ffmpeg(&bin).arg("-i").arg(&output)
            .args(["-pix_fmt", "rgba", "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "pipe:1"]).output().unwrap();
        assert!(video.status.success());
        assert_eq!(video.stdout.len(), req.frame_count() * req.width * req.height * 4);
        assert_ne!(&video.stdout[..96 * 64 * 4], &video.stdout[96 * 64 * 4..2 * 96 * 64 * 4]);

        let mut original = req.cache(&work.0).unwrap();
        req.effects.fog = 0.6;
        let recolored = req.cache(&work.0).unwrap();
        assert_eq!(original.0, recolored.0);
        assert_ne!(original.1, recolored.1);
        req.start = 0.5;
        assert_ne!(original.0, req.cache(&work.0).unwrap().0);

        let still = work.0.join("source.png");
        assert!(ffmpeg(&bin).arg("-i").arg(&fixture).args(["-frames:v", "1", "-update", "1"]).arg(&still).status().unwrap().success());
        req.path = still.to_string_lossy().into_owned();
        req.still = true;
        req.start = 0.;
        original = req.cache(&work.0).unwrap();
        make_depth(&bin, &req, &model, &original.0, &job, |_| {}).unwrap();
        render(&bin, &req, &original.0, &original.1, &job, |_| {}).unwrap();
        req.effects.parallax = 0.;
        let static_render = req.cache(&work.0).unwrap();
        assert_eq!(original.0, static_render.0);
        render(&bin, &req, &static_render.0, &static_render.1, &job, |_| {}).unwrap();
        assert!(static_render.1.is_file());
        job.stop.store(true, Relaxed);
        assert_eq!(render(&bin, &req, &static_render.0, &work.0.join("cancelled.png"), &job, |_| {}).unwrap_err(), "cancelled");
    }

    #[test]
    fn model_smoke() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.models/depth");
        if !dir.join(MODEL).is_file() {
            eprintln!("SKIP depth smoke: no dev models");
            return;
        }
        eprintln!("Execution devices: {:?}", matte::ort_env().unwrap().devices().filter_map(|d| d.ep().ok()).collect::<Vec<_>>());
        let (w, h) = (SHORT_SIDE, SHORT_SIDE);
        let mut rgb = Vec::with_capacity(3 * w * h);
        for y in 0..h {
            for x in 0..w {
                let color = if (w / 4..w * 3 / 4).contains(&x) && (h / 3..h * 3 / 4).contains(&y) {
                    [195, 71, 50]
                } else if y >= h / 2 {
                    let shade = 95 + (110 * (y - h / 2) / (h / 2)) as u8;
                    [shade, shade, shade]
                } else { [136, 182, 215] };
                rgb.extend(color);
            }
        }
        let mut selected_passed = false;
        for file in [Q4, MODEL] {
            for cpu in [true, false] {
                if !cpu && std::env::var_os("MAQTO_DEPTH_COREML").is_none() { continue; }
                let path = dir.join(file);
                if !path.is_file() { continue; }
                let provider = if cpu { "CPU" } else { "default" };
                let run = || -> R<_> {
                    let start = Instant::now();
                    let mut model = session(&path, cpu)?;
                    let load = start.elapsed();
                    let options = RunOptions::new().map_err(err)?;
                    let depth = infer(&mut model, &rgb, (w, h), &options)?;
                    let start = Instant::now();
                    for _ in 0..3 { infer(&mut model, &rgb, (w, h), &options)?; }
                    Ok((depth, load, start.elapsed() / 3))
                };
                match run() {
                    Ok((depth, load, average)) => {
                        assert_eq!(depth.len(), w * h);
                        let row = |y| depth[y * w..(y + 1) * w].iter().sum::<f32>() / w as f32;
                        assert!(row(h * 9 / 10) > row(h / 10), "{file} {provider}");
                        eprintln!("{file} {provider}: load {load:?}, warmed frame {average:?}, top {:.3}, bottom {:.3}", row(h / 10), row(h * 9 / 10));
                        selected_passed |= file == MODEL && cpu;
                    }
                    Err(e) => eprintln!("{file} {provider}: {e}"),
                }
            }
        }
        assert!(selected_passed, "The selected depth model failed on CPU");
    }
}
