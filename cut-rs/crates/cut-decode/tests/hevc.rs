//! HEVC through Media Foundation (the HEVC Video Extension), 8 and 10 bits. Its encoder refuses a B-frame count
//! (ICodecAPI E_INVALIDARG), so these files are made with its defaults.

mod common;

use common::*;
use cut_decode::{Accel, Codec};

#[test]
fn hevc_main_decodes_every_frame_in_software_and_on_the_gpu() {
    let s = hevc();
    check_made("hevc-720p.mp4", &s, make::Timing::Constant, Accel::Software);
    let path = check_made("hevc-720p.mp4", &s, make::Timing::Constant, Accel::Auto);
    assert!(path.starts_with("Hardware"), "{path}");
}

#[test]
fn hevc_main_10_decodes_to_p010() {
    for adapter in 0..cut_decode::adapters().len() as u32 {
        let gpu = cut_decode::gpu_decodes(Some(adapter), Codec::Hevc, cut_decode::PixelFormat::P010);
        eprintln!("{}: DXVA HEVC Main 10 {gpu}", cut_decode::adapters()[adapter as usize]);
    }
    let s = cut_decode::encode::VideoSettings { ten_bit: true, ..hevc() };
    let probe = cut_decode::encode::encode_video(&s, 1, |i, px| make::draw(i, px, s.width, s.height, true));
    if let Err(e) = probe {
        eprintln!("no Main 10 file can be made here: {e}");
        return;
    }
    check_made("hevc10-720p.mp4", &s, make::Timing::Constant, Accel::Software);
    check_made("hevc10-720p.mp4", &s, make::Timing::Constant, Accel::Auto);
}

fn hevc() -> cut_decode::encode::VideoSettings {
    cut_decode::encode::VideoSettings { b_frames: 0, ..make::settings(Codec::Hevc, 1280, 720) }
}

#[test]
fn hevc_gpu_frames_are_the_software_frames_byte_for_byte() {
    let path = make::video("hevc-720p.mp4", &hevc(), 90, make::Timing::Constant);
    let (reader, source) = open(&path);
    let track = video(&source);
    let (soft, _) = decode_all(&reader, track, Accel::Software);
    let (hard, path) = decode_all(&reader, track, Accel::Auto);
    assert!(hard.iter().all(|f| f.gpu), "{path}");
    assert_eq!(soft.len(), hard.len());
    for (s, h) in soft.iter().zip(&hard) {
        assert!(s.sample == h.sample && s.bytes == h.bytes, "sample {}", s.sample);
    }
}
