//! Waveform peaks (`thumbs.js`), levels, loud, silent and speech ranges, the range algebra and Auto Ducking's
//! keyframes (`analyze.js`) against the JavaScript.

mod common;

use common::{MemAudio, b32, f32s, signal};
use cut_audio::analysis::*;
use cut_oracle::{Inputs, ask, ask_scenario};
use serde_json::{Value, json};
use std::sync::Arc;

fn ranges(v: &Value) -> Vec<(f64, f64)> {
    v.as_array()
        .expect("ranges")
        .iter()
        .map(|r| (r[0].as_f64().unwrap_or(f64::NAN), r[1].as_f64().unwrap_or(f64::NAN)))
        .collect()
}

fn random_ranges(rng: &mut Inputs, n: usize, span: i64) -> Vec<(f64, f64)> {
    (0..n)
        .map(|_| {
            let a = rng.range(-span / 10, span) as f64;
            (a, a + rng.range(-span / 20, span / 5) as f64)
        })
        .collect()
}

#[test]
fn range_algebra_and_silence_match() {
    let mut rng = Inputs::new(21);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for k in 0..200 {
        let x = {
            let n = rng.range(0, 12) as usize;
            random_ranges(&mut rng, n, 1000)
        };
        let y = {
            let n = rng.range(0, 12) as usize;
            random_ranges(&mut rng, n, 1000)
        };
        let js = |r: &[(f64, f64)]| json!(r.iter().map(|p| [p.0, p.1]).collect::<Vec<_>>());
        calls.push(json!(["union", js(&x)]));
        ours.push(union(&x));
        calls.push(json!(["subtract", js(&x), js(&y)]));
        ours.push(subtract(&x, &y));
        calls.push(json!(["intersect", js(&x), js(&y)]));
        ours.push(intersect(&x, &y));
        let (min, margin, frame) = (rng.range(0, 100) as f64, rng.range(0, 30) as f64, [1.0, 7.0, 33.3][k % 3]);
        calls.push(json!(["silenceRanges", js(&x), js(&y), { "minLength": min, "margin": margin, "frame": frame }]));
        ours.push(silence_ranges(&x, &y, min, margin, frame));
        calls.push(json!(["speechRanges", js(&x), js(&y), { "hold": min }]));
        ours.push(speech_ranges(&x, &y, min));
    }
    let answers = ask("analyze", &calls);
    for ((call, o), js) in calls.iter().zip(&ours).zip(&answers) {
        assert_eq!(*o, ranges(js), "{call}");
    }
    let x = random_ranges(&mut rng, 30, 1000);
    let t = ask("analyze", &[json!(["total", x.iter().map(|p| [p.0, p.1]).collect::<Vec<_>>()])]);
    assert_eq!(total(&x), t[0].as_f64().unwrap_or(f64::NAN), "total");
}

#[test]
fn levels_and_loud_ranges_match() {
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for (k, &(rate, window, ch)) in
        [(48000.0, 0.01, 2usize), (44100.0, 0.02, 1), (48000.0, 0.0333, 2)].iter().enumerate()
    {
        let n = 70001 + k * 333;
        let mut x: Vec<Vec<f32>> = (0..ch).map(|c| signal(n, c as u64 + 7)).collect();
        for v in &mut x[0][20000..30000] {
            *v = 0.0;
        }
        calls.push(json!(["levels", x.iter().map(|c| b32(c)).collect::<Vec<_>>(), rate, window]));
        let mut m = LevelMeter::new(rate, window);
        let refs: Vec<&[f32]> = x.iter().map(Vec::as_slice).collect();
        for a in (0..n).step_by(1000) {
            let part: Vec<&[f32]> = refs.iter().map(|c| &c[a..(a + 1000).min(n)]).collect();
            m.push(&part);
        }
        ours.push((m.levels(), m.step));
    }
    let answers = ask_scenario("audio", &calls);
    let mut loud_calls = Vec::new();
    let mut loud = Vec::new();
    for ((lv, step), js) in ours.iter().zip(&answers) {
        assert_eq!(*lv, f32s(&js["levels"]), "levels");
        assert_eq!(*step, js["step"].as_f64().unwrap_or(f64::NAN), "step");
        for th in [-40.0, -12.0, -200.0, 0.0] {
            loud_calls.push(json!(["loudRanges", lv, step, th]));
            loud.push(loud_ranges(lv, *step, th));
        }
    }
    for ((call, o), js) in loud_calls.iter().zip(&loud).zip(&ask("analyze", &loud_calls)) {
        assert_eq!(*o, ranges(js), "{}", &call.to_string()[..60.min(call.to_string().len())]);
    }
}

#[test]
fn peaks_match_and_long_files_go_by_windows() {
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for (k, &(n, spp)) in
        [(0usize, 256usize), (1, 256), (1000, 256), (48000, 300), (48001, 1), (9999, 1024)].iter().enumerate()
    {
        let x = [signal(n, k as u64), signal(n, k as u64 + 50)];
        calls.push(json!(["computePeaks", [x[0], x[1]], spp]));
        let p = compute_peaks(&[&x[0], &x[1]], spp);
        ours.push(p.clone());
        for c in [1, 2, 3, 8] {
            calls.push(json!(["coarsen", p, c]));
            ours.push(coarsen(&p, c));
        }
    }
    for ((call, o), js) in calls.iter().zip(&ours).zip(&ask("thumbs", &calls)) {
        let js: Vec<f32> =
            js.as_array().expect("peaks").iter().map(|v| v.as_f64().unwrap_or(f64::NAN) as f32).collect();
        assert_eq!(*o, js, "{}", &call.to_string()[..40.min(call.to_string().len())]);
    }
    // A source read in ten-second windows gives the peaks of all of it at once.
    let data = Arc::new(vec![signal(48000 * 25 + 77, 3), signal(48000 * 25 + 77, 4)]);
    let mut r = MemAudio { rate: 48000.0, data: data.clone() };
    let by_windows = peaks(&mut r, BASE_SPP).expect("peaks");
    assert_eq!(by_windows, compute_peaks(&[&data[0], &data[1]], BASE_SPP));
}

#[test]
fn duck_keyframes_match() {
    let mut rng = Inputs::new(8);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for _ in 0..150 {
        let duration = rng.range(0, 2000) as f64;
        let speech = {
            let n = rng.range(0, 6) as usize;
            random_ranges(&mut rng, n, 2000)
        };
        let (amount, fade, frame) =
            (-(rng.range(0, 240) as f64) / 10.0, rng.range(0, 100) as f64, [1.0, 10.0, 25.0][rng.range(0, 2) as usize]);
        calls.push(json!(["duckKeyframes", { "duration": duration, "speech": speech.iter().map(|p| [p.0, p.1]).collect::<Vec<_>>(), "amount": amount, "fade": fade, "frame": frame }]));
        ours.push(duck_keyframes(duration, &speech, amount, fade, frame));
    }
    for ((call, o), js) in calls.iter().zip(&ours).zip(&ask("analyze", &calls)) {
        let js = js.as_array().expect("keyframes");
        assert_eq!(o.len(), js.len(), "{call}");
        for (k, j) in o.iter().zip(js) {
            assert_eq!(k.t as f64, j["t"].as_f64().unwrap_or(f64::NAN), "{call}");
            assert_eq!(k.v, cut_model::keyframes::Value::Num(j["v"].as_f64().unwrap_or(f64::NAN)), "{call}");
        }
    }
}
