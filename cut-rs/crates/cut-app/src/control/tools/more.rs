//! Transitions, titles, captions, markers, masks, nesting, tracks, the sequence, silences, the selection and the
//! playhead, undo, and the sequence export (control.js).

use cut_model::TrackKind;
use cut_model::commands::build as C;
use cut_time::TICKS;
use serde_json::{Map, Value as Json, json};

use super::clip::{param_value, prop_value, shape_path};
use super::edit::{Op, plan};
use crate::control::call::{Cx, Out, R, arg, b, f, given, num, plain_name, r3, refuse, round, s, strs};
use crate::control::schema::js_num;

const T: f64 = TICKS as f64;

fn color8(v: &str) -> bool {
    let h = v.strip_prefix('#').unwrap_or("");
    v.starts_with('#') && (h.len() == 6 || h.len() == 8) && h.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn add_transition(c: &mut Cx, a: &Json) -> R<Out> {
    let t = c.track_of(s(a, "track").unwrap_or_default(), None, true)?;
    let kind =
        if t.kind == TrackKind::Audio { cut_model::effects::Kind::Audio } else { cut_model::effects::Kind::Video };
    let ty = s(a, "type").map_or_else(|| cut_model::effects::default_transition(kind).to_owned(), str::to_owned);
    let Some(def) = cut_model::effects::transitions(None).find(|d| d.id == ty) else {
        return refuse(format!("There is no transition \"{ty}\". list_effects lists them."));
    };
    let tk = if t.kind == TrackKind::Audio { "audio" } else { "video" };
    if def.kind != kind {
        return refuse(format!("{ty} is a {} transition and {} a {tk} track.", def.kind.name(), t.id.as_str()));
    }
    let at_s = f(a, "at").unwrap_or(0.0);
    let at = c.ticks(at_s);
    let mut edge: Option<i64> = None;
    for x in c.seq().clips_in_order().filter(|x| x.track == t.id) {
        for e in [x.start, x.end()] {
            if edge.is_none_or(|b| (e - at).abs() < (b - at).abs()) {
                edge = Some(e);
            }
        }
    }
    let Some(edge) = edge.filter(|e| (e - at).abs() <= c.f()) else {
        return refuse(format!(
            "There is no clip edge on {} at {} s{}.",
            t.id.as_str(),
            js_num(at_s),
            edge.map(|e| format!("; the nearest is at {} s", c.sec(e as f64))).unwrap_or_default()
        ));
    };
    let mut params = Map::new();
    for (k, v) in arg(a, "params").and_then(Json::as_object).into_iter().flatten() {
        params.insert(k.clone(), param_value(def, k, v, &format!("params.{k}"), None)?);
    }
    // Without an alignment asked for: centred on a cut between two clips; at a clip's free end inside the clip, as the
    // timeline's own Apply Transition places it. Centred there, half of it lay outside the clip and a fade stopped
    // half way (the last frame of a 0.8 s fade out was still at 36 % of its brightness).
    let align = s(a, "align").unwrap_or_else(|| crate::edit::actions::align_at(c.seq(), t.id, edge));
    let mut opts = json!({ "track": t.id.as_str(), "at": edge, "type": ty, "align": align, "params": params });
    if let Some(d) = f(a, "duration") {
        opts["duration"] = json!(c.ticks(d));
    }
    let r = c.run(&C::add_transition(c.seq_id().as_str(), opts))?;
    let mut out = json!({ "edit": { "at": edge }, "transition": r["id"] });
    // said only when it is not the schema's default, so the caller knows where the transition lies
    if align != "center" {
        out["align"] = json!(align);
    }
    Ok(out.into())
}

pub fn remove_transition(c: &mut Cx, a: &Json) -> R<Out> {
    let id = s(a, "transition_id").unwrap_or_default();
    let Some(t) = c.seq().transitions.iter().find(|x| x.id.as_str() == id).cloned() else {
        return refuse(format!("There is no transition {id}."));
    };
    c.track_of(t.track.as_str(), None, true)?;
    c.run(&C::remove_transition(c.seq_id().as_str(), t.id.as_str()))?;
    Ok(json!({ "edit": { "at": t.at } }).into())
}

/// `layerPatch(a)`: a title layer's fields from the arguments.
fn layer_patch(a: &Json) -> R<Map<String, Json>> {
    let mut p = Map::new();
    let color = |v: Option<&str>, at: &str| -> R<Json> {
        match v {
            Some(x) if color8(x) => Ok(json!(x)),
            _ => refuse(format!("{at} must look like #ffffff.")),
        }
    };
    if let Some(v) = a.get("text") {
        p.insert("text".into(), v.clone());
    }
    if given(a, "color") {
        p.insert("fill".into(), color(s(a, "color"), "color")?);
    }
    for k in ["size", "font", "weight", "italic", "align", "tracking", "leading"] {
        if let Some(v) = a.get(k) {
            p.insert(k.into(), v.clone());
        }
    }
    if let Some(v) = a.get("position") {
        p.insert("position".into(), prop_value("position", v)?);
    }
    if let Some(v) = a.get("box") {
        let x = if v.is_null() {
            Json::Null
        } else {
            json!({ "color": color(v.as_str(), "box")?, "padding": 16, "radius": 6 })
        };
        p.insert("box".into(), x);
    }
    if let Some(v) = a.get("stroke") {
        let x = if v.is_null() {
            Json::Null
        } else {
            json!({ "color": color(s(v, "color"), "stroke.color")?, "width": f(v, "width").map_or(json!(4), num) })
        };
        p.insert("stroke".into(), x);
    }
    if let Some(v) = a.get("shadow") {
        let x = if v.is_null() {
            Json::Null
        } else {
            json!({
                "color": color(Some(s(v, "color").unwrap_or("#000000aa")), "shadow.color")?,
                "blur": f(v, "blur").map_or(json!(8), num), "x": f(v, "x").map_or(json!(0), num), "y": f(v, "y").map_or(json!(4), num),
            })
        };
        p.insert("shadow".into(), x);
    }
    Ok(p)
}

/// The track a new generated clip goes on: `track`, else the lowest free unlocked video track above the clips at
/// `at..at + d`, else a new one (in the caller's group).
pub fn free_video_track(c: &mut Cx, track: Option<&str>, at: i64, d: i64) -> R<String> {
    if let Some(t) = track {
        return Ok(t.to_owned());
    }
    let seq = c.seq();
    let vids: Vec<&cut_model::Track> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).collect();
    let busy = |tid: cut_model::Id| seq.clips_in_order().any(|x| x.track == tid && x.start < at + d && x.end() > at);
    let top = vids.iter().rposition(|t| busy(t.id));
    let free = vids[top.map_or(0, |i| i + 1)..].iter().find(|t| !t.locked).map(|t| t.id.as_str().to_owned());
    match free {
        Some(t) => Ok(t),
        None => {
            let r = c.run(&C::add_track(c.seq_id().as_str(), "video", None, json!({})))?;
            Ok(r["id"].as_str().unwrap_or_default().to_owned())
        }
    }
}

/// How far after the sequence's end a made clip may start (seconds).
const PAST_END: f64 = 3600.0;

/// The start and length of a new still, title or graphic (`at` snapped, `duration` in frames or the project's).
pub fn still_span(c: &Cx, a: &Json) -> R<(i64, i64)> {
    // A made clip needs no material at its place, so it may go after the sequence's end as a clip dragged on the
    // timeline may (a title at 5 s of an empty sequence was refused as "outside the sequence (0 to 0 s)"); not
    // further than an hour past it, which is a mistaken time and not a plan.
    let at_s = f(a, "at").unwrap_or(0.0);
    let end = c.duration() as f64 / cut_time::TICKS as f64;
    if at_s > end + PAST_END {
        return refuse(format!(
            "at {} s is more than an hour after the sequence's end ({} s); a new clip goes inside the sequence or within an hour after it.",
            js_num(at_s),
            js_num(r3(end))
        ));
    }
    let at = cut_time::snap(c.time_in(at_s, "at", true)?, c.fps(), false);
    let fr = c.f();
    let still = c.project().settings.get("stillDuration").and_then(Json::as_f64).unwrap_or(0.0) as i64;
    let d = match f(a, "duration") {
        Some(x) => round(c.ticks(x) as f64 / fr as f64) as i64 * fr,
        None => still,
    };
    Ok((at, d.max(fr)))
}

pub fn add_text(c: &mut Cx, a: &Json) -> R<Out> {
    let text = s(a, "text").unwrap_or_default().to_owned();
    if text.trim().is_empty() {
        return refuse("The text is empty.");
    }
    let (at, d) = still_span(c, a)?;
    let track = match s(a, "track") {
        Some(t) => Some(c.track_of(t, Some(TrackKind::Video), true)?.id.as_str().to_owned()),
        None => None,
    };
    let mut layer = layer_patch(a)?;
    layer.insert("text".into(), json!(text));
    let name: String = text.split('\n').next().unwrap_or_default().chars().take(60).collect();
    let (id, track) = c.atomic("Add Text", |c| {
        let track = free_video_track(c, track.as_deref(), at, d)?;
        let opts = json!({ "track": track, "at": at, "duration": d, "name": name, "source": { "generator": "text", "layers": [layer] } });
        let r = c.run(&C::add_generated(c.seq_id().as_str(), opts))?;
        Ok((r["id"].clone(), track))
    })?;
    Ok(json!({ "edit": { "at": at }, "clip": id, "track": track }).into())
}

pub fn set_text(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let cut_model::Source::Generator { generator: cut_model::Generator::Text, layers, .. } = &clip.source else {
        return refuse(format!("{} is not a text clip.", clip.id.as_str()));
    };
    let layers = layers.clone().unwrap_or_default();
    let patch = layer_patch(a)?;
    let (seq, id) = (c.seq_id(), clip.id);
    let layer_id = s(a, "layer_id");
    let add = b(a, "add_layer") == Some(true);
    let animation = s(a, "animation");
    if b(a, "remove_layer") == Some(true) {
        if layer_id.is_none() || !patch.is_empty() || add || animation.is_some() {
            return refuse("remove_layer takes layer_id and nothing else.");
        }
        let lid = layer_id.unwrap_or_default();
        if !layers.iter().any(|l| l["id"].as_str() == Some(lid)) {
            return refuse(format!("{} has no text layer {lid}.", id.as_str()));
        }
        if layers.len() == 1 {
            return refuse("A title keeps one layer at least; delete_clips removes the title.");
        }
        c.run(&C::remove_layer(seq.as_str(), id.as_str(), lid))?;
        return Ok(json!({ "edit": { "at": clip.start }, "clip": id.as_str() }).into());
    }
    if add && layer_id.is_some() {
        return refuse("add_layer makes a new layer: leave out layer_id.");
    }
    if add && patch.get("text").and_then(Json::as_str).is_none_or(|t| t.trim().is_empty()) {
        return refuse("A new layer needs text.");
    }
    let layer = if add {
        None
    } else {
        let l = match layer_id {
            Some(w) => layers.iter().find(|l| l["id"].as_str() == Some(w)),
            None => layers.first(),
        };
        match l {
            Some(l) => Some(l["id"].as_str().unwrap_or_default().to_owned()),
            None => return refuse(format!("{} has no text layer {}.", id.as_str(), layer_id.unwrap_or("undefined"))),
        }
    };
    if patch.is_empty() && animation.is_none() {
        return refuse("Give something to change.");
    }
    let out = s(a, "animation_at") == Some("out");
    let fr = c.f();
    let lid = c.atomic("Edit Text", |c| {
        let lid = match &layer {
            None => c.run(&C::add_layer(seq.as_str(), id.as_str(), Json::Object(patch.clone()), None))?["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            Some(l) => l.clone(),
        };
        if layer.is_some() && !patch.is_empty() {
            c.run(&C::set_layer(seq.as_str(), id.as_str(), &lid, Json::Object(patch.clone())))?;
        }
        if let Some(anim) = animation {
            let now = c.seq().clip(id).cloned();
            let keys = now.and_then(|n| crate::text_ui::presets::apply(&n, &lid, anim, out, fr)).unwrap_or_default();
            for (prop, list) in keys {
                c.run(&C::set_keyframes(
                    seq.as_str(),
                    id.as_str(),
                    &prop,
                    Some(serde_json::to_value(list).unwrap_or_default()),
                ))?;
            }
        }
        Ok(lid)
    })?;
    Ok(json!({ "edit": { "at": clip.start }, "clip": id.as_str(), "layer": lid }).into())
}

fn caption_items(c: &Cx, items: &[Json]) -> R<Vec<(i64, i64, String)>> {
    let mut out = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let a0 = c.time_in(f(it, "start").unwrap_or(0.0), &format!("items[{i}].start"), false)?;
        let b0 = c.time_in(f(it, "end").unwrap_or(0.0), &format!("items[{i}].end"), c.duration() == 0)?;
        if b0 - a0 < c.f() {
            return refuse(format!("items[{i}] must end at least one frame after it starts."));
        }
        let text = s(it, "text").unwrap_or_default();
        if text.trim().is_empty() {
            return refuse(format!("items[{i}] has no text."));
        }
        out.push((a0, b0, text.to_owned()));
    }
    Ok(out)
}

fn caption_track(c: &Cx, id: &str) -> R<cut_model::CaptionTrack> {
    match c.seq().captions.iter().find(|t| t.id.as_str() == id) {
        Some(t) => Ok(t.clone()),
        None => refuse(format!("There is no caption track {id}. get_sequence lists them (captionTracks).")),
    }
}

pub fn add_captions(c: &mut Cx, a: &Json) -> R<Out> {
    let items = caption_items(c, arg(a, "items").and_then(Json::as_array).map_or(&[][..], Vec::as_slice))?;
    let seq = c.seq_id();
    let first = items.iter().map(|x| x.0).min().unwrap_or(0);
    let id = match s(a, "track_id").filter(|x| !x.is_empty()) {
        Some(tid) => {
            let t = caption_track(c, tid)?;
            c.atomic("Add Caption", |c| {
                for (x, y, text) in &items {
                    c.run(&C::add_caption(seq.as_str(), t.id.as_str(), json!({ "start": x, "end": y, "text": text })))?;
                }
                Ok(())
            })?;
            json!(tid)
        }
        None => {
            let list: Vec<Json> = items.iter().map(|(x, y, t)| json!({ "start": x, "end": y, "text": t })).collect();
            let opts = json!({ "name": s(a, "name").filter(|x| !x.is_empty()).unwrap_or("Captions"), "lang": s(a, "lang").filter(|x| !x.is_empty()).unwrap_or("ko"), "items": list });
            c.run(&C::add_caption_track(seq.as_str(), opts))?["id"].clone()
        }
    };
    Ok(json!({ "edit": { "at": first }, "track": id, "added": items.len() }).into())
}

pub fn set_caption(c: &mut Cx, a: &Json) -> R<Out> {
    let t = caption_track(c, s(a, "track_id").unwrap_or_default())?;
    let cid = s(a, "caption_id").unwrap_or_default();
    let Some(it) = t.items.iter().find(|x| x.id.as_str() == cid).cloned() else {
        return refuse(format!("Caption track {} has no caption {cid}.", t.id.as_str()));
    };
    let mut patch = Map::new();
    if let Some(text) = a.get("text") {
        if text.as_str().unwrap_or_default().trim().is_empty() {
            return refuse("The text is empty; remove_captions removes a caption.");
        }
        patch.insert("text".into(), text.clone());
    }
    let mut start = it.start;
    let mut end = it.end;
    if given(a, "start") {
        start = c.time_in(f(a, "start").unwrap_or(0.0), "start", false)?;
        patch.insert("start".into(), json!(start));
    }
    if given(a, "end") {
        end = c.time_in(f(a, "end").unwrap_or(0.0), "end", false)?;
        patch.insert("end".into(), json!(end));
    }
    if patch.is_empty() {
        return refuse("Give text, start or end.");
    }
    if end - start < c.f() {
        return refuse("The caption must end at least one frame after it starts.");
    }
    c.run(&C::set_caption(c.seq_id().as_str(), t.id.as_str(), it.id.as_str(), Json::Object(patch)))?;
    Ok(json!({ "edit": { "at": start } }).into())
}

pub fn remove_captions(c: &mut Cx, a: &Json) -> R<Out> {
    let t = caption_track(c, s(a, "track_id").unwrap_or_default())?;
    let seq = c.seq_id();
    if b(a, "whole_track") == Some(true) {
        c.run(&C::remove_caption_track(seq.as_str(), t.id.as_str()))?;
        return Ok(json!({ "edit": { "at": 0 }, "removedTrack": t.id.as_str() }).into());
    }
    let Some(ids) = strs(a, "caption_ids") else { return refuse("Give caption_ids, or whole_track: true.") };
    let mut items = Vec::new();
    for id in &ids {
        match t.items.iter().find(|x| x.id.as_str() == id) {
            Some(x) => items.push(x.clone()),
            None => return refuse(format!("Caption track {} has no caption {id}.", t.id.as_str())),
        }
    }
    c.atomic("Remove Caption", |c| {
        for it in &items {
            c.run(&C::remove_caption(seq.as_str(), t.id.as_str(), it.id.as_str()))?;
        }
        Ok(())
    })?;
    let first = items.iter().map(|x| x.start).min().unwrap_or(0);
    Ok(json!({ "edit": { "at": first }, "removed": items.len() }).into())
}

pub fn add_marker(c: &mut Cx, a: &Json) -> R<Out> {
    let at_s = f(a, "at").unwrap_or(0.0);
    let t = c.time_in(at_s, "at", false)?;
    let clip = match s(a, "clip_id").filter(|x| !x.is_empty()) {
        Some(id) => Some(c.clip_of(id, false)?),
        None => None,
    };
    if let Some(x) = &clip
        && (t < x.start || t > x.end())
    {
        return refuse(format!(
            "{} s is outside {} ({} to {} s).",
            js_num(at_s),
            x.id.as_str(),
            c.sec(x.start as f64),
            c.sec(x.end() as f64)
        ));
    }
    let kind = s(a, "kind").unwrap_or("comment");
    let color = s(a, "color").filter(|x| !x.is_empty()).unwrap_or(if kind == "chapter" { "blue" } else { "green" });
    let mut marker = json!({ "t": t, "name": s(a, "name").unwrap_or_default(), "kind": kind, "color": color });
    if let Some(n) = s(a, "note").filter(|x| !x.is_empty()) {
        marker["note"] = json!(n);
    }
    if let Some(d) = f(a, "duration").filter(|x| *x != 0.0) {
        marker["duration"] = json!(c.ticks(d));
    }
    let opts = clip.as_ref().map_or(json!({}), |x| json!({ "clipId": x.id.as_str() }));
    let r = c.run(&C::add_marker(c.seq_id().as_str(), marker, opts))?;
    Ok(json!({ "edit": { "at": t }, "marker": r["id"] }).into())
}

/// `markerOf`: a sequence marker or a clip marker by id -> (its id, its `t`).
fn marker_of(c: &Cx, id: &str) -> R<(String, i64)> {
    let seq = c.seq();
    let found = seq
        .markers
        .iter()
        .find(|m| m.id.as_str() == id)
        .or_else(|| seq.clips_in_order().flat_map(|x| x.markers.iter().flatten()).find(|m| m.id.as_str() == id));
    match found {
        Some(m) => Ok((m.id.as_str().to_owned(), m.t)),
        None => refuse(format!("There is no marker {id}. get_markers lists them.")),
    }
}

pub fn set_marker(c: &mut Cx, a: &Json) -> R<Out> {
    let (id, t0) = marker_of(c, s(a, "marker_id").unwrap_or_default())?;
    let mut patch = Map::new();
    let mut at = t0;
    if given(a, "at") {
        at = c.time_in(f(a, "at").unwrap_or(0.0), "at", false)?;
        patch.insert("t".into(), json!(at));
    }
    for k in ["name", "kind", "color", "note"] {
        if let Some(v) = a.get(k) {
            patch.insert(k.into(), v.clone());
        }
    }
    if patch.is_empty() {
        return refuse("Give something to change.");
    }
    c.run(&C::set_marker(c.seq_id().as_str(), &id, Json::Object(patch)))?;
    Ok(json!({ "edit": { "at": at } }).into())
}

pub fn remove_markers(c: &mut Cx, a: &Json) -> R<Out> {
    let (ids, kind) = (strs(a, "marker_ids"), s(a, "kind"));
    if ids.is_none() == kind.is_none() {
        return refuse("Give marker_ids or kind (one of them).");
    }
    if let Some(k) = kind {
        let any = c.seq().markers.iter().any(|m| k == "all" || serde_json::to_value(m.kind).unwrap_or_default() == k);
        if !any {
            return refuse(format!(
                "There are no {}sequence markers.",
                if k == "all" { String::new() } else { format!("{k} ") }
            ));
        }
        plan(c, Op::RemoveMarkers(k.to_owned()), "Remove Marker")?;
        return Ok(json!({ "edit": { "at": 0 } }).into());
    }
    let mut list = Vec::new();
    for id in ids.unwrap_or_default() {
        list.push(marker_of(c, &id)?);
    }
    let seq = c.seq_id();
    c.atomic("Remove Marker", |c| {
        for (id, _) in &list {
            c.run(&C::remove_marker(seq.as_str(), id))?;
        }
        Ok(())
    })?;
    let first = list.iter().map(|x| x.1).min().unwrap_or(0);
    Ok(json!({ "edit": { "at": first }, "removed": list.len() }).into())
}

const MASK_FIELDS: [&str; 5] = ["feather", "opacity", "expansion", "inverted", "mode"];

pub fn add_mask(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    c.need_kind(&clip, TrackKind::Video, "A mask")?;
    let effect = s(a, "effect_id");
    if let Some(e) = effect
        && !clip.effects.iter().any(|x| x.id.as_str() == e)
    {
        return refuse(format!("{} has no effect {e}.", clip.id.as_str()));
    }
    let mut mask = json!({ "path": shape_path(a, "the shape")? });
    for k in MASK_FIELDS {
        if let Some(v) = a.get(k) {
            mask[k] = v.clone();
        }
    }
    let r = c.run(&C::add_mask(c.seq_id().as_str(), clip.id.as_str(), mask, effect))?;
    Ok(json!({ "edit": { "at": clip.start }, "mask": r["id"] }).into())
}

pub fn set_mask(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let mask = s(a, "mask_id").unwrap_or_default();
    let effect = s(a, "effect_id");
    let mut patch = Map::new();
    for k in MASK_FIELDS {
        if let Some(v) = a.get(k) {
            patch.insert(k.into(), v.clone());
        }
    }
    if s(a, "shape").is_some_and(|x| !x.is_empty()) {
        patch.insert("path".into(), json!(shape_path(a, "the shape")?));
    } else if ["x", "y", "width", "height"].iter().any(|k| given(a, k)) {
        return refuse("x, y, width and height go with shape.");
    }
    let prefix = format!(
        "{}masks.{mask}.",
        effect.filter(|e| !e.is_empty()).map(|e| format!("effects.{e}.")).unwrap_or_default()
    );
    if let Some(k) = clip
        .keyframes
        .keys()
        .find(|k| k.starts_with(&prefix) && k.rsplit('.').next().is_some_and(|f| patch.contains_key(f)))
    {
        return refuse(format!("{k} has keyframes; change them with set_keyframes."));
    }
    if patch.is_empty() {
        return refuse("Give something to change.");
    }
    c.run(&C::set_mask(c.seq_id().as_str(), clip.id.as_str(), mask, Json::Object(patch), effect))?;
    Ok(json!({ "edit": { "at": clip.start } }).into())
}

pub fn remove_mask(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    c.run(&C::remove_mask(
        c.seq_id().as_str(),
        clip.id.as_str(),
        s(a, "mask_id").unwrap_or_default(),
        s(a, "effect_id"),
    ))?;
    Ok(json!({ "edit": { "at": clip.start } }).into())
}

pub fn nest_clips(c: &mut Cx, a: &Json) -> R<Out> {
    let ids = strs(a, "clip_ids").unwrap_or_default();
    let mut first = i64::MAX;
    for id in &ids {
        first = first.min(c.clip_of(id, true)?.start);
    }
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let name = s(a, "name").filter(|x| !x.is_empty()).unwrap_or("Nested Sequence");
    let r = c.run(&C::nest(c.seq_id().as_str(), &refs, json!({ "name": name })))?;
    Ok(json!({ "edit": { "at": first }, "sequence": r["id"], "clips": r["ids"] }).into())
}

pub fn set_track(c: &mut Cx, a: &Json) -> R<Out> {
    let t = c.track_of(s(a, "track_id").unwrap_or_default(), None, true)?;
    let mut patch = Map::new();
    if let Some(v) = a.get("name") {
        patch.insert("name".into(), v.clone());
    }
    if let Some(v) = a.get("sync_lock") {
        patch.insert("syncLock".into(), v.clone());
    }
    if let Some(v) = a.get("visible") {
        if t.kind != TrackKind::Video {
            return refuse("visible is for video tracks; audio tracks have mute.");
        }
        patch.insert("visible".into(), v.clone());
    }
    for k in ["mute", "solo", "pan", "volume"] {
        if let Some(v) = a.get(k) {
            if t.kind != TrackKind::Audio {
                return refuse(format!("{k} is for audio tracks."));
            }
            patch.insert(k.into(), v.clone());
        }
    }
    if patch.is_empty() {
        return refuse("Give something to change.");
    }
    c.run(&C::set_track(c.seq_id().as_str(), t.id.as_str(), Json::Object(patch)))?;
    Ok(json!({ "edit": { "at": c.host.app().t } }).into())
}

/// Frame rates as a model writes them (`FPS`).
pub fn fps_of(name: &str) -> Option<[u32; 2]> {
    Some(match name {
        "23.976" => [24000, 1001],
        "24" => [24, 1],
        "25" => [25, 1],
        "29.97" => [30000, 1001],
        "30" => [30, 1],
        "50" => [50, 1],
        "59.94" => [60000, 1001],
        "60" => [60, 1],
        _ => return None,
    })
}

pub fn set_sequence(c: &mut Cx, a: &Json) -> R<Out> {
    let mut patch = Map::new();
    if let Some(v) = a.get("name") {
        patch.insert("name".into(), v.clone());
    }
    if let Some(v) = a.get("master_gain") {
        patch.insert("masterGain".into(), v.clone());
    }
    for (k, key) in [("width", "w"), ("height", "h")] {
        if let Some(v) = f(a, k) {
            if v % 2.0 != 0.0 {
                return refuse(format!("{k} must be even."));
            }
            patch.insert(key.into(), num(v));
        }
    }
    if let Some(v) = s(a, "fps") {
        patch.insert("fps".into(), json!(fps_of(v)));
    }
    if let Some(v) = a.get("background") {
        let ok = v
            .as_str()
            .is_some_and(|x| x.len() == 7 && x.starts_with('#') && x[1..].chars().all(|c| c.is_ascii_hexdigit()));
        if !ok {
            return refuse("background must look like #000000.");
        }
        patch.insert("background".into(), v.clone());
    }
    let active = b(a, "active") == Some(true);
    if patch.is_empty() && !active {
        return refuse("Give something to change.");
    }
    let seq = c.seq_id();
    let changed = !patch.is_empty();
    if changed {
        c.run(&C::set_sequence(seq.as_str(), Json::Object(patch)))?;
    }
    if active && c.host.app().sequence_id != Some(seq) {
        c.host.app_mut().set_sequence(seq);
    }
    Ok(if changed {
        json!({ "edit": { "at": c.host.app().t }, "sequence": seq.as_str() })
    } else {
        json!({ "sequence": seq.as_str(), "active": true })
    }
    .into())
}

pub fn remove_silence(c: &mut Cx, a: &Json) -> R<Out> {
    let longer = f(a, "longer_than").unwrap_or(0.0);
    let threshold = f(a, "threshold");
    let seq = c.seq_id();
    let Some(mut task) = c.host.silence(seq, threshold.unwrap_or(-40.0), longer) else {
        return refuse("The sound cannot be measured here.");
    };
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        let ranges: Vec<(i64, i64)> = r["ranges"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| (x[0].as_f64().unwrap_or(0.0) as i64, x[1].as_f64().unwrap_or(0.0) as i64))
            .collect();
        if ranges.is_empty() {
            return Some(refuse(format!(
                "There is no silence longer than {} s quieter than {} dB.",
                js_num(longer),
                js_num(threshold.unwrap_or(-40.0))
            )));
        }
        let tracks = r["tracks"].as_array().map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect());
        let mut c = Cx { host: h, seq: Some(seq), undo_floor: None, live };
        let first = ranges[0].0;
        let secs = ranges.iter().map(|(x, y)| y - x).sum::<i64>() as f64;
        let n = ranges.len();
        Some(
            plan(&mut c, Op::RemoveSilence(ranges, tracks), "Remove Silence")
                .map(|_| json!({ "edit": { "at": first }, "cuts": n, "seconds": num(r3(secs / T)) })),
        )
    })))
}

pub fn select_clips(c: &mut Cx, a: &Json) -> R<Out> {
    let ids = strs(a, "clip_ids").unwrap_or_default();
    let mut found = Vec::new();
    for id in &ids {
        found.push(c.clip_of(id, false)?.id);
    }
    let seq = c.seq_id();
    let app = c.host.app_mut();
    if app.sequence_id != Some(seq) {
        app.set_sequence(seq);
    }
    app.select(found, b(a, "add") == Some(true), false);
    Ok(json!({ "selection": crate::control::call::selection(c.host.app()) }).into())
}

pub fn seek(c: &mut Cx, a: &Json) -> R<Out> {
    let t = cut_time::snap(c.time_in(f(a, "time").unwrap_or(0.0), "time", false)?, c.fps(), false);
    let seq = c.seq_id();
    if c.host.app().sequence_id != Some(seq) {
        c.host.app_mut().set_sequence(seq);
    }
    c.host.seek(t);
    Ok(json!({ "playhead": c.sec(t as f64), "frame": c.frame(t as f64) }).into())
}

pub fn play(c: &mut Cx, _a: &Json) -> R<Out> {
    c.context(None)?;
    c.host.play();
    Ok(json!({ "playing": true, "from": c.sec(c.host.app().t as f64) }).into())
}

pub fn stop(c: &mut Cx, _a: &Json) -> R<Out> {
    c.context(None)?;
    c.host.stop();
    Ok(json!({ "playing": false, "playhead": c.sec(c.host.app().t as f64) }).into())
}

fn last_done(app: &crate::state::App) -> Option<String> {
    app.history.list().into_iter().rev().find(|x| x.done).map(|x| x.label)
}

pub fn undo(c: &mut Cx, _a: &Json) -> R<Out> {
    let floor = c.undo_floor;
    let app = c.host.app_mut();
    if !app.history.can_undo() || floor.is_some_and(|f| app.history.position() <= f) {
        return refuse("There is nothing of yours to undo.");
    }
    let label = last_done(app);
    app.undo();
    Ok(json!({ "undone": label, "edit": { "at": app.t } }).into())
}

pub fn redo(c: &mut Cx, _a: &Json) -> R<Out> {
    let app = c.host.app_mut();
    if !app.history.can_redo() {
        return refuse("There is nothing to redo.");
    }
    app.redo();
    Ok(json!({ "redone": last_done(app), "edit": { "at": app.t } }).into())
}

pub fn export_sequence(c: &mut Cx, a: &Json) -> R<Out> {
    use cut_export::presets as P;
    if c.duration() == 0 {
        return refuse("The sequence is empty.");
    }
    let file = plain_name(s(a, "file_name"))?;
    let range = if given(a, "from") || given(a, "to") {
        let i = c.time_in(f(a, "from").unwrap_or(0.0), "from", false)?;
        let o = c.time_in(f(a, "to").unwrap_or(c.duration() as f64 / T), "to", false)?;
        if o - i < c.f() {
            return refuse("\"to\" must be after \"from\".");
        }
        Some((i, o))
    } else {
        None
    };
    let pid = s(a, "preset").unwrap_or_default();
    let Some(p) = P::get(pid) else { return refuse(format!("preset must be one of {}.", presets_list())) };
    let audio_only = p.kind == P::Kind::Audio;
    let mut o = Map::new();
    for (k, key) in
        [("width", "w"), ("height", "h"), ("codec", "codec"), ("bitrate_mode", "mode"), ("key_seconds", "keySeconds")]
    {
        let Some(v) = a.get(k) else { continue };
        if audio_only {
            return refuse(format!("{pid} has no picture: {k} does not apply."));
        }
        o.insert(key.into(), v.clone());
    }
    if let Some(v) = f(a, "bitrate") {
        if audio_only {
            return refuse(format!("{pid} has no picture: bitrate does not apply (audio_bitrate does)."));
        }
        o.insert("bitrate".into(), num(round(v * 1e6)));
    }
    if let Some(v) = f(a, "audio_bitrate") {
        o.insert("audioBitrate".into(), num(v * 1000.0));
    }
    if let Some(v) = a.get("loudness") {
        o.insert("loudness".into(), v.clone());
    }
    let over: P::Overrides = serde_json::from_value(Json::Object(o)).unwrap_or_default();
    let seq = c.seq();
    let settings = P::resolve(p, seq.fps, Some((seq.w as f64, seq.h as f64)), &over);
    let bad = P::validate(&settings);
    if !bad.is_empty() {
        return refuse(bad.join(" "));
    }
    let sj = serde_json::to_value(&settings).unwrap_or_default();
    let request = json!({
        "seq": seq.id.as_str(), "preset": pid, "fileName": file, "range": range.map(|(i, o)| json!({ "in": i, "out": o })),
        "captions": if s(a, "captions") == Some("burn") { json!("burn") } else { Json::Null }, "settings": sj,
    });
    let Some(mut ask) = c.host.export_ask(request) else { return refuse("Exporting is not available here.") };
    let summary = json!({
        "width": sj["width"], "height": sj["height"],
        "video": if sj["video"].is_null() { Json::Null } else {
            json!(format!("{} {} Mbps", sj["video"]["family"].as_str().unwrap_or_default(), js_num(r3(sj["video"]["bitrate"].as_f64().unwrap_or(0.0) / 1e6))))
        },
        "audio": format!("{} kbps", js_num(sj["audio"]["bitrate"].as_f64().unwrap_or(0.0) / 1000.0)),
        "loudness": sj["loudness"],
    });
    let wait = b(a, "wait") == Some(true);
    let mut waiting: Option<(crate::control::host::Task<Json>, Json, String)> = None;
    Ok(Out::Later(Box::new(move |h, live| {
        if let Some((task, out, name)) = &mut waiting {
            let w = task(h, live)?;
            return Some(if w["ok"] == true {
                let mut v = out.clone();
                v["done"] = json!(true);
                Ok(v)
            } else if w["cancelled"] == true {
                refuse(format!("The export of {name} was cancelled; its unfinished file is removed."))
            } else {
                refuse(format!("The export of {name} failed: {}", w["error"].as_str().unwrap_or("unknown error")))
            });
        }
        let r = ask(h, live)?;
        if r["ok"] != true {
            return Some(refuse(if r["declined"] == true {
                "The user said no to this export. Nothing was written.".to_owned()
            } else {
                format!("The export could not start: {}", r["error"].as_str().unwrap_or("unknown error"))
            }));
        }
        let out =
            json!({ "queued": r["name"], "job": r.get("job").cloned().unwrap_or(Json::Null), "settings": summary });
        if !wait {
            let mut v = out;
            v["note"] = json!("The user agreed; the export runs in the export queue (export_queue shows it).");
            return Some(Ok(v));
        }
        let name = r["name"].as_str().unwrap_or_default().to_owned();
        match h.export_wait(r["job"].as_u64().unwrap_or(0)) {
            Some(task) => {
                waiting = Some((task, out, name));
                None
            }
            None => Some(refuse(format!("The export of {name} failed: unknown error"))),
        }
    })))
}

fn presets_list() -> String {
    cut_export::presets::EXPORT.iter().map(|p| p.id).collect::<Vec<_>>().join(", ")
}

/// A plain-name check shared with the frame and caption exports.
pub fn file_name(a: &Json) -> R<Option<String>> {
    plain_name(s(a, "file_name"))
}
