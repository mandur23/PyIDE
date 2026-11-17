//! What the tools need of the editor beyond its commands (the JavaScript page's `services`, ui-assistant.js and
//! ui-control.js): the frame, silences, playback, run_action, the Automation jobs, media in, saving, the ask-first
//! exports, the export queue and proxies. A service a host does not have answers `None`, and the tool refuses as the
//! JavaScript does when the service is missing ("… is not available here."). The shell's host is `shell_host.rs`;
//! tests use the editor state alone.
//!
//! A service that takes time (a dialog that waits for the user, a job) gives a [`Task`]: the page polls it each frame
//! until it has its answer, with the call's [`Live`] (Stop, progress).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cut_model::Id;
use cut_time::Ticks;
use serde_json::Value as Json;

use crate::state::App;

/// A step of work polled until it gives its answer (`None`: not yet).
pub type Task<T> = Box<dyn FnMut(&mut dyn Host, &Live) -> Option<T>>;

/// A long call's progress (`env.progress(fraction, text)`), as the page reports it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub fraction: Option<f64>,
    pub text: String,
}

/// What a running call shares with the server: Stop (`env.signal`) and its progress.
#[derive(Debug, Clone, Default)]
pub struct Live {
    abort: Arc<AtomicBool>,
    progress: Arc<Mutex<Option<Progress>>>,
    /// Each report, counted: the server takes a report as a sign of life.
    reports: Arc<std::sync::atomic::AtomicU64>,
}

impl Live {
    pub fn abort(&self) {
        self.abort.store(true, Ordering::SeqCst);
    }

    pub fn aborted(&self) -> bool {
        self.abort.load(Ordering::SeqCst)
    }

    /// `progress(fraction, text)`: a fraction outside 0..1 is clamped, a missing one is `None`.
    pub fn progress(&self, fraction: Option<f64>, text: &str) {
        let fraction = fraction.filter(|f| f.is_finite()).map(|f| f.clamp(0.0, 1.0));
        let text: String = text.chars().take(200).collect();
        if let Ok(mut p) = self.progress.lock() {
            *p = Some(Progress { fraction, text });
        }
        self.reports.fetch_add(1, Ordering::SeqCst);
    }

    pub fn last(&self) -> Option<Progress> {
        self.progress.lock().ok().and_then(|p| p.clone())
    }

    pub fn reports(&self) -> u64 {
        self.reports.load(Ordering::SeqCst)
    }
}

/// The editor as the tools see it.
pub trait Host {
    fn app(&self) -> &App;
    fn app_mut(&mut self) -> &mut App;
    /// The shell, when the host is the editor's window (the services that need its screens).
    fn shell(&mut self) -> Option<&mut crate::shell::Shell> {
        None
    }

    /// Whether the program monitor plays.
    fn playing(&self) -> bool {
        false
    }
    /// Whether a media item's file is missing (`services.offline`).
    fn offline(&self, _media: Id) -> bool {
        false
    }
    /// The program monitor's picture as a PNG: `{ok, base64, width, height}` or `{ok: false, error}`.
    fn frame(&mut self, _seq: Id, _t: Ticks, _width: u32) -> Option<Task<Json>> {
        None
    }
    /// What is said in the sequence: segments `(start s, end s, text)`.
    fn transcript(&mut self, _seq: Id) -> Option<Vec<(f64, f64, String)>> {
        None
    }
    /// The silences Remove Silence would cut: `{ranges: [[a, b] ticks], tracks}` or null.
    fn silence(&mut self, _seq: Id, _threshold: f64, _min_length: f64) -> Option<Task<Json>> {
        None
    }
    fn seek(&mut self, t: Ticks) {
        self.app_mut().set_time(t);
    }
    fn play(&mut self) {}
    fn stop(&mut self) {}
    /// Whether [`Host::action`] runs actions (`services.action`).
    fn can_act(&self) -> bool {
        false
    }
    /// run_action's run of a keyboard or menu action: `{ran, toasts}`.
    fn action(&mut self, _id: &str, _panel: Option<&str>) -> Option<Json> {
        None
    }
    /// What the person sees beyond the state (workspace, snapping, panels, track heights), compared before and after.
    fn view(&mut self) -> Json {
        Json::Null
    }
    /// How many clips the clipboard holds.
    fn clipboard(&self) -> usize {
        0
    }
    /// An Automation job without its dialog: `{ok, changed, value, at, seqId}`, `{declined}`, `{cancelled}` or
    /// `{ok: false, error}`.
    fn automation(&mut self, _action: &str, _args: &Json, _seq: Id) -> Option<Task<Json>> {
        None
    }
    /// Media in: `{ok, ids, captionTracks, failed}`, `{declined}` or `{ok: false, error}`.
    fn import_media(
        &mut self,
        _paths: Option<Vec<String>>,
        _folder: bool,
        _bin: Option<Id>,
        _seq: Id,
    ) -> Option<Task<Json>> {
        None
    }
    /// Saves the project: `{ok, name}`, `{declined}` or `{ok: false, error}`.
    fn save(&mut self) -> Option<Task<Json>> {
        None
    }
    /// Asks the user, then queues the export: `{ok, name, job}`, `{ok: false, declined}` or `{ok: false, error}`.
    fn export_ask(&mut self, _request: Json) -> Option<Task<Json>> {
        None
    }
    /// Follows a queued export: `{ok}`, `{ok: false, cancelled}` or `{ok: false, error}`.
    fn export_wait(&mut self, _job: u64) -> Option<Task<Json>> {
        None
    }
    /// Asks, then writes a PNG of a frame: `{ok, name}` or `{ok: false, declined | error}`.
    fn export_frame(&mut self, _seq: Id, _t: Ticks, _file: Option<String>) -> Option<Task<Json>> {
        None
    }
    /// Asks, then writes a caption file: `{ok, name, count}` or `{ok: false, declined | error}`.
    fn export_captions(
        &mut self,
        _seq: Id,
        _track: Option<Id>,
        _format: &str,
        _file: Option<String>,
    ) -> Option<Task<Json>> {
        None
    }
    /// The export queue's jobs: `[{id, name, seqName, presetName, state, fraction, error}]`.
    fn queue_jobs(&mut self) -> Option<Vec<Json>> {
        None
    }
    /// cancel, retry, remove (`id`) or clearFinished on the queue -> whether it was done.
    fn queue_do(&mut self, _action: &str, _id: u64) -> bool {
        false
    }
    /// Whether the proxy services are there (`services.proxies`).
    fn has_proxies(&self) -> bool {
        false
    }
    /// A media item's proxy: `{proxy: state, progress?, error?}`.
    fn proxy_state(&mut self, _media: Id) -> Option<Json> {
        None
    }
    /// Queues proxies for these media -> how many were queued.
    fn proxy_create(&mut self, _media: &[Id]) -> usize {
        0
    }
    /// Until each media's proxy job ends; Stop cancels the ones not done: `{done, cancelled}`.
    fn proxy_wait(&mut self, _media: Vec<Id>) -> Option<Task<Json>> {
        None
    }
    /// The clips an edit changed flash on the timeline.
    fn flash(&mut self, _clips: &[Id]) {}
    /// Makes a caption track the one the program monitor draws.
    fn show_caption_track(&mut self, _seq: Id, _track: Id) {}
}

/// The editor's state alone, with none of the page's services (the Node test's env with `effects` only).
pub struct Bare(pub App);

impl Host for Bare {
    fn app(&self) -> &App {
        &self.0
    }
    fn app_mut(&mut self) -> &mut App {
        &mut self.0
    }
}
