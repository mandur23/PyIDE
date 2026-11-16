//! The property helpers the editing panels share (port of `ui-timeline.js`'s `Cut.ui.edit`): the clip the panels
//! edit, the clip time of the playhead, a property path's default and its value at the playhead, and the writes that
//! the Effect Controls rows, the Lumetri panel and the monitor's handles make: a static value, or the keyframe at the
//! playhead when the property is keyframed, the stopwatch, and the add/remove and previous/next keyframe buttons.
//!
//! A path is the keyframe path the model reads (`opacity`, `effects.<id>.<param>`, `masks.<id>.<field>`,
//! `effects.<id>.masks.<id>.<field>`). Every write is one command run through [`App::exec`]; a drag groups them
//! with [`Gesture`].

use cut_model::commands::build as C;
use cut_model::keyframes::{self as K, Ease, Keyframe, Value};
use cut_model::{Clip, Id, Sequence, TrackKind, effects, masks};
use cut_time::{Ticks, frame_start};
use serde_json::{Value as Json, json};

use crate::state::App;

/// The selected clip the panels edit: the first selected video clip in the sequence's order, else the first selected.
pub fn primary_clip(app: &App) -> Option<&Clip> {
    let seq = app.sequence()?;
    let picked = app.selected_clips();
    picked.iter().find(|c| seq.kind_of(c.track) == Some(TrackKind::Video)).or(picked.first()).copied()
}

/// The kind of a clip's track.
pub fn kind_of(seq: &Sequence, clip: &Clip) -> TrackKind {
    seq.kind_of(clip.track).unwrap_or(TrackKind::Video)
}

/// One frame of the sequence in ticks.
pub fn frame(seq: &Sequence) -> Ticks {
    frame_start(1, seq.fps).max(1)
}

/// Clip time (ticks from the clip's start) of `t`, kept inside the clip and on a frame (`clipTime`).
pub fn clip_time(seq: &Sequence, clip: &Clip, t: Ticks) -> Ticks {
    let f = frame(seq);
    let rel = (t - clip.start).clamp(0, (clip.duration() - f).max(0));
    ((rel as f64 / f as f64).round() as Ticks) * f
}

/// Whether `t` is inside the clip (`inClip`).
pub fn in_clip(clip: &Clip, t: Ticks) -> bool {
    t >= clip.start && t < clip.end()
}

/// The value of a property a clip has before anything is set (`defaultOf`); `None` for a mask's path and paths the
/// registry does not know.
pub fn default_of(clip: &Clip, path: &str) -> Option<Value> {
    let parts: Vec<&str> = path.split('.').collect();
    if let [p] = parts[..] {
        return Some(match p {
            "position" | "anchor" => Value::List(vec![0.0, 0.0]),
            "scale" => Value::List(vec![100.0, 100.0]),
            "rotation" | "volume" | "pan" => Value::Num(0.0),
            "opacity" => Value::Num(100.0),
            "crop" => Value::List(vec![0.0; 4]),
            _ => return None,
        });
    }
    if let Some(m) = masks::parse_path(path, true) {
        let d = masks::DEFAULTS;
        return match m.field {
            "feather" => Some(Value::Num(d.feather)),
            "opacity" => Some(Value::Num(d.opacity)),
            "expansion" => Some(Value::Num(d.expansion)),
            "inverted" => Some(Value::Flag(d.inverted)),
            "mode" => Some(Value::Text(d.mode.name().into())),
            _ => None,
        };
    }
    if let ["effects", e, param] = parts[..] {
        let fx = clip.effects.iter().find(|x| x.id.as_str() == e)?;
        let p = effects::get(&fx.kind)?.params.iter().find(|p| p.id == param)?;
        return K::from_json(&p.default.to_json());
    }
    if let ["layers", _, field] = parts[..] {
        return match field {
            "opacity" => Some(Value::Num(100.0)),
            "reveal" => Some(Value::Num(1.0)),
            _ => K::from_json(cut_model::defaults::text_layer(&Default::default()).get(field)?),
        };
    }
    None
}

/// The text layer fields that exist only as keyframes (`KEYFRAME_ONLY`, textrender.js).
const KEYFRAME_ONLY: [&str; 2] = ["opacity", "reveal"];

/// The keyframe menu's interpolations in its order (`edit.EASES`).
pub const EASES: [(Ease, &str); 6] = [
    (Ease::Linear, "Linear"),
    (Ease::EaseIn, "Ease In"),
    (Ease::EaseOut, "Ease Out"),
    (Ease::EaseInOut, "Ease In and Out"),
    (Ease::Bezier, "Bezier"),
    (Ease::Hold, "Hold"),
];

/// The list with the keyframes at `times` set to `ease` (`easeList`); one turned into a bezier keyframe gets the
/// handles that draw its segment as it was, so its motion does not jump.
pub fn ease_list(list: &[Keyframe], times: &[Ticks], ease: Ease) -> Vec<Keyframe> {
    list.iter()
        .map(|k| {
            if !times.contains(&k.t) {
                return k.clone();
            }
            let h = (ease == Ease::Bezier)
                .then(|| K::handles(k.ease, k.h.as_deref()).unwrap_or_else(|| K::DEFAULT_HANDLES.to_vec()));
            Keyframe { t: k.t, v: k.v.clone(), ease, h }
        })
        .collect()
}

/// The value of `path` at sequence time `t` (`valueAt`): its keyframes, else its static value, else its default.
pub fn value_at(seq: &Sequence, clip: &Clip, path: &str, t: Ticks) -> Option<Value> {
    K::prop_value(clip, path, clip_time(seq, clip, t) as f64).or_else(|| default_of(clip, path))
}

/// Whether the property has keyframes (its stopwatch is on).
pub fn keyframed(clip: &Clip, path: &str) -> bool {
    clip.keyframes.get(path).is_some_and(|l| !l.is_empty())
}

/// A keyframe value as the commands take it.
pub fn to_json(v: &Value) -> Json {
    serde_json::to_value(v).unwrap_or(Json::Null)
}

fn keys_json(list: &[Keyframe]) -> Option<Json> {
    (!list.is_empty()).then(|| serde_json::to_value(list).unwrap_or(Json::Null))
}

/// The command that sets the static value of a path (`setStatic`) with the playhead at `at`: a property, an effect
/// parameter (left out when it is the default, so a later change of the default reaches it), a mask's field, or a
/// text layer's field. `None` for a path of something else.
pub fn set_static_cmd(seq: &Sequence, clip: &Clip, path: &str, value: &Value, at: Ticks) -> Option<Json> {
    let (s, c) = (seq.id.as_str(), clip.id.as_str());
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() == 1 {
        return Some(C::set_clip(s, c, json!({ "props": { path: to_json(value) } }), json!({})));
    }
    if let Some(m) = masks::parse_path(path, true) {
        return Some(C::set_mask(s, c, m.mask_id, json!({ m.field: to_json(value) }), m.effect_id));
    }
    if let ["effects", e, param] = parts[..] {
        let v = if default_of(clip, path).as_ref() == Some(value) { Json::Null } else { to_json(value) };
        return Some(C::set_effect(s, c, e, json!({ "params": { param: v } })));
    }
    if let ["layers", layer, field] = parts[..] {
        // opacity and reveal of a text layer exist only as keyframes: a value is a keyframe at the playhead
        if KEYFRAME_ONLY.contains(&field) {
            let t = clip_time(seq, clip, at);
            let k = Keyframe { t, v: value.clone(), ease: Ease::Linear, h: None };
            return Some(C::set_keyframes(s, c, path, keys_json(&[k])));
        }
        return Some(C::set_layer(s, c, layer, json!({ field: to_json(value) })));
    }
    None
}

/// The command that sets `path` to `value` at sequence time `t` (`write`): the keyframe there when the path is
/// keyframed (made when missing, with the ease of the one before), else the static value.
pub fn write_cmd(seq: &Sequence, clip: &Clip, path: &str, value: &Value, t: Ticks) -> Option<Json> {
    let Some(list) = clip.keyframes.get(path).filter(|l| !l.is_empty()) else {
        return set_static_cmd(seq, clip, path, value, t);
    };
    let kt = clip_time(seq, clip, t);
    let old = list.iter().find(|k| k.t == kt);
    let ease = old.map(|k| k.ease).or_else(|| K::prev(list, kt).map(|k| k.ease)).unwrap_or(Ease::Linear);
    let next = K::insert(list, &Keyframe { t: kt, v: value.clone(), ease, h: old.and_then(|k| k.h.clone()) });
    Some(C::set_keyframes(seq.id.as_str(), clip.id.as_str(), path, keys_json(&next)))
}

/// Runs a command on the clip `clip` of the active sequence, built from the sequence and clip as they are now.
fn on_clip(app: &mut App, clip: Id, f: impl FnOnce(&Sequence, &Clip) -> Option<Json>) -> Option<Json> {
    let cmd = {
        let seq = app.sequence()?;
        f(seq, seq.clip(clip)?)?
    };
    app.exec(&cmd)
}

/// Sets `path` at the playhead (see [`write_cmd`]).
pub fn write(app: &mut App, clip: Id, path: &str, value: &Value) -> Option<Json> {
    let t = app.t;
    on_clip(app, clip, |s, c| write_cmd(s, c, path, value, t))
}

/// One undo step for a drag of a slider, a field or a handle (`gesture`): [`Gesture::begin`] when it starts,
/// [`Gesture::end`] when it stops; the commands between join the step.
#[derive(Debug, Default)]
pub struct Gesture {
    open: bool,
}

impl Gesture {
    pub fn begin(&mut self, app: &mut App, label: &str) {
        if !self.open {
            app.history.begin(label);
            self.open = true;
        }
    }

    pub fn end(&mut self, app: &mut App) {
        if self.open {
            self.open = false;
            app.history.commit();
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }
}

/// The command that sets a path's keyframes (`None`: no keyframes).
pub fn keys_cmd(seq: Id, clip: Id, path: &str, list: &[Keyframe]) -> Json {
    C::set_keyframes(seq.as_str(), clip.as_str(), path, keys_json(list))
}

/// Sets the static value of `path` (see [`set_static_cmd`]).
pub fn set_static(app: &mut App, clip: Id, path: &str, value: &Value) -> Option<Json> {
    let t = app.t;
    on_clip(app, clip, |s, c| set_static_cmd(s, c, path, value, t))
}
