use crate::{command, err, media_source_key, sidecar, tail, R};
use serde::Serialize;
use serde_json::json;
use std::collections::VecDeque;
use std::io::{BufReader, Read};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const SIZE: usize = 96;
const PLANE: usize = SIZE * SIZE;
const FPS: f64 = 4.0;

#[derive(Clone, Serialize)]
pub(crate) struct Sample(f64, f64, f64, bool);

type CacheKey = (String, u64, u64);

#[derive(Default)]
pub(crate) struct Reframe {
    active: Mutex<Option<Job>>,
    cache: Mutex<VecDeque<(CacheKey, Vec<Sample>)>>,
}

struct Job {
    id: String,
    cancelled: bool,
    child: Option<Child>,
}

impl Reframe {
    pub(crate) fn cancel(&self, id: Option<&str>) {
        let mut active = self.active.lock().unwrap();
        if let Some(job) = active.as_mut().filter(|j| id.is_none_or(|id| j.id == id)) {
            job.cancelled = true;
            if let Some(child) = &mut job.child {
                let _ = child.kill();
            }
        }
    }
}

fn score(frame: &[u8], previous: &[u8], motion: bool, baseline: &mut f64) -> (f64, f64, bool) {
    let y = &frame[..PLANE];
    let diff = |i: usize| y[i].abs_diff(previous[i]);
    let mut mean = 0.0;
    let mut changed = 0;
    if motion {
        for i in 0..PLANE {
            let d = diff(i);
            mean += f64::from(d);
            changed += usize::from(d > 24);
        }
        mean /= PLANE as f64;
    }
    let cut = motion && changed > PLANE / 2 && mean > (2.5 * *baseline).max(28.0);
    if motion && !cut {
        *baseline = 0.8 * *baseline + 0.2 * mean;
    }
    // A weak centre prior keeps low-detail shots stable.
    let (mut x, mut cy, mut total) = (12.0, 12.0, 24.0);
    for row in 1..SIZE - 1 {
        for col in 1..SIZE - 1 {
            let i = row * SIZE + col;
            let c = row / 2 * (SIZE / 2) + col / 2;
            let (cb, cr) = (frame[PLANE + c], frame[PLANE + PLANE / 4 + c]);
            let skin = (77..=127).contains(&cb)
                && (133..=173).contains(&cr)
                && (35..=235).contains(&y[i]);
            let texture = (f64::from(y[i - 1].abs_diff(y[i + 1]))
                + f64::from(y[i - SIZE].abs_diff(y[i + SIZE]))) / 255.0;
            let mut w = texture.min(0.5) * 0.22;
            if skin {
                w += 0.25 + texture.min(0.5);
            }
            if motion && !cut {
                w += ((f64::from(diff(i)) - mean.max(9.0)).max(0.0) / 64.0).min(2.0);
            }
            x += w * (col as f64 + 0.5) / SIZE as f64;
            cy += w * (row as f64 + 0.5) / SIZE as f64;
            total += w;
        }
    }
    (x / total, cy / total, cut)
}

fn decode(
    app: &AppHandle, state: &Reframe, id: &str, path: &str, start: f64, duration: f64,
) -> R<Vec<Sample>> {
    let mut active = state.active.lock().unwrap();
    let job = active.as_mut().unwrap();
    if job.cancelled {
        return Err("cancelled".into());
    }
    let filter = format!("fps={FPS}:round=up:start_time=0,scale={SIZE}:{SIZE},format=yuv420p");
    let mut child = command(&sidecar("ffmpeg"))
        .args(["-v", "error", "-filter_threads", "1", "-ss", &start.to_string(), "-t", &duration.to_string(),
            "-i", path, "-map", "0:V:0", "-an", "-vf", &filter, "-threads:v", "1", "-f", "rawvideo", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut stderr = child.stderr.take().unwrap();
    job.child = Some(child);
    drop(active);

    let log = std::thread::spawn(move || {
        let mut log = String::new();
        let _ = stderr.read_to_string(&mut log);
        log
    });
    let mut samples = Vec::new();
    let mut frame = vec![0; PLANE * 3 / 2];
    let mut prev = frame.clone();
    let mut baseline = 8.0;
    let mut progress = 0;
    let read_error = loop {
        match stdout.read_exact(&mut frame) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break None,
            Err(e) => break Some(e),
        }
        let t = samples.len() as f64 / FPS;
        let (x, y, cut) = score(&frame, &prev, !samples.is_empty(), &mut baseline);
        samples.push(Sample(t, x, y, cut));
        std::mem::swap(&mut frame, &mut prev);
        let p = ((t + 1.0 / FPS) / duration * 100.0).min(99.0) as u32;
        if p > progress {
            progress = p;
            let _ = app.emit("reframe-progress", json!({ "job": id, "p": p as f64 / 100.0 }));
        }
    };
    drop(stdout);
    if read_error.is_some() {
        state.cancel(Some(id));
    }
    let log = log.join().unwrap_or_default();
    let mut active = state.active.lock().unwrap();
    let job = active.as_mut().unwrap();
    let status = job.child.take().unwrap().wait().map_err(err)?;
    if let Some(e) = read_error {
        return Err(err(e));
    }
    if job.cancelled {
        return Err("cancelled".into());
    }
    if !status.success() {
        return Err(tail(&log));
    }
    if samples.is_empty() {
        return Err("No video frames in the source range".into());
    }
    Ok(samples)
}

#[tauri::command]
pub(crate) async fn reframe_analyze(
    app: AppHandle, job: String, path: String, start: f64, duration: f64,
) -> R<Vec<Sample>> {
    if !start.is_finite() || start < 0.0 || !duration.is_finite() || duration <= 0.0 {
        return Err("Invalid source range".into());
    }
    {
        let state = app.state::<Reframe>();
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err("Another reframe analysis is running".into());
        }
        *active = Some(Job { id: job.clone(), cancelled: false, child: None });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Reframe>();
        let result = (|| {
            let source = media_source_key(&path)?;
            let key = (source.clone(), start.to_bits(), duration.to_bits());
            {
                let mut cache = state.cache.lock().unwrap();
                if let Some(i) = cache.iter().position(|(k, _)| k == &key) {
                    let hit = cache.remove(i).unwrap();
                    let samples = hit.1.clone();
                    cache.push_back(hit);
                    return Ok(samples);
                }
            }
            let samples = decode(&app, &state, &job, &path, start, duration)?;
            if media_source_key(&path)? != source {
                return Err("Source changed".into());
            }
            let mut cache = state.cache.lock().unwrap();
            if cache.len() >= 24 {
                cache.pop_front();
            }
            cache.push_back((key, samples.clone()));
            Ok(samples)
        })();
        let cancelled = state.active.lock().unwrap().take().unwrap().cancelled;
        if cancelled {
            Err("cancelled".into())
        } else {
            result
        }
    }).await.map_err(err)?
}

#[tauri::command]
pub(crate) fn reframe_cancel(state: State<'_, Reframe>, job: String) {
    state.cancel(Some(&job));
}
