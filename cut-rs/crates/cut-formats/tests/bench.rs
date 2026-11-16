//! Timings against the JavaScript on the same bytes (run with `cargo test --release -p cut-formats --test bench --
//! --ignored --nocapture`): probing the largest fixture, writing and probing an MP4 of a million samples, and converting an hour of PCM.

mod common;

use std::time::Instant;

use common::{fixture, records};
use cut_formats::mp4::write::{Mp4Writer, Sample, VideoConfig};
use cut_formats::{MemReader, probe};
use cut_oracle::{ask_scenario, bytes};
use cut_time::TICKS;
use serde_json::json;

/// The best of `rounds` timings of `f`, in milliseconds.
fn best(rounds: usize, mut f: impl FnMut()) -> f64 {
    f();
    (0..rounds)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1e3
        })
        .fold(f64::INFINITY, f64::min)
}

fn probe_both(name: &str, file: &[u8], rounds: usize) {
    let mut samples = 0;
    let ours =
        best(rounds, || samples = probe::open(&MemReader(file), name).tracks.iter().map(|t| t.samples.count()).sum());
    let theirs = ask_scenario("formats", &[json!(["probeTime", bytes(file), rounds])])[0].as_f64().expect("ms");
    println!(
        "probe {name} ({} bytes, {samples} samples): Rust {ours:.3} ms, JavaScript {theirs:.3} ms ({:.1}x), {:.1} ns a sample here",
        file.len(),
        theirs / ours,
        ours * 1e6 / samples.max(1) as f64
    );
}

#[test]
#[ignore = "a benchmark: prints timings"]
fn probe_the_largest_fixture() {
    let file = std::fs::read(fixture("audio/tone.wav")).expect("the fixture");
    probe_both("tone.wav", &file, 200);
    let file = std::fs::read(fixture("video/clip.mp4")).expect("the fixture");
    probe_both("clip.mp4", &file, 200);
    let file = std::fs::read(fixture("video/voice.webm")).expect("the fixture");
    probe_both("voice.webm", &file, 200);
}

#[test]
#[ignore = "a benchmark: prints timings"]
fn write_and_probe_a_million_samples() {
    const N: i64 = 1_000_000;
    let (avc, _) = records();
    let f = TICKS / 30;
    let video = VideoConfig {
        codec: "avc1.640028".into(),
        width: 64,
        height: 64,
        description: Some(avc[0].clone()),
        frame_rate: Some([30, 1]),
        color_space: None,
    };
    let mut file = Vec::new();
    let write_ms = best(3, || {
        let mut w = Mp4Writer::create(Some(video.clone()), None, Vec::new(), None).expect("a writer");
        for i in 0..N {
            let s =
                Sample { data: vec![1, 2, 3], timestamp: i * f, duration: f, key: i % 60 == 0, composition_offset: 0 };
            w.add_video(s).expect("written");
        }
        w.finish().expect("finished");
        file = w.into_sink();
    });
    let js_write = ask_scenario("formats", &[json!(["writeTime", N, bytes(&avc[0])])])[0].as_f64().expect("ms");
    println!(
        "write {N} samples ({} bytes): Rust {write_ms:.1} ms, JavaScript {js_write:.1} ms ({:.1}x), {:.1} ns a sample here",
        file.len(),
        js_write / write_ms,
        write_ms * 1e6 / N as f64
    );
    probe_both("a million samples", &file, 5);
}

#[test]
#[ignore]
fn pcm_to_float_one_hour() {
    use cut_formats::codecs::pcm::pcm_to_float;
    // a WAV's sample table holds pieces of at most 1 MiB; an hour of 48 kHz stereo is 659 of them
    let mut r = cut_oracle::Inputs::new(3);
    for (codec, bytes) in [("pcm-s16", 2usize), ("pcm-s24", 3), ("pcm-f32", 4)] {
        let piece: Vec<u8> = (0..(1 << 20) / (bytes * 2) * bytes * 2).map(|_| r.range(0, 255) as u8).collect();
        let pieces = 3600 * 48000 * 2 * bytes / piece.len();
        let mut n = 0;
        let ms = best(3, || {
            n = 0;
            for _ in 0..pieces {
                n += pcm_to_float(&piece, codec, 2).expect("pcm")[0].len();
            }
        });
        println!(
            "pcm_to_float, an hour of 48 kHz stereo {codec}: {ms:.0} ms ({:.2} ns a sample)",
            ms * 1e6 / (n * 2) as f64
        );
    }
}
