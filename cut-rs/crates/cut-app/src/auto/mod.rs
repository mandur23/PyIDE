//! Automation by signal analysis (`ui-auto.js`): Auto Ducking ([`duck`]), Remove Silence ([`silence`]), Auto
//! Color ([`color`]), Detect Scene Changes ([`scenes`]) and Detect Beats ([`beats`]), with the progress box their measurements run under ([`Job`]). The loudness matches are in
//! [`crate::audio::loudness`].
//!
//! Threads: each analysis reads its files on a thread of its own (one at a time, as the JavaScript's `task`); the
//! window keeps drawing and takes the result when it is there. An analysis that decodes video waits while the player
//! plays ("Paused while playing"). Every result is one undo step.

pub mod beats;
pub mod color;
pub mod duck;
pub mod levels;
pub mod pictures;
pub mod scenes;
pub mod silence;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use eframe::egui::{self, Align2, ProgressBar, Vec2};
use serde_json::{Map, Value as Json};

use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;

/// What an analysis thread is handed: whether to stop, whether to wait for the player, and where to put its progress.
#[derive(Clone)]
pub struct Step {
    progress: Arc<AtomicU32>,
    cancel: Arc<AtomicBool>,
    playing: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    video: bool,
}

/// An analysis stopped by its Cancel.
#[derive(Debug, PartialEq)]
pub struct Cancelled;

/// Why an analysis ended early: `Ok(text)` it failed (the text in English, translated on the UI thread), `Err` it was
/// cancelled.
pub type Stop = Result<String, Cancelled>;

impl Step {
    /// Between two reads (`ctx.step`): `Err` once cancelled; a task that decodes video waits here while the player
    /// plays.
    pub fn step(&self) -> Result<(), Cancelled> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(Cancelled);
        }
        while self.video && self.playing.load(Ordering::Relaxed) && !self.cancel.load(Ordering::Relaxed) {
            self.paused.store(true, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(20));
        }
        self.paused.store(false, Ordering::Relaxed);
        if self.cancel.load(Ordering::Relaxed) { Err(Cancelled) } else { Ok(()) }
    }

    /// The flag a Cancel sets, for a model that is told to stop.
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    /// Progress 0..1.
    pub fn progress(&self, fraction: f64) {
        self.progress.store((fraction.clamp(0.0, 1.0) as f32).to_bits(), Ordering::Relaxed);
    }
}

/// How an analysis ended.
pub enum Outcome<T> {
    Done(T),
    Failed(String),
    Cancelled,
}

/// An analysis running on its thread under the progress box.
pub struct Job<T> {
    pub title: String,
    step: Step,
    rx: Receiver<Outcome<T>>,
}

impl<T: Send + 'static> Job<T> {
    /// Runs `work` on a thread; `video` makes it wait while the player plays.
    pub fn start(title: String, video: bool, work: impl FnOnce(&Step) -> Result<T, Stop> + Send + 'static) -> Job<T> {
        let step = Step {
            progress: Arc::new(AtomicU32::new(0)),
            cancel: Arc::new(AtomicBool::new(false)),
            playing: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            video,
        };
        let (tx, rx) = channel();
        let st = step.clone();
        let _ = std::thread::Builder::new().name("cut-app analysis".into()).spawn(move || {
            let out = match work(&st) {
                Ok(v) if !st.cancel.load(Ordering::Relaxed) => Outcome::Done(v),
                Err(Ok(e)) => Outcome::Failed(e),
                _ => Outcome::Cancelled,
            };
            let _ = tx.send(out);
        });
        Job { title, step, rx }
    }

    pub fn fraction(&self) -> f32 {
        f32::from_bits(self.step.progress.load(Ordering::Relaxed))
    }

    pub fn paused(&self) -> bool {
        self.step.paused.load(Ordering::Relaxed)
    }

    pub fn cancel(&self) {
        self.step.cancel.store(true, Ordering::Relaxed);
    }

    /// The outcome once there, after telling the thread whether the player plays.
    pub fn poll(&self, playing: bool) -> Option<Outcome<T>> {
        self.step.playing.store(playing, Ordering::Relaxed);
        self.rx.try_recv().ok()
    }
}

/// The automation's state: its dialogs and the one analysis that may run.
#[derive(Default)]
pub struct AutoUi {
    pub duck: duck::DuckUi,
    pub silence: silence::SilenceUi,
    pub color: color::ColorUi,
    pub scenes: scenes::ScenesUi,
    pub beats: beats::BeatsUi,
    /// Levels measured this session (the JavaScript's `levelCache`).
    pub levels: levels::Cache,
}

impl AutoUi {
    /// Whether one of the analyses is running (`ui.auto.running`).
    pub fn running(&self) -> bool {
        self.duck.job.is_some()
            || self.silence.job.is_some()
            || self.color.job.is_some()
            || self.scenes.job.is_some()
            || self.beats.job.is_some()
    }
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "auto.duck" | "auto.silence" | "auto.scenes" | "auto.beats" => Some(s.app.sequence().is_some()),
        "auto.color" => Some(color::target(&s.app).is_some()),
        _ => None,
    }
}

/// Runs one of this feature's actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    if !matches!(id, "auto.duck" | "auto.silence" | "auto.color" | "auto.scenes" | "auto.beats") {
        return false;
    }
    if s.features.auto.running() || crate::voice::running(s) || crate::speakers::running(s) {
        s.app.toast(tr("Another analysis is running."));
        return true;
    }
    match id {
        "auto.duck" => duck::open(s),
        "auto.silence" => silence::open(s),
        "auto.scenes" => scenes::open(s),
        "auto.beats" => beats::open(s),
        _ => color::start(s),
    }
    true
}

/// The dialogs, the progress box and the results that came back, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let playing = s.transport.playing();
    duck::poll(s, playing);
    silence::poll(s, playing);
    color::poll(s, playing);
    scenes::poll(s, playing);
    beats::poll(s, playing);
    let running = {
        let a = &s.features.auto;
        let job = |title: &str, f: f32, paused: bool| (title.to_owned(), f, paused, None);
        a.duck
            .job
            .as_ref()
            .map(|j| job(&j.title, j.fraction(), j.paused()))
            .or_else(|| a.silence.job.as_ref().map(|j| job(&j.title, j.fraction(), j.paused())))
            .or_else(|| a.color.job.as_ref().map(|j| job(&j.title, j.fraction(), j.paused())))
            .or_else(|| a.scenes.job.as_ref().map(|j| job(&j.title, j.fraction(), j.paused())))
            .or_else(|| a.beats.job.as_ref().map(|j| job(&j.title, j.fraction(), j.paused())))
            .or_else(|| crate::voice::progress_box(s))
            .or_else(|| crate::speakers::progress_box(s))
    };
    if let Some((title, f, paused, text)) = running {
        ctx.request_repaint_after(Duration::from_millis(50));
        let mut stop = false;
        egui::Window::new(title.clone())
            .id(egui::Id::unique("cut-auto-task"))
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_TOP, Vec2::new(0.0, 60.0))
            .show_titled(ctx, &title, None, |ui| {
                ui.add(ProgressBar::new(f).desired_width(260.0));
                let line = if paused {
                    tr("Paused while playing").into_owned()
                } else if let Some(text) = text {
                    text
                } else {
                    format!("{}%", cut_audio::util::js_round(f64::from(f) * 100.0))
                };
                ui.label(line);
                stop = ui.button(tr("Cancel")).clicked();
            });
        if stop {
            cancel(s);
        }
    }
    duck::windows(s, ctx);
    silence::windows(s, ctx);
    scenes::windows(s, ctx);
    beats::windows(s, ctx);
}

/// Stops the analysis that runs (`ui.auto.cancel`).
pub fn cancel(s: &mut Shell) {
    let a = &s.features.auto;
    a.duck.job.as_ref().inspect(|j| j.cancel());
    a.silence.job.as_ref().inspect(|j| j.cancel());
    a.color.job.as_ref().inspect(|j| j.cancel());
    a.scenes.job.as_ref().inspect(|j| j.cancel());
    a.beats.job.as_ref().inspect(|j| j.cancel());
    crate::voice::cancel(s);
    crate::speakers::cancel(s);
}

/// What an analysis that did not finish leaves: a toast for a cancel, a report for a failure.
pub fn ended<T>(s: &mut Shell, outcome: Outcome<T>) -> Option<T> {
    match outcome {
        Outcome::Done(v) => Some(v),
        Outcome::Cancelled => {
            s.app.toast(tr("The analysis was cancelled."));
            None
        }
        Outcome::Failed(e) => {
            // every failure here carries the JavaScript's code `media`, which `ui.report` shows as it is
            s.app.report(tr(&e).into_owned());
            None
        }
    }
}

/// The remembered settings of an analysis (`cut.auto.<key>`) over its defaults.
pub fn settings(s: &Shell, key: &str, defaults: &[(&str, f64)]) -> Vec<f64> {
    let saved = s.doc.settings.get(&format!("auto.{key}")).and_then(Json::as_object);
    defaults
        .iter()
        .map(|(k, d)| saved.and_then(|m| m.get(*k)).and_then(Json::as_f64).filter(|v| v.is_finite()).unwrap_or(*d))
        .collect()
}

/// A remembered setting of an analysis that is a word (`cut.auto.<key>.<k>`), if it is one of `choices`.
pub fn setting_word(s: &Shell, key: &str, k: &str, choices: &[&'static str]) -> Option<&'static str> {
    let v = s.doc.settings.get(&format!("auto.{key}")).and_then(|m| m.get(k)).and_then(Json::as_str)?;
    choices.iter().copied().find(|c| *c == v)
}

/// Keeps a setting of an analysis that is a word, beside its numbers.
pub fn remember_word(s: &mut Shell, key: &str, k: &str, word: &str) {
    let mut m = s.doc.settings.get(&format!("auto.{key}")).and_then(Json::as_object).cloned().unwrap_or_else(Map::new);
    m.insert(k.to_owned(), Json::from(word));
    s.doc.settings.set(&format!("auto.{key}"), Json::Object(m));
    let _ = s.doc.settings.save();
}

/// Keeps an analysis's settings (`remember`).
pub fn remember(s: &mut Shell, key: &str, values: &[(&str, f64)]) {
    let mut m = s.doc.settings.get(&format!("auto.{key}")).and_then(Json::as_object).cloned().unwrap_or_else(Map::new);
    for (k, v) in values {
        m.insert((*k).to_owned(), serde_json::json!(v));
    }
    s.doc.settings.set(&format!("auto.{key}"), Json::Object(m));
    let _ = s.doc.settings.save();
}

/// "{n} s" with one decimal (`seconds`).
pub fn seconds(ticks: f64) -> String {
    trf("{n} s", &[("n", &format!("{:.1}", ticks / cut_time::TICKS as f64))])
}

/// A number field as the JavaScript's `ui.numberField`: dragged or typed, kept within its range, with its unit.
pub fn number(ui: &mut egui::Ui, v: &mut f64, (min, max, step): (f64, f64, f64), decimals: usize, unit: &str) -> bool {
    ui.add(egui::DragValue::new(v).range(min..=max).speed(step).fixed_decimals(decimals).suffix(format!(" {unit}")))
        .changed()
}

/// A dialog's frame: centred, its id and width, not folded or resized.
pub fn dialog(title: &str, id: &str, width: f32) -> egui::Window<'static> {
    egui::Window::new(tr(title).into_owned())
        .id(egui::Id::unique(id.to_owned()))
        .collapsible(false)
        .resizable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .default_width(width)
}
