//! The presets against presets.js: every preset at every frame rate with random and nasty overrides, the levels, the
//! checks of typed settings, the estimates and the sequence for a media item.

mod common;

use common::compare;
use cut_export::presets::{self, Overrides, Settings};
use cut_oracle::{Inputs, ask};
use cut_time::{FRAME_RATES, Fps, TICKS};
use serde_json::{Value, json};

fn rates() -> Vec<Fps> {
    let mut v = FRAME_RATES.to_vec();
    v.extend([Fps::new(1, 1), Fps::new(120, 1), Fps::new(31, 1), Fps::new(32, 1), Fps::new(7, 3)]);
    v
}

fn overrides(r: &mut Inputs) -> Value {
    let mut o = serde_json::Map::new();
    let maybe = |r: &mut Inputs| r.range(0, 2) == 0;
    let num = |r: &mut Inputs, lo: i64, hi: i64, scale: f64| json!(r.range(lo, hi) as f64 / scale);
    if maybe(r) {
        o.insert("w".into(), num(r, 0, 90000, 10.0));
    }
    if maybe(r) {
        o.insert("h".into(), num(r, 0, 90000, 10.0));
    }
    if maybe(r) {
        o.insert("codec".into(), json!(r.pick(&["h264", "hevc"])));
    }
    if maybe(r) {
        o.insert("bitrate".into(), num(r, 0, 500_000_000, 1.0));
    }
    if maybe(r) {
        o.insert("mode".into(), json!(r.pick(&["variable", "constant"])));
    }
    if maybe(r) {
        o.insert("keySeconds".into(), num(r, 0, 100, 10.0));
    }
    if maybe(r) {
        o.insert("audioBitrate".into(), num(r, 0, 300_000, 1.0));
    }
    match r.range(0, 3) {
        0 => {
            o.insert("loudness".into(), Value::Null);
        }
        1 => {
            o.insert("loudness".into(), json!(r.pick(&[-14, -24, -18])));
        }
        _ => {}
    }
    Value::Object(o)
}

#[test]
fn resolve_validate_and_estimates_match_presets_js() {
    let mut r = Inputs::new(7);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for p in presets::EXPORT {
        for fps in rates() {
            for k in 0..12 {
                let o = if k == 0 { json!({}) } else { overrides(&mut r) };
                let size = if k % 3 == 1 { None } else { Some((r.range(16, 4000) as f64, r.range(16, 4000) as f64)) };
                let seq = match size {
                    Some((w, h)) => json!({ "fps": [fps.num, fps.den], "w": w, "h": h }),
                    None => json!({ "fps": [fps.num, fps.den] }),
                };
                let parsed: Overrides = serde_json::from_value(o.clone()).expect("overrides");
                let s = presets::resolve(&p, fps, size, &parsed);
                let sj = serde_json::to_value(&s).expect("json");
                calls.push(json!(["resolve", p.id, seq, o]));
                ours.push(sj.clone());
                calls.push(json!(["validate", sj.clone()]));
                ours.push(json!(presets::validate(&s)));
                let ticks = r.range(-TICKS, 4000 * TICKS);
                calls.push(json!(["estimate", sj.clone(), ticks]));
                ours.push(json!(presets::estimate(&s, ticks)));
                let speed = r.pick(&[0.0, -1.0, 1e7, 2e8, 1920.0 * 1080.0 * 30.0 * 2.0]);
                calls.push(json!(["estimateSeconds", sj, ticks, { "speed": speed }]));
                ours.push(json!(presets::estimate_seconds(&s, ticks, Some(speed))));
            }
        }
    }
    // typed settings that break each rule
    for _ in 0..300 {
        let mut s: Settings = serde_json::from_value(ours[0].clone()).expect("settings");
        s.width = r.range(0, 9000) as u32;
        s.height = r.range(0, 9000) as u32;
        if let Some(v) = &mut s.video {
            v.bitrate = r.pick(&[10, 99_999, 100_000, 400_000_000, 400_000_001, 5_000_000]);
        }
        if let Some(a) = &mut s.audio {
            a.bitrate = r.pick(&[96_000, 128_000, 160_000, 192_000, 256_000]);
        }
        if r.range(0, 4) == 0 {
            s.audio = None;
        }
        calls.push(json!(["validate", serde_json::to_value(&s).expect("json")]));
        ours.push(json!(presets::validate(&s)));
    }
    let theirs = ask("presets", &calls);
    let n = compare("presets", &calls, &ours, &theirs);
    eprintln!("{n} presets.js comparisons");
}

#[test]
fn levels_and_sequence_for_match_presets_js() {
    let mut r = Inputs::new(11);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for _ in 0..2000 {
        let (w, h) = (r.range(1, 9000) as f64, r.range(1, 9000) as f64);
        let fps = r.range(1, 2400) as f64 / 10.0;
        let br = r.range(0, 1_200_000_000) as f64;
        calls.push(json!(["avcLevel", w, h, fps, br]));
        ours.push(json!(presets::avc_level(w, h, fps, br)));
        calls.push(json!(["hevcLevel", w, h, fps, br]));
        ours.push(json!(presets::hevc_level(w, h, fps, br)));
        calls.push(json!(["avcCodec", w, h, fps, br]));
        ours.push(json!(presets::avc_codec(w, h, fps, br)));
        calls.push(json!(["hevcCodec", w, h, fps, br]));
        ours.push(json!(presets::hevc_codec(w, h, fps, br)));
        let rot = r.pick(&[0.0, 90.0, 180.0, 270.0]);
        let mfps = r.pick(&[None, Some(23.976), Some(59.9), Some(25.0), Some(1000.0), Some(29.97), Some(0.5)]);
        let media = match mfps {
            Some(f) => json!({ "video": { "w": w, "h": h, "fps": [f, 1], "rotation": rot } }),
            None => json!({ "video": { "w": w, "h": h, "rotation": rot } }),
        };
        let (sw, sh, sf) = presets::sequence_for(Some((w, h, mfps, rot)));
        calls.push(json!(["sequenceFor", media]));
        ours.push(json!({ "w": sw, "h": sh, "fps": [sf.num, sf.den] }));
    }
    calls.push(json!(["sequenceFor", {}]));
    let (sw, sh, sf) = presets::sequence_for(None);
    ours.push(json!({ "w": sw, "h": sh, "fps": [sf.num, sf.den] }));
    calls.push(json!(["sequences"]));
    ours.push(json!(
        presets::SEQUENCE
            .map(|s| json!({ "id": s.id, "name": s.name, "w": s.w, "h": s.h, "fps": [s.fps.num, s.fps.den] }))
    ));
    let theirs = ask("presets", &calls);
    let n = compare("levels", &calls, &ours, &theirs);
    eprintln!("{n} presets.js comparisons");
}

/// The cases of verify/cut-export-core.mjs's presets block.
#[test]
fn the_javascript_tests_cases() {
    let none = Overrides::default();
    let f30 = Fps::new(30, 1);
    let yt = presets::get("youtube-1080p").expect("preset");
    let s30 = presets::resolve(yt, f30, Some((1920.0, 1080.0)), &none);
    let v = s30.video.clone().expect("video");
    assert_eq!(
        (s30.width, s30.height, v.codec.as_str(), v.bitrate, v.key_interval),
        (1920, 1080, "avc1.640028", 10_000_000, 60)
    );
    let s60 = presets::resolve(yt, Fps::new(60, 1), None, &none).video.expect("video");
    assert_eq!((s60.codec.as_str(), s60.bitrate, s60.key_interval), ("avc1.64002a", 15_000_000, 120));
    let hevc = Overrides { codec: Some(presets::Family::Hevc), ..Overrides::default() };
    assert_eq!(presets::resolve(yt, f30, None, &hevc).video.expect("v").codec, "hvc1.1.6.L120.B0");
    let custom = Overrides {
        w: Some(1281.0),
        h: Some(721.0),
        audio_bitrate: Some(150_000.0),
        mode: Some(presets::RateMode::Constant),
        ..Overrides::default()
    };
    let c = presets::resolve(yt, f30, None, &custom);
    assert_eq!((c.width, c.height, c.audio.as_ref().map(|a| a.bitrate)), (1282, 722, Some(160_000)));
    assert!(presets::validate(&c).is_empty());
    let bytes = presets::estimate(&s30, 60 * TICKS) as f64;
    assert!((bytes / 1e6 - (10e6 + 192_000.0) * 60.0 / 8.0 / 1e6).abs() < 0.1);
    let secs = presets::estimate_seconds(&s30, 60 * TICKS, Some(1920.0 * 1080.0 * 30.0 * 2.0));
    assert!((secs - 30.0).abs() < 1e-6);
    let off = Overrides { loudness: Some(None), ..Overrides::default() };
    assert_eq!(presets::resolve(yt, f30, None, &off).loudness, None);
}
