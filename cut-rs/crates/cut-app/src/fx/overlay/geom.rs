//! Where things are on the Program monitor (`ui-overlay.js` `frameRect`, `placement`, `toSeq`; `ui-masks.js`
//! `mapping`): the picture's rectangle and scale, a clip's placement in the sequence as the compositor draws it, and
//! a mask's picture fractions on screen.
//!
//! The compositor (`composite.wgsl`) draws a sequence pixel `s` from the layer point
//! `q = R⁻¹ (s - center - position) / scale + anchor` (relative to the layer's center), so a layer point `q` lands at
//! `center + position + R · scale · (q - anchor)`: position in sequence pixels from the center, scale in percent,
//! rotation in degrees clockwise on screen, anchor in layer pixels from the layer's center. The layer is the media
//! fitted to the sequence (`plan::fit_scale`), a nest's frame fitted the same way, or the whole frame for generators.

use cut_model::keyframes::{self as K, Value};
use cut_model::{Clip, Project, Sequence, Source, masks};
use cut_time::Ticks;
use serde_json::Value as Json;

use crate::fx::edit;

/// A point in screen points or in sequence or picture pixels.
pub type P = [f64; 2];

/// The picture's place on screen: a sequence pixel `s` is at `origin + s * k` points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: P,
    pub k: f64,
}

impl Frame {
    /// The frame of a sequence `seq_w` pixels wide drawn into `rect` (the letterboxed picture's rectangle).
    pub fn new(rect: eframe::egui::Rect, seq_w: f64) -> Frame {
        let k = if seq_w > 0.0 { f64::from(rect.width()) / seq_w } else { 1.0 };
        Frame { origin: [f64::from(rect.left()), f64::from(rect.top())], k }
    }

    /// The screen point of sequence pixel `s`.
    pub fn to_screen(&self, s: P) -> P {
        [self.origin[0] + s[0] * self.k, self.origin[1] + s[1] * self.k]
    }

    /// The sequence pixel under screen point `pt`.
    pub fn to_sequence(&self, pt: P) -> P {
        [(pt[0] - self.origin[0]) / self.k, (pt[1] - self.origin[1]) / self.k]
    }
}

/// A clip's picture and motion at a time (`placement`).
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    /// The sequence's size.
    pub seq: P,
    /// The layer's size in sequence pixels.
    pub size: P,
    /// What the box goes around, `[x, y, w, h]` relative to the layer's center: the cropped picture, or a text
    /// clip's layers.
    pub content: [f64; 4],
    pub position: P,
    pub scale: P,
    pub rotation: f64,
    pub anchor: P,
    /// `[top, right, bottom, left]` percent.
    pub crop: [f64; 4],
}

fn pair(v: Option<Value>, fb: P) -> P {
    match v {
        Some(Value::List(l)) if l.len() >= 2 => [l[0], l[1]],
        _ => fb,
    }
}

fn num(v: Option<Value>, fb: f64) -> f64 {
    match v {
        Some(Value::Num(x)) => x,
        _ => fb,
    }
}

fn js_num(v: Option<&Json>) -> f64 {
    v.and_then(Json::as_f64).unwrap_or(0.0)
}

/// `textrender.measure(layer).box` without a canvas to measure on (the JavaScript's own fallback: 0.6 of the size
/// per character), `[x, y, w, h]` in sequence pixels from the frame's center.
fn text_box(l: &serde_json::Map<String, Json>) -> [f64; 4] {
    let size = js_num(l.get("size")).max(1.0);
    let leading = js_num(l.get("leading"));
    let line_height = size * if leading == 0.0 { 1.2 } else { leading };
    let tracking = js_num(l.get("tracking")) / 1000.0 * size;
    let text = match l.get("text") {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => String::new(),
        Some(v) => v.to_string(),
    };
    let lines: Vec<&str> = text.split('\n').map(|x| x.strip_suffix('\r').unwrap_or(x)).collect();
    let width = lines
        .iter()
        .map(|t| {
            let n = t.chars().count() as f64;
            n * size * 0.6 + (n - 1.0).max(0.0) * tracking
        })
        .fold(0.0, f64::max);
    let height = lines.len() as f64 * line_height;
    let pad = l.get("box").filter(|b| b.is_object()).map_or(0.0, |b| js_num(b.get("padding")).max(0.0));
    let [x, y] = match l.get("position").and_then(Json::as_array) {
        Some(a) if a.len() >= 2 => [js_num(a.first()), js_num(a.get(1))],
        _ => [0.0, 0.0],
    };
    [x - width / 2.0 - pad, y - height / 2.0 - pad, width + 2.0 * pad, height + 2.0 * pad]
}

/// The clip's placement at sequence time `t`.
pub fn placement(project: &Project, seq: &Sequence, clip: &Clip, t: Ticks) -> Placement {
    let (sw, sh) = (seq.w as f64, seq.h as f64);
    let local = edit::clip_time(seq, clip, t) as f64;
    let v = |name: &str| K::prop_value(clip, name, local);
    let fit_mode = project.settings.get("fit").and_then(Json::as_str);
    let fitted = |w: f64, h: f64| {
        let f = cut_engine::plan::fit_scale(w, h, sw, sh, fit_mode);
        [w * f, h * f]
    };
    let mut content = None;
    let size = if let Some(m) = clip.media_id().and_then(|id| project.media(id)) {
        let (w, h) = m.video.as_ref().map_or((0.0, 0.0), |v| (v.w, v.h));
        fitted(if w > 0.0 { w } else { sw }, if h > 0.0 { h } else { sh })
    } else if let Some(n) = project.nest_of(clip) {
        fitted(n.w as f64, n.h as f64)
    } else {
        if let Source::Generator { generator: cut_model::Generator::Text, layers: Some(layers), .. } = &clip.source {
            let boxes: Vec<[f64; 4]> =
                layers.iter().map(|l| text_box(&cut_engine::text::resolve_layer(l, clip, local))).collect();
            if !boxes.is_empty() {
                let x1 = boxes.iter().map(|b| b[0]).fold(f64::INFINITY, f64::min);
                let y1 = boxes.iter().map(|b| b[1]).fold(f64::INFINITY, f64::min);
                let x2 = boxes.iter().map(|b| b[0] + b[2]).fold(f64::NEG_INFINITY, f64::max);
                let y2 = boxes.iter().map(|b| b[1] + b[3]).fold(f64::NEG_INFINITY, f64::max);
                content = Some([x1, y1, (x2 - x1).max(8.0), (y2 - y1).max(8.0)]);
            }
        }
        [sw, sh]
    };
    let crop = match v("crop") {
        Some(Value::List(l)) if l.len() >= 4 => [l[0], l[1], l[2], l[3]].map(|x| if x.is_nan() { 0.0 } else { x }),
        _ => [0.0; 4],
    };
    let [w, h] = size;
    let c = crop.map(|x| x / 100.0);
    let content =
        content.unwrap_or([-w / 2.0 + c[3] * w, -h / 2.0 + c[0] * h, w * (1.0 - c[1] - c[3]), h * (1.0 - c[0] - c[2])]);
    Placement {
        seq: [sw, sh],
        size,
        content,
        position: pair(v("position"), [0.0, 0.0]),
        scale: pair(v("scale"), [100.0, 100.0]),
        rotation: num(v("rotation"), 0.0),
        anchor: pair(v("anchor"), [0.0, 0.0]),
        crop,
    }
}

/// The rotation's cosine and sine.
fn rot(p: &Placement) -> (f64, f64) {
    let a = p.rotation.to_radians();
    (a.cos(), a.sin())
}

/// The sequence point of layer point `q` (from the layer's center): center + position + R S (q - anchor).
pub fn to_seq(p: &Placement, q: P) -> P {
    let (c, s) = rot(p);
    let x = (q[0] - p.anchor[0]) * p.scale[0] / 100.0;
    let y = (q[1] - p.anchor[1]) * p.scale[1] / 100.0;
    [p.seq[0] / 2.0 + p.position[0] + x * c - y * s, p.seq[1] / 2.0 + p.position[1] + x * s + y * c]
}

/// The layer point (from the layer's center) shown at sequence point `s`: [`to_seq`] backwards.
pub fn from_seq(p: &Placement, s: P) -> P {
    let (c, sn) = rot(p);
    let dx = s[0] - p.seq[0] / 2.0 - p.position[0];
    let dy = s[1] - p.seq[1] / 2.0 - p.position[1];
    let nz = |v: f64| if v == 0.0 || v.is_nan() { 1e-6 } else { v };
    let (sx, sy) = (nz(p.scale[0] / 100.0), nz(p.scale[1] / 100.0));
    let rx = dx * c + dy * sn;
    let ry = -dx * sn + dy * c;
    [rx / sx + p.anchor[0], ry / sy + p.anchor[1]]
}

/// A sequence-pixel vector turned into the layer's axes and scale (how far a layer point moves for it).
pub fn seq_delta_to_layer(p: &Placement, d: P) -> P {
    let (c, s) = rot(p);
    let nz = |v: f64| if v == 0.0 || v.is_nan() { 1e-6 } else { v };
    let rx = d[0] * c + d[1] * s;
    let ry = -d[0] * s + d[1] * c;
    [rx / nz(p.scale[0] / 100.0), ry / nz(p.scale[1] / 100.0)]
}

/// Picture fractions of a clip <-> screen points through its motion (`mapping`).
#[derive(Debug, Clone, PartialEq)]
pub struct Mapping {
    pub fr: Frame,
    pub p: Placement,
    /// The picture's up direction on screen.
    pub up: P,
    /// Screen points per picture pixel along `up`.
    pub k_up: f64,
}

impl Mapping {
    /// The mapping of a clip placed as `p` in frame `fr`.
    pub fn new(fr: Frame, p: Placement) -> Mapping {
        let (c, s) = rot(&p);
        let sy = p.scale[1] / 100.0;
        let k_up = fr.k * if sy == 0.0 || sy.is_nan() { 1e-6 } else { sy.abs() };
        Mapping { fr, p, up: [s, -c], k_up }
    }

    /// The screen point of picture fractions (u, v).
    pub fn to(&self, u: f64, v: f64) -> P {
        let [w, h] = self.p.size;
        self.fr.to_screen(to_seq(&self.p, [u * w - w / 2.0, v * h - h / 2.0]))
    }

    /// The picture fractions under screen point `pt`.
    pub fn from(&self, pt: P) -> P {
        let [w, h] = self.p.size;
        let q = from_seq(&self.p, self.fr.to_sequence(pt));
        [(q[0] + w / 2.0) / w, (q[1] + h / 2.0) / h]
    }

    /// The path with its vertices and handles in screen points (an affine map, so the curve is the same curve).
    pub fn screen_path(&self, path: &[f64]) -> Vec<f64> {
        let mut out = Vec::with_capacity(path.len());
        for k in (0..masks::count(path)).map(|i| i * 6) {
            let v = self.to(path[k], path[k + 1]);
            let hi = self.to(path[k] + path[k + 2], path[k + 1] + path[k + 3]);
            let ho = self.to(path[k] + path[k + 4], path[k + 1] + path[k + 5]);
            out.extend([v[0], v[1], hi[0] - v[0], hi[1] - v[1], ho[0] - v[0], ho[1] - v[1]]);
        }
        out
    }
}

/// `Math.round(x * 10) / 10`: halves round up, as the JavaScript's do.
pub fn round1(x: f64) -> f64 {
    (x * 10.0 + 0.5).floor() / 10.0
}

/// The distance between two points.
pub fn dist(a: P, b: P) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placed(rotation: f64, scale: P, anchor: P, position: P) -> Placement {
        Placement {
            seq: [1920.0, 1080.0],
            size: [1920.0, 1080.0],
            content: [-960.0, -540.0, 1920.0, 1080.0],
            position,
            scale,
            rotation,
            anchor,
            crop: [0.0; 4],
        }
    }

    #[test]
    fn to_seq_and_from_seq_are_inverse() {
        let p = placed(33.0, [75.0, 140.0], [12.0, -40.0], [100.0, -50.0]);
        for q in [[0.0, 0.0], [300.0, -200.0], [-960.0, 540.0]] {
            let back = from_seq(&p, to_seq(&p, q));
            assert!(dist(back, q) < 1e-9, "{q:?} -> {back:?}");
        }
    }

    #[test]
    fn a_layer_point_goes_where_the_compositor_draws_it() {
        // 90 degrees clockwise: the layer's right (+x) is down on screen
        let p = placed(90.0, [50.0, 50.0], [0.0, 0.0], [10.0, 20.0]);
        let s = to_seq(&p, [100.0, 0.0]);
        assert!(dist(s, [960.0 + 10.0, 540.0 + 20.0 + 50.0]) < 1e-9, "{s:?}");
        // the anchor point is placed at the position
        let p = placed(0.0, [200.0, 200.0], [30.0, 40.0], [0.0, 0.0]);
        assert!(dist(to_seq(&p, [30.0, 40.0]), [960.0, 540.0]) < 1e-9);
    }

    #[test]
    fn mapping_round_trips_fractions_through_the_screen() {
        let fr = Frame { origin: [10.0, 20.0], k: 0.5 };
        let m = Mapping::new(fr, placed(-20.0, [80.0, 60.0], [5.0, 5.0], [-40.0, 30.0]));
        let pt = m.to(0.25, 0.75);
        let back = m.from(pt);
        assert!(dist(back, [0.25, 0.75]) < 1e-9, "{back:?}");
        assert!((m.k_up - 0.3).abs() < 1e-12);
    }

    #[test]
    fn round1_rounds_halves_up_as_math_round() {
        assert_eq!(round1(1.25), 1.3);
        assert_eq!(round1(-1.25), -1.2);
        assert_eq!(round1(2.04), 2.0);
    }

    #[test]
    fn the_text_box_is_the_javascripts_fallback_measure() {
        let l = serde_json::json!({ "text": "ab\ncdef", "size": 100, "position": [10, -20] });
        let b = text_box(l.as_object().unwrap());
        assert_eq!(b, [10.0 - 120.0, -20.0 - 120.0, 240.0, 240.0]);
    }
}
