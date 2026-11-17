//! A clip's settings, speed, time remapping, keyframes, effects and Lumetri Color (control.js), with the checks of
//! values the tools share (`effectDef`, `paramValue`, `propValue`).

use cut_model::commands::build as C;
use cut_model::effects::{self as E, Def, ParamKind};
use cut_model::remap::{self as RM, Remap, Side};
use cut_model::{Source, TrackKind};
use cut_time::TICKS;
use serde_json::{Map, Value as Json, json};

use crate::control::call::{Cx, Out, R, arg, b, f, given, num, r3, refuse, round, s};
use crate::control::schema::js_num;

const T: f64 = TICKS as f64;

/// `effectDef`: an effect (not a transition) of the registry.
pub fn effect_def(kind: &str) -> R<&'static Def> {
    match E::get(kind) {
        Some(d) if !d.transition => Ok(d),
        _ => refuse(format!("There is no effect \"{kind}\". list_effects lists them.")),
    }
}

fn is_color6(v: &str) -> bool {
    v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn opt(x: Option<f64>) -> String {
    x.map_or_else(|| "undefined".into(), js_num)
}

/// `paramValue(def, id, v, at, luts)`: a parameter's value checked against its kind and range.
pub fn param_value(def: &Def, id: &str, v: &Json, at: &str, luts: Option<&Json>) -> R<Json> {
    let Some(p) = def.params.iter().find(|p| p.id == id) else {
        let ids: Vec<&str> = def.params.iter().map(|p| p.id).collect();
        return refuse(format!("Effect {} has no parameter \"{id}\". Its parameters: {}.", def.id, ids.join(", ")));
    };
    match p.kind {
        ParamKind::Number | ParamKind::Percent | ParamKind::Angle => {
            let Some(x) = v.as_f64().filter(|x| x.is_finite()) else {
                return refuse(format!("{at} must be a number."));
            };
            if p.min.is_some_and(|m| x < m) || p.max.is_some_and(|m| x > m) {
                return refuse(format!("{at} {} is outside {} to {}.", js_num(x), opt(p.min), opt(p.max)));
            }
        }
        ParamKind::Bool => {
            if !v.is_boolean() {
                return refuse(format!("{at} must be true or false."));
            }
        }
        ParamKind::Choice => {
            if !p.choices.iter().any(|(c, _)| v.as_str() == Some(c)) {
                let all: Vec<&str> = p.choices.iter().map(|c| c.0).collect();
                return refuse(format!("{at} must be one of {}.", all.join(", ")));
            }
        }
        ParamKind::Color => {
            if !v.as_str().is_some_and(is_color6) {
                return refuse(format!("{at} must be a color like #ff8800."));
            }
        }
        ParamKind::Point => {
            if !v.as_array().is_some_and(|a| a.len() == 2 && a.iter().all(|x| x.as_f64().is_some())) {
                return refuse(format!("{at} must be [x, y]."));
            }
        }
        ParamKind::Curve => {
            let ok = v.as_array().is_some_and(|a| {
                a.len() % 2 == 0
                    && (4..=32).contains(&a.len())
                    && a.iter().all(|x| x.as_f64().is_some_and(|x| (0.0..=1.0).contains(&x)))
            });
            if !ok {
                return refuse(format!(
                    "{at} must be a flat list of 2 to 16 points [x0, y0, x1, y1, ...] from 0 to 1."
                ));
            }
        }
        ParamKind::Lut => {
            let known = |k: &str| luts.and_then(Json::as_object).is_some_and(|m| m.contains_key(k));
            if v.as_str() == Some("") || v.as_str().is_some_and(known) {
                return Ok(v.clone());
            }
            let names: Vec<String> =
                luts.and_then(Json::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
            return refuse(format!(
                "{at} must be \"\" (no LUT) or a LUT the project has (get_project lists luts: {}). Loading a LUT file is the user's.",
                if names.is_empty() { "none".to_owned() } else { names.join(", ") }
            ));
        }
    }
    Ok(v.clone())
}

/// `PROP_RULES` and `propValue(name, v)`: a clip property's static value.
pub fn prop_value(name: &str, v: &Json) -> R<Json> {
    let (pair, four, min, max, desc) = match name {
        "position" => (true, false, None, None, "[x, y] pixels from the center"),
        "scale" => (true, false, Some(0.0), Some(10000.0), "[width %, height %] or one %"),
        "rotation" => (false, false, Some(-36000.0), Some(36000.0), "degrees"),
        "anchor" => (true, false, None, None, "[x, y] pixels from the center"),
        "opacity" => (false, false, Some(0.0), Some(100.0), "%"),
        "crop" => (false, true, Some(0.0), Some(100.0), "[top, right, bottom, left] %"),
        "volume" => (false, false, Some(-60.0), Some(24.0), "dB"),
        _ => (false, false, Some(-100.0), Some(100.0), "-100 left to 100 right"),
    };
    let v = if name == "scale" && v.is_number() { json!([v, v]) } else { v.clone() };
    let in_range = |x: &Json| {
        x.as_f64().is_some_and(|x| x.is_finite() && min.is_none_or(|m| x >= m && max.is_none_or(|n| x <= n)))
    };
    let list = |n: usize| v.as_array().is_some_and(|a| a.len() == n && a.iter().all(in_range));
    if pair && !list(2) {
        let each = min.map(|m| format!(", each {} to {}", js_num(m), opt(max))).unwrap_or_default();
        return refuse(format!("{name} must be {desc}{each}."));
    }
    if four && !list(4) {
        return refuse(format!("{name} must be {desc}."));
    }
    if !pair && !four && !(v.is_number() && in_range(&v)) {
        return refuse(format!("{name} must be a number from {} to {} ({desc}).", opt(min), opt(max)));
    }
    Ok(v)
}

pub fn set_clip(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let mut patch = Map::new();
    let mut props = Map::new();
    for k in ["opacity", "position", "scale", "rotation", "anchor", "crop"] {
        if let Some(v) = a.get(k) {
            c.need_kind(&clip, TrackKind::Video, k)?;
            props.insert(k.into(), prop_value(k, v)?);
        }
    }
    for k in ["volume", "pan"] {
        if let Some(v) = a.get(k) {
            c.need_kind(&clip, TrackKind::Audio, k)?;
            props.insert(k.into(), prop_value(k, v)?);
        }
    }
    for (k, key) in [("fade_in", "fadeIn"), ("fade_out", "fadeOut")] {
        if let Some(x) = a.get(k) {
            c.need_kind(&clip, TrackKind::Audio, k)?;
            patch.insert(key.into(), json!(c.ticks(x.as_f64().unwrap_or(0.0))));
        }
    }
    for k in props.keys() {
        if clip.keyframes.get(k).is_some_and(|l| !l.is_empty()) {
            return refuse(format!(
                "{k} of {} has keyframes; change them with set_keyframes (or clear them there first).",
                clip.id.as_str()
            ));
        }
    }
    if !props.is_empty() {
        patch.insert("props".into(), Json::Object(props));
    }
    for k in ["name", "enabled", "role", "label"] {
        if let Some(v) = a.get(k) {
            patch.insert(k.into(), v.clone());
        }
    }
    if let Some(v) = a.get("interpolation") {
        c.need_kind(&clip, TrackKind::Video, "interpolation")?;
        patch.insert("sampling".into(), v.clone());
    }
    let color = s(a, "color");
    if given(a, "color") {
        let generator = match &clip.source {
            Source::Generator { generator, .. } => Some(*generator),
            _ => None,
        };
        if generator != Some(cut_model::Generator::Solid) {
            let text =
                if generator == Some(cut_model::Generator::Text) { " (set_text changes a title's color)" } else { "" };
            return refuse(format!("color is for color mattes; {} is not one{text}.", clip.id.as_str()));
        }
        if !color.is_some_and(is_color6) {
            return refuse("color must look like #2f6fdb.");
        }
    }
    if patch.is_empty() && color.is_none() {
        return refuse("Give at least one setting to change.");
    }
    let linked = b(a, "linked") != Some(false);
    let (seq, id) = (c.seq_id(), clip.id);
    c.atomic("Clip Settings", |c| {
        if !patch.is_empty() {
            c.run(&C::set_clip(seq.as_str(), id.as_str(), Json::Object(patch), json!({ "linked": linked })))?;
        }
        if let Some(col) = color {
            c.run(&C::set_generator(seq.as_str(), id.as_str(), json!({ "color": col.to_lowercase() })))?;
        }
        Ok(())
    })?;
    Ok(json!({ "edit": { "at": clip.start }, "clip": id.as_str() }).into())
}

pub fn set_speed(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let (speed, duration, reverse) = (f(a, "speed"), f(a, "duration"), b(a, "reverse"));
    if speed.is_none() && reverse.is_none() && duration.is_none() {
        return refuse("Give speed, duration or reverse.");
    }
    if speed.is_some() && duration.is_some() {
        return refuse("Give speed or duration, not both.");
    }
    let id = clip.id.as_str();
    if clip.remap.is_some() {
        return refuse(format!("{id} has Time Remapping; change it with set_time_remap, or turn it off there first."));
    }
    if c.project().is_still(&clip) {
        return refuse(format!(
            "{id} is a still (a picture, text or a freeze frame) and has no speed; trim it to change its length."
        ));
    }
    let ripple = b(a, "ripple") != Some(false);
    let opts = json!({ "linked": b(a, "linked") != Some(false) });
    let seq = c.seq_id();
    let fr = c.f();
    c.atomic("Speed/Duration", |c| {
        if let Some(v) = speed {
            c.run(&C::set_clip(seq.as_str(), id, json!({ "speed": v / 100.0, "ripple": ripple }), opts.clone()))?;
        }
        if let Some(d) = duration {
            let t = (round(c.ticks(d) as f64 / fr as f64) as i64 * fr).max(fr);
            c.run(&C::set_clip(seq.as_str(), id, json!({ "duration": t, "ripple": ripple }), opts.clone()))?;
        }
        if let Some(r) = reverse {
            c.run(&C::set_clip(seq.as_str(), id, json!({ "reverse": r }), opts.clone()))?;
        }
        Ok(())
    })?;
    let Some(now) = c.seq().clip(clip.id).cloned() else { return refuse("The editor refused: the clip is gone.") };
    Ok(json!({ "edit": { "at": clip.start }, "start": c.sec(now.start as f64), "end": c.sec(now.end() as f64), "speed": num(r3(now.speed * 100.0)) }).into())
}

pub fn set_time_remap(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    c.need_kind(&clip, TrackKind::Video, "Time Remapping")?;
    let (seq, id) = (c.seq_id(), clip.id.as_str());
    if b(a, "off") == Some(true) {
        c.run(&C::set_remap(seq.as_str(), id, None))?;
        return Ok(json!({ "edit": { "at": clip.start } }).into());
    }
    let Some(segments) = arg(a, "segments").and_then(Json::as_array) else {
        return refuse("Give segments, or off: true.");
    };
    if c.project().is_still(&clip) {
        return refuse(format!("{id} is a still and has no source frames to remap."));
    }
    let fr = c.f();
    let frames = |s: f64| (round(s * T / fr as f64) as i64 * fr).max(fr);
    struct Moving {
        speed: f64,
        until: Option<f64>,
        ramp: Option<f64>,
        i: usize,
    }
    let mut moving: Vec<Moving> = Vec::new();
    let mut inserts: Vec<(usize, &str, i64, usize)> = Vec::new();
    for (i, sg) in segments.iter().enumerate() {
        let kinds: Vec<&str> = ["speed", "hold", "reverse"].into_iter().filter(|k| arg(sg, k).is_some()).collect();
        if kinds.len() != 1 {
            return refuse(format!("segments[{i}] needs exactly one of speed, hold or reverse."));
        }
        if kinds[0] == "speed" {
            moving.push(Moving {
                speed: f(sg, "speed").unwrap_or(100.0),
                until: f(sg, "until"),
                ramp: f(sg, "ramp"),
                i,
            });
            continue;
        }
        if arg(sg, "until").is_some() || arg(sg, "ramp").is_some() {
            return refuse(format!("segments[{i}] (a {}) takes no until or ramp.", kinds[0]));
        }
        if moving.is_empty() || segments.get(i + 1).is_none_or(|n| arg(n, "speed").is_none()) {
            return refuse(format!("segments[{i}] (a {}) goes between two speed segments.", kinds[0]));
        }
        inserts.push((moving.len() - 1, kinds[0], frames(f(sg, kinds[0]).unwrap_or(0.0)), i));
    }
    let Some(last) = moving.last() else {
        return refuse("The editor refused: Cannot read properties of undefined (reading 'until')");
    };
    let end = clip.end();
    if last.until.is_some() {
        return refuse("The last speed segment runs to the clip's end: leave out its \"until\".");
    }
    if last.ramp.is_some_and(|r| r != 0.0) {
        return refuse("The last speed segment has no next speed to ramp into.");
    }
    let mut r: Remap = clip.remap_of();
    if let Some(cur) = &clip.remap {
        let v = RM::speed_at(cur, 0.0);
        let v = if v == 0.0 || v.is_nan() { 1.0 } else { v };
        r = RM::constant(RM::value(cur, 0.0), v.signum() * v.abs().clamp(RM::MIN, RM::MAX), clip.duration());
    }
    let mut cuts = Vec::new();
    for m in &moving[..moving.len() - 1] {
        let Some(u) = m.until else {
            return refuse(format!("segments[{}] needs \"until\" (only the last speed goes to the clip's end).", m.i));
        };
        let t = round((c.ticks(u) - clip.start) as f64 / fr as f64) as i64 * fr;
        if t <= 0 || clip.start + t >= end {
            return refuse(format!(
                "segments[{}].until {} s is not inside the clip ({} to {} s).",
                m.i,
                js_num(u),
                c.sec(clip.start as f64),
                c.sec(end as f64)
            ));
        }
        cuts.push(t);
    }
    if cuts.windows(2).any(|w| w[1] <= w[0]) {
        return refuse("The segments' \"until\" times must grow.");
    }
    for t in &cuts {
        match RM::add_key(&r, *t) {
            Some(n) => r = n,
            None => return refuse(format!("A segment cannot start at {} s.", js_num(r3((clip.start + t) as f64 / T)))),
        }
    }
    let sign = if r.speeds.first().is_some_and(|v| *v < 0.0) { -1.0 } else { 1.0 };
    for (i, m) in moving.iter().enumerate().rev() {
        r = RM::set_segment_speed(&r, i, sign * m.speed / 100.0, fr);
    }
    for (j, m) in moving.iter().enumerate().take(moving.len() - 1) {
        let Some(ramp) = m.ramp.filter(|x| *x != 0.0) else { continue };
        if inserts.iter().any(|x| x.0 == j) {
            return refuse(format!("segments[{}] cannot ramp into a hold or a reverse.", m.i));
        }
        r = RM::split_key(&r, j, Side::Right, frames(ramp), fr);
        if r.keys.get(j).is_none_or(|k| k.ramp == 0) {
            return refuse(format!("There is no room for the ramp of segments[{}].", m.i));
        }
    }
    inserts.sort_by_key(|p| std::cmp::Reverse(p.0));
    for (key, kind, len, i) in inserts {
        if kind == "reverse" {
            let room = RM::reverse_room(&r, key, fr, 0.0);
            if len as f64 > room {
                return refuse(format!(
                    "segments[{i}]: there is only {} s of source before that point to play backward.",
                    js_num(r3(room / T))
                ));
            }
        }
        let next = if kind == "hold" { RM::insert_freeze(&r, key, len) } else { RM::insert_reverse(&r, key, len) };
        match next {
            Some(n) => r = n,
            None => return refuse(format!("segments[{i}] cannot go there.")),
        }
    }
    let res = c.run(&C::set_remap(seq.as_str(), id, Some(serde_json::to_value(&r).unwrap_or_default())))?;
    let now = c.seq().clip(clip.id).cloned();
    let (speeds, keys) = match now.as_ref().and_then(|n| n.remap.as_ref()) {
        Some(m) => (
            m.speeds.iter().map(|v| num(r3(v * 100.0))).collect::<Vec<_>>(),
            m.keys
                .iter()
                .map(|k| {
                    let mut o = json!({ "at": c.sec((clip.start + k.t) as f64) });
                    if k.ramp != 0 {
                        o["ramp"] = c.sec(k.ramp as f64);
                    }
                    o
                })
                .collect::<Vec<_>>(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    Ok(json!({
        "edit": { "at": clip.start }, "duration": c.sec(res["duration"].as_f64().unwrap_or(0.0)),
        "stoppedBy": res.get("clamped").filter(|v| !v.is_null()).cloned(),
        "speeds": speeds, "keys": keys,
    })
    .into())
}

/// `shapePath`: an ellipse or rectangle centered at x, y with width and height (fractions), as a 4-point mask path.
pub fn shape_path(sh: &Json, at: &str) -> R<Vec<f64>> {
    let shape = sh["shape"].as_str().unwrap_or_default();
    if shape != "ellipse" && shape != "rectangle" {
        return refuse(format!("{at}.shape must be ellipse or rectangle."));
    }
    for k in ["x", "y", "width", "height"] {
        let min = if k == "width" || k == "height" { 0.001 } else { 0.0 };
        if let Some(v) = sh.get(k)
            && !v.as_f64().is_some_and(|x| x.is_finite() && x >= min && x <= 4.0)
        {
            return refuse(format!("{at}.{k} must be a fraction of the picture."));
        }
    }
    let g = |k: &str, d: f64| sh.get(k).and_then(Json::as_f64).unwrap_or(d);
    let (cx, cy, hw, hh) = (g("x", 0.5), g("y", 0.5), g("width", 0.5) / 2.0, g("height", 0.5) / 2.0);
    let k = cut_model::masks::KAPPA;
    Ok(if shape == "ellipse" {
        vec![
            cx,
            cy - hh,
            -k * hw,
            0.0,
            k * hw,
            0.0,
            cx + hw,
            cy,
            0.0,
            -k * hh,
            0.0,
            k * hh,
            cx,
            cy + hh,
            k * hw,
            0.0,
            -k * hw,
            0.0,
            cx - hw,
            cy,
            0.0,
            k * hh,
            0.0,
            -k * hh,
        ]
    } else {
        vec![
            cx - hw,
            cy - hh,
            0.0,
            0.0,
            0.0,
            0.0,
            cx + hw,
            cy - hh,
            0.0,
            0.0,
            0.0,
            0.0,
            cx + hw,
            cy + hh,
            0.0,
            0.0,
            0.0,
            0.0,
            cx - hw,
            cy + hh,
            0.0,
            0.0,
            0.0,
            0.0,
        ]
    })
}

/// `LAYER_KEYS`: what a title layer animates.
fn layer_key(field: &str, v: &Json, at: &str) -> R<Json> {
    let n = v.as_f64();
    match field {
        "opacity" if n.is_some_and(|x| (0.0..=100.0).contains(&x)) => Ok(v.clone()),
        "opacity" => refuse(format!("{at} must be 0..100 (%).")),
        "reveal" if n.is_some_and(|x| (0.0..=1.0).contains(&x)) => Ok(v.clone()),
        "reveal" => refuse(format!("{at} must be 0..1.")),
        "size" if n.is_some_and(|x| (8.0..=600.0).contains(&x)) => Ok(v.clone()),
        "size" => refuse(format!("{at} must be 8..600 (px).")),
        "position" => prop_value("position", v),
        _ => refuse(format!("A title layer animates opacity, reveal, size, position; not {field}.")),
    }
}

/// `graphicKey`: a graphic layer's animated field.
fn graphic_key(layers: &[Json], layer_id: &str, field: &str, v: &Json, at: &str) -> R<Json> {
    let l = layers.iter().find(|l| l["id"].as_str() == Some(layer_id)).cloned().unwrap_or_default();
    let kind = l["kind"].as_str().unwrap_or_default();
    let fields = cut_model::graphic::fields_of(kind);
    if !cut_model::graphic::animated(field) || !fields.contains(&field) {
        let can: Vec<&str> = fields.iter().copied().filter(|x| cut_model::graphic::animated(x)).collect();
        return refuse(format!("A {kind} layer animates {}; not {field}.", can.join(", ")));
    }
    let e = cut_model::graphic::check_value(field, v);
    if !e.is_empty() {
        return refuse(format!("{at} {e}."));
    }
    Ok(match v.as_str() {
        Some(t) if t.chars().count() == 7 => json!(format!("{t}ff")),
        _ => v.clone(),
    })
}

pub fn set_keyframes(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let kind = c.kind_of(&clip).unwrap_or(clip.props.kind());
    let prop = s(a, "property").unwrap_or_default();
    if !cut_model::validate::valid_prop_path(&clip, kind, prop) || prop == "duck" {
        let props: &[&str] = if kind == TrackKind::Audio {
            &cut_model::defaults::AUDIO_PROPS
        } else {
            &cut_model::defaults::VIDEO_PROPS
        };
        let effects: Vec<&str> = clip.effects.iter().map(|e| e.id.as_str()).collect();
        return refuse(format!(
            "{} has no property \"{prop}\". It has {} and effects.<id>.<parameter> of its effects ({}).",
            clip.id.as_str(),
            props.join(", "),
            if effects.is_empty() { "none".to_owned() } else { effects.join(", ") }
        ));
    }
    let parts: Vec<&str> = prop.split('.').collect();
    let mask = cut_model::masks::parse_path(prop, false);
    let value = |v: &Json, i: usize| -> R<Json> {
        let at = format!("keyframes[{i}].value");
        if parts.len() == 1 {
            return prop_value(parts[0], v);
        }
        if let Some(mp) = mask {
            let holder = match mp.effect_id {
                Some(e) => clip.effects.iter().find(|x| x.id.as_str() == e).and_then(|x| x.masks.clone()),
                None => clip.masks.clone(),
            };
            let m = holder.unwrap_or_default().into_iter().find(|m| m.id.as_str() == mp.mask_id);
            if mp.field != "path" {
                let [lo, hi] = cut_model::masks::range_of(mp.field).unwrap_or([0.0, 0.0]);
                if !v.as_f64().is_some_and(|x| x >= lo && x <= hi) {
                    return refuse(format!("{at} must be a number from {} to {}.", js_num(lo), js_num(hi)));
                }
                return Ok(v.clone());
            }
            let path: Option<Vec<f64>> = if v.is_object() {
                Some(shape_path(v, &at)?)
            } else {
                v.as_array().and_then(|l| l.iter().map(Json::as_f64).collect())
            };
            let Some(path) = path.filter(|p| cut_model::masks::valid_path(p)) else {
                return refuse(format!("{at} must be {{shape, x, y, width, height}} or a mask path."));
            };
            let have = m.map_or(0, |m| m.path.len());
            if path.len() != have {
                return refuse(format!(
                    "{at} has {} points; mask {} has {} (an ellipse and a rectangle have 4).",
                    js_num(path.len() as f64 / 6.0),
                    mp.mask_id,
                    js_num(have as f64 / 6.0)
                ));
            }
            return Ok(json!(path));
        }
        if parts[0] == "layers" {
            if let Source::Generator { generator: cut_model::Generator::Graphic, layers, .. } = &clip.source {
                return graphic_key(
                    layers.as_deref().unwrap_or_default(),
                    parts[1],
                    parts.get(2).copied().unwrap_or_default(),
                    v,
                    &at,
                );
            }
            return layer_key(parts.get(2).copied().unwrap_or_default(), v, &at);
        }
        if parts[0] == "effects" && parts.len() == 3 {
            let e = clip.effects.iter().find(|x| x.id.as_str() == parts[1]).map(|e| e.kind.clone()).unwrap_or_default();
            let def = effect_def(&e)?;
            if let Some(p) = def.params.iter().find(|p| p.id == parts[2])
                && !p.keyframable
            {
                return refuse(format!("{} of {} cannot be animated.", p.id, def.id));
            }
            return param_value(def, parts[2], v, &at, None);
        }
        Ok(v.clone())
    };
    let (fr, end) = (c.f(), clip.end());
    let mut list = Vec::new();
    for (i, k) in arg(a, "keyframes").and_then(Json::as_array).into_iter().flatten().enumerate() {
        let time = f(k, "time").unwrap_or(0.0);
        let t = c.ticks(time);
        if (t as f64) < clip.start as f64 - fr as f64 / 2.0 || t as f64 > end as f64 + fr as f64 / 2.0 {
            return refuse(format!(
                "keyframes[{i}].time {} s is outside the clip ({} to {} s).",
                js_num(time),
                c.sec(clip.start as f64),
                c.sec(end as f64)
            ));
        }
        let ease = s(k, "ease").unwrap_or("linear");
        list.push(json!({ "t": (t - clip.start).max(0), "v": value(k.get("value").unwrap_or(&Json::Null), i)?, "ease": ease }));
    }
    let first = list.first().map(|k| k["t"].as_i64().unwrap_or(0));
    let n = list.len();
    c.run(&C::set_keyframes(c.seq_id().as_str(), clip.id.as_str(), prop, (n > 0).then_some(Json::Array(list))))?;
    Ok(json!({ "edit": { "at": clip.start + first.unwrap_or(0) }, "keyframes": n }).into())
}

pub fn add_effect(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let def = effect_def(s(a, "type").unwrap_or_default())?;
    let kind = if def.kind == E::Kind::Audio { TrackKind::Audio } else { TrackKind::Video };
    c.need_kind(&clip, kind, &format!("{} (a {} effect)", def.id, def.kind.name()))?;
    let luts = c.project().luts.clone();
    let mut params = Map::new();
    for (k, v) in arg(a, "params").and_then(Json::as_object).into_iter().flatten() {
        params.insert(k.clone(), param_value(def, k, v, &format!("params.{k}"), luts.as_ref())?);
    }
    let index = f(a, "index").map(|i| i as usize);
    let r = c.run(&C::add_effect(c.seq_id().as_str(), clip.id.as_str(), def.id, index, Json::Object(params)))?;
    Ok(json!({ "edit": { "at": clip.start }, "effect": r["id"] }).into())
}

pub fn set_effect(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let eid = s(a, "effect_id").unwrap_or_default();
    let Some(e) = clip.effects.iter().find(|x| x.id.as_str() == eid) else {
        let all: Vec<String> = clip.effects.iter().map(|x| format!("{} {}", x.id.as_str(), x.kind)).collect();
        return refuse(format!(
            "{} has no effect {eid}; its effects: {}.",
            clip.id.as_str(),
            if all.is_empty() { "none".to_owned() } else { all.join(", ") }
        ));
    };
    let def = effect_def(&e.kind)?;
    let luts = c.project().luts.clone();
    let mut params = Map::new();
    for (k, v) in arg(a, "params").and_then(Json::as_object).into_iter().flatten() {
        let key = format!("effects.{}.{k}", e.id.as_str());
        if !v.is_null() && clip.keyframes.get(&key).is_some_and(|l| !l.is_empty()) {
            return refuse(format!("{k} has keyframes; change it with set_keyframes."));
        }
        if v.is_null() && !def.params.iter().any(|p| p.id == k) {
            param_value(def, k, v, k, None)?;
        }
        params.insert(
            k.clone(),
            if v.is_null() { Json::Null } else { param_value(def, k, v, &format!("params.{k}"), luts.as_ref())? },
        );
    }
    let on = a.get("on").cloned();
    let index = f(a, "index").map(|i| i as usize);
    if on.is_none() && params.is_empty() && index.is_none() {
        return refuse("Give on, params or index.");
    }
    if let Some(i) = index
        && i >= clip.effects.len()
    {
        let n = clip.effects.len();
        return refuse(format!("index must be below {n} (the clip has {n} effects)."));
    }
    let (seq, id, eid) = (c.seq_id(), clip.id, e.id);
    c.atomic("Effect Settings", |c| {
        if on.is_some() || !params.is_empty() {
            let mut patch = json!({ "params": params });
            if let Some(o) = on {
                patch["on"] = o;
            }
            c.run(&C::set_effect(seq.as_str(), id.as_str(), eid.as_str(), patch))?;
        }
        if let Some(i) = index {
            c.run(&C::move_effect(seq.as_str(), id.as_str(), eid.as_str(), i))?;
        }
        Ok(())
    })?;
    Ok(json!({ "edit": { "at": clip.start }, "effect": eid.as_str() }).into())
}

pub fn remove_effect(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    let eid = s(a, "effect_id").unwrap_or_default();
    if !clip.effects.iter().any(|x| x.id.as_str() == eid) {
        return refuse(format!("{} has no effect {eid}.", clip.id.as_str()));
    }
    c.run(&C::remove_effect(c.seq_id().as_str(), clip.id.as_str(), eid))?;
    Ok(json!({ "edit": { "at": clip.start } }).into())
}

const COLOR_KEYS: [&str; 10] = [
    "temperature",
    "tint",
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "saturation",
    "vibrance",
];
const CURVES: [(&str, &str); 4] =
    [("master", "curveMaster"), ("red", "curveRed"), ("green", "curveGreen"), ("blue", "curveBlue")];
const HSL: [(&str, &str); 15] = [
    ("hue", "hslHue"),
    ("hue_range", "hslHueRange"),
    ("hue_soft", "hslHueSoft"),
    ("sat_low", "hslSatLow"),
    ("sat_high", "hslSatHigh"),
    ("sat_soft", "hslSatSoft"),
    ("lum_low", "hslLumLow"),
    ("lum_high", "hslLumHigh"),
    ("lum_soft", "hslLumSoft"),
    ("show_mask", "hslMask"),
    ("temperature", "hslTemperature"),
    ("tint", "hslTint"),
    ("contrast", "hslContrast"),
    ("saturation", "hslSaturation"),
    ("hue_shift", "hslHueShift"),
];

pub fn set_color(c: &mut Cx, a: &Json) -> R<Out> {
    let clip = c.clip_of(s(a, "clip_id").unwrap_or_default(), true)?;
    c.need_kind(&clip, TrackKind::Video, "Lumetri Color")?;
    let def = effect_def("color.basic")?;
    let luts = c.project().luts.clone();
    let mut params = Map::new();
    let mut order: Vec<&str> = Vec::new();
    let mut put = |key: &'static str, v: &Json, at: &str| -> R<()> {
        params.insert(key.into(), param_value(def, key, v, at, luts.as_ref())?);
        if !order.contains(&key) {
            order.push(key);
        }
        Ok(())
    };
    for k in COLOR_KEYS {
        if let Some(v) = a.get(k) {
            put(k, v, k)?;
        }
    }
    if let Some(v) = a.get("lut") {
        put("lut", v, "lut")?;
    }
    if let Some(v) = a.get("lut_intensity") {
        put("lutIntensity", v, "lut_intensity")?;
    }
    for (k, key) in CURVES {
        if let Some(v) = a.get("curves").and_then(|x| x.get(k)) {
            put(key, v, &format!("curves.{k}"))?;
        }
    }
    for (k, key) in HSL {
        if let Some(v) = a.get("hsl").and_then(|x| x.get(k)) {
            put(key, v, &format!("hsl.{k}"))?;
        }
    }
    if params.is_empty() {
        return refuse(format!("Give at least one of {}, lut, lut_intensity, curves, hsl.", COLOR_KEYS.join(", ")));
    }
    let e = clip.effects.iter().find(|x| x.kind == "color.basic").map(|e| e.id);
    if let Some(eid) = e {
        for k in &order {
            if clip.keyframes.get(&format!("effects.{}.{k}", eid.as_str())).is_some_and(|l| !l.is_empty()) {
                return refuse(format!(
                    "{k} has keyframes; change it with set_keyframes on effects.{}.{k}.",
                    eid.as_str()
                ));
            }
        }
    }
    let seq = c.seq_id();
    let id = match e {
        Some(eid) => {
            c.run(&C::set_effect(seq.as_str(), clip.id.as_str(), eid.as_str(), json!({ "params": params })))?;
            json!(eid.as_str())
        }
        None => c.run(&C::add_effect(seq.as_str(), clip.id.as_str(), "color.basic", None, Json::Object(params)))?["id"]
            .clone(),
    };
    Ok(json!({ "edit": { "at": clip.start }, "effect": id, "changed": order }).into())
}
