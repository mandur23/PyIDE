//! Decoding speed: `cargo test -p cut-decode --release --test bench -- --ignored --nocapture`. A 1080p30 H.264 file
//! (and HEVC) of 300 frames with B-frames, made here, decoded sequentially; frames are dropped as they come (a GPU
//! frame stays on the GPU; a software frame is copied out of the decoder, as the engine would). The clock stops
//! after the last frame is read back, so queued GPU work is counted.

mod common;

use std::time::Instant;

use common::*;
use cut_decode::{Accel, Codec, VideoDecoder};
use cut_formats::probe::read_samples;

fn run(reader: &cut_formats::FileReader, track: &cut_formats::Track, accel: Accel, low: bool) -> Option<(f64, String)> {
    let mut dec = VideoDecoder::with_latency(track, accel, Some(low)).ok()?;
    let path = format!("{:?} low latency {low}", dec.path());
    let start = Instant::now();
    let mut n = 0;
    let mut last = None;
    read_samples(reader, track, 0, track.samples.count(), |i, b| {
        dec.send(i, b).expect("sent");
        while let Some(f) = dec.receive().expect("a frame") {
            n += 1;
            last = Some(f);
        }
    })
    .expect("read");
    dec.finish().expect("drained");
    while let Some(f) = dec.receive().expect("a frame") {
        n += 1;
        last = Some(f);
    }
    // A GPU frame comes out when its decode is queued; copying the last one back waits for all of them.
    last.expect("frames").to_memory().expect("read back");
    assert_eq!(n, track.samples.count());
    Some((n as f64 / start.elapsed().as_secs_f64(), path))
}

#[test]
#[ignore]
fn bench_1080p_sequential_decoding() {
    for (codec, name, b) in [(Codec::H264, "bench-h264-1080p.mp4", 2), (Codec::Hevc, "bench-hevc-1080p.mp4", 0)] {
        let s =
            cut_decode::encode::VideoSettings { bitrate: 10_000_000, b_frames: b, ..make::settings(codec, 1920, 1080) };
        let t = Instant::now();
        let path = make::video(name, &s, 300, make::Timing::Constant);
        eprintln!(
            "{name}: ready in {:.1} s, {} bytes",
            t.elapsed().as_secs_f64(),
            std::fs::metadata(&path).unwrap().len()
        );
        let (reader, source) = open(&path);
        let track = video(&source);
        let mut accels = vec![Accel::Software];
        accels.extend((0..cut_decode::adapters().len() as u32).map(|a| Accel::Hardware { adapter: Some(a) }));
        for (accel, low) in accels.into_iter().flat_map(|a| [(a, true), (a, false)]) {
            for round in 0..2 {
                match run(&reader, track, accel, low) {
                    Some((fps, path)) => eprintln!("  {codec:?} round {round}: {fps:7.1} frames/s  {path}"),
                    None => eprintln!("  {codec:?} {accel:?}: no decoder"),
                }
            }
        }
    }
}
