//! The engine's resampler, stretch and loudness meter, and every audio effect (`audiofx.js` processors, the chain,
//! parameter resolution, the filters' design and response), against the JavaScript on the same inputs.

mod common;

use common::{b32, b64, f32s, f64s, signal};
use cut_audio::effects::{self, AUDIO_EFFECTS, Action, ParamKind};
use cut_audio::fx::{self, Chain, Dsp, FilterType, Stage};
use cut_audio::loudness::{Loudness, k_filters, loudness, match_gain, normalize_gain};
use cut_audio::resample::resample;
use cut_audio::stretch::stretch;
use cut_oracle::{Inputs, ask, ask_scenario};
use serde_json::{Map, Value, json};

fn close(a: f64, b: &Value, eps: f64) -> bool {
    match b.as_f64() {
        Some(b) => a == b || (a - b).abs() <= eps * (1.0 + b.abs()),
        // JSON has no -inf or NaN: the oracle sends null.
        None => !a.is_finite(),
    }
}

fn assert_buf(ours: &[f32], js: &[f32], eps: f64, what: &str) {
    assert_eq!(ours.len(), js.len(), "{what}: length");
    for (i, (a, b)) in ours.iter().zip(js).enumerate() {
        assert!((f64::from(*a) - f64::from(*b)).abs() <= eps, "{what}: sample {i}: {a} vs {b}");
    }
}

#[test]
fn resampling_matches() {
    let pairs = [
        (44100.0, 48000.0),
        (48000.0, 44100.0),
        (22050.0, 48000.0),
        (48000.0, 22050.0),
        (96000.0, 48000.0),
        (32000.0, 48000.0),
        (48000.0, 48000.0),
        (48000.0, 96000.0),
    ];
    let lens = [0, 1, 5, 33, 100, 4801, 48000];
    let mut calls = Vec::new();
    let mut inputs = Vec::new();
    for (k, &(from, to)) in pairs.iter().enumerate() {
        for (j, &n) in lens.iter().enumerate() {
            let x = vec![signal(n, (k * 10 + j) as u64), signal(n, 99)];
            calls.push(json!(["resample", [b32(&x[0]), b32(&x[1])], from, to]));
            inputs.push((x, from, to));
        }
    }
    let answers = ask_scenario("audio", &calls);
    let mut exact = 0usize;
    let mut total = 0usize;
    for ((x, from, to), a) in inputs.iter().zip(&answers) {
        let ours = resample(x, *from, *to);
        for c in 0..2 {
            let js = f32s(&a[c]);
            assert_buf(&ours[c], &js, 1e-7, &format!("resample {from} -> {to}, {} samples", x[0].len()));
            exact += ours[c].iter().zip(&js).filter(|(a, b)| a == b).count();
            total += js.len();
        }
    }
    eprintln!("resample: {exact} of {total} samples bit-exact");
}

#[test]
fn time_stretch_matches() {
    let mut calls = Vec::new();
    let mut inputs = Vec::new();
    for (k, &factor) in [2.0, 0.5, 1.5, 0.8, 1.0, 3.7, 0.26, 1.0000000001].iter().enumerate() {
        for &(n, rate, ch) in &[(48000usize, 48000.0, 2usize), (30000, 44100.0, 1), (700, 48000.0, 2), (0, 48000.0, 1)]
        {
            let x: Vec<Vec<f32>> = (0..ch).map(|c| signal(n, (k * 7 + c) as u64)).collect();
            calls.push(json!(["stretch", x.iter().map(|c| b32(c)).collect::<Vec<_>>(), factor, rate]));
            inputs.push((x, factor, rate));
        }
    }
    let answers = ask_scenario("audio", &calls);
    for ((x, factor, rate), a) in inputs.iter().zip(&answers) {
        let ours = stretch(x, *factor, *rate);
        for (c, o) in ours.iter().enumerate() {
            assert_buf(o, &f32s(&a[c]), 1e-6, &format!("stretch x{factor} at {rate}, {} samples", x[0].len()));
        }
    }
}

fn loud_matches(ours: &Loudness, js: &Value, what: &str) {
    for (name, v) in [
        ("integrated", ours.integrated),
        ("truePeak", ours.true_peak),
        ("samplePeak", ours.sample_peak),
        ("momentaryMax", ours.momentary_max),
        ("shortTermMax", ours.short_term_max),
    ] {
        assert!(close(v, &js[name], 1e-9), "{what}: {name} {v} vs {}", js[name]);
    }
}

#[test]
fn loudness_matches() {
    let mut calls = Vec::new();
    let mut inputs = Vec::new();
    for &(seconds, rate, ch) in &[
        (4.0, 48000.0, 2usize),
        (3.5, 44100.0, 1),
        (2.0, 96000.0, 2),
        (1.0, 192000.0, 1),
        (3.2, 48000.0, 6),
        (3.2, 48000.0, 5),
        (0.05, 48000.0, 2),
    ] {
        let n = (seconds * rate) as usize;
        let x: Vec<Vec<f32>> =
            (0..ch).map(|c| signal(n, c as u64 + 3).iter().map(|v| v * (1.0 + c as f32 * 0.3)).collect()).collect();
        calls.push(json!(["loudness", x.iter().map(|c| b32(c)).collect::<Vec<_>>(), rate]));
        inputs.push((x, rate));
    }
    calls.push(json!(["loudness", [b32(&vec![0.0; 96000]), b32(&vec![0.0; 96000])], 48000.0]));
    inputs.push((vec![vec![0.0; 96000]; 2], 48000.0));
    let answers = ask_scenario("audio", &calls);
    for ((x, rate), a) in inputs.iter().zip(&answers) {
        let chans: Vec<&[f32]> = x.iter().map(Vec::as_slice).collect();
        loud_matches(&loudness(&chans, *rate), a, &format!("{} channels at {rate}", x.len()));
    }
    let k = ask_scenario("audio", &[json!(["kFilters", 48000]), json!(["kFilters", 44100]), json!(["kFilters", 8000])]);
    for (fs, a) in [48000.0, 44100.0, 8000.0].iter().zip(&k) {
        let ours = k_filters(*fs);
        for f in 0..2 {
            for i in 0..5 {
                assert!(close(ours[f][i], &a[f][i], 1e-15), "kFilters {fs} [{f}][{i}]");
            }
        }
    }
    let l =
        Loudness { integrated: -20.0, true_peak: -10.0, sample_peak: -10.0, momentary_max: 0.0, short_term_max: 0.0 };
    assert_eq!(match_gain(&l, -14.0, -1.0), 6.0, "match -20 LUFS to -14: +6 dB");
    assert_eq!(
        match_gain(&Loudness { true_peak: -4.0, ..l }, -14.0, -1.0),
        3.0,
        "held so the true peak stays at -1 dBTP"
    );
    assert_eq!(match_gain(&Loudness { integrated: f64::NEG_INFINITY, ..l }, -14.0, -1.0), 0.0, "silence");
    assert!((normalize_gain(0.5, -1.0) - 5.0206).abs() < 1e-3, "normalize 0.5 to -1 dB");
    assert_eq!(normalize_gain(0.0, -1.0), 0.0, "normalize silence");
}

/// Random stored parameters of an effect: in and out of range, wrong types, missing, null.
fn random_params(rng: &mut Inputs, e: &effects::AudioEffect) -> Map<String, Value> {
    let mut m = Map::new();
    for p in e.params {
        let v = match (rng.range(0, 9), p.kind) {
            (0, _) => continue,
            (1, _) => Value::Null,
            (2, _) => json!("x"),
            (_, ParamKind::Number { min, max }) => {
                let span = max - min;
                json!(min - 0.1 * span + (rng.range(0, 10000) as f64 / 10000.0) * 1.2 * span)
            }
            (_, ParamKind::Bool) => json!(rng.range(0, 1) == 1),
            (_, ParamKind::Choice(list)) => {
                if rng.range(0, 4) == 0 {
                    json!(12)
                } else {
                    json!(list[rng.range(0, list.len() as i64 - 1) as usize].0)
                }
            }
        };
        m.insert(p.id.into(), v);
    }
    m
}

/// The JavaScript's resolved object as the Rust parameter list.
fn as_list(e: &effects::AudioEffect, js: &Value) -> Vec<f64> {
    e.params
        .iter()
        .map(|p| match (&js[p.id], p.kind) {
            (Value::Bool(b), _) => f64::from(u8::from(*b)),
            (Value::String(s), ParamKind::Choice(list)) => list.iter().find(|c| c.0 == s).map_or(f64::NAN, |c| c.1),
            (v, _) => v.as_f64().unwrap_or(f64::NAN),
        })
        .collect()
}

#[test]
fn parameters_resolve_as_the_registry_does() {
    let mut rng = Inputs::new(5);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for e in AUDIO_EFFECTS {
        for _ in 0..40 {
            let p = random_params(&mut rng, e);
            calls.push(json!(["resolve", e.kind, p]));
            ours.push((e, e.resolve(&p)));
        }
    }
    let answers = ask_scenario("audio", &calls);
    for ((e, r), js) in ours.iter().zip(&answers) {
        assert_eq!(*r, as_list(e, js), "{}: {js}", e.kind);
    }
}

fn dsp_effects() -> impl Iterator<Item = (&'static effects::AudioEffect, Dsp)> {
    AUDIO_EFFECTS.iter().filter_map(|e| if let Action::Dsp(d) = e.action { Some((e, d)) } else { None })
}

#[test]
fn processors_match_in_any_call_sizes() {
    let mut rng = Inputs::new(9);
    let n = 24000;
    let l: Vec<f64> = signal(n, 1).iter().map(|&v| f64::from(v) * 2.5).collect();
    let r: Vec<f64> = signal(n, 2).iter().map(|&v| f64::from(v) * 0.7).collect();
    let mut calls = Vec::new();
    let mut cases = Vec::new();
    for (e, d) in dsp_effects() {
        for k in 0..8 {
            let p = if k == 0 { Map::new() } else { random_params(&mut rng, e) };
            let fs = [48000.0, 44100.0, 96000.0][k % 3];
            let blocks: Vec<usize> = (0..5).map(|_| rng.range(1, 700) as usize).collect();
            calls.push(json!(["processBuffer", e.kind, p, b64(&l), b64(&r), fs, blocks]));
            calls.push(json!(["memory", e.kind, p, fs]));
            cases.push((e, d, e.resolve(&p), fs, blocks));
        }
    }
    let answers = ask_scenario("audio", &calls);
    for ((e, d, p, fs, blocks), a) in cases.iter().zip(answers.chunks(2)) {
        let [yl, yr] = fx::process_buffer(*d, p, &l, &r, *fs, Some(blocks));
        let [jl, jr] = [f64s(&a[0][0]), f64s(&a[0][1])];
        for (ours, js) in [(&yl, &jl), (&yr, &jr)] {
            assert_eq!(ours.len(), js.len());
            let worst = ours.iter().zip(js).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max);
            assert!(worst <= 1e-9, "{} {p:?} at {fs}: worst {worst:e}", e.kind);
        }
        assert!(close(d.memory(p, *fs), &a[1][0], 1e-12), "{} memory {p:?}", e.kind);
        assert_eq!(d.latency(*fs) as f64, a[1][1].as_f64().unwrap_or(-1.0), "{} latency", e.kind);
        let [ml, _] = fx::process_buffer(*d, p, &l, &r, *fs, None);
        assert_eq!(ml, yl, "{}: the same samples in calls of {blocks:?} as in 32-sample calls", e.kind);
    }
}

#[test]
fn a_chain_of_effects_matches() {
    let n = 30000;
    let l: Vec<f64> = signal(n, 4).iter().map(|&v| f64::from(v) * 1.8).collect();
    let r: Vec<f64> = signal(n, 5).iter().map(|&v| f64::from(v)).collect();
    let list = json!([
        ["audio.eq", { "hpOn": true, "hpSlope": "48", "b1Gain": 5, "lpOn": true, "lpFreq": 6000 }],
        ["audio.gain", { "gain": 4 }],
        ["audio.compressor", { "threshold": -30, "ratio": 8, "knee": 0 }],
        ["audio.fade", { "fadeIn": 0.2, "fadeOut": 0.1 }],
        ["audio.limiter", { "ceiling": -2, "truePeak": true }],
        ["audio.gate", { "threshold": -30 }],
        ["audio.limiter", { "ceiling": -6 }],
    ]);
    let a = &ask_scenario("audio", &[json!(["chain", list, b64(&l), b64(&r), 48000])])[0];
    let mut stages = Vec::new();
    let mut params = Vec::new();
    for item in list.as_array().expect("a list") {
        let e = effects::get(item[0].as_str().expect("a type")).expect("an audio effect");
        stages.push(Stage::of(e, 10.0));
        params.push(e.resolve(item[1].as_object().expect("params")));
    }
    let mut chain = Chain::new(stages, 48000.0);
    assert_eq!(chain.latency as f64, a["latency"].as_f64().unwrap_or(-1.0), "latency");
    let (mut x, mut y) = (l.clone(), r.clone());
    chain.process(&mut x, &mut y, n, |k, _| std::borrow::Cow::Borrowed(&params[k]), |i| i as f64 / 48000.0);
    for (ours, js) in [(&x, f64s(&a["out"][0])), (&y, f64s(&a["out"][1]))] {
        let worst = ours.iter().zip(&js).map(|(p, q)| (p - q).abs()).fold(0.0, f64::max);
        assert!(worst <= 1e-9, "chain: worst {worst:e}");
    }
}

#[test]
fn filter_design_response_and_curves_match() {
    let mut rng = Inputs::new(3);
    let types = ["lowpass", "highpass", "peaking", "lowshelf", "highshelf", "notch", "cut", "other"];
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for _ in 0..300 {
        let t = types[rng.range(0, 7) as usize];
        let f0 = [0.0, 0.5, 20.0, 100.0, 1000.0, 15000.0, 30000.0][rng.range(0, 6) as usize];
        let g = rng.range(-300, 300) as f64 / 10.0;
        let q = [0.0, 0.0005, 0.1, std::f64::consts::FRAC_1_SQRT_2, 2.0, 30.0][rng.range(0, 5) as usize];
        let fs = [8000.0, 44100.0, 48000.0, 96000.0][rng.range(0, 3) as usize];
        let c = fx::design(FilterType::of(t), f0, g, q, fs);
        calls.push(json!(["design", t, f0, g, q, fs]));
        ours.push(c.to_vec());
        let f = rng.range(1, 20000) as f64;
        calls.push(json!(["magnitudeDb", c, f, fs]));
        ours.push(vec![fx::magnitude_db(&c, f, fs)]);
        calls.push(json!(["ringSamples", c]));
        ours.push(vec![fx::ring_samples(&c)]);
        let (x, th, ratio, knee) = (
            rng.range(-900, 100) as f64 / 10.0,
            rng.range(-600, 0) as f64 / 10.0,
            rng.range(10, 200) as f64 / 10.0,
            rng.range(0, 24) as f64,
        );
        calls.push(json!(["compressCurve", x, th, ratio, knee]));
        ours.push(vec![fx::compress_curve(x, th, ratio, knee)]);
    }
    let answers = ask("audiofx", &calls);
    for ((call, o), js) in calls.iter().zip(&ours).zip(&answers) {
        let js: Vec<Value> = js.as_array().cloned().unwrap_or_else(|| vec![js.clone()]);
        for (a, b) in o.iter().zip(&js) {
            assert!(close(*a, b, 1e-12), "{call}: {a} vs {b}");
        }
    }
    let freqs: Vec<f64> = (0..40).map(|i| 20.0 * 1.19f64.powi(i)).collect();
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for (e, d) in dsp_effects() {
        for _ in 0..10 {
            let p = random_params(&mut rng, e);
            calls.push(json!(["response", e.kind, p, freqs, 48000]));
            ours.push(fx::response(d, &e.resolve(&p), &freqs, 48000.0));
        }
    }
    let answers = ask_scenario("audio", &calls);
    for ((call, o), js) in calls.iter().zip(&ours).zip(&answers) {
        for (a, b) in o.iter().zip(js.as_array().expect("a list")) {
            assert!(close(*a, b, 1e-9), "{call}: {a} vs {b}");
        }
    }
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for e in AUDIO_EFFECTS.iter().filter(|e| !matches!(e.action, Action::Dsp(_))) {
        for _ in 0..60 {
            let p = random_params(&mut rng, e);
            let (t, len) = (rng.range(-10, 700) as f64 / 100.0, rng.range(0, 600) as f64 / 100.0);
            calls.push(json!(["gain", e.kind, p, t, len]));
            ours.push(e.gain(&e.resolve(&p), t, len));
        }
    }
    for ((call, o), js) in calls.iter().zip(&ours).zip(&ask_scenario("audio", &calls)) {
        assert!(close(*o, js, 1e-12), "{call}: {o} vs {js}");
    }
}
