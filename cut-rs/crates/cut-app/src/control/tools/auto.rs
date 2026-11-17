//! Automation, Essential Sound and the speakers (control-auto.js), and the graphic clips (control-graphic.js).

use std::collections::HashSet;

use cut_model::commands::build as C;
use cut_model::{Clip, Source, TrackKind};
use serde_json::{Map, Value as Json, json};

use super::more::{free_video_track, still_span};
use crate::control::call::{Cx, Out, R, arg, f, given, refuse, s, strs};
use crate::control::schema::js_num;

/// action -> the arguments it takes, and the model its setup names.
const JOBS: [(&str, &[&str], &str); 11] = [
    ("transcribe", &["clip_ids", "from", "to", "language"], "speech recognition (Whisper)"),
    (
        "auto_captions",
        &["clip_ids", "from", "to", "language", "chars_per_line", "highlight"],
        "speech recognition (Whisper)",
    ),
    (
        "remove_fillers",
        &["clip_ids", "from", "to", "fillers", "pauses", "pause_length", "keep"],
        "speech recognition (Whisper)",
    ),
    ("label_speakers", &["speakers"], "speaker labels (WeSpeaker)"),
    ("isolate_voice", &["clip_ids"], "voice isolation (HTDemucs)"),
    ("detect_scenes", &["clip_ids", "threshold", "mode"], ""),
    ("detect_beats", &["clip_ids", "every"], ""),
    ("match_loudness", &["target"], ""),
    ("match_clip_loudness", &["clip_ids", "target"], ""),
    ("auto_duck", &["amount", "fade", "threshold"], ""),
    ("auto_color", &["clip_ids", "time"], ""),
];

const ARGS: [&str; 18] = [
    "clip_ids",
    "from",
    "to",
    "language",
    "chars_per_line",
    "highlight",
    "fillers",
    "pauses",
    "pause_length",
    "keep",
    "speakers",
    "threshold",
    "mode",
    "every",
    "target",
    "amount",
    "fade",
    "time",
];

/// The chat's step line of each job.
pub fn job_step(action: &str) -> &'static str {
    match action {
        "transcribe" => "Recognize speech",
        "auto_captions" => "Create auto captions",
        "remove_fillers" => "Remove filler words",
        "label_speakers" => "Label speakers",
        "isolate_voice" => "Isolate the voice",
        "detect_scenes" => "Detect scene changes",
        "detect_beats" => "Detect beats",
        "match_loudness" => "Match loudness",
        "match_clip_loudness" => "Match clip loudness",
        "auto_duck" => "Auto ducking",
        _ => "Auto color",
    }
}

pub fn automation(c: &mut Cx, a: &Json) -> R<Out> {
    let action = s(a, "action").unwrap_or_default().to_owned();
    let Some(&(_, takes, model)) = JOBS.iter().find(|j| j.0 == action) else {
        return refuse(format!("action must be one of {}.", JOBS.map(|j| j.0).join(", ")));
    };
    for k in ARGS {
        if given(a, k) && !takes.contains(&k) {
            let list = if takes.is_empty() { "no other arguments".to_owned() } else { takes.join(", ") };
            return refuse(format!("{action} takes {list}; not {k}."));
        }
    }
    if arg(a, "from").is_none() != arg(a, "to").is_none() {
        return refuse("Give from and to together.");
    }
    let range = match (f(a, "from"), f(a, "to")) {
        (Some(x), Some(y)) => {
            let r = (c.time_in(x, "from", false)?, c.time_in(y, "to", false)?);
            if r.1 - r.0 < c.f() {
                return refuse("\"to\" must be after \"from\".");
            }
            Some(r)
        }
        _ => None,
    };
    let threshold = f(a, "threshold");
    if action == "detect_scenes" && threshold.is_some_and(|t| t < 5.0) {
        return refuse("threshold of detect_scenes is 5..95 (%).");
    }
    if action == "auto_duck" && threshold.is_some_and(|t| t > -5.0) {
        return refuse("threshold of auto_duck is -90..-5 (dB).");
    }
    let mut clips: Vec<Clip> = Vec::new();
    for id in strs(a, "clip_ids").unwrap_or_default() {
        clips.push(c.clip_of(&id, true)?);
    }
    let seq = c.seq();
    let sound = |x: &Clip| {
        seq.kind_of(x.track) == Some(TrackKind::Audio)
            || seq.linked_clips(x).iter().any(|l| seq.kind_of(l.track) == Some(TrackKind::Audio))
    };
    let picture = |x: &Clip| seq.kind_of(x.track) == Some(TrackKind::Video) && matches!(x.source, Source::Media { .. });
    let need: Option<(bool, &str)> = match action.as_str() {
        "isolate_voice" | "match_clip_loudness" => Some((true, "a clip with sound")),
        "detect_beats" => Some((true, "an audio clip")),
        "detect_scenes" | "auto_color" => Some((false, "a video clip of a media file")),
        _ => None,
    };
    if let Some((want_sound, what)) = need {
        for x in &clips {
            if !(if want_sound { sound(x) } else { picture(x) }) {
                return refuse(format!("{} is not {what}.", x.id.as_str()));
            }
        }
    }
    if action == "auto_color" && clips.len() > 1 {
        return refuse("auto_color works on one clip at a time.");
    }
    if action == "auto_color"
        && let Some(time) = f(a, "time")
    {
        let t = c.time_in(time, "time", false)?;
        if let Some(x) = clips.first()
            && (t < x.start || t >= x.end())
        {
            return refuse(format!("time {} s is outside {}.", js_num(time), x.id.as_str()));
        }
    }
    let mut args = a.clone();
    args["range"] = range.map_or(Json::Null, |(x, y)| json!([x, y]));
    args["clipIds"] = arg(a, "clip_ids").cloned().unwrap_or(Json::Null);
    let seq_id = c.seq_id();
    let Some(mut task) = c.host.automation(&action, &args, seq_id) else {
        return refuse("Automation is not available here.");
    };
    let model = model.to_owned();
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        if r["declined"] == true {
            return Some(refuse(format!(
                "The user did not agree to set up {model} in Cut's setup dialog, so nothing was downloaded or changed. Tell them it is needed and that they can download it when Cut asks."
            )));
        }
        if r["cancelled"] == true {
            return Some(refuse(format!("{action} was stopped. Nothing was changed.")));
        }
        if r["ok"] != true {
            return Some(refuse(
                r["error"].as_str().map_or_else(|| format!("{action} changed nothing."), str::to_owned),
            ));
        }
        let mut out = Map::new();
        if r["changed"] == true {
            let mut e = json!({ "at": r.get("at").filter(|x| !x.is_null()).cloned().unwrap_or(json!(h.app().t)) });
            if let Some(sid) = r.get("seqId").filter(|x| !x.is_null()) {
                e["seqId"] = sid.clone();
            }
            out.insert("edit".into(), e);
        }
        if let Some(v) = r["value"].as_object() {
            out.extend(v.clone());
        }
        Some(Ok(Json::Object(out)))
    })))
}

pub fn essential_sound(c: &mut Cx, a: &Json) -> R<Out> {
    let action = s(a, "action").unwrap_or_default();
    let (name, label) = match action {
        "clarity" => ("clarity", "Clarity"),
        "reduce_hum_50" => ("hum50", "Reduce Hum"),
        "reduce_hum_60" => ("hum60", "Reduce Hum"),
        "noise_gate" => ("gate", "Noise Gate"),
        _ => ("limit", "Hard Limiter"),
    };
    let mut out: Vec<Clip> = Vec::new();
    let mut seen = HashSet::new();
    for id in strs(a, "clip_ids").unwrap_or_default() {
        let x = c.clip_of(&id, true)?;
        let seq = c.seq();
        let audio: Vec<String> = std::iter::once(&x)
            .chain(seq.linked_clips(&x))
            .filter(|y| seq.kind_of(y.track) == Some(TrackKind::Audio))
            .map(|y| y.id.as_str().to_owned())
            .collect();
        if audio.is_empty() {
            return refuse(format!("{} has no sound.", x.id.as_str()));
        }
        for y in audio {
            let clip = c.clip_of(&y, true)?;
            if seen.insert(clip.id) {
                out.push(clip);
            }
        }
    }
    let preset = crate::audio::essential::preset(name);
    let seq = c.seq_id();
    let cmds: Vec<Json> = out
        .iter()
        .flat_map(|x| preset.iter().map(move |(ty, p)| C::add_effect(seq.as_str(), x.id.as_str(), ty, None, p.clone())))
        .collect();
    c.run(&C::batch(label, cmds))?;
    let first = out.iter().map(|x| x.start).min().unwrap_or(0);
    Ok(json!({
        "edit": { "at": first }, "clips": out.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
        "effects": preset.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
    })
    .into())
}

pub fn speakers(c: &mut Cx, a: &Json) -> R<Out> {
    c.context(None)?;
    let sp = c.project().speakers.clone().filter(|v| !v.is_null());
    let list = |p: &cut_model::Project| -> Vec<Json> {
        p.speakers
            .as_ref()
            .and_then(|v| v["list"].as_array())
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(i, x)| {
                let name = x["name"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .map_or_else(|| format!("Speaker {}", i + 1), str::to_owned);
                let mut o = json!({ "id": x["id"], "name": name });
                if let Some(col) = x.get("color") {
                    o["color"] = col.clone();
                }
                o
            })
            .collect()
    };
    if s(a, "action").unwrap_or("list") == "list" {
        if given(a, "speaker_id") || given(a, "name") {
            return refuse("list takes nothing else.");
        }
        let mut o = json!({ "speakers": list(c.project()) });
        if sp.is_none() {
            o["note"] = json!("There are no speaker labels yet (automation label_speakers makes them).");
        }
        return Ok(o.into());
    }
    let entries: Vec<Json> = sp.as_ref().and_then(|v| v["list"].as_array().cloned()).unwrap_or_default();
    if entries.is_empty() {
        return refuse("There are no speaker labels yet; run automation label_speakers first.");
    }
    let (Some(id), Some(name)) = (s(a, "speaker_id"), s(a, "name")) else {
        return refuse("rename needs speaker_id and name.");
    };
    if !entries.iter().any(|x| x["id"].as_str() == Some(id)) {
        let ids: Vec<&str> = entries.iter().filter_map(|x| x["id"].as_str()).collect();
        return refuse(format!("There is no speaker {id}. Speakers: {}.", ids.join(", ")));
    }
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let next: Vec<Json> = entries
        .iter()
        .map(|x| {
            let mut x = x.clone();
            if x["id"].as_str() == Some(id) {
                x["name"] = json!(name);
            }
            x
        })
        .collect();
    c.run(&C::batch("Rename Speaker", vec![C::set_speakers(Some(json!({ "list": next })))]))?;
    Ok(json!({ "edit": { "at": c.host.app().t }, "speakers": list(c.project()) }).into())
}

/// `withIds`: the layers with an id each; given ids stay, the others get `g<n>` not used yet.
fn with_ids(layers: &[Json], taken: &[String]) -> Vec<Json> {
    let mut used: HashSet<String> = taken.iter().cloned().collect();
    used.extend(layers.iter().filter_map(|l| l["id"].as_str().filter(|x| !x.is_empty()).map(str::to_owned)));
    let mut n = 0;
    layers
        .iter()
        .map(|l| {
            if l["id"].as_str().is_some_and(|x| !x.is_empty()) {
                return l.clone();
            }
            let id = loop {
                n += 1;
                let id = format!("g{n}");
                if !used.contains(&id) {
                    break id;
                }
            };
            used.insert(id.clone());
            let mut l = l.clone();
            l["id"] = json!(id);
            l
        })
        .collect()
}

fn layer_ids(l: &[Json]) -> Vec<String> {
    l.iter().filter_map(|x| x["id"].as_str().map(str::to_owned)).collect()
}

pub fn add_graphic(c: &mut Cx, a: &Json) -> R<Out> {
    let layers = with_ids(arg(a, "layers").and_then(Json::as_array).map_or(&[][..], Vec::as_slice), &[]);
    let bad = cut_model::graphic::validate(Some(&Json::Array(layers.clone())));
    if !bad.is_empty() {
        return refuse(format!("The graphic is not valid: {}.", bad.join("; ")));
    }
    let (at, d) = still_span(c, a)?;
    let track = match s(a, "track") {
        Some(t) => Some(c.track_of(t, Some(TrackKind::Video), true)?.id.as_str().to_owned()),
        None => None,
    };
    let name = s(a, "name").filter(|x| !x.is_empty()).unwrap_or("Graphic").to_owned();
    let (id, track) = c.atomic("Add Graphic", |c| {
        let track = free_video_track(c, track.as_deref(), at, d)?;
        let opts = json!({ "track": track, "at": at, "duration": d, "name": name, "source": { "generator": "graphic", "layers": layers } });
        Ok((c.run(&C::add_generated(c.seq_id().as_str(), opts))?["id"].as_str().unwrap_or_default().to_owned(), track))
    })?;
    let ids = match c.seq().clip(cut_model::Id::new(&id)).map(|x| &x.source) {
        Some(Source::Generator { layers: Some(l), .. }) => layer_ids(l),
        _ => Vec::new(),
    };
    Ok(json!({ "edit": { "at": at }, "clip": id, "track": track, "layers": ids }).into())
}

pub fn set_graphic(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let Source::Generator { generator: cut_model::Generator::Graphic, layers: now, .. } = &clip.source else {
        return refuse(format!("{} is not a graphic clip (add_graphic makes one).", clip.id.as_str()));
    };
    let now = now.clone().unwrap_or_default();
    let list = |k: &str| arg(a, k).and_then(Json::as_array).cloned();
    let (all, update, add, remove) = (list("layers"), list("update"), list("add"), list("remove"));
    if all.is_some() && (update.is_some() || add.is_some() || remove.is_some()) {
        return refuse("Give layers alone, or update, add and remove.");
    }
    let empty = |v: &Option<Vec<Json>>| v.as_ref().is_none_or(Vec::is_empty);
    if all.is_none() && empty(&update) && empty(&add) && empty(&remove) {
        return refuse("Nothing to change: give layers, update, add or remove.");
    }
    let id = clip.id.as_str();
    let mut next: Vec<Json> = match &all {
        Some(l) => with_ids(l, &layer_ids(&now)),
        None => now.clone(),
    };
    let names = |l: &[Json]| layer_ids(l).join(", ");
    for r in remove.iter().flatten() {
        let rid = r.as_str().unwrap_or_default();
        if !next.iter().any(|l| l["id"].as_str() == Some(rid)) {
            return refuse(format!("{id} has no layer {rid}. Layers: {}.", names(&next)));
        }
        next.retain(|l| l["id"].as_str() != Some(rid));
    }
    let mut added = Vec::new();
    for (i, x) in add.iter().flatten().enumerate() {
        let mut given = x.clone();
        let after = given.as_object_mut().and_then(|o| o.remove("after"));
        let taken: Vec<String> = layer_ids(&next).into_iter().chain(layer_ids(&now)).collect();
        let layer = with_ids(&[given], &taken).remove(0);
        let lid = layer["id"].as_str().unwrap_or_default().to_owned();
        let at = match after.as_ref().and_then(Json::as_str).filter(|x| !x.is_empty()) {
            Some(w) => match next.iter().position(|l| l["id"].as_str() == Some(w)) {
                Some(p) => p,
                None => return refuse(format!("add[{i}].after: {id} has no layer {w}.")),
            },
            None => next.len().wrapping_sub(1),
        };
        next.insert(at.wrapping_add(1), layer);
        added.push(lid);
    }
    for u in update.iter().flatten() {
        let uid = u["id"].as_str().unwrap_or_default();
        let Some(l) = next.iter_mut().find(|x| x["id"].as_str() == Some(uid)) else {
            return refuse(format!("{id} has no layer {uid}. Layers: {}.", names(&next)));
        };
        if let Some(k) = u.get("kind")
            && *k != l["kind"]
        {
            return refuse(format!(
                "Layer {uid} is a {}; a layer keeps its kind (remove it and add another).",
                l["kind"].as_str().unwrap_or_default()
            ));
        }
        if let (Some(o), Some(p)) = (l.as_object_mut(), u.as_object()) {
            o.extend(p.clone());
        }
    }
    let bad = cut_model::graphic::validate(Some(&Json::Array(next.clone())));
    if !bad.is_empty() {
        return refuse(format!("The graphic would not be valid: {}.", bad.join("; ")));
    }
    if next.is_empty() {
        return refuse("A graphic keeps one layer at least; delete_clips removes the clip.");
    }
    let seq = c.seq_id();
    c.atomic("Edit Graphic", |c| c.run(&C::set_generator(seq.as_str(), id, json!({ "layers": next }))))?;
    let fr = c.f();
    let at = clip.start.max(c.host.app().t.min(clip.end() - fr));
    let ids = match c.seq().clip(clip.id).map(|x| &x.source) {
        Some(Source::Generator { layers: Some(l), .. }) => layer_ids(l),
        _ => Vec::new(),
    };
    let mut o = json!({ "edit": { "at": at }, "layers": ids });
    if !added.is_empty() {
        o["added"] = json!(added);
    }
    Ok(o.into())
}
