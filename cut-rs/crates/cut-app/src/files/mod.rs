//! Project file I/O shared with the JavaScript editor (`main/cut/project.js`, `paths.js`, `runs.js`).
//!
//! Both editors use one Cut workspace ([`Home`]) and the same files in it: projects (`.ncut`) with their `.bak` and
//! `.v<version>.bak` copies, autosaves named `<name>-<hash>-<stamp>[.latest].ncut`, and session markers
//! `<autosave>\.sessions\<pid>-<run>-<hash>.json` that tell a crash from a clean close. Names, hashes, stamps and the
//! marker JSON are byte for byte the JavaScript's, so either editor recovers what the other left behind.
//!
//! Every call returns a value: expected failures are a [`FileError`] carrying the JavaScript's code, never a panic.
//! Paths follow `paths.js`: local absolute Windows paths only, network and device paths refused before anything
//! touches them, every check made on the real path.

mod atomic;
pub mod cache;
mod names;
mod paths;
mod projects;
mod runs;
mod settings;

use std::fmt;
use std::path::PathBuf;

pub use atomic::{mtime_ms, now_ms, write_atomic};
pub use names::{autosave_name, hash_of, name_of, stamp_of, time_of_stamp};
pub use paths::{ext_of, local_path};
pub use projects::{Autosave, AutosaveJob, KEEP, MAX_KEEP, Offer, Projects, ReadOk, WriteOk};
pub use runs::Run;
pub use settings::{RECENT_MAX, Recent, Settings};

/// The largest project text either editor reads or writes (`NCUT_TEXT_LIMIT`), in UTF-16 code units as JavaScript
/// counts a string's length.
pub const NCUT_TEXT_LIMIT: usize = 200 * 1024 * 1024;

/// Why a file call failed, with the JavaScript's code string ([`Code::as_str`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Code {
    BadArgs,
    Network,
    Missing,
    NotFile,
    Extension,
    Outside,
    Io,
    TooLarge,
    Autosave,
    Changed,
}

impl Code {
    /// The code as the JavaScript spells it (`badArgs`, `notFile` ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadArgs => "badArgs",
            Self::Network => "network",
            Self::Missing => "missing",
            Self::NotFile => "notFile",
            Self::Extension => "extension",
            Self::Outside => "outside",
            Self::Io => "io",
            Self::TooLarge => "tooLarge",
            Self::Autosave => "autosave",
            Self::Changed => "changed",
        }
    }
}

/// A failed file call: the JavaScript's `{ error, code }`, plus the file's time now for [`Code::Changed`].
#[derive(Clone, Debug, PartialEq)]
pub struct FileError {
    pub code: Code,
    pub message: String,
    pub mtime: Option<f64>,
}

impl FileError {
    pub(crate) fn new(code: Code, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), mtime: None }
    }

    pub(crate) fn io(err: &std::io::Error) -> Self {
        Self::new(Code::Io, err.to_string())
    }
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code.as_str())
    }
}

impl std::error::Error for FileError {}

/// The Cut workspace and its folders: `<home>\Projects`, `<home>\Autosave` (markers in `.sessions`), `<home>\Cache`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Home {
    pub home: PathBuf,
    pub projects: PathBuf,
    pub autosave: PathBuf,
    pub cache: PathBuf,
}

impl Home {
    /// The workspace both editors use: `CUT_HOME`, else `PYIDE_CUT_HOME` (the JavaScript's test override), else
    /// `%USERPROFILE%\Nano Studio Cut`, made absolute.
    pub fn resolve() -> Self {
        let set = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let root = set("CUT_HOME")
            .or_else(|| set("PYIDE_CUT_HOME"))
            .unwrap_or_else(|| set("USERPROFILE").or_else(|| set("HOME")).unwrap_or_default().join("Nano Studio Cut"));
        Self::at(std::path::absolute(&root).unwrap_or(root))
    }

    /// The folders of a workspace at `root`, as given.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        let home = root.into();
        Self { projects: home.join("Projects"), autosave: home.join("Autosave"), cache: home.join("Cache"), home }
    }

    /// Creates the folders that are not there yet.
    pub fn ensure(&self) -> Result<(), FileError> {
        for dir in [&self.projects, &self.autosave, &self.cache] {
            std::fs::create_dir_all(dir).map_err(|e| FileError::io(&e))?;
        }
        Ok(())
    }
}
