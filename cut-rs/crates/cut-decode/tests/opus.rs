//! Opus through Microsoft's Opus decoder: the fixture `voice.webm` (a second of 330 Hz from time 0, mono, 20 ms
//! packets, a 312-sample pre-skip in Matroska's CodecDelay), the same packets in MP4 (an edit list for the pre-skip),
//! and mapping family 1 tracks of more than two channels, each stream through a decoder of its own.

mod common;

use common::more::{opus_mp4, opus_routed_webm, opus_streams_webm};
use common::signal::*;
use common::*;
use cut_decode::{decode_audio, decode_audio_samples, decodes_audio};
use cut_formats::Media;
use cut_time::TICKS;

fn voice() -> impl Fn(i64) -> f64 {
    tone(330.0, 48000.0, 0.125)
}

#[test]
fn voice_webm_decodes_to_its_tone_from_time_zero() {
    assert!(decodes_audio("opus"), "Microsoft's Opus decoder is listed");
    let (reader, source) = open(&fixture("video/voice.webm"));
    let track = &source.tracks[0];
    let Media::Audio(a) = &track.media else { panic!("audio") };
    assert_eq!((track.codec.as_str(), a.sample_rate, a.channels), ("opus", 48000, 1));
    assert_eq!(track.pre_roll, cut_time::from_seconds(0.08), "Opus's 80 ms pre-roll");
    assert_eq!(track.samples.pts[0], -cut_time::rescale(312, 48000), "the pre-skip is before 0");
    let pcm = decode_audio(&reader, track).expect("decoded");
    let want = (track.duration as f64 / TICKS as f64 * 48000.0).round() as usize;
    assert_eq!((pcm.rate, pcm.channels, pcm.data[0].len()), (48000, 1, want));
    let x = &pcm.data[0];
    // The first packet's 960 samples run from -312: the tone is in phase from sample 0, the pre-skip dropped once.
    let (lag, corr) = best_lag(x, voice(), 100..600, -72..=72);
    assert_eq!(lag, 0, "the tone starts at time 0 ({corr:.5})");
    assert!(corr > 0.999);
    let hz = frequency(x, 4800..43200, 48000.0);
    assert!((hz - 330.0).abs() < 2.0, "330 Hz: {hz}");
    let peak = x[4800..43200].iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!((peak - 0.125).abs() < 0.01, "an eighth of full scale: {peak}");
    // Each later packet sits at its block's time, as WebCodecs places it: the file's millisecond times put packet
    // 1 at 14.5 ms, 48 samples after where 20 ms of packet 0 ends.
    let (lag, _) = best_lag(x, voice(), 2000..20000, -72..=72);
    assert_eq!(lag, 48);

    let (mreader, msource) = open(&opus_mp4("opus-voice.mp4"));
    let mtrack = &msource.tracks[0];
    assert_eq!(mtrack.codec, "opus");
    let m = decode_audio(&mreader, mtrack).expect("decoded from MP4");
    assert_eq!(m.data[0].len(), want, "MP4 lasts as long");
    let worst = m.data[0].iter().zip(x).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
    assert!(worst < 1e-6, "MP4 and WebM give the same samples: {worst}");
}

#[test]
fn surround_opus_decodes_each_stream_into_its_channel() {
    let (reader, source) = open(&fixture("video/voice.webm"));
    let mono = decode_audio(&reader, &source.tracks[0]).expect("the mono fixture");
    let same =
        |x: &[f32]| x.len() == mono.data[0].len() && x.iter().zip(&mono.data[0]).all(|(a, b)| (a - b).abs() < 1e-6);
    // One stream routed to each channel of 5.1 (Vorbis order L C R Ls Rs LFE), the others silent: it comes out in
    // WebCodecs' order, L R C LFE Ls Rs, so the first two channels are left and right.
    for (to, out_at) in [(0, 0), (1, 2), (2, 1), (3, 4), (4, 5), (5, 3)] {
        let (reader, source) = open(&opus_routed_webm(&format!("opus-51-to{to}.webm"), 6, to));
        let out = decode_audio(&reader, &source.tracks[0]).expect("5.1 Opus");
        assert_eq!((out.rate, out.channels), (48000, 6));
        for (c, x) in out.data.iter().enumerate() {
            assert!(if c == out_at { same(x) } else { x.iter().all(|v| *v == 0.0) }, "Vorbis {to}: channel {c}");
        }
    }
    // three streams in one packet (two self-delimited), channels from streams 2, 0, 1 and one silent (four channels
    // keep their order)
    let (reader, source) = open(&opus_streams_webm("opus-3-streams.webm", 3, &[2, 0, 255, 1]));
    let track = &source.tracks[0];
    assert!(decodes_audio(&track.codec));
    let out = decode_audio(&reader, track).expect("three streams");
    assert_eq!(out.channels, 4);
    for c in [0, 1, 3] {
        assert!(same(&out.data[c]), "channel {c} is its stream, decoded as the mono file");
    }
    assert!(out.data[2].iter().all(|v| *v == 0.0));
    let part = decode_audio_samples(&reader, track, 20, 30).expect("a part");
    assert_eq!(part.pieces[0].1.len(), 4);
}

#[test]
fn a_cold_decoder_converges_within_the_pre_roll() {
    let (reader, source) = open(&fixture("video/voice.webm"));
    let track = &source.tracks[0];
    let whole = decode_audio(&reader, track).expect("decoded");
    let part = decode_audio_samples(&reader, track, 20, 40).expect("a part");
    let worst = |k: usize| {
        let (at, planes) = &part.pieces[k];
        let start = (at * 48000.0).round() as usize;
        planes[0].iter().zip(&whole.data[0][start..]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max)
    };
    // Packets 20.. decoded from cold, against the same packets decoded from the start: after the 80 ms pre-roll
    // (4 packets) within 1 % of full scale, after the 12 packets every read decodes first within 0.02 %.
    eprintln!("cold decoder error by packet: {:?}", (0..13).map(worst).collect::<Vec<_>>());
    assert!(worst(4) < 0.01, "{}", worst(4));
    assert!(worst(12) < 2e-4, "{}", worst(12));
}
