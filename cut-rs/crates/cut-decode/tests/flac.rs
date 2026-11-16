//! FLAC through Microsoft's FLAC decoder, in Matroska and in MP4, from Media Foundation's FLAC encoder: lossless, so
//! every sample comes back as it was written, at its place, for the track's whole length.

mod common;

use common::more::{RATE, flac_mkv, flac_mp4};
use common::signal::*;
use common::*;
use cut_decode::{decode_audio, decode_audio_samples, decodes_audio};
use cut_formats::Media;
use cut_time::TICKS;
use std::time::Duration;

const LEN: usize = 72123;
const START: i64 = 12000;

/// Left: a sweep from 200 Hz to 8 kHz at half scale from sample 12000 for a second; right: 1 kHz at a quarter.
fn stereo() -> (Vec<i16>, Vec<i16>, Vec<i16>) {
    let left = pcm16(sweep(200.0, 8000.0, 48000, 48000.0, 0.5), START, LEN);
    let right = pcm16(|n| if (0..48000).contains(&n) { tone(1000.0, 48000.0, 0.25)(n) } else { 0.0 }, START, LEN);
    let pcm = left.iter().zip(&right).flat_map(|(l, r)| [*l, *r]).collect();
    (pcm, left, right)
}

/// Decodes a FLAC Matroska file held in memory on a thread of its own: the result, or `None` when it did not end
/// within `limit` (the thread is left behind).
fn decode_within(file: Vec<u8>, limit: std::time::Duration) -> Option<Result<cut_decode::Pcm, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reader = cut_formats::MemReader(file);
        let source = cut_formats::probe::open(&reader, "damaged.mkv");
        let r = match source.tracks.first() {
            Some(t) => decode_audio(&reader, t).map_err(|e| e.to_string()),
            None => Err("no track".into()),
        };
        let _ = tx.send(r);
    });
    rx.recv_timeout(limit).ok()
}

#[test]
fn damaged_flac_frames_become_silence_in_place_and_never_hang() {
    let (pcm, left, _) = stereo();
    let (head, frames) = common::more::flac(&pcm, 2);
    let mut rng = Rng(0x5851_f42d_4c95_7f2d);
    let mut worst = Duration::ZERO;
    for round in 0..30 {
        let (mut head, mut damaged, mut hit) = (head.clone(), frames.clone(), vec![false; frames.len()]);
        if round % 5 == 4 {
            // the metadata: STREAMINFO or the blocks after it
            for _ in 0..1 + rng.below(6) {
                let at = rng.below(head.len());
                head[at] ^= 1 << rng.below(8);
            }
        } else {
            for _ in 0..1 + rng.below(4) {
                let k = rng.below(damaged.len());
                let f = &mut damaged[k];
                hit[k] = true;
                match round % 5 {
                    0 => f.truncate(rng.below(f.len())),
                    1 => {
                        for _ in 0..1 + rng.below(16) {
                            let at = rng.below(f.len());
                            f[at] ^= 1 << rng.below(8);
                        }
                    }
                    2 => {
                        let from = rng.below(f.len());
                        f[from..].iter_mut().for_each(|b| *b ^= 0x5a);
                    }
                    _ => f.clear(),
                }
            }
        }
        let file = common::more::flac_mkv_of(head, damaged, 2, LEN as i64);
        let start = std::time::Instant::now();
        let got = decode_within(file, Duration::from_secs(10));
        worst = worst.max(start.elapsed());
        let got = got.unwrap_or_else(|| panic!("round {round}: the decoder did not end within 10 s"));
        if round % 5 == 4 {
            continue;
        }
        let out = got.unwrap_or_else(|e| panic!("round {round}: {e}"));
        assert_eq!(out.data[0].len(), LEN, "round {round}: the track keeps its length");
        for (k, block) in out.data[0].chunks(4096).enumerate() {
            let src = &left[k * 4096..];
            let exact = block.iter().zip(src).all(|(d, s)| (f32::from(*s) / 32768.0 - d).abs() < 1e-6);
            let silent = block.iter().all(|d| *d == 0.0);
            assert!(if hit[k] { silent } else { exact }, "round {round}, frame {k} (damaged: {})", hit[k]);
        }
    }
    eprintln!("30 damaged files decoded, the slowest in {worst:?}");
}

#[test]
fn flac_in_matroska_and_mp4_decodes_every_sample_in_place() {
    assert!(decodes_audio("flac"), "Microsoft's FLAC decoder is listed");
    let (pcm, left, right) = stereo();
    for path in [flac_mkv("flac-stereo.mkv", &pcm, 2), flac_mp4("flac-stereo.mp4", &pcm, 2)] {
        let (reader, source) = open(&path);
        let track = &source.tracks[0];
        let Media::Audio(a) = &track.media else { panic!("audio") };
        assert_eq!((track.codec.as_str(), a.sample_rate, a.channels), ("flac", RATE, 2), "{path:?}");
        let out = decode_audio(&reader, track).expect("decoded");
        assert_eq!((out.rate, out.channels), (RATE, 2));
        let want = (track.duration as f64 / TICKS as f64 * f64::from(RATE)).round() as usize;
        assert_eq!(want, LEN, "the track lasts what was written: {path:?}");
        assert_eq!(out.data[0].len(), LEN, "{path:?}");
        for (c, src) in [(0, &left), (1, &right)] {
            let worst =
                src.iter().zip(&out.data[c]).map(|(s, d)| (f32::from(*s) / 32768.0 - d).abs()).fold(0f32, f32::max);
            assert!(worst < 1e-6, "channel {c} of {path:?} differs by {worst}");
        }
        let (lag, corr) =
            best_lag(&out.data[0], sweep(200.0, 8000.0, 48000, 48000.0, 0.5), 12000..60000, START - 50..=START + 50);
        assert_eq!(lag, START, "the sweep starts at its sample ({corr})");
        let hz = frequency(&out.data[1], 20000..44000, 48000.0);
        assert!((hz - 1000.0).abs() < 5.0, "1 kHz on the right: {hz}");

        let part = decode_audio_samples(&reader, track, 5, 9).expect("a part");
        let (at, planes) = &part.pieces[0];
        let first = (at * f64::from(RATE)).round() as usize;
        assert_eq!(first, 5 * 4096, "a part's first block is at its sample's time");
        assert!(planes[0].iter().zip(&left[first..]).all(|(d, s)| (f32::from(*s) / 32768.0 - d).abs() < 1e-6));
    }
}
