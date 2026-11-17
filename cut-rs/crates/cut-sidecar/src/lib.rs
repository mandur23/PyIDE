//! The one private Python environment behind Nano Studio's local AI models, and the JSON-lines protocol the editor
//! talks to their Python servers with: the port of `main/ai/runtime.js`, plus what `main/cut/whisper.js`,
//! `voice.js` and `speakers.js` each repeat around it (setup failure codes, the pretend setup of the tests, the temp
//! files of 16 kHz sound, free disk space).
//!
//! The models keep running in the JavaScript editor's Python servers (`main/ai/*_server.py`, unchanged); this crate
//! finds, creates and fills the same environment the installed JavaScript app uses, so what a person downloaded there
//! is reused as it is:
//! - the environment: `%USERPROFILE%\.pyide\semantic\venv` (Python at `venv\Scripts\python.exe`);
//! - the models: the Hugging Face cache, `%HF_HUB_CACHE%`, else `%HF_HOME%\hub`, else
//!   `%USERPROFILE%\.cache\huggingface\hub`.
//!
//! # API (for the features built on it: speech recognition, speakers, voice isolation)
//! - [`Runtime::shared`] (or [`Runtime::at`] in tests): `python_ready`, `importable(pkg)`, `torch_on_disk`,
//!   [`usable`]`(version)`; [`hf::cached_file`]`(repo, file)`, [`hf::repo_dir`], [`hf::cache_dir`].
//! - Setup steps, run on a thread of the caller's: [`Job::new`]`(log)` streams each command's output and can be
//!   [`Job::cancel`]led (the running command's process tree is ended); [`exclusive`] serializes the pip runs of every
//!   feature; [`setup::ensure_venv`], [`setup::pip_install`], [`setup::torch_usable`],
//!   [`setup::install_torchvision`], [`setup::hf_download`], [`setup::snapshot_download`]. Errors are the
//!   JavaScript's messages; [`classify`]`(text)` turns one (and the log's end) into a [`SetupCode`] (`offline`,
//!   `disk`, `noPython`, `noTorch`, `busy`, `cancelled`, `failed`). [`Progress`] is what a setup reports.
//! - [`fake::setup`]: the pretend download of the tests (`PYIDE_*_FAKE_SETUP=ok|offline|disk|noPython`).
//! - Disk: [`disk::free_bytes`]`(dir, probe)` (the probe is `cut_decode::disk::free_space`), [`disk::dir_bytes`].
//! - A server: [`Sidecar::start`]`(`[`Spec::python`]`(&rt, script)...)`; [`Sidecar::send`]`(json)` -> [`Reply`]
//!   (`wait()`: the answer with the request's id, or `{"error": "server exited (code)"}` when the process ends first),
//!   [`Sidecar::notify`] (no answer, as a cancel), `alive`, `idle` (re-read the idle timeout), `stop`, `kill`. Lines
//!   without an id are events (`on_event`), stderr is log text (`on_log`). [`idle_ms_of`]`(minutes)` is the
//!   `ai.idleUnloadMinutes` setting in ms. [`script`]`(name)` finds a server's `.py` file (`CUT_SIDECAR_DIR`).
//! - Sound: [`sound::SoundFiles`] holds the temp files of 16 kHz mono float32 a server reads (`open`, `write`,
//!   `read`, `close`).
//!
//! Threads: a [`Sidecar`] has three of its own (stdout, stderr, the idle clock); a [`Job`] two while a command runs.
//! Nothing here touches the network itself: only the setup commands the caller runs do (pip, Hugging Face).

mod classify;
pub mod disk;
pub mod fake;
pub mod hf;
mod job;
mod runtime;
pub mod setup;
mod sidecar;
pub mod sound;

pub use classify::{SetupCode, classify};
pub use job::{Job, exclusive};
pub use runtime::{Runtime, TORCH, home, usable};
pub use sidecar::{Reply, Sidecar, Spec, kill_all};

use serde_json::{Value as Json, json};

/// Models stay loaded this long after their last request before the server is stopped (minutes).
pub const IDLE_MINUTES: f64 = 10.0;

/// The idle timeout of a server in ms from the `ai.idleUnloadMinutes` setting (0 keeps the model loaded, `None` or a
/// value that is not a number means the default), as `idleMsOf`.
pub fn idle_ms_of(minutes: Option<&Json>) -> u64 {
    let m = match minutes {
        Some(Json::Number(n)) => n.as_f64().unwrap_or(IDLE_MINUTES),
        Some(Json::String(s)) => {
            s.trim().parse::<f64>().ok().or(if s.trim().is_empty() { Some(0.0) } else { None }).unwrap_or(IDLE_MINUTES)
        }
        Some(Json::Bool(b)) => f64::from(u8::from(*b)),
        Some(Json::Null) => 0.0,
        _ => IDLE_MINUTES,
    };
    let m = if m.is_finite() { m } else { IDLE_MINUTES };
    (m * 60000.0).round().max(0.0) as u64
}

/// What a setup reports while it runs (`cut:speechProgress` and its kin): the phase, the fraction done (`None`:
/// unknown, the bar moves on its own), the last line of the log, the bytes of the download.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub phase: Phase,
    pub fraction: Option<f64>,
    pub text: Option<String>,
    pub bytes: Option<f64>,
}

/// A setup's phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// The environment and its packages.
    Runtime,
    /// The model's files.
    Download,
    Done,
}

impl Phase {
    /// The JavaScript's word.
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Runtime => "runtime",
            Phase::Download => "download",
            Phase::Done => "done",
        }
    }
}

impl Progress {
    /// As the JavaScript's progress object.
    pub fn to_json(&self) -> Json {
        let mut o = json!({ "phase": self.phase.as_str(), "fraction": self.fraction });
        if let Some(t) = &self.text {
            o["text"] = json!(t);
        }
        if let Some(b) = self.bytes {
            o["bytes"] = json!(b);
        }
        o
    }
}

/// A setup that did not end ready: its code, the message, and the end of its log.
#[derive(Debug, Clone, PartialEq)]
pub struct SetupFailure {
    pub code: SetupCode,
    pub error: String,
    pub log: String,
}

/// Where a server's script is: `CUT_SIDECAR_DIR\<name>` when that is set, else `<this program's folder>\sidecars\
/// <name>`, else the JavaScript editor's `main\ai\<name>` beside this source tree (a run from the workspace).
pub fn script(name: &str) -> Option<std::path::PathBuf> {
    let mut places = Vec::new();
    if let Some(d) = std::env::var_os("CUT_SIDECAR_DIR").filter(|d| !d.is_empty()) {
        places.push(std::path::PathBuf::from(d).join(name));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("sidecars"))) {
        places.push(d.join(name));
    }
    places.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../main/ai").join(name));
    places.into_iter().find(|p| p.is_file())
}
