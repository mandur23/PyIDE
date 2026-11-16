//! The timeline's editing gestures and menus (port of the parts of `ui-timeline.js`'s `onDown`, `onUp`, `rulerDown`,
//! the context menus, the double-click, `buildTabs`, the track header's source patch and target toggles and
//! `trackMenu`, and the drop of a source monitor drag): the panel calls these from its own input handling, and they
//! turn what [`super::tools`] and [`crate::edit`] decide into commands, selections and drags.

use cut_model::commands::build as C;
use cut_model::keyframes as K;
use cut_model::{Id, Sequence, TrackKind};
use cut_time::{Ticks, snap};
use eframe::egui::{self, Button, Color32, Pos2, Rect, RichText, Stroke, Vec2};
use serde_json::{Value as Json, json};

use super::bands::{self, Extra};
use super::gesture::{self, Mods};
use super::layout::{self, Part, RowKind};
use super::tools::{self, At, Live, MarkerDrag, Pressed};
use super::{Drag, Timeline};
use crate::edit::dialogs::EditDialog;
use crate::edit::source::{SourceClip, SourceDrag, SourceItem};
use crate::edit::{self as E, Band, Patch};
use crate::i18n::tr;
use crate::state::{App, Panel, Tool};
use crate::theme::Palette;

/// The clip labels (`LABELS`, `LABEL_NAMES`).
pub const LABELS: [(&str, &str, Color32); 8] = [
    ("violet", "Violet", Color32::from_rgb(0x8a, 0x6b, 0xd6)),
    ("iris", "Iris", Color32::from_rgb(0x6c, 0x7f, 0xe0)),
    ("caribbean", "Caribbean", Color32::from_rgb(0x22, 0xa0, 0x8c)),
    ("lavender", "Lavender", Color32::from_rgb(0xb9, 0x8a, 0xd8)),
    ("cerulean", "Cerulean", Color32::from_rgb(0x2f, 0x8a, 0xd0)),
    ("forest", "Forest", Color32::from_rgb(0x4f, 0x8c, 0x3a)),
    ("rose", "Rose", Color32::from_rgb(0xcf, 0x5a, 0x7a)),
    ("mango", "Mango", Color32::from_rgb(0xd9, 0x96, 0x2e)),
];

/// The close glyph of a tab (Segoe MDL2 Assets).
const CLOSE: &str = "\u{E711}";

/// The clip menu's quick speeds (`QUICK_SPEEDS`).
const QUICK_SPEEDS: [f64; 7] = [25.0, 50.0, 75.0, 100.0, 150.0, 200.0, 400.0];

/// What a context menu is about.
#[derive(Debug, Clone, PartialEq)]
pub enum Menu {
    Clip(Id),
    Transition(Id),
    Keyframe { clip: Id, prop: &'static str, index: usize },
    RemapKey { clip: Id, index: usize },
    Band(Id),
    Lanes,
    Ruler(Option<Id>),
    Track(Id),
}

/// The editing state of the panel that is not the app's: the menu open, the clip under the pointer.
#[derive(Debug, Default)]
pub struct Local {
    menu: Option<(Pos2, Menu)>,
    pub hover: Option<Id>,
}

impl Timeline {
    fn snaps_for(&self, seq: &Sequence, app: &App) -> impl Fn(&[Id]) -> Vec<Ticks> + '_ {
        let (t, io) = (app.t, [app.in_out.in_, app.in_out.out]);
        let seq = seq.clone();
        move |ex: &[Id]| self.layout.snap_points(&seq, t, io, ex)
    }

    /// A press on the lanes the editing tools and handles take (`onDown`'s cases before the trims and moves).
    /// -> whether it was one.
    pub(super) fn press_edit(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2, m: Mods) -> bool {
        app.edit.transition = None;
        app.edit.gap = None;
        let pos = (f64::from(p.x - lanes.left()), p.y - lanes.top());
        let hit = self.hit_at(lanes, p);
        let extra = bands::extra(app.project(), seq, &self.layout, &self.view, &app.edit.band, &hit, pos);
        let frame = super::frame_of(seq);
        let pressed = {
            let snaps = self.snaps_for(seq, app);
            let at = At {
                project: app.project(),
                seq,
                layout: &self.layout,
                view: &self.view,
                bands: &app.edit.band,
                hit: &hit,
                extra,
                pos,
                frame,
            };
            tools::press(&at, app.tool, m, &snaps)
        };
        let Some(pressed) = pressed else { return false };
        let selection = app.selected();
        let select = |app: &mut App, c: Option<Id>| {
            if let Some(c) = c {
                Self::apply_selection(
                    app,
                    gesture::press_selection(seq, &selection, c, Mods { ctrl: false, ..m }, app.linked_selection),
                );
            }
        };
        match pressed {
            Pressed::Nothing => {}
            Pressed::Live { select: c, live, first } => {
                select(app, c);
                let mut open = false;
                if let Some(cmd) = first {
                    app.history.begin(live.label);
                    open = true;
                    if let Err(e) = app.history.apply(&cmd) {
                        app.report(tr(&e.message).into_owned());
                    }
                }
                self.drag = Drag::Tool { d: live, open, source_end: false };
            }
            Pressed::Exec { select: c, cmd } => {
                select(app, c);
                app.exec(&cmd);
            }
            Pressed::Refuse { select: c, why } => {
                select(app, c);
                app.toast(tr(why));
            }
            Pressed::Transition { id, live } => {
                app.selection.clear();
                app.edit.transition = Some(id);
                self.drag = Drag::Tool { d: live, open: false, source_end: false };
            }
            Pressed::FxMenu(c) => {
                select(app, Some(c));
                if seq.kind_of(seq.clip(c).map_or(c, |x| x.track)) == Some(TrackKind::Video) {
                    self.edit.menu = Some((p, Menu::Band(c)));
                }
            }
        }
        true
    }

    /// One step of a live drag: the last try taken back and the new one done in the drag's history group.
    pub(super) fn step_tool(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2, m: Mods) {
        let Drag::Tool { d, open, source_end } = &mut self.drag else { return };
        let pos = (f64::from(p.x - lanes.left()), p.y - lanes.top());
        let Some(c) = d.step(seq, &self.view, pos, m, app.snapping, super::frame_of(seq)) else { return };
        if *open {
            app.history.cancel();
        }
        app.history.begin(d.label);
        *open = true;
        let r = app.history.apply(&c);
        *source_end |= Live::source_end(&r);
        self.tip = Some(d.tip(&r, app.sequence()));
        // a slip shows the clip's first and last frame, a slide the frames on either side of its new start
        let f = super::frame_of(seq);
        let applied = r.as_ref().ok().and_then(|v| v.get("applied")).and_then(Json::as_i64).unwrap_or(0);
        self.trim_view = match d.kind {
            tools::LiveKind::Slip { clip } => seq.clip(clip).map(|c| [Some(c.start), Some(c.end() - f)]),
            tools::LiveKind::Slide { s0, .. } => {
                Some([(s0 + applied >= f).then(|| s0 + applied - f), Some(s0 + applied)])
            }
            _ => None,
        };
    }

    /// The release of a live drag: kept when it moved (a Pen keyframe always), else taken back.
    pub(super) fn release_tool(app: &mut App, d: &Live, open: bool, source_end: bool) {
        if open {
            if d.moved || d.keep_unmoved {
                app.history.commit();
            } else {
                app.history.cancel();
            }
            app.prune_selection();
        }
        if d.moved && source_end {
            app.toast(tr("Source end"));
        }
    }

    /// A press on the ruler's markers (`markerHit`): a drag of the marker.
    pub(super) fn press_ruler(&mut self, app: &App, seq: &Sequence, ruler: Rect, p: Pos2) -> bool {
        let x = f64::from(p.x - ruler.left());
        let Some((mk, end)) = tools::marker_hit(seq, &self.view, x, p.y - ruler.top()) else { return false };
        let pts = self.layout.snap_points(seq, app.t, [app.in_out.in_, app.in_out.out], &[]);
        self.drag = Drag::Marker(MarkerDrag::new(mk, end, &pts, x));
        true
    }

    pub(super) fn step_marker(&mut self, app: &App, seq: &Sequence, ruler: Rect, p: Pos2) {
        let Drag::Marker(d) = &mut self.drag else { return };
        d.step(&self.view, f64::from(p.x - ruler.left()), app.snapping, super::frame_of(seq));
        if d.moved {
            self.tip = Some(cut_time::timecode(if d.end { d.duration } else { d.t }, seq.fps));
        }
    }

    pub(super) fn release_marker(app: &mut App, seq: &Sequence, d: &MarkerDrag) {
        match d.finish(seq) {
            Ok(Some(c)) => {
                app.exec(&c);
            }
            Ok(None) => {}
            Err(t) => app.set_time(t),
        }
    }

    /// The guide line of a live or marker drag.
    pub(super) fn edit_guide(&self) -> Option<Ticks> {
        match &self.drag {
            Drag::Tool { d, .. } => d.guide,
            Drag::Marker(d) => d.guide,
            _ => None,
        }
    }

    /// The cursor over the lanes for the editing tools and handles (`hover`).
    pub(super) fn edit_cursor(&mut self, app: &App, seq: &Sequence, lanes: Rect, p: Pos2) -> Option<egui::CursorIcon> {
        use egui::CursorIcon as I;
        let hit = self.hit_at(lanes, p);
        let pos = (f64::from(p.x - lanes.left()), p.y - lanes.top());
        let extra = bands::extra(app.project(), seq, &self.layout, &self.view, &app.edit.band, &hit, pos);
        self.edit.hover = hit.clip;
        let edge = matches!(hit.part, Some(Part::Start | Part::End)) && extra.is_none();
        Some(match (app.tool, extra) {
            (Tool::Slip, _) if hit.clip.is_some() => I::ResizeHorizontal,
            (Tool::Slide, _) if hit.clip.is_some() => I::Move,
            (Tool::Rate, None) if edge => I::ResizeColumn,
            (Tool::Pen, Some(Extra::Keyframe { .. })) => I::Move,
            (Tool::Pen, _) => I::Cell,
            (
                Tool::Select | Tool::Ripple | Tool::Roll | Tool::Rate | Tool::TrackForward | Tool::TrackBackward,
                Some(e),
            ) => match e {
                Extra::Transition { part: bands::TPart::Body, .. } => I::Grab,
                Extra::Transition { .. } | Extra::RemapKey { .. } | Extra::Fade { .. } => I::ResizeHorizontal,
                Extra::Line { .. } | Extra::RemapLine(_) => I::ResizeVertical,
                Extra::Keyframe { .. } => I::Move,
                Extra::Fx(_) => return None,
            },
            _ => return None,
        })
    }

    /// A click on an empty spot that did not become a marquee picks the gap there (`gapAt`).
    pub(super) fn pick_gap(&self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2) {
        let h = self.hit_at(lanes, p);
        let row = h.row.and_then(|i| self.layout.rows.get(i));
        app.edit.gap = row
            .filter(|r| matches!(r.kind, RowKind::Video | RowKind::Audio))
            .and_then(|r| r.id)
            .and_then(|tr| E::gap_at(seq, tr, h.t.max(0.0) as Ticks));
    }

    /// Double clicks and context menus over the ruler and the lanes.
    pub(super) fn edit_input(
        &mut self,
        ui: &mut egui::Ui,
        resp: &egui::Response,
        [ruler, lanes]: [Rect; 2],
        app: &mut App,
        seq: &Sequence,
    ) {
        let pointer = ui.ctx().pointer_latest_pos();
        if let Some(p) = pointer.filter(|_| resp.double_clicked()) {
            if ruler.contains(p) {
                if let Some((mk, _)) =
                    tools::marker_hit(seq, &self.view, f64::from(p.x - ruler.left()), p.y - ruler.top())
                {
                    app.edit.dialog = EditDialog::marker(app, mk.id);
                }
            } else if lanes.contains(p) && app.tool == Tool::Select && !self.direct_double(app, seq, lanes, p) {
                self.double_click(app, seq, lanes, p);
            }
        }
        if let Some(p) = pointer.filter(|_| resp.secondary_clicked()) {
            app.focus = Some(Panel::Timeline);
            let menu = if ruler.contains(p) {
                let mk = tools::marker_hit(seq, &self.view, f64::from(p.x - ruler.left()), p.y - ruler.top())
                    .map(|(m, _)| m.id);
                Some(Menu::Ruler(mk))
            } else if lanes.contains(p) {
                Some(self.lanes_menu(app, seq, lanes, p))
            } else {
                None
            };
            self.edit.menu = menu.map(|m| (p, m));
        }
        self.show_menu(ui, app, seq);
    }

    /// The double clicks [`Timeline::direct_double`] leaves: a nest opens its sequence, a media clip its media in the
    /// Source Monitor.
    fn double_click(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2) {
        let hit = self.hit_at(lanes, p);
        let Some(c) = hit.clip.and_then(|id| seq.clip(id)) else { return };
        if c.is_nest() {
            open_nest(app, seq, c);
        } else if !c.is_generator() {
            reveal_in_source(app, c);
        }
    }

    /// Opens a clip's menu at `at` as a right click on it does.
    pub(super) fn open_clip_menu(&mut self, at: Pos2, clip: Id) {
        self.edit.menu = Some((at, Menu::Clip(clip)));
    }

    /// Whether a clip's menu is open (its Automation items ask the shell what can run).
    pub fn clip_menu_open(&self) -> bool {
        matches!(self.edit.menu, Some((_, Menu::Clip(_))))
    }

    fn lanes_menu(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2) -> Menu {
        let pos = (f64::from(p.x - lanes.left()), p.y - lanes.top());
        let hit = self.hit_at(lanes, p);
        match bands::extra(app.project(), seq, &self.layout, &self.view, &app.edit.band, &hit, pos) {
            Some(Extra::Transition { id, .. }) => {
                app.edit.transition = Some(id);
                return Menu::Transition(id);
            }
            Some(Extra::Keyframe { clip, prop, index }) => return Menu::Keyframe { clip, prop, index },
            Some(Extra::RemapKey { clip, index, .. }) => return Menu::RemapKey { clip, index },
            _ => {}
        }
        if let Some(c) = hit.clip {
            if !app.selection.contains(&c) {
                let sel = app.selected();
                Self::apply_selection(
                    app,
                    gesture::press_selection(seq, &sel, c, Mods::default(), app.linked_selection),
                );
            }
            return Menu::Clip(c);
        }
        self.pick_gap(app, seq, lanes, p);
        Menu::Lanes
    }

    fn show_menu(&mut self, ui: &mut egui::Ui, app: &mut App, seq: &Sequence) {
        let Some((at, menu)) = self.edit.menu.clone() else { return };
        let mut open = true;
        let mut done = false;
        egui::Popup::new(ui.scope_id().with("timeline-menu"), ui.ctx().clone(), at, ui.layer_id())
            .kind(egui::PopupKind::Menu)
            .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
            .open_bool(&mut open)
            .show(|ui| {
                ui.set_min_width(200.0);
                done = menu_ui(ui, app, seq, &menu, &mut self.direct);
            });
        if !open || done {
            self.edit.menu = None;
        }
    }

    /// The sequence tabs (`buildTabs`): the active one underlined, a close button when there are two or more.
    pub(super) fn tabs(ui: &mut egui::Ui, app: &mut App, pal: &Palette) {
        let p = app.project();
        let mut tabs: Vec<Id> = app.edit.tabs.iter().copied().filter(|id| p.sequence(*id).is_some()).collect();
        if let Some(active) = app.sequence_id
            && !tabs.contains(&active)
        {
            tabs.push(active);
        }
        let mut pick = None;
        let mut close = None;
        for id in &tabs {
            let Some(s) = p.sequence(*id) else { continue };
            let active = Some(*id) == app.sequence_id;
            let color = if active { pal.gray[12] } else { pal.gray[9] };
            let r = ui.add(Button::new(RichText::new(&s.name).color(color)).frame(false)).on_hover_text(&s.name);
            if active {
                ui.painter().hline(r.rect.x_range(), ui.max_rect().bottom() + 1.5, Stroke::new(2.0, pal.accent));
            }
            if r.clicked() {
                pick = Some(*id);
            }
            if tabs.len() > 1
                && ui
                    .add(Button::new(RichText::new(CLOSE).size(10.0)).frame(false))
                    .on_hover_text(tr("Close"))
                    .clicked()
            {
                close = Some(*id);
            }
            ui.add_space(6.0);
        }
        if let Some(id) = close {
            tabs.retain(|t| *t != id);
            if Some(id) == app.sequence_id
                && let Some(last) = tabs.last()
            {
                app.set_sequence(*last);
            }
        }
        if let Some(id) = pick {
            app.set_sequence(id);
        }
        app.edit.tabs = tabs;
    }

    /// The source patch button of a track header (`V1`, `A1`): on for the track source clips go to.
    pub(super) fn patch_button(
        ui: &mut egui::Ui,
        app: &mut App,
        seq: &Sequence,
        track: Id,
        index: usize,
        kind: TrackKind,
    ) {
        let (v, a) = E::patch_for(seq, &app.edit.patch);
        let on = if kind == TrackKind::Video { v } else { a } == Some(track);
        let letter = format!("{}{}", if kind == TrackKind::Video { "V" } else { "A" }, index + 1);
        let r = ui
            .add(Button::new(RichText::new(letter).size(10.5)).selected(on).min_size(Vec2::new(24.0, 20.0)))
            .on_hover_text(tr("Source Patch: place source clips on this track"));
        if r.clicked() {
            app.edit.patch = E::toggle_patch(seq, &app.edit.patch, track);
        }
    }

    /// The track targeting toggle (the track's name, as Premiere's): which tracks the edits take.
    pub(super) fn target_button(
        ui: &mut egui::Ui,
        app: &mut App,
        seq: &Sequence,
        track: Id,
        name: &str,
        pal: &Palette,
    ) {
        let on = E::is_target(app.edit.targets.as_deref(), track);
        let text = RichText::new(name).strong().color(if on { pal.gray[12] } else { pal.gray[8] });
        let r = ui
            .add(Button::new(text).selected(on).min_size(Vec2::new(26.0, 20.0)))
            .on_hover_text(tr("Toggle Track Targeting"));
        if r.clicked() {
            app.edit.targets = E::toggle_target(seq, app.edit.targets.as_deref(), track);
        }
    }

    /// A right click on a track header opens its menu (`trackMenu`); a double click renames it.
    pub(super) fn head_menu(&mut self, r: &egui::Response, app: &mut App, track: Id, name: &str) {
        if r.secondary_clicked()
            && let Some(p) = r.interact_pointer_pos()
        {
            self.edit.menu = Some((p, Menu::Track(track)));
        }
        if r.double_clicked() {
            app.edit.dialog = Some(EditDialog::RenameTrack { id: track, name: name.to_owned() });
        }
    }

    /// A drag from the source monitor dropped on a track: placed there (overwrite; Ctrl inserts), as `placeItems`.
    pub(super) fn drop_source(&mut self, ui: &mut egui::Ui, lanes: Rect, app: &mut App, seq: &Sequence) {
        let Some(p) = ui.ctx().pointer_latest_pos() else { return };
        if !lanes.contains(p) || !egui::DragAndDrop::has_payload_of_type::<SourceDrag>(ui.ctx()) {
            return;
        }
        ui.painter_at(lanes).vline(p.x, lanes.y_range(), Stroke::new(1.0, Color32::from_rgb(0x4f, 0xc3, 0xf7)));
        if !ui.input(|i| i.pointer.any_released()) {
            return;
        }
        let Some(d) = egui::DragAndDrop::take_payload::<SourceDrag>(ui.ctx()) else { return };
        let h = self.hit_at(lanes, p);
        let row = h.row.and_then(|i| self.layout.rows.get(i)).map(|r| (r.kind, r.index, r.id));
        let mode = if ui.input(|i| i.modifiers.ctrl) { "insert" } else { "overwrite" };
        let mut at = snap(h.t.max(0.0) as Ticks, seq.fps, true);
        if app.snapping {
            let pts = self.layout.snap_points(seq, app.t, [app.in_out.in_, app.in_out.out], &[]);
            at += layout::snap_delta(&[at], 0, &pts, layout::snap_limit(self.view.pps)).0;
        }
        let media = match d.item {
            SourceItem::Media(m) => Some(m),
            SourceItem::Sequence(_) => None,
        };
        let label = if mode == "insert" { "Insert" } else { "Overwrite" };
        E::mismatch::before(app, media, Some(label), move |app: &mut App| {
            let Some(seq) = app.sequence().cloned() else { return };
            match drop_command(app.project(), &seq, &d, row, &app.edit.patch, at.max(0), mode) {
                Ok(c) => {
                    if let Some(r) = app.exec(&c) {
                        let ids = r["results"][0]["ids"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Json::as_str)
                            .map(Id::new);
                        app.select(ids, false, false);
                    }
                }
                Err(why) => app.toast(tr(why)),
            }
        });
    }
}

/// The place command of a source drag dropped on a row (`dropPlan` and `dropTracks`): a video row takes the video
/// and the audio row of its number (the last when there are fewer), an audio row the other way round, elsewhere the
/// patched tracks.
pub fn drop_command(
    project: &cut_model::Project,
    seq: &Sequence,
    d: &SourceDrag,
    row: Option<(RowKind, usize, Option<Id>)>,
    patch: &[Patch; 2],
    at: Ticks,
    mode: &str,
) -> Result<Json, &'static str> {
    if let SourceItem::Sequence(inner) = d.item {
        if project.nest_loop(seq.id, inner) {
            return Err("A sequence cannot be nested inside itself.");
        }
        let k = project.nest_kinds(inner);
        if !k.video && !k.audio {
            return Err("The sequence is empty.");
        }
    }
    let vids: Vec<Id> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).map(|t| t.id).collect();
    let auds: Vec<Id> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).map(|t| t.id).collect();
    let near = |list: &[Id], i: usize| list.get(i.min(list.len().saturating_sub(1))).copied();
    let (vt, at_) = match row {
        Some((RowKind::Video, i, id)) => (id, near(&auds, i)),
        Some((RowKind::Audio, i, id)) => (near(&vids, i), id),
        _ => {
            let (v, a) = E::patch_for(seq, patch);
            (v.or(vids.first().copied()), a.or(auds.first().copied()))
        }
    };
    let (has_v, has_a) = crate::edit::source::kinds(project, d.item);
    let video = if has_v && d.video { vt } else { None };
    let audio = if has_a && d.audio { at_ } else { None };
    if video.is_none() && audio.is_none() {
        return Err("Choose a target track.");
    }
    let source = match d.item {
        SourceItem::Media(m) => json!({ "media": m.as_str() }),
        SourceItem::Sequence(s) => json!({ "sequence": s.as_str() }),
    };
    let mut opts = json!({
        "source": source, "in": d.in_, "at": at, "mode": mode,
        "video": video.map(Id::as_str), "audio": audio.map(Id::as_str),
    });
    if let Some(o) = d.out {
        opts["out"] = json!(o);
    }
    Ok(C::batch(if mode == "insert" { "Insert" } else { "Overwrite" }, vec![C::place(seq.id.as_str(), opts)]))
}

/// A nest clip opens its sequence (a timeline tab) at the frame the playhead shows in it (`openNest`).
pub fn open_nest(app: &mut App, seq: &Sequence, c: &cut_model::Clip) {
    let Some(inner) = app.project().nest_of(c).map(|s| (s.id, s.fps)) else { return };
    let f = super::frame_of(seq);
    let at = app.t.clamp(c.start, (c.end() - f).max(c.start));
    let t = snap(c.source_time(at as f64).max(0.0) as Ticks, inner.1, false);
    if !app.edit.tabs.contains(&seq.id) {
        app.edit.tabs.push(seq.id);
    }
    app.set_sequence(inner.0);
    app.set_time(t);
}

/// Reveal in Source Monitor: the clip's media there with the clip's In/Out (`openInSource`).
pub fn reveal_in_source(app: &mut App, c: &cut_model::Clip) {
    let Some(m) = c.media_id().and_then(|m| app.project().media(m)) else { return };
    let image = m.kind == cut_model::MediaKind::Image;
    let clip = SourceClip {
        item: SourceItem::Media(m.id),
        in_: (!image).then(|| c.in_.round() as Ticks),
        out: (!image).then(|| c.out.round() as Ticks),
        t: c.in_.round() as Ticks,
    };
    app.edit.source.open(clip);
    app.focus = Some(Panel::Source);
}

fn item(ui: &mut egui::Ui, label: &str, key: &str, enabled: bool) -> bool {
    ui.add_enabled(enabled, Button::new(tr(label)).shortcut_text(key)).clicked()
}

/// A track's volume as the header's percentage (`percentOf`): 0 for silence (-144 dB and below).
pub fn track_percent(db: f64) -> f64 {
    if db > -144.0 { 100.0 * 10f64.powf(db / 20.0) } else { 0.0 }
}

/// A percentage as the track's volume in dB (`dbOf` of `clampPercent`): 0 to 200 %, whole, to 0.01 dB.
pub fn track_db(pct: f64) -> f64 {
    let r = cut_audio::util::js_round;
    let p = r(pct).clamp(0.0, 200.0);
    if p <= 0.0 { -144.0 } else { r(2000.0 * (p / 100.0).log10()) / 100.0 }
}

pub(super) fn check(ui: &mut egui::Ui, label: &str, on: bool) -> bool {
    let text = if on { format!("{}  {}", crate::icons::CHECK, tr(label)) } else { format!("     {}", tr(label)) };
    ui.button(text).clicked()
}

/// A menu's items; `true` once one was chosen.
fn menu_ui(ui: &mut egui::Ui, app: &mut App, seq: &Sequence, menu: &Menu, direct: &mut super::direct::Direct) -> bool {
    let s = seq.id.as_str();
    let mut chose = false;
    let act = |ui: &mut egui::Ui, app: &mut App, label: &str, id: &'static str, enabled: bool| {
        let on = item(ui, label, "", enabled);
        if on {
            app.edit.request(id);
        }
        on
    };
    match menu {
        Menu::Clip(cid) => {
            let Some(c) = seq.clip(*cid) else { return true };
            let kind = seq.kind_of(c.track).unwrap_or(TrackKind::Video);
            let clips: Vec<&cut_model::Clip> = app.selected().iter().filter_map(|i| seq.clip(*i)).collect();
            let paste = !app.clipboard.is_empty();
            let linked_any = clips.iter().any(|x| x.link.is_some());
            let p = app.project();
            let still = p.is_still(c);
            let media = c.media_id().and_then(|m| p.media(m)).map(|m| m.kind);
            let speed_ok = clips.iter().any(|x| !p.is_still(x)) && !clips.iter().any(|x| x.remap.is_some());
            let in_clip = c.start <= app.t && app.t < c.end();
            chose |= act(ui, app, "Cut", "cut", true);
            chose |= act(ui, app, "Copy", "copy", true);
            chose |= act(ui, app, "Paste", "paste", paste);
            chose |= act(ui, app, "Paste Insert", "pasteInsert", paste);
            chose |= act(ui, app, "Clear", "delete", true);
            chose |= act(ui, app, "Ripple Delete", "rippleDelete", true);
            ui.separator();
            if check(ui, "Enable", c.enabled) {
                app.edit.request("toggleEnabled");
                chose = true;
            }
            chose |= act(ui, app, if linked_any { "Unlink" } else { "Link" }, "link", linked_any || clips.len() >= 2);
            chose |= act(ui, app, "Group", "group", clips.len() >= 2);
            chose |= act(ui, app, "Ungroup", "ungroup", clips.iter().any(|x| x.group.is_some()));
            chose |= act(ui, app, "Nest…", "nest", !clips.is_empty());
            ui.separator();
            ui.menu_button(tr("Label"), |ui| {
                let mut set = None;
                if check(ui, "None", c.label.is_none()) {
                    set = Some(None);
                }
                for (k, name, _) in LABELS {
                    if check(ui, name, c.label.as_deref() == Some(k)) {
                        set = Some(Some(k));
                    }
                }
                if let Some(label) = set {
                    let list = clips
                        .iter()
                        .map(|x| C::set_clip(s, x.id.as_str(), json!({ "label": label }), json!({})))
                        .collect();
                    app.exec(&C::batch("Clip Settings", list));
                    chose = true;
                }
            });
            ui.separator();
            chose |= act(ui, app, "Speed/Duration…", "speed", true);
            ui.add_enabled_ui(speed_ok, |ui| {
                ui.menu_button(tr("Speed"), |ui| {
                    for q in QUICK_SPEEDS {
                        if check(ui, &format!("{q}%"), (c.speed * 100.0 - q).abs() < 1e-6) {
                            set_speed(app, seq, json!({ "speed": q / 100.0 }));
                            chose = true;
                        }
                    }
                    ui.separator();
                    if check(ui, "Reverse Speed", c.reverse) {
                        set_speed(app, seq, json!({ "reverse": !c.reverse }));
                        chose = true;
                    }
                });
            });
            if kind == TrackKind::Video && !still {
                ui.menu_button(tr("Time Interpolation"), |ui| {
                    for (id, name) in [("sample", "Frame Sampling"), ("blend", "Frame Blending")] {
                        let on = serde_json::to_value(c.sampling).ok().and_then(|v| v.as_str().map(str::to_owned))
                            == Some(id.to_owned());
                        if check(ui, name, on) {
                            set_sampling(app, seq, id);
                            chose = true;
                        }
                    }
                });
            }
            let hold = kind == TrackKind::Video && media.is_some_and(|k| k != cut_model::MediaKind::Image) && in_clip;
            chose |= act(ui, app, "Insert Frame Hold Segment", "freezeFrame", hold);
            chose |= act(ui, app, "Apply Default Transitions to Selection", "transitionBoth", true);
            ui.separator();
            if kind == TrackKind::Video {
                ui.menu_button(tr("Show Clip Keyframes"), |ui| chose |= band_items(ui, app, c));
            }
            if item(ui, "Rename…", "", true) {
                app.edit.dialog = Some(EditDialog::RenameClip { id: c.id, name: c.name.clone() });
                chose = true;
            }
            ui.separator();
            if item(ui, "Reveal in Source Monitor", "", media.is_some()) {
                reveal_in_source(app, c);
                chose = true;
            }
            chose |= act(ui, app, "Match Frame", "matchFrame", media.is_some() && in_clip);
            chose |= super::direct::menu::replace_items(ui, app, c, direct);
            ui.separator();
            chose |= super::direct::menu::auto_items(ui, app, seq, c, direct);
        }
        Menu::Band(cid) => {
            if let Some(c) = seq.clip(*cid) {
                chose = band_items(ui, app, c);
            }
        }
        Menu::Transition(id) => {
            let Some(t) = seq.transitions.iter().find(|t| t.id == *id) else { return true };
            ui.menu_button(tr("Alignment"), |ui| {
                for (a, label) in [("center", "Center at Cut"), ("start", "Start at Cut"), ("end", "End at Cut")] {
                    let on = serde_json::to_value(t.align).ok().and_then(|v| v.as_str().map(str::to_owned))
                        == Some(a.to_owned());
                    if check(ui, label, on) {
                        app.exec(&C::set_transition(s, id.as_str(), json!({ "align": a })));
                        chose = true;
                    }
                }
            });
            if item(ui, "Set Duration…", "", true) {
                app.edit.dialog =
                    Some(EditDialog::TransitionLength { id: *id, text: cut_time::timecode(t.duration, seq.fps) });
                chose = true;
            }
            ui.separator();
            if item(ui, "Clear", "Delete", true) {
                app.exec(&C::remove_transition(s, id.as_str()));
                app.edit.transition = None;
                chose = true;
            }
        }
        Menu::Keyframe { clip, prop, index } => {
            let Some(c) = seq.clip(*clip) else { return true };
            let list = c.keyframes.get(*prop).cloned().unwrap_or_default();
            let Some(k) = list.get(*index).cloned() else { return true };
            for (ease, label) in crate::fx::edit::EASES {
                if check(ui, label, k.ease == ease) {
                    let next = crate::fx::edit::ease_list(&list, &[k.t], ease);
                    app.exec(&C::set_keyframes(s, clip.as_str(), prop, Some(json!(next))));
                    chose = true;
                }
            }
            ui.separator();
            if item(ui, "Delete Keyframe", "", true) {
                let left = K::remove(&list, k.t);
                app.exec(&C::set_keyframes(s, clip.as_str(), prop, (!left.is_empty()).then(|| json!(left))));
                chose = true;
            }
        }
        Menu::RemapKey { clip, index } => {
            let Some(c) = seq.clip(*clip) else { return true };
            let r = c.remap_of();
            let Some(k) = r.keys.get(*index).cloned() else { return true };
            let f = super::frame_of(seq);
            if item(ui, "Join Speed Transition", "", k.ramp > 0) {
                let next = cut_model::remap::split_key(&r, *index, cut_model::remap::Side::Right, -k.ramp, f);
                app.exec(&C::set_remap(s, clip.as_str(), Some(json!(next))));
                chose = true;
            }
            if item(ui, "Delete Keyframe", "", true) {
                let next = cut_model::remap::remove_key(&r, *index, f);
                app.exec(&C::set_remap(s, clip.as_str(), Some(json!(next))));
                chose = true;
            }
        }
        Menu::Lanes => {
            let gap = app.edit.gap.is_some();
            if item(ui, "Close Gap", "", gap) {
                if let Some(g) = app.edit.gap.take() {
                    app.exec(&C::close_gap(s, g.track.as_str(), g.t));
                }
                chose = true;
            }
            let paste = !app.clipboard.is_empty();
            chose |= act(ui, app, "Paste", "paste", paste);
            chose |= act(ui, app, "Paste Insert", "pasteInsert", paste);
            ui.separator();
            for (label, kind) in [("Add Video Track", "video"), ("Add Audio Track", "audio")] {
                if item(ui, label, "", true) {
                    app.exec(&C::add_track(s, kind, None, json!({})));
                    chose = true;
                }
            }
        }
        Menu::Ruler(Some(mid)) => {
            let Some(m) = seq.markers.iter().find(|m| m.id == *mid).cloned() else { return true };
            if item(ui, "Edit Marker…", "", true) {
                app.edit.dialog = EditDialog::marker(app, *mid);
                chose = true;
            }
            ui.menu_button(tr("Color"), |ui| {
                for (k, name, _) in crate::edit::markers::COLORS {
                    if check(ui, name, m.color == k) {
                        app.exec(&C::set_marker(s, mid.as_str(), json!({ "color": k })));
                        chose = true;
                    }
                }
            });
            ui.menu_button(tr("Type"), |ui| {
                for (k, name) in crate::edit::markers::KINDS {
                    if check(ui, name, m.kind == k) {
                        app.exec(&C::set_marker(s, mid.as_str(), json!({ "kind": k })));
                        chose = true;
                    }
                }
            });
            ui.separator();
            if item(ui, "Remove Marker", "", true) {
                app.exec(&C::remove_marker(s, mid.as_str()));
                chose = true;
            }
        }
        Menu::Ruler(None) => {
            let io = app.in_out.in_.is_some() || app.in_out.out.is_some();
            chose |= act(ui, app, "Add Marker", "addMarker", true);
            ui.separator();
            chose |= act(ui, app, "Lift", "lift", io);
            chose |= act(ui, app, "Extract", "extract", io);
            chose |= act(ui, app, "Clear In and Out", "clearInOut", io);
        }
        Menu::Track(tid) => {
            let Some(t) = seq.track(*tid) else { return true };
            let index = seq.track_index(t.id).unwrap_or(0);
            let video = t.kind == TrackKind::Video;
            let kind = if video { "video" } else { "audio" };
            if item(ui, "Rename…", "", true) {
                app.edit.dialog = Some(EditDialog::RenameTrack { id: t.id, name: t.name.clone() });
                chose = true;
            }
            ui.separator();
            let (above, below) = if video {
                ("Add Video Track Above", "Add Video Track Below")
            } else {
                ("Add Audio Track Below", "Add Audio Track Above")
            };
            if item(ui, above, "", true) {
                app.exec(&C::add_track(s, kind, Some(index + 1), json!({})));
                chose = true;
            }
            if item(ui, below, "", true) {
                app.exec(&C::add_track(s, kind, Some(index), json!({})));
                chose = true;
            }
            let more = seq.tracks.iter().filter(|x| x.kind == t.kind).count() > 1;
            if item(ui, "Delete Track", "", more) {
                if seq.clips().any(|c| c.track == t.id) {
                    app.edit.dialog = Some(EditDialog::DeleteTrack { id: t.id, name: t.name.clone() });
                } else {
                    app.exec(&C::remove_track(s, t.id.as_str()));
                }
                chose = true;
            }
            ui.separator();
            if !video {
                ui.menu_button(tr("Track Volume"), |ui| {
                    let now = track_percent(t.volume.unwrap_or(0.0)).round();
                    for p in [0.0, 50.0, 100.0, 150.0, 200.0] {
                        if check(ui, &format!("{p}%"), now == p) {
                            app.exec(&C::set_track(s, t.id.as_str(), json!({ "volume": track_db(p) })));
                            chose = true;
                        }
                    }
                    ui.separator();
                    if item(ui, "Set Volume…", "", true) {
                        let text = format!("{}", track_percent(t.volume.unwrap_or(0.0)).round());
                        app.edit.dialog = Some(EditDialog::TrackVolume { id: t.id, text });
                        chose = true;
                    }
                });
            }
            ui.menu_button(tr("Track Height"), |ui| {
                for (label, h) in [("Small", 32.0), ("Medium", if video { 56.0 } else { 48.0 }), ("Large", 100.0)] {
                    if check(ui, label, t.height == h) {
                        app.exec(&C::set_track(s, t.id.as_str(), json!({ "height": h })));
                        chose = true;
                    }
                }
            });
            if item(ui, "Make Every Track This Height", "", true) {
                let list = seq
                    .tracks
                    .iter()
                    .filter(|x| x.height != t.height)
                    .map(|x| C::set_track(s, x.id.as_str(), json!({ "height": t.height })))
                    .collect::<Vec<_>>();
                if !list.is_empty() {
                    app.exec(&C::batch("Track Height", list));
                }
                chose = true;
            }
        }
    }
    chose
}

/// What a video clip's line shows (`bandItems`): Opacity, or Time Remapping > Speed (not for a still).
fn band_items(ui: &mut egui::Ui, app: &mut App, c: &cut_model::Clip) -> bool {
    let cur = bands::line_of(app.project(), c, TrackKind::Video, &app.edit.band);
    let mut chose = false;
    if check(ui, "Opacity", cur == bands::Line::Prop("opacity")) {
        app.edit.band.insert(c.id, Band::Opacity);
        chose = true;
    }
    let still = app.project().is_still(c);
    ui.add_enabled_ui(!still, |ui| {
        ui.menu_button(tr("Time Remapping"), |ui| {
            if check(ui, "Speed", cur == bands::Line::Remap) {
                app.edit.band.insert(c.id, Band::Remap);
                chose = true;
            }
        });
    });
    chose
}

/// The clip menu's Speed submenu (`setSpeed`): the selected clips with a source get it, later clips moving along; a
/// linked pair changes once. One step.
pub fn set_speed(app: &mut App, seq: &Sequence, patch: Json) {
    let p = app.project();
    let clips: Vec<&cut_model::Clip> =
        app.selected().iter().filter_map(|i| seq.clip(*i)).filter(|x| !p.is_still(x)).collect();
    if clips.is_empty() {
        app.toast(tr("Select a clip first."));
        return;
    }
    let mut done: Vec<Id> = Vec::new();
    let mut list = Vec::new();
    for x in clips {
        if done.contains(&x.id) {
            continue;
        }
        done.push(x.id);
        done.extend(seq.linked_clips(x).iter().map(|l| l.id));
        let mut pt = patch.clone();
        pt["ripple"] = json!(true);
        list.push(C::set_clip(seq.id.as_str(), x.id.as_str(), pt, json!({})));
    }
    app.exec(&C::batch("Clip Settings", list));
}

/// Clip > Time Interpolation: Frame Sampling or Frame Blending for the selected video clips (`setSampling`).
pub fn set_sampling(app: &mut App, seq: &Sequence, sampling: &str) {
    let p = app.project();
    let list: Vec<Json> = app
        .selected()
        .iter()
        .filter_map(|i| seq.clip(*i))
        .filter(|x| seq.kind_of(x.track) == Some(TrackKind::Video) && !p.is_still(x))
        .map(|x| {
            C::set_clip(seq.id.as_str(), x.id.as_str(), json!({ "sampling": sampling }), json!({ "linked": false }))
        })
        .collect();
    if !list.is_empty() {
        app.exec(&C::batch("Time Interpolation", list));
    }
}
