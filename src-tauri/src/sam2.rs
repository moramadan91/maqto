use super::{command, err, probe_one, sidecar, tail, MediaServer, R};
use ort::{session::Session, value::{DynValue, Tensor}};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

const SIZE: usize = 1024;
const GRID: usize = 256;
const BRUSH_GRID: usize = 1024;
const URL: &str = "https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx/";
const ENCODER: &str = "vision_encoder_quantized.onnx";
const DECODER: &str = "prompt_encoder_mask_decoder_quantized.onnx";
const FILES: [&str; 4] = [ENCODER, "vision_encoder_quantized.onnx_data", DECODER, "prompt_encoder_mask_decoder_quantized.onnx_data"];
const FILE_SIZES: [u64; 4] = [441_167, 52_573_088, 290_416, 8_662_016];
const EMB: [&str; 3] = ["image_embeddings.0", "image_embeddings.1", "image_embeddings.2"];

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Prompt {
    points: Vec<[f32; 3]>,
    bbox: Option<[f32; 4]>,
}

#[derive(Clone, Copy)]
struct Geometry {
    w: usize,
    h: usize,
    rw: usize,
    rh: usize,
}

impl Geometry {
    fn new(w: usize, h: usize) -> Self {
        let scale = SIZE as f64 / w.max(h).max(1) as f64;
        Self { w, h, rw: ((w as f64 * scale).round() as usize).max(1), rh: ((h as f64 * scale).round() as usize).max(1) }
    }
    fn padded(self, x: f32, y: f32) -> [f32; 2] {
        [x.clamp(0., self.w as f32) * self.rw as f32 / self.w as f32,
         y.clamp(0., self.h as f32) * self.rh as f32 / self.h as f32]
    }
    fn mask_size(self) -> (usize, usize) {
        // H.264 4:2:0 needs even dimensions.
        (((self.rw + 4) / 8 * 2).max(2), ((self.rh + 4) / 8 * 2).max(2))
    }
}

struct Engine {
    encoder: Session,
    decoder: Session,
    recent: VecDeque<(String, [DynValue; 3])>,
}

impl Engine {
    fn new(dir: &Path) -> R<Self> {
        let env = super::matte::ort_env()?;
        let load = |file| {
            let path = dir.join(file);
            let mut builder = Session::builder(&env).map_err(err)?;
            builder.commit_from_file(&path).or_else(|_| {
                Session::builder(&env)?
                    .with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU)?
                    .commit_from_file(&path)
            }).map_err(err)
        };
        // CoreML rejects the zero-element input_boxes [1,0,4] of a points-only prompt; the decoder is tiny, CPU is fine
        let decoder = Session::builder(&env).map_err(err)?
            .with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(err)?
            .commit_from_file(dir.join(DECODER)).map_err(err)?;
        Ok(Self { encoder: load(ENCODER)?, decoder, recent: VecDeque::new() })
    }

    fn embed(&mut self, key: String, rgb: impl FnOnce() -> R<Vec<u8>>, g: Geometry) -> R<()> {
        if let Some(i) = self.recent.iter().position(|(k, _)| *k == key) {
            let cached = self.recent.remove(i).unwrap();
            self.recent.push_front(cached);
            return Ok(());
        }
        let rgb = rgb()?;
        let mut pixels = vec![0.; 3 * SIZE * SIZE];
        for y in 0..g.rh {
            for x in 0..g.rw {
                for c in 0..3 {
                    pixels[(c * SIZE + y) * SIZE + x] =
                        (rgb[(y * g.rw + x) * 3 + c] as f32 / 255. - [0.485, 0.456, 0.406][c]) /
                        [0.229, 0.224, 0.225][c];
                }
            }
        }
        let input = Tensor::from_array(([1, 3, SIZE, SIZE], pixels)).map_err(err)?;
        let mut out = self.encoder.run(ort::inputs!["pixel_values" => input]).map_err(err)?;
        let mut take = |name| out.remove(name).ok_or("SAM encoder did not return all embeddings");
        let features = [take(EMB[0])?, take(EMB[1])?, take(EMB[2])?];
        self.recent.push_front((key, features));
        self.recent.truncate(4);
        Ok(())
    }

    fn decode(&mut self, prompt: &Prompt, g: Geometry) -> R<(Vec<u8>, f32)> {
        let mut points = Vec::new();
        let mut labels = Vec::new();
        for &[x, y, label] in &prompt.points {
            points.extend(g.padded(x, y));
            labels.push(if label == 0. { 0i64 } else { 1 });
        }
        if labels.is_empty() {
            points.extend([0., 0.]);
            labels.push(-1);
        }
        let n = labels.len();
        let boxes: Vec<f32> = prompt.bbox.iter().flat_map(|&[x0, y0, x1, y1]| {
            let [a, b] = g.padded(x0, y0);
            let [c, d] = g.padded(x1, y1);
            [a, b, c, d]
        }).collect();
        let boxes = Tensor::from_array(([1, boxes.len() / 4, 4], boxes)).map_err(err)?;
        let points = Tensor::from_array(([1, 1, n, 2], points)).map_err(err)?;
        let labels = Tensor::from_array(([1, 1, n], labels)).map_err(err)?;
        let e = &self.recent.front().unwrap().1;
        let out = self.decoder.run(ort::inputs![
            "input_points" => points, "input_labels" => labels, "input_boxes" => boxes,
            EMB[0] => &e[0], EMB[1] => &e[1], EMB[2] => &e[2],
        ]).map_err(err)?;
        let get = |name: &str| out.get(name).ok_or_else(|| format!("Missing SAM output {name}"));
        let (_, scores) = get("iou_scores")?.try_extract_tensor::<f32>().map_err(err)?;
        let (_, logits) = get("pred_masks")?.try_extract_tensor::<f32>().map_err(err)?;
        let (_, object) = get("object_score_logits")?.try_extract_tensor::<f32>().map_err(err)?;
        let best = scores.iter().enumerate().filter(|(_, v)| v.is_finite())
            .max_by(|a, b| a.1.total_cmp(b.1).then_with(|| b.0.cmp(&a.0)))
            .ok_or("SAM decoder returned no masks")?.0;
        let mask = logits.get(best * GRID * GRID..(best + 1) * GRID * GRID).ok_or("Invalid SAM mask dimensions")?;
        let object_score = *object.get(best / 3).ok_or("Missing SAM object score")?;
        let (w, h) = g.mask_size();
        let mut pixels = Vec::with_capacity(w * h);
        for y in 0..h {
            let yy = (((y as f32 + 0.5) * g.rh as f32 / h as f32 / 4.) - 0.5).clamp(0., (GRID - 1) as f32);
            let y0 = yy.floor() as usize;
            let y1 = (y0 + 1).min(GRID - 1);
            for x in 0..w {
                let xx = (((x as f32 + 0.5) * g.rw as f32 / w as f32 / 4.) - 0.5).clamp(0., (GRID - 1) as f32);
                let x0 = xx.floor() as usize;
                let x1 = (x0 + 1).min(GRID - 1);
                let a = mask[y0 * GRID + x0] + (mask[y0 * GRID + x1] - mask[y0 * GRID + x0]) * xx.fract();
                let b = mask[y1 * GRID + x0] + (mask[y1 * GRID + x1] - mask[y1 * GRID + x0]) * xx.fract();
                pixels.push(if a + (b - a) * yy.fract() > 0. { 255 } else { 0 });
            }
        }
        Ok((pixels, object_score))
    }
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);
static MODEL_IO: Mutex<()> = Mutex::new(());
static NEXT_TMP: AtomicU64 = AtomicU64::new(0);
static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

fn model_dir(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models/sam2"))
}

#[tauri::command]
pub fn sam2_ready(app: AppHandle) -> R<bool> {
    let dir = model_dir(&app)?;
    Ok(FILES.iter().zip(FILE_SIZES).all(|(f, size)| has_model_file(&dir.join(f), size)))
}

fn has_model_file(path: &Path, size: u64) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() == size)
}

#[tauri::command]
pub async fn sam2_download(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _io = MODEL_IO.lock().map_err(err)?;
        let dir = model_dir(&app)?;
        let total = FILE_SIZES.iter().sum::<u64>() as f64;
        let mut completed = 0.;
        for (file, size) in FILES.into_iter().zip(FILE_SIZES) {
            let path = dir.join(file);
            if !has_model_file(&path, size) {
                super::matte::fetch_segment(&app, &format!("{URL}{file}"), &path, "sam2_dl", completed / total, size as f64 / total)?;
                if !has_model_file(&path, size) { return Err(format!("Incomplete SAM 2 model file: {file}")); }
            }
            completed += size as f64;
            let _ = app.emit("progress", serde_json::json!({ "label": "sam2_dl", "p": completed / total }));
        }
        Ok(())
    }).await.map_err(err)?
}

#[tauri::command]
pub async fn sam2_remove(app: AppHandle) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _io = MODEL_IO.lock().map_err(err)?;
        *ENGINE.lock().map_err(err)? = None;
        let dir = model_dir(&app)?;
        for file in FILES {
            super::remove_model_file(&dir.join(file))?;
        }
        Ok(())
    }).await.map_err(err)?
}

struct Source {
    path: String,
    key: String,
    g: Geometry,
    fps: f64,
    last: u64,
}

pub fn source_key(path: &str) -> R<String> {
    let meta = fs::metadata(path).map_err(err)?;
    let modified = meta.modified().map_err(err)?;
    Ok(format!("{path}|{}|{modified:?}", meta.len()))
}

impl Source {
    fn new(path: String) -> R<Self> {
        let m = probe_one(&path)?;
        let w = m["w"].as_u64().unwrap_or(0) as usize;
        let h = m["h"].as_u64().unwrap_or(0) as usize;
        if w == 0 || h == 0 { return Err("SAM 2 requires a video or image".into()); }
        let fps = m["fps"].as_f64().filter(|&n| n >= 1.).unwrap_or(30.);
        let last = if m["kind"] == "image" { 0 } else {
            ((m["dur"].as_f64().unwrap_or(0.) * fps - 0.0001).ceil() as u64).saturating_sub(1)
        };
        let key = source_key(&path)?;
        Ok(Self { path, key, g: Geometry::new(w, h), fps, last })
    }

    fn frame(&self, time: f64) -> u64 {
        ((time * self.fps + 0.0001).floor() as u64).min(self.last)
    }

    fn rgb(&self, frame: u64) -> R<Vec<u8>> {
        let t = format!("{:.8}", (frame as f64 - 0.1).max(0.) / self.fps);
        let scale = format!("scale={}:{}:flags=bilinear", self.g.rw, self.g.rh);
        let out = command(&sidecar("ffmpeg"))
            .args(["-v", "error", "-ss", &t, "-i", &self.path, "-map", "0:V:0", "-frames:v", "1",
                "-vf", &scale, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]).output().map_err(err)?;
        if out.status.success() && out.stdout.len() == self.g.rw * self.g.rh * 3 { Ok(out.stdout) }
        else { Err(format!("Could not decode source frame {frame}. {}", tail(&String::from_utf8_lossy(&out.stderr)))) }
    }
}

fn infer(app: &AppHandle, source: &Source, frame: u64, prompt: &Prompt) -> R<(Vec<u8>, f32)> {
    let mut engine = ENGINE.lock().map_err(err)?;
    if engine.is_none() { *engine = Some(Engine::new(&model_dir(app)?)?); }
    let engine = engine.as_mut().unwrap();
    engine.embed(format!("{}|{frame}", source.key), || source.rgb(frame), source.g)?;
    engine.decode(prompt, source.g)
}

#[tauri::command]
pub async fn sam2_preview(app: AppHandle, path: String, time: f64, prompt: Prompt) -> R<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = Source::new(path)?;
        let (mask, score) = infer(&app, &source, source.frame(time), &prompt)?;
        let (w, h) = source.g.mask_size();
        let mut data = Vec::with_capacity(mask.len() + 5);
        data.extend((w as u16).to_le_bytes());
        data.extend((h as u16).to_le_bytes());
        data.push(u8::from(score < 0.));
        data.extend(mask);
        Ok(tauri::ipc::Response::new(data))
    }).await.map_err(err)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRequest {
    project: String,
    path: String,
    start: f64,
    end: f64,
    seed: f64,
    prompt: Prompt,
    still: bool,
    job: String,
}

#[derive(Serialize, Deserialize)]
struct MaskInfo {
    source: String,
    source_key: String,
    fps: f64,
    first: u64,
    last: u64,
    found_first: u64,
    found_last: u64,
    w: usize,
    h: usize,
    source_w: usize,
    source_h: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    brush: Option<Brush>,
}

impl MaskInfo {
    fn lost(&self) -> bool {
        self.first < self.found_first || self.found_last < self.last
    }
}

fn cache_root(app: &AppHandle) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("object-mattes"))
}

fn cache_dir(app: &AppHandle, key: &str) -> R<PathBuf> {
    let valid = |s: &str| s.len() == 16 && s.bytes().all(|v| v.is_ascii_hexdigit());
    let (project, hash) = key.split_once('/').ok_or("Invalid object matte key")?;
    if !valid(project) || !valid(hash) { return Err("Invalid object matte key".into()); }
    Ok(cache_root(app)?.join(project).join(hash))
}

fn info(dir: &Path) -> R<MaskInfo> {
    let i: MaskInfo = serde_json::from_slice(&fs::read(dir.join("frames.json")).map_err(err)?).map_err(err)?;
    let grid = if i.brush.is_some() { BRUSH_GRID } else { GRID };
    if i.fps <= 0. || i.first > i.found_first || i.found_first > i.found_last || i.found_last > i.last ||
        !(1..=grid).contains(&i.w) || !(1..=grid).contains(&i.h) || i.source_w == 0 || i.source_h == 0 {
        return Err("Invalid object matte metadata".into());
    }
    Ok(i)
}

#[derive(Deserialize, Serialize)]
struct Stroke {
    size: f64,
    erase: bool,
    points: Vec<[f64; 2]>,
}

#[derive(Deserialize, Serialize)]
pub struct Brush {
    seed: f64,
    strokes: Vec<Stroke>,
    #[serde(default)]
    motion: Vec<[f64; 3]>,
}

fn motion_at(points: &[[f64; 3]], time: f64) -> [f64; 2] {
    let n = points.partition_point(|p| p[0] <= time);
    if points.is_empty() { return [0., 0.]; }
    let [start, x, y] = points[n.saturating_sub(1)];
    let [end, nx, ny] = points[n.min(points.len() - 1)];
    let f = if end > start { ((time - start) / (end - start)).clamp(0., 1.) } else { 0. };
    [x + (nx - x) * f, y + (ny - y) * f]
}

fn brush_mask(i: &MaskInfo, brush: &Brush, time: f64) -> Vec<u8> {
    let mut mask = vec![0; i.w * i.h];
    let [sx, sy] = motion_at(&brush.motion, brush.seed);
    let [tx, ty] = motion_at(&brush.motion, time);
    let (dx, dy) = ((tx - sx) * i.source_w as f64, (ty - sy) * i.source_h as f64);
    let (kx, ky) = (i.w as f64 / i.source_w as f64, i.h as f64 / i.source_h as f64);
    for stroke in &brush.strokes {
        let r = stroke.size / 2.;
        for (j, &[x, y]) in stroke.points.iter().enumerate() {
            let [px, py] = stroke.points[j.saturating_sub(1)];
            let (ax, ay, bx, by) = (px + dx, py + dy, x + dx, y + dy);
            let (vx, vy) = (bx - ax, by - ay);
            let len2 = (vx * vx + vy * vy).max(f64::EPSILON);
            let x0 = ((ax.min(bx) - r) * kx).floor() as usize;
            let x1 = (((ax.max(bx) + r) * kx).ceil() as usize).min(i.w);
            let y0 = ((ay.min(by) - r) * ky).floor() as usize;
            let y1 = (((ay.max(by) + r) * ky).ceil() as usize).min(i.h);
            for yy in y0..y1 {
                for xx in x0..x1 {
                    let x = (xx as f64 + 0.5) / kx - ax;
                    let y = (yy as f64 + 0.5) / ky - ay;
                    let f = ((x * vx + y * vy) / len2).clamp(0., 1.);
                    if (x - f * vx).powi(2) + (y - f * vy).powi(2) <= r * r {
                        mask[yy * i.w + xx] = if stroke.erase { 0 } else { 255 };
                    }
                }
            }
        }
    }
    mask
}

// H.264 4:2:0 needs even dimensions; the matte encoder takes the mask size as is.
fn even(n: usize) -> usize { (n.max(1) + 1) & !1 }

#[tauri::command]
pub async fn object_brush(app: AppHandle, project: String, path: String, mut brush: Brush) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = Source::new(path)?;
        let g = source.g;
        brush.motion.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut hash = DefaultHasher::new();
        ("brush-v2", &source.key, serde_json::to_string(&brush).map_err(err)?).hash(&mut hash);
        let key = format!("{project}/{:016x}", hash.finish());
        let dir = cache_dir(&app, &key)?;
        if info(&dir).is_ok() { return Ok(key); }
        let scale = (BRUSH_GRID as f64 / g.w.max(g.h) as f64).min(1.);
        let grid = |n| even((n as f64 * scale).round() as usize);
        let last = if brush.motion.is_empty() { 0 } else { source.last };
        let i = MaskInfo { source: source.path, source_key: source.key, fps: source.fps, first: 0, last,
            found_first: 0, found_last: last, w: grid(g.w), h: grid(g.h), source_w: g.w, source_h: g.h, brush: Some(brush) };
        let mask = brush_mask(&i, i.brush.as_ref().unwrap(), i.brush.as_ref().unwrap().seed);
        if mask.iter().all(|&a| a == 0) { return Err("The brush mask is empty".into()); }
        let tmp = dir.with_extension(format!("{}-{}.part", std::process::id(), tmp_id()));
        fs::create_dir_all(&tmp).map_err(err)?;
        let result = (|| {
            fs::write(tmp.join("frames.json"), serde_json::to_vec(&i).map_err(err)?).map_err(err)?;
            fs::rename(&tmp, &dir).or_else(|e| if info(&dir).is_ok() { Ok(()) } else { Err(e) }).map_err(err)
        })();
        let _ = fs::remove_dir_all(tmp);
        result?;
        Ok(key)
    }).await.map_err(err)?
}

fn write_mask(dir: &Path, frame: u64, mask: &[u8]) -> R<()> {
    let mut rle = Vec::new();
    for run in mask.chunk_by(|a, b| a == b) {
        rle.extend((run.len() as u32).to_le_bytes());
        rle.push(run[0]);
    }
    fs::write(dir.join(format!("{frame}.rle")), rle).map_err(err)
}

fn read_mask(dir: &Path, i: &MaskInfo, frame: u64) -> R<Vec<u8>> {
    let frame = frame.clamp(i.found_first, i.found_last);
    if let Some(brush) = &i.brush {
        return Ok(brush_mask(i, brush, frame as f64 / i.fps));
    }
    let rle = fs::read(dir.join(format!("{frame}.rle"))).map_err(err)?;
    let size = i.w * i.h;
    let mut data = Vec::with_capacity(size);
    for run in rle.chunks_exact(5) {
        let end = data.len() + u32::from_le_bytes(run[..4].try_into().unwrap()) as usize;
        if end > size || end == data.len() { return Err("Invalid object matte RLE".into()); }
        data.resize(end, run[4]);
    }
    if rle.len() % 5 != 0 || data.len() != size { return Err("Invalid object matte RLE".into()); }
    Ok(data)
}

/// Raw source-aligned mask for an inpainting caller, at a time in source seconds.
pub fn mask_for_frame(app: &AppHandle, key: &str, time: f64) -> R<(usize, usize, Vec<u8>)> {
    let dir = cache_dir(app, key)?;
    let i = info(&dir)?;
    raw_mask(&dir, &i, time)
}

fn raw_mask(dir: &Path, i: &MaskInfo, time: f64) -> R<(usize, usize, Vec<u8>)> {
    let data = match &i.brush {
        Some(brush) => brush_mask(i, brush, time),
        None => read_mask(dir, i, (time * i.fps + 0.0001).floor() as u64)?,
    };
    Ok((i.w, i.h, data))
}

#[tauri::command]
pub async fn sam2_mask_for_frame(app: AppHandle, key: String, source: Option<String>, time: f64) -> R<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let (w, h, mask) = if let Some(source) = source {
            let reader = MaskReader::open(&app, &key, &source)?;
            raw_mask(&reader.dir, &reader.info, time)?
        } else {
            mask_for_frame(&app, &key, time)?
        };
        let mut data = Vec::with_capacity(4 + mask.len());
        data.extend((w as u16).to_le_bytes());
        data.extend((h as u16).to_le_bytes());
        data.extend(mask);
        Ok(tauri::ipc::Response::new(data))
    }).await.map_err(err)?
}

fn mask_geometry(mask: &[u8], (w, h): (usize, usize), g: Geometry) -> Option<([f32; 4], [f32; 2])> {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    let (mut sx, mut sy, mut n) = (0, 0, 0);
    for (i, _) in mask.iter().enumerate().filter(|(_, v)| **v >= 128) {
        let (x, y) = (i % w, i / w);
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
        (sx, sy, n) = (sx + x, sy + y, n + 1);
    }
    if n == 0 { return None; }
    let (a, b) = (g.w as f32 / w as f32, g.h as f32 / h as f32);
    Some(([x0 as f32 * a, y0 as f32 * b, x1 as f32 * a, y1 as f32 * b],
          [(sx as f32 / n as f32 + 0.5) * a, (sy as f32 / n as f32 + 0.5) * b]))
}

fn tracking_prompt(points: &[[f32; 3]], bbox: [f32; 4], centroid: [f32; 2]) -> Prompt {
    let dx = (bbox[2] - bbox[0]) * 0.05;
    let dy = (bbox[3] - bbox[1]) * 0.05;
    let mut points = points.to_vec();
    points.push([centroid[0], centroid[1], 1.]);
    Prompt { bbox: Some([bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy]), points }
}

fn center(b: [f32; 4]) -> [f32; 2] {
    [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5]
}

fn tmp_id() -> u64 { NEXT_TMP.fetch_add(1, Ordering::Relaxed) }

fn track(app: &AppHandle, request: TrackRequest, cancel: &AtomicBool) -> R<serde_json::Value> {
    let TrackRequest { project, path, start, end, seed, prompt, still, job } = request;
    let source = Source::new(path)?;
    let g = source.g;
    let mut first = source.frame(start);
    let mut last = ((end * source.fps - 0.0001).ceil() as u64).saturating_sub(1).min(source.last).max(first);
    let seed_frame = source.frame(seed).clamp(first, last);
    if still { first = seed_frame; last = seed_frame; }
    let mut hasher = DefaultHasher::new();
    ("sam2-v3", &source.key, start.to_bits(), end.to_bits(), seed_frame, still, serde_json::to_string(&prompt).map_err(err)?).hash(&mut hasher);
    let key = format!("{project}/{:016x}", hasher.finish());
    let dir = cache_dir(app, &key)?;
    if let Ok(i) = info(&dir) { return Ok(serde_json::json!({ "key": key, "lost": i.lost() })); }
    let tmp = dir.with_extension(format!("{}-{}.part", std::process::id(), tmp_id()));
    fs::create_dir_all(&tmp).map_err(err)?;
    let res = (|| {
        let (mask, score) = infer(app, &source, seed_frame, &prompt)?;
        if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
        let size = g.mask_size();
        let Some(seed_geometry) = mask_geometry(&mask, size, g).filter(|_| score >= 0.) else {
            return Err("No object found at the selected frame".into());
        };
        write_mask(&tmp, seed_frame, &mask)?;
        let (mut found_first, mut found_last) = (seed_frame, seed_frame);
        let total = last - first + 1;
        let mut done = 1;
        let progress = |done| { let _ = app.emit("sam2prog", serde_json::json!({ "job": job, "p": done as f64 / total as f64 })); };
        progress(done);
        for forward in [true, false] {
            let (mut bbox, mut centroid) = seed_geometry;
            let mut points: Vec<_> = prompt.points.iter().copied().filter(|p| p[2] == 1.).collect();
            let steps = if forward { last - seed_frame } else { seed_frame - first };
            for step in 1..=steps {
                if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
                let frame = if forward { seed_frame + step } else { seed_frame - step };
                let next = tracking_prompt(&points, bbox, centroid);
                let (mask, score) = infer(app, &source, frame, &next)?;
                let Some((b, c)) = mask_geometry(&mask, size, g).filter(|_| score >= 0.) else {
                    done += steps - step + 1;
                    progress(done);
                    break;
                };
                let (a, z) = (center(bbox), center(b));
                for point in &mut points {
                    point[0] = (point[0] + z[0] - a[0]).clamp(0., g.w as f32);
                    point[1] = (point[1] + z[1] - a[1]).clamp(0., g.h as f32);
                }
                (bbox, centroid) = (b, c);
                write_mask(&tmp, frame, &mask)?;
                if forward { found_last = frame; } else { found_first = frame; }
                done += 1;
                progress(done);
            }
        }
        if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
        let i = MaskInfo { source: source.path.clone(), source_key: source.key, fps: source.fps, first, last, found_first, found_last, w: size.0, h: size.1, source_w: g.w, source_h: g.h, brush: None };
        fs::write(tmp.join("frames.json"), serde_json::to_vec(&i).map_err(err)?).map_err(err)?;
        if let Err(e) = fs::rename(&tmp, &dir) {
            if info(&dir).is_err() { return Err(err(e)); }
        }
        Ok(serde_json::json!({ "key": key, "lost": i.lost() }))
    })();
    let _ = fs::remove_dir_all(&tmp);
    res
}

#[tauri::command]
pub async fn sam2_track(app: AppHandle, request: TrackRequest) -> R<serde_json::Value> {
    let job = request.job.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS.lock().map_err(err)?;
        if jobs.contains_key(&job) { return Err("Object tracking is already running".into()); }
        jobs.insert(job.clone(), cancel.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let res = track(&app, request, &cancel);
        JOBS.lock().map_err(err)?.remove(&job);
        res
    }).await.map_err(err)?
}

#[tauri::command]
pub fn sam2_cancel(job: String) {
    if let Some(cancel) = JOBS.lock().unwrap().get(&job) {
        cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Deserialize, Hash)]
pub struct Edges {
    #[serde(default)]
    invert: bool,
    #[serde(default)]
    feather: u32,
    #[serde(default)]
    expand: i32,
}

#[derive(Serialize)]
pub struct Matte {
    path: String,
    origin: f64,
    last: f64,
    fps: f64,
    w: usize,
    h: usize,
    lost: bool,
}

// One board-sized mask pass per axis. A monotonic queue keeps the pass cost independent of radius.
fn edge_pass(data: &[u8], line: usize, lines: usize, stride: usize, step: usize, radius: usize, morph: i32) -> Vec<u8> {
    let mut out = vec![0; data.len()];
    for y in 0..lines {
        let at = |x| y * step + x * stride;
        let mut queue: VecDeque<usize> = VecDeque::new();
        let (mut left, mut right, mut sum) = (0, 0, 0u32);
        for x in 0..line {
            let lo = x.saturating_sub(radius);
            let hi = (x + radius + 1).min(line);
            while right < hi {
                let v = data[at(right)];
                if morph == 0 { sum += v as u32; }
                else {
                    while queue.back().is_some_and(|&i| if morph > 0 { data[at(i)] <= v } else { data[at(i)] >= v }) { queue.pop_back(); }
                    queue.push_back(right);
                }
                right += 1;
            }
            if morph == 0 {
                while left < lo { sum -= data[at(left)] as u32; left += 1; }
                out[at(x)] = ((sum + (hi - lo) as u32 / 2) / (hi - lo) as u32) as u8;
            } else {
                while queue.front().is_some_and(|&i| i < lo) { queue.pop_front(); }
                out[at(x)] = data[at(queue[0])];
            }
        }
    }
    out
}

fn radius_pass(data: Vec<u8>, line: usize, lines: usize, stride: usize, step: usize, radius: f64, morph: i32) -> Vec<u8> {
    let radius = radius.min(line.saturating_sub(1) as f64);
    if radius <= 0. { return data; }
    let base = radius.floor() as usize;
    let mix = radius.fract() as f32;
    let low = if base == 0 { data.clone() } else { edge_pass(&data, line, lines, stride, step, base, morph) };
    if mix == 0. { return low; }
    let high = edge_pass(&data, line, lines, stride, step, base + 1, morph);
    low.into_iter().zip(high).map(|(a, b)| (a as f32 + (b as f32 - a as f32) * mix).round() as u8).collect()
}

fn apply_edges(mut mask: Vec<u8>, i: &MaskInfo, e: &Edges) -> Vec<u8> {
    if e.invert { mask.iter_mut().for_each(|v| *v = 255 - *v); }
    for (px, morph) in [(e.expand.unsigned_abs(), e.expand.signum()), (e.feather, 0)] {
        let x = px as f64 * i.w as f64 / i.source_w as f64;
        let y = px as f64 * i.h as f64 / i.source_h as f64;
        mask = radius_pass(mask, i.w, i.h, 1, i.w, x, morph);
        mask = radius_pass(mask, i.h, i.w, i.w, 1, y, morph);
    }
    mask
}

pub struct MaskReader {
    dir: PathBuf,
    info: MaskInfo,
}

impl MaskReader {
    pub fn open(app: &AppHandle, key: &str, source: &str) -> R<Self> {
        let dir = cache_dir(app, key)?;
        let info = info(&dir)?;
        if info.source != source || info.source_key != source_key(source)? {
            return Err("Object mask belongs to a different source version".into());
        }
        Ok(Self { dir, info })
    }

    pub fn is_static(&self) -> bool { self.info.found_first == self.info.found_last }

    pub fn frame(&self, time: f64, edges: &Edges) -> R<(usize, usize, Vec<u8>)> {
        let i = &self.info;
        let (w, h, mask) = raw_mask(&self.dir, i, time)?;
        let edges = Edges { invert: edges.invert, feather: edges.feather.min(128), expand: edges.expand.clamp(-128, 128) };
        Ok((w, h, apply_edges(mask, i, &edges)))
    }
}

fn encode_matte(bin: &Path, dir: &Path, i: &MaskInfo, edges: &Edges, out: &Path) -> R<()> {
    let tmp = out.with_extension(format!("{}-{}.part.mp4", std::process::id(), tmp_id()));
    let mut enc = command(bin).args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", &format!("{}x{}", i.w, i.h),
        "-framerate", &format!("{:.8}", i.fps), "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", "12",
        "-g", "12", "-pix_fmt", "yuv420p", "-vf", "scale=in_range=full:out_range=limited", "-color_range", "tv"])
        .arg(&tmp).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(err)?;
    let mut stdin = enc.stdin.take().unwrap();
    let res = (|| -> R<()> {
        let mut previous = None;
        let mut data = Vec::new();
        for frame in i.first..=i.last {
            let nearest = frame.clamp(i.found_first, i.found_last);
            if previous != Some(nearest) {
                data = apply_edges(read_mask(dir, i, nearest)?, i, edges);
                previous = Some(nearest);
            }
            stdin.write_all(&data).map_err(err)?;
        }
        Ok(())
    })();
    drop(stdin);
    let result = enc.wait_with_output().map_err(err).and_then(|result| {
        if !result.status.success() { return Err(tail(&String::from_utf8_lossy(&result.stderr))); }
        res?;
        fs::rename(&tmp, out).or_else(|e| if out.is_file() { Ok(()) } else { Err(e) }).map_err(err)
    });
    let _ = fs::remove_file(&tmp);
    result
}

#[tauri::command]
pub async fn sam2_matte(app: AppHandle, key: String, source: String, edges: Edges) -> R<Matte> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = cache_dir(&app, &key)?;
        let i = info(&dir)?;
        if i.source != source || i.source_key != source_key(&source)? {
            return Err("Object matte belongs to a different source version".into());
        }
        let edges = Edges { invert: edges.invert, feather: edges.feather.min(128), expand: edges.expand.clamp(-128, 128) };
        let path = dir.join(format!("mask-{}-{}-{}.mp4", u8::from(edges.invert), edges.feather, edges.expand));
        if !path.is_file() { encode_matte(&sidecar("ffmpeg"), &dir, &i, &edges, &path)?; }
        let path = path.to_string_lossy().into_owned();
        app.state::<Arc<MediaServer>>().allow(&path);
        Ok(Matte { path, origin: i.first as f64 / i.fps, last: i.last as f64 / i.fps, fps: i.fps, w: i.w, h: i.h, lost: i.lost() })
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn even_rounds_up_and_never_zero() {
        assert_eq!([0, 1, 2, 3, 255, 256].map(even), [2, 2, 2, 4, 256, 256]);
    }

    const G: Geometry = Geometry { w: SIZE, h: SIZE, rw: SIZE, rh: SIZE };
    fn square_contains(x: usize, y: usize, offset: usize) -> bool {
        (256 + offset..768 + offset).contains(&x) && (256..768).contains(&y)
    }
    fn square_rgb(offset: usize) -> Vec<u8> {
        let mut rgb = Vec::with_capacity(SIZE * SIZE * 3);
        for y in 0..SIZE {
            for x in 0..SIZE {
                rgb.extend(if square_contains(x, y, offset) { [231, 42, 29] } else { [37, 67, 116] });
            }
        }
        rgb
    }
    fn square_iou(mask: &[u8], offset: usize) -> f64 {
        let (mut intersection, mut union) = (0, 0);
        for (i, &v) in mask.iter().enumerate() {
            let expected = square_contains(i % GRID * 4 + 2, i / GRID * 4 + 2, offset);
            intersection += usize::from(expected && v != 0);
            union += usize::from(expected || v != 0);
        }
        intersection as f64 / union as f64
    }

    #[test]
    fn sam2_square_smoke() -> R<()> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.models/sam2");
        if !FILES.iter().all(|file| dir.join(file).is_file()) {
            eprintln!("SKIP SAM 2 smoke: .models/sam2 is missing");
            return Ok(());
        }
        let wide = Geometry::new(1280, 720);
        assert_eq!(wide.padded(360., 180.), [288., 144.]);
        assert_eq!(wide.mask_size(), (256, 144));
        let mut engine = Engine::new(&dir)?;
        engine.embed("square".into(), || Ok(square_rgb(0)), G)?;
        let prompt = Prompt { points: vec![[512., 512., 1.]], bbox: None };
        let (mask, score) = engine.decode(&prompt, G)?;
        let iou = square_iou(&mask, 0);
        eprintln!("SAM 2 square IoU: {iou:.4}, object score: {score:.2}");
        assert!(iou > 0.8 && score >= 0.);

        engine.embed("square".into(), || panic!("A refinement must reuse the embedding"), G)?;
        let bbox = Some([248., 248., 776., 776.]);
        let (box_mask, _) = engine.decode(&Prompt { points: vec![], bbox }, G)?;
        assert!(square_iou(&box_mask, 0) > 0.8);

        let (bbox, centroid) = mask_geometry(&mask, G.mask_size(), G).unwrap();
        let tracking = tracking_prompt(&prompt.points, bbox, centroid);
        engine.embed("moving square".into(), || Ok(square_rgb(36)), G)?;
        let (next, score) = engine.decode(&tracking, G)?;
        let iou = square_iou(&next, 36);
        eprintln!("SAM 2 moving square IoU: {iou:.4}, object score: {score:.2}");
        assert!(iou > 0.8 && score >= 0.);
        Ok(())
    }

    #[test]
    fn brush_erases_and_follows_motion() {
        let i = MaskInfo { source: String::new(), source_key: String::new(), fps: 24., first: 0, last: 24,
            found_first: 0, found_last: 24, w: 32, h: 32, source_w: 32, source_h: 32, brush: None };
        let brush = Brush { seed: 0., motion: vec![[0., 0., 0.], [1., 0.25, 0.125]], strokes: vec![
            Stroke { size: 6., erase: false, points: vec![[4.5, 4.5], [10.5, 4.5]] },
            Stroke { size: 2., erase: true, points: vec![[6.5, 4.5]] },
        ] };
        let initial = brush_mask(&i, &brush, 0.);
        let shifted = brush_mask(&i, &brush, 0.5);
        let index = |x: usize, y: usize| y * 32 + x;
        assert_eq!(initial[index(6, 4)], 0);
        assert_eq!(initial[index(7, 3)], 255);
        assert_eq!(shifted[index(10, 6)], 0);
        assert_eq!(shifted[index(11, 5)], 255);
        assert_eq!(shifted[index(4, 4)], 0);
    }

    #[test]
    fn matte_edges_and_held_frames() -> R<()> {
        let dir = std::env::temp_dir().join(format!("maqto-sam2-test-{}-{}", std::process::id(), tmp_id()));
        fs::create_dir(&dir).map_err(err)?;
        let result = (|| {
            let i = MaskInfo { source: String::new(), source_key: String::new(), fps: 24., first: 0, last: 3,
                found_first: 1, found_last: 2, w: 5, h: 2, source_w: 10, source_h: 4, brush: None };
            let left = vec![0, 255, 255, 0, 0, 0, 255, 255, 0, 0];
            let right = vec![0, 0, 0, 255, 255, 0, 0, 0, 255, 255];
            write_mask(&dir, 1, &left)?;
            write_mask(&dir, 2, &right)?;
            assert_eq!(read_mask(&dir, &i, 0)?, left);
            assert_eq!(read_mask(&dir, &i, 3)?, right);
            let expanded = apply_edges(left.clone(), &i, &Edges { invert: false, feather: 0, expand: 1 });
            assert_eq!(&expanded[..5], &[128, 255, 255, 128, 0]);
            let inverted = apply_edges(left, &i, &Edges { invert: true, feather: 0, expand: -2 });
            assert_eq!(&inverted[..5], &[0, 0, 0, 0, 255]);
            Ok(())
        })();
        let _ = fs::remove_dir_all(&dir);
        result
    }
}
