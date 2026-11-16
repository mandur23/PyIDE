//! The geometry of a mask path in pixels and the coverage it gives (the CPU reference; `WGSL` computes the same).

use serde::{Deserialize, Serialize};

use super::{FLATTEN, Mask, MaskMode, clamp, count, js_max, js_min, or0, smoothstep};

// ---- geometry in pixels ------------------------------------------------------------------------------------------------

/// A vertex and its handles (relative to it), in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Vertex {
    pub x: f64,
    pub y: f64,
    pub ix: f64,
    pub iy: f64,
    pub ox: f64,
    pub oy: f64,
}

/// An edge's cubic in pixels: from `a` to `b`, control points `p0..p3`, `straight` when neither handle is out.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Edge {
    pub a: Vertex,
    pub b: Vertex,
    pub p0: [f64; 2],
    pub p1: [f64; 2],
    pub p2: [f64; 2],
    pub p3: [f64; 2],
    pub straight: bool,
}

/// Vertex `i` (any integer, taken around the path) in pixels of a `w` x `h` picture; NaN for a path with no vertex.
pub fn vertex(path: &[f64], i: i64, w: f64, h: f64) -> Vertex {
    let n = count(path) as i64;
    if n == 0 {
        return Vertex { x: f64::NAN, y: f64::NAN, ix: f64::NAN, iy: f64::NAN, ox: f64::NAN, oy: f64::NAN };
    }
    let k = (i.rem_euclid(n) * 6) as usize;
    let p = &path[k..k + 6];
    Vertex { x: p[0] * w, y: p[1] * h, ix: p[2] * w, iy: p[3] * h, ox: p[4] * w, oy: p[5] * h }
}

/// Edge `i`'s control points in pixels.
pub fn edge(path: &[f64], i: i64, w: f64, h: f64) -> Edge {
    let a = vertex(path, i, w, h);
    let b = vertex(path, i + 1, w, h);
    Edge {
        a,
        b,
        p0: [a.x, a.y],
        p1: [a.x + a.ox, a.y + a.oy],
        p2: [b.x + b.ix, b.y + b.iy],
        p3: [b.x, b.y],
        straight: a.ox == 0.0 && a.oy == 0.0 && b.ix == 0.0 && b.iy == 0.0,
    }
}

/// The point of an edge's cubic at `t`.
pub fn cubic(e: &Edge, t: f64) -> [f64; 2] {
    let u = 1.0 - t;
    let a = u * u * u;
    let b = 3.0 * u * u * t;
    let c = 3.0 * u * t * t;
    let d = t * t * t;
    [a * e.p0[0] + b * e.p1[0] + c * e.p2[0] + d * e.p3[0], a * e.p0[1] + b * e.p1[1] + c * e.p2[1] + d * e.p3[1]]
}

/// The closed polygon the path draws as, in pixels, the first point not repeated: [`FLATTEN`] segments a curved edge,
/// one a straight edge.
pub fn flatten(path: &[f64], w: f64, h: f64) -> Vec<[f64; 2]> {
    let mut pts = Vec::new();
    for i in 0..count(path) as i64 {
        let e = edge(path, i, w, h);
        pts.push(e.p0);
        if !e.straight {
            pts.extend((1..FLATTEN).map(|s| cubic(&e, s as f64 / FLATTEN as f64)));
        }
    }
    pts
}

/// One segment of a flattened polygon with what the distance needs of it, computed once.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Seg {
    ax: f64,
    ay: f64,
    by: f64,
    abx: f64,
    aby: f64,
    len2: f64,
}

/// The closing segments of a polygon, each from the point before to the point (the first from the last).
fn segments(pts: &[[f64; 2]]) -> Vec<Seg> {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let [ax, ay] = pts[(i + n - 1) % n];
            let [bx, by] = pts[i];
            let (abx, aby) = (bx - ax, by - ay);
            Seg { ax, ay, by, abx, aby, len2: js_max(abx * abx + aby * aby, 1e-12) }
        })
        .collect()
}

fn signed_distance_segs(segs: &[Seg], x: f64, y: f64) -> f64 {
    let mut d2 = f64::INFINITY;
    let mut inside = false;
    for s in segs {
        let apx = x - s.ax;
        let apy = y - s.ay;
        let t = clamp((apx * s.abx + apy * s.aby) / s.len2, 0.0, 1.0);
        let qx = apx - s.abx * t;
        let qy = apy - s.aby * t;
        d2 = js_min(d2, qx * qx + qy * qy);
        if (s.ay > y) != (s.by > y) && x < (s.abx * (y - s.ay)) / s.aby + s.ax {
            inside = !inside;
        }
    }
    d2.sqrt() * if inside { 1.0 } else { -1.0 }
}

/// Signed distance (positive inside, even-odd) from (x, y) to a flattened polygon; -infinity for no points.
pub fn signed_distance(pts: &[[f64; 2]], x: f64, y: f64) -> f64 {
    signed_distance_segs(&segments(pts), x, y)
}

/// Whether the pixel point (x, y) is inside the path.
pub fn contains(path: &[f64], w: f64, h: f64, x: f64, y: f64) -> bool {
    signed_distance(&flatten(path, w, h), x, y) > 0.0
}

/// `[x0, y0, x1, y1]` of the points (infinities for none).
pub fn bounds(pts: &[[f64; 2]]) -> [f64; 4] {
    pts.iter()
        .fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |[x0, y0, x1, y1], &[x, y]| {
            [js_min(x0, x), js_min(y0, y), js_max(x1, x), js_max(y1, y)]
        })
}

// ---- coverage (the CPU reference; WGSL computes the same) --------------------------------------------------------------

/// A mask that counts (mode not None) with its pixel geometry for one picture size and pxScale.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Prepared {
    pub mode: MaskMode,
    pub inverted: bool,
    /// Mask Opacity as 0..1.
    pub opacity: f64,
    pub pts: Vec<[f64; 2]>,
    /// The feather ramp's width in pixels, at least 1.
    pub width: f64,
    /// The expansion in pixels.
    pub grow: f64,
    /// Where the shape can be above 0: `[x0, y0, x1, y1]`.
    #[serde(rename = "box")]
    pub bbox: [f64; 4],
    #[serde(skip)]
    segs: Vec<Seg>,
}

/// The masks that count, each with its pixel geometry for a picture of `w` x `h` at `px_scale`.
pub fn prepare(masks: &[Mask], w: f64, h: f64, px_scale: f64) -> Vec<Prepared> {
    masks
        .iter()
        .filter(|m| m.mode != MaskMode::None)
        .map(|m| {
            let pts = flatten(&m.path, w, h);
            let width = js_max(or0(m.feather) * px_scale, 1.0);
            let grow = or0(m.expansion) * px_scale;
            let reach = width / 2.0 + js_max(grow, 0.0) + 1.0;
            let [x0, y0, x1, y1] = bounds(&pts);
            Prepared {
                mode: m.mode,
                inverted: m.inverted,
                opacity: clamp(m.opacity / 100.0, 0.0, 1.0),
                segs: segments(&pts),
                pts,
                width,
                grow,
                bbox: [x0 - reach, y0 - reach, x1 + reach, y1 + reach],
            }
        })
        .collect()
}

fn start_of(prepared: &[Prepared]) -> f64 {
    match prepared.first() {
        Some(q) if matches!(q.mode, MaskMode::Subtract | MaskMode::Intersect) => 1.0,
        _ => 0.0,
    }
}

/// One mask's value at (x, y), its distance taken to `segs` (all of its segments, or those that matter on the row).
fn mask_at(q: &Prepared, segs: &[Seg], x: f64, y: f64) -> f64 {
    let c = if x < q.bbox[0] || y < q.bbox[1] || x > q.bbox[2] || y > q.bbox[3] {
        0.0
    } else {
        smoothstep(-q.width / 2.0, q.width / 2.0, signed_distance_segs(segs, x, y) + q.grow)
    };
    (if q.inverted { 1.0 - c } else { c }) * q.opacity
}

fn combine(acc: f64, mode: MaskMode, m: f64) -> f64 {
    match mode {
        MaskMode::Add => acc + m - acc * m,
        MaskMode::Subtract => acc * (1.0 - m),
        MaskMode::Intersect => acc * m,
        MaskMode::Difference | MaskMode::None => acc + m - 2.0 * acc * m,
    }
}

/// The combined coverage of prepared masks at the pixel point (x, y).
pub fn coverage_at(prepared: &[Prepared], x: f64, y: f64) -> f64 {
    prepared.iter().fold(start_of(prepared), |acc, q| combine(acc, q.mode, mask_at(q, &q.segs, x, y)))
}

/// The coverage of every pixel center of a `w` x `h` picture, row by row; 1 everywhere when no mask counts.
///
/// The same bits as [`coverage_at`] at each pixel center, with each row looking only at the segments near it: a
/// segment farther than `width / 2 + |grow|` from a pixel cannot move its coverage off 0 or 1 (the smoothstep is
/// clamped there), every segment that crosses the row (the inside test) is near it, and the two pixels of margin keep
/// float rounding out of both arguments. A non-finite reach (NaN or infinite sizes) keeps every segment.
pub fn coverage(masks: &[Mask], w: usize, h: usize, px_scale: f64) -> Vec<f32> {
    let prepared = prepare(masks, w as f64, h as f64, px_scale);
    if prepared.is_empty() {
        return vec![1.0; w * h];
    }
    let start = start_of(&prepared);
    let mut rows: Vec<Vec<Seg>> = vec![Vec::new(); prepared.len()];
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let yc = y as f64 + 0.5;
        for (q, row) in prepared.iter().zip(&mut rows) {
            row.clear();
            let m = q.width / 2.0 + q.grow.abs() + 2.0;
            if m.is_finite() {
                let far = |s: &&Seg| (yc < s.ay - m && yc < s.by - m) || (yc > s.ay + m && yc > s.by + m);
                row.extend(q.segs.iter().filter(|s| !far(s)));
            } else {
                row.extend_from_slice(&q.segs);
            }
        }
        for x in 0..w {
            let xc = x as f64 + 0.5;
            let acc =
                prepared.iter().zip(&rows).fold(start, |acc, (q, row)| combine(acc, q.mode, mask_at(q, row, xc, yc)));
            out.push(acc as f32);
        }
    }
    out
}

/// A picture as `effects.js` holds one: rgba, premultiplied, linear, row by row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Image {
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

/// Opacity's masks on a picture: each pixel multiplied by the coverage.
pub fn cut_cpu(img: &Image, masks: &[Mask], px_scale: f64) -> Image {
    let cov = coverage(masks, img.w, img.h, px_scale);
    let mut data = vec![0.0_f32; img.data.len()];
    for (k, o) in data.iter_mut().enumerate().take(cov.len() * 4) {
        *o = (f64::from(img.data[k]) * f64::from(cov[k / 4])) as f32;
    }
    Image { w: img.w, h: img.h, data }
}

/// An effect's masks: its output `fx` over its input `base`, by the coverage.
pub fn mix_cpu(base: &Image, fx: &Image, masks: &[Mask], px_scale: f64) -> Image {
    let cov = coverage(masks, base.w, base.h, px_scale);
    let mut data = vec![0.0_f32; base.data.len()];
    for (k, o) in data.iter_mut().enumerate().take(cov.len() * 4) {
        let b = f64::from(base.data[k]);
        let f = fx.data.get(k).map_or(f64::NAN, |v| f64::from(*v));
        *o = (b + (f - b) * f64::from(cov[k / 4])) as f32;
    }
    Image { w: base.w, h: base.h, data }
}

/// The storage buffer of vec4f the WGSL reads: `[count, start, 0, 0]`, then per mask three vec4 (segment start,
/// segment count, mode, inverted), (width, expansion, opacity, 0), (box), then the segments (x0, y0, x1, y1), pixels.
pub fn gpu_data(masks: &[Mask], w: f64, h: f64, px_scale: f64) -> Vec<f32> {
    let prepared = prepare(masks, w, h, px_scale);
    let segs: usize = prepared.iter().map(|q| q.pts.len()).sum();
    let mut data = vec![0.0_f32; 4 * (1 + 3 * prepared.len() + segs)];
    data[0] = prepared.len() as f32;
    data[1] = start_of(&prepared) as f32;
    let mut seg = 1 + 3 * prepared.len();
    for (i, q) in prepared.iter().enumerate() {
        let head = [
            seg as f64,
            q.pts.len() as f64,
            q.mode as usize as f64,
            if q.inverted { 1.0 } else { 0.0 },
            q.width,
            q.grow,
            q.opacity,
            0.0,
        ];
        let o = 4 * (1 + 3 * i);
        for (d, v) in data[o..o + 12].iter_mut().zip(head.iter().chain(&q.bbox)) {
            *d = *v as f32;
        }
        let n = q.pts.len();
        for k in 0..n {
            let ([x0, y0], [x1, y1]) = (q.pts[(k + n - 1) % n], q.pts[k]);
            for (d, v) in data[4 * seg..4 * seg + 4].iter_mut().zip([x0, y0, x1, y1]) {
                *d = v as f32;
            }
            seg += 1;
        }
    }
    data
}

/// The mask pass: tex0 is what the masks keep, tex1 what shows outside them (an effect's input; transparent for
/// Opacity's masks, `mu.info.x = 0`). Pixel centers are at `v.pos.xy`, as the CPU's (x + 0.5, y + 0.5).
pub const WGSL: &str = r"
struct MaskU { size: vec4f, info: vec4f };
@group(0) @binding(0) var tex0: texture_2d<f32>;
@group(0) @binding(1) var tex1: texture_2d<f32>;
@group(0) @binding(2) var<uniform> mu: MaskU;
@group(0) @binding(3) var<storage, read> md: array<vec4f>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
  var o: VOut;
  o.pos = vec4f(xy, 0.0, 1.0);
  o.uv = vec2f((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return o;
}
fn shapeAt(i: u32, p: vec2f) -> f32 {
  let h0 = md[1u + i * 3u];
  let h1 = md[2u + i * 3u];
  let bb = md[3u + i * 3u];
  if (p.x < bb.x || p.y < bb.y || p.x > bb.z || p.y > bb.w) { return 0.0; }
  let s0 = u32(h0.x);
  let n = u32(h0.y);
  var d2 = 1e30;
  var inside = false;
  for (var k = 0u; k < n; k++) {
    let s = md[s0 + k];
    let a = s.xy;
    let b = s.zw;
    let ab = b - a;
    let ap = p - a;
    let t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    let q = ap - ab * t;
    d2 = min(d2, dot(q, q));
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
  }
  let d = sqrt(d2) * select(-1.0, 1.0, inside);
  return smoothstep(-h1.x * 0.5, h1.x * 0.5, d + h1.y);
}
fn coverage(p: vec2f) -> f32 {
  let hd = md[0];
  let n = u32(hd.x);
  var acc = hd.y;
  for (var i = 0u; i < n; i++) {
    let h0 = md[1u + i * 3u];
    let h1 = md[2u + i * 3u];
    var c = shapeAt(i, p);
    if (h0.w > 0.5) { c = 1.0 - c; }
    let m = c * h1.z;
    let mode = u32(h0.z);
    if (mode == 0u) { acc = acc + m - acc * m; }
    else if (mode == 1u) { acc = acc * (1.0 - m); }
    else if (mode == 2u) { acc = acc * m; }
    else { acc = acc + m - 2.0 * acc * m; }
  }
  return acc;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let px = vec2i(floor(v.pos.xy));
  let keep = textureLoad(tex0, px, 0);
  let under = textureLoad(tex1, px, 0) * mu.info.x;
  _ = mu.size;
  return mix(under, keep, coverage(v.pos.xy));
}
";
