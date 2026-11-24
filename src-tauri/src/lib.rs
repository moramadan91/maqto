mod mcp;
mod assistant;
mod rife;
mod matte;
mod stems;
mod media_server;
mod reframe;
mod multicam_sync;

pub fn mcp_stdio() { mcp::serve_stdio() }

use media_server::MediaServer;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

// Speech models people can pick for auto captions (whisper.cpp ggml files, downloaded on first use).
const MODELS: [&str; 4] = ["small", "large-v3-turbo-q5_0", "large-v3-turbo", "large-v3-q5_0"];
const MODEL_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

#[derive(Default)]
struct AppState {
    job: Arc<Mutex<Option<Child>>>,
    job_lock: Mutex<()>,
    media_proxy: Mutex<Option<MediaProxyJob>>,
    multicam_sync: Mutex<()>,
    dirs: Mutex<HashMap<u32, PathBuf>>,
    next: Mutex<u32>,
}

type R<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

// Sidecars sit next to the app executable (bundle and dev target dir).
fn sidecar(name: &str) -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    dir.join(exe_name(name))
}

fn command(bin: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn tail(s: &str) -> String {
    let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join("\n")
}

/// Run a long job and retain its stderr tail for callers. Killable through `cancel`.
fn run_job(state: &AppState, bin: &Path, args: &[String], on_line: impl Fn(&str) + Send + Sync + 'static) -> R<String> {
    let _job = state.job_lock.try_lock().map_err(|_| "another job is running")?;
    let mut child = command(bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("{}: {e}", bin.display()))?;
    let out = child.stdout.take().unwrap();
    let errp = child.stderr.take().unwrap();
    *state.job.lock().unwrap() = Some(child);
    let on_line = Arc::new(on_line);
    let f2 = on_line.clone();
    let err_buf = Arc::new(Mutex::new(String::new()));
    let eb = err_buf.clone();
    let t_err = std::thread::spawn(move || {
        let mut r = BufReader::new(errp);
        let mut buf = Vec::new();
        // whisper prints progress with \r, so split on both
        let mut byte = [0u8; 1];
        while r.read(&mut byte).map(|n| n > 0).unwrap_or(false) {
            if byte[0] == b'\n' || byte[0] == b'\r' {
                let l = String::from_utf8_lossy(&buf).to_string();
                f2(&l);
                let mut e = eb.lock().unwrap();
                e.push_str(&l);
                e.push('\n');
                if e.len() > 8000 { let cut = e.len() - 8000; let cut = (cut..e.len()).find(|i| e.is_char_boundary(*i)).unwrap_or(0); e.drain(..cut); }
                buf.clear();
            } else {
                buf.push(byte[0]);
            }
        }
    });
    for l in BufReader::new(out).lines().map_while(Result::ok) {
        on_line(&l);
    }
    t_err.join().ok();
    let status = state.job.lock().unwrap().take().map(|mut c| c.wait());
    match status {
        Some(Ok(s)) if s.success() => Ok(std::mem::take(&mut *err_buf.lock().unwrap())),
        Some(Ok(_)) => Err(tail(&err_buf.lock().unwrap())),
        Some(Err(e)) => Err(err(e)),
        None => Err("cancelled".into()),
    }
}

#[tauri::command]
fn cancel(state: State<AppState>) {
    stems::STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(mut c) = state.job.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn probe_one(p: &str) -> R<Value> {
    let source_key = media_source_key(p).ok();
    let out = command(&sidecar("ffprobe"))
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", p])
        .output().map_err(err)?;
    if !out.status.success() { return Err(tail(&String::from_utf8_lossy(&out.stderr))); }
    let j: Value = serde_json::from_slice(&out.stdout).map_err(err)?;
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let v = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let a = streams.iter().find(|s| s["codec_type"] == "audio");
    if v.is_none() && a.is_none() { return Err("unsupported file".into()); }
    let ext = Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let is_img = IMAGE_EXT.contains(&ext.as_str());
    let (mut w, mut h) = v.map(|v| (v["width"].as_u64().unwrap_or(0), v["height"].as_u64().unwrap_or(0))).unwrap_or((0, 0));
    let rot = v.and_then(|v| {
        v["side_data_list"].as_array().and_then(|l| l.iter().find_map(|d| d["rotation"].as_f64()))
            .or_else(|| v["tags"]["rotate"].as_str().and_then(|s| s.parse().ok()))
    }).unwrap_or(0.0).abs() as i64;
    if rot == 90 || rot == 270 { std::mem::swap(&mut w, &mut h); }
    let num = |x: &Value| x.as_str().and_then(|s| s.parse::<f64>().ok());
    let dur = num(&j["format"]["duration"]).or_else(|| v.and_then(|v| num(&v["duration"]))).or_else(|| a.and_then(|a| num(&a["duration"]))).unwrap_or(0.0);
    let fps = v.and_then(|v| v["avg_frame_rate"].as_str().or(v["r_frame_rate"].as_str())).and_then(|s| s.split_once('/'))
        .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok().filter(|b| *b > 0.0)?)).unwrap_or(0.0);
    let kind = if is_img { "image" } else if v.is_some() { "video" } else { "audio" };
    let name = Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mut media = json!({ "path": p, "name": name, "kind": kind, "dur": if is_img { Value::Null } else { json!(dur) },
        "w": w, "h": h, "fps": fps, "hasAudio": a.is_some() && !is_img, "audioChannels": a.and_then(|a| a["channels"].as_u64()) });
    media["firstMarker"] = json!(j["chapters"].as_array().into_iter().flatten()
        .filter_map(|c| num(&c["start_time"])).filter(|t| t.is_finite() && *t >= 0.0)
        .min_by(f64::total_cmp));
    if let Some(v) = v.filter(|_| !is_img) {
        let hdr = v["color_transfer"] == "arib-std-b67" || v["color_transfer"] == "smpte2084" || v["color_primaries"] == "bt2020";
        media["hdr"] = json!(hdr);
        media["codec"] = v["codec_name"].clone();
        let bitrate = num(&v["bit_rate"]).filter(|b| *b > 0.0).or_else(|| num(&j["format"]["bit_rate"]));
        media["bitrate"] = json!(bitrate);
        media["sourceKey"] = json!(source_key);
        if hdr {
            for (key, stream_key) in [("trc", "color_transfer"), ("primaries", "color_primaries"), ("matrix", "color_space")] {
                let value = v[stream_key].as_str().filter(|s| !matches!(*s, "unknown" | "unspecified"));
                media[key] = json!(value);
            }
        }
    }
    Ok(media)
}

#[tauri::command]
fn media_base(srv: State<Arc<MediaServer>>) -> String {
    srv.base.clone()
}

#[tauri::command]
async fn probe(srv: State<'_, Arc<MediaServer>>, paths: Vec<String>) -> Result<Value, ()> {
    let srv = srv.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let (mut ok, mut bad) = (vec![], vec![]);
        for p in paths {
            match probe_one(&p) {
                Ok(v) => { srv.allow(&p); ok.push(v) }
                Err(e) => bad.push(format!("{}: {e}", Path::new(&p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(p.clone()))),
            }
        }
        json!({ "ok": ok, "bad": bad })
    }).await.unwrap_or(json!({ "ok": [], "bad": [] })))
}

#[tauri::command]
fn save_project(path: String, json: String) -> R<()> {
    if !(path.ends_with(".maqto") || path.ends_with(".kadr")) { return Err("project files end with .maqto".into()); }
    std::fs::write(path, json).map_err(err)
}

#[tauri::command]
fn save_chapters(path: String, text: String) -> R<()> {
    if !path.to_ascii_lowercase().ends_with(".txt") { return Err("chapter files end with .txt".into()); }
    std::fs::write(path, text).map_err(err)
}

#[tauri::command]
fn save_timeline(path: String, text: String) -> R<()> {
    if !["fcpxml", "edl", "otio"].iter().any(|ext| timeline_extension(&path, ext)) {
        return Err("timeline files end with .fcpxml, .edl or .otio".into());
    }
    std::fs::write(path, text).map_err(err)
}

fn timeline_extension(path: &str, ext: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

#[tauri::command]
fn read_timeline(path: String) -> R<String> {
    if !["fcpxml", "otio"].iter().any(|ext| timeline_extension(&path, ext)) {
        return Err("timeline files end with .fcpxml or .otio".into());
    }
    std::fs::read_to_string(path).map_err(err)
}

#[tauri::command]
async fn open_project(srv: State<'_, Arc<MediaServer>>, path: String) -> R<Value> {
    if !(path.ends_with(".maqto") || path.ends_with(".kadr")) { return Err("project files end with .maqto".into()); }
    let srv = srv.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut p: Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(err)?).map_err(err)?;
        let mut missing = vec![];
        if let Some(m) = p["media"].as_object_mut() {
            for v in m.values_mut() {
                let Some(f) = v["path"].as_str() else { continue };
                if f.is_empty() { continue; } // fill layers have no file
                if Path::new(f).exists() {
                    srv.allow(f);
                    if v["kind"] == "video" && (!v["hdr"].is_boolean()
                        || v["sourceKey"].as_str() != media_source_key(f).ok().as_deref())
                    {
                        if let Ok(probed) = probe_one(f) {
                            // Old projects only gain the newer source keys; a saved size/length/rate is never overwritten.
                            for key in ["w", "h", "dur", "fps", "hasAudio", "audioChannels", "hdr", "trc", "primaries", "matrix", "codec", "bitrate", "sourceKey", "firstMarker"] {
                                if matches!(key, "w" | "h" | "dur" | "fps") && !v[key].is_null() { continue; }
                                v[key] = probed[key].clone();
                            }
                        }
                    }
                } else { missing.push(v["name"].clone()); }
            }
        }
        Ok(json!({ "project": p, "missing": missing }))
    }).await.map_err(err)?
}

#[tauri::command]
fn work_begin(state: State<AppState>) -> R<Value> {
    let mut n = state.next.lock().unwrap();
    *n += 1;
    let dir = std::env::temp_dir().join(format!("maqto-{}-{}", std::process::id(), *n));
    std::fs::create_dir_all(&dir).map_err(err)?;
    state.dirs.lock().unwrap().insert(*n, dir.clone());
    Ok(json!({ "id": *n, "path": dir.to_string_lossy().replace('\\', "/") }))
}

fn work_dir(state: &AppState, id: u32) -> R<PathBuf> {
    state.dirs.lock().unwrap().get(&id).cloned().ok_or_else(|| "bad work dir".to_string())
}

#[tauri::command]
fn work_end(state: State<AppState>, id: u32) {
    if let Some(d) = state.dirs.lock().unwrap().remove(&id) { let _ = std::fs::remove_dir_all(d); }
}

#[tauri::command]
fn write_work(state: State<AppState>, request: tauri::ipc::Request) -> R<String> {
    // Export side files (baked colour LUTs, mask images) into a job's work dir.
    let h = request.headers();
    let id: u32 = h.get("x-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or("x-id")?;
    let name = h.get("x-name").and_then(|v| v.to_str().ok()).ok_or("x-name")?;
    let (stem, ext) = name.rsplit_once('.').ok_or("bad name")?;
    let ok = !stem.is_empty() && stem.len() <= 40 && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') && matches!(ext, "cube" | "png" | "ffconcat" | "ffmetadata");
    if !ok { return Err("bad file name".into()); }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw body".into()) };
    let p = work_dir(&state, id)?.join(name);
    std::fs::write(&p, bytes).map_err(err)?;
    Ok(p.to_string_lossy().replace('\\', "/"))
}

/// LUT library: .cube files shipped in the app (resources/luts) and ones the user imported (app data/luts).
#[tauri::command]
fn lut_library(app: AppHandle, srv: State<Arc<MediaServer>>) -> R<Value> {
    let mut out = vec![];
    let dirs = [(app.path().resource_dir().map_err(err)?.join("luts"), true), (app.path().app_data_dir().map_err(err)?.join("luts"), false)];
    for (dir, builtin) in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map_or(false, |x| x.eq_ignore_ascii_case("cube"))).collect();
        files.sort();
        for f in files {
            let s = f.to_string_lossy().into_owned();
            srv.allow(&s);
            out.push(json!({ "name": f.file_stem().map(|x| x.to_string_lossy().into_owned()), "path": s, "builtin": builtin }));
        }
    }
    Ok(json!(out))
}

/// Copy an imported .cube into the user's library so it stays listed.
#[tauri::command]
fn lut_add(app: AppHandle, path: String) -> R<String> {
    let src = Path::new(&path);
    if !src.extension().map_or(false, |x| x.eq_ignore_ascii_case("cube")) { return Err("only .cube files".into()); }
    let dir = app.path().app_data_dir().map_err(err)?.join("luts");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let dst = dir.join(src.file_name().ok_or("bad name")?);
    if dst != src { std::fs::copy(src, &dst).map_err(err)?; }
    Ok(dst.to_string_lossy().into_owned())
}

const AUDIO_EXT: [&str; 8] = ["wav", "mp3", "m4a", "aac", "ogg", "flac", "aif", "aiff"];
fn is_audio(p: &Path) -> bool { p.extension().map_or(false, |x| AUDIO_EXT.iter().any(|e| x.eq_ignore_ascii_case(e))) }
fn walk_audio(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) { walk(dir, depth, is_audio, out) }
fn walk(dir: &Path, depth: u8, ok: fn(&Path) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() { if depth > 0 { walk(&p, depth - 1, ok, out); } } else if ok(&p) { out.push(p); }
    }
}
fn is_video(p: &Path) -> bool { p.extension().map_or(false, |x| ["mp4", "mov", "webm", "m4v"].iter().any(|e| x.eq_ignore_ascii_case(e))) }

/// Overlay clips (dust, light leaks…): app data/overlays/<category>/<file>, laid over the video in screen mode.
#[tauri::command]
fn overlay_library(app: AppHandle, srv: State<Arc<MediaServer>>) -> R<Value> {
    let root = app.path().app_data_dir().map_err(err)?.join("overlays");
    let mut files = vec![];
    walk(&root, 1, is_video, &mut files);
    files.sort();
    Ok(json!(files.iter().map(|f| {
        let s = f.to_string_lossy().into_owned();
        srv.allow(&s);
        json!({ "name": f.file_stem().map(|x| x.to_string_lossy().into_owned()), "path": s })
    }).collect::<Vec<_>>()))
}

/// Sound effects library: app data/sfx/<category>/<file>.
#[tauri::command]
fn sfx_library(app: AppHandle, srv: State<Arc<MediaServer>>) -> R<Value> {
    let root = app.path().app_data_dir().map_err(err)?.join("sfx");
    let mut files = vec![];
    walk_audio(&root, 1, &mut files);
    files.sort();
    Ok(json!(files.iter().map(|f| {
        let s = f.to_string_lossy().into_owned();
        srv.allow(&s);
        let cat = f.parent().filter(|d| *d != root).and_then(|d| d.file_name()).map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
        json!({ "cat": cat, "name": f.file_stem().map(|x| x.to_string_lossy().into_owned()), "path": s })
    }).collect::<Vec<_>>()))
}

/// Copy every sound under a folder into the library; each file's own folder becomes its category.
#[tauri::command]
fn sfx_import(app: AppHandle, dir: String) -> R<usize> {
    let src = Path::new(&dir);
    let root = app.path().app_data_dir().map_err(err)?.join("sfx");
    let mut files = vec![];
    walk_audio(src, 6, &mut files);
    for f in &files {
        let cat = f.parent().and_then(|d| d.file_name()).map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|| "Sounds".into());
        let d = root.join(cat);
        std::fs::create_dir_all(&d).map_err(err)?;
        std::fs::copy(f, d.join(f.file_name().ok_or("bad name")?)).map_err(err)?;
    }
    Ok(files.len())
}

/// Remove a LUT the user imported (never one shipped with the app).
#[tauri::command]
fn lut_remove(app: AppHandle, path: String) -> R<()> {
    let dir = app.path().app_data_dir().map_err(err)?.join("luts");
    let p = Path::new(&path);
    if p.parent() != Some(dir.as_path()) { return Err("not an imported LUT".into()); }
    std::fs::remove_file(p).map_err(err)
}

/// A user's .cube colour LUT, read as text (size-capped).
#[tauri::command]
fn read_lut(path: String) -> R<String> {
    if !path.to_lowercase().ends_with(".cube") { return Err("only .cube files".into()); }
    if std::fs::metadata(&path).map_err(err)?.len() > 32 << 20 { return Err("LUT file too big".into()); }
    std::fs::read_to_string(&path).map_err(err)
}

// Raw body: PNG bytes. Headers: x-id (work dir), x-name (fNNNNN.png).
#[tauri::command]
fn write_frame(state: State<AppState>, request: tauri::ipc::Request) -> R<()> {
    let h = request.headers();
    let id: u32 = h.get("x-id").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok()).ok_or("x-id")?;
    let name = h.get("x-name").and_then(|v| v.to_str().ok()).ok_or("x-name")?;
    let ok = name.len() <= 24 && name.strip_suffix(".png").map_or(false, |st| !st.is_empty() && st.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    if !ok { return Err("bad frame name".into()); }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw body".into()) };
    std::fs::write(work_dir(&state, id)?.join(name), bytes).map_err(err)
}

// Raw body: recorded audio. Header x-ext: m4a | webm. Saved under app data/recordings.
#[tauri::command]
fn save_recording(app: AppHandle, request: tauri::ipc::Request) -> R<String> {
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("m4a");
    let ext = match ext { "webm" => "webm", "png" => "png", _ => "m4a" };
    let kind = if ext == "png" { "freeze" } else { "voiceover" };
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected raw body".into()) };
    let dir = app.path().app_data_dir().map_err(err)?.join("recordings");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_millis()).unwrap_or(0);
    let file = dir.join(format!("{kind}-{secs}{nanos:03}.{ext}"));
    std::fs::write(&file, bytes).map_err(err)?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
async fn export_run(app: AppHandle, id: u32, args: Vec<String>, concat: Option<String>, duration: f64) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir = work_dir(&state, id)?;
        if let Some(c) = concat { std::fs::write(dir.join("text.ffconcat"), c).map_err(err)?; }
        let a = app.clone();
        let r = assert_original_inputs(&app, &args).and_then(|()| run_job(&state, &sidecar("ffmpeg"), &args, move |l| {
            if let Some(us) = l.strip_prefix("out_time_us=").and_then(|s| s.trim().parse::<f64>().ok()) {
                let _ = a.emit("progress", json!({ "label": "export", "p": (us / 1e6 / duration).clamp(0.0, 1.0) }));
            }
        }));
        if let Some(d) = state.dirs.lock().unwrap().remove(&id) { let _ = std::fs::remove_dir_all(d); }
        r.map(|_| ())
    }).await.map_err(err)?
}

#[tauri::command]
async fn loudness_measure(app: AppHandle, args: Vec<String>) -> R<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        assert_original_inputs(&app, &args)?;
        let log = run_job(&app.state::<AppState>(), &sidecar("ffmpeg"), &args, |_| {})?;
        let end = log.rfind("\n}").ok_or("missing loudness analysis")? + 1;
        let start = log[..end].rfind("\n{").ok_or("missing loudness analysis")? + 1;
        serde_json::from_str(&log[start..=end]).map_err(err)
    }).await.map_err(err)?
}

fn model_path(app: &AppHandle, model: &str) -> R<PathBuf> {
    if !MODELS.contains(&model) { return Err(format!("unknown model {model}")); }
    Ok(app.path().app_data_dir().map_err(err)?.join("models").join(format!("ggml-{model}.bin")))
}

/// Preview proxy for a speed-curve clip: the export's own retime graph rendered once at a small size,
/// cached by its arguments, so the preview plays it at normal speed instead of changing the rate
/// every frame. The output path in `args` is the "__OUT__" placeholder.
// Running proxy renders by job id (a clip id), so a newer edit of the same clip can stop the old one.
// A project file the OS asked us to open (double-click / "Open with"): kept until the page takes it.
static OPEN_FILE: Mutex<Option<String>> = Mutex::new(None);
fn offer_file(app: &AppHandle, p: PathBuf) {
    if !matches!(p.extension().and_then(|e| e.to_str()), Some("maqto" | "kadr")) { return; }
    *OPEN_FILE.lock().unwrap() = Some(p.to_string_lossy().into_owned());
    let _ = app.emit("open-file", ());
}
#[tauri::command]
fn take_open_file() -> Option<String> { OPEN_FILE.lock().unwrap().take() }
static PX_JOBS: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<Option<Child>>>>>> = std::sync::LazyLock::new(Default::default);

#[tauri::command]
async fn proxy_render(app: AppHandle, srv: State<'_, Arc<MediaServer>>, args: Vec<String>, job: Option<String>, total: Option<f64>) -> R<String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    args.hash(&mut h);
    let dir = app.path().app_data_dir().map_err(err)?.join("proxy");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let out = dir.join(format!("{:016x}.mp4", h.finish()));
    if !out.exists() {
        let o = out.clone();
        let a2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> R<()> {
            let tmp = o.with_extension("part.mp4");
            let t = tmp.to_string_lossy().into_owned();
            let mut a: Vec<String> = args.into_iter().map(|x| if x == "__OUT__" { t.clone() } else { x }).collect();
            a.splice(0..0, ["-progress".to_string(), "pipe:1".to_string(), "-nostats".to_string()]);
            let mut child = command(&sidecar("ffmpeg")).args(&a).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
            let (so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
            let slot = Arc::new(Mutex::new(Some(child)));
            if let Some(j) = &job {
                if let Some(old) = PX_JOBS.lock().unwrap().insert(j.clone(), slot.clone()) {
                    if let Some(mut c) = old.lock().unwrap().take() { let _ = c.kill(); }
                }
            }
            let errs = std::thread::spawn(move || { let mut s = String::new(); let _ = se.read_to_string(&mut s); s });
            let tot = total.unwrap_or(0.0);
            for l in BufReader::new(so).lines().map_while(Result::ok) {
                if let (Some(j), Some(us)) = (&job, l.strip_prefix("out_time_us=").and_then(|s| s.trim().parse::<f64>().ok())) {
                    if tot > 0.0 { let _ = a2.emit("pxprog", json!({ "job": j, "p": (us / 1e6 / tot).clamp(0.0, 0.99) })); }
                }
            }
            let child = slot.lock().unwrap().take();
            if let Some(j) = &job {
                let mut jobs = PX_JOBS.lock().unwrap();
                if jobs.get(j).is_some_and(|s| Arc::ptr_eq(s, &slot)) { jobs.remove(j); }
            }
            let Some(mut child) = child else { let _ = std::fs::remove_file(&tmp); return Err("cancelled".into()) };
            let st = child.wait().map_err(err)?;
            let e = errs.join().unwrap_or_default();
            if !st.success() { let _ = std::fs::remove_file(&tmp); return Err(tail(&e)); }
            std::fs::rename(&tmp, &o).map_err(err)
        }).await.map_err(err)??;
    }
    let s = out.to_string_lossy().into_owned();
    srv.allow(&s);
    Ok(s)
}

/// Stop the proxy render running for a clip (its curve changed again).
#[tauri::command]
fn proxy_cancel(job: String) {
    if let Some(s) = PX_JOBS.lock().unwrap().remove(&job) { if let Some(mut c) = s.lock().unwrap().take() { let _ = c.kill(); } }
}

struct MediaProxyJob {
    id: String,
    path: String,
    cancelled: bool,
    child: Option<Child>,
}

fn proxy_hash(value: impl std::hash::Hash) -> String {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn media_source_key(path: &str) -> R<String> {
    let meta = std::fs::metadata(path).map_err(err)?;
    Ok(proxy_hash((path, meta.len(), meta.modified().map_err(err)?)))
}

fn media_proxy_dir(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_cache_dir().map_err(err)?.join("media-proxies"))
}

fn media_proxy_path(dir: &Path, path: &str, source_key: &str, high: bool) -> PathBuf {
    dir.join(format!("{}-{source_key}-{}.mp4", proxy_hash(path), if high { 1280 } else { 960 }))
}

fn assert_original_inputs(app: &AppHandle, args: &[String]) -> R<()> {
    let dir = media_proxy_dir(app)?;
    let canonical = dir.canonicalize().ok();
    for pair in args.windows(2).filter(|pair| pair[0] == "-i") {
        let path = Path::new(&pair[1]);
        if path.starts_with(&dir) || canonical.as_ref().is_some_and(|d| path.canonicalize().is_ok_and(|p| p.starts_with(d))) {
            return Err("Editing proxies cannot be used as export inputs".into());
        }
    }
    Ok(())
}

#[tauri::command]
async fn media_proxy_info(app: AppHandle, srv: State<'_, Arc<MediaServer>>, paths: Vec<String>, high: bool) -> R<Value> {
    let dir = media_proxy_dir(&app)?;
    let srv = srv.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = serde_json::Map::new();
        for path in paths {
            let Ok(key) = media_source_key(&path) else { continue };
            let out = media_proxy_path(&dir, &path, &key, high);
            let cached = out.is_file().then(|| {
                let out = out.to_string_lossy().into_owned();
                srv.allow(&out);
                out
            });
            entries.insert(path, json!({ "sourceKey": key, "path": cached }));
        }
        Value::Object(entries)
    }).await.map_err(err)
}

#[tauri::command]
fn media_proxy_size(app: AppHandle) -> R<u64> {
    Ok(std::fs::read_dir(media_proxy_dir(&app)?).into_iter().flatten().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
        .filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum())
}

#[tauri::command]
fn delete_media_proxies(app: AppHandle, state: State<AppState>, path: Option<String>) -> R<()> {
    let active = state.media_proxy.lock().unwrap();
    if active.as_ref().is_some_and(|job| path.as_ref().is_none_or(|p| *p == job.path)) {
        return Err("Cancel the media proxy job before deleting it".into());
    }
    let prefix = path.map(|p| format!("{}-", proxy_hash(p)));
    let entries = match std::fs::read_dir(media_proxy_dir(&app)?) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    for e in entries {
        let e = e.map_err(err)?;
        let name = e.file_name();
        let name = name.to_string_lossy();
        if (name.ends_with(".mp4") || name.ends_with(".part"))
            && prefix.as_ref().is_none_or(|p| name.starts_with(p))
        {
            std::fs::remove_file(e.path()).map_err(err)?;
        }
    }
    Ok(())
}

fn encode_media_proxy(app: &AppHandle, job: &Mutex<Option<MediaProxyJob>>, args: &[String], duration: f64, id: &str) -> R<()> {
    let mut active = job.lock().unwrap();
    let active_job = active.as_mut().unwrap();
    if active_job.cancelled { return Err("cancelled".into()); }
    let mut child = command(&sidecar("ffmpeg")).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
    let (stdout, mut stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    active_job.child = Some(child);
    drop(active);
    let stderr = std::thread::spawn(move || {
        let mut log = String::new();
        let _ = stderr.read_to_string(&mut log);
        log
    });
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|s| s.parse::<f64>().ok()) {
            if duration > 0.0 {
                let _ = app.emit("mediaproxyprog", json!({ "job": id, "p": (us / 1e6 / duration).clamp(0.0, 0.99) }));
            }
        }
    }
    let log = stderr.join().unwrap_or_default();
    let mut active = job.lock().unwrap();
    let active_job = active.as_mut().unwrap();
    let status = active_job.child.take().unwrap().wait().map_err(err)?;
    if active_job.cancelled { return Err("cancelled".into()); }
    if status.success() { Ok(()) } else { Err(tail(&log)) }
}

#[tauri::command]
async fn make_proxy(app: AppHandle, srv: State<'_, Arc<MediaServer>>, path: String, high: bool, tone_map: String, job: String, source_key: String) -> R<String> {
    let srv = srv.inner().clone();
    let dir = media_proxy_dir(&app)?;
    let out = media_proxy_path(&dir, &path, &source_key, high);
    {
        let state = app.state::<AppState>();
        let mut active = state.media_proxy.lock().unwrap();
        if active.is_some() { return Err("another media proxy is running".into()); }
        *active = Some(MediaProxyJob { id: job.clone(), path: path.clone(), cancelled: false, child: None });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let tmp = out.with_extension("part");
        let cached = out.is_file();
        let result = (|| {
            if media_source_key(&path)? != source_key { return Err("Source changed".into()); }
            if !cached {
                std::fs::create_dir_all(&dir).map_err(err)?;
                let m = probe_one(&path)?;
                if m["kind"] != "video" { return Err("Expected video".into()); }
                let w = m["w"].as_f64().filter(|w| *w > 0.0).ok_or("Missing video width")?;
                let h = m["h"].as_f64().filter(|h| *h > 0.0).ok_or("Missing video height")?;
                let scale = (if high { 1280.0 } else { 960.0 } / w.max(h)).min(1.0);
                let even = |v: f64| ((v * scale / 2.0).round() * 2.0).max(2.0);
                let prefix = if tone_map.is_empty() { String::new() } else { format!("{tone_map},") };
                let filter = format!("{prefix}scale={}:{}", even(w), even(h));
                let mut args = vec!["-y", "-v", "error", "-nostats", "-progress", "pipe:1",
                    "-filter_threads", "2", "-threads", "2", "-i", &path, "-map", "0:V:0", "-map", "0:a:0?",
                    "-vf", &filter, "-g", "15", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
                    "-enc_time_base:v", "-1", "-c:a", "aac", "-ac", "2", "-b:a", "128k", "-movflags", "+faststart"];
                if !tone_map.is_empty() { args.extend(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]); }
                let run = |encoder: &[&str]| {
                    let out = tmp.to_string_lossy();
                    let args = args.iter().copied().chain(encoder.iter().copied()).chain(["-f", "mp4", out.as_ref()])
                        .map(str::to_owned).collect::<Vec<_>>();
                    encode_media_proxy(&app, &state.media_proxy, &args, m["dur"].as_f64().unwrap_or(0.0), &job)
                };
                if !cfg!(target_os = "macos") || run(&["-c:v", "h264_videotoolbox", "-allow_sw", "0", "-realtime", "1", "-b:v", if high { "4M" } else { "2M" }]).is_err() {
                    run(&["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-threads", "2"])?;
                }
                if media_source_key(&path)? != source_key { return Err("Source changed".into()); }
            }
            Ok(())
        })();
        let mut active = state.media_proxy.lock().unwrap();
        let cancelled = active.take().unwrap().cancelled;
        let result = if cancelled { Err("cancelled".into()) } else {
            result.and_then(|()| if cached { Ok(()) } else { std::fs::rename(&tmp, &out).map_err(err) })
        };
        if result.is_err() { let _ = std::fs::remove_file(&tmp); }
        result?;
        let path = out.to_string_lossy().into_owned();
        srv.allow(&path);
        Ok(path)
    }).await.map_err(err)?
}

#[tauri::command]
fn cancel_media_proxy(state: State<AppState>, job: String) {
    if let Some(active) = state.media_proxy.lock().unwrap().as_mut().filter(|a| a.id == job) {
        active.cancelled = true;
        if let Some(child) = &mut active.child { let _ = child.kill(); }
    }
}

/// Raw frames for motion tracking: ffmpeg's stdout handed to JS as bytes.
#[tauri::command]
async fn gray_frames(args: Vec<String>) -> R<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = command(&sidecar("ffmpeg")).args(&args).stdin(Stdio::null()).output().map_err(err)?;
        if !out.status.success() { return Err(tail(&String::from_utf8_lossy(&out.stderr))); }
        Ok(tauri::ipc::Response::new(out.stdout))
    }).await.map_err(err)?
}

/// Audio effects that need the whole file (d = RNNoise speech denoise with the bundled model,
/// n = loudness normalize): the source's sound is processed once into a cached FLAC that both
/// the preview and the export play instead of the original.
#[tauri::command]
async fn audio_fx(app: AppHandle, srv: State<'_, Arc<MediaServer>>, path: String, fx: String) -> R<String> {
    use std::hash::{Hash, Hasher};
    let mut chain = vec![];
    if fx.contains('d') { chain.push("highpass=f=70,arnndn=m=rnnoise.rnnn"); }
    if fx.contains('n') { chain.push("loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=48000"); }
    if fx == "x" { chain.push("anull"); } // plain sound track, for the preview's Web Audio playback
    if chain.is_empty() { return Err("no audio effect".into()); }
    let af = chain.join(",");
    let meta = std::fs::metadata(&path).map_err(err)?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&path, meta.len(), meta.modified().ok(), &af).hash(&mut h);
    let dir = app.path().app_data_dir().map_err(err)?.join("denoise");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let out = dir.join(format!("{:016x}.flac", h.finish()));
    let res = app.path().resource_dir().map_err(err)?;
    let o = out.clone();
    if !out.exists() {
        tauri::async_runtime::spawn_blocking(move || -> R<()> {
            let tmp = o.with_extension("part.flac");
            // relative model path: Windows drive colons would need escaping inside the filter string
            let r = command(&sidecar("ffmpeg")).current_dir(&res)
                .args(["-hide_banner", "-y", "-i", &path, "-vn", "-af", &af, "-c:a", "flac"])
                .arg(&tmp).stdin(Stdio::null()).output().map_err(err)?;
            if !r.status.success() { return Err(tail(&String::from_utf8_lossy(&r.stderr))); }
            std::fs::rename(&tmp, &o).map_err(err)
        }).await.map_err(err)??;
    }
    let s = out.to_string_lossy().into_owned();
    srv.allow(&s);
    Ok(s)
}

#[derive(serde::Deserialize)]
struct MulticamInput {
    path: String,
    start: f64,
    duration: f64,
    audio: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MulticamMatch {
    offset: f64,
    confidence: f64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MulticamSync {
    audio: Option<usize>,
    matches: Vec<MulticamMatch>,
}

fn multicam_energy(input: &MulticamInput) -> Vec<f64> {
    use multicam_sync::FRAME;
    if !input.audio { return Vec::new(); }
    let Ok(mut child) = command(&sidecar("ffmpeg")).args([
        "-v", "error", "-nostdin", "-ss", &input.start.to_string(), "-i", &input.path,
        "-t", &input.duration.min(180.0).to_string(), "-map", "0:a:0", "-vn", "-ac", "1",
        "-af", "aresample=8000:async=1:first_pts=0", "-f", "s16le", "pipe:1",
    ]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
        return Vec::new();
    };
    let mut energy = Vec::new();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut frame = [0; FRAME * 2];
    while reader.read_exact(&mut frame).is_ok() {
        let power: f64 = frame.chunks_exact(2).map(|p| {
            (i16::from_le_bytes([p[0], p[1]]) as f64 / 32768.0).powi(2)
        }).sum();
        energy.push(power / FRAME as f64);
    }
    if child.wait().is_ok_and(|status| status.success()) { energy } else { Vec::new() }
}

#[tauri::command]
async fn sync_multicam(app: AppHandle, inputs: Vec<MulticamInput>, reference: Option<usize>, align: bool) -> R<MulticamSync> {
    if !(2..=9).contains(&inputs.len()) || reference.is_some_and(|i| !inputs.get(i).is_some_and(|a| a.audio))
        || inputs.iter().any(|i| !i.start.is_finite() || i.start < 0.0 || !i.duration.is_finite() || i.duration <= 0.0) {
        return Err("Invalid multicam inputs".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _job = state.multicam_sync.lock().map_err(err)?;
        let cache = app.path().app_cache_dir().map_err(err)?.join("multicam-sync");
        let sources: Vec<_> = inputs.iter().map(|i| {
            (media_source_key(&i.path).ok(), i.start.to_bits(), i.duration.to_bits(), i.audio)
        }).collect();
        let cacheable = sources.iter().all(|s| s.0.is_some());
        let file = cache.join(format!("{}.json", proxy_hash((1, &sources, reference, align))));
        if cacheable {
            if let Some(hit) = std::fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
                return Ok(hit);
            }
        }
        let energy: Vec<_> = inputs.iter().map(multicam_energy).collect();
        let audio = reference.or_else(|| inputs.iter().enumerate().filter(|(_, i)| i.audio)
            .max_by(|(a, _), (b, _)| {
                let rank = |i: usize| energy[i].iter().sum::<f64>();
                rank(*a).total_cmp(&rank(*b)).then_with(|| inputs[*a].duration.total_cmp(&inputs[*b].duration))
            }).map(|(i, _)| i));
        let env: Vec<_> = if align { energy.iter().map(|e| multicam_sync::envelope(e)).collect() } else { Vec::new() };
        let matches = energy.iter().enumerate().map(|(i, e)| {
            let (offset, confidence) = match audio.filter(|_| align) {
                Some(r) if r != i => multicam_sync::correlate(&env[r], &env[i], 60 * multicam_sync::HZ),
                Some(_) if e.iter().any(|v| *v > 1e-8) => (0.0, 1.0),
                _ => (0.0, 0.0),
            };
            MulticamMatch { offset, confidence }
        }).collect();
        let result = MulticamSync { audio, matches };
        if cacheable && inputs.iter().zip(&energy).all(|(i, e)| !i.audio || !e.is_empty())
            && inputs.iter().zip(&sources).all(|(i, s)| media_source_key(&i.path).ok() == s.0) {
            if let Ok(bytes) = serde_json::to_vec(&result) {
                if std::fs::create_dir_all(&cache).is_ok() { let _ = std::fs::write(file, bytes); }
            }
        }
        Ok(result)
    }).await.map_err(err)?
}

#[tauri::command]
async fn speech_regions(app: AppHandle, path: String, threshold_db: Option<f64>, silences: Option<bool>) -> R<Vec<(f64, f64)>> {
    use std::hash::{Hash, Hasher};
    let dir = app.path().app_data_dir().map_err(err)?.join("speech");
    tauri::async_runtime::spawn_blocking(move || {
        const FILTER: &str = "aresample=16000:async=1:first_pts=0,silencedetect=n=-38dB:d=0.20";
        let silence = silences.unwrap_or(false);
        let custom;
        let filter = if silence {
            let db = threshold_db.filter(|db| db.is_finite()).unwrap_or(-40.0).clamp(-100.0, 0.0);
            custom = format!("aresample=16000:async=1:first_pts=0,silencedetect=n={db}dB:d=0.001");
            custom.as_str()
        } else { FILTER };
        static SCAN: Mutex<()> = Mutex::new(());
        let _scan = SCAN.lock().unwrap();
        let meta = std::fs::metadata(&path).map_err(err)?;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&path, meta.len(), meta.modified().ok(), filter).hash(&mut h);
        let out = dir.join(format!("{:016x}.json", h.finish()));
        if let Ok(data) = std::fs::read(&out) {
            if let Ok(regions) = serde_json::from_slice(&data) { return Ok(regions); }
        }
        let result = command(&sidecar("ffmpeg")).args([
            "-hide_banner", "-nostats", "-progress", "pipe:1", "-i", &path,
            "-map", "0:a:0", "-af", filter, "-f", "null", "-",
        ]).stdin(Stdio::null()).output().map_err(err)?;
        let log = String::from_utf8_lossy(&result.stderr);
        if !result.status.success() { return Err(tail(&log)); }
        let progress = String::from_utf8_lossy(&result.stdout);
        let dur = progress.lines().rev().filter_map(|l| l.strip_prefix("out_time_us=")?.parse::<f64>().ok())
            .next().unwrap_or(0.0) / 1e6;
        let mut regions = Vec::new();
        let mut start: f64 = 0.0;
        for line in log.lines() {
            if let Some((_, end)) = line.split_once("silence_start: ") {
                if let Ok(end) = end.trim().parse::<f64>() {
                    if end.min(dur) > start { regions.push((start, end.min(dur))); }
                    start = dur;
                }
            }
            if let Some((_, end)) = line.split_once("silence_end: ") {
                if let Some(end) = end.split_whitespace().next().and_then(|s| s.parse::<f64>().ok()) {
                    start = end.clamp(0.0, dur);
                }
            }
        }
        if dur > start { regions.push((start, dur)); }
        if silence {
            let mut at = 0.0;
            let mut gaps = Vec::new();
            for (a, b) in regions {
                if a > at { gaps.push((at, a)); }
                at = b;
            }
            if dur > at { gaps.push((at, dur)); }
            regions = gaps;
        }
        std::fs::create_dir_all(&dir).map_err(err)?;
        let tmp = out.with_extension(format!("{}.part", std::process::id()));
        std::fs::write(&tmp, serde_json::to_vec(&regions).map_err(err)?).map_err(err)?;
        std::fs::rename(&tmp, &out).map_err(err)?;
        Ok(regions)
    }).await.map_err(err)?
}

/// Stabilize (vidstab, two passes) the whole source once per file and strength into a cached copy
/// that then stands in for the original in both the preview and the export.
#[tauri::command]
async fn video_stab(app: AppHandle, srv: State<'_, Arc<MediaServer>>, path: String, level: u32, tone_map: Option<String>) -> R<String> {
    use std::hash::{Hash, Hasher};
    let (shk, smooth) = match level { 1 => (4, 10), 3 => (10, 45), _ => (7, 25) };
    let meta = std::fs::metadata(&path).map_err(err)?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&path, meta.len(), meta.modified().ok(), shk, smooth).hash(&mut h);
    let tone_map = tone_map.filter(|s| !s.is_empty());
    if let Some(filter) = &tone_map { filter.hash(&mut h); }
    let key = format!("{:016x}", h.finish());
    let dir = app.path().app_data_dir().map_err(err)?.join("stab");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let out = dir.join(format!("{key}.mp4"));
    if !out.exists() {
        let (o, d) = (out.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || -> R<()> {
            // relative .trf name (cwd = cache dir): drive colons would need escaping inside the filter string
            let trf = format!("{key}.trf");
            let run = |a: Vec<String>| -> R<()> {
                let r = command(&sidecar("ffmpeg")).current_dir(&d).args(&a).stdin(Stdio::null()).output().map_err(err)?;
                if r.status.success() { Ok(()) } else { Err(tail(&String::from_utf8_lossy(&r.stderr))) }
            };
            let s = |x: &str| x.to_string();
            let prefix = tone_map.as_ref().map(|f| format!("{f},")).unwrap_or_default();
            run(vec![s("-hide_banner"), s("-y"), s("-i"), path.clone(), s("-vf"), format!("{prefix}vidstabdetect=shakiness={shk}:accuracy=15:result={trf}"), s("-f"), s("null"), s("-")])?;
            let tmp = o.with_extension("part.mp4");
            let mut args = vec![s("-hide_banner"), s("-y"), s("-i"), path.clone(), s("-vf"), format!("{prefix}vidstabtransform=input={trf}:smoothing={smooth}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3"),
                s("-c:v"), s("libx264"), s("-preset"), s("medium"), s("-crf"), s("16"), s("-pix_fmt"), s("yuv420p"), s("-c:a"), s("aac"), s("-b:a"), s("256k"),
                s("-movflags"), s("+faststart")];
            if tone_map.is_some() { args.extend(["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"].map(s)); }
            args.push(tmp.to_string_lossy().into_owned());
            run(args)?;
            let _ = std::fs::remove_file(d.join(&trf));
            std::fs::rename(&tmp, &o).map_err(err)
        }).await.map_err(err)??;
    }
    let s = out.to_string_lossy().into_owned();
    srv.allow(&s);
    Ok(s)
}

#[tauri::command]
fn model_ready(app: AppHandle, model: String) -> R<bool> {
    Ok(model_path(&app, &model)?.exists())
}

#[tauri::command]
async fn model_download(app: AppHandle, model: String) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = model_path(&app, &model)?;
        std::fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
        let res = ureq::get(&format!("{MODEL_BASE}ggml-{model}.bin")).call().map_err(err)?;
        let total: f64 = res.header("content-length").and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let part = file.with_extension("part");
        let mut w = std::fs::File::create(&part).map_err(err)?;
        let mut r = res.into_reader();
        let mut buf = vec![0u8; 1 << 16];
        let (mut got, mut last) = (0f64, 0f64);
        loop {
            let n = r.read(&mut buf).map_err(err)?;
            if n == 0 { break; }
            w.write_all(&buf[..n]).map_err(err)?;
            got += n as f64;
            if total > 0.0 && got / total - last > 0.005 {
                last = got / total;
                let _ = app.emit("progress", json!({ "label": "model", "p": last }));
            }
        }
        w.flush().map_err(err)?;
        drop(w);
        std::fs::rename(part, file).map_err(err)
    }).await.map_err(err)?
}

// ---------- fonts ----------
// Pick samples from the Unicode cmap so the webview never has to substitute a preview glyph.
fn system_font_sample(data: &[u8], index: u32, name: &str) -> Option<String> {
    let face = ttf_parser::Face::parse(data, index).ok()?;
    let supports = |text: &str| text.chars().filter(|c| !c.is_whitespace()).all(|c| face.glyph_index(c).is_some());
    match (supports("Aa"), supports("أبجد هوز")) {
        (true, true) => return Some("Aa أبجد هوز".into()),
        (true, false) => return Some("Aa".into()),
        (false, true) => return Some("أبجد هوز".into()),
        _ => {}
    }
    if supports(name) { return Some(name.chars().take(8).collect()); }
    // Other scripts: a few direct glyph lookups; walking the whole cmap of every installed face is too slow.
    ["αβγ", "абв", "אבג", "कखग", "กขค", "あいう", "漢字", "한글"].into_iter().find(|t| supports(t)).map(String::from)
}

// Families installed on this computer, with the exact face and its supported preview text.
#[tauri::command]
async fn system_fonts(srv: State<'_, Arc<MediaServer>>) -> Result<Value, ()> {
    let srv = srv.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut fams: std::collections::BTreeMap<String, (String, Vec<Value>)> = Default::default();
        for f in db.faces() {
            let Some(name) = f.families.first().map(|x| x.0.clone()).filter(|n| !n.starts_with('.')) else { continue };
            let path = match &f.source { fontdb::Source::File(p) => p.clone(), fontdb::Source::SharedFile(p, _) => p.clone(), _ => continue };
            let e = fams.entry(name.to_lowercase()).or_insert_with(|| (name.clone(), vec![]));
            let (collection, sample) = db.with_face_data(f.id, |data, index| {
                (data.starts_with(b"ttcf"), system_font_sample(data, index, &name))
            }).unwrap_or((f.index > 0, None));
            let p = path.to_string_lossy().into_owned();
            srv.allow(&p);
            e.1.push(json!({ "path": p, "index": f.index, "collection": collection, "sample": sample,
                "weight": f.weight.0, "italic": f.style != fontdb::Style::Normal }));
        }
        Value::Array(fams.into_values().map(|(n, files)| json!({ "family": n, "files": files })).collect())
    }).await.unwrap_or(Value::Array(vec![])))
}

// Autosave target for projects that were never saved to a file.
#[tauri::command]
fn recovery_path(app: AppHandle) -> R<String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("recovery");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("autosave.maqto").to_string_lossy().into_owned())
}

fn fonts_dir(app: &AppHandle) -> R<PathBuf> { Ok(app.path().app_data_dir().map_err(err)?.join("fonts")) }

// Google Fonts families downloaded inside the app: { family: [file paths] }.
#[tauri::command]
fn fonts_downloaded(app: AppHandle) -> R<Value> {
    let mut out = serde_json::Map::new();
    let Ok(rd) = std::fs::read_dir(fonts_dir(&app)?) else { return Ok(Value::Object(out)) };
    for d in rd.flatten() {
        let fam = d.file_name().to_string_lossy().to_string();
        let files: Vec<String> = std::fs::read_dir(d.path()).map(|r| r.flatten().map(|f| f.path())
            .filter(|p| p.extension().map_or(false, |e| e == "ttf" || e == "otf")).map(|p| p.to_string_lossy().to_string()).collect()).unwrap_or_default();
        if !files.is_empty() { out.insert(fam, json!(files)); }
    }
    Ok(Value::Object(out))
}

// Download one Google Fonts family (its download manifest lists the file URLs) into the app's font folder.
#[tauri::command]
async fn font_fetch(app: AppHandle, family: String) -> R<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        if family.contains('/') || family.contains('\\') || family.contains("..") { return Err("bad family".into()); }
        let url = format!("https://fonts.google.com/download/list?family={}", family.replace(' ', "%20"));
        let body = ureq::get(&url).call().map_err(err)?.into_string().map_err(err)?;
        let j: Value = serde_json::from_str(body.trim_start_matches(")]}'").trim_start()).map_err(err)?;
        let refs = j["manifest"]["fileRefs"].as_array().cloned().unwrap_or_default();
        let name = |r: &Value| r["filename"].as_str().unwrap_or("").to_string();
        let upright: Vec<&Value> = refs.iter().filter(|r| { let n = name(r); n.ends_with(".ttf") && !n.to_lowercase().contains("italic") }).collect();
        let var: Vec<&Value> = upright.iter().copied().filter(|r| { let n = name(r); !n.starts_with("static/") && (n.contains('[') || n.contains("VariableFont")) }).take(1).collect();
        // no variable font: base optical size statics in regular / bold / black (skip Family_24pt-…)
        let pick = if var.is_empty() { upright.into_iter().filter(|r| { let n = name(r); !n.contains("pt-") && ["-Regular.", "-Bold.", "-Black."].iter().any(|w| n.contains(w)) }).collect() } else { var };
        if pick.is_empty() { return Err("no font files".into()); }
        let dir = fonts_dir(&app)?.join(&family);
        let part = dir.with_extension("part");
        let _ = std::fs::remove_dir_all(&part);
        std::fs::create_dir_all(&part).map_err(err)?;
        for r in &pick {
            let u = r["url"].as_str().ok_or("bad manifest")?;
            if !u.starts_with("https://fonts.gstatic.com/") { return Err("unexpected font host".into()); }
            let file = Path::new(&name(r)).file_name().ok_or("bad name")?.to_os_string();
            let mut rd = ureq::get(u).call().map_err(err)?.into_reader();
            let mut w = std::fs::File::create(part.join(file)).map_err(err)?;
            std::io::copy(&mut rd, &mut w).map_err(err)?;
        }
        for f in j["manifest"]["files"].as_array().cloned().unwrap_or_default() {
            let n = name(&f);
            if n.contains("OFL") || n.contains("LICENSE") { let _ = std::fs::write(part.join(Path::new(&n).file_name().unwrap()), f["contents"].as_str().unwrap_or("")); }
        }
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&part, &dir).map_err(err)?;
        let files = std::fs::read_dir(&dir).map_err(err)?.flatten().map(|f| f.path())
            .filter(|p| p.extension().map_or(false, |e| e == "ttf")).map(|p| p.to_string_lossy().to_string()).collect();
        Ok(files)
    }).await.map_err(err)?
}

fn find_whisper() -> Option<PathBuf> {
    // shortcut: falls back to a system whisper.cpp (brew install whisper-cpp); bundle whisper-cli as a sidecar before wide release.
    let bundled = sidecar("whisper-cli");
    if bundled.exists() { return Some(bundled); }
    let mut dirs: Vec<PathBuf> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
    dirs.into_iter().map(|d| d.join(exe_name("whisper-cli"))).find(|p| p.exists())
}

#[tauri::command]
async fn transcribe(app: AppHandle, id: u32, audio_args: Vec<String>, lang: String, model: String) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let whisper = find_whisper().ok_or("whisper")?;
        let dir = work_dir(&state, id)?;
        let a = app.clone();
        let _ = a.emit("progress", json!({ "label": "audio", "p": 0 }));
        let r = (|| {
            run_job(&state, &sidecar("ffmpeg"), &audio_args, |_| {})?;
            let base = dir.join("out");
            let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4).to_string();
            // DTW token times (-dtw, needs -nfa, read from -ojf): plain whisper word times run up to ~0.8 s early.
            let dtw = if model.starts_with("large-v3-turbo") { "large.v3.turbo" } else if model.starts_with("large-v3") { "large.v3" } else { "small" };
            let args: Vec<String> = ["-m", &model_path(&app, &model)?.to_string_lossy(), "-f", &dir.join("mix.wav").to_string_lossy(),
                "-l", &lang, "-ml", "1", "-sow", "-oj", "-ojf", "-nfa", "-dtw", dtw, "-of", &base.to_string_lossy(), "-t", &threads, "-pp", "-np"]
                .iter().map(|s| s.to_string()).collect();
            let a2 = a.clone();
            run_job(&state, &whisper, &args, move |l| {
                if let Some(i) = l.find("progress =") {
                    if let Ok(p) = l[i + 10..].trim().trim_end_matches('%').trim().parse::<f64>() {
                        let _ = a2.emit("progress", json!({ "label": "asr", "p": p / 100.0 }));
                    }
                }
            })?;
            std::fs::read_to_string(base.with_extension("json")).map_err(err)
        })();
        if let Some(d) = state.dirs.lock().unwrap().remove(&id) { let _ = std::fs::remove_dir_all(d); }
        r
    }).await.map_err(err)?
}

// Dev builds only: MAQTO_DEMO="a.mp4;b.wav" preloads media, MAQTO_DEMO_EXPORT=out.mp4 exports it. Lets tests drive the app.
#[tauri::command]
fn dev_demo() -> Value {
    if !cfg!(debug_assertions) { return json!({}); }
    let paths: Vec<String> = std::env::var("MAQTO_DEMO").unwrap_or_default().split(';').filter(|s| !s.is_empty()).map(String::from).collect();
    json!({ "paths": paths, "export": std::env::var("MAQTO_DEMO_EXPORT").ok() })
}

#[tauri::command]
fn dev_log(msg: String) {
    if cfg!(debug_assertions) { eprintln!("[web] {msg}"); }
}

fn cleanup(st: &AppState) {
    if let Some(mut c) = st.job.lock().unwrap().take() { let _ = c.kill(); }
    for (_, d) in st.dirs.lock().unwrap().drain() { let _ = std::fs::remove_dir_all(d); }
}

#[tauri::command]
fn splash_show(app: AppHandle) {
    if let Some(s) = app.get_webview_window("splash") { let _ = s.show(); }
}

#[tauri::command]
fn splash_done(app: AppHandle) {
    let Some(s) = app.get_webview_window("splash") else { return };
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
    let _ = s.destroy();
}

#[tauri::command]
fn path_exists(path: String) -> bool { Path::new(&path).exists() }

#[tauri::command]
fn quit_app(app: AppHandle, state: State<AppState>) {
    app.state::<reframe::Reframe>().cancel(None);
    cleanup(&state);
    app.exit(0);
}

// macOS app menu. Our own Quit item (Cmd+Q) goes through the page so it can offer to save first;
// the stock Quit terminates without an event we can hold.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let quit = MenuItem::with_id(app, "quit", "Quit Maqto", true, Some("CmdOrCtrl+Q"))?;
    let shortcuts = MenuItem::with_id(app, "shortcuts", "Keyboard Shortcuts…", true, None::<&str>)?;
    let maqto = Submenu::with_items(app, "Maqto", true, &[
        &P::about(app, None, None)?, &shortcuts, &P::separator(app)?, &P::services(app, None)?, &P::separator(app)?,
        &P::hide(app, None)?, &P::hide_others(app, None)?, &P::show_all(app, None)?, &P::separator(app)?, &quit,
    ])?;
    // The webview owns editor accelerators so rebinding also releases the old keys.
    let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
    let file = Submenu::with_items(app, "File", true, &[
        &item("new", "New Project")?, &item("open", "Open…")?, &P::separator(app)?,
        &item("save", "Save")?, &item("saveAs", "Save As…")?, &P::separator(app)?,
        &item("import", "Import Media…")?, &item("export", "Export Video…")?,
        &P::separator(app)?, &item("importTimeline", "Import Timeline…")?, &item("exportTimeline", "Export Timeline As…")?,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &P::undo(app, None)?, &P::redo(app, None)?, &P::separator(app)?,
        &P::cut(app, None)?, &P::copy(app, None)?, &P::paste(app, None)?, &P::select_all(app, None)?,
    ])?;
    let workspaces = MenuItem::with_id(app, "workspaces", "Workspaces", true, None::<&str>)?;
    let window = Submenu::with_items(app, "Window", true, &[
        &P::minimize(app, None)?, &P::maximize(app, None)?, &P::fullscreen(app, None)?,
        &P::separator(app)?, &workspaces,
    ])?;
    Menu::with_items(app, &[&maqto, &file, &edit, &window])
}

/// iOS: the exported video goes into the Photos library (Info.plist has NSPhotoLibraryAddUsageDescription)
#[tauri::command]
fn save_to_photos(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use objc2_foundation::NSString;
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("no video data".into()) };
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let path = std::env::temp_dir().join(format!("maqto-{ms}.mp4"));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        let s = NSString::from_str(&path.to_string_lossy());
        #[link(name = "UIKit", kind = "framework")]
        extern "C" {
            fn UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(path: &NSString) -> bool;
            fn UISaveVideoAtPathToSavedPhotosAlbum(path: &NSString, target: *const std::ffi::c_void, sel: *const std::ffi::c_void, ctx: *mut std::ffi::c_void);
        }
        unsafe {
            if !UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(&s) { return Err("Photos cannot take this video".into()); }
            UISaveVideoAtPathToSavedPhotosAlbum(&s, std::ptr::null(), std::ptr::null(), std::ptr::null_mut());
        }
        Ok(())
    }
    #[cfg(not(target_os = "ios"))]
    { let _ = request; Err("iOS only".into()) }
}

// Auto captions on iPhone: Apple's speech recognizer (on the phone when the language supports it), WAV bytes in, words out.
#[tauri::command]
async fn speech_to_text(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("no audio".into()) };
        let lang = request.headers().get("lang").and_then(|v| v.to_str().ok()).unwrap_or("ar").to_string();
        let ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let path = std::env::temp_dir().join(format!("maqto-stt-{ns}.wav"));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || { let r = ios_stt(&path, &lang); let _ = std::fs::remove_file(&path); r })
            .await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "ios"))]
    { let _ = request; Err("iOS only".into()) }
}

#[cfg(target_os = "ios")]
fn ios_stt(path: &std::path::Path, lang: &str) -> Result<String, String> {
    use objc2::AnyThread;
    use objc2_foundation::{NSError, NSLocale, NSOperationQueue, NSString, NSURL};
    use objc2_speech::{SFSpeechRecognitionResult, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus as Auth, SFSpeechURLRecognitionRequest};
    use std::sync::mpsc;
    unsafe {
        let mut st = SFSpeechRecognizer::authorizationStatus();
        if st == Auth::NotDetermined {
            let (tx, rx) = mpsc::channel();
            let blk = block2::RcBlock::new(move |s: Auth| { let _ = tx.send(s); });
            SFSpeechRecognizer::requestAuthorization(&blk);
            st = rx.recv().map_err(|e| e.to_string())?;
        }
        if st != Auth::Authorized { return Err("denied".into()); }
        // prefer a locale the phone can do offline
        let ids: &[&str] = if lang == "en" { &["en-US", "en-GB"] } else { &["ar-EG", "ar-SA", "ar-AE"] };
        let mut pick = None;
        for id in ids {
            let loc = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(id));
            let Some(r) = SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &loc) else { continue };
            if !r.isAvailable() { continue; }
            let od = r.supportsOnDeviceRecognition();
            if od || pick.is_none() { pick = Some((r, od)); }
            if od { break; }
        }
        let (rec, on_device) = pick.ok_or("unavailable")?;
        rec.setQueue(&NSOperationQueue::new()); // results must not wait on the main thread
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let req = SFSpeechURLRecognitionRequest::initWithURL(SFSpeechURLRecognitionRequest::alloc(), &url);
        req.setShouldReportPartialResults(false);
        req.setRequiresOnDeviceRecognition(on_device);
        req.setAddsPunctuation(true);
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let blk = block2::RcBlock::new(move |res: *mut SFSpeechRecognitionResult, err: *mut NSError| {
            if let Some(res) = res.as_ref() {
                if !res.isFinal() { return; }
                let words: Vec<_> = res.bestTranscription().segments().iter()
                    .map(|g| serde_json::json!({ "w": g.substring().to_string(), "s": g.timestamp(), "e": g.timestamp() + g.duration() })).collect();
                let _ = tx.send(Ok(serde_json::json!({ "words": words, "onDevice": on_device }).to_string()));
            } else if let Some(e) = err.as_ref() {
                let _ = tx.send(Err(e.localizedDescription().to_string()));
            }
        });
        let task = rec.recognitionTaskWithRequest_resultHandler(&req, &blk);
        let out = rx.recv_timeout(std::time::Duration::from_secs(300)).map_err(|_| "timeout".to_string());
        task.cancel();
        out?
    }
}

// Auto captions on iPhone with the desktop's own whisper model (model_download fetches it once):
// 16 kHz mono f32 in, the same JSON whisper-cli writes with -ojf (one word per segment, DTW times) out.
#[tauri::command]
async fn whisper_words(app: AppHandle, request: tauri::ipc::Request<'_>) -> R<String> {
    #[cfg(target_os = "ios")]
    {
        let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("no audio".into()) };
        let pcm: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let lang = request.headers().get("lang").and_then(|v| v.to_str().ok()).unwrap_or("ar").to_string();
        tauri::async_runtime::spawn_blocking(move || whisper_run(&app, &pcm, &lang)).await.map_err(err)?
    }
    #[cfg(not(target_os = "ios"))]
    { let _ = (app, request); Err("iOS only".into()) }
}

#[cfg(target_os = "ios")]
fn whisper_run(app: &AppHandle, pcm: &[f32], lang: &str) -> R<String> {
    use whisper_rs::*;
    // loaded per run, not kept: ~600 MB held while editing video gets the app killed
    let mut cp = WhisperContextParameters::default();
    cp.use_gpu(!cfg!(target_abi = "sim")); // the simulator's Metal can't hold the model; phones run it on the GPU
    cp.dtw_parameters(DtwParameters { mode: DtwMode::ModelPreset { model_preset: DtwModelPreset::LargeV3Turbo }, ..Default::default() });
    let ctx = WhisperContext::new_with_params(model_path(app, "large-v3-turbo-q5_0")?, cp).map_err(err)?;
    let mut st = ctx.create_state().map_err(err)?;
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(lang));
    p.set_max_len(1);
    p.set_split_on_word(true);
    p.set_token_timestamps(true);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_special(false);
    p.set_print_timestamps(false);
    p.set_n_threads(std::thread::available_parallelism().map(|n| n.get().clamp(2, 6)).unwrap_or(4) as i32);
    let a = app.clone();
    p.set_progress_callback_safe(move |q: i32| { let _ = a.emit("progress", json!({ "label": "asr", "p": q as f64 / 100.0 })); });
    st.full(p, pcm).map_err(err)?;
    let mut segs = vec![];
    for i in 0..st.full_n_segments() {
        let Some(s) = st.get_segment(i) else { continue };
        let toks: Vec<Value> = (0..s.n_tokens()).filter_map(|j| s.get_token(j))
            .map(|t| json!({ "text": t.to_str_lossy().map(|x| x.into_owned()).unwrap_or_default(), "t_dtw": t.token_data().t_dtw })).collect();
        segs.push(json!({ "text": s.to_str_lossy().map(|x| x.into_owned()).unwrap_or_default(),
            "offsets": { "from": s.start_timestamp() * 10, "to": s.end_timestamp() * 10 }, "tokens": toks }));
    }
    Ok(json!({ "transcription": segs }).to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let b = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let b = b.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init())
        .on_menu_event(|app, e| match e.id().as_ref() {
            "quit" => { let _ = app.emit("quit-requested", ()); }
            "workspaces" => { let _ = app.emit("menu-workspaces", ()); }
            "shortcuts" => { let _ = app.emit("menu-shortcuts", ()); }
            id @ ("new" | "open" | "save" | "saveAs" | "import" | "export" | "importTimeline" | "exportTimeline") => { let _ = app.emit("menu-file", id.to_string()); }
            _ => {}
        });
    b
        .manage(AppState::default())
        .manage(reframe::Reframe::default())
        .manage(MediaServer::start().expect("media server"))
        .invoke_handler(tauri::generate_handler![
            reframe::reframe_analyze, reframe::reframe_cancel,
            probe, save_project, save_chapters, save_timeline, read_timeline, open_project, recovery_path, work_begin, work_end, write_frame, export_run, loudness_measure, audio_fx, sync_multicam, speech_regions, video_stab, proxy_render, write_work, read_lut, lut_library, lut_add, lut_remove, sfx_library, sfx_import, overlay_library,
            cancel, take_open_file, model_ready, model_download, transcribe, save_recording, dev_demo, dev_log, media_base, quit_app, splash_show, splash_done, path_exists, gray_frames, make_proxy, cancel_media_proxy, media_proxy_info, media_proxy_size, delete_media_proxies, proxy_cancel, system_fonts, fonts_downloaded, font_fetch, mcp::mcp_reply, rife::rife_ready, rife::rife_download, rife::rife_make, matte::matte_ready, matte::matte_download, matte::matte_make, stems::stems_ready, stems::stems_download, stems::stems_make, stems::stems_raw, assistant::assistant_ready, assistant::assistant_ask, assistant::assistant_stop, save_to_photos, speech_to_text, whisper_words, matte::cut_ready, matte::cut_download, matte::cut_raw, matte::slow_raw
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(app_menu(app.handle())?)?;
            app.manage(mcp::Bridge::start(app.handle().clone()));
            // the editor UI is drawn at 80%: denser, closer to other desktop editors (all page coordinates scale with it)
            if let Some(w) = app.get_webview_window("main") { let _ = w.set_zoom(0.8); }
            // Windows/Linux pass a double-clicked project as the first argument
            if let Some(a) = std::env::args().nth(1) { offer_file(app.handle(), PathBuf::from(a)); }
            // launch intro runs in its own small window (it calls splash_done when it ends); the editor
            // loads hidden behind it. Fallback in case the intro never reports back.
            let h = app.handle().clone();
            std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(6)); splash_done(h); });
            Ok(())
        })
        .on_window_event(|w, e| if w.label() == "main" { match e {
            // The page decides: it asks to save unsaved work, then calls quit_app.
            tauri::WindowEvent::CloseRequested { api, .. } => { api.prevent_close(); let _ = w.emit("quit-requested", ()); }
            tauri::WindowEvent::Destroyed => {
                w.state::<reframe::Reframe>().cancel(None);
                cleanup(&w.state::<AppState>());
            }
            _ => {}
        } })
        .build(tauri::generate_context!())
        .expect("error while building Maqto")
        .run(|app, e| {
            // macOS hands double-clicked files over as an event
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &e {
                for u in urls { if let Ok(p) = u.to_file_path() { offer_file(app, p); } }
            }
            // Cmd+Q / app menu Quit: same question first. quit_app exits with a code, so it passes.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = e {
                api.prevent_exit();
                let _ = app.emit("quit-requested", ());
            }
        });
}

/* ---------- rename: data saved under the old identifier (app.kadr.editor) moves to app.maqto.editor ---------- */
pub fn migrate_old_id() {
    // dev builds run next to the installed app, which still uses the old folders: leave them alone
    if cfg!(debug_assertions) && std::env::var_os("MAQTO_MIGRATE").is_none() { return; }
    for base in id_bases() {
        let new = base.join("app.maqto.editor");
        migrate_dir(&base.join("app.kadr.editor"), &new);
        let (o, n) = (new.join("autosave.kadr"), new.join("autosave.maqto"));
        if o.exists() && !n.exists() { let _ = std::fs::rename(o, n); }
    }
    // Windows: the update installs maqto.exe and leaves the old kadr.exe beside it
    #[cfg(target_os = "windows")]
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) { let _ = std::fs::remove_file(d.join("kadr.exe")); }
}
/// Folders that hold one sub-folder per app identifier (app data, web storage, caches).
fn id_bases() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    #[cfg(target_os = "macos")]
    {
        let Some(h) = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from) else { return vec![] };
        vec![h.join("Library/Application Support"), h.join("Library/WebKit"), h.join("Library/Caches")]
    }
    #[cfg(target_os = "windows")]
    { ["APPDATA", "LOCALAPPDATA"].iter().filter_map(|k| std::env::var_os(k)).filter(|v| !v.is_empty()).map(PathBuf::from).collect() }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { vec![] }
}
/// Moves `old` to `new`. When `new` already exists, moves only the entries it lacks; never overwrites.
fn migrate_dir(old: &std::path::Path, new: &std::path::Path) {
    if !old.is_dir() { return; }
    if !new.exists() && std::fs::rename(old, new).is_ok() { return; }
    if std::fs::create_dir_all(new).is_err() { return; }
    let Ok(rd) = std::fs::read_dir(old) else { return };
    for e in rd.flatten() {
        let to = new.join(e.file_name());
        if !to.exists() { let _ = std::fs::rename(e.path(), to); }
    }
}
#[cfg(test)]
mod migrate_tests {
    use super::migrate_dir;
    #[test]
    fn moves_whole_folder_or_missing_entries() {
        let root = std::env::temp_dir().join(format!("maqto-mig-{}", std::process::id()));
        let (old, new) = (root.join("old"), root.join("new"));
        std::fs::create_dir_all(old.join("luts")).unwrap();
        std::fs::write(old.join("a.txt"), "old").unwrap();
        migrate_dir(&old, &new);
        assert!(!old.exists() && new.join("luts").is_dir() && std::fs::read_to_string(new.join("a.txt")).unwrap() == "old");
        // both exist: only what new lacks moves over, nothing is overwritten
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("a.txt"), "older").unwrap();
        std::fs::write(old.join("b.txt"), "b").unwrap();
        migrate_dir(&old, &new);
        assert_eq!(std::fs::read_to_string(new.join("a.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(new.join("b.txt")).unwrap(), "b");
        let _ = std::fs::remove_dir_all(&root);
    }
}
