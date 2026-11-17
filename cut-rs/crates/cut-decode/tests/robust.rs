//! Bad input never panics or hangs: damaged samples go to the decoder (which conceals or skips them) or come back
//! as `damaged`; tracks this crate does not decode come back as `unsupported`.

mod common;

use common::*;
use cut_decode::{Accel, DecodeError, VideoDecoder, decode_audio};
use cut_formats::probe::read_sample;

#[test]
fn truncated_and_bit_flipped_samples_do_not_panic_or_hang() {
    let (reader, source) = open(&fixture("video/clip.mp4"));
    let track = video(&source);
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for accel in [Accel::Software, Accel::Auto] {
        for round in 0..8 {
            let mut dec = VideoDecoder::new(track, accel).expect("a decoder");
            let (mut frames, mut damaged, mut failed) = (0, 0, 0);
            for i in 0..track.samples.count() {
                let mut b = read_sample(&reader, track, i).expect("a sample").into_owned();
                // The sync sample stays whole: the decoder then has a picture to conceal the damage with.
                match if i == 0 { 2 } else { rng.next() % 3 } {
                    0 => b.truncate((rng.next() % (b.len() as u64 + 1)) as usize),
                    1 => {
                        for _ in 0..1 + round {
                            let at = (rng.next() % b.len().max(1) as u64) as usize;
                            if let Some(x) = b.get_mut(at) {
                                *x ^= 1 << (rng.next() % 8);
                            }
                        }
                    }
                    _ => {}
                }
                match dec.send(i, &b) {
                    Ok(()) => {}
                    Err(DecodeError::Damaged(_)) => damaged += 1,
                    Err(_) => failed += 1,
                }
                while let Ok(Some(_)) = dec.receive() {
                    frames += 1;
                }
            }
            let _ = dec.finish();
            while let Ok(Some(_)) = dec.receive() {
                frames += 1;
            }
            eprintln!("{accel:?} round {round}: {frames} frames, {damaged} damaged samples refused, {failed} errors");
            assert!(frames > 0, "the decoder goes on after damage");
        }
    }
}

#[test]
fn tracks_this_crate_does_not_decode_are_unsupported() {
    let (reader, source) = open(&fixture("video/voice.webm"));
    let mut t = source.tracks[0].clone();
    t.codec = "ac-3".into();
    assert_eq!(decode_audio(&reader, &t).map(|_| ()).unwrap_err().code(), "unsupported");
    let (_, clip) = open(&fixture("video/clip.mp4"));
    let v = video(&clip);
    assert_eq!(decode_audio(&reader, v).map(|_| ()).unwrap_err().code(), "unsupported");
}
