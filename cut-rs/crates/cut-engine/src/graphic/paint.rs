//! Resolved layers into a display list (graphic.js `draw`, `drawShape`, `drawText`, `drawParticles`): every fill and
//! stroke a Canvas 2D context would draw, as a path in canvas pixels with its paint, composite operation, blur filter
//! and shadow. Strokes are turned into the outlines they cover here, so the rasteriser only fills.

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use serde_json::Value as Json;
use tiny_skia::{
    BlendMode, Color, GradientStop, LineCap, LineJoin, LinearGradient, Path, PathBuilder, Point, RadialGradient, Rect,
    Shader, SpreadMode, Stroke, StrokeDash, Transform,
};

use super::geometry::{self, Poly};
use super::{Graphic, L, glyphs};
use crate::text::TextRenderer;

/// A canvas shadow: its colour, the standard deviation of its blur and its offset, in canvas pixels.
#[derive(Debug, Clone, Copy)]
pub(super) struct Shadow {
    pub color: Color,
    pub sigma: f32,
    pub dx: f32,
    pub dy: f32,
}

/// One draw call: a path in canvas pixels filled (non-zero) with a shader whose alpha holds the global alpha.
pub(super) struct Op {
    pub path: Path,
    pub shader: Shader<'static>,
    pub blend: BlendMode,
    /// The standard deviation of the layer's blur filter in canvas pixels (0: none).
    pub blur: f32,
    pub shadow: Option<Shadow>,
}

/// The composite operation a layer's blend names (`BLENDS`): W3C compositing's separable blend modes over the
/// destination, `add` the Porter-Duff `lighter` sum.
fn blend_of(name: &str) -> BlendMode {
    match name {
        "add" => BlendMode::Plus,
        "screen" => BlendMode::Screen,
        "multiply" => BlendMode::Multiply,
        "overlay" => BlendMode::Overlay,
        "lighten" => BlendMode::Lighten,
        "darken" => BlendMode::Darken,
        _ => BlendMode::SourceOver,
    }
}

/// A 2D affine matrix as Canvas 2D writes one: `[a, b, c, d, e, f]`, x' = a x + c y + e, y' = b x + d y + f.
type M = [f64; 6];

/// `m` then `n` applied first, as `ctx.transform(n)` after `m`.
fn mul(m: M, n: M) -> M {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

fn translate([x, y]: [f64; 2]) -> M {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

fn rotate(deg: f64) -> M {
    let (s, c) = (deg * PI / 180.0).sin_cos();
    [c, s, -s, c, 0.0, 0.0]
}

fn scale([x, y]: [f64; 2]) -> M {
    [x, 0.0, 0.0, y, 0.0, 0.0]
}

fn to_ts(m: M) -> Transform {
    Transform::from_row(m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32, m[4] as f32, m[5] as f32)
}

/// How much a transform enlarges, for flattening strokes finely enough.
fn res_scale(m: M) -> f32 {
    (m[0].hypot(m[1]).max(m[2].hypot(m[3])) as f32).max(0.01)
}

/// Position, rotation and scale about the anchor (graphic.js `transform`).
fn layer_transform(l: &L<'_>) -> M {
    let s = l.pair("scale");
    let a = l.pair("anchor");
    let m = mul(translate(l.pair("position")), rotate(l.num("rotation")));
    mul(mul(m, scale([s[0] / 100.0, s[1] / 100.0])), translate([-a[0], -a[1]]))
}

/// `#rrggbb` / `#rrggbbaa` as a colour.
pub(super) fn color(hex: &str) -> Option<Color> {
    let b = hex.as_bytes();
    if !((b.len() == 7 || b.len() == 9) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    Some(Color::from_rgba8(byte(1), byte(3), byte(5), if b.len() == 9 { byte(7) } else { 255 }))
}

fn solid(c: Color, alpha: f64) -> Shader<'static> {
    let mut c = c;
    c.apply_opacity(alpha as f32);
    Shader::SolidColor(c)
}

/// A layer's fill: its gradient (in the layer's pixels) or its colour, with the global alpha (`paintOf`); `None`
/// when it paints nothing.
fn paint_of(l: &L<'_>, alpha: f64, m: M) -> Option<Shader<'static>> {
    let Some(g) = l.0.get("gradient").and_then(Json::as_object) else {
        return Some(solid(color(l.color_text("fill")?)?, alpha));
    };
    let pt = |k: &str| {
        let p = g.get(k).and_then(Json::as_array);
        let at = |i: usize| p.and_then(|p| p.get(i)).and_then(Json::as_f64).unwrap_or(0.0);
        [at(0), at(1)]
    };
    let (from, to) = (pt("from"), pt("to"));
    let mut stops: Vec<(f64, Color)> = g
        .get("stops")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| Some((s.get(0)?.as_f64()?, color(s.get(1)?.as_str()?)?)))
        .collect();
    stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    let stops: Vec<GradientStop> = stops
        .into_iter()
        .map(|(o, mut c)| {
            c.apply_opacity(alpha as f32);
            GradientStop::new(o as f32, c)
        })
        .collect();
    let p = |q: [f64; 2]| Point::from_xy(q[0] as f32, q[1] as f32);
    if g.get("type").and_then(Json::as_str) == Some("radial") {
        let r = (to[0] - from[0]).hypot(to[1] - from[1]).max(0.001);
        RadialGradient::new(p(from), p(from), r as f32, stops, SpreadMode::Pad, to_ts(m))
    } else if from == to {
        // a linear gradient along no line paints nothing on a canvas
        None
    } else {
        LinearGradient::new(p(from), p(to), stops, SpreadMode::Pad, to_ts(m))
    }
}

fn polys_path(polys: &[Poly]) -> Option<Path> {
    let mut b = PathBuilder::new();
    for p in polys {
        let Some(first) = p.pts.first() else { continue };
        b.move_to(first[0] as f32, first[1] as f32);
        for q in &p.pts[1..] {
            b.line_to(q[0] as f32, q[1] as f32);
        }
        if p.closed {
            b.close();
        }
    }
    b.finish()
}

fn cap_of(s: &str) -> LineCap {
    match s {
        "butt" => LineCap::Butt,
        "square" => LineCap::Square,
        _ => LineCap::Round,
    }
}

fn join_of(s: &str) -> LineJoin {
    match s {
        "miter" => LineJoin::Miter,
        "bevel" => LineJoin::Bevel,
        _ => LineJoin::Round,
    }
}

/// What a stroke of `path` (in the layer's pixels) covers, in canvas pixels.
fn stroked(path: &Path, stroke: &Stroke, dash: Option<[f64; 2]>, m: M) -> Option<Path> {
    let res = res_scale(m);
    let dashed;
    let path = match dash {
        Some([d, g]) => {
            dashed = path.dash(&StrokeDash::new(vec![d as f32, g as f32], 0.0)?, res)?;
            &dashed
        }
        None => path,
    };
    path.stroke(stroke, res)?.transform(to_ts(m))
}

/// The state a layer draws all its calls with.
struct Style {
    blend: BlendMode,
    blur: f32,
    shadow: Option<Shadow>,
}

struct List(Vec<Op>);

impl List {
    fn push(&mut self, path: Option<Path>, shader: Option<Shader<'static>>, st: &Style, shadow: bool) {
        if let (Some(path), Some(shader)) = (path, shader) {
            self.0.push(Op {
                path,
                shader,
                blend: st.blend,
                blur: st.blur,
                shadow: if shadow { st.shadow } else { None },
            });
        }
    }
}

/// The draw calls of a graphic at `k` canvas pixels per sequence pixel, bottom first.
pub(super) fn ops(g: &Graphic, text: &mut TextRenderer, k: f64) -> Vec<Op> {
    let layers: Vec<L<'_>> = g.layers.iter().map(L).collect();
    let by_id: HashMap<&str, L<'_>> = layers.iter().filter_map(|l| Some((l.0.get("id")?.as_str()?, *l))).collect();
    let parent_of = |l: &L<'_>| l.0.get("parent").and_then(Json::as_str).and_then(|p| by_id.get(p)).copied();
    let base = [k, 0.0, 0.0, k, g.w / 2.0 * k, g.h / 2.0 * k];
    let mut out = List(Vec::new());
    for l in &layers {
        if l.kind() == "group" || !l.flag("visible") {
            continue;
        }
        let mut parents = Vec::new();
        let mut seen = HashSet::new();
        let mut p = parent_of(l);
        while let Some(q) = p {
            if !seen.insert(q.str("id")) {
                break;
            }
            parents.insert(0, q);
            p = parent_of(&q);
        }
        if parents.iter().any(|p| !p.flag("visible")) {
            continue;
        }
        let alpha: f64 = parents.iter().chain([l]).map(|x| x.num("opacity") / 100.0).product();
        if alpha <= 0.0 {
            continue;
        }
        let big = |x: &L<'_>| {
            let s = x.pair("scale");
            s[0].abs().max(s[1].abs()) / 100.0
        };
        let zoom = parents.iter().fold(big(l), |z, x| z * big(x));
        let unit = (k * zoom).max(0.05);
        let m = parents.iter().chain([l]).fold(base, |m, x| mul(m, layer_transform(x)));
        let shadow = l.color_text("shadowColor").and_then(color).and_then(|c| {
            let (b, o) = (l.num("shadowBlur"), l.pair("shadowOffset"));
            (b > 0.0 || o[0] != 0.0 || o[1] != 0.0).then_some(Shadow {
                color: c,
                sigma: (b * k / 2.0) as f32,
                dx: (o[0] * k) as f32,
                dy: (o[1] * k) as f32,
            })
        });
        let st = Style { blend: blend_of(l.str("blend")), blur: (l.num("blur") * k).max(0.0) as f32, shadow };
        let copies = l.count("repeatCount").max(1);
        let kind = l.kind();
        let polys = if kind == "text" || kind == "particles" { Vec::new() } else { geometry::outline(l, unit) };
        let shaped = (kind == "text").then(|| glyphs::shape(text, l));
        let anchor = l.pair("anchor");
        for i in 0..copies {
            let m = if i > 0 {
                let n = i as f64;
                let (ro, rs) = (l.pair("repeatOffset"), l.pair("repeatScale"));
                let r = mul(translate(anchor), translate([ro[0] * n, ro[1] * n]));
                let r = mul(
                    mul(r, rotate(l.num("repeatRotation") * n)),
                    scale([(rs[0] / 100.0).powf(n), (rs[1] / 100.0).powf(n)]),
                );
                mul(m, mul(r, translate([-anchor[0], -anchor[1]])))
            } else {
                m
            };
            let fade = if copies > 1 {
                1.0 + (l.num("repeatOpacity") / 100.0 - 1.0) * (i as f64 / (copies - 1) as f64)
            } else {
                1.0
            };
            let a = alpha * fade;
            match (kind, &shaped) {
                ("text", Some(s)) => text_ops(&mut out, l, s, a, m, &st),
                ("particles", _) => particle_ops(&mut out, l, g.t, a, m, &st),
                _ => shape_ops(&mut out, l, &polys, a, m, &st),
            }
        }
    }
    out.0
}

fn shape_ops(out: &mut List, l: &L<'_>, polys: &[Poly], a: f64, m: M, st: &Style) {
    let filled =
        l.kind() != "line" && (l.color_text("fill").is_some() || l.0.get("gradient").is_some_and(Json::is_object));
    if filled {
        out.push(polys_path(polys).and_then(|p| p.transform(to_ts(m))), paint_of(l, a, m), st, true);
    }
    let width = l.num("strokeWidth");
    let Some(c) = l.color_text("stroke").and_then(color) else { return };
    if width <= 0.0 {
        return;
    }
    let runs = geometry::stroke_runs(l, polys);
    let stroke = Stroke {
        width: width as f32,
        miter_limit: 10.0,
        line_cap: cap_of(l.str("cap")),
        line_join: join_of(l.str("join")),
        dash: None,
    };
    let dash = l.0.get("dash").and_then(Json::as_array).map(|d| {
        let at = |i: usize| d.get(i).and_then(Json::as_f64).unwrap_or(0.0);
        [at(0), at(1)]
    });
    let path = polys_path(&runs).and_then(|p| stroked(&p, &stroke, dash, m));
    // a filled shape's stroke casts no shadow of its own (the JavaScript clears shadowColor before it)
    out.push(path, Some(solid(c, a)), st, !filled);
}

fn text_ops(out: &mut List, l: &L<'_>, s: &glyphs::Shaped, a: f64, m: M, st: &Style) {
    let lh = l.num("fontSize") * l.num("lineHeight");
    let y0 = -((s.lines.len() as f64 - 1.0) * lh) / 2.0;
    let place = |i: usize, width: f64| {
        let x = match l.str("align") {
            "left" => 0.0,
            "right" => -width,
            _ => -width / 2.0,
        };
        mul(m, translate([x, y0 + i as f64 * lh + s.baseline]))
    };
    let width = l.num("strokeWidth");
    if let Some(c) = l.color_text("stroke").and_then(color)
        && width > 0.0
    {
        let stroke = Stroke {
            width: width as f32,
            miter_limit: 10.0,
            line_cap: LineCap::Butt,
            line_join: join_of(l.str("join")),
            dash: None,
        };
        for (i, line) in s.lines.iter().enumerate() {
            let path = line.path.as_ref().and_then(|p| stroked(p, &stroke, None, place(i, line.width)));
            out.push(path, Some(solid(c, a)), st, true);
        }
    }
    if l.color_text("fill").is_some() || l.0.get("gradient").is_some_and(Json::is_object) {
        for (i, line) in s.lines.iter().enumerate() {
            let lm = place(i, line.width);
            out.push(line.path.as_ref().and_then(|p| p.clone().transform(to_ts(lm))), paint_of(l, a, m), st, true);
        }
    }
}

fn particle_ops(out: &mut List, l: &L<'_>, t: f64, a: f64, m: M, st: &Style) {
    for p in geometry::particles(l, t) {
        let path = match p.turn {
            Some(turn) => {
                let h = p.size / 2.0;
                let pm = mul(mul(m, translate([p.x, p.y])), rotate(turn));
                Rect::from_xywh(-h as f32, -h as f32, p.size as f32, p.size as f32)
                    .map(PathBuilder::from_rect)
                    .and_then(|r| r.transform(to_ts(pm)))
            }
            None => PathBuilder::from_circle(p.x as f32, p.y as f32, (p.size / 2.0) as f32)
                .and_then(|c| c.transform(to_ts(m))),
        };
        out.push(path, color(&p.color).map(|c| solid(c, p.alpha * a)), st, true);
    }
}
