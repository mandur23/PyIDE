//! Test media made here: a picture whose frame number is written as a row of black and white blocks (as the
//! JavaScript's `Cut.testsrc` does), encoded by Media Foundation's software encoders and written by cut-formats' MP4
//! writer, optionally with variable frame durations. Files are cached by name in the output directory.

use std::path::PathBuf;

use cut_decode::Codec;
use cut_decode::encode::{EncodedAudio, VideoSettings, encode_aac, encode_video};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample, VideoConfig};
use cut_time::{TICKS, rescale};

use super::{Got, out_dir};

pub const BITS: u32 = 16;

/// Where the number blocks are: `[top, height]` of the band and each block's width.
fn band(w: u32, h: u32) -> (u32, u32, u32) {
    (h / 20, h / 10, w / BITS)
}

/// Paints frame `i`: a moving diagonal ramp, colour that changes with `i`, and `i` as blocks (most significant first).
pub fn draw(i: u32, px: &mut [u8], w: u32, h: u32, ten_bit: bool) {
    let put = |px: &mut [u8], at: usize, v: u32| {
        if ten_bit {
            px[at * 2..at * 2 + 2].copy_from_slice(&((v as u16) << 8).to_le_bytes());
        } else {
            px[at] = v as u8;
        }
    };
    let (top, height, block) = band(w, h);
    for y in 0..h {
        for x in 0..w {
            let in_band = y >= top && y < top + height && x < block * BITS;
            let v = if in_band {
                let bit = (i >> (BITS - 1 - x / block)) & 1;
                if bit == 1 { 235 } else { 16 }
            } else {
                16 + (x / 2 + y / 2 + i * 4) % 220
            };
            put(px, (y * w + x) as usize, v);
        }
    }
    let chroma = (w * h) as usize;
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            let in_band = y * 2 >= top && y * 2 < top + height;
            let (u, v) = if in_band { (128, 128) } else { (16 + (i * 5 + y) % 224, 16 + (x * 2 * 224) / w) };
            let at = chroma + (y * w + x * 2) as usize;
            put(px, at, u);
            put(px, at + 1, v);
        }
    }
}

/// The frame number written in a decoded picture's blocks.
pub fn read_number(g: &Got) -> u32 {
    let (w, h) = (g.width, g.height);
    let b = g.format.sample_bytes() as usize;
    let (top, height, block) = band(w, h);
    let mut n = 0;
    for k in 0..BITS {
        let (mut sum, mut count) = (0u64, 0u64);
        for y in top + height / 4..top + height * 3 / 4 {
            for x in k * block + block / 4..k * block + block * 3 / 4 {
                let at = (y * w + x) as usize * b;
                sum += u64::from(if b == 1 { g.bytes[at] } else { g.bytes[at + 1] });
                count += 1;
            }
        }
        n = (n << 1) | u32::from(sum / count.max(1) > 126);
    }
    n
}

/// How frames are timed in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timing {
    Constant,
    /// Every third frame lasts twice as long.
    Variable,
}

/// The video file `name` (made once): `frames` frames of the test picture.
pub fn video(name: &str, s: &VideoSettings, frames: u32, timing: Timing) -> PathBuf {
    let path = out_dir().join(name);
    if path.exists() {
        return path;
    }
    let (w, h) = (s.width, s.height);
    let enc = encode_video(s, frames, |i, px| draw(i, px, w, h, s.ten_bit)).expect("encoded");
    eprintln!("{name}: {} by {}, {} samples", enc.codec, enc.encoder, enc.samples.len());
    let frame = TICKS * i64::from(s.fps[1]) / i64::from(s.fps[0]);
    let frame_hns = 10_000_000 * i64::from(s.fps[1]) / i64::from(s.fps[0]);
    let length = |f: i64| if timing == Timing::Variable && f % 3 == 0 { 2 * frame } else { frame };
    let mut starts = vec![0i64; frames as usize + 1];
    for f in 0..frames as usize {
        starts[f + 1] = starts[f] + length(f as i64);
    }
    // The encoder adds its reordering delay to the times it stamps; frame 0 is the earliest pts.
    let first = enc.samples.iter().map(|x| x.pts).min().unwrap_or(0);
    let index = |hns: i64| ((hns - first + frame_hns / 2).div_euclid(frame_hns)) as usize;
    assert_eq!(enc.samples.len(), frames as usize, "one sample a frame");
    let pts: Vec<i64> = enc.samples.iter().map(|x| starts[index(x.pts)]).collect();
    let mut sorted = pts.clone();
    sorted.sort_unstable();
    let delay = sorted.iter().zip(&pts).map(|(s, p)| s - p).max().unwrap_or(0);
    let config = VideoConfig {
        codec: enc.codec.clone(),
        width: w,
        height: h,
        description: Some(enc.description.clone()),
        frame_rate: Some(s.fps),
        color_space: None,
    };
    let mut writer = Mp4Writer::create(Some(config), None, Vec::new(), None).expect("a writer");
    for (k, x) in enc.samples.iter().enumerate() {
        let f = index(x.pts);
        let dts = sorted[k] - delay;
        writer
            .add_video(Sample {
                data: x.data.clone(),
                timestamp: pts[k],
                duration: starts[f + 1] - starts[f],
                key: x.key,
                composition_offset: pts[k] - dts,
            })
            .expect("a sample");
    }
    writer.finish().expect("finished");
    write_whole(&path, &writer.into_sink());
    path
}

/// An AAC file of `pcm` (interleaved, 48 kHz), its samples moved `shift` samples earlier (the encoder's delay, so the
/// edit list hides the priming as the JavaScript's export does).
pub fn audio(name: &str, pcm: &[i16], channels: u32, shift: i64) -> PathBuf {
    let path = out_dir().join(name);
    let enc: EncodedAudio = encode_aac(pcm, 48000, channels, 24000).expect("encoded");
    let config = AudioConfig {
        codec: enc.codec.clone(),
        sample_rate: 48000,
        channels,
        description: Some(enc.description.clone()),
    };
    let mut writer = Mp4Writer::create(None, Some(config), Vec::new(), None).expect("a writer");
    for (k, x) in enc.samples.iter().enumerate() {
        let at = k as i64 * 1024 - shift;
        writer
            .add_audio(Sample {
                data: x.data.clone(),
                timestamp: rescale(at, 48000),
                duration: rescale(1024, 48000),
                key: true,
                composition_offset: 0,
            })
            .expect("a sample");
    }
    writer.finish().expect("finished");
    write_whole(&path, &writer.into_sink());
    path
}

/// Settings for H.264 or HEVC at a size, 30 fps, a key frame a second, two B-frames.
pub fn settings(codec: Codec, width: u32, height: u32) -> VideoSettings {
    VideoSettings {
        codec,
        width,
        height,
        fps: [30, 1],
        bitrate: width * height * 4,
        key_every: 30,
        b_frames: 2,
        ten_bit: false,
    }
}

/// Writes a file so that a test running beside this one never reads it half written.
fn write_whole(path: &std::path::Path, bytes: &[u8]) {
    let part = path.with_extension(format!("part-{}-{:?}", std::process::id(), std::thread::current().id()));
    std::fs::write(&part, bytes).expect("written");
    std::fs::rename(&part, path).expect("renamed");
}
