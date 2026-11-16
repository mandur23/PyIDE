//! The export journal (`main/cut/sink.js`): each run lists the part files it writes now (an export's `.part`, an SRT
//! sidecar's, faststart's full-size `.faststart.tmp` copy) in `<home>\.cut-rs\cut-exports\<pid>-<run>.json`, and
//! deletes the list when it is empty. At the next start the parts that a run which is gone (crashed, killed) left
//! behind are removed with its list; a list of a run that still runs is left alone.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use cut_export::sink::Journal;
use serde_json::{Map, Value, json};

use crate::files::{Run, write_atomic};
use crate::shell::Shell;

/// Only names of these kinds are removed, whatever a list says.
fn leftover(part: &str) -> bool {
    let lower = part.to_lowercase();
    lower.ends_with(".part") || lower.ends_with(".faststart.tmp")
}

/// `<pid>-<hex>.json`.
fn journal_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else { return false };
    let Some((pid, run)) = stem.split_once('-') else { return false };
    !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && !run.is_empty()
        && run.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// This run's list of part files.
pub struct ExportJournal {
    file: PathBuf,
    run: Run,
    parts: Mutex<Vec<PathBuf>>,
}

impl ExportJournal {
    /// The journal of `run` in `dir`; nothing is written until a part file is added.
    pub fn new(dir: &Path, run: Run) -> Self {
        Self { file: dir.join(format!("{}-{}.json", run.pid, run.run)), run, parts: Mutex::default() }
    }

    fn save(&self, parts: &[PathBuf]) {
        let r = if parts.is_empty() {
            match fs::remove_file(&self.file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            }
        } else {
            let list: Vec<String> = parts.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            let text = json!({ "pid": self.run.pid, "run": self.run.run, "started": self.run.started, "parts": list });
            self.file
                .parent()
                .map_or(Ok(()), fs::create_dir_all)
                .and_then(|()| write_atomic(&self.file, text.to_string().as_bytes(), false))
        };
        if let Err(e) = r {
            eprintln!("export journal: {e}");
        }
    }

    /// Removes the part files of runs that are gone, and their lists.
    pub fn sweep(&self) {
        let Some(dir) = self.file.parent() else { return };
        let Ok(entries) = fs::read_dir(dir) else { return };
        let files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| journal_name(&e.file_name().to_string_lossy()))
            .map(|e| e.path())
            .collect();
        let markers: Vec<Option<Map<String, Value>>> = files
            .iter()
            .map(|f| fs::read_to_string(f).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()))
            .map(|v| match v {
                Some(Value::Object(m)) => Some(m),
                Some(_) => Some(Map::new()),
                None => None,
            })
            .collect();
        let objects: Vec<&Map<String, Value>> = markers.iter().flatten().collect();
        let mut alive = self.run.alive(&objects).into_iter();
        for (file, marker) in files.iter().zip(&markers) {
            if marker.is_some() && alive.next() == Some(true) {
                continue;
            }
            let parts = marker.as_ref().and_then(|m| m.get("parts")).and_then(Value::as_array);
            for part in parts.into_iter().flatten().filter_map(Value::as_str).filter(|p| leftover(p)) {
                let _ = fs::remove_file(part);
            }
            let _ = fs::remove_file(file);
        }
    }
}

impl Journal for ExportJournal {
    fn add(&self, part: &Path) {
        let mut parts = self.parts.lock().unwrap_or_else(|e| e.into_inner());
        parts.push(part.to_owned());
        self.save(&parts);
    }

    fn remove(&self, part: &Path) {
        let mut parts = self.parts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = parts.iter().position(|p| p == part) {
            parts.remove(i);
            self.save(&parts);
        }
    }
}

/// The journal of this app's run, made at the first frame; the leftovers of runs that are gone are swept then, on a
/// thread of its own (it asks the system which processes run). One run a process, as the JavaScript's, so two
/// windows of one process never take each other's part files for a dead run's.
pub fn get(s: &mut Shell) -> Arc<dyn Journal> {
    static RUN: OnceLock<Run> = OnceLock::new();
    if let Some(j) = &s.features.export.journal {
        return j.clone();
    }
    let dir = s.doc.home.home.join(".cut-rs").join("cut-exports");
    let j = Arc::new(ExportJournal::new(&dir, RUN.get_or_init(Run::new).clone()));
    let sweeper = j.clone();
    std::thread::Builder::new().name("export journal".into()).spawn(move || sweeper.sweep()).ok();
    s.features.export.journal = Some(j.clone());
    j
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_names() {
        assert!(journal_name("1234-0a1b2c3d4e5f.json"));
        assert!(!journal_name("1234-0A1B.json") && !journal_name("-ab.json") && !journal_name("12-.json"));
        assert!(!journal_name("x1-ab.json") && !journal_name("12-ab.txt") && !journal_name("12ab.json"));
        assert!(leftover("C:\\a\\b.mp4.PART") && leftover("b.mp4.1234abcd.faststart.tmp") && !leftover("b.mp4"));
    }

    #[test]
    fn parts_are_listed_while_they_exist_and_a_dead_runs_are_swept() {
        let dir = std::env::temp_dir().join(format!("cut-journal-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = |name: &str| {
            let p = dir.join(name);
            fs::write(&p, b"x").unwrap();
            p
        };
        let me = ExportJournal::new(&dir, Run::new());
        let part = file("live.mp4.part");
        me.add(&part);
        let listed: Value = serde_json::from_str(&fs::read_to_string(&me.file).unwrap()).unwrap();
        assert_eq!(listed["parts"], json!([part.to_string_lossy()]), "the part is listed");
        assert_eq!(listed["run"], json!(me.run.run));
        // a run of this process before this one: dead, whatever its pid says
        let (dead_part, kept_txt) = (file("dead.mp4.part"), file("notes.txt"));
        let dead_tmp = file("dead.mp4.0badf00d.faststart.tmp");
        let dead = dir.join(format!("{}-feedface.json", std::process::id()));
        let parts = json!([dead_part.to_string_lossy(), kept_txt.to_string_lossy(), dead_tmp.to_string_lossy(), 7]);
        fs::write(
            &dead,
            json!({ "pid": std::process::id(), "run": "feedface", "started": 1, "parts": parts }).to_string(),
        )
        .unwrap();
        let (broken, other) = (dir.join("12-ab.json"), file("settings.json"));
        fs::write(&broken, b"{ not json").unwrap();
        me.sweep();
        assert!(!dead_part.exists() && !dead_tmp.exists() && !dead.exists(), "a dead run's parts and list go");
        assert!(kept_txt.exists(), "only part and faststart names are removed");
        assert!(!broken.exists() && other.exists(), "an unreadable list goes, other files stay");
        assert!(part.exists() && me.file.exists(), "this run's list and part stay");
        me.remove(&part);
        assert!(!me.file.exists(), "an empty list is deleted");
        fs::remove_dir_all(&dir).unwrap();
    }
}
