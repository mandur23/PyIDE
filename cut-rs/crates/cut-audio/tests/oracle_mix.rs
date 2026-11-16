//! Whole mixes of test projects the JavaScript builds with its own commands, against `audioengine.createMixer`'s on
//! the same sources, sample by sample.

mod common;

use common::{built, f32s, mix_blocks, mixer, worst};
use cut_oracle::ask_scenario;
use serde_json::json;

/// Float rounding: the two sides compute in doubles and store the same values in 32-bit floats, but `Math.pow`,
/// `sin` and `exp` of V8 and of the Windows C runtime can differ in the last bit, and a 32-bit store can then round
/// the other way (2^-24 of the value); filters and the compressor carry such a difference on.
const TOLERANCE: f64 = 2e-6;

struct Case {
    name: &'static str,
    seconds: f64,
    from: f64,
    blocks: &'static [usize],
    whole: bool,
}

fn compare(cases: &[Case]) {
    let mut calls = Vec::new();
    for c in cases {
        calls.push(json!(["build", c.name]));
        let (s0, total) = ((c.from * 48000.0) as i64, (c.seconds * 48000.0) as usize);
        calls.push(json!(["mix", c.name, s0, total, c.blocks, if c.whole { "whole" } else { "reader" }]));
    }
    let answers = ask_scenario("audio", &calls);
    for (c, pair) in cases.iter().zip(answers.chunks(2)) {
        let b = built(&pair[0]);
        let js = [f32s(&pair[1]["out"][0]), f32s(&pair[1]["out"][1])];
        let mut m = mixer(&b, c.whole);
        let (s0, total) = ((c.from * 48000.0) as i64, (c.seconds * 48000.0) as usize);
        let (ours, missing) = mix_blocks(&mut m, &b, s0, total, c.blocks);
        assert_eq!(missing, 0, "{}: nothing missing once loaded", c.name);
        assert_eq!(pair[1]["missing"], 0, "{}: nor in the JavaScript", c.name);
        let energy: f64 = js[0].iter().map(|v| f64::from(*v).abs()).sum();
        assert!(energy > 100.0, "{}: the mix is not silence ({energy})", c.name);
        let mut exact = 0;
        for ch in 0..2 {
            let (w, at) = worst(&ours[ch], &js[ch]);
            assert!(
                w <= TOLERANCE,
                "{} channel {ch} blocks {:?}: worst difference {w:e} at sample {} (ours {}, JavaScript {})",
                c.name,
                c.blocks,
                at + s0 as usize,
                ours[ch][at],
                js[ch][at]
            );
            exact += ours[ch].iter().zip(&js[ch]).filter(|(a, b)| a == b).count();
        }
        eprintln!("{}: {} of {} samples bit-exact", c.name, exact, 2 * total);
    }
}

#[test]
fn clips_keyframes_fades_crossfades_tracks_and_master_match() {
    compare(&[
        Case { name: "basic", seconds: 9.0, from: 0.0, blocks: &[48000], whole: false },
        Case { name: "basic", seconds: 4.0, from: 3.3, blocks: &[2048], whole: true },
        Case { name: "solo", seconds: 8.0, from: 0.0, blocks: &[48000], whole: false },
    ]);
}

#[test]
fn speed_reverse_and_resampled_clips_match() {
    compare(&[
        Case { name: "speed", seconds: 9.0, from: 0.0, blocks: &[48000], whole: false },
        Case { name: "speed", seconds: 3.0, from: 4.1, blocks: &[1999, 4096], whole: true },
    ]);
}

#[test]
fn effect_chains_and_gain_effects_match() {
    compare(&[
        Case { name: "fx", seconds: 10.0, from: 0.0, blocks: &[48000], whole: false },
        Case { name: "fx", seconds: 3.0, from: 3.3, blocks: &[2048], whole: false },
    ]);
}

#[test]
fn nested_sequences_match() {
    compare(&[
        Case { name: "nest", seconds: 8.0, from: 0.0, blocks: &[48000], whole: false },
        Case { name: "nest", seconds: 3.0, from: 1.7, blocks: &[777, 3000], whole: false },
    ]);
}

#[test]
fn a_sample_does_not_depend_on_the_block_it_is_mixed_in() {
    let answers = ask_scenario("audio", &[json!(["build", "fx"]), json!(["build", "speed"])]);
    for a in &answers {
        let b = built(a);
        let total = 6 * 48000;
        let whole = mix_blocks(&mut mixer(&b, false), &b, 0, total, &[total]).0;
        let mut rng = cut_oracle::Inputs::new(11);
        let sizes: Vec<usize> = (0..64).map(|_| rng.range(1, 3000) as usize).collect();
        let small = mix_blocks(&mut mixer(&b, false), &b, 0, total, &sizes).0;
        assert_eq!(whole, small, "one block and blocks of 1..3000 samples give the same samples");
        let s0 = (3.3 * 48000.0) as usize;
        let middle = mix_blocks(&mut mixer(&b, false), &b, s0 as i64, total - s0, &[2048]).0;
        assert_eq!(&whole[0][s0..], &middle[0][..], "started from 3.3 s (a seek), the same samples there");
    }
}

#[test]
fn track_and_master_meters_match() {
    let list = [("basic", 96000), ("basic", 230000), ("solo", 150000), ("fx", 100000)];
    let calls: Vec<_> = list.iter().flat_map(|(n, s)| [json!(["build", n]), json!(["meters", n, s, 4800])]).collect();
    let answers = ask_scenario("audio", &calls);
    for ((_, s0), pair) in list.iter().zip(answers.chunks(2)) {
        let b = built(&pair[0]);
        let js = &pair[1];
        let r = mixer(&b, false).mix_loaded(&b.project, b.seq, *s0, 4800, 0.0);
        let near = |a: f64, v: &serde_json::Value, eps: f64| (a - v.as_f64().unwrap_or(f64::NAN)).abs() < eps;
        for (id, [l, rr]) in &r.tracks {
            let j = &js["tracks"][id.as_str()];
            assert!(near(*l, &j[0], 1e-6) && near(*rr, &j[1], 1e-6), "track {id:?}: {l} {rr} vs {j}");
        }
        for k in 0..2 {
            assert!(near(r.master[k], &js["master"][k], 1e-6), "master {k}");
            assert!(near(r.rms[k], &js["rms"][k], 1e-7), "rms {k}");
        }
    }
}
