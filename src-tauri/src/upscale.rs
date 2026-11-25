// Real-ESRGAN ncnn-vulkan runs on extracted frames, with their source timing restored at encode.
use super::{command, err, exe_name, media_source_key, proxy_hash, sidecar, tail, MediaServer, R};
use serde::Deserialize;
use serde_json::json;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed}, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const TOOL: &str = "realesrgan-ncnn-vulkan";
const RELEASE: &str = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0";
const FOOTAGE: &str = "realesrgan-x4plus";
const ANIMATION: &str = "realesr-animevideov3";
static TRANSFER: Mutex<()> = Mutex::new(());
static ACTIVE_JOB: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);
static NEXT: AtomicUsize = AtomicUsize::new(0);

fn root(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("upscale"))
}

pub(crate) struct Scratch(pub(crate) PathBuf);

impl Scratch {
    pub(crate) fn new(root: &Path) -> R<Self> {
        fs::create_dir_all(root).map_err(err)?;
        loop {
            let dir = root.join(format!("work-{}-{}", std::process::id(), NEXT.fetch_add(1, Relaxed)));
            match fs::create_dir(&dir) {
                Ok(()) => return Ok(Self(dir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(err(e)),
            }
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn installed(dir: &Path) -> bool {
    dir.join(exe_name(TOOL)).is_file() &&
        [FOOTAGE, "realesr-animevideov3-x2", "realesr-animevideov3-x3", "realesr-animevideov3-x4"].iter().all(|model| {
            ["bin", "param"].iter().all(|ext| dir.join("models").join(format!("{model}.{ext}")).is_file())
        })
}

#[tauri::command]
pub fn upscale_ready(app: AppHandle) -> R<bool> { Ok(installed(&root(&app)?.join("tool"))) }

#[tauri::command]
pub fn upscale_remove(app: AppHandle) -> R<()> {
    let _transfer = TRANSFER.try_lock().map_err(|_| "Real-ESRGAN installation is busy")?;
    if ACTIVE_JOB.lock().unwrap().is_some() { return Err("Real-ESRGAN is in use".into()); }
    remove_tool(&root(&app)?.join("tool"))
}

fn remove_tool(dir: &Path) -> R<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result.map_err(err),
    }
}

#[tauri::command]
pub async fn upscale_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _transfer = TRANSFER.try_lock().map_err(|_| "Real-ESRGAN installation is busy")?;
        let root = root(&app)?;
        let dir = root.join("tool");
        if installed(&dir) { return Ok(()); }
        let platform = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" }
            else if cfg!(target_os = "linux") { "ubuntu" } else { return Err("Real-ESRGAN is unavailable on this platform".into()); };
        let stage = Scratch::new(&root)?;
        let zip = stage.0.join("download.zip");
        let url = format!("{RELEASE}/{TOOL}-20220424-{platform}.zip");
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(20)).timeout_read(Duration::from_secs(60)).build();
        let res = agent.get(&url).call().map_err(err)?;
        let total = res.header("content-length").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.);
        let mut download = res.into_reader();
        let mut file = File::create(&zip).map_err(err)?;
        let mut buf = [0; 65536];
        let (mut got, mut last) = (0., 0.);
        loop {
            let n = download.read(&mut buf).map_err(err)?;
            if n == 0 { break; }
            file.write_all(&buf[..n]).map_err(err)?;
            got += n as f64;
            if total > 0. && got / total - last >= 0.005 {
                last = got / total;
                let _ = app.emit("progress", json!({ "label": "upscale_dl", "p": last }));
            }
        }
        drop(file);
        if total > 0. && got != total { return Err(format!("Download incomplete ({got} of {total} bytes)")); }
        let unpacked = stage.0.join("tool");
        fs::create_dir(&unpacked).map_err(err)?;
        let mut unpack = if cfg!(target_os = "linux") {
            let mut cmd = command(Path::new("unzip"));
            cmd.arg("-q").arg(&zip).arg("-d").arg(&unpacked);
            cmd
        } else {
            let mut cmd = command(Path::new("tar"));
            cmd.arg("-xf").arg(&zip).arg("-C").arg(&unpacked);
            cmd
        };
        let output = unpack.output().map_err(err)?;
        if !output.status.success() { return Err(tail(&String::from_utf8_lossy(&output.stderr))); }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(unpacked.join(TOOL), fs::Permissions::from_mode(0o755)).map_err(err)?;
        }
        if !installed(&unpacked) { return Err("Real-ESRGAN files are missing after unpacking".into()); }
        remove_tool(&dir)?;
        fs::rename(unpacked, dir).map_err(err)
    }).await.map_err(err)?
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Model { Footage, Animation }

fn model_choice(model: Model, scale: u32) -> R<(&'static str, u32)> {
    match (model, scale) {
        (Model::Footage, 2 | 4) => Ok((FOOTAGE, 4)),
        (Model::Animation, 2..=4) => Ok((ANIMATION, scale)),
        _ => Err("Invalid upscale factor".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    path: String,
    start: f64,
    len: f64,
    still: bool,
    scale: u32,
    model: Model,
    tone_map: Option<String>,
}

impl Request {
    fn cache(&self, root: &Path) -> R<PathBuf> {
        if !matches!(self.scale, 2 | 4) { return Err("Invalid clip upscale factor".into()); }
        let model = model_choice(self.model, self.scale)?;
        if !self.start.is_finite() || self.start < 0. || !self.len.is_finite() || (!self.still && self.len <= 0.) {
            return Err("Invalid upscale range".into());
        }
        let key = proxy_hash(("20220424", media_source_key(&self.path)?, self.start.to_bits(),
            self.len.to_bits(), self.still, self.scale, model, &self.tone_map));
        let ext = if self.still { "png" } else { "mp4" };
        Ok(root.join("out").join(format!("{key}.{ext}")))
    }
}

#[tauri::command]
pub fn upscale_cached(app: AppHandle, request: Request) -> R<Option<String>> {
    let out = request.cache(&root(&app)?)?;
    Ok(out.is_file().then(|| allow_cache(&app, &out)))
}

fn allow_cache(app: &AppHandle, out: &Path) -> String {
    let path = out.to_string_lossy().into_owned();
    app.state::<Arc<MediaServer>>().allow(&path);
    path
}

struct Job { id: String, stop: Arc<AtomicBool> }

impl Job {
    fn new(id: String) -> R<Self> {
        let _transfer = TRANSFER.try_lock().map_err(|_| "Real-ESRGAN installation is busy")?;
        let mut active = ACTIVE_JOB.lock().unwrap();
        if active.is_some() { return Err("An upscale job is already running".into()); }
        let stop = Arc::new(AtomicBool::new(false));
        *active = Some((id.clone(), stop.clone()));
        Ok(Self { id, stop })
    }

    fn check(&self) -> R<()> {
        if self.stop.load(Relaxed) { Err("cancelled".into()) } else { Ok(()) }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        let mut active = ACTIVE_JOB.lock().unwrap();
        if active.as_ref().is_some_and(|(id, _)| *id == self.id) { *active = None; }
    }
}

#[tauri::command]
pub fn upscale_cancel(job: String) {
    if let Some((id, stop)) = ACTIVE_JOB.lock().unwrap().as_ref() {
        if *id == job { stop.store(true, Relaxed); }
    }
}

fn run(job: &Job, cmd: &mut Command, mut on_line: impl FnMut(&str)) -> R<()> {
    job.check()?;
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(err)?;
    let log = child.stderr.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(log).lines().map_while(Result::ok) {
            if tx.send(line).is_err() { break; }
        }
    });
    let mut last = std::collections::VecDeque::new();
    let status = loop {
        if job.stop.load(Relaxed) { let _ = child.kill(); break child.wait(); }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                on_line(&line);
                if last.len() == 4 { last.pop_front(); }
                last.push_back(line);
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => break Err(e),
            },
        }
    };
    let _ = reader.join();
    job.check()?;
    if status.map_err(err)?.success() { Ok(()) }
    else { Err(last.into_iter().collect::<Vec<_>>().join("\n")) }
}

fn number(line: &str, field: &str) -> Option<i64> {
    line.split_once(field)?.1.split_whitespace().next()?.parse().ok()
}

fn extract(job: &Job, ffmpeg: &Path, req: &Request, dir: &Path, mut on_frame: impl FnMut(i64)) -> R<Vec<i64>> {
    let mut cmd = command(ffmpeg);
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "info"]);
    if !req.still { cmd.args(["-ss", &format!("{:.8}", req.start)]); }
    cmd.args(["-i", &req.path, "-map", "0:V:0"]);
    if req.still { cmd.args(["-frames:v", "1"]); }
    let filter = [req.tone_map.as_deref().unwrap_or(""), "setsar=1", "settb=AVTB", "showinfo=checksum=0"]
        .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(",");
    if !req.still {
        // Trim before showinfo so its timestamp list matches the PNG sequence.
        cmd.args(["-vf", &format!("trim=end={:.8},{filter}", req.len)]);
    } else { cmd.args(["-vf", &filter]); }
    let mut times = Vec::new();
    run(job, cmd.args(["-fps_mode", "passthrough", "-threads", "1", "-start_number", "0"])
        .arg(dir.join("%09d.png")), |line| {
        if line.contains("Parsed_showinfo_") {
            if let Some(t) = number(line, " pts:") {
                times.push(t);
                on_frame(t);
            }
        }
    })?;
    // Some FFmpeg versions filter one extra frame when the output has a frame limit.
    times.truncate(fs::read_dir(dir).map_err(err)?.count());
    if times.is_empty() { return Err("No frames in upscale range".into()); }
    Ok(times)
}

fn infer(job: &Job, tool: &Path, input: &Path, output: &Path, model: (&str, u32), on_frame: impl FnMut()) -> R<()> {
    let mut on_frame = on_frame;
    run(job, command(&tool.join(exe_name(TOOL))).current_dir(tool)
        .arg("-i").arg(input).arg("-o").arg(output).arg("-m").arg(tool.join("models"))
        .args(["-n", model.0, "-s", &model.1.to_string(), "-f", "png", "-v"]), |line| {
        if line.trim_end().ends_with(" done") { on_frame(); }
    })
}

fn manifest(dir: &Path, times: &[i64], fps: f64) -> R<PathBuf> {
    let file = dir.join("frames.ffconcat");
    let mut text = String::from("ffconcat version 1.0\n");
    for (i, &t) in times.iter().enumerate() {
        let duration = times.get(i + 1).map(|next| (next - t).max(1) as f64 / 1e6).unwrap_or(1. / fps);
        text.push_str(&format!("file '{i:09}.png'\noption framerate 1000000\nduration {duration:.6}\n"));
    }
    fs::write(&file, text).map_err(err)?;
    Ok(file)
}

fn encode_video(job: &Job, ffmpeg: &Path, dir: &Path, times: &[i64], req: &Request, fps: f64, out: &Path, export: Option<Export<'_>>) -> R<()> {
    let mut cmd = command(ffmpeg);
    cmd.args(["-v", "error", "-y"]);
    let fps = if fps.is_finite() && fps > 0. { fps } else { 30. };
    let cfr = times.iter().enumerate().all(|(i, &t)| {
        ((t - times[0]) as f64 - i as f64 * 1e6 / fps).abs() <= 2.
    });
    if cfr {
        cmd.args(["-framerate", &format!("{fps:.10}"), "-start_number", "0", "-i"]).arg(dir.join("%09d.png"));
    } else {
        cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(manifest(dir, times, fps)?);
    }
    let model = model_choice(req.model, req.scale)?;
    let vf = if let Some(export) = &export {
        cmd.args(["-i", &req.path, "-map", "0:v:0", "-map", "1:a?", "-map_chapters", "1", "-map_metadata", "1", "-c:a", "copy"]);
        format!("scale={}:{}:flags=lanczos:out_color_matrix=bt709,setsar=1", export.size[0], export.size[1])
    } else {
        let ratio = req.scale as f64 / model.1 as f64;
        format!("scale=iw*{ratio}:ih*{ratio}:flags=lanczos:out_color_matrix=bt709,setsar=1")
    };
    cmd.args(["-vf", &vf, "-fps_mode", "passthrough"]);
    if let Some(export) = export { cmd.args(export.encoder); } else { cmd.args(CACHE_ENCODER); }
    if !cfr {
        // MP4 reads sample durations from decode timestamps. With no B-frames we can
        // set the last packet's duration from the requested source out-point.
        let last_us = ((req.len * 1e6).round() as i64 - times[times.len() - 1]).max(1);
        cmd.args(["-enc_time_base", "1:1000000", "-video_track_timescale", "1000000", "-bf", "0", "-bsf:v",
            &format!("setts=duration=if(eq(N\\,{})\\,{last_us}\\,DURATION)", times.len() - 1)]);
    }
    run(job, cmd.args(SDR).args(["-movflags", "+faststart"]).arg(out), |_| {})
}

const CACHE_ENCODER: &[&str] = &["-c:v", "libx264", "-preset", "fast", "-crf", "16", "-g", "24", "-pix_fmt", "yuv420p"];
const SDR: &[&str] = &["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];

struct Export<'a> { size: [u32; 2], encoder: &'a [String] }

#[allow(clippy::too_many_arguments)]
fn render(job: &Job, ffmpeg: &Path, tool: &Path, work: &Path, req: &Request, fps: f64, out: &Path,
    export: Option<Export<'_>>, mut progress: impl FnMut(f64, Option<f64>)) -> R<()> {
    let model = model_choice(req.model, req.scale)?;
    if !installed(tool) { return Err("Real-ESRGAN is missing".into()); }
    let input = work.join("in");
    let sample = work.join("sample");
    let output = work.join("out");
    for dir in [&input, &sample, &output] { fs::create_dir(dir).map_err(err)?; }
    progress(0., None);
    let mut decoded = 0.;
    let times = extract(job, ffmpeg, req, &input, |time| {
        if req.still { return; }
        let p = 0.08 * (time as f64 / 1e6 / req.len).clamp(0., 1.);
        if p - decoded >= 0.0025 {
            decoded = p;
            progress(p, None);
        }
    })?;
    let total = times.len();
    let samples = total.min(10);
    for i in 0..samples {
        let name = format!("{i:09}.png");
        fs::rename(input.join(&name), sample.join(name)).map_err(err)?;
    }
    let measured = Instant::now();
    let mut done = 0;
    infer(job, tool, &sample, &output, model, || {
        done += 1;
        progress(0.08 + 0.84 * done.min(total) as f64 / total as f64, None);
    })?;
    fs::remove_dir_all(&sample).map_err(err)?;
    let per_frame = measured.elapsed().as_secs_f64() / samples as f64;
    done = samples;
    progress(0.08 + 0.84 * done as f64 / total as f64, Some(per_frame * (total - done) as f64));
    if total > samples {
        infer(job, tool, &input, &output, model, || {
            done = (done + 1).min(total);
            progress(0.08 + 0.84 * done as f64 / total as f64, Some(per_frame * (total - done) as f64));
        })?;
    }
    fs::remove_dir_all(&input).map_err(err)?;
    if fs::read_dir(&output).map_err(err)?.count() != total { return Err("Real-ESRGAN returned an incomplete frame sequence".into()); }
    progress(0.93, None);
    if req.still {
        let frame = output.join("000000000.png");
        if req.scale == model.1 {
            job.check()?;
            return fs::rename(frame, out).map_err(err);
        }
        let ratio = req.scale as f64 / model.1 as f64;
        return run(job, command(ffmpeg).args(["-v", "error", "-y", "-i"]).arg(frame)
            .args(["-vf", &format!("scale=iw*{ratio}:ih*{ratio}:flags=lanczos"), "-frames:v", "1", "-threads", "1"])
            .arg(out), |_| {});
    }
    encode_video(job, ffmpeg, &output, &times, req, fps, out, export)
}

fn notify<'a>(app: &'a AppHandle, job: &'a Job) -> impl FnMut(f64, Option<f64>) + 'a {
    move |p, eta| { let _ = app.emit("upscaleprog", json!({ "job": job.id, "p": p, "eta": eta })); }
}

#[tauri::command]
pub async fn upscale_prepare(app: AppHandle, request: Request, job: String) -> R<String> {
    let job = Job::new(job)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&app)?;
        let out = request.cache(&root)?;
        if !out.is_file() {
            let scratch = Scratch::new(&root)?;
            let tmp = scratch.0.join(if request.still { "cache.png" } else { "cache.mp4" });
            let fps = if request.still { 0. } else {
                super::probe_one(&request.path)?["fps"].as_f64().unwrap_or(0.)
            };
            render(&job, &sidecar("ffmpeg"), &root.join("tool"), &scratch.0, &request, fps, &tmp, None, notify(&app, &job))?;
            job.check()?;
            if request.cache(&root)? != out { return Err("The source changed while upscaling".into()); }
            fs::create_dir_all(out.parent().unwrap()).map_err(err)?;
            fs::rename(tmp, &out).map_err(err)?;
        }
        Ok(allow_cache(&app, &out))
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn upscale_export(app: AppHandle, path: String, out: String, size: [u32; 2], encoder: Vec<String>, job: String) -> R<()> {
    let job = Job::new(job)?;
    tauri::async_runtime::spawn_blocking(move || {
        if size.into_iter().any(|n| n == 0 || n > 3840 || n % 2 != 0) { return Err("Invalid upscale export size".into()); }
        let root = root(&app)?;
        let work = Scratch::new(&root)?;
        let out = Path::new(&out);
        let ext = out.extension().and_then(|ext| ext.to_str()).filter(|ext| matches!(*ext, "mp4" | "mov")).ok_or("Invalid upscale export format")?;
        let parent = out.parent().filter(|p| p.is_dir()).ok_or("Invalid upscale export folder")?;
        let staged = Scratch::new(parent)?;
        let tmp = staged.0.join(format!("export.{ext}"));
        let media = super::probe_one(&path)?;
        let len = media["dur"].as_f64().filter(|n| *n > 0.).ok_or("Missing export duration")?;
        let width = media["w"].as_u64().filter(|n| *n > 0).ok_or("Missing export width")?;
        let height = media["h"].as_u64().filter(|n| *n > 0).ok_or("Missing export height")?;
        let factor = (size[0] as u64).div_ceil(width).max((size[1] as u64).div_ceil(height)).clamp(2, 4) as u32;
        let req = Request { path, start: 0., len, still: false, scale: factor, model: Model::Animation, tone_map: None };
        render(&job, &sidecar("ffmpeg"), &root.join("tool"), &work.0, &req, media["fps"].as_f64().unwrap_or(0.),
            &tmp, Some(Export { size, encoder: &encoder }), notify(&app, &job))?;
        job.check()?;
        fs::rename(tmp, out).map_err(err)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn sidecar_fixture(name: &str) -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        fs::read_dir(dir).ok()?.filter_map(Result::ok).map(|entry| entry.path()).find(|path| {
            path.file_name().is_some_and(|p| p.to_string_lossy().starts_with(&format!("{name}-{}-", std::env::consts::ARCH)))
                && path.to_string_lossy().contains(if cfg!(windows) {"windows"} else if cfg!(target_os = "macos") {"darwin"} else {"linux"})
        })
    }

    fn test_job() -> Job {
        Job { id: "test".into(), stop: Arc::new(AtomicBool::new(false)) }
    }

    fn ffprobe_json(ffprobe: &Path, args: &[&str], out: &Path) -> Value {
        let result = command(ffprobe).args(["-v", "error", "-of", "json"]).args(args).arg(out).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        serde_json::from_slice(&result.stdout).unwrap()
    }

    #[test]
    fn models_pick_native_scale() {
        assert_eq!(model_choice(Model::Footage, 2).unwrap(), ("realesrgan-x4plus", 4));
        assert_eq!(model_choice(Model::Footage, 4).unwrap(), ("realesrgan-x4plus", 4));
        assert_eq!(model_choice(Model::Animation, 2).unwrap(), ("realesr-animevideov3", 2));
        assert_eq!(model_choice(Model::Animation, 4).unwrap(), ("realesr-animevideov3", 4));
        assert_eq!(model_choice(Model::Animation, 3).unwrap(), ("realesr-animevideov3", 3));
        assert!(model_choice(Model::Footage, 3).is_err());
        assert!(model_choice(Model::Animation, 5).is_err());
    }

    #[test]
    fn cache_preserves_frame_timestamps() {
        let (Some(ffmpeg), Some(ffprobe)) = (sidecar_fixture("ffmpeg"), sidecar_fixture("ffprobe")) else {
            eprintln!("Skipping upscale timing test: bundled FFmpeg sidecars unavailable");
            return;
        };
        let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
        let input = scratch.0.join("source.mp4");
        let frames = scratch.0.join("frames");
        let out = scratch.0.join("cache.mp4");
        fs::create_dir(&frames).unwrap();
        let job = test_job();
        run(&job, command(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i",
            "testsrc=size=64x36:rate=24000/1001", "-vf", "select='not(eq(n,3))'", "-frames:v", "8",
            "-fps_mode", "passthrough", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&input), |_| {}).unwrap();
        let req = Request { path: input.to_string_lossy().into_owned(), start: 0.06, len: 0.26,
            still: false, scale: 2, model: Model::Animation, tone_map: None };
        let times = extract(&job, &ffmpeg, &req, &frames, |_| {}).unwrap();
        assert_eq!(times, [23_417, 106_833, 148_542, 190_250, 231_958]);
        encode_video(&job, &ffmpeg, &frames, &times, &req, 24_000. / 1_001., &out, None).unwrap();
        let data = ffprobe_json(&ffprobe, &["-show_streams", "-show_frames", "-select_streams", "v:0"], &out);
        let read_seconds = |v: &Value| v.as_str().unwrap().parse::<f64>().unwrap();
        let actual = data["frames"].as_array().unwrap();
        assert_eq!(actual.len(), times.len());
        for (frame, time) in actual.iter().zip(&times) {
            assert!((read_seconds(&frame["best_effort_timestamp_time"]) - (time - times[0]) as f64 / 1e6).abs() <= 0.000002);
        }
        assert!((read_seconds(&data["streams"][0]["duration"]) - (req.len - times[0] as f64 / 1e6)).abs() < 0.001);

        let cfr = [0, 41_708, 83_417, 125_125, 166_833];
        encode_video(&job, &ffmpeg, &frames, &cfr, &req, 24_000. / 1_001., &out, None).unwrap();
        let data = ffprobe_json(&ffprobe, &["-show_streams", "-select_streams", "v:0"], &out);
        assert_eq!(data["streams"][0]["avg_frame_rate"], "24000/1001");
        assert_eq!(data["streams"][0]["nb_frames"], "5");
    }

    #[test]
    fn export_resizes_video_and_keeps_audio_and_chapters() {
        let (Some(ffmpeg), Some(ffprobe)) = (sidecar_fixture("ffmpeg"), sidecar_fixture("ffprobe")) else {
            eprintln!("Skipping upscale export test: bundled FFmpeg sidecars unavailable");
            return;
        };
        let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
        let input = scratch.0.join("project.mp4");
        let frames = scratch.0.join("frames");
        let out = scratch.0.join("export.mp4");
        let metadata = scratch.0.join("chapters.ffmetadata");
        fs::create_dir(&frames).unwrap();
        fs::write(&metadata, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=Intro\n").unwrap();
        let job = test_job();
        run(&job, command(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i",
            "testsrc=size=64x36:rate=24:duration=0.5", "-f", "lavfi", "-i", "sine=duration=0.5",
            "-f", "ffmetadata", "-i"]).arg(metadata)
            .args(["-map", "0:v", "-map", "1:a", "-map_chapters", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&input), |_| {}).unwrap();
        let req = Request { path: input.to_string_lossy().into_owned(), start: 0., len: 0.5,
            still: false, scale: 2, model: Model::Animation, tone_map: None };
        let times = extract(&job, &ffmpeg, &req, &frames, |_| {}).unwrap();
        let encoder: Vec<String> = CACHE_ENCODER.iter().map(|s| s.to_string()).collect();
        encode_video(&job, &ffmpeg, &frames, &times, &req, 24., &out,
            Some(Export { size: [256, 144], encoder: &encoder })).unwrap();
        let data = ffprobe_json(&ffprobe, &["-show_streams", "-show_chapters"], &out);
        let video = &data["streams"][0];
        assert_eq!(video["width"], 256);
        assert_eq!(video["height"], 144);
        assert_eq!(video["nb_frames"], "12");
        assert_eq!(data["streams"][1]["codec_name"], "aac");
        assert_eq!(data["chapters"][0]["tags"]["title"], "Intro");
    }

    #[test]
    fn real_esrgan_smoke() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.models/esrgan");
        if !installed(&fixture) {
            eprintln!("Skipping Real-ESRGAN smoke test: .models/esrgan unavailable");
            return;
        }
        let (Some(ffmpeg), Some(ffprobe)) = (sidecar_fixture("ffmpeg"), sidecar_fixture("ffprobe")) else {
            eprintln!("Skipping Real-ESRGAN smoke test: bundled FFmpeg sidecars unavailable");
            return;
        };
        let scratch = Scratch::new(&std::env::temp_dir()).unwrap();
        let tool = scratch.0.join("tool");
        fs::create_dir(&tool).unwrap();
        let bin = tool.join(exe_name(TOOL));
        fs::copy(fixture.join(exe_name(TOOL)), &bin).unwrap();
        fs::create_dir(tool.join("models")).unwrap();
        for file in fs::read_dir(fixture.join("models")).unwrap().map(Result::unwrap) {
            fs::copy(file.path(), tool.join("models").join(file.file_name())).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let input = scratch.0.join("source.png");
        let job = test_job();
        run(&job, command(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x36",
            "-frames:v", "1", "-threads", "1"]).arg(&input), |_| {}).unwrap();
        for (i, (model, scale)) in [(Model::Animation, 2), (Model::Footage, 2), (Model::Footage, 4)].into_iter().enumerate() {
            let work = scratch.0.join(format!("run-{i}"));
            fs::create_dir(&work).unwrap();
            let output = work.join("cache.png");
            let request = Request { path: input.to_string_lossy().into_owned(), start: 0., len: 0.,
                still: true, scale, model, tone_map: None };
            if let Err(error) = render(&job, &ffmpeg, &tool, &work, &request, 0., &output, None, |_, _| {}) {
                if error.contains("Vulkan is not supported on this device") || error.contains("VK_ERROR_INCOMPATIBLE_DRIVER") {
                    eprintln!("Skipping Real-ESRGAN smoke test: Vulkan/Metal unavailable\n{error}");
                    return;
                }
                panic!("Real-ESRGAN failed: {error}");
            }
            let meta = ffprobe_json(&ffprobe, &["-show_streams"], &output);
            assert_eq!(meta["streams"][0]["width"], 64 * scale);
            assert_eq!(meta["streams"][0]["height"], 36 * scale);
        }
    }
}
