//! Placing, moving, trimming and cutting clips (port of commands.js's timeline commands).

use cut_time::Ticks;
use serde_json::{Value as Json, json};

use super::{
    Code, Ctx, R, context, defined, fail, fail_at, given, id_list, id_of, invalid, list, media_of, num, opts, string,
};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::project::{Generator, MediaKind, Project, Source, TrackKind};

/// The lowest and highest delta every limit allows, and why a wanted delta stops.
pub(crate) struct Limits {
    lo: f64,
    hi: f64,
    lo_why: Option<&'static str>,
    hi_why: Option<&'static str>,
}

impl Limits {
    pub fn new() -> Self {
        Limits { lo: f64::NEG_INFINITY, hi: f64::INFINITY, lo_why: None, hi_why: None }
    }

    pub fn limit(&mut self, low: f64, high: f64, why: &'static str) {
        if low > self.lo {
            self.lo = low;
            self.lo_why = Some(why);
        }
        if high < self.hi {
            self.hi = high;
            self.hi_why = Some(why);
        }
    }

    /// -> (applied, clamped)
    pub fn apply(&self, d: f64) -> (f64, Option<&'static str>) {
        let applied = d.max(self.lo).min(self.hi);
        let clamped = if applied == d {
            None
        } else if d > self.hi {
            self.hi_why
        } else {
            self.lo_why
        };
        (applied, clamped)
    }
}

pub(crate) fn outcome(applied: f64, clamped: Option<&str>) -> Json {
    json!({ "applied": applied as Ticks, "clamped": clamped })
}

fn truthy(v: Option<&Json>) -> bool {
    v.is_some_and(|v| !matches!(v, Json::Null | Json::Bool(false)) && v != &json!(0) && v != &json!(""))
}

// ---- sources and placing ----

/// The source a command names, checked and with only its own fields (text layers filled).
pub(crate) fn norm_source(c: &Ctx, source: Option<&Json>) -> R<Source> {
    let Some(s) = source.filter(|s| s.is_object() || s.is_array()) else { return invalid("the source is missing") };
    if given(s, "media").is_some() {
        let m = media_of(c.p, s.get("media"))?;
        return Ok(Source::Media { media: m.id, freeze: false, extra: Default::default() });
    }
    if let Some(seq) = given(s, "sequence") {
        let Some(inner) = id_of(Some(seq)).filter(|id| c.p.sequence(*id).is_some()) else {
            return fail(format!("there is no sequence {}", string(seq)), Code::NotFound);
        };
        if c.p.nest_loop(c.seq, inner) {
            return fail("A sequence cannot be nested inside itself.", Code::NestLoop);
        }
        return Ok(Source::Nest { sequence: inner, extra: Default::default() });
    }
    match s.get("generator").and_then(Json::as_str) {
        Some("text") => Ok(Source::Generator {
            generator: Generator::Text,
            layers: Some(text_layers(s.get("layers"))),
            color: None,
            extra: Default::default(),
        }),
        Some("solid") => Ok(Source::Generator {
            generator: Generator::Solid,
            layers: None,
            color: Some(s.get("color").and_then(Json::as_str).unwrap_or("#ffffff").to_owned()),
            extra: Default::default(),
        }),
        Some("adjustment") => Ok(Source::Generator {
            generator: Generator::Adjustment,
            layers: None,
            color: None,
            extra: Default::default(),
        }),
        Some("graphic") => Ok(Source::Generator {
            generator: Generator::Graphic,
            layers: Some(graphic_layers(s.get("layers"))?),
            color: None,
            extra: Default::default(),
        }),
        _ => invalid(format!("unknown source {s}")),
    }
}

/// A text clip's layers: each a full text layer, ids unique (`l<n>` for one without).
pub(crate) fn text_layers(given_layers: Option<&Json>) -> Vec<Json> {
    let empty = vec![json!({})];
    let layers = given_layers.and_then(Json::as_array).filter(|a| !a.is_empty()).unwrap_or(&empty);
    let mut used: Vec<String> = Vec::new();
    layers
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let own = l.get("id").and_then(Json::as_str).filter(|id| !id.is_empty() && !used.iter().any(|u| u == id));
            let mut id = own.map_or_else(|| format!("l{}", i + 1), str::to_owned);
            while used.contains(&id) {
                id.push('_');
            }
            used.push(id.clone());
            let mut o = l.as_object().cloned().unwrap_or_default();
            o.insert("id".into(), json!(id));
            crate::defaults::text_layer(&o)
        })
        .collect()
}

/// A graphic's layers: one at least, each with an id (`g<n>` for one without), checked, then normalized.
pub(crate) fn graphic_layers(given_layers: Option<&Json>) -> R<Vec<Json>> {
    let given_layers = given_layers.and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
    if given_layers.is_empty() {
        return invalid("a graphic needs one layer at least");
    }
    let mut used: Vec<String> =
        given_layers.iter().filter_map(|l| l.get("id").and_then(Json::as_str)).map(str::to_owned).collect();
    let mut n = 0;
    let layers: Vec<Json> = given_layers
        .iter()
        .map(|l| {
            if l.is_object() && l.get("id").is_some_and(Json::is_string) {
                return l.clone();
            }
            let id = loop {
                n += 1;
                let id = format!("g{n}");
                if !used.contains(&id) {
                    break id;
                }
            };
            used.push(id.clone());
            let mut o = super::js_spread(l);
            o.insert("id".into(), json!(id));
            Json::Object(o)
        })
        .collect();
    let errors = crate::graphic::validate(Some(&Json::Array(layers.clone())));
    if !errors.is_empty() {
        return fail(format!("the graphic is not valid: {}", errors.join("; ")), Code::BadGraphic);
    }
    Ok(layers.iter().map(crate::graphic::normalize).collect())
}

/// Video and/or audio clips of one source at `at` (or ending at `endAt`), linked when both are placed.
pub(crate) fn place_clips(c: &mut Ctx, o: &Json) -> R<Json> {
    let src = norm_source(c, o.get("source"))?;
    let media = match &src {
        Source::Media { media, .. } => c.p.media(*media).cloned(),
        _ => None,
    };
    let nest = match &src {
        Source::Nest { sequence, .. } => Some(*sequence),
        _ => None,
    };
    let kinds = nest.map(|n| c.p.nest_kinds(n));
    if kinds.is_some_and(|k| !k.video && !k.audio) {
        return fail("The sequence is empty.", Code::EmptySequence);
    }
    let has_v = match kinds {
        Some(k) => k.video,
        None => media.as_ref().is_none_or(|m| m.kind == MediaKind::Image || m.video.is_some()),
    };
    let has_a = match kinds {
        Some(k) => k.audio,
        None => media.as_ref().is_some_and(|m| m.audio.is_some()),
    };
    let v = if has_v { given(o, "video") } else { None };
    let a = if has_a { given(o, "audio") } else { None };
    if v.is_none() && a.is_none() {
        return fail("Choose a target track.", Code::NoTarget);
    }
    let mut v_id = None;
    let mut a_id = None;
    if let Some(v) = v {
        let t = c.track_json(Some(v))?;
        let (id, kind) = (t.id, t.kind);
        c.unlocked(id)?;
        if kind != TrackKind::Video {
            return fail_at("There is no track there.", Code::NoTrack, id.as_str());
        }
        v_id = Some(id);
    }
    if let Some(a) = a {
        let t = c.track_json(Some(a))?;
        let (id, kind) = (t.id, t.kind);
        c.unlocked(id)?;
        if kind != TrackKind::Audio {
            return fail_at("There is no track there.", Code::NoTrack, id.as_str());
        }
        a_id = Some(id);
    }
    let still_src = nest.is_none() && media.as_ref().is_none_or(|m| m.kind == MediaKind::Image);
    let length = match nest {
        Some(n) => c.p.sequence(n).map_or(0, |s| s.duration()) as f64,
        None => media.as_ref().map_or(f64::NAN, |m| m.duration),
    };
    let (sin, d) = if still_src {
        let want = match (given(o, "out"), given(o, "in")) {
            (Some(out), Some(i)) => num(Some(out), "out")? - num(Some(i), "in")?,
            (Some(out), None) => num(Some(out), "out")?,
            _ => num(c.p.settings.get("stillDuration"), "length")?,
        };
        (0, c.f.max(c.frames_of(want)))
    } else {
        let sin = match given(o, "in") {
            None => 0,
            Some(i) => c.at(Some(i), "in")?,
        };
        let sout = match given(o, "out") {
            None => length,
            Some(x) => num(Some(x), "out")?,
        }
        .min(length);
        let d = c.floor_frames(sout - sin as f64);
        if d.is_nan() || d < c.f as f64 {
            return fail("The clip is too short.", Code::TooShort);
        }
        (sin, d as Ticks)
    };
    let p = match given(o, "endAt") {
        Some(e) => c.at(Some(e), "endAt")? - d,
        None => c.at(Some(given(o, "at").unwrap_or(&json!(0))), "at")?,
    };
    if p < 0 {
        return fail("The clip does not fit before the Out point.", Code::NoRoom);
    }
    let targets: Vec<Id> = [v_id, a_id].into_iter().flatten().collect();
    match o.get("mode").filter(|m| truthy(Some(m))) {
        Some(m) if m.as_str() == Some("insert") => c.ripple_insert(&targets, p, d)?,
        Some(m) if m.as_str() != Some("overwrite") => return invalid(format!("unknown mode {}", string(m))),
        _ => {
            for t in &targets {
                c.clear_range(*t, p, p + d);
            }
        }
    }
    let link = if v_id.is_some() && a_id.is_some() { Some(c.nid("L")) } else { None };
    let name = match o.get("name").and_then(Json::as_str) {
        Some(n) => n.to_owned(),
        None => match (&media, nest, &src) {
            (Some(m), _, _) => m.name.clone(),
            (None, Some(_), _) => String::new(),
            (None, None, Source::Generator { generator, .. }) => match generator {
                Generator::Text => "Text",
                Generator::Solid => "Color",
                Generator::Adjustment => "Adjustment",
                Generator::Graphic => "",
            }
            .to_owned(),
            _ => String::new(),
        },
    };
    let mut made = Vec::new();
    for (id, kind) in [(v_id, TrackKind::Video), (a_id, TrackKind::Audio)] {
        let Some(track) = id else { continue };
        let cid = c.nid("c");
        let mut clip =
            crate::defaults::clip(kind, cid, track, p, sin as f64, (sin + d) as f64, src.clone(), name.clone());
        clip.link = link;
        c.add(clip, None);
        made.push(cid);
    }
    Ok(json!({ "ids": made, "at": p, "duration": d }))
}

pub fn place(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    place_clips(&mut c, opts(cmd, "opts"))
}

pub fn place_range(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let mut o = opts(cmd, "opts").as_object().cloned().unwrap_or_default();
    let ov = Json::Object(o.clone());
    let r = opts(&ov, "range");
    let (r_in, r_out) = (given(r, "in").cloned(), given(r, "out").cloned());
    if given(&ov, "in").is_some() && given(&ov, "out").is_some() {
        if let Some(i) = r_in {
            o.insert("at".into(), i);
        } else if let Some(x) = r_out {
            o.insert("endAt".into(), x);
        } else {
            return fail("Set an In or Out point in the sequence.", Code::NoRange);
        }
    } else if let (Some(ri), Some(ro)) = (&r_in, &r_out) {
        let len = num(Some(ro), "range out")? - num(Some(ri), "range in")?;
        if len <= 0.0 {
            return fail("Set an In and an Out point.", Code::NoRange);
        }
        if let Some(out) = given(&ov, "out") {
            let out = out.as_f64().unwrap_or(f64::NAN);
            o.insert("in".into(), json!((out - len).max(0.0)));
        } else {
            let i = given(&ov, "in").and_then(Json::as_f64).unwrap_or(0.0);
            o.insert("in".into(), json!(i));
            o.insert("out".into(), json!(i + len));
        }
        o.insert("at".into(), ri.clone());
    } else {
        return fail("Set an In and an Out point.", Code::NoRange);
    }
    place_clips(&mut c, &Json::Object(o))
}

// ---- moving ----

pub fn move_clips(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let clips = c.with_linked(cmd.get("clipIds"), o.get("linked") != Some(&json!(false)), true)?;
    if clips.is_empty() {
        return Ok(json!({ "ids": [], "delta": 0 }));
    }
    for id in &clips {
        let t = c.clip(*id)?.track;
        c.unlocked(t)?;
    }
    let mut d = c.frames(Some(given(o, "delta").unwrap_or(&json!(0))), "delta")?;
    let min_start = clips.iter().map(|id| c.clip(*id).map_or(0, |x| x.start)).min().unwrap_or(0);
    if min_start + d < 0 {
        d = -min_start;
    }
    let td = given(o, "trackDelta").cloned().unwrap_or(json!(0));
    let td_of = |kind: TrackKind| -> Option<Json> {
        let key = if kind == TrackKind::Video { "video" } else { "audio" };
        if td.is_object() { Some(given(&td, key).cloned().unwrap_or(json!(0))) } else { Some(td.clone()) }
    };
    let mut dest = Vec::new();
    for id in &clips {
        let tr = c.track(c.clip(*id)?.track)?;
        let kind = tr.kind;
        let same: Vec<Id> = c.seq().tracks.iter().filter(|t| t.kind == kind).map(|t| t.id).collect();
        let at = same.iter().position(|t| *t == tr.id).expect("its own kind") as f64;
        let i = at + num(td_of(kind).as_ref(), "trackDelta")?;
        if i.fract() != 0.0 || i < 0.0 || i >= same.len() as f64 {
            return fail("There is no track there.", Code::NoTrack);
        }
        let to = same[i as usize];
        if c.track(to)?.locked {
            return fail_at("The track is locked.", Code::Locked, to.as_str());
        }
        dest.push(to);
    }
    let ids_json: Vec<Id> = clips.clone();
    if d == 0 && clips.iter().zip(&dest).all(|(id, t)| c.clip(*id).is_ok_and(|x| x.track == *t)) {
        return Ok(json!({ "ids": ids_json, "delta": 0 }));
    }
    let mut by_track: Vec<(Id, Vec<(Ticks, Ticks)>)> = Vec::new();
    for (id, t) in clips.iter().zip(&dest) {
        let x = c.clip(*id)?;
        let span = (x.start, x.end());
        match by_track.iter_mut().find(|(k, _)| k == t) {
            Some((_, l)) => l.push(span),
            None => by_track.push((*t, vec![span])),
        }
    }
    for (_, l) in &mut by_track {
        l.sort_by_key(|s| s.0);
        if l.windows(2).any(|w| w[0].1 > w[1].0) {
            return fail("Clips would overlap.", Code::Overlap);
        }
    }
    let mut carried = Vec::new();
    for t in &c.seq().transitions {
        let there: Vec<&crate::project::Clip> = c
            .seq()
            .track(t.track)
            .map(|tr| tr.clips.iter().filter(|x| x.start == t.at || x.end() == t.at).map(|x| &**x).collect())
            .unwrap_or_default();
        if !there.is_empty() && there.iter().all(|x| clips.contains(&x.id)) {
            let mut to: Vec<Id> =
                there.iter().map(|x| dest[clips.iter().position(|y| *y == x.id).expect("moved")]).collect();
            to.dedup();
            to.sort();
            to.dedup();
            if to.len() == 1 {
                carried.push((t.id, to[0]));
            }
        }
    }
    let carried_t: Vec<crate::project::Transition> = {
        let ts = c.transitions_mut();
        let mut out = Vec::new();
        for (id, _) in &carried {
            if let Some(i) = ts.iter().position(|t| t.id == *id) {
                out.push(ts.remove(i));
            }
        }
        out
    };
    let mut taken = Vec::new();
    for id in &clips {
        let x = c.clip(*id)?.clone();
        c.remove(*id);
        taken.push(x);
    }
    if truthy(o.get("insert")) {
        let span = taken.iter().map(|x| x.end()).max().unwrap_or(0) - min_start;
        let keys: Vec<Id> = by_track.iter().map(|(k, _)| *k).collect();
        c.ripple_insert(&keys, min_start + d, span)?;
    } else {
        for (x, t) in taken.iter().zip(&dest) {
            c.clear_range(*t, x.start + d, x.end() + d);
        }
    }
    for (mut x, t) in taken.into_iter().zip(dest) {
        x.start += d;
        x.track = t;
        c.add(x, None);
    }
    let ts = c.transitions_mut();
    for (mut t, (_, track)) in carried_t.into_iter().zip(carried) {
        t.at += d;
        t.track = track;
        ts.push(t);
    }
    Ok(json!({ "ids": ids_json, "delta": d }))
}

// ---- trimming ----

pub fn trim(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let id = c.clip_json(cmd.get("clipId"))?.id;
    trim_in(&mut c, id, opts(cmd, "opts"))
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    Ripple,
    Roll,
}

pub(crate) fn trim_in(c: &mut Ctx, id: Id, o: &Json) -> R<Json> {
    let end_edge = match o.get("edge").and_then(Json::as_str) {
        Some("end") => true,
        Some("start") => false,
        _ => return invalid(format!("unknown edge {}", o.get("edge").map_or("undefined".into(), string))),
    };
    let mode = match o.get("mode").filter(|m| truthy(Some(m))).map(|m| m.as_str()) {
        None | Some(Some("normal")) => Mode::Normal,
        Some(Some("ripple")) => Mode::Ripple,
        Some(Some("roll")) => Mode::Roll,
        Some(_) => return invalid(format!("unknown trim mode {}", string(&o["mode"]))),
    };
    let d = c.frames(Some(given(o, "delta").unwrap_or(&json!(0))), "delta")?;
    let clip = c.clip(id)?.clone();
    let pos = if end_edge { clip.end() } else { clip.start };
    let edge_of = |x: &crate::project::Clip| if end_edge { x.end() } else { x.start };
    let mut group = vec![id];
    if o.get("linked") != Some(&json!(false)) {
        group.extend(c.seq().linked_clips(&clip).into_iter().filter(|x| edge_of(x) == pos).map(|x| x.id));
    }
    for g in &group {
        let t = c.clip(*g)?.track;
        c.unlocked(t)?;
    }
    let partner = |c: &Ctx, g: Id| -> Option<Id> {
        let gc = c.clip(g).ok()?;
        c.seq()
            .clips_in_order()
            .find(|x| x.id != g && x.track == gc.track && (if end_edge { x.start == pos } else { x.end() == pos }))
            .map(|x| x.id)
    };
    let f = c.f as f64;
    let mut lim = Limits::new();
    let inf = f64::INFINITY;
    for g in &group {
        let gc = c.clip(*g)?.clone();
        let (head, tail) = c.room(&gc);
        let (prev_end, next_start) = c.neighbours(&gc);
        let gd = gc.duration() as f64;
        let posf = pos as f64;
        if mode == Mode::Roll {
            let pt = partner(c, *g).map(|x| c.clip(x).expect("found").clone());
            if end_edge {
                lim.limit(-(gd - f), inf, "length");
                lim.limit(-inf, tail, "source");
                match &pt {
                    Some(pc) => {
                        lim.limit(-c.room(pc).0, inf, "source");
                        lim.limit(-inf, pc.duration() as f64 - f, "neighbour");
                    }
                    None => lim.limit(-inf, next_start - posf, "neighbour"),
                }
            } else {
                lim.limit(-inf, gd - f, "length");
                lim.limit(-head, inf, "source");
                match &pt {
                    Some(pc) => {
                        lim.limit(-inf, c.room(pc).1, "source");
                        lim.limit(-(pc.duration() as f64 - f), inf, "neighbour");
                    }
                    None => lim.limit(prev_end - posf, inf, "neighbour"),
                }
            }
        } else if end_edge {
            lim.limit(-(gd - f), inf, "length");
            lim.limit(-inf, tail, "source");
            if mode == Mode::Normal {
                lim.limit(-inf, next_start - posf, "neighbour");
            }
        } else {
            lim.limit(-inf, gd - f, "length");
            lim.limit(-head, inf, "source");
            if mode == Mode::Normal {
                lim.limit(prev_end - posf, inf, "neighbour");
            }
        }
    }
    let (applied, clamped) = lim.apply(d as f64);
    if applied == 0.0 {
        return Ok(outcome(0.0, clamped));
    }
    let a = applied as Ticks;
    let tracks: Vec<Id> = group.iter().map(|g| c.clip(*g).expect("in the group").track).collect();
    let carried = lift_transitions(c, &tracks, pos);
    match mode {
        Mode::Normal => {
            for g in &group {
                if end_edge {
                    c.set_end(*g, pos + a);
                } else {
                    c.set_start(*g, pos + a);
                }
            }
        }
        Mode::Ripple => {
            if end_edge {
                if a > 0 {
                    c.ripple_insert(&tracks, pos, a)?;
                    for g in &group {
                        c.set_end(*g, pos + a);
                    }
                } else {
                    for g in &group {
                        c.set_end(*g, pos + a);
                    }
                    c.ripple_remove(&tracks, pos + a, pos)?;
                }
            } else if a > 0 {
                for g in &group {
                    c.set_start(*g, pos + a);
                }
                c.ripple_remove(&tracks, pos, pos + a)?;
            } else {
                c.ripple_insert(&tracks, pos, -a)?;
                for g in &group {
                    c.set_start(*g, pos);
                }
            }
        }
        Mode::Roll => {
            let partners: Vec<Option<Id>> = group.iter().map(|g| partner(c, *g)).collect();
            for (g, pt) in group.iter().zip(partners) {
                if end_edge {
                    if let Some(pt) = pt {
                        c.set_start(pt, pos + a);
                    }
                    c.set_end(*g, pos + a);
                } else {
                    if let Some(pt) = pt {
                        c.set_end(pt, pos + a);
                    }
                    c.set_start(*g, pos + a);
                }
            }
        }
    }
    let new_pos = if mode == Mode::Ripple && !end_edge { pos } else { pos + a };
    drop_transitions(c, carried, new_pos);
    Ok(outcome(applied, clamped))
}

/// Transitions on these tracks at `p`, taken off the list to be put back where the edit point goes.
pub(crate) fn lift_transitions(c: &mut Ctx, tracks: &[Id], p: Ticks) -> Vec<crate::project::Transition> {
    if !c.seq().transitions.iter().any(|t| t.at == p && tracks.contains(&t.track)) {
        return Vec::new();
    }
    let ts = c.transitions_mut();
    let (out, keep): (Vec<_>, Vec<_>) =
        std::mem::take(ts).into_iter().partition(|t| t.at == p && tracks.contains(&t.track));
    *ts = keep;
    out
}

pub(crate) fn drop_transitions(c: &mut Ctx, carried: Vec<crate::project::Transition>, p: Ticks) {
    if carried.is_empty() {
        return;
    }
    let ts = c.transitions_mut();
    for mut t in carried {
        t.at = p;
        ts.push(t);
    }
}

// ---- edit tools ----

pub fn slip(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    if c.still(&clip) {
        return fail("This clip has no source frames to slip.", Code::Still);
    }
    let mut group = vec![clip.id];
    if o.get("linked") != Some(&json!(false)) {
        group.extend(c.seq().linked_clips(&clip).into_iter().filter(|x| !c.still(x)).map(|x| x.id));
    }
    for g in &group {
        let t = c.clip(*g)?.track;
        c.unlocked(t)?;
    }
    let mut lim = Limits::new();
    let per = |g: &crate::project::Clip| if g.remap.is_some() { 1.0 } else { g.speed };
    for g in &group {
        let gc = c.clip(*g)?;
        let len = c.p.source_length(gc);
        lim.limit(-c.floor_frames(gc.in_ / per(gc)), c.floor_frames((len - gc.out) / per(gc)), "source");
    }
    let d = c.frames(Some(given(o, "delta").unwrap_or(&json!(0))), "delta")?;
    let (applied, clamped) = lim.apply(d as f64);
    for g in &group {
        if applied == 0.0 {
            break;
        }
        c.edit(*g, |x| {
            let sd = applied * per(x);
            if let Some(r) = &mut x.remap {
                r.at += sd;
            }
            x.in_ += sd;
            x.out += sd;
        });
    }
    Ok(outcome(applied, clamped))
}

pub fn slide(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let clip = c.clip_json(cmd.get("clipId"))?.clone();
    let mut group = vec![clip.id];
    if o.get("linked") != Some(&json!(false)) {
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
    let f = c.f as f64;
    let inf = f64::INFINITY;
    let mut lim = Limits::new();
    let mut plan = Vec::new();
    for g in &group {
        let gc = c.clip(*g)?.clone();
        let (s, e) = (gc.start, gc.end());
        let order: Vec<&crate::project::Clip> =
            c.seq().clips_in_order().filter(|x| x.id != gc.id && x.track == gc.track).collect();
        let prev = order.iter().find(|x| x.end() == s).map(|x| (*x).clone());
        let next = order.iter().find(|x| x.start == e).map(|x| (*x).clone());
        let (prev_end, next_start) = c.neighbours(&gc);
        match &prev {
            Some(pc) => {
                lim.limit(-(pc.duration() as f64 - f), inf, "length");
                lim.limit(-inf, c.room(pc).1, "source");
            }
            None => lim.limit(prev_end - s as f64, inf, "neighbour"),
        }
        match &next {
            Some(nc) => {
                lim.limit(-inf, nc.duration() as f64 - f, "length");
                lim.limit(-c.room(nc).0, inf, "source");
            }
            None => lim.limit(-inf, next_start - e as f64, "neighbour"),
        }
        plan.push((*g, s, e, prev.map(|x| x.id), next.map(|x| x.id)));
    }
    let d = c.frames(Some(given(o, "delta").unwrap_or(&json!(0))), "delta")?;
    let (applied, clamped) = lim.apply(d as f64);
    if applied == 0.0 {
        return Ok(outcome(applied, clamped));
    }
    let a = applied as Ticks;
    let tracks: Vec<Id> = group.iter().map(|g| c.clip(*g).expect("in the group").track).collect();
    let at_start = lift_transitions(&mut c, &tracks, clip.start);
    let at_end = lift_transitions(&mut c, &tracks, clip.end());
    for (g, s, e, prev, next) in &plan {
        if let Some(pv) = prev {
            c.set_end(*pv, s + a);
        }
        if let Some(nx) = next {
            c.set_start(*nx, e + a);
        }
        c.edit(*g, |x| x.start = s + a);
    }
    drop_transitions(&mut c, at_start, plan[0].1 + a);
    drop_transitions(&mut c, at_end, plan[0].2 + a);
    Ok(outcome(applied, clamped))
}

pub fn extend_edit(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let t = c.at(cmd.get("t"), "time")?;
    let linked = o.get("linked") != Some(&json!(false));
    let clips: Vec<Id> = match o.get("clipIds").and_then(Json::as_array).filter(|a| !a.is_empty()) {
        Some(_) => {
            let mut out = Vec::new();
            for id in id_list(o.get("clipIds"), "clipIds")? {
                let x = match id {
                    Some(id) => c.clip(id)?,
                    None => return fail("there is no clip undefined", Code::NotFound),
                };
                if !c.track(x.track)?.locked {
                    out.push(x.id);
                }
            }
            out
        }
        None => {
            let tracks: Vec<Id> = match given(o, "trackIds") {
                Some(ids) => {
                    let mut v = Vec::new();
                    for id in list(Some(ids), "trackIds")? {
                        let tr = c.track_json(Some(id))?;
                        if !tr.locked {
                            v.push(tr.id);
                        }
                    }
                    v
                }
                None => c.seq().tracks.iter().filter(|x| !x.locked).map(|x| x.id).collect(),
            };
            c.seq().clips_in_order().filter(|x| tracks.contains(&x.track)).map(|x| x.id).collect()
        }
    };
    let mut edges = Vec::new();
    for id in &clips {
        let x = c.clip(*id)?;
        edges.push((*id, true, x.end(), x.track));
        edges.push((*id, false, x.start, x.track));
    }
    let mut pt: Option<Ticks> = None;
    for e in &edges {
        if e.2 != t && pt.is_none_or(|p| (e.2 - t).abs() < (p - t).abs()) {
            pt = Some(e.2);
        }
    }
    let Some(pt) = pt else { return fail("There is no edit point here.", Code::NoEdit) };
    let mut at_p: Vec<&(Id, bool, Ticks, Id)> = edges.iter().filter(|e| e.2 == pt).collect();
    at_p.sort_by_key(|e| if e.1 { 0 } else { 1 });
    let mut by_track: Vec<(Id, Id, bool)> = Vec::new();
    for e in at_p {
        if !by_track.iter().any(|(tr, _, _)| *tr == e.3) {
            by_track.push((e.3, e.0, e.1));
        }
    }
    let mut first = None;
    let mut clamped: Option<Json> = None;
    for (_, id, end_edge) in by_track {
        let x = c.clip(id)?.clone();
        if (if end_edge { x.end() } else { x.start }) != pt {
            continue;
        }
        let partner = c
            .seq()
            .clips()
            .any(|y| y.id != id && y.track == x.track && (if end_edge { y.start == pt } else { y.end() == pt }));
        let topts = json!({ "edge": if end_edge { "end" } else { "start" }, "delta": t - pt, "mode": if partner { "roll" } else { "normal" }, "linked": linked });
        let r = trim_in(&mut c, id, &topts)?;
        if first.is_none() {
            first = Some(r["applied"].clone());
        }
        if clamped.as_ref().is_none_or(Json::is_null) {
            clamped = Some(r["clamped"].clone());
        }
    }
    Ok(json!({ "at": pt, "applied": first.unwrap_or(json!(0)), "clamped": clamped.unwrap_or(Json::Null) }))
}

// ---- cutting ----

pub fn split(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let t = c.at(cmd.get("t"), "time")?;
    let linked = o.get("linked") != Some(&json!(false));
    let inside = |x: &crate::project::Clip| x.start < t && t < x.end();
    let clips: Vec<Id> = if let Some(ids) = o.get("clipIds").filter(|v| truthy(Some(v))) {
        let clips = c.with_linked(Some(ids), linked, false)?;
        let named = id_list(Some(ids), "clipIds")?;
        for id in &clips {
            let x = c.clip(*id)?;
            if inside(x) && named.contains(&Some(*id)) {
                c.unlocked(x.track)?;
            }
        }
        clips
    } else {
        let tracks: Vec<Id> = match given(o, "trackIds").filter(|_| !truthy(o.get("allTracks"))) {
            Some(ids) => {
                let mut v = Vec::new();
                for id in list(Some(ids), "trackIds")? {
                    let tr = c.track_json(Some(id))?;
                    if !tr.locked {
                        v.push(tr.id);
                    }
                }
                v
            }
            None => c.seq().tracks.iter().filter(|x| !x.locked).map(|x| x.id).collect(),
        };
        let seq = c.seq();
        let mut under: Vec<Id> =
            tracks.iter().filter_map(|tr| seq.track(*tr)?.clip_at(t)).filter(|x| inside(x)).map(|x| x.id).collect();
        under.sort_by_key(|x| seq.order_of(*x));
        under.dedup();
        if linked {
            c.with_linked(Some(&json!(under.iter().map(|i| i.as_str()).collect::<Vec<_>>())), true, false)?
        } else {
            under
        }
    };
    let clips: Vec<Id> = clips
        .into_iter()
        .filter(|id| c.clip(*id).is_ok_and(|x| inside(x) && !c.track(x.track).is_ok_and(|tr| tr.locked)))
        .collect();
    let mut made = Vec::new();
    for id in clips {
        made.push(c.split_clip(id, t));
    }
    Ok(json!({ "ids": made }))
}

pub fn remove(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let clips = c.with_linked(cmd.get("clipIds"), o.get("linked") != Some(&json!(false)), true)?;
    let mut ranges = Vec::new();
    let mut tracks: Vec<Id> = Vec::new();
    for id in &clips {
        let x = c.clip(*id)?;
        c.unlocked(x.track)?;
        ranges.push((x.start, x.end()));
        if !tracks.contains(&x.track) {
            tracks.push(x.track);
        }
    }
    let ranges = super::edit::merge_ranges(&ranges);
    for id in &clips {
        c.remove(*id);
    }
    if truthy(o.get("ripple")) {
        for (a, b) in ranges.into_iter().rev() {
            c.ripple_remove(&tracks, a, b)?;
        }
    }
    Ok(json!({ "ids": clips }))
}

fn target_tracks(c: &Ctx, ids: Option<&Json>) -> R<Vec<Id>> {
    match ids.filter(|v| !v.is_null()) {
        Some(ids) => {
            let mut v = Vec::new();
            for id in list(Some(ids), "trackIds")? {
                let tr = c.track_json(Some(id))?;
                if !tr.locked {
                    v.push(tr.id);
                }
            }
            Ok(v)
        }
        None => Ok(c.seq().tracks.iter().filter(|x| !x.locked).map(|x| x.id).collect()),
    }
}

pub fn ripple_to_playhead(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    let t = c.at(cmd.get("t"), "time")?;
    let before = match cmd.get("side").and_then(Json::as_str) {
        Some("before") => true,
        Some("after") => false,
        _ => return invalid(format!("unknown side {}", cmd.get("side").map_or("undefined".into(), string))),
    };
    let tracks = target_tracks(&c, o.get("trackIds"))?;
    let on: Vec<crate::project::Clip> =
        c.seq().clips_in_order().filter(|x| tracks.contains(&x.track)).cloned().collect();
    let (mut a, mut b) = (f64::NEG_INFINITY, f64::INFINITY);
    if before {
        for x in &on {
            for e in [x.start, x.end()] {
                if e < t && e as f64 > a {
                    a = e as f64;
                }
            }
        }
        b = t as f64;
    } else {
        for x in &on {
            for e in [x.start, x.end()] {
                if e > t && (e as f64) < b {
                    b = e as f64;
                }
            }
        }
        a = t as f64;
    }
    if !a.is_finite() || !b.is_finite() || b <= a {
        return Ok(json!({ "range": null }));
    }
    let (a, b) = (a as Ticks, b as Ticks);
    let mut involved = tracks.clone();
    for x in &on {
        if x.start < b && x.end() > a {
            for l in c.seq().linked_clips(x) {
                if !involved.contains(&l.track) {
                    involved.push(l.track);
                }
            }
        }
    }
    c.ripple_remove(&involved, a, b)?;
    Ok(json!({ "range": [a, b] }))
}

pub fn close_gap(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let track = c.track_json(cmd.get("trackId"))?.id;
    c.unlocked(track)?;
    let t = c.at(cmd.get("t"), "time")?;
    let on = c.seq().track(track).map(|tr| tr.clips.clone()).unwrap_or_default();
    if on.iter().any(|x| x.start <= t && t < x.end()) {
        return fail("There is no gap here.", Code::NoGap);
    }
    let Some(next) = on.iter().find(|x| x.start > t) else { return fail("There is no gap here.", Code::NoGap) };
    let a = on.iter().filter(|x| x.end() <= t).map(|x| x.end()).max().unwrap_or(0).max(0);
    let b = next.start;
    for id in c.ripple_tracks(&[track])? {
        if id != track && c.seq().track(id).is_some_and(|tr| !tr.clips_in(a, b).is_empty()) {
            return fail_at(
                "The gap cannot be closed: a sync-locked track has clips in it.",
                Code::GapBlocked,
                id.as_str(),
            );
        }
    }
    for ct in &c.seq().captions {
        if ct.sync_lock && ct.items.iter().any(|it| it.start < b && it.end > a) {
            return fail_at(
                "The gap cannot be closed: a sync-locked track has clips in it.",
                Code::GapBlocked,
                ct.id.as_str(),
            );
        }
    }
    c.ripple_remove(&[track], a, b)?;
    Ok(json!({ "range": [a, b] }))
}

/// Lift (and with `extract` also close up) the range `[in, out)` on the given tracks.
pub fn lift(p: &mut Project, tx: &mut Tx, cmd: &Json, extract: bool) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let a = c.at(cmd.get("in"), "in")?;
    let b = c.at(cmd.get("out"), "out")?;
    if b <= a {
        return fail("Set an In and an Out point.", Code::NoRange);
    }
    let tracks = target_tracks(&c, cmd.get("trackIds"))?;
    for id in &tracks {
        c.clear_range(*id, a, b);
    }
    if extract {
        c.ripple_remove(&tracks, a, b)?;
    }
    Ok(json!({ "range": [a, b] }))
}

pub fn add_generated(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts");
    if !o.get("source").and_then(|s| s.get("generator")).is_some_and(Json::is_string) {
        return invalid("the source is not a generator");
    }
    let d = given(o, "duration").cloned().or_else(|| c.p.settings.get("stillDuration").cloned()).unwrap_or(Json::Null);
    let mut po = json!({
        "source": o["source"], "in": 0, "out": d, "at": given(o, "at").cloned().unwrap_or(json!(0)),
        "video": o.get("track").cloned().unwrap_or(Json::Null), "audio": null,
    });
    if let Some(m) = defined(o, "mode") {
        po["mode"] = m.clone();
    }
    if let Some(n) = defined(o, "name") {
        po["name"] = n.clone();
    }
    let r = place_clips(&mut c, &po)?;
    Ok(json!({ "id": r["ids"][0] }))
}
