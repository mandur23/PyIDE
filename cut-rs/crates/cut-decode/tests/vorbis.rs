//! Vorbis through lewton, on streams this test suite codes itself (`common/vorbis.rs`: no Vorbis encoder is on this
//! PC): the tone comes back at its place and level, a part decoded from cold matches the whole after one packet, a
//! surround layout comes out in WebCodecs' order, and damaged packets or headers end in silence or an error, never a
//! panic or a hang.

mod common;

use std::time::{Duration, Instant};

use common::more::{RATE, vorbis_file, vorbis_tone, vorbis_webm};
use common::signal::best_lag;
use common::*;
use cut_decode::{decode_audio, decode_audio_samples, decodes_audio};
use cut_formats::{Media, MemReader, probe};
use cut_time::TICKS;

/// The gain that best maps `want` onto `got`, and the signal-to-noise ratio in dB after it.
fn fit(got: &[f32], want: impl Fn(i64) -> f64) -> (f64, f64) {
    let (mut xy, mut xx) = (0.0, 0.0);
    for (t, g) in got.iter().enumerate() {
        let w = want(t as i64);
        xy += f64::from(*g) * w;
        xx += w * w;
    }
    let gain = xy / xx;
    let noise: f64 = got.iter().enumerate().map(|(t, g)| (f64::from(*g) - gain * want(t as i64)).powi(2)).sum();
    (gain, 10.0 * (gain * gain * xx / noise.max(1e-30)).log10())
}

#[test]
fn a_stereo_stream_decodes_to_its_tones_in_place() {
    assert!(decodes_audio("vorbis"));
    let (reader, source) = open(&vorbis_webm("vorbis-tone-2ch-a.webm", 2, 120, false));
    let track = &source.tracks[0];
    let Media::Audio(a) = &track.media else { panic!("audio") };
    assert_eq!((track.codec.as_str(), a.sample_rate, a.channels), ("vorbis", RATE, 2));
    let pcm = decode_audio(&reader, track).expect("decoded");
    let want = (track.duration as f64 / TICKS as f64 * f64::from(RATE)).round() as usize;
    assert_eq!((pcm.rate, pcm.channels, pcm.data[0].len()), (RATE, 2, want));
    for (c, x) in pcm.data.iter().enumerate() {
        let (gain, snr) = fit(x, |t| vorbis_tone(c, t));
        eprintln!("channel {c}: gain {gain:.5}, {snr:.1} dB");
        assert!((gain - 1.0).abs() < 0.01, "channel {c} at its level: {gain}");
        assert!(snr > 35.0, "channel {c} is its tone: {snr} dB");
        let (lag, _) = best_lag(x, |t| vorbis_tone(c, t), 2000..40000, -50..=50);
        assert_eq!(lag, 0, "channel {c} in place");
    }
}

#[test]
fn a_part_decoded_from_cold_matches_the_whole_after_one_packet() {
    let (reader, source) = open(&vorbis_webm("vorbis-tone-2ch-a.webm", 2, 120, false));
    let track = &source.tracks[0];
    let whole = decode_audio(&reader, track).expect("decoded");
    for i0 in [1, 9, 37, 64, 100] {
        let part = decode_audio_samples(&reader, track, i0, i0 + 12).expect("a part");
        assert_eq!((part.rate, part.channels), (RATE, 2));
        let sample = |i: usize| (track.samples.pts[i] as f64 / TICKS as f64 * f64::from(RATE)).round() as usize;
        let at = (part.pieces[0].0 * f64::from(RATE)).round() as usize;
        assert!((sample(i0 + 1)..sample(i0 + 2)).contains(&at), "packet {i0} only primes the decoder: {at}");
        for (at, planes) in &part.pieces {
            let start = (at * f64::from(RATE)).round() as usize;
            for (c, p) in planes.iter().enumerate() {
                let end = (start + p.len()).min(whole.data[c].len());
                assert_eq!(&p[..end - start], &whole.data[c][start..end], "from packet {i0}, channel {c} at {start}");
            }
        }
    }
}

#[test]
fn surround_comes_out_in_webcodecs_order_and_mono_as_one_channel() {
    let (reader, source) = open(&vorbis_webm("vorbis-tone-6ch-a.webm", 6, 60, false));
    let pcm = decode_audio(&reader, &source.tracks[0]).expect("5.1 Vorbis");
    assert_eq!(pcm.channels, 6);
    // Vorbis 5.1 is L C R Ls Rs LFE; WebCodecs gives L R C LFE Ls Rs.
    for (k, from) in [0, 2, 1, 5, 3, 4].into_iter().enumerate() {
        let (gain, snr) = fit(&pcm.data[k], |t| vorbis_tone(from, t));
        assert!((gain - 1.0).abs() < 0.01 && snr > 35.0, "output {k} is Vorbis channel {from}: {gain} {snr}");
    }
    let (reader, source) = open(&vorbis_webm("vorbis-tone-1ch-a.webm", 1, 40, false));
    let pcm = decode_audio(&reader, &source.tracks[0]).expect("mono Vorbis");
    assert_eq!(pcm.channels, 1);
    assert!(fit(&pcm.data[0], |t| vorbis_tone(0, t)).1 > 35.0);
}

#[test]
fn damaged_packets_and_headers_never_panic_or_hang() {
    let stream = vorbis::encode(2, &vorbis::sizes(80), vorbis_tone);
    let private = vorbis::private(2, RATE);
    let good = vorbis_file(2, &stream, private.clone(), false);
    let clean = {
        let reader = MemReader(good.clone());
        let source = probe::open(&reader, "");
        decode_audio(&reader, &source.tracks[0]).expect("the undamaged file")
    };
    let ends: Vec<i64> = stream.packets.iter().skip(1).map(|p| p.1.unwrap_or(0)).chain([stream.length]).collect();
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let (mut decoded, mut refused, mut slowest) = (0, 0, Duration::ZERO);
    let started = Instant::now();
    for round in 0..400 {
        let mut s = vorbis::Stream { packets: stream.packets.clone(), length: stream.length };
        let mut headers = private.clone();
        let mut hurt = Vec::new();
        let kind = round % 4;
        match kind {
            0 | 1 => {
                for _ in 0..1 + rng.below(4) {
                    let k = rng.below(s.packets.len());
                    let p = &mut s.packets[k].0;
                    if kind == 0 {
                        p.truncate(rng.below(p.len() + 1));
                    } else {
                        for _ in 0..1 + rng.below(8) {
                            let at = rng.below(p.len());
                            p[at] ^= 1 << rng.below(8);
                        }
                    }
                    hurt.push(k);
                }
            }
            2 => {
                for _ in 0..1 + rng.below(6) {
                    let at = rng.below(headers.len());
                    headers[at] ^= 1 << rng.below(8);
                }
            }
            _ => headers.truncate(rng.below(headers.len())),
        }
        let mut file = vorbis_file(2, &s, headers, false);
        if round % 10 == 9 {
            file.truncate(rng.below(file.len()));
        }
        let t = Instant::now();
        let reader = MemReader(file);
        let source = probe::open(&reader, "");
        let result = source.tracks.first().map(|track| decode_audio(&reader, track));
        slowest = slowest.max(t.elapsed());
        match result {
            Some(Ok(pcm)) => {
                decoded += 1;
                // Only a damaged packet's span and the next two (the one overlapping it, and the samples a long block
                // before a short one finishes early) may differ.
                if kind < 2 && round % 10 != 9 {
                    for (m, end) in ends.iter().enumerate().skip(1) {
                        if hurt.iter().any(|&k| (k..=k + 2).contains(&m)) {
                            continue;
                        }
                        let start = stream.packets[m].1.unwrap_or(0) as usize;
                        let end = (*end as usize).min(clean.data[0].len());
                        for c in 0..2 {
                            assert_eq!(
                                &pcm.data[c][start..end],
                                &clean.data[c][start..end],
                                "round {round}, packet {m}"
                            );
                        }
                    }
                }
            }
            Some(Err(e)) => {
                refused += 1;
                assert_eq!(e.code(), "damaged", "round {round}: {e}");
            }
            None => refused += 1,
        }
    }
    eprintln!("{decoded} decoded, {refused} refused; slowest {slowest:?}, all {:?}", started.elapsed());
    assert!(slowest < Duration::from_secs(2), "no round hangs: {slowest:?}");
    assert!(decoded >= 200, "damaged packets leave the rest playable: {decoded}");
}
