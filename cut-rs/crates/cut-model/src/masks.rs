//! Masks of Opacity and of the video effects (port of `masks.js`, docs/cut-architecture.md section 6 "Masks").
//!
//! A path is one flat list, six numbers a vertex: `[x, y, inX, inY, outX, outY]`, the vertex and its bezier handles
//! relative to it, as fractions of the clip's picture. Edge i is the cubic (v_i, v_i + out_i, v_i+1 + in_i+1, v_i+1),
//! the last back to the first. The arithmetic is the JavaScript's, operation for operation in f64 (with `Math.min`,
//! `Math.max` and `Math.hypot` as V8 computes them), so coverage and edits give the same bits on both sides.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::id::Id;
use crate::keyframes::{Keyframe, Value};

mod coverage;

pub use coverage::*;

/// How a mask combines with the masks above it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MaskMode {
    Add,
    Subtract,
    Intersect,
    Difference,
    None,
}

impl MaskMode {
    /// The name in the project file.
    pub fn name(self) -> &'static str {
        match self {
            Self::Add => "add",
            Self::Subtract => "subtract",
            Self::Intersect => "intersect",
            Self::Difference => "difference",
            Self::None => "none",
        }
    }

    /// The mode a project file names, if it is one.
    pub fn from_name(name: &str) -> Option<Self> {
        MODES.into_iter().find(|m| m.name() == name)
    }
}

/// `{ id: 'm<n>', mode, inverted, path: [x, y, inX, inY, outX, outY, ...], feather, opacity, expansion }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mask {
    pub id: Id,
    pub mode: MaskMode,
    pub inverted: bool,
    pub path: Vec<f64>,
    pub feather: f64,
    pub opacity: f64,
    pub expansion: f64,
}

/// Every mode, in the order Effect Controls lists them.
pub const MODES: [MaskMode; 5] =
    [MaskMode::Add, MaskMode::Subtract, MaskMode::Intersect, MaskMode::Difference, MaskMode::None];
/// The keyframable fields of a mask.
pub const FIELDS: [&str; 4] = ["path", "feather", "opacity", "expansion"];

/// The values a new mask gets for the fields it is not given (Premiere's).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Defaults {
    pub mode: MaskMode,
    pub inverted: bool,
    pub feather: f64,
    pub opacity: f64,
    pub expansion: f64,
}

/// See [`Defaults`].
pub const DEFAULTS: Defaults =
    Defaults { mode: MaskMode::Add, inverted: false, feather: 10.0, opacity: 100.0, expansion: 0.0 };

/// The allowed `[min, max]` of each number field.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Ranges {
    pub feather: [f64; 2],
    pub opacity: [f64; 2],
    pub expansion: [f64; 2],
}

/// See [`Ranges`].
pub const RANGES: Ranges = Ranges { feather: [0.0, 1000.0], opacity: [0.0, 100.0], expansion: [-2000.0, 2000.0] };

/// Masks a list holds at most.
pub const MAX_MASKS: usize = 16;
/// Vertices a path holds at most.
pub const MAX_POINTS: usize = 256;
/// Vertices a path holds at least.
pub const MIN_POINTS: usize = 3;
/// Line segments a curved edge flattens into.
pub const FLATTEN: usize = 16;
/// The handle length, as a fraction of the radius, of a four-point bezier circle.
pub const KAPPA: f64 = 0.552_284_749_830_793_6;
/// The 2D back end's feather blur: sigma = width / SIGMA.
pub const SIGMA: f64 = 3.76;

/// `Math.min`: NaN when either is NaN, -0 below 0.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max`: NaN when either is NaN, 0 above -0.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// V8's `Math.hypot` of two numbers (normalized to the larger, Kahan-summed), which can differ from libm's by an ulp.
fn js_hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a == f64::INFINITY || b == f64::INFINITY {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = if b > a { b } else { a };
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0_f64, 0.0_f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `x || 0` on a number.
fn or0(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 0.0 } else { x }
}

fn clamp(x: f64, a: f64, b: f64) -> f64 {
    js_max(a, js_min(b, x))
}

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// ---- shape and validation ------------------------------------------------------------------------------------------

/// The number of whole vertices of a path.
pub fn count(path: &[f64]) -> usize {
    path.len() / 6
}

/// A path of 3 to 256 whole vertices, every number finite and within ±100.
pub fn valid_path(path: &[f64]) -> bool {
    let n = path.len() / 6;
    path.len().is_multiple_of(6)
        && (MIN_POINTS..=MAX_POINTS).contains(&n)
        && path.iter().all(|v| v.is_finite() && v.abs() <= 100.0)
}

fn valid_path_json(v: &Json) -> bool {
    let Some(a) = v.as_array() else { return false };
    let n = a.len() / 6;
    a.len().is_multiple_of(6)
        && (MIN_POINTS..=MAX_POINTS).contains(&n)
        && a.iter().all(|v| v.as_f64().is_some_and(|x| x.abs() <= 100.0))
}

/// The allowed `[min, max]` of a number field, `None` for any other name.
pub fn range_of(field: &str) -> Option<[f64; 2]> {
    match field {
        "feather" => Some(RANGES.feather),
        "opacity" => Some(RANGES.opacity),
        "expansion" => Some(RANGES.expansion),
        _ => None,
    }
}

/// Whether `v` (unparsed JSON, as a file or a keyframe holds it) is a value of the mask field `field`.
pub fn valid_field(field: &str, v: &Json) -> bool {
    if field == "path" {
        return valid_path_json(v);
    }
    match (range_of(field), v.as_f64()) {
        (Some([lo, hi]), Some(x)) => x >= lo && x <= hi,
        _ => false,
    }
}

/// A number as JavaScript's `String(x)` writes it.
pub(crate) fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", js_number(-x));
    }
    let s = format!("{x:e}");
    let (mantissa, exp) = s.split_once('e').unwrap_or((&s, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let rest = if k == 1 { String::new() } else { format!(".{}", &digits[1..]) };
        format!("{}{rest}e{sign}{}", &digits[..1], e.abs())
    }
}

/// A value as a JavaScript template string writes it (`${v}`); `None` is a missing field (`undefined`).
fn js_string(v: Option<&Json>) -> String {
    match v {
        None => "undefined".into(),
        Some(Json::Null) => "null".into(),
        Some(Json::Bool(b)) => b.to_string(),
        Some(Json::Number(n)) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Some(Json::String(s)) => s.clone(),
        Some(Json::Array(a)) => {
            let parts: Vec<String> =
                a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect();
            parts.join(",")
        }
        Some(Json::Object(_)) => "[object Object]".into(),
    }
}

/// `m<digits>`, as `ID_RE` reads a mask id.
fn is_mask_id(s: &str) -> bool {
    s.strip_prefix('m').is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// `None` when `m` (unparsed JSON) is a well-formed mask, else what is wrong, in the JavaScript's words.
pub fn problem(m: &Json) -> Option<String> {
    let Some(o) = m.as_object() else { return Some("not an object".into()) };
    if !o.get("id").and_then(Json::as_str).is_some_and(is_mask_id) {
        return Some(format!("id {}", js_string(o.get("id"))));
    }
    if !o.get("mode").and_then(Json::as_str).is_some_and(|s| MaskMode::from_name(s).is_some()) {
        return Some(format!("mode {}", js_string(o.get("mode"))));
    }
    if !o.get("inverted").is_some_and(Json::is_boolean) {
        return Some("inverted".into());
    }
    FIELDS.into_iter().find(|f| !o.get(*f).is_some_and(|v| valid_field(f, v))).map(String::from)
}

/// Whether `m` (unparsed JSON) is a well-formed mask.
pub fn valid(m: &Json) -> bool {
    problem(m).is_none()
}

/// `m` with its missing (or null) fields filled from [`DEFAULTS`], when the result is a well-formed mask
/// (`problem(full(m)) === null` in the JavaScript); `None` otherwise.
pub fn full(m: &Json) -> Option<Mask> {
    let o = m.as_object()?;
    let given = |f: &str| o.get(f).filter(|v| !v.is_null());
    let mut filled = serde_json::Map::new();
    if let Some(id) = o.get("id") {
        filled.insert("id".into(), id.clone());
    }
    filled.insert("mode".into(), given("mode").cloned().unwrap_or_else(|| DEFAULTS.mode.name().into()));
    filled.insert("inverted".into(), given("inverted").cloned().unwrap_or(DEFAULTS.inverted.into()));
    if let Some(path) = o.get("path") {
        filled.insert("path".into(), path.clone());
    }
    filled.insert("feather".into(), given("feather").cloned().unwrap_or(DEFAULTS.feather.into()));
    filled.insert("opacity".into(), given("opacity").cloned().unwrap_or(DEFAULTS.opacity.into()));
    filled.insert("expansion".into(), given("expansion").cloned().unwrap_or(DEFAULTS.expansion.into()));
    let filled = Json::Object(filled);
    if problem(&filled).is_some() {
        return None;
    }
    serde_json::from_value(filled).ok()
}

/// The keyframe prefix of a mask list: `masks` for Opacity's, `effects.<id>.masks` for an effect's.
pub fn prefix_of(effect_id: Option<&str>) -> String {
    match effect_id {
        Some(e) if !e.is_empty() => format!("effects.{e}.masks"),
        _ => "masks".into(),
    }
}

/// A keyframe path of a mask field, as [`parse_path`] reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropPath<'a> {
    pub effect_id: Option<&'a str>,
    pub mask_id: &'a str,
    pub field: &'a str,
}

/// `masks.m1.path` -> `{ effectId: None, maskId: m1, field: path }`; `effects.e2.masks.m3.feather` -> `{ e2, m3, feather }`;
/// else `None`. Only the keyframable fields, unless `all` (mode and inverted too: what Effect Controls writes).
pub fn parse_path(prop: &str, all: bool) -> Option<PropPath<'_>> {
    let p: Vec<&str> = prop.split('.').collect();
    let ok = |f: &str| FIELDS.contains(&f) || (all && (f == "mode" || f == "inverted"));
    match p[..] {
        ["masks", mask_id, field] if ok(field) => Some(PropPath { effect_id: None, mask_id, field }),
        ["effects", e, "masks", mask_id, field] if ok(field) => Some(PropPath { effect_id: Some(e), mask_id, field }),
        _ => None,
    }
}

// ---- shapes the Effect Controls buttons make --------------------------------------------------------------------------

/// Where a made shape sits: its center as fractions, and its size in pixels (`None`: the button's default).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Place {
    pub cx: f64,
    pub cy: f64,
    pub size: Option<f64>,
}

impl Default for Place {
    fn default() -> Self {
        Self { cx: 0.5, cy: 0.5, size: None }
    }
}

/// Create Ellipse Mask: a circle of radius `size` (default a quarter of the shorter side), four smooth vertices (top,
/// right, bottom, left). `w`, `h`: the picture's size in pixels, so the circle is round.
pub fn ellipse(w: f64, h: f64, place: Place) -> Vec<f64> {
    let Place { cx, cy, size } = place;
    let r = size.unwrap_or_else(|| 0.25 * js_min(w, h));
    let (rx, ry) = (r / w, r / h);
    let (kx, ky) = (KAPPA * rx, KAPPA * ry);
    vec![
        cx,
        cy - ry,
        -kx,
        0.0,
        kx,
        0.0, //
        cx + rx,
        cy,
        0.0,
        -ky,
        0.0,
        ky, //
        cx,
        cy + ry,
        kx,
        0.0,
        -kx,
        0.0, //
        cx - rx,
        cy,
        0.0,
        ky,
        0.0,
        -ky,
    ]
}

/// Create 4-point Polygon Mask: a centered square `size` across (default half the shorter side), four corners.
pub fn polygon(w: f64, h: f64, place: Place) -> Vec<f64> {
    let Place { cx, cy, size } = place;
    let s = size.unwrap_or_else(|| 0.5 * js_min(w, h));
    let (dx, dy) = (s / 2.0 / w, s / 2.0 / h);
    let corner = |x: f64, y: f64| [x, y, 0.0, 0.0, 0.0, 0.0];
    [corner(cx - dx, cy - dy), corner(cx + dx, cy - dy), corner(cx + dx, cy + dy), corner(cx - dx, cy + dy)].concat()
}

/// A point of the Free Draw Bezier pen: fractions, with its dragged out handle (`hx`, `hy`; 0 for a click).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct PenPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub hx: f64,
    #[serde(default)]
    pub hy: f64,
}

/// The pen's points as a path: each point's out handle as dragged, its in handle mirrored.
pub fn from_points(points: &[PenPoint]) -> Vec<f64> {
    points
        .iter()
        .flat_map(|p| {
            let (hx, hy) = (or0(p.hx), or0(p.hy));
            [p.x, p.y, -hx, -hy, hx, hy]
        })
        .collect()
}

// ---- edits (pure: each returns a new path) ------------------------------------------------------------------------------
//
// An index past the end writes past it as the JavaScript's arrays do: the gap fills with NaN (`null` in JSON, as the
// JavaScript's holes are).

fn at(p: &[f64], k: usize) -> f64 {
    p.get(k).copied().unwrap_or(f64::NAN)
}

fn put(out: &mut Vec<f64>, k: usize, v: f64) {
    if k >= out.len() {
        out.resize(k + 1, f64::NAN);
    }
    out[k] = v;
}

/// The whole path moved by (du, dv), fractions.
pub fn translate(path: &[f64], du: f64, dv: f64) -> Vec<f64> {
    path.iter()
        .enumerate()
        .map(|(k, v)| match k % 6 {
            0 => v + du,
            1 => v + dv,
            _ => *v,
        })
        .collect()
}

/// Vertex `i` moved by (du, dv), its handles with it.
pub fn move_vertex(path: &[f64], i: usize, du: f64, dv: f64) -> Vec<f64> {
    let mut out = path.to_vec();
    let k = i.saturating_mul(6);
    put(&mut out, k, at(path, k) + du);
    put(&mut out, k + 1, at(path, k + 1) + dv);
    out
}

/// One of a vertex's two bezier handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Handle {
    In,
    Out,
}

/// Handle `which` of vertex `i` set to `to` (fractions, relative to the vertex). Unless `broken` (Alt), the other
/// handle turns to point the opposite way and keeps its length in pixels (the same length when it had none).
pub fn set_handle(path: &[f64], i: usize, which: Handle, to: [f64; 2], w: f64, h: f64, broken: bool) -> Vec<f64> {
    let [hu, hv] = to;
    let mut out = path.to_vec();
    let base = i.saturating_mul(6);
    let (k, o) = match which {
        Handle::In => (base + 2, base + 4),
        Handle::Out => (base + 4, base + 2),
    };
    put(&mut out, k, hu);
    put(&mut out, k + 1, hv);
    if !broken {
        let len = js_hypot(hu * w, hv * h);
        let olen = or0(js_hypot(at(&out, o) * w, at(&out, o + 1) * h));
        let olen = if olen == 0.0 { len } else { olen };
        let f = if len > 1e-9 { olen / len } else { 0.0 };
        put(&mut out, o, -hu * f);
        put(&mut out, o + 1, -hv * f);
    }
    out
}

/// Whether vertex `i` has both handles at 0 (also true past the end, as the JavaScript's empty slice is).
pub fn is_corner(path: &[f64], i: usize) -> bool {
    let k = i.saturating_mul(6);
    let (a, b) = ((k + 2).min(path.len()), (k + 6).min(path.len()));
    path[a..b].iter().all(|v| *v == 0.0)
}

/// Alt+click: a corner becomes smooth (handles along the line from the previous vertex to the next, a third of the
/// distance to each), a smooth (or broken) vertex becomes a corner.
pub fn toggle_smooth(path: &[f64], i: usize, w: f64, h: f64) -> Vec<f64> {
    let mut out = path.to_vec();
    let k = i.saturating_mul(6);
    if !is_corner(path, i) {
        let end = (k + 6).min(out.len());
        out[k + 2..end].fill(0.0);
        return out;
    }
    let n = count(path) as i64;
    let ii = i as i64;
    let v = vertex(path, ii, w, h);
    let a = vertex(path, ii - 1 + n, w, h);
    let b = vertex(path, ii + 1, w, h);
    let (mut dx, mut dy) = (b.x - a.x, b.y - a.y);
    let len = or0(js_hypot(dx, dy));
    let len = if len == 0.0 { 1.0 } else { len };
    dx /= len;
    dy /= len;
    let li = js_hypot(v.x - a.x, v.y - a.y) / 3.0;
    let lo = js_hypot(b.x - v.x, b.y - v.y) / 3.0;
    put(&mut out, k + 2, (-dx * li) / w);
    put(&mut out, k + 3, (-dy * li) / h);
    put(&mut out, k + 4, (dx * lo) / w);
    put(&mut out, k + 5, (dy * lo) / h);
    out
}

/// A vertex on edge `e` (any integer, taken around the path) at `t` (0..1) that keeps the shape: de Casteljau's split
/// of the edge's cubic (a straight edge stays straight, with a corner).
pub fn insert_vertex(path: &[f64], e: i64, t: f64) -> Vec<f64> {
    let n = count(path) as i64;
    if n == 0 {
        // The JavaScript's NaN index splices six NaNs in at the start.
        return [&[f64::NAN; 6][..], path].concat();
    }
    let i = e.rem_euclid(n) as usize;
    let j = (i + 1) % n as usize;
    let g = |k: usize| path[k];
    let p0 = [g(i * 6), g(i * 6 + 1)];
    let p3 = [g(j * 6), g(j * 6 + 1)];
    let p1 = [p0[0] + g(i * 6 + 4), p0[1] + g(i * 6 + 5)];
    let p2 = [p3[0] + g(j * 6 + 2), p3[1] + g(j * 6 + 3)];
    let lerp = |a: [f64; 2], b: [f64; 2]| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let mut out = path.to_vec();
    let nv = if g(i * 6 + 4) == 0.0 && g(i * 6 + 5) == 0.0 && g(j * 6 + 2) == 0.0 && g(j * 6 + 3) == 0.0 {
        let m = lerp(p0, p3);
        [m[0], m[1], 0.0, 0.0, 0.0, 0.0]
    } else {
        let a = lerp(p0, p1);
        let b = lerp(p1, p2);
        let c = lerp(p2, p3);
        let d = lerp(a, b);
        let e = lerp(b, c);
        let m = lerp(d, e);
        out[i * 6 + 4] = a[0] - p0[0];
        out[i * 6 + 5] = a[1] - p0[1];
        out[j * 6 + 2] = c[0] - p3[0];
        out[j * 6 + 3] = c[1] - p3[1];
        [m[0], m[1], d[0] - m[0], d[1] - m[1], e[0] - m[0], e[1] - m[1]]
    };
    let at = (i + 1) * 6;
    out.splice(at..at, nv);
    out
}

/// Vertex `i` deleted, unless only [`MIN_POINTS`] are left.
pub fn remove_vertex(path: &[f64], i: usize) -> Vec<f64> {
    if count(path) <= MIN_POINTS {
        return path.to_vec();
    }
    let a = i.saturating_mul(6).min(path.len());
    let b = i.saturating_mul(6).saturating_add(6).min(path.len());
    [&path[..a], &path[b..]].concat()
}

/// The vertex nearest a pixel point (`index` `None` for a path with none).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct NearestVertex {
    pub index: Option<usize>,
    pub distance: f64,
}

/// The point of an edge nearest a pixel point, to 1/64 of the edge.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct NearestEdge {
    pub index: Option<usize>,
    pub t: f64,
    pub distance: f64,
}

/// Hit test of the vertices, pixels of the picture.
pub fn nearest_vertex(path: &[f64], w: f64, h: f64, x: f64, y: f64) -> NearestVertex {
    let mut best = NearestVertex { index: None, distance: f64::INFINITY };
    for i in 0..count(path) {
        let v = vertex(path, i as i64, w, h);
        let d = js_hypot(v.x - x, v.y - y);
        if d < best.distance {
            best = NearestVertex { index: Some(i), distance: d };
        }
    }
    best
}

/// Hit test of the edges, pixels of the picture.
pub fn nearest_edge(path: &[f64], w: f64, h: f64, x: f64, y: f64) -> NearestEdge {
    let mut best = NearestEdge { index: None, t: 0.0, distance: f64::INFINITY };
    for i in 0..count(path) {
        let e = edge(path, i as i64, w, h);
        for s in 0..=64 {
            let t = f64::from(s) / 64.0;
            let p = cubic(&e, t);
            let d = js_hypot(p[0] - x, p[1] - y);
            if d < best.distance {
                best = NearestEdge { index: Some(i), t, distance: d };
            }
        }
    }
    best
}

/// The outline grown by `d` pixels (positive outward): the flattened points moved along their normals. The monitor
/// draws Mask Expansion's and Mask Feather's guide lines with it.
pub fn outline(path: &[f64], w: f64, h: f64, d: f64) -> Vec<[f64; 2]> {
    let pts = flatten(path, w, h);
    if or0(d) == 0.0 {
        return pts;
    }
    let n = pts.len();
    let mut area = 0.0;
    for i in 0..n {
        let (pj, pi) = (pts[(i + n - 1) % n], pts[i]);
        area += pj[0] * pi[1] - pi[0] * pj[1];
    }
    let out = if area > 0.0 { 1.0 } else { -1.0 };
    (0..n)
        .map(|i| {
            let (p, a, b) = (pts[i], pts[(i + n - 1) % n], pts[(i + 1) % n]);
            let (mut nx, mut ny) = (b[1] - a[1], -(b[0] - a[0]));
            let len = or0(js_hypot(nx, ny));
            let len = if len == 0.0 { 1.0 } else { len };
            nx /= len;
            ny /= len;
            [p[0] - out * nx * d, p[1] - out * ny * d]
        })
        .collect()
}

/// The topmost point of the path in pixels (where the monitor puts the feather and expansion handles).
pub fn top_point(path: &[f64], w: f64, h: f64) -> Option<[f64; 2]> {
    flatten(path, w, h).into_iter().fold(None, |best, p| match best {
        Some(b) if p[1] < b[1] => Some(p),
        Some(b) => Some(b),
        None => Some(p),
    })
}

/// The same edit on every keyframe of a Mask Path (adding or deleting a vertex keeps the counts equal); a keyframe
/// whose value is not a valid path is kept as it is.
pub fn map_keyframes(list: &[Keyframe], mut edit: impl FnMut(&[f64]) -> Vec<f64>) -> Vec<Keyframe> {
    list.iter()
        .map(|k| match &k.v {
            Value::List(p) if valid_path(p) => Keyframe { v: Value::List(edit(p)), ..k.clone() },
            _ => k.clone(),
        })
        .collect()
}
