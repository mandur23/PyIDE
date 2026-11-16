//! Sample lookups and reads (`probe.sampleAtTime`, `keyBefore`, `readSample(s)`) and `probe.sniff`, against the
//! JavaScript and on the cases `verify/cut-formats.mjs` checks.

mod common;

use std::borrow::Cow;
use std::cell::Cell;
use std::io;

use common::{FIXTURES, diff, fixture};
use cut_formats::table::finish_track;
use cut_formats::{Audio, Media, MemReader, Reader, SampleTable, Track, Video, probe};
use cut_oracle::{Inputs, ask, bytes};
use serde_json::{Value, json};

fn track(video: bool, pts: &[i64], dts: &[i64], key: &[bool], pre_roll: i64) -> Track {
    let n = pts.len();
    let mut samples = SampleTable {
        offset: (0..n as u64).collect(),
        size: vec![1; n],
        dts: dts.to_vec(),
        pts: pts.to_vec(),
        duration: vec![1; n],
        key: key.to_vec(),
        ..SampleTable::default()
    };
    let mut v = Video {
        width: 0,
        height: 0,
        display_width: 0,
        display_height: 0,
        rotation: 0,
        bit_depth: 8,
        color_space: None,
        frame_rate: [30, 1],
        vfr: false,
    };
    finish_track(&mut samples, video.then_some(&mut v), 0.0);
    let media = if video { Media::Video(v) } else { Media::Audio(Audio { sample_rate: 48000, channels: 2 }) };
    Track {
        id: 1,
        media,
        codec: String::new(),
        description: None,
        duration: 0,
        truncated: false,
        pre_roll,
        sample_prefix: None,
        samples,
    }
}

#[test]
fn open_gops_reordered_pictures_and_empty_tables() {
    let t = track(
        true,
        &[0, 3, 1, 2, 6, 4, 5, 7],
        &[-1, 0, 1, 2, 3, 4, 5, 6],
        &[true, false, false, false, true, false, false, false],
        0,
    );
    let kb = |i| probe::key_before(&t, i);
    assert_eq!(
        [kb(5), kb(6), kb(4), kb(7), kb(2)],
        [Some(0), Some(0), Some(4), Some(4), Some(0)],
        "leading pictures decode from the GOP before"
    );
    assert_eq!(probe::sample_at_time(&t, 4), Some(5));
    assert_eq!(probe::sample_at_time(&t, 6), Some(4));
    assert_eq!(probe::sample_at_time(&t, -5), Some(0), "before the first pts: the earliest sample");
    let empty = track(false, &[], &[], &[], 0);
    assert_eq!((probe::sample_at_time(&empty, 0), probe::key_before(&empty, 0)), (None, None));
}

#[test]
fn lookups_match_the_javascript_on_random_tables() {
    let mut rng = Inputs::new(8);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for round in 0..60 {
        let n = rng.range(1, 200) as usize;
        let video = round % 3 != 0;
        // GOPs of B-frames: decode order 0, 3, 1, 2, ... inside each, keys at their starts.
        let gop = rng.range(1, 12) as usize;
        let mut pts = Vec::new();
        for g in (0..n).step_by(gop) {
            let m = gop.min(n - g);
            let mut order: Vec<usize> = (0..m).collect();
            if video && m > 2 && rng.range(0, 1) == 1 {
                order.swap(1, m - 1);
            }
            pts.extend(order.into_iter().map(|i| ((g + i) as i64) * 1000 + rng.pick(&[0, 0, 0, -3000])));
        }
        let dts: Vec<i64> = (0..n as i64).map(|i| i * 1000 - 2000).collect();
        let key: Vec<bool> = (0..n).map(|i| i % gop == 0 || rng.range(0, 30) == 0).collect();
        let t = track(video, &pts, &dts, &key, rng.pick(&[0, 0, 2500, 80_000]));
        let tj = serde_json::to_value(&t).expect("a track");
        for _ in 0..40 {
            let at = rng.range(-5000, n as i64 * 1000 + 5000);
            calls.push(json!(["sampleAtTime", tj, at]));
            ours.push(json!(probe::sample_at_time(&t, at).map_or(-1, |i| i as i64)));
            let i = rng.range(-3, n as i64 + 3);
            calls.push(json!(["keyBefore", tj, i]));
            ours.push(json!(probe::key_before(&t, i).map_or(-1, |i| i as i64)));
        }
    }
    let theirs = ask("probe", &calls);
    println!("{} lookups compared", calls.len());
    for ((c, a), b) in calls.iter().zip(&ours).zip(&theirs) {
        assert_eq!(diff(a, b, ""), None, "{} {}", c[0], c[2]);
    }
}

#[test]
fn sniffing_matches_the_javascript() {
    let mut rng = Inputs::new(9);
    let mut inputs: Vec<Vec<u8>> =
        FIXTURES.iter().map(|r| std::fs::read(fixture(r)).expect("fixture")[..64].to_vec()).collect();
    let heads: [&[u8]; 14] = [
        b"\0\0\0\x18ftypisom",
        b"\0\0\0\x18ftypavif",
        b"\0\0\0\x18ftypheic",
        b"\0\0\0\x18ftypmif1",
        b"\0\0\0\x08moov",
        b"\x1a\x45\xdf\xa3",
        b"RIFF\0\0\0\0WAVE",
        b"RF64\0\0\0\0WAVE",
        b"RIFF\0\0\0\0WEBP",
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF89a",
        b"ID3\x04\0\0\0\0\0\0",
        b"\xff\xfb\x90\x00",
    ];
    for h in heads {
        inputs.push(h.to_vec());
        inputs.push(h[..h.len() - 1].to_vec());
        let mut long = h.to_vec();
        long.extend((0..40).map(|_| rng.range(0, 255) as u8));
        inputs.push(long);
    }
    let mut bmp = b"BM".to_vec();
    bmp.extend([0; 12]);
    bmp.extend(40_u32.to_le_bytes());
    bmp.extend([0; 12]);
    inputs.push(bmp);
    // Two MP3 frames, two ADTS frames.
    let mut mp3 = vec![0xff, 0xfb, 0x90, 0x00];
    mp3.resize(417, 0x11);
    mp3.extend_from_within(..417);
    inputs.push(mp3);
    let mut adts = vec![0xff, 0xf1, 0x4c, 0x80, 0x1a, 0x1f, 0xfc];
    adts.resize(208, 0x22);
    adts.extend_from_within(..208);
    inputs.push(adts);
    for _ in 0..200 {
        let n = rng.range(0, 64) as usize;
        let mut b: Vec<u8> = (0..n).map(|_| rng.range(0, 255) as u8).collect();
        if n > 2 && rng.range(0, 1) == 0 {
            b[0] = 0xff;
            b[1] = rng.pick(&[0xfb, 0xf3, 0xf1, 0xf9]);
        }
        inputs.push(b);
    }
    let calls: Vec<Value> = inputs.iter().map(|b| json!(["sniff", bytes(b)])).collect();
    for (b, theirs) in inputs.iter().zip(ask("probe", &calls)) {
        assert_eq!(json!(probe::sniff(b).map(|s| s.as_str())), theirs, "{b:02x?}");
    }
}

/// A reader that counts its reads.
struct Counting<'a>(MemReader<&'a [u8]>, Cell<usize>);

impl Reader for Counting<'_> {
    fn size(&self) -> u64 {
        self.0.size()
    }
    fn read(&self, offset: u64, len: usize) -> io::Result<Cow<'_, [u8]>> {
        self.1.set(self.1.get() + 1);
        self.0.read(offset, len)
    }
}

#[test]
fn samples_read_in_few_reads_and_with_their_prefix() {
    let file = std::fs::read(fixture("video/clip.mp4")).expect("fixture");
    let src = probe::open(&MemReader(&file[..]), "clip.mp4");
    let t = &src.tracks[0];
    let n = t.samples.count();
    let r = Counting(MemReader(&file[..]), Cell::new(0));
    let mut got = Vec::new();
    probe::read_samples(&r, t, 0, n + 10, |i, b| got.push((i, b.to_vec()))).expect("they read");
    assert_eq!(got.len(), n, "clamped to the table");
    assert!(r.1.get() <= 2, "{} reads for {n} samples", r.1.get());
    for (i, b) in &got {
        assert_eq!(probe::read_sample(&MemReader(&file[..]), t, *i).expect("one reads").as_ref(), &b[..]);
    }
    let mut none = 0;
    probe::read_samples(&r, t, 5, 5, |_, _| none += 1).expect("an empty range");
    assert_eq!(none, 0, "half-open");
    assert!(probe::read_sample(&MemReader(&file[..]), t, n).is_err(), "a missing index is an error");
    let mut prefixed = t.clone();
    prefixed.sample_prefix = Some(vec![0xaa, 0xbb]);
    let mem = MemReader(&file[..]);
    let first = probe::read_sample(&mem, &prefixed, 0).expect("it reads");
    assert_eq!(&first[..2], &[0xaa, 0xbb]);
    assert_eq!(&first[2..], &got[0].1[..]);
    probe::read_samples(&MemReader(&file[..]), &prefixed, 0, 2, |i, b| assert_eq!(&b[2..], &got[i].1[..]))
        .expect("they read");
    let cut = &file[..file.len() - 100];
    assert!(probe::read_sample(&MemReader(cut), t, n - 1).is_err(), "a sample past the end is cut off");
}
