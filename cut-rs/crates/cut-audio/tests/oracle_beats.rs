//! Onsets, tempo and beats (`analyze.js` `createFlux`, `onsetStrength`, `tempo`, `trackBeats`, `barPhase`, `beats`)
//! against the JavaScript on click tracks at many tempos, rates and offsets, with and without noise, on noise alone,
//! silence and pieces shorter than one frame; and `verify/cut-analyze.mjs`'s 'beats' cases.

mod common;

use common::b32;
use cut_audio::analysis::*;
use cut_oracle::{Inputs, ask_scenario};
use serde_json::{Value, json};

/// Clicks at `bpm` from `offset` s, every fourth one louder when `accent`, plus noise of `noise` peak to peak
/// (`clickTrack` of `verify/cut-analyze.mjs`) -> the samples and the click times.
fn click_track(
    rng: &mut Inputs,
    bpm: f64,
    seconds: f64,
    rate: f64,
    offset: f64,
    accent: bool,
    noise: f64,
) -> (Vec<f32>, Vec<f64>) {
    let n = (seconds * rate).round() as usize;
    let mut out = vec![0f32; n];
    let period = 60.0 / bpm;
    let mut clicks = Vec::new();
    let mut k = 0;
    while offset + k as f64 * period < seconds - 0.05 {
        let at = offset + k as f64 * period;
        clicks.push(at);
        let amp = if accent && k % 4 == 0 { 0.9 } else { 0.35 };
        let s0 = (at * rate).round() as usize;
        let mut i = 0;
        while (i as f64) < 0.03 * rate && s0 + i < n {
            let v = amp
                * (-(i as f64) / (0.006 * rate)).exp()
                * ((2.0 * std::f64::consts::PI * 2000.0 * i as f64) / rate).sin();
            out[s0 + i] = (f64::from(out[s0 + i]) + v) as f32;
            i += 1;
        }
        k += 1;
    }
    if noise > 0.0 {
        for v in &mut out {
            let r = (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
            *v = (f64::from(*v) + (r - 0.5) * noise) as f32;
        }
    }
    (out, clicks)
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array().map(|a| a.iter().map(num).collect()).unwrap_or_default()
}

fn floats(v: &Value) -> Vec<f32> {
    nums(v).into_iter().map(|x| x as f32).collect()
}

/// The same number, NaN equal to the JavaScript's null.
fn same(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

struct Case {
    samples: Vec<f32>,
    rate: f64,
    size: usize,
    hop: usize,
    block: usize,
}

#[test]
fn beats_match_the_javascript_stage_by_stage() {
    let mut rng = Inputs::new(31);
    let mut cases = Vec::new();
    for (bpm, noise) in [(120.0, 0.0), (90.0, 0.0), (140.0, 0.02)] {
        let (samples, _) = click_track(&mut rng, bpm, 40.0, 22050.0, 0.25, true, noise);
        cases.push(Case { samples, rate: 22050.0, size: 1024, hop: 256, block: 3001 });
    }
    for _ in 0..24 {
        let bpm = rng.range(55, 210) as f64 + rng.range(0, 9) as f64 / 10.0;
        let rate = rng.pick(&[22050.0, 24000.0, 16000.0, 44100.0]);
        let seconds = rng.range(3, 14) as f64;
        let offset = rng.range(0, 900) as f64 / 1000.0;
        let noise = rng.pick(&[0.0, 0.0, 0.01, 0.1, 0.5]);
        let accent = rng.range(0, 1) == 1;
        let (samples, _) = click_track(&mut rng, bpm, seconds, rate, offset, accent, noise);
        let (size, hop) = rng.pick(&[(1024, 256), (1024, 256), (512, 128), (2048, 512), (256, 256), (64, 16)]);
        cases.push(Case { samples, rate, size, hop, block: rng.range(1, 12000) as usize });
    }
    // noise alone, silence, a single impulse, shorter than a frame, nothing
    let noise: Vec<f32> =
        (0..22050 * 6).map(|_| ((rng.next_u64() >> 40) as f64 / (1u64 << 24) as f64 - 0.5) as f32).collect();
    cases.push(Case { samples: noise, rate: 22050.0, size: 1024, hop: 256, block: 4096 });
    cases.push(Case { samples: vec![0.0; 22050 * 5], rate: 22050.0, size: 1024, hop: 512, block: 22050 });
    let mut one = vec![0.0f32; 30000];
    one[12345] = 1.0;
    cases.push(Case { samples: one, rate: 24000.0, size: 1024, hop: 256, block: 777 });
    cases.push(Case { samples: vec![0.5; 900], rate: 24000.0, size: 1024, hop: 256, block: 100 });
    cases.push(Case { samples: Vec::new(), rate: 24000.0, size: 1024, hop: 256, block: 100 });
    cases.push(Case { samples: vec![0.25; 4096], rate: 8000.0, size: 1024, hop: 1024, block: 1 });

    let calls: Vec<Value> =
        cases.iter().map(|c| json!(["beats", b32(&c.samples), c.rate, c.size, c.hop, c.block])).collect();
    let answers = ask_scenario("analyze", &calls);
    let (mut envs, mut stages) = (0, 0);
    let mut bad = Vec::new();
    for (k, (c, js)) in cases.iter().zip(&answers).enumerate() {
        let mut flux = Flux::new(c.rate, c.size, c.hop).expect("a power of two");
        for part in c.samples.chunks(c.block) {
            flux.push(part);
        }
        let env = flux.envelope().to_vec();
        let js_env = floats(&js["env"]);
        if env != js_env {
            let worst = env.iter().zip(&js_env).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            bad.push(format!("case {k}: envelope ({} vs {} frames, worst {worst:e})", env.len(), js_env.len()));
        }
        envs += js_env.len();
        // each stage from the JavaScript's own input, so a difference shows where it starts
        let strength = onset_strength(&js_env, flux.hop_seconds(), 0.5);
        let js_strength = floats(&js["strength"]);
        if strength != js_strength {
            bad.push(format!("case {k}: onset strength"));
        }
        let t = tempo(&js_strength, flux.hop_seconds(), 60.0, 200.0);
        let jt = &js["tempo"];
        if !(same(t.bpm, num(&jt["bpm"]))
            && same(t.period, num(&jt["period"]))
            && same(t.confidence, num(&jt["confidence"])))
        {
            bad.push(format!("case {k}: tempo {t:?} vs {jt}"));
        }
        let frames = track_beats(&js_strength, num(&jt["period"]), 100.0);
        let js_frames = nums(&js["frames"]);
        if frames.len() != js_frames.len() || frames.iter().zip(&js_frames).any(|(a, b)| !same(*a, *b)) {
            bad.push(format!("case {k}: beat frames ({} vs {})", frames.len(), js_frames.len()));
        }
        if bar_phase(&js_strength, &js_frames, 4) as f64 != num(&js["phase"]) {
            bad.push(format!("case {k}: bar phase"));
        }
        // and the whole of it from the samples
        let r = beats(&flux, &env);
        let jr = &js["result"];
        let jb = nums(&jr["beats"]);
        if !(same(r.bpm, num(&jr["bpm"]))
            && r.beats.len() == jb.len()
            && r.beats.iter().zip(&jb).all(|(a, b)| same(*a, *b))
            && r.phase as f64 == num(&jr["phase"])
            && same(r.confidence, num(&jr["confidence"])))
        {
            bad.push(format!("case {k}: beats {} {} vs {}", r.bpm, r.beats.len(), jr["bpm"]));
        }
        stages += 6 + js_frames.len();
    }
    eprintln!("beats: {} cases, {envs} envelope frames and {stages} stage values agree with analyze.js", cases.len());
    assert!(bad.is_empty(), "{} differ:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn click_tracks_give_their_tempo_beats_and_bars() {
    let mut rng = Inputs::new(7);
    for (bpm, label) in [(120.0, "120 BPM"), (90.0, "90 BPM"), (140.0, "140 BPM with noise")] {
        let (samples, clicks) =
            click_track(&mut rng, bpm, 40.0, 22050.0, 0.25, true, if bpm == 140.0 { 0.02 } else { 0.0 });
        let mut flux = Flux::new(22050.0, 1024, 256).unwrap();
        for part in samples.chunks(3001) {
            flux.push(part);
        }
        let r = beats(&flux, flux.envelope());
        assert!((r.bpm - bpm).abs() < 0.3, "{label}: the tempo is {:.2}", r.bpm);
        let near = |c: f64| r.beats.iter().map(|b| (b - c).abs()).fold(f64::INFINITY, f64::min);
        let missed = clicks.iter().filter(|c| near(**c) > 0.012).count();
        assert!(
            missed == 0 && r.beats.len().abs_diff(clicks.len()) <= 1,
            "{label}: {} beats for {} clicks, {missed} missed",
            r.beats.len(),
            clicks.len()
        );
        let downs: Vec<f64> = r.beats.iter().enumerate().filter(|(i, _)| i % 4 == r.phase).map(|(_, b)| *b).collect();
        let accents: Vec<f64> = clicks.iter().step_by(4).copied().collect();
        let on = downs.iter().filter(|b| accents.iter().any(|c| (*b - c).abs() < 0.012)).count();
        assert!(on + 1 >= downs.len() && downs.len() + 1 >= accents.len(), "{label}: the bars start on the accents");
    }
    let mut re = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let mut im = [0.0; 8];
    Fft::new(8).unwrap().run(&mut re, &mut im);
    assert!(
        re.iter().all(|x| (x - 1.0).abs() < 1e-12) && im.iter().all(|x| x.abs() < 1e-12),
        "the FFT of an impulse is flat"
    );
    assert!(Fft::new(12).is_none() && Flux::new(48000.0, 1000, 256).is_none(), "the FFT size must be a power of two");
    let mut quiet = Flux::new(22050.0, 1024, 512).unwrap();
    quiet.push(&vec![0.0; 22050 * 5]);
    let none = beats(&quiet, quiet.envelope());
    assert!(none.beats.is_empty() || none.confidence == 0.0, "silence has no beats");
}

#[test]
fn flux_is_the_same_in_any_blocks_and_never_panics() {
    let mut rng = Inputs::new(3);
    let (samples, _) = click_track(&mut rng, 128.0, 6.0, 24000.0, 0.1, true, 0.05);
    let mut whole = Flux::new(24000.0, 1024, 256).unwrap();
    whole.push(&samples);
    let mut parts = Flux::new(24000.0, 1024, 256).unwrap();
    let mut i = 0;
    while i < samples.len() {
        let n = rng.range(0, 5000) as usize;
        parts.push(&samples[i..(i + n).min(samples.len())]);
        i += n;
    }
    assert_eq!(whole.envelope(), parts.envelope());
    // odd values: NaN, infinities, huge numbers, an empty curve
    let mut odd = samples.clone();
    for k in (0..odd.len()).step_by(9973) {
        odd[k] = [f32::NAN, f32::INFINITY, -f32::INFINITY, f32::MAX][k % 4];
    }
    let mut f = Flux::new(24000.0, 512, 128).unwrap();
    f.push(&odd);
    let _ = beats(&f, f.envelope());
    let _ = beats(&f, &[]);
    assert!(track_beats(&[1.0; 10], f64::NAN, 100.0).is_empty() && tempo(&[], 0.01, 60.0, 200.0).bpm == 0.0);
}

#[test]
#[ignore = "benchmark"]
fn bench_beats_of_a_minute() {
    let mut rng = Inputs::new(5);
    let (samples, _) = click_track(&mut rng, 120.0, 60.0, 24000.0, 0.2, true, 0.01);
    let mut best = f64::INFINITY;
    let mut found = 0;
    for _ in 0..5 {
        let t0 = std::time::Instant::now();
        let mut flux = Flux::new(24000.0, 1024, 256).unwrap();
        for part in samples.chunks(240000) {
            flux.push(part);
        }
        found = beats(&flux, flux.envelope()).beats.len();
        best = best.min(t0.elapsed().as_secs_f64() * 1e3);
    }
    let js = ask_scenario("analyze", &[json!(["timeBeats", b32(&samples), 24000, 5])]);
    eprintln!("a minute at 24 kHz, flux and beats ({found} beats): {best:.1} ms here, {:.1} ms in analyze.js", js[0]);
}
