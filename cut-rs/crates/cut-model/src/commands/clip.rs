//! A clip's settings, keyframes, time remapping, links, effects, masks, transitions and generators (port of
//! commands.js's clip commands).

use cut_time::Ticks;
use serde_json::{Value as Json, json};

use super::timeline::{Limits, drop_transitions, lift_transitions, trim_in};
use super::{Code, Ctx, R, context, defined, fail, given, id_list, id_of, invalid, list, media_of, num, opts, string};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::keyframes::{Ease, Keyframe};
use crate::masks;
use crate::project::{Clip, Effect, Project, Props, Role, Sampling, Source, TrackKind, Transition};
use crate::remap::{self as R_, Direction, Remap};

fn remapped<T>() -> R<T> {
    fail("This clip has Time Remapping. Change its speed with Time Remapping.", Code::Remap)
}

fn role_of(v: &Json) -> R<Option<Role>> {
    if v.is_null() {
        return Ok(None);
    }
    serde_json::from_value(v.clone()).map(Some).or_else(|_| invalid(format!("unknown clip role {}", string(v))))
}

fn truthy(v: &Json) -> bool {
    !matches!(v, Json::Null | Json::Bool(false))
        && v != &json!(0)
        && v != &json!("")
        && !v.as_f64().is_some_and(f64::is_nan)
}

const CLIP_FIELDS: [&str; 12] = [
    "props", "speed", "duration", "ripple", "reverse", "enabled", "name", "label", "role", "fadeIn", "fadeOut",
    "sampling",
];

pub fn set_clip(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    let id = clip.id;
    let patch = opts(cmd, "patch").clone();
    let linked = cmd.get("opts").and_then(|o| o.get("linked")) != Some(&json!(false));
    for k in patch.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !CLIP_FIELDS.contains(&k.as_str()) {
            return invalid(format!("unknown clip setting {k}"));
        }
    }
    let kind = c.kind_of(&clip)?;
    c.unlocked(clip.track)?;
    let mut damaged = false;
    if let Some(props) = given(&patch, "props").filter(|v| truthy(v)) {
        let allowed: &[&str] =
            if kind == TrackKind::Audio { &crate::defaults::AUDIO_PROPS } else { &crate::defaults::VIDEO_PROPS };
        let mut json_props = serde_json::to_value(&clip.props).expect("props serialize");
        for (k, v) in props.as_object().into_iter().flatten() {
            if !allowed.contains(&k.as_str()) {
                return invalid(format!("unknown property {k}"));
            }
            json_props[k] = v.clone();
        }
        // a value the types cannot hold: the JavaScript sets it, goes on, and its validation refuses the result
        match serde_json::from_value::<Props>(json_props) {
            Ok(next) => c.edit(id, |x| x.props = next),
            Err(_) => damaged = true,
        }
    }
    if let Some(n) = defined(&patch, "name") {
        let n = string(n);
        c.edit(id, |x| x.name = n);
    }
    if let Some(l) = defined(&patch, "label") {
        let l = if l.is_null() { None } else { Some(string(l)) };
        c.edit(id, |x| x.label = l);
    }
    if let Some(r) = defined(&patch, "role") {
        let r = role_of(r)?;
        c.edit(id, |x| x.role = r);
    }
    if let Some(e) = defined(&patch, "enabled") {
        let e = truthy(e);
        c.edit(id, |x| x.enabled = e);
    }
    if let Some(s) = defined(&patch, "sampling") {
        let s: Sampling =
            serde_json::from_value(s.clone()).or_else(|_| invalid(format!("unknown frame sampling {}", string(s))))?;
        c.edit(id, |x| x.sampling = s);
    }
    if let Some(r) = defined(&patch, "reverse") {
        let r = truthy(r);
        let mut group = vec![id];
        if linked {
            group.extend(c.seq().linked_clips(&clip).into_iter().map(|x| x.id));
        }
        for g in &group {
            let t = c.clip(*g)?.track;
            c.unlocked(t)?;
        }
        for g in &group {
            let gc = c.clip(*g)?;
            if gc.remap.is_some() && r != gc.reverse {
                return remapped();
            }
        }
        for g in &group {
            c.edit(*g, |x| x.reverse = r);
        }
    }
    let ripple = patch.get("ripple").is_some_and(truthy);
    if defined(&patch, "speed").is_some() && defined(&patch, "duration").is_some() {
        return invalid("give a speed or a duration");
    }
    if let Some(s) = defined(&patch, "speed") {
        let s = num(Some(s), "speed")?;
        set_speed(&mut c, id, s, ripple, linked, None)?;
    }
    if let Some(d) = defined(&patch, "duration") {
        let d = c.f.max(c.frames(Some(d), "duration")?);
        let now = c.clip(id)?.clone();
        if now.remap.is_some() {
            return remapped();
        }
        if c.still(&now) {
            let delta = d - now.duration();
            let mode = if ripple { "ripple" } else { "normal" };
            trim_in(&mut c, id, &json!({ "edge": "end", "delta": delta, "mode": mode, "linked": linked }))?;
        } else {
            set_speed(&mut c, id, (now.out - now.in_) / d as f64, ripple, linked, Some(d))?;
        }
    }
    for k in ["fadeIn", "fadeOut"] {
        let Some(v) = defined(&patch, k) else { continue };
        let v = c.frames(Some(v), k)?.max(0);
        let d = c.clip(id)?.duration();
        c.edit(id, |x| {
            if k == "fadeIn" {
                x.fade_in = v.min(d);
                x.fade_out = x.fade_out.min(d - x.fade_in);
            } else {
                x.fade_out = v.min(d - x.fade_in);
            }
        });
    }
    if damaged {
        return super::fail_at(
            "The edit would leave the project damaged.",
            Code::InvalidResult,
            format!("clip {id}: a property is not a number"),
        );
    }
    Ok(json!({}))
}

/// Keyframes and clip markers of a clip whose speed changed by `ratio` (old / new) stay on their source frames.
pub(crate) fn rescale_keys(c: &mut Ctx, id: Id, ratio: f64) {
    let f = c.f as f64;
    c.edit(id, |x| {
        let at = |t: Ticks| (crate::query::js_round(t as f64 * ratio / f) * f) as Ticks;
        for list in x.keyframes.values_mut() {
            let mut by_t: Vec<Keyframe> = Vec::new();
            for k in list.iter() {
                let t = at(k.t);
                let nk = Keyframe { t, ..k.clone() };
                match by_t.iter_mut().find(|y| y.t == t) {
                    Some(slot) => *slot = nk,
                    None => by_t.push(nk),
                }
            }
            by_t.sort_by_key(|k| k.t);
            *list = by_t;
        }
        if let Some(m) = &mut x.markers {
            for mk in m {
                mk.t = at(mk.t);
            }
        }
    });
}

/// Speed keeps the clip's start and the source span it shows, so its length changes; without ripple it cannot grow
/// into the next clip.
fn set_speed(c: &mut Ctx, id: Id, speed: f64, ripple: bool, linked: bool, want: Option<Ticks>) -> R<()> {
    if !(0.01..=100.0).contains(&speed) {
        return fail("Speed must be between 1% and 10000%.", Code::Speed);
    }
    let clip = c.clip(id)?.clone();
    let mut group = vec![id];
    if linked {
        group.extend(
            c.seq()
                .linked_clips(&clip)
                .into_iter()
                .filter(|x| x.start == clip.start && x.end() == clip.end())
                .map(|x| x.id),
        );
    }
    for g in &group {
        let t = c.clip(*g)?.track;
        c.unlocked(t)?;
    }
    for g in &group {
        if c.clip(*g)?.remap.is_some() {
            return remapped();
        }
    }
    let old = clip.duration();
    let pos = clip.end();
    let f = c.f as f64;
    let mut nd = old as f64;
    if !c.still(&clip) {
        nd = want.map_or_else(|| f.max(crate::query::js_round((clip.out - clip.in_) / speed / f) * f), |w| w as f64);
        for g in &group {
            let gc = c.clip(*g)?;
            let span = if gc.reverse { gc.out } else { c.p.source_length(gc) - gc.in_ };
            nd = nd.min(c.floor_frames(span / speed));
        }
    }
    if !ripple {
        for g in &group {
            let gc = c.clip(*g)?.clone();
            nd = nd.min(c.floor_frames(c.neighbours(&gc).1 - gc.start as f64));
        }
    }
    if nd.is_nan() || nd < f {
        return fail("The clip is too short.", Code::TooShort);
    }
    let nd = nd as Ticks;
    let l = nd - old;
    let tracks: Vec<Id> = group.iter().map(|g| c.clip(*g).expect("in the group").track).collect();
    let carried = lift_transitions(c, &tracks, pos);
    if ripple && l > 0 {
        c.ripple_insert(&tracks, pos, l)?;
    }
    for g in &group {
        let gc = c.clip(*g)?.clone();
        let ratio = gc.speed / speed;
        let still = c.still(&gc);
        c.edit(*g, |x| {
            x.speed = speed;
            if still || !x.reverse {
                x.out = x.in_ + nd as f64 * speed;
            } else {
                x.in_ = x.out - nd as f64 * speed;
            }
        });
        rescale_keys(c, *g, ratio);
        c.clamp_fades(*g, nd);
    }
    if ripple && l < 0 {
        c.ripple_remove(&tracks, pos + l, pos)?;
    }
    let start = c.clip(id)?.start;
    drop_transitions(c, carried, start + nd);
    Ok(())
}

pub fn set_remap(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    c.unlocked(clip.track)?;
    if c.kind_of(&clip)? != TrackKind::Video {
        return fail("Time Remapping is for video clips.", Code::Remap);
    }
    if c.still(&clip) {
        return fail("This clip has no source frames to remap.", Code::Still);
    }
    let old = clip.duration();
    let r: Remap = match given(cmd, "remap") {
        None => {
            let Some(cur) = &clip.remap else { return Ok(json!({ "duration": old, "clamped": null })) };
            let v0 = R_::speed_at(cur, 0.0);
            let v = if v0 == 0.0 || v0.is_nan() { 1.0 } else { v0 };
            R_::constant(cur.at, v.signum() * R_::MAX.min(R_::MIN.max(v.abs())), old)
        }
        Some(x) => {
            let (Some(speeds), Some(keys)) =
                (x.get("speeds").and_then(Json::as_array), x.get("keys").and_then(Json::as_array))
            else {
                return invalid("invalid time remapping");
            };
            let speeds = speeds.iter().map(|v| num(Some(v), "speed")).collect::<R<Vec<f64>>>()?;
            let mut ks = Vec::new();
            for k in keys {
                let t = c.frames(k.get("t"), "key time")?.max(0);
                let ramp = c.frames(Some(given(k, "ramp").unwrap_or(&json!(0))), "ramp")?.max(0);
                ks.push(R_::RemapKey { t, ramp });
            }
            let r = Remap {
                at: num(x.get("at"), "at")?,
                speeds,
                keys: ks,
                duration: c.f.max(c.frames(x.get("duration"), "duration")?),
            };
            if r.speeds.iter().any(|v| v.abs() > R_::MAX + 1e-9) {
                return fail("Speed must be between 1% and 10000%.", Code::Speed);
            }
            if !R_::valid(&r, c.f) {
                return invalid("invalid time remapping");
            }
            r
        }
    };
    let len = c.p.source_length(&clip);
    let s0 = R_::value(&r, 0.0);
    if !(-0.5..=len + 0.5).contains(&s0) {
        return fail("The source has no frames there.", Code::Source);
    }
    let mut lim = Limits::new();
    lim.limit(f64::NEG_INFINITY, c.floor_frames(R_::stay(&r, 0.0, Direction::Later, -0.25, len + 0.25)), "source");
    lim.limit(f64::NEG_INFINITY, c.floor_frames(c.neighbours(&clip).1 - clip.start as f64), "neighbour");
    let (got, clamped) = lim.apply(r.duration as f64);
    if got.is_nan() || got < c.f as f64 {
        return fail("The clip is too short.", Code::TooShort);
    }
    let got = got as Ticks;
    let carried = if got != old { lift_transitions(&mut c, &[clip.track], clip.end()) } else { Vec::new() };
    c.set_curve(clip.id, R_::with_duration(&r, got));
    c.clamp_fades(clip.id, got);
    drop_transitions(&mut c, carried, clip.start + got);
    Ok(json!({ "duration": got, "clamped": clamped }))
}

pub fn set_keyframes(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    c.unlocked(clip.track)?;
    let prop = cmd.get("prop").and_then(Json::as_str).unwrap_or_default().to_owned();
    if !crate::validate::valid_prop_path(&clip, c.kind_of(&clip)?, &prop) {
        return invalid(format!("the clip has no property {}", cmd.get("prop").map_or("undefined".into(), string)));
    }
    let given_list = given(cmd, "keyframes");
    if given_list.is_none_or(|l| l.as_array().is_some_and(Vec::is_empty)) {
        c.edit(clip.id, |x| x.keyframes.remove(&prop));
        return Ok(json!({}));
    }
    let mut by_t: Vec<Keyframe> = Vec::new();
    for k in list(given_list, "keyframes")? {
        let ease_json = given(k, "ease").cloned().unwrap_or(json!("linear"));
        let ease: Ease = serde_json::from_value(ease_json.clone())
            .or_else(|_| invalid(format!("unknown ease {}", string(&ease_json))))?;
        let t = c.frames(k.get("t"), "keyframe time")?;
        let v = crate::keyframes::from_json(k.get("v").unwrap_or(&Json::Null))
            .map_or_else(|| invalid("a keyframe value is not a value"), Ok)?;
        let h = if ease == Ease::Bezier {
            Some(list(k.get("h"), "bezier handles")?.iter().take(4).map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
        } else {
            None
        };
        let kf = Keyframe { t, v, ease, h };
        match by_t.iter_mut().find(|y| y.t == t) {
            Some(slot) => *slot = kf,
            None => by_t.push(kf),
        }
    }
    by_t.sort_by_key(|k| k.t);
    c.edit(clip.id, |x| x.keyframes.insert(prop, by_t));
    Ok(json!({}))
}

fn unique_clips(c: &Ctx, ids: Option<&Json>) -> R<Vec<Id>> {
    let mut out = Vec::new();
    for id in id_list(ids, "clipIds")? {
        let id = match id {
            Some(id) => c.clip(id)?.id,
            None => return fail("there is no clip undefined", Code::NotFound),
        };
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// Link (prefix `L`) or group (`G`) two or more clips.
pub fn link(p: &mut Project, tx: &mut Tx, cmd: &Json, prefix: &str) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clips = unique_clips(&c, cmd.get("clipIds"))?;
    let group = prefix == "G";
    if clips.len() < 2 {
        return if group {
            fail("Choose two or more clips to group.", Code::GroupOne)
        } else {
            fail("Choose two or more clips to link.", Code::LinkOne)
        };
    }
    let id = c.nid(prefix);
    for x in &clips {
        c.edit(*x, |k| if group { k.group = Some(id) } else { k.link = Some(id) });
    }
    Ok(if group { json!({ "group": id }) } else { json!({ "link": id }) })
}

pub fn unlink(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    for id in id_list(cmd.get("clipIds"), "clipIds")? {
        let id = match id {
            Some(id) => c.clip(id)?.id,
            None => return fail("there is no clip undefined", Code::NotFound),
        };
        c.edit(id, |x| x.link = None);
    }
    Ok(json!({}))
}

pub fn ungroup(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let mut groups: Vec<Id> = Vec::new();
    for id in id_list(cmd.get("clipIds"), "clipIds")? {
        let g = match id {
            Some(id) => c.clip(id)?.group,
            None => return fail("there is no clip undefined", Code::NotFound),
        };
        if let Some(g) = g
            && !groups.contains(&g)
        {
            groups.push(g);
        }
    }
    let members: Vec<Id> =
        c.seq().clips_in_order().filter(|x| x.group.is_some_and(|g| groups.contains(&g))).map(|x| x.id).collect();
    for id in members {
        c.edit(id, |x| x.group = None);
    }
    Ok(json!({ "groups": groups }))
}

pub fn set_role(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let role = role_of(given(cmd, "role").unwrap_or(&Json::Null))?;
    let linked = cmd.get("opts").and_then(|o| o.get("linked")) != Some(&json!(false));
    let clips = c.with_linked(cmd.get("clipIds"), linked, false)?;
    for id in &clips {
        let t = c.clip(*id)?.track;
        c.unlocked(t)?;
    }
    for id in &clips {
        c.edit(*id, |x| x.role = role);
    }
    Ok(json!({ "ids": clips }))
}

pub fn replace_audio(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let m = media_of(c.p, cmd.get("mediaId"))?;
    if m.audio.is_none() {
        return fail("The media has no sound.", Code::NoAudio);
    }
    let mut clips = Vec::new();
    for id in id_list(cmd.get("clipIds"), "clipIds")? {
        let x = match id {
            Some(id) => c.clip(id)?.clone(),
            None => return fail("there is no clip undefined", Code::NotFound),
        };
        if c.kind_of(&x)? != TrackKind::Audio || x.media_id().is_none() {
            return fail("Only audio clips of a media file can take another sound.", Code::NotAudio);
        }
        c.unlocked(x.track)?;
        if x.in_.max(x.out) > m.duration + 0.5 {
            return fail("The new sound is shorter than the clip.", Code::TooShort);
        }
        clips.push(x.id);
    }
    for id in &clips {
        c.edit(*id, |x| x.source = Source::Media { media: m.id, freeze: false, extra: Default::default() });
    }
    Ok(json!({ "ids": clips }))
}

// ---- effects ----

fn effect_index(clip: &Clip, id: Option<&Json>) -> R<usize> {
    let want = id.and_then(Json::as_str);
    clip.effects.iter().position(|e| Some(e.id.as_str()) == want).map_or_else(
        || fail(format!("there is no effect {}", id.map_or("undefined".into(), string)), Code::NotFound),
        Ok,
    )
}

fn clip_unlocked(c: &Ctx, cmd: &Json) -> R<Clip> {
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    c.unlocked(clip.track)?;
    Ok(clip)
}

pub fn add_effect(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = clip_unlocked(&c, cmd)?;
    let Some(kind) = cmd.get("effectType").and_then(Json::as_str).filter(|s| !s.is_empty()) else {
        return invalid("the effect has no type");
    };
    let mut n = 1_i64;
    for e in &clip.effects {
        let s = e.id.as_str();
        if let Some(d) = s.strip_prefix('e').filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) {
            n = n.max(d.parse::<f64>().map_or(i64::MAX, |x| x as i64).saturating_add(1));
        }
    }
    let params = cmd.get("params").and_then(Json::as_object).cloned().unwrap_or_default();
    let effect = Effect {
        id: Id::numbered("e", n),
        kind: kind.to_owned(),
        on: true,
        params,
        masks: None,
        extra: Default::default(),
    };
    let len = clip.effects.len();
    let index = super::splice_index(cmd.get("index"), len);
    let eid = effect.id;
    c.edit(clip.id, |x| x.effects.insert(index.min(x.effects.len()), effect));
    Ok(json!({ "id": eid }))
}

pub fn remove_effect(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = clip_unlocked(&c, cmd)?;
    let i = effect_index(&clip, cmd.get("effectId"))?;
    let prefix = format!("effects.{}.", clip.effects[i].id);
    c.edit(clip.id, |x| {
        x.keyframes.retain(|k, _| !k.starts_with(&prefix));
        x.effects.remove(i);
    });
    Ok(json!({}))
}

pub fn set_effect(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = clip_unlocked(&c, cmd)?;
    let i = effect_index(&clip, cmd.get("effectId"))?;
    let patch = opts(cmd, "patch").clone();
    c.edit(clip.id, |x| {
        let e = &mut x.effects[i];
        if let Some(on) = defined(&patch, "on") {
            e.on = truthy(on);
        }
        for (k, v) in opts(&patch, "params").as_object().into_iter().flatten() {
            if v.is_null() {
                e.params.remove(k);
            } else {
                e.params.insert(k.clone(), v.clone());
            }
        }
    });
    Ok(json!({}))
}

pub fn move_effect(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = clip_unlocked(&c, cmd)?;
    let i = effect_index(&clip, cmd.get("effectId"))?;
    let to = num(cmd.get("index"), "index")?.min(clip.effects.len() as f64 - 1.0).max(0.0);
    if i as f64 == to {
        return Ok(json!({}));
    }
    // splice takes the whole part of a fractional index
    let to = to as usize;
    c.edit(clip.id, |x| {
        let e = x.effects.remove(i);
        x.effects.insert(to.min(x.effects.len()), e);
    });
    Ok(json!({}))
}

// ---- masks (Opacity's or an effect's) ----

/// The next free mask id of a clip, unique across its lists.
pub fn next_mask_id(clip: &Clip) -> Id {
    let mut n = 1_i64;
    let lists = clip.masks.iter().flatten().chain(clip.effects.iter().flat_map(|e| e.masks.iter().flatten()));
    for m in lists {
        if let Some(d) =
            m.id.as_str().strip_prefix('m').filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        {
            n = n.max(d.parse::<f64>().map_or(i64::MAX, |x| x as i64).saturating_add(1));
        }
    }
    Id::numbered("m", n)
}

/// Whose masks a command works on: Opacity's (the clip's own) or an effect's, by index.
#[derive(Clone, Copy)]
enum Holder {
    Opacity,
    Effect(usize),
}

impl Holder {
    fn masks(self, clip: &Clip) -> Option<&Vec<masks::Mask>> {
        match self {
            Holder::Opacity => clip.masks.as_ref(),
            Holder::Effect(i) => clip.effects[i].masks.as_ref(),
        }
    }

    fn masks_mut(self, clip: &mut Clip) -> &mut Option<Vec<masks::Mask>> {
        match self {
            Holder::Opacity => &mut clip.masks,
            Holder::Effect(i) => &mut clip.effects[i].masks,
        }
    }

    /// The start of the keyframe paths of its masks (`prefixOf`).
    fn prefix(self, clip: &Clip) -> String {
        match self {
            Holder::Opacity => "masks".into(),
            Holder::Effect(i) => format!("effects.{}.masks", clip.effects[i].id),
        }
    }
}

/// The clip and whose masks (`maskHolder`): masks go on video clips, and on an effect only one the registry knows as
/// a video effect that takes masks.
fn mask_holder(c: &Ctx, cmd: &Json) -> R<(Clip, Holder)> {
    let clip = clip_unlocked(c, cmd)?;
    if c.kind_of(&clip)? != TrackKind::Video {
        return fail("Masks go on video clips.", Code::NotVideo);
    }
    let Some(effect) = cmd.get("opts").and_then(|o| given(o, "effectId")) else { return Ok((clip, Holder::Opacity)) };
    let i = effect_index(&clip, Some(effect))?;
    let takes =
        crate::effects::get(&clip.effects[i].kind).is_some_and(|d| d.kind == crate::effects::Kind::Video && d.masks);
    if !takes {
        return fail("This effect takes no masks.", Code::NoMasks);
    }
    Ok((clip, Holder::Effect(i)))
}

pub fn add_mask(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, holder) = mask_holder(&c, cmd)?;
    if holder.masks(&clip).map_or(0, Vec::len) >= masks::MAX_MASKS {
        return fail("There are as many masks as there can be.", Code::TooMany);
    }
    let id = next_mask_id(&clip);
    let mut m = cmd.get("mask").and_then(Json::as_object).cloned().unwrap_or_default();
    m.insert("id".into(), json!(id));
    let m = Json::Object(m);
    let full = full_mask(&m);
    let Some(mask) = masks::full(&full).filter(|_| masks::valid(&full)) else {
        return invalid(format!("the mask is not valid: {}", masks::problem(&full).unwrap_or_default()));
    };
    c.edit(clip.id, |x| holder.masks_mut(x).get_or_insert_with(Vec::new).push(mask));
    Ok(json!({ "id": id }))
}

/// `M.full(m)` as JSON: the given fields over the defaults, only a mask's fields.
fn full_mask(m: &Json) -> Json {
    let d = masks::DEFAULTS;
    let pick = |k: &str, dv: Json| given(m, k).cloned().unwrap_or(dv);
    json!({
        "id": m.get("id"), "mode": pick("mode", json!(d.mode)), "inverted": pick("inverted", json!(d.inverted)),
        "path": m.get("path"), "feather": pick("feather", json!(d.feather)), "opacity": pick("opacity", json!(d.opacity)),
        "expansion": pick("expansion", json!(d.expansion)),
    })
}

fn mask_index(clip: &Clip, holder: Holder, id: Option<&Json>) -> R<usize> {
    let want = id.and_then(Json::as_str);
    holder
        .masks(clip)
        .into_iter()
        .flatten()
        .position(|m| Some(m.id.as_str()) == want)
        .map_or_else(|| fail(format!("there is no mask {}", id.map_or("undefined".into(), string)), Code::NotFound), Ok)
}

pub fn set_mask(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, holder) = mask_holder(&c, cmd)?;
    let i = mask_index(&clip, holder, cmd.get("maskId"))?;
    let patch = opts(cmd, "patch");
    let mut next = serde_json::to_value(&holder.masks(&clip).expect("found")[i]).expect("a mask serializes");
    for k in ["mode", "inverted", "path", "feather", "opacity", "expansion"] {
        if let Some(v) = defined(patch, k) {
            next[k] = v.clone();
        }
    }
    let Some(mask) = masks::full(&next).filter(|_| masks::valid(&next)) else {
        return invalid(format!("the mask is not valid: {}", masks::problem(&next).unwrap_or_default()));
    };
    c.edit(clip.id, |x| holder.masks_mut(x).as_mut().expect("found")[i] = mask);
    Ok(json!({}))
}

pub fn remove_mask(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, holder) = mask_holder(&c, cmd)?;
    let i = mask_index(&clip, holder, cmd.get("maskId"))?;
    let prefix = format!("{}.{}.", holder.prefix(&clip), holder.masks(&clip).expect("found")[i].id);
    c.edit(clip.id, |x| {
        x.keyframes.retain(|k, _| !k.starts_with(&prefix));
        let list = holder.masks_mut(x);
        match list {
            Some(l) if l.len() > 1 => {
                l.remove(i);
            }
            _ => *list = None,
        }
    });
    Ok(json!({}))
}

// ---- transitions ----

fn transition_index(c: &Ctx, id: Option<&Json>) -> R<usize> {
    let want = id.and_then(Json::as_str);
    c.seq().transitions.iter().position(|t| Some(t.id.as_str()) == want).map_or_else(
        || fail(format!("there is no transition {}", id.map_or("undefined".into(), string)), Code::NotFound),
        Ok,
    )
}

/// The longest a transition at `at` with `align` may be without overlapping another on its track.
fn room_for(c: &Ctx, track: Id, at: Ticks, align: crate::project::Align, except: Option<Id>) -> f64 {
    use crate::project::Align;
    let (k1, k2) = match align {
        Align::Start => (0.0, 1.0),
        Align::End => (1.0, 0.0),
        Align::Center => (0.5, 0.5),
    };
    let mut room = f64::INFINITY;
    let at = at as f64;
    for t in &c.seq().transitions {
        if t.track != track || Some(t.id) == except || t.at as f64 == at {
            continue;
        }
        let (ta, d) = (t.at as f64, t.duration as f64);
        let (a, b) = match t.align {
            Align::Start => (ta, ta + d),
            Align::End => (ta - d, ta),
            Align::Center => (ta - d / 2.0, ta + d / 2.0),
        };
        if b <= at && k1 != 0.0 {
            room = room.min((at - b) / k1);
        }
        if a >= at && k2 != 0.0 {
            room = room.min((a - at) / k2);
        }
        if a < at && b > at {
            room = 0.0;
        }
    }
    room
}

fn fit_transition(
    c: &Ctx,
    track: Id,
    at: Ticks,
    align: crate::project::Align,
    d: Ticks,
    except: Option<Id>,
) -> R<Ticks> {
    let room = room_for(c, track, at, align, except);
    if room == f64::INFINITY || d as f64 <= room {
        return Ok(d);
    }
    let fit = (room / c.f as f64 + 1e-9).floor() * c.f as f64;
    if fit < c.f as f64 {
        return fail(
            "There is no room for a transition here: the transitions beside it reach this edit point.",
            Code::NoRoom,
        );
    }
    Ok(fit as Ticks)
}

fn align_of(v: &Json) -> R<crate::project::Align> {
    serde_json::from_value(v.clone()).or_else(|_| invalid(format!("unknown alignment {}", string(v))))
}

pub fn add_transition(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts").clone();
    let track = c.track_json(o.get("track"))?.id;
    c.unlocked(track)?;
    let at = c.at(o.get("at"), "time")?;
    if !c.seq().track(track).is_some_and(|t| t.clips.iter().any(|x| x.start == at || x.end() == at)) {
        return fail("Transitions go on an edit point or a clip end.", Code::NoEdge);
    }
    let Some(kind) = o.get("type").and_then(Json::as_str).filter(|s| !s.is_empty()) else {
        return invalid("the transition has no type");
    };
    let align = align_of(given(&o, "align").unwrap_or(&json!("center")))?;
    let want = given(&o, "duration").cloned().or_else(|| c.p.settings.get("transitionDuration").cloned());
    let d = fit_transition(&c, track, at, align, c.f.max(c.frames(want.as_ref(), "duration")?), None)?;
    let id = c.nid("t");
    let params = o.get("params").and_then(Json::as_object).cloned().unwrap_or_default();
    let t = Transition { id, track, at, kind: kind.to_owned(), duration: d, align, params, extra: Default::default() };
    let ts = c.transitions_mut();
    ts.retain(|x| !(x.track == track && x.at == at));
    ts.push(t);
    Ok(json!({ "id": id }))
}

pub fn remove_transition(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let i = transition_index(&c, cmd.get("id"))?;
    let track = c.seq().transitions[i].track;
    c.unlocked(track)?;
    c.transitions_mut().remove(i);
    Ok(json!({}))
}

pub fn set_transition(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let i = transition_index(&c, cmd.get("id"))?;
    let t = c.seq().transitions[i].clone();
    c.unlocked(t.track)?;
    let patch = opts(cmd, "patch").clone();
    for k in patch.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !["type", "duration", "align", "params"].contains(&k.as_str()) {
            return invalid(format!("unknown transition setting {k}"));
        }
    }
    let mut next = t.clone();
    if let Some(k) = defined(&patch, "type") {
        next.kind = string(k);
    }
    let align = match defined(&patch, "align") {
        Some(a) => Some(align_of(a)?),
        None => None,
    };
    let use_align = align.unwrap_or(t.align);
    if defined(&patch, "duration").is_some() || align.is_some() {
        let d = match defined(&patch, "duration") {
            Some(d) => c.f.max(c.frames(Some(d), "duration")?),
            None => t.duration,
        };
        next.duration = fit_transition(&c, t.track, t.at, use_align, d, Some(t.id))?;
    }
    if let Some(a) = align {
        next.align = a;
    }
    for (k, v) in opts(&patch, "params").as_object().into_iter().flatten() {
        if v.is_null() {
            next.params.remove(k);
        } else {
            next.params.insert(k.clone(), v.clone());
        }
    }
    c.transitions_mut()[i] = next;
    Ok(json!({}))
}

/// Cuts the clip at t and puts a still of the frame there for `duration`, pushing the rest later.
pub fn freeze_frame(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    let media = clip.media_id().and_then(|m| c.p.media(m)).map(|m| m.id);
    let Some(media) = media.filter(|_| c.kind_of(&clip).ok() == Some(TrackKind::Video) && !c.still(&clip)) else {
        return fail("This clip has no frame to freeze.", Code::NoFrame);
    };
    c.unlocked(clip.track)?;
    let at = c.at(cmd.get("t"), "time")?;
    if at < clip.start || at >= clip.end() {
        return fail("The playhead is not on the clip.", Code::NotOnClip);
    }
    let want = given(cmd, "duration").cloned().or_else(|| c.p.settings.get("freezeDuration").cloned());
    let d = c.f.max(c.frames(want.as_ref(), "duration")?);
    let src = clip.source_time(at as f64);
    let off = at - clip.start;
    let mut frozen = crate::project::Keyframes::new();
    for (prop, list) in &clip.keyframes {
        let v = crate::keyframes::value_at(list, off as f64).expect("a keyframe list is not empty");
        frozen.insert(prop.clone(), vec![Keyframe { t: 0, v, ease: Ease::Linear, h: None }]);
    }
    let mut tracks = vec![clip.track];
    tracks.extend(c.seq().linked_clips(&clip).iter().map(|x| x.track));
    c.ripple_insert(&tracks, at, d)?;
    let id = c.nid("c");
    let source = Source::Media { media, freeze: true, extra: Default::default() };
    let mut fz =
        crate::defaults::clip(TrackKind::Video, id, clip.track, at, src, src + d as f64, source, clip.name.clone());
    fz.label = clip.label.clone();
    fz.enabled = clip.enabled;
    fz.props = clip.props.clone();
    fz.effects = clip.effects.clone();
    fz.masks = clip.masks.clone();
    fz.keyframes = frozen;
    c.add(fz, None);
    let _ = id_of;
    Ok(json!({ "id": id }))
}
