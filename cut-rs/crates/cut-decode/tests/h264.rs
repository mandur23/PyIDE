//! H.264 through Media Foundation: every frame of the fixtures, their times and pictures.

mod common;

use common::*;
use cut_decode::Accel;

#[test]
fn clip_mp4_decodes_every_frame_at_the_sample_tables_times() {
    let (reader, source) = open(&fixture("video/clip.mp4"));
    let track = video(&source);
    let s = &track.samples;
    eprintln!("clip.mp4: {} {:?} samples {} keys {:?}", track.codec, track.media, s.count(), s.keys);
    eprintln!("pts {:?}\ndts {:?}", s.pts, s.dts);
    let (frames, path) = decode_all(&reader, track, Accel::Software);
    eprintln!("path {path}");
    let shown: Vec<usize> = frames.iter().map(|f| f.sample).collect();
    assert_eq!(shown, shown_order(track), "one frame a sample, in presentation order");
    for f in &frames {
        assert_eq!(f.pts, s.pts[f.sample]);
    }
    for i in [0, frames.len() / 2, frames.len() - 1] {
        eprintln!("{}", write_png(&format!("clip-sw-{i}.png"), &frames[i]).display());
    }
}

#[test]
fn what_this_pc_has() {
    eprintln!("adapters {:?}", cut_decode::adapters());
    for c in [cut_decode::Codec::H264, cut_decode::Codec::Hevc, cut_decode::Codec::Aac] {
        eprintln!("{c:?}: decoders {:?} encoders {:?}", cut_decode::decoders(c), cut_decode::encoders(c));
    }
}

#[test]
fn hardware_frames_are_the_software_frames_byte_for_byte() {
    let (reader, source) = open(&fixture("video/clip.mp4"));
    let track = video(&source);
    let (soft, _) = decode_all(&reader, track, Accel::Software);
    let mut checked = 0;
    for adapter in 0..cut_decode::adapters().len() as u32 {
        let accel = Accel::Hardware { adapter: Some(adapter) };
        if let Err(e) = cut_decode::VideoDecoder::new(track, accel) {
            eprintln!("adapter {adapter}: no hardware decoder: {e}");
            continue;
        }
        checked += 1;
        let (hard, path) = decode_all(&reader, track, Accel::Hardware { adapter: Some(adapter) });
        eprintln!("adapter {adapter}: {path}, gpu frames {}", hard.iter().filter(|f| f.gpu).count());
        assert!(hard.iter().all(|f| f.gpu), "every frame on the GPU");
        assert_eq!(hard.len(), soft.len());
        for (h, s) in hard.iter().zip(&soft) {
            assert_eq!((h.sample, h.pts, h.width, h.height), (s.sample, s.pts, s.width, s.height));
            assert!(h.bytes == s.bytes, "sample {} differs", h.sample);
        }
        write_png(&format!("clip-hw{adapter}-30.png"), &hard[30]);
    }
    assert!(checked > 0, "no GPU decodes H.264 here");
}

#[test]
fn b_frames_come_out_in_presentation_order_with_their_pictures() {
    let s = make::settings(cut_decode::Codec::H264, 1280, 720);
    check_made("h264-720p.mp4", &s, make::Timing::Constant, Accel::Software);
    check_made("h264-720p.mp4", &s, make::Timing::Constant, Accel::Auto);
}

#[test]
fn variable_frame_rates_keep_the_tables_times() {
    let s = make::settings(cut_decode::Codec::H264, 1280, 720);
    check_made("h264-720p-vfr.mp4", &s, make::Timing::Variable, Accel::Software);
    check_made("h264-720p-vfr.mp4", &s, make::Timing::Variable, Accel::Auto);
}
