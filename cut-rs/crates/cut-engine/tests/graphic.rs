//! Graphic clips (src/graphic) against graphic.js and in pictures: resolved layers, outlines, trims, the particle
//! hash and stream and text lines value by value through the oracle; then pictures the engine draws headlessly, read
//! back pixel by pixel (a stroked rectangle, Korean text, every blend mode against the W3C formulas, keyframed
//! opacity and position at two times), and a benchmark.

mod common;

use std::time::{Duration, Instant};

use common::*;
use cut_engine::graphic::{self, Graphic, L, geometry};
use cut_engine::text::TextRenderer;
use cut_engine::{Engine, RenderOptions};
use cut_model::keyframes::{Ease, Keyframe, Value};
use cut_model::{Clip, Generator, Id, Project, Source};
use cut_oracle::{Inputs, ask};
use serde_json::{Value as Json, json};

const WAIT: RenderOptions = RenderOptions {
    quality: 1.0,
    captions: cut_engine::Captions::None,
    wait: Some(Duration::from_secs(20)),
    proxy: false,
};

fn graphic_source(layers: &[Json]) -> Source {
    Source::Generator {
        generator: Generator::Graphic,
        layers: Some(layers.iter().map(cut_model::graphic::normalize).collect()),
        color: None,
        extra: Default::default(),
    }
}

fn graphic_clip(layers: &[Json]) -> Clip {
    clip("g1", "V1", 0, 0.0, (2 * SEC) as f64, graphic_source(layers))
}

fn kf(t: i64, v: Value) -> Keyframe {
    Keyframe { t, v, ease: Ease::Linear, h: None }
}

/// A 320 x 180 project showing the clip, read back as the editor opens it.
fn project_with(c: Clip) -> Project {
    let mut p = project(320, 180);
    put(&mut p, "s1", c);
    reload(&p).0
}

fn shot(e: &mut Engine, p: &Project, t: i64, name: &str) -> Vec<u8> {
    let r = e.render(p, Id::new("s1"), t, (320, 180), &WAIT).expect("a render");
    assert!(r.complete && r.failed.is_empty(), "the frame is drawn");
    let img = e.read_pixels();
    let path = write_png(name, &img, 320, 180);
    eprintln!("{}", path.display());
    img
}

fn px(img: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [img[i], img[i + 1], img[i + 2], img[i + 3]]
}

fn near(a: [u8; 4], b: [u8; 4], tol: i32, what: &str) {
    assert!(a.iter().zip(&b).all(|(x, y)| (i32::from(*x) - i32::from(*y)).abs() <= tol), "{what}: {a:?} vs {b:?}");
}

fn check(what: &str, got: &[Json], want: &[Json], calls: &[Json], eps: f64) {
    assert_eq!(got.len(), want.len());
    let bad: Vec<String> = got
        .iter()
        .zip(want)
        .enumerate()
        .filter_map(|(i, (g, w))| same(g, w, eps, "").err().map(|e| format!("{what} {}: {e}", calls[i])))
        .collect();
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), got.len(), bad[..bad.len().min(6)].join("\n"));
    eprintln!("{what}: {} calls agree", got.len());
}

fn f(r: &mut Inputs, lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * (r.next_u64() % 1_000_001) as f64 / 1_000_000.0
}

fn hex(r: &mut Inputs, alpha: bool) -> String {
    let n = if alpha { 4 } else { 3 };
    let mut s = String::from("#");
    for _ in 0..n {
        s.push_str(&format!("{:02x}", r.range(0, 255)));
    }
    s
}

/// A colour with or without alpha.
fn hex_any(r: &mut Inputs) -> String {
    let alpha = r.range(0, 1) == 1;
    hex(r, alpha)
}

const PATHS: [&str; 6] = [
    "M -250 0 C -150 -80 -50 80 50 0 S 200 -60 250 0",
    "m 0 0 l 10 0 l 0 10 z m 20 20 h 30 v 30 h -30 z",
    "M0 0 Q 50 -80 100 0 T 200 0",
    "M 10 10 L 200 30 L 50 180 Z",
    "M 0 0 A 5 5 0 0 1 10 10",
    "M -100 -100 c 0 -55 45 -100 100 -100 s 100 45 100 100 q 0 50 -50 75 t -50 25 z",
];

/// A random layer of a shape kind with fields in and out of their ranges' corners.
fn random_layer(r: &mut Inputs, id: &str) -> Json {
    let kind = r.pick(&["rect", "ellipse", "polygon", "star", "line", "path", "text", "particles"]);
    let mut l = json!({ "id": id, "kind": kind });
    let o = l.as_object_mut().expect("an object");
    o.insert("position".into(), json!([f(r, -500.0, 500.0), f(r, -300.0, 300.0)]));
    o.insert("rotation".into(), json!(f(r, -720.0, 720.0)));
    o.insert("opacity".into(), json!(f(r, 0.0, 100.0)));
    match kind {
        "rect" => {
            o.insert("size".into(), json!([f(r, 0.0, 800.0), f(r, 0.0, 400.0)]));
            o.insert("radius".into(), json!(f(r, 0.0, 300.0) * r.range(0, 1) as f64));
        }
        "ellipse" => {
            o.insert("size".into(), json!([f(r, 0.0, 900.0), f(r, 0.0, 900.0)]));
        }
        "polygon" | "star" => {
            o.insert("points".into(), json!(r.range(3, 64)));
            o.insert("radius".into(), json!(f(r, 0.0, 400.0)));
            if kind == "star" {
                o.insert("innerRadius".into(), json!(f(r, 0.0, 400.0)));
            }
        }
        "line" => {
            o.insert("from".into(), json!([f(r, -500.0, 500.0), f(r, -500.0, 500.0)]));
            o.insert("to".into(), json!([f(r, -500.0, 500.0), f(r, -500.0, 500.0)]));
        }
        "path" => {
            o.insert("d".into(), json!(r.pick(&PATHS)));
        }
        "text" => {
            o.insert(
                "text".into(),
                json!(r.pick(&["Text", "{value}%", "안녕하세요\n두 줄", "a 👩‍👩‍👧 b", "{value} / {value}"])),
            );
            o.insert("value".into(), json!(f(r, -2e6, 2e6) * r.pick(&[1.0, 0.001, 1e5])));
            o.insert("decimals".into(), json!(r.range(0, 6)));
            o.insert("reveal".into(), json!(f(r, 0.0, 1.0)));
        }
        _ => {
            o.insert("count".into(), json!(r.range(1, 80)));
            o.insert("seed".into(), json!(r.range(0, 1_000_000_000)));
            o.insert("emit".into(), json!(r.pick(&["stream", "burst"])));
            o.insert("emitter".into(), json!([f(r, 0.0, 600.0), f(r, 0.0, 300.0)]));
            o.insert("spread".into(), json!(f(r, 0.0, 360.0)));
            o.insert("gravity".into(), json!([f(r, -200.0, 200.0), f(r, -200.0, 200.0)]));
            o.insert("life".into(), json!(f(r, 0.05, 4.0)));
            o.insert("particleSizeEnd".into(), json!(f(r, 0.0, 30.0)));
            o.insert("fillEnd".into(), if r.range(0, 1) == 1 { json!(hex_any(r)) } else { Json::Null });
            o.insert("particleShape".into(), json!(r.pick(&["circle", "square"])));
            o.insert("spin".into(), json!(f(r, -720.0, 720.0)));
            o.insert("opacityEnd".into(), json!(f(r, 0.0, 100.0)));
        }
    }
    if kind != "text" && kind != "particles" {
        o.insert("stroke".into(), json!(hex(r, false)));
        o.insert("strokeWidth".into(), json!(f(r, 0.0, 20.0)));
        o.insert("trimStart".into(), json!(f(r, 0.0, 100.0)));
        o.insert("trimEnd".into(), json!(f(r, 0.0, 100.0)));
        o.insert("trimOffset".into(), json!(f(r, -300.0, 300.0)));
    }
    l
}

/// Keyframes on the layer's fields: numbers past their ranges, overshooting eases, colours with and without alpha,
/// whole numbers that need rounding, a field the kind lacks and one that cannot animate.
fn random_keyframes(r: &mut Inputs, l: &Json) -> cut_model::Keyframes {
    let id = l["id"].as_str().expect("an id");
    let mut out = cut_model::Keyframes::new();
    let fields = [
        "opacity", "rotation", "position", "scale", "fill", "stroke", "points", "trimEnd", "count", "radius", "d",
        "visible", "nope",
    ];
    for _ in 0..r.range(1, 5) {
        let field = r.pick(&fields);
        let v = |r: &mut Inputs| match field {
            "position" | "scale" => Value::List(vec![f(r, -30000.0, 30000.0), f(r, -200.0, 200.0)]),
            "fill" | "stroke" => Value::Text(hex_any(r)),
            "d" => Value::Text("M0 0 L 1 1".into()),
            "visible" => Value::Flag(false),
            _ => Value::Num(f(r, -150.0, 250.0)),
        };
        let a = kf(0, v(r));
        let mut b = kf(SEC, v(r));
        if r.range(0, 1) == 1 {
            b = Keyframe { t: SEC, v: b.v, ease: Ease::Linear, h: None };
            let ease = r.pick(&[Ease::EaseInOut, Ease::Bezier, Ease::Hold, Ease::EaseOut]);
            out.insert(
                format!("layers.{id}.{field}"),
                vec![Keyframe { t: 0, v: a.v, ease, h: (ease == Ease::Bezier).then(|| vec![0.3, 1.8, 0.6, 1.4]) }, b],
            );
        } else {
            out.insert(format!("layers.{id}.{field}"), vec![a, b]);
        }
    }
    out
}

#[test]
fn resolve_outline_trim_and_hash_match_the_javascript() {
    let mut r = Inputs::new(0x6a70);
    let (mut calls, mut got) = (Vec::new(), Vec::new());
    let (mut ocalls, mut ogot) = (Vec::new(), Vec::new());
    let (mut tcalls, mut tgot) = (Vec::new(), Vec::new());
    for i in 0..300 {
        let layer = random_layer(&mut r, &format!("l{i}"));
        let mut c = graphic_clip(std::slice::from_ref(&layer));
        c.keyframes = random_keyframes(&mut r, &layer);
        let t = f(&mut r, -0.2, 1.2) * SEC as f64;
        let resolved = graphic::resolve(&layer, &c, t);
        calls.push(json!(["resolve", layer, { "keyframes": c.keyframes }, t]));
        got.push(Json::Object(resolved.clone()));
        let fine = f(&mut r, 0.05, 4.0);
        let polys = geometry::outline(&L(&resolved), fine);
        let as_json = |p: &[geometry::Poly]| {
            json!(p.iter().map(|p| json!({ "pts": p.pts, "closed": p.closed })).collect::<Vec<_>>())
        };
        ocalls.push(json!(["outline", resolved, fine]));
        ogot.push(as_json(&polys));
        tcalls.push(json!(["strokeRuns", resolved, as_json(&polys)]));
        tgot.push(as_json(&geometry::stroke_runs(&L(&resolved), &polys)));
    }
    check("resolve", &got, &ask("graphic", &calls), &calls, 1e-12);
    check("outline", &ogot, &ask("graphic", &ocalls), &ocalls, 1e-9);
    check("strokeRuns", &tgot, &ask("graphic", &tcalls), &tcalls, 1e-9);

    let mut hcalls = Vec::new();
    let mut hgot = Vec::new();
    for _ in 0..2000 {
        let a = [r.range(0, 1_000_000_000), r.range(0, 2000), r.range(0, 200_000), r.range(0, 6)].map(|x| x as f64);
        hcalls.push(json!(["rand", a[0], a[1], a[2], a[3]]));
        hgot.push(json!(geometry::rand(a[0], a[1], a[2], a[3])));
    }
    check("rand", &hgot, &ask("graphic", &hcalls), &hcalls, 0.0);

    let mut pcalls = Vec::new();
    let mut pgot = Vec::new();
    for i in 0..40 {
        let l = cut_model::graphic::normalize(
            &json!({ "id": "p", "kind": "particles", "emit": if i % 2 == 0 { "burst" } else { "stream" }, "life": f(&mut r, 0.1, 3.0), "opacity": r.pick(&[0.0, 50.0]), "visible": i % 5 != 0 }),
        );
        let t = f(&mut r, 0.0, 4.0);
        let Json::Object(m) = l.clone() else { unreachable!() };
        pcalls.push(json!(["hasParticles", [l], t]));
        pgot.push(json!(graphic::has_particles(&[m], t)));
    }
    check("hasParticles", &pgot, &ask("graphic", &pcalls), &pcalls, 0.0);
}

#[test]
fn particles_and_text_lines_match_the_javascript() {
    let mut r = Inputs::new(0x9a27);
    let (mut calls, mut got) = (Vec::new(), Vec::new());
    let (mut lcalls, mut lgot) = (Vec::new(), Vec::new());
    for i in 0..120 {
        let mut layer = random_layer(&mut r, "p");
        if i % 2 == 0 {
            layer = json!({ "id": "p", "kind": "particles", "count": r.range(1, 200), "seed": r.range(0, 1_000_000_000), "emit": r.pick(&["stream", "burst"]),
                "emitter": [f(&mut r, 0.0, 600.0), f(&mut r, 0.0, 300.0)], "life": f(&mut r, 0.05, 3.0), "fill": hex_any(&mut r),
                "fillEnd": hex_any(&mut r), "particleShape": r.pick(&["circle", "square"]), "spin": f(&mut r, -720.0, 720.0),
                "speedVariation": f(&mut r, 0.0, 100.0), "direction": f(&mut r, -360.0, 360.0) });
        }
        // the oracle places the layer at the origin, unturned, at 100 %
        let o = layer.as_object_mut().expect("an object");
        o.remove("position");
        o.remove("rotation");
        o.insert("opacity".into(), json!(100));
        let Json::Object(n) = cut_model::graphic::normalize(&layer) else { unreachable!() };
        match n["kind"].as_str() {
            Some("particles") => {
                let t = f(&mut r, 0.0, 10.0);
                calls.push(json!(["particles", layer, t]));
                got.push(json!(geometry::particles(&L(&n), t)
                    .iter()
                    .map(|p| json!({ "x": p.x, "y": p.y, "size": p.size, "alpha": p.alpha, "color": p.color, "turn": p.turn }))
                    .collect::<Vec<_>>()));
            }
            Some("text") => {
                lcalls.push(json!(["lines", layer]));
                lgot.push(json!(cut_engine::graphic::glyphs::shown_text(&L(&n)).split('\n').collect::<Vec<_>>()));
            }
            _ => {}
        }
    }
    let want = ask_scenario_cjs("graphic", &calls);
    check("particles", &got, &want, &calls, 1e-9);
    check("text lines", &lgot, &ask_scenario_cjs("graphic", &lcalls), &lcalls, 0.0);
}

/// A CommonJS scenario under tools/scenarios.
fn ask_scenario_cjs(name: &str, calls: &[Json]) -> Vec<Json> {
    ask(&format!("scenario/{name}"), calls)
}

#[test]
fn a_red_rectangle_with_a_white_stroke() {
    let rect = json!({ "id": "r", "kind": "rect", "size": [100, 60], "fill": "#ff0000", "stroke": "#ffffff", "strokeWidth": 4, "join": "miter" });
    let p = project_with(graphic_clip(&[rect]));
    let mut e = Engine::headless().expect("a GPU");
    let img = shot(&mut e, &p, 0, "graphic-rect.png");
    // the rect spans x 110..210, y 60..120; its 4 px stroke covers 2 px either side of the edge
    near(px(&img, 320, 160, 90), [255, 0, 0, 255], 1, "inside the fill");
    near(px(&img, 320, 113, 90), [255, 0, 0, 255], 1, "inside the fill, past the stroke");
    for (x, y) in [(109, 90), (110, 90), (210, 90), (160, 59), (160, 120), (108, 58), (211, 121)] {
        near(px(&img, 320, x, y), [255, 255, 255, 255], 1, &format!("on the stroke at {x},{y}"));
    }
    for (x, y) in [(106, 90), (214, 90), (160, 56), (160, 124), (5, 5), (300, 170)] {
        near(px(&img, 320, x, y), [0, 0, 0, 255], 1, &format!("outside at {x},{y}"));
    }
}

#[test]
fn korean_text_inks_its_box() {
    let text = json!({ "id": "t", "kind": "text", "text": "안녕하세요", "font": "Malgun Gothic", "fontSize": 40, "weight": 700, "fill": "#ffffff" });
    let p = project_with(graphic_clip(&[text]));
    let mut e = Engine::headless().expect("a GPU");
    let img = shot(&mut e, &p, 0, "graphic-korean.png");
    let ink: Vec<(u32, u32)> =
        (0..180).flat_map(|y| (0..320).map(move |x| (x, y))).filter(|&(x, y)| px(&img, 320, x, y)[0] > 128).collect();
    let (x0, x1) = (ink.iter().map(|p| p.0).min().unwrap_or(0), ink.iter().map(|p| p.0).max().unwrap_or(0));
    let (y0, y1) = (ink.iter().map(|p| p.1).min().unwrap_or(0), ink.iter().map(|p| p.1).max().unwrap_or(0));
    eprintln!("ink: {} pixels in x {x0}..{x1}, y {y0}..{y1}", ink.len());
    // five syllables of about one em each, 40 px, centred on the frame's middle
    assert!(ink.len() > 1500, "the text is drawn ({} pixels)", ink.len());
    assert!(x0 >= 50 && x1 <= 270 && y0 >= 62 && y1 <= 118, "the ink stays in its box");
    assert!(x1 - x0 >= 160 && y1 - y0 >= 25, "the ink fills its box");
    assert!((i64::from(x0 + x1) - 320).abs() <= 6 && (i64::from(y0 + y1) - 180).abs() <= 8, "the line is centred");
}

/// The W3C separable blend functions (Compositing and Blending Level 1) and `lighter`, on 0..1 values.
fn w3c(mode: &str, b: f64, s: f64) -> f64 {
    let hard = |b: f64, s: f64| {
        if s <= 0.5 {
            b * 2.0 * s
        } else {
            let s = 2.0 * s - 1.0;
            b + s - b * s
        }
    };
    match mode {
        "multiply" => b * s,
        "screen" => b + s - b * s,
        "overlay" => hard(s, b),
        "darken" => b.min(s),
        "lighten" => b.max(s),
        "add" => (b + s).min(1.0),
        _ => s,
    }
}

#[test]
fn blend_modes_follow_the_w3c_formulas() {
    let (a, b) = ([0x80u8, 0xc0, 0xff], [0xffu8, 0x80, 0x40]);
    let hexs = |c: [u8; 3]| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]);
    let mut text = TextRenderer::new();
    for mode in ["normal", "add", "screen", "multiply", "overlay", "lighten", "darken"] {
        let layers = [
            json!({ "id": "a", "kind": "rect", "size": [120, 80], "position": [-30, 0], "fill": hexs(a) }),
            json!({ "id": "b", "kind": "rect", "size": [120, 80], "position": [30, 0], "fill": hexs(b), "blend": mode }),
        ];
        let c = graphic_clip(&layers);
        let img = Graphic::new(&c, 0.0, 320.0, 180.0).draw(&mut text, 320, 180);
        if mode == "multiply" {
            write_png("graphic-multiply.png", &img, 320, 180);
        }
        let want: Vec<u8> = (0..3)
            .map(|k| (w3c(mode, f64::from(a[k]) / 255.0, f64::from(b[k]) / 255.0) * 255.0).round() as u8)
            .collect();
        near(px(&img, 320, 160, 90), [want[0], want[1], want[2], 255], 1, &format!("{mode}: the overlap"));
        near(px(&img, 320, 80, 90), [a[0], a[1], a[2], 255], 0, &format!("{mode}: the bottom layer alone"));
        near(px(&img, 320, 240, 90), [b[0], b[1], b[2], 255], 1, &format!("{mode}: the top layer over nothing"));
        near(px(&img, 320, 160, 20), [0, 0, 0, 0], 0, &format!("{mode}: nothing"));
    }
    // and through the engine: the multiplied overlap reaches the screen as it was drawn
    let layers = [
        json!({ "id": "a", "kind": "rect", "size": [120, 80], "position": [-30, 0], "fill": hexs(a) }),
        json!({ "id": "b", "kind": "rect", "size": [120, 80], "position": [30, 0], "fill": hexs(b), "blend": "multiply" }),
    ];
    let p = project_with(graphic_clip(&layers));
    let mut e = Engine::headless().expect("a GPU");
    let img = shot(&mut e, &p, 0, "graphic-multiply-engine.png");
    near(px(&img, 320, 160, 90), [128, 96, 64, 255], 1, "the product of #80c0ff and #ff8040");
}

#[test]
fn keyframed_opacity_and_position_at_two_times() {
    let mut c = graphic_clip(&[json!({ "id": "r", "kind": "rect", "size": [40, 40], "fill": "#ffffff" })]);
    c.keyframes.insert("layers.r.opacity".into(), vec![kf(0, Value::Num(100.0)), kf(SEC, Value::Num(0.0))]);
    c.keyframes.insert(
        "layers.r.position".into(),
        vec![kf(0, Value::List(vec![-100.0, 0.0])), kf(SEC, Value::List(vec![100.0, 0.0]))],
    );
    let mut text = TextRenderer::new();
    let at = |text: &mut TextRenderer, t: i64| Graphic::new(&c, t as f64, 320.0, 180.0).draw(text, 320, 180);
    let start = at(&mut text, 0);
    let half = at(&mut text, SEC / 2);
    write_png("graphic-keyframes-0s.png", &start, 320, 180);
    write_png("graphic-keyframes-half.png", &half, 320, 180);
    near(px(&start, 320, 60, 90), [255, 255, 255, 255], 0, "at 0 s: opaque at x -100");
    near(px(&start, 320, 160, 90), [0, 0, 0, 0], 0, "at 0 s: nothing in the middle");
    near(px(&half, 320, 160, 90), [255, 255, 255, 128], 1, "at 0.5 s: half opaque in the middle");
    near(px(&half, 320, 60, 90), [0, 0, 0, 0], 0, "at 0.5 s: gone from x -100");

    let p = project_with(c);
    let mut e = Engine::headless().expect("a GPU");
    let img = shot(&mut e, &p, 0, "graphic-keyframes-engine-0s.png");
    near(px(&img, 320, 60, 90), [255, 255, 255, 255], 1, "the engine at 0 s");
    let img = shot(&mut e, &p, SEC / 2, "graphic-keyframes-engine-half.png");
    let mid = px(&img, 320, 160, 90);
    assert!(
        mid[0] > 100 && mid[0] < 220 && mid[0] == mid[1] && mid[1] == mid[2],
        "the engine at 0.5 s: grey ({mid:?})"
    );
    near(px(&img, 320, 60, 90), [0, 0, 0, 255], 1, "the engine at 0.5 s: black at x -100");
}

#[test]
fn every_kind_draws_and_nothing_panics() {
    let mut r = Inputs::new(0x51ab);
    let mut text = TextRenderer::new();
    let mut lit = 0;
    for i in 0..60 {
        let layers: Vec<Json> = (0..r.range(1, 6)).map(|k| random_layer(&mut r, &format!("l{k}"))).collect();
        let mut layers = layers;
        for l in &mut layers {
            let o = l.as_object_mut().expect("an object");
            o.insert(
                "blend".into(),
                json!(r.pick(&["normal", "add", "screen", "multiply", "overlay", "lighten", "darken"])),
            );
            if r.range(0, 3) == 0 && o["kind"] != "particles" {
                o.insert("shadowColor".into(), json!("#000000aa"));
                o.insert("shadowBlur".into(), json!(f(&mut r, 0.0, 20.0)));
                o.insert("shadowOffset".into(), json!([f(&mut r, -10.0, 10.0), 4.5]));
                o.insert("blur".into(), json!(f(&mut r, 0.0, 6.0) * r.range(0, 1) as f64));
            }
            if r.range(0, 3) == 0 && o["kind"] != "particles" && o["kind"] != "line" {
                o.insert("gradient".into(), json!({ "type": r.pick(&["linear", "radial"]), "from": [-100, 0], "to": [100, 50], "stops": [[0, "#ff0000"], [1, "#0000ff80"]] }));
            }
            o.insert("repeatCount".into(), json!(r.range(1, 4)));
            o.insert("repeatOffset".into(), json!([20, 10]));
        }
        let mut c = graphic_clip(&layers);
        c.keyframes = random_keyframes(&mut r, &layers[0]);
        let img = Graphic::new(&c, f(&mut r, 0.0, 2.0) * SEC as f64, 640.0, 360.0).draw(&mut text, 160 + i, 90);
        assert_eq!(img.len(), ((160 + i) * 90 * 4) as usize);
        lit += usize::from(img.chunks(4).any(|p| p[3] > 0));
    }
    assert!(lit > 40, "most random graphics draw something ({lit} of 60)");
}

#[test]
fn a_typical_graphic_as_a_picture() {
    let layers = typical();
    let c = graphic_clip(&layers);
    let mut text = TextRenderer::new();
    let img = Graphic::new(&c, 0.8 * SEC as f64, 1280.0, 720.0).draw(&mut text, 1280, 720);
    let path = write_png("graphic-typical.png", &img, 1280, 720);
    eprintln!("{}", path.display());
    assert!(img.chunks(4).filter(|p| p[3] > 0).count() > 50_000, "it draws");
}

/// A lower third with a chart: what an AI or a person writes (the layers of verify/cut-control-core.mjs's graphic,
/// with a shadow, a gradient and a blend).
fn typical() -> Vec<Json> {
    vec![
        json!({ "id": "bg", "kind": "rect", "size": [900, 180], "radius": 24, "position": [0, 220], "gradient": { "type": "linear", "from": [-450, 0], "to": [450, 0], "stops": [[0, "#102040ee"], [1, "#3050a0cc"]] }, "shadowColor": "#00000099", "shadowBlur": 20, "shadowOffset": [0, 8] }),
        json!({ "id": "grp", "kind": "group", "position": [-300, -60] }),
        json!({ "id": "bar", "kind": "rect", "parent": "grp", "size": [80, 200], "fill": "#ff8800", "anchor": [0, 100], "repeatCount": 4, "repeatOffset": [110, 0], "repeatScale": [100, 80], "radius": 8 }),
        json!({ "id": "wave", "kind": "path", "d": "M -250 0 C -150 -80 -50 80 50 0 S 200 -60 250 0", "stroke": "#ffffff", "strokeWidth": 6, "trimEnd": 70, "position": [250, -80] }),
        json!({ "id": "num", "kind": "text", "text": "매출 {value}%", "value": 1234.5, "decimals": 1, "fontSize": 64, "position": [0, 220], "stroke": "#000000", "strokeWidth": 3 }),
        json!({ "id": "spark", "kind": "particles", "count": 60, "emitter": [600, 0], "direction": 180, "spread": 30, "speed": 120, "gravity": [0, 80], "life": 1.5, "fill": "#ffee88", "fillEnd": "#ff4400", "blend": "add" }),
        json!({ "id": "star", "kind": "star", "points": 5, "radius": 60, "innerRadius": 26, "fill": "#ffd700", "position": [420, -200], "rotation": 12, "stroke": "#ffffff", "strokeWidth": 4, "join": "miter", "blend": "screen" }),
    ]
}

/// Run with `cargo test --release -p cut-engine --test graphic -- --ignored --nocapture`.
#[test]
#[ignore]
fn bench_a_typical_graphic() {
    let layers = typical();
    let c = graphic_clip(&layers);
    let mut text = TextRenderer::new();
    text.warm();
    for (w, h) in [(1920u32, 1080u32), (960, 540)] {
        let g = Graphic::new(&c, 0.8 * SEC as f64, 1920.0, 1080.0);
        let _ = g.draw(&mut text, w, h);
        let mut times: Vec<f64> = (0..30)
            .map(|_| {
                let t0 = Instant::now();
                std::hint::black_box(g.draw(&mut text, w, h));
                t0.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        times.sort_by(f64::total_cmp);
        eprintln!("draw {w}x{h}: {:.2} ms fastest, {:.2} ms median of 30", times[0], times[15]);
    }
    let n = 200;
    let t0 = Instant::now();
    for i in 0..n {
        let g = Graphic::new(&c, f64::from(i), 1920.0, 1080.0);
        std::hint::black_box(g.signature());
    }
    eprintln!("resolve + signature: {:.3} ms a frame", t0.elapsed().as_secs_f64() * 1000.0 / f64::from(n));
    let js = ask_scenario_cjs("graphic", &[json!(["drawMs", layers, 0.8, 200])]);
    eprintln!(
        "graphic.js draw on a recording context (geometry only, no rasteriser): {:.3} ms a frame",
        js[0].as_f64().unwrap_or(f64::NAN)
    );
}
