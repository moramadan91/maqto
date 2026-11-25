// Source-aligned inpainting. PNGs preserve the original alpha and pixels outside the mask.
use super::{command, err, matte, probe_one, sam2, sidecar, tail, MediaServer, R};
use ort::{session::{builder::AutoDevicePolicy, Session}, value::Tensor};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Stdio},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

const SIZE: usize = 512;
const MODEL: &str = "migan_pipeline.onnx";
const URL: &str = "https://huggingface.co/anyisalin/migan-onnx/resolve/main/onnx/migan_pipeline.onnx";
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(0);

fn model(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models").join(MODEL))
}

#[tauri::command]
pub fn migan_ready(app: AppHandle) -> R<bool> { Ok(model(&app)?.is_file()) }

#[tauri::command]
pub async fn migan_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || matte::fetch(&app, URL, &model(&app)?, "migan_dl")).await.map_err(err)?
}

#[tauri::command]
pub fn migan_remove(app: AppHandle) -> R<()> { super::remove_model_file(&model(&app)?) }

fn session(path: &Path) -> R<Session> {
    Session::builder(&matte::ort_env()?).map_err(err)?
        .with_auto_device(AutoDevicePolicy::PreferCPU).map_err(err)?
        .commit_from_file(path).map_err(err)
}

fn mask_box(mask: &[u8], w: usize, h: usize) -> Option<[usize; 4]> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for (i, _) in mask.iter().enumerate().filter(|(_, a)| **a > 0) {
        let (x, y) = (i % w, i / w);
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
    }
    (x1 > x0).then_some([x0, y0, x1, y1])
}

fn crop_box([x0, y0, x1, y1]: [usize; 4], w: usize, h: usize) -> [usize; 4] {
    let pad = |span: usize| (span * 13).div_ceil(10);
    let size = 256.max(pad(x1 - x0)).max(pad(y1 - y0));
    let axis = |lo: usize, hi: usize, limit: usize| {
        let len = size.min(limit);
        let start = (lo + hi).saturating_sub(len).div_euclid(2).min(limit - len);
        (start, start + len)
    };
    let (left, right) = axis(x0, x1, w);
    let (top, bottom) = axis(y0, y1, h);
    [left, top, right, bottom]
}

fn axis(pos: f32, len: usize) -> (usize, usize, f32) {
    let pos = pos.clamp(0., (len - 1) as f32);
    let base = pos as usize;
    (base, (base + 1).min(len - 1), pos.fract())
}

fn sample(data: &[u8], stride: usize, (x, x1, fx): (usize, usize, f32), (y, y1, fy): (usize, usize, f32), step: usize, c: usize) -> f32 {
    let at = |x, y| data[y * stride + x * step + c] as f32;
    let mix = |a, b, f| a + (b - a) * f;
    mix(mix(at(x, y), at(x1, y), fx), mix(at(x, y1), at(x1, y1), fx), fy)
}

fn mapped(i: usize, from: usize, to: usize) -> f32 {
    (i as f32 + 0.5) * to as f32 / from as f32 - 0.5
}

fn paste_pixel(original: u8, fill: f32, alpha: u8, prev: Option<(u8, u8)>) -> u8 {
    let fill = match prev {
        Some((previous, previous_alpha)) => fill + (previous as f32 - fill) * (0.3 * previous_alpha as f32 / 255.),
        None => fill,
    };
    (original as f32 + (fill - original as f32) * alpha as f32 / 255.).round() as u8
}

fn barely_moved(mask: &[u8], prev: &[u8]) -> bool {
    let (mut shared, mut union) = (0u64, 0u64);
    for (&a, &b) in mask.iter().zip(prev) {
        shared += u64::from(a.min(b));
        union += u64::from(a.max(b));
    }
    union > 0 && shared * 10 >= union * 9
}

fn fill_frame(sess: &mut Session, rgba: &mut [u8], (w, h): (usize, usize), mask: &[u8], prev: Option<(&[u8], &[u8])>) -> R<()> {
    let Some(bbox) = mask_box(mask, w, h) else { return Ok(()); };
    let [x0, y0, x1, y1] = crop_box(bbox, w, h);
    let (cw, ch) = (x1 - x0, y1 - y0);
    let area = SIZE * SIZE;
    let (mut image, mut holes) = (vec![0; 3 * area], vec![255u8; area]);
    let xs: Vec<_> = (0..SIZE).map(|x| axis(mapped(x, SIZE, cw), cw)).collect();
    for y in 0..SIZE {
        let row = axis(mapped(y, SIZE, ch), ch);
        for (x, &col) in xs.iter().enumerate() {
            let i = y * SIZE + x;
            for c in 0..3 {
                image[c * area + i] = sample(&rgba[(y0 * w + x0) * 4..], w * 4, col, row, 4, c).round() as u8;
            }
            // MI-GAN takes 255 for known pixels and 0 for holes.
            if sample(&mask[y0 * w + x0..], w, col, row, 1, 0) > 0. {
                holes[i] = 0;
            }
        }
    }
    let image = Tensor::from_array(([1, 3, SIZE, SIZE], image)).map_err(err)?;
    let holes = Tensor::from_array(([1, 1, SIZE, SIZE], holes)).map_err(err)?;
    let outputs = sess.run(ort::inputs!["image" => image, "mask" => holes]).map_err(err)?;
    let (_, result) = outputs.get("result").ok_or("Missing MI-GAN result")?.try_extract_tensor::<u8>().map_err(err)?;
    if result.len() != 3 * area { return Err("Unexpected MI-GAN result size".into()); }
    let prev = prev.filter(|&(_, pm)| barely_moved(mask, pm));
    for y in bbox[1]..bbox[3] {
        let row = axis(mapped(y - y0, ch, SIZE), SIZE);
        for x in bbox[0]..bbox[2] {
            let i = y * w + x;
            let a = mask[i];
            if a == 0 { continue; }
            let col = axis(mapped(x - x0, cw, SIZE), SIZE);
            for c in 0..3 {
                let p = i * 4 + c;
                let v = sample(&result[c * area..], SIZE, col, row, 1, 0);
                rgba[p] = paste_pixel(rgba[p], v, a, prev.map(|(img, m)| (img[p], m[i])));
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    path: String,
    start: f64,
    end: f64,
    key: String,
    edges: sam2::Edges,
    smooth: bool,
    tone_map: Option<String>,
    job: String,
}

#[derive(Serialize)]
pub struct Cache {
    manifest: PathBuf,
    path: PathBuf,
    times: Vec<f64>,
}

// Reap both subprocesses on every failure, including cancellation between frames.
struct Pipe(Child);
impl Drop for Pipe {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn check_cancel(cancel: &AtomicBool) -> R<()> {
    if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
    Ok(())
}

fn render(app: &AppHandle, req: &Request, cancel: &AtomicBool) -> R<Cache> {
    let m = probe_one(&req.path)?;
    let w = m["w"].as_u64().unwrap_or(0) as usize;
    let h = m["h"].as_u64().unwrap_or(0) as usize;
    if w == 0 || h == 0 || req.start < 0. || req.end < req.start { return Err("Invalid inpainting source range".into()); }
    let still = m["kind"] == "image";
    let source_key = sam2::source_key(&req.path)?;
    let mut hash = DefaultHasher::new();
    ("migan-v2", &source_key, req.start.to_bits(), req.end.to_bits(), &req.key, &req.edges, req.smooth, &req.tone_map).hash(&mut hash);
    let root = app.path().app_data_dir().map_err(err)?.join("inpaint");
    let dir = root.join(format!("{:016x}", hash.finish()));
    let metadata = dir.join("times.json");
    if !metadata.is_file() {
        let reader = sam2::MaskReader::open(app, &req.key, &req.path)?;
        let path = model(app)?;
        if !path.is_file() { return Err("MI-GAN model is missing".into()); }
        check_cancel(cancel)?;
        let mut sess = session(&path)?;
        let tmp = dir.with_extension(format!("{}-{}.part", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&tmp).map_err(err)?;
        let fps = m["fps"].as_f64().filter(|&n| n >= 1.).unwrap_or(30.);
        let result = (|| {
            let progress = |p| { let _ = app.emit("miganprog", serde_json::json!({ "job": req.job, "p": p })); };
            let mut static_mask: Option<Arc<[u8]>> = None;
            let mask_at = |t| {
                if let Some(mask) = &static_mask { return Ok(Arc::clone(mask)); }
                let (mw, mh, mask) = reader.frame(t, &req.edges)?;
                let mask = Arc::from(scale_mask(&mask, (mw, mh), (w, h)));
                if reader.is_static() { static_mask = Some(Arc::clone(&mask)); }
                Ok(mask)
            };
            let times = render_frames(&sidecar("ffmpeg"), req, cancel, &mut sess, &tmp, (w, h), still, fps, mask_at, progress)?;
            fs::write(tmp.join("times.json"), serde_json::to_vec(&times).map_err(err)?).map_err(err)?;
            if !still { write_manifest(&tmp, &times, req.end)?; }
            check_cancel(cancel)?;
            fs::rename(&tmp, &dir).or_else(|e| if metadata.is_file() { Ok(()) } else { Err(e) }).map_err(err)
        })();
        let _ = fs::remove_dir_all(tmp);
        result?;
    }
    let times: Vec<f64> = serde_json::from_slice(&fs::read(metadata).map_err(err)?).map_err(err)?;
    let srv = app.state::<Arc<MediaServer>>();
    for i in 0..times.len() {
        check_cancel(cancel)?;
        srv.allow(&dir.join(format!("{i:09}.png")).to_string_lossy());
    }
    Ok(Cache { manifest: dir.join("frames.ffconcat"), path: dir, times })
}

fn write_manifest(dir: &Path, times: &[f64], end: f64) -> R<()> {
    let mut text = String::from("ffconcat version 1.0\n");
    for (i, &t) in times.iter().enumerate() {
        let duration = times.get(i + 1).copied().unwrap_or(end) - t;
        text.push_str(&format!("file '{i:09}.png'\noption framerate 1000000\nduration {:.6}\n", duration.max(0.000001)));
    }
    // The last timestamp gives the fps filter the full final frame duration.
    text.push_str(&format!("file '{:09}.png'\noption framerate 1000000\n", times.len() - 1));
    fs::write(dir.join("frames.ffconcat"), text).map_err(err)
}

struct FrameSource {
    input: ChildStdout,
    log: BufReader<ChildStderr>,
    process: Pipe,
}

impl FrameSource {
    fn open(bin: &Path, req: &Request, still: bool) -> R<Self> {
        let vf = [req.tone_map.as_deref().unwrap_or(""), "format=rgba", "settb=AVTB", "showinfo=checksum=0"]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(",");
        let mut cmd = command(bin);
        cmd.args(["-hide_banner", "-nostats", "-loglevel", "info", "-copyts", "-start_at_zero"]);
        if !still { cmd.args(["-ss", &format!("{:.8}", req.start), "-noaccurate_seek"]); }
        cmd.args(["-i", &req.path, "-map", "0:V:0", "-vf", &vf, "-fps_mode", "passthrough"]);
        if still { cmd.args(["-frames:v", "1"]); }
        let mut process = Pipe(cmd.args(["-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "-"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?);
        Ok(Self { input: process.0.stdout.take().unwrap(), log: BufReader::new(process.0.stderr.take().unwrap()), process })
    }

    fn next(&mut self, rgba: &mut [u8]) -> R<Option<f64>> {
        let mut line = String::new();
        while self.log.read_line(&mut line).map_err(err)? != 0 {
            if line.starts_with("[Parsed_showinfo_") {
                if let Some((_, ts)) = line.split_once(" pts:") {
                    let us = ts.split_whitespace().next().and_then(|v| v.parse::<i64>().ok()).ok_or("Missing source frame timestamp")?;
                    self.input.read_exact(rgba).map_err(err)?;
                    return Ok(Some(us as f64 / 1_000_000.));
                }
            }
            line.clear();
        }
        if !self.process.0.wait().map_err(err)?.success() { return Err("Could not decode inpainting source".into()); }
        Ok(None)
    }
}

#[allow(clippy::too_many_arguments)]
fn render_frames(bin: &Path, req: &Request, cancel: &AtomicBool, sess: &mut Session, dir: &Path,
                 (w, h): (usize, usize), still: bool, fps: f64,
                 mut mask_at: impl FnMut(f64) -> R<Arc<[u8]>>, mut progress: impl FnMut(f64)) -> R<Vec<f64>> {
    check_cancel(cancel)?;
    let mut dec = FrameSource::open(bin, req, still)?;
    let mut enc = Pipe(command(bin).args(["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", &format!("{w}x{h}"),
        "-framerate", &format!("{fps:.8}"), "-i", "-", "-c:v", "png", "-threads", "2", "-start_number", "0"])
        .arg(dir.join("%09d.png")).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(err)?);
    let mut output = enc.0.stdin.take().unwrap();
    let mut rgba = vec![0; w * h * 4];
    let mut prev = Vec::new();
    let mut prev_mask: Option<Arc<[u8]>> = None;
    let mut times = Vec::new();
    let mut emit = |time: f64, src_time: f64, frame: &mut [u8]| -> R<()> {
        check_cancel(cancel)?;
        let mask = mask_at(src_time)?;
        let prior = prev_mask.as_deref().map(|a| (prev.as_slice(), a));
        fill_frame(sess, frame, (w, h), &mask, prior)?;
        check_cancel(cancel)?;
        output.write_all(frame).map_err(err)?;
        if req.smooth { prev.clear(); prev.extend_from_slice(frame); prev_mask = Some(mask); }
        times.push(time);
        if !still { progress(((time - req.start) / (req.end - req.start).max(0.000001)).clamp(0., 0.99)); }
        Ok(())
    };

    // Seeking lands on a keyframe. Keep the last frame at or before the in-point.
    let mut leading = vec![0; rgba.len()];
    let mut leading_time = None;
    let mut started = false;
    let mut last = f64::NEG_INFINITY;
    let start_us = (req.start * 1_000_000.).round() / 1_000_000.;
    let end_us = (req.end * 1_000_000.).round() / 1_000_000.;
    while let Some(time) = dec.next(&mut rgba)? {
        check_cancel(cancel)?;
        if still { emit(0., 0., &mut rgba)?; started = true; break; }
        if time < start_us {
            leading_time = Some(time);
            std::mem::swap(&mut leading, &mut rgba);
            continue;
        }
        if !started {
            if time > start_us {
                if let Some(t) = leading_time.take() { emit(req.start, t, &mut leading)?; }
                else {
                    emit(req.start, time, &mut rgba)?;
                    started = true;
                    continue;
                }
            }
            started = true;
        }
        if time >= end_us && time > start_us { break; }
        if time > last {
            emit(time.max(req.start), time, &mut rgba)?;
            last = time;
        }
    }
    if !started {
        if let Some(t) = leading_time { emit(req.start, t, &mut leading)?; }
        else { return Err("No frames in inpainting source".into()); }
    }
    drop(dec);
    drop(output);
    let mut stderr = String::new();
    enc.0.stderr.take().unwrap().read_to_string(&mut stderr).map_err(err)?;
    if !enc.0.wait().map_err(err)?.success() { return Err(tail(&stderr)); }
    progress(1.);
    Ok(times)
}

fn scale_mask(mask: &[u8], (mw, mh): (usize, usize), (w, h): (usize, usize)) -> Vec<u8> {
    if (mw, mh) == (w, h) { return mask.to_vec(); }
    let cols: Vec<_> = (0..w).map(|x| axis(mapped(x, w, mw), mw)).collect();
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let row = axis(mapped(y, h, mh), mh);
        out.extend(cols.iter().map(|&col| sample(mask, mw, col, row, 1, 0).round() as u8));
    }
    out
}

#[tauri::command]
pub async fn migan_render(app: AppHandle, request: Request) -> R<Cache> {
    let job = request.job.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().map_err(err)?;
        if jobs.contains_key(&job) { return Err("Inpainting is already running".into()); }
        jobs.insert(job.clone(), cancel.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let res = render(&app, &request, &cancel);
        JOBS.lock().map_err(err)?.remove(&job);
        res
    }).await.map_err(err)?
}

#[tauri::command]
pub fn migan_cancel(job: String) {
    if let Some(cancel) = JOBS.lock().unwrap().get(&job) { cancel.store(true, Ordering::Relaxed); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_padding_minimum_and_bounds() {
        assert_eq!(crop_box([400, 400, 700, 700], 1000, 1000), [355, 355, 745, 745]);
        assert_eq!(crop_box([350, 250, 360, 260], 700, 500), [227, 127, 483, 383]);
        assert_eq!(crop_box([0, 490, 10, 500], 700, 500), [0, 244, 256, 500]);
        assert_eq!(crop_box([0, 0, 200, 100], 200, 100), [0, 0, 200, 100]);
    }

    #[test]
    fn paste_back_and_temporal_blend() {
        assert_eq!(paste_pixel(20, 220., 0, None), 20);
        assert_eq!(paste_pixel(20, 220., 255, None), 220);
        assert_eq!(paste_pixel(20, 220., 128, None), 120);
        assert_eq!(paste_pixel(20, 220., 255, Some((120, 255))), 190);
        assert_eq!(paste_pixel(20, 220., 255, Some((120, 0))), 220);
        assert!(barely_moved(&[255, 255, 0], &[255, 250, 0]));
        assert!(!barely_moved(&[255, 255, 0], &[0, 255, 255]));
    }

    #[test]
    fn native_frame_timing_and_cancellation() -> R<()> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let model = root.join("../.models/migan").join(MODEL);
        let bin = root.join("target/debug").join(super::super::exe_name("ffmpeg"));
        if !model.is_file() || !bin.is_file() {
            eprintln!("SKIP native frame test: install the dev model and FFmpeg sidecar");
            return Ok(());
        }
        let dir = std::env::temp_dir().join(format!("maqto-fill-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&dir).map_err(err)?;
        let result = (|| {
            let clip = dir.join("vfr.mp4");
            let out = command(&bin).args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=4:d=3",
                "-vf", "select='not(eq(n,4)+eq(n,6))'", "-fps_mode", "vfr", "-c:v", "libx264", "-g", "8"]).arg(&clip).output().map_err(err)?;
            if !out.status.success() { return Err(tail(&String::from_utf8_lossy(&out.stderr))); }
            let req: Request = serde_json::from_value(serde_json::json!({
                "path": clip, "start": 1.28, "end": 2.24, "key": "", "edges": {}, "smooth": true, "job": "test"
            })).map_err(err)?;
            let mut sess = session(&model)?;
            let cancel = AtomicBool::new(false);
            let mut selected = Vec::new();
            let times = render_frames(&bin, &req, &cancel, &mut sess, &dir, (64, 64), false, 4.,
                |t| { selected.push(t); Ok(Arc::from(vec![0; 64 * 64])) }, |_| {})?;
            assert_eq!(times, [1.28, 1.75, 2.]);
            assert_eq!(selected, [1.25, 1.75, 2.]);
            assert!(dir.join("000000002.png").is_file());
            assert!(!dir.join("000000003.png").exists());
            write_manifest(&dir, &times, req.end)?;
            let still = Request { path: dir.join("000000000.png").to_string_lossy().into_owned(), start: 0., end: 0., ..req };
            let still_dir = dir.join("still");
            fs::create_dir(&still_dir).map_err(err)?;
            let times = render_frames(&bin, &still, &cancel, &mut sess, &still_dir, (64, 64), true, 4.,
                |_| Ok(Arc::from(vec![0; 64 * 64])), |_| {})?;
            assert_eq!(times, [0.]);
            assert!(still_dir.join("000000000.png").is_file());
            let cancel_dir = dir.join("cancelled");
            fs::create_dir(&cancel_dir).map_err(err)?;
            let stopped = render_frames(&bin, &req_for_video(clip), &cancel, &mut sess, &cancel_dir, (64, 64), false, 4.,
                |_| Ok(Arc::from(vec![0; 64 * 64])), |_| cancel.store(true, Ordering::Relaxed));
            assert_eq!(stopped.unwrap_err(), "cancelled");
            Ok(())
        })();
        let _ = fs::remove_dir_all(dir);
        result
    }

    fn req_for_video(path: PathBuf) -> Request {
        serde_json::from_value(serde_json::json!({
            "path": path, "start": 0., "end": 2., "key": "", "edges": {}, "smooth": false, "job": "test"
        })).unwrap()
    }

    #[test]
    fn red_square_smoke() -> R<()> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.models/migan").join(MODEL);
        if !path.is_file() {
            eprintln!("SKIP MI-GAN smoke: .models/migan is missing");
            return Ok(());
        }
        let mut sess = session(&path)?;
        let (w, h) = (512, 384);
        let mut rgba = Vec::with_capacity(w * h * 4);
        let mut mask = vec![0; w * h];
        for (i, a) in mask.iter_mut().enumerate() {
            let square = (200..312).contains(&(i % w)) && (136..248).contains(&(i / w));
            *a = if square { 255 } else { 0 };
            rgba.extend(if square { [235, 28, 21, 255] } else { [63, 89, 112, 197] });
        }
        let red = |img: &[u8]| img.chunks_exact(4).zip(&mask)
            .filter(|(p, a)| **a > 0 && p[0] > 150 && p[0].saturating_sub(p[1].max(p[2])) > 80).count();
        let original = rgba.clone();
        let before = red(&rgba);
        fill_frame(&mut sess, &mut rgba, (w, h), &mask, None)?;
        let after = red(&rgba);
        eprintln!("MI-GAN red pixels inside the mask: {before} -> {after}");
        assert!(before > 0 && after * 5 < before);
        for (i, &a) in mask.iter().enumerate() {
            if a == 0 { assert_eq!(rgba[i * 4..i * 4 + 4], original[i * 4..i * 4 + 4]); }
        }
        Ok(())
    }
}
