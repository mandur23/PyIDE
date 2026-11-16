//! Editing clips where they are on the timeline (`ui-timeline.js`'s `addTextAt`, its double click and its drop of
//! Explorer files, `ui-auto.js`'s clip menu part, `ui-proxy.js`'s and `ui-project.js`'s marks), with what the
//! JavaScript does not have done the native way:
//!
//! - The Type tool on a video track makes a text clip there and opens the in-place editor on the Program monitor, the
//!   whole visit one undo step; a double click on a text clip edits it in place with the playhead in the clip.
//! - A double click on a clip's name opens a field over its bar: Enter or a click elsewhere renames it (one step),
//!   Escape leaves it ([`rename`]).
//! - A double click on a still, a graphic or a solid selects it alone with the playhead in it, so the Program monitor
//!   shows its transform box; on a transition it opens the transition in Effect Controls.
//! - Files dropped from Explorer onto a track are imported and placed there, one undo step ([`drop`]).
//! - The clip menu's Audio Role, Automation, Replace With Clip, Replace Image and Reveal in Project ([`menu`]).
//! - Offline media and proxies are marked on the clips ([`badges`]).
//!
//! Everything here runs on the UI thread except the probes of dropped and replacing files (their own importer's
//! threads, at most four) and the file dialog of Replace Image (a thread of its own).

pub mod badges;
pub mod drop;
pub mod menu;
pub mod rename;

use cut_model::commands::build as C;
use cut_model::{Generator, Id, Sequence, Source};
use cut_time::{Ticks, snap};
use eframe::egui::{self, Pos2, Rect};
use serde_json::json;

use super::Timeline;
use super::bands::{self, Extra};
use super::layout::RowKind;
use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::{App, Panel, Tool};

/// Texts only these screens show, for [`crate::i18n`].
pub const KO: [(&str, &str); 8] = [
    ("Reveal in Project", "프로젝트에서 보기"),
    ("Replace With Clip", "클립으로 바꾸기"),
    ("From Source Monitor", "소스 모니터에서"),
    ("Replace Image…", "이미지 바꾸기…"),
    ("Open a clip in the Source Monitor first.", "먼저 소스 모니터에 클립을 여세요."),
    ("The source is shorter than the clip.", "소스가 클립보다 짧습니다."),
    ("Choose an image file.", "이미지 파일을 고르세요."),
    ("Replace", "바꾸기"),
];

/// What the timeline asks of the shell, which it cannot reach from the panel (it gets only the [`App`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ask {
    /// The in-place text editor on the Program monitor; `created`: the Type tool's step is open and becomes the visit's.
    EditText { clip: Id, created: bool },
    /// The clip's media (or nested sequence) selected in the Project panel.
    Reveal(Id),
    /// A file dialog for the image that replaces a still clip's.
    ReplaceImage(Id),
}

/// The timeline's direct-editing state.
#[derive(Default)]
pub struct Direct {
    /// The lanes on screen at the last frame (files dropped on the window are placed when they land there).
    pub lanes: Option<Rect>,
    pub rename: Option<rename::Rename>,
    pub asks: Vec<Ask>,
    pub marks: badges::Marks,
    pub drops: drop::Drops,
    picking: Option<menu::Picking>,
    /// The media files' check since this timeline was made (a project opened makes a new one).
    check: Check,
}

/// The check of the media files a project opens with: due, running on a thread (it asks the disk about each file),
/// or done.
#[derive(Default)]
enum Check {
    #[default]
    Due,
    Running(std::sync::mpsc::Receiver<Vec<Id>>),
    Done,
}

impl Timeline {
    /// The Type tool on the lanes (`addTextAt`): a text clip at the frame under the pointer on that video track,
    /// selected, the playhead on it, the Selection tool back, and the editor open on the Program monitor.
    pub(super) fn type_at(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2) {
        let h = self.hit_at(lanes, p);
        let Some(track) =
            h.row.and_then(|i| self.layout.rows.get(i)).filter(|r| r.kind == RowKind::Video).and_then(|r| r.id)
        else {
            app.toast(tr("Click a video track to add text."));
            return;
        };
        let at = snap(h.t.max(0.0) as Ticks, seq.fps, true);
        let layer = cut_model::defaults::text_layer(&[("text".to_owned(), json!(tr("Title")))].into_iter().collect());
        let cmd = C::add_generated(
            seq.id.as_str(),
            json!({
                "track": track.as_str(), "at": at, "name": tr("Text"),
                "source": { "generator": "text", "layers": [layer] },
            }),
        );
        app.history.begin(&cut_model::commands::label(&cmd));
        let made = match app.history.apply(&cmd) {
            Ok(r) => r["id"].as_str().map(Id::new),
            Err(e) => {
                app.report(tr(&e.message).into_owned());
                None
            }
        };
        let Some(id) = made else {
            app.history.cancel();
            return;
        };
        app.select([id], false, false);
        app.tool = Tool::Select;
        app.set_time(at);
        self.direct.asks.push(Ask::EditText { clip: id, created: true });
    }

    /// A double click with the Selection tool on the lanes -> whether it was one of these: a clip's name, a text clip,
    /// a still or graphic, a transition.
    pub(super) fn direct_double(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2) -> bool {
        let pos = (f64::from(p.x - lanes.left()), p.y - lanes.top());
        let hit = self.hit_at(lanes, p);
        if let Some(Extra::Transition { id, .. }) =
            bands::extra(app.project(), seq, &self.layout, &self.view, &app.edit.band, &hit, pos)
        {
            app.selection.clear();
            app.edit.transition = Some(id);
            app.edit.request("window.controls");
            return true;
        }
        let Some(c) = hit.clip.and_then(|id| seq.clip(id)) else { return false };
        if let Some(r) = self.label_rect(seq, c.id, lanes)
            && r.contains(p)
        {
            self.direct.rename = Some(rename::Rename::new(c));
            return true;
        }
        match &c.source {
            Source::Generator { generator: Generator::Text, .. } => {
                self.direct.asks.push(Ask::EditText { clip: c.id, created: false });
                true
            }
            Source::Generator { generator: Generator::Adjustment, .. } => false,
            _ if app.project().is_still(c) && !c.is_freeze() => {
                app.select([c.id], false, false);
                if !(c.start <= app.t && app.t < c.end()) {
                    app.set_time(c.start);
                }
                app.focus = Some(Panel::Program);
                true
            }
            _ => false,
        }
    }

    /// Where a clip's name is drawn on screen: the top strip of its bar after the fx badge.
    pub(super) fn label_rect(&self, seq: &Sequence, clip: Id, lanes: Rect) -> Option<Rect> {
        let c = seq.clip(clip)?;
        let row = self.layout.row_of(c.track)?;
        let kind = seq.kind_of(c.track)?;
        let (cy, _) = bands::clip_box(row, &self.view);
        let x0 = lanes.left() + self.view.x_of(c.start) as f32;
        let x1 = lanes.left() + self.view.x_of(c.end()) as f32;
        let w = x1 - x0;
        let left = x0.max(lanes.left()) + 2.0 + super::marks::badge_w(c, kind, w);
        let top = lanes.top() + cy;
        (x1 - left > 8.0)
            .then(|| Rect::from_min_max(egui::pos2(left, top), egui::pos2(x1.min(lanes.right()), top + 15.0)))
    }

    /// The direct editing drawn over the lanes each frame: the rename field and the guide of files dragged in.
    pub(super) fn direct_ui(&mut self, ui: &mut egui::Ui, lanes: Rect, app: &mut App, seq: &Sequence) {
        self.direct.lanes = Some(lanes);
        self.rename_ui(ui, lanes, app, seq);
        drop::guide(ui, lanes);
    }

    /// Whether a press at `p` belongs to the rename field, not to the lanes.
    pub(super) fn direct_blocks(&self, p: Pos2) -> bool {
        self.direct.rename.as_ref().and_then(|r| r.rect).is_some_and(|r| r.contains(p))
    }
}

/// `CUT_ACTIONS`' ids for pictures (no menu has them, as `controls.fold.*`): `direct.menu` opens the selected clip's
/// menu on its bar, `direct.rename` its name field.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    matches!(id, "direct.menu" | "direct.rename").then(|| crate::fx::edit::primary_clip(&s.app).is_some())
}

/// Runs one of these ids -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    let (Some(lanes), Some(seq)) = (s.timeline.direct.lanes, s.app.sequence().cloned()) else { return false };
    let Some(c) = crate::fx::edit::primary_clip(&s.app).cloned() else { return false };
    match id {
        "direct.menu" => {
            if let Some(r) = s.timeline.label_rect(&seq, c.id, lanes) {
                s.timeline.open_clip_menu(r.left_bottom(), c.id);
            }
        }
        "direct.rename" => s.timeline.direct.rename = Some(rename::Rename::new(&c)),
        _ => return false,
    }
    true
}

/// Once a frame, after the panels: the timeline's asks, the marks it draws, files dropped on it.
pub fn frame(s: &mut Shell, ctx: &egui::Context) {
    s.timeline.direct.check = match std::mem::take(&mut s.timeline.direct.check) {
        Check::Due => {
            let files: Vec<(Id, String)> = s.app.project().media.iter().map(|m| (m.id, m.path.clone())).collect();
            let (tx, rx) = std::sync::mpsc::channel();
            let wake = ctx.clone();
            std::thread::spawn(move || {
                let _ = tx.send(crate::prefs::relink::offline_of(&files));
                wake.request_repaint();
            });
            Check::Running(rx)
        }
        Check::Running(rx) => match rx.try_recv() {
            Ok(ids) => {
                s.features.prefs.relink.offline = ids.iter().copied().collect();
                crate::prefs::relink::offer(s, ids);
                Check::Done
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => Check::Running(rx),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Check::Done,
        },
        Check::Done => Check::Done,
    };
    // the editor opens once the click is over: a release on the timeline would take its field's keyboard away
    let down = ctx.input(|i| i.pointer.any_down());
    for ask in std::mem::take(&mut s.timeline.direct.asks) {
        match ask {
            Ask::EditText { .. } if down => s.timeline.direct.asks.push(ask),
            Ask::EditText { clip, created } => {
                crate::text_ui::editor::open(s, clip, created, None);
            }
            Ask::Reveal(id) => {
                let p = s.app.project().clone();
                s.project.reveal(&p, id);
                s.run_action("window.project", ctx);
            }
            Ask::ReplaceImage(clip) => menu::ask_image(s, clip, ctx),
        }
    }
    if badges::refresh(s) {
        ctx.request_repaint();
    }
    drop::frame(s, ctx);
    menu::poll(s, ctx);
    crate::panels::media_marks::frame(s, ctx);
}
