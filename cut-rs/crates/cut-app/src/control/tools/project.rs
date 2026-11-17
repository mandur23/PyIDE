//! The tools for the project and its output (control-project.js): media in and out of the project, bins and names,
//! sequences, tracks, transitions, caption tracks, color mattes, project settings, saving, the frame and caption
//! exports, the export queue, proxies and the 9:16 shorts sequence.

use cut_model::commands::build as C;
use cut_model::{Id, TrackKind};
use cut_time::TICKS;
use serde_json::{Map, Value as Json, json};

use super::clip::param_value;
use super::more::{file_name, fps_of, free_video_track, still_span};
use crate::control::call::{Cx, Out, R, arg, b, f, given, num, r3, refuse, round, s, strs};

const T: f64 = TICKS as f64;

/// `PATH`: an absolute path on a drive of this PC.
fn absolute(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
        && !p[3..].chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*') || (c as u32) < 0x20)
}

fn has_dotdot(p: &str) -> bool {
    p.split(['\\', '/']).any(|x| x == "..")
}

pub fn import_media(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    let paths = strs(a, "paths");
    let folder = b(a, "folder") == Some(true);
    if paths.is_some() && folder {
        return refuse("Give paths or folder, not both.");
    }
    for p in paths.iter().flatten() {
        if p.starts_with("\\\\") || p.starts_with("//") || p.starts_with("\\/") || p.starts_with("/\\") {
            return refuse(format!("{p} is on a network share; Cut opens only files on this PC."));
        }
        if !absolute(p) || has_dotdot(p) {
            return refuse(format!("{p} is not an absolute file path like C:\\Users\\me\\Videos\\clip.mp4."));
        }
    }
    let bin = s(a, "bin_id");
    if let Some(id) = bin
        && !c.project().bins.iter().any(|x| x.id.as_str() == id)
    {
        return refuse(format!("There is no bin {id}. get_project lists the bins."));
    }
    let seq = c.seq_id();
    let had_paths = paths.is_some();
    let Some(mut task) = c.host.import_media(paths, folder, bin.map(Id::new), seq) else {
        return refuse("Importing is not available here.");
    };
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        if r["declined"] == true {
            return Some(refuse(if had_paths {
                "The user did not confirm these files. Nothing was imported."
            } else {
                "The user picked nothing. Nothing was imported."
            }));
        }
        if r["ok"] != true {
            return Some(refuse(r["error"].as_str().unwrap_or("Nothing was imported.")));
        }
        let p = h.app().project();
        let media: Vec<Json> = r["ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
            .map(|id| match p.media.iter().find(|m| m.id.as_str() == id) {
                Some(m) => {
                    json!({ "id": id, "name": m.name, "kind": serde_json::to_value(m.kind).unwrap_or_default() })
                }
                None => json!({ "id": id }),
            })
            .collect();
        let tracks = r["captionTracks"].as_array().filter(|l| !l.is_empty());
        let failed = r["failed"].as_array().filter(|l| !l.is_empty());
        if media.is_empty() && tracks.is_none() {
            let why = failed.map_or_else(
                || ".".to_owned(),
                |l| {
                    let parts: Vec<String> = l
                        .iter()
                        .map(|x| {
                            format!(
                                "{} ({})",
                                x["name"].as_str().unwrap_or_default(),
                                x["error"].as_str().unwrap_or_default()
                            )
                        })
                        .collect();
                    format!(": {}", parts.join("; "))
                },
            );
            return Some(refuse(format!("Nothing could be imported{why}")));
        }
        let mut out = json!({ "edit": { "at": h.app().t }, "media": media });
        if let Some(t) = tracks {
            out["captionTracks"] = json!(t);
        }
        if let Some(l) = failed {
            out["failed"] = json!(l);
        }
        Some(Ok(out))
    })))
}

pub fn remove_media(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    let ids = strs(a, "media_ids");
    let unused = b(a, "unused") == Some(true);
    if ids.is_none() == !unused {
        return refuse("Give media_ids or unused: true (one of them).");
    }
    let uses = |c: &Cx, id: Id| {
        c.project()
            .sequences
            .iter()
            .map(|q| q.clips_in_order().filter(|x| x.media_id() == Some(id)).count())
            .sum::<usize>()
    };
    let list: Vec<Id> = if unused {
        c.project().media.iter().map(|m| m.id).filter(|id| uses(c, *id) == 0).collect()
    } else {
        let mut l = Vec::new();
        for id in ids.unwrap_or_default() {
            l.push(c.media_of(&id)?.id);
        }
        l
    };
    if list.is_empty() {
        return refuse("There is no unused media.");
    }
    for id in &list {
        let n = uses(c, *id);
        if n > 0 {
            return refuse(format!(
                "{} is used by {n} clips; delete them first (the file itself is never deleted).",
                id.as_str()
            ));
        }
    }
    let refs: Vec<&str> = list.iter().map(|i| i.as_str()).collect();
    c.run(&C::remove_media(&refs))?;
    Ok(json!({ "edit": { "at": c.host.app().t }, "removed": refs, "note": "Removed from the project only; the files stay on the disk." }).into())
}

pub fn project_items(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    let action = s(a, "action").unwrap_or_default();
    let only = |keys: &[&str]| -> R<()> {
        for k in ["name", "bin_id", "item_id", "item_ids"] {
            if given(a, k) && !keys.contains(&k) {
                let takes = if keys.is_empty() { "nothing else".to_owned() } else { keys.join(", ") };
                return refuse(format!("{action} takes {takes}, not {k}."));
            }
        }
        Ok(())
    };
    let bin = |c: &Cx, id: &str| -> R<Id> {
        match c.project().bins.iter().find(|x| x.id.as_str() == id) {
            Some(x) => Ok(x.id),
            None => refuse(format!("There is no bin {id}. get_project lists the bins.")),
        }
    };
    let item = |c: &Cx, id: &str| -> R<Id> {
        let p = c.project();
        let found = p
            .media
            .iter()
            .map(|m| m.id)
            .chain(p.bins.iter().map(|x| x.id))
            .chain(p.sequences.iter().map(|q| q.id))
            .find(|x| x.as_str() == id);
        match found {
            Some(x) => Ok(x),
            None => refuse(format!("There is no media, bin or sequence {id}.")),
        }
    };
    let t = c.host.app().t;
    let bin_id = s(a, "bin_id");
    match action {
        "new_bin" => {
            only(&["name", "bin_id"])?;
            if let Some(id) = bin_id {
                bin(c, id)?;
            }
            let name = s(a, "name").map(str::trim).filter(|x| !x.is_empty()).unwrap_or("Bin");
            let r = c.run(&C::add_bin(name, bin_id))?;
            Ok(json!({ "edit": { "at": t }, "bin": r["id"] }).into())
        }
        "remove_bin" => {
            only(&["bin_id"])?;
            let Some(id) = bin_id else { return refuse("remove_bin needs bin_id.") };
            let id = bin(c, id)?;
            c.run(&C::remove_bin(id.as_str()))?;
            Ok(json!({ "edit": { "at": t }, "note": "Its items moved to the bin above it." }).into())
        }
        "rename" => {
            only(&["item_id", "name"])?;
            let name = s(a, "name").map(str::trim).filter(|x| !x.is_empty());
            let (Some(id), Some(name)) = (s(a, "item_id"), name) else {
                return refuse("rename needs item_id and a name.");
            };
            let id = item(c, id)?;
            c.run(&C::rename_item(id.as_str(), name))?;
            Ok(json!({ "edit": { "at": t } }).into())
        }
        _ => {
            only(&["item_ids", "bin_id"])?;
            let Some(ids) = strs(a, "item_ids") else { return refuse("move needs item_ids.") };
            for id in &ids {
                item(c, id)?;
            }
            if let Some(id) = bin_id {
                bin(c, id)?;
            }
            let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
            c.run(&C::move_to_bin(&refs, bin_id))?;
            Ok(json!({ "edit": { "at": t } }).into())
        }
    }
}

pub fn add_sequence(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    let bin = s(a, "bin_id");
    if let Some(id) = bin
        && !c.project().bins.iter().any(|x| x.id.as_str() == id)
    {
        return refuse(format!("There is no bin {id}."));
    }
    let mut opts = match s(a, "duplicate_of") {
        Some(from) => {
            if given(a, "preset")
                || f(a, "width").is_some_and(|x| x != 0.0)
                || f(a, "height").is_some_and(|x| x != 0.0)
                || given(a, "fps")
            {
                return refuse(
                    "A duplicate keeps the size and rate of its sequence; change them after with set_sequence.",
                );
            }
            if !c.project().sequences.iter().any(|q| q.id.as_str() == from) {
                return refuse(format!("There is no sequence {from}."));
            }
            json!({ "from": from })
        }
        None => {
            let want = s(a, "preset").unwrap_or("youtube-1080p30");
            let pre = cut_export::presets::SEQUENCE
                .iter()
                .find(|p| p.id == want)
                .copied()
                .unwrap_or(cut_export::presets::SEQUENCE[0]);
            let w = f(a, "width").unwrap_or(f64::from(pre.w));
            let h = f(a, "height").unwrap_or(f64::from(pre.h));
            if w % 2.0 != 0.0 || h % 2.0 != 0.0 {
                return refuse("width and height must be even.");
            }
            let fps = s(a, "fps").and_then(fps_of).unwrap_or([pre.fps.num, pre.fps.den]);
            json!({ "w": num(w), "h": num(h), "fps": fps })
        }
    };
    if let Some(n) = s(a, "name").map(str::trim).filter(|x| !x.is_empty()) {
        opts["name"] = json!(n);
    }
    if let Some(id) = bin {
        opts["binId"] = json!(id);
    }
    let r = c.run(&C::add_sequence(opts))?;
    let id = Id::new(r["id"].as_str().unwrap_or_default());
    let active = b(a, "active") != Some(false);
    if active {
        c.host.app_mut().set_sequence(id);
    }
    let Some(q) = c.project().sequence(id) else { return refuse("The editor refused: the sequence is gone.") };
    Ok(json!({
        "edit": { "at": 0, "seqId": if active { json!(id.as_str()) } else { Json::Null } },
        "sequence": id.as_str(), "name": q.name, "width": q.w, "height": q.h, "fps": num(r3(q.fps.num as f64 / q.fps.den as f64)),
    })
    .into())
}

pub fn remove_sequence(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(a.get("sequence_id"))?;
    let seq = c.seq_id();
    let p = c.project();
    if p.sequences.len() < 2 {
        return refuse("This is the only sequence; a project keeps one.");
    }
    let uses = p.nest_uses(seq);
    let count: usize = uses.iter().map(|u| u.1.len()).sum();
    for (sid, clips) in &uses {
        let Some(q) = p.sequence(*sid) else { continue };
        for x in clips.iter().filter_map(|id| q.clip(*id)) {
            if q.track(x.track).is_some_and(|t| t.locked) {
                return refuse(format!("A nest of it lies on locked track {} of \"{}\".", x.track.as_str(), q.name));
            }
        }
    }
    let other = p.sequences.iter().find(|q| q.id != seq).map(|q| q.id);
    let was = c.host.app().sequence_id == Some(seq);
    if was && let Some(o) = other {
        c.host.app_mut().set_sequence(o);
    }
    if let Err(e) = c.run(&C::remove_sequence(seq.as_str())) {
        if was {
            c.host.app_mut().set_sequence(seq);
        }
        return Err(e);
    }
    Ok(json!({ "edit": { "at": 0 }, "removed": seq.as_str(), "nestClipsRemoved": count, "active": c.host.app().sequence_id.map(|i| i.as_str()) }).into())
}

fn track_ids(c: &Cx) -> Vec<&'static str> {
    c.seq().tracks.iter().map(|t| t.id.as_str()).collect()
}

pub fn add_track(c: &mut Cx, a: &Json) -> R<Out> {
    let kind = s(a, "kind").unwrap_or("video");
    let k = if kind == "audio" { TrackKind::Audio } else { TrackKind::Video };
    let n = c.seq().tracks.iter().filter(|t| t.kind == k).count();
    let index = f(a, "index").map(|i| i as usize);
    if let Some(i) = index
        && i > n
    {
        return refuse(format!("index is at most {n} (there are {n} {kind} tracks)."));
    }
    let seq = c.seq_id();
    let name = s(a, "name").map(str::trim).filter(|x| !x.is_empty()).map(str::to_owned);
    let id = c.atomic("Add Track", |c| {
        let r = c.run(&C::add_track(seq.as_str(), kind, index, json!({})))?;
        let id = r["id"].as_str().unwrap_or_default().to_owned();
        if let Some(n) = &name {
            c.run(&C::set_track(seq.as_str(), &id, json!({ "name": n })))?;
        }
        Ok(id)
    })?;
    Ok(json!({ "edit": { "at": c.host.app().t }, "track": id, "tracks": track_ids(c) }).into())
}

pub fn remove_track(c: &mut Cx, a: &Json) -> R<Out> {
    let t = c.track_of(s(a, "track_id").unwrap_or_default(), None, true)?;
    let kind = if t.kind == TrackKind::Audio { "audio" } else { "video" };
    if c.seq().tracks.iter().filter(|x| x.kind == t.kind).count() < 2 {
        return refuse(format!("{} is the only {kind} track; a sequence keeps one.", t.id.as_str()));
    }
    let clips = c.seq().clips_in_order().filter(|x| x.track == t.id).count();
    c.run(&C::remove_track(c.seq_id().as_str(), t.id.as_str()))?;
    Ok(json!({ "edit": { "at": c.host.app().t }, "removedClips": clips, "tracks": track_ids(c) }).into())
}

pub fn set_transition(c: &mut Cx, a: &Json) -> R<Out> {
    let id = s(a, "transition_id").unwrap_or_default();
    let Some(t) = c.seq().transitions.iter().find(|x| x.id.as_str() == id).cloned() else {
        return refuse(format!("There is no transition {id}. get_sequence lists them."));
    };
    let track = c.track_of(t.track.as_str(), None, true)?;
    let ty = s(a, "type").map_or_else(|| t.kind.clone(), str::to_owned);
    let Some(def) = cut_model::effects::transitions(None).find(|d| d.id == ty) else {
        return refuse(format!("There is no transition \"{ty}\". list_effects lists them."));
    };
    let tk =
        if track.kind == TrackKind::Audio { cut_model::effects::Kind::Audio } else { cut_model::effects::Kind::Video };
    if def.kind != tk {
        return refuse(format!(
            "{ty} is a {} transition and {} a {} track.",
            def.kind.name(),
            t.track.as_str(),
            tk.name()
        ));
    }
    let mut patch = Map::new();
    if let Some(v) = a.get("type") {
        patch.insert("type".into(), v.clone());
    }
    if let Some(v) = a.get("align") {
        patch.insert("align".into(), v.clone());
    }
    if let Some(d) = f(a, "duration") {
        let fr = c.f();
        patch.insert("duration".into(), json!((round(c.ticks(d) as f64 / fr as f64) as i64 * fr).max(fr)));
    }
    if let Some(p) = arg(a, "params").and_then(Json::as_object) {
        let mut m = Map::new();
        for (k, v) in p {
            m.insert(k.clone(), param_value(def, k, v, &format!("params.{k}"), None)?);
        }
        patch.insert("params".into(), Json::Object(m));
    }
    if patch.is_empty() {
        return refuse("Give something to change.");
    }
    c.run(&C::set_transition(c.seq_id().as_str(), t.id.as_str(), Json::Object(patch)))?;
    let Some(now) = c.seq().transitions.iter().find(|x| x.id == t.id).cloned() else {
        return refuse("The editor refused: the transition is gone.");
    };
    Ok(json!({
        "edit": { "at": now.at }, "duration": c.sec(now.duration as f64),
        "align": serde_json::to_value(now.align).unwrap_or_default(), "type": now.kind,
    })
    .into())
}

fn color8(v: &str) -> bool {
    let h = v.strip_prefix('#').unwrap_or("");
    v.starts_with('#') && (h.len() == 6 || h.len() == 8) && h.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn set_caption_track(c: &mut Cx, a: &Json) -> R<Out> {
    let id = s(a, "track_id").unwrap_or_default();
    let Some(t) = c.seq().captions.iter().find(|x| x.id.as_str() == id).map(|x| x.id) else {
        return refuse(format!("There is no caption track {id}. get_sequence lists them (captionTracks)."));
    };
    let mut patch = Map::new();
    for (k, key) in [("name", "name"), ("lang", "lang"), ("sync_lock", "syncLock")] {
        if let Some(v) = a.get(k) {
            patch.insert(key.into(), v.clone());
        }
    }
    let empty = json!({});
    let st = arg(a, "style").unwrap_or(&empty);
    let mut style = Map::new();
    for k in ["font", "size", "weight", "position", "margin", "highlight"] {
        if let Some(v) = st.get(k) {
            style.insert(k.into(), v.clone());
        }
    }
    for (k, key) in [("color", "color"), ("highlight_color", "highlightColor")] {
        if let Some(v) = st.get(k) {
            if !v.as_str().is_some_and(color8) {
                return refuse(format!("style.{k} must look like #ffffff."));
            }
            style.insert(key.into(), v.clone());
        }
    }
    if let Some(v) = st.get("background") {
        if !(v.is_null() || v.as_str().is_some_and(color8)) {
            return refuse("style.background must look like #00000099 or be null.");
        }
        style.insert("background".into(), if v.is_null() { json!("transparent") } else { v.clone() });
    }
    if let Some(v) = st.get("highlight_mode") {
        style.insert("highlightMode".into(), v.clone());
    }
    if let Some(v) = st.get("speakers").and_then(Json::as_str) {
        style.insert("speakerColor".into(), json!(v == "color" || v == "both"));
        style.insert("speakerName".into(), json!(v == "name" || v == "both"));
    }
    if !style.is_empty() {
        patch.insert("style".into(), Json::Object(style));
    }
    let shown = b(a, "shown") == Some(true);
    if patch.is_empty() && !shown {
        return refuse("Give something to change.");
    }
    let seq = c.seq_id();
    let changed = !patch.is_empty();
    if changed {
        c.run(&C::set_caption_track(seq.as_str(), t.as_str(), Json::Object(patch)))?;
    }
    if shown {
        c.host.show_caption_track(seq, t);
    }
    Ok(if changed {
        json!({ "edit": { "at": c.host.app().t }, "track": t.as_str() })
    } else {
        json!({ "track": t.as_str(), "shown": true })
    }
    .into())
}

pub fn add_color_matte(c: &mut Cx, a: &Json) -> R<Out> {
    let color = s(a, "color").unwrap_or("#2f6fdb").to_lowercase();
    if !(color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|x| x.is_ascii_hexdigit())) {
        return refuse("color must look like #2f6fdb.");
    }
    let (at, d) = still_span(c, a)?;
    let track = match s(a, "track") {
        Some(t) => Some(c.track_of(t, Some(TrackKind::Video), true)?.id.as_str().to_owned()),
        None => None,
    };
    let name = s(a, "name").filter(|x| !x.is_empty()).unwrap_or("Color Matte").to_owned();
    let (id, track) = c.atomic("Add Graphic", |c| {
        let track = free_video_track(c, track.as_deref(), at, d)?;
        let opts = json!({ "track": track, "at": at, "duration": d, "name": name, "source": { "generator": "solid", "color": color } });
        Ok((c.run(&C::add_generated(c.seq_id().as_str(), opts))?["id"].clone(), track))
    })?;
    Ok(json!({ "edit": { "at": at }, "clip": id, "track": track }).into())
}

pub fn set_project_settings(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    let fr = cut_model::query::frame(cut_time::Fps::new(30, 1));
    let ticks_of = |x: f64| (round(x * T / fr as f64) as i64 * fr).max(fr);
    let mut patch = Map::new();
    for (k, key) in [
        ("still_duration", "stillDuration"),
        ("transition_duration", "transitionDuration"),
        ("freeze_duration", "freezeDuration"),
    ] {
        if let Some(v) = f(a, k) {
            patch.insert(key.into(), json!(ticks_of(v)));
        }
    }
    if let Some(v) = a.get("fit") {
        patch.insert("fit".into(), v.clone());
    }
    if let Some(list) = strs(a, "speech_terms") {
        let mut seen: Vec<String> = Vec::new();
        for x in list {
            let t = x.split_whitespace().collect::<Vec<_>>().join(" ");
            if !t.is_empty() && !seen.contains(&t) {
                seen.push(t);
            }
        }
        patch.insert("speechTerms".into(), json!(seen));
    }
    if patch.is_empty() {
        return refuse("Give something to change.");
    }
    c.run(&C::set_settings(Json::Object(patch)))?;
    Ok(json!({ "edit": { "at": c.host.app().t } }).into())
}

pub fn save_project(c: &mut Cx, _a: &Json) -> R<Out> {
    c.context(None)?;
    let Some(mut task) = c.host.save() else { return refuse("Saving is not available here.") };
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        Some(if r["declined"] == true {
            refuse("The user did not pick a place to save. Nothing was written.")
        } else if r["ok"] != true {
            refuse(format!("The project could not be saved: {}", r["error"].as_str().unwrap_or("unknown error")))
        } else {
            Ok(json!({ "saved": r["name"] }))
        })
    })))
}

pub fn export_frame(c: &mut Cx, a: &Json) -> R<Out> {
    if c.duration() == 0 {
        return refuse("The sequence is empty.");
    }
    let last = (c.duration() - c.f()).max(0);
    let t = match f(a, "time") {
        None => c.host.app().t.min(last),
        Some(x) => c.time_in(x, "time", false)?.min(last),
    };
    let name = file_name(a)?;
    let seq = c.seq_id();
    let Some(mut task) = c.host.export_frame(seq, t, name) else {
        return refuse("Exporting a frame is not available here.");
    };
    let time = c.sec(t as f64);
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        Some(if r["ok"] == true {
            Ok(json!({ "saved": r["name"], "time": time }))
        } else if r["declined"] == true {
            refuse("The user said no. Nothing was written.")
        } else {
            refuse(format!("The frame could not be saved: {}", r["error"].as_str().unwrap_or("unknown error")))
        })
    })))
}

pub fn export_captions(c: &mut Cx, a: &Json) -> R<Out> {
    let want = s(a, "track_id").filter(|x| !x.is_empty());
    let tracks = &c.seq().captions;
    let t = match want {
        Some(id) => match tracks.iter().find(|x| x.id.as_str() == id) {
            Some(t) => t,
            None => return refuse(format!("There is no caption track {id}.")),
        },
        None => match tracks.first() {
            Some(t) => t,
            None => return refuse("The sequence has no captions."),
        },
    };
    if t.items.is_empty() {
        return refuse(format!("Caption track {} is empty.", t.id.as_str()));
    }
    let name = file_name(a)?;
    let seq = c.seq_id();
    let format = s(a, "format").unwrap_or("srt").to_owned();
    let Some(mut task) = c.host.export_captions(seq, want.map(Id::new), &format, name) else {
        return refuse("Exporting captions is not available here.");
    };
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        Some(if r["ok"] == true {
            Ok(json!({ "saved": r["name"], "captions": r["count"] }))
        } else if r["declined"] == true {
            refuse("The user said no. Nothing was written.")
        } else {
            refuse(format!("The captions could not be saved: {}", r["error"].as_str().unwrap_or("unknown error")))
        })
    })))
}

pub fn export_queue(c: &mut Cx, a: &Json) -> R<Out> {
    let Some(jobs) = c.host.queue_jobs() else { return refuse("The export queue is not available here.") };
    let action = s(a, "action").unwrap_or("list");
    if action != "list" && action != "clear_finished" {
        let Some(id) = f(a, "job_id") else { return refuse(format!("{action} needs job_id.")) };
        let Some(job) = jobs.iter().find(|j| j["id"].as_f64() == Some(id)) else {
            return refuse(format!("There is no job {}. export_queue lists them.", crate::control::schema::js_num(id)));
        };
        let state = job["state"].as_str().unwrap_or_default();
        let allowed = match action {
            "cancel" => state == "waiting" || state == "running",
            "retry" => state == "failed" || state == "cancelled",
            _ => state != "running",
        };
        let ok = allowed && c.host.queue_do(action, id as u64);
        if !ok {
            let what = match action {
                "remove" => "removed while it runs (cancel it first)",
                "cancel" => "cancelled",
                _ => "retried",
            };
            return refuse(format!("Job {} is {state}; it cannot be {what}.", crate::control::schema::js_num(id)));
        }
    } else if action == "clear_finished" {
        c.host.queue_do("clearFinished", 0);
    }
    let list: Vec<Json> = c
        .host
        .queue_jobs()
        .unwrap_or_default()
        .iter()
        .map(|j| {
            let mut o = json!({
                "id": j["id"], "file": j["name"], "sequence": j["seqName"], "preset": j["presetName"], "state": j["state"],
                "progress": num(r3(j["fraction"].as_f64().unwrap_or(0.0))),
            });
            if j["error"].as_str().is_some_and(|e| !e.is_empty()) {
                o["error"] = j["error"].clone();
            }
            o
        })
        .collect();
    Ok(json!({ "jobs": list }).into())
}

pub fn proxies(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    if !c.host.has_proxies() {
        return refuse("Proxies are not available here.");
    }
    let ids: Vec<String> = match strs(a, "media_ids") {
        Some(l) => l,
        None => c
            .project()
            .media
            .iter()
            .filter(|m| m.kind == cut_model::MediaKind::Video)
            .map(|m| m.id.as_str().to_owned())
            .collect(),
    };
    let mut all = Vec::new();
    for id in &ids {
        all.push(c.media_of(id)?);
    }
    let state = |h: &mut dyn crate::control::host::Host, all: &[cut_model::Media]| -> Json {
        Json::Array(
            all.iter()
                .map(|m| {
                    let mut o = json!({ "id": m.id.as_str(), "name": m.name });
                    if let Some(Json::Object(st)) = h.proxy_state(m.id) {
                        for (k, v) in st {
                            o[k] = v;
                        }
                    }
                    o
                })
                .collect(),
        )
    };
    let action = s(a, "action").unwrap_or("status");
    if action == "status" {
        return Ok(json!({ "media": state(c.host, &all) }).into());
    }
    let video: Vec<cut_model::Media> =
        all.iter().filter(|m| m.kind == cut_model::MediaKind::Video && m.video.is_some()).cloned().collect();
    if video.is_empty() {
        return refuse("None of these is a video; proxies are for video media.");
    }
    if action == "remove" {
        let with: Vec<Id> = video.iter().filter(|m| m.proxy.is_some()).map(|m| m.id).collect();
        if with.is_empty() {
            return refuse("None of these has a proxy.");
        }
        c.atomic("Remove Proxy", |c| {
            for id in &with {
                c.run(&C::set_proxy(id.as_str(), None))?;
            }
            Ok(())
        })?;
        return Ok(
            json!({ "edit": { "at": c.host.app().t }, "removed": with.iter().map(|i| i.as_str()).collect::<Vec<_>>() })
                .into(),
        );
    }
    for m in &video {
        if c.host.offline(m.id) {
            return refuse(format!("{} is offline (its file is missing); it cannot get a proxy.", m.id.as_str()));
        }
    }
    let vids: Vec<Id> = video.iter().map(|m| m.id).collect();
    let queued = c.host.proxy_create(&vids);
    if b(a, "wait") == Some(false) {
        return Ok(json!({ "queued": queued, "media": state(c.host, &all) }).into());
    }
    let Some(mut task) = c.host.proxy_wait(vids) else { return refuse("Proxies are not available here.") };
    let n = video.len();
    Ok(Out::Later(Box::new(move |h, live| {
        let w = task(h, live)?;
        Some(if w["cancelled"] == true {
            refuse(format!(
                "Stopped: the proxies not done yet were cancelled ({} of {n} ready).",
                w["done"].as_u64().unwrap_or(0)
            ))
        } else {
            Ok(json!({ "edit": { "at": h.app().t }, "media": state(h, &all) }))
        })
    })))
}

/// ai.js `complement`: what is left out of [0, duration) when `keep` stays, latest first.
fn complement(keep: &[(i64, i64)], duration: i64) -> Vec<(i64, i64)> {
    let mut gaps = Vec::new();
    let mut at = 0;
    for &(x, y) in keep {
        if x > at {
            gaps.push((at, x));
        }
        at = at.max(y);
    }
    if duration > at {
        gaps.push((at, duration));
    }
    gaps.reverse();
    gaps
}

/// ai.js `shortsEdits`: each video clip's scale for the new frame, centred.
fn shorts_edits(p: &cut_model::Project, seq: &cut_model::Sequence, mode: &str) -> Vec<Json> {
    let fit = p.settings.get("fit").and_then(Json::as_str);
    let mut out = Vec::new();
    for x in seq.clips_in_order() {
        if seq.kind_of(x.track) != Some(TrackKind::Video) {
            continue;
        }
        let Some(v) = x.media_id().and_then(|m| p.media(m)).and_then(|m| m.video.as_ref()) else { continue };
        if !(v.w > 0.0 && v.h > 0.0) {
            continue;
        }
        let (sw, sh) = (seq.w as f64, seq.h as f64);
        let k = cut_engine::plan::fit_scale(v.w, v.h, sw, sh, Some(mode))
            / cut_engine::plan::fit_scale(v.w, v.h, sw, sh, fit);
        let mul = |v: &Json| -> Json {
            match v {
                Json::Array(l) => {
                    Json::Array(l.iter().map(|y| num(round(y.as_f64().unwrap_or(0.0) * k * 1000.0) / 1000.0)).collect())
                }
                y => num(round(y.as_f64().unwrap_or(0.0) * k * 1000.0) / 1000.0),
            }
        };
        let j = crate::control::call::cj(x);
        let (sid, cid) = (seq.id.as_str(), x.id.as_str());
        out.push(C::set_clip(
            sid,
            cid,
            json!({ "props": { "scale": mul(&j["props"]["scale"]), "position": [0, 0] } }),
            json!({ "linked": false }),
        ));
        if let Some(l) = j["keyframes"]["scale"].as_array().filter(|l| !l.is_empty()) {
            let list: Vec<Json> = l
                .iter()
                .map(|kf| {
                    let mut kf = kf.clone();
                    kf["v"] = mul(&kf["v"]);
                    kf
                })
                .collect();
            out.push(C::set_keyframes(sid, cid, "scale", Some(Json::Array(list))));
        }
        if j["keyframes"]["position"].as_array().is_some_and(|l| !l.is_empty()) {
            out.push(C::set_keyframes(sid, cid, "position", None));
        }
    }
    out
}

pub fn create_shorts(c: &mut Cx, a: &Json) -> R<Out> {
    let fr = c.f();
    let mut keep = Vec::new();
    for (i, x) in arg(a, "ranges").and_then(Json::as_array).into_iter().flatten().enumerate() {
        let r0 = c.time_in(f(x, "from").unwrap_or(0.0), &format!("ranges[{i}].from"), false)?;
        let r1 = c.time_in(f(x, "to").unwrap_or(0.0), &format!("ranges[{i}].to"), false)?;
        if r1 - r0 < fr {
            return refuse(format!("ranges[{i}] must end at least one frame after it starts."));
        }
        let snap = |t: i64| round(t as f64 / fr as f64) as i64 * fr;
        keep.push((snap(r0), snap(r1)));
    }
    keep.sort_by_key(|k| k.0);
    if keep.windows(2).any(|w| w[1].0 < w[0].1) {
        return refuse("The ranges overlap; give each part once.");
    }
    let src = c.seq().clone();
    let name = s(a, "name")
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map_or_else(|| format!("{} Shorts", src.name), str::to_owned);
    let mode = s(a, "mode").unwrap_or("fill").to_owned();
    let id = c.atomic("Create Shorts Sequence", |c| {
        let sid = c.run(&C::add_sequence(json!({ "from": src.id.as_str(), "name": name })))?["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let sq = |c: &Cx| c.project().sequence(Id::new(&sid)).cloned();
        let Some(s0) = sq(c) else { return refuse("The editor refused: the sequence is gone.") };
        for t in s0.tracks.iter().filter(|t| t.locked) {
            c.run(&C::set_track(&sid, t.id.as_str(), json!({ "locked": false })))?;
        }
        for ct in s0.captions.iter().filter(|t| !t.sync_lock) {
            c.run(&C::set_caption_track(&sid, ct.id.as_str(), json!({ "syncLock": true })))?;
        }
        c.run(&C::set_sequence(&sid, json!({ "w": 1080, "h": 1920 })))?;
        let Some(s1) = sq(c) else { return refuse("The editor refused: the sequence is gone.") };
        let end = std::iter::once(s1.duration())
            .chain(s1.captions.iter().flat_map(|t| t.items.iter().map(|it| it.end)))
            .chain(s1.markers.iter().map(|m| m.t + m.duration))
            .chain(std::iter::once(0))
            .max()
            .unwrap_or(0);
        for (x, y) in complement(&keep, end) {
            c.run(&C::extract(&sid, x, y, None))?;
        }
        let Some(s2) = sq(c) else { return refuse("The editor refused: the sequence is gone.") };
        for cmd in shorts_edits(c.project(), &s2, &mode) {
            c.run(&cmd)?;
        }
        Ok(sid)
    })?;
    let sid = Id::new(&id);
    c.host.app_mut().set_sequence(sid);
    let Some(q) = c.project().sequence(sid) else { return refuse("The editor refused: the sequence is gone.") };
    Ok(json!({ "edit": { "at": 0, "seqId": id }, "sequence": id, "name": q.name, "duration": num(r3(q.duration() as f64 / T)) }).into())
}
