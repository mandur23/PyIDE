//! Keyframes: a property's value at a clip time (port of `keyframes.js`).

use cut_time::Ticks;
use serde::{Deserialize, Serialize};

/// The shape of the segment that leaves a keyframe, with the CSS meaning of the names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ease {
    Linear,
    Hold,
    EaseIn,
    EaseOut,
    EaseInOut,
    Bezier,
}

/// A keyframed value: a number, a list of numbers (a pair, a crop, a mask path), a `#rrggbb` color, or a flag.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Value {
    Num(f64),
    List(Vec<f64>),
    Text(String),
    Flag(bool),
}

impl<'de> Deserialize<'de> for Value {
    /// What the untagged derive read (a number, a list of numbers, a string, a flag), without buffering the value.
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Value;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a number, a list of numbers, a string or a flag")
            }
            fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
                Ok(Value::Num(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
                Ok(Value::Num(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
                Ok(Value::Num(v as f64))
            }
            fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
                Ok(Value::Flag(v))
            }
            fn visit_str<E>(self, v: &str) -> Result<Value, E> {
                Ok(Value::Text(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> Result<Value, E> {
                Ok(Value::Text(v))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
                let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(2));
                while let Some(x) = seq.next_element::<f64>()? {
                    out.push(x);
                }
                Ok(Value::List(out))
            }
        }
        d.deserialize_any(V)
    }
}

/// `{ t /* ticks from the clip start */, v, ease, h? }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Keyframe {
    pub t: Ticks,
    pub v: Value,
    pub ease: Ease,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<Vec<f64>>,
}

/// The handles of a bezier keyframe that has none.
pub const DEFAULT_HANDLES: [f64; 4] = [0.25, 0.1, 0.25, 1.0];

fn preset(ease: Ease) -> Option<[f64; 4]> {
    match ease {
        Ease::EaseIn => Some([0.42, 0.0, 1.0, 1.0]),
        Ease::EaseOut => Some([0.0, 0.0, 0.58, 1.0]),
        Ease::EaseInOut => Some([0.42, 0.0, 0.58, 1.0]),
        _ => None,
    }
}

/// y of the cubic-bezier timing curve (0,0) (x1,y1) (x2,y2) (1,1) at x: Newton steps, bisection where the slope is
/// flat.
pub fn bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;
    let sx = |s: f64| ((ax * s + bx) * s + cx) * s;
    let dx = |s: f64| (3.0 * ax * s + 2.0 * bx) * s + cx;
    let y = |s: f64| ((ay * s + by) * s + cy) * s;
    let mut s = x;
    for _ in 0..8 {
        let e = sx(s) - x;
        if e.abs() < 1e-7 {
            return y(s);
        }
        let d = dx(s);
        if d.abs() < 1e-6 {
            break;
        }
        s -= e / d;
    }
    let (mut lo, mut hi) = (0.0, 1.0);
    s = x;
    for _ in 0..60 {
        let v = sx(s);
        if (v - x).abs() < 1e-7 {
            break;
        }
        if v < x {
            lo = s;
        } else {
            hi = s;
        }
        s = (lo + hi) / 2.0;
    }
    y(s)
}

/// The eased fraction of the segment leaving `k` at linear fraction `u` (0..1).
pub fn eased(k: &Keyframe, u: f64) -> f64 {
    let h = match k.ease {
        Ease::Linear => return u,
        Ease::Hold => return 0.0,
        Ease::Bezier => match k.h.as_deref() {
            Some(h) => [h.first(), h.get(1), h.get(2), h.get(3)].map(|x| x.copied().unwrap_or(f64::NAN)),
            None => DEFAULT_HANDLES,
        },
        e => preset(e).expect("the eases with presets"),
    };
    bezier(h[0], h[1], h[2], h[3], u)
}

/// The bezier handles that draw a segment as it is now: the preset's for the eases, a straight line for linear, its
/// own for bezier; `None` for hold. Turning a keyframe into a bezier one with them keeps its shape.
pub fn handles(ease: Ease, own: Option<&[f64]>) -> Option<Vec<f64>> {
    match ease {
        Ease::Hold => None,
        Ease::Bezier => Some(own.unwrap_or(&DEFAULT_HANDLES).iter().take(4).copied().collect()),
        Ease::Linear => Some(vec![1.0 / 3.0, 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0]),
        e => preset(e).map(|h| h.to_vec()),
    }
}

fn hex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !((b.len() == 7 || b.len() == 9) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)) {
        return None;
    }
    (1..b.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

fn mix_color(a: &str, b: &str, p: f64) -> Option<String> {
    let (ca, cb) = (hex(a)?, hex(b)?);
    if ca.len() != cb.len() {
        return None;
    }
    let mut out = String::from("#");
    for (x, y) in ca.iter().zip(&cb) {
        let (x, y) = (f64::from(*x), f64::from(*y));
        let v = crate::query::js_round(x + (y - x) * p).clamp(0.0, 255.0);
        out.push_str(&format!("{:02x}", v as u8));
    }
    Some(out)
}

/// The value a fraction `p` of the way from `a` to `b`: numbers and lists of the same length element by element,
/// colors by channel; anything else holds `a`.
pub fn mix(a: &Value, b: &Value, p: f64) -> Value {
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => Value::Num(x + (y - x) * p),
        (Value::List(x), Value::List(y)) if x.len() == y.len() => {
            Value::List(x.iter().zip(y).map(|(x, y)| x + (y - x) * p).collect())
        }
        (Value::Text(x), Value::Text(y)) => Value::Text(mix_color(x, y, p).unwrap_or_else(|| x.clone())),
        _ => a.clone(),
    }
}

/// The value of a keyframe list at clip time t: the first value before the first keyframe, the last after the last;
/// `None` (the caller's fallback) for no keyframes.
pub fn value_at(keyframes: &[Keyframe], t: f64) -> Option<Value> {
    let first = keyframes.first()?;
    if t <= first.t as f64 {
        return Some(first.v.clone());
    }
    let last = keyframes.last()?;
    if t >= last.t as f64 {
        return Some(last.v.clone());
    }
    let (mut lo, mut hi) = (0, keyframes.len() - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if keyframes[mid].t as f64 <= t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (a, b) = (&keyframes[lo], &keyframes[hi]);
    if a.ease == Ease::Hold {
        return Some(a.v.clone());
    }
    Some(mix(&a.v, &b.v, eased(a, (t - a.t as f64) / (b.t - a.t) as f64)))
}

/// A JSON value as a keyframe value, when it is one.
pub fn from_json(v: &serde_json::Value) -> Option<Value> {
    serde_json::from_value(v.clone()).ok()
}

/// The static value of a prop path on a clip: a property, `effects.<id>.<param>`, `layers.<id>.<field>`,
/// `masks.<id>.<field>`, `effects.<id>.masks.<id>.<field>`. `None` where the clip has none (or it is not a value).
pub fn static_value(clip: &crate::project::Clip, prop: &str) -> Option<Value> {
    let parts: Vec<&str> = prop.split('.').collect();
    let mask_field = |list: Option<&Vec<crate::masks::Mask>>, id: &str, field: &str| {
        let m = list?.iter().find(|m| m.id.as_str() == id)?;
        from_json(serde_json::to_value(m).ok()?.get(field)?)
    };
    let effect = |id: &str| clip.effects.iter().find(|e| e.id.as_str() == id);
    match parts[..] {
        [p] => clip.props.get(p),
        ["masks", id, field, ..] => mask_field(clip.masks.as_ref(), id, field),
        ["effects", e, "masks", id, field, ..] => mask_field(effect(e)?.masks.as_ref(), id, field),
        ["effects", e, param, ..] => from_json(effect(e)?.params.get(param)?),
        ["layers", id, field, ..] => match &clip.source {
            crate::project::Source::Generator { layers: Some(l), .. } => {
                from_json(l.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id))?.get(field)?)
            }
            _ => None,
        },
        _ => None,
    }
}

/// A prop's value at clip time t: its keyframes, else its static value.
pub fn prop_value(clip: &crate::project::Clip, prop: &str, t: f64) -> Option<Value> {
    match clip.keyframes.get(prop) {
        Some(list) if !list.is_empty() => value_at(list, t),
        _ => static_value(clip, prop),
    }
}

/// The list with `kf` in place of any keyframe at its time, in order; a bezier keyframe gets handles.
pub fn insert(keyframes: &[Keyframe], kf: &Keyframe) -> Vec<Keyframe> {
    let mut list: Vec<Keyframe> = keyframes.iter().filter(|k| k.t != kf.t).cloned().collect();
    let h = (kf.ease == Ease::Bezier).then(|| kf.h.clone().unwrap_or_else(|| DEFAULT_HANDLES.to_vec()));
    let k = Keyframe { t: kf.t, v: kf.v.clone(), ease: kf.ease, h };
    let mut i = list.len();
    while i > 0 && list[i - 1].t > k.t {
        i -= 1;
    }
    list.insert(i, k);
    list
}

/// The list without the keyframe at t.
pub fn remove(keyframes: &[Keyframe], t: Ticks) -> Vec<Keyframe> {
    keyframes.iter().filter(|k| k.t != t).cloned().collect()
}

/// The first keyframe after t.
pub fn next(keyframes: &[Keyframe], t: Ticks) -> Option<&Keyframe> {
    keyframes.iter().find(|k| k.t > t)
}

/// The last keyframe before t.
pub fn prev(keyframes: &[Keyframe], t: Ticks) -> Option<&Keyframe> {
    keyframes.iter().rev().find(|k| k.t < t)
}
