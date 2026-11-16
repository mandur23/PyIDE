//! The math of Lumetri Color beyond the basic correction (port of `lumetri.js`): RGB curves, the creative LUT (.cube
//! parsing, the copy kept in `project.luts`, trilinear lookup) and the HSL secondary. Curves, the LUT and the qualifier
//! work on the sRGB values shown (0..1); the corrections inside the qualifier work in linear light.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use cut_model::effects::Params;
use cut_model::lumetri::{MAX_SIZE, valid_entry};
use serde_json::{Map, Value as Json};

use crate::color::{LUMA, clamp, linear_to_srgb, smoothstep, srgb_to_linear};

/// The curve data checks are the model's; the panel reads them from here with the rest of the curve math.
pub use cut_model::lumetri::{MAX_POINTS, MIN_GAP, points};

pub const TABLE: usize = 1024;
pub const CURVE_PARAMS: [&str; 4] = ["curveMaster", "curveRed", "curveGreen", "curveBlue"];

/// As the shaders' toSrgb / toLinear: negative values count as 0.
fn enc(v: f64) -> f64 {
    linear_to_srgb(v.max(0.0))
}
fn dec(v: f64) -> f64 {
    srgb_to_linear(v.max(0.0))
}

// ---- curves ----

pub fn flatten(pts: &[[f64; 2]]) -> Vec<f64> {
    pts.iter().flat_map(|p| [p[0], p[1]]).collect()
}

/// The slopes of the monotone cubic through `pts` (Fritsch-Carlson).
pub fn slopes(pts: &[[f64; 2]]) -> Vec<f64> {
    let n = pts.len();
    let d: Vec<f64> = (0..n - 1).map(|i| (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0])).collect();
    let mut m = vec![0.0; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        if d[i - 1] * d[i] <= 0.0 {
            continue;
        }
        let h0 = pts[i][0] - pts[i - 1][0];
        let h1 = pts[i + 1][0] - pts[i][0];
        let w1 = 2.0 * h1 + h0;
        let w2 = h1 + 2.0 * h0;
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    m
}

/// y of the curve through `pts` at x, `m` from [`slopes`].
pub fn eval_curve(pts: &[[f64; 2]], x: f64, m: &[f64]) -> f64 {
    let n = pts.len();
    if x <= pts[0][0] {
        return pts[0][1];
    }
    if x >= pts[n - 1][0] {
        return pts[n - 1][1];
    }
    let mut i = 0;
    while i < n - 2 && x > pts[i + 1][0] {
        i += 1;
    }
    let ([x0, y0], [x1, y1]) = (pts[i], pts[i + 1]);
    let h = x1 - x0;
    let t = (x - x0) / h;
    let (t2, t3) = (t * t, t * t * t);
    let y = (2.0 * t3 - 3.0 * t2 + 1.0) * y0
        + (t3 - 2.0 * t2 + t) * h * m[i]
        + (-2.0 * t3 + 3.0 * t2) * y1
        + (t3 - t2) * h * m[i + 1];
    clamp(y, 0.0, 1.0)
}

/// The curve sampled at `TABLE` evenly spaced x in 0..1.
pub fn curve_table(flat: &[f64]) -> Vec<f64> {
    let pts = points(flat);
    let m = slopes(&pts);
    (0..TABLE).map(|i| eval_curve(&pts, i as f64 / (TABLE - 1) as f64, &m)).collect()
}

pub fn is_identity_curve(flat: &[f64]) -> bool {
    let pts = points(flat);
    pts[0][0] == 0.0 && pts[pts.len() - 1][0] == 1.0 && pts.iter().all(|p| (p[0] - p[1]).abs() < 1e-9)
}

/// A curve parameter's flat list (a missing or malformed one is the straight line, as `points` makes it).
fn curve_of(p: &Map<String, Json>, k: &str) -> Vec<f64> {
    match p.get(k).and_then(Json::as_array) {
        Some(a) => a.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect(),
        None => Vec::new(),
    }
}

pub fn curves_identity(p: &Map<String, Json>) -> bool {
    CURVE_PARAMS.iter().all(|k| is_identity_curve(&curve_of(p, k)))
}

/// `Number.prototype.toFixed(6)` of a value in 0..1 (what curveKey writes).
fn fixed6(v: f64) -> String {
    format!("{v:.6}")
}

/// The key of a set of curves (one GPU table per key).
pub fn curve_key(p: &Map<String, Json>) -> String {
    let parts: Vec<String> = CURVE_PARAMS
        .iter()
        .map(|k| flatten(&points(&curve_of(p, k))).iter().map(|v| fixed6(*v)).collect::<Vec<_>>().join(","))
        .collect();
    format!("curves:{}", parts.join("|"))
}

/// The four tables interleaved (master, red, green, blue per entry) as f32, kept for the last keys asked.
pub fn curves_table(p: &Map<String, Json>) -> Arc<Vec<f32>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Vec<f32>>>>> = OnceLock::new();
    let key = curve_key(p);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(t) = cache.lock().expect("the curve cache").get(&key) {
        return t.clone();
    }
    let ch: Vec<Vec<f64>> = CURVE_PARAMS.iter().map(|k| curve_table(&curve_of(p, k))).collect();
    let mut t = vec![0f32; TABLE * 4];
    for i in 0..TABLE {
        for c in 0..4 {
            t[i * 4 + c] = ch[c][i] as f32;
        }
    }
    let t = Arc::new(t);
    let mut c = cache.lock().expect("the curve cache");
    if c.len() >= 32 {
        c.clear();
    }
    c.insert(key, t.clone());
    t
}

/// A table lookup as the shader does it: linear between the two entries around x (clamped to 0..1).
pub fn lookup(t: &[f32], x: f64, c: usize) -> f64 {
    let f = clamp(x, 0.0, 1.0) * (TABLE - 1) as f64;
    let i = (f.floor() as usize).min(TABLE - 2);
    let u = f - i as f64;
    f64::from(t[i * 4 + c]) * (1.0 - u) + f64::from(t[(i + 1) * 4 + c]) * u
}

/// Linear rgb through the curves: master on every channel, then each channel's own.
pub fn curves_pixel(rgb: [f64; 3], t: &[f32]) -> [f64; 3] {
    let m = rgb.map(|v| lookup(t, enc(v), 0));
    [dec(lookup(t, m[0], 1)), dec(lookup(t, m[1], 2)), dec(lookup(t, m[2], 3))]
}

// ---- .cube LUTs ----

/// A parsed or decoded 3D LUT: `data` is r, g, b triples, red changing fastest.
#[derive(Debug, Clone, PartialEq)]
pub struct Lut {
    pub id: String,
    pub title: String,
    pub size: u32,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub data: Vec<f32>,
}

/// Why a .cube file cannot be used (code `lut`): the English message template and its parameters, as the panel shows
/// them through `tr(message, params)`.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct LutError {
    pub message: &'static str,
    pub params: Vec<(&'static str, Json)>,
}

fn lut_error(message: &'static str, params: Vec<(&'static str, Json)>) -> LutError {
    LutError { message, params }
}

/// JavaScript's `Number(s)` restricted to what the parser accepts: `[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`, finite.
fn cube_number(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - s
    };
    let int = digits(&mut i);
    if int > 0 {
        if i < b.len() && b[i] == b'.' {
            i += 1;
            digits(&mut i);
        }
    } else {
        if i >= b.len() || b[i] != b'.' {
            return None;
        }
        i += 1;
        if digits(&mut i) == 0 {
            return None;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn is_keyword(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_uppercase()
        && b.iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// Parses the text of a .cube file (TITLE, LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX, LUT_3D_INPUT_RANGE, `#` comments,
/// other keywords ignored).
pub fn parse_cube(text: &str) -> Result<Lut, LutError> {
    if text.contains('\0') {
        return Err(lut_error("This file is not a text .cube LUT.", vec![]));
    }
    let (mut title, mut size, mut min, mut max) = (String::new(), 0u32, [0.0; 3], [1.0; 3]);
    let mut data: Vec<f32> = Vec::new();
    let mut count = 0u64;
    let nums = |parts: &[&str], line: usize| -> Result<Vec<f64>, LutError> {
        parts
            .iter()
            .map(|s| {
                cube_number(s).ok_or_else(|| {
                    let value = utf16_prefix(s, 20);
                    lut_error(
                        "Line {line}: {value} is not a number.",
                        vec![("line", line.into()), ("value", value.into())],
                    )
                })
            })
            .collect()
    };
    for (i, l) in split_lines(text).enumerate() {
        let line = i + 1;
        let raw = l.split('#').next().unwrap_or("").trim_matches(js_space);
        if raw.is_empty() {
            continue;
        }
        let parts: Vec<&str> = raw.split(js_space).filter(|s| !s.is_empty()).collect();
        let key = parts[0].to_uppercase();
        if !is_keyword(parts[0]) {
            if size == 0 {
                return Err(lut_error("No LUT_3D_SIZE line: this is not a 3D .cube LUT.", vec![]));
            }
            if parts.len() != 3 {
                return Err(lut_error("Line {line}: a data line needs three numbers.", vec![("line", line.into())]));
            }
            if count >= u64::from(size).pow(3) {
                count += 1;
                continue;
            }
            let v = nums(&parts, line)?;
            let at = count as usize * 3;
            for k in 0..3 {
                data[at + k] = v[k] as f32;
            }
            count += 1;
            continue;
        }
        match key.as_str() {
            "TITLE" => {
                let t = raw.get(5..).unwrap_or("").trim_matches(js_space);
                let t = if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') { &t[1..t.len() - 1] } else { t };
                title = utf16_prefix(t, 200);
            }
            "LUT_1D_SIZE" => return Err(lut_error("1D LUTs are not supported. Load a 3D LUT (LUT_3D_SIZE).", vec![])),
            "LUT_3D_SIZE" => {
                let n = parts.get(1).and_then(|s| js_number(s));
                let whole = n.filter(|n| n.fract() == 0.0 && (2.0..=MAX_SIZE as f64).contains(n));
                let Some(n) = whole.filter(|_| parts.len() == 2) else {
                    let shown = utf16_prefix(parts.get(1).unwrap_or(&""), 20);
                    return Err(lut_error(
                        "LUT_3D_SIZE must be a whole number from 2 to {max} (it is {size}).",
                        vec![("max", MAX_SIZE.into()), ("size", shown.into())],
                    ));
                };
                let n = n as u32;
                if size != 0 && n != size {
                    return Err(lut_error("Line {line}: a second LUT_3D_SIZE.", vec![("line", line.into())]));
                }
                size = n;
                data = vec![0.0; (n as usize).pow(3) * 3];
            }
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                if parts.len() != 4 {
                    let keyword = if key == "DOMAIN_MIN" { "DOMAIN_MIN" } else { "DOMAIN_MAX" };
                    return Err(lut_error(
                        "Line {line}: {keyword} needs three numbers.",
                        vec![("line", line.into()), ("keyword", keyword.into())],
                    ));
                }
                let v = nums(&parts[1..], line)?;
                let v = [v[0], v[1], v[2]];
                if key == "DOMAIN_MIN" {
                    min = v;
                } else {
                    max = v;
                }
            }
            "LUT_3D_INPUT_RANGE" => {
                if parts.len() != 3 {
                    return Err(lut_error(
                        "Line {line}: {keyword} needs two numbers.",
                        vec![("line", line.into()), ("keyword", "LUT_3D_INPUT_RANGE".into())],
                    ));
                }
                let v = nums(&parts[1..], line)?;
                min = [v[0]; 3];
                max = [v[1]; 3];
            }
            _ => {}
        }
    }
    if size == 0 {
        return Err(lut_error("No LUT_3D_SIZE line: this is not a 3D .cube LUT.", vec![]));
    }
    let want = u64::from(size).pow(3);
    if count != want {
        return Err(lut_error(
            "The LUT has {count} data lines; LUT_3D_SIZE {size} needs {want}.",
            vec![("count", count.into()), ("size", size.into()), ("want", want.into())],
        ));
    }
    if !(0..3).all(|k| min[k] < max[k]) {
        return Err(lut_error("DOMAIN_MIN must be below DOMAIN_MAX in every channel.", vec![]));
    }
    Ok(Lut { id: String::new(), title, size, min, max, data })
}

/// `s.slice(0, n)` in UTF-16 units, as JavaScript cuts a string (a cut surrogate pair becomes U+FFFD).
fn utf16_prefix(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<u16>>())
}

/// JavaScript's `\s` (what `trim` and `split(/\s+/)` use).
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `text.split(/\r\n|\r|\n/)`.
fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(text);
    std::iter::from_fn(move || {
        let s = rest?;
        match s.find(['\r', '\n']) {
            Some(i) => {
                let skip = if s[i..].starts_with("\r\n") { 2 } else { 1 };
                rest = Some(&s[i + skip..]);
                Some(&s[..i])
            }
            None => {
                rest = None;
                Some(s)
            }
        }
    })
}

/// `Number(s)` for the size field: decimal, hex `0x`, and the empty string as 0 are what a .cube line could hold.
fn js_number(s: &str) -> Option<f64> {
    let t = s.trim_matches(js_space);
    if t.is_empty() {
        return Some(0.0);
    }
    for (p, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(h) = t.strip_prefix(p) {
            return u64::from_str_radix(h, radix).ok().map(|v| v as f64);
        }
    }
    if t.ends_with(['e', 'E', '+', '-']) || t.contains(['_']) {
        return None;
    }
    match t {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) => t.parse().ok(),
        _ => None,
    }
}

// base64 as the JavaScript's own (standard alphabet, padded).
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn to_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n =
            (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(char::from(B64[(n >> 18) as usize & 63]));
        out.push(char::from(B64[(n >> 12) as usize & 63]));
        out.push(if c.len() > 1 { char::from(B64[(n >> 6) as usize & 63]) } else { '=' });
        out.push(if c.len() > 2 { char::from(B64[n as usize & 63]) } else { '=' });
    }
    out
}

pub fn from_base64(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return None;
    }
    let pad = if s.ends_with("==") { 2 } else { usize::from(s.ends_with('=')) };
    let len = (b.len() / 4) * 3 - pad.min((b.len() / 4) * 3);
    let mut out = Vec::with_capacity(len);
    let val = |c: u8| -> Option<u32> {
        if c == b'=' {
            return Some(0);
        }
        B64.iter().position(|&x| x == c).map(|p| p as u32)
    };
    for q in b.chunks(4) {
        let mut n = 0u32;
        for &c in q {
            n = (n << 6) | val(c)?;
        }
        for k in [16, 8, 0] {
            if out.len() < len {
                out.push((n >> k) as u8);
            }
        }
    }
    Some(out)
}

fn float_bytes(f: impl IntoIterator<Item = f32>) -> Vec<u8> {
    f.into_iter().flat_map(f32::to_le_bytes).collect()
}

/// A 64-bit FNV-1a of the bytes (two 32-bit halves), as 16 hex digits.
pub fn hash64(bytes: &[u8]) -> String {
    let (mut a, mut b) = (0x811c_9dc5_u32, 0x050c_5d1f_u32);
    for (i, &x) in bytes.iter().enumerate() {
        a = (a ^ u32::from(x)).wrapping_mul(0x0100_0193);
        b = (b ^ u32::from(x) ^ (i as u32 & 255)).wrapping_mul(0x0100_0193);
    }
    format!("{a:08x}{b:08x}")
}

/// What goes into `project.luts`: `(id, entry)`.
pub fn store(lut: &Lut, name: &str) -> (String, Json) {
    let bytes = float_bytes(lut.data.iter().copied());
    let head = float_bytes(
        [lut.size as f32, lut.min[0] as f32, lut.min[1] as f32, lut.min[2] as f32]
            .into_iter()
            .chain(lut.max.map(|v| v as f32)),
    );
    let all: Vec<u8> = head.into_iter().chain(bytes.iter().copied()).collect();
    let id = format!("lut-{}", hash64(&all));
    let name = if name.is_empty() { if lut.title.is_empty() { "LUT" } else { &lut.title } } else { name };
    let name = utf16_prefix(name, 200);
    let entry = serde_json::json!({
        "name": name, "title": lut.title, "size": lut.size, "min": lut.min, "max": lut.max, "data": to_base64(&bytes),
    });
    (id, entry)
}

/// The usable LUT of an entry.
pub fn decode(entry: &Json, id: &str) -> Option<Lut> {
    if !valid_entry(entry) {
        return None;
    }
    let size = entry["size"].as_f64()? as u32;
    let bytes = from_base64(entry["data"].as_str()?)?;
    if bytes.len() != (size as usize).pow(3) * 12 {
        return None;
    }
    let data = bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
    let v3 = |k: &str| {
        let a = &entry[k];
        [a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0), a[2].as_f64().unwrap_or(0.0)]
    };
    Some(Lut {
        id: id.to_string(),
        title: entry["title"].as_str()?.to_string(),
        size,
        min: v3("min"),
        max: v3("max"),
        data,
    })
}

/// The LUT a parameter names in the project, decoded once per id and data.
pub fn lut_of(luts: Option<&Json>, id: &str) -> Option<Arc<Lut>> {
    /// id -> (a tag of the entry's data, the decoded LUT)
    type Decoded = HashMap<String, (usize, Arc<Lut>)>;
    static CACHE: OnceLock<Mutex<Decoded>> = OnceLock::new();
    if id.is_empty() {
        return None;
    }
    let entry = luts?.as_object()?.get(id)?;
    let tag = entry.get("data").and_then(Json::as_str).map_or(0, |d| d.len() ^ d.as_ptr() as usize);
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, l)) = cache.lock().expect("the LUT cache").get(id)
        && *t == tag
    {
        return Some(l.clone());
    }
    let lut = Arc::new(decode(entry, id)?);
    let mut c = cache.lock().expect("the LUT cache");
    if c.len() >= 32 {
        c.clear();
    }
    c.insert(id.to_string(), (tag, lut.clone()));
    Some(lut)
}

/// The LUT at sRGB values `s`, trilinear, domain-normalized and clamped.
pub fn sample_lut(lut: &Lut, s: [f64; 3]) -> [f64; 3] {
    let n = lut.size as usize;
    let x: [f64; 3] =
        std::array::from_fn(|k| clamp((s[k] - lut.min[k]) / (lut.max[k] - lut.min[k]), 0.0, 1.0) * (n - 1) as f64);
    let i0 = x.map(|v| (v.floor() as usize).min(n - 2));
    let f: [f64; 3] = std::array::from_fn(|k| x[k] - i0[k] as f64);
    let at = |r: usize, g: usize, b: usize, c: usize| f64::from(lut.data[((b * n + g) * n + r) * 3 + c]);
    std::array::from_fn(|c| {
        let c00 = at(i0[0], i0[1], i0[2], c) * (1.0 - f[0]) + at(i0[0] + 1, i0[1], i0[2], c) * f[0];
        let c10 = at(i0[0], i0[1] + 1, i0[2], c) * (1.0 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2], c) * f[0];
        let c01 = at(i0[0], i0[1], i0[2] + 1, c) * (1.0 - f[0]) + at(i0[0] + 1, i0[1], i0[2] + 1, c) * f[0];
        let c11 = at(i0[0], i0[1] + 1, i0[2] + 1, c) * (1.0 - f[0]) + at(i0[0] + 1, i0[1] + 1, i0[2] + 1, c) * f[0];
        (c00 * (1.0 - f[1]) + c10 * f[1]) * (1.0 - f[2]) + (c01 * (1.0 - f[1]) + c11 * f[1]) * f[2]
    })
}

/// Linear rgb through the LUT at intensity k (0..1), mixed in sRGB values.
pub fn lut_pixel(rgb: [f64; 3], lut: &Lut, k: f64) -> [f64; 3] {
    let s = rgb.map(enc);
    let v = sample_lut(lut, s);
    std::array::from_fn(|i| dec(s[i] + (v[i] - s[i]) * k))
}

// ---- half floats for the GPU's rgba16float tables ----

pub fn to_half(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = ((x >> 16) & 0x8000) as u16;
    let e = ((x >> 23) & 0xff) as i32 - 112;
    let m = x & 0x7f_ffff;
    if e >= 31 {
        return sign | 0x7c00;
    }
    if e <= 0 {
        if e < -10 {
            return sign;
        }
        let mm = (m | 0x80_0000) >> (1 - e);
        return sign | ((mm + 0x1000) >> 13) as u16;
    }
    let h = sign | ((e as u32) << 10) as u16 | (m >> 13) as u16;
    if m & 0x1000 != 0 { h.wrapping_add(1) } else { h }
}

/// rgb triples (stride 3) or rgba (stride 4) as rgba half floats, alpha 1 for triples.
pub fn half_rgba(values: &[f32], stride: usize) -> Vec<u16> {
    let one = to_half(1.0);
    values
        .chunks_exact(stride)
        .flat_map(|v| [to_half(v[0]), to_half(v[1]), to_half(v[2]), if stride == 4 { to_half(v[3]) } else { one }])
        .collect()
}

// ---- HSL secondary ----

/// Hue (0..1 turns) of sRGB values; 0 for a gray.
pub fn hue_of(s: [f64; 3]) -> f64 {
    let mx = s[0].max(s[1]).max(s[2]);
    let mn = s[0].min(s[1]).min(s[2]);
    let c = mx - mn;
    if c.is_nan() || c <= 0.0 {
        return 0.0;
    }
    let h = if mx == s[0] {
        let h = (s[1] - s[2]) / c;
        if h < 0.0 { h + 6.0 } else { h }
    } else if mx == s[1] {
        (s[2] - s[0]) / c + 2.0
    } else {
        (s[0] - s[1]) / c + 4.0
    };
    h / 6.0
}

fn w(w: f64) -> f64 {
    w.max(1e-4)
}
fn fall(x: f64, edge: f64, wd: f64) -> f64 {
    1.0 - smoothstep(edge, edge + w(wd), x)
}
fn band(x: f64, lo: f64, hi: f64, wd: f64) -> f64 {
    smoothstep(lo - w(wd), lo, x) * fall(x, hi, wd)
}

/// The CSS hue-rotate matrix.
pub fn hue_matrix(deg: f64) -> [[f64; 3]; 3] {
    let a = deg * std::f64::consts::PI / 180.0;
    let (s, c) = a.sin_cos();
    [
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ]
}

/// The qualifier and its correction (`hslPlan`).
#[derive(Debug, Clone, PartialEq)]
pub struct HslPlan {
    pub hue: f64,
    pub half: f64,
    pub hue_soft: f64,
    pub sat: [f64; 3],
    pub lum: [f64; 3],
    pub gain: [f64; 3],
    pub k: f64,
    pub saturation: f64,
    pub shift: f64,
    pub mask: bool,
    pub matrix: Option<[[f64; 3]; 3]>,
    pub active: bool,
}

/// JavaScript's `%` on numbers (the sign of the dividend).
fn js_rem(a: f64, b: f64) -> f64 {
    a % b
}

pub fn hsl_plan(p: &Map<String, Json>) -> HslPlan {
    let or = |k: &str, d: f64| p.get(k).and_then(Json::as_f64).unwrap_or(d);
    let t = or("hslTemperature", 0.0) / 100.0;
    let m = or("hslTint", 0.0) / 100.0;
    let g = [(t / 2.0 + m / 4.0).exp2(), (-m / 2.0).exp2(), (-t / 2.0 + m / 4.0).exp2()];
    let n = g[0] * LUMA[0] + g[1] * LUMA[1] + g[2] * LUMA[2];
    let shift = js_rem(js_rem(or("hslHueShift", 0.0), 360.0) + 360.0, 360.0);
    let shift = if shift > 180.0 { shift - 360.0 } else { shift };
    let k = 1.0 + or("hslContrast", 0.0) / 100.0;
    let saturation = or("hslSaturation", 100.0) / 100.0;
    let mask = p.flag("hslMask");
    HslPlan {
        hue: js_rem(js_rem(or("hslHue", 0.0), 360.0) + 360.0, 360.0) / 360.0,
        half: clamp(or("hslHueRange", 360.0), 0.0, 360.0) / 720.0,
        hue_soft: clamp(or("hslHueSoft", 0.0), 0.0, 180.0) / 360.0,
        sat: [or("hslSatLow", 0.0) / 100.0, or("hslSatHigh", 100.0) / 100.0, or("hslSatSoft", 0.0) / 100.0],
        lum: [or("hslLumLow", 0.0) / 100.0, or("hslLumHigh", 100.0) / 100.0, or("hslLumSoft", 0.0) / 100.0],
        gain: g.map(|x| x / n),
        k,
        saturation,
        shift,
        mask,
        matrix: (shift != 0.0).then(|| hue_matrix(shift)),
        active: mask || t != 0.0 || m != 0.0 || k != 1.0 || saturation != 1.0 || shift != 0.0,
    }
}

/// How much a linear colour is inside the qualifier (0..1).
pub fn hsl_mask(rgb: [f64; 3], q: &HslPlan) -> f64 {
    let s = rgb.map(|v| clamp(enc(v), 0.0, 1.0));
    let c = s[0].max(s[1]).max(s[2]) - s[0].min(s[1]).min(s[2]);
    let l = s[0] * LUMA[0] + s[1] * LUMA[1] + s[2] * LUMA[2];
    let x = hue_of(s) - q.hue + 0.5;
    let dh = (x - x.floor() - 0.5).abs();
    fall(dh, q.half, q.hue_soft) * band(c, q.sat[0], q.sat[1], q.sat[2]) * band(l, q.lum[0], q.lum[1], q.lum[2])
}

/// sRGB 128, the gray Show Mask draws outside the key.
pub fn mid_gray() -> f64 {
    srgb_to_linear(128.0 / 255.0)
}

pub fn hsl_pixel(rgb: [f64; 3], q: &HslPlan) -> [f64; 3] {
    let m = hsl_mask(rgb, q);
    if q.mask {
        let g = mid_gray();
        return rgb.map(|x| g + (x - g) * m);
    }
    let mut c: [f64; 3] = std::array::from_fn(|i| rgb[i] * q.gain[i]);
    if q.k != 1.0 {
        c = c.map(|x| if x > 0.0 { 0.18 * (x / 0.18).powf(q.k) } else { x });
    }
    if let Some(mx) = q.matrix {
        c = mx.map(|r| r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
    }
    let y = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
    c = c.map(|x| (y + (x - y) * q.saturation).max(0.0));
    std::array::from_fn(|i| rgb[i] + (c[i] - rgb[i]) * m)
}
