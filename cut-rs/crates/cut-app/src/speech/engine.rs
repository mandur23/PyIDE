//! Speech recognition's backend (port of `main/cut/whisper.js`): Whisper on the CPU in the JavaScript editor's
//! Python server (`main/ai/whisper_server.py`, found by `cut_sidecar::script`) inside the shared AI environment; the
//! setup of that environment and the download of a model, only when the person presses Download.
//!
//! `PYIDE_WHISPER_BACKEND=fake` (tests): no Python at all, one word per burst of sound ([`super::words`]).
//! `PYIDE_WHISPER_FAKE_SETUP=ok|offline|disk|noPython` (with the fake): the model and runtime start missing and a
//! setup pretends to download them, then succeeds or fails with that code.
//!
//! Threads: every call here blocks and runs on the caller's thread (the analysis thread, the setup thread); the
//! server has its own three (`cut_sidecar::Sidecar`).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cut_sidecar::sound::SoundFiles;
use cut_sidecar::{Job, Phase, Progress, Runtime, SetupCode, SetupFailure, Sidecar, Spec, setup};
use serde_json::{Value as Json, json};

use super::text::terms_of;
use super::words::{self, Heard, RATE};

/// A Whisper model the editor offers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Model {
    pub id: &'static str,
    pub repo: &'static str,
    pub name: &'static str,
    pub bytes: f64,
}

pub const MODELS: [Model; 2] = [
    Model { id: "whisper-small", repo: "openai/whisper-small", name: "Whisper small", bytes: 970e6 },
    Model {
        id: "whisper-large-v3-turbo",
        repo: "openai/whisper-large-v3-turbo",
        name: "Whisper large-v3 turbo",
        bytes: 1625e6,
    },
];

/// Only what transformers loads: the repos also hold PyTorch, TensorFlow and Flax copies of the weights.
const PATTERNS: [&str; 3] = ["*.json", "*.txt", "model.safetensors"];
const NEEDED: [&str; 3] = ["model.safetensors", "preprocessor_config.json", "tokenizer.json"];
/// torch (CPU) and transformers when nothing can be reused.
pub const RUNTIME_BYTES: f64 = 2.6e9;
const MARGIN: f64 = 300e6;
/// One window is 31 s at most.
pub const MAX_WINDOW: u64 = 31 * RATE as u64;
const PACKAGES: [&str; 3] = ["transformers", "numpy", "huggingface_hub"];

/// The model with `id`, else the first.
pub fn model_of(id: &str) -> Model {
    MODELS.iter().copied().find(|m| m.id == id).unwrap_or(MODELS[0])
}

/// The model's state in the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EngineState {
    #[default]
    Idle,
    Loading,
    Ready,
}

/// What the dialogs show (`cut:speechStatus`).
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub fake: bool,
    pub runtime: bool,
    pub runtime_bytes: f64,
    pub models: Vec<(Model, bool)>,
    pub engine: EngineState,
}

impl Status {
    /// The model with `id` and whether it is installed (the first when unknown).
    pub fn model(&self, id: &str) -> (Model, bool) {
        self.models.iter().copied().find(|(m, _)| m.id == id).unwrap_or(self.models[0])
    }
}

/// A recognition that did not give words: its code (`notFound`, `badArgs`, `tooLarge`, `notInstalled`, `model`,
/// `io`) and message.
#[derive(Debug, Clone, PartialEq)]
pub struct Fail {
    pub code: &'static str,
    pub error: String,
}

fn fail(code: &'static str, error: impl Into<String>) -> Fail {
    Fail { code, error: error.into() }
}

/// What one window gave: its words (seconds from the window's start), where its text ends, the language heard.
#[derive(Debug, Clone, PartialEq)]
pub struct Transcribed {
    pub words: Vec<Heard>,
    pub end: Option<f64>,
    pub language: Option<String>,
}

/// One window to recognise.
#[derive(Debug, Clone, PartialEq)]
pub struct Request<'a> {
    pub file: &'a str,
    pub offset: u64,
    pub length: u64,
    /// `auto`, `ko` or `en`.
    pub language: &'a str,
    pub model: &'a str,
    pub terms: &'a [String],
}

#[derive(Debug, Default)]
struct Fake {
    runtime: bool,
    models: Vec<&'static str>,
    delay_ms: u64,
    load_ms: u64,
    stop_after: f64,
}

/// Where a setup reports its progress, from any thread.
pub type Report = Arc<dyn Fn(Progress) + Send + Sync>;

/// How many setups, windows and cancels ran (tests).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub setups: u32,
    pub windows: u32,
    pub cancelled: u32,
}

enum Kind {
    Fake { setup: String, state: Mutex<Fake> },
    Whisper { rt: Runtime, script: Option<PathBuf> },
}

/// Speech recognition of this editor, shared by its threads.
pub struct Speech {
    kind: Kind,
    files: Arc<SoundFiles>,
    engine: Arc<Mutex<(EngineState, Option<&'static str>)>>,
    sidecar: Mutex<Option<Sidecar>>,
    idle_ms: Arc<AtomicU64>,
    setup_job: Mutex<Option<Job>>,
    stats: Mutex<Stats>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Speech {
    /// The backend the environment asks for (`PYIDE_WHISPER_BACKEND`, `PYIDE_WHISPER_FAKE_SETUP`), its sound files in
    /// `files`.
    pub fn from_env(files: Arc<SoundFiles>) -> Arc<Speech> {
        if std::env::var("PYIDE_WHISPER_BACKEND").is_ok_and(|v| v == "fake") {
            return Speech::fake(&std::env::var("PYIDE_WHISPER_FAKE_SETUP").unwrap_or_default(), files);
        }
        Speech::new(Kind::Whisper { rt: Runtime::shared(), script: cut_sidecar::script("whisper_server.py") }, files)
    }

    /// The test backend; `setup` is the `PYIDE_WHISPER_FAKE_SETUP` word (empty: everything is installed).
    pub fn fake(setup: &str, files: Arc<SoundFiles>) -> Arc<Speech> {
        let ready = setup.is_empty();
        let state = Fake {
            runtime: ready,
            models: if ready { MODELS.iter().map(|m| m.id).collect() } else { Vec::new() },
            ..Fake::default()
        };
        Speech::new(Kind::Fake { setup: setup.to_owned(), state: Mutex::new(state) }, files)
    }

    fn new(kind: Kind, files: Arc<SoundFiles>) -> Arc<Speech> {
        Arc::new(Speech {
            kind,
            files,
            engine: Arc::default(),
            sidecar: Mutex::new(None),
            idle_ms: Arc::new(AtomicU64::new(cut_sidecar::idle_ms_of(None))),
            setup_job: Mutex::new(None),
            stats: Mutex::new(Stats::default()),
        })
    }

    /// The temp files of sound the windows are read from (shared with speakers and voice isolation).
    pub fn files(&self) -> &Arc<SoundFiles> {
        &self.files
    }

    pub fn stats(&self) -> Stats {
        *lock(&self.stats)
    }

    pub fn engine(&self) -> EngineState {
        lock(&self.engine).0
    }

    fn installed(&self, m: &Model) -> bool {
        match &self.kind {
            Kind::Fake { state, .. } => lock(state).models.contains(&m.id),
            Kind::Whisper { .. } => NEEDED.iter().all(|f| cut_sidecar::hf::cached_file(m.repo, f).is_some()),
        }
    }

    fn runtime_ready(&self) -> bool {
        match &self.kind {
            Kind::Fake { state, .. } => lock(state).runtime,
            Kind::Whisper { rt, .. } => {
                rt.python_ready()
                    && rt.torch_on_disk().is_some_and(|v| cut_sidecar::usable(&v))
                    && PACKAGES.iter().all(|p| rt.importable(p))
            }
        }
    }

    pub fn status(&self) -> Status {
        Status {
            fake: matches!(self.kind, Kind::Fake { .. }),
            runtime: self.runtime_ready(),
            runtime_bytes: RUNTIME_BYTES,
            models: MODELS.iter().map(|m| (*m, self.installed(m))).collect(),
            engine: self.engine(),
        }
    }

    /// The idle timeout from `ai.idleUnloadMinutes`.
    pub fn configure(&self, minutes: Option<&Json>) {
        self.idle_ms.store(cut_sidecar::idle_ms_of(minutes), Ordering::Relaxed);
        if let Some(s) = lock(&self.sidecar).as_ref() {
            s.idle();
        }
    }

    /// The fake's knobs (`testConfig`): ms per window, ms the next model load takes, the first window's text stopping
    /// after `stop_after` s (0 off), the models on this PC, the model unloaded.
    pub fn test_config(
        &self,
        delay_ms: Option<u64>,
        load_ms: Option<u64>,
        stop_after: Option<f64>,
        installed: Option<&[&str]>,
        unload: bool,
    ) -> bool {
        let Kind::Fake { state, .. } = &self.kind else { return false };
        let mut f = lock(state);
        if let Some(v) = delay_ms {
            f.delay_ms = v;
        }
        if let Some(v) = load_ms {
            f.load_ms = v;
        }
        if let Some(v) = stop_after {
            f.stop_after = v.max(0.0);
        }
        if let Some(list) = installed {
            f.models = MODELS.iter().map(|m| m.id).filter(|id| list.contains(id)).collect();
        }
        if unload {
            *lock(&self.engine) = (EngineState::Idle, None);
        }
        true
    }

    /// Recognises one window of a sound file; `cancel` stops it (`Ok(None)`).
    pub fn transcribe(&self, r: &Request<'_>, cancelled: &dyn Fn() -> bool) -> Result<Option<Transcribed>, Fail> {
        let (_, total) = self.files.info(r.file).ok_or_else(|| fail("notFound", "no such sound file"))?;
        if r.length == 0 {
            return Err(fail("badArgs", "transcribe takes an offset and a length in samples"));
        }
        if r.length > MAX_WINDOW {
            return Err(fail("tooLarge", "one window is 31 s at most"));
        }
        let language = if matches!(r.language, "auto" | "ko" | "en") { r.language } else { "auto" };
        let terms = terms_of(r.terms);
        let m = model_of(r.model);
        if !self.runtime_ready() || !self.installed(&m) {
            return Err(fail("notInstalled", format!("{} is not installed", m.name)));
        }
        lock(&self.stats).windows += 1;
        let samples = self.files.read(r.file, r.offset, r.length).map_err(|e| fail(e.code(), e.message()))?;
        match &self.kind {
            Kind::Fake { state, .. } => {
                let (delay, load, stop_after) = {
                    let f = lock(state);
                    (f.delay_ms, f.load_ms, f.stop_after)
                };
                let loaded = *lock(&self.engine) == (EngineState::Ready, Some(m.id));
                if !loaded {
                    *lock(&self.engine) = (EngineState::Loading, Some(m.id));
                    std::thread::sleep(Duration::from_millis(load));
                    *lock(&self.engine) = (EngineState::Ready, Some(m.id));
                }
                let until = std::time::Instant::now() + Duration::from_millis(delay);
                while std::time::Instant::now() < until {
                    if cancelled() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                if cancelled() {
                    lock(&self.stats).cancelled += 1;
                    return Ok(None);
                }
                let english = language == "en";
                let mut heard = words::fake_words(&samples, r.offset, total, english, &terms);
                let mut end = None;
                // like Whisper under music: the file's first window ends after stop_after seconds of text
                if stop_after > 0.0 && r.offset == 0 {
                    heard.retain(|w| w.t0 < stop_after);
                    end = heard.last().map(|w| w.t1);
                }
                Ok(Some(Transcribed { words: heard, end, language: Some(if english { "en" } else { "ko" }.into()) }))
            }
            Kind::Whisper { rt, script } => {
                let script = script.as_ref().ok_or_else(|| fail("model", "whisper_server.py was not found"))?;
                let sc = self.server(rt, script);
                {
                    let mut e = lock(&self.engine);
                    if e.1 != Some(m.id) {
                        e.1 = Some(m.id);
                    }
                }
                let (path, _) = self.files.info(r.file).ok_or_else(|| fail("notFound", "no such sound file"))?;
                let job = sc.send(json!({
                    "op": "transcribe", "model": m.repo, "file": path.display().to_string(),
                    "offset": r.offset, "length": r.length, "language": language, "terms": terms,
                }));
                let mut asked = false;
                let reply = loop {
                    if let Some(v) = job.wait_for(Duration::from_millis(50)) {
                        break v;
                    }
                    if !asked && cancelled() {
                        asked = true;
                        sc.notify(&json!({ "op": "cancel", "target": job.id }));
                    }
                };
                if reply.get("cancelled").and_then(Json::as_bool) == Some(true) {
                    lock(&self.stats).cancelled += 1;
                    return Ok(None);
                }
                if let Some(e) = reply.get("error").filter(|e| !e.is_null()) {
                    return Err(fail("model", e.as_str().map_or_else(|| e.to_string(), str::to_owned)));
                }
                let heard: Vec<Heard> = reply
                    .get("words")
                    .and_then(Json::as_array)
                    .map(|ws| ws.iter().filter_map(heard_of).collect())
                    .unwrap_or_default();
                Ok(Some(Transcribed {
                    words: words::refine(&samples, &heard),
                    end: reply.get("end").and_then(Json::as_f64),
                    language: reply.get("language").and_then(Json::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
                }))
            }
        }
    }

    fn server(&self, rt: &Runtime, script: &std::path::Path) -> Sidecar {
        let mut g = lock(&self.sidecar);
        if let Some(s) = g.as_ref().filter(|s| s.alive()) {
            return s.clone();
        }
        let mut spec = Spec::python(rt, script);
        // the model was downloaded when the person asked; loading it never goes to the network
        spec.env = [("HF_HUB_OFFLINE", "1"), ("TRANSFORMERS_OFFLINE", "1"), ("TRANSFORMERS_VERBOSITY", "error")]
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        spec.idle_ms = self.idle_ms.clone();
        let engine = self.engine.clone();
        spec.on_event = Box::new(move |msg| match msg.get("event").and_then(Json::as_str) {
            Some("loading") => lock(&engine).0 = EngineState::Loading,
            Some("ready") => lock(&engine).0 = EngineState::Ready,
            _ => {}
        });
        let engine = self.engine.clone();
        spec.on_exit = Box::new(move |_| *lock(&engine) = (EngineState::Idle, None));
        let sc = Sidecar::start(spec);
        *g = Some(sc.clone());
        sc
    }

    /// Sets up the shared runtime, then the model (`cut:speechSetup`); `free` asks a folder's drive for its free bytes
    /// (`cut_decode::disk::free_space`).
    pub fn setup(
        &self,
        model_id: &str,
        progress: &Report,
        free: &dyn Fn(&std::path::Path) -> Option<u64>,
    ) -> Result<(), SetupFailure> {
        let m = model_of(model_id);
        lock(&self.stats).setups += 1;
        let out = match &self.kind {
            Kind::Fake { setup: word, state } => {
                let job = Job::new(|_| {});
                *lock(&self.setup_job) = Some(job.clone());
                let runtime_ready = lock(state).runtime;
                let p = cut_sidecar::fake::Pretend {
                    outcome: if word.is_empty() { "ok" } else { word },
                    runtime_ready,
                    runtime_text: "Collecting transformers",
                    bytes: m.bytes,
                    runtime_pause: Duration::from_millis(300),
                    step_pause: Duration::from_millis(120),
                };
                let r = cut_sidecar::fake::setup(p, &job, &|x| progress(x));
                if r.is_ok() {
                    let mut f = lock(state);
                    f.runtime = true;
                    if !f.models.contains(&m.id) {
                        f.models.push(m.id);
                    }
                }
                r
            }
            Kind::Whisper { rt, .. } => {
                if lock(&self.setup_job).is_some() {
                    return Err(SetupFailure {
                        code: SetupCode::Busy,
                        error: "a download is already running".into(),
                        log: String::new(),
                    });
                }
                self.setup_real(rt, &m, progress, free)
            }
        };
        *lock(&self.setup_job) = None;
        out
    }

    fn setup_real(
        &self,
        rt: &Runtime,
        m: &Model,
        progress: &Report,
        free: &dyn Fn(&std::path::Path) -> Option<u64>,
    ) -> Result<(), SetupFailure> {
        let tail = Arc::new(Mutex::new(String::new()));
        let phase = Arc::new(Mutex::new(Phase::Runtime));
        let (t, ph, report) = (tail.clone(), phase.clone(), progress.clone());
        let job = Job::new(move |text| {
            let mut g = lock(&t);
            g.push_str(text);
            let cut = g.len().saturating_sub(6000);
            let cut = (cut..=g.len()).find(|&i| g.is_char_boundary(i)).unwrap_or(g.len());
            g.drain(..cut);
            let line = text.split(['\n', '\r']).map(str::trim).rfind(|l| !l.is_empty());
            if let Some(line) = line {
                let short: String = line.chars().take(200).collect();
                report(Progress { phase: *lock(&ph), fraction: None, text: Some(short), bytes: None });
            }
        });
        *lock(&self.setup_job) = Some(job.clone());
        let fail_of = |message: String| {
            let t = lock(&tail).clone();
            let log: String = {
                let n = t.chars().count();
                t.chars().skip(n.saturating_sub(2000)).collect()
            };
            SetupFailure { code: cut_sidecar::classify(&format!("{message}\n{t}")), error: message, log }
        };
        let ready = self.runtime_ready();
        let need = (if self.installed(m) { 0.0 } else { m.bytes }) + (if ready { 0.0 } else { RUNTIME_BYTES }) + MARGIN;
        let space = |d: &std::path::Path| cut_sidecar::disk::free_bytes(d, free).map_or(f64::INFINITY, |n| n as f64);
        let have = space(&cut_sidecar::hf::cache_dir()).min(if ready { f64::INFINITY } else { space(&rt.dir) });
        if have < need {
            let gb = |x: f64, up: bool| {
                let v = x / 1e9 * 10.0;
                (if up { v.ceil() } else { v.floor() }) / 10.0
            };
            return Err(SetupFailure {
                code: SetupCode::Disk,
                error: format!("{} GB needed, {} GB free", gb(need, true), gb(have, false)),
                log: String::new(),
            });
        }
        let run = || -> Result<(), String> {
            if !ready {
                progress(Progress { phase: Phase::Runtime, fraction: None, text: None, bytes: None });
                cut_sidecar::exclusive(|| -> Result<(), String> {
                    setup::ensure_venv(&job, rt, None, true, &[])?;
                    if !setup::torch_usable(rt) {
                        setup::pip_install(&job, rt, &[cut_sidecar::TORCH])?;
                    }
                    let missing: Vec<String> =
                        PACKAGES.iter().filter(|p| !rt.importable(p)).map(|p| p.replace('_', "-")).collect();
                    if !missing.is_empty() {
                        let refs: Vec<&str> = missing.iter().map(String::as_str).collect();
                        setup::pip_install(&job, rt, &refs)?;
                    }
                    Ok(())
                })?;
            }
            if !self.installed(m) {
                *lock(&phase) = Phase::Download;
                let blobs = cut_sidecar::hf::repo_dir(m.repo).join("blobs");
                let done = AtomicBool::new(false);
                std::thread::scope(|s| {
                    s.spawn(|| {
                        while !done.load(Ordering::Relaxed) {
                            let f = (cut_sidecar::disk::dir_bytes(&blobs) as f64 / m.bytes).min(0.99);
                            progress(Progress {
                                phase: Phase::Download,
                                fraction: Some(f),
                                text: None,
                                bytes: Some(m.bytes),
                            });
                            std::thread::sleep(Duration::from_millis(500));
                        }
                    });
                    let r = setup::snapshot_download(&job, rt, m.repo, &PATTERNS);
                    done.store(true, Ordering::Relaxed);
                    r
                })?;
                if !self.installed(m) {
                    return Err(format!("{} was not downloaded completely", m.name));
                }
            }
            progress(Progress { phase: Phase::Done, fraction: Some(1.0), text: None, bytes: None });
            Ok(())
        };
        run().map_err(fail_of)
    }

    /// Stops a running setup.
    pub fn cancel_setup(&self) {
        if let Some(j) = lock(&self.setup_job).as_ref() {
            j.cancel();
        }
    }

    /// The server ends and every sound file goes.
    pub fn dispose(&self) {
        self.files.dispose();
        if let Some(s) = lock(&self.sidecar).take() {
            s.kill();
        }
    }
}

/// `[t0, t1, text, lead?, p?]` of the server.
fn heard_of(v: &Json) -> Option<Heard> {
    let a = v.as_array()?;
    Some(Heard {
        t0: a.first()?.as_f64()?,
        t1: a.get(1)?.as_f64()?,
        text: a
            .get(2)
            .and_then(Json::as_str)
            .map_or_else(|| a.get(2).map(Json::to_string).unwrap_or_default(), str::to_owned),
        lead: a.get(3).is_some_and(|x| x.as_f64().is_some_and(|n| n != 0.0) || x.as_bool() == Some(true)),
        p: a.get(4).and_then(Json::as_f64),
    })
}
