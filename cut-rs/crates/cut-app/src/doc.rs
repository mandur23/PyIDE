//! The open project's life (port of `ui-shell.js`'s project part): an untitled project at start, New, Open, Save,
//! Save As, Save a Copy, the latest-state autosave 2 s after edits stop and a copy every 5 minutes, the session marker
//! that tells a crash from a clean close, recovery, and the recent projects. The files themselves are [`crate::files`].
//!
//! Time is passed in (`now` in ms), so the autosave rules are tested without waiting.

use std::path::{Path, PathBuf};

use cut_model::{History, Project};
use serde_json::{Value as Json, json};

use crate::files::{self, Code, FileError, Home, Projects, Recent, Settings};
use crate::i18n::{tr, trf};
use crate::state::App;

/// `AUTOSAVE_MS`: the latest state is written this long after the last edit.
pub const AUTOSAVE_MS: i64 = 2000;
/// `COPY_MINUTES`: an autosave copy is made this often while there are changes the last copy does not have.
pub const COPY_MS: i64 = 5 * 60_000;
/// The history's step limit (`createHistory`'s 1000).
pub const HISTORY_LIMIT: usize = 1000;

/// A project text that cannot be opened: the code and the sentence for the person.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenError {
    pub code: &'static str,
    pub message: String,
}

/// The text of a `.ncut` file as a history (`historyFromText`).
pub fn history_from_text(text: &str) -> Result<History, OpenError> {
    history_of(project_from_text(text)?)
}

/// The text of a `.ncut` file as a project, not yet checked as a whole ([`history_of`] does).
fn project_from_text(text: &str) -> Result<Project, OpenError> {
    let not_project =
        || OpenError { code: "notProject", message: "This file is not a Nano Studio Cut project.".into() };
    let json: Json = serde_json::from_str(text).map_err(|_| not_project())?;
    if json.get("format").and_then(Json::as_str) != Some("ncut") {
        return Err(not_project());
    }
    Project::load(text).map_err(|e| OpenError { code: e.code(), message: e.to_string() })
}

fn history_of(project: Project) -> Result<History, OpenError> {
    History::new(project, HISTORY_LIMIT).map_err(|e| OpenError { code: e.code(), message: e.to_string() })
}

/// A project file read and parsed, which any thread can do ([`load`]); [`Doc::open_loaded`] opens it.
pub struct Loaded {
    path: PathBuf,
    read: Result<(files::ReadOk, Result<Project, OpenError>), FileError>,
}

/// Reads and parses the project file at `path` (`projectRead`, `historyFromText` up to the whole check): the slow
/// part of opening a large project, so a start does it on a thread while the window is made.
pub fn load(projects: &mut Projects, path: &Path) -> Loaded {
    let read = projects.project_read(path).map(|r| {
        let parsed = project_from_text(&r.text);
        (r, parsed)
    });
    Loaded { path: path.to_owned(), read }
}

/// A new project with one sequence named in the screen's language (`freshProject`).
pub fn fresh_history() -> History {
    let mut p = cut_model::defaults::project();
    if let Some(s) = p.sequences.first_mut() {
        s.name = trf("Sequence {n}", &[("n", "1")]);
    }
    History::new(p, HISTORY_LIMIT).expect("a new project is valid")
}

/// A new project with the Preferences' default transition and still lengths (`freshProject`'s
/// `settings: projectDefaults()`).
fn fresh_for(settings: &Settings) -> History {
    let mut p = fresh_history().project().clone();
    let (transition, still) = crate::prefs::project_defaults(settings);
    p.settings.insert("transitionDuration".into(), json!(transition));
    p.settings.insert("stillDuration".into(), json!(still));
    History::new(p, HISTORY_LIMIT).expect("a new project is valid")
}

fn untitled_key(now: i64) -> String {
    format!("untitled-{}{:04x}", radix36(now.max(0) as u64), (now as u64).wrapping_mul(2_654_435_761) & 0xffff)
}

fn radix36(mut n: u64) -> String {
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// What a save attempt needs from the person.
#[derive(Debug, Clone, PartialEq)]
pub enum SaveOutcome {
    Saved(PathBuf),
    /// The file changed on disk since it was read here: ask before overwriting (`changed`).
    Changed(PathBuf),
    Failed(String),
}

/// The workspace, the session and the autosave clock of the open project.
pub struct Doc {
    pub home: Home,
    pub projects: Projects,
    pub settings: Settings,
    /// The autosave and session key: the project path, or `untitled-<id>`.
    pub key: String,
    /// The project file's time as read or last written here.
    disk_mtime: Option<f64>,
    /// A recovered or autosave-copy project is modified from the start.
    pub force_dirty: bool,
    revision: u64,
    last_change: i64,
    autosaved_revision: Option<u64>,
    last_copy: i64,
    copied_revision: Option<u64>,
    pub last_autosave: Option<i64>,
    was_grouping: bool,
    /// The thread autosaves are written on.
    writer: Writer,
}

/// An autosave for the thread: where it goes and the project it writes.
type Job = (files::AutosaveJob, Project);

/// The thread that turns autosaves into text and writes them, so an edit on a large project never waits for the
/// disk: one at a time, in the order asked.
#[derive(Default)]
struct Writer {
    /// Where autosaves go to the thread, and its word for each one written.
    worker: Option<(std::sync::mpsc::Sender<Job>, std::sync::mpsc::Receiver<()>)>,
    /// Autosaves asked for and not written yet.
    pending: usize,
}

impl Writer {
    fn write(&mut self, job: files::AutosaveJob, project: Project) {
        let (tx, _) = self.worker.get_or_insert_with(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Job>();
            let (done_tx, done) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                for (job, project) in rx {
                    let _ = job.write(&project.to_text());
                    let _ = done_tx.send(());
                }
            });
            (tx, done)
        });
        if tx.send((job, project)).is_ok() {
            self.pending += 1;
        }
    }

    /// Notes what was written since; with `wait`, until everything asked for is.
    fn settle(&mut self, wait: bool) {
        let Some((_, done)) = &self.worker else { return };
        while self.pending > 0 {
            let got = if wait { done.recv().is_ok() } else { done.try_recv().is_ok() };
            if !got {
                break;
            }
            self.pending -= 1;
        }
    }
}

impl Doc {
    /// The workspace at `home` (created), with a new untitled project.
    pub fn start(home: Home, now: i64) -> (Doc, App) {
        let _ = home.ensure();
        let projects = Projects::new(home.autosave.clone());
        let settings = Settings::load(&home.home);
        let mut doc = Doc {
            home,
            projects,
            settings,
            key: String::new(),
            disk_mtime: None,
            force_dirty: false,
            revision: 0,
            last_change: now,
            autosaved_revision: None,
            last_copy: now,
            copied_revision: None,
            last_autosave: None,
            was_grouping: false,
            writer: Writer::default(),
        };
        let app = App::new(fresh_for(&doc.settings), None);
        doc.adopt(&app, None, None, now);
        (doc, app)
    }

    /// Takes on a project just put in `app` (`adopt`): a new session, the autosave clock reset.
    fn adopt(&mut self, app: &App, session_key: Option<String>, mtime: Option<f64>, now: i64) {
        self.disk_mtime = if app.path.is_some() { mtime } else { None };
        self.force_dirty = false;
        self.revision = app.history.revision();
        self.last_change = now;
        self.autosaved_revision = None;
        self.last_copy = now;
        self.copied_revision = Some(self.revision);
        let key = session_key
            .or_else(|| app.path.as_ref().map(|p| p.to_string_lossy().into_owned()))
            .unwrap_or_else(|| untitled_key(now));
        self.start_session(key);
    }

    fn start_session(&mut self, key: String) {
        if !self.key.is_empty() && self.key != key {
            let _ = self.projects.session_end(&self.key);
        }
        let _ = self.projects.session_start(&key);
        self.key = key;
    }

    /// Waits until the autosaves asked for are written.
    pub fn flush(&mut self) {
        self.writer.settle(true);
    }

    /// Ends the session (a clean close), once the autosaves on their way are written.
    pub fn end(&mut self) {
        self.flush();
        if !self.key.is_empty() {
            let _ = self.projects.session_end(&self.key);
        }
    }

    pub fn dirty(&self, app: &App) -> bool {
        app.history.dirty() || self.force_dirty
    }

    /// The project's name for the title and questions.
    pub fn name(&self, app: &App) -> String {
        match &app.path {
            Some(p) => p.file_stem().map_or_else(String::new, |s| s.to_string_lossy().into_owned()),
            None => tr("Untitled").into_owned(),
        }
    }

    pub fn new_project(&mut self, app: &mut App, now: i64) {
        app.set_history(fresh_for(&self.settings), None);
        self.adopt(app, None, None, now);
    }

    /// Opens a project file; an autosave copy opens unsaved (the app deletes old ones).
    pub fn open(&mut self, app: &mut App, path: &Path, now: i64) -> Result<(), String> {
        let loaded = load(&mut self.projects, path);
        self.open_loaded(app, loaded, now)
    }

    /// Opens a project file [`load`] read.
    pub fn open_loaded(&mut self, app: &mut App, loaded: Loaded, now: i64) -> Result<(), String> {
        let path = &loaded.path;
        let (r, parsed) = match loaded.read {
            Ok(r) => r,
            Err(e) if e.code == Code::Missing => {
                self.remember(path, false);
                return Err(trf("The project file is gone: {path}", &[("path", &path.to_string_lossy())]));
            }
            Err(e) => return Err(trf("The project could not be opened: {error}", &[("error", &e.message)])),
        };
        let history = parsed.and_then(history_of).map_err(|e| tr(&e.message).into_owned())?;
        app.set_history(history, (!r.autosave).then(|| r.path.clone()));
        self.adopt(app, None, Some(r.mtime), now);
        if r.autosave {
            self.force_dirty = true;
            app.report(tr(
                "This is an autosave copy, which Nano Studio Cut deletes when it gets old. Save the project to keep it.",
            ));
        } else {
            self.remember(&r.path, true);
        }
        Ok(())
    }

    /// Adds a path to the recent projects (or takes it out), saved at once.
    fn remember(&mut self, path: &Path, add: bool) {
        let mut recent = Recent::of(&self.settings);
        let same: Vec<PathBuf> = recent.paths().iter().filter(|p| same_file(p, path)).cloned().collect();
        for p in &same {
            recent.remove(p);
        }
        if add {
            recent.add(path);
        }
        recent.store(&mut self.settings);
        let _ = self.settings.save();
    }

    pub fn recent(&self) -> Vec<PathBuf> {
        Recent::of(&self.settings).paths().to_vec()
    }

    /// Writes the project to `path` (`writeTo`); `overwrite` skips the changed-on-disk check.
    pub fn write_to(&mut self, app: &mut App, path: &Path, overwrite: bool, now: i64) -> SaveOutcome {
        let at = app.history.mark();
        let text = app.history.serialize();
        let same = app.path.as_ref().is_some_and(|p| same_file(p, path));
        let mtime = if same && !overwrite { self.disk_mtime } else { None };
        match self.projects.project_write(path, &text, mtime) {
            Ok(w) => {
                app.history.mark_saved(at);
                self.force_dirty = false;
                self.disk_mtime = w.mtime;
                let was = app.path.clone();
                app.path = Some(w.path.clone());
                if !was.is_some_and(|p| same_file(&p, &w.path)) {
                    self.start_session(w.path.to_string_lossy().into_owned());
                }
                self.last_change = now;
                self.remember(&w.path, true);
                SaveOutcome::Saved(w.path)
            }
            Err(e) if e.code == Code::Changed => SaveOutcome::Changed(path.to_owned()),
            Err(e) => SaveOutcome::Failed(save_failed(&e)),
        }
    }

    /// Save a Copy: the project as it is into another file; the open project stays where it was, unsaved.
    pub fn save_copy(&mut self, app: &App, path: &Path) -> Result<PathBuf, String> {
        self.projects.project_write(path, &app.history.serialize(), None).map(|w| w.path).map_err(|e| save_failed(&e))
    }

    /// Where Save As proposes to put the project.
    pub fn default_save_path(&self, app: &App) -> PathBuf {
        app.path.clone().unwrap_or_else(|| self.home.projects.join(format!("{}.ncut", self.name(app))))
    }

    /// Runs the autosave clock: the latest state 2 s after the last edit, a copy every 5 minutes with changes, each
    /// written on a thread of its own ([`Doc::flush`] waits for them). -> whether one was asked for.
    pub fn tick(&mut self, app: &App, now: i64) -> bool {
        let rev = app.history.revision();
        let grouping = app.history.grouping();
        // a group that became a step (a drag released) counts as the last edit, as its commit does in the JavaScript
        if rev != self.revision || (self.was_grouping && !grouping) {
            self.revision = rev;
            self.last_change = now;
        }
        self.was_grouping = grouping;
        if !self.dirty(app) || app.history.grouping() {
            return false;
        }
        self.writer.settle(false);
        let mut wrote = false;
        if self.autosaved_revision != Some(rev) && now - self.last_change >= AUTOSAVE_MS {
            if let Ok(job) = self.projects.autosave_job(&self.key, true, files::KEEP) {
                self.writer.write(job, app.history.project().clone());
                self.last_autosave = Some(now);
                wrote = true;
            }
            self.autosaved_revision = Some(rev);
        }
        // `copyMinutes` and `copyKeep`: the settings when they are numbers in range
        let setting = |k: &str| self.settings.get(k).and_then(Json::as_f64).filter(|v| v.is_finite() && *v >= 1.0);
        let every = setting("autosaveMinutes").map_or(COPY_MS, |m| (m.min(120.0) * 60_000.0) as i64);
        if now - self.last_copy >= every {
            self.last_copy = now;
            if self.copied_revision != Some(rev) {
                let keep = self.settings.get("autosaveKeep").and_then(Json::as_f64).map(|k| (k + 0.5).floor());
                let keep = keep.filter(|k| k.is_finite() && *k >= 1.0).map_or(files::KEEP, |k| k.min(100.0) as usize);
                if let Ok(job) = self.projects.autosave_job(&self.key, false, keep) {
                    self.writer.write(job, app.history.project().clone());
                    self.copied_revision = Some(rev);
                    wrote = true;
                }
            }
        }
        wrote
    }

    /// Writes the latest autosave now, without the 2 s wait, and waits for it (a close asked from outside, as an
    /// update does, before the question about unsaved changes) -> whether one was written.
    pub fn autosave_now(&mut self, app: &App) -> bool {
        let rev = app.history.revision();
        if !self.dirty(app) || self.autosaved_revision == Some(rev) {
            return false;
        }
        let Ok(job) = self.projects.autosave_job(&self.key, true, files::KEEP) else { return false };
        self.writer.write(job, app.history.project().clone());
        self.autosaved_revision = Some(rev);
        self.flush();
        true
    }

    /// How long until [`Doc::tick`] has something to write (ms), for the window to wake then; `None` while nothing
    /// is due (no unsaved change, or a drag still grouping its edits).
    pub fn next_due(&self, app: &App, now: i64) -> Option<i64> {
        if !self.dirty(app) || app.history.grouping() {
            return None;
        }
        let rev = app.history.revision();
        let latest = (self.autosaved_revision != Some(rev)).then(|| self.last_change + AUTOSAVE_MS - now);
        let setting =
            self.settings.get("autosaveMinutes").and_then(Json::as_f64).filter(|v| v.is_finite() && *v >= 1.0);
        let every = setting.map_or(COPY_MS, |m| (m.min(120.0) * 60_000.0) as i64);
        let copy = (self.copied_revision != Some(rev)).then(|| self.last_copy + every - now);
        latest.into_iter().chain(copy).min().map(|ms| ms.max(0))
    }

    /// Opens an offered autosave in place of the project, unsaved, under its own file and session (`recover`).
    pub fn recover(&mut self, app: &mut App, offer: &files::Offer, now: i64) -> Result<(), String> {
        let text =
            std::fs::read_to_string(&offer.file).map_err(|_| tr("The autosave could not be read.").into_owned())?;
        let history =
            history_from_text(text.trim_start_matches('\u{feff}')).map_err(|e| tr(&e.message).into_owned())?;
        let path = (!offer.key.starts_with("untitled-")).then(|| PathBuf::from(&offer.key));
        app.set_history(history, path);
        self.adopt(app, Some(offer.key.clone()), None, now);
        self.force_dirty = true;
        Ok(())
    }

    /// A setting of this app (`language`, `theme`, `keyPreset`).
    pub fn setting(&self, key: &str) -> Option<&str> {
        self.settings.get(key).and_then(Json::as_str)
    }

    pub fn set_setting(&mut self, key: &str, value: &str) {
        self.settings.set(key, json!(value));
        let _ = self.settings.save();
    }
}

/// Whether two paths name one file as Windows reads them (case and either slash).
pub fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

fn save_failed(e: &FileError) -> String {
    if e.code == Code::Autosave {
        tr("Projects are not saved in the Autosave folder, where Nano Studio Cut deletes old files. Choose another folder.")
            .into_owned()
    } else {
        trf("The project could not be saved: {error}", &[("error", &e.message)])
    }
}
