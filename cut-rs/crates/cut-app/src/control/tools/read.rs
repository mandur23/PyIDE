//! The reading tools (control.js): the project, a sequence, a clip, the media, markers, captions, the transcript,
//! the effects, a frame and the editor's state.

use cut_model::{Clip, Marker, Sequence, Source, TrackKind};
use cut_time::TICKS;
use serde_json::{Map, Value as Json, json};

use crate::control::call::{Cx, Out, R, cj, f, num, r3, refuse, s, selection};
use crate::control::schema::js_stringify;

const T: f64 = TICKS as f64;

fn fps_of(seq: &Sequence) -> Json {
    num(r3(seq.fps.num as f64 / seq.fps.den as f64))
}

fn overlaps(a0: f64, a1: f64, from: Option<f64>, to: Option<f64>) -> bool {
    from.is_none_or(|x| a1 > x) && to.is_none_or(|x| a0 < x)
}

fn source_name(c: &Clip) -> String {
    match &c.source {
        Source::Generator { generator, .. } => generator.name().to_owned(),
        Source::Nest { sequence, .. } => format!("nest {}", sequence.as_str()),
        Source::Media { media, freeze, .. } => {
            format!("{}media {}", if *freeze { "freeze " } else { "" }, media.as_str())
        }
    }
}

/// `clipSummary`: a clip in a few fields, only what differs from the defaults.
pub fn clip_summary(c: &Cx, clip: &Clip) -> Map<String, Json> {
    let j = cj(clip);
    let kind = c.kind_of(clip);
    let mut o = Map::new();
    o.insert("id".into(), json!(clip.id.as_str()));
    o.insert("track".into(), json!(clip.track.as_str()));
    o.insert("start".into(), c.sec(clip.start as f64));
    o.insert("end".into(), c.sec(clip.end() as f64));
    o.insert("startFrame".into(), c.frame(clip.start as f64));
    o.insert("endFrame".into(), c.frame(clip.end() as f64));
    let name = if !clip.name.is_empty() {
        clip.name.clone()
    } else {
        clip.media_id().and_then(|m| c.project().media(m)).map(|m| m.name.clone()).unwrap_or_default()
    };
    if !name.is_empty() {
        o.insert("name".into(), json!(name));
    }
    o.insert("source".into(), json!(source_name(clip)));
    if !clip.is_generator() {
        o.insert("in".into(), c.sec(clip.in_));
        o.insert("out".into(), c.sec(clip.out));
    }
    if clip.speed != 1.0 {
        o.insert("speed".into(), num(r3(clip.speed * 100.0)));
    }
    if clip.reverse {
        o.insert("reverse".into(), json!(true));
    }
    if clip.remap.is_some() {
        o.insert("timeRemap".into(), json!(true));
    }
    if !clip.enabled {
        o.insert("enabled".into(), json!(false));
    }
    for k in ["link", "group", "role"] {
        if !j[k].is_null() {
            o.insert(k.into(), j[k].clone());
        }
    }
    if kind == Some(TrackKind::Audio) {
        o.insert("volume".into(), num(j["props"]["volume"].as_f64().unwrap_or(0.0)));
    } else if j["props"]["opacity"].as_f64() != Some(100.0) {
        o.insert("opacity".into(), j["props"]["opacity"].clone());
    }
    if let Source::Generator { generator: cut_model::Generator::Text, layers, .. } = &clip.source {
        let text: Vec<String> = layers
            .iter()
            .flatten()
            .map(|l| l["text"].as_str().map_or_else(|| l["text"].to_string(), str::to_owned))
            .collect();
        o.insert("text".into(), json!(text.join(" / ").chars().take(200).collect::<String>()));
    }
    if !clip.effects.is_empty() {
        let list: Vec<String> = clip
            .effects
            .iter()
            .map(|e| format!("{} {}{}", e.id.as_str(), e.kind, if e.on { "" } else { " (off)" }))
            .collect();
        o.insert("effects".into(), json!(list));
    }
    if !clip.keyframes.is_empty() {
        o.insert("keyframed".into(), json!(clip.keyframes.keys().collect::<Vec<_>>()));
    }
    if let Some(m) = clip.masks.as_ref().filter(|m| !m.is_empty()) {
        o.insert("masks".into(), json!(m.len()));
    }
    if let Some(m) = clip.markers.as_ref().filter(|m| !m.is_empty()) {
        o.insert("markers".into(), json!(m.len()));
    }
    o
}

fn track_summary(t: &cut_model::Track) -> Json {
    let mut o = Map::new();
    o.insert("id".into(), json!(t.id.as_str()));
    o.insert("kind".into(), json!(if t.kind == TrackKind::Audio { "audio" } else { "video" }));
    if !t.name.is_empty() && t.name != t.id.as_str() {
        o.insert("name".into(), json!(t.name));
    }
    if t.locked {
        o.insert("locked".into(), json!(true));
    }
    if t.kind == TrackKind::Video && t.visible == Some(false) {
        o.insert("hidden".into(), json!(true));
    }
    if t.kind == TrackKind::Audio {
        if t.mute == Some(true) {
            o.insert("mute".into(), json!(true));
        }
        if t.solo == Some(true) {
            o.insert("solo".into(), json!(true));
        }
        if let Some(v) = t.volume.filter(|v| *v != 0.0) {
            o.insert("volume".into(), num(v));
        }
        if let Some(v) = t.pan.filter(|v| *v != 0.0) {
            o.insert("pan".into(), num(v));
        }
    }
    if !t.sync_lock {
        o.insert("syncLock".into(), json!(false));
    }
    Json::Object(o)
}

/// `markerSummary(c, mk, base)`.
pub fn marker_summary(c: &Cx, mk: &Marker, base: i64) -> Map<String, Json> {
    let j = serde_json::to_value(mk).unwrap_or_default();
    let mut o = Map::new();
    o.insert("id".into(), json!(mk.id.as_str()));
    o.insert("time".into(), c.sec((base + mk.t) as f64));
    o.insert("frame".into(), c.frame((base + mk.t) as f64));
    o.insert("kind".into(), j["kind"].clone());
    o.insert("name".into(), json!(mk.name));
    if !mk.color.is_empty() && mk.color != "green" {
        o.insert("color".into(), json!(mk.color));
    }
    if !mk.note.is_empty() {
        o.insert("note".into(), json!(mk.note));
    }
    if mk.duration != 0 {
        o.insert("duration".into(), c.sec(mk.duration as f64));
    }
    o
}

fn param_text(p: &cut_model::effects::Param) -> String {
    let range = p.min.map(|min| format!(" {}..{}", js_num_opt(Some(min)), js_num_opt(p.max))).unwrap_or_default();
    let choices = if p.choices.is_empty() {
        String::new()
    } else {
        format!(" {}", p.choices.iter().map(|c| c.0).collect::<Vec<_>>().join("|"))
    };
    let unit = p.unit.map(|u| format!(" {u}")).unwrap_or_default();
    format!("{}: {}{range}{choices} = {}{unit}", p.id, p.kind.name(), js_stringify(&p.default.to_json()))
}

fn js_num_opt(x: Option<f64>) -> String {
    x.map_or_else(|| "undefined".into(), crate::control::schema::js_num)
}

pub fn get_project(c: &mut Cx, _a: &Json) -> R<Out> {
    let app = c.host.app();
    let p = app.project();
    let st = &p.settings;
    let secs = |k: &str| num(r3(st.get(k).and_then(Json::as_f64).unwrap_or(0.0) / T));
    let mut settings = Map::new();
    settings.insert("stillDuration".into(), secs("stillDuration"));
    settings.insert("transitionDuration".into(), secs("transitionDuration"));
    settings.insert("freezeDuration".into(), secs("freezeDuration"));
    if let Some(fit) = st.get("fit") {
        settings.insert("fit".into(), fit.clone());
    }
    settings.insert("speechTerms".into(), st.get("speechTerms").filter(|v| !v.is_null()).cloned().unwrap_or(json!([])));
    let sequences: Vec<Json> = p
        .sequences
        .iter()
        .map(|q| {
            let mut o = json!({
                "id": q.id.as_str(), "name": q.name, "width": q.w, "height": q.h, "fps": fps_of(q),
                "duration": num(r3(q.duration() as f64 / T)), "clips": q.clip_count(),
            });
            if Some(q.id) == app.sequence_id {
                o["active"] = json!(true);
            }
            o
        })
        .collect();
    let bins: Vec<Json> = p
        .bins
        .iter()
        .map(|b| {
            let mut o = json!({ "id": b.id.as_str(), "name": b.name, "items": b.items.len() });
            if let Some(par) = b.parent {
                o["parent"] = json!(par.as_str());
            }
            o
        })
        .collect();
    let luts: Vec<Json> = p
        .luts
        .as_ref()
        .and_then(Json::as_object)
        .map(|m| m.iter().map(|(id, e)| json!({ "id": id, "name": e["name"] })).collect())
        .unwrap_or_default();
    Ok(json!({
        "sequences": sequences, "media": p.media.len(), "bins": bins, "luts": luts,
        "activeSequence": app.sequence_id.map(|i| i.as_str()),
        "playhead": num(r3(app.t as f64 / T)),
        "selection": selection(app),
        "savedToFile": app.path.is_some(), "unsavedChanges": app.history.dirty(),
        "settings": settings,
    })
    .into())
}

pub fn get_sequence(c: &mut Cx, a: &Json) -> R<Out> {
    let (from, to) = (f(a, "from"), f(a, "to"));
    let seq = c.seq();
    let mut all: Vec<&Clip> =
        seq.clips_in_order().filter(|x| overlaps(x.start as f64 / T, x.end() as f64 / T, from, to)).collect();
    all.sort_by(|x, y| x.start.cmp(&y.start).then_with(|| x.track.as_str().cmp(y.track.as_str())));
    let max = f(a, "max_clips").map_or(300, |m| m as usize);
    let clips: Vec<Json> = all.iter().take(max).map(|x| Json::Object(clip_summary(c, x))).collect();
    let mut o = json!({
        "id": seq.id.as_str(), "name": seq.name, "width": seq.w, "height": seq.h, "fps": fps_of(seq),
        "duration": c.sec(c.duration() as f64), "durationFrames": c.frame(c.duration() as f64),
        "masterGain": num(seq.master_gain),
        "tracks": seq.tracks.iter().map(track_summary).collect::<Vec<_>>(),
        "clips": clips,
        "transitions": seq.transitions.iter().map(|t| json!({
            "id": t.id.as_str(), "track": t.track.as_str(), "at": c.sec(t.at as f64), "atFrame": c.frame(t.at as f64),
            "type": t.kind, "duration": c.sec(t.duration as f64), "align": serde_json::to_value(t.align).unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "markers": seq.markers.len(),
        "captionTracks": seq.captions.iter().map(|t| json!({ "id": t.id.as_str(), "name": t.name, "lang": t.lang, "items": t.items.len() })).collect::<Vec<_>>(),
    });
    if all.len() > max {
        o["truncated"] = json!(format!("{} more clips; ask with from/to", all.len() - max));
    }
    Ok(o.into())
}

pub fn get_clip(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), false)?;
    let j = cj(&clip);
    let mut out = clip_summary(c, &clip);
    out.insert("props".into(), j["props"].clone());
    let keyframes: Map<String, Json> = j["keyframes"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, list)| {
                    let l: Vec<Json> = list
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|kf| {
                            let mut o = json!({ "time": c.sec(clip.start as f64 + kf["t"].as_f64().unwrap_or(0.0)), "value": kf["v"] });
                            if !kf["ease"].is_null() {
                                o["ease"] = kf["ease"].clone();
                            }
                            o
                        })
                        .collect();
                    (k.clone(), Json::Array(l))
                })
                .collect()
        })
        .unwrap_or_default();
    out.insert("keyframes".into(), Json::Object(keyframes));
    let effects: Vec<Json> = clip
        .effects
        .iter()
        .map(|e| {
            let params = if cut_model::effects::get(&e.kind).is_some() {
                Json::Object(cut_model::effects::resolve(&e.kind, &e.params))
            } else {
                Json::Object(e.params.clone())
            };
            let mut o = json!({ "id": e.id.as_str(), "type": e.kind, "on": e.on, "params": params });
            if let Some(m) = &e.masks {
                o["masks"] = json!(m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>());
            }
            o
        })
        .collect();
    out.insert("effects".into(), json!(effects));
    if let Some(masks) = j["masks"].as_array().filter(|m| !m.is_empty()) {
        let list: Vec<Json> = masks
            .iter()
            .map(|mk| {
                let mut o = Map::new();
                for k in ["id", "mode", "inverted", "feather", "opacity", "expansion"] {
                    if !mk[k].is_null() {
                        o.insert(k.into(), mk[k].clone());
                    }
                }
                o.insert("points".into(), num(mk["path"].as_array().map_or(0, Vec::len) as f64 / 6.0));
                Json::Object(o)
            })
            .collect();
        out.insert("masks".into(), json!(list));
    }
    match &clip.source {
        Source::Generator { generator: cut_model::Generator::Text, layers, .. } => {
            let list: Vec<Json> = layers
                .iter()
                .flatten()
                .map(|l| {
                    let mut o = Map::new();
                    for (k, from) in [
                        ("id", "id"),
                        ("text", "text"),
                        ("font", "font"),
                        ("size", "size"),
                        ("weight", "weight"),
                        ("color", "fill"),
                        ("position", "position"),
                        ("align", "align"),
                    ] {
                        if let Some(v) = l.get(from) {
                            o.insert(k.into(), v.clone());
                        }
                    }
                    Json::Object(o)
                })
                .collect();
            out.insert("layers".into(), json!(list));
        }
        Source::Generator { generator: cut_model::Generator::Solid, color, .. } => {
            out.insert("color".into(), json!(color));
        }
        Source::Generator { generator: cut_model::Generator::Graphic, layers, .. } => {
            out.insert(
                "layers".into(),
                json!(layers.iter().flatten().map(cut_model::graphic::compact).collect::<Vec<_>>()),
            );
        }
        _ => {}
    }
    if let Some(m) = clip.markers.as_ref().filter(|m| !m.is_empty()) {
        out.insert("markers".into(), json!(m.iter().map(|mk| marker_summary(c, mk, clip.start)).collect::<Vec<_>>()));
    }
    if c.kind_of(&clip) == Some(TrackKind::Audio) {
        out.insert("fadeIn".into(), c.sec(clip.fade_in as f64));
        out.insert("fadeOut".into(), c.sec(clip.fade_out as f64));
    }
    let linked: Vec<&str> = c.seq().linked_clips(&clip).iter().map(|l| l.id.as_str()).collect();
    out.insert("linked".into(), json!(linked));
    Ok(Json::Object(out).into())
}

pub fn get_media(c: &mut Cx, _a: &Json) -> R<Out> {
    let p = c.project();
    let mut used = std::collections::HashMap::new();
    for s in &p.sequences {
        for x in s.clips_in_order() {
            if let Some(m) = x.media_id() {
                *used.entry(m).or_insert(0) += 1;
            }
        }
    }
    let bin_of: std::collections::HashMap<_, _> =
        p.bins.iter().flat_map(|b| b.items.iter().map(move |id| (*id, b.id))).collect();
    let list: Vec<Json> = p
        .media
        .iter()
        .map(|m| {
            let j = serde_json::to_value(m).unwrap_or_default();
            let image = j["kind"] == "image";
            let mut o = json!({
                "id": m.id.as_str(), "name": m.name, "kind": j["kind"],
                "duration": if image { Json::Null } else { num(r3(m.duration / T)) },
                "audio": m.audio.is_some(), "clips": used.get(&m.id).copied().unwrap_or(0),
            });
            if let Some(v) = &m.video {
                o["width"] = num(v.w);
                o["height"] = num(v.h);
                if let Some(fps) = v.extra.get("fps").and_then(Json::as_f64).filter(|x| *x != 0.0) {
                    o["fps"] = num(r3(fps));
                }
            }
            if let Some(b) = bin_of.get(&m.id) {
                o["bin"] = json!(b.as_str());
            }
            if m.proxy.is_some() {
                o["proxy"] = json!(true);
            }
            if c.host.offline(m.id) {
                o["offline"] = json!(true);
            }
            o
        })
        .collect();
    Ok(Json::Array(list).into())
}

pub fn get_markers(c: &mut Cx, _a: &Json) -> R<Out> {
    let c: &Cx = c;
    let seq = c.seq();
    let sequence: Vec<Json> = seq.markers.iter().map(|mk| Json::Object(marker_summary(c, mk, 0))).collect();
    let clips: Vec<Json> = seq
        .clips_in_order()
        .flat_map(|x| {
            x.markers.iter().flatten().map(move |mk| {
                let mut o = Map::new();
                o.insert("clip".into(), json!(x.id.as_str()));
                o.extend(marker_summary(c, mk, x.start));
                Json::Object(o)
            })
        })
        .collect();
    Ok(json!({ "sequence": sequence, "clips": clips }).into())
}

pub fn get_captions(c: &mut Cx, a: &Json) -> R<Out> {
    let want = s(a, "track_id").filter(|x| !x.is_empty());
    let seq = c.seq();
    let tracks: Vec<_> = seq.captions.iter().filter(|t| want.is_none_or(|w| t.id.as_str() == w)).collect();
    if let Some(w) = want
        && tracks.is_empty()
    {
        return refuse(format!("There is no caption track {w}."));
    }
    let (from, to) = (f(a, "from"), f(a, "to"));
    let max = f(a, "max_items").map_or(300, |m| m as usize);
    let out: Vec<Json> = tracks
        .iter()
        .map(|t| {
            let items: Vec<_> =
                t.items.iter().filter(|it| overlaps(it.start as f64 / T, it.end as f64 / T, from, to)).collect();
            let mut o = json!({
                "id": t.id.as_str(), "name": t.name, "lang": t.lang,
                "items": items.iter().take(max).map(|it| json!({ "id": it.id.as_str(), "start": c.sec(it.start as f64), "end": c.sec(it.end as f64), "text": it.text })).collect::<Vec<_>>(),
            });
            if items.len() > max {
                o["truncated"] = json!(items.len() - max);
            }
            o
        })
        .collect();
    Ok(Json::Array(out).into())
}

pub fn get_transcript(c: &mut Cx, a: &Json) -> R<Out> {
    let seq = c.seq_id();
    let segs = c.host.transcript(seq).unwrap_or_default();
    let keep: Vec<_> = segs.into_iter().filter(|(x, y, _)| overlaps(*x, *y, f(a, "from"), f(a, "to"))).collect();
    if keep.is_empty() {
        return Ok(json!({ "segments": [], "note": "There is no transcript of this sequence yet." }).into());
    }
    let list: Vec<Json> = keep
        .into_iter()
        .take(2000)
        .map(|(x, y, t)| json!({ "start": num(r3(x)), "end": num(r3(y)), "text": t }))
        .collect();
    Ok(Json::Array(list).into())
}

pub fn list_effects(_c: &mut Cx, a: &Json) -> R<Out> {
    use cut_model::effects::{self as E, Kind};
    let kind = s(a, "kind");
    let q = s(a, "search").unwrap_or_default().to_lowercase();
    let kname = |k: Kind| k.name();
    let hit = |d: &E::Def| {
        kind.is_none_or(|k| kname(d.kind) == k)
            && (q.is_empty() || format!("{} {} {}", d.id, d.name, d.category).to_lowercase().contains(&q))
    };
    let params = |d: &E::Def| d.params.iter().map(param_text).collect::<Vec<_>>();
    let effects: Vec<Json> = E::list(None)
        .filter(|d| hit(d))
        .map(|d| json!({ "type": d.id, "name": d.name, "kind": kname(d.kind), "category": d.category, "params": params(d) }))
        .collect();
    let transitions: Vec<Json> = E::transitions(None)
        .filter(|d| hit(d))
        .map(|d| json!({ "type": d.id, "name": d.name, "kind": kname(d.kind), "params": params(d) }))
        .collect();
    Ok(json!({ "effects": effects, "transitions": transitions }).into())
}

pub fn get_frame(c: &mut Cx, a: &Json) -> R<Out> {
    let t = match f(a, "time") {
        None => c.host.app().t.min((c.duration() - c.f()).max(0)),
        Some(x) => c.time_in(x, "time", false)?,
    };
    let width = f(a, "width").map_or(640, |w| w as u32);
    let seq = c.seq_id();
    let Some(mut task) = c.host.frame(seq, t, width) else { return refuse("Frames cannot be rendered here.") };
    let (sec, frame) = (c.sec(t as f64), c.frame(t as f64));
    Ok(Out::Later(Box::new(move |h, live| {
        let r = task(h, live)?;
        Some(if r["ok"] != true {
            refuse(format!(
                "The frame could not be rendered: {}",
                r["error"].as_str().filter(|e| !e.is_empty()).unwrap_or("unknown error")
            ))
        } else {
            Ok(json!({
                "$image": { "data": r["base64"], "mimeType": "image/png" },
                "time": sec, "frame": frame, "width": r["width"], "height": r["height"],
            }))
        })
    })))
}

pub fn get_state(c: &mut Cx, _a: &Json) -> R<Out> {
    c.context(None)?;
    let app = c.host.app();
    let h = &app.history;
    let steps: Vec<String> = h.list().into_iter().filter(|x| x.done).map(|x| x.label).collect();
    let io = app.in_out;
    Ok(json!({
        "sequence": c.seq_id().as_str(), "playhead": c.sec(app.t as f64), "playheadFrame": c.frame(app.t as f64),
        "playing": c.host.playing(),
        "selection": selection(app),
        "inOut": { "in": io.in_.map(|x| c.sec(x as f64)), "out": io.out.map(|x| c.sec(x as f64)) },
        "canUndo": h.can_undo(), "canRedo": h.can_redo(),
        "lastSteps": steps[steps.len().saturating_sub(5)..].to_vec(),
    })
    .into())
}
