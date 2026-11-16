//! What the decoder tests share: fixtures, reading every frame, and pictures written as PNG to look at.
#![allow(dead_code)]

pub mod make;
pub mod mkv;
pub mod more;
pub mod signal;

use std::path::PathBuf;

use cut_decode::{Accel, Frame, FrameSource, PixelFormat, VideoDecoder};
use cut_formats::probe::read_samples;
use cut_formats::{FileReader, Kind, Reader, Source, Track, probe};

pub fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures/viewers").join(rel)
}

/// Where made media and test pictures go: `CUT_DECODE_OUT` when set, else the system temporary directory.
pub fn out_dir() -> PathBuf {
    let dir = std::env::var_os("CUT_DECODE_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cut-decode"));
    std::fs::create_dir_all(&dir).expect("an output directory");
    dir
}

pub fn open(path: &std::path::Path) -> (FileReader, Source) {
    let reader = FileReader::open(path).expect("the file");
    let source = probe::open(&reader, "");
    assert!(source.error.is_none(), "{:?}", source.error);
    (reader, source)
}

pub fn video(source: &Source) -> &Track {
    source.tracks.iter().find(|t| t.kind() == Kind::Video).expect("a video track")
}

/// A decoded frame's sample, pts and pixels (in system memory).
pub struct Got {
    pub sample: usize,
    pub pts: i64,
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub bytes: Vec<u8>,
    pub gpu: bool,
}

pub fn got(f: &Frame) -> Got {
    Got {
        sample: f.sample,
        pts: f.pts,
        width: f.width,
        height: f.height,
        format: f.format,
        bytes: f.to_memory().expect("pixels").into_owned(),
        gpu: matches!(f.pixels, cut_decode::Pixels::Gpu(_)),
    }
}

/// Every frame of the track, decoded sequentially from the first sample, in the order they came out.
pub fn decode_all<R: Reader + ?Sized>(reader: &R, track: &Track, accel: Accel) -> (Vec<Got>, String) {
    let mut dec = VideoDecoder::new(track, accel).expect("a decoder");
    let path = format!("{:?}", dec.path());
    let mut out = Vec::new();
    let mut err = None;
    read_samples(reader, track, 0, track.samples.count(), |i, b| {
        if err.is_none() {
            err = dec.send(i, b).err();
            while let Some(f) = dec.receive().expect("a picture") {
                out.push(got(&f));
            }
        }
    })
    .expect("samples");
    assert!(err.is_none(), "{err:?}");
    dec.finish().expect("drained");
    while let Some(f) = dec.receive().expect("a picture") {
        out.push(got(&f));
    }
    (out, path)
}

/// The sample indexes in presentation order.
pub fn shown_order(track: &Track) -> Vec<usize> {
    track.samples.order.iter().map(|&i| i as usize).collect()
}

/// BT.709 limited range NV12 (or P010) to RGB, written as a PNG.
pub fn write_png(name: &str, g: &Got) -> PathBuf {
    let (w, h) = (g.width as usize, g.height as usize);
    let b = g.format.sample_bytes() as usize;
    let at = |i: usize| -> f32 {
        if b == 1 { f32::from(g.bytes[i]) } else { f32::from(u16::from_le_bytes([g.bytes[i], g.bytes[i + 1]])) / 256.0 }
    };
    let row = w * b;
    let mut rgb = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            let luma = at(y * row + x * b);
            let c = h * row + (y / 2) * row + (x / 2) * 2 * b;
            let (cb, cr) = (at(c) - 128.0, at(c + b) - 128.0);
            let l = (luma - 16.0) * 1.164;
            let px = [l + 1.793 * cr, l - 0.213 * cb - 0.533 * cr, l + 2.112 * cb];
            rgb.extend(px.map(|v| v.round().clamp(0.0, 255.0) as u8));
        }
    }
    let path = out_dir().join(name);
    let file = std::io::BufWriter::new(std::fs::File::create(&path).expect("a png file"));
    let mut enc = png::Encoder::new(file, g.width, g.height);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().expect("png header").write_image_data(&rgb).expect("png data");
    path
}

pub fn source<'a, R: Reader + ?Sized>(reader: &'a R, track: &'a Track, accel: Accel) -> FrameSource<'a, R> {
    FrameSource::new(reader, track, accel).expect("a frame source")
}

/// Makes (once) and decodes a test video: one frame a sample in presentation order, at the table's times, each
/// picture showing its frame number. Returns the decoder path.
pub fn check_made(name: &str, s: &cut_decode::encode::VideoSettings, timing: make::Timing, accel: Accel) -> String {
    let path = make::video(name, s, 90, timing);
    let (reader, source) = open(&path);
    let track = video(&source);
    let t = &track.samples;
    let (frames, path) = decode_all(&reader, track, accel);
    let vfr = matches!(&track.media, cut_formats::Media::Video(v) if v.vfr);
    eprintln!("{name}: {} {:?} vfr {vfr}, {path}", track.codec, (t.count(), t.keys.len()));
    assert_eq!(frames.iter().map(|f| f.sample).collect::<Vec<_>>(), shown_order(track));
    for (n, f) in frames.iter().enumerate() {
        assert_eq!((f.width, f.height), (s.width, s.height));
        assert_eq!(f.pts, t.pts[f.sample]);
        assert_eq!(make::read_number(f), n as u32, "the picture of frame {n}");
    }
    let reordered = t.pts.iter().zip(&t.dts).any(|(p, d)| p != d);
    eprintln!("{name}: reordered (B-frames) {reordered}");
    assert!(reordered || s.b_frames == 0, "the file has B-frames");
    write_png(&format!("{name}-{}-45.png", if path.starts_with("Hardware") { "hw" } else { "sw" }), &frames[45]);
    path
}

/// Deterministic random numbers for damaged-input tests (xorshift).
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// A number in `0..n` (0 when `n` is 0).
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
}
