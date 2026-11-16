//! The handles over the Program monitor (port of `ui-overlay.js` and `ui-masks.js`): the selected clip's box (move,
//! scale from the corners and edges, rotate, the anchor point, crop), the mask selected in Effect Controls (vertices,
//! handles, the whole mask, the feather and expansion handles; the Free Draw Bezier pen), and the clicks that pick a
//! colour or a point for a control.
//!
//! The geometry and every gesture are pure functions ([`geom`], [`transform`], [`mask`], [`pick`]) from pointer
//! positions, the picture's rectangle and the clip to property values or commands; [`program`] feeds them the
//! frame's pointer and runs what they return through [`App::exec`], each drag one undo step ([`edit::Gesture`]).
//! It all runs on the UI thread; the painting is egui shapes the window's wgpu renderer draws over the picture.

pub mod draw;
pub mod geom;
pub mod mask;
pub mod pick;
pub mod transform;

use cut_model::commands::build as C;
use cut_model::masks::{self as M, PenPoint};
use cut_model::{Clip, Id, TrackKind};
use eframe::egui::{self, CursorIcon, Key, Rect, Sense};
use serde_json::json;

use self::geom::{Frame, Mapping, P};
use self::mask::{Edit, MaskGeom, PenPress, Press, Target};
use self::transform::{BoxGeom, Part};
use crate::fx::{PickKind, edit};
use crate::shell::Shell;
use crate::state::{App, Panel};

/// A mask of a clip: Opacity's (`effect` `None`) or an effect's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaskSel {
    pub clip: Id,
    pub effect: Option<Id>,
    pub mask: Id,
}

/// The shapes Effect Controls' mask buttons make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Ellipse,
    Polygon,
}

/// A drag in progress.
#[derive(Debug, Clone)]
enum Drag {
    Box { clip: Id, press: transform::Press, moved: bool },
    Mask { sel: MaskSel, geom: MaskGeom, target: Target, path0: Vec<f64>, start: P, moved: bool },
    Pen { map: Mapping, index: usize, at: PenPoint, start: P },
}

/// The overlay's state between frames.
#[derive(Debug, Default)]
pub struct State {
    /// The mask being edited on the monitor.
    pub selected: Option<MaskSel>,
    /// The clip and effect the pen draws a mask for.
    pub pen: Option<(Id, Option<Id>)>,
    /// The box's corners and edges crop instead of scaling (Premiere's handles while Crop is selected).
    pub crop: bool,
    /// The pen's points so far, and the clip and effect they are for.
    points: Vec<PenPoint>,
    points_for: Option<(Id, Option<Id>)>,
    drag: Option<Drag>,
    last: Option<P>,
    gesture: edit::Gesture,
}

impl State {
    /// The pen's points so far (picture fractions).
    pub fn pen_points(&self) -> &[PenPoint] {
        &self.points
    }
}

/// Whether Escape belongs to the overlay now (it ends a pick or the pen) rather than to Deselect All.
pub fn takes_escape(fx: &crate::fx::Fx) -> bool {
    fx.pick.is_some() || fx.overlay.pen.is_some()
}

/// Create Ellipse Mask / Create 4-point Polygon Mask: a new mask on the clip (or its effect), one step, selected.
pub fn create(state: &mut State, app: &mut App, clip: Id, effect: Option<Id>, shape: Shape) {
    let cmd = {
        let Some(seq) = app.sequence() else { return };
        let Some(c) = seq.clip(clip) else { return };
        let [w, h] = geom::placement(app.project(), seq, c, app.t).size;
        let path = match shape {
            Shape::Ellipse => M::ellipse(w, h, M::Place::default()),
            Shape::Polygon => M::polygon(w, h, M::Place::default()),
        };
        C::add_mask(seq.id.as_str(), clip.as_str(), json!({ "path": path }), effect.map(|e| e.as_str()))
    };
    if let Some(id) = app.exec(&cmd).as_ref().and_then(|r| r["id"].as_str()) {
        state.selected = Some(MaskSel { clip, effect, mask: Id::new(id) });
        state.pen = None;
    }
}

/// What the monitor shows handles for this frame.
enum View {
    None,
    Pick { fr: Frame },
    Box { clip: Id, fr: Frame, g: BoxGeom, p: geom::Placement },
    Mask { sel: MaskSel, g: MaskGeom },
    Pen { map: Mapping },
}

/// The selected clip when the monitor shows it (`shownClip`): a video clip at the playhead, enabled, on a visible
/// track, not an adjustment layer.
pub fn shown_clip(app: &App) -> Option<&Clip> {
    let seq = app.sequence()?;
    let c = edit::primary_clip(app)?;
    let adjustment =
        matches!(c.source, cut_model::Source::Generator { generator: cut_model::Generator::Adjustment, .. });
    if edit::kind_of(seq, c) != TrackKind::Video || !edit::in_clip(c, app.t) || !c.enabled || adjustment {
        return None;
    }
    let t = seq.tracks.iter().find(|t| t.id == c.track)?;
    (t.visible != Some(false)).then_some(c)
}

fn view(s: &Shell, picture: Rect) -> View {
    let app = &s.app;
    let st = &s.features.fx.overlay;
    let Some(seq) = app.sequence() else { return View::None };
    let fr = Frame::new(picture, seq.w as f64);
    if s.features.fx.pick.is_some() {
        return View::Pick { fr };
    }
    let Some(c) = shown_clip(app) else { return View::None };
    let p = geom::placement(app.project(), seq, c, app.t);
    if st.pen.is_some_and(|(clip, _)| clip == c.id) {
        return View::Pen { map: Mapping::new(fr, p) };
    }
    if let Some(sel) = st.selected.filter(|x| x.clip == c.id)
        && let Some(g) = mask::geometry(Mapping::new(fr, p.clone()), seq, c, &sel, app.t)
    {
        return View::Mask { sel, g };
    }
    View::Box { clip: c.id, g: transform::geometry(&fr, &p), fr, p }
}

/// Lets go of a mask or the pen whose clip is no longer selected, and of pen points drawn for another target.
fn forget(st: &mut State, app: &App) {
    if st.selected.is_some_and(|x| !app.selection.contains(&x.clip)) {
        st.selected = None;
    }
    if st.pen.is_some_and(|(c, _)| !app.selection.contains(&c)) {
        st.pen = None;
    }
    if st.pen.is_some() {
        st.selected = None;
    }
    if st.points_for != st.pen {
        st.points.clear();
        st.points_for = st.pen;
    }
}

fn cursor(v: &View, pt: P, crop: bool) -> CursorIcon {
    match v {
        View::None => CursorIcon::Default,
        View::Pick { .. } | View::Pen { .. } => CursorIcon::Crosshair,
        View::Box { g, .. } => match transform::hit(g, pt) {
            Some(Part::Move | Part::Anchor) => CursorIcon::Move,
            Some(Part::Corner(_) | Part::Edge(_)) if crop => CursorIcon::Crosshair,
            Some(Part::Corner(0 | 2)) => CursorIcon::ResizeNwSe,
            Some(Part::Corner(_)) => CursorIcon::ResizeNeSw,
            Some(Part::Edge(0 | 2)) => CursorIcon::ResizeVertical,
            Some(Part::Edge(_)) => CursorIcon::ResizeHorizontal,
            Some(Part::Rotate) => CursorIcon::Grab,
            None => CursorIcon::Default,
        },
        View::Mask { g, .. } => match mask::hit(g, pt) {
            mask::Hit::Vertex(_) | mask::Hit::Inside => CursorIcon::Move,
            mask::Hit::Handle(..) | mask::Hit::Edge(..) => CursorIcon::PointingHand,
            mask::Hit::Feather | mask::Hit::Expansion => CursorIcon::ResizeVertical,
            mask::Hit::Outside => CursorIcon::Default,
        },
    }
}

/// Runs a mask edit on the selected mask's clip.
fn mask_edit(app: &mut App, sel: &MaskSel, e: &Edit) {
    let t = app.t;
    let cmd = app.sequence().and_then(|seq| mask::command(seq, seq.clip(sel.clip)?, sel, e, t));
    if let Some(cmd) = cmd {
        app.exec(&cmd);
    }
}

/// A click while a control waits for a pick: the value goes to the control, the pick ends either way.
fn pick_click(s: &mut Shell, fr: &Frame, pt: P) {
    let Some(pick) = s.features.fx.pick.take() else { return };
    let Some(seq) = s.app.sequence() else { return };
    let size = [seq.w as f64, seq.h as f64];
    match pick.kind {
        PickKind::Point => {
            let Some(c) = seq.clip(pick.clip) else { return };
            let s_pt = fr.to_sequence(pt);
            if !(0.0..=size[0]).contains(&s_pt[0]) || !(0.0..=size[1]).contains(&s_pt[1]) {
                return;
            }
            let p = geom::placement(s.app.project(), seq, c, s.app.t);
            let v = pick::point_at(fr, &p, pt);
            edit::write(&mut s.app, pick.clip, &pick.path, &cut_model::keyframes::Value::List(v.to_vec()));
        }
        PickKind::Color | PickKind::Lumetri(_) => {
            let Some((w, h, px)) = s.monitors.as_ref().and_then(|m| m.program.pixels()) else { return };
            let Some(rgb) = pick::color_at(&px, w, h, fr, size, pt) else { return };
            match pick.kind {
                PickKind::Lumetri(d) => s.features.fx.picked_color = Some((d, rgb)),
                _ => {
                    edit::write(&mut s.app, pick.clip, &pick.path, &cut_model::keyframes::Value::Text(pick::hex(rgb)));
                }
            }
        }
    }
}

fn press(s: &mut Shell, v: &View, pt: P, mods: egui::Modifiers) {
    s.focus(Panel::Program);
    let crop = s.features.fx.overlay.crop;
    match v {
        View::None => {}
        View::Pick { fr } => pick_click(s, fr, pt),
        View::Pen { map } => {
            let st = &mut s.features.fx.overlay;
            let Some((clip, effect)) = st.pen else { return };
            match mask::pen_press(map, &st.points, pt) {
                PenPress::Close(path) => {
                    st.points.clear();
                    st.pen = None;
                    let seq = s.app.sequence().map(|q| q.id);
                    let r = seq.and_then(|seq| {
                        let cmd = C::add_mask(
                            seq.as_str(),
                            clip.as_str(),
                            json!({ "path": path }),
                            effect.map(|e| e.as_str()),
                        );
                        s.app.exec(&cmd)
                    });
                    if let Some(id) = r.as_ref().and_then(|r| r["id"].as_str()) {
                        s.features.fx.overlay.selected = Some(MaskSel { clip, effect, mask: Id::new(id) });
                    }
                }
                PenPress::Point(p) => {
                    st.points.push(p);
                    st.drag = Some(Drag::Pen { map: map.clone(), index: st.points.len() - 1, at: p, start: pt });
                }
            }
        }
        View::Mask { sel, g } => {
            let p = mask::press(g, mask::hit(g, pt), mods.command || mods.ctrl, mods.alt);
            let label = p.label();
            let st = &mut s.features.fx.overlay;
            match p {
                Press::Deselect => st.selected = None,
                Press::Once(e) => {
                    if let Some(e) = e {
                        st.gesture.begin(&mut s.app, label);
                        mask_edit(&mut s.app, sel, &e);
                        s.features.fx.overlay.gesture.end(&mut s.app);
                    }
                }
                Press::Drag { first, target, path0 } => {
                    if let Some(e) = first {
                        st.gesture.begin(&mut s.app, label);
                        mask_edit(&mut s.app, sel, &e);
                    }
                    let st = &mut s.features.fx.overlay;
                    let moved = st.gesture.is_open();
                    st.drag = Some(Drag::Mask { sel: *sel, geom: g.clone(), target, path0, start: pt, moved });
                }
            }
        }
        View::Box { clip, fr, g, p } => {
            if let Some(part) = transform::hit(g, pt) {
                let press = transform::Press { part, start: pt, fr: *fr, p0: p.clone(), g0: g.clone(), crop };
                s.features.fx.overlay.drag = Some(Drag::Box { clip: *clip, press, moved: false });
            }
        }
    }
}

/// The pointer moved to `pt` during a drag.
fn moved(s: &mut Shell, pt: P, mods: egui::Modifiers) {
    let st = &mut s.features.fx.overlay;
    let Some(drag) = st.drag.as_mut() else { return };
    match drag {
        Drag::Box { clip, press, moved } => {
            if !*moved && geom::dist(pt, press.start) < 2.0 {
                return;
            }
            *moved = true;
            let (clip, writes) = (*clip, transform::drag(press, pt, mods.shift));
            st.gesture.begin(&mut s.app, press.part.label(press.crop));
            for (name, v) in writes {
                edit::write(&mut s.app, clip, name, &v);
            }
        }
        Drag::Mask { sel, geom, target, path0, start, moved } => {
            if !*moved && geom::dist(pt, *start) < 2.0 {
                return;
            }
            *moved = true;
            let label = match target {
                Target::Feather => "Mask Feather",
                Target::Expansion => "Mask Expansion",
                _ => "Mask Path",
            };
            let (sel, e) = (*sel, mask::drag(geom, *target, path0, *start, pt, mods.alt));
            st.gesture.begin(&mut s.app, label);
            mask_edit(&mut s.app, &sel, &e);
        }
        Drag::Pen { map, index, at, start } => {
            let p = mask::pen_drag(map, *at, *start, pt);
            if let Some(slot) = st.points.get_mut(*index) {
                *slot = p;
            }
        }
    }
}

/// Draws the handles of the selected clip over the picture drawn at `picture` and turns gestures into commands.
pub fn program(s: &mut Shell, ui: &mut egui::Ui, picture: Rect) {
    forget(&mut s.features.fx.overlay, &s.app);
    let (pressed, down, pos, mods, esc) = ui.input(|i| {
        (
            i.pointer.primary_pressed(),
            i.pointer.primary_down(),
            i.pointer.latest_pos(),
            i.modifiers,
            i.key_pressed(Key::Escape),
        )
    });
    if esc {
        let fx = &mut s.features.fx;
        if fx.pick.take().is_none() && fx.overlay.pen.take().is_some() {
            fx.overlay.points.clear();
            fx.overlay.drag = None;
        }
    }
    let v = view(s, picture);
    let area = picture.expand(48.0).intersect(ui.clip_rect());
    let active = !matches!(v, View::None) || s.features.fx.overlay.drag.is_some();
    let r = ui.interact(
        area,
        ui.make_persistent_id("fx-overlay"),
        if active { Sense::click_and_drag() } else { Sense::hover() },
    );
    let at = pos.map(|p| [f64::from(p.x), f64::from(p.y)]);
    if let Some(pt) = at {
        if pressed && r.contains_pointer() && s.features.fx.overlay.drag.is_none() {
            press(s, &v, pt, mods);
            s.features.fx.overlay.last = Some(pt);
        } else if down && s.features.fx.overlay.drag.is_some() && s.features.fx.overlay.last != Some(pt) {
            moved(s, pt, mods);
            s.features.fx.overlay.last = Some(pt);
        }
    }
    if !down && s.features.fx.overlay.drag.is_some() {
        let st = &mut s.features.fx.overlay;
        st.drag = None;
        st.last = None;
        st.gesture.end(&mut s.app);
    }
    let v = view(s, picture);
    if let Some(pt) = at
        && (r.contains_pointer() || s.features.fx.overlay.drag.is_some())
    {
        ui.ctx().set_cursor_icon(cursor(&v, pt, s.features.fx.overlay.crop));
    }
    let painter = ui.painter_at(area);
    match &v {
        View::Box { g, .. } => {
            draw::transform_box(&painter, g, s.palette.blue6, s.palette.blue8, s.features.fx.overlay.crop);
        }
        View::Mask { g, .. } => draw::mask(&painter, g),
        View::Pen { map } => draw::pen(&painter, map, &s.features.fx.overlay.points),
        View::None | View::Pick { .. } => {}
    }
}
