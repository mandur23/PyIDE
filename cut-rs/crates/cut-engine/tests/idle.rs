//! A paused engine keeps only the decoders of what it shows: a source the last renders neither drew nor prefetched
//! closes its decoder and lets its frames go after `media::IDLE_CLOSE`, and opens a new one when it is shown again.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::Duration;

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind};

fn file(w: u32, h: u32, frames: u32) -> String {
    let name = format!("playback-h264-{w}x{h}-{frames}.mp4");
    let s = decode_common::make::settings(Codec::H264, w, h);
    let path = decode_common::make::video(&name, &s, frames, decode_common::make::Timing::Constant);
    path.to_str().expect("a path").to_string()
}

/// The frame number the test picture shows (`cut-decode/tests/common/make.rs draw`).
fn number(img: &[u8], w: u32, h: u32) -> u32 {
    let (top, height, block) = (h / 20, h / 10, w / 16);
    (0..16).fold(0, |n, k| {
        let (x, y) = (k * block + block / 2, top + height / 2);
        (n << 1) | u32::from(img[((y * w + x) * 4 + 1) as usize] > 128)
    })
}

#[test]
fn a_source_out_of_sight_closes_its_decoder_and_opens_again() {
    let (small, big) = (file(1280, 720, 150), file(1920, 1080, 150));
    let mut p = project(1280, 720);
    let a = media(&mut p, "a", &small, MediaKind::Video, 1280.0, 720.0, (150 * F) as f64);
    let b = media(&mut p, "b", &big, MediaKind::Video, 1920.0, 1080.0, (150 * F) as f64);
    put(&mut p, "s1", clip("ca", "V1", 0, 0.0, (30 * F) as f64, of_media(a)));
    put(&mut p, "s1", clip("cb", "V1", 60 * F, 0.0, (30 * F) as f64, of_media(b)));
    let p = reload(&p).0;
    let s1 = Id::new("s1");
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    let mut e = Engine::headless().expect("a GPU");
    let open = |e: &Engine| {
        let mut d: Vec<(bool, bool)> =
            e.decoders().iter().map(|(path, d)| (path.contains("1920x1080"), d.is_some())).collect();
        d.sort();
        d
    };
    e.render(&p, s1, 10 * F, (1280, 720), &wait).expect("a render");
    assert_eq!(number(&e.read_pixels(), 1280, 720), 10);
    e.render(&p, s1, 70 * F, (1280, 720), &wait).expect("a render");
    e.render(&p, s1, 71 * F, (1280, 720), &wait).expect("a render");
    assert_eq!(open(&e), vec![(false, true), (true, true)], "both decoders open at first");
    let before = e.memory().frames_vram + e.memory().frames_ram;
    std::thread::sleep(cut_engine::media::IDLE_CLOSE + Duration::from_millis(800));
    assert_eq!(open(&e), vec![(false, false), (true, true)], "the 720p clip out of sight closed its decoder");
    let after = e.memory().frames_vram + e.memory().frames_ram;
    assert!(after < before, "its frames went: {before} -> {after} bytes");
    e.render(&p, s1, 12 * F, (1280, 720), &wait).expect("a render");
    assert_eq!(number(&e.read_pixels(), 1280, 720), 12, "shown again from a new decoder");
    assert!(open(&e).iter().any(|&(big, on)| !big && on));
}
