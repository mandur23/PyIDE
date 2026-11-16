//! Going backwards (ignored; `cargo test --release -p cut-engine --test scrub -- --ignored --nocapture`): one 1080p
//! H.264 clip (a sync sample every 30 frames), the frame stepped back one at a time and scrubbed back three at a
//! time, each render waiting for its exact frame; the time of each step.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::{Duration, Instant};

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind, Project};

fn project_of(w: u32, h: u32) -> Project {
    let name = format!("playback-h264-{w}x{h}-150.mp4");
    let s = decode_common::make::settings(Codec::H264, w, h);
    let path = decode_common::make::video(&name, &s, 150, decode_common::make::Timing::Constant);
    let mut p = project(i64::from(w), i64::from(h));
    let m = media(
        &mut p,
        "m",
        path.to_str().expect("a path"),
        MediaKind::Video,
        f64::from(w),
        f64::from(h),
        (150 * F) as f64,
    );
    put(&mut p, "s1", clip("c", "V1", 0, 0.0, (150 * F) as f64, of_media(m)));
    reload(&p).0
}

fn steps(e: &mut Engine, p: &Project, frames: impl Iterator<Item = i64>) -> (Duration, Duration, Duration) {
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    let mut times = Vec::new();
    for f in frames {
        let t0 = Instant::now();
        e.render(p, Id::new("s1"), f * F, (1920, 1080), &wait).expect("a render");
        times.push(t0.elapsed());
    }
    let total = times.iter().sum();
    times.sort();
    (times[times.len() / 2], times[times.len() - 1], total)
}

#[test]
#[ignore]
fn step_and_scrub_backwards() {
    let p = project_of(1920, 1080);
    let mut e = Engine::headless().expect("a GPU");
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    for round in 0..5 {
        e.render(&p, Id::new("s1"), 119 * F, (1920, 1080), &wait).expect("a render");
        let (m, w, t) = steps(&mut e, &p, (60..119).rev());
        eprintln!("round {round}: step back 59 frames: median {m:?}, worst {w:?}, all {t:?}");
        e.render(&p, Id::new("s1"), 149 * F, (1920, 1080), &wait).expect("a render");
        let (m, w, t) = steps(&mut e, &p, (0..149).rev().step_by(3));
        eprintln!("round {round}: scrub back 3 at a time: median {m:?}, worst {w:?}, all {t:?}");
        let (m, w, t) = steps(&mut e, &p, 0..60);
        eprintln!("round {round}: step forward 60 frames: median {m:?}, worst {w:?}, all {t:?}");
        let mem = e.memory();
        eprintln!("round {round}: frames on the GPU {} MB", mem.frames_vram >> 20);
    }
}
