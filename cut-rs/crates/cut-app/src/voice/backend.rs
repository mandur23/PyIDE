//! The voice model (`main/cut/voice.js`): the vocals stem of HTDemucs on the CPU, in the JavaScript editor's Python
//! server (`main/ai/voice_server.py`) inside the shared AI environment of `cut-sidecar`. The sound comes in as a temp
//! file of 44.1 kHz float32, one or two channels interleaved; the vocals are a 16-bit WAV written as `.part` and
//! renamed when complete, so a cancelled or failed separation leaves nothing.
//!
//! `PYIDE_VOICE_BACKEND=fake` (tests): no Python; the vocals are the sound itself, at `delay` ms per second of it.
//! With `PYIDE_VOICE_FAKE_SETUP=ok|offline|disk|noPython|noTorch` the model and runtime start missing and a setup
//! pretends to download them (`cut_sidecar::fake::setup`), then succeeds or fails with that code.
//!
//! Threads: every call blocks; the caller runs it on an analysis thread.

use std::collections::HashMap;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cut_sidecar::sound::SoundFiles;
use cut_sidecar::{Job, Phase, Progress, Runtime, SetupCode, SetupFailure, Sidecar, Spec};
use serde_json::{Value as Json, json};

use super::files::{RATE, part_of, wav_header};

pub const NAME: &str = "HTDemucs";
pub const REPO: &str = "adefossez/HTDemucs";
pub const BYTES: f64 = 84e6;
/// What the server imports (folders, or a module file, in the environment's site-packages).
const PACKAGES: [&str; 7] = ["demucs", "einops", "julius", "safetensors", "soundfile.py", "tqdm", "numpy"];
/// demucs is installed without its dependencies; these are the ones the separation imports.
const PIP_DEPS: [&str; 7] = ["einops", "julius", "safetensors", "soundfile", "tqdm", "numpy", "huggingface_hub"];
/// torch (CPU) when nothing can be reused.
const RUNTIME_BYTES: f64 = 2.6e9;
const PACKAGES_BYTES: f64 = 60e6;
const MARGIN: f64 = 300e6;

/// The model's state, for the progress line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Idle,
    Loading,
    Ready,
}

/// What the model and its runtime are now (`status`).
#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    /// `fake` or `demucs`.
    pub backend: &'static str,
    pub runtime: bool,
    pub installed: bool,
    pub runtime_bytes: f64,
}

/// A failed separation: the JavaScript's code (`notInstalled`, `notFound`, `io`, `disk`, `model`, `cancelled`).
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub error: String,
}

fn fail(code: &'static str, error: impl Into<String>) -> Failure {
    Failure { code, error: error.into() }
}

/// What the calls count (`stats`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub setups: u32,
    pub separations: u32,
    pub cancelled: u32,
}

/// A temp file of sound: its id in the files, and its channels (interleaved).
#[derive(Clone, Copy)]
pub struct Sound<'a> {
    pub files: &'a SoundFiles,
    pub id: &'a str,
    pub channels: u16,
}

enum Kind {
    Fake {
        setup: String,
        runtime: AtomicBool,
        model: AtomicBool,
        delay: AtomicU64,
    },
    Real {
        rt: Runtime,
        server: Mutex<Option<Sidecar>>,
        idle_ms: Arc<AtomicU64>,
        jobs: Arc<Mutex<HashMap<u64, Sender<f64>>>>,
    },
}

/// The voice model of this editor.
pub struct Backend {
    kind: Kind,
    engine: Arc<AtomicU8>,
    stats: Mutex<Stats>,
}

impl Backend {
    /// The backend `PYIDE_VOICE_BACKEND` and `PYIDE_VOICE_FAKE_SETUP` choose.
    pub fn from_env() -> Arc<Backend> {
        let var = |k: &str| std::env::var(k).unwrap_or_default();
        if var("PYIDE_VOICE_BACKEND") == "fake" {
            return Backend::fake(&var("PYIDE_VOICE_FAKE_SETUP"));
        }
        Arc::new(Backend {
            kind: Kind::Real {
                rt: Runtime::shared(),
                server: Mutex::new(None),
                idle_ms: Arc::new(AtomicU64::new(cut_sidecar::idle_ms_of(None))),
                jobs: Arc::default(),
            },
            engine: Arc::default(),
            stats: Mutex::default(),
        })
    }

    /// The fake; `setup` empty: everything is there, else the word the pretend download ends with.
    pub fn fake(setup: &str) -> Arc<Backend> {
        let ready = setup.is_empty();
        Arc::new(Backend {
            kind: Kind::Fake {
                setup: setup.to_owned(),
                runtime: AtomicBool::new(ready),
                model: AtomicBool::new(ready),
                delay: AtomicU64::new(0),
            },
            engine: Arc::default(),
            stats: Mutex::default(),
        })
    }

    fn stats_mut(&self) -> std::sync::MutexGuard<'_, Stats> {
        self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn stats(&self) -> Stats {
        *self.stats_mut()
    }

    /// Fake only: ms of work per second of sound (`testConfig({delay})`).
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

    pub fn engine(&self) -> Engine {
        match self.engine.load(Ordering::Relaxed) {
            1 => Engine::Loading,
            2 => Engine::Ready,
            _ => Engine::Idle,
        }
    }

    /// The weight files `htdemucs.yaml` names (`models: ['955717e8']`), when all are there.
    fn weights() -> Option<Vec<PathBuf>> {
        let yaml = cut_sidecar::hf::cached_file(REPO, "htdemucs.yaml")?;
        let text = std::fs::read_to_string(&yaml).ok()?;
        let at = text.find("models:")?;
        let rest = text[at + 7..].trim_start().strip_prefix('[')?;
        let list = &rest[..rest.find(']')?];
        let dir = yaml.parent()?;
        let files: Vec<PathBuf> = list
            .split(',')
            .map(|s| s.trim().trim_matches(['\'', '"']))
            .filter(|s| !s.is_empty())
            .map(|n| dir.join(format!("{n}.safetensors")))
            .collect();
        (!files.is_empty() && files.iter().all(|f| f.exists())).then_some(files)
    }

    fn installed(&self) -> bool {
        match &self.kind {
            Kind::Fake { model, .. } => model.load(Ordering::Relaxed),
            Kind::Real { .. } => Self::weights().is_some(),
        }
    }

    fn torch_ready(rt: &Runtime) -> bool {
        rt.torch_on_disk().is_some_and(|v| cut_sidecar::usable(&v))
    }

    fn runtime_ready(&self) -> bool {
        match &self.kind {
            Kind::Fake { runtime, .. } => runtime.load(Ordering::Relaxed),
            Kind::Real { rt, .. } => {
                rt.python_ready() && Self::torch_ready(rt) && PACKAGES.iter().all(|p| rt.importable(p))
            }
        }
    }

    pub fn status(&self) -> Status {
        let (backend, cheap) = match &self.kind {
            Kind::Fake { .. } => ("fake", true),
            Kind::Real { rt, .. } => ("demucs", Self::torch_ready(rt)),
        };
        Status {
            backend,
            runtime: self.runtime_ready(),
            installed: self.installed(),
            runtime_bytes: if cheap { PACKAGES_BYTES } else { RUNTIME_BYTES },
        }
    }

    /// The vocals of the temp file `id` (`channels` interleaved, padded to `frames`) written to `out`: through
    /// `out.part`, renamed when complete and removed otherwise. `progress` gets the fraction done.
    pub fn separate(
        &self,
        sound: Sound<'_>,
        frames: u64,
        out: &Path,
        progress: &dyn Fn(f64),
        cancel: &AtomicBool,
    ) -> Result<u64, Failure> {
        let channels = sound.channels;
        let Some((file, samples)) = sound.files.info(sound.id) else {
            return Err(fail("notFound", "no such sound file"));
        };
        if !self.runtime_ready() || !self.installed() {
            return Err(fail("notInstalled", "HTDemucs is not installed"));
        }
        let dir = out.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(dir).map_err(|e| fail("io", e.to_string()))?;
        let have = samples / u64::from(channels.max(1));
        let total = have.max(frames);
        let need = (total * u64::from(channels) * 2) as f64 + 1e6;
        if cut_sidecar::disk::free_bytes(dir, cut_decode::disk::free_space).is_some_and(|f| (f as f64) < need) {
            return Err(fail("disk", format!("{} MB needed in {}", (need / 1e6).ceil(), dir.display())));
        }
        let part = part_of(out);
        {
            let mut st = self.stats_mut();
            st.separations += 1;
        }
        let r = match &self.kind {
            Kind::Fake { delay, .. } => {
                fake_separate(sound, total, &part, progress, cancel, delay.load(Ordering::Relaxed))
            }
            Kind::Real { .. } => self.real_separate(&file, channels, frames, &part, progress, cancel),
        };
        let r = r.and_then(|n| std::fs::rename(&part, out).map(|()| n).map_err(|e| fail("io", e.to_string())));
        if let Err(e) = &r {
            let _ = std::fs::remove_file(&part);
            if e.code == "cancelled" {
                self.stats_mut().cancelled += 1;
            }
        }
        r
    }

    fn real_separate(
        &self,
        file: &Path,
        channels: u16,
        frames: u64,
        part: &Path,
        progress: &dyn Fn(f64),
        cancel: &AtomicBool,
    ) -> Result<u64, Failure> {
        let Kind::Real { rt, server, idle_ms, jobs } = &self.kind else { return Err(fail("model", "no model")) };
        let weights = Self::weights().ok_or_else(|| fail("notInstalled", "HTDemucs is not installed"))?;
        let sc = {
            let mut g = server.lock().unwrap_or_else(|e| e.into_inner());
            match g.as_ref().filter(|s| s.alive()) {
                Some(s) => s.clone(),
                None => {
                    let script = cut_sidecar::script("voice_server.py")
                        .ok_or_else(|| fail("model", "voice_server.py is missing"))?;
                    let mut spec = Spec::python(rt, &script);
                    spec.env.push(("HF_HUB_OFFLINE".into(), "1".into()));
                    spec.idle_ms = idle_ms.clone();
                    let (engine, jobs) = (self.engine.clone(), jobs.clone());
                    spec.on_event = Box::new(move |msg: Json| match msg.get("event").and_then(Json::as_str) {
                        Some("loading") => engine.store(1, Ordering::Relaxed),
                        Some("ready") => engine.store(2, Ordering::Relaxed),
                        Some("progress") => {
                            let id = msg.get("request").and_then(Json::as_u64).unwrap_or(0);
                            let f = msg.get("fraction").and_then(Json::as_f64).unwrap_or(0.0);
                            if let Some(tx) = jobs.lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
                                let _ = tx.send(f);
                            }
                        }
                        _ => {}
                    });
                    let engine = self.engine.clone();
                    spec.on_exit = Box::new(move |_| engine.store(0, Ordering::Relaxed));
                    let s = Sidecar::start(spec);
                    *g = Some(s.clone());
                    s
                }
            }
        };
        let (tx, rx) = channel();
        let reply = sc.send(json!({
            "op": "separate", "weights": weights, "file": file, "channels": channels, "frames": frames, "out": part,
        }));
        let target = reply.id;
        jobs.lock().unwrap_or_else(|e| e.into_inner()).insert(target, tx);
        let mut asked = false;
        let r = loop {
            if let Some(r) = reply.wait_for(Duration::from_millis(50)) {
                break r;
            }
            while let Ok(f) = rx.try_recv() {
                progress(f);
            }
            if cancel.load(Ordering::Relaxed) && !asked {
                sc.notify(&json!({ "op": "cancel", "target": target }));
                asked = true;
            }
        };
        jobs.lock().unwrap_or_else(|e| e.into_inner()).remove(&target);
        if r.get("cancelled").and_then(Json::as_bool) == Some(true) {
            return Err(fail("cancelled", "cancelled"));
        }
        if r.get("ok").and_then(Json::as_bool) != Some(true) {
            let e = r.get("error").and_then(Json::as_str).unwrap_or("the separation failed");
            return Err(fail("model", e));
        }
        Ok(r.get("frames").and_then(Json::as_u64).unwrap_or(frames))
    }

    /// Sets up the environment, PyTorch and Demucs, then the model; `job.cancel()` stops it with `cancelled`.
    pub fn setup(&self, job: &Job, progress: &(dyn Fn(Progress) + Sync)) -> Result<(), SetupFailure> {
        self.stats_mut().setups += 1;
        match &self.kind {
            Kind::Fake { setup, runtime, model, .. } => {
                let p = cut_sidecar::fake::Pretend {
                    outcome: setup,
                    runtime_ready: runtime.load(Ordering::Relaxed),
                    runtime_text: "Collecting demucs",
                    bytes: BYTES,
                    runtime_pause: Duration::from_millis(300),
                    step_pause: Duration::from_millis(100),
                };
                cut_sidecar::fake::setup(p, job, progress)?;
                runtime.store(true, Ordering::Relaxed);
                model.store(true, Ordering::Relaxed);
                Ok(())
            }
            Kind::Real { rt, .. } => self.setup_real(rt, job, progress),
        }
    }

    fn setup_real(&self, rt: &Runtime, job: &Job, progress: &(dyn Fn(Progress) + Sync)) -> Result<(), SetupFailure> {
        let failure = |error: String| SetupFailure { code: cut_sidecar::classify(&error), error, log: String::new() };
        let ready = self.runtime_ready();
        let need =
            if self.installed() { 0.0 } else { BYTES } + if ready { 0.0 } else { self.status().runtime_bytes } + MARGIN;
        let free_of = |d: &Path| {
            cut_sidecar::disk::free_bytes(d, cut_decode::disk::free_space).map_or(f64::INFINITY, |b| b as f64)
        };
        let free = free_of(&cut_sidecar::hf::cache_dir()).min(if ready { f64::INFINITY } else { free_of(&rt.dir) });
        if free < need {
            return Err(SetupFailure {
                code: SetupCode::Disk,
                error: format!(
                    "{} GB needed, {} GB free",
                    (need / 1e9 * 10.0).ceil() / 10.0,
                    (free / 1e9 * 10.0).floor() / 10.0
                ),
                log: String::new(),
            });
        }
        if !ready {
            progress(Progress { phase: Phase::Runtime, fraction: None, text: None, bytes: None });
            cut_sidecar::exclusive(|| {
                cut_sidecar::setup::ensure_venv(job, rt, None, true, &[])?;
                if !cut_sidecar::setup::torch_usable(rt) {
                    cut_sidecar::setup::pip_install(job, rt, &[cut_sidecar::TORCH])?;
                }
                if !rt.importable("demucs") {
                    cut_sidecar::setup::pip_install(job, rt, &["--no-deps", "demucs"])?;
                }
                cut_sidecar::setup::pip_install(job, rt, &PIP_DEPS)
            })
            .map_err(failure)?;
        }
        if !self.installed() {
            let blobs = cut_sidecar::hf::repo_dir(REPO).join("blobs");
            let done = AtomicBool::new(false);
            let tick = || {
                let n = cut_sidecar::disk::dir_bytes(&blobs) as f64;
                progress(Progress {
                    phase: Phase::Download,
                    fraction: Some((n / BYTES).min(0.99)),
                    text: None,
                    bytes: Some(BYTES),
                });
            };
            let r = std::thread::scope(|scope| {
                scope.spawn(|| {
                    while !done.load(Ordering::Relaxed) {
                        tick();
                        std::thread::sleep(Duration::from_millis(500));
                    }
                });
                let r = cut_sidecar::setup::hf_download(job, rt, REPO, None);
                done.store(true, Ordering::Relaxed);
                r
            });
            r.map_err(failure)?;
            if !self.installed() {
                return Err(failure(format!("{NAME} was not downloaded completely")));
            }
        }
        progress(Progress { phase: Phase::Done, fraction: Some(1.0), text: None, bytes: None });
        Ok(())
    }
}

/// The fake's vocals: the sound itself as 16-bit PCM, in ten-second blocks, padded with silence to `total` frames.
fn fake_separate(
    sound: Sound<'_>,
    total: u64,
    part: &Path,
    progress: &dyn Fn(f64),
    cancel: &AtomicBool,
    delay: u64,
) -> Result<u64, Failure> {
    let Sound { files, id, channels } = sound;
    let have = files.info(id).map_or(0, |(_, n)| n) / u64::from(channels.max(1));
    let io = |e: std::io::Error| fail("model", e.to_string());
    let mut fh = std::fs::File::create(part).map_err(io)?;
    fh.write_all(&wav_header(total, channels)).map_err(io)?;
    let ch = u64::from(channels);
    let step = u64::from(RATE) * 10;
    let mut at = 0;
    while at < total && !cancel.load(Ordering::Relaxed) {
        let n = step.min(total - at);
        let mut pcm = vec![0u8; (n * ch * 2) as usize];
        let m = n.min(have.saturating_sub(at));
        if m > 0 {
            let raw = files.read(id, at * ch, m * ch).map_err(|e| fail("model", e.message()))?;
            for (i, x) in raw.iter().enumerate() {
                let v = cut_audio::util::js_round(f64::from(x.clamp(-1.0, 1.0)) * 32767.0) as i16;
                pcm[2 * i..2 * i + 2].copy_from_slice(&v.to_le_bytes());
            }
        }
        fh.seek(SeekFrom::Start(44 + at * ch * 2)).map_err(io)?;
        fh.write_all(&pcm).map_err(io)?;
        progress(1f64.min((at + n) as f64 / total as f64));
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay * n / u64::from(RATE)));
        }
        at += n;
    }
    drop(fh);
    if cancel.load(Ordering::Relaxed) { Err(fail("cancelled", "cancelled")) } else { Ok(total) }
}
