//! The native app's own settings, `<home>\.cut-rs\settings.json` (the JavaScript editor keeps its settings in
//! Electron's folder), and the recent-projects list stored there under `recent`.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::FileError;
use super::atomic::write_atomic;

/// How many recent projects are listed.
pub const RECENT_MAX: usize = 10;
const RECENT: &str = "recent";

/// The settings file as a JSON object; keys this app does not know are kept as they are.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    file: PathBuf,
    values: Map<String, Value>,
}

impl Settings {
    /// The settings of a workspace; empty when the file is missing or is not a JSON object.
    pub fn load(home: &Path) -> Self {
        let file = home.join(".cut-rs").join("settings.json");
        let values = match fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        Self { file, values }
    }

    /// Where the settings are saved.
    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    pub fn set(&mut self, key: &str, value: Value) {
        self.values.insert(key.to_owned(), value);
    }

    /// Writes the file whole or not at all, creating its folder.
    pub fn save(&self) -> Result<(), FileError> {
        let text = serde_json::to_vec_pretty(&self.values).map_err(|e| FileError::io(&std::io::Error::other(e)))?;
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| FileError::io(&e))?;
        }
        write_atomic(&self.file, &text, true).map_err(|e| FileError::io(&e))
    }
}

/// Recent projects, newest first, at most [`RECENT_MAX`], no path twice (compared ignoring case, as Windows does).
/// A project that is gone stays listed until opening it fails and the app calls [`Recent::remove`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recent {
    paths: Vec<PathBuf>,
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

impl Recent {
    /// The list stored in the settings (entries that are not text are skipped).
    pub fn of(settings: &Settings) -> Self {
        let mut recent = Self::default();
        let stored = settings.get(RECENT).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        for p in stored.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()) {
            let p = Path::new(p);
            if recent.paths.len() < RECENT_MAX && !recent.paths.iter().any(|q| same(q, p)) {
                recent.paths.push(p.to_path_buf());
            }
        }
        recent
    }

    pub fn paths(&self) -> &[PathBuf] {
        &self.paths
    }

    /// A project opened or saved: first in the list.
    pub fn add(&mut self, path: &Path) {
        self.remove(path);
        self.paths.insert(0, path.to_path_buf());
        self.paths.truncate(RECENT_MAX);
    }

    pub fn remove(&mut self, path: &Path) {
        self.paths.retain(|q| !same(q, path));
    }

    /// Puts the list into the settings (to be saved with [`Settings::save`]).
    pub fn store(&self, settings: &mut Settings) {
        let list = self.paths.iter().map(|p| Value::String(p.to_string_lossy().into_owned())).collect();
        settings.set(RECENT, Value::Array(list));
    }
}
