//! Media, bins, settings, sequences, tracks, markers and captions (port of commands.js's project commands).

use cut_time::{Fps, Ticks};
use serde_json::{Value as Json, json};

use super::edit::{insert_sorted, retime, timed};
use super::{
    Code, Ctx, R, bin_index, bins_mut, context, defined, fail, floor_frames, given, id_list, id_of, invalid, list,
    media_of, nid, num, opts, remove_clip, string,
};
use crate::captionwords as cw;
use crate::defaults::{self, SequenceOpts};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::migrate::snap_f;
use crate::project::{
    AudioInfo, Caption, CaptionTrack, Marker, MarkerKind, Media, MediaKind, Project, Proxy, TrackKind, VideoInfo,
};
use crate::query::{frame, valid_fps};
use crate::remap::{self as R_, Direction};

fn truthy(v: &Json) -> bool {
    !matches!(v, Json::Null | Json::Bool(false)) && v != &json!(0) && v != &json!("")
}

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or_default().to_owned()
}

fn info<T: serde::de::DeserializeOwned>(v: Option<&Json>, what: &str) -> R<Option<T>> {
    match v.filter(|x| !x.is_null()) {
        None => Ok(None),
        Some(x) => {
            serde_json::from_value(x.clone()).map(Some).or_else(|_| invalid(format!("the media's {what} is not valid")))
        }
    }
}

pub fn import_media(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let bin = match given(cmd, "binId") {
        Some(b) => Some(bin_index(p, id_of(Some(b)).unwrap_or(Id::new("")))?),
        None => None,
    };
    let mut made = Vec::new();
    for m in list(cmd.get("media"), "media")? {
        let Some(path) = m.get("path").and_then(Json::as_str) else { return invalid("a media entry has no path") };
        let kind: MediaKind = serde_json::from_value(m.get("kind").cloned().unwrap_or(Json::Null))
            .or_else(|_| invalid("the media's kind is not valid"))?;
        let id = nid(p, tx, "m");
        let entry = Media {
            id,
            path: path.to_owned(),
            name: m.get("name").and_then(Json::as_str).map_or_else(|| file_name(path), str::to_owned),
            kind,
            size: given(m, "size").cloned().unwrap_or(json!(0)),
            mtime: given(m, "mtime").cloned().unwrap_or(json!(0)),
            duration: given(m, "duration").map_or(Ok(0.0), |d| num(Some(d), "duration"))?,
            video: info::<VideoInfo>(m.get("video"), "video")?,
            audio: info::<AudioInfo>(m.get("audio"), "audio")?,
            interpret: Json::Null,
            proxy: None,
            extra: Default::default(),
        };
        tx.media(p);
        p.media.push(entry);
        if let Some(b) = bin {
            bins_mut(p, tx)[b].items.push(id);
        }
        made.push(id);
    }
    Ok(json!({ "ids": made }))
}

pub fn remove_media(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut gone: Vec<Id> = Vec::new();
    for id in list(cmd.get("ids"), "ids")? {
        let m = media_of(p, Some(id))?;
        if !gone.contains(&m.id) {
            gone.push(m.id);
        }
    }
    for si in 0..p.sequences.len() {
        let sid = p.sequences[si].id;
        let hit: Vec<Id> = p.sequences[si]
            .clips_in_order()
            .filter(|x| x.media_id().is_some_and(|m| gone.contains(&m)))
            .map(|x| x.id)
            .collect();
        for id in hit {
            remove_clip(p, tx, sid, id);
        }
    }
    if p.bins.iter().any(|b| b.items.iter().any(|i| gone.contains(i))) {
        for b in bins_mut(p, tx) {
            b.items.retain(|i| !gone.contains(i));
        }
    }
    tx.media(p);
    p.media.retain(|m| !gone.contains(&m.id));
    Ok(json!({ "ids": gone }))
}

pub fn set_proxy(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let m = media_of(p, cmd.get("id"))?;
    let proxy = match given(cmd, "proxy") {
        None => None,
        Some(x) => match x.get("path").and_then(Json::as_str) {
            Some(path) => Some(Proxy { path: path.to_owned(), extra: Default::default() }),
            None => return invalid("a proxy needs a path"),
        },
    };
    tx.media(p);
    if let Some(e) = p.media.iter_mut().find(|x| x.id == m.id) {
        e.proxy = proxy;
    }
    Ok(json!({}))
}

pub fn set_settings(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    for (k, v) in opts(cmd, "patch").as_object().into_iter().flatten() {
        let ok = match k.as_str() {
            "fit" => matches!(v.as_str(), Some("fit" | "fill" | "original")),
            "stillDuration" | "transitionDuration" | "freezeDuration" => {
                v.as_f64().is_some_and(|x| x.fract() == 0.0 && x > 0.0)
            }
            "textStyles" => v.is_array(),
            "speechTerms" => v.as_array().is_some_and(|a| {
                a.len() <= 200
                    && a.iter().all(|t| {
                        t.as_str().is_some_and(|t| t.trim() == t && !t.is_empty() && t.encode_utf16().count() <= 100)
                    })
            }),
            _ => return invalid(format!("unknown project setting {k}")),
        };
        if !ok {
            return invalid(format!("project setting {k} is not valid"));
        }
        tx.project(p);
        p.settings.insert(k.clone(), v.clone());
    }
    Ok(json!({}))
}

/// A LUT for Lumetri Color's Look (`{ id, entry }` as lumetri.js `store()` makes it), kept in the project so it
/// travels with it; the same LUT again changes nothing.
pub fn add_lut(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let entry = cmd.get("entry").cloned().unwrap_or(Json::Null);
    let Some(id) = cmd
        .get("id")
        .and_then(Json::as_str)
        .filter(|id| crate::lumetri::valid_id(id) && crate::lumetri::valid_entry(&entry))
    else {
        return invalid("the LUT is not valid");
    };
    if p.luts.as_ref().and_then(|l| l.get(id)).is_some() {
        return Ok(json!({ "id": id }));
    }
    tx.project(p);
    match p.luts.as_mut().and_then(Json::as_object_mut) {
        Some(l) => {
            l.insert(id.to_owned(), entry);
        }
        None => p.luts = Some(json!({ id: entry })),
    }
    Ok(json!({ "id": id }))
}

pub fn set_speakers(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    if cmd.get("patch") == Some(&Json::Null) {
        tx.project(p);
        p.speakers = None;
        return Ok(json!({}));
    }
    let patch = opts(cmd, "patch");
    for k in patch.as_object().into_iter().flatten().map(|(k, _)| k) {
        if !["list", "turns", "count"].contains(&k.as_str()) {
            return invalid(format!("unknown speakers field {k}"));
        }
    }
    let now = p.speakers.clone().unwrap_or(json!({ "list": [], "turns": {}, "count": 0 }));
    let mut turns = now.get("turns").and_then(Json::as_object).cloned().unwrap_or_default();
    for (media, l) in opts(patch, "turns").as_object().into_iter().flatten() {
        if l.is_null() {
            turns.remove(media);
        } else {
            turns.insert(media.clone(), l.clone());
        }
    }
    let next = json!({
        "list": given(patch, "list").cloned().unwrap_or_else(|| now.get("list").cloned().unwrap_or(json!([]))),
        "turns": turns,
        "count": given(patch, "count").cloned().unwrap_or_else(|| now.get("count").cloned().unwrap_or(json!(0))),
    });
    let mut probe = p.clone();
    probe.speakers = Some(next.clone());
    let bad: Vec<String> =
        crate::validate::validate(&probe).errors.into_iter().filter(|e| e.starts_with("speakers")).collect();
    if !bad.is_empty() {
        return Err(super::CommandError::new("the speaker labels are not valid", Code::Invalid, Some(bad.join("; "))));
    }
    tx.project(p);
    p.speakers = Some(next);
    Ok(json!({}))
}

pub fn relink_media(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let m = media_of(p, cmd.get("id"))?;
    let file = opts(cmd, "file");
    let Some(path) = file.get("path").and_then(Json::as_str) else { return invalid("relink needs a path") };
    let mut next = m.clone();
    next.path = path.to_owned();
    if let Some(v) = defined(file, "size") {
        next.size = v.clone();
    }
    if let Some(v) = defined(file, "mtime") {
        next.mtime = v.clone();
    }
    if let Some(v) = defined(file, "duration") {
        next.duration = num(Some(v), "duration")?;
    }
    if defined(file, "video").is_some() {
        next.video = info(file.get("video"), "video")?;
    }
    if defined(file, "audio").is_some() {
        next.audio = info(file.get("audio"), "audio")?;
    }
    next.proxy = None;
    tx.media(p);
    if let Some(e) = p.media.iter_mut().find(|x| x.id == m.id) {
        *e = next.clone();
    }
    let mut trimmed = Vec::new();
    let mut removed = Vec::new();
    if next.kind != MediaKind::Image {
        let d = next.duration;
        for si in 0..p.sequences.len() {
            let seq_id = p.sequences[si].id;
            let ids: Vec<Id> =
                p.sequences[si].clips_in_order().filter(|x| x.media_id() == Some(m.id)).map(|x| x.id).collect();
            let mut c = context(p, tx, Some(&json!(seq_id.as_str())))?;
            for id in ids {
                let clip = c.clip(id)?.clone();
                if if clip.is_freeze() { clip.in_ <= d } else { clip.out <= d + 0.5 } {
                    continue;
                }
                let keep = if clip.remap.is_some() || clip.is_freeze() {
                    0.0
                } else {
                    c.floor_frames((d - clip.in_) / clip.speed)
                };
                if keep < c.f as f64 {
                    c.remove(id);
                    removed.push(id);
                    continue;
                }
                let keep = keep as Ticks;
                if clip.reverse {
                    c.set_start(id, clip.end() - keep);
                } else {
                    c.set_end(id, clip.start + keep);
                }
                trimmed.push(id);
            }
        }
    }
    Ok(json!({ "trimmed": trimmed, "removed": removed }))
}

pub fn add_bin(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let parent = match given(cmd, "parent") {
        Some(b) => Some(p.bins[bin_index(p, id_of(Some(b)).unwrap_or(Id::new("")))?].id),
        None => None,
    };
    let id = nid(p, tx, "b");
    let name = given(cmd, "name").map_or_else(|| "Bin".to_owned(), string);
    bins_mut(p, tx).push(crate::project::Bin { id, name, parent, items: Vec::new(), extra: Default::default() });
    Ok(json!({ "id": id }))
}

pub fn remove_bin(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let i = bin_index(p, id_of(cmd.get("id")).unwrap_or(Id::new("")))?;
    let bin = p.bins[i].clone();
    let parent = match bin.parent {
        Some(pid) => Some(bin_index(p, pid)?),
        None => None,
    };
    let bins = bins_mut(p, tx);
    for b in bins.iter_mut() {
        if b.parent == Some(bin.id) {
            b.parent = bin.parent;
        }
    }
    if let Some(pi) = parent {
        bins[pi].items.extend(bin.items.iter().copied());
    }
    bins.remove(i);
    Ok(json!({}))
}

pub fn rename_item(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let id = id_of(cmd.get("id"));
    let name = given(cmd, "name").map_or_else(String::new, string);
    if let Some(m) = p.media.iter().position(|m| Some(m.id) == id) {
        tx.media(p);
        p.media[m].name = name;
    } else if let Some(b) = p.bins.iter().position(|b| Some(b.id) == id) {
        bins_mut(p, tx)[b].name = name;
    } else if let Some(sid) = id.filter(|i| p.sequence(*i).is_some()) {
        tx.seq_info(p, sid);
        p.sequence_mut(sid).expect("found").name = name;
    } else {
        return fail(format!("there is no item {}", cmd.get("id").map_or("undefined".into(), string)), Code::NotFound);
    }
    Ok(json!({}))
}

pub fn move_to_bin(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let target = match given(cmd, "binId") {
        Some(b) => Some(p.bins[bin_index(p, id_of(Some(b)).unwrap_or(Id::new("")))?].id),
        None => None,
    };
    for id in id_list(cmd.get("ids"), "ids")? {
        if let Some(bin) = id.and_then(|id| p.bins.iter().find(|b| b.id == id)).map(|b| b.id) {
            let mut at = target;
            while let Some(a) = at {
                if a == bin {
                    return fail("A bin cannot go inside itself.", Code::BinLoop);
                }
                at = p.bins[bin_index(p, a)?].parent;
                if let Some(next) = at {
                    bin_index(p, next)?;
                }
            }
            let bi = bin_index(p, bin)?;
            bins_mut(p, tx)[bi].parent = target;
            continue;
        }
        let Some(id) = id.filter(|id| p.media(*id).is_some() || p.sequence(*id).is_some()) else {
            return fail(format!("there is no item {}", id.map_or("undefined", |i| i.as_str())), Code::NotFound);
        };
        if p.bins.iter().any(|b| b.items.contains(&id)) {
            for b in bins_mut(p, tx) {
                if let Some(pos) = b.items.iter().position(|x| *x == id) {
                    b.items.remove(pos);
                }
            }
        }
        if let Some(t) = target {
            let ti = bin_index(p, t)?;
            bins_mut(p, tx)[ti].items.push(id);
        }
    }
    Ok(json!({}))
}

// ---- sequences ----

fn add_seq(p: &mut Project, tx: &mut Tx, seq: crate::project::Sequence) {
    let id = seq.id;
    p.sequences.push(seq);
    tx.seq_added(id);
}

fn duplicate(p: &mut Project, tx: &mut Tx, src: Id, name: Option<&Json>) -> crate::project::Sequence {
    let mut copy = p.sequence(src).expect("found").clone();
    copy.id = nid(p, tx, "s");
    copy.name = name.map_or_else(|| format!("{} Copy", copy.name), string);
    let mut links: Vec<(Id, Id)> = Vec::new();
    let mut groups: Vec<(Id, Id)> = Vec::new();
    let order: Vec<Id> = copy.clip_order().to_vec();
    let mut clips = Vec::new();
    for old in order {
        let (mut x, _) = copy.remove_clip(old).expect("listed");
        x.id = nid(p, tx, "c");
        if let Some(l) = x.link {
            let nl = match links.iter().find(|(o, _)| *o == l) {
                Some((_, n)) => *n,
                None => {
                    let n = nid(p, tx, "L");
                    links.push((l, n));
                    n
                }
            };
            x.link = Some(nl);
        }
        if let Some(g) = x.group {
            let ng = match groups.iter().find(|(o, _)| *o == g) {
                Some((_, n)) => *n,
                None => {
                    let n = nid(p, tx, "G");
                    groups.push((g, n));
                    n
                }
            };
            x.group = Some(ng);
        }
        for m in x.markers.iter_mut().flatten() {
            m.id = nid(p, tx, "mk");
        }
        clips.push(x);
    }
    for x in clips {
        copy.insert_clip(x, None);
    }
    for t in &mut copy.transitions {
        t.id = nid(p, tx, "t");
    }
    for m in &mut copy.markers {
        m.id = nid(p, tx, "mk");
    }
    for ct in &mut copy.captions {
        ct.id = nid(p, tx, "cc");
        for it in &mut ct.items {
            it.id = nid(p, tx, "cap");
        }
    }
    copy
}

fn fps_json(v: &Json) -> Option<Fps> {
    let a = v.as_array()?;
    let n = a.first()?.as_u64().filter(|x| *x <= u32::MAX as u64)?;
    let d = a.get(1)?.as_u64().filter(|x| *x <= u32::MAX as u64)?;
    (a.len() == 2).then(|| Fps::new(n as u32, d as u32))
}

pub fn add_sequence(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let o = opts(cmd, "opts").clone();
    let seq = if let Some(from) = given(&o, "from") {
        let Some(src) = id_of(Some(from)).filter(|i| p.sequence(*i).is_some()) else {
            return fail(format!("there is no sequence {}", string(from)), Code::NotFound);
        };
        duplicate(p, tx, src, given(&o, "name"))
    } else {
        let fps = match given(&o, "fps").filter(|v| truthy(v)) {
            Some(f) => match fps_json(f).filter(|f| valid_fps(*f)) {
                Some(f) => f,
                None => return fail("That frame rate is not supported.", Code::Fps),
            },
            None => Fps::new(30, 1),
        };
        let int = |k: &str, d: i64| given(&o, k).and_then(Json::as_i64).unwrap_or(d);
        let count = |k: &str| given(&o, k).and_then(Json::as_u64).unwrap_or(2) as usize;
        let id = nid(p, tx, "s");
        let opts = SequenceOpts {
            name: given(&o, "name").map_or_else(|| format!("Sequence {}", p.sequences.len() + 1), string),
            w: int("w", 1920),
            h: int("h", 1080),
            fps,
            background: given(&o, "background").map_or_else(|| "#000000".to_owned(), string),
            master_gain: given(&o, "masterGain").and_then(Json::as_f64).unwrap_or(0.0),
            video_tracks: count("videoTracks"),
            audio_tracks: count("audioTracks"),
        };
        defaults::sequence(id, &opts)
    };
    let id = seq.id;
    add_seq(p, tx, seq);
    if let Some(b) = given(&o, "binId") {
        let bi = bin_index(p, id_of(Some(b)).unwrap_or(Id::new("")))?;
        bins_mut(p, tx)[bi].items.push(id);
    }
    Ok(json!({ "id": id }))
}

pub fn remove_sequence(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let Some(id) = id_of(cmd.get("id")).filter(|i| p.sequence(*i).is_some()) else {
        return fail(
            format!("there is no sequence {}", cmd.get("id").map_or("undefined".into(), string)),
            Code::NotFound,
        );
    };
    if p.bins.iter().any(|b| b.items.contains(&id)) {
        for b in bins_mut(p, tx) {
            if let Some(pos) = b.items.iter().position(|x| *x == id) {
                b.items.remove(pos);
            }
        }
    }
    for (seq, clips) in p.nest_uses(id) {
        let order: Vec<Id> = p
            .sequence(seq)
            .map(|s| s.clip_order().iter().copied().filter(|c| clips.contains(c)).collect())
            .unwrap_or_default();
        for c in order {
            remove_clip(p, tx, seq, c);
        }
    }
    let pos = p.sequences.iter().position(|s| s.id == id).expect("found");
    let seq = p.sequences.remove(pos);
    tx.seq_removed(pos, seq);
    Ok(json!({}))
}

pub fn set_sequence(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("id"))?;
    let patch = opts(cmd, "patch").clone();
    for k in patch.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !["name", "w", "h", "fps", "background", "masterGain"].contains(&k.as_str()) {
            return invalid(format!("unknown sequence setting {k}"));
        }
    }
    if let Some(n) = defined(&patch, "name") {
        let n = string(n);
        c.seq_info_mut().name = n;
    }
    for k in ["w", "h"] {
        let Some(v) = defined(&patch, k) else { continue };
        let Some(x) = v.as_f64().filter(|x| x.fract() == 0.0 && (16.0..=16384.0).contains(x)) else {
            return fail("That frame size is not supported.", Code::Size);
        };
        let s = c.seq_info_mut();
        if k == "w" {
            s.w = x as i64;
        } else {
            s.h = x as i64;
        }
    }
    if let Some(b) = defined(&patch, "background") {
        let b = string(b);
        c.seq_info_mut().background = b;
    }
    if let Some(g) = defined(&patch, "masterGain") {
        let Some(g) = g.as_f64().filter(|g| g.is_finite()) else { return fail("That gain is not valid.", Code::Gain) };
        c.seq_info_mut().master_gain = g;
    }
    if let Some(f) = defined(&patch, "fps") {
        let a = f.as_array();
        let same = a.is_some_and(|a| {
            a.first().and_then(Json::as_f64) == Some(f64::from(c.fps.num))
                && a.get(1).and_then(Json::as_f64) == Some(f64::from(c.fps.den))
        });
        if !same {
            let Some(fps) = fps_json(f).filter(|f| valid_fps(*f)) else {
                return fail("That frame rate is not supported.", Code::Fps);
            };
            refps(&mut c, fps)?;
        }
    }
    Ok(json!({}))
}

/// Every time of the sequence to the nearest frame of the new rate; a clip keeps a frame at least and no more source
/// than it has, and starts where the clip before it ends when it would overlap it.
fn refps(c: &mut Ctx, fps: Fps) -> R<()> {
    let f = frame(fps);
    let sn = |t: f64| snap_f(t, fps, true);
    let mut plan = Vec::new();
    for tr in c.seq().tracks.clone() {
        let mut prev_end = 0;
        for x in c.seq().track(tr.id).map(|t| t.clips.clone()).unwrap_or_default() {
            let s = sn(x.start as f64).max(prev_end);
            let mut d = f.max(sn(x.end() as f64) - s);
            let mut curve = None;
            if let Some(r) = &x.remap {
                let mut cv = R_::refit(r, |t| sn((x.start + t) as f64) - s, f);
                let len = c.p.source_length(&x);
                d = d.min(
                    ((R_::stay(&cv, 0.0, Direction::Later, -0.25, len + 0.25) / f as f64 + 1e-9).floor() * f as f64)
                        as Ticks,
                );
                if d < f {
                    return super::fail_at("The clip is too short.", Code::TooShort, x.id.as_str());
                }
                cv.duration = d;
                curve = Some(cv);
            } else if !c.still(&x) {
                let span = if x.reverse { x.out } else { c.p.source_length(&x) - x.in_ };
                d = d.min(((span / x.speed / f as f64 + 1e-9).floor() * f as f64) as Ticks);
                if d < f {
                    return super::fail_at("The clip is too short.", Code::TooShort, x.id.as_str());
                }
            }
            plan.push((x.id, x.start, s, d, curve));
            prev_end = s + d;
        }
    }
    c.seq_info_mut().fps = fps;
    for (id, old_start, s, d, curve) in plan {
        let rel = |t: Ticks| sn((old_start + t) as f64) - s;
        let still = c.still(c.clip(id)?);
        let has_curve = curve.is_some();
        c.edit(id, |x| {
            for list in x.keyframes.values_mut() {
                let mut by_t: Vec<crate::keyframes::Keyframe> = Vec::new();
                for k in list.iter() {
                    let t = rel(k.t);
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
                m.t = rel(m.t);
                m.duration = sn(m.duration as f64);
            }
        });
        if let Some(cv) = curve {
            c.set_curve(id, cv);
        }
        c.edit(id, |x| {
            if !has_curve {
                if still || !x.reverse {
                    x.out = x.in_ + d as f64 * x.speed;
                } else {
                    x.in_ = x.out - d as f64 * x.speed;
                }
            }
            x.start = s;
            let fi = sn(x.fade_in as f64).min(d);
            x.fade_in = fi;
            x.fade_out = sn(x.fade_out as f64).min(d - fi);
        });
    }
    for t in c.transitions_mut() {
        t.at = sn(t.at as f64);
        t.duration = f.max(sn(t.duration as f64));
    }
    for m in c.markers_mut() {
        m.t = sn(m.t as f64);
        m.duration = sn(m.duration as f64);
    }
    let snf = move |x: Ticks, _: bool| snap_f(x as f64, fps, true);
    for ct in c.captions_mut() {
        for it in &mut ct.items {
            let s = sn(it.start as f64);
            let e = (s + f).max(sn(it.end as f64));
            let t = timed(it, s, e, snf, None);
            retime(it, t);
            it.start = s;
            it.end = e;
        }
    }
    Ok(())
}

// ---- tracks ----

pub fn add_track(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let kind = match cmd.get("kind").and_then(Json::as_str) {
        Some("video") => TrackKind::Video,
        Some("audio") => TrackKind::Audio,
        _ => return invalid(format!("unknown track kind {}", cmd.get("kind").map_or("undefined".into(), string))),
    };
    let letter = if kind == TrackKind::Video { "V" } else { "A" };
    let mut n = 1;
    while c.seq().track(Id::numbered(letter, n)).is_some() {
        n += 1;
    }
    let o = opts(cmd, "opts");
    let id = Id::numbered(letter, n);
    let track = defaults::track(kind, id, o.get("name").and_then(Json::as_str));
    let tracks = &c.seq().tracks;
    let same: Vec<usize> = tracks.iter().enumerate().filter(|(_, t)| t.kind == kind).map(|(i, _)| i).collect();
    let index = match given(cmd, "index") {
        None => same.len() as f64,
        Some(i) => i.as_f64().unwrap_or(f64::NAN),
    }
    .min(same.len() as f64)
    .max(0.0);
    let pos = if index < same.len() as f64 {
        same[index as usize]
    } else if let Some(last) = same.last() {
        last + 1
    } else if kind == TrackKind::Video {
        0
    } else {
        tracks.len()
    };
    let mut infos = c.seq().track_infos();
    infos.insert(pos, track);
    c.seq_info_mut().set_tracks(infos);
    Ok(json!({ "id": id }))
}

pub fn remove_track(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let id = c.track_json(cmd.get("trackId"))?.id;
    let clips: Vec<Id> = c.seq().clips_in_order().filter(|x| x.track == id).map(|x| x.id).collect();
    for x in clips {
        c.remove(x);
    }
    if c.seq().transitions.iter().any(|t| t.track == id) {
        c.transitions_mut().retain(|t| t.track != id);
    }
    let mut infos = c.seq().track_infos();
    infos.retain(|t| t.id != id);
    c.seq_info_mut().set_tracks(infos);
    Ok(json!({}))
}

pub fn set_track(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let tr = c.track_json(cmd.get("trackId"))?.clone();
    let patch = opts(cmd, "patch").clone();
    let mut next = tr.info();
    for (k, v) in patch.as_object().into_iter().flatten() {
        let want = match (k.as_str(), tr.kind) {
            ("name", _) => "string",
            ("locked" | "syncLock", _) | ("visible", TrackKind::Video) | ("mute" | "solo", TrackKind::Audio) => {
                "boolean"
            }
            ("height", _) | ("volume" | "pan", TrackKind::Audio) => "number",
            _ => return invalid(format!("unknown track setting {k}")),
        };
        let ok = match want {
            "string" => v.is_string(),
            "boolean" => v.is_boolean(),
            _ => v.as_f64().is_some_and(f64::is_finite),
        };
        if !ok {
            return invalid(format!("track setting {k} is not a {want}"));
        }
        let x = v.as_f64().unwrap_or(0.0);
        match k.as_str() {
            "name" => next.name = v.as_str().unwrap_or_default().to_owned(),
            "locked" => next.locked = v == &json!(true),
            "syncLock" => next.sync_lock = v == &json!(true),
            "height" => next.height = x.clamp(16.0, 400.0),
            "visible" => next.visible = Some(v == &json!(true)),
            "mute" => next.mute = Some(v == &json!(true)),
            "solo" => next.solo = Some(v == &json!(true)),
            "volume" => next.volume = Some(x),
            _ => next.pan = Some(x.clamp(-100.0, 100.0)),
        }
    }
    let mut infos = c.seq().track_infos();
    if let Some(slot) = infos.iter_mut().find(|t| t.id == tr.id) {
        *slot = next;
    }
    c.seq_info_mut().set_tracks(infos);
    Ok(json!({}))
}

// ---- markers ----

fn marker_fields(c: &Ctx, src: &Json, m: &mut Marker) -> R<()> {
    if let Some(d) = defined(src, "duration") {
        m.duration = c.frames(Some(d), "duration")?.max(0);
    }
    if let Some(v) = defined(src, "name") {
        m.name = string(v);
    }
    if let Some(v) = defined(src, "note") {
        m.note = string(v);
    }
    if let Some(v) = defined(src, "color") {
        m.color = string(v);
    }
    if let Some(k) = defined(src, "kind") {
        m.kind = serde_json::from_value::<MarkerKind>(k.clone())
            .or_else(|_| invalid(format!("unknown marker kind {}", string(k))))?;
    }
    Ok(())
}

fn insert_marker(list: &mut Vec<Marker>, m: Marker) {
    let mut i = list.len();
    while i > 0 && list[i - 1].t > m.t {
        i -= 1;
    }
    list.insert(i, m);
}

pub fn add_marker(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let src = opts(cmd, "marker").clone();
    let clip = match cmd.get("opts").and_then(|o| given(o, "clipId")) {
        Some(id) => Some(c.clip_json(Some(id))?.clone()),
        None => None,
    };
    let default_t = json!(clip.as_ref().map_or(0, |x| x.start));
    let t = c.at(Some(given(&src, "t").unwrap_or(&default_t)), "time")?;
    let id = c.nid("mk");
    let mut m = Marker {
        id,
        t: clip.as_ref().map_or(t, |x| t - x.start),
        duration: 0,
        name: String::new(),
        note: String::new(),
        kind: MarkerKind::Comment,
        color: "green".into(),
        extra: Default::default(),
    };
    marker_fields(&c, &src, &mut m)?;
    match clip {
        Some(x) => c.edit(x.id, |k| insert_marker(k.markers.get_or_insert_with(Vec::new), m)),
        None => insert_marker(c.markers_mut(), m),
    }
    Ok(json!({ "id": id }))
}

/// Where a marker is: the sequence's list, or a clip's.
fn marker_of(c: &Ctx, id: Option<&Json>) -> R<(Option<Id>, usize)> {
    let want = id.and_then(Json::as_str);
    if let Some(i) = c.seq().markers.iter().position(|m| Some(m.id.as_str()) == want) {
        return Ok((None, i));
    }
    for x in c.seq().clips_in_order() {
        if let Some(i) = x.markers.iter().flatten().position(|m| Some(m.id.as_str()) == want) {
            return Ok((Some(x.id), i));
        }
    }
    fail(format!("there is no marker {}", id.map_or("undefined".into(), string)), Code::NotFound)
}

pub fn set_marker(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let (clip, i) = marker_of(&c, cmd.get("id"))?;
    let patch = opts(cmd, "patch").clone();
    for k in patch.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !["t", "duration", "name", "note", "kind", "color"].contains(&k.as_str()) {
            return invalid(format!("unknown marker field {k}"));
        }
    }
    let base = match clip {
        Some(x) => c.clip(x)?.markers.as_ref().expect("found")[i].clone(),
        None => c.seq().markers[i].clone(),
    };
    let mut m = base;
    marker_fields(&c, &patch, &mut m)?;
    let moved = match defined(&patch, "t") {
        Some(t) => {
            let start = clip.map_or(Ok(0), |x| c.clip(x).map(|k| k.start))?;
            m.t = c.at(Some(t), "time")? - start;
            true
        }
        None => false,
    };
    let put = |list: &mut Vec<Marker>| {
        if moved {
            list.remove(i);
            insert_marker(list, m);
        } else {
            list[i] = m;
        }
    };
    match clip {
        Some(x) => c.edit(x, |k| put(k.markers.as_mut().expect("found"))),
        None => put(c.markers_mut()),
    }
    Ok(json!({}))
}

pub fn remove_marker(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    match marker_of(&c, cmd.get("id"))? {
        (Some(x), i) => c.edit(x, |k| {
            k.markers.as_mut().expect("found").remove(i);
        }),
        (None, i) => {
            c.markers_mut().remove(i);
        }
    }
    Ok(json!({}))
}

// ---- captions ----

fn caption_track(c: &Ctx, id: Option<&Json>) -> R<usize> {
    let want = id.and_then(Json::as_str);
    c.seq().captions.iter().position(|t| Some(t.id.as_str()) == want).map_or_else(
        || fail(format!("there is no caption track {}", id.map_or("undefined".into(), string)), Code::NotFound),
        Ok,
    )
}

fn valid_doubt(d: &Json) -> bool {
    d.as_array().is_some_and(|a| {
        a.iter().all(|x| {
            x.is_object()
                && x.get("at").and_then(Json::as_f64).is_some_and(|at| at.fract() == 0.0 && at >= 0.0)
                && x.get("text").is_some_and(Json::is_string)
                && x.get("p").and_then(Json::as_f64).is_some_and(|p| (0.0..=1.0).contains(&p))
        })
    })
}

/// A caption item as a command takes it: times on frames, its words fitted to its text, doubt and speaker checked.
fn caption_item(c: &Ctx, it: &Json) -> R<Caption> {
    if !it.is_object() {
        return invalid("a caption is not an object");
    }
    let start = c.near(it.get("start"), "caption start")?;
    let e = c.near(it.get("end"), "caption end")?;
    let end = if e > start { e } else { start + c.f };
    let text = given(it, "text").map_or_else(String::new, string);
    let mut out = Caption {
        id: Id::new(""),
        start,
        end,
        text,
        doubt: None,
        words: None,
        speaker: None,
        extra: Default::default(),
    };
    if let Some(d) = given(it, "doubt") {
        if !valid_doubt(d) {
            return invalid("a caption's doubt is not valid");
        }
        let d: Vec<cw::Doubt> =
            serde_json::from_value(d.clone()).or_else(|_| invalid("a caption's doubt is not valid"))?;
        if !d.is_empty() {
            out.doubt = Some(d);
        }
    }
    if let Some(w) = given(it, "words") {
        out.words = cw::realign(w, &out.text, c.f, Some(out.end - out.start));
    }
    if let Some(s) = given(it, "speaker") {
        let ok = s
            .as_str()
            .is_some_and(|s| s.len() > 2 && s.starts_with("sp") && s[2..].bytes().all(|b| b.is_ascii_digit()));
        if !ok {
            return invalid("a caption's speaker is not valid");
        }
        out.speaker = s.as_str().map(str::to_owned);
    }
    Ok(out)
}

fn sorted_items(c: &mut Ctx, items: &[Json]) -> R<Vec<Caption>> {
    let mut list = items.iter().map(|x| caption_item(c, x)).collect::<R<Vec<_>>>()?;
    list.sort_by_key(|it| it.start);
    for it in &mut list {
        it.id = c.nid("cap");
    }
    Ok(list)
}

pub fn add_caption_track(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let o = opts(cmd, "opts").clone();
    let id = c.nid("cc");
    let mut style = defaults::default_caption_style();
    if let Some(s) = o.get("style").and_then(Json::as_object) {
        style.extend(s.clone());
    }
    let items: Vec<Json> = o.get("items").and_then(Json::as_array).cloned().unwrap_or_default();
    let mut ct = CaptionTrack {
        id,
        lang: given(&o, "lang").map_or_else(|| "ko".into(), string),
        name: given(&o, "name").map_or_else(|| "Captions".into(), string),
        style,
        sync_lock: o.get("syncLock") != Some(&json!(false)),
        items: Vec::new(),
        extra: Default::default(),
    };
    ct.items = sorted_items(&mut c, &items)?;
    c.captions_mut().push(ct);
    Ok(json!({ "id": id }))
}

pub fn set_caption_track(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let i = caption_track(&c, cmd.get("trackId"))?;
    let patch = opts(cmd, "patch").clone();
    for k in patch.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !["lang", "name", "style", "syncLock"].contains(&k.as_str()) {
            return invalid(format!("unknown caption track setting {k}"));
        }
    }
    let ct = &mut c.captions_mut()[i];
    if let Some(v) = defined(&patch, "lang") {
        ct.lang = string(v);
    }
    if let Some(v) = defined(&patch, "name") {
        ct.name = string(v);
    }
    if let Some(v) = defined(&patch, "syncLock") {
        ct.sync_lock = truthy(v);
    }
    for (k, v) in opts(&patch, "style").as_object().into_iter().flatten() {
        if v.is_null() {
            ct.style.remove(k);
        } else {
            ct.style.insert(k.clone(), v.clone());
        }
    }
    Ok(json!({}))
}

pub fn remove_caption_track(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let i = caption_track(&c, cmd.get("trackId"))?;
    c.captions_mut().remove(i);
    Ok(json!({}))
}

pub fn set_captions(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let i = caption_track(&c, cmd.get("trackId"))?;
    let items = list(cmd.get("items"), "items")?.clone();
    let list = sorted_items(&mut c, &items)?;
    let ids: Vec<Id> = list.iter().map(|it| it.id).collect();
    c.captions_mut()[i].items = list;
    Ok(json!({ "ids": ids }))
}

pub fn add_caption(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let i = caption_track(&c, cmd.get("trackId"))?;
    let id = c.nid("cap");
    let mut it = caption_item(&c, cmd.get("item").unwrap_or(&Json::Null))?;
    it.id = id;
    insert_sorted(&mut c.captions_mut()[i].items, it);
    Ok(json!({ "id": id }))
}

pub fn set_caption(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let ti = caption_track(&c, cmd.get("trackId"))?;
    let want = cmd.get("itemId").and_then(Json::as_str);
    let Some(ii) = c.seq().captions[ti].items.iter().position(|x| Some(x.id.as_str()) == want) else {
        return fail(
            format!("there is no caption {}", cmd.get("itemId").map_or("undefined".into(), string)),
            Code::NotFound,
        );
    };
    let it = c.seq().captions[ti].items[ii].clone();
    let patch = opts(cmd, "patch").clone();
    for k in patch.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        if !["start", "end", "text", "doubt", "words", "speaker"].contains(&k.as_str()) {
            return invalid(format!("unknown caption field {k}"));
        }
    }
    let as_json = |x: &Option<Vec<cw::Doubt>>| x.as_ref().map(|d| serde_json::to_value(d).expect("serializes"));
    let mut doubt: Option<Json> = match defined(&patch, "doubt") {
        Some(d) => Some(d.clone()),
        None => match defined(&patch, "text") {
            Some(t) if string(t) != it.text => None,
            _ => as_json(&it.doubt),
        },
    };
    let mut words: Option<Json> = match defined(&patch, "words") {
        Some(w) => Some(w.clone()),
        None => it.words.as_ref().map(|w| serde_json::to_value(w).expect("serializes")),
    };
    let s = c.near(Some(given(&patch, "start").unwrap_or(&json!(it.start))), "caption start")?;
    let e = match defined(&patch, "end") {
        Some(e) => c.near(Some(e), "caption end")?,
        None => it.end,
    };
    if s != it.start && s - it.start != e - it.end {
        if defined(&patch, "words").is_none()
            && let Some(w) = &it.words
        {
            words = Some(serde_json::to_value(cw::remap(w, it.start, s, |x, _| x)).expect("serializes"));
        }
        if defined(&patch, "doubt").is_none()
            && let Some(d) = doubt.as_ref().and_then(|d| serde_json::from_value::<Vec<cw::Doubt>>(d.clone()).ok())
        {
            doubt = Some(serde_json::to_value(cw::remap_doubt(&d, it.start, s, |x, _| x, e - s)).expect("serializes"));
        }
    }
    let speaker = match defined(&patch, "speaker") {
        Some(sp) => sp.clone(),
        None => it.speaker.as_ref().map_or(Json::Null, |s| json!(s)),
    };
    let item = json!({
        "start": given(&patch, "start").cloned().unwrap_or(json!(it.start)),
        "end": given(&patch, "end").cloned().unwrap_or(json!(it.end)),
        "text": given(&patch, "text").cloned().unwrap_or(json!(it.text)),
        "doubt": doubt, "words": words, "speaker": speaker,
    });
    let next = caption_item(&c, &item)?;
    let items = &mut c.captions_mut()[ti].items;
    let cur = &mut items[ii];
    cur.speaker = next.speaker;
    cur.text = next.text;
    cur.end = next.end;
    cur.doubt = next.doubt;
    cur.words = next.words;
    if next.start != cur.start {
        cur.start = next.start;
        let moved = items.remove(ii);
        insert_sorted(items, moved);
    }
    let _ = (floor_frames, id_list, num);
    Ok(json!({}))
}

pub fn remove_caption(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let mut c = context(p, tx, cmd.get("seqId"))?;
    let ti = caption_track(&c, cmd.get("trackId"))?;
    let want = cmd.get("itemId").and_then(Json::as_str);
    let Some(ii) = c.seq().captions[ti].items.iter().position(|x| Some(x.id.as_str()) == want) else {
        return fail(
            format!("there is no caption {}", cmd.get("itemId").map_or("undefined".into(), string)),
            Code::NotFound,
        );
    };
    c.captions_mut()[ti].items.remove(ii);
    Ok(json!({}))
}
