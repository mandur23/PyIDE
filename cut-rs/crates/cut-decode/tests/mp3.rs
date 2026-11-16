//! MP3 through Media Foundation's MP3 decoder, from its MP3 encoder (ACM wrapper, 128 kbit/s): a bare stream, and the
//! same stream behind an Info frame with a LAME tag, where the format crate's gapless rule (skip the tag's delay plus
//! the decoder's 529, trim the tag's padding) must put the sweep at the very sample it was written at.

mod common;

use common::more::{RATE, mp3};
use common::signal::*;
use common::*;
use cut_decode::{decode_audio, decodes_audio};
use cut_formats::Media;
use cut_time::TICKS;

const LEN: usize = 96077;
const START: i64 = 24000;

/// Left: a sweep from 200 Hz to 6 kHz at half scale from sample 24000 for a second; right: 440 Hz at a quarter.
fn stereo() -> Vec<i16> {
    let left = pcm16(sweep(200.0, 6000.0, 48000, 48000.0, 0.5), START, LEN);
    let right = pcm16(|n| if (0..48000).contains(&n) { tone(440.0, 48000.0, 0.25)(n) } else { 0.0 }, START, LEN);
    left.iter().zip(&right).flat_map(|(l, r)| [*l, *r]).collect()
}

fn reference() -> impl Fn(i64) -> f64 {
    sweep(200.0, 6000.0, 48000, 48000.0, 0.5)
}

#[test]
fn mp3_decodes_and_its_lame_tag_puts_the_sound_at_its_sample() {
    assert!(decodes_audio("mp3"), "Media Foundation's MP3 decoder is listed");
    let pcm = stereo();
    let (reader, source) = open(&mp3("mp3-raw.mp3", &pcm, 2, None));
    let track = &source.tracks[0];
    let Media::Audio(a) = &track.media else { panic!("audio") };
    assert_eq!((track.codec.as_str(), a.sample_rate, a.channels), ("mp3", RATE, 2));
    let frames = track.samples.count();
    let raw = decode_audio(&reader, track).expect("decoded");
    assert_eq!((raw.rate, raw.channels), (RATE, 2));
    assert_eq!(raw.data[0].len(), frames * 1152, "a stream without a tag lasts all its frames");
    let (at, corr) = best_lag(&raw.data[0], reference(), 30000..70000, START..=START + 4000);
    let total = at - START;
    eprintln!(
        "{frames} frames; the sweep comes out {total} samples late (encoder delay + decoder delay), corr {corr:.4}"
    );
    assert!(corr > 0.95, "the sweep is there: {corr}");
    assert!((529..=4000).contains(&total), "{total}");
    let hz = frequency(&raw.data[1], at as usize + 4800..at as usize + 43200, 48000.0);
    assert!((hz - 440.0).abs() < 3.0, "440 Hz on the right: {hz}");

    let delay = (total - 529) as u32;
    let (reader, source) = open(&mp3(&format!("mp3-lame-{delay}.mp3"), &pcm, 2, Some(delay)));
    let track = &source.tracks[0];
    assert_eq!(track.samples.count(), frames, "the Info frame is not a sample");
    let s = &track.samples;
    assert_eq!(s.pts[0], -cut_time::rescale(i64::from(delay) + 529, RATE.into()), "the delay plus 529 is before 0");
    let padding = frames as i64 * 1152 - i64::from(delay) - LEN as i64;
    let want = frames as i64 * 1152 - (i64::from(delay) + 529) - padding;
    let duration = (track.duration as f64 / TICKS as f64 * f64::from(RATE)).round() as i64;
    assert_eq!(duration, want, "the length the format crate's rule gives");
    let out = decode_audio(&reader, track).expect("decoded");
    assert_eq!(out.data[0].len() as i64, want);
    let (at, corr) = best_lag(&out.data[0], reference(), 30000..70000, START - 600..=START + 600);
    assert_eq!(at, START, "gapless: the sweep starts at the sample it was written at ({corr:.4})");
    let quiet = out.data[0][..START as usize - 200].iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!(quiet < 0.01, "silence before the sweep: {quiet}");
}
