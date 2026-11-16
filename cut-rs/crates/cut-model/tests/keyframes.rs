//! `keyframes` against `keyframes.js`: values at times for every ease, bezier curves, mixing, list edits.

mod common;

use common::{diff, same};
use cut_model::keyframes::*;
use cut_oracle::{Inputs, ask};
use serde_json::{Value as Json, json};

const EASES: [Ease; 6] = [Ease::Linear, Ease::Hold, Ease::EaseIn, Ease::EaseOut, Ease::EaseInOut, Ease::Bezier];

fn value(rng: &mut Inputs, shape: i64) -> Value {
    let x = |rng: &mut Inputs| rng.range(-100_000, 100_000) as f64 / 37.0;
    match shape {
        0 => Value::Num(x(rng)),
        1 => Value::List(vec![x(rng), x(rng)]),
        2 => Value::Text(format!("#{:06x}", rng.range(0, 0xff_ffff))),
        3 => Value::Text(format!("#{:08x}", rng.range(0, 0xffff_ffff))),
        _ => Value::Flag(rng.range(0, 1) == 1),
    }
}

fn list(rng: &mut Inputs) -> Vec<Keyframe> {
    let n = rng.range(0, 6);
    let shape = rng.range(0, 4);
    let mut t = rng.range(-5, 5) * 1000;
    (0..n)
        .map(|_| {
            t += rng.range(1, 40) * 1000;
            let ease = rng.pick(&EASES);
            let h = match rng.range(0, 3) {
                0 => None,
                1 => Some(vec![
                    rng.range(0, 100) as f64 / 100.0,
                    rng.range(-50, 150) as f64 / 100.0,
                    rng.range(0, 100) as f64 / 100.0,
                    rng.range(-50, 150) as f64 / 100.0,
                ]),
                _ => Some(vec![0.0, 0.0, 1.0, 1.0]),
            };
            // a list may mix shapes now and then: the earlier value holds
            let sh = if rng.range(0, 10) == 0 { rng.range(0, 4) } else { shape };
            let v = value(rng, sh);
            Keyframe { t, v, ease, h }
        })
        .collect()
}

#[test]
fn values_and_edits_match_the_javascript() {
    let mut rng = Inputs::new(7);
    let mut calls = Vec::new();
    let mut ours: Vec<Json> = Vec::new();
    for _ in 0..600 {
        let l = list(&mut rng);
        let lj = serde_json::to_value(&l).unwrap();
        let end = l.last().map_or(10_000, |k| k.t + 10_000);
        for _ in 0..12 {
            let t = rng.range(-20_000, end) as f64 + if rng.range(0, 3) == 0 { 0.5 } else { 0.0 };
            calls.push(json!(["valueAt", lj, t, "fallback"]));
            ours.push(value_at(&l, t).map_or(json!("fallback"), |v| serde_json::to_value(v).unwrap()));
        }
        for k in l.iter().take(2) {
            let probe =
                Keyframe { t: k.t + rng.range(-1, 1) * 1000, v: value(&mut rng, 0), ease: rng.pick(&EASES), h: None };
            calls.push(json!(["insert", lj, probe]));
            ours.push(serde_json::to_value(insert(&l, &probe)).unwrap());
            calls.push(json!(["remove", lj, k.t]));
            ours.push(serde_json::to_value(remove(&l, k.t)).unwrap());
            calls.push(json!(["next", lj, k.t]));
            ours.push(serde_json::to_value(next(&l, k.t)).unwrap());
            calls.push(json!(["prev", lj, k.t]));
            ours.push(serde_json::to_value(prev(&l, k.t)).unwrap());
            calls.push(json!(["handles", k]));
            ours.push(serde_json::to_value(handles(k.ease, k.h.as_deref())).unwrap());
        }
    }
    for _ in 0..3000 {
        let h = [0, 1, 2, 3]
            .map(|i| rng.range(if i % 2 == 0 { 0 } else { -100 }, if i % 2 == 0 { 100 } else { 200 }) as f64 / 100.0);
        let x = rng.range(-10, 1010) as f64 / 1000.0;
        calls.push(json!(["bezier", h[0], h[1], h[2], h[3], x]));
        ours.push(json!(bezier(h[0], h[1], h[2], h[3], x)));
    }
    for _ in 0..1000 {
        let shape = rng.range(0, 4);
        let other = if rng.range(0, 5) == 0 { rng.range(0, 4) } else { shape };
        let (a, b) = (value(&mut rng, shape), value(&mut rng, other));
        let p = rng.range(-200, 1200) as f64 / 1000.0;
        calls.push(json!(["mix", a, b, p]));
        ours.push(serde_json::to_value(mix(&a, &b, p)).unwrap());
    }
    let theirs = ask("keyframes", &calls);
    let bad: Vec<String> = calls
        .iter()
        .zip(ours.iter().zip(&theirs))
        .filter(|(_, (a, b))| !same(a, b))
        .take(8)
        .map(|(c, (a, b))| format!("{c}: {:?}", diff(a, b, "")))
        .collect();
    assert!(bad.is_empty(), "{} calls; differences:\n{}", calls.len(), bad.join("\n"));
}
