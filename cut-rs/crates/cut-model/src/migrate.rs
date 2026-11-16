//! `migrate`: a project file of any version, or one written by hand or by another tool, as this version reads it
//! (port of model.js's `migrate`). It works on the file's JSON, before the types: it fills missing fields with their
//! defaults, snaps keyframe, marker and caption times to frames, drops masks, curves and word timings that do not
//! hold, and refuses a file that is no project or comes from a newer version.

use cut_time::{Fps, Ticks};
use serde_json::{Map, Value as Json, json};

use crate::captionwords;
use crate::defaults::{self, EASES, ROLES, SAMPLINGS};
use crate::id::Id;
use crate::masks;
use crate::project::{LoadError, TrackKind};
use crate::query::{VERSION, frame, js_round, valid_fps};
use crate::remap::{self as R, Remap};

mod current;
pub use current::is_current;

/// JavaScript's `String(v)` of a JSON value, for messages and names.
pub(crate) fn js_string(v: &Json) -> String {
    match v {
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => n.as_f64().map_or_else(|| n.to_string(), masks::js_number),
        Json::String(s) => s.clone(),
        Json::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(",")
        }
        Json::Object(_) => "[object Object]".into(),
    }
}

/// `t` snapped as `time.snap` snaps a Number: rounded to a tick first.
pub(crate) fn snap_f(t: f64, fps: Fps, nearest: bool) -> Ticks {
    cut_time::snap(js_round(t) as Ticks, fps, nearest)
}

fn is_int(v: &Json) -> bool {
    v.as_f64().is_some_and(|x| x.is_finite() && x.fract() == 0.0)
}

fn num(v: Option<&Json>) -> Option<f64> {
    v.and_then(Json::as_f64)
}

/// `obj[key] ??= value`.
fn fill(obj: &mut Map<String, Json>, key: &str, value: impl FnOnce() -> Json) {
    if obj.get(key).is_none_or(Json::is_null) {
        obj.insert(key.to_owned(), value());
    }
}

fn damaged(what: &str) -> LoadError {
    LoadError::Damaged(format!("{what} is not an object"))
}

fn objects<'a>(v: &'a mut Json, what: &str) -> Result<Vec<&'a mut Map<String, Json>>, LoadError> {
    match v {
        Json::Array(a) => a.iter_mut().map(|x| x.as_object_mut().ok_or_else(|| damaged(what))).collect(),
        _ => Err(LoadError::Damaged(format!("{what} is not a list"))),
    }
}

fn fps_of(seq: &Map<String, Json>) -> Option<Fps> {
    let a = seq.get("fps")?.as_array()?;
    if a.len() != 2 {
        return None;
    }
    let n = a[0].as_u64().filter(|&x| x <= u32::MAX as u64)?;
    let d = a[1].as_u64().filter(|&x| x <= u32::MAX as u64)?;
    let fps = Fps::new(n as u32, d as u32);
    valid_fps(fps).then_some(fps)
}

/// `{ ...createTrack(tr.kind, tr.id), ...tr }`.
fn full_track(tr: &Map<String, Json>) -> Map<String, Json> {
    let kind = if tr.get("kind").and_then(Json::as_str) == Some("video") { TrackKind::Video } else { TrackKind::Audio };
    let Json::Object(mut m) =
        serde_json::to_value(defaults::track(kind, Id::new("V1"), None)).expect("a track serializes")
    else {
        unreachable!()
    };
    for k in ["id", "name", "kind"] {
        m.remove(k);
    }
    if let Some(id) = tr.get("id") {
        m.insert("id".into(), id.clone());
        m.insert("name".into(), id.clone());
    }
    m.extend(tr.clone());
    m
}

fn props_json(kind: Option<TrackKind>) -> Map<String, Json> {
    let p = crate::project::Props::of(kind.unwrap_or(TrackKind::Video));
    let Json::Object(m) = serde_json::to_value(p).expect("props serialize") else { unreachable!() };
    m
}

/// The project as this version reads it, or why it cannot be read.
pub fn migrate(json: Json) -> Result<Json, LoadError> {
    let mut p = json;
    let Some(o) = p.as_object_mut().filter(|o| o.get("format").and_then(Json::as_str) == Some("ncut")) else {
        return Err(LoadError::NotProject);
    };
    let version = o.get("version").cloned().unwrap_or(Json::Null);
    if !is_int(&version) || version.as_f64().is_some_and(|v| v > VERSION as f64) {
        let shown = if o.contains_key("version") { js_string(&version) } else { "undefined".into() };
        return Err(LoadError::Newer(format!("format version {shown}, this app reads {VERSION}")));
    }
    o.insert("version".into(), json!(VERSION));
    let mut settings = defaults::default_settings();
    if let Some(Json::Object(s)) = o.get("settings") {
        settings.extend(s.clone());
    }
    o.insert("settings".into(), Json::Object(settings));
    for key in ["media", "bins", "sequences"] {
        if !o.get(key).is_some_and(Json::is_array) {
            o.insert(key.into(), json!([]));
        }
    }
    for m in objects(o.get_mut("media").expect("set above"), "media")? {
        let path = m.get("path").filter(|v| !v.is_null() && v.as_str() != Some("")).map(js_string).unwrap_or_default();
        fill(m, "name", || json!(path.rsplit(['\\', '/']).next().unwrap_or_default()));
        fill(m, "size", || json!(0));
        fill(m, "mtime", || json!(0));
        for k in ["video", "audio", "interpret"] {
            m.entry(k).or_insert(Json::Null);
        }
        if let Some(Json::String(s)) = m.get("proxy") {
            let s = s.clone();
            m.insert("proxy".into(), json!({ "path": s }));
        }
        m.entry("proxy").or_insert(Json::Null);
    }
    for b in objects(o.get_mut("bins").expect("set above"), "bin")? {
        b.entry("parent").or_insert(Json::Null);
        fill(b, "items", || json!([]));
    }
    let media_kinds: Vec<(Json, Json)> = o["media"]
        .as_array()
        .map(|a| a.iter().map(|m| (m["id"].clone(), m["kind"].clone())).collect())
        .unwrap_or_default();
    let is_still = |c: &Map<String, Json>| -> bool {
        let Some(src) = c.get("source").and_then(Json::as_object) else { return false };
        if src.get("generator").is_some_and(Json::is_string) || src.get("freeze").is_some_and(truthy) {
            return true;
        }
        let Some(id) = src.get("media").filter(|v| !v.is_null()) else { return false };
        media_kinds.iter().any(|(m, k)| m == id && k.as_str() == Some("image"))
    };
    let mut max_id = 0_i64;
    for seq in objects(o.get_mut("sequences").expect("set above"), "sequence")? {
        migrate_sequence(seq, &is_still)?;
        visit_ids(seq, &mut max_id);
    }
    for key in ["media", "bins"] {
        for x in o[key].as_array().into_iter().flatten() {
            visit(x.get("id"), &mut max_id);
        }
    }
    let next = o.get("nextId").filter(|v| is_int(v)).and_then(Json::as_f64).unwrap_or(1.0);
    o.insert("nextId".into(), json!(next.max(max_id.saturating_add(1) as f64) as i64));
    if o.contains_key("luts") {
        let used = luts_used(o);
        let keep: Map<String, Json> = match o.get("luts") {
            Some(Json::Object(l)) => l
                .iter()
                .filter(|(id, e)| {
                    used.contains(id.as_str()) && crate::lumetri::valid_id(id) && crate::lumetri::valid_entry(e)
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            _ => Map::new(),
        };
        if keep.is_empty() {
            o.remove("luts");
        } else {
            o.insert("luts".into(), Json::Object(keep));
        }
    }
    Ok(p)
}

fn luts_used(o: &Map<String, Json>) -> std::collections::HashSet<String> {
    let mut used = std::collections::HashSet::new();
    for seq in o["sequences"].as_array().into_iter().flatten() {
        for c in seq["clips"].as_array().into_iter().flatten() {
            for e in c["effects"].as_array().into_iter().flatten() {
                if let Some(l) = e.get("params").and_then(|p| p.get("lut")).and_then(Json::as_str)
                    && !l.is_empty()
                {
                    used.insert(l.to_owned());
                }
            }
        }
    }
    used
}

fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Json::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The number of an id as `ID_RE` reads it: letters then digits.
fn visit(id: Option<&Json>, max: &mut i64) {
    if let Some(n) = id.map(js_string).and_then(|s| Id::new(&s).number()) {
        *max = (*max).max(n);
    }
}

fn visit_ids(seq: &Map<String, Json>, max: &mut i64) {
    visit(seq.get("id"), max);
    for c in seq["clips"].as_array().into_iter().flatten() {
        visit(c.get("id"), max);
        for m in c.get("markers").and_then(Json::as_array).into_iter().flatten() {
            visit(m.get("id"), max);
        }
    }
    for t in seq["transitions"].as_array().into_iter().flatten() {
        visit(t.get("id"), max);
    }
    for m in seq["markers"].as_array().into_iter().flatten() {
        visit(m.get("id"), max);
    }
    for ct in seq["captions"].as_array().into_iter().flatten() {
        visit(ct.get("id"), max);
        for it in ct["items"].as_array().into_iter().flatten() {
            visit(it.get("id"), max);
        }
    }
}

fn marker_defaults(m: &mut Map<String, Json>) {
    fill(m, "duration", || json!(0));
    fill(m, "name", || json!(""));
    fill(m, "note", || json!(""));
    fill(m, "kind", || json!("comment"));
    fill(m, "color", || json!("green"));
}

fn migrate_sequence(
    seq: &mut Map<String, Json>,
    is_still: &dyn Fn(&Map<String, Json>) -> bool,
) -> Result<(), LoadError> {
    let id = seq.get("id").cloned().unwrap_or(Json::Null);
    let base = json!({
        "id": id, "name": "Sequence 1", "w": 1920, "h": 1080, "fps": [30, 1], "rate": 48000, "background": "#000000",
        "masterGain": 0, "tracks": [], "clips": [], "transitions": [], "markers": [], "captions": [],
    });
    for (k, v) in base.as_object().expect("an object") {
        fill(seq, k, || v.clone());
    }
    let mut kinds: Vec<(Json, TrackKind)> = Vec::new();
    for tr in objects(seq.get_mut("tracks").expect("filled"), "track")? {
        *tr = full_track(tr);
        let kind =
            if tr.get("kind").and_then(Json::as_str) == Some("video") { TrackKind::Video } else { TrackKind::Audio };
        kinds.push((tr.get("id").cloned().unwrap_or(Json::Null), kind));
    }
    let kind_of = |track: Option<&Json>| track.and_then(|t| kinds.iter().find(|(id, _)| id == t)).map(|(_, k)| *k);
    // createClip's fields of each kind (id, track and source are the clip's own), made once
    let template = |kind: Option<TrackKind>| {
        json!({
            "start": 0, "in": 0, "out": 0, "speed": 1, "reverse": false, "enabled": true, "link": null, "group": null, "name": "", "label": null,
            "role": null, "props": props_json(kind), "keyframes": {}, "effects": [], "fadeIn": 0, "fadeOut": 0,
            "remap": null, "sampling": "sample",
        })
    };
    let (video, audio) = (template(Some(TrackKind::Video)), template(Some(TrackKind::Audio)));
    for c in objects(seq.get_mut("clips").expect("filled"), "clip")? {
        let kind = kind_of(c.get("track"));
        let full = if kind == Some(TrackKind::Audio) { &audio } else { &video };
        for (k, v) in full.as_object().expect("an object") {
            if c.get(k).is_none_or(Json::is_null) {
                c.insert(k.clone(), v.clone());
            }
        }
        if !c["role"].is_null() && !c["role"].as_str().is_some_and(|r| ROLES.contains(&r)) {
            c.insert("role".into(), Json::Null);
        }
        if !c["sampling"].as_str().is_some_and(|s| SAMPLINGS.contains(&s)) {
            c.insert("sampling".into(), json!("sample"));
        }
        let mut props = full["props"].as_object().expect("an object").clone();
        if let Some(Json::Object(given)) = c.get("props") {
            for (k, v) in given {
                props.insert(k.clone(), v.clone());
            }
        }
        c.insert("props".into(), Json::Object(props));
        if let Some(Json::Object(kf)) = c.get_mut("keyframes") {
            for list in kf.values_mut() {
                for k in list.as_array_mut().into_iter().flatten().filter_map(Json::as_object_mut) {
                    let e = k.get("ease").and_then(Json::as_str).unwrap_or("");
                    let ease = if EASES.contains(&e) {
                        e
                    } else {
                        match e {
                            "in" => "easeIn",
                            "out" => "easeOut",
                            "inOut" => "easeInOut",
                            _ => "linear",
                        }
                    };
                    k.insert("ease".into(), json!(ease));
                }
            }
        }
        for e in c.get_mut("effects").and_then(Json::as_array_mut).into_iter().flatten().filter_map(Json::as_object_mut)
        {
            fill(e, "on", || json!(true));
            fill(e, "params", || json!({}));
        }
        let has_masks = c.contains_key("masks")
            || c["effects"].as_array().is_some_and(|a| a.iter().any(|e| e.get("masks").is_some()));
        if has_masks {
            migrate_masks(c, kind);
        }
        for m in c.get_mut("markers").and_then(Json::as_array_mut).into_iter().flatten().filter_map(Json::as_object_mut)
        {
            marker_defaults(m);
        }
    }
    for t in objects(seq.get_mut("transitions").expect("filled"), "transition")? {
        fill(t, "align", || json!("center"));
        fill(t, "params", || json!({}));
    }
    for m in objects(seq.get_mut("markers").expect("filled"), "marker")? {
        marker_defaults(m);
    }
    let short = num(seq.get("w")).unwrap_or(0.0).min(num(seq.get("h")).unwrap_or(0.0));
    for ct in objects(seq.get_mut("captions").expect("filled"), "caption track")? {
        if ct.get("id").is_none_or(Json::is_null) && ct.get("track").is_some_and(|t| !t.is_null()) {
            let t = ct.remove("track").expect("checked");
            ct.insert("id".into(), t);
        }
        if let Some(Json::Object(style)) = ct.get_mut("style")
            && style.get("ref").is_none_or(Json::is_null)
            && let Some(size) = num(style.get("size")).filter(|s| s.is_finite() && *s != 54.0)
            && short > 0.0
        {
            style.insert("size".into(), json!((js_round(size * 1080.0 / short)).max(1.0) as i64));
        }
        fill(ct, "lang", || json!(""));
        let lang = ct["lang"].clone();
        fill(ct, "name", || if truthy(&lang) { lang.clone() } else { json!("Captions") });
        let mut style = defaults::default_caption_style();
        if let Some(Json::Object(s)) = ct.get("style") {
            style.extend(s.clone());
        }
        ct.insert("style".into(), Json::Object(style));
        fill(ct, "syncLock", || json!(true));
        fill(ct, "items", || json!([]));
    }
    if let Some(fps) = fps_of(seq) {
        snap_times(seq, fps, &kinds, is_still)?;
    }
    Ok(())
}

fn snap_times(
    seq: &mut Map<String, Json>,
    fps: Fps,
    kinds: &[(Json, TrackKind)],
    is_still: &dyn Fn(&Map<String, Json>) -> bool,
) -> Result<(), LoadError> {
    let f = frame(fps);
    let sn = |t: f64| snap_f(t, fps, true);
    let snj = |v: Option<&Json>| json!(sn(num(v).unwrap_or(f64::NAN)));
    for c in objects(seq.get_mut("clips").expect("filled"), "clip")? {
        let video = c.get("track").and_then(|t| kinds.iter().find(|(id, _)| id == t)).map(|(_, k)| *k)
            == Some(TrackKind::Video);
        let curve: Option<Remap> =
            c.get("remap").filter(|r| !r.is_null()).and_then(|r| serde_json::from_value(r.clone()).ok());
        let has_remap = c.get("remap").is_some_and(|r| !r.is_null());
        let (cin, cout) = (num(c.get("in")).unwrap_or(f64::NAN), num(c.get("out")).unwrap_or(f64::NAN));
        if has_remap && (!curve.as_ref().is_some_and(|r| R::valid(r, f)) || !video || is_still(c)) {
            let d = c["remap"].get("duration");
            let len = match d.and_then(Json::as_f64) {
                Some(x) if is_int(d.expect("some")) && x >= f as f64 && x % f as f64 == 0.0 => x,
                _ => (f as f64).max(sn(cout - cin) as f64),
            };
            let speed = (cout - cin) / len;
            c.insert("remap".into(), Json::Null);
            c.insert("reverse".into(), json!(false));
            if (0.01..=100.0).contains(&speed) {
                c.insert("speed".into(), json!(speed));
            } else {
                c.insert("speed".into(), json!(1));
                c.insert("out".into(), json!(cin + len));
            }
        } else if let Some(r) = curve.filter(|_| has_remap) {
            let (lo, hi) = R::range(&r);
            c.insert("in".into(), json!(lo));
            c.insert("out".into(), json!(hi));
            c.insert("speed".into(), json!(1));
            c.insert("reverse".into(), json!(false));
        }
        if let Some(Json::Object(kf)) = c.get_mut("keyframes") {
            for list in kf.values_mut() {
                let mut by_t: Vec<(Ticks, Json)> = Vec::new();
                for k in list.as_array().into_iter().flatten() {
                    let t = sn(num(k.get("t")).unwrap_or(f64::NAN));
                    let mut k = k.clone();
                    if let Some(o) = k.as_object_mut() {
                        o.insert("t".into(), json!(t));
                    }
                    match by_t.iter_mut().find(|(x, _)| *x == t) {
                        Some(slot) => slot.1 = k,
                        None => by_t.push((t, k)),
                    }
                }
                by_t.sort_by_key(|(t, _)| *t);
                *list = Json::Array(by_t.into_iter().map(|(_, k)| k).collect());
            }
        }
        for m in c.get_mut("markers").and_then(Json::as_array_mut).into_iter().flatten().filter_map(Json::as_object_mut)
        {
            let t = snj(m.get("t"));
            let d = json!(sn(num(m.get("duration")).unwrap_or(0.0)));
            m.insert("t".into(), t);
            m.insert("duration".into(), d);
        }
    }
    for m in objects(seq.get_mut("markers").expect("filled"), "marker")? {
        let t = snj(m.get("t"));
        let d = snj(m.get("duration"));
        m.insert("t".into(), t);
        m.insert("duration".into(), d);
    }
    for ct in objects(seq.get_mut("captions").expect("filled"), "caption track")? {
        let Some(items) = ct.get_mut("items").and_then(Json::as_array_mut) else { continue };
        for it in items.iter_mut().filter_map(Json::as_object_mut) {
            let s = sn(num(it.get("start")).unwrap_or(f64::NAN));
            let e = (s + f).max(sn(num(it.get("end")).unwrap_or(f64::NAN)));
            it.insert("start".into(), json!(s));
            it.insert("end".into(), json!(e));
        }
        for it in items.iter_mut().filter_map(Json::as_object_mut) {
            let Some(words) = it.get("words") else { continue };
            let text = it.get("text").and_then(Json::as_str).unwrap_or_default();
            let d = it["end"].as_i64().unwrap_or(0) - it["start"].as_i64().unwrap_or(0);
            match captionwords::realign(words, text, f, Some(d)) {
                Some(w) => {
                    it.insert("words".into(), serde_json::to_value(w).expect("words serialize"));
                }
                None => {
                    it.remove("words");
                }
            }
        }
        items.sort_by_key(|it| it["start"].as_i64().unwrap_or(0));
    }
    Ok(())
}

/// Masks get the fields they lack; a mask that is not well formed, a list that is not a list and masks on an audio
/// track go, with their keyframes and the keyframes that are not values of their field.
fn migrate_masks(c: &mut Map<String, Json>, kind: Option<TrackKind>) {
    let video = kind == Some(TrackKind::Video);
    let clean = |holder: &mut Map<String, Json>| {
        let Some(list) = holder.get("masks") else { return };
        let mut keep: Vec<Json> = Vec::new();
        let mut ids = std::collections::HashSet::new();
        if video && let Some(a) = list.as_array() {
            for m in a.iter().filter(|m| m.is_object()).filter_map(masks::full) {
                if ids.insert(m.id) {
                    keep.push(serde_json::to_value(m).expect("a mask serializes"));
                }
            }
        }
        keep.truncate(masks::MAX_MASKS);
        if keep.is_empty() {
            holder.remove("masks");
        } else {
            holder.insert("masks".into(), Json::Array(keep));
        }
    };
    clean(c);
    for e in c.get_mut("effects").and_then(Json::as_array_mut).into_iter().flatten().filter_map(Json::as_object_mut) {
        clean(e);
    }
    let has = |c: &Map<String, Json>, effect: Option<&str>, mask: &str| -> bool {
        let holder = match effect {
            None => Some(c),
            Some(e) => c["effects"]
                .as_array()
                .and_then(|a| a.iter().find(|x| x["id"].as_str() == Some(e)))
                .and_then(Json::as_object),
        };
        holder
            .and_then(|h| h.get("masks"))
            .and_then(Json::as_array)
            .is_some_and(|l| l.iter().any(|m| m["id"].as_str() == Some(mask)))
    };
    let props: Vec<String> =
        c.get("keyframes").and_then(Json::as_object).map(|k| k.keys().cloned().collect()).unwrap_or_default();
    for prop in props {
        let pp = masks::parse_path(&prop, false)
            .map(|p| (p.effect_id.map(str::to_owned), p.mask_id.to_owned(), p.field.to_owned()));
        if pp.is_none() && !prop.starts_with("masks.") && !prop.contains(".masks.") {
            continue;
        }
        let keep = pp.as_ref().filter(|(e, m, _)| has(c, e.as_deref(), m));
        let kf = c.get_mut("keyframes").and_then(Json::as_object_mut).expect("listed above");
        let Some((_, _, field)) = keep else {
            kf.remove(&prop);
            continue;
        };
        let good: Vec<Json> = kf[&prop]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|k| masks::valid_field(field, k.get("v").unwrap_or(&Json::Null)))
            .cloned()
            .collect();
        if good.is_empty() {
            kf.remove(&prop);
        } else {
            kf.insert(prop, Json::Array(good));
        }
    }
}
