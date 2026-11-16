//! `cut_model::masks` against `renderer/features/cut/masks.js` (through `tools/scenarios/masks.cjs`) on the same
//! inputs, and the plain-Node cases of `verify/cut-mask-core.mjs`.

use cut_model::keyframes::Keyframe;
use cut_model::masks::*;
use cut_oracle::{Inputs, ask};
use serde_json::{Value as Json, json};

const ORACLE: &str = "scenario/masks";

/// A number of the oracle's answer: the scenario sends each as `{ "$n": String(x) }`, parsed here exactly (std's
/// parser rounds correctly; serde_json's default one can land an ulp off).
fn num(v: &Json) -> Option<f64> {
    v.get("$n")?.as_str()?.parse().ok()
}

/// Equal as the JavaScript sees JSON: numbers by value, bit for bit (10 and 10.0 alike), every other value exactly.
/// `ours` is the Rust value, `theirs` the oracle's answer.
fn same(ours: &Json, theirs: &Json) -> bool {
    match (ours, theirs) {
        (Json::Number(x), t) => x.as_f64().is_some() && x.as_f64() == num(t),
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => ours == theirs,
    }
}

/// Asks the oracle and compares each answer with ours; returns how many were compared.
fn compare(calls: &[Json], ours: &[Json]) -> usize {
    assert_eq!(calls.len(), ours.len());
    let theirs = ask(ORACLE, calls);
    let bad: Vec<String> = calls
        .iter()
        .zip(ours.iter().zip(&theirs))
        .filter(|(_, (o, t))| !same(o, t))
        .take(5)
        .map(|(c, (o, t))| format!("{}\n  rust {}\n  js   {}", trunc(c), trunc(o), trunc(t)))
        .collect();
    assert!(bad.is_empty(), "differs from masks.js:\n{}", bad.join("\n"));
    println!("{} oracle comparisons", calls.len());
    calls.len()
}

fn trunc(v: &Json) -> String {
    let s = v.to_string();
    if s.len() > 600 { format!("{}...", &s[..600]) } else { s }
}

fn f(rng: &mut Inputs, lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * (rng.next_u64() >> 11) as f64 / (1_u64 << 53) as f64
}

/// A path of `n` vertices around (0.5, 0.5): corners, smooth points, broken handles and one-handle points mixed.
fn random_path(rng: &mut Inputs, n: usize, spread: f64) -> Vec<f64> {
    let mut p = Vec::with_capacity(n * 6);
    for i in 0..n {
        let a = std::f64::consts::TAU * i as f64 / n as f64 + f(rng, -0.3, 0.3);
        let r = spread * f(rng, 0.3, 1.0);
        let (x, y) = (0.5 + r * a.cos(), 0.5 + r * a.sin());
        let hs = spread * 0.4;
        let (hx, hy) = (f(rng, -hs, hs), f(rng, -hs, hs));
        let handles = match rng.range(0, 4) {
            0 => [0.0; 4],
            1 => [-hx, -hy, hx, hy],
            2 => [hx, hy, f(rng, -hs, hs), f(rng, -hs, hs)],
            3 => [0.0, 0.0, hx, hy],
            _ => [hx, hy, 0.0, 0.0],
        };
        p.extend([x, y]);
        p.extend(handles);
    }
    p
}

/// Paths that matter: random ones, the button shapes, and the degenerate ones (a point, a line, a bowtie, tiny, at
/// the ±100 limit, repeated vertices).
fn paths(rng: &mut Inputs) -> Vec<Vec<f64>> {
    let corner = |pts: &[[f64; 2]]| pts.iter().flat_map(|[x, y]| [*x, *y, 0.0, 0.0, 0.0, 0.0]).collect::<Vec<_>>();
    let mut out = vec![
        ellipse(200.0, 100.0, Place::default()),
        polygon(200.0, 100.0, Place::default()),
        ellipse(1920.0, 1080.0, Place { cx: 0.1, cy: 0.9, size: Some(700.0) }),
        corner(&[[0.3, 0.3], [0.3, 0.3], [0.3, 0.3]]),
        corner(&[[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]),
        corner(&[[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]]),
        corner(&[[0.5, 0.5], [0.5 + 1e-9, 0.5], [0.5, 0.5 + 1e-9]]),
        corner(&[[-100.0, -100.0], [100.0, -100.0], [100.0, 100.0], [-100.0, 100.0]]),
        corner(&[[0.2, 0.2], [0.8, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]),
        from_points(&[
            PenPoint { x: 0.1, y: 0.1, ..Default::default() },
            PenPoint { x: 0.6, y: 0.1, ..Default::default() },
            PenPoint { x: 0.1, y: 0.9, ..Default::default() },
        ]),
    ];
    for _ in 0..24 {
        let n = rng.range(3, 14) as usize;
        let spread = rng.pick(&[0.05, 0.3, 0.45, 0.9]);
        out.push(random_path(rng, n, spread));
    }
    out
}

fn mask_json(
    id: &str,
    mode: MaskMode,
    inverted: bool,
    path: &[f64],
    feather: f64,
    opacity: f64,
    expansion: f64,
) -> Mask {
    Mask { id: id.into(), mode, inverted, path: path.to_vec(), feather, opacity, expansion }
}

fn random_masks(rng: &mut Inputs, all: &[Vec<f64>]) -> Vec<Mask> {
    let n = rng.range(1, 4) as usize;
    (0..n)
        .map(|i| {
            let path = &all[rng.range(0, all.len() as i64 - 1) as usize];
            let feather = rng.pick(&[0.0, 0.5, 1.0, 10.0, 37.5, 1000.0]);
            let expansion = rng.pick(&[0.0, 3.0, -4.5, 2000.0, -2000.0, 12.25]);
            let opacity = rng.pick(&[100.0, 0.0, 40.0, 73.3]);
            mask_json(&format!("m{}", i + 1), rng.pick(&MODES), rng.range(0, 2) == 0, path, feather, opacity, expansion)
        })
        .collect()
}

fn pts_json(pts: &[[f64; 2]]) -> Json {
    json!(pts)
}

#[test]
fn constants_match_the_javascript() {
    let ours = json!({
        "MODES": MODES, "FIELDS": FIELDS, "DEFAULTS": DEFAULTS, "RANGES": RANGES, "MAX_MASKS": MAX_MASKS,
        "MAX_POINTS": MAX_POINTS, "MIN_POINTS": MIN_POINTS, "FLATTEN": FLATTEN, "KAPPA": KAPPA, "SIGMA": SIGMA, "WGSL": WGSL,
    });
    compare(&[json!(["constants"])], &[ours]);
}

/// Masks as a damaged or hand-written file may hold them.
fn malformed(rng: &mut Inputs) -> Vec<Json> {
    let good = json!({ "id": "m1", "mode": "add", "inverted": false, "path": polygon(16.0, 9.0, Place::default()), "feather": 10, "opacity": 100, "expansion": 0 });
    let mut out = vec![good.clone(), json!(null), json!(3), json!("m1"), json!([good.clone()]), json!({}), json!(true)];
    let bad_values: Vec<(&str, Vec<Json>)> = vec![
        (
            "id",
            vec![
                json!("m"),
                json!("m01"),
                json!("m1a"),
                json!("M1"),
                json!(" m1"),
                json!("m1\n"),
                json!("m١"),
                json!(1),
                json!([1, [2, 3], null]),
                json!({}),
                json!(true),
                json!(null),
                json!(1e21),
                json!(1.5e-7),
                json!(0.000001),
                json!(-0.0),
                json!(123456789.125),
                json!(-2.5e-12),
                json!([]),
                json!(["m1"]),
            ],
        ),
        (
            "mode",
            vec![
                json!("Add"),
                json!("lighten"),
                json!(null),
                json!(3),
                json!(["add"]),
                json!(""),
                json!("none"),
                json!("difference"),
            ],
        ),
        ("inverted", vec![json!(0), json!("true"), json!(null), json!(true)]),
        (
            "path",
            vec![
                json!(vec![0.1; 17]),
                json!(vec![0.1; 12]),
                json!(vec![0.1; 6 * 257]),
                json!(vec![0.1; 6 * 256]),
                json!([0.1, 0.1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 100.0001, 0, 0, 0, 0, 0]),
                json!([-100, 100, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]),
                json!([0.1, null, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]),
                json!("0.1"),
                json!({ "0": 1 }),
                json!(null),
                json!([]),
            ],
        ),
        ("feather", vec![json!(-1), json!(1000), json!(1000.0001), json!("10"), json!(null), json!(0), json!(-0.0)]),
        ("opacity", vec![json!(100.5), json!(-1e-9), json!(50), json!([50])]),
        ("expansion", vec![json!(-2000), json!(2000), json!(-2000.5), json!(true)]),
    ];
    for (field, values) in &bad_values {
        for v in values {
            let mut m = good.clone();
            m[*field] = v.clone();
            out.push(m);
        }
        let mut m = good.clone();
        m.as_object_mut().expect("an object").remove(*field);
        out.push(m);
    }
    for _ in 0..40 {
        let mut m = good.clone();
        let o = m.as_object_mut().expect("an object");
        for f in ["id", "mode", "inverted", "path", "feather", "opacity", "expansion"] {
            match rng.range(0, 5) {
                0 => {
                    o.remove(f);
                }
                1 => {
                    o.insert(f.into(), json!(null));
                }
                2 => {
                    let (field, values) = &bad_values[rng.range(0, bad_values.len() as i64 - 1) as usize];
                    o.insert((*field).into(), values[rng.range(0, values.len() as i64 - 1) as usize].clone());
                }
                _ => {}
            }
        }
        o.insert("extra".into(), json!(rng.range(0, 9)));
        out.push(m);
    }
    out
}

#[test]
fn validation_matches_the_javascript() {
    let mut rng = Inputs::new(11);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for m in malformed(&mut rng) {
        calls.push(json!(["problem", m]));
        ours.push(json!(problem(&m)));
        calls.push(json!(["valid", m]));
        ours.push(json!(valid(&m)));
        calls.push(json!(["full", m]));
        ours.push(json!(full(&m)));
        for field in ["path", "feather", "opacity", "expansion", "mode", "inverted", "toString", "__proto__"] {
            let v = m.get(field).cloned().unwrap_or(json!(null));
            calls.push(json!(["validField", field, v]));
            ours.push(json!(valid_field(field, &v)));
        }
        if let Some(Ok(p)) = m.get("path").map(|p| serde_json::from_value::<Vec<f64>>(p.clone())) {
            calls.push(json!(["validPath", p]));
            ours.push(json!(valid_path(&p)));
            calls.push(json!(["count", p]));
            ours.push(json!(count(&p)));
        }
    }
    for p in paths(&mut rng) {
        calls.push(json!(["validPath", p]));
        ours.push(json!(valid_path(&p)));
    }
    for prop in [
        "masks.m1.path",
        "masks.m1.inverted",
        "masks.m1.mode",
        "effects.e1.masks.m2.mode",
        "effects.e1.masks.m2.path",
        "masks..feather",
        "masks.m1",
        "masks.m1.path.x",
        "effects.e1.mask.m2.path",
        "effects..masks..opacity",
        "",
        "masks.m1.expansion",
        "effects.e1.masks.m2.inverted",
    ] {
        for all in [false, true] {
            calls.push(json!(["parsePath", prop, all]));
            ours.push(json!(parse_path(prop, all)));
        }
    }
    for e in [None, Some("e1"), Some("")] {
        calls.push(json!(["prefixOf", e]));
        ours.push(json!(prefix_of(e)));
    }
    compare(&calls, &ours);
}

#[test]
fn shapes_and_geometry_match_the_javascript() {
    let mut rng = Inputs::new(12);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let sizes = [(200.0, 100.0), (1920.0, 1080.0), (1.0, 1.0), (33.0, 77.0), (0.0, 50.0)];
    for (w, h) in sizes {
        for (opts, place) in [
            (json!({}), Place::default()),
            (json!({ "cx": 0.2, "cy": 0.7, "r": 13.5, "s": 13.5 }), Place { cx: 0.2, cy: 0.7, size: Some(13.5) }),
        ] {
            calls.push(json!(["ellipse", w, h, opts]));
            ours.push(json!(ellipse(w, h, place)));
            calls.push(json!(["polygon", w, h, opts]));
            ours.push(json!(polygon(w, h, place)));
        }
    }
    for _ in 0..10 {
        let n = rng.range(0, 6);
        let (mut js, mut pts) = (Vec::new(), Vec::new());
        for _ in 0..n {
            let p = PenPoint {
                x: f(&mut rng, 0.0, 1.0),
                y: f(&mut rng, 0.0, 1.0),
                hx: rng.pick(&[0.0, 0.1, -0.25]),
                hy: rng.pick(&[0.0, 0.05]),
            };
            js.push(if p.hx == 0.0 && p.hy == 0.0 { json!({ "x": p.x, "y": p.y }) } else { json!(p) });
            pts.push(p);
        }
        calls.push(json!(["fromPoints", js]));
        ours.push(json!(from_points(&pts)));
    }
    let mut all = paths(&mut rng);
    all.extend([vec![], vec![0.5; 6], vec![0.5; 12], (0..20).map(|k| k as f64 / 20.0).collect()]);
    for p in &all {
        let n = count(p) as i64;
        for (w, h) in sizes {
            calls.push(json!(["flatten", p, w, h]));
            let pts = flatten(p, w, h);
            ours.push(pts_json(&pts));
            calls.push(json!(["topPoint", p, w, h]));
            ours.push(json!(top_point(p, w, h)));
            for d in [0.0, 5.0, -3.0, 40.0] {
                calls.push(json!(["outline", p, w, h, d]));
                ours.push(pts_json(&outline(p, w, h, d)));
            }
            for _ in 0..6 {
                let (x, y) = (f(&mut rng, -0.2, 1.2) * w, f(&mut rng, -0.2, 1.2) * h);
                calls.push(json!(["signedDistance", pts_json(&pts), x, y]));
                ours.push(json!(signed_distance(&pts, x, y)));
                calls.push(json!(["contains", p, w, h, x, y]));
                ours.push(json!(contains(p, w, h, x, y)));
                let v = nearest_vertex(p, w, h, x, y);
                calls.push(json!(["nearestVertex", p, w, h, x, y]));
                ours.push(json!({ "index": v.index.map_or(-1, |i| i as i64), "distance": v.distance }));
                let e = nearest_edge(p, w, h, x, y);
                calls.push(json!(["nearestEdge", p, w, h, x, y]));
                ours.push(json!({ "index": e.index.map_or(-1, |i| i as i64), "t": e.t, "distance": e.distance }));
            }
        }
        for i in [-7, -1, 0, 1, n - 1, n, n + 5] {
            calls.push(json!(["vertex", p, i, 200, 100]));
            ours.push(json!(vertex(p, i, 200.0, 100.0)));
            let e = edge(p, i, 200.0, 100.0);
            calls.push(json!(["edge", p, i, 200, 100]));
            ours.push(json!(e));
            // A path with no vertex has a NaN edge, which JSON can only send as nulls (0 to the JavaScript).
            for t in [0.0, 0.25, 1.0 / 3.0, 1.0, f(&mut rng, 0.0, 1.0)].into_iter().filter(|_| n > 0) {
                calls.push(json!(["cubic", e, t]));
                ours.push(json!(cubic(&e, t)));
            }
        }
        for i in [0, 1, (n.max(1) - 1) as usize, n as usize + 2] {
            calls.push(json!(["isCorner", p, i]));
            ours.push(json!(is_corner(p, i)));
        }
    }
    compare(&calls, &ours);
}

fn widen(v: &[f32]) -> Vec<f64> {
    v.iter().map(|x| f64::from(*x)).collect()
}

fn image(rng: &mut Inputs, w: usize, h: usize) -> Image {
    Image { w, h, data: (0..w * h * 4).map(|_| f(rng, -0.5, 2.0) as f32).collect() }
}

fn image_json(img: &Image) -> Json {
    json!({ "w": img.w, "h": img.h, "data": widen(&img.data) })
}

#[test]
fn coverage_matches_the_javascript() {
    let mut rng = Inputs::new(13);
    let all = paths(&mut rng);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let mut lists: Vec<Vec<Mask>> = (0..60).map(|_| random_masks(&mut rng, &all)).collect();
    lists.push(vec![]);
    lists.push(vec![mask_json("m1", MaskMode::None, false, &all[0], 10.0, 100.0, 0.0)]);
    for mode in MODES {
        for inverted in [false, true] {
            lists.push(vec![
                mask_json("m1", MaskMode::Add, false, &all[1], 0.0, 100.0, 0.0),
                mask_json("m2", mode, inverted, &all[0], 6.0, 60.0, 2.0),
            ]);
            lists.push(vec![mask_json("m1", mode, inverted, &all[2], 0.0, 100.0, -7.0)]);
        }
    }
    for masks in &lists {
        let (w, h) = (rng.range(1, 48) as usize, rng.range(1, 32) as usize);
        let px = rng.pick(&[1.0, 0.5, 2.25, 0.0]);
        let (wf, hf) = (w as f64, h as f64);
        calls.push(json!(["prepare", masks, wf, hf, px]));
        let prepared = prepare(masks, wf, hf, px);
        ours.push(json!(prepared));
        let points: Vec<[f64; 2]> =
            (0..20).map(|_| [f(&mut rng, -0.3, 1.3) * wf, f(&mut rng, -0.3, 1.3) * hf]).collect();
        calls.push(json!(["coverageAt", masks, wf, hf, px, points]));
        ours.push(json!(points.iter().map(|[x, y]| coverage_at(&prepared, *x, *y)).collect::<Vec<_>>()));
        calls.push(json!(["coverage", masks, w, h, px]));
        ours.push(json!(widen(&coverage(masks, w, h, px))));
        calls.push(json!(["gpuData", masks, wf, hf, px]));
        ours.push(json!(widen(&gpu_data(masks, wf, hf, px))));
        let (base, fx) = (image(&mut rng, w, h), image(&mut rng, w, h));
        calls.push(json!(["cutCpu", image_json(&base), masks, px]));
        ours.push(image_json(&cut_cpu(&base, masks, px)));
        calls.push(json!(["mixCpu", image_json(&base), image_json(&fx), masks, px]));
        ours.push(image_json(&mix_cpu(&base, &fx, masks, px)));
    }
    // Larger pictures with thin feathers, where coverage leaves out the segments far from a row.
    for _ in 0..12 {
        let mut masks = random_masks(&mut rng, &all);
        for m in &mut masks {
            m.feather = rng.pick(&[0.0, 1.0, 2.5]);
            m.expansion = rng.pick(&[0.0, 1.5, -3.0]);
        }
        let (w, h) = (rng.range(120, 200) as usize, rng.range(60, 110) as usize);
        calls.push(json!(["coverage", masks, w, h, 1.0]));
        ours.push(json!(widen(&coverage(&masks, w, h, 1.0))));
    }
    compare(&calls, &ours);
}

#[test]
fn edits_match_the_javascript() {
    let mut rng = Inputs::new(14);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let sizes = [(200.0, 100.0), (1920.0, 1080.0), (0.0, 0.0)];
    let mut all = paths(&mut rng);
    all.extend([vec![], vec![0.5; 6]]);
    for p in &all {
        let n = count(p);
        let (du, dv) = (f(&mut rng, -0.5, 0.5), f(&mut rng, -0.5, 0.5));
        calls.push(json!(["translate", p, du, dv]));
        ours.push(json!(translate(p, du, dv)));
        calls.push(json!(["removeVertex", p, n / 2]));
        ours.push(json!(remove_vertex(p, n / 2)));
        calls.push(json!(["removeVertex", p, n + 1]));
        ours.push(json!(remove_vertex(p, n + 1)));
        for e in [-4, -1, 0, 1, n as i64 - 1, n as i64 + 2] {
            for t in [0.0, 0.3, 0.5, 1.0, f(&mut rng, 0.0, 1.0)] {
                calls.push(json!(["insertVertex", p, e, t]));
                ours.push(json!(insert_vertex(p, e, t)));
            }
        }
        for i in [0, n / 2, n.max(1) - 1, n, n + 2] {
            calls.push(json!(["moveVertex", p, i, du, dv]));
            ours.push(json!(move_vertex(p, i, du, dv)));
            for (w, h) in sizes {
                calls.push(json!(["toggleSmooth", p, i, w, h]));
                ours.push(json!(toggle_smooth(p, i, w, h)));
                for which in [Handle::In, Handle::Out] {
                    for to in [[f(&mut rng, -0.2, 0.2), f(&mut rng, -0.2, 0.2)], [0.0, 0.0], [1e-12, 0.0]] {
                        for broken in [false, true] {
                            calls.push(json!(["setHandle", p, i, which, to[0], to[1], w, h, { "broken": broken }]));
                            ours.push(json!(set_handle(p, i, which, to, w, h, broken)));
                        }
                    }
                }
            }
        }
    }
    let list: Vec<Keyframe> = serde_json::from_value(json!([
        { "t": 0, "v": all[0], "ease": "linear" },
        { "t": 141120000, "v": all[1], "ease": "easeIn", "h": [0.3, 0.1, 0.7, 0.9] },
        { "t": 282240000, "v": [0.1, 0.2], "ease": "hold" },
        { "t": 300000000, "v": 4, "ease": "linear" },
        { "t": 400000000, "v": "x", "ease": "bezier" },
        { "t": 500000000, "v": all[12], "ease": "easeOut" },
    ]))
    .expect("keyframes");
    let kf = |l: Vec<Keyframe>| serde_json::to_value(l).expect("keyframes serialize");
    calls.push(json!(["mapKeyframes", list, "insert", 0, 0.5]));
    ours.push(kf(map_keyframes(&list, |p| insert_vertex(p, 0, 0.5))));
    calls.push(json!(["mapKeyframes", list, "remove", 1]));
    ours.push(kf(map_keyframes(&list, |p| remove_vertex(p, 1))));
    calls.push(json!(["mapKeyframes", list, "translate", 0.1, -0.2]));
    ours.push(kf(map_keyframes(&list, |p| translate(p, 0.1, -0.2))));
    calls.push(json!(["mapKeyframes", [], "remove", 1]));
    ours.push(kf(map_keyframes(&[], |p| remove_vertex(p, 1))));
    compare(&calls, &ours);
}

#[test]
fn truncated_and_non_finite_paths_do_not_panic() {
    let mut rng = Inputs::new(15);
    let odd = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -0.0, 1e300, -1e-300];
    for _ in 0..400 {
        let len = rng.range(0, 40) as usize;
        let path: Vec<f64> =
            (0..len).map(|_| if rng.range(0, 5) == 0 { rng.pick(&odd) } else { f(&mut rng, -2.0, 2.0) }).collect();
        let (w, h) = (rng.pick(&[0.0, 1.0, 64.0, f64::NAN]), rng.pick(&[0.0, 1.0, 48.0, f64::INFINITY]));
        let i = rng.range(0, 9) as usize;
        let (x, y) = (f(&mut rng, -10.0, 70.0), f(&mut rng, -10.0, 50.0));
        let m = mask_json(
            "m1",
            rng.pick(&MODES),
            rng.range(0, 1) == 0,
            &path,
            rng.pick(&odd),
            rng.pick(&odd),
            rng.pick(&odd),
        );
        let _ =
            (count(&path), valid_path(&path), flatten(&path, w, h), outline(&path, w, h, 3.0), top_point(&path, w, h));
        let _ = (contains(&path, w, h, x, y), nearest_vertex(&path, w, h, x, y), nearest_edge(&path, w, h, x, y));
        let _ = (vertex(&path, i as i64 - 4, w, h), is_corner(&path, i), translate(&path, 0.1, 0.1));
        let _ = (move_vertex(&path, i, 0.1, 0.1), set_handle(&path, i, Handle::In, [0.1, 0.0], w, h, false));
        let _ = (toggle_smooth(&path, i, w, h), insert_vertex(&path, i as i64 - 4, 0.5), remove_vertex(&path, i));
        let _ = (coverage(std::slice::from_ref(&m), 9, 7, 1.0), gpu_data(std::slice::from_ref(&m), w, h, 1.0));
        let img = Image { w: 9, h: 7, data: vec![0.5; rng.range(0, 300) as usize] };
        let _ = (cut_cpu(&img, std::slice::from_ref(&m), 1.0), mix_cpu(&img, &img, &[m], 1.0));
        let _ = problem(
            &json!({ "id": "m1", "path": path.iter().map(|v| if v.is_finite() { json!(v) } else { json!(null) }).collect::<Vec<_>>() }),
        );
    }
}

// ---- the plain-Node cases of verify/cut-mask-core.mjs --------------------------------------------------------------

fn near(a: f64, b: f64, eps: f64) -> bool {
    (a - b).abs() <= eps
}

fn smooth(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn mask(path: Vec<f64>, feather: f64) -> Mask {
    Mask { id: "m1".into(), mode: MaskMode::Add, inverted: false, path, feather, opacity: 100.0, expansion: 0.0 }
}

fn cov_at(masks: &[Mask], w: usize, h: usize, x: usize, y: usize) -> f64 {
    f64::from(coverage(masks, w, h, 1.0)[y * w + x])
}

const W: usize = 200;
const H: usize = 100;
const WF: f64 = 200.0;
const HF: f64 = 100.0;

/// The exact coverage of the square (75, 25)..(125, 75) at a pixel, feather `feather`.
fn square(x: usize, y: usize, feather: f64) -> f64 {
    let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
    let inside = cx > 75.0 && cx < 125.0 && cy > 25.0 && cy < 75.0;
    let d = if inside {
        (cx - 75.0).min(125.0 - cx).min(cy - 25.0).min(75.0 - cy)
    } else {
        (75.0 - cx).max(0.0).max(cx - 125.0).hypot((25.0 - cy).max(0.0).max(cy - 75.0))
    };
    smooth(-feather / 2.0, feather / 2.0, if inside { d } else { -d })
}

#[test]
fn shapes_at_chosen_pixels() {
    let e = [mask(ellipse(WF, HF, Place::default()), 20.0)];
    let want = |x: usize, y: usize| smooth(-10.0, 10.0, 25.0 - (x as f64 + 0.5 - 100.0).hypot(y as f64 + 0.5 - 50.0));
    let pts = [(100, 50), (114, 50), (120, 50), (124, 50), (128, 50), (100, 70), (117, 67), (136, 50), (60, 20)];
    let worst = pts.iter().map(|&(x, y)| (cov_at(&e, W, H, x, y) - want(x, y)).abs()).fold(0.0, f64::max);
    assert!(worst < 0.004, "an ellipse mask is the circle it draws ({worst})");
    assert!(
        cov_at(&e, W, H, 100, 50) == 1.0 && cov_at(&e, W, H, 0, 0) == 0.0,
        "an ellipse covers its center and not the corner"
    );
    let hard = [mask(ellipse(WF, HF, Place::default()), 0.0)];
    assert!(
        near(cov_at(&hard, W, H, 124, 50), smooth(-0.5, 0.5, 25.0 - 24.5_f64.hypot(0.5)), 0.03),
        "feather 0 leaves a one-pixel antialiased edge"
    );
    let p = [mask(polygon(WF, HF, Place::default()), 10.0)];
    for (x, y) in [(80, 50), (77, 50), (75, 50), (73, 50), (70, 50), (100, 26), (123, 73), (127, 77), (130, 80)] {
        assert!(
            near(cov_at(&p, W, H, x, y), square(x, y, 10.0), 1e-6),
            "a 4-point polygon mask: exact coverage at ({x}, {y})"
        );
    }
    let pen = |x, y| PenPoint { x, y, ..Default::default() };
    let tri = [mask(from_points(&[pen(0.1, 0.1), pen(0.6, 0.1), pen(0.1, 0.9)]), 0.0)];
    assert!(
        cov_at(&tri, W, H, 30, 30) == 1.0 && cov_at(&tri, W, H, 110, 80) == 0.0 && cov_at(&tri, W, H, 22, 80) > 0.99,
        "a pen triangle covers inside its corners only"
    );

    let path = from_points(&[
        PenPoint { x: 0.2, y: 0.2, hx: 0.15, hy: -0.05 },
        PenPoint { x: 0.8, y: 0.4, hx: 0.0, hy: 0.25 },
        PenPoint { x: 0.3, y: 0.85, hx: -0.2, hy: -0.1 },
    ]);
    let mut curve = Vec::new();
    for i in 0..3 {
        let e = edge(&path, i, WF, HF);
        curve.extend((0..4096).map(|s| cubic(&e, f64::from(s) / 4096.0)));
    }
    let sd = |x: f64, y: f64| {
        let (mut d, mut inside) = (f64::INFINITY, false);
        for i in 0..curve.len() {
            let (a, b) = (curve[(i + curve.len() - 1) % curve.len()], curve[i]);
            d = d.min((b[0] - x).hypot(b[1] - y));
            if (a[1] > y) != (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
        }
        if inside { d } else { -d }
    };
    let bz = [mask(path.clone(), 8.0)];
    let bz_pts = [(100, 40), (150, 40), (158, 45), (162, 55), (90, 80), (60, 76), (40, 20), (100, 60), (170, 70)];
    let worst = bz_pts
        .iter()
        .map(|&(x, y)| (cov_at(&bz, W, H, x, y) - smooth(-4.0, 4.0, sd(x as f64 + 0.5, y as f64 + 0.5))).abs())
        .fold(0.0, f64::max);
    assert!(
        worst < 0.03 && cov_at(&bz, W, H, 100, 60) == 1.0,
        "a bezier mask of smooth points follows its cubics ({worst})"
    );

    let split = [mask(insert_vertex(&path, 1, 0.3), 8.0)];
    let (a1, a2) = (coverage(&bz, W, H, 1.0), coverage(&split, W, H, 1.0));
    let dmax = a1.iter().zip(&a2).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
    assert!(count(&split[0].path) == 4 && dmax < 0.04, "a vertex added on a curve keeps the shape ({dmax})");
    let rounded = toggle_smooth(&polygon(WF, HF, Place::default()), 1, WF, HF);
    assert!(
        !is_corner(&rounded, 1)
            && is_corner(&rounded, 0)
            && toggle_smooth(&rounded, 1, WF, HF) == polygon(WF, HF, Place::default()),
        "Alt+click: a corner becomes smooth, and back"
    );
    let sq = polygon(WF, HF, Place::default());
    assert!(
        count(&remove_vertex(&sq, 2)) == 3 && count(&remove_vertex(&remove_vertex(&sq, 2), 0)) == 3,
        "a vertex goes, but three always stay"
    );
    let hdl = set_handle(&path, 0, Handle::Out, [0.1, 0.05], WF, HF, false);
    let len_in = (path[2] * WF).hypot(path[3] * HF);
    assert!(
        near((hdl[2] * WF).hypot(hdl[3] * HF), len_in, 1e-9)
            && near(hdl[2] * WF * 0.05 * HF, hdl[3] * HF * 0.1 * WF, 1e-9)
            && hdl[2] < 0.0,
        "dragging a handle turns the opposite one"
    );
    assert_eq!(
        set_handle(&path, 0, Handle::Out, [0.1, 0.05], WF, HF, true)[2..4],
        path[2..4],
        "with Alt the handles break apart"
    );
    let moved = [mask(translate(&sq, 0.1, 0.0), 10.0)];
    assert!(
        near(cov_at(&moved, W, H, 100, 50), square(80, 50, 10.0), 1e-6)
            && near(cov_at(&moved, W, H, 97, 50), square(77, 50, 10.0), 1e-6),
        "translate moves the whole mask (20 px right)"
    );
}

#[test]
fn feather_expansion_opacity_inverted_and_modes() {
    let sq = polygon(WF, HF, Place::default());
    let at = |edit: &dyn Fn(&mut Mask), x: usize, y: usize| {
        let mut m = mask(sq.clone(), 0.0);
        edit(&mut m);
        cov_at(&[m], W, H, x, y)
    };
    let grow = |e: f64| move |m: &mut Mask| m.expansion = e;
    assert!(
        at(&grow(5.0), 72, 50) == 1.0 && at(&|_| {}, 72, 50) == 0.0 && at(&grow(5.0), 68, 50) == 0.0,
        "Mask Expansion +5 grows the mask by 5 px"
    );
    assert!(at(&grow(-5.0), 77, 50) == 0.0 && at(&grow(-5.0), 81, 50) == 1.0, "Mask Expansion -5 shrinks it by 5 px");
    let ramp = |m: &mut Mask| {
        m.expansion = 4.0;
        m.feather = 10.0;
    };
    assert!(
        near(at(&ramp, 72, 50), smooth(-5.0, 5.0, -2.5 + 4.0), 1e-6),
        "expansion moves the feather ramp with the edge"
    );
    let opacity = |m: &mut Mask| m.opacity = 40.0;
    assert!(near(at(&opacity, 100, 50), 0.4, 1e-6) && at(&opacity, 10, 10) == 0.0, "Mask Opacity 40% keeps 40% inside");
    let inv = |m: &mut Mask| m.inverted = true;
    let inv_half = |m: &mut Mask| {
        m.inverted = true;
        m.opacity = 50.0;
    };
    assert!(
        at(&inv, 100, 50) == 0.0 && at(&inv, 10, 10) == 1.0 && near(at(&inv_half, 10, 10), 0.5, 1e-6),
        "Inverted keeps the outside"
    );

    let a = mask(sq.clone(), 0.0);
    let b =
        |mode: MaskMode, opacity: f64| Mask { id: "m2".into(), mode, opacity, ..mask(translate(&sq, 0.2, 0.0), 0.0) };
    let four = |list: &[Mask]| -> Vec<f64> {
        [90, 120, 150, 10].iter().map(|&x| (cov_at(list, W, H, x, 50) * 1e4).round() / 1e4).collect()
    };
    assert_eq!(four(&[a.clone(), b(MaskMode::Add, 100.0)]), [1.0, 1.0, 1.0, 0.0], "Add: the union");
    assert_eq!(four(&[a.clone(), b(MaskMode::Subtract, 100.0)]), [1.0, 0.0, 0.0, 0.0], "Subtract: A without B");
    assert_eq!(four(&[a.clone(), b(MaskMode::Intersect, 100.0)]), [0.0, 1.0, 0.0, 0.0], "Intersect: where both are");
    assert_eq!(four(&[a.clone(), b(MaskMode::Difference, 100.0)]), [1.0, 0.0, 1.0, 0.0], "Difference: where one is");
    assert_eq!(four(&[a.clone(), b(MaskMode::None, 100.0)]), [1.0, 1.0, 0.0, 0.0], "None: B is left out");
    assert_eq!(four(&[a.clone(), b(MaskMode::Add, 50.0)]), [1.0, 1.0, 0.5, 0.0], "Add with B at 50%");
    let first = |mode| Mask { mode, ..a.clone() };
    assert_eq!(four(&[first(MaskMode::Subtract)]), [0.0, 0.0, 1.0, 1.0], "a first mask that subtracts cuts a hole");
    assert_eq!(
        four(&[first(MaskMode::Intersect)]),
        [1.0, 1.0, 0.0, 0.0],
        "a first mask that intersects keeps only itself"
    );
    assert!(
        coverage(&[first(MaskMode::None)], W, H, 1.0).iter().all(|v| *v == 1.0)
            && coverage(&[], W, H, 1.0).iter().all(|v| *v == 1.0),
        "no mask counting is no mask"
    );

    let b2 = Mask {
        mode: MaskMode::Subtract,
        inverted: true,
        opacity: 60.0,
        feather: 6.0,
        expansion: 2.0,
        ..b(MaskMode::Subtract, 60.0)
    };
    let g = gpu_data(&[a.clone(), b2], WF, HF, 0.5);
    let segs = flatten(&sq, WF, HF).len() as f32;
    assert!(
        g[0] == 2.0
            && g[1] == 0.0
            && g[4] == 7.0
            && g[5] == segs
            && g[6] == 0.0
            && g[16] == 7.0 + segs
            && g[17] == segs
            && g[18] == 1.0
            && g[19] == 1.0,
        "the GPU data has both masks with their modes and inversion"
    );
    assert!(
        near(f64::from(g[20]), 3.0, 1e-6) && near(f64::from(g[21]), 1.0, 1e-6) && near(f64::from(g[22]), 0.6, 1e-6),
        "width, expansion and opacity at pxScale 0.5"
    );
    assert_eq!(g[28..32], [75.0, 75.0, 75.0, 25.0], "the segments of the first mask from its flattening");
    assert_eq!(
        gpu_data(&[first(MaskMode::Intersect)], WF, HF, 1.0)[1],
        1.0,
        "a first mask that intersects starts the GPU total at 1"
    );
}

#[test]
fn keyframed_paths_and_property_paths() {
    let e = ellipse(1920.0, 1080.0, Place::default());
    let tri = from_points(&[
        PenPoint { x: 0.3, y: 0.3, ..Default::default() },
        PenPoint { x: 0.7, y: 0.3, ..Default::default() },
        PenPoint { x: 0.5, y: 0.7, ..Default::default() },
    ]);
    let list: Vec<Keyframe> =
        serde_json::from_value(json!([{ "t": 0, "v": e, "ease": "linear" }, { "t": 10, "v": tri, "ease": "linear" }]))
            .expect("keyframes");
    let both = map_keyframes(&list, |p| insert_vertex(p, 0, 0.5));
    let counts: Vec<usize> = both
        .iter()
        .map(|k| match &k.v {
            cut_model::keyframes::Value::List(p) => count(p),
            _ => 0,
        })
        .collect();
    assert_eq!(counts, [5, 4], "a vertex added on a keyframed path is added on every keyframe");
    assert!(parse_path("masks.m1.inverted", false).is_none(), "inverted is not keyframed");
    assert_eq!(
        parse_path("effects.e1.masks.m2.mode", true).map(|p| p.field),
        Some("mode"),
        "mode is a field Effect Controls writes"
    );
    assert_eq!(
        parse_path("effects.e1.masks.m2.path", false).and_then(|p| p.effect_id),
        Some("e1"),
        "an effect's mask path"
    );
    let m = full(&json!({ "id": "m1", "path": polygon(20.0, 10.0, Place::default()), "feather": 0 }))
        .expect("a well formed mask");
    assert_eq!(coverage(&[m], 20, 10, 1.0)[5 * 20 + 10], 1.0, "a full mask covers its middle");
}

#[test]
#[ignore = "benchmark: cargo test --release -p cut-model --test masks -- --ignored --nocapture"]
fn coverage_speed_against_the_javascript() {
    let (w, h) = (1920_usize, 1080_usize);
    let (wf, hf) = (w as f64, h as f64);
    let mut rng = Inputs::new(99);
    let masks = vec![
        mask_json("m1", MaskMode::Add, false, &ellipse(wf, hf, Place::default()), 30.0, 100.0, 0.0),
        mask_json(
            "m2",
            MaskMode::Subtract,
            false,
            &polygon(wf, hf, Place { cx: 0.55, cy: 0.45, size: None }),
            10.0,
            80.0,
            5.0,
        ),
        mask_json("m3", MaskMode::Add, false, &random_path(&mut rng, 12, 0.4), 60.0, 100.0, -10.0),
        mask_json(
            "m4",
            MaskMode::Intersect,
            true,
            &ellipse(wf, hf, Place { cx: 0.3, cy: 0.6, size: Some(300.0) }),
            100.0,
            90.0,
            0.0,
        ),
    ];
    let reps = 5;
    let mut best = f64::INFINITY;
    let mut sum = 0.0;
    for _ in 0..reps {
        let t0 = std::time::Instant::now();
        let cov = std::hint::black_box(coverage(&masks, w, h, 1.0));
        best = best.min(t0.elapsed().as_nanos() as f64);
        sum = cov.iter().enumerate().fold(0.0, |s, (i, v)| s + f64::from(*v) * ((i % 1009) + 1) as f64);
    }
    let js = ask(ORACLE, &[json!(["benchCoverage", masks, w, h, reps])]);
    let js_ns = num(&js[0]["nsPerPixel"]).expect("a time");
    let js_sum = num(&js[0]["sum"]).expect("a sum");
    assert_eq!(sum, js_sum, "both sides computed the same coverage");
    let segs: usize = prepare(&masks, wf, hf, 1.0).iter().map(|q| q.pts.len()).sum();
    println!(
        "coverage of {w}x{h}, 4 masks ({segs} segments), checksum {sum} on both sides: rust {:.2} ns/pixel, javascript {js_ns:.2} ns/pixel ({:.1}x)",
        best / (w * h) as f64,
        js_ns / (best / (w * h) as f64)
    );
}
