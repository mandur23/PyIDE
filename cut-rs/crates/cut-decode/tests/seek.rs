//! `frame_at(t)`: the frame shown at t, by decoding from the sync sample before it; random seeks give the bytes
//! sequential decoding gives.

mod common;

use std::collections::HashMap;

use common::*;
use cut_decode::Accel;
use cut_formats::probe::sample_at_time;

fn seeks(name: &std::path::Path, accel: Accel) {
    let (reader, source) = open(name);
    let track = video(&source);
    let (frames, _) = decode_all(&reader, track, Accel::Software);
    let by_sample: HashMap<usize, &Got> = frames.iter().map(|f| (f.sample, f)).collect();
    let mut src = source_of(&reader, track, accel);

    for &i in &shown_order(track) {
        let f = got(src.frame_at(track.samples.pts[i]).expect("a frame"));
        assert_eq!(f.sample, i);
        assert!(f.bytes == by_sample[&i].bytes, "sequential frame_at, sample {i}");
    }
    assert_eq!(src.stats().runs, 1, "playing through never restarts");

    let end = track.duration;
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut runs = src.stats().runs;
    for k in 0..60 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let t = (seed % (end as u64 + end as u64 / 10)) as i64 - end / 20;
        let want = sample_at_time(track, t).expect("a sample");
        let before = src.stats();
        let f = got(src.frame_at(t).expect("a frame"));
        assert_eq!(f.sample, want, "seek {k} to {t}");
        assert!(f.bytes == by_sample[&want].bytes, "seek {k} to {t}: sample {want}'s picture");
        runs = runs.max(src.stats().runs);
        let _ = before;
    }
    eprintln!("{}: {:?} after 60 random seeks", name.display(), src.stats());
    assert!(runs > 1);
}

fn source_of<'a>(
    reader: &'a cut_formats::FileReader,
    track: &'a cut_formats::Track,
    accel: Accel,
) -> cut_decode::FrameSource<'a, cut_formats::FileReader> {
    source(reader, track, accel)
}

#[test]
fn random_seeks_in_clip_mp4_match_sequential_decoding() {
    seeks(&fixture("video/clip.mp4"), Accel::Software);
    seeks(&fixture("video/clip.mp4"), Accel::Auto);
}

#[test]
fn random_seeks_across_gops_with_b_frames_match_sequential_decoding() {
    let path =
        make::video("h264-720p.mp4", &make::settings(cut_decode::Codec::H264, 1280, 720), 90, make::Timing::Constant);
    seeks(&path, Accel::Software);
    seeks(&path, Accel::Auto);
}

#[test]
fn forward_steps_continue_the_run_and_backward_steps_restart_it() {
    let path =
        make::video("h264-720p.mp4", &make::settings(cut_decode::Codec::H264, 1280, 720), 90, make::Timing::Constant);
    let (reader, source) = open(&path);
    let track = video(&source);
    let pts = |n: usize| track.samples.pts[track.samples.order[n] as usize];
    let mut src = source_of(&reader, track, Accel::Software);
    src.frame_at(pts(10)).expect("frame 10");
    src.frame_at(pts(20)).expect("frame 20");
    assert_eq!(src.stats().runs, 1, "10 then 20: same run");
    let fed = src.stats().fed;
    src.frame_at(pts(20)).expect("frame 20 again");
    assert_eq!(src.stats().fed, fed, "the frame shown again costs nothing");
    src.frame_at(pts(15)).expect("frame 15");
    assert_eq!(src.stats().runs, 2, "back to 15: a new run");
    src.frame_at(pts(75)).expect("frame 75");
    assert_eq!(src.stats().runs, 3, "past the next sync samples: a new run from the one before 75");
    let n = make::read_number(&got(src.frame_at(pts(75)).expect("75")));
    assert_eq!(n, 75);
}
