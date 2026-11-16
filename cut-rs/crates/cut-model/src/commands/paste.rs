//! Rate Stretch and paste (port of commands.js's `stretch`, `fitToFrames` and `paste`).

use cut_time::Ticks;
use serde_json::{Value as Json, json};

use super::timeline::{Limits, drop_transitions, lift_transitions, norm_source, trim_in};
use super::{Code, Ctx, R, context, defined, fail, fail_at, given, id_of, invalid, list, num, opts, string};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::project::{Clip, Project, Source, TrackKind};
use crate::remap::{self as R_, Direction};

fn truthy(v: Option<&Json>) -> bool {
    v.is_some_and(|v| !matches!(v, Json::Null | Json::Bool(false)) && v != &json!(0) && v != &json!(""))
}

/// Rate Stretch: an edge moves and the speed changes so the same source fills the new length.
pub fn stretch(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    let end_edge = match o.get("edge").and_then(Json::as_str) {
        Some("end") => true,
        Some("start") => false,
        _ => return invalid(format!("unknown edge {}", o.get("edge").map_or("undefined".into(), string))),
    };
    if c.still(&clip) {
        let mut t = json!({ "edge": o["edge"], "mode": "normal" });
        if let Some(d) = defined(o, "delta") {
            t["delta"] = d.clone();
        }
        if let Some(l) = defined(o, "linked") {
            t["linked"] = l.clone();
        }
        return trim_in(&mut c, clip.id, &t);
    }
    let (s0, e0) = (clip.start, clip.end());
    let old = (e0 - s0) as f64;
    let mut group = vec![clip.id];
    if o.get("linked") != Some(&json!(false)) {
        group.extend(
            c.seq()
                .linked_clips(&clip)
                .into_iter()
                .filter(|x| x.start == s0 && x.end() == e0 && !c.still(x))
                .map(|x| x.id),
        );
    }
    for g in &group {
        let t = c.clip(*g)?.track;
        c.unlocked(t)?;
    }
    for g in &group {
        if c.clip(*g)?.remap.is_some() {
            return fail("This clip has Time Remapping. Change its speed with Time Remapping.", Code::Remap);
        }
    }
    let sign = if end_edge { 1.0 } else { -1.0 };
    let f = c.f as f64;
    let inf = f64::INFINITY;
    let mut lim = Limits::new();
    let len = |lim: &mut Limits, lo: f64, hi: f64, why| {
        if sign > 0.0 { lim.limit(lo - old, hi - old, why) } else { lim.limit(old - hi, old - lo, why) }
    };
    len(&mut lim, f, inf, "length");
    for g in &group {
        let gc = c.clip(*g)?.clone();
        let span = gc.out - gc.in_;
        len(&mut lim, f.max((span / 100.0 / f - 1e-9).ceil() * f), c.floor_frames(span / 0.01), "speed");
        let (prev_end, next_start) = c.neighbours(&gc);
        len(&mut lim, -inf, if end_edge { next_start - s0 as f64 } else { e0 as f64 - prev_end }, "neighbour");
    }
    let d = c.frames(Some(given(o, "delta").unwrap_or(&json!(0))), "delta")?;
    let (applied, clamped) = lim.apply(d as f64);
    if applied == 0.0 {
        return Ok(json!({ "applied": 0, "clamped": clamped, "speed": clip.speed }));
    }
    let nd = (old + sign * applied) as Ticks;
    let tracks: Vec<Id> = group.iter().map(|g| c.clip(*g).expect("in the group").track).collect();
    let carried = lift_transitions(&mut c, &tracks, if end_edge { e0 } else { s0 });
    for g in &group {
        let gc = c.clip(*g)?.clone();
        let speed = (gc.out - gc.in_) / nd as f64;
        let ratio = gc.speed / speed;
        c.edit(*g, |x| {
            x.speed = speed;
            if !end_edge {
                x.start = e0 - nd;
            }
        });
        super::clip::rescale_keys(&mut c, *g, ratio);
        c.clamp_fades(*g, nd);
    }
    drop_transitions(&mut c, carried, if end_edge { s0 + nd } else { e0 - nd });
    let speed = c.clip(clip.id)?.speed;
    Ok(json!({ "applied": applied as Ticks, "clamped": clamped, "speed": speed }))
}

/// A copied clip's length, fades, keyframes and markers in this sequence's frames (copied at another rate).
fn fit_to_frames(c: &Ctx, x: &mut Clip) -> R<()> {
    let f = c.f;
    let sn = |t: f64| (crate::query::js_round(t / f as f64) * f as f64) as Ticks;
    let mut d = f.max(sn(x.duration() as f64));
    if let Some(r) = &x.remap {
        let mut curve = R_::refit(r, |t| sn(t as f64), f);
        let len = c.p.source_length(x);
        if len != 0.0 && !len.is_nan() {
            let stay = R_::stay(&curve, 0.0, Direction::Later, -0.25, len + 0.25);
            d = d.min(((stay / f as f64 + 1e-9).floor() * f as f64) as Ticks);
        }
        if d < f {
            return fail("The clip is too short.", Code::TooShort);
        }
        curve.duration = d;
        (x.in_, x.out) = R_::range(&curve);
        x.remap = Some(curve);
        x.speed = 1.0;
        x.reverse = false;
    } else {
        let still = c.still(x);
        if !still {
            let len = c.p.source_length(x);
            if len != 0.0 && !len.is_nan() {
                let span = if x.reverse { x.out } else { len - x.in_ };
                d = d.min(((span / x.speed / f as f64 + 1e-9).floor() * f as f64) as Ticks);
            }
            if d < f {
                return fail("The clip is too short.", Code::TooShort);
            }
        }
        if still || !x.reverse {
            x.out = x.in_ + d as f64 * x.speed;
        } else {
            x.in_ = x.out - d as f64 * x.speed;
        }
    }
    x.fade_in = sn(x.fade_in as f64).min(d);
    x.fade_out = sn(x.fade_out as f64).min(d - x.fade_in);
    for list in x.keyframes.values_mut() {
        let mut by_t: Vec<crate::keyframes::Keyframe> = Vec::new();
        for k in list.iter() {
            let t = d.min(sn(k.t as f64));
            let nk = crate::keyframes::Keyframe { t, ..k.clone() };
            match by_t.iter_mut().find(|y| y.t == t) {
                Some(slot) => *slot = nk,
                None => by_t.push(nk),
            }
        }
        by_t.sort_by_key(|k| k.t);
        *list = by_t;
    }
    for m in x.markers.iter_mut().flatten() {
        m.t = sn(m.t as f64);
        m.duration = sn(m.duration as f64);
    }
    Ok(())
}

/// A copied field as the model's type; a copy that does not fit it would leave the project damaged.
fn copied<T: serde::de::DeserializeOwned>(v: &Json) -> R<T> {
    serde_json::from_value(v.clone())
        .or_else(|_| fail("The edit would leave the project damaged.", Code::InvalidResult))
}

fn kind_name(k: TrackKind) -> &'static str {
    if k == TrackKind::Video { "video" } else { "audio" }
}

/// Pastes copied clips at `at`, keeping their spacing in time and between tracks: the lowest copied video track
/// lands on `opts.video` (else on its own track), the lowest audio one on `opts.audio`.
pub fn paste(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let src = list(cmd.get("clips"), "clips")?.clone();
    if src.is_empty() {
        return Ok(json!({ "ids": [] }));
    }
    let at = c.at(Some(given(o, "at").unwrap_or(&json!(0))), "time")?;
    let mut min_start = f64::INFINITY;
    for x in &src {
        min_start = min_start.min(num(x.get("start"), "start")?);
    }
    let of_kind = |k: TrackKind| -> Vec<Id> { c.seq().tracks.iter().filter(|t| t.kind == k).map(|t| t.id).collect() };
    let (videos, audios) = (of_kind(TrackKind::Video), of_kind(TrackKind::Audio));
    let list_of = |k: TrackKind| if k == TrackKind::Video { &videos } else { &audios };
    let kind_of_copy = |x: &Json| -> R<TrackKind> {
        let k = match given(x, "kind") {
            Some(k) => k.as_str().map(str::to_owned),
            None => Some(match id_of(x.get("track")).and_then(|t| c.seq().track(t)) {
                Some(t) => kind_name(t.kind).to_owned(),
                None if x.get("props").and_then(|p| p.get("opacity")).is_some() => "video".to_owned(),
                None => "audio".to_owned(),
            }),
        };
        match k.as_deref() {
            Some("video") => Ok(TrackKind::Video),
            Some("audio") => Ok(TrackKind::Audio),
            _ => invalid(format!("unknown clip kind {}", x.get("kind").map_or("undefined".into(), string))),
        }
    };
    let index_of_copy = |x: &Json, k: TrackKind| -> f64 {
        match x.get("trackIndex").and_then(Json::as_f64).filter(|i| i.fract() == 0.0) {
            Some(i) => i,
            None => list_of(k).iter().position(|t| Some(*t) == id_of(x.get("track"))).map_or(0.0, |i| i as f64),
        }
    };
    let mut base: Vec<(TrackKind, f64)> = Vec::new();
    for x in &src {
        let k = kind_of_copy(x)?;
        let i = index_of_copy(x, k);
        match base.iter_mut().find(|(b, _)| *b == k) {
            Some((_, v)) => *v = v.min(i),
            None => base.push((k, i)),
        }
    }
    let mut target = Vec::new();
    for (k, b) in &base {
        match given(o, kind_name(*k)) {
            None => target.push((*k, *b)),
            Some(t) => {
                let tr = c.track_json(Some(t))?;
                if tr.kind != *k {
                    return fail_at("There is no track there.", Code::NoTrack, string(t));
                }
                let id = tr.id;
                target.push((*k, list_of(*k).iter().position(|x| *x == id).expect("its kind") as f64));
            }
        }
    }
    let get = |v: &[(TrackKind, f64)], k| v.iter().find(|(b, _)| *b == k).map_or(0.0, |(_, x)| *x);
    let mut links: Vec<(Id, Option<Id>)> = Vec::new();
    let mut groups: Vec<(Id, Option<Id>)> = Vec::new();
    let mut made: Vec<Clip> = Vec::new();
    for x in &src {
        let k = kind_of_copy(x)?;
        let i = get(&target, k) + index_of_copy(x, k) - get(&base, k);
        let track = if i >= 0.0 && i.fract() == 0.0 { list_of(k).get(i as usize).copied() } else { None };
        let Some(track) = track else { return fail("There is no track there.", Code::NoTrack) };
        if c.track(track)?.locked {
            return fail_at("The track is locked.", Code::Locked, track.as_str());
        }
        let mut source = norm_source(&c, x.get("source"))?;
        if truthy(x.get("source").and_then(|s| s.get("freeze")))
            && let Source::Media { freeze, .. } = &mut source
        {
            *freeze = true;
        }
        let start = at + c.at(Some(&json!(num(x.get("start"), "start")? - min_start)), "time")?;
        let (cin, cout) = (num(x.get("in"), "in")?, num(x.get("out"), "out")?);
        let mut clip = crate::defaults::clip(k, Id::new(""), track, start, cin, cout, source, String::new());
        if let Some(v) = defined(x, "speed") {
            clip.speed = copied(v)?;
        }
        if let Some(v) = defined(x, "reverse") {
            clip.reverse = copied(v)?;
        }
        if let Some(v) = defined(x, "enabled") {
            clip.enabled = copied(v)?;
        }
        if let Some(v) = defined(x, "name") {
            clip.name = copied(v)?;
        }
        if let Some(v) = defined(x, "label") {
            clip.label = copied(v)?;
        }
        if let Some(v) = defined(x, "props") {
            clip.props = copied(v)?;
        }
        if let Some(v) = defined(x, "keyframes") {
            clip.keyframes = copied(v)?;
        }
        if let Some(v) = defined(x, "effects") {
            clip.effects = copied(v)?;
        }
        if let Some(v) = defined(x, "fadeIn") {
            clip.fade_in = copied(v)?;
        }
        if let Some(v) = defined(x, "fadeOut") {
            clip.fade_out = copied(v)?;
        }
        if let Some(v) = defined(x, "role") {
            clip.role = serde_json::from_value(v.clone()).ok().flatten();
        }
        if let Some(s) = x.get("sampling").and_then(|s| serde_json::from_value(s.clone()).ok()) {
            clip.sampling = s;
        }
        if let Some(r) = x.get("remap").filter(|r| truthy(Some(r)))
            && k == TrackKind::Video
            && !c.still(&clip)
        {
            clip.remap = Some(copied(r)?);
        }
        if let Some(m) = x.get("markers").filter(|m| truthy(Some(m))) {
            clip.markers = Some(copied(m)?);
        }
        if let Some(m) = x.get("masks").and_then(Json::as_array).filter(|m| !m.is_empty())
            && k == TrackKind::Video
        {
            clip.masks = Some(copied(&Json::Array(m.clone()))?);
        }
        fit_to_frames(&c, &mut clip)?;
        if let Some(l) = x.get("link").filter(|l| truthy(Some(l))) {
            let l = Id::new(&string(l));
            if !links.iter().any(|(o, _)| *o == l) {
                links.push((l, None));
            }
            clip.link = Some(l);
        }
        if let Some(g) = x.get("group").and_then(Json::as_str).filter(|g| !g.is_empty()) {
            let g = Id::new(g);
            if !groups.iter().any(|(o, _)| *o == g) {
                groups.push((g, None));
            }
            clip.group = Some(g);
        }
        made.push(clip);
    }
    let mut tracks: Vec<Id> = Vec::new();
    for x in &made {
        if !tracks.contains(&x.track) {
            tracks.push(x.track);
        }
    }
    for t in &tracks {
        let mut spans: Vec<(Ticks, Ticks)> =
            made.iter().filter(|x| x.track == *t).map(|x| (x.start, x.end())).collect();
        spans.sort_by_key(|s| s.0);
        if spans.windows(2).any(|w| w[0].1 > w[1].0) {
            return fail("Clips would overlap.", Code::Overlap);
        }
    }
    let span = made.iter().map(Clip::end).max().unwrap_or(at) - at;
    if o.get("mode").and_then(Json::as_str) == Some("insert") {
        c.ripple_insert(&tracks, at, span)?;
    } else {
        for x in &made {
            c.clear_range(x.track, x.start, x.end());
        }
    }
    for l in &mut links {
        l.1 = Some(c.nid("L"));
    }
    for g in &mut groups {
        g.1 = Some(c.nid("G"));
    }
    let mut ids = Vec::new();
    for mut x in made {
        x.id = c.nid("c");
        x.link = x.link.and_then(|l| links.iter().find(|(o, _)| *o == l).and_then(|(_, n)| *n));
        x.group = x.group.and_then(|g| groups.iter().find(|(o, _)| *o == g).and_then(|(_, n)| *n));
        for m in x.markers.iter_mut().flatten() {
            m.id = c.nid("mk");
        }
        ids.push(x.id);
        c.add(x, None);
    }
    Ok(json!({ "ids": ids }))
}
