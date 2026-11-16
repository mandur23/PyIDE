//! The window (port of `ui-shell.js`'s layout and `ui-base.js`'s plumbing): the menu bar, the top bar, the Editing
//! workspace's panels in Premiere's places (Source and Program above; Project, Tools, Timeline and Audio Meters
//! below), the status bar, the dialogs, the keyboard, files dropped on the window, playback's clock and the question
//! about unsaved changes when the window closes.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Instant;

use cut_model::Id;
use cut_time::{TICKS, Ticks, frame_at, frame_start};
use eframe::egui::{self, Vec2};
use eframe::egui_wgpu;

use crate::doc::{Doc, SaveOutcome};
use crate::files::{self, Home, now_ms};
use crate::i18n::{self, Lang, tr, trf};
use crate::import::{self, Importer};
use crate::keys::{self, Preset};
use crate::panels;
use crate::picture::Monitors;
use crate::state::{App, Panel};
use crate::theme::{Palette, ThemeKind};
use crate::thumbs::Thumbs;
use crate::timeline::Timeline;
use crate::transport::{Player, Transport, WallClock, dropped_between};

/// A playback run as the picture follows it (player.js `tick`'s state): the playhead it set last, the frame it showed
/// last, when it last asked the engine to decode ahead, and the frames it showed and skipped.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Play {
    pub active: bool,
    last_set: Option<Ticks>,
    last_frame: Option<i64>,
    last_prefetch: Option<Ticks>,
    pub shown: u64,
    pub dropped: i64,
    pub started: Option<Instant>,
}

/// What to do once the unsaved changes are saved or let go.
#[derive(Debug, Clone, PartialEq)]
pub enum Then {
    Nothing,
    NewProject,
    /// Open this project, or ask which one.
    Open(Option<PathBuf>),
    Close,
}

/// The dialog on screen.
#[derive(Debug, Clone)]
pub enum Dialog {
    SaveChanges { then: Then, closing: bool },
    Overwrite { path: PathBuf, then: Then },
    Recovery(Vec<files::Offer>),
    Autosaves(Vec<files::Autosave>),
    ImportErrors(Vec<(PathBuf, &'static str)>),
    RemoveMedia { ids: Vec<Id>, used: Vec<String> },
    NewSequence { name: String, preset: usize },
}

/// A file dialog that runs on its own thread, so the window keeps drawing.
#[derive(Debug, Clone, PartialEq)]
pub enum Ask {
    Import,
    Open,
    SaveAs(Then),
    SaveCopy,
}

/// The bottom-left frame's tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LowerTab {
    Project,
    Effects,
    Markers,
    History,
}

/// The editor window's state.
pub struct Shell {
    pub app: App,
    pub doc: Doc,
    pub timeline: Timeline,
    /// Playback: the wall clock until [`Shell::attach`] gives the sound's.
    pub transport: Box<dyn Transport>,
    pub importer: Importer,
    pub palette: Palette,
    pub preset: Preset,
    pub dialog: Option<Dialog>,
    pub project: panels::project::ProjectPanel,
    pub lower_tab: LowerTab,
    /// The monitors' pictures, once the window's GPU device is there ([`Shell::attach`]).
    pub monitors: Option<Monitors>,
    monitors_coming: Option<Receiver<Monitors>>,
    /// The sound's library until the output device opens (with the monitors).
    sound_library: Option<cut_audio::Library>,
    shown_title: String,
    /// Thumbnails and waveforms, made off the UI thread.
    pub thumbs: Option<Thumbs>,
    /// The playback run the picture follows (player.js's counters).
    pub play: Play,
    /// What the UI thread spent on the last frame (ms): this crate's code, and eframe's whole frame.
    pub frame_ms: f32,
    pub frame_cpu_ms: f32,
    /// What each panel drawn took of the last frame it was drawn in (ms).
    pub panel_ms: std::collections::BTreeMap<&'static str, f32>,
    /// The project revision and sequence the sound plays.
    synced: Option<(u64, Id)>,
    /// Why there is no sound, when the output device would not open.
    pub sound_error: Option<String>,
    asking: Option<(Ask, Receiver<Option<Vec<PathBuf>>>)>,
    import_bin: Option<Id>,
    import_failed: Vec<(PathBuf, &'static str)>,
    import_made: usize,
    close_allowed: bool,
    started_fonts: bool,
    tool_groups: [crate::state::Tool; 8],
    /// The sound, captions, text and graphics screens, the workspaces and the preferences.
    pub features: crate::features::Features,
    /// `CUT_ACTIONS`, run once the monitors are up.
    drive: Vec<String>,
}

impl Shell {
    /// The editor on the workspace `home`.
    pub fn new(home: Home) -> Shell {
        let (doc, app) = Doc::start(home, now_ms());
        let lang = std::env::var("CUT_LANG")
            .ok()
            .and_then(|l| Lang::from_code(&l))
            .or_else(|| doc.setting("language").and_then(Lang::from_code))
            .unwrap_or(Lang::Ko);
        i18n::set_lang(lang);
        let theme = match doc.setting("theme") {
            Some("light") => ThemeKind::Light,
            _ => ThemeKind::Dark,
        };
        let preset = doc.setting("keyPreset").and_then(Preset::from_code).unwrap_or(Preset::Premiere);
        let offers = doc.projects.recovery();
        let features = crate::features::Features::new(&doc);
        Shell {
            app,
            doc,
            timeline: Timeline::default(),
            transport: Box::<WallClock>::default(),
            importer: Importer::default(),
            palette: Palette::of(theme),
            preset,
            dialog: (!offers.is_empty()).then_some(Dialog::Recovery(offers)),
            project: panels::project::ProjectPanel::default(),
            lower_tab: LowerTab::Project,
            monitors: None,
            monitors_coming: None,
            sound_library: None,
            shown_title: String::new(),
            thumbs: None,
            play: Play::default(),
            frame_ms: 0.0,
            frame_cpu_ms: 0.0,
            panel_ms: Default::default(),
            synced: None,
            sound_error: None,
            asking: None,
            import_bin: None,
            import_failed: Vec::new(),
            import_made: 0,
            close_allowed: false,
            started_fonts: false,
            tool_groups: panels::tools::GROUPS.map(|g| g[0]),
            features,
            drive: std::env::var("CUT_ACTIONS")
                .map(|v| v.split(',').map(str::trim).filter(|a| !a.is_empty()).map(str::to_owned).collect())
                .unwrap_or_default(),
        }
    }

    /// Sets up fonts (Korean from the system's Malgun Gothic) and the theme on the window's context.
    pub fn setup(&mut self, ctx: &egui::Context) {
        if !self.started_fonts {
            self.started_fonts = true;
            let mut fonts = egui::FontDefinitions::default();
            // Korean from Malgun Gothic and the icons from Segoe MDL2 Assets, both shipped with Windows.
            for (name, file) in [("korean", "C:/Windows/Fonts/malgun.ttf"), ("icons", "C:/Windows/Fonts/segmdl2.ttf")] {
                if let Ok(bytes) = std::fs::read(file) {
                    fonts.font_data.insert(name.into(), std::sync::Arc::new(egui::FontData::from_owned(bytes)));
                    for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
                        fonts.families.entry(family).or_default().push(name.into());
                    }
                }
            }
            ctx.set_fonts(fonts);
            // Pictures at an exact size in points on a scaled display (tests): `CUT_PPP=1`.
            if let Some(ppp) = std::env::var("CUT_PPP").ok().and_then(|v| v.parse::<f32>().ok()) {
                ctx.set_pixels_per_point(ppp);
            }
            ctx.set_theme(if self.palette.light() { egui::Theme::Light } else { egui::Theme::Dark });
        }
        let theme = if self.palette.light() { egui::Theme::Light } else { egui::Theme::Dark };
        ctx.set_visuals_of(theme, self.palette.visuals());
        ctx.set_theme(theme);
        ctx.global_style_mut(|s| {
            s.spacing.item_spacing = Vec2::new(6.0, 4.0);
            s.spacing.button_padding = Vec2::new(6.0, 2.0);
        });
    }

    pub fn set_theme(&mut self, ctx: &egui::Context, kind: ThemeKind) {
        self.palette = Palette::of(kind);
        self.doc.set_setting("theme", kind.code());
        self.setup(ctx);
    }

    pub fn set_lang(&mut self, lang: Lang) {
        i18n::set_lang(lang);
        self.doc.set_setting("language", lang.code());
    }

    /// The window title: the project's name, a dot when it has unsaved changes.
    pub fn title(&self) -> String {
        let dot = if self.doc.dirty(&self.app) { " ●" } else { "" };
        format!("{}{dot} - Nano Studio Cut", self.doc.name(&self.app))
    }

    // ---------- files ----------

    pub(crate) fn dialog_override(kind: &str) -> Option<Option<Vec<PathBuf>>> {
        let file = std::env::var("CUT_DIALOG").ok()?;
        let json: serde_json::Value = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok())?;
        let v = json.get(kind);
        Some(match v {
            Some(serde_json::Value::String(s)) => Some(vec![PathBuf::from(s)]),
            Some(serde_json::Value::Array(a)) => Some(a.iter().filter_map(|x| x.as_str()).map(PathBuf::from).collect()),
            _ => None,
        })
    }

    /// Opens a file dialog (`cut:pickMedia`, `cut:pickProject`, `cut:saveAs`); `CUT_DIALOG` names a JSON file that
    /// answers it instead, as `PYIDE_CUT_DIALOG` does for the JavaScript editor's tests.
    pub fn ask(&mut self, ask: Ask) {
        if self.asking.is_some() {
            return;
        }
        let key = match ask {
            Ask::Import => "pickMedia",
            Ask::Open => "pickProject",
            Ask::SaveAs(_) | Ask::SaveCopy => "saveAs",
        };
        let (tx, rx) = channel();
        if let Some(answer) = Self::dialog_override(key) {
            let _ = tx.send(answer);
            self.asking = Some((ask, rx));
            return;
        }
        let projects = self.doc.home.projects.clone();
        let save_path = match ask {
            Ask::SaveCopy => {
                let name = trf("{name} copy", &[("name", &self.doc.name(&self.app))]);
                self.app
                    .path
                    .as_ref()
                    .and_then(|p| p.parent())
                    .map_or(projects.clone(), |p| p.to_owned())
                    .join(format!("{name}.ncut"))
            }
            _ => self.doc.default_save_path(&self.app),
        };
        let title = match &ask {
            Ask::Import => tr("Import Media"),
            Ask::Open => tr("Open Project"),
            Ask::SaveAs(_) => tr("Save Project As"),
            Ask::SaveCopy => tr("Save a Copy"),
        }
        .into_owned();
        let (media, all, project) =
            (tr("Media files").into_owned(), tr("All files").into_owned(), tr("Nano Studio Cut project").into_owned());
        let kind = ask.clone();
        std::thread::spawn(move || {
            let d = rfd::FileDialog::new().set_title(&title);
            let r = match kind {
                Ask::Import => d.add_filter(&media, &import::media_extensions()).add_filter(&all, &["*"]).pick_files(),
                Ask::Open => d.add_filter(&project, &["ncut"]).set_directory(&projects).pick_file().map(|p| vec![p]),
                Ask::SaveAs(_) | Ask::SaveCopy => {
                    let dir = save_path.parent().map(|p| p.to_owned()).unwrap_or(projects);
                    let name = save_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    d.add_filter(&project, &["ncut"]).set_directory(dir).set_file_name(name).save_file().map(|mut p| {
                        if p.extension().is_none() {
                            p.set_extension("ncut");
                        }
                        vec![p]
                    })
                }
            };
            let _ = tx.send(r);
        });
        self.asking = Some((ask, rx));
    }

    fn poll_ask(&mut self, ctx: &egui::Context) {
        let Some((_, rx)) = &self.asking else { return };
        let Ok(answer) = rx.try_recv() else {
            ctx.request_repaint_after(std::time::Duration::from_millis(100));
            return;
        };
        let Some((ask, _)) = self.asking.take() else { return };
        let Some(paths) = answer.filter(|p| !p.is_empty()) else { return };
        match ask {
            Ask::Import => self.import_paths(paths, self.project.current_bin()),
            Ask::Open => self.open_now(&paths[0]),
            Ask::SaveAs(then) => self.write(paths[0].clone(), false, then, ctx),
            Ask::SaveCopy => match self.doc.save_copy(&self.app, &paths[0]) {
                Ok(p) => self.app.toast(trf(
                    "Saved a copy as {name}",
                    &[("name", &p.file_name().unwrap_or_default().to_string_lossy())],
                )),
                Err(e) => self.app.report(e),
            },
        }
    }

    fn write(&mut self, path: PathBuf, overwrite: bool, then: Then, ctx: &egui::Context) {
        match self.doc.write_to(&mut self.app, &path, overwrite, now_ms()) {
            SaveOutcome::Saved(_) => {
                self.app.toast(tr("Saved"));
                self.after(then, ctx);
            }
            SaveOutcome::Changed(path) => self.dialog = Some(Dialog::Overwrite { path, then }),
            SaveOutcome::Failed(e) => self.app.report(e),
        }
    }

    /// Save (Ctrl+S): to the project's file, or Save As for an untitled project; then `then`.
    pub fn save(&mut self, then: Then, ctx: &egui::Context) {
        match self.app.path.clone() {
            Some(p) => self.write(p, false, then, ctx),
            None => self.ask(Ask::SaveAs(then)),
        }
    }

    pub fn overwrite(&mut self, path: PathBuf, then: Then, ctx: &egui::Context) {
        self.write(path, true, then, ctx);
    }

    /// Goes on with `then` once the unsaved changes are dealt with.
    pub fn after(&mut self, then: Then, ctx: &egui::Context) {
        match then {
            Then::Nothing => {}
            Then::NewProject => {
                self.transport.pause();
                self.doc.new_project(&mut self.app, now_ms());
                self.timeline = Timeline::default();
            }
            Then::Open(Some(p)) => self.open_now(&p),
            Then::Open(None) => self.ask(Ask::Open),
            Then::Close => {
                self.close_allowed = true;
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
        }
    }

    /// `then` now, or after asking about unsaved changes (`askToSave`).
    pub fn guard(&mut self, then: Then, ctx: &egui::Context) {
        if self.doc.dirty(&self.app) {
            let closing = then == Then::Close;
            self.dialog = Some(Dialog::SaveChanges { then, closing });
        } else {
            self.after(then, ctx);
        }
    }

    fn open_now(&mut self, path: &std::path::Path) {
        self.transport.pause();
        match self.doc.open(&mut self.app, path, now_ms()) {
            Ok(()) => {
                self.timeline = Timeline::default();
                self.project = panels::project::ProjectPanel::default();
            }
            Err(e) => self.app.report(e),
        }
    }

    /// Imports files and folders: folders become bins (`importFolderPath`), files go into `bin`.
    pub fn import_paths(&mut self, paths: Vec<PathBuf>, bin: Option<Id>) {
        let mut files = Vec::new();
        for p in paths {
            if p.is_dir() {
                files.extend(self.folder_files(&p, bin));
            } else {
                files.push(p);
            }
        }
        self.import_bin = bin;
        self.import_failed.clear();
        self.import_made = 0;
        self.importer.start(files);
    }

    /// A dropped folder: a bin of its name (and one per subfolder) holds its media; bins are made at once, the files
    /// go in as their probes finish.
    fn folder_files(&mut self, root: &std::path::Path, bin: Option<Id>) -> Vec<PathBuf> {
        if let Err(e) = std::fs::read_dir(root) {
            self.app.report(trf("The folder could not be read: {error}", &[("error", &e.to_string())]));
            return Vec::new();
        }
        let list = import::list_folder(root);
        if list.is_empty() {
            self.app.toast(tr("There are no media files in that folder."));
            return Vec::new();
        }
        let name = root.file_name().map_or_else(|| "Folder".to_owned(), |n| n.to_string_lossy().into_owned());
        self.app.history.begin(&tr("Import"));
        let mut bins: std::collections::HashMap<Vec<String>, Option<Id>> = std::collections::HashMap::new();
        let top = self
            .app
            .history
            .apply(&crate::cmd::add_bin(&name, bin))
            .ok()
            .and_then(|r| r.get("id").and_then(|v| v.as_str()).map(Id::new));
        bins.insert(Vec::new(), top.or(bin));
        let mut out = Vec::new();
        for (path, rel) in list {
            for depth in 1..=rel.len() {
                let key = rel[..depth].to_vec();
                if bins.contains_key(&key) {
                    continue;
                }
                let parent = bins.get(&rel[..depth - 1]).copied().flatten();
                let made = self
                    .app
                    .history
                    .apply(&crate::cmd::add_bin(&rel[depth - 1], parent))
                    .ok()
                    .and_then(|r| r.get("id").and_then(|v| v.as_str()).map(Id::new));
                bins.insert(key, made.or(parent));
            }
            self.project.pending_bins.insert(path.clone(), bins.get(&rel).copied().flatten());
            out.push(path);
        }
        self.app.history.commit();
        out
    }

    fn poll_import(&mut self) {
        let got = self.importer.poll();
        if got.is_empty() {
            return;
        }
        let mut groups: Vec<(Option<Id>, Vec<serde_json::Value>)> = Vec::new();
        for p in got {
            if let Some(note) = p.note {
                self.import_failed.push((p.path.clone(), note));
            }
            match p.result {
                Ok(media) => {
                    let bin = self.project.pending_bins.remove(&p.path).unwrap_or(self.import_bin);
                    match groups.iter_mut().find(|g| g.0 == bin) {
                        Some(g) => g.1.push(media),
                        None => groups.push((bin, vec![media])),
                    }
                }
                Err(r) => self.import_failed.push((p.path, import::refusal_text(&r))),
            }
        }
        if !groups.is_empty() {
            self.app.history.begin(&tr("Import"));
            for (bin, list) in groups {
                match self.app.history.apply(&crate::cmd::import_media(list, bin)) {
                    Ok(r) => self.import_made += r.get("ids").and_then(|v| v.as_array()).map_or(0, Vec::len),
                    Err(e) => self.app.report(tr(&e.message).into_owned()),
                }
            }
            self.app.history.commit();
        }
        if self.importer.pending() == 0 {
            if !self.import_failed.is_empty() {
                self.dialog = Some(Dialog::ImportErrors(std::mem::take(&mut self.import_failed)));
            } else if self.import_made > 0 {
                self.app.toast(trf("{n} files imported", &[("n", &self.import_made.to_string())]));
            }
        }
    }

    // ---------- the frame ----------

    pub(crate) fn keyboard(&mut self, ctx: &egui::Context) {
        if self.dialog.is_some()
            || self.app.edit.dialog.is_some()
            || self.app.edit.mismatch.open.is_some()
            || crate::prefs::takes_keys(self)
            || self.features.view.find.is_some()
            || self.features.view.buttons.is_some()
        {
            return;
        }
        let typing = ctx.egui_wants_keyboard_input();
        let events = ctx.input(|i| i.events.clone());
        for e in events {
            if let egui::Event::Key { key, pressed: true, modifiers, repeat, .. } = e
                && let Some(id) = keys::action_for(key, modifiers, self.preset, typing)
            {
                if repeat && !(id.starts_with("frame") || id.starts_with("nudge")) {
                    continue;
                }
                if key == egui::Key::Escape && crate::fx::overlay::takes_escape(&self.features.fx) {
                    continue;
                }
                // A panel key goes to the panel with the keyboard: the Project panel keeps Delete, the arrows, Ctrl+A.
                let panel_key = keys::action(id).is_some_and(|a| a.scope == keys::Scope::Panel);
                if panel_key && matches!(self.app.focus, Some(Panel::Project | Panel::History)) {
                    continue;
                }
                self.run_action(id, ctx);
            }
        }
    }

    pub(crate) fn files_dropped(&mut self, ctx: &egui::Context) {
        let dropped: Vec<PathBuf> = ctx.input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_owned()).collect());
        if !dropped.is_empty() && !crate::timeline::direct::drop::files_dropped(self, &dropped, ctx) {
            self.import_paths(dropped, self.project.current_bin());
        }
    }

    /// Gives the window its GPU device: the monitors' engines (made on a thread; the output device, the sound and its
    /// clock open when they come) and the thumbnail workers. Until then the monitors are black and the clock is the
    /// wall's.
    pub fn attach(&mut self, rs: egui_wgpu::RenderState, ctx: &egui::Context) {
        self.monitors_coming = Some(Monitors::spawn(rs, ctx));
        let library = cut_audio::Library::default();
        self.sound_library = Some(library.clone());
        let gb = Some(crate::prefs::number(&self.doc.settings, "cacheLimitGB")).filter(|v| *v > 0.0);
        let limit = (gb.unwrap_or(10.0) * 1024.0 * 1024.0 * 1024.0) as u64;
        let cache = crate::files::cache::Cache::new(self.doc.home.cache.clone(), limit);
        self.thumbs = Some(Thumbs::new(ctx, Some(cache), library));
    }

    /// Sends the sound the project after every change of it or of the sequence.
    fn sync_sound(&mut self) {
        let Some(seq) = self.app.sequence_id else { return };
        let key = (self.app.history.revision(), seq);
        if self.synced != Some(key) {
            self.synced = Some(key);
            self.transport.set_project(Arc::new(self.app.project().clone()), seq);
        }
    }

    /// While playing, the playhead follows the clock frame by frame (player.js `tick`): a move of the playhead by
    /// anything else is a seek; the picture shows whatever frame the clock is at (it skips frames rather than make
    /// the sound wait), the engine decodes two seconds ahead, and playback stops at the end.
    fn playback(&mut self, ctx: &egui::Context) {
        if !self.transport.playing() {
            self.play.active = false;
            self.features.view.stop_at = None;
            return;
        }
        let Some(seq) = self.app.sequence() else {
            self.transport.pause();
            return;
        };
        let (fps, end, seq_id) = (seq.fps, seq.duration(), seq.id);
        let ft = frame_start(1, fps).max(1);
        let rate = self.transport.rate();
        if !self.play.active {
            self.play =
                Play { active: true, last_set: Some(self.app.t), started: Some(Instant::now()), ..Play::default() };
        }
        if self.play.last_set != Some(self.app.t) {
            self.transport.play(self.app.t, rate);
            self.play.last_set = Some(self.app.t);
            self.play.last_frame = None;
        }
        let mut t = self.transport.now().unwrap_or(self.app.t);
        let mut stop = false;
        // the end of the run: the sequence's, or the Out of Play In to Out; with Loop it starts over there
        let (from, limit) = crate::view::play_range(self, end);
        let over = if rate > 0.0 { t >= limit - ft / 2 } else { t <= from };
        if over {
            let last = (limit - ft).max(from);
            if self.features.view.looping && last > from {
                t = if rate > 0.0 { from } else { last };
                self.transport.play(t, rate);
                self.play.last_frame = None;
            } else {
                t = if rate > 0.0 { last } else { from };
                stop = true;
            }
        }
        let frame = frame_at(t.max(0), fps);
        let ts = frame_start(frame, fps);
        if self.play.last_set != Some(ts) {
            self.play.last_set = Some(ts);
            self.app.set_time(ts);
        }
        if self.play.last_frame != Some(frame) {
            self.play.dropped += dropped_between(self.play.last_frame, frame, rate);
            self.play.last_frame = Some(frame);
            self.play.shown += 1;
            if self.play.last_prefetch.is_none_or(|p| (ts - p).abs() > TICKS / 2)
                && let Some(m) = &mut self.monitors
            {
                self.play.last_prefetch = Some(ts);
                m.prefetch(self.app.history.project(), seq_id, ts, rate);
            }
        }
        if stop {
            self.transport.pause();
            self.play.active = false;
        }
        ctx.request_repaint();
    }

    fn closing(&mut self, ctx: &egui::Context) {
        if ctx.input(|i| i.viewport().close_requested()) {
            if self.close_allowed || !self.doc.dirty(&self.app) {
                self.doc.end();
            } else {
                ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
                if self.dialog.is_none() {
                    self.dialog = Some(Dialog::SaveChanges { then: Then::Close, closing: true });
                }
            }
        }
    }

    /// One frame of the editor.
    pub fn frame(&mut self, ui: &mut egui::Ui) {
        let started = Instant::now();
        let ctx = ui.ctx().clone();
        if !self.started_fonts {
            self.setup(&ctx);
        }
        self.closing(&ctx);
        self.poll_ask(&ctx);
        self.poll_import();
        if self.importer.pending() > 0 {
            ctx.request_repaint_after(std::time::Duration::from_millis(50));
        }
        self.files_dropped(&ctx);
        self.keyboard(&ctx);
        if let Some(m) = self.monitors_coming.as_ref().and_then(|rx| rx.try_recv().ok()) {
            self.monitors = Some(m);
            self.monitors_coming = None;
            // the output device with them, off the first frame (opening it takes a few hundred ms)
            if let Some(library) = self.sound_library.take() {
                let (player, error) = Player::new(library);
                self.transport.pause();
                self.transport = Box::new(player);
                self.sound_error = error;
                self.synced = None;
            }
        }
        self.sync_sound();
        self.playback(&ctx);
        let playing = self.transport.playing();
        if let Some(th) = &mut self.thumbs {
            th.begin_frame();
            th.pause(playing);
        }
        let now = now_ms();
        if self.doc.tick(&self.app, now) {
            ctx.request_repaint();
        }
        // at rest the window draws nothing until the next autosave is due (or something else asks for a frame)
        if let Some(ms) = self.doc.next_due(&self.app, now) {
            ctx.request_repaint_after(std::time::Duration::from_millis(ms as u64 + 1));
        }
        // only when it changes: every viewport command asks for another frame, so sending it each frame kept the
        // window drawing 60 frames a second at rest
        let title = self.title();
        if title != self.shown_title {
            ctx.send_viewport_cmd(egui::ViewportCommand::Title(title.clone()));
            self.shown_title = title;
        }

        self.drive(&ctx);
        let laid = Instant::now();
        panels::layout(self, ui);
        let shown = Instant::now();
        // the panels in windows of their own, then the dialogs, floating windows and toasts in the window they belong to
        crate::windows::show(self, &ctx);
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f32() * 1000.0;
        let end = Instant::now();
        self.panel_ms.insert("(before the panels)", ms(started, laid));
        self.panel_ms.insert("(layout)", ms(laid, shown));
        self.panel_ms.insert("(windows and dialogs)", ms(shown, end));
        self.frame_ms = ms(started, end);
    }

    /// `CUT_ACTIONS=t=6,selectAtPlayhead,workspace.color,...` drives a run for pictures: once the monitors are up,
    /// each action runs as its menu item would; `t=<seconds>` moves the playhead,
    /// `tab.<project|effects|markers|history>` picks the Editing workspace's lower tab and `mask` selects the first
    /// mask of the selected clip (what a click on its header in Effect Controls does).
    fn drive(&mut self, ctx: &egui::Context) {
        if self.drive.is_empty() || self.monitors.is_none() {
            return;
        }
        for id in std::mem::take(&mut self.drive) {
            match id.as_str() {
                "tab.project" => self.lower_tab = LowerTab::Project,
                "tab.effects" => self.lower_tab = LowerTab::Effects,
                "tab.markers" => self.lower_tab = LowerTab::Markers,
                "tab.history" => self.lower_tab = LowerTab::History,
                // the first mask of the selected video clip, as a click on its header in Effect Controls selects it
                "mask" => {
                    let sel = crate::fx::edit::primary_clip(&self.app).and_then(|c| {
                        let m = c.masks.as_ref()?.first()?;
                        Some(crate::fx::overlay::MaskSel { clip: c.id, effect: None, mask: m.id })
                    });
                    self.features.fx.overlay.selected = sel;
                }
                _ => match id.strip_prefix("t=").and_then(|t| t.parse::<f64>().ok()) {
                    Some(t) => self.app.set_time((t * cut_time::TICKS as f64).round() as Ticks),
                    None => self.run_action(&id, ctx),
                },
            }
        }
    }

    /// The tool a Tools panel group shows (its last used one, `cut.toolGroups`).
    pub fn tools_last(&self, group: usize) -> crate::state::Tool {
        self.tool_groups[group]
    }

    pub fn set_tools_last(&mut self, group: usize, tool: crate::state::Tool) {
        self.tool_groups[group] = tool;
    }

    /// The panel that has the keyboard.
    pub fn focus(&mut self, panel: Panel) {
        self.app.focus = Some(panel);
    }
}

impl eframe::App for Shell {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        if self.monitors.is_none()
            && self.monitors_coming.is_none()
            && let Some(rs) = frame.wgpu_render_state()
        {
            let ctx = ui.ctx().clone();
            self.attach(rs.clone(), &ctx);
        }
        self.frame_cpu_ms = frame.info().cpu_usage.unwrap_or(0.0) * 1000.0;
        crate::windows::screens(self, frame);
        self.frame(ui);
    }

    fn on_exit(&mut self) {
        self.doc.end();
    }
}
