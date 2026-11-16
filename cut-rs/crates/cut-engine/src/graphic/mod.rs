//! Graphic clips (port of the drawing part of graphic.js, docs/cut-architecture.md section 6 "Graphic clips"): the
//! layers of `source: { generator: 'graphic', layers }` resolved at the item's time and drawn into an RGBA picture the
//! compositor uploads as it uploads a text clip's.
//!
//! [`Graphic::at`] resolves the layers (keyframes of `layers.<id>.<field>`, as `graphic.resolve`), and
//! [`Graphic::signature`] says what they show, so the engine keeps the picture while it stays the same (particles
//! that still move change it every frame). [`Graphic::draw`] turns the layers into a display list of filled paths in
//! canvas pixels ([`paint`]: shapes, trimmed and dashed strokes, text from glyph outlines, particles, each layer's
//! transform under its groups', repeated copies, opacity, gradients) and rasterises it with tiny-skia, Skia's
//! rasteriser ported to Rust, as Chrome's Canvas 2D is Skia ([`raster`]: blend modes as canvas composite operations,
//! shadows and blur filters as Gaussian blurs), in horizontal bands on as many threads as pay.

pub mod geometry;
pub mod glyphs;
mod paint;
mod raster;

use cut_model::graphic::{FieldType, check_value, field, normalize};
use cut_model::keyframes::{self, Value};
use cut_model::{Clip, Source};
use cut_time::TICKS;
use serde_json::{Map, Number, Value as Json};

use crate::plan::Item;
use crate::text::TextRenderer;

/// A resolved layer read by field (every field of its kind is there: `normalize` put the defaults in).
#[derive(Debug, Clone, Copy)]
pub struct L<'a>(pub &'a Map<String, Json>);

impl<'a> L<'a> {
    pub fn kind(&self) -> &'a str {
        self.str("kind")
    }

    pub fn str(&self, f: &str) -> &'a str {
        self.0.get(f).and_then(Json::as_str).unwrap_or("")
    }

    pub fn num(&self, f: &str) -> f64 {
        self.0.get(f).and_then(Json::as_f64).unwrap_or(0.0)
    }

    /// A whole-number field as a count (negative or missing: 0).
    pub fn count(&self, f: &str) -> usize {
        self.num(f).max(0.0) as usize
    }

    pub fn pair(&self, f: &str) -> [f64; 2] {
        let a = self.0.get(f).and_then(Json::as_array);
        let at = |i: usize| a.and_then(|a| a.get(i)).and_then(Json::as_f64).unwrap_or(0.0);
        [at(0), at(1)]
    }

    pub fn flag(&self, f: &str) -> bool {
        self.0.get(f).and_then(Json::as_bool).unwrap_or(false)
    }

    /// A color field's text when it holds one (null and `''` are none, as the JavaScript's truthiness says).
    pub fn color_text(&self, f: &str) -> Option<&'a str> {
        self.0.get(f).and_then(Json::as_str).filter(|s| !s.is_empty())
    }
}

fn to_json(v: Value) -> Option<Json> {
    Some(match v {
        Value::Num(x) => Json::Number(Number::from_f64(x)?),
        Value::List(xs) => {
            Json::Array(xs.into_iter().map(|x| Number::from_f64(x).map_or(Json::Null, Json::Number)).collect())
        }
        Value::Text(s) => Json::String(s),
        Value::Flag(b) => Json::Bool(b),
    })
}

/// A keyframed number past its range (an ease that overshoots) at the range's edge (`clampTo`); `None` when it is
/// no number.
fn clamp_to(f: &str, v: &Json) -> Option<Json> {
    let (lo, hi) = match field(f)?.1 {
        FieldType::Num(a, b) | FieldType::Int(a, b) | FieldType::Pair(a, b) => (a, b),
        _ => return None,
    };
    let one = |x: &Json| x.as_f64().filter(|x| x.is_finite()).map(|x| x.clamp(lo, hi));
    match v {
        Json::Array(p) => {
            let p: Option<Vec<f64>> = p.iter().map(one).collect();
            p.filter(|p| p.len() == 2).map(Json::from)
        }
        v => one(v).map(Json::from),
    }
}

/// The layer as it is at clip time `t` (ticks from the clip's start): keyframed fields replace the static ones,
/// whole numbers rounded, values out of range ignored, numbers that overshoot clamped (`graphic.resolve`).
pub fn resolve(layer: &Json, clip: &Clip, t: f64) -> Map<String, Json> {
    let Json::Object(mut out) = normalize(layer) else { return Map::new() };
    let id = match layer.get("id") {
        Some(Json::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => "undefined".to_string(),
    };
    let prefix = format!("layers.{id}.");
    for (prop, list) in &clip.keyframes {
        let Some(f) = prop.strip_prefix(&prefix) else { continue };
        if list.is_empty() || !cut_model::graphic::animated(f) || !out.contains_key(f) {
            continue;
        }
        let Some(mut v) = keyframes::value_at(list, t).and_then(to_json) else { continue };
        if matches!(field(f).map(|x| x.1), Some(FieldType::Int(..)))
            && let Some(x) = v.as_f64()
        {
            v = Json::from(geometry::js_round(x));
        }
        if check_value(f, &v).is_empty() {
            out.insert(f.to_string(), v);
        } else if !matches!(field(f).map(|x| x.1), Some(FieldType::ColorOrNull))
            && let Some(c) = clamp_to(f, &v)
        {
            out.insert(f.to_string(), c);
        }
    }
    out
}

/// Whether resolved layers change with time beyond their keyframes: a visible particle layer that still emits
/// (`hasParticles`).
pub fn has_particles(layers: &[Map<String, Json>], t_sec: f64) -> bool {
    layers.iter().map(L).any(|l| {
        l.kind() == "particles"
            && l.0.get("visible") != Some(&Json::Bool(false))
            && l.0.get("opacity").and_then(Json::as_f64) != Some(0.0)
            && (l.str("emit") != "burst" || l.0.get("life").and_then(Json::as_f64).is_some_and(|life| t_sec <= life))
    })
}

/// A graphic clip's layers at a time, ready to draw.
#[derive(Debug, Clone)]
pub struct Graphic {
    /// The resolved layers, bottom first.
    pub layers: Vec<Map<String, Json>>,
    /// Seconds from the clip's start (particles move with it).
    pub t: f64,
    /// The sequence's size, in whose pixels the layers are placed.
    pub w: f64,
    pub h: f64,
}

impl Graphic {
    /// The layers of a graphic clip `local` ticks from its start, in a `w` x `h` sequence.
    pub fn new(clip: &Clip, local: f64, w: f64, h: f64) -> Self {
        let layers = match &clip.source {
            Source::Generator { layers: Some(layers), .. } => layers.iter().map(|l| resolve(l, clip, local)).collect(),
            _ => Vec::new(),
        };
        Self { layers, t: local / TICKS as f64, w, h }
    }

    /// The graphic an item of the plan shows.
    pub fn at(it: &Item<'_>) -> Self {
        Self::new(it.clip, it.local, it.seq_w, it.seq_h)
    }

    /// What the picture shows, as text: two graphics with one signature draw the same picture at one size.
    pub fn signature(&self) -> String {
        let t = if has_particles(&self.layers, self.t) { self.t } else { 0.0 };
        let layers = Json::Array(self.layers.iter().cloned().map(Json::Object).collect());
        format!("{}x{}|{t}|{layers}", self.w, self.h)
    }

    /// The picture, `tw` x `th` canvas pixels for the whole sequence: non-premultiplied RGBA8 of sRGB values, as
    /// the compositor reads a text clip's.
    pub fn draw(&self, text: &mut TextRenderer, tw: u32, th: u32) -> Vec<u8> {
        let k = f64::from(tw) / self.w;
        let ops = paint::ops(self, text, k);
        raster::rasterize(&ops, tw, th)
    }
}
