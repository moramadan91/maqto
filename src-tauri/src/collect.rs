// Collect project: copy a .maqto and every file it needs into one folder (optionally zipped), streaming.
// Relink: find files by name under a folder. The JS side plans the names (shared.js collectPlan).
use super::{command, err, R};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

static CANCEL: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize, Clone)]
pub struct CollectFile { pub src: String, pub dest: String }

// A project file name that is safe as a folder name on both platforms.
fn clean_name(name: &str) -> String {
    let n: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let n = n.trim().trim_matches('.').to_string();
    if n.is_empty() { "Project".into() } else { n }
}

// `dest` must stay inside the collect folder.
fn inside(rel: &str) -> bool {
    !rel.is_empty() && Path::new(rel).components().all(|c| matches!(c, Component::Normal(_)))
}

fn prepare_root(dest: &str, name: &str) -> R<PathBuf> {
    let base = Path::new(dest);
    if !base.is_dir() { return Err("Destination folder not found".into()); }
    let root = base.join(clean_name(name));
    if root.exists() && (!root.is_dir() || std::fs::read_dir(&root).map_err(err)?.next().is_some()) {
        return Err("The destination already has a non-empty folder with this project name".into());
    }
    std::fs::create_dir_all(&root).map_err(err)?;
    Ok(root)
}

// Streams each file in 1 MiB chunks; `progress(done, total)` after every chunk; stops when `cancel` is set.
fn copy_plan(root: &Path, files: &[CollectFile], cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> R<u64> {
    let mut total = 0u64;
    for f in files {
        if !inside(&f.dest) { return Err(format!("bad destination: {}", f.dest)); }
        total += std::fs::metadata(&f.src).map_err(|e| format!("{}: {e}", f.src))?.len();
    }
    let (mut done, mut buf) = (0u64, vec![0u8; 1 << 20]);
    for f in files {
        let to = root.join(&f.dest);
        std::fs::create_dir_all(to.parent().unwrap_or(root)).map_err(err)?;
        let mut r = std::fs::File::open(&f.src).map_err(|e| format!("{}: {e}", f.src))?;
        let mut w = std::io::BufWriter::new(std::fs::File::create(&to).map_err(err)?);
        loop {
            if cancel.load(Ordering::Relaxed) { return Err("cancelled".into()); }
            let n = r.read(&mut buf).map_err(err)?;
            if n == 0 { break; }
            w.write_all(&buf[..n]).map_err(err)?;
            done += n as u64;
            progress(done, total);
        }
        w.flush().map_err(err)?;
    }
    progress(done, total);
    Ok(done)
}

// "<root>.zip" appended to the whole name: with_extension would turn "Final v1.2" into "Final v1.zip".
fn zip_path(root: &Path) -> PathBuf {
    let mut z = root.as_os_str().to_owned();
    z.push(".zip");
    PathBuf::from(z)
}

// Never overwrite or delete a zip we did not make.
fn zip_target(root: &Path) -> R<PathBuf> {
    let zip = zip_path(root);
    if zip.exists() { return Err(format!("{} already exists", zip.display())); }
    Ok(zip)
}

fn zip_folder(root: &Path) -> R<PathBuf> {
    let zip = zip_target(root)?;
    let out = if cfg!(windows) {
        // paths go through the environment: extra args after -Command never populate $args
        command(Path::new("powershell")).args(["-NoProfile", "-Command", "Compress-Archive -LiteralPath $env:MQ_SRC -DestinationPath $env:MQ_DST"])
            .env("MQ_SRC", root).env("MQ_DST", &zip).output()
    } else {
        command(Path::new("/usr/bin/ditto")).args(["-c", "-k", "--keepParent"]).arg(root).arg(&zip).output()
    }.map_err(err)?;
    if !out.status.success() { return Err(format!("zip failed: {}", String::from_utf8_lossy(&out.stderr).trim())); }
    Ok(zip)
}

#[tauri::command]
pub fn collect_sizes(paths: Vec<String>) -> Value {
    let mut total = 0u64;
    let mut missing = vec![];
    for p in paths {
        match std::fs::metadata(&p) { Ok(m) if m.is_file() => total += m.len(),
            _ => missing.push(p) }
    }
    json!({ "total": total, "missing": missing })
}

#[tauri::command]
pub fn collect_cancel() { CANCEL.store(true, Ordering::Relaxed); }

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) { BUSY.store(false, Ordering::SeqCst); }
}

#[tauri::command]
pub async fn collect_run(app: AppHandle, job: String, dest: String, name: String, files: Vec<CollectFile>, project_json: String, zip: bool) -> R<Value> {
    if BUSY.swap(true, Ordering::SeqCst) { return Err("another collect is running".into()); }
    let _busy = BusyGuard;
    CANCEL.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        if zip { zip_target(&Path::new(&dest).join(clean_name(&name)))?; } // refuse before copying gigabytes
        let root = prepare_root(&dest, &name)?;
        let copied = (|| {
            let mut last = 0u64;
            let bytes = copy_plan(&root, &files, &CANCEL, |done, total| {
                if done == total || done - last >= (4 << 20) { last = done; let _ = app.emit("collectprog", json!({ "job": job, "done": done, "total": total })); }
            })?;
            std::fs::write(root.join(format!("{}.maqto", clean_name(&name))), &project_json).map_err(err)?;
            Ok(bytes)
        })();
        let bytes = match copied {
            Ok(b) => b,
            Err(e) => { let _ = std::fs::remove_dir_all(&root); return Err(e); } // only a folder this run created (it was empty)
        };
        // a zip failure keeps the good collected folder
        let zipped = if zip {
            Some(zip_folder(&root).map_err(|e| format!("Collected to {}, but {e}", root.display()))?.to_string_lossy().to_string())
        } else { None };
        Ok(json!({ "dir": root.to_string_lossy(), "bytes": bytes, "zip": zipped }))
    }).await.map_err(err)?
}

// Files under `root` whose name matches (case-insensitive) one of `names`; capped so a drive root cannot run away.
#[tauri::command]
pub async fn relink_search(root: String, names: Vec<String>) -> R<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let want: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();
        let (mut found, mut stack, mut seen) = (vec![], vec![PathBuf::from(&root)], 0usize);
        'walk: while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                seen += 1;
                if seen > 500_000 { break 'walk; }
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_symlink() { continue; }
                let p = e.path();
                if ft.is_dir() { stack.push(p); continue; }
                let n = e.file_name().to_string_lossy().to_string();
                if want.contains(&n.to_lowercase()) {
                    found.push(json!({ "path": p.to_string_lossy(), "name": n, "size": e.metadata().map(|m| m.len()).ok() }));
                }
            }
        }
        Ok(json!(found))
    }).await.map_err(err)?
}

// A path stored relative to the project file resolves against its folder; absolute paths stay as they are.
pub fn resolve_rel(project_dir: &Path, p: &str) -> String {
    let is_abs = Path::new(p).is_absolute() || p.starts_with('/') || p.starts_with('\\') || p.as_bytes().get(1) == Some(&b':');
    if p.is_empty() || is_abs { p.to_string() } else { project_dir.join(p).to_string_lossy().to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maqto-collect-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn collect_copies_plan_and_reports_progress() {
        let d = tmp("copy");
        std::fs::write(d.join("a.bin"), vec![1u8; 3 << 20]).unwrap();
        std::fs::write(d.join("b.bin"), b"hello").unwrap();
        let files = vec![
            CollectFile { src: d.join("a.bin").to_string_lossy().into(), dest: "Media/clip.bin".into() },
            CollectFile { src: d.join("b.bin").to_string_lossy().into(), dest: "Media/clip_2.bin".into() },
        ];
        let out = d.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let root = prepare_root(out.to_str().unwrap(), "My: Film").unwrap();
        assert!(root.ends_with("My_ Film"));
        let mut last = (0, 0);
        let n = copy_plan(&root, &files, &AtomicBool::new(false), |a, b| last = (a, b)).unwrap();
        assert_eq!(n, (3 << 20) + 5);
        assert_eq!(last, (n, n));
        assert_eq!(std::fs::read(root.join("Media/clip_2.bin")).unwrap(), b"hello");
        assert_eq!(std::fs::metadata(root.join("Media/clip.bin")).unwrap().len(), 3 << 20);
        assert!(prepare_root(out.to_str().unwrap(), "My: Film").is_err(), "non-empty folder is refused");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn collect_refuses_escapes_and_honours_cancel() {
        let d = tmp("bad");
        std::fs::write(d.join("a.bin"), b"x").unwrap();
        let src: String = d.join("a.bin").to_string_lossy().into();
        for bad in ["../x", "/abs", ""] {
            let f = vec![CollectFile { src: src.clone(), dest: bad.into() }];
            assert!(copy_plan(&d.join("r"), &f, &AtomicBool::new(false), |_, _| {}).is_err(), "{bad}");
        }
        let f = vec![CollectFile { src, dest: "Media/a.bin".into() }];
        assert_eq!(copy_plan(&d.join("r"), &f, &AtomicBool::new(true), |_, _| {}).unwrap_err(), "cancelled");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn zip_name_keeps_dotted_names() {
        assert_eq!(zip_path(Path::new("/o/Final v1.2")), PathBuf::from("/o/Final v1.2.zip"));
        let d = tmp("zip");
        std::fs::write(d.join("x.zip"), b"mine").unwrap();
        assert!(zip_target(&d.join("x")).is_err(), "existing zip is refused, not deleted");
        assert!(d.join("x.zip").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(resolve_rel(Path::new("/p/Film"), "Media/a.mp4"), "/p/Film/Media/a.mp4");
        assert_eq!(resolve_rel(Path::new("/p/Film"), "/x/a.mp4"), "/x/a.mp4");
        assert_eq!(resolve_rel(Path::new("/p"), "C:\\x\\a.mp4"), "C:\\x\\a.mp4");
        assert_eq!(resolve_rel(Path::new("/p"), ""), "");
    }
}
