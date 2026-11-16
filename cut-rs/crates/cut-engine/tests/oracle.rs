//! The engine's pure parts against the JavaScript (tools/oracle.mjs, scenario `engine`): the registry, every effect's
//! and transition's uniforms, Lumetri Color's math and the compositor's plan.

mod common;

use std::sync::Arc;

use common::*;
use cut_engine::lumetri::{self, Lut};
use cut_engine::uniforms::{self, Info};
use cut_engine::{plan, uniforms::basic_plan};
use cut_model::effects::{self as fx, Def, Kind, ParamKind};
use cut_model::keyframes::{Ease, Keyframe, Value};
use cut_model::masks::{Mask, MaskMode};
use cut_model::{Id, MediaKind, Source};
use cut_oracle::{Inputs, ask};
use serde_json::{Map, Value as Json, json};

const S: &str = "scenario/engine";

fn check(what: &str, got: &[Json], want: &[Json], calls: &[Json], eps: f64) {
    assert_eq!(got.len(), want.len());
    let mut bad = Vec::new();
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        if let Err(e) = same(g, w, eps, "") {
            bad.push(format!("{what} {}: {e}", calls[i]));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        got.len(),
        bad.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
    eprintln!("{what}: {} calls agree", got.len());
}

fn f(r: &mut Inputs, lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * (r.next_u64() % 1_000_001) as f64 / 1_000_000.0
}

fn hex(r: &mut Inputs) -> String {
    format!("#{:06x}", r.next_u64() & 0xff_ffff)
}

/// Parameters for a def: in range, out of range, wrong types, missing.
fn random_params(r: &mut Inputs, def: &Def) -> Map<String, Json> {
    let mut p = Map::new();
    for d in def.params {
        let pick = r.range(0, 9);
        if pick == 0 {
            continue;
        }
        let v = match d.kind {
            ParamKind::Number | ParamKind::Percent | ParamKind::Angle => {
                let (lo, hi) = (d.min.unwrap_or(-1000.0), d.max.unwrap_or(1000.0));
                let span = (hi - lo).max(1.0);
                match pick {
                    1 => json!("12"),
                    2 => json!(lo - span * 0.3),
                    3 => json!(hi + span * 0.3),
                    4 => json!(lo),
                    5 => d.default.to_json(),
                    _ => json!((f(r, lo, hi) * 100.0).round() / 100.0),
                }
            }
            ParamKind::Bool => {
                [json!(true), json!(false), json!(0), json!(1), json!("x"), json!("")][r.range(0, 5) as usize].clone()
            }
            ParamKind::Choice => {
                let c = d.choices;
                if pick == 1 { json!("nope") } else { json!(c[r.range(0, c.len() as i64 - 1) as usize].0) }
            }
            ParamKind::Color => {
                if pick == 1 {
                    json!(7)
                } else {
                    json!(hex(r))
                }
            }
            ParamKind::Point => {
                if pick == 1 {
                    json!([1])
                } else {
                    json!([f(r, -500.0, 500.0), f(r, -500.0, 500.0)])
                }
            }
            ParamKind::Curve => match pick {
                1 => json!([0, 0, 1]),
                2 => json!([0, "a", 1, 1]),
                3 => json!([0, 0, 1, 1]),
                _ => {
                    let n = r.range(2, 18) as usize;
                    Json::from((0..n * 2).map(|_| (f(r, -0.2, 1.2) * 1000.0).round() / 1000.0).collect::<Vec<f64>>())
                }
            },
            ParamKind::Lut => {
                if pick < 5 {
                    json!("")
                } else {
                    json!("lut-test")
                }
            }
        };
        p.insert(d.id.to_owned(), v);
    }
    p
}

fn cube(r: &mut Inputs, n: u32) -> String {
    let mut s = format!("TITLE \"t\"\nLUT_3D_SIZE {n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n");
    for _ in 0..n.pow(3) {
        s += &format!("{:.4} {:.4} {:.4}\n", f(r, 0.0, 1.0), f(r, 0.0, 1.0), f(r, 0.0, 1.0));
    }
    s
}

fn lut_of(cube: &str) -> Arc<Lut> {
    let mut l = lumetri::parse_cube(cube).expect("a valid cube");
    l.id = "lut-test".into();
    Arc::new(l)
}

/// The categories of a kind's effects and transitions, in order of first appearance (effects.js `categories`).
fn categories(kind: Kind) -> Vec<&'static str> {
    let mut out: Vec<&str> = Vec::new();
    for d in fx::list(Some(kind)).chain(fx::transitions(Some(kind))) {
        if !out.contains(&d.category) {
            out.push(d.category);
        }
    }
    out
}

#[test]
fn registry_resolve_defaults_and_categories() {
    let mut r = Inputs::new(1);
    let (mut calls, mut got) = (Vec::new(), Vec::new());
    for def in fx::list(None).chain(fx::transitions(None)) {
        calls.push(json!(["defaults", def.id]));
        got.push(Json::Object(fx::defaults(def.id)));
        for _ in 0..30 {
            let p = random_params(&mut r, def);
            calls.push(json!(["resolve", def.id, p.clone()]));
            got.push(Json::Object(fx::resolve(def.id, &p)));
        }
    }
    calls.push(json!(["resolve", "nope", { "a": 1 }]));
    got.push(Json::Object(fx::resolve("nope", json!({ "a": 1 }).as_object().expect("an object"))));
    for (k, n) in [(Kind::Video, "video"), (Kind::Audio, "audio")] {
        calls.push(json!(["categories", n]));
        got.push(json!(categories(k)));
    }
    for _ in 0..50 {
        let c = [f(&mut r, 0.0, 1.0), f(&mut r, 0.0, 1.0), f(&mut r, 0.0, 1.0), 1.0];
        calls.push(json!(["whiteBalance", c]));
        let (t, m) = uniforms::white_balance([c[0], c[1], c[2]]);
        got.push(json!({ "temperature": t, "tint": m }));
    }
    let want = ask(S, &calls);
    check("registry", &got, &want, &calls, 1e-12);
}

#[test]
fn every_effects_uniforms_and_tables() {
    let mut r = Inputs::new(2);
    let (mut calls, mut got) = (Vec::new(), Vec::new());
    for def in fx::list(Some(Kind::Video)) {
        calls.push(json!(["bindings", def.id]));
        let b = uniforms::bindings(def.id);
        got.push(if b.is_empty() {
            Json::Null
        } else {
            b.iter().map(|&(n, three_d)| (n.to_string(), json!(if three_d { "3d" } else { "2d" }))).collect()
        });
        for k in 0..60 {
            let p = random_params(&mut r, def);
            let info = json!({
                "width": r.range(1, 4000), "height": r.range(1, 2200), "pxScale": r.pick(&[1.0, 0.5, 0.25, 0.37]),
                "quality": 1, "frame": r.range(0, 2000),
            });
            let c = if def.id == "color.basic" && k % 2 == 0 {
                let n = r.range(2, 4) as u32;
                cube(&mut r, n)
            } else {
                String::new()
            };
            let resolved = fx::resolve(def.id, &p);
            let i = Info {
                width: info["width"].as_f64().unwrap_or(0.0),
                height: info["height"].as_f64().unwrap_or(0.0),
                px_scale: info["pxScale"].as_f64().unwrap_or(0.0),
                quality: 1.0,
                frame: info["frame"].as_f64().unwrap_or(0.0),
                lut: (!c.is_empty()).then(|| lut_of(&c)),
            };
            calls.push(json!(["uniforms", def.id, p, info, c]));
            got.push(json!(uniforms::effect(def.id, &resolved, &i)));
            if def.id == "color.basic" && k % 3 == 0 {
                calls.push(json!(["textureKeys", def.id, p, c]));
                let mut m = Map::new();
                for b in ["4", "5"] {
                    m.insert(b.into(), Json::Null);
                }
                for t in uniforms::textures(def.id, &resolved, &i) {
                    m.insert(t.binding.to_string(), json!({ "key": t.key, "size": t.size, "data": (t.data)() }));
                }
                // the JavaScript gives a 2D size as [w, h]
                if let Some(Json::Object(t)) = m.get_mut("5") {
                    t.insert("size".into(), json!([lumetri::TABLE, 1]));
                }
                got.push(Json::Object(m));
            }
        }
    }
    for def in fx::transitions(Some(Kind::Video)) {
        for _ in 0..30 {
            let p = random_params(&mut r, def);
            let progress = f(&mut r, 0.0, 1.0);
            calls.push(json!(["transition", def.id, p, progress]));
            got.push(json!(uniforms::transition(def.id, &fx::resolve(def.id, &p), progress)));
        }
    }
    let want = ask(S, &calls);
    check("uniforms", &got, &want, &calls, 1e-12);
}

#[test]
fn lumetri_color_math() {
    let mut r = Inputs::new(3);
    let def = fx::get("color.basic").expect("Lumetri Color");
    let (mut calls, mut got) = (Vec::new(), Vec::new());
    for k in 0..300 {
        let p = random_params(&mut r, def);
        let rgb = [f(&mut r, 0.0, 1.2), f(&mut r, 0.0, 1.0), f(&mut r, 0.0, 1.0)];
        let resolved = fx::resolve("color.basic", &p);
        if k % 3 == 0 {
            let q = basic_plan(&resolved);
            calls.push(json!(["basic", p, rgb]));
            got.push(json!({ "plan": { "gain": q.gain, "k": q.k, "tone": q.tone, "vibrance": q.vibrance, "saturation": q.saturation },
                "pixel": uniforms::basic_pixel(rgb, &q) }));
        }
        let c = if k % 2 == 0 { cube(&mut r, 3) } else { String::new() };
        let info = Info { lut: (!c.is_empty()).then(|| lut_of(&c)), ..Default::default() };
        let stages = uniforms::lumetri_stages(&resolved, &info);
        // the JavaScript's CPU picture is a Float32Array: its input is rounded to f32 first
        let mut px = rgb.map(|v| f64::from(v as f32));
        for s in &stages {
            px = s.pixel(px);
        }
        let out = [px[0], px[1], px[2], 1.0];
        calls.push(json!(["lumetriPixel", p, rgb, c]));
        // the JavaScript's CPU picture is a Float32Array
        got.push(json!(out.map(|v| f64::from(v as f32))));
        let h = lumetri::hsl_plan(&resolved);
        calls.push(json!(["hslPlan", resolved]));
        got.push(json!({ "hue": h.hue, "half": h.half, "hueSoft": h.hue_soft, "sat": h.sat, "lum": h.lum, "gain": h.gain, "k": h.k,
            "saturation": h.saturation, "shift": h.shift, "mask": h.mask, "matrix": h.matrix, "active": h.active }));
        calls.push(json!(["lumetri", "hslMask", rgb, { "hue": h.hue, "half": h.half, "hueSoft": h.hue_soft, "sat": h.sat, "lum": h.lum }]));
        got.push(json!(lumetri::hsl_mask(rgb, &h)));
        calls.push(json!(["curvesPixel", resolved, rgb]));
        got.push(json!(lumetri::curves_pixel(rgb, &lumetri::curves_table(&resolved))));
        calls.push(json!(["lumetri", "curveKey", resolved]));
        got.push(json!(lumetri::curve_key(&resolved)));
    }
    let negative_zero =
        fx::resolve("color.basic", json!({ "curveRed": [-0.0, -0.0, 1, 1] }).as_object().expect("an object"));
    calls.push(json!(["lumetri", "curveKey", negative_zero]));
    got.push(json!(lumetri::curve_key(&negative_zero)));
    for _ in 0..200 {
        let n = r.range(0, 20) as usize;
        let flat: Vec<f64> = (0..n).map(|_| (f(&mut r, -0.3, 1.3) * 1000.0).round() / 1000.0).collect();
        calls.push(json!(["lumetri", "sanitize", flat]));
        got.push(json!(cut_model::lumetri::sanitize(&flat.iter().map(|&v| json!(v)).collect::<Vec<_>>())));
        let pts = lumetri::points(&flat);
        let m = lumetri::slopes(&pts);
        calls.push(json!(["lumetri", "slopes", pts]));
        got.push(json!(m));
        let x = f(&mut r, -0.1, 1.1);
        calls.push(json!(["lumetri", "evalCurve", pts, x]));
        got.push(json!(lumetri::eval_curve(&pts, x, &m)));
        calls.push(json!(["lumetri", "isIdentityCurve", flat]));
        got.push(json!(lumetri::is_identity_curve(&flat)));
        let s = [f(&mut r, -0.1, 1.1), f(&mut r, -0.1, 1.1), f(&mut r, -0.1, 1.1)];
        calls.push(json!(["lumetri", "hueOf", s]));
        got.push(json!(lumetri::hue_of(s)));
        let v = f(&mut r, -70000.0, 70000.0) * if r.range(0, 1) == 0 { 1e-6 } else { 1.0 };
        calls.push(json!(["lumetri", "toHalf", v]));
        got.push(json!(lumetri::to_half(v as f32)));
    }
    for n in [2u32, 3, 5] {
        let c = cube(&mut r, n);
        let l = lut_of(&c);
        for _ in 0..30 {
            let s = [f(&mut r, -0.2, 1.2), f(&mut r, -0.2, 1.2), f(&mut r, -0.2, 1.2)];
            calls.push(json!(["sampleLut", c, s]));
            got.push(json!(lumetri::sample_lut(&l, s)));
            let k = f(&mut r, 0.0, 1.0);
            calls.push(json!(["lutPixel", c, s, k]));
            got.push(json!(lumetri::lut_pixel(s, &l, k)));
        }
        calls.push(json!(["lutHalf", c]));
        got.push(json!(lumetri::half_rgba(&l.data, 3)));
        let (id, entry) = lumetri::store(&l, if n == 2 { "" } else { "Look" });
        calls.push(json!(["store", c, if n == 2 { "" } else { "Look" }]));
        got.push(json!({ "id": id, "entry": entry }));
        calls.push(json!(["decode", entry, id]));
        let d = lumetri::decode(&entry, &id).expect("decodes");
        got.push(
            json!({ "id": d.id, "size": d.size, "min": d.min, "max": d.max, "data": d.data, "name": entry["name"] }),
        );
    }
    let want = ask(S, &calls);
    check("lumetri", &got, &want, &calls, 1e-12);
}

#[test]
fn cube_files_good_and_bad() {
    let mut r = Inputs::new(4);
    let good = cube(&mut r, 2);
    let mut texts: Vec<String> = vec![
        good.clone(),
        good.replace("DOMAIN_MIN 0 0 0", "LUT_3D_INPUT_RANGE 0.1 0.9"),
        good.replace("TITLE \"t\"", "# a comment\nTITLE \"A Look\" # with a comment\nLUT_IN_VIDEO_RANGE"),
        good.replace("\n", "\r\n"),
        good.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 0x2"),
        good.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2.0"),
        good.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 1e0"),
        "".into(),
        "nope".into(),
        "a\0b".into(),
        "LUT_1D_SIZE 4".into(),
        "LUT_3D_SIZE 1".into(),
        "LUT_3D_SIZE 66".into(),
        "LUT_3D_SIZE 2.5".into(),
        "LUT_3D_SIZE 2 2".into(),
        "LUT_3D_SIZE 2\nLUT_3D_SIZE 3".into(),
        "LUT_3D_SIZE 2\n0 0".into(),
        "LUT_3D_SIZE 2\n0 0 x".into(),
        "LUT_3D_SIZE 2\n0 0 .".into(),
        "LUT_3D_SIZE 2\n0 0 1e".into(),
        "LUT_3D_SIZE 2\nnan 0 0".into(),
        "LUT_3D_SIZE 2\n0 0 0\n".into(),
        good.replace("DOMAIN_MAX 1 1 1", "DOMAIN_MAX 1 0 1"),
        good.replace("DOMAIN_MAX 1 1 1", "DOMAIN_MAX 1 1"),
        good.replace("DOMAIN_MAX 1 1 1", "LUT_3D_INPUT_RANGE 1"),
        format!("{good}0 0 0\n"),
        good.replace("TITLE \"t\"", "TITLE \"한국어 제목\""),
        format!("TITLE \"{}\"\n{}", "x".repeat(300), good),
    ];
    for _ in 0..40 {
        // truncated and bit-flipped files
        let mut b = good.clone().into_bytes();
        let cut = r.range(0, b.len() as i64 - 1) as usize;
        b.truncate(cut);
        if r.range(0, 1) == 0 && !b.is_empty() {
            let i = r.range(0, b.len() as i64 - 1) as usize;
            b[i] = b"0.-e9 \nXa#"[r.range(0, 9) as usize];
        }
        texts.push(String::from_utf8_lossy(&b).into_owned());
    }
    let calls: Vec<Json> = texts.iter().map(|t| json!(["parseCube", t])).collect();
    let got: Vec<Json> = texts
        .iter()
        .map(|t| match lumetri::parse_cube(t) {
            Ok(l) => json!({ "title": l.title, "size": l.size, "min": l.min, "max": l.max, "data": l.data }),
            Err(e) => json!({ "$lut": e.message, "params": Json::Object(e.params.into_iter().map(|(k, v)| (k.to_string(), v)).collect()), "code": "lut" }),
        })
        .collect();
    let want = ask(S, &calls);
    check("parseCube", &got, &want, &calls, 1e-7);
}

// ---- the plan ----

fn kf(t: i64, v: Value) -> Keyframe {
    Keyframe { t, v, ease: Ease::Linear, h: None }
}

fn mask(id: &str, mode: MaskMode) -> Mask {
    Mask {
        id: Id::new(id),
        mode,
        inverted: false,
        path: cut_model::masks::ellipse(
            1920.0,
            1080.0,
            cut_model::masks::Place { cx: 0.5, cy: 0.5, size: Some(200.0) },
        ),
        feather: 10.0,
        opacity: 100.0,
        expansion: 0.0,
    }
}

/// A project with a bit of everything the plan looks at.
fn busy_project() -> cut_model::Project {
    let mut p = project(1920, 1080);
    let a = media(&mut p, "m1", "D:/a.mp4", MediaKind::Video, 1920.0, 1080.0, (10 * SEC) as f64);
    let pic = media(&mut p, "m2", "D:/pic.png", MediaKind::Image, 640.0, 480.0, 0.0);
    let mut s2 = cut_model::defaults::sequence(
        Id::new("s2"),
        &cut_model::defaults::SequenceOpts { w: 640, h: 360, video_tracks: 2, audio_tracks: 0, ..Default::default() },
    );
    s2.insert_clip(clip("n1", "V1", 0, 0.0, (5 * SEC) as f64, of_media(a)), None);
    let mut n2 = clip("n2", "V2", SEC, 0.0, (2 * SEC) as f64, solid("#336699"));
    n2.effects.push(effect("e9", "color.invert", json!({ "amount": 50 })));
    s2.insert_clip(n2, None);
    p.sequences.push(s2);

    let mut c1 = clip("c1", "V1", 0, 0.0, (2 * SEC) as f64, of_media(a));
    c1.sampling = cut_model::Sampling::Blend;
    c1.speed = 0.4;
    c1.out = (0.4 * (2 * SEC) as f64).round();
    put(&mut p, "s1", c1);
    put(&mut p, "s1", clip("c2", "V1", 2 * SEC, (5 * SEC) as f64, (7 * SEC) as f64, of_media(a)));
    let mut c3 = clip("c3", "V2", 0, 0.0, (3 * SEC) as f64, solid("#ff0000"));
    c3.keyframes.insert("opacity".into(), vec![kf(0, Value::Num(0.0)), kf(SEC, Value::Num(100.0))]);
    c3.keyframes.insert(
        "position".into(),
        vec![kf(0, Value::List(vec![0.0, 0.0])), kf(2 * SEC, Value::List(vec![100.0, -50.0]))],
    );
    c3.effects.push(effect("e1", "blur.gaussian", json!({ "blurriness": 20 })));
    c3.keyframes.insert("effects.e1.blurriness".into(), vec![kf(0, Value::Num(0.0)), kf(SEC, Value::Num(40.0))]);
    c3.effects.push(effect("e2", "color.basic", json!({ "exposure": 1, "curveMaster": [0, 0, 0.5, 0.7, 1, 1] })));
    c3.effects.push(effect("e3", "vignette", json!({})));
    c3.effects.last_mut().expect("e3").masks = Some(vec![mask("m1", MaskMode::Add)]);
    c3.effects
        .push(serde_json::from_value(json!({ "id": "e4", "type": "mosaic", "on": false, "params": {} })).expect("e4"));
    c3.effects.push(effect("e5", "edge.extend", json!({})));
    c3.masks = Some(vec![mask("m2", MaskMode::Add), mask("m3", MaskMode::None)]);
    c3.keyframes.insert("masks.m2.feather".into(), vec![kf(0, Value::Num(0.0)), kf(2 * SEC, Value::Num(50.0))]);
    put(&mut p, "s1", c3);
    let mut c4 = clip(
        "c4",
        "V3",
        0,
        (SEC) as f64,
        (4 * SEC) as f64,
        Source::Nest { sequence: Id::new("s2"), extra: Default::default() },
    );
    if let cut_model::Props::Video(v) = &mut c4.props {
        v.scale = [50.0, 50.0];
        v.rotation = 30.0;
        v.crop = [10.0, 0.0, 5.0, 0.0];
    }
    put(&mut p, "s1", c4);
    let mut c5 = clip("c5", "V3", 4 * SEC, 0.0, (4 * SEC) as f64, of_media(a));
    c5.reverse = true;
    c5.speed = 2.0;
    put(&mut p, "s1", c5);
    let mut c6 = clip("c6", "V3", 6 * SEC, 0.0, (2 * SEC) as f64, of_media(a));
    c6.remap = Some(cut_model::remap::constant(0.0, 1.0, 2 * SEC));
    c6.remap = cut_model::remap::add_key(c6.remap.as_ref().expect("a remap"), SEC);
    if let Some(r) = c6.remap.as_mut() {
        r.speeds = vec![1.0, 3.0];
    }
    c6.out = (4 * SEC) as f64;
    put(&mut p, "s1", c6);
    put(&mut p, "s1", clip("c7", "V2", 4 * SEC, 0.0, (2 * SEC) as f64, of_media(pic)));
    let mut c8 = clip("c8", "V2", 6 * SEC, (2 * SEC) as f64, (3 * SEC) as f64, of_media(a));
    if let Source::Media { freeze, .. } = &mut c8.source {
        *freeze = true;
    }
    put(&mut p, "s1", c8);
    let mut c9 = clip("c9", "V4", 0, 0.0, (9 * SEC) as f64, solid("#00ff00"));
    c9.enabled = false;
    put(&mut p, "s1", c9);
    let mut text = cut_model::Source::Generator {
        generator: cut_model::Generator::Text,
        layers: Some(vec![cut_model::defaults::text_layer(&Default::default())]),
        color: None,
        extra: Default::default(),
    };
    if let Source::Generator { layers: Some(l), .. } = &mut text {
        l[0]["text"] = json!("Hello");
    }
    put(&mut p, "s1", clip("c10", "V2", 3 * SEC, 0.0, SEC as f64, text));
    let adj = Source::Generator {
        generator: cut_model::Generator::Adjustment,
        layers: None,
        color: None,
        extra: Default::default(),
    };
    put(&mut p, "s1", clip("c11", "V4", 9 * SEC, 0.0, SEC as f64, adj));
    let s1 = p.sequence_mut(Id::new("s1")).expect("s1");
    s1.transitions.push(serde_json::from_value(json!({ "id": "t1", "track": "V1", "at": 2 * SEC, "type": "dissolve", "duration": SEC / 2, "align": "center", "params": {} })).expect("t1"));
    s1.transitions.push(serde_json::from_value(json!({ "id": "t2", "track": "V3", "at": 4 * SEC, "type": "wipe", "duration": SEC, "align": "start", "params": { "direction": "fromTop", "feather": 20 } })).expect("t2"));
    p
}

fn item_json(it: &plan::Item<'_>) -> Json {
    let kind = format!("{:?}", it.kind).to_lowercase();
    json!({
        "clip": it.clip.id, "kind": kind, "local": it.local, "srcT": it.src_t,
        "blend": it.blend.map(|b| json!({ "srcT": b.src_t, "w": b.w })), "key": it.key, "seqW": it.seq_w, "seqH": it.seq_h,
        "position": it.position, "scale": it.scale, "rotation": it.rotation, "anchor": it.anchor, "opacity": it.opacity,
        "crop": it.crop, "extend": it.extend, "masks": it.masks, "frameIndex": it.frame_index,
        "effects": it.effects.iter().map(|e| json!({ "id": e.id, "type": e.def.id, "params": e.params, "masks": e.masks })).collect::<Vec<_>>(),
        "layers": (it.kind == plan::ItemKind::Nest).then(|| layers_json(&it.layers)),
    })
}

fn layers_json(layers: &[plan::Layer<'_>]) -> Json {
    Json::from(
        layers
            .iter()
            .map(|l| match l {
                plan::Layer::Clip(it) => json!({ "kind": "clip", "item": item_json(it) }),
                plan::Layer::Transition { def, params, progress, a, b, .. } => json!({
                    "kind": "transition", "type": def.id, "params": params, "progress": progress,
                    "a": a.as_ref().map(item_json), "b": b.as_ref().map(item_json),
                }),
            })
            .collect::<Vec<_>>(),
    )
}

#[test]
fn the_plan_at_many_times() {
    let (p, text) = reload(&busy_project());
    let s1 = p.sequence(Id::new("s1")).expect("s1");
    let mut r = Inputs::new(5);
    let mut times: Vec<f64> = (0..=40).map(|i| (i * SEC / 4) as f64).collect();
    times.extend((0..120).map(|_| r.range(-SEC, 11 * SEC) as f64));
    times.extend([(2 * SEC - SEC / 4) as f64, (2 * SEC + SEC / 4 - 1) as f64, (4 * SEC + SEC - 1) as f64, 1234.5]);
    let calls: Vec<Json> = times.iter().map(|t| json!(["plan", text, "s1", t])).collect();
    let got: Vec<Json> = times.iter().map(|&t| layers_json(&plan::plan(&p, s1, t, ""))).collect();
    let all = Json::from(got.clone()).to_string();
    for kind in
        ["\"nest\"", "\"transition\"", "\"text\"", "\"image\"", "\"blend\":{", "\"masks\":[{", "\"extend\":true"]
    {
        assert!(all.contains(kind), "the plans show {kind}");
    }
    let want = ask(S, &calls);
    check("plan", &got, &want, &calls, 1e-12);

    let calls: Vec<Json> = ["t1", "t2"].iter().map(|t| json!(["missingHandles", text, "s1", t])).collect();
    let got: Vec<Json> = ["t1", "t2"]
        .iter()
        .map(|id| {
            let tn = s1.transitions.iter().find(|x| x.id.as_str() == *id).expect("a transition");
            let (a, b) = plan::missing_handles(&p, s1, tn);
            json!({ "a": a, "b": b })
        })
        .collect();
    let want = ask(S, &calls);
    check("missingHandles", &got, &want, &calls, 1e-12);

    let mut calls = Vec::new();
    let mut got = Vec::new();
    for _ in 0..200 {
        let (sw, sh, w, h) =
            (f(&mut r, -10.0, 4000.0), f(&mut r, -10.0, 4000.0), f(&mut r, 1.0, 4000.0), f(&mut r, 1.0, 4000.0));
        let mode = r.pick(&["fit", "fill", "original", "other"]);
        calls.push(json!(["fitScale", sw, sh, w, h, mode]));
        got.push(json!(plan::fit_scale(sw, sh, w, h, Some(mode))));
    }
    for c in s1.clips() {
        for _ in 0..5 {
            let t = r.range(-SEC, 12 * SEC) as f64;
            let d = r.pick(&[(10 * SEC) as f64, 100.0, 0.0]);
            calls.push(json!(["extendedSourceTime", serde_json::to_value(c).expect("a clip"), t, d]));
            got.push(json!(plan::extended_source_time(c, t, d)));
        }
    }
    let want = ask(S, &calls);
    check("fitScale, extendedSourceTime", &got, &want, &calls, 1e-12);
}

#[test]
fn scopes_counts() {
    use cut_engine::scopes;
    let mut r = Inputs::new(6);
    let (mut calls, mut got) = (Vec::new(), Vec::new());
    for _ in 0..100 {
        let (w, h) = (r.range(1, 3000) as u32, r.range(1, 2000) as u32);
        let (sw, sh) = (r.range(16, 4000) as f64, r.range(16, 4000) as f64);
        let rect = scopes::frame_rect(w, h, sw, sh);
        calls.push(json!(["frameRect", w, h, sw, sh]));
        got.push(json!({ "x0": rect.x0, "y0": rect.y0, "x1": rect.x1, "y1": rect.y1 }));
        let budget = r.pick(&[262_144u32, 1000, 7]);
        calls.push(json!(["stepFor", { "x0": rect.x0, "y0": rect.y0, "x1": rect.x1, "y1": rect.y1 }, budget]));
        got.push(json!(scopes::step_for(rect, budget)));
    }
    for _ in 0..6 {
        let (w, h) = (r.range(8, 60) as u32, r.range(8, 40) as u32);
        let img: Vec<u8> = (0..w * h * 4).map(|_| r.range(0, 255) as u8).collect();
        let rect = scopes::frame_rect(w, h, r.range(16, 100) as f64, r.range(16, 100) as f64);
        let (cols, size, step) = (r.pick(&[256u32, 64, 7]), r.pick(&[256u32, 33]), r.range(1, 3) as u32);
        calls.push(json!(["analyze", img, w, h, { "x0": rect.x0, "y0": rect.y0, "x1": rect.x1, "y1": rect.y1 }, { "cols": cols, "size": size, "step": step }]));
        let (bins, l) = scopes::analyze(&img, w, rect, cols, size, step);
        got.push(json!({ "bins": bins, "layout": { "cols": l.cols, "size": l.size, "wave": l.wave, "parade": l.parade, "vector": l.vector, "hist": l.hist, "total": l.total } }));
    }
    let want = ask("scopes", &calls);
    check("scopes", &got, &want, &calls, 0.0);
}
