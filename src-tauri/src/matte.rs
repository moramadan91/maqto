// Remove background: an AI matte for a whole video file, run with onnxruntime.
// kind "person": MODNet (Apache-2.0), every frame. kind "object": BiRefNet-lite (MIT) for products, cars, things;
// ~2.8 s a frame on CPU, so it runs on about 6 frames a second of video and blends the matte in between.
// The matte is a grey video, same timing as the source; preview multiplies it into alpha, export alphamerges it.
use super::{command, err, sidecar, tail, R};
use serde_json::json;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};

/// ONNX Runtime allows one environment per process: every model run shares it
pub fn ort_env() -> R<ort::environment::Environment> {
    static ENV: std::sync::Mutex<Option<ort::environment::Environment>> = std::sync::Mutex::new(None);
    let mut g = ENV.lock().map_err(err)?;
    if g.is_none() { *g = Some(ort::init().build().map_err(err)?); }
    Ok(g.clone().unwrap())
}

fn is_obj(kind: &Option<String>) -> bool {
    kind.as_deref() == Some("object")
}
fn model(app: &AppHandle, kind: &Option<String>) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models").join(if is_obj(kind) { "birefnet_lite.onnx" } else { "modnet.onnx" }))
}

#[tauri::command]
pub fn matte_ready(app: AppHandle, kind: Option<String>) -> R<bool> {
    Ok(model(&app, &kind)?.exists())
}

#[tauri::command]
pub async fn matte_download(app: AppHandle, kind: Option<String>) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = if is_obj(&kind) { "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx" } else { "https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx" };
        fetch(&app, url, &model(&app, &kind)?, "matte_dl")
    }).await.map_err(err)?
}

/// Download `url` to `file` (through a .part file), with "progress" events under `label`.
pub fn fetch(app: &AppHandle, url: &str, file: &std::path::Path, label: &str) -> R<()> {
    std::fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
    let res = ureq::get(url).call().map_err(err)?;
    let total: f64 = res.header("content-length").and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let part = file.with_extension("part");
    let mut w = std::fs::File::create(&part).map_err(err)?;
    let (mut r, mut buf) = (res.into_reader(), vec![0u8; 1 << 16]);
    let (mut got, mut last) = (0f64, 0f64);
    loop {
        let n = r.read(&mut buf).map_err(err)?;
        if n == 0 { break; }
        w.write_all(&buf[..n]).map_err(err)?;
        got += n as f64;
        if total > 0.0 && got / total - last > 0.005 {
            last = got / total;
            let _ = app.emit("progress", json!({ "label": label, "p": last }));
        }
    }
    drop(w);
    std::fs::rename(part, file).map_err(err)
}

/// Matte for the whole of `path`. Cached per file.
#[tauri::command]
pub async fn matte_make(app: AppHandle, path: String, job: String, kind: Option<String>, full: Option<bool>) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pr = super::probe_one(&path)?;
        let (w, h, fps, dur) = (pr["w"].as_u64().unwrap_or(0) as u32, pr["h"].as_u64().unwrap_or(0) as u32, pr["fps"].as_f64().unwrap_or(0.0), pr["dur"].as_f64().unwrap_or(0.0));
        use std::hash::{Hash, Hasher};
        let mut hs = std::collections::hash_map::DefaultHasher::new();
        let mt = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok()).map(|t| format!("{t:?}")).unwrap_or_default();
        let obj = is_obj(&kind);
        let full = !obj || full.unwrap_or(false);
        (&path, mt, if obj { "birefnet1" } else { "modnet1" }, full).hash(&mut hs);
        let dir = app.path().app_data_dir().map_err(err)?.join("matte");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let out = dir.join(format!("{:016x}.mp4", hs.finish()));
        let srv = app.state::<std::sync::Arc<super::MediaServer>>();
        if !out.exists() {
            // model input: MODNet short side 512, both sides multiples of 32; BiRefNet a fixed 1024 square (squashed; the matte is stretched back)
            let k = 512.0 / (w.min(h).max(1) as f64);
            let (mw, mh) = if obj { (1024, 1024) } else { (((w as f64 * k / 32.0).round() as usize).max(1) * 32, ((h as f64 * k / 32.0).round() as usize).max(1) * 32) };
            let fps = if fps > 1.0 { fps } else { 30.0 };
            let step = if full { 1 } else { (fps / 6.0).round().max(1.0) as u64 };
            let s = |x: &str| x.to_string();
            let mut dec = command(&sidecar("ffmpeg")).args([s("-v"), s("error"), s("-i"), path.clone(), s("-map"), s("0:v:0"), s("-vf"), format!("scale={mw}:{mh}:flags=area,format=rgb24"),
                s("-r"), format!("{fps:.4}"), s("-f"), s("rawvideo"), s("-")]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(err)?;
            let tmp = out.with_extension("part.mp4");
            let mut enc = command(&sidecar("ffmpeg")).args([s("-v"), s("error"), s("-y"), s("-f"), s("rawvideo"), s("-pix_fmt"), s("gray"), s("-s"), format!("{mw}x{mh}"),
                s("-framerate"), format!("{fps:.4}"), s("-i"), s("-"), s("-c:v"), s("libx264"), s("-preset"), s("fast"), s("-crf"), s("10"), s("-g"), s("15"), s("-pix_fmt"), s("yuv420p"),
                tmp.to_string_lossy().into_owned()]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(err)?;
            let env = ort_env()?;
            let mut b = ort::session::Session::builder(&env).map_err(err)?;
            // ort picks CoreML on macOS by default; BiRefNet's Neural Engine compile never finishes there, CPU is ~2.8 s a frame
            if obj { b = b.with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(err)?; }
            let mut sess = b.commit_from_file(model(&app, &kind)?).map_err(err)?;
            let (mut so, mut si) = (dec.stdout.take().unwrap(), enc.stdin.take().unwrap());
            let (n, total) = (mw * mh, (dur * fps).max(1.0));
            let (mut rgb, mut x, mut g) = (vec![0u8; n * 3], vec![0f32; n * 3], vec![0u8; n]);
            let (mut done, mut prev, mut held) = (0f64, Vec::<u8>::new(), 0u64);
            const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
            const SD: [f32; 3] = [0.229, 0.224, 0.225];
            let res = (|| -> R<()> {
                while so.read_exact(&mut rgb).is_ok() {
                    done += 1.0;
                    // objects: frames between model runs wait, then get a blend of the two mattes around them
                    if (done as u64 - 1) % step != 0 { held += 1; continue; }
                    for i in 0..n { for c in 0..3 { let v = rgb[i * 3 + c] as f32; x[c * n + i] = if obj { (v / 255.0 - MEAN[c]) / SD[c] } else { v / 127.5 - 1.0 }; } }
                    let t = ort::value::Tensor::from_array(([1usize, 3, mh, mw], x.clone())).map_err(err)?;
                    let o = sess.run(ort::inputs![t]).map_err(err)?;
                    let (_, a) = o[0].try_extract_tensor::<f32>().map_err(err)?;
                    for i in 0..n { let v = if obj { 1.0 / (1.0 + (-a[i]).exp()) } else { a[i] }; g[i] = (v.clamp(0.0, 1.0) * 255.0).round() as u8; }
                    for j in 1..=held {
                        let f = j as f32 / (held + 1) as f32;
                        let m: Vec<u8> = prev.iter().zip(&g).map(|(&p, &q)| (p as f32 + (q as f32 - p as f32) * f).round() as u8).collect();
                        si.write_all(&m).map_err(err)?;
                    }
                    held = 0;
                    si.write_all(&g).map_err(err)?;
                    prev.clone_from(&g);
                    if obj || done as u64 % 10 == 0 { let _ = app.emit("matteprog", json!({ "job": job, "p": (done / total).min(0.99) })); }
                }
                for _ in 0..held { si.write_all(&prev).map_err(err)?; } // tail after the last model run
                Ok(())
            })();
            drop(si);
            let _ = dec.wait();
            let mut e = String::new();
            let _ = enc.stderr.take().unwrap().read_to_string(&mut e);
            let st = enc.wait().map_err(err)?;
            if let Err(x) = res { let _ = std::fs::remove_file(&tmp); return Err(x); }
            if !st.success() || done < 1.0 { let _ = std::fs::remove_file(&tmp); return Err(format!("matte: {}", tail(&e))); }
            std::fs::rename(&tmp, &out).map_err(err)?;
        }
        let p = out.to_string_lossy().into_owned();
        srv.allow(&p);
        Ok(p)
    }).await.map_err(err)?
}

// Remove background on the phone: U2-Net-p (Apache-2.0, 4.6 MB, shipped inside the iOS app), one model for people and products.
// Raw IPC body = 320x320 RGBA frames (the app squashes each frame); the answer = one 256x256 8-bit matte per frame.
const CUT_URL: &str = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx";
const CUT_SIZE: u64 = 4_574_861;
fn cut_model(app: &AppHandle) -> R<PathBuf> { Ok(app.path().app_data_dir().map_err(err)?.join("models").join("u2netp.onnx")) }

#[cfg(target_os = "ios")]
fn cut_bytes(_: &AppHandle) -> R<std::borrow::Cow<'static, [u8]>> { Ok(include_bytes!("../resources/u2netp.onnx").as_slice().into()) }
#[cfg(not(target_os = "ios"))]
fn cut_bytes(app: &AppHandle) -> R<std::borrow::Cow<'static, [u8]>> { Ok(std::fs::read(cut_model(app)?).map_err(err)?.into()) }

#[tauri::command]
pub fn cut_ready(app: AppHandle) -> R<bool> {
    if cfg!(target_os = "ios") { return Ok(true); } // bundled
    Ok(cut_model(&app)?.metadata().map(|m| m.len() == CUT_SIZE).unwrap_or(false))
}

#[tauri::command]
pub async fn cut_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || { let f = cut_model(&app)?; fetch(&app, CUT_URL, &f, "cut_dl") }).await.map_err(err)?
}

#[tauri::command]
pub async fn cut_raw(app: AppHandle, request: tauri::ipc::Request<'_>) -> R<tauri::ipc::Response> {
    const S: usize = 320; const M: usize = 256;
    let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("expected raw frames".into()) };
    if b.is_empty() || b.len() % (S * S * 4) != 0 { return Err("bad frame size".into()); }
    let b = b.clone();
    tauri::async_runtime::spawn_blocking(move || -> R<tauri::ipc::Response> {
        let rt = ort_env()?;
        let mut sess = ort::session::Session::builder(&rt).map_err(err)?
            .with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(err)?
            .commit_from_memory(&cut_bytes(&app)?).map_err(err)?;
        const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
        const SD: [f32; 3] = [0.229, 0.224, 0.225];
        let n = S * S;
        let mut out = Vec::with_capacity(b.len() / (S * S * 4) * M * M);
        let mut x = vec![0f32; 3 * n];
        for f in b.chunks_exact(n * 4) {
            for i in 0..n { for c in 0..3 { x[c * n + i] = (f[i * 4 + c] as f32 / 255.0 - MEAN[c]) / SD[c]; } }
            let t = ort::value::Tensor::from_array(([1usize, 3, S, S], x.clone())).map_err(err)?;
            let o = sess.run(ort::inputs![t]).map_err(err)?;
            let (_, a) = o[0].try_extract_tensor::<f32>().map_err(err)?;
            // the model's output is relative: stretch it to 0..1 the way rembg does
            let (lo, hi) = a.iter().fold((f32::MAX, f32::MIN), |(l, h), &v| (l.min(v), h.max(v)));
            let k = 1.0 / (hi - lo).max(1e-6);
            for y in 0..M { for xx in 0..M { out.push((((a[(y * S / M) * S + xx * S / M] - lo) * k).clamp(0.0, 1.0) * 255.0) as u8); } }
        }
        Ok(tauri::ipc::Response::new(out))
    }).await.map_err(err)?
}

// Smooth slow motion on the phone: RIFE 4.25 lite (MIT, hzwer; ONNX export from huggingface t9749/rife-4.25-lite-onnx), shipped inside the iOS app.
// Raw IPC body = two RGBA frames back to back, headers w, h, n; the answer = the n-1 RGBA frames between them.
#[cfg(target_os = "ios")]
const SLOW_MODEL: &[u8] = include_bytes!("../resources/rife_v425lite.onnx");
#[cfg(not(target_os = "ios"))]
const SLOW_MODEL: &[u8] = &[]; // the desktop app uses rife-ncnn (rife.rs)

#[tauri::command]
pub async fn slow_raw(request: tauri::ipc::Request<'_>) -> R<tauri::ipc::Response> {
    static SESS: std::sync::Mutex<Option<ort::session::Session>> = std::sync::Mutex::new(None);
    let hd = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()).ok_or_else(|| format!("missing {k}"));
    let (w, h, n) = (hd("w")?, hd("h")?, hd("n")?);
    let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("expected raw frames".into()) };
    if w == 0 || h == 0 || !(2..=8).contains(&n) || b.len() != w * h * 8 { return Err("bad frames".into()); }
    if SLOW_MODEL.is_empty() { return Err("slow motion model is in the phone app only".into()); }
    let b = b.clone();
    tauri::async_runtime::spawn_blocking(move || -> R<tauri::ipc::Response> {
        let mut g = SESS.lock().map_err(err)?;
        if g.is_none() { // 22 MB model: load once, keep for the next pairs
            let rt = ort_env()?;
            *g = Some(ort::session::Session::builder(&rt).map_err(err)?
                .with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(err)?
                .commit_from_memory(SLOW_MODEL).map_err(err)?);
        }
        let sess = g.as_mut().unwrap();
        // the network wants sides in multiples of 64: pad by repeating the edge, crop back after
        let (pw, ph) = ((w + 63) / 64 * 64, (h + 63) / 64 * 64);
        let pn = pw * ph;
        let planar = |f: &[u8]| {
            let mut x = vec![0f32; 3 * pn];
            for y in 0..ph { let r = y.min(h - 1) * w; for xx in 0..pw { let p = (r + xx.min(w - 1)) * 4; for c in 0..3 { x[c * pn + y * pw + xx] = f[p + c] as f32 / 255.0; } } }
            x
        };
        let (a, c) = (planar(&b[..w * h * 4]), planar(&b[w * h * 4..]));
        let mut out = Vec::with_capacity((n - 1) * w * h * 4);
        for k in 1..n {
            let t0 = ort::value::Tensor::from_array(([1usize, 3, ph, pw], a.clone())).map_err(err)?;
            let t1 = ort::value::Tensor::from_array(([1usize, 3, ph, pw], c.clone())).map_err(err)?;
            let ts = ort::value::Tensor::from_array(([1usize, 1, 1, 1], vec![k as f32 / n as f32])).map_err(err)?;
            let o = sess.run(ort::inputs![t0, t1, ts]).map_err(err)?;
            let (_, d) = o[0].try_extract_tensor::<f32>().map_err(err)?;
            for y in 0..h { for x in 0..w { let q = y * pw + x; for ch in 0..3 { out.push((d[ch * pn + q] * 255.0 + 0.5).clamp(0.0, 255.0) as u8); } out.push(255); } }
        }
        Ok(tauri::ipc::Response::new(out))
    }).await.map_err(err)?
}
