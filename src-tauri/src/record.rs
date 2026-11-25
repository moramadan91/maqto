// Screen / camera / microphone recording through the bundled ffmpeg.
// One ffmpeg process takes every chosen source and writes one file each, so the files share a clock
// and stay in sync. ffmpeg stops cleanly when it reads `q` on stdin, which finalizes the mp4.
use super::{command, err, sidecar, R};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Device { pub id: String, pub name: String }
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Devices { pub screens: Vec<Device>, pub cameras: Vec<Device>, pub mics: Vec<Device> }
#[derive(Deserialize, Debug, Default)]
pub struct Opts { pub screen: Option<String>, pub camera: Option<String>, pub mic: Option<String> }
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct RecFile { pub role: &'static str, pub path: String }

const FPS: u32 = 30;

/// `[AVFoundation indev @ 0x1] [0] FaceTime HD Camera` lines under "video devices" / "audio devices" headers.
/// A video device called "Capture screen N" is a display.
pub fn parse_avfoundation(text: &str) -> Devices {
    let mut d = Devices::default();
    let mut video = true;
    for line in text.lines() {
        let rest = line.split_once("] ").filter(|_| line.starts_with('[') && line.contains("indev")).map_or(line, |(_, r)| r).trim();
        let low = rest.to_lowercase();
        if low.contains("video devices") { video = true; continue; }
        if low.contains("audio devices") { video = false; continue; }
        let Some((id, name)) = rest.strip_prefix('[').and_then(|r| r.split_once(']')) else { continue };
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) { continue; }
        let dev = Device { id: id.to_string(), name: name.trim().to_string() };
        if !video { d.mics.push(dev); }
        else if dev.name.starts_with("Capture screen") { d.screens.push(dev); }
        else { d.cameras.push(dev); }
    }
    d
}

/// `[dshow @ 0x1] "Integrated Camera" (video)`; older builds print `DirectShow video devices` headers
/// and bare quoted names. DirectShow devices are addressed by name. The display is gdigrab's "desktop".
pub fn parse_dshow(text: &str) -> Devices {
    let mut d = Devices { screens: vec![Device { id: "desktop".into(), name: "Desktop".into() }], ..Default::default() };
    let mut section = "";
    for line in text.lines() {
        let low = line.to_lowercase();
        if low.contains("directshow video devices") { section = "video"; continue; }
        if low.contains("directshow audio devices") { section = "audio"; continue; }
        if low.contains("alternative name") { continue; }
        let Some(a) = line.find('"') else { continue };
        let Some(n) = line[a + 1..].find('"') else { continue };
        let name = &line[a + 1..a + 1 + n];
        let tail = &line[a + n + 2..];
        let kind = if tail.contains("(video)") { "video" } else if tail.contains("(audio)") { "audio" } else if tail.contains("(none)") { "" } else { section };
        let dev = Device { id: name.to_string(), name: name.to_string() };
        match kind { "video" => d.cameras.push(dev), "audio" => d.mics.push(dev), _ => {} }
    }
    d
}

/// ffmpeg arguments for the chosen sources and the files they write (`<stem>-screen.mp4`, `-camera.mp4`, `-mic.m4a`).
pub fn build_args(windows: bool, o: &Opts, dir: &Path, stem: &str, hw: bool) -> R<(Vec<String>, Vec<RecFile>)> {
    let s = |v: &str| v.to_string();
    let fps = FPS.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-y"].map(s).to_vec();
    let mut outs: Vec<String> = vec![];
    let mut files = vec![];
    let mut n = 0;
    let mut add = |input: Vec<String>, role: &'static str, ext: &str, codec: Vec<String>, args: &mut Vec<String>| {
        args.extend(input);
        let path = dir.join(format!("{stem}-{role}.{ext}")).to_string_lossy().to_string();
        outs.extend(["-map".to_string(), n.to_string()].into_iter().chain(codec).chain([path.clone()]));
        files.push(RecFile { role, path });
        n += 1;
    };
    let video = |bitrate: &str| -> Vec<String> {
        let mut v = vec![s("-vf"), format!("fps={fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p")];
        v.extend(if hw { vec![s("-c:v"), s("h264_videotoolbox"), s("-b:v"), s(bitrate)] }
                 else { vec![s("-c:v"), s("libx264"), s("-preset"), s("ultrafast"), s("-crf"), s("20")] });
        v
    };
    let wall = ["-use_wallclock_as_timestamps", "1"];
    if let Some(id) = &o.screen {
        let input = if windows { vec![s("-f"), s("gdigrab"), s("-framerate"), fps.clone(), s("-draw_mouse"), s("1"), s("-i"), id.clone()] }
            else { [vec![s("-f"), s("avfoundation")], wall.map(s).to_vec(), vec![s("-capture_cursor"), s("1"), s("-framerate"), fps.clone(), s("-i"), format!("{id}:none")]].concat() };
        add(input, "screen", "mp4", video("12M"), &mut args);
    }
    if let Some(id) = &o.camera {
        let input = if windows { [vec![s("-f"), s("dshow"), s("-rtbufsize"), s("200M")], wall.map(s).to_vec(), vec![s("-i"), format!("video={id}")]].concat() }
            else { [vec![s("-f"), s("avfoundation")], wall.map(s).to_vec(), vec![s("-framerate"), fps.clone(), s("-i"), format!("{id}:none")]].concat() };
        add(input, "camera", "mp4", video("6M"), &mut args);
    }
    if let Some(id) = &o.mic {
        let input = if windows { [vec![s("-f"), s("dshow")], wall.map(s).to_vec(), vec![s("-i"), format!("audio={id}")]].concat() }
            else { [vec![s("-f"), s("avfoundation")], wall.map(s).to_vec(), vec![s("-i"), format!("none:{id}")]].concat() };
        add(input, "mic", "m4a", ["-c:a", "aac", "-b:a", "160k"].map(s).to_vec(), &mut args);
    }
    if files.is_empty() { return Err("nothing to record".into()); }
    args.extend(outs);
    Ok((args, files))
}

/// Capture failures that mean the OS has not allowed this app to use the screen, camera or microphone.
pub fn is_permission_error(stderr: &str) -> bool {
    let l = stderr.to_lowercase();
    ["permission", "not authorized", "not permitted", "denied", "tcc"].iter().any(|w| l.contains(w))
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" { fn CGPreflightScreenCaptureAccess() -> bool; fn CGRequestScreenCaptureAccess() -> bool; }

struct Active { child: Child, files: Vec<RecFile> }
#[derive(Default)]
pub struct Recorder(Mutex<Option<Active>>);

impl Recorder {
    /// Asks ffmpeg to finish its files, and kills it only if it does not exit in time.
    pub fn finish(&self) -> R<Vec<RecFile>> {
        let Some(mut a) = self.0.lock().unwrap().take() else { return Ok(vec![]) };
        if let Some(mut i) = a.child.stdin.take() { let _ = i.write_all(b"q\n"); }
        let end = Instant::now() + Duration::from_secs(10);
        while a.child.try_wait().ok().flatten().is_none() {
            if Instant::now() > end {
                let _ = a.child.kill();
                let _ = a.child.wait();
                // a killed ffmpeg never wrote the mp4/m4a moov atom, so the files are probably unplayable
                let paths: Vec<_> = a.files.iter().map(|f| f.path.to_string()).collect();
                return Err(format!("ffmpeg did not finish in time and was stopped; the recordings are likely unplayable and were not imported. Files kept on disk: {}", paths.join(", ")));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(a.files.into_iter().filter(|f| std::fs::metadata(&f.path).map(|m| m.len() > 0).unwrap_or(false)).collect())
    }
}

fn list(windows: bool) -> R<Devices> {
    let args: &[&str] = if windows { &["-list_devices", "true", "-f", "dshow", "-i", "dummy"] } else { &["-f", "avfoundation", "-list_devices", "true", "-i", ""] };
    // ffmpeg prints the list on stderr and exits non-zero, which is expected
    let out = command(&sidecar("ffmpeg")).args(["-hide_banner"]).args(args).stdin(Stdio::null()).output().map_err(err)?;
    let text = String::from_utf8_lossy(&out.stderr);
    Ok(if windows { parse_dshow(&text) } else { parse_avfoundation(&text) })
}

fn spawn(args: &[String]) -> R<(Child, Arc<Mutex<String>>)> {
    let mut child = command(&sidecar("ffmpeg")).args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(err)?;
    let log = Arc::new(Mutex::new(String::new()));
    let (mut e, l) = (child.stderr.take().unwrap(), log.clone());
    std::thread::spawn(move || {
        let mut b = [0u8; 4096];
        while let Ok(n) = e.read(&mut b) {
            if n == 0 { break; }
            let mut g = l.lock().unwrap();
            g.push_str(&String::from_utf8_lossy(&b[..n]));
            if g.len() > 8000 { let cut = (g.len() - 8000..g.len()).find(|i| g.is_char_boundary(*i)).unwrap_or(0); g.drain(..cut); }
        }
    });
    Ok((child, log))
}

#[tauri::command]
pub async fn record_devices() -> R<Devices> {
    tauri::async_runtime::spawn_blocking(|| list(cfg!(windows))).await.map_err(err)?
}

/// Starts recording; returns once ffmpeg has survived its first moments. Errors starting with
/// `permission:` mean the OS blocked capture (the page then offers the privacy settings).
#[tauri::command]
pub async fn record_start(app: AppHandle, state: State<'_, Recorder>, opts: Opts, dir: Option<String>) -> R<()> {
    let dir = match dir { Some(d) => std::path::PathBuf::from(d), None => app.path().app_data_dir().map_err(err)?.join("Recordings") };
    std::fs::create_dir_all(&dir).map_err(err)?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let stem = format!("recording-{secs}");
    if state.0.lock().unwrap().is_some() { return Err("already recording".into()); }
    #[cfg(target_os = "macos")]
    if opts.screen.is_some() && !unsafe { CGPreflightScreenCaptureAccess() } {
        unsafe { CGRequestScreenCaptureAccess(); }
        return Err("permission: screen".into());
    }
    let started = tauri::async_runtime::spawn_blocking(move || -> R<Active> {
        // the hardware encoder is tried first on macOS; if ffmpeg dies right away without a permission error, retry in software
        for hw in if cfg!(target_os = "macos") { vec![true, false] } else { vec![false] } {
            let (args, files) = build_args(cfg!(windows), &opts, &dir, &stem, hw)?;
            let (mut child, log) = spawn(&args)?;
            let t = Instant::now();
            while t.elapsed() < Duration::from_millis(1500) {
                if let Some(st) = child.try_wait().map_err(err)? {
                    std::thread::sleep(Duration::from_millis(100));
                    let text = log.lock().unwrap().clone();
                    if is_permission_error(&text) { return Err(format!("permission: {}", super::tail(&text))); }
                    if hw && !st.success() { break; }
                    return Err(super::tail(&text));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            if child.try_wait().map_err(err)?.is_none() { return Ok(Active { child, files }); }
        }
        Err("recording could not start".into())
    }).await.map_err(err)??;
    *state.0.lock().unwrap() = Some(started);
    Ok(())
}

/// Stops and returns the files that were written.
#[tauri::command]
pub async fn record_stop(app: AppHandle) -> R<Vec<RecFile>> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Recorder>().finish()).await.map_err(err)?
}

#[tauri::command]
pub fn record_open_privacy(kind: String) {
    #[cfg(target_os = "macos")]
    {
        let pane = match kind.as_str() { "camera" => "Privacy_Camera", "mic" => "Privacy_Microphone", _ => "Privacy_ScreenCapture" };
        let _ = std::process::Command::new("open").arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}")).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = kind;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const MAC: &str = "[AVFoundation indev @ 0x7f8] AVFoundation video devices:
[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8] [1] Capture screen 0
[AVFoundation indev @ 0x7f8] [2] Capture screen 1
[AVFoundation indev @ 0x7f8] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7f8] [1] USB Mic [Blue]
: Input/output error";
    const WIN: &str = "[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001]  \"Integrated Camera\" (video)
[dshow @ 000001]   Alternative name \"@device_pnp_\\\\?\\usb#vid_0c45\"
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  \"Microphone (Realtek Audio)\" (audio)
[dshow @ 000001]   Alternative name \"@device_cm_{33D9A762}\"
dummy: Immediate exit requested";
    const WIN_OLD: &str = "[dshow @ 01] DirectShow video devices\n[dshow @ 01]  \"USB Cam\"\n[dshow @ 01]     Alternative name \"@x\"\n[dshow @ 01] DirectShow audio devices\n[dshow @ 01]  \"Line In\"\n";

    #[test]
    fn parses_avfoundation() {
        let d = parse_avfoundation(MAC);
        assert_eq!(d.cameras, vec![Device { id: "0".into(), name: "FaceTime HD Camera".into() }]);
        assert_eq!(d.screens.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["1", "2"]);
        assert_eq!(d.mics.len(), 2);
        assert_eq!(d.mics[1].name, "USB Mic [Blue]"); // brackets inside a name survive
        assert_eq!(parse_avfoundation("nothing here"), Devices::default());
    }

    #[test]
    fn parses_dshow() {
        let d = parse_dshow(WIN);
        assert_eq!(d.cameras, vec![Device { id: "Integrated Camera".into(), name: "Integrated Camera".into() }]);
        assert_eq!(d.mics[0].id, "Microphone (Realtek Audio)");
        assert_eq!(d.screens[0].id, "desktop");
        let o = parse_dshow(WIN_OLD);
        assert_eq!((o.cameras.len(), o.mics.len()), (1, 1));
        assert_eq!(o.mics[0].name, "Line In");
    }

    #[test]
    fn builds_mac_args() {
        let o = Opts { screen: Some("1".into()), camera: Some("0".into()), mic: Some("1".into()) };
        let (a, f) = build_args(false, &o, &PathBuf::from("/r"), "rec", true).unwrap();
        let line = a.join(" ");
        assert!(line.contains("-capture_cursor 1 -framerate 30 -i 1:none"));
        assert!(line.contains("-i 0:none") && line.contains("-i none:1"));
        assert!(line.contains("-map 0 -vf") && line.contains("-map 1 -vf") && line.contains("-map 2 -c:a aac"));
        assert!(line.contains("h264_videotoolbox") && !line.contains("libx264"));
        assert_eq!(f.iter().map(|x| (x.role, x.path.as_str())).collect::<Vec<_>>(),
            [("screen", "/r/rec-screen.mp4"), ("camera", "/r/rec-camera.mp4"), ("mic", "/r/rec-mic.m4a")]);
        // every input comes before the first output option so the options bind to the right file
        assert!(a.iter().rposition(|x| x == "-i").unwrap() < a.iter().position(|x| x == "-map").unwrap());
        assert!(build_args(false, &o, &PathBuf::from("/r"), "rec", false).unwrap().0.join(" ").contains("libx264 -preset ultrafast"));
    }

    #[test]
    fn builds_windows_args_and_rejects_empty() {
        let o = Opts { screen: Some("desktop".into()), camera: Some("Integrated Camera".into()), mic: None };
        let (a, f) = build_args(true, &o, &PathBuf::from("C:/r"), "rec", false).unwrap();
        let line = a.join(" ");
        assert!(line.contains("-f gdigrab -framerate 30 -draw_mouse 1 -i desktop"));
        assert!(line.contains("-f dshow") && line.contains("-i video=Integrated Camera"));
        assert_eq!(f.len(), 2);
        assert!(build_args(true, &Opts::default(), &PathBuf::from("C:/r"), "rec", false).is_err());
    }

    #[test]
    fn spots_permission_errors() {
        assert!(is_permission_error("[AVFoundation indev @ 0x1] Failed to start: Operation not permitted"));
        assert!(is_permission_error("Camera access denied"));
        assert!(!is_permission_error("Unrecognized option 'foo'"));
    }
}
