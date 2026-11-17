//! Speech recognition in the editor (port of `ui-speech.js`, `speech.js`, `main/cut/whisper.js` and
//! `speech-words.js`; docs/cut-architecture.md sections 7, 9 and 10): Whisper runs on this PC in the JavaScript
//! editor's Python server through `cut-sidecar`; this module reads and mixes the sound, keeps the transcripts and
//! turns them into edits.
//!
//! - Auto Captions… (Automation menu, Captions panel): a caption track from the speech of the sequence, the In-Out
//!   range or the selected clips, one undo step ([`flow::make_captions`]).
//! - Remove Filler Words… (Automation menu): hesitations and long pauses, previewed on the timeline, then
//!   ripple-deleted from the clips' tracks and the tracks linked to them ([`dialogs`]).
//! - Next / Previous Uncertain Word (Automation menu, Alt+] and Alt+[).
//! - The Transcript panel ([`panel`]): the words, a click seeks, chosen words ripple-deleted, the search, a word
//!   corrected, Word List….
//! - The voice isolated first when `cut.speech.isolateVoice` is on (`crate::voice`'s model, the vocals in the cache).
//! - The Download Speech Recognition dialog before the first use, and the Speech Recognition page of the Preferences
//!   ([`settings`]). Nothing is downloaded until the person presses Download.
//!
//! Threads: recognition runs on an analysis thread of its own under a progress box with Cancel (decoding, mixing,
//! resampling and the windows one after another; the model runs in the server's process on every core it takes);
//! a setup runs on a thread of its own. The window takes the results each frame. Nothing runs on the GPU.

pub mod dialogs;
pub mod engine;
pub mod flow;
pub mod panel;
pub mod settings;
pub mod sound;
pub mod store;
pub mod text;
pub mod words;

use std::sync::{Arc, Mutex};

use cut_sidecar::sound::SoundFiles;
use eframe::egui;
use serde_json::{Value as Json, json};

use crate::i18n::tr;
use crate::shell::Shell;
use engine::Speech;
use store::{Opts, Store};

/// The settings of speech recognition (`DEFAULTS`), by this app's key.
pub fn default_of(key: &str) -> Json {
    match key {
        "speech.model" => json!("whisper-large-v3-turbo"),
        "speech.language" => json!("auto"),
        "speech.lineChars" => json!(0),
        "speech.markUncertain" => json!(true),
        "speech.isolateVoice" => json!(false),
        "speech.highlight" => json!(false),
        _ => Json::Null,
    }
}

/// A setting or its default (an empty or null value counts as unset, as `setting`).
pub fn setting(s: &Shell, key: &str) -> Json {
    match s.doc.settings.get(key) {
        None | Some(Json::Null) => default_of(key),
        Some(Json::String(t)) if t.is_empty() => default_of(key),
        Some(v) => v.clone(),
    }
}

/// Sets and saves a setting.
pub fn set_setting(s: &mut Shell, key: &str, v: Json) {
    s.doc.settings.set(key, v);
    let _ = s.doc.settings.save();
}

/// The language setting, `auto` when it is no language offered.
pub fn language(s: &Shell) -> String {
    let v = setting(s, "speech.language");
    match v.as_str() {
        Some(l @ ("auto" | "ko" | "en")) => l.to_owned(),
        _ => "auto".into(),
    }
}

/// Characters per caption line (0: 18 for Korean, 42 otherwise).
pub fn line_chars(s: &Shell) -> f64 {
    let v = setting(s, "speech.lineChars");
    v.as_f64().or_else(|| v.as_str().and_then(|t| t.parse().ok())).filter(|x| x.is_finite()).unwrap_or(0.0)
}

/// The project's word list (it names what this video is about and travels with the project file).
pub fn project_terms(s: &Shell) -> Vec<String> {
    s.app
        .project()
        .settings
        .get("speechTerms")
        .and_then(Json::as_array)
        .map(|a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// What recognition is asked now (`opts`): the voice is isolated first only when the setting is exactly true.
pub fn opts(s: &Shell) -> Opts {
    let model = setting(s, "speech.model");
    Opts {
        model: model.as_str().map_or_else(|| model.to_string(), str::to_owned),
        language: language(s),
        terms: project_terms(s),
        isolate: setting(s, "speech.isolateVoice") == Json::Bool(true),
    }
}

/// Whether the words Whisper was unsure of are marked.
pub fn marking(s: &Shell) -> bool {
    setting(s, "speech.markUncertain").as_bool() != Some(false)
}

/// A stretch of the timeline or of a source, `(from, to)` in ticks or seconds as its user says.
pub type Span = (f64, f64);

/// What a recognition is for, done once it has run.
#[derive(Debug, Clone, PartialEq)]
pub enum Goal {
    /// Captions with these choices.
    Captions { ids: Vec<cut_model::Id>, range: Option<(f64, f64)>, chars: f64, highlight: bool },
    /// The Remove Filler Words dialog.
    Fillers { ids: Vec<cut_model::Id>, range: Option<(f64, f64)> },
    /// Only the model downloaded (the Preferences' Download…).
    Download,
    /// Only the recognition (the control API's `automation` jobs, which go on themselves).
    Recognize { ids: Vec<cut_model::Id>, range: Option<(f64, f64)> },
    /// Label Speakers on these clips' transcripts, with this many speakers (0: Auto) (`crate::speakers`).
    Speakers { ids: Vec<cut_model::Id>, count: u32 },
    /// The Claude features' Transcribe offer: what waited for the words runs once they are recognised, and not
    /// after a decline, a cancel or a failure (`crate::ai::notice`).
    Claude { ids: Vec<cut_model::Id> },
    /// The Transcript panel's Transcribe: the panel shows the words.
    Panel { ids: Vec<cut_model::Id> },
}

impl Goal {
    /// The clips recognised for it (none for a download alone).
    pub fn clips(&self) -> Option<(&[cut_model::Id], Option<Span>)> {
        match self {
            Goal::Download => None,
            Goal::Captions { ids, range, .. } | Goal::Fillers { ids, range } | Goal::Recognize { ids, range } => {
                Some((ids, *range))
            }
            Goal::Speakers { ids, .. } | Goal::Claude { ids } | Goal::Panel { ids } => Some((ids, None)),
        }
    }
}

/// Speech recognition's state on the shell.
#[derive(Default)]
pub struct SpeechUi {
    backend: Option<Arc<Speech>>,
    store: Option<Arc<Mutex<Store>>>,
    /// The recognition running, and what it is for.
    pub job: Option<(crate::auto::Job<Result<(), String>>, Goal)>,
    pub setup: Option<dialogs::Setup>,
    pub captions: Option<dialogs::CaptionsForm>,
    pub fillers: Option<dialogs::FillersForm>,
    /// The Word List dialog: the list as typed.
    pub terms: Option<String>,
    pub panel: panel::Transcript,
}

impl SpeechUi {
    /// Uses `backend` from now on (tests: a fake one).
    pub fn set_backend(&mut self, backend: Arc<Speech>) {
        self.backend = Some(backend);
    }
}

/// The backend, made on first use from the environment (`PYIDE_WHISPER_BACKEND`).
pub fn backend(s: &mut Shell) -> Arc<Speech> {
    if s.features.speech.backend.is_none() {
        let files = Arc::new(SoundFiles::new(SoundFiles::default_dir()));
        let b = Speech::from_env(files);
        b.configure(s.doc.settings.get("ai.idleUnloadMinutes"));
        s.features.speech.backend = Some(b);
    }
    s.features
        .speech
        .backend
        .clone()
        .unwrap_or_else(|| Speech::fake("", Arc::new(SoundFiles::new(SoundFiles::default_dir()))))
}

/// The temp sound files recognition streams in, for speakers and voice isolation (one set an editor).
pub fn sound_files(s: &mut Shell) -> Arc<SoundFiles> {
    backend(s).files().clone()
}

/// The transcripts, made on first use over the app's cache.
pub fn store(s: &mut Shell) -> Arc<Mutex<Store>> {
    if s.features.speech.store.is_none() {
        let gb = Some(crate::prefs::number(&s.doc.settings, "cacheLimitGB")).filter(|v| *v > 0.0);
        let limit = (gb.unwrap_or(10.0) * 1024.0 * 1024.0 * 1024.0) as u64;
        let cache = crate::files::cache::Cache::new(s.doc.home.cache.clone(), limit);
        s.features.speech.store = Some(Arc::new(Mutex::new(Store::new(Some(Arc::new(cache))))));
    }
    s.features.speech.store.clone().unwrap_or_default()
}

/// The ids of this feature's actions.
const ACTIONS: [&str; 4] = ["auto.captions", "auto.fillers", "auto.nextUncertain", "auto.prevUncertain"];

/// `Some(can run now)` for this feature's actions; Delete and Ripple Delete while the Transcript panel has the
/// keyboard and words chosen (else they are the timeline's).
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    if panel::takes(s, id) || id == "window.transcript" {
        return Some(true);
    }
    ACTIONS.contains(&id).then(|| s.app.sequence().is_some())
}

/// Runs one of this feature's actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    if panel::takes(s, id) {
        panel::remove_selected(s);
        return true;
    }
    if !ACTIONS.contains(&id) {
        return false;
    }
    match id {
        "auto.nextUncertain" => {
            flow::next_uncertain(s, 1);
        }
        "auto.prevUncertain" => {
            flow::next_uncertain(s, -1);
        }
        _ if busy(s) => s.app.toast(tr("Another analysis is running.")),
        "auto.captions" => dialogs::open_captions(s),
        _ => flow::remove_fillers(s),
    }
    true
}

/// Whether an analysis runs (this one's, or one of the Automation menu's).
pub fn busy(s: &Shell) -> bool {
    s.features.speech.job.is_some() || s.features.auto.running()
}

/// The dialogs, the progress box, the results that came back and the Alt+] / Alt+[ keys, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    flow::poll(s, ctx);
    dialogs::windows(s, ctx);
    if s.app.sequence().is_some() && !ctx.egui_wants_keyboard_input() {
        let (next, prev) = ctx.input_mut(|i| {
            (
                i.consume_key(egui::Modifiers::ALT, egui::Key::CloseBracket),
                i.consume_key(egui::Modifiers::ALT, egui::Key::OpenBracket),
            )
        });
        if next {
            flow::next_uncertain(s, 1);
        }
        if prev {
            flow::next_uncertain(s, -1);
        }
    }
}

/// `ui.formatBytes`: `925 MB`, `1.5 GB`.
pub fn format_bytes(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let (mut i, mut v) = (0, n);
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if v < 10.0 && i > 0 { format!("{v:.1} {}", units[i]) } else { format!("{} {}", text::js_round(v), units[i]) }
}
