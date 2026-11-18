//! Decoding ahead as the app asks for it: the read-ahead window is set every half second of playback, not every
//! frame, so the playhead is past the window's start for most frames. Frames it has passed must not be decoded again:
//! one behind the decoder restarts it at its sync sample, and in a file with a sync sample every 8 seconds (what
//! YouTube's files have) that decoded the picture group again twice a second, until the picture fell behind.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::{Duration, Instant};

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind};

#[test]
fn playing_with_a_window_set_twice_a_second_never_restarts_the_decoder() {
    const FRAMES: i64 = 150;
    let s = decode_common::make::settings(Codec::H264, 1280, 720);
    let path = decode_common::make::video(
        &format!("playback-h264-1280x720-{FRAMES}.mp4"),
        &s,
        FRAMES as u32,
        decode_common::make::Timing::Constant,
    );
    let path = path.to_str().expect("a path").to_string();
    let mut p = project(1280, 720);
    let m = media(&mut p, "m", &path, MediaKind::Video, 1280.0, 720.0, (FRAMES * F) as f64);
    put(&mut p, "s1", clip("c", "V1", 0, 0.0, (FRAMES * F) as f64, of_media(m)));
    let p = reload(&p).0;
    let s1 = Id::new("s1");
    let mut e = Engine::headless().expect("a GPU");

    let mut shown = 0;
    for frame in 0..120 {
        let t = frame * F;
        if frame % 15 == 0 {
            e.prefetch(&p, s1, t, t + 2 * SEC, false);
        }
        // the frame's turn on screen: rendered until its picture is the right one
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let r = e.render(&p, s1, t, (1280, 720), &RenderOptions::default()).expect("a render");
            if r.complete {
                shown += 1;
                break;
            }
            assert!(Instant::now() < end, "frame {frame} did not come");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let stats = e.source_stats();
    let [_hits, _misses, decoded, _dropped, restarts] = stats[0].1;
    eprintln!("{shown} frames shown: {decoded} decoded, {restarts} decoder runs");
    assert_eq!(shown, 120);
    assert!(restarts <= 1, "the decoder started {restarts} times for one pass forward");
    assert!(decoded <= 200, "{decoded} frames were decoded to show 120");
}
