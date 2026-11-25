// Separate sounds: a clip's audio split into dialogue, music and effects with TIGER-DnR (JusperLee/TIGER, Apache-2.0),
// as audiojs/tiger-dnr exports it to ONNX (7.3 MB, int8 weights). The graph holds only the networks between the STFT and
// the iSTFT; both are done here as @audio/neural-separate does them: mono 44.1 kHz, STFT n 2048 hop 512 Hann
// (unnormalized, centered, reflect), 12 s segments every 4 s, the input zero-padded 8 s at each end, the sum / 3.
use super::{command, err, sidecar, tail, R};
use ort::session::{builder::AutoDevicePolicy, RunOptions, Session};
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const URL: &str = "https://huggingface.co/audiojs/tiger-dnr/resolve/1c959ab7ff8794dc5663b104ba301687ab95d2ab/tiger.int8.onnx";
const SIZE: u64 = 7_320_735;
const SR: usize = 44100;
const N: usize = 2048;
const HOP: usize = 512;
const F: usize = N / 2 + 1;
const T: usize = 1034;
const L: usize = 529_200; // 12 s
const STEP: usize = L / 3;
pub const NAMES: [&str; 3] = ["dialogue", "music", "effects"];
pub static STOP: AtomicBool = AtomicBool::new(false);

fn model(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models").join("tiger-dnr.int8.onnx"))
}

#[tauri::command]
pub fn stems_ready(app: AppHandle) -> R<bool> {
    Ok(model(&app)?.metadata().map(|m| m.len() == SIZE).unwrap_or(false))
}

#[tauri::command]
pub fn stems_remove(app: AppHandle) -> R<()> {
    super::remove_model_file(&model(&app)?)
}

#[tauri::command]
pub async fn stems_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let f = model(&app)?;
        super::matte::fetch(&app, URL, &f, "stems_dl")?;
        if f.metadata().map(|m| m.len()).unwrap_or(0) != SIZE { let _ = std::fs::remove_file(&f); return Err("stems: model download incomplete".into()); }
        Ok(())
    }).await.map_err(err)?
}

struct Fft {
    swaps: Vec<(usize, usize)>,
    forward: Vec<Vec<(f64, f64)>>,
    inverse: Vec<Vec<(f64, f64)>>,
}

impl Fft {
    fn new() -> Self {
        let levels = N.ilog2();
        let swaps = (1..N)
            .filter_map(|i| {
                let j = i.reverse_bits() >> (usize::BITS - levels);
                (i < j).then_some((i, j))
            })
            .collect();
        let twiddles = |direction: f64| {
            (1..=levels)
                .map(|level| {
                    let len = 1 << level;
                    let angle = direction * std::f64::consts::PI / len as f64;
                    (0..len / 2)
                        .map(|k| {
                            let a = angle * k as f64;
                            (a.cos(), a.sin())
                        })
                        .collect()
                })
                .collect()
        };
        Self {
            swaps,
            forward: twiddles(-2.0),
            inverse: twiddles(2.0),
        }
    }

    /// In-place radix-2 FFT. The inverse is unnormalized.
    fn transform(&self, re: &mut [f64], im: &mut [f64], inverse: bool) {
        for &(i, j) in &self.swaps {
            re.swap(i, j);
            im.swap(i, j);
        }
        let stages = if inverse { &self.inverse } else { &self.forward };
        for weights in stages {
            let half = weights.len();
            for start in (0..N).step_by(2 * half) {
                for (k, &(wr, wi)) in weights.iter().enumerate() {
                    let p = start + k;
                    let q = p + half;
                    let xr = re[q] * wr - im[q] * wi;
                    let xi = re[q] * wi + im[q] * wr;
                    re[q] = re[p] - xr;
                    im[q] = im[p] - xi;
                    re[p] += xr;
                    im[p] += xi;
                }
            }
        }
    }
}

fn reflect(i: isize, n: usize) -> usize {
    let p = 2 * (n as isize - 1);
    let i = i.rem_euclid(p);
    (if i < n as isize { i } else { p - i }) as usize
}

fn check_cancelled() -> R<()> {
    if STOP.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    Ok(())
}

/// One 12 s segment -> its three stems (each L samples).
fn segment(
    session: &mut Session,
    options: &RunOptions,
    seg: &[f32],
    fft: &Fft,
    win: &[f64],
    env: &[f64],
) -> R<[Vec<f32>; 3]> {
    let mut spec = vec![0f32; 2 * F * T];
    let (mut re, mut im) = (vec![0f64; N], vec![0f64; N]);
    for t in 0..T {
        for i in 0..N {
            re[i] = seg[reflect((t * HOP + i) as isize - (N / 2) as isize, L)] as f64 * win[i];
            im[i] = 0.0;
        }
        fft.transform(&mut re, &mut im, false);
        for f in 0..F {
            spec[f * T + t] = re[f] as f32;
            spec[F * T + f * T + t] = im[f] as f32;
        }
    }
    check_cancelled()?;
    let x = ort::value::Tensor::from_array(([1usize, 2, F, T], spec)).map_err(err)?;
    let o = session.run_with_options(ort::inputs![x], options).map_err(err)?;
    let (_, z) = o[0].try_extract_tensor::<f32>().map_err(err)?;
    let mut out: [Vec<f32>; 3] = Default::default();
    for (s, dst) in out.iter_mut().enumerate() {
        check_cancelled()?;
        let (pr, pi) = (2 * s * F * T, (2 * s + 1) * F * T);
        let mut acc = vec![0f64; (T - 1) * HOP + N];
        for t in 0..T {
            // Hermitian spectrum -> real frame (irfft: DC and Nyquist taken as real)
            for f in 0..F {
                re[f] = z[pr + f * T + t] as f64;
                im[f] = if f == 0 || f == F - 1 { 0.0 } else { z[pi + f * T + t] as f64 };
            }
            for f in F..N {
                re[f] = re[N - f];
                im[f] = -im[N - f];
            }
            fft.transform(&mut re, &mut im, true);
            for i in 0..N {
                acc[t * HOP + i] += re[i] / N as f64 * win[i];
            }
        }
        *dst = (N / 2..N / 2 + L)
            .map(|j| if env[j] > 1e-8 { (acc[j] / env[j]) as f32 } else { 0.0 })
            .collect();
    }
    Ok(out)
}

fn write_wav(p: &std::path::Path, x: &[f32]) -> R<()> {
    let n = (x.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + n as usize);
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + n).to_le_bytes()); b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&(SR as u32).to_le_bytes()); b.extend_from_slice(&(SR as u32 * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes()); b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data"); b.extend_from_slice(&n.to_le_bytes());
    for v in x { b.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()); }
    std::fs::write(p, b).map_err(err)
}

/// Mono 44.1 kHz samples -> the three stems over the zero-padded input (border = L - STEP samples each side).
// shortcut: whole clip held in memory (~1 GB for an hour), fine for social clips; stream to disk if long sources matter
fn separate(model: &std::path::Path, x: &[f32], mut progress: impl FnMut(f64)) -> R<Vec<Vec<f32>>> {
    check_cancelled()?;
    let (n, border) = (x.len(), L - STEP);
    let m = n + 2 * border;
    let mut starts = vec![0];
    while starts.last().unwrap() + L < m {
        starts.push(starts.last().unwrap() + STEP);
    }

    let fft = Fft::new();
    let win: Vec<f64> = (0..N)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / N as f64).cos())
        .collect();
    let mut env = vec![0f64; (T - 1) * HOP + N];
    for t in 0..T {
        for i in 0..N {
            env[t * HOP + i] += win[i] * win[i];
        }
    }

    // Each session has its own activation buffers. Cap the number of simultaneous segments.
    let cores = thread::available_parallelism().map_or(1, usize::from);
    let max_workers = if cfg!(any(target_os = "ios", target_os = "android")) {
        1
    } else {
        4
    };
    let workers = (cores / 3).clamp(1, max_workers).min(starts.len());
    let threads_per_worker = (cores / workers).min(6);
    // Two inter-op threads use one extra thread beyond the calling thread.
    let parallel_graph = threads_per_worker > 1;
    let intra_threads = threads_per_worker - usize::from(parallel_graph);
    let rt = super::matte::ort_env()?;
    let options = (0..workers)
        .map(|_| RunOptions::new().map_err(err))
        .collect::<R<Vec<_>>>()?;
    let mut acc = vec![vec![0f32; m]; 3];

    progress(0.0);
    thread::scope(|scope| {
        let mut receivers = Vec::with_capacity(workers);
        for (worker, options) in options.iter().enumerate() {
            // Backpressure bounds the number of completed segments waiting to be mixed.
            let (send, receive) = sync_channel(0);
            receivers.push(receive);
            let (rt, fft, win, env, starts) = (&rt, &fft, &win, &env, &starts);
            scope.spawn(move || {
                let run = || -> R<()> {
                    check_cancelled()?;
                    // CoreML refuses the graph with "generic_general_slice: Invalid values".
                    // Parallel graph execution lowered peak memory for TIGER on the CPU.
                    let mut session = Session::builder(rt)
                        .map_err(err)?
                        .with_auto_device(AutoDevicePolicy::PreferCPU)
                        .map_err(err)?
                        .with_intra_threads(intra_threads)
                        .map_err(err)?
                        .with_parallel_execution(parallel_graph)
                        .map_err(err)?
                        .with_inter_threads(1 + usize::from(parallel_graph))
                        .map_err(err)?
                        .with_memory_pattern(false)
                        .map_err(err)?
                        .commit_from_file(model)
                        .map_err(err)?;
                    let mut seg = vec![0f32; L];
                    for &st in starts.iter().skip(worker).step_by(workers) {
                        check_cancelled()?;
                        let from = st.max(border);
                        let to = (st + L).min(border + n);
                        seg.fill(0.0);
                        seg[from - st..to - st].copy_from_slice(&x[from - border..to - border]);
                        let out = segment(&mut session, options, &seg, fft, win, env)?;
                        if send.send(Ok(out)).is_err() {
                            break;
                        }
                    }
                    Ok(())
                };
                if let Err(error) = run() {
                    let _ = send.send(Err(error));
                }
            });
        }

        // Mix in segment order to preserve the floating-point sums and serialize progress.
        let result = starts.iter().enumerate().try_for_each(|(k, &st)| -> R<()> {
            let out = loop {
                check_cancelled()?;
                match receivers[k % workers].recv_timeout(Duration::from_millis(50)) {
                    Ok(out) => break out?,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(error) => return Err(err(error)),
                }
            };
            check_cancelled()?;
            let len = L.min(m - st);
            for (dst, src) in acc.iter_mut().zip(&out) {
                for (sample, value) in dst[st..st + len].iter_mut().zip(src) {
                    *sample += value;
                }
            }
            check_cancelled()?;
            progress((k + 1) as f64 / starts.len() as f64);
            Ok(())
        });
        // Release workers waiting to send before the scope joins them.
        drop(receivers);
        if result.is_err() {
            for options in &options {
                let _ = options.terminate();
            }
        }
        result
    })?;
    Ok(acc)
}

/// Source range [start, start+len] of `path` -> three mono WAVs (dialogue, music, effects). Cached by its inputs.
#[tauri::command]
pub async fn stems_make(app: AppHandle, path: String, start: f64, len: f64) -> R<Vec<String>> {
    STOP.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        use std::hash::{Hash, Hasher};
        let mut hs = std::collections::hash_map::DefaultHasher::new();
        let mt = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok()).map(|t| format!("{t:?}")).unwrap_or_default();
        (&path, mt, format!("{start:.3}"), format!("{len:.3}"), "tiger1").hash(&mut hs);
        let stem = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let dir = app.path().app_data_dir().map_err(err)?.join("stems").join(format!("{:016x}", hs.finish()));
        let outs: Vec<PathBuf> = NAMES.iter().map(|n| dir.join(format!("{stem} - {n}.wav"))).collect();
        if !outs.iter().all(|p| p.exists()) {
            std::fs::create_dir_all(&dir).map_err(err)?;
            let s = |x: &str| x.to_string();
            let mut a = vec![s("-v"), s("error"), s("-ss"), format!("{start:.4}")];
            if len > 0.0 { a.extend([s("-t"), format!("{len:.4}")]); }
            a.extend([s("-i"), path.clone(), s("-map"), s("0:a:0"), s("-ac"), s("1"), s("-ar"), SR.to_string(), s("-f"), s("f32le"), s("-")]);
            let o = command(&sidecar("ffmpeg")).args(&a).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(err)?;
            if !o.status.success() { return Err(format!("stems: {}", tail(&String::from_utf8_lossy(&o.stderr)))); }
            let x: Vec<f32> = o.stdout.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            if x.is_empty() { return Err("stems: no audio".into()); }
            let (n, border) = (x.len(), L - STEP);
            let acc = separate(&model(&app)?, &x, |p| { let _ = app.emit("progress", json!({ "label": "stems", "p": p })); })?;
            // every sample of the clip lies in exactly three segments
            for (s, p) in outs.iter().enumerate() {
                let y: Vec<f32> = acc[s][border..border + n].iter().map(|v| v / 3.0).collect();
                let tmp = p.with_extension("part");
                write_wav(&tmp, &y)?;
                std::fs::rename(&tmp, p).map_err(err)?;
            }
        }
        Ok(outs.iter().map(|p| p.to_string_lossy().into_owned()).collect())
    }).await.map_err(err)?
}

/// iOS (no ffmpeg): the raw IPC body is mono 44.1 kHz f32le samples, the answer is the three stems back to back, same format.
#[tauri::command]
pub async fn stems_raw(app: AppHandle, request: tauri::ipc::Request<'_>) -> R<tauri::ipc::Response> {
    let tauri::ipc::InvokeBody::Raw(b) = request.body() else { return Err("stems: expected raw samples".into()) };
    let x: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    if x.is_empty() { return Err("stems: no audio".into()); }
    STOP.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let (n, border) = (x.len(), L - STEP);
        let acc = separate(&model(&app)?, &x, |p| { let _ = app.emit("progress", json!({ "label": "stems", "p": p })); })?;
        let mut out = Vec::with_capacity(3 * n * 4);
        for s in &acc { for v in &s[border..border + n] { out.extend_from_slice(&(v / 3.0).to_le_bytes()); } }
        Ok(tauri::ipc::Response::new(out))
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    // STEMS_IN=<mono f32le 44.1k file> STEMS_MODEL=<onnx> cargo test --lib stems -- --ignored --nocapture
    #[test]
    #[ignore]
    fn separate_file() {
        let (i, mdl) = (std::env::var("STEMS_IN").unwrap(), std::env::var("STEMS_MODEL").unwrap());
        let b = std::fs::read(&i).unwrap();
        let x: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let t0 = std::time::Instant::now();
        let mut last = None;
        let acc = separate(std::path::Path::new(&mdl), &x, |p| {
            assert!((0.0..=1.0).contains(&p));
            assert!(last.map_or(p == 0.0, |previous| p >= previous));
            last = Some(p);
            eprintln!("{p:.2}");
        }).unwrap();
        assert_eq!(last, Some(1.0));
        eprintln!("{:.1} s for {:.1} s of audio", t0.elapsed().as_secs_f64(), x.len() as f64 / SR as f64);
        let border = L - STEP;
        for (s, nm) in NAMES.iter().enumerate() {
            let y: Vec<f32> = acc[s][border..border + x.len()].iter().map(|v| v / 3.0).collect();
            write_wav(&std::path::PathBuf::from(format!("{i}.{nm}.wav")), &y).unwrap();
        }
    }
    #[test]
    fn fft_round_trip() {
        let x: Vec<f64> = (0..N).map(|i| ((i * 7919) % 101) as f64 / 50.0 - 1.0).collect();
        let (mut re, mut im) = (x.clone(), vec![0f64; N]);
        let fft = Fft::new();
        fft.transform(&mut re, &mut im, false);
        // DC bin is the sum
        assert!((re[0] - x.iter().sum::<f64>()).abs() < 1e-9);
        fft.transform(&mut re, &mut im, true);
        for i in 0..N { assert!((re[i] / N as f64 - x[i]).abs() < 1e-9); }
    }
}
