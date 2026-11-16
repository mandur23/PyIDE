//! The Effect Controls panel (port of `ui-controls.js`, video-editor-features.md sections 7 and 8): the selected
//! clip's fixed effects (Motion, Opacity with its masks, Time Remapping, Crop, a text layer's fields; Volume and
//! Panner for sound; Speed) and its applied effects in order, each parameter a row built from the registry
//! (`cut_model::effects`), with the values at the playhead. Each animatable row has a stopwatch, the previous/add/next
//! keyframe buttons and a lane of the clip's span under the panel's own ruler and playhead; when a transition is
//! selected on the timeline, its settings.
//!
//! What a clip shows is data ([`spec::sections`]); the rows ([`rows`]), the lanes ([`lane`], [`interact`]), the
//! masks ([`masks`]) and the keyframe edits ([`keys`]) change the project only through commands run by
//! [`App::exec`](crate::state::App::exec), a drag or a multi-command edit one undo step. Everything runs on the UI
//! thread; the lanes are egui shapes drawn by the window's wgpu renderer.

mod icons;
pub mod interact;
pub mod keys;
pub mod lane;
mod masks;
pub mod rows;
pub mod spec;
mod transition;

use std::collections::{BTreeSet, HashMap, HashSet};

use cut_model::Id;
use cut_model::commands::build as C;
use eframe::egui::{self, Rect, RichText, Sense, Vec2};
use serde_json::json;

use self::icons::Icon;
use self::keys::{Copied, Picked};
use self::spec::{Item, Kind, Section};
use crate::fx::edit::{self, Gesture};
use crate::fx::effects::FxDrag;
use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::Panel;

/// What the panel shows (`pickSubject`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject {
    Clip(Id),
    Transition(Id),
}

/// An effect's header dragged to a new place in the list.
#[derive(Debug, Clone, Copy)]
struct EffectOrder {
    clip: Id,
    effect: Id,
}

/// The panel's state between frames.
#[derive(Debug, Default)]
pub struct Controls {
    /// The folded sections, by their key.
    pub collapsed: HashSet<String>,
    /// The keyframes picked in the lanes.
    pub picked: Vec<Picked>,
    /// Copied keyframes.
    pub board: Vec<Copied>,
    /// A scrub or slider drag of a row.
    pub gesture: Gesture,
    pub drag: Option<interact::Drag>,
    /// The selection the picks were made in (a new selection lets them go).
    seen: BTreeSet<Id>,
    /// Where this frame drew its controls, by name (`<path>/watch`, `<path>/lane`, `masks:opacity/ellipse` ...).
    rects: HashMap<String, Rect>,
    /// Each lane's clip and rectangle this frame, by path (the first row of a path).
    lanes: HashMap<String, (Id, Rect)>,
    /// The applied effects' sections this frame, for a dragged header's new place.
    effect_rects: Vec<(Id, Id, Rect)>,
}

impl Controls {
    /// Remembers where a control was drawn this frame (the first one of a name wins).
    pub fn note(&mut self, name: String, rect: Rect) {
        self.rects.entry(name).or_insert(rect);
    }

    /// Where the control `name` was drawn last frame.
    pub fn rect(&self, name: &str) -> Option<Rect> {
        self.rects.get(name).copied()
    }

    /// The lane of `path` drawn this frame.
    pub fn lane_rect(&self, path: &str) -> Option<Rect> {
        self.lanes.get(path).map(|l| l.1)
    }

    /// The screen point of a lane's keyframe at clip time `t` (`lanePoint`), or with `which` of a bezier handle of
    /// the segment leaving it (and whether it is shown).
    pub fn lane_point(
        &self,
        s: &Shell,
        path: &str,
        t: cut_time::Ticks,
        which: Option<usize>,
    ) -> Option<(egui::Pos2, bool)> {
        let (clip, rect) = *self.lanes.get(path)?;
        let c = s.app.sequence()?.clip(clip)?;
        let list = c.keyframes.get(path)?;
        let i = list.iter().position(|k| k.t == t)?;
        let (w, h) = (f64::from(rect.width()), f64::from(rect.height()));
        let Some(which) = which else {
            let x = lane::lane_x(c.duration(), w, t as f64);
            return Some((egui::pos2(rect.left() + x as f32, rect.center().y), true));
        };
        let seg = lane::segment(c.duration(), list, i, w, h)?;
        let [x, y] = seg.pts?[which];
        Some((egui::pos2(rect.left() + x as f32, rect.top() + y as f32), seg.handles.is_some()))
    }
}

/// What the panel shows now: a transition selected on the timeline while no clip is, else the clip the panels edit.
pub fn subject(s: &Shell) -> Option<Subject> {
    let seq = s.app.sequence()?;
    if let Some(t) = s.app.edit.transition
        && seq.transitions.iter().any(|x| x.id == t)
        && s.app.selection.is_empty()
    {
        return Some(Subject::Transition(t));
    }
    edit::primary_clip(&s.app).map(|c| Subject::Clip(c.id))
}

/// The panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    let st = &mut s.features.controls;
    st.rects.clear();
    st.lanes.clear();
    st.effect_rects.clear();
    let sel: BTreeSet<Id> = s.app.selection.iter().copied().collect();
    if sel != st.seen {
        st.picked.clear();
        st.seen = sel;
    }
    let whole = ui.available_rect_before_wrap();
    if ui.input(|i| i.pointer.any_pressed()) && ui.rect_contains_pointer(whole) {
        s.focus(Panel::Controls);
    }
    let pal = s.palette.clone();
    let subject = subject(s);
    let (title, sub) = match subject {
        Some(Subject::Clip(id)) => {
            let seq = s.app.sequence().expect("a clip's sequence");
            spec::title(s.app.project(), seq, seq.clip(id).expect("the subject clip"))
        }
        Some(Subject::Transition(id)) => (transition::title(s, id), tr("Transition").into_owned()),
        None => (String::new(), String::new()),
    };
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.add(egui::Label::new(RichText::new(title).strong().color(pal.gray[12])).truncate());
        ui.label(RichText::new(sub).size(11.0).color(pal.gray[8]));
    });
    ui.separator();
    let Some(subject) = subject else {
        ui.add_space(16.0);
        ui.vertical_centered(|ui| {
            let text = tr("Select a clip in the timeline to see its properties and effects.");
            ui.label(RichText::new(text).color(pal.gray[8]));
        });
        return;
    };
    let clip = match subject {
        Subject::Transition(id) => {
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| transition::show(s, ui, id));
            drop_target(s, ui, whole, subject);
            return;
        }
        Subject::Clip(id) => id,
    };
    let (ruler, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 18.0), Sense::hover());
    let (_, ruler) = rows::split(ruler);
    let sections = {
        let seq = s.app.sequence().expect("a clip's sequence");
        let c = seq.clip(clip).expect("the subject clip");
        spec::sections(s.app.project(), seq, &s.app.selection, c)
    };
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        for sec in &sections {
            section(s, ui, sec);
        }
        ui.add_space(24.0);
    });
    interact::ruler(s, ui, clip, ruler);
    interact::follow(s, ui);
    reorder(s, ui);
    drop_target(s, ui, whole, subject);
    let st = &mut s.features.controls;
    // a drag whose control went away (its section folded, the clip changed) ends with the button
    if st.gesture.is_open() && !ui.input(|i| i.pointer.any_down()) && !ui.ctx().egui_wants_keyboard_input() {
        st.gesture.end(&mut s.app);
    }
}

/// A section: its header and, unless folded, its lines.
fn section(s: &mut Shell, ui: &mut egui::Ui, sec: &Section) {
    let open = !s.features.controls.collapsed.contains(&sec.id);
    header(s, ui, sec, open);
    if !open {
        return;
    }
    // an effect's own view above its rows (`ui.effectViews`): the filters' frequency response
    if let Kind::Effect { id, .. } = sec.kind {
        crate::audio::response::view(s, ui, sec.clip, id);
    }
    for item in &sec.items {
        match item {
            Item::Heading(name) => {
                let (left, _) = rows::allocate(s, ui, 20.0);
                let p = ui.painter();
                let font = egui::FontId::proportional(11.0);
                p.text(
                    left.left_center() + Vec2::new(24.0, 0.0),
                    egui::Align2::LEFT_CENTER,
                    tr(name),
                    font,
                    s.palette.gray[8],
                );
            }
            Item::Row(spec) => rows::row(s, ui, sec.clip, spec),
            Item::MaskTools(effect) => masks::tools(s, ui, sec.clip, *effect),
            Item::MaskHead { sel, n } => masks::head(s, ui, *sel, *n),
            Item::RemapSpeed => remap_row(s, ui, sec.clip),
        }
    }
}

/// A section's header (`section`): the twisty, an effect's on/off, the name (a double click folds it), Reset and an
/// effect's Move Up, Move Down and Remove; an effect's header is dragged to reorder and has the same in its menu.
fn header(s: &mut Shell, ui: &mut egui::Ui, sec: &Section, open: bool) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 24.0), Sense::hover());
    ui.painter().rect_filled(rect, 0.0, s.palette.gray[2]);
    ui.painter().hline(rect.x_range(), rect.top(), egui::Stroke::new(1.0, s.palette.gray[3]));
    let r = ui.interact(rect, ui.make_persistent_id(("ec-sechead", &sec.id)), Sense::click_and_drag());
    let mut cu = rows::child(ui, rect.shrink2(Vec2::new(4.0, 0.0)));
    cu.spacing_mut().item_spacing.x = 2.0;
    let (accent, yellow) = (s.palette.accent, egui::Color32::from_rgb(0xe6, 0xc2, 0x29));
    let mut fold =
        icons::button(&mut cu, Icon::Twisty(open), &tr(if open { "Collapse" } else { "Expand" }), false, accent)
            .clicked();
    let effect = match sec.kind {
        Kind::Effect { id, index, count } => Some((id, index, count)),
        Kind::Fixed => None,
    };
    let seq = s.app.sequence_id;
    let mut cmd = None;
    let mut reset = false;
    if let Some((e, ..)) = effect {
        let on = s
            .app
            .sequence()
            .and_then(|q| q.clip(sec.clip))
            .and_then(|c| c.effects.iter().find(|x| x.id == e))
            .is_some_and(|x| x.on);
        let b = icons::button(&mut cu, Icon::Fx, &tr("Effect On/Off"), on, yellow);
        s.features.controls.note(format!("sec:{}/fx", sec.id), b.rect);
        if b.clicked()
            && let Some(q) = seq
        {
            cmd = Some(C::set_effect(q.as_str(), sec.clip.as_str(), e.as_str(), json!({ "on": !on })));
        }
    }
    cu.add(egui::Label::new(RichText::new(&sec.name).strong().color(s.palette.gray[11])).truncate());
    let moves = |index: usize, to: usize, e: Id| {
        seq.map(|q| C::move_effect(q.as_str(), sec.clip.as_str(), e.as_str(), to)).filter(|_| index != to)
    };
    cu.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        ui.spacing_mut().item_spacing.x = 1.0;
        if let Some((e, index, count)) = effect {
            let b = icons::button(ui, Icon::Remove, &tr("Remove Effect"), false, accent);
            if b.clicked() {
                cmd = seq.map(|q| C::remove_effect(q.as_str(), sec.clip.as_str(), e.as_str()));
            }
            if index + 1 < count && icons::button(ui, Icon::Down, &tr("Move Down"), false, accent).clicked() {
                cmd = moves(index, index + 1, e);
            }
            if index > 0 && icons::button(ui, Icon::Up, &tr("Move Up"), false, accent).clicked() {
                cmd = moves(index, index - 1, e);
            }
        }
        let b = icons::button(ui, Icon::Reset, &tr("Reset"), false, accent);
        s.features.controls.note(format!("sec:{}/reset", sec.id), b.rect);
        reset |= b.clicked();
    });
    fold |= r.double_clicked();
    if let Some((e, index, count)) = effect {
        s.features.controls.effect_rects.push((sec.clip, e, rect));
        if r.drag_started() {
            egui::DragAndDrop::set_payload(ui.ctx(), EffectOrder { clip: sec.clip, effect: e });
        }
        r.context_menu(|ui| {
            if ui.add_enabled(index > 0, egui::Button::new(tr("Move Up"))).clicked() {
                cmd = moves(index, index.saturating_sub(1), e);
                ui.close();
            }
            if ui.add_enabled(index + 1 < count, egui::Button::new(tr("Move Down"))).clicked() {
                cmd = moves(index, index + 1, e);
                ui.close();
            }
            if ui.button(tr("Reset")).clicked() {
                reset = true;
                ui.close();
            }
            ui.separator();
            if ui.button(tr("Remove Effect")).clicked() {
                cmd = seq.map(|q| C::remove_effect(q.as_str(), sec.clip.as_str(), e.as_str()));
                ui.close();
            }
        });
    }
    s.features.controls.note(format!("sec:{}/head", sec.id), rect);
    if fold {
        let c = &mut s.features.controls.collapsed;
        if !c.remove(&sec.id) {
            c.insert(sec.id.clone());
        }
    }
    if let Some(cmd) = cmd {
        s.app.exec(&cmd);
    }
    if reset {
        let specs: Vec<&spec::Spec> = sec.specs().collect();
        keys::reset(&mut s.app, sec.clip, &specs, effect.map(|e| e.0));
    }
}

/// An effect header dropped among the others: its new index is how many of the other effects sit above the pointer.
fn reorder(s: &mut Shell, ui: &egui::Ui) {
    let Some(p) = egui::DragAndDrop::payload::<EffectOrder>(ui.ctx()) else { return };
    let Some(pos) = ui.ctx().pointer_latest_pos() else { return };
    let others: Vec<Rect> = s
        .features
        .controls
        .effect_rects
        .iter()
        .filter(|(c, e, _)| *c == p.clip && *e != p.effect)
        .map(|x| x.2)
        .collect();
    if let Some(r) = others.iter().find(|r| r.contains(pos)) {
        ui.painter().hline(r.x_range(), r.top(), egui::Stroke::new(2.0, s.palette.accent));
    }
    if !ui.input(|i| i.pointer.any_released()) {
        return;
    }
    egui::DragAndDrop::clear_payload(ui.ctx());
    let index = others.iter().filter(|r| r.center().y < pos.y).count();
    let from =
        s.app.sequence().and_then(|q| q.clip(p.clip)).and_then(|c| c.effects.iter().position(|e| e.id == p.effect));
    if let (Some(from), Some(seq)) = (from, s.app.sequence_id)
        && from != index
    {
        s.app.exec(&C::move_effect(seq.as_str(), p.clip.as_str(), p.effect.as_str(), index));
    }
}

/// An effect dropped on the panel goes on the clip shown; a transition on the transition shown changes its type.
fn drop_target(s: &mut Shell, ui: &egui::Ui, rect: Rect, subject: Subject) {
    let Some(drag) = egui::DragAndDrop::payload::<FxDrag>(ui.ctx()) else { return };
    let Some(pos) = ui.ctx().pointer_latest_pos().filter(|p| rect.contains(*p)) else { return };
    let d = drag.0;
    let fits = matches!((subject, d.transition), (Subject::Clip(_), false) | (Subject::Transition(_), true));
    if !fits {
        return;
    }
    ui.painter().rect_stroke(rect.shrink(1.0), 0.0, egui::Stroke::new(2.0, s.palette.accent), egui::StrokeKind::Inside);
    let _ = pos;
    if !ui.input(|i| i.pointer.any_released()) {
        return;
    }
    egui::DragAndDrop::clear_payload(ui.ctx());
    match subject {
        Subject::Clip(c) => {
            crate::fx::effects::apply_to_clip(&mut s.app, c, d);
        }
        Subject::Transition(t) => {
            if let Some(seq) = s.app.sequence_id {
                s.app.exec(&C::set_transition(seq.as_str(), t.as_str(), json!({ "type": d.id })));
            }
        }
    }
}

/// Time Remapping > Speed (`remapSection`): the speed at the playhead; the stopwatch turns the curve on or off, the
/// diamond adds or removes a key at the playhead, the arrows go to the keys; typing a speed sets the segment under the
/// playhead. The lane draws the speed between the keys.
fn remap_row(s: &mut Shell, ui: &mut egui::Ui, clip: Id) {
    let (left, lane) = rows::allocate(s, ui, rows::ROW_H);
    let Some(seq) = s.app.sequence() else { return };
    let Some(c) = seq.clip(clip) else { return };
    let (keyed, t) = (keys::remap_keyed(c), s.app.t);
    let speed = (keys::remap_speed(seq, c, t).abs() * 10000.0).round() / 100.0;
    let here = keyed
        && edit::in_clip(c, t)
        && c.remap.as_ref().is_some_and(|r| r.keys.iter().any(|k| k.t == edit::clip_time(seq, c, t)));
    let colors = lane::Colors {
        line: s.palette.gray[4],
        curve: s.palette.gray[8],
        text: s.palette.gray[10],
        accent: s.palette.accent,
        playhead: s.palette.playhead,
    };
    lane::paint_remap(ui.painter(), lane, &c.remap_of(), c.duration(), &colors);
    if edit::in_clip(c, t) {
        let x = (lane.left() + lane::lane_x(c.duration(), f64::from(lane.width()), (t - c.start) as f64) as f32)
            .round()
            + 0.5;
        ui.painter().vline(x, lane.y_range(), egui::Stroke::new(1.0, s.palette.playhead));
    }
    let accent = s.palette.accent;
    let mut cu = rows::child(ui, left.shrink2(Vec2::new(4.0, 0.0)));
    cu.spacing_mut().item_spacing.x = 4.0;
    let mut act = 0;
    let w = icons::button(&mut cu, Icon::Watch, &tr("Toggle Animation"), keyed, accent);
    s.features.controls.note("remap.speed/watch".into(), w.rect);
    if w.clicked() {
        act = 3;
    }
    let name = rows::label(&mut cu, &tr("Speed"), s.palette.gray[10], 0.0).id;
    let n = crate::fx::widgets::Num {
        decimals: 2,
        ..crate::fx::widgets::Num::new(Some(1.0), Some(10000.0), Some(1.0), "%")
    };
    let (ch, r) = crate::fx::widgets::number_named(&mut cu, speed, n, Some(name));
    s.features.controls.note("remap.speed/value".into(), r.rect);
    if keyed {
        cu.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            for (a, icon, tip, name) in [
                (1, Icon::Next, "Go to Next Keyframe", "next"),
                (2, if here { Icon::KeyOn } else { Icon::Key }, "Add/Remove Keyframe", "add"),
                (-1, Icon::Prev, "Go to Previous Keyframe", "prev"),
            ] {
                let b = icons::button(ui, icon, &tr(tip), a == 2 && here, accent);
                s.features.controls.note(format!("remap.speed/{name}"), b.rect);
                if b.clicked() {
                    act = a;
                }
            }
        });
    }
    let r = ui.interact(lane, ui.make_persistent_id(("ec-remap-lane", clip)), Sense::click());
    if r.clicked()
        && let Some(p) = r.interact_pointer_pos()
        && let Some(c) = s.app.sequence().and_then(|q| q.clip(clip))
    {
        let f = s.app.sequence().map_or(1, edit::frame);
        let tt = lane::lane_t(c.duration(), f64::from(lane.width()), f64::from(p.x - lane.left()));
        let at = c.start + (((tt / f as f64).round() as cut_time::Ticks) * f).clamp(0, (c.duration() - f).max(0));
        s.app.set_time(at);
    }
    if ch.started {
        s.features.controls.gesture.begin(&mut s.app, "Time Remapping");
    }
    if let Some(v) = ch.value {
        keys::remap_set_speed(&mut s.app, clip, v);
    }
    if ch.stopped {
        s.features.controls.gesture.end(&mut s.app);
    }
    match act {
        3 => keys::remap_watch(&mut s.app, clip),
        2 => keys::remap_toggle(&mut s.app, clip),
        1 | -1 => keys::remap_jump(&mut s.app, clip, act),
        _ => {}
    }
}

/// `controls.fold.<section>` folds a section (`motion`, `opacity` ...): no menu has it, `CUT_ACTIONS` uses it to show
/// the rows below in a picture.
const FOLD: &str = "controls.fold.";

/// `Some(can run now)` for the actions this panel owns: opening it, and Delete, Copy and Paste of picked keyframes
/// while it has the keyboard (else they are the timeline's).
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    if id == "window.controls" || id.starts_with(FOLD) {
        return Some(true);
    }
    if s.app.focus != Some(Panel::Controls) {
        return None;
    }
    let Some(Subject::Clip(clip)) = subject(s) else { return None };
    let c = s.app.sequence()?.clip(clip)?;
    let has = !keys::picked_of(c, &s.features.controls.picked).is_empty();
    match id {
        "delete" | "copy" if has => Some(true),
        "paste" if !s.features.controls.board.is_empty() => Some(true),
        _ => None,
    }
}

/// Runs `id` when it is one of this panel's actions -> whether it was.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    if id == "window.controls" {
        s.features.workspace.open_panel("controls");
        let ws = s.features.workspace.current;
        s.doc.set_setting("workspace", ws.id());
        s.focus(Panel::Controls);
        return true;
    }
    if let Some(sec) = id.strip_prefix(FOLD) {
        s.features.controls.collapsed.insert(sec.to_owned());
        return true;
    }
    if enabled(s, id) != Some(true) {
        return false;
    }
    let Some(Subject::Clip(clip)) = subject(s) else { return false };
    let picked = s.features.controls.picked.clone();
    match id {
        "delete" => {
            keys::delete(&mut s.app, clip, &picked);
            s.features.controls.picked.clear();
        }
        "copy" => {
            if let Some(c) = s.app.sequence().and_then(|q| q.clip(clip)) {
                s.features.controls.board = keys::copy(c, &picked);
            }
        }
        "paste" => {
            let board = s.features.controls.board.clone();
            keys::paste(&mut s.app, clip, &board);
        }
        _ => return false,
    }
    true
}
