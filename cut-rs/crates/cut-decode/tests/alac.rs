//! ALAC through this crate's own decoder (`cut_decode::alac`), from files Media Foundation's ALAC encoder made:
//! lossless, so every sample comes back as it was written, mono and stereo; damaged frames give errors, never a
//! panic or a hang.

mod common;

use std::time::{Duration, Instant};

use common::more::{RATE, alac_mp4};
use common::signal::*;
use common::*;
use cut_decode::alac::{AlacConfig, AlacDecoder};
use cut_decode::{decode_audio, decode_audio_samples, decodes_audio};
use cut_formats::Media;
use cut_formats::probe::read_samples;

const LEN: usize = 50123;

/// A sweep at half scale, a quiet stretch, a burst of noise near full scale (the encoder's escape and its zero runs).
fn signal(seed: u64) -> Vec<i16> {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15 ^ seed);
    let s = sweep(100.0, 12000.0, 30000, 48000.0, 0.5);
    (0..LEN as i64)
        .map(|n| match n {
            0..30000 => (s(n) * 32767.0).round() as i16,
            30000..36000 => 0,
            _ => r.next() as i16,
        })
        .collect()
}

#[test]
fn alac_in_mp4_decodes_every_sample_as_written() {
    assert!(decodes_audio("alac"), "ALAC is decoded here, whatever the PC has");
    let left = signal(1);
    let right: Vec<i16> = signal(2).iter().zip(&left).map(|(n, l)| if l % 3 == 0 { *l } else { *n / 4 }).collect();
    let stereo: Vec<i16> = left.iter().zip(&right).flat_map(|(l, r)| [*l, *r]).collect();
    for (name, pcm, channels, planes) in
        [("alac-mono.mp4", left.clone(), 1, vec![&left]), ("alac-stereo.mp4", stereo, 2, vec![&left, &right])]
    {
        let path = alac_mp4(name, &pcm, channels);
        let (reader, source) = open(&path);
        let track = &source.tracks[0];
        let Media::Audio(a) = &track.media else { panic!("audio") };
        assert_eq!((track.codec.as_str(), a.sample_rate, a.channels), ("alac", RATE, channels), "{name}");
        let out = decode_audio(&reader, track).expect("decoded");
        assert_eq!((out.rate, out.channels), (RATE, channels));
        for (c, src) in planes.iter().enumerate() {
            assert_eq!(out.data[c].len(), LEN, "{name}");
            let differ = src.iter().zip(&out.data[c]).filter(|(s, d)| f32::from(**s) / 32768.0 != **d).count();
            assert_eq!(differ, 0, "channel {c} of {name}: every sample exact");
        }
        let part = decode_audio_samples(&reader, track, 3, 5).expect("a part");
        let (at, p) = &part.pieces[0];
        assert_eq!((at * f64::from(RATE)).round() as usize, 3 * 4096, "a part's first block is at its time");
        assert!(p[0].iter().zip(&left[3 * 4096..]).all(|(d, s)| f32::from(*s) / 32768.0 == *d));
    }
}

#[test]
fn damaged_alac_frames_are_errors_and_end_at_once() {
    let left = signal(3);
    let pcm: Vec<i16> = left.iter().flat_map(|l| [*l, l / 2]).collect();
    let (reader, source) = open(&alac_mp4("alac-stereo-fuzz.mp4", &pcm, 2));
    let track = &source.tracks[0];
    let config = AlacConfig::parse(track.description.as_deref().expect("a config")).expect("parsed");
    let mut frames = Vec::new();
    read_samples(&reader, track, 0, track.samples.count(), |_, b| frames.push(b.to_vec())).expect("frames");
    let mut r = Rng(0x2545_f491_4f6c_dd1d);
    let mut dec = AlacDecoder::new(config);
    let (mut errors, start) = (0, Instant::now());
    for k in 0..3000 {
        let mut f = frames[k % frames.len()].clone();
        if k % 2 == 0 {
            f.truncate(r.below(f.len() + 1));
        }
        for _ in 0..r.below(8) {
            let at = r.below(f.len());
            if let Some(b) = f.get_mut(at) {
                *b ^= 1 << r.below(8);
            }
        }
        match dec.decode(&f) {
            Ok(planes) => assert!(planes.len() == 2 && planes[0].len() <= 4096),
            Err(_) => errors += 1,
        }
        for cut in [&[][..], &[0x20][..], &[0xff; 3][..]] {
            assert!(dec.decode(cut).is_err());
        }
    }
    assert!(errors > 1000, "most damaged frames are refused: {errors}");
    assert!(start.elapsed() < Duration::from_secs(20), "3000 damaged frames in {:?}", start.elapsed());
    for bad in [&[][..], &[0u8; 23][..], &[0xffu8; 24][..]] {
        assert!(AlacConfig::parse(bad).is_err());
    }
}

/// Speed (ignored; `cargo test --release -p cut-decode --test alac -- --ignored --nocapture`): this crate's decoder
/// against Microsoft's ALAC decoder is not compared (the crate does not drive it); the figure is frames a second and
/// times real time on a stereo file of noise and a sweep, decoded whole 20 times.
#[test]
#[ignore]
fn alac_decoding_speed() {
    let left = signal(4);
    let pcm: Vec<i16> = left.iter().flat_map(|l| [*l, l.wrapping_mul(3) / 4]).collect();
    let (reader, source) = open(&alac_mp4("alac-stereo-bench.mp4", &pcm, 2));
    let track = &source.tracks[0];
    let config = AlacConfig::parse(track.description.as_deref().expect("a config")).expect("parsed");
    let mut frames = Vec::new();
    read_samples(&reader, track, 0, track.samples.count(), |_, b| frames.push(b.to_vec())).expect("frames");
    let mut dec = AlacDecoder::new(config);
    let mut runs = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let mut n = 0;
        for f in &frames {
            n += dec.decode(f).expect("a frame")[0].len();
        }
        runs.push((start.elapsed().as_secs_f64(), n));
    }
    runs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (secs, n) = runs[10];
    eprintln!(
        "ALAC stereo 16-bit: median of 20 runs {:.2} ms for {} frames ({:.0} frames/s, {:.0}x real time; {:.2} to {:.2} ms)",
        secs * 1000.0,
        frames.len(),
        frames.len() as f64 / secs,
        n as f64 / f64::from(RATE) / secs,
        runs[0].0 * 1000.0,
        runs[19].0 * 1000.0
    );
}
