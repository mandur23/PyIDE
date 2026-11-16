//! Effect Controls' lane maths against the JavaScript's own functions (`tools/scenarios/controls.cjs` takes them out of
//! `ui-controls.js` and `ui-timeline.js` by name): where a keyframe and a time sit in a lane, which way a segment
//! goes, a segment's ends, control points and handles, what a press at a point hits, and the keyframe menu's
//! interpolation change. Random clips, lane sizes, keyframe lists of every ease and value kind, and the edges.

use cut_app::controls::lane;
use cut_app::fx::edit;
use cut_model::keyframes::{Ease, Keyframe, Value};
use cut_oracle::Inputs;
use cut_time::{TICKS, Ticks};
use serde_json::{Value as Json, json};

/// The tick quantum clip lengths are whole multiples of (`model.js`'s `QUANTUM`).
const Q: Ticks = 2_116_800;

const EASES: [Ease; 6] = [Ease::Linear, Ease::Hold, Ease::EaseIn, Ease::EaseOut, Ease::EaseInOut, Ease::Bezier];

fn ask(calls: &[Json]) -> Vec<Json> {
    cut_oracle::ask("scenario/controls", calls)
}

/// A clip the JavaScript reads `clipDuration` of: `d` ticks at speed 1, and its keyframes on `path`.
fn clip(d: Ticks, path: &str, list: &[Keyframe]) -> Json {
    json!({ "id": "c1", "in": 0, "out": d, "speed": 1, "keyframes": { path: list } })
}

fn value(rng: &mut Inputs, kind: i64) -> Value {
    match kind {
        0 => Value::Num(rng.range(-500, 500) as f64 / 4.0),
        1 => Value::List(vec![rng.range(-50, 50) as f64, rng.range(-50, 50) as f64]),
        2 => Value::List(vec![1.0, rng.range(0, 2) as f64]),
        _ => Value::Text(format!("#{:06x}", rng.range(0, 0xff_ffff))),
    }
}

fn list(rng: &mut Inputs, d: Ticks, n: usize) -> Vec<Keyframe> {
    let kind = rng.range(0, 3);
    let mut out: Vec<Keyframe> = Vec::new();
    for _ in 0..n {
        let t = rng.range(0, d.max(1) - 1);
        if out.iter().any(|k| k.t == t) {
            continue;
        }
        let ease = rng.pick(&EASES);
        let h = (ease == Ease::Bezier && rng.range(0, 1) == 1)
            .then(|| (0..4).map(|_| rng.range(-1000, 2000) as f64 / 1000.0).collect());
        out.push(Keyframe { t, v: value(rng, kind), ease, h });
    }
    out.sort_by_key(|k| k.t);
    out
}

fn near(a: f64, b: &Json) -> bool {
    b.as_f64().is_some_and(|b| (a - b).abs() < 1e-9 * (1.0 + a.abs()))
}

fn pair(p: [f64; 2], j: &Json) -> bool {
    near(p[0], &j[0]) && near(p[1], &j[1])
}

#[test]
fn lane_positions_and_times_match() {
    let mut rng = Inputs::new(11);
    let mut calls = Vec::new();
    let mut mine = Vec::new();
    for _ in 0..400 {
        let r = rng.range(1, 100_000) * Q;
        let d = rng.pick(&[Q, TICKS / 30, 10 * TICKS, r]);
        let r = rng.range(20, 2000) as f64 / 3.0;
        let w = rng.pick(&[0.0, 1.0, 12.0, 13.0, 200.0, r]);
        let t = rng.range(-d, 2 * d) as f64;
        let x = rng.range(-100, 3000) as f64 / 3.0;
        calls.push(json!(["laneX", clip(d, "opacity", &[]), w, t]));
        mine.push(lane::lane_x(d, w, t));
        calls.push(json!(["laneT", clip(d, "opacity", &[]), w, x]));
        mine.push(lane::lane_t(d, w, x));
    }
    let got = ask(&calls);
    for ((c, m), g) in calls.iter().zip(&mine).zip(&got) {
        assert!(near(*m, g), "{c}: {m} vs {g}");
    }
    eprintln!("{} lane positions and times compared", calls.len());
}

#[test]
fn directions_match() {
    let mut rng = Inputs::new(12);
    let mut calls = Vec::new();
    let mut mine = Vec::new();
    for _ in 0..300 {
        let kind = rng.range(0, 3);
        let other = if rng.range(0, 4) == 0 { 0 } else { kind };
        let (a, b) = (value(&mut rng, kind), value(&mut rng, other));
        let same = rng.range(0, 3) == 0;
        let b = if same { a.clone() } else { b };
        calls.push(json!(["direction", a, b]));
        mine.push(lane::direction(&a, &b));
    }
    let got = ask(&calls);
    for ((c, m), g) in calls.iter().zip(&mine).zip(&got) {
        assert_eq!(Some(i64::from(*m)), g.as_i64(), "{c}");
    }
}

#[test]
fn segments_and_hits_match() {
    let mut rng = Inputs::new(13);
    let mut calls = Vec::new();
    let mut cases = Vec::new();
    for _ in 0..250 {
        let r = rng.range(1, 600_000) * Q;
        let d = rng.pick(&[TICKS, 10 * TICKS, r]);
        let n = rng.range(0, 6) as usize;
        let l = list(&mut rng, d, n);
        let r = rng.range(30, 900) as f64;
        let (w, h) = (rng.pick(&[20.0, 160.0, 300.0, r]), rng.pick(&[22.0, 40.0]));
        for i in 0..=l.len() {
            calls.push(json!(["segment", clip(d, "opacity", &l), l, i, w, h]));
            cases.push((d, l.clone(), w, h, i, 0.0, 0.0, 0u8));
        }
        for _ in 0..6 {
            let x = rng.range(-10, w as i64 + 10) as f64 + rng.range(0, 3) as f64 / 4.0;
            let y = rng.range(-4, h as i64 + 4) as f64;
            // aim at a keyframe or a handle now and then
            let (x, y) = match (rng.range(0, 2), l.first()) {
                (0, Some(k)) => (lane::lane_x(d, w, k.t as f64) + rng.range(-7, 7) as f64, y),
                (1, Some(_)) => lane::segment(d, &l, 0, w, h)
                    .and_then(|s| s.handles)
                    .map_or((x, y), |hs| (hs[0][0] + rng.range(-6, 6) as f64, hs[0][1] + rng.range(-6, 6) as f64)),
                _ => (x, y),
            };
            calls.push(json!(["keyAt", clip(d, "opacity", &l), "opacity", w, h, x]));
            cases.push((d, l.clone(), w, h, 0, x, y, 1));
            calls.push(json!(["handleAt", clip(d, "opacity", &l), "opacity", w, h, x, y]));
            cases.push((d, l.clone(), w, h, 0, x, y, 2));
        }
    }
    let got = ask(&calls);
    let mut shown = 0;
    for ((c, (d, l, w, h, i, x, y, what)), g) in calls.iter().zip(&cases).zip(&got) {
        match what {
            0 => match lane::segment(*d, l, *i, *w, *h) {
                None => assert!(g.is_null(), "{c}: none vs {g}"),
                Some(s) => {
                    assert!(near(s.xa, &g["xa"]) && near(s.xb, &g["xb"]), "{c}: ends {s:?} vs {g}");
                    assert!(
                        near(s.y_of(0.0), &g["y0"]) && near(s.y_of(1.0), &g["y1"]) && near(s.y_of(0.5), &g["yHalf"]),
                        "{c}: {g}"
                    );
                    assert!(near(s.p_of(4.0), &g["pTop"]) && near(s.p_of(s.y_of(0.25)), &g["pMid"]), "{c}: {g}");
                    match s.pts {
                        None => assert!(g["pts"].is_null(), "{c}: no points vs {g}"),
                        Some(p) => assert!(pair(p[0], &g["pts"][0]) && pair(p[1], &g["pts"][1]), "{c}: {p:?} vs {g}"),
                    }
                    match s.handles {
                        None => assert!(g["handles"].is_null(), "{c}: no handles vs {g}"),
                        Some(p) => {
                            shown += 1;
                            assert!(pair(p[0], &g["handles"][0]) && pair(p[1], &g["handles"][1]), "{c}: {p:?} vs {g}");
                        }
                    }
                }
            },
            1 => assert_eq!(lane::key_at(*d, l, *w, *x), g.as_i64(), "{c}"),
            _ => {
                let m = lane::handle_at(*d, l, *w, *h, *x, *y);
                let j = g
                    .as_object()
                    .map(|o| (o["index"].as_u64().unwrap() as usize, o["which"].as_u64().unwrap() as usize));
                assert_eq!(m, j, "{c}");
            }
        }
    }
    assert!(shown > 20, "bezier segments with handles were compared ({shown})");
    eprintln!("{} segments and hits compared, {shown} with handles", calls.len());
}

#[test]
fn the_keyframe_menus_interpolation_matches() {
    let mut rng = Inputs::new(14);
    let mut calls = Vec::new();
    let mut mine = Vec::new();
    for _ in 0..200 {
        let d = 10 * TICKS;
        let n = rng.range(1, 6) as usize;
        let l = list(&mut rng, d, n);
        let extra = rng.range(0, d);
        let times: Vec<Ticks> = l.iter().filter(|_| rng.range(0, 1) == 1).map(|k| k.t).chain([extra]).collect();
        let ease = rng.pick(&EASES);
        calls.push(json!(["easeList", l, times, ease]));
        mine.push(edit::ease_list(&l, &times, ease));
    }
    let got = ask(&calls);
    for ((c, m), g) in calls.iter().zip(&mine).zip(&got) {
        let theirs: Vec<Keyframe> = serde_json::from_value(g.clone()).unwrap_or_else(|e| panic!("{c}: {e} in {g}"));
        assert_eq!(m.len(), theirs.len(), "{c}");
        for (a, b) in m.iter().zip(&theirs) {
            assert_eq!((a.t, &a.v, a.ease), (b.t, &b.v, b.ease), "{c}");
            match (&a.h, &b.h) {
                (Some(x), Some(y)) => {
                    assert!(x.iter().zip(y).all(|(p, q)| (p - q).abs() < 1e-12) && x.len() == y.len(), "{c}")
                }
                (x, y) => assert_eq!(x, y, "{c}"),
            }
        }
    }
}
