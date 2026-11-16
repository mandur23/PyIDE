//! `cut-time` against `renderer/features/cut/time.js` on the same inputs.

use cut_oracle::{Inputs, ask};
use cut_time::*;
use serde_json::{Value, json};

fn fps_json(f: Fps) -> Value {
    json!([f.num, f.den])
}

/// Times that matter: around 0, around frame boundaries of the rate, and near the longest time a project holds.
fn times(rng: &mut Inputs, fps: Fps) -> Vec<Ticks> {
    let f = fps.frame_ticks().expect("an offered rate");
    let mut out = vec![0, 1, -1, f - 1, f, f + 1, f / 2, f / 2 + 1, MAX_TICKS, MAX_TICKS - 1, MAX_TICKS - f];
    for _ in 0..40 {
        let frame = rng.range(0, MAX_TICKS / f - 1);
        out.push(frame * f + rng.pick(&[0, 1, f / 2 - 1, f / 2, f / 2 + 1, f - 1]));
        out.push(rng.range(-10 * TICKS, MAX_TICKS));
    }
    out
}

#[test]
fn frames_snap_and_timecode_match_the_javascript() {
    let mut rng = Inputs::new(1);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for fps in FRAME_RATES {
        for t in times(&mut rng, fps) {
            let fj = fps_json(fps);
            calls.push(json!(["frameAt", t, fj]));
            ours.push(json!(frame_at(t, fps)));
            calls.push(json!(["snap", t, fj]));
            ours.push(json!(snap(t, fps, false)));
            calls.push(json!(["snap", t, fj, { "nearest": true }]));
            ours.push(json!(snap(t, fps, true)));
            calls.push(json!(["timecode", t, fj]));
            ours.push(json!(timecode(t, fps)));
            let frame = frame_at(t.max(0), fps);
            calls.push(json!(["frameStart", frame, fj]));
            ours.push(json!(frame_start(frame, fps)));
        }
    }
    compare("time", &calls, &ours);
}

#[test]
fn container_and_microsecond_times_match_the_javascript() {
    let mut rng = Inputs::new(2);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for scale in [1_u64, 1000, 12_800, 24_000, 30_000, 44_100, 48_000, 90_000, 600, 1_000_000, 1_000_000_000] {
        for _ in 0..60 {
            // Up to about ten hours in the scale's units, and the negative times of priming and B-frame delay.
            let value = rng.range(-(scale as i64) * 2, scale as i64 * 35_000);
            calls.push(json!(["rescale", value, scale]));
            ours.push(json!(rescale(value, scale)));
            let ticks = rng.range(-TICKS, MAX_TICKS);
            calls.push(json!(["toScale", ticks, scale]));
            ours.push(json!(to_scale(ticks, scale)));
        }
    }
    for _ in 0..200 {
        let micros = rng.range(-2_000_000, 35_000_000_000);
        calls.push(json!(["fromMicros", micros]));
        ours.push(json!(from_micros(micros)));
        let ticks = rng.range(-TICKS, MAX_TICKS);
        calls.push(json!(["toMicros", ticks]));
        ours.push(json!(to_micros(ticks)));
    }
    compare("time", &calls, &ours);
}

#[test]
fn typed_timecodes_match_the_javascript() {
    let texts = [
        "0",
        "45",
        "00:00:01:00",
        "1:00",
        "01:02:03:04",
        "1;02;03",
        "10.05",
        "+10",
        "-10",
        "+ 3",
        "- 3",
        "",
        " ",
        "abc",
        "1:x",
        "1:2:3:4:5",
        ":",
        "1:",
        "+",
        "-",
        "12 ",
        " 00:10:00:00 ",
        "99:59:59:29",
        "1.5",
        "+1.5",
        "0:0:0:0",
        "000123",
    ];
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for fps in FRAME_RATES {
        let from = 100 * fps.frame_ticks().expect("an offered rate");
        for text in texts {
            calls.push(json!(["parseTimecode", text, fps_json(fps), from]));
            ours.push(json!(parse_timecode(text, fps, from)));
        }
    }
    compare("time", &calls, &ours);
}

fn compare(module: &str, calls: &[Value], ours: &[Value]) {
    let theirs = ask(module, calls);
    let differ: Vec<String> = calls
        .iter()
        .zip(ours.iter().zip(&theirs))
        .filter(|(_, (a, b))| a != b)
        .take(10)
        .map(|(call, (a, b))| format!("{call} -> rust {a}, javascript {b}"))
        .collect();
    assert!(differ.is_empty(), "{} calls compared; the first differences:\n{}", calls.len(), differ.join("\n"));
}
