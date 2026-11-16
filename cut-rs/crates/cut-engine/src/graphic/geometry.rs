//! A layer's geometry in its own pixels (graphic.js `outline`, `trimmed`, `strokeRuns`, `rand` and the particle
//! stream of `drawParticles`): pure functions of a resolved layer, compared with the JavaScript value by value.

use std::f64::consts::PI;

use cut_model::graphic::{Seg, parse_path};
use cut_model::keyframes::{self, Value};

use super::L;

/// A polyline of an outline, closed or open.
#[derive(Debug, Clone, PartialEq)]
pub struct Poly {
    pub pts: Vec<[f64; 2]>,
    pub closed: bool,
}

fn ring(n: usize, at: impl Fn(f64) -> [f64; 2]) -> Poly {
    Poly { pts: (0..n).map(|i| at(i as f64 / n as f64)).collect(), closed: true }
}

/// A layer's outline as polylines in its own pixels; `fine` is how many polyline points per pixel of curve length
/// (more when drawn larger). Text, groups and particles have none.
pub fn outline(l: &L<'_>, fine: f64) -> Vec<Poly> {
    let seg = |len: f64| (len * fine / 3.0).ceil().clamp(4.0, 256.0) as usize;
    match l.kind() {
        "rect" => {
            let [w, h] = l.pair("size");
            let r = l.num("radius").min(w / 2.0).min(h / 2.0).max(0.0);
            let (x0, y0) = (-w / 2.0, -h / 2.0);
            if r <= 0.0 {
                return vec![Poly { pts: vec![[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], closed: true }];
            }
            let n = seg((PI * r) / 2.0);
            let mut pts = Vec::with_capacity(4 * (n + 1));
            let mut corner = |cx: f64, cy: f64, a0: f64| {
                for i in 0..=n {
                    let a = a0 + (i as f64 / n as f64) * (PI / 2.0);
                    pts.push([cx + r * a.cos(), cy + r * a.sin()]);
                }
            };
            corner(x0 + w - r, y0 + r, -PI / 2.0);
            corner(x0 + w - r, y0 + h - r, 0.0);
            corner(x0 + r, y0 + h - r, PI / 2.0);
            corner(x0 + r, y0 + r, PI);
            vec![Poly { pts, closed: true }]
        }
        "ellipse" => {
            let [w, h] = l.pair("size");
            let n = seg((PI * (w + h)) / 2.0).max(24);
            vec![ring(n, |f| [(w / 2.0) * (f * 2.0 * PI).sin(), (-h / 2.0) * (f * 2.0 * PI).cos()])]
        }
        "polygon" => {
            let r = l.num("radius");
            vec![ring(l.count("points"), |f| [r * (f * 2.0 * PI).sin(), -r * (f * 2.0 * PI).cos()])]
        }
        "star" => {
            let n = l.count("points");
            let (outer, inner) = (l.num("radius"), l.num("innerRadius"));
            vec![ring(n * 2, |f| {
                let r = if js_round(f * n as f64 * 2.0) as i64 % 2 != 0 { inner } else { outer };
                [r * (f * 2.0 * PI).sin(), -r * (f * 2.0 * PI).cos()]
            })]
        }
        "line" => vec![Poly { pts: vec![l.pair("from"), l.pair("to")], closed: false }],
        "path" => parse_path(l.str("d")).unwrap_or_default().iter().map(|sp| flatten(sp, &seg)).collect(),
        _ => Vec::new(),
    }
}

fn flatten(sp: &cut_model::graphic::Subpath, seg: &impl Fn(f64) -> usize) -> Poly {
    let mut pts = Vec::new();
    let (mut px, mut py) = (0.0, 0.0);
    let d = |ax: f64, ay: f64, bx: f64, by: f64| (bx - ax).hypot(by - ay);
    for c in &sp.cmds {
        match *c {
            Seg::M(x, y) | Seg::L(x, y) => {
                pts.push([x, y]);
                (px, py) = (x, y);
            }
            Seg::C(x1, y1, x2, y2, x, y) => {
                let n = seg(d(px, py, x1, y1) + d(x1, y1, x2, y2) + d(x2, y2, x, y));
                for i in 1..=n {
                    let t = i as f64 / n as f64;
                    let u = 1.0 - t;
                    pts.push([
                        u * u * u * px + 3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t * x,
                        u * u * u * py + 3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t * y,
                    ]);
                }
                (px, py) = (x, y);
            }
            Seg::Q(x1, y1, x, y) => {
                let n = seg(d(px, py, x1, y1) + d(x1, y1, x, y));
                for i in 1..=n {
                    let t = i as f64 / n as f64;
                    let u = 1.0 - t;
                    pts.push([u * u * px + 2.0 * u * t * x1 + t * t * x, u * u * py + 2.0 * u * t * y1 + t * t * y]);
                }
                (px, py) = (x, y);
            }
        }
    }
    Poly { pts, closed: sp.closed }
}

fn length(pts: &[[f64; 2]]) -> f64 {
    pts.windows(2).map(|p| (p[1][0] - p[0][0]).hypot(p[1][1] - p[0][1])).sum()
}

/// The parts of the outline between fractions `a` and `b` of its whole length (a < b, both 0..1), as open polylines.
pub fn trimmed(polys: &[Poly], a: f64, b: f64) -> Vec<Vec<[f64; 2]>> {
    let runs: Vec<Vec<[f64; 2]>> = polys
        .iter()
        .map(|p| {
            let mut pts = p.pts.clone();
            if p.closed && !pts.is_empty() {
                pts.push(p.pts[0]);
            }
            pts
        })
        .collect();
    let lens: Vec<f64> = runs.iter().map(|r| length(r)).collect();
    let total: f64 = lens.iter().sum();
    if total <= 0.0 {
        return Vec::new();
    }
    let (from, to) = (a * total, b * total);
    let mut out = Vec::new();
    let mut base = 0.0;
    for (pts, len) in runs.iter().zip(&lens) {
        let (lo, hi) = (from.max(base), to.min(base + len));
        if hi > lo {
            let mut part = Vec::new();
            let mut s = base;
            for i in 1..pts.len() {
                let (p0, p1) = (pts[i - 1], pts[i]);
                let d = (p1[0] - p0[0]).hypot(p1[1] - p0[1]);
                let at = |q: f64| {
                    let f = if d > 0.0 { (q - s) / d } else { 0.0 };
                    [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f]
                };
                if s + d >= lo && s <= hi {
                    if part.is_empty() {
                        part.push(at(lo.max(s)));
                    }
                    part.push(at(hi.min(s + d)));
                }
                s += d;
            }
            if part.len() > 1 {
                out.push(part);
            }
        }
        base += len;
    }
    out
}

/// The stroke's visible runs: whole polylines when nothing is trimmed, else open runs of the trimmed length.
pub fn stroke_runs(l: &L<'_>, polys: &[Poly]) -> Vec<Poly> {
    let (mut a, mut b) = (l.num("trimStart") / 100.0, l.num("trimEnd") / 100.0);
    if b < a {
        (a, b) = (b, a);
    }
    if a <= 0.0 && b >= 1.0 {
        return polys.to_vec();
    }
    if b - a <= 0.0 {
        return Vec::new();
    }
    let mut off = (l.num("trimOffset") / 100.0) % 1.0;
    if off < 0.0 {
        off += 1.0;
    }
    a += off;
    b += off;
    let parts = if b <= 1.0 {
        trimmed(polys, a, b)
    } else if a >= 1.0 {
        trimmed(polys, a - 1.0, b - 1.0)
    } else {
        let (mut tail, head) = (trimmed(polys, a, 1.0), trimmed(polys, 0.0, b - 1.0));
        // one closed outline: the run goes on through its start, so the corner there keeps its join
        if polys.len() == 1 && polys[0].closed && !tail.is_empty() && !head.is_empty() {
            let last = tail.last_mut().expect("not empty");
            last.extend_from_slice(&head[0][1..]);
            tail.extend(head.into_iter().skip(1));
            tail
        } else {
            tail.extend(head);
            tail
        }
    };
    parts.into_iter().map(|pts| Poly { pts, closed: false }).collect()
}

/// `Math.round`: halves go up, also below zero.
pub(super) fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `x >>> 0` of a JavaScript number.
fn to_u32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let m = x.trunc() % 4_294_967_296.0;
    (if m < 0.0 { m + 4_294_967_296.0 } else { m }) as u32
}

/// A deterministic random number in 0..1 for (seed, i, j, k), the JavaScript's hash bit for bit (its first sum is in
/// doubles, rounding as the JavaScript's does).
pub fn rand(seed: f64, i: f64, j: f64, k: f64) -> f64 {
    let mut h = to_u32(seed * 374_761_393.0 + i * 668_265_263.0 + j * 2_246_822_519.0 + k * 3_266_489_917.0);
    h = (h ^ (h >> 15)).wrapping_mul(2_246_822_507);
    h = (h ^ (h >> 13)).wrapping_mul(3_266_489_909);
    f64::from(h ^ (h >> 16)) / 4_294_967_296.0
}

/// One particle as drawn at a time, in the layer's pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Particle {
    pub x: f64,
    pub y: f64,
    pub size: f64,
    /// Its opacity as a fraction of the layer's.
    pub alpha: f64,
    /// `#rrggbb` or `#rrggbbaa`.
    pub color: String,
    /// The turn of a square particle in degrees; `None` for a circle.
    pub turn: Option<f64>,
}

/// The particles a particle layer draws `t` seconds from the clip's start (`drawParticles`).
pub fn particles(l: &L<'_>, t: f64) -> Vec<Particle> {
    let n = l.count("count");
    let (life, seed) = (l.num("life"), l.num("seed"));
    let burst = l.str("emit") == "burst";
    let fill = l.color_text("fill").unwrap_or("#ffffff");
    let fill_end = l.color_text("fillEnd");
    let (emitter, gravity) = (l.pair("emitter"), l.pair("gravity"));
    let (size0, size1) = (l.num("particleSize"), l.num("particleSizeEnd"));
    let full = |c: &str| if c.len() == 7 { format!("{c}ff") } else { c.to_string() };
    let mut out = Vec::new();
    for i in 0..n {
        let (age, cycle) = if burst {
            if t > life {
                continue;
            }
            (t, 0.0)
        } else {
            let born = (i as f64 / n as f64) * life;
            if t < born {
                continue;
            }
            let cycle = ((t - born) / life).floor();
            (t - born - cycle * life, cycle)
        };
        let r = |j: f64| rand(seed, i as f64, cycle, j);
        let p = age / life;
        let a = (l.num("direction") + (r(3.0) - 0.5) * l.num("spread")) * PI / 180.0;
        let v = l.num("speed") * (1.0 + (r(4.0) - 0.5) * 2.0 * (l.num("speedVariation") / 100.0));
        let x = (r(1.0) - 0.5) * emitter[0] + a.sin() * v * age + 0.5 * gravity[0] * age * age;
        let y = (r(2.0) - 0.5) * emitter[1] - a.cos() * v * age + 0.5 * gravity[1] * age * age;
        let size = size0 + (size1 - size0) * p;
        if size <= 0.0 {
            continue;
        }
        let color = match fill_end {
            Some(end) => match keyframes::mix(&Value::Text(full(fill)), &Value::Text(full(end)), p) {
                Value::Text(c) => c,
                _ => fill.to_string(),
            },
            None => fill.to_string(),
        };
        out.push(Particle {
            x,
            y,
            size,
            alpha: (1.0 + (l.num("opacityEnd") / 100.0 - 1.0) * p).clamp(0.0, 1.0),
            color,
            turn: (l.str("particleShape") == "square").then(|| l.num("spin") * age + r(5.0) * 360.0),
        });
    }
    out
}
