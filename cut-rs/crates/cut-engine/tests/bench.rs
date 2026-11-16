//! Speed (ignored; run with `cargo test --release -p cut-engine --test bench -- --ignored --nocapture`): frames a
//! second drawing a 1080p sequence of three video layers with Lumetri Color on each, decoding included, and the time
//! from a random seek to its first frame.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::{Duration, Instant};

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind, Props};
use cut_oracle::Inputs;
use serde_json::json;

#[test]
#[ignore]
fn three_1080p_layers_with_colour() {
    let path = decode_common::make::video(
        "engine-h264-1920x1080.mp4",
        &decode_common::make::settings(Codec::H264, 1920, 1080),
        90,
        decode_common::make::Timing::Constant,
    );
    let mut p = project(1920, 1080);
    let m = media(&mut p, "m1", path.to_str().expect("a path"), MediaKind::Video, 1920.0, 1080.0, (3 * SEC) as f64);
    for (i, track) in ["V1", "V2", "V3"].iter().enumerate() {
        let mut c = clip(&format!("c{i}"), track, 0, 0.0, (3 * SEC) as f64, of_media(m));
        if let Props::Video(v) = &mut c.props {
            v.scale = [100.0 - 25.0 * i as f64; 2];
            v.opacity = 90.0;
        }
        c.effects.push(effect(
            "e1",
            "color.basic",
            json!({ "exposure": 0.3, "contrast": 15, "saturation": 120, "temperature": 10 * i as i64 }),
        ));
        put(&mut p, "s1", c);
    }
    let (p, _) = reload(&p);
    let s1 = Id::new("s1");
    let mut e = Engine::headless().expect("a GPU");
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    // warm up: pipelines, decoders
    e.render(&p, s1, 0, (1920, 1080), &wait).expect("a render");
    let _ = e.read_pixels();

    // five runs through the clip, each from a seek back to frame 1 (the decoders restart there)
    let n = 89;
    let mut runs = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        for f in 1..=n {
            let t = f * F;
            e.prefetch(&p, s1, t, t + 2 * SEC, false);
            let r = e.render(&p, s1, t, (1920, 1080), &wait).expect("a render");
            assert!(r.complete && r.failed.is_empty(), "frame {f} drawn whole");
        }
        // the GPU's work done, as a frame shown on screen would need it
        let _ = e.read_pixels();
        runs.push(f64::from(n as u32) / start.elapsed().as_secs_f64());
    }
    runs.sort_by(f64::total_cmp);
    eprintln!(
        "1080p, 3 video layers + Lumetri Color each, decoding included: median {:.1} fps over 5 runs of {n} frames (range {:.1} to {:.1})",
        runs[2], runs[0], runs[4]
    );
    // the compositor alone: the same frame again (its planes are on the GPU already), so no decoding and no upload
    let t = 45 * F;
    e.render(&p, s1, t, (1920, 1080), &wait).expect("a render");
    let start = Instant::now();
    for _ in 0..200 {
        e.render(&p, s1, t, (1920, 1080), &wait).expect("a render");
    }
    let _ = e.read_pixels();
    eprintln!(
        "the same 1080p frame redrawn (3 layers, 3 Lumetri passes, no decode): {:.1} fps",
        200.0 / start.elapsed().as_secs_f64()
    );

    let mut r = Inputs::new(7);
    let mut times = Vec::new();
    for _ in 0..10 {
        let t = r.range(0, 89) * F;
        let mut fresh = Engine::headless().expect("a GPU");
        fresh.render(&p, s1, 0, (1920, 1080), &RenderOptions::default()).expect("pipelines made");
        let t0 = Instant::now();
        fresh.render(&p, s1, t, (1920, 1080), &wait).expect("a render");
        let _ = fresh.read_pixels();
        times.push(t0.elapsed());
        // the same engine seeking elsewhere: its decoders restart at a sync sample
        let t1 = Instant::now();
        let to = r.range(0, 89) * F;
        e.render(&p, s1, to, (1920, 1080), &wait).expect("a render");
        let _ = e.read_pixels();
        times.push(t1.elapsed());
    }
    times.sort();
    eprintln!(
        "random seek to first frame (3 decoders): median {:?}, worst {:?}",
        times[times.len() / 2],
        times[times.len() - 1]
    );
}
