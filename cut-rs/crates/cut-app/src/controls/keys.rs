//! The keyframe edits of Effect Controls (the stopwatch, Add/Remove Keyframe, previous/next, the lane menu's
//! interpolations, Copy, Paste, Delete, a section's Reset, and Time Remapping's row), as `ui-timeline.js`'s
//! `edit.setKeyframing`, `toggleKeyframe`, `jumpKeyframe` and `ui-controls.js` make them. Each runs its commands
//! through [`App::exec`]; the ones of several commands are one undo step.

use std::collections::BTreeMap;

use cut_model::commands::build as C;
use cut_model::keyframes::{self as K, Ease, Keyframe, Value};
use cut_model::{Clip, Id, Sequence, remap as R};
use cut_time::Ticks;
use serde_json::{Map, Value as Json, json};

use super::spec::{Ctl, Field, Spec};
use crate::fx::edit;
use crate::i18n::tr;
use crate::state::App;

/// A keyframe picked in a lane: the clip, the path and its time.
pub type Picked = (Id, String, Ticks);

/// A copied keyframe: its path, its time from the first copied one, its value, ease and handles.
#[derive(Debug, Clone, PartialEq)]
pub struct Copied {
    pub path: String,
    pub t: Ticks,
    pub v: Value,
    pub ease: Ease,
    pub h: Option<Vec<f64>>,
}

fn clip(app: &App, id: Id) -> Option<(&Sequence, &Clip)> {
    let seq = app.sequence()?;
    Some((seq, seq.clip(id)?))
}

/// Runs `cmds` (built against the project as it is when each runs) as one step labelled `label`, all or none.
fn group(app: &mut App, label: &str, f: impl FnOnce(&mut App) -> bool) {
    app.history.begin(label);
    if f(app) {
        app.history.commit();
    } else {
        app.history.cancel();
    }
}

/// The stopwatch (`setKeyframing`): on makes a keyframe at the playhead with the value there; off drops the
/// keyframes and keeps the value at the playhead as the static value, in one step.
pub fn set_keyframing(app: &mut App, clip_id: Id, path: &str, on: bool) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let v = edit::value_at(seq, c, path, app.t);
    let (s, kt) = (seq.id, edit::clip_time(seq, c, app.t));
    if on {
        let Some(v) = v else { return };
        app.exec(&edit::keys_cmd(s, clip_id, path, &[Keyframe { t: kt, v, ease: Ease::Linear, h: None }]));
        return;
    }
    group(app, "Keyframes", |app| {
        if app.exec(&edit::keys_cmd(s, clip_id, path, &[])).is_none() {
            return false;
        }
        v.is_none_or(|v| edit::set_static(app, clip_id, path, &v).is_some())
    });
}

/// Add/Remove Keyframe (`toggleKeyframe`): the keyframe at the playhead goes, or one is made with the value there and
/// the ease of the one before.
pub fn toggle_keyframe(app: &mut App, clip_id: Id, path: &str) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let list = c.keyframes.get(path).cloned().unwrap_or_default();
    let kt = edit::clip_time(seq, c, app.t);
    let next = if list.iter().any(|k| k.t == kt) {
        K::remove(&list, kt)
    } else {
        let Some(v) = edit::value_at(seq, c, path, app.t) else { return };
        let ease = K::prev(&list, kt).map_or(Ease::Linear, |k| k.ease);
        K::insert(&list, &Keyframe { t: kt, v, ease, h: None })
    };
    let cmd = edit::keys_cmd(seq.id, clip_id, path, &next);
    app.exec(&cmd);
}

/// Previous/next keyframe (`jumpKeyframe`): the playhead moves to it -> its clip time.
pub fn jump(app: &mut App, clip_id: Id, path: &str, dir: i32) -> Option<Ticks> {
    let (seq, c) = clip(app, clip_id)?;
    let kt = edit::clip_time(seq, c, app.t);
    let list = c.keyframes.get(path)?;
    let k = if dir < 0 { K::prev(list, kt) } else { K::next(list, kt) }?.t;
    let start = c.start;
    app.set_time(start + k);
    Some(k)
}

/// The value a row shows (`value()`): a clip field's, a fade's ticks, else the path's at the playhead or its fallback.
pub fn value(seq: &Sequence, c: &Clip, spec: &Spec, t: Ticks) -> Option<Value> {
    match spec.field {
        Some(Field::Speed) => return Some(Value::Num((c.speed * 10000.0).round() / 100.0)),
        Some(Field::Reverse) => return Some(Value::Flag(c.reverse)),
        None => {}
    }
    match (spec.ctl.clone(), spec.path.as_str()) {
        (Ctl::Duration, "fadeIn") => Some(Value::Num(c.fade_in as f64)),
        (Ctl::Duration, _) => Some(Value::Num(c.fade_out as f64)),
        _ => edit::value_at(seq, c, &spec.path, t).or_else(|| spec.fallback.clone()),
    }
}

/// A row's write of `v` (`write`): a clip field, a fade, one element of crop, both of Scale, else the path at the
/// playhead.
pub fn write(app: &mut App, clip_id: Id, spec: &Spec, v: Value) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let (s, cl) = (seq.id.as_str().to_owned(), clip_id.as_str());
    let num = |v: &Value| if let Value::Num(x) = v { *x } else { 0.0 };
    match spec.field {
        Some(Field::Speed) => {
            app.exec(&C::set_clip(&s, cl, json!({ "speed": num(&v) / 100.0, "ripple": true }), json!({})));
            return;
        }
        Some(Field::Reverse) => {
            let on = matches!(v, Value::Flag(true));
            app.exec(&C::set_clip(&s, cl, json!({ "reverse": on, "ripple": true }), json!({})));
            return;
        }
        None => {}
    }
    if spec.ctl == Ctl::Duration {
        let ticks = num(&v).round() as Ticks;
        app.exec(&C::set_clip(&s, cl, json!({ spec.path.as_str(): ticks }), json!({ "linked": false })));
        return;
    }
    let next = match (spec.index, &spec.ctl) {
        (Some(i), _) => {
            let mut list = match value(seq, c, spec, app.t) {
                Some(Value::List(l)) => l,
                _ => vec![0.0; 4],
            };
            if let Some(x) = list.get_mut(i) {
                *x = num(&v);
            }
            Value::List(list)
        }
        (None, Ctl::Uniform) => Value::List(vec![num(&v), num(&v)]),
        _ => v,
    };
    edit::write(app, clip_id, &spec.path, &next);
}

/// A section's Reset (`resetSection`), one step: clip fields to theirs, fades to 0, keyframes dropped, each row's
/// default back; an effect's stored parameters all cleared.
pub fn reset(app: &mut App, clip_id: Id, specs: &[&Spec], effect: Option<Id>) {
    group(app, "Reset", |app| {
        for spec in specs {
            let Some((seq, c)) = clip(app, clip_id) else { return false };
            let (s, cl) = (seq.id.as_str().to_owned(), clip_id.as_str().to_owned());
            let cmd = match spec.field {
                Some(Field::Speed) => Some(C::set_clip(&s, &cl, json!({ "speed": 1, "ripple": true }), json!({}))),
                Some(Field::Reverse) => {
                    Some(C::set_clip(&s, &cl, json!({ "reverse": false, "ripple": true }), json!({})))
                }
                None if spec.ctl == Ctl::Duration => {
                    Some(C::set_clip(&s, &cl, json!({ spec.path.as_str(): 0 }), json!({})))
                }
                None => None,
            };
            if let Some(cmd) = cmd {
                if app.exec(&cmd).is_none() {
                    return false;
                }
                continue;
            }
            if edit::keyframed(c, &spec.path) && app.exec(&C::set_keyframes(&s, &cl, &spec.path, None)).is_none() {
                return false;
            }
            let Some((_, c)) = clip(app, clip_id) else { return false };
            let def = edit::default_of(c, &spec.path).or_else(|| spec.fallback.clone());
            let layer_keyframe_only =
                spec.path.starts_with("layers.") && matches!(spec.path.split('.').nth(2), Some("opacity" | "reveal"));
            if layer_keyframe_only {
                continue;
            }
            if let Some(def) = def
                && edit::set_static(app, clip_id, &spec.path, &def).is_none()
            {
                return false;
            }
        }
        if let Some(e) = effect {
            let Some((seq, c)) = clip(app, clip_id) else { return false };
            let Some(fx) = c.effects.iter().find(|x| x.id == e) else { return false };
            let nulls: Map<String, Json> = fx.params.keys().map(|k| (k.clone(), Json::Null)).collect();
            let cmd = C::set_effect(seq.id.as_str(), clip_id.as_str(), e.as_str(), json!({ "params": nulls }));
            if app.exec(&cmd).is_none() {
                return false;
            }
        }
        true
    });
}

/// The picked keyframes of a clip that still exist, as (path, keyframe).
pub fn picked_of<'a>(c: &'a Clip, picked: &[Picked]) -> Vec<(String, &'a Keyframe)> {
    picked
        .iter()
        .filter(|(id, ..)| *id == c.id)
        .filter_map(|(_, path, t)| Some((path.clone(), c.keyframes.get(path)?.iter().find(|k| k.t == *t)?)))
        .collect()
}

fn by_path(sel: &[(String, &Keyframe)]) -> BTreeMap<String, Vec<Ticks>> {
    let mut m: BTreeMap<String, Vec<Ticks>> = BTreeMap::new();
    for (p, k) in sel {
        m.entry(p.clone()).or_default().push(k.t);
    }
    m
}

/// The lane menu's interpolation for the picked keyframes (`setEase`), one step.
pub fn set_ease(app: &mut App, clip_id: Id, picked: &[Picked], ease: Ease) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let cmds: Vec<Json> = by_path(&picked_of(c, picked))
        .into_iter()
        .map(|(p, times)| edit::keys_cmd(seq.id, clip_id, &p, &edit::ease_list(&c.keyframes[&p], &times, ease)))
        .collect();
    group(app, "Keyframes", |app| cmds.iter().all(|cmd| app.exec(cmd).is_some()));
}

/// Deletes the picked keyframes (`deleteKeys`), one step.
pub fn delete(app: &mut App, clip_id: Id, picked: &[Picked]) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let cmds: Vec<Json> = by_path(&picked_of(c, picked))
        .into_iter()
        .map(|(p, times)| {
            let left: Vec<Keyframe> = c.keyframes[&p].iter().filter(|k| !times.contains(&k.t)).cloned().collect();
            edit::keys_cmd(seq.id, clip_id, &p, &left)
        })
        .collect();
    group(app, "Keyframes", |app| cmds.iter().all(|cmd| app.exec(cmd).is_some()));
}

/// Copy: the picked keyframes, their times from the first.
pub fn copy(c: &Clip, picked: &[Picked]) -> Vec<Copied> {
    let sel = picked_of(c, picked);
    let Some(t0) = sel.iter().map(|(_, k)| k.t).min() else { return Vec::new() };
    sel.into_iter()
        .map(|(path, k)| Copied { path, t: k.t - t0, v: k.v.clone(), ease: k.ease, h: k.h.clone() })
        .collect()
}

/// Paste (`pasteKeys`): the copied keyframes from the playhead on, where the clip has the path and they fall inside
/// it; one step.
pub fn paste(app: &mut App, clip_id: Id, board: &[Copied]) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let (t0, d, kind) = (edit::clip_time(seq, c, app.t), c.duration(), edit::kind_of(seq, c));
    let mut paths: BTreeMap<&str, Vec<&Copied>> = BTreeMap::new();
    for k in board {
        paths.entry(k.path.as_str()).or_default().push(k);
    }
    let mut cmds = Vec::new();
    for (p, list) in paths {
        if !cut_model::validate::valid_prop_path(c, kind, p) {
            continue;
        }
        let mut next = c.keyframes.get(p).cloned().unwrap_or_default();
        for k in list.into_iter().filter(|k| t0 + k.t < d) {
            next = K::insert(&next, &Keyframe { t: t0 + k.t, v: k.v.clone(), ease: k.ease, h: k.h.clone() });
        }
        cmds.push(edit::keys_cmd(seq.id, clip_id, p, &next));
    }
    group(app, "Keyframes", |app| cmds.iter().all(|cmd| app.exec(cmd).is_some()));
}

// ---- Time Remapping > Speed ------------------------------------------------------------------------------------------

/// The clip time the remap row works at: the playhead's inside the clip, else 0.
fn local(seq: &Sequence, c: &Clip, t: Ticks) -> Ticks {
    if edit::in_clip(c, t) { edit::clip_time(seq, c, t) } else { 0 }
}

fn set_remap(app: &mut App, clip_id: Id, r: Option<&R::Remap>) {
    let Some(seq) = app.sequence_id else { return };
    let cmd = C::set_remap(seq.as_str(), clip_id.as_str(), r.map(|r| json!(r)));
    app.exec(&cmd);
}

/// The speed at the playhead, or at the start when the playhead is off the clip.
pub fn remap_speed(seq: &Sequence, c: &Clip, t: Ticks) -> f64 {
    let at = (c.duration() - 1).min(local(seq, c, t));
    R::speed_at(&c.remap_of(), at as f64)
}

/// Whether the clip's speed is a curve with keys (the row's stopwatch is on).
pub fn remap_keyed(c: &Clip) -> bool {
    c.remap.as_ref().is_some_and(|r| !r.keys.is_empty())
}

/// The stopwatch: off makes a constant speed again; on puts a key at the playhead (in the middle when the playhead is
/// at the start or off the clip).
pub fn remap_watch(app: &mut App, clip_id: Id) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    if remap_keyed(c) {
        set_remap(app, clip_id, None);
        return;
    }
    let f = edit::frame(seq);
    let l = local(seq, c, app.t);
    let at = if edit::in_clip(c, app.t) && l > 0 {
        l
    } else {
        ((c.duration() as f64 / 2.0 / f as f64).round() as Ticks) * f
    };
    if let Some(r) = R::add_key(&c.remap_of(), at) {
        set_remap(app, clip_id, Some(&r));
    }
}

/// A speed typed in (percent): the segment under the playhead plays at it, in its direction.
pub fn remap_set_speed(app: &mut App, clip_id: Id, pct: f64) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let r = c.remap_of();
    let at = (c.duration() - 1).min(local(seq, c, app.t));
    let i = match R::segment_at(&r, at) {
        R::Segment::Index(i) => Some(i),
        R::Segment::Ramp(_) => None,
    };
    let old = i.and_then(|i| r.speeds.get(i).copied()).unwrap_or(0.0);
    let Some(i) = i.filter(|_| old != 0.0) else {
        app.toast(tr("A hold has no speed to change."));
        return;
    };
    let next = R::set_segment_speed(&r, i, old.signum() * pct / 100.0, edit::frame(seq));
    set_remap(app, clip_id, Some(&next));
}

/// The diamond: the key at the playhead goes, or one is added there.
pub fn remap_toggle(app: &mut App, clip_id: Id) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    if !edit::in_clip(c, app.t) {
        return;
    }
    let (r, l, f) = (c.remap_of(), local(seq, c, app.t), edit::frame(seq));
    match r.keys.iter().position(|k| k.t == l) {
        Some(i) => set_remap(app, clip_id, Some(&R::remove_key(&r, i, f))),
        None => match R::add_key(&r, l) {
            Some(next) => set_remap(app, clip_id, Some(&next)),
            None => app.toast(tr("A speed keyframe cannot go there.")),
        },
    }
}

/// The arrows: the playhead to the previous or next speed key inside the clip.
pub fn remap_jump(app: &mut App, clip_id: Id, dir: i32) {
    let Some((seq, c)) = clip(app, clip_id) else { return };
    let Some(r) = c.remap.as_ref() else { return };
    let now = local(seq, c, app.t);
    let mut times = r.keys.iter().map(|k| k.t).filter(|t| *t < c.duration());
    let t = if dir > 0 { times.find(|k| *k > now) } else { times.rev().find(|k| *k < now) };
    if let Some(t) = t {
        let start = c.start;
        app.set_time(start + t);
    }
}
