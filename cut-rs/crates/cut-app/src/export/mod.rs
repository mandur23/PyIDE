//! Export (port of `ui-export.js` and `ui-queue.js`): the Export Media dialog (Ctrl+M) and the Export workspace's
//! Export Settings and Export Queue panels, Export Frame (Ctrl+Shift+E), and the exports themselves, which run on
//! threads of their own through `cut_export::run` while editing goes on.
//!
//! One export runs at a time: the dialog's own, or the queue's next job (a copy of the project as it was when it was
//! added, so later edits never reach it). The UI thread only polls their progress.

mod form;
mod journal;
pub mod queue;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cut_export::presets::Settings;
use cut_export::{CaptionMode, Done, Failure, Job, Progress};
use cut_model::{Id, Project};
use cut_time::Ticks;
use eframe::egui;

use crate::i18n::{tr, trf};
use crate::shell::Shell;

pub use form::Form;
pub use journal::get as journal;
pub use queue::{JobState, QueueJob};

/// What a finished export left to show.
pub enum Outcome {
    Done(Box<Done>),
    Failed(Failure),
    Cancelled,
}

/// The export in progress.
struct Running {
    /// The queue job it is, or none for the dialog's own.
    job: Option<u64>,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Option<Progress>>>,
    rx: Receiver<Result<Done, Failure>>,
    started: Instant,
}

/// A question the export asks before it starts.
pub enum Ask {
    Replace { queued: bool },
    Offline { queued: bool },
    Close,
}

/// The export screens' state.
#[derive(Default)]
pub struct ExportUi {
    /// The Export Media dialog is open.
    pub open: bool,
    pub form: Form,
    running: Option<Running>,
    pub queue: Vec<QueueJob>,
    next_id: u64,
    /// The dialog's last result.
    pub outcome: Option<Outcome>,
    pub ask: Option<Ask>,
    /// Whether this PC has a hardware HEVC encoder (asked once, on a thread).
    hevc: Option<Arc<Mutex<Option<bool>>>>,
    picked: Option<Receiver<Option<PathBuf>>>,
    frame_pick: Option<Receiver<Option<PathBuf>>>,
    /// The window closes once the exports stop.
    leaving: bool,
    frame_saved: Option<Receiver<Result<PathBuf, String>>>,
    measured: Option<Receiver<String>>,
    pub loudness_text: String,
    /// `CUT_EXPORT` was acted on.
    env_done: bool,
    /// This run's part files, for the next start to remove after a crash.
    journal: Option<Arc<journal::ExportJournal>>,
}

/// The actions this module owns.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "export" => Some(true),
        "exportFrame" => Some(s.app.sequence().is_some()),
        _ => None,
    }
}

pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    match id {
        "export" => {
            // the Export workspace shows this form in its own panel: that panel comes forward, not a second copy
            if s.features.workspace.current == crate::workspaces::Ws::Export && !s.features.export.open {
                s.features.workspace.open_panel("export");
            } else {
                s.features.export.open = true;
            }
            true
        }
        "exportFrame" => {
            export_frame(s);
            true
        }
        _ => false,
    }
}

impl ExportUi {
    /// An export runs (the dialog's or the queue's).
    pub fn busy(&self) -> bool {
        self.running.is_some()
    }

    /// The dialog's own export runs.
    pub fn running_own(&self) -> bool {
        self.running.as_ref().is_some_and(|r| r.job.is_none())
    }

    /// The progress of what runs now and the seconds left.
    pub fn progress(&self) -> Option<(f64, Option<f64>, Option<u64>)> {
        let r = self.running.as_ref()?;
        let p = *r.progress.lock().unwrap_or_else(|e| e.into_inner());
        let f = p.map_or(0.0, |p| p.fraction);
        let el = r.started.elapsed().as_secs_f64();
        let left = (f > 0.02).then(|| el / f * (1.0 - f));
        Some((f, left, r.job))
    }

    /// Whether this PC encodes HEVC on a GPU (false until known).
    pub fn hevc(&mut self) -> bool {
        let slot = self.hevc.get_or_insert_with(|| {
            let slot = Arc::new(Mutex::new(None));
            let s2 = slot.clone();
            std::thread::spawn(move || {
                let ok =
                    !cut_export::encoder_choices(cut_export::presets::Family::Hevc, cut_export::Hardware::Hardware, 0)
                        .is_empty();
                *s2.lock().unwrap_or_else(|e| e.into_inner()) = Some(ok);
            });
            slot
        });
        slot.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or(false)
    }
}

/// What an export is asked to do, as the form or a queue job holds it.
#[derive(Clone)]
pub struct Spec {
    pub project: Arc<Project>,
    pub seq: Id,
    pub path: PathBuf,
    pub settings: Settings,
    pub range: Option<(Ticks, Ticks)>,
    pub captions: Option<CaptionMode>,
    pub caption_track: Option<Id>,
}

/// Starts an export on a thread of its own.
fn start(s: &mut Shell, spec: Spec, job: Option<u64>, ctx: &egui::Context) {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Mutex::new(None));
    let (tx, rx) = channel();
    let gpu = s.monitors.as_ref().map(|m| (m.program.engine.device().clone(), m.program.engine.queue().clone()));
    let library = cut_audio::Library::default();
    let mut j = Job::new(spec.project, spec.seq, spec.path, spec.settings, crate::transport::file_audio(library));
    j.range = spec.range;
    j.captions = spec.captions;
    j.caption_track = spec.caption_track;
    j.gpu = gpu;
    j.speaker_label = tr("Speaker {n}").into_owned();
    j.journal = Some(journal::get(s));
    let (c2, p2, ctx2) = (cancel.clone(), progress.clone(), ctx.clone());
    std::thread::Builder::new()
        .name("export".into())
        .spawn(move || {
            let r = cut_export::run(j, &c2, &mut |p| {
                *p2.lock().unwrap_or_else(|e| e.into_inner()) = Some(*p);
                ctx2.request_repaint();
            });
            let _ = tx.send(r);
            ctx2.request_repaint();
        })
        .ok();
    let ex = &mut s.features.export;
    if job.is_none() {
        ex.outcome = None;
    }
    ex.running = Some(Running { job, cancel, progress, rx, started: Instant::now() });
}

/// Stops the export that runs (the dialog's, or the queue job `job`).
pub fn cancel(s: &mut Shell, job: Option<u64>) {
    if let Some(r) = &s.features.export.running
        && r.job == job
    {
        r.cancel.store(true, Ordering::Relaxed);
    }
}

/// Polls the export that runs; at its end shows the result and starts the queue's next job.
fn poll(s: &mut Shell, ctx: &egui::Context) {
    let Some(r) = &s.features.export.running else {
        queue::kick(s, ctx);
        return;
    };
    ctx.request_repaint_after(std::time::Duration::from_millis(200));
    let Ok(result) = r.rx.try_recv() else { return };
    let Some(r) = s.features.export.running.take() else { return };
    let cancelled = r.cancel.load(Ordering::Relaxed) || result.as_ref().err().is_some_and(|f| f.code == "cancelled");
    if let Ok(done) = &result
        && let Some(speed) = done.pixels_per_second
    {
        s.doc.set_setting("exportSpeed", &format!("{}", speed.round()));
    }
    match r.job {
        Some(id) => queue::finished(s, id, result, cancelled),
        None => {
            s.features.export.outcome = Some(match result {
                _ if cancelled => Outcome::Cancelled,
                Ok(d) => Outcome::Done(Box::new(d)),
                Err(f) => Outcome::Failed(f),
            });
        }
    }
    queue::kick(s, ctx);
}

/// The export's windows each frame: the dialog, its questions, and the work in the background.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    journal::get(s);
    from_env(s, ctx);
    poll(s, ctx);
    form::poll(s);
    if s.features.export.busy() && !s.features.export.leaving && ctx.input(|i| i.viewport().close_requested()) {
        ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
        s.features.export.ask = Some(Ask::Close);
    }
    if s.features.export.open {
        let mut open = true;
        // centred and as tall as the window allows: the file name and the Export button are at the bottom of the
        // form, and a scroll bar egui only shows on hover hid them below a short first size
        let screen = ctx.content_rect();
        egui::Window::new(tr("Export Media"))
            .id(egui::Id::unique("cutExportDialog"))
            .open(&mut open)
            .default_width(560.0)
            .default_height((screen.height() - 80.0).clamp(300.0, 820.0))
            .pivot(egui::Align2::CENTER_CENTER)
            .default_pos(screen.center())
            .resizable(true)
            .collapsible(false)
            .show(ctx, |ui| {
                egui::ScrollArea::vertical().auto_shrink([false, true]).show(ui, |ui| {
                    form::show(s, ui, false);
                });
            });
        s.features.export.open = open && s.features.export.open;
    }
    form::ask(s, ctx);
}

/// `CUT_EXPORT` drives a run for pictures and tests: `dialog` opens the dialog, `run` also starts an export of the
/// active sequence to its default file (beside the project, or in the projects folder of `CUT_HOME` for an unsaved
/// one), `workspace` shows the Export workspace.
fn from_env(s: &mut Shell, ctx: &egui::Context) {
    if s.features.export.env_done || s.app.sequence().is_none() {
        return;
    }
    s.features.export.env_done = true;
    match std::env::var("CUT_EXPORT").as_deref() {
        Ok("dialog") => s.features.export.open = true,
        Ok("run") => {
            s.features.export.open = true;
            form::go(s, false, true, ctx);
        }
        Ok("workspace") => crate::workspaces::set(s, crate::workspaces::Ws::Export),
        _ => {}
    }
}

/// Export (or Add to Queue) with the form's settings, after the checks and questions the Export button asks.
pub fn start_export(s: &mut Shell, queued: bool, ctx: &egui::Context) {
    form::go(s, queued, false, ctx);
}

/// The Export workspace's Export Settings panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    egui::Frame::new().inner_margin(egui::Margin::symmetric(8, 4)).show(ui, |ui| {
        egui::ScrollArea::vertical().id_salt("cut-export-panel").show(ui, |ui| form::show(s, ui, true));
    });
}

/// The Export workspace's Export Queue panel.
pub fn queue_panel(s: &mut Shell, ui: &mut egui::Ui) {
    queue::show(s, ui);
}

/// `formatSeconds`: `12 s`, `3 min 4 s`, `1 h 2 min`.
pub fn format_seconds(s: f64) -> String {
    let v = s.max(0.0).round() as u64;
    if v < 60 {
        trf("{n} s", &[("n", &v.to_string())])
    } else if v < 3600 {
        trf("{m} min {s} s", &[("m", &(v / 60).to_string()), ("s", &(v % 60).to_string())])
    } else {
        trf("{h} h {m} min", &[("h", &(v / 3600).to_string()), ("m", &((v / 60) % 60).to_string())])
    }
}

/// `formatBytes`: `512 B`, `1.2 KB`, `76.4 MB`, `1.50 GB`.
pub fn format_bytes(n: u64) -> String {
    let f = n as f64;
    if f < 1024.0 {
        format!("{n} B")
    } else if f < 1024.0 * 1024.0 {
        format!("{:.1} KB", f / 1024.0)
    } else if f < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} MB", f / 1024.0 / 1024.0)
    } else {
        format!("{:.2} GB", f / 1024.0 / 1024.0 / 1024.0)
    }
}

/// Shows a file in Explorer, selected.
pub fn reveal(path: &Path) {
    let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn();
}

/// A failure as the screen says it.
pub fn said(f: &Failure) -> String {
    let params: Vec<(&str, &str)> = f.params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    trf(&f.message, &params)
}

/// Export Frame: the program frame at the playhead as a PNG at the sequence's size.
fn export_frame(s: &mut Shell) {
    let Some(seq) = s.app.sequence() else { return };
    let dir = s.app.path.as_ref().and_then(|p| p.parent()).map_or_else(|| s.doc.home.projects.clone(), Path::to_owned);
    let tc = cut_time::timecode(s.app.t, seq.fps).replace(':', "-");
    let name = format!("{} {tc}.png", form::safe_name(&seq.name, "Frame"));
    let (tx, rx) = channel();
    let title = tr("Export Frame").into_owned();
    let filter = tr("PNG image").into_owned();
    std::thread::spawn(move || {
        let p = rfd::FileDialog::new()
            .set_title(&title)
            .add_filter(&filter, &["png"])
            .set_directory(&dir)
            .set_file_name(name)
            .save_file();
        let _ = tx.send(p);
    });
    s.features.export.frame_pick = Some(rx);
}

/// Saves the frame once its file is chosen.
fn save_frame(s: &mut Shell, path: PathBuf) {
    let (Some(m), Some(seq)) = (&mut s.monitors, s.app.sequence()) else { return };
    let (w, h, seq_id, t) = (seq.w.max(2) as u32, seq.h.max(2) as u32, seq.id, s.app.t);
    let opts = cut_engine::RenderOptions { wait: Some(std::time::Duration::from_secs(10)), ..Default::default() };
    let r = m.program.engine.render(s.app.history.project(), seq_id, cut_time::snap(t, seq.fps, false), (w, h), &opts);
    let pixels = match r {
        Ok(_) => m.program.engine.read_pixels(),
        Err(e) => {
            s.app.report(trf("The frame could not be saved: {error}", &[("error", &e.to_string())]));
            return;
        }
    };
    let path = PathBuf::from(cut_export::plan::with_ext(&path.to_string_lossy(), "png"));
    let journal = journal::get(s);
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut png = Vec::new();
        let enc = image::codecs::png::PngEncoder::new(&mut png);
        let r = image::ImageEncoder::write_image(enc, &pixels, w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())
            .and_then(|()| cut_export::sink::save_bytes(&path, &png, Some(journal)).map_err(|f| f.to_string()))
            .map(|_| path);
        let _ = tx.send(r);
    });
    s.features.export.frame_saved = Some(rx);
}
