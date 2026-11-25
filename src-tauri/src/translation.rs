use super::{err, matte, R};
use ort::{
    session::{builder::AutoDevicePolicy, RunOptions, Session},
    value::{DynValue, Tensor},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

const BATCH_SIZE: usize = 16;
const LIMIT: usize = 512;
const ENCODER: &str = "encoder_model_quantized.onnx";
const DECODER: &str = "decoder_model_merged_quantized.onnx";
const FILES: [(&str, &str, f64); 4] = [
    ("tokenizer.json", "tokenizer.json", 0.06),
    ("config.json", "config.json", 0.001),
    (ENCODER, "onnx/encoder_model_quantized.onnx", 0.44),
    (DECODER, "onnx/decoder_model_merged_quantized.onnx", 0.499),
];

#[derive(Clone, Copy, Deserialize)]
pub enum Direction {
    #[serde(rename = "ar-en")]
    ArabicToEnglish,
    #[serde(rename = "en-ar")]
    EnglishToArabic,
}

impl Direction {
    fn code(self) -> &'static str {
        match self {
            Self::ArabicToEnglish => "ar-en",
            Self::EnglishToArabic => "en-ar",
        }
    }

    fn pad(self) -> usize {
        match self {
            Self::ArabicToEnglish => 62833,
            Self::EnglishToArabic => 62801,
        }
    }
}

#[derive(Deserialize)]
struct ModelConfig {
    decoder_start_token_id: usize,
    pad_token_id: usize,
    eos_token_id: usize,
    vocab_size: usize,
}

#[derive(Deserialize)]
struct TokenizerFile {
    model: Unigram,
}

#[derive(Deserialize)]
struct Unigram {
    vocab: Vec<(String, f64)>,
}

struct Tokenizer {
    vocab: Vec<(String, f64)>,
    unk: usize,
    unknown_score: f64,
    longest: usize,
}

impl Tokenizer {
    fn load(path: &Path, pad: usize) -> R<Self> {
        let TokenizerFile { model: Unigram { vocab } } =
            serde_json::from_reader(fs::File::open(path).map_err(err)?).map_err(err)?;
        // The Marian vocabulary assigns <unk> to 1. The Xenova Unigram metadata points at ".".
        let unk = vocab.iter().position(|(piece, _)| piece == "<unk>");
        if vocab.len() != pad + 1 || vocab[0].0 != "</s>" || vocab[pad].0 != "<pad>" {
            return Err("Invalid translation vocabulary".into());
        }
        let unk = unk.ok_or("Translation vocabulary has no unknown token")?;
        let unknown_score = vocab.iter().map(|(_, score)| *score).fold(0., f64::min) - 10.;
        let longest = vocab.iter().map(|(piece, _)| piece.len()).max().unwrap_or(0);
        Ok(Self { vocab, unk, unknown_score, longest })
    }

    fn encode(&self, text: &str, pieces: &HashMap<&str, (usize, f64)>, language: Option<usize>) -> R<Vec<i64>> {
        let mut ids: Vec<_> = language.filter(|_| !text.trim().is_empty()).into_iter().map(|id| id as i64).collect();
        for word in text.split_whitespace() {
            let word = format!("▁{word}");
            let mut best = vec![(f64::NEG_INFINITY, 0, self.unk); word.len() + 1];
            best[0].0 = 0.;
            for (start, ch) in word.char_indices() {
                let first = start + ch.len_utf8();
                let prefix_score = best[start].0;
                let mut consider = |end: usize, id, score| {
                    if prefix_score + score > best[end].0 {
                        best[end] = (prefix_score + score, start, id);
                    }
                };
                if !pieces.contains_key(&word[start..first]) {
                    consider(first, self.unk, self.unknown_score);
                }
                for end in first..=word.len().min(start + self.longest) {
                    if let Some(&(id, score)) = word.get(start..end).and_then(|piece| pieces.get(piece)) {
                        consider(end, id, score);
                    }
                }
            }
            let mut end = word.len();
            let mut reversed = Vec::new();
            while end > 0 {
                let (_, start, id) = best[end];
                if id != self.unk || reversed.last() != Some(&id) {
                    reversed.push(id);
                }
                end = start;
            }
            ids.extend(reversed.into_iter().rev().map(|id| id as i64));
            if ids.len() >= LIMIT {
                return Err("translation_line_too_long".into());
            }
        }
        ids.push(0);
        Ok(ids)
    }

    fn decode(&self, ids: &[usize]) -> String {
        ids.iter()
            .filter(|&&id| id != self.unk)
            .map(|&id| self.vocab[id].0.as_str())
            .collect::<String>()
            .replace('▁', " ")
            .trim()
            .to_owned()
    }
}

fn session(path: &Path) -> R<Session> {
    Session::builder(&matte::ort_env()?).map_err(err)?
        .with_auto_device(AutoDevicePolicy::PreferCPU).map_err(err)?
        .commit_from_file(path).map_err(err)
}

fn decode_batch(
    encoder: &mut Session,
    decoder: &mut Session,
    lines: &[Vec<i64>],
    pad: usize,
    options: &RunOptions,
) -> R<Vec<Vec<usize>>> {
    let batch = lines.len();
    let width = lines.iter().map(Vec::len).max().unwrap_or(0);
    let mut ids = vec![pad as i64; batch * width];
    let mut mask = vec![0i64; batch * width];
    for (i, line) in lines.iter().enumerate() {
        let range = i * width..i * width + line.len();
        ids[range.clone()].copy_from_slice(line);
        mask[range].fill(1);
    }
    let mask = Tensor::from_array(([batch, width], mask)).map_err(err)?;
    let ids = Tensor::from_array(([batch, width], ids)).map_err(err)?;
    let hidden = encoder.run_with_options(ort::inputs!["input_ids" => ids, "attention_mask" => &mask], options)
        .map_err(err)?.remove("last_hidden_state").ok_or("Missing translation encoder output")?;

    let names: Vec<_> = (0..6).flat_map(|layer| {
        ["decoder.key", "decoder.value", "encoder.key", "encoder.value"].map(|kind| {
            (format!("past_key_values.{layer}.{kind}"), format!("present.{layer}.{kind}"))
        })
    }).collect();
    let mut cache: Vec<DynValue> = names.iter().map(|_| {
        Tensor::from_array(([batch, 8, 0, 64], Vec::<f32>::new())).map(|tensor| tensor.into_dyn()).map_err(err)
    }).collect::<R<_>>()?;
    let limits: Vec<_> = lines.iter().map(|line| LIMIT.min(3 * line.len())).collect();
    let mut next = vec![pad as i64; batch];
    let mut tokens = vec![Vec::new(); batch];
    let mut done = vec![false; batch];
    for step in 0..LIMIT {
        let input = Tensor::from_array(([batch, 1], next.clone())).map_err(err)?;
        let branch = Tensor::from_array(([1], vec![step > 0])).map_err(err)?;
        let mut inputs = ort::inputs![
            "encoder_attention_mask" => &mask, "input_ids" => input,
            "encoder_hidden_states" => &hidden, "use_cache_branch" => branch
        ];
        inputs.extend(names.iter().zip(&cache).map(|((name, _), value)| (name.as_str().into(), value.into())));
        let mut output = decoder.run_with_options(inputs, options).map_err(err)?;
        let (shape, logits) = output.get("logits").ok_or("Missing translation logits")?.try_extract_tensor::<f32>().map_err(err)?;
        if **shape != [batch as i64, 1, (pad + 1) as i64] {
            return Err(format!("Unexpected translation logits shape {shape:?}"));
        }
        for (row, logits) in logits.chunks_exact(pad + 1).enumerate() {
            if done[row] { continue; }
            if lines[row].len() == 1 {
                done[row] = true;
                next[row] = 0;
                continue;
            }
            // Pad is the last vocabulary entry and is valid only as the decoder start token.
            let mut best = 0;
            for id in 1..pad {
                if logits[id] > logits[best] { best = id; }
            }
            if best != 0 { tokens[row].push(best); }
            next[row] = best as i64;
            done[row] = best == 0 || step + 1 >= limits[row];
        }
        if done.iter().all(|&finished| finished) { break; }
        // The cached branch emits empty encoder presents. Retain cross-attention from step zero.
        for (i, (_, name)) in names.iter().enumerate() {
            if step == 0 || i % 4 < 2 {
                cache[i] = output.remove(name).ok_or_else(|| format!("Missing translation cache {name}"))?;
            }
        }
    }
    Ok(tokens)
}

fn batches<T>(lines: &[T]) -> impl Iterator<Item = &[T]> {
    lines.chunks(BATCH_SIZE)
}

fn translate(
    root: &Path, direction: Direction, lines: &[String], options: &RunOptions, progress: impl Fn(usize),
) -> R<Vec<String>> {
    let pad = direction.pad();
    let config: ModelConfig = serde_json::from_reader(fs::File::open(root.join("config.json")).map_err(err)?).map_err(err)?;
    if config.decoder_start_token_id != pad || config.pad_token_id != pad || config.eos_token_id != 0 || config.vocab_size != pad + 1 {
        return Err("Invalid opus-mt model configuration".into());
    }
    let tokenizer = Tokenizer::load(&root.join("tokenizer.json"), pad)?;
    let pieces: HashMap<_, _> = tokenizer.vocab.iter().enumerate()
        .filter(|(id, _)| ![0, tokenizer.unk, pad].contains(id))
        .map(|(id, (piece, score))| (piece.as_str(), (id, *score)))
        .collect();
    // The multilingual Arabic target model uses a sentence-initial tag for standard Arabic.
    let language = match direction {
        Direction::EnglishToArabic => Some(pieces.get(">>ara<<").ok_or("Missing Arabic target token")?.0),
        Direction::ArabicToEnglish => None,
    };
    let mut encoder = session(&model_file(root, ENCODER))?;
    let mut decoder = session(&model_file(root, DECODER))?;
    let mut translations = Vec::with_capacity(lines.len());
    for batch in batches(lines) {
        let ids = batch.iter().map(|line| tokenizer.encode(line, &pieces, language)).collect::<R<Vec<_>>>()?;
        translations.extend(decode_batch(&mut encoder, &mut decoder, &ids, pad, options)?
            .iter().map(|ids| tokenizer.decode(ids)));
        progress(translations.len());
    }
    Ok(translations)
}

static TRANSFER: Mutex<()> = Mutex::new(());
static ACTIVE: Mutex<Option<(String, Arc<RunOptions>)>> = Mutex::new(None);

fn model_file(root: &Path, name: &str) -> PathBuf {
    let flat = root.join(name);
    if name.ends_with(".onnx") && !flat.is_file() {
        root.join("onnx").join(name)
    } else {
        flat
    }
}

fn root(app: &AppHandle, direction: Direction) -> R<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join("models").join(format!("opus-{}", direction.code())))
}

#[tauri::command]
pub fn translation_ready(app: AppHandle, direction: Direction) -> R<bool> {
    let root = root(&app, direction)?;
    Ok(FILES.iter().all(|(file, _, _)| root.join(file).is_file()))
}

#[tauri::command]
pub async fn translation_download(app: AppHandle, direction: Direction) -> R<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _transfer = TRANSFER.try_lock().map_err(|_| "Translation model transfer in progress")?;
        let root = root(&app, direction)?;
        let mut p = 0.;
        for (file, remote, span) in FILES {
            let path = root.join(file);
            if !path.is_file() {
                let url = format!("https://huggingface.co/Xenova/opus-mt-{}/resolve/main/{remote}", direction.code());
                matte::fetch_segment(&app, &url, &path, "translation_dl", p, span)?;
            }
            p += span;
        }
        Ok(())
    }).await.map_err(err)?
}

#[tauri::command]
pub fn translation_remove(app: AppHandle, direction: Direction) -> R<()> {
    let _transfer = TRANSFER.try_lock().map_err(|_| "Translation model transfer in progress")?;
    if ACTIVE.lock().map_err(err)?.is_some() {
        return Err("Translation model is in use".into());
    }
    let root = root(&app, direction)?;
    for (file, _, _) in FILES {
        let path = root.join(file);
        super::remove_model_file(&path)?;
        super::remove_model_file(&path.with_extension("part"))?;
    }
    Ok(())
}

// set by translation_cancel so a terminated run reports "cancelled" instead of an ORT error
static CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct ActiveJob;

impl Drop for ActiveJob {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap() = None;
    }
}

#[tauri::command]
pub fn translation_cancel(job: String) {
    if let Some((_, options)) = ACTIVE.lock().unwrap().as_ref().filter(|(id, _)| id == &job) {
        CANCELLED.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = options.terminate();
    }
}

#[tauri::command]
pub async fn translation_run(app: AppHandle, job: String, direction: Direction, lines: Vec<String>) -> R<Vec<String>> {
    if lines.is_empty() { return Ok(Vec::new()); }
    let _env = matte::ort_env()?;
    let options = Arc::new(RunOptions::new().map_err(err)?);
    {
        let _transfer = TRANSFER.try_lock().map_err(|_| "Translation model transfer in progress")?;
        let mut active = ACTIVE.lock().map_err(err)?;
        if active.is_some() { return Err("A translation job is already running".into()); }
        if !translation_ready(app.clone(), direction)? { return Err("Translation model is missing".into()); }
        CANCELLED.store(false, std::sync::atomic::Ordering::Relaxed);
        *active = Some((job.clone(), options.clone()));
    }
    let guard = ActiveJob;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        translate(&root(&app, direction)?, direction, &lines, &options, |done| {
            let _ = app.emit("translation-progress", serde_json::json!({ "job": job, "done": done }));
        }).map_err(|e| if CANCELLED.load(std::sync::atomic::Ordering::Relaxed) { "cancelled".to_string() } else { e })
    }).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_batches_keep_order_and_cap_at_sixteen() {
        let lines: Vec<_> = (0..33).collect();
        assert_eq!(batches(&lines).map(<[_]>::len).collect::<Vec<_>>(), [16, 16, 1]);
        assert!(batches(&lines).flatten().eq(&lines));
        assert_eq!(batches::<String>(&[]).count(), 0);
    }

    #[test]
    fn opus_mt_smoke() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.models");
        for (direction, inputs) in [
            (Direction::EnglishToArabic, ["Hello, how are you?", "Thank you."]),
            (Direction::ArabicToEnglish, ["مرحبا كيف حالك", "شكرا"]),
        ] {
            let path = root.join(format!("opus-{}", direction.code()));
            if !FILES.iter().all(|(file, _, _)| model_file(&path, file).is_file()) {
                eprintln!("Skipping opus-mt {} smoke check: model fixtures missing", direction.code());
                continue;
            }
            let _env = matte::ort_env().unwrap();
            let options = RunOptions::new().unwrap();
            let outputs = translate(&path, direction, &inputs.map(str::to_owned), &options, |_| {}).unwrap();
            assert_eq!(outputs.len(), inputs.len());
            assert!(outputs.iter().all(|line| !line.is_empty()), "{outputs:?}");
            eprintln!("{}: {outputs:?}", direction.code());
            let text = &outputs[0];
            match direction {
                Direction::EnglishToArabic => assert!(text.chars().any(|ch| ch.is_alphabetic() && ('\u{0600}'..='\u{06ff}').contains(&ch)), "{text}"),
                Direction::ArabicToEnglish => {
                    let lower = text.to_ascii_lowercase();
                    assert!(text.chars().any(|ch| ch.is_ascii_alphabetic()) && (lower.contains("how") || lower.contains("hello")), "{text}");
                }
            }
        }
    }
}
