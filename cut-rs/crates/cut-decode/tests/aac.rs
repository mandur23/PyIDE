//! AAC to float PCM: the length is the track's, and the encoder's priming is hidden the way the JavaScript's export
//! hides it (samples moved before 0, an edit list) and its decoder drops it (pieces placed at their pts from 0).

mod common;

use common::*;
use cut_decode::decode_audio;
use cut_formats::Media;
use cut_time::TICKS;

const RATE: u32 = 48000;
const ONSET: usize = 24000;

/// Stereo: half a second of silence, a second of 1 kHz at half scale (right channel at a quarter), half a second of
/// silence.
fn tone() -> Vec<i16> {
    let mut pcm = Vec::new();
    for n in 0..2 * RATE as usize {
        let on = (ONSET..ONSET + RATE as usize).contains(&n);
        let v = if on { (n as f64 * 2.0 * std::f64::consts::PI * 1000.0 / f64::from(RATE)).sin() } else { 0.0 };
        pcm.push((v * 16384.0) as i16);
        pcm.push((v * 8192.0) as i16);
    }
    pcm
}

fn onset(x: &[f32]) -> usize {
    x.iter().position(|v| v.abs() > 0.1).expect("sound")
}

#[test]
fn aac_decodes_to_the_tracks_length_with_the_priming_left_out() {
    let pcm = tone();
    let (reader, source) = open(&make::audio("aac-raw.m4a", &pcm, 2, 0));
    let track = &source.tracks[0];
    let raw = decode_audio(&reader, track).expect("decoded");
    let delay = onset(&raw.data[0]) as i64 - ONSET as i64;
    eprintln!(
        "encoder delay {delay} samples ({} AAC samples, rate {}, channels {})",
        track.samples.count(),
        raw.rate,
        raw.channels
    );
    assert!((0..=4096).contains(&delay), "{delay}");

    for extra in [0, 1024, 2112] {
        let shift = delay + extra;
        let (reader, source) = open(&make::audio(&format!("aac-{shift}.m4a"), &pcm, 2, shift));
        let track = &source.tracks[0];
        let Media::Audio(a) = &track.media else { panic!("audio") };
        assert_eq!((a.sample_rate, a.channels), (RATE, 2));
        let s = &track.samples;
        assert!(s.pts[0] < 0, "the priming is before 0: {}", s.pts[0]);
        let out = decode_audio(&reader, track).expect("decoded");
        assert_eq!((out.rate, out.channels, out.data.len()), (RATE, 2, 2));
        let want = (track.duration as f64 / TICKS as f64 * f64::from(RATE)).round() as usize;
        assert_eq!(out.data[0].len(), want, "the track's duration");
        assert_eq!(want as i64, s.count() as i64 * 1024 - shift, "every AAC frame but the priming");
        let at = onset(&out.data[0]);
        let expect = ONSET - extra as usize;
        eprintln!("moved {shift}: onset at {at}, expected {expect}; {} samples", out.data[0].len());
        assert!(at.abs_diff(expect) <= 16, "the tone starts where it was written: {at}");

        let mid = &out.data[0][expect + 12000..expect + 36000];
        let crossings = mid.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!(crossings.abs_diff(1000) <= 2, "1 kHz: {crossings} zero crossings in half a second");
        let peak = |c: &[f32]| c[expect + 1000..expect + 40000].iter().fold(0f32, |m, v| m.max(v.abs()));
        let (l, r) = (peak(&out.data[0]), peak(&out.data[1]));
        assert!((l - 0.5).abs() < 0.05 && (r - 0.25).abs() < 0.03, "levels {l} {r}");
    }
}
