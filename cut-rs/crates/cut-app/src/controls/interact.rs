//! The pointer on a lane (`laneEvents`, `dragHandle`) and on the lanes' ruler: a press on a bezier handle drags it, on
//! a keyframe picks it (Shift: adds or takes it away) and drags the picked keyframes of the clip in whole frames, on
//! the empty lane moves the playhead there; a double click goes to the keyframe; the right button opens the
//! keyframe menu (the interpolations, Copy, Paste, Delete). Each drag is one undo step, shown live: every move takes
//! the last one back and applies the new one.

use std::collections::BTreeMap;

use cut_model::Id;
use cut_model::keyframes::{Ease, Keyframe};
use cut_time::Ticks;
use eframe::egui::{self, Rect, Sense};

use super::keys::{self, Picked};
use super::lane::{self, Colors, Segment};
use crate::fx::edit;
use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::Panel;

/// A drag in a lane.
#[derive(Debug, Clone)]
pub enum Drag {
    Keys {
        clip: Id,
        x0: f32,
        w: f64,
        /// The picked times of each path, and each path's keyframes when the drag began.
        plan: BTreeMap<String, Vec<Ticks>>,
        base: BTreeMap<String, Vec<Keyframe>>,
        moved: bool,
        open: bool,
        last: Ticks,
    },
    Handle {
        clip: Id,
        path: String,
        list: Vec<Keyframe>,
        index: usize,
        which: usize,
        seg: Segment,
        origin: egui::Pos2,
        open: bool,
    },
    /// The ruler scrubs the playhead inside the clip.
    Scrub { clip: Id, rect: Rect },
}

/// What the keyframe menu chose.
enum Choice {
    Ease(Ease),
    Copy,
    Paste,
    Delete,
}

fn colors(s: &Shell) -> Colors {
    let pal = &s.palette;
    Colors { line: pal.gray[4], curve: pal.gray[8], text: pal.gray[10], accent: pal.accent, playhead: pal.playhead }
}

/// The playhead's time on frames inside the clip at lane x.
fn time_at(s: &Shell, clip: Id, w: f64, x: f64) -> Option<Ticks> {
    let seq = s.app.sequence()?;
    let c = seq.clip(clip)?;
    let f = edit::frame(seq);
    let t = lane::lane_t(c.duration(), w, x);
    Some(c.start + (((t / f as f64).round() as Ticks) * f).clamp(0, (c.duration() - f).max(0)))
}

/// A property's lane in `rect`: drawn, and the pointer on it handled.
pub fn lane(s: &mut Shell, ui: &mut egui::Ui, clip: Id, path: &str, rect: Rect) {
    let id = ui.make_persistent_id(("ec-lane", clip, path));
    let r = ui.interact(rect, id, Sense::click_and_drag());
    let (w, h) = (f64::from(rect.width()), f64::from(rect.height()));
    let st = &mut s.features.controls;
    st.lanes.entry(path.to_owned()).or_insert((clip, rect));
    let Some(seq) = s.app.sequence() else { return };
    let Some(c) = seq.clip(clip) else { return };
    let d = c.duration();
    let list = c.keyframes.get(path).cloned().unwrap_or_default();
    let playhead = edit::in_clip(c, s.app.t).then(|| s.app.t - c.start);
    let picked = &s.features.controls.picked;
    let is_picked = |t: Ticks| picked.iter().any(|(cl, p, x)| *cl == clip && p == path && *x == t);
    lane::paint(ui.painter(), rect, d, &list, is_picked, playhead, &colors(s));
    let (pressed, shift) = ui.input(|i| (i.pointer.primary_pressed(), i.modifiers.shift));
    let pos = r.interact_pointer_pos().or_else(|| r.hover_pos());
    if pressed && r.hovered() && s.features.controls.drag.is_none() {
        s.focus(Panel::Controls);
        if let Some(p) = pos {
            press(s, clip, path, rect, &list, d, p, shift, w, h);
        }
    }
    if r.double_clicked()
        && let Some(p) = pos
        && let Some(t) = lane::key_at(d, &list, w, f64::from(p.x - rect.left()))
    {
        let start = s.app.sequence().and_then(|q| q.clip(clip)).map_or(0, |c| c.start);
        s.app.set_time(start + t);
    }
    if r.secondary_clicked() {
        s.focus(Panel::Controls);
        if let Some(t) = pos.and_then(|p| lane::key_at(d, &list, w, f64::from(p.x - rect.left()))) {
            let id: Picked = (clip, path.to_owned(), t);
            let st = &mut s.features.controls;
            if !st.picked.contains(&id) {
                st.picked = vec![id];
            }
        }
    }
    menu(s, &r, clip);
}

#[allow(clippy::too_many_arguments)]
fn press(
    s: &mut Shell,
    clip: Id,
    path: &str,
    rect: Rect,
    list: &[Keyframe],
    d: Ticks,
    p: egui::Pos2,
    shift: bool,
    w: f64,
    h: f64,
) {
    let (x, y) = (f64::from(p.x - rect.left()), f64::from(p.y - rect.top()));
    let st = &mut s.features.controls;
    if let Some((index, which)) = lane::handle_at(d, list, w, h, x, y) {
        let Some(seg) = lane::segment(d, list, index, w, h) else { return };
        st.picked = vec![(clip, path.to_owned(), list[index].t)];
        st.drag = Some(Drag::Handle {
            clip,
            path: path.to_owned(),
            list: list.to_vec(),
            index,
            which,
            seg,
            origin: rect.min,
            open: false,
        });
        return;
    }
    let Some(t) = lane::key_at(d, list, w, x) else {
        if !shift {
            st.picked.clear();
        }
        if let Some(t) = time_at(s, clip, w, x) {
            s.app.set_time(t);
        }
        return;
    };
    let id: Picked = (clip, path.to_owned(), t);
    if shift {
        if let Some(i) = st.picked.iter().position(|x| *x == id) {
            st.picked.remove(i);
        } else {
            st.picked.push(id);
        }
    } else if !st.picked.contains(&id) {
        st.picked = vec![id];
    }
    let mut plan: BTreeMap<String, Vec<Ticks>> = BTreeMap::new();
    for (cl, p, t) in &st.picked {
        if *cl == clip {
            plan.entry(p.clone()).or_default().push(*t);
        }
    }
    let Some(c) = s.app.sequence().and_then(|q| q.clip(clip)) else { return };
    let base = plan.keys().map(|p| (p.clone(), c.keyframes.get(p).cloned().unwrap_or_default())).collect();
    s.features.controls.drag = Some(Drag::Keys { clip, x0: p.x, w, plan, base, moved: false, open: false, last: 0 });
}

/// The drag in progress follows the pointer; the button's release ends it.
pub fn follow(s: &mut Shell, ui: &egui::Ui) {
    let (down, pos) = ui.input(|i| (i.pointer.primary_down(), i.pointer.latest_pos()));
    let Some(drag) = s.features.controls.drag.clone() else { return };
    if !down {
        end(s, drag);
        return;
    }
    let Some(p) = pos else { return };
    match drag {
        Drag::Keys { clip, x0, w, plan, base, moved, open, last } => {
            let dx = f64::from(p.x - x0);
            if !moved && dx.abs() < 3.0 {
                return;
            }
            let Some(seq) = s.app.sequence() else { return };
            let Some(c) = seq.clip(clip) else { return };
            let (dur, f, sid) = (c.duration(), edit::frame(seq), seq.id);
            let delta = lane::drag_delta(dur, f, w, dx);
            if delta == last && open {
                return;
            }
            if open {
                s.app.history.cancel();
            }
            s.app.history.begin("Keyframes");
            for (path, times) in &plan {
                let next = lane::moved(&base[path], times, delta, dur, f);
                if s.app.exec(&edit::keys_cmd(sid, clip, path, &next)).is_none() {
                    break;
                }
            }
            s.features.controls.drag =
                Some(Drag::Keys { clip, x0, w, plan, base, moved: true, open: true, last: delta });
        }
        Drag::Handle { clip, path, list, index, which, seg, origin, open } => {
            let (x, y) = (f64::from(p.x - origin.x), f64::from(p.y - origin.y));
            let mut next = list.clone();
            let h = lane::dragged_handles(&seg, &next[index], which, x, y);
            next[index].h = Some(h);
            for k in &mut next {
                if k.ease != Ease::Bezier {
                    k.h = None;
                }
            }
            let Some(sid) = s.app.sequence_id else { return };
            if open {
                s.app.history.cancel();
            }
            s.app.history.begin("Keyframes");
            s.app.exec(&edit::keys_cmd(sid, clip, &path, &next));
            s.features.controls.drag = Some(Drag::Handle { clip, path, list, index, which, seg, origin, open: true });
        }
        Drag::Scrub { clip, rect } => {
            if let Some(t) = time_at(s, clip, f64::from(rect.width()), f64::from(p.x - rect.left())) {
                s.app.set_time(t);
            }
        }
    }
}

fn end(s: &mut Shell, drag: Drag) {
    s.features.controls.drag = None;
    match drag {
        Drag::Keys { clip, plan, open: true, last, .. } => {
            s.app.history.commit();
            let st = &mut s.features.controls;
            st.picked.clear();
            for (p, times) in plan {
                for t in times {
                    st.picked.push((clip, p.clone(), (t + last).max(0)));
                }
            }
        }
        Drag::Handle { open: true, .. } => s.app.history.commit(),
        _ => {}
    }
}

/// The lanes' ruler over the lane column (`drawLaneRuler`): the clip's start and end timecodes and the playhead; a
/// press scrubs the playhead.
pub fn ruler(s: &mut Shell, ui: &mut egui::Ui, clip: Id, rect: Rect) {
    let r = ui.interact(rect, ui.make_persistent_id("ec-ruler"), Sense::click_and_drag());
    let Some(seq) = s.app.sequence() else { return };
    let Some(c) = seq.clip(clip) else { return };
    let (d, start, fps) = (c.duration(), c.start, seq.fps);
    let p = ui.painter_at(rect);
    let pal = &s.palette;
    p.hline(rect.x_range(), rect.bottom(), egui::Stroke::new(1.0, pal.gray[3]));
    let font = egui::FontId::monospace(10.0);
    let a = p.text(
        rect.left_top() + egui::vec2(6.0, 2.0),
        egui::Align2::LEFT_TOP,
        cut_time::timecode(start, fps),
        font.clone(),
        pal.gray[8],
    );
    // the end's timecode only where it does not run into the start's (a narrow panel)
    let end = p.layout_no_wrap(cut_time::timecode(start + d, fps), font, pal.gray[8]);
    if a.right() + 8.0 + end.size().x <= rect.right() - 6.0 {
        p.galley(egui::pos2(rect.right() - 6.0 - end.size().x, rect.top() + 2.0), end, pal.gray[8]);
    }
    if edit::in_clip(c, s.app.t) {
        let x = rect.left() + lane::lane_x(d, f64::from(rect.width()), (s.app.t - start) as f64) as f32;
        let pts = vec![
            egui::pos2(x - 5.0, rect.bottom() - 8.0),
            egui::pos2(x + 5.0, rect.bottom() - 8.0),
            egui::pos2(x, rect.bottom() - 2.0),
        ];
        p.add(egui::Shape::convex_polygon(pts, pal.playhead, egui::Stroke::NONE));
    }
    s.features.controls.note("ruler".into(), rect);
    if ui.input(|i| i.pointer.primary_pressed()) && r.hovered() && s.features.controls.drag.is_none() {
        s.features.controls.drag = Some(Drag::Scrub { clip, rect });
        follow(s, ui);
    }
}

/// The keyframe menu of a lane: the interpolations (checked when every picked keyframe has it), Copy, Paste, Delete.
fn menu(s: &mut Shell, r: &egui::Response, clip: Id) {
    let Some(c) = s.app.sequence().and_then(|q| q.clip(clip)) else { return };
    let sel: Vec<Ease> = keys::picked_of(c, &s.features.controls.picked).iter().map(|(_, k)| k.ease).collect();
    let can_paste = !s.features.controls.board.is_empty();
    let mut chose = None;
    r.context_menu(|ui| {
        for (ease, label) in edit::EASES {
            let on = !sel.is_empty() && sel.iter().all(|e| *e == ease);
            if ui.add_enabled(!sel.is_empty(), egui::Button::selectable(on, tr(label))).clicked() {
                chose = Some(Choice::Ease(ease));
            }
        }
        ui.separator();
        for (choice, label, ok) in [
            (Choice::Copy, "Copy", !sel.is_empty()),
            (Choice::Paste, "Paste", can_paste),
            (Choice::Delete, "Delete", !sel.is_empty()),
        ] {
            if ui.add_enabled(ok, egui::Button::new(tr(label))).clicked() {
                chose = Some(choice);
            }
        }
        if chose.is_some() {
            ui.close();
        }
    });
    let picked = s.features.controls.picked.clone();
    match chose {
        Some(Choice::Ease(e)) => keys::set_ease(&mut s.app, clip, &picked, e),
        Some(Choice::Copy) => s.features.controls.board = keys::copy(c, &picked),
        Some(Choice::Paste) => {
            let board = s.features.controls.board.clone();
            keys::paste(&mut s.app, clip, &board);
        }
        Some(Choice::Delete) => {
            keys::delete(&mut s.app, clip, &picked);
            s.features.controls.picked.clear();
        }
        None => {}
    }
}
