//! VP8 and VP9 in WebM through the VP9 Video Extensions' decoder, from its encoder: every frame's number blocks come
//! back in order, on the GPU and in software, and a frame source seeks to any frame; AV1 says what it needs when no
//! decoder is listed.

mod common;

use common::more::vpx_webm;
use common::*;
use cut_decode::{Accel, Codec, Path};

const FRAMES: u32 = 45;

#[test]
fn vp8_and_vp9_in_webm_decode_every_frame_in_order() {
    for (codec, name) in [(Codec::Vp9, "vp9-320.webm"), (Codec::Vp8, "vp8-320.webm")] {
        eprintln!("{codec:?} decoders {:?}", cut_decode::decoders(codec));
        let (reader, file) = open(&vpx_webm(name, codec, 320, 240, FRAMES));
        let track = video(&file);
        assert_eq!(Codec::of(&track.codec), Some(codec), "{}", track.codec);
        for accel in [Accel::Auto, Accel::Software] {
            let (frames, path) = decode_all(&reader, track, accel);
            eprintln!("{codec:?} {accel:?}: {path}, {} frames", frames.len());
            assert_eq!(frames.len(), FRAMES as usize, "{codec:?} {accel:?}");
            for (k, f) in frames.iter().enumerate() {
                assert_eq!((f.width, f.height), (320, 240));
                assert_eq!(make::read_number(f), k as u32, "{codec:?} {accel:?} frame {k}");
                assert_eq!(f.sample, k);
            }
            if accel == Accel::Software {
                assert!(frames.iter().all(|f| !f.gpu));
            }
            if codec == Codec::Vp9 && accel == Accel::Auto {
                write_png(&format!("{codec:?}-{accel:?}-frame-30.png").to_lowercase(), &frames[30]);
            }
        }
        let mut fs = source(&reader, track, Accel::Auto);
        for k in [40usize, 3, 31, 30, 44, 0] {
            let t = track.samples.pts[k];
            let f = got(fs.frame_at(t).expect("a frame"));
            assert_eq!(make::read_number(&f), k as u32, "{codec:?} frame_at frame {k}");
        }
        if let Path::Hardware { adapter, .. } = fs.decoder().path() {
            eprintln!("{codec:?} on the GPU: {adapter}");
        }
    }
}

#[test]
fn a_missing_decoder_names_the_extension() {
    assert!(Codec::Av1.missing_decoder().contains("AV1 Video Extension"));
    assert!(Codec::Vp9.missing_decoder().contains("VP9 Video Extensions"));
    assert_eq!(Codec::of("av01.0.04M.08"), Some(Codec::Av1));
    assert_eq!(Codec::of("vp09.00.10.08"), Some(Codec::Vp9));
    assert_eq!(Codec::of("vp8"), Some(Codec::Vp8));
    eprintln!("AV1 decoders {:?}", cut_decode::decoders(Codec::Av1));
}
