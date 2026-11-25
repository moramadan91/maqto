use super::{command, err, exe_name, sidecar, tail, AppHandle, Emitter, Manager, R};
use serde::Deserialize;
use serde_json::json;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RELEASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const VERSION: &str = "v2.0.3";
const TTS_EXE: &str = "sherpa-onnx-offline-tts";
const DOWNLOAD: &str = "download";
static ACTIVE: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(0);

fn engine_url(os: &str, arch: &str) -> Option<String> {
    let asset = match (os, arch) {
        ("macos", "aarch64" | "x86_64") => "osx-universal2-shared",
        ("windows", "x86_64") => "win-x64-shared-MT-Release",
        _ => return None,
    };
    Some(format!("{RELEASE}/{VERSION}/sherpa-onnx-{VERSION}-{asset}.tar.bz2"))
}

fn platform_url() -> Option<String> {
    engine_url(std::env::consts::OS, std::env::consts::ARCH)
}

fn voice_url(voice: &str) -> R<String> {
    match voice {
        "ar_JO-kareem-medium" | "en_US-lessac-medium" => Ok(format!("{RELEASE}/tts-models/vits-piper-{voice}.tar.bz2")),
        _ => Err("Unknown Piper voice".into()),
    }
}

fn root(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("piper"))
}

fn engine_exe(dir: &Path) -> PathBuf {
    dir.join("bin").join(exe_name(TTS_EXE))
}

// lib/ stays beside bin/ so the binary's rpath finds the shared libraries.
fn engine_cmd(dir: &Path) -> Command {
    let mut cmd = command(&engine_exe(dir));
    cmd.current_dir(dir);
    cmd
}

fn has_engine(dir: &Path) -> bool {
    engine_exe(dir).is_file() && dir.join("lib").is_dir()
}

fn voice_model(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path())
        .find(|p| p.is_file() && p.extension().is_some_and(|x| x == "onnx"))
}

fn has_voice(dir: &Path) -> bool {
    voice_model(dir).is_some() && dir.join("tokens.txt").is_file() && dir.join("espeak-ng-data").is_dir()
}

/// The archives wrap their files in one top folder; return `dir` or its child that passes `ok`.
fn package_root(dir: &Path, ok: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    if ok(dir) { return Some(dir.to_path_buf()); }
    fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.is_dir() && ok(p))
}

struct Stage(PathBuf);
impl Stage {
    fn new(parent: &Path, prefix: &str) -> R<Self> {
        fs::create_dir_all(parent).map_err(err)?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_nanos();
        let count = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".{prefix}-{}-{stamp}-{count}", std::process::id()));
        fs::create_dir(&path).map_err(err)?;
        Ok(Self(path))
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Job(Arc<AtomicBool>);
impl Job {
    fn start(id: String) -> R<Self> {
        let mut active = ACTIVE.lock().unwrap();
        if active.is_some() {
            return Err("piper_busy".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some((id, cancelled.clone()));
        Ok(Self(cancelled))
    }

    fn check(&self) -> R<()> {
        if self.0.load(Ordering::Relaxed) { Err("cancelled".into()) } else { Ok(()) }
    }

    fn run(&self, cmd: &mut Command, stdin: Stdio, log: &Path) -> R<()> {
        self.check()?;
        let mut child = cmd.stdin(stdin).stdout(Stdio::null())
            .stderr(File::create(log).map_err(err)?).spawn().map_err(err)?;
        loop {
            match self.check().and_then(|_| child.try_wait().map_err(err)) {
                Ok(Some(status)) if status.success() => return self.check(),
                Ok(Some(status)) => return Err(format!("{status}\n{}", tail(&fs::read_to_string(log).unwrap_or_default()))),
                Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e);
                }
            }
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap() = None;
    }
}

#[tauri::command]
pub fn piper_cancel(job: String) {
    if let Some((id, flag)) = ACTIVE.lock().unwrap().as_ref() {
        if id == &job {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
pub fn piper_ready(app: AppHandle, voice: String) -> R<Option<bool>> {
    voice_url(&voice)?;
    let dir = root(&app)?;
    Ok(platform_url().map(|_| {
        has_engine(&dir.join("engine")) && has_voice(&dir.join("voices").join(&voice))
    }))
}

fn remove_dir(path: &Path) -> R<()> {
    match fs::remove_dir_all(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result.map_err(err),
    }
}

#[tauri::command]
pub fn piper_remove(app: AppHandle, voice: String) -> R<()> {
    voice_url(&voice)?;
    let _job = Job::start("remove".into())?;
    remove_dir(&root(&app)?.join("voices").join(voice))
}

fn download(job: &Job, url: &str, path: &Path, approximate: u64, missing: &str, progress: impl Fn(f64)) -> R<()> {
    job.check()?;
    let response = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(5))
        .build().get(url).call();
    job.check()?;
    let response = response.map_err(|e| match e {
            ureq::Error::Status(404, _) => missing.to_string(),
            _ => err(e),
        })?;
    let total = response.header("content-length").and_then(|s| s.parse::<u64>().ok());
    let mut reader = response.into_reader();
    let mut file = File::create(path).map_err(err)?;
    let (mut got, mut last) = (0u64, 0.0);
    let mut buf = [0u8; 64 * 1024];
    loop {
        job.check()?;
        let read = reader.read(&mut buf);
        job.check()?;
        let len = read.map_err(err)?;
        if len == 0 { break; }
        file.write_all(&buf[..len]).map_err(err)?;
        got += len as u64;
        let p = (got as f64 / total.unwrap_or(approximate).max(1) as f64).min(0.99);
        if p - last >= 0.01 {
            last = p;
            progress(p);
        }
    }
    if got == 0 || total.is_some_and(|n| n != got) {
        return Err("Incomplete Piper download".into());
    }
    job.check()
}

fn unpack(job: &Job, url: &str, stage: &Path, approximate: u64, missing: &str, progress: impl Fn(f64)) -> R<PathBuf> {
    let archive = stage.join("archive");
    let unpacked = stage.join("unpacked");
    fs::create_dir(&unpacked).map_err(err)?;
    download(job, url, &archive, approximate, missing, |p| progress(p * 0.94))?;
    let mut tar = command(Path::new("tar"));
    job.run(tar.arg("-xjf").arg(&archive).arg("-C").arg(&unpacked), Stdio::null(), &stage.join("process.log"))?;
    Ok(unpacked)
}

fn prepare_engine(job: &Job, url: &str, dest: &Path, progress: impl Fn(f64)) -> R<()> {
    let stage = Stage::new(dest.parent().unwrap(), "engine")?;
    let unpacked = unpack(job, url, &stage.0, 47_000_000, "piper_engine_unavailable", &progress)?;
    let package = package_root(&unpacked, has_engine).ok_or("Incomplete sherpa-onnx engine archive")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(engine_exe(&package), fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = command(Path::new("/usr/bin/xattr"))
            .args(["-dr", "com.apple.quarantine"]).arg(&package).output();
    }
    remove_dir(dest)?;
    fs::rename(package, dest).map_err(err)?;
    progress(1.0);
    Ok(())
}

fn prepare_voice(job: &Job, url: &str, dest: &Path, progress: impl Fn(f64)) -> R<()> {
    let stage = Stage::new(dest.parent().unwrap(), "voice")?;
    let unpacked = unpack(job, url, &stage.0, 65_000_000, "piper_voice_unavailable", &progress)?;
    let package = package_root(&unpacked, has_voice).ok_or("Incomplete Piper voice archive")?;
    job.check()?;
    remove_dir(dest)?;
    fs::rename(package, dest).map_err(err)?;
    progress(1.0);
    Ok(())
}

#[tauri::command]
pub async fn piper_download(app: AppHandle, voice: String) -> R<()> {
    let voice_url = voice_url(&voice)?;
    let job = Job::start(DOWNLOAD.into())?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = platform_url().ok_or("piper_engine_unavailable")?;
        let dir = root(&app)?;
        let engine = dir.join("engine");
        let dest = dir.join("voices").join(&voice);
        let progress = |p| { let _ = app.emit("progress", json!({ "label": "piper_dl", "p": p })); };
        let engine_share = if has_engine(&engine) { 0.0 } else { 0.4 };
        if engine_share > 0.0 {
            prepare_engine(&job, &url, &engine, |p| progress(p * engine_share))?;
        }
        if !has_voice(&dest) {
            prepare_voice(&job, &voice_url, &dest, |p| progress(engine_share + p * (0.99 - engine_share)))?;
        }
        progress(1.0);
        Ok(())
    }).await.map_err(err)?
}

#[derive(Deserialize)]
pub struct Line {
    text: String,
    slot: Option<f64>,
}

fn caption_atempo(duration: f64, slot: Option<f64>) -> f64 {
    slot.filter(|&s| s > 0.0).map_or(1.0, |s| (duration / s).clamp(1.0, 1.25))
}

fn wav_info(path: &Path) -> R<(u32, f64)> {
    let mut file = File::open(path).map_err(err)?;
    let invalid = "Invalid Piper WAV";
    let mut riff = [0; 12];
    file.read_exact(&mut riff).map_err(err)?;
    if &riff[..4] != b"RIFF" || &riff[8..] != b"WAVE" {
        return Err(invalid.into());
    }
    let mut format = None;
    let length = file.metadata().map_err(err)?.len();
    loop {
        let mut chunk = [0; 8];
        file.read_exact(&mut chunk).map_err(err)?;
        let size = u32::from_le_bytes(chunk[4..].try_into().unwrap());
        let start = file.stream_position().map_err(err)?;
        if start + u64::from(size) > length {
            return Err(invalid.into());
        }
        match &chunk[..4] {
            b"fmt " if size >= 16 => {
                let mut data = [0; 16];
                file.read_exact(&mut data).map_err(err)?;
                format = Some((u32::from_le_bytes(data[4..8].try_into().unwrap()),
                    u32::from_le_bytes(data[8..12].try_into().unwrap())));
            }
            b"data" => return match format {
                Some((hz, rate)) if hz > 0 && rate > 0 && size > 0 => Ok((hz, f64::from(size) / f64::from(rate))),
                _ => Err(invalid.into()),
            },
            _ => {}
        }
        file.seek(SeekFrom::Start(start + u64::from(size) + u64::from(size % 2))).map_err(err)?;
    }
}

/// Split at sentence ends (a terminator followed by space or the end, or a newline).
fn split_sentences(text: &str) -> Vec<String> {
    let (mut out, mut cur) = (Vec::new(), String::new());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let end = c == '\n' || ".!?؟…؛;".contains(c) && chars.peek().map_or(true, |n| n.is_whitespace());
        if c != '\n' { cur.push(c); }
        if end {
            out.push(std::mem::take(&mut cur));
        }
    }
    out.push(cur);
    // A leading dash would be read as a CLI flag.
    out.iter().map(|s| s.trim().trim_start_matches('-').trim().to_string())
        .filter(|s| s.chars().any(char::is_alphanumeric)).collect()
}

fn tts_args(model: &Path, tokens: &Path, data: &Path, scale: f64, out: &Path, text: &str) -> Vec<OsString> {
    let flag = |name: &str, v: &Path| { let mut s = OsString::from(format!("--{name}=")); s.push(v); s };
    vec![flag("vits-model", model), flag("vits-tokens", tokens), flag("vits-data-dir", data),
        format!("--vits-length-scale={scale}").into(), flag("output-filename", out), text.into()]
}

/// Join the clips, padding each but the last with `pause` seconds of silence.
fn concat_args(inputs: &[PathBuf], pause: f64, out: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-v".into(), "error".into(), "-y".into()];
    for input in inputs { args.push("-i".into()); args.push(input.into()); }
    let last = inputs.len() - 1;
    let mut graph = String::new();
    for i in 0..inputs.len() {
        let pad = if i < last { format!("apad=pad_dur={pause}") } else { "anull".into() };
        graph += &format!("[{i}:a]{pad}[a{i}];");
    }
    for i in 0..inputs.len() { graph += &format!("[a{i}]"); }
    graph += &format!("concat=n={}:v=0:a=1[out]", inputs.len());
    args.extend(["-filter_complex".into(), graph.into(), "-map".into(), "[out]".into(),
        "-c:a".into(), "pcm_s16le".into()]);
    args.push(out.into());
    args
}

fn synthesize(job: &Job, engine: &Path, voice: &Path, text: &str, out: &Path, log: &Path, scale: f64, pause: f64) -> R<()> {
    let model = voice_model(voice).ok_or("piper_missing")?;
    let sentences = split_sentences(text);
    if sentences.is_empty() {
        return Err("Invalid Piper settings".into());
    }
    let parts: Vec<PathBuf> = (0..sentences.len()).map(|i| out.with_extension(format!("part{i}.wav"))).collect();
    for (sentence, part) in sentences.iter().zip(&parts) {
        let mut cmd = engine_cmd(engine);
        cmd.args(tts_args(&model, &voice.join("tokens.txt"), &voice.join("espeak-ng-data"), scale, part, sentence));
        job.run(&mut cmd, Stdio::null(), log)?;
    }
    if parts.len() == 1 {
        return fs::rename(&parts[0], out).map_err(err);
    }
    let mut ffmpeg = command(&sidecar("ffmpeg"));
    job.run(ffmpeg.args(concat_args(&parts, pause, out)), Stdio::null(), log)?;
    for part in parts { fs::remove_file(part).map_err(err)?; }
    Ok(())
}

#[tauri::command]
pub async fn piper_synthesize(
    app: AppHandle, voice: String, lines: Vec<Line>, length_scale: f64, pause: f64, job: String,
) -> R<Vec<String>> {
    voice_url(&voice)?;
    if !(0.7..=1.4).contains(&length_scale) || !(0.0..=3.0).contains(&pause) || lines.is_empty()
        || lines.iter().any(|l| l.text.trim().is_empty() || l.slot.is_some_and(|s| !s.is_finite() || s <= 0.0))
    {
        return Err("Invalid Piper settings".into());
    }
    let id = job;
    let job = Job::start(id.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root(&app)?;
        let engine = dir.join("engine");
        let voices = dir.join("voices").join(&voice);
        if !has_engine(&engine) || !has_voice(&voices) {
            return Err("piper_missing".into());
        }
        let cache = app.path().app_data_dir().map_err(err)?.join("project-media").join("voice-over");
        let stage = Stage::new(&cache, "speech")?;
        let final_dir = stage.0.with_file_name(stage.0.file_name().unwrap().to_string_lossy().trim_start_matches('.'));
        let log = stage.0.join("process.log");
        let filenames: Vec<_> = (1..=lines.len()).map(|n| {
            if lines.len() == 1 { "voice-over.wav".to_string() } else { format!("voice-over-{n}.wav") }
        }).collect();
        for (index, (line, name)) in lines.iter().zip(&filenames).enumerate() {
            job.check()?;
            let path = stage.0.join(name);
            synthesize(&job, &engine, &voices, &line.text, &path, &log, length_scale, pause)?;
            let (_, duration) = wav_info(&path)?;
            let tempo = caption_atempo(duration, line.slot);
            if tempo > 1.0 {
                let fitted = stage.0.join("fitted.wav");
                let mut ffmpeg = command(&sidecar("ffmpeg"));
                job.run(ffmpeg.args(["-v", "error", "-y", "-i"]).arg(&path)
                    .args(["-af", &format!("atempo={tempo}"), "-c:a", "pcm_s16le"]).arg(&fitted),
                    Stdio::null(), &log)?;
                wav_info(&fitted)?;
                fs::remove_file(&path).map_err(err)?;
                fs::rename(fitted, path).map_err(err)?;
            }
            if lines.len() > 1 {
                let _ = app.emit("piper-progress", json!({ "job": id, "done": index + 1, "total": lines.len() }));
            }
        }
        job.check()?;
        fs::remove_file(log).map_err(err)?;
        fs::rename(&stage.0, &final_dir).map_err(err)?;
        Ok(filenames.iter().map(|name| final_dir.join(name).to_string_lossy().into_owned()).collect())
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_fit_caps_speed_without_slowing() {
        assert_eq!(caption_atempo(2.0, None), 1.0);
        assert_eq!(caption_atempo(2.0, Some(3.0)), 1.0);
        assert_eq!(caption_atempo(2.0, Some(2.0)), 1.0);
        assert_eq!(caption_atempo(2.2, Some(2.0)), 1.1);
        assert_eq!(caption_atempo(3.0, Some(2.0)), 1.25);
    }

    #[test]
    fn asset_urls() {
        let base = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
        for arch in ["aarch64", "x86_64"] {
            assert_eq!(engine_url("macos", arch).unwrap(),
                format!("{base}/v2.0.3/sherpa-onnx-v2.0.3-osx-universal2-shared.tar.bz2"));
        }
        assert_eq!(engine_url("windows", "x86_64").unwrap(),
            format!("{base}/v2.0.3/sherpa-onnx-v2.0.3-win-x64-shared-MT-Release.tar.bz2"));
        assert!(engine_url("linux", "x86_64").is_none() && engine_url("windows", "aarch64").is_none());
        assert_eq!(voice_url("ar_JO-kareem-medium").unwrap(), format!("{base}/tts-models/vits-piper-ar_JO-kareem-medium.tar.bz2"));
        assert_eq!(voice_url("en_US-lessac-medium").unwrap(), format!("{base}/tts-models/vits-piper-en_US-lessac-medium.tar.bz2"));
        assert!(voice_url("../ar").is_err());
    }

    #[test]
    fn tts_arguments() {
        let args = tts_args(Path::new("/v/m.onnx"), Path::new("/v/tokens.txt"), Path::new("/v/espeak-ng-data"),
            1.1, Path::new("/o/out.wav"), "--hi there; rm -rf");
        let args: Vec<_> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--vits-model=/v/m.onnx", "--vits-tokens=/v/tokens.txt", "--vits-data-dir=/v/espeak-ng-data",
            "--vits-length-scale=1.1", "--output-filename=/o/out.wav", "--hi there; rm -rf"]);
    }

    #[test]
    fn sentence_split() {
        assert_eq!(split_sentences("Hello world. How are you? Fine"), ["Hello world.", "How are you?", "Fine"]);
        assert_eq!(split_sentences("Pi is 3.14 ok.\n\n- dash"), ["Pi is 3.14 ok.", "dash"]);
        assert_eq!(split_sentences("مرحبا بكم. كيف الحال؟"), ["مرحبا بكم.", "كيف الحال؟"]);
        assert!(split_sentences(" . ... ").is_empty());
    }

    #[test]
    fn wav_concat_arguments() {
        let ins = [PathBuf::from("a.wav"), PathBuf::from("b.wav"), PathBuf::from("c.wav")];
        let args: Vec<_> = concat_args(&ins, 0.2, Path::new("out.wav")).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args[3..9], ["-i", "a.wav", "-i", "b.wav", "-i", "c.wav"]);
        assert_eq!(args[10], "[0:a]apad=pad_dur=0.2[a0];[1:a]apad=pad_dur=0.2[a1];[2:a]anull[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]");
        assert_eq!(args.last().unwrap(), "out.wav");
    }

    #[test]
    fn package_detection_on_fake_trees() {
        let stage = Stage::new(&std::env::temp_dir(), "piper-tree").unwrap();
        let (engine, voice) = (stage.0.join("e/sherpa-onnx-v2.0.3-osx"), stage.0.join("v/vits-piper-x"));
        fs::create_dir_all(engine.join("bin")).unwrap();
        fs::create_dir_all(engine.join("lib")).unwrap();
        fs::write(engine_exe(&engine), b"").unwrap();
        fs::create_dir_all(voice.join("espeak-ng-data")).unwrap();
        fs::write(voice.join("x.onnx"), b"").unwrap();
        assert!(package_root(&stage.0.join("v"), has_voice).is_none());
        fs::write(voice.join("tokens.txt"), b"").unwrap();
        assert_eq!(package_root(&stage.0.join("e"), has_engine), Some(engine.clone()));
        assert_eq!(package_root(&stage.0.join("v"), has_voice), Some(voice.clone()));
        assert_eq!(package_root(&engine, has_engine), Some(engine));
        assert_eq!(voice_model(&voice), Some(voice.join("x.onnx")));
    }

    // Runs a downloaded third-party binary, so it never runs by default. To run it, unpack the
    // sherpa-onnx tarball and a vits-piper voice yourself, then:
    // MAQTO_SHERPA_ENGINE=<engine dir> MAQTO_SHERPA_VOICE=<voice dir> cargo test arabic_sherpa_smoke -- --ignored
    #[test]
    #[ignore]
    fn arabic_sherpa_smoke() {
        let engine = PathBuf::from(std::env::var_os("MAQTO_SHERPA_ENGINE").expect("MAQTO_SHERPA_ENGINE"));
        let voice = PathBuf::from(std::env::var_os("MAQTO_SHERPA_VOICE").expect("MAQTO_SHERPA_VOICE"));
        assert!(has_engine(&engine) && has_voice(&voice));
        let job = Job::start("test".into()).unwrap();
        let stage = Stage::new(&std::env::temp_dir(), "piper-test").unwrap();
        let out = stage.0.join("arabic.wav");
        synthesize(&job, &engine, &voice, "مرحبا بكم في ماكتو. أهلا وسهلا.", &out, &stage.0.join("log"), 1.0, 0.2).unwrap();
        let (_, duration) = wav_info(&out).unwrap();
        assert!((0.5..=10.0).contains(&duration), "duration: {duration}s");
    }
}
