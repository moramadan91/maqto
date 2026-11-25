use super::{command, err, matte, media_source_key, sidecar, R};
use ort::{session::{builder::AutoDevicePolicy, RunOptions, Session}, value::Tensor};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::VecDeque,
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{atomic::{AtomicBool, Ordering::Relaxed}, Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

const MODEL: &str = "transnetv2.onnx";
const MODEL_URL: &str = "https://huggingface.co/edgetools/transnetv2/resolve/main/transnetv2.onnx";
const FRAME: usize = 48 * 27 * 3;
const WINDOW: usize = 100;
const STRIDE: usize = 50;
const PAD: usize = (WINDOW - STRIDE) / 2;
static TRANSFER: Mutex<()> = Mutex::new(());
static ACTIVE: Mutex<Option<(String, Arc<Run>)>> = Mutex::new(None);

fn model(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models").join(MODEL))
}

#[tauri::command]
pub fn scenes_ready(app: AppHandle) -> R<bool> {
    Ok(model(&app)?.is_file())
}

#[tauri::command]
pub async fn scenes_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _transfer = TRANSFER.try_lock().map_err(|_| "Scene model transfer in progress")?;
        let path = model(&app)?;
        if !path.is_file() {
            matte::fetch(&app, MODEL_URL, &path, "scenes_dl")?;
        }
        Ok(())
    }).await.map_err(err)?
}

#[tauri::command]
pub fn scenes_remove(app: AppHandle) -> R<()> {
    let _transfer = TRANSFER.try_lock().map_err(|_| "Scene model transfer in progress")?;
    if ACTIVE.lock().map_err(err)?.is_some() {
        return Err("Scene model is in use".into());
    }
    super::remove_model_file(&model(&app)?)
}

#[derive(Default)]
struct Run {
    stopped: AtomicBool,
    child: Mutex<Option<Child>>,
    options: Mutex<Option<Arc<RunOptions>>>,
}

impl Run {
    fn check(&self) -> R<()> {
        if self.stopped.load(Relaxed) { Err("cancelled".into()) } else { Ok(()) }
    }

    fn cancel(&self) {
        self.stopped.store(true, Relaxed);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
        if let Some(options) = self.options.lock().unwrap().as_ref() {
            let _ = options.terminate();
        }
    }

    fn finish(&self) -> R<()> {
        let status = self.child.lock().map_err(err)?.take().unwrap().wait().map_err(err)?;
        self.check()?;
        if status.success() { Ok(()) } else { Err("FFmpeg scene decoding failed".into()) }
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.get_mut().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Active;
impl Drop for Active {
    fn drop(&mut self) { *ACTIVE.lock().unwrap() = None; }
}

#[tauri::command]
pub fn scenes_cancel(job: String) {
    let run = ACTIVE.lock().unwrap().as_ref().filter(|(id, _)| *id == job).map(|(_, run)| run.clone());
    if let Some(run) = run { run.cancel(); }
}

#[derive(Deserialize)]
pub struct Request {
    path: String,
    threshold: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    source_key: String,
    threshold: f64,
    cuts: Vec<f64>,
}

#[tauri::command]
pub async fn scenes_detect(app: AppHandle, request: Request, job: String) -> R<Option<Detection>> {
    let run = Arc::new(Run::default());
    {
        let _transfer = TRANSFER.try_lock().map_err(|_| "Scene model transfer in progress")?;
        let mut active = ACTIVE.lock().map_err(err)?;
        if active.is_some() { return Err("A scene detection job is already running".into()); }
        *active = Some((job.clone(), run.clone()));
    }
    let guard = Active;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let Request { path, threshold } = request;
        if !(0. ..=1.).contains(&threshold) { return Err("Invalid scene threshold".into()); }
        let source_key = media_source_key(&path)?;
        let dir = app.path().app_cache_dir().map_err(err)?.join("scenes");
        let cache = dir.join(format!("transnet-v1-{source_key}.json"));
        let predictions: Predictions = match fs::read(&cache).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
            Some(predictions) => predictions,
            None => {
                let model = model(&app)?;
                if !model.is_file() { return Ok(None); }
                let probe = super::probe_one(&path)?;
                if probe["kind"] != "video" { return Err("Scene detection needs a video".into()); }
                let fps = probe["fps"].as_f64().filter(|fps| *fps > 0.).ok_or("Source frame rate is unknown")?;
                let duration = probe["dur"].as_f64().unwrap_or(0.);
                let progress = |frames| {
                    let p = if duration > 0. { (frames as f64 / fps / duration).clamp(0., 0.99) } else { 0. };
                    let _ = app.emit("scenesprog", json!({ "job": job, "p": p }));
                };
                let predictions = predict(&sidecar("ffmpeg"), &path, &model, fps, &run, progress)?;
                run.check()?;
                if media_source_key(&path)? != source_key { return Err("The source changed during scene detection".into()); }
                let scratch = super::upscale::Scratch::new(&dir)?;
                let part = scratch.0.join("predictions.json");
                serde_json::to_writer(fs::File::create(&part).map_err(err)?, &predictions).map_err(err)?;
                run.check()?;
                fs::rename(part, &cache).map_err(err)?;
                predictions
            }
        };
        let cuts = predictions.cuts(threshold);
        run.check()?;
        if media_source_key(&path)? != source_key { return Err("The source changed during scene detection".into()); }
        Ok(Some(Detection { source_key, threshold, cuts }))
    }).await.map_err(err)?
}

#[derive(Serialize, Deserialize)]
struct Predictions {
    fps: f64,
    scores: Vec<f32>,
}

impl Predictions {
    fn cuts(&self, threshold: f64) -> Vec<f64> {
        merge_close_cuts(self.scores.iter().copied().enumerate().skip(1)
            .filter(|(_, p)| f64::from(*p) > threshold)
            .map(|(i, p)| (i as f64 / self.fps, p)))
    }
}

fn merge_close_cuts(candidates: impl IntoIterator<Item = (f64, f32)>) -> Vec<f64> {
    let mut cuts = Vec::new();
    let mut previous = f64::NEG_INFINITY;
    let mut best = (0., 0.);
    for (time, score) in candidates {
        if time - previous >= 0.3 - 1e-9 {
            if previous.is_finite() { cuts.push(best.0); }
            best = (time, score);
        } else if score > best.1 {
            best = (time, score);
        }
        previous = time;
    }
    if previous.is_finite() { cuts.push(best.0); }
    cuts
}

fn window_index(start: usize, slot: usize, frames: usize) -> usize {
    (start + slot).saturating_sub(PAD).min(frames - 1)
}

fn predict(
    ffmpeg: &Path, source: &str, model: &Path, fps: f64, run: &Run, progress: impl Fn(usize),
) -> R<Predictions> {
    run.check()?;
    let mut session = Session::builder(&matte::ort_env()?).map_err(err)?
        .with_auto_device(AutoDevicePolicy::PreferCPU).map_err(err)?
        .with_intra_threads(2).map_err(err)?
        .commit_from_file(model).map_err(err)?;
    let options = Arc::new(RunOptions::new().map_err(err)?);
    *run.options.lock().map_err(err)? = Some(options.clone());
    let mut reader = {
        let mut slot = run.child.lock().map_err(err)?;
        run.check()?;
        let mut child = command(ffmpeg).args(["-v", "error", "-nostdin", "-i", source, "-map", "0:V:0",
            "-vf", &format!("fps={fps:.12}:start_time=0,scale=48:27"), "-pix_fmt", "rgb24",
            "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", "pipe:1"])
            .stdout(Stdio::piped()).spawn().map_err(err)?;
        let stdout = child.stdout.take().unwrap();
        *slot = Some(child);
        BufReader::new(stdout)
    };
    let mut frames = VecDeque::new();
    let mut scores = Vec::new();
    let (mut read, mut base, mut eof) = (0, 0, false);
    loop {
        run.check()?;
        let start = scores.len();
        while !eof && read < start + WINDOW - PAD {
            let mut frame = vec![0; FRAME];
            if reader.read(&mut frame[..1]).map_err(err)? == 0 {
                eof = true;
                break;
            }
            reader.read_exact(&mut frame[1..]).map_err(err)?;
            frames.push_back(frame);
            read += 1;
        }
        run.check()?;
        if start == read { break; }
        let mut input = Vec::with_capacity(WINDOW * FRAME);
        for slot in 0..WINDOW {
            input.extend(frames[window_index(start, slot, read) - base].iter().map(|&v| f32::from(v)));
        }
        let input = Tensor::from_array(([1, WINDOW, 27, 48, 3], input)).map_err(err)?;
        let output = session.run_with_options(ort::inputs!["input" => input], &options)
            .map_err(|e| if run.stopped.load(Relaxed) { "cancelled".to_string() } else { err(e) })?;
        let (shape, logits) = output.get("534").ok_or("Missing TransNetV2 output 534")?.try_extract_tensor::<f32>().map_err(err)?;
        if **shape != [1, WINDOW as i64, 1] || logits.iter().any(|x| !x.is_finite()) {
            return Err(format!("Invalid TransNetV2 output {shape:?}"));
        }
        let keep = STRIDE.min(read - start);
        scores.extend(logits[PAD..PAD + keep].iter().map(|x| 1. / (1. + (-x).exp())));
        let next_base = scores.len().saturating_sub(PAD);
        frames.drain(..next_base - base);
        base = next_base;
        progress(scores.len());
    }
    run.finish()?;
    if scores.is_empty() { return Err("No video frames to analyze".into()); }
    Ok(Predictions { fps, scores })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_window_indices() {
        let indices = |start, count| (0..WINDOW).map(|slot| window_index(start, slot, count)).collect::<Vec<_>>();
        assert_eq!(indices(0, 100), [vec![0; 25], (0..75).collect()].concat());
        assert_eq!(indices(50, 100), [(25..100).collect(), vec![99; 25]].concat());
        assert_eq!(indices(100, 101), [(75..101).collect(), vec![100; 74]].concat());
        assert_eq!(indices(0, 1), vec![0; 100]);
    }

    #[test]
    fn scene_merge_close_cuts() {
        assert!(merge_close_cuts([]).is_empty());
        assert_eq!(merge_close_cuts([(1., 0.7), (1.04, 0.9), (1.2, 0.8), (1.5, 0.7), (2., 0.9), (2.1, 0.9)]), [1.04, 1.5, 2.]);
    }

    #[test]
    fn scene_smoke_red_to_blue() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let model = root.join("../.models/transnet/transnetv2.onnx");
        if !model.is_file() {
            eprintln!("Skipping TransNetV2 smoke test (.models fixture missing)");
            return;
        }
        let sidecar = sidecar("ffmpeg");
        let ffmpeg = if sidecar.is_file() { sidecar } else { PathBuf::from("ffmpeg") };
        let scratch = super::super::upscale::Scratch::new(&std::env::temp_dir()).unwrap();
        let video = scratch.0.join("red-blue.mp4");
        let result = command(&ffmpeg).args(["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=25:d=2",
            "-f", "lavfi", "-i", "color=blue:s=160x90:r=25:d=2", "-filter_complex", "concat=n=2:v=1:a=0",
            "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&video).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let prediction = predict(&ffmpeg, video.to_str().unwrap(), &model, 25., &Run::default(), |_| {}).unwrap();
        assert_eq!(prediction.scores.len(), 100);
        let cuts = prediction.cuts(0.5);
        assert_eq!(cuts.len(), 1, "{cuts:?}");
        assert!((cuts[0] - 2.).abs() <= 0.1, "{cuts:?}");
    }
}
