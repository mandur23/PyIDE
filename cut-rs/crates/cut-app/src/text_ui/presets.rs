//! The motion presets of text layers (textrender.js `animations`): fade, rise and typewriter, in at the clip's start
//! or out at its end, as keyframes on `layers.<id>.<field>` that Effect Controls edits afterwards.

use std::collections::BTreeMap;

use cut_model::keyframes::{self as K, Ease, Keyframe, Value};
use cut_time::{TICKS, Ticks};
use serde_json::Value as Json;

/// The presets in their order: id and English name (`PRESETS`).
pub const PRESETS: [(&str, &str); 3] = [("fade", "Fade"), ("rise", "Rise"), ("typewriter", "Typewriter")];

/// The characters a person sees (`graphemes`): a Hangul syllable or a letter with its marks counts once.
fn graphemes(s: &str) -> usize {
    let mut n = 0;
    let mut prev_joiner = false;
    for c in s.chars() {
        let mark = matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x20D0..=0x20FF | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F | 0x1160..=0x11FF);
        if !mark && !prev_joiner {
            n += 1;
        }
        prev_joiner = c == '\u{200d}';
    }
    n
}

fn num(v: Option<&Json>, d: f64) -> f64 {
    v.and_then(Json::as_f64).unwrap_or(d)
}

/// `Math.round`: halves up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The keyframes of one preset (`make`): `layer` the text layer, `duration` the clip's length, `out` the
/// disappearing variant at the end, `frame` one frame (so the out variant ends on the last frame shown).
pub fn make(
    id: &str,
    layer: &Json,
    duration: Ticks,
    out: bool,
    frame: Ticks,
) -> Option<BTreeMap<String, Vec<Keyframe>>> {
    let text = match layer.get("text") {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => String::new(),
        Some(v) => v.to_string(),
    };
    let chars = graphemes(&text.replace("\r\n", "").replace('\n', ""));
    let l0 = if id == "typewriter" {
        js_round(TICKS as f64 / 20.0 * chars.max(1) as f64)
    } else {
        js_round(TICKS as f64 / 2.0)
    };
    let l = (l0 as Ticks).min(duration - frame).max(if frame > 0 { frame } else { 1 });
    let a = if out { (duration - frame - l).max(0) } else { 0 };
    let b = a + l;
    let span = |from: Value, to: Value, ease: Ease| {
        vec![Keyframe { t: a, v: from, ease, h: None }, Keyframe { t: b, v: to, ease: Ease::Linear, h: None }]
    };
    let base = format!("layers.{}.", layer.get("id").and_then(Json::as_str).unwrap_or(""));
    let pos = match layer.get("position").and_then(Json::as_array) {
        Some(p) => p.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect::<Vec<_>>(),
        None => vec![0.0, 0.0],
    };
    let size = num(layer.get("size"), 96.0);
    let dist = js_round(if size == 0.0 || size.is_nan() { 96.0 } else { size } * 0.6);
    let low = vec![pos.first().copied().unwrap_or(f64::NAN), pos.get(1).copied().unwrap_or(f64::NAN) + dist];
    let in_out = |show: Value, hide: Value| if out { (show, hide) } else { (hide, show) };
    let ease = if out { Ease::EaseIn } else { Ease::EaseOut };
    let mut m = BTreeMap::new();
    let opacity = || {
        let (x, y) = in_out(Value::Num(100.0), Value::Num(0.0));
        span(x, y, ease)
    };
    match id {
        "fade" => {
            m.insert(format!("{base}opacity"), opacity());
        }
        "rise" => {
            m.insert(format!("{base}opacity"), opacity());
            let (x, y) = in_out(Value::List(pos), Value::List(low));
            m.insert(format!("{base}position"), span(x, y, ease));
        }
        "typewriter" => {
            let (x, y) = in_out(Value::Num(1.0), Value::Num(0.0));
            m.insert(format!("{base}reveal"), span(x, y, Ease::Linear));
        }
        _ => return None,
    }
    Some(m)
}

/// The keyframe lists to store after adding a preset to a clip's layer (`apply`): the preset's keyframes merged into
/// the clip's, replacing the ones inside the preset's span.
pub fn apply(
    clip: &cut_model::Clip,
    layer_id: &str,
    id: &str,
    out: bool,
    frame: Ticks,
) -> Option<BTreeMap<String, Vec<Keyframe>>> {
    let cut_model::Source::Generator { layers: Some(layers), .. } = &clip.source else { return None };
    let layer = layers.iter().find(|l| l.get("id").and_then(Json::as_str) == Some(layer_id))?;
    let speed = if clip.speed == 0.0 || clip.speed.is_nan() { 1.0 } else { clip.speed };
    let d = js_round((clip.out - clip.in_) / speed) as Ticks;
    let made = make(id, layer, d, out, frame)?;
    let mut res = BTreeMap::new();
    for (prop, list) in made {
        let (a, b) = (list[0].t, list[list.len() - 1].t);
        let mut merged: Vec<Keyframe> = clip
            .keyframes
            .get(&prop)
            .map_or_else(Vec::new, |l| l.iter().filter(|k| k.t < a || k.t > b).cloned().collect());
        for k in &list {
            merged = K::insert(&merged, k);
        }
        res.insert(prop, merged);
    }
    Some(res)
}
