use super::{command, err, sidecar, tail, AppHandle, Emitter, Manager, R};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime};

const VERSION: &str = "0.5.6";
const POLL: Duration = Duration::from_millis(50);
const DOWNLOAD: &str = "download";
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Mutex::default);
static PROCESS: Mutex<()> = Mutex::new(());

fn asset(os: &str, arch: &str) -> Option<String> {
    let target = match (os, arch) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc.exe",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        _ => return None,
    };
    Some(format!("deep-filter-{VERSION}-{target}"))
}

fn tool(app: &AppHandle) -> R<Option<PathBuf>> {
    let asset = asset(std::env::consts::OS, std::env::consts::ARCH);
    let data = app.path().app_data_dir().map_err(err)?;
    Ok(asset.map(|name| data.join("deepfilter").join(name)))
}

#[tauri::command]
pub fn voice_clean_ready(app: AppHandle) -> R<Option<bool>> {
    Ok(tool(&app)?.map(|p| p.is_file()))
}

#[tauri::command]
pub fn voice_clean_remove(app: AppHandle) -> R<()> {
    let jobs = JOBS.lock().unwrap();
    if jobs.contains_key(DOWNLOAD) { return Err("DeepFilterNet is downloading".into()); }
    if let Some(path) = tool(&app)? {
        match fs::remove_file(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            result => result.map_err(err)?,
        }
    }
    Ok(())
}

struct Job {
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl Job {
    fn start(id: String) -> R<Self> {
        let mut jobs = JOBS.lock().unwrap();
        if jobs.contains_key(&id) { return Err("Voice clean-up job is already running".into()); }
        let cancelled = Arc::new(AtomicBool::new(false));
        jobs.insert(id.clone(), cancelled.clone());
        Ok(Self { id, cancelled })
    }

    fn check(&self) -> R<()> {
        if self.cancelled.load(Ordering::Relaxed) { Err("cancelled".into()) } else { Ok(()) }
    }

    fn run(&self, cmd: &mut Command, log: &Path) -> R<()> {
        self.check()?;
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null())
            .stderr(fs::File::create(log).map_err(err)?).spawn().map_err(err)?;
        loop {
            match self.check().and_then(|_| child.try_wait().map_err(err)) {
                Ok(Some(status)) if status.success() => return self.check(),
                Ok(Some(status)) => {
                    let log = tail(&fs::read_to_string(log).unwrap_or_default());
                    return Err(format!("{status}\n{log}"));
                }
                Ok(None) => std::thread::sleep(POLL),
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
    fn drop(&mut self) { JOBS.lock().unwrap().remove(&self.id); }
}

#[tauri::command]
pub fn voice_clean_cancel(job: String) {
    if let Some(cancelled) = JOBS.lock().unwrap().get(&job) {
        cancelled.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn voice_clean_download(app: AppHandle) -> R<()> {
    let job = Job::start(DOWNLOAD.into())?;
    tauri::async_runtime::spawn_blocking(move || {
        let target = tool(&app)?.ok_or("DeepFilterNet is unavailable on this platform")?;
        if target.is_file() { return Ok(()); }
        fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
        let part = target.with_extension(format!("{}.part", std::process::id()));
        let download = || -> R<()> {
            job.check()?;
            let name = target.file_name().unwrap().to_string_lossy();
            let url = format!("https://github.com/Rikorose/DeepFilterNet/releases/download/v{VERSION}/{name}");
            let response = ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(5))
                .build().get(&url).call().map_err(err)?;
            let total = response.header("content-length").and_then(|s| s.parse::<u64>().ok());
            let (mut reader, mut file) = (response.into_reader(), fs::File::create(&part).map_err(err)?);
            let (mut got, mut last) = (0u64, 0.0);
            let mut buf = [0u8; 64 * 1024];
            loop {
                job.check()?;
                let len = reader.read(&mut buf).map_err(err)?;
                if len == 0 { break; }
                file.write_all(&buf[..len]).map_err(err)?;
                got += len as u64;
                if let Some(total) = total.filter(|n| *n > 0) {
                    let p = (got as f64 / total as f64).min(1.0);
                    if p - last >= 0.01 {
                        last = p;
                        let _ = app.emit("progress", json!({ "label": "voice_clean_dl", "p": p }));
                    }
                }
            }
            if got == 0 || total.is_some_and(|n| got != n) {
                return Err("Incomplete DeepFilterNet download".into());
            }
            drop(file);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&part, fs::Permissions::from_mode(0o755)).map_err(err)?;
            }
            #[cfg(target_os = "macos")]
            {
                let _ = command(Path::new("/usr/bin/xattr"))
                    .args(["-d", "com.apple.quarantine"]).arg(&part).output();
            }
            job.check()?;
            fs::rename(&part, &target).map_err(err)?;
            let _ = app.emit("progress", json!({ "label": "voice_clean_dl", "p": 1 }));
            Ok(())
        };
        let result = download();
        if result.is_err() { let _ = fs::remove_file(part); }
        job.check().and(result)
    }).await.map_err(err)?
}

#[derive(Debug, PartialEq, Eq, Hash)]
struct Settings {
    attenuation: u8,
    room: u8,
    normalize: bool,
}

impl Settings {
    fn parse(fx: &str) -> R<Self> {
        let parts: Vec<_> = fx.split(':').collect();
        let ["voice", attenuation, room, normalize] = parts.as_slice() else {
            return Err("Invalid voice clean-up settings".into());
        };
        let attenuation = attenuation.parse().map_err(err)?;
        let room = room.parse().map_err(err)?;
        if !matches!(attenuation, 12 | 24 | 100) || room > 30 || !matches!(*normalize, "n" | "") {
            return Err("Invalid voice clean-up settings".into());
        }
        Ok(Self { attenuation, room, normalize: *normalize == "n" })
    }
}

fn cache_key(path: &str, bytes: u64, modified: Option<SystemTime>, settings: &Settings) -> String {
    let mut h = DefaultHasher::new();
    (VERSION, path, bytes, modified, settings).hash(&mut h);
    format!("voice-{:016x}.flac", h.finish())
}

fn filter_args(settings: &Settings, input: &Path, out: &Path) -> Vec<std::ffi::OsString> {
    vec!["--compensate-delay".into(), "--atten-lim-db".into(),
        settings.attenuation.to_string().into(), "-o".into(), out.into(), input.into()]
}

fn mix_filter(settings: &Settings) -> String {
    let room = f64::from(settings.room) / 100.0;
    let mut filter = format!(
        "amix=inputs=2:duration=first:weights='{room:.2} {:.2}':normalize=0",
        1.0 - room
    );
    if settings.normalize {
        filter.push_str(",loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=48000");
    }
    filter
}

fn process(
    ffmpeg: &Path, binary: &Path, path: &Path, settings: &Settings, work: &Path,
    job: &Job, progress: impl Fn(f64),
) -> R<()> {
    let original = work.join("original.wav");
    let input = work.join("input.wav");
    let clean = work.join("clean");
    let log = work.join("process.log");
    let ff = || {
        let mut cmd = command(ffmpeg);
        cmd.args(["-v", "error", "-nostdin", "-y"]);
        cmd
    };
    progress(0.05);
    job.run(ff().arg("-i").arg(path)
        .args(["-map", "0:a:0", "-af", "aformat=sample_rates=48000:channel_layouts=mono|stereo",
            "-c:a", "pcm_s16le"]).arg(&original), &log)?;
    // Delay compensation trims the output tail. Pad before filtering and use the original length for the mix.
    job.run(ff().arg("-i").arg(&original).args(["-af", "apad=pad_dur=0.06", "-c:a", "pcm_s16le"])
        .arg(&input), &log)?;
    progress(0.25);
    job.run(command(binary).args(filter_args(settings, &input, &clean)), &log)?;
    progress(0.9);
    job.run(ff().arg("-i").arg(original).arg("-i").arg(clean.join("input.wav"))
        .args(["-filter_complex", &mix_filter(settings), "-c:a", "flac"]).arg(work.join("out.flac")), &log)?;
    Ok(())
}

pub async fn prepare(app: AppHandle, path: String, fx: String, id: Option<String>) -> R<PathBuf> {
    let settings = Settings::parse(&fx)?;
    let job = Job::start(id.ok_or("Missing voice clean-up job ID")?)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(err)?;
        let dir = app.path().app_data_dir().map_err(err)?.join("denoise");
        let out = dir.join(cache_key(&path, meta.len(), meta.modified().ok(), &settings));
        let progress = |p| { let _ = app.emit("voice-clean-progress", json!({ "job": job.id, "p": p })); };
        let _lock = loop {
            job.check()?;
            if out.is_file() {
                progress(1.0);
                return Ok(out);
            }
            match PROCESS.try_lock() {
                Ok(lock) => break lock,
                Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(POLL),
                Err(e) => return Err(err(e)),
            }
        };
        if out.is_file() {
            progress(1.0);
            return Ok(out);
        }
        let binary = tool(&app)?.filter(|p| p.is_file()).ok_or("voice_clean_missing")?;
        let work = out.with_extension(format!("{}.work", std::process::id()));
        fs::create_dir_all(&work).map_err(err)?;
        let result = process(&sidecar("ffmpeg"), &binary, Path::new(&path), &settings, &work, &job, progress)
            .and_then(|_| job.check())
            .and_then(|_| fs::rename(work.join("out.flac"), &out).map_err(err));
        let _ = fs::remove_dir_all(&work);
        result?;
        progress(1.0);
        Ok(out)
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_tracks_source_and_settings() {
        let settings = Settings::parse("voice:24:0:").unwrap();
        let key = cache_key("source.wav", 42, None, &settings);
        assert_eq!(key, cache_key("source.wav", 42, None, &settings));
        assert_ne!(key, cache_key("other.wav", 42, None, &settings));
        assert_ne!(key, cache_key("source.wav", 43, None, &settings));
        assert_ne!(key, cache_key("source.wav", 42, Some(SystemTime::UNIX_EPOCH), &settings));
        for fx in ["voice:12:0:", "voice:24:30:", "voice:24:0:n"] {
            assert_ne!(key, cache_key("source.wav", 42, None, &Settings::parse(fx).unwrap()));
        }
        for fx in ["voice:13:0:", "voice:24:31:", "voice:24:0:d"] {
            assert!(Settings::parse(fx).is_err(), "{fx}");
        }
    }

    #[test]
    fn cli_args_and_mix() {
        for db in [12, 24, 100] {
            let settings = Settings { attenuation: db, room: 30, normalize: false };
            let args = filter_args(&settings, Path::new("source clip.wav"), Path::new("clean output"));
            assert_eq!(args, ["--compensate-delay", "--atten-lim-db", &db.to_string(), "-o",
                "clean output", "source clip.wav"]);
            assert_eq!(mix_filter(&settings), "amix=inputs=2:duration=first:weights='0.30 0.70':normalize=0");
        }
        let settings = Settings::parse("voice:24:0:n").unwrap();
        assert!(mix_filter(&settings).ends_with("loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=48000"));
    }

    #[test]
    fn deepfilter_reduces_noise_in_gap() -> R<()> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let Some(binary) = asset(std::env::consts::OS, std::env::consts::ARCH)
            .map(|name| root.join("../.models/deepfilter").join(name)).filter(|p| p.is_file())
        else {
            eprintln!("Skipped DeepFilterNet smoke test (local model binary missing)");
            return Ok(());
        };
        let ffmpeg = fs::read_dir(root.join("binaries")).map_err(err)?
            .filter_map(Result::ok).map(|e| e.path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("ffmpeg-"))
            .unwrap_or_else(|| PathBuf::from(super::super::exe_name("ffmpeg")));
        let dir = std::env::temp_dir().join(format!("maqto-voice-test-{}", std::process::id()));
        fs::create_dir_all(&dir).map_err(err)?;
        let run = || -> R<f64> {
            let source = dir.join("source.wav");
            let job = Job::start("smoke-test".into())?;
            job.run(command(&ffmpeg).args([
                "-v", "error", "-y", "-f", "lavfi", "-i",
                r"aevalsrc=0.125*sin(2*PI*440*t)*not(between(t\,0.8\,2.2)):s=48000:d=3",
                "-f", "lavfi", "-i", "anoisesrc=a=0.035:r=48000:d=3:seed=42",
                "-filter_complex", "amix=normalize=0", "-c:a", "pcm_s16le",
            ]).arg(&source), &dir.join("fixture.log"))?;
            let settings = Settings::parse("voice:100:0:")?;
            process(&ffmpeg, &binary, &source, &settings, &dir, &job, |_| {})?;
            let rms = |file: &Path, gap: bool| -> R<(f64, usize)> {
                let mut cmd = command(&ffmpeg);
                cmd.args(["-v", "error"]);
                if gap { cmd.args(["-ss", "1.25"]); }
                cmd.arg("-i").arg(file);
                if gap { cmd.args(["-t", "0.5"]); }
                let output = cmd.args(["-f", "f32le", "-"]).output().map_err(err)?;
                if !output.status.success() { return Err(err(String::from_utf8_lossy(&output.stderr))); }
                let count = output.stdout.len() / 4;
                let energy: f64 = output.stdout.chunks_exact(4)
                    .map(|s| f64::from(f32::from_le_bytes(s.try_into().unwrap())).powi(2)).sum();
                Ok(((energy / count as f64).sqrt(), count))
            };
            let clean = dir.join("out.flac");
            assert_eq!(rms(&source, false)?.1, 144_000);
            assert_eq!(rms(&clean, false)?.1, 144_000, "clean-up must preserve the source length");
            let before = rms(&source, true)?.0;
            let after = rms(&clean, true)?.0;
            let stereo = dir.join("stereo.wav");
            job.run(command(&ffmpeg).args(["-v", "error", "-y", "-i"]).arg(&source)
                .args(["-ac", "2", "-c:a", "pcm_s16le"]).arg(&stereo), &dir.join("fixture.log"))?;
            let room = Settings::parse("voice:100:30:")?;
            process(&ffmpeg, &binary, &stereo, &room, &dir, &job, |_| {})?;
            assert_eq!(rms(&clean, false)?.1, 288_000, "stereo must retain both channels");
            let wet_ratio = rms(&clean, true)?.0 / rms(&stereo, true)?.0;
            assert!((wet_ratio - 0.30).abs() < 0.03, "room mix ratio was {wet_ratio}");

            std::thread::scope(|scope| {
                scope.spawn(|| {
                    std::thread::sleep(Duration::from_millis(150));
                    voice_clean_cancel(job.id.clone());
                });
                let result = job.run(command(&ffmpeg).args(["-v", "error", "-re", "-i"])
                    .arg(&stereo).args(["-f", "null", "-"]), &dir.join("cancel.log"));
                assert_eq!(result.unwrap_err(), "cancelled");
            });
            Ok(20.0 * (before / after).log10())
        };
        let reduction = run();
        let _ = fs::remove_dir_all(dir);
        let reduction = reduction?;
        eprintln!("DeepFilterNet RMS noise reduction: {reduction:.2} dB");
        assert!(reduction > 10.0, "noise floor only fell by {reduction:.2} dB");
        Ok(())
    }
}
