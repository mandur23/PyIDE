//! The speaker model (`main/cut/speakers.js`): one embedding per window of speech, from WeSpeaker ResNet34-LM in the
//! JavaScript editor's Python server (`main/ai/speaker_server.py`) inside the shared AI environment of `cut-sidecar`.
//! The windows are read from the temp sound file speech recognition streams in (`cut_sidecar::sound::SoundFiles`).
//!
//! `PYIDE_SPEAKERS_BACKEND=fake` (tests): no Python; a window's embedding is its sound's energy at 24 frequencies, so
//! tones of different pitch are different speakers. With `PYIDE_SPEAKERS_FAKE_SETUP=ok|offline|disk|noPython` the
//! model starts missing and a setup pretends to download it in five steps, then ends with that code.
//!
//! Threads: every call here blocks; the caller runs it on an analysis thread.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cut_sidecar::sound::SoundFiles;
use cut_sidecar::{Job, Phase, Progress, Runtime, SetupCode, SetupFailure, Sidecar, Spec};
use serde_json::{Value as Json, json};

/// The model: its name, Hugging Face repo, size and files.
pub const NAME: &str = "WeSpeaker ResNet34-LM";
pub const REPO: &str = "Wespeaker/wespeaker-voxceleb-resnet34-LM";
pub const FILE: &str = "voxceleb_resnet34_LM.onnx";
pub const FILES: [&str; 2] = ["voxceleb_resnet34_LM.onnx", "config.yaml"];
pub const BYTES: f64 = 26.5e6;
const PACKAGES: [&str; 3] = ["onnxruntime", "numpy", "huggingface_hub"];
/// onnxruntime and numpy when the environment has neither.
pub const RUNTIME_BYTES: f64 = 80e6;
const MARGIN: f64 = 100e6;
/// The sound's rate.
pub const RATE: u64 = 16000;
const MAX_WINDOW: u64 = 30 * RATE;
const MAX_WINDOWS: usize = 20000;

/// What the model and its runtime are now (`status`).
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    /// `fake` or `wespeaker`.
    pub backend: &'static str,
    pub runtime: bool,
    pub installed: bool,
    pub runtime_bytes: f64,
}

/// A failed call: the JavaScript's code (`badArgs`, `notInstalled`, `notFound`, `model`, `cancelled`) and message.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub error: String,
}

fn fail(code: &'static str, error: impl Into<String>) -> Failure {
    Failure { code, error: error.into() }
}

/// One embedding of `dim` values per window, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct Embeddings {
    pub dim: usize,
    pub data: Vec<f32>,
}

/// What the calls count (`stats`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub setups: u32,
    pub embeds: u32,
    pub windows: u64,
    pub cancelled: u32,
}

/// The fake's frequencies: 24 log-spaced from 150 Hz to 4 kHz.
fn fake_freqs() -> [f64; 24] {
    std::array::from_fn(|k| 150.0 * (4000.0_f64 / 150.0).powf(k as f64 / 23.0))
}

/// The fake backend's embedding: the energy at 24 frequencies (Goertzel over 20 ms frames).
pub fn fake_embedding(x: &[f32]) -> Vec<f32> {
    let frame = 320;
    fake_freqs()
        .iter()
        .map(|f| {
            let c = 2.0 * ((2.0 * std::f64::consts::PI * f) / RATE as f64).cos();
            let mut e = 0.0;
            let mut a = 0;
            while a + frame <= x.len() {
                let (mut s1, mut s2) = (0.0, 0.0);
                for v in &x[a..a + frame] {
                    let s0 = f64::from(*v) + c * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                }
                e += s1 * s1 + s2 * s2 - c * s1 * s2;
                a += frame;
            }
            0.0_f64.max(e).sqrt() as f32
        })
        .collect()
}

/// Checks the windows `[offset, length]` in samples (at most 20000, each 30 s at most).
pub fn check_windows(windows: &[(u64, u64)]) -> Result<(), Failure> {
    if windows.len() > MAX_WINDOWS {
        return Err(fail("badArgs", "embed takes a list of windows"));
    }
    if windows.iter().any(|(_, n)| *n == 0 || *n > MAX_WINDOW) {
        return Err(fail("badArgs", "a window is [offset, length] in samples, at most 30 s"));
    }
    Ok(())
}

enum Kind {
    /// The pretend model: whether it is there, and the pause after each window (ms).
    Fake {
        setup: String,
        installed: AtomicBool,
        delay: AtomicU64,
    },
    Real {
        rt: Runtime,
        server: Mutex<Option<Sidecar>>,
        idle_ms: Arc<AtomicU64>,
    },
}

/// The speaker model of this editor; clones of the `Arc` share it.
pub struct Backend {
    kind: Kind,
    stats: Mutex<Stats>,
}

impl Backend {
    /// The backend `PYIDE_SPEAKERS_BACKEND` and `PYIDE_SPEAKERS_FAKE_SETUP` choose.
    pub fn from_env() -> Arc<Backend> {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        if var("PYIDE_SPEAKERS_BACKEND") == "fake" {
            Backend::fake(&var("PYIDE_SPEAKERS_FAKE_SETUP"))
        } else {
            Arc::new(Backend {
                kind: Kind::Real {
                    rt: Runtime::shared(),
                    server: Mutex::new(None),
                    idle_ms: Arc::new(AtomicU64::new(cut_sidecar::idle_ms_of(None))),
                },
                stats: Mutex::default(),
            })
        }
    }

    /// The fake backend; `setup` empty: the model is there, else the word the pretend download ends with.
    pub fn fake(setup: &str) -> Arc<Backend> {
        Arc::new(Backend {
            kind: Kind::Fake {
                setup: setup.to_owned(),
                installed: AtomicBool::new(setup.is_empty()),
                delay: AtomicU64::new(0),
            },
            stats: Mutex::default(),
        })
    }

    fn stats_mut(&self) -> std::sync::MutexGuard<'_, Stats> {
        self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn stats(&self) -> Stats {
        *self.stats_mut()
    }

    /// Fake only: the pause after each window (`testConfig({delay})`).
    pub fn set_delay(&self, ms: u64) {
        if let Kind::Fake { delay, .. } = &self.kind {
            delay.store(ms, Ordering::Relaxed);
        }
    }

    /// The `ai.idleUnloadMinutes` setting (`configure`).
    pub fn configure(&self, minutes: Option<&Json>) {
        if let Kind::Real { idle_ms, server, .. } = &self.kind {
            idle_ms.store(cut_sidecar::idle_ms_of(minutes), Ordering::Relaxed);
            if let Some(s) = server.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                s.idle();
            }
        }
    }

    fn installed(&self) -> bool {
        match &self.kind {
            Kind::Fake { installed, .. } => installed.load(Ordering::Relaxed),
            Kind::Real { .. } => FILES.iter().all(|f| cut_sidecar::hf::cached_file(REPO, f).is_some()),
        }
    }

    fn runtime_ready(&self) -> bool {
        match &self.kind {
            Kind::Fake { installed, .. } => installed.load(Ordering::Relaxed),
            Kind::Real { rt, .. } => rt.python_ready() && PACKAGES.iter().all(|p| rt.importable(p)),
        }
    }

    pub fn status(&self) -> Status {
        Status {
            backend: if matches!(self.kind, Kind::Fake { .. }) { "fake" } else { "wespeaker" },
            runtime: self.runtime_ready(),
            installed: self.installed(),
            runtime_bytes: RUNTIME_BYTES,
        }
    }

    /// The embeddings of `windows` (`[offset, length]` samples) of the sound file `id`; a `cancel` stops it between
    /// windows (the fake) or batches (the model) with `cancelled`.
    pub fn embed(
        &self,
        files: &SoundFiles,
        id: &str,
        windows: &[(u64, u64)],
        cancel: &AtomicBool,
    ) -> Result<Embeddings, Failure> {
        check_windows(windows)?;
        if !self.runtime_ready() || !self.installed() {
            return Err(fail("notInstalled", format!("{NAME} is not installed")));
        }
        let Some((file, _)) = files.info(id) else { return Err(fail("notFound", "no such sound file")) };
        {
            let mut st = self.stats_mut();
            st.embeds += 1;
            st.windows += windows.len() as u64;
        }
        let out = match &self.kind {
            Kind::Fake { delay, .. } => {
                let mut data = Vec::with_capacity(windows.len() * 24);
                for (o, n) in windows {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let x = files.read(id, *o, *n).map_err(|e| fail("notFound", e.message()))?;
                    data.extend(fake_embedding(&x));
                    let d = delay.load(Ordering::Relaxed);
                    if d > 0 {
                        std::thread::sleep(Duration::from_millis(d));
                    }
                }
                if cancel.load(Ordering::Relaxed) {
                    Err(fail("cancelled", "cancelled"))
                } else {
                    Ok(Embeddings { dim: 24, data })
                }
            }
            Kind::Real { rt, server, idle_ms } => {
                let model = cut_sidecar::hf::cached_file(REPO, FILE).ok_or_else(|| fail("notInstalled", "no model"))?;
                let sc = {
                    let mut g = server.lock().unwrap_or_else(|e| e.into_inner());
                    match g.as_ref().filter(|s| s.alive()) {
                        Some(s) => s.clone(),
                        None => {
                            let script = cut_sidecar::script("speaker_server.py")
                                .ok_or_else(|| fail("model", "speaker_server.py is missing"))?;
                            let mut spec = Spec::python(rt, &script);
                            spec.env.push(("HF_HUB_OFFLINE".into(), "1".into()));
                            spec.idle_ms = idle_ms.clone();
                            let s = Sidecar::start(spec);
                            *g = Some(s.clone());
                            s
                        }
                    }
                };
                let list: Vec<Json> = windows.iter().map(|(o, n)| json!([o, n])).collect();
                let reply = sc.send(json!({ "op": "embed", "model": model, "file": file, "windows": list }));
                let target = reply.id;
                let r = loop {
                    if let Some(r) = reply.wait_for(Duration::from_millis(50)) {
                        break r;
                    }
                    if cancel.load(Ordering::Relaxed) {
                        sc.notify(&json!({ "op": "cancel", "target": target }));
                        break reply.wait();
                    }
                };
                parse_reply(&r, windows.len())
            }
        };
        if out.as_ref().is_err_and(|e| e.code == "cancelled") {
            self.stats_mut().cancelled += 1;
        }
        out
    }

    /// Sets up onnxruntime in the shared environment, then the model; `job.cancel()` stops it with `cancelled`.
    pub fn setup(&self, job: &Job, progress: &dyn Fn(Progress)) -> Result<(), SetupFailure> {
        self.stats_mut().setups += 1;
        match &self.kind {
            Kind::Fake { setup, installed, .. } => {
                for i in 1..=5 {
                    if job.is_cancelled() {
                        return Err(SetupFailure {
                            code: SetupCode::Cancelled,
                            error: "Cancelled".into(),
                            log: String::new(),
                        });
                    }
                    if setup != "ok" && i == 3 {
                        return Err(SetupFailure {
                            code: SetupCode::parse(setup),
                            error: format!("pretend failure: {setup}"),
                            log: String::new(),
                        });
                    }
                    progress(Progress {
                        phase: Phase::Download,
                        fraction: Some(f64::from(i) / 5.0),
                        text: None,
                        bytes: Some(BYTES),
                    });
                    std::thread::sleep(Duration::from_millis(100));
                }
                installed.store(true, Ordering::Relaxed);
                progress(Progress { phase: Phase::Done, fraction: Some(1.0), text: None, bytes: None });
                Ok(())
            }
            Kind::Real { rt, .. } => self.setup_real(rt, job, progress),
        }
    }

    fn setup_real(&self, rt: &Runtime, job: &Job, progress: &dyn Fn(Progress)) -> Result<(), SetupFailure> {
        let failure = |error: String| SetupFailure { code: cut_sidecar::classify(&error), error, log: String::new() };
        let need = if self.installed() { 0.0 } else { BYTES }
            + if self.runtime_ready() { 0.0 } else { RUNTIME_BYTES }
            + MARGIN;
        let free_of = |d: &std::path::Path| {
            cut_sidecar::disk::free_bytes(d, cut_decode::disk::free_space).map_or(f64::INFINITY, |b| b as f64)
        };
        let free = free_of(&cut_sidecar::hf::cache_dir()).min(if self.runtime_ready() {
            f64::INFINITY
        } else {
            free_of(&rt.dir)
        });
        if free < need {
            return Err(SetupFailure {
                code: SetupCode::Disk,
                error: format!("{} GB needed, {} GB free", (need / 1e8).ceil() / 10.0, (free / 1e8).floor() / 10.0),
                log: String::new(),
            });
        }
        if !self.runtime_ready() {
            progress(Progress { phase: Phase::Runtime, fraction: None, text: None, bytes: None });
            cut_sidecar::exclusive(|| {
                cut_sidecar::setup::ensure_venv(job, rt, None, false, &[])?;
                let missing: Vec<String> =
                    PACKAGES.iter().filter(|p| !rt.importable(p)).map(|p| p.replace('_', "-")).collect();
                if missing.is_empty() {
                    return Ok(());
                }
                let args: Vec<&str> = missing.iter().map(String::as_str).collect();
                cut_sidecar::setup::pip_install(job, rt, &args)
            })
            .map_err(failure)?;
        }
        if !self.installed() {
            progress(Progress { phase: Phase::Download, fraction: None, text: None, bytes: Some(BYTES) });
            cut_sidecar::setup::snapshot_download(job, rt, REPO, &FILES).map_err(failure)?;
            if !self.installed() {
                return Err(failure(format!("{NAME} was not downloaded completely")));
            }
        }
        progress(Progress { phase: Phase::Done, fraction: Some(1.0), text: None, bytes: None });
        Ok(())
    }
}

/// The server's answer -> the embeddings, checked against the windows asked for.
fn parse_reply(r: &Json, windows: usize) -> Result<Embeddings, Failure> {
    if r.get("cancelled").and_then(Json::as_bool) == Some(true) {
        return Err(fail("cancelled", "cancelled"));
    }
    if let Some(e) = r.get("error") {
        return Err(fail("model", e.as_str().map_or_else(|| e.to_string(), str::to_owned)));
    }
    let dim = r.get("dim").and_then(Json::as_u64).unwrap_or(0) as usize;
    let bytes =
        r.get("embeddings").and_then(Json::as_str).and_then(cut_engine::lumetri::from_base64).unwrap_or_default();
    if dim == 0 || bytes.len() != windows * dim * 4 {
        return Err(fail("model", "the embeddings do not match the windows"));
    }
    Ok(Embeddings { dim, data: bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect() })
}
