//! Placing, moving, trimming and cutting (control.js), and the edit-command allowlist of ai.js (`validatePlan`,
//! `planCommands`) for the operations these tools share with the text AI: a split on every track, a range cut or
//! lift, removing markers by kind, removing silence.

use cut_model::TrackKind;
use cut_model::commands::build as C;
use cut_time::TICKS;
use serde_json::{Value as Json, json};

use crate::control::call::{Cx, Out, R, b, f, given, num, r3, refuse, round, s, strs};
use crate::control::schema::js_num;

const T: f64 = TICKS as f64;

/// One operation of ai.js's allowlist, as these tools use it.
pub enum Op {
    Split(f64),
    Cut(f64, f64),
    Lift(f64, f64),
    RemoveMarkers(String),
    /// The measured ranges (ticks) and the tracks they were measured on.
    RemoveSilence(Vec<(i64, i64)>, Option<Vec<String>>),
}

/// `plan(c, ops, {label, silence})`: the operation checked and turned into commands as ai.js does, one step.
pub fn plan(c: &mut Cx, op: Op, label: &str) -> R<Json> {
    let end = c.duration() as f64 / T;
    let fr = c.f();
    let clamp = |x: f64| x.max(0.0).min(end);
    let tk = |x: f64| round(x * T / fr as f64) as i64 * fr;
    let seq = c.seq_id().as_str();
    let mut cmds = Vec::new();
    match op {
        Op::Split(at) => cmds.push(C::split(seq, tk(clamp(at)), json!({}))),
        Op::Lift(a, z) => {
            let (a, z) = (tk(clamp(a)), tk(clamp(z)));
            if z > a {
                cmds.push(C::lift(seq, a, z, None));
            }
        }
        Op::Cut(a, z) => {
            let (a, z) = (tk(clamp(a)), tk(clamp(z)));
            if z > a {
                cmds.push(C::extract(seq, a, z, None));
            }
        }
        Op::RemoveMarkers(kind) => {
            for m in &c.seq().markers {
                let k = serde_json::to_value(m.kind).unwrap_or_default();
                if kind == "all" || k == kind.as_str() {
                    cmds.push(C::remove_marker(seq, m.id.as_str()));
                }
            }
        }
        Op::RemoveSilence(mut ranges, tracks) => {
            ranges.sort_by(|x, y| y.0.cmp(&x.0).then(y.1.cmp(&x.1)));
            let ids: Option<Vec<&str>> = tracks.as_ref().map(|t| t.iter().map(String::as_str).collect());
            for (a, z) in ranges {
                if z > a {
                    cmds.push(C::extract(seq, a, z, ids.as_deref()));
                }
            }
        }
    }
    if cmds.is_empty() {
        return refuse("That changes nothing.");
    }
    c.run(&C::batch(label, cmds))
}

pub fn place_clip(c: &mut Cx, a: &Json) -> R<Out> {
    let (media, nest) = (s(a, "media_id"), s(a, "nest_sequence_id"));
    if media.is_none() == nest.is_none() {
        return refuse("Give media_id or nest_sequence_id (one of them).");
    }
    let at = c.time_in(f(a, "at").unwrap_or(0.0), "at", false)?;
    let (source, has_v, has_a, length);
    if let Some(id) = media {
        let m = c.media_of(id)?;
        source = json!({ "media": m.id.as_str() });
        has_v = m.kind == cut_model::MediaKind::Image || m.video.is_some();
        has_a = m.audio.is_some();
        length = if m.kind == cut_model::MediaKind::Image { f64::INFINITY } else { m.duration / T };
    } else {
        let id = nest.unwrap_or_default();
        let Some(inner) = c.project().sequences.iter().find(|q| q.id.as_str() == id) else {
            return refuse(format!("There is no sequence {id}."));
        };
        let inner_id = inner.id;
        let len = inner.duration() as f64 / T;
        if c.project().nest_loop(c.seq_id(), inner_id) {
            return refuse("That nest would make the sequence show itself.");
        }
        source = json!({ "sequence": inner_id.as_str() });
        let k = c.project().nest_kinds(inner_id);
        has_v = k.video;
        has_a = k.audio;
        length = len;
    }
    let pick = |k: &str, has: bool, default: &str| -> Option<String> {
        if given(a, k) { s(a, k).map(str::to_owned) } else { has.then(|| default.to_owned()) }
    };
    let vt = pick("video_track", has_v, "V1");
    let at2 = pick("audio_track", has_a, "A1");
    if let Some(v) = &vt {
        c.track_of(v, Some(TrackKind::Video), true)?;
    }
    if let Some(x) = &at2 {
        c.track_of(x, Some(TrackKind::Audio), true)?;
    }
    let (si, so) = (f(a, "source_in"), f(a, "source_out"));
    if let Some(x) = si
        && x >= length
    {
        return refuse(format!("source_in {} s is past the end of the source ({} s).", js_num(x), js_num(r3(length))));
    }
    if let (Some(o), Some(i)) = (so, si)
        && o <= i
    {
        return refuse("source_out must be after source_in.");
    }
    let mut opts =
        json!({ "source": source, "at": at, "video": vt, "audio": at2, "mode": s(a, "mode").unwrap_or("overwrite") });
    if length.is_finite() {
        if let Some(i) = si {
            opts["in"] = json!(c.ticks(i));
        }
        if let Some(o) = so {
            opts["out"] = json!(c.ticks(o.min(length)));
        }
    } else if let Some(d) = f(a, "duration") {
        opts["in"] = json!(0);
        opts["out"] = json!(c.ticks(d));
    }
    let r = c.run(&C::place(c.seq_id().as_str(), opts))?;
    let rat = r["at"].as_f64().unwrap_or(0.0);
    let rd = r["duration"].as_f64().unwrap_or(0.0);
    Ok(json!({ "edit": { "at": rat }, "clips": r["ids"], "start": c.sec(rat), "end": c.sec(rat + rd) }).into())
}

fn ids_of(a: &Json, k: &str) -> Vec<String> {
    strs(a, k).unwrap_or_default()
}

fn refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

pub fn move_clips(c: &mut Cx, a: &Json) -> R<Out> {
    let ids = ids_of(a, "clip_ids");
    let mut first = i64::MAX;
    for id in &ids {
        first = first.min(c.clip_of(id, true)?.start);
    }
    let (to, delta) = (f(a, "to"), f(a, "delta"));
    if to.is_some() && delta.is_some() {
        return refuse("Give to or delta, not both.");
    }
    let d = match to {
        Some(t) => c.ticks(t) - first,
        None => c.ticks(delta.unwrap_or(0.0)),
    };
    if first + d < 0 {
        return refuse(format!(
            "That would move a clip before the start (by {} s from {} s).",
            js_num(r3(d as f64 / T)),
            c.sec(first as f64)
        ));
    }
    let track_delta = f(a, "track_delta").unwrap_or(0.0) as i64;
    if d == 0 && track_delta == 0 {
        return refuse("Give to, delta or track_delta.");
    }
    let opts = json!({ "delta": d, "trackDelta": track_delta, "insert": b(a, "insert") == Some(true), "linked": b(a, "linked") != Some(false) });
    c.run(&C::move_clips(c.seq_id().as_str(), &refs(&ids), opts))?;
    Ok(json!({ "edit": { "at": first + d }, "moved": ids }).into())
}

pub fn trim_clip(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let mode = s(a, "mode").unwrap_or("normal");
    let linked = b(a, "linked") != Some(false);
    let seq = c.seq_id();
    let now = |c: &Cx| c.seq().clip(clip.id).cloned();
    if mode == "slip" || mode == "slide" {
        let Some(d) = f(a, "delta").filter(|_| f(a, "to").is_none() && s(a, "edge").is_none()) else {
            return refuse(format!("{mode} takes delta (seconds) and no edge or to."));
        };
        let opts = json!({ "delta": c.ticks(d), "linked": linked });
        let cmd = if mode == "slip" {
            C::slip(seq.as_str(), clip.id.as_str(), opts)
        } else {
            C::slide(seq.as_str(), clip.id.as_str(), opts)
        };
        let r = c.run(&cmd)?;
        let Some(n) = now(c) else { return refuse("The editor refused: the clip is gone.") };
        return Ok(json!({
            "edit": { "at": n.start },
            "applied": r["applied"].as_f64().map(|x| num(r3(x / T))),
            "stoppedBy": r.get("clamped").filter(|v| !v.is_null()).cloned(),
            "start": c.sec(n.start as f64), "end": c.sec(n.end() as f64), "in": c.sec(n.in_), "out": c.sec(n.out),
        })
        .into());
    }
    let Some(edge) = s(a, "edge") else { return refuse(format!("mode {mode} needs edge (start or end).")) };
    let (to, delta) = (f(a, "to"), f(a, "delta"));
    if to.is_none() == delta.is_none() {
        return refuse("Give to or delta (one of them).");
    }
    let edge_at = if edge == "start" { clip.start } else { clip.end() };
    let d = match to {
        Some(t) => c.ticks(t) - edge_at,
        None => c.ticks(delta.unwrap_or(0.0)),
    };
    let cmd = if mode == "stretch" {
        C::stretch(seq.as_str(), clip.id.as_str(), json!({ "edge": edge, "delta": d, "linked": linked }))
    } else {
        C::trim(seq.as_str(), clip.id.as_str(), json!({ "edge": edge, "delta": d, "mode": mode, "linked": linked }))
    };
    let r = c.run(&cmd)?;
    let applied = r["applied"].as_f64();
    let mut o = json!({
        "edit": { "at": edge_at as f64 + applied.unwrap_or(d as f64) },
        "applied": if r.is_null() { Json::Null } else { applied.map_or(Json::Null, |x| num(r3(x / T))) },
        "stoppedBy": r.get("clamped").filter(|v| !v.is_null()).cloned(),
    });
    if let Some(n) = now(c) {
        o["start"] = c.sec(n.start as f64);
        o["end"] = c.sec(n.end() as f64);
        if n.speed != 1.0 {
            o["speed"] = num(r3(n.speed * 100.0));
        }
    }
    Ok(o.into())
}

pub fn razor(c: &mut Cx, a: &Json) -> R<Out> {
    let at_s = f(a, "at").unwrap_or(0.0);
    let t = c.time_in(at_s, "at", false)?;
    let tracks = strs(a, "track_ids");
    let clips = strs(a, "clip_ids");
    for id in tracks.iter().flatten() {
        c.track_of(id, None, true)?;
    }
    for id in clips.iter().flatten() {
        c.clip_of(id, true)?;
    }
    let seq = c.seq();
    let under = seq.clips_in_order().any(|x| {
        x.start < t
            && t < x.end()
            && tracks.as_ref().is_none_or(|l| l.iter().any(|i| i == x.track.as_str()))
            && clips.as_ref().is_none_or(|l| l.iter().any(|i| i == x.id.as_str()))
            && !seq.track(x.track).is_some_and(|k| k.locked)
    });
    if !under {
        return refuse(format!(
            "No clip on an unlocked track crosses {} s (cuts go inside a clip, not on its edge).",
            js_num(at_s)
        ));
    }
    let r = if tracks.is_none() && clips.is_none() {
        let r = plan(c, Op::Split(at_s), "Add Edit")?;
        r["results"][0].clone()
    } else {
        let opts = match &clips {
            Some(l) => json!({ "clipIds": l }),
            None => json!({ "trackIds": tracks }),
        };
        c.run(&C::split(c.seq_id().as_str(), t, opts))?
    };
    Ok(json!({ "edit": { "at": t }, "newClips": r["ids"] }).into())
}

pub fn delete_clips(c: &mut Cx, a: &Json) -> R<Out> {
    let ids = ids_of(a, "clip_ids");
    let linked = b(a, "linked") != Some(false);
    let mut at = i64::MAX;
    let mut clips = Vec::new();
    for id in &ids {
        let x = c.clip_of(id, true)?;
        at = at.min(x.start);
        clips.push(x);
    }
    if linked {
        for x in &clips {
            let tracks: Vec<String> = c.seq().linked_clips(x).iter().map(|l| l.track.as_str().to_owned()).collect();
            for t in tracks {
                c.track_of(&t, None, true)?;
            }
        }
    }
    let r = c.run(&C::remove(
        c.seq_id().as_str(),
        &refs(&ids),
        json!({ "ripple": b(a, "ripple") == Some(true), "linked": linked }),
    ))?;
    Ok(json!({ "edit": { "at": at }, "removed": r["ids"] }).into())
}

pub fn delete_range(c: &mut Cx, a: &Json) -> R<Out> {
    let (from, to) = (f(a, "from").unwrap_or(0.0), f(a, "to").unwrap_or(0.0));
    let a0 = c.time_in(from, "from", false)?;
    let b0 = c.time_in(to, "to", false)?;
    if b0 - a0 < c.f() {
        return refuse("\"to\" must be at least one frame after \"from\".");
    }
    let ripple = b(a, "ripple") != Some(false);
    match strs(a, "track_ids") {
        None => {
            let op = if ripple { Op::Cut(from, to) } else { Op::Lift(from, to) };
            plan(c, op, if ripple { "Extract" } else { "Lift" })?;
        }
        Some(tracks) => {
            for id in &tracks {
                c.track_of(id, None, true)?;
            }
            let seq = c.seq_id();
            let ids = refs(&tracks);
            let cmd = if ripple {
                C::extract(seq.as_str(), a0, b0, Some(&ids))
            } else {
                C::lift(seq.as_str(), a0, b0, Some(&ids))
            };
            c.run(&cmd)?;
        }
    }
    Ok(json!({ "edit": { "at": a0 }, "range": [c.sec(a0 as f64), c.sec(b0 as f64)] }).into())
}

pub fn link_clips(c: &mut Cx, a: &Json) -> R<Out> {
    let ids = ids_of(a, "clip_ids");
    let action = s(a, "action").unwrap_or("link");
    let mut first = i64::MAX;
    for id in &ids {
        first = first.min(c.clip_of(id, true)?.start);
    }
    if (action == "link" || action == "group") && ids.len() < 2 {
        return refuse(format!("To {action}, give two clips or more."));
    }
    let seq = c.seq_id();
    let r = refs(&ids);
    let cmd = match action {
        "link" => C::link(seq.as_str(), &r),
        "unlink" => C::unlink(seq.as_str(), &r),
        "group" => C::group(seq.as_str(), &r),
        _ => C::ungroup(seq.as_str(), &r),
    };
    c.run(&cmd)?;
    Ok(json!({ "edit": { "at": first }, "clips": ids }).into())
}
