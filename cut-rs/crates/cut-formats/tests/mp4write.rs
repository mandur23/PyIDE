//! `cut_formats::mp4::write` against `renderer/features/cut/mp4write.js`: the same samples give the same writes to
//! the sink, byte for byte, in the same order (and the same refusals and sink errors).

mod common;

use std::io;

use common::{fill, open, records};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample, Sink, VideoConfig, WriteError};
use cut_formats::{ColorSpace, Matrix, MemReader, Primaries, Transfer, probe};
use cut_oracle::{ask_scenario, bytes, unbytes};
use cut_time::{Fps, TICKS};
use serde_json::{Value, json};

const FRAME: i64 = TICKS * 1001 / 30000;
const AAC: i64 = 1024 * (TICKS / 48000);

/// A sample of the plan: video or audio, its size and fill seed, and its times.
#[derive(Clone)]
struct Planned {
    video: bool,
    size: usize,
    seed: i64,
    timestamp: i64,
    duration: i64,
    key: bool,
    cto: i64,
    dts: i64,
}

/// Video in decode order with B-frames (I P B B P B B ...), a key every `gop` frames (verify/cut-formats.mjs).
fn video_plan(n: usize, negative: bool, gop: usize) -> Vec<Planned> {
    let mut frames = Vec::new();
    for g in (0..n).step_by(gop) {
        let m = gop.min(n - g);
        let mut order = vec![0];
        let mut p = 3;
        while p < m + 2 {
            let big_p = p.min(m - 1);
            if !order.contains(&big_p) {
                order.push(big_p);
            }
            for b in p - 2..p.min(m) {
                if !order.contains(&b) {
                    order.push(b);
                }
            }
            p += 3;
        }
        for i in 0..m {
            if !order.contains(&i) {
                order.push(i);
            }
        }
        frames.extend(order.into_iter().map(|i| g + i));
    }
    frames
        .into_iter()
        .enumerate()
        .map(|(k, frame)| {
            let pts = frame as i64 * FRAME;
            let dts = (k as i64 - if negative { 0 } else { 2 }) * FRAME;
            Planned {
                video: true,
                size: 200 + (k * 37) % 900,
                seed: k as i64,
                timestamp: pts,
                duration: FRAME,
                key: frame % gop == 0,
                cto: pts - dts,
                dts,
            }
        })
        .collect()
}

fn audio_plan(n: usize, first: i64, step: i64, size: impl Fn(usize) -> usize) -> Vec<Planned> {
    (0..n)
        .map(|i| {
            let t = first + i as i64 * step;
            Planned {
                video: false,
                size: size(i),
                seed: 1000 + i as i64,
                timestamp: t,
                duration: step,
                key: true,
                cto: 0,
                dts: t,
            }
        })
        .collect()
}

/// Video and audio in the order an export hands them over.
fn interleave(v: &[Planned], a: &[Planned]) -> Vec<Planned> {
    let (mut vi, mut ai, mut out) = (0, 0, Vec::new());
    while vi < v.len() || ai < a.len() {
        if vi < v.len() && (ai >= a.len() || v[vi].dts <= a[ai].timestamp) {
            out.push(v[vi].clone());
            vi += 1;
        } else {
            out.push(a[ai].clone());
            ai += 1;
        }
    }
    out
}

/// A sink that keeps every write, and refuses its write number `fail_at` (and every later one).
struct Log {
    writes: Vec<(Option<u64>, Vec<u8>)>,
    fail_at: usize,
    n: usize,
}

impl Sink for Log {
    fn write(&mut self, b: &[u8], position: Option<u64>) -> io::Result<()> {
        self.n += 1;
        if self.fail_at > 0 && self.n >= self.fail_at {
            return Err(io::Error::other("disk full"));
        }
        self.writes.push((position, b.to_vec()));
        Ok(())
    }
}

struct Case {
    name: &'static str,
    video: Option<VideoConfig>,
    audio: Option<AudioConfig>,
    timescale: Option<u32>,
    samples: Vec<Planned>,
    fail_at: usize,
}

fn video_json(v: &VideoConfig) -> Value {
    json!({
        "codec": v.codec, "width": v.width, "height": v.height,
        "description": v.description.as_deref().map(bytes), "frameRate": v.frame_rate, "colorSpace": v.color_space,
    })
}

fn audio_json(a: &AudioConfig) -> Value {
    json!({ "codec": a.codec, "sampleRate": a.sample_rate, "channels": a.channels, "description": a.description.as_deref().map(bytes) })
}

/// What the Rust writer did: the writes, the first add that failed, finish's error, the size.
struct Outcome {
    writes: Vec<(Option<u64>, Vec<u8>)>,
    failed: Option<usize>,
    finish: Option<String>,
    size: Option<u64>,
}

fn run(c: &Case) -> Result<Outcome, WriteError> {
    let sink = Log { writes: Vec::new(), fail_at: c.fail_at, n: 0 };
    let mut w = Mp4Writer::create(c.video.clone(), c.audio.clone(), sink, c.timescale)?;
    let mut failed = None;
    for (i, p) in c.samples.iter().enumerate() {
        let s = Sample {
            data: fill(p.size, p.seed),
            timestamp: p.timestamp,
            duration: p.duration,
            key: p.key,
            composition_offset: p.cto,
        };
        let r = if p.video { w.add_video(s) } else { w.add_audio(s) };
        if r.is_err() {
            failed = Some(i);
            break;
        }
    }
    let (finish, size) = match w.finish() {
        Ok(n) => (None, Some(n)),
        Err(e) => (Some(e.to_string()), None),
    };
    Ok(Outcome { writes: w.into_sink().writes, failed, finish, size })
}

fn h264(avc_c: &[u8], width: u32, height: u32, fps: [u32; 2]) -> VideoConfig {
    VideoConfig {
        codec: "avc1.640028".into(),
        width,
        height,
        description: Some(avc_c.to_vec()),
        frame_rate: Some(fps),
        color_space: None,
    }
}

fn aac(channels: u32, description: Option<Vec<u8>>) -> AudioConfig {
    AudioConfig { codec: "mp4a.40.2".into(), sample_rate: 48000, channels, description }
}

fn opus_head(pre_skip: u16) -> Vec<u8> {
    let mut h = b"OpusHead".to_vec();
    h.extend([1, 2]);
    h.extend(pre_skip.to_le_bytes());
    h.extend(48000_u32.to_le_bytes());
    h.extend([0, 0, 0]);
    h
}

fn cases() -> Vec<Case> {
    let (avc, hevc) = records();
    let (avc_c, hvc_c) = (avc[0].clone(), hevc[0].clone());
    let bt709 = ColorSpace {
        primaries: Some(Primaries::Bt709),
        transfer: Some(Transfer::Bt709),
        matrix: Some(Matrix::Bt709),
        full_range: Some(false),
    };
    let fps = [30000, 1001];
    let mut vfr = Vec::new();
    let mut t = 0;
    let f60 = Fps::new(60, 1).frame_ticks().expect("60 fps");
    for i in 0..120 {
        let d = [1, 1, 1, 2, 1, 1, 3, 1, 1, 1, 1, 2][i % 12] * f60;
        vfr.push(Planned {
            video: true,
            size: 50 + i % 9,
            seed: i as i64,
            timestamp: t,
            duration: d,
            key: i % 60 == 0,
            cto: 0,
            dts: t,
        });
        t += d;
    }
    let f30 = TICKS / 30;
    let big = |n: usize, size: usize| -> Vec<Planned> {
        (0..n)
            .map(|i| Planned {
                video: true,
                size,
                seed: i as i64,
                timestamp: i as i64 * f30,
                duration: f30,
                key: i == 0,
                cto: 0,
                dts: i as i64 * f30,
            })
            .collect()
    };
    let mut handed = video_plan(90, false, 30);
    handed.extend(audio_plan(140, 0, AAC, |i| 150 + i % 40));
    vec![
        Case {
            name: "H.264 with B-frames and AAC starting before 0",
            video: Some(VideoConfig { color_space: Some(bt709), ..h264(&avc_c, 1920, 1080, fps) }),
            audio: Some(aac(2, Some(vec![0x11, 0x90]))),
            timescale: None,
            samples: interleave(&video_plan(90, false, 30), &audio_plan(143, -AAC * 2, AAC, |i| 150 + i % 40)),
            fail_at: 0,
        },
        Case {
            name: "HEVC with negative composition offsets and audio starting late",
            video: Some(VideoConfig { codec: "hvc1.2.4.L153.90".into(), ..h264(&hvc_c, 3840, 2160, fps) }),
            audio: Some(aac(2, None)),
            timescale: None,
            samples: interleave(&video_plan(60, true, 30), &audio_plan(60, TICKS / 4, AAC, |i| 150 + i % 40)),
            fail_at: 0,
        },
        Case {
            name: "VFR video and Opus",
            video: Some(h264(&avc_c, 1280, 720, [60, 1])),
            audio: Some(AudioConfig {
                codec: "opus".into(),
                sample_rate: 48000,
                channels: 2,
                description: Some(opus_head(312)),
            }),
            timescale: None,
            samples: interleave(&vfr, &audio_plan(100, 0, 960 * (TICKS / 48000), |_| 80)),
            fail_at: 0,
        },
        Case {
            name: "Opus without a description",
            video: None,
            audio: Some(AudioConfig { codec: "opus".into(), sample_rate: 48000, channels: 1, description: None }),
            timescale: None,
            samples: audio_plan(30, 0, 960 * (TICKS / 48000), |i| 60 + i),
            fail_at: 0,
        },
        Case {
            name: "an M4A",
            video: None,
            audio: Some(aac(1, None)),
            timescale: None,
            samples: audio_plan(200, 0, AAC, |i| 150 + i % 40),
            fail_at: 0,
        },
        Case {
            name: "video only at 90 kHz, starting at 2 s",
            video: Some(h264(&avc_c, 640, 360, fps)),
            audio: None,
            timescale: Some(90000),
            samples: video_plan(75, false, 25)
                .into_iter()
                .map(|p| Planned { timestamp: p.timestamp + 2 * TICKS, ..p })
                .collect(),
            fail_at: 0,
        },
        Case {
            name: "three seconds of video before any audio",
            video: Some(h264(&avc_c, 64, 64, fps)),
            audio: Some(aac(2, None)),
            timescale: None,
            samples: handed,
            fail_at: 0,
        },
        Case {
            name: "samples of 2.5 MB",
            video: Some(h264(&avc_c, 16, 16, [30, 1])),
            audio: None,
            timescale: None,
            samples: big(6, 5 << 19),
            fail_at: 0,
        },
        Case {
            name: "a sink that refuses its second write",
            video: Some(h264(&avc_c, 16, 16, [30, 1])),
            audio: None,
            timescale: None,
            samples: big(40, 3 << 20),
            fail_at: 2,
        },
        Case {
            name: "a sink that refuses its last write",
            video: Some(h264(&avc_c, 16, 16, [30, 1])),
            audio: None,
            timescale: None,
            samples: big(20, 1000),
            fail_at: 3,
        },
        Case { name: "no tracks", video: None, audio: None, timescale: None, samples: vec![], fail_at: 0 },
        Case {
            name: "VP9",
            video: Some(VideoConfig { codec: "vp09.00.40.08".into(), ..h264(&avc_c, 10, 10, [30, 1]) }),
            audio: None,
            timescale: None,
            samples: vec![],
            fail_at: 0,
        },
        Case {
            name: "no avcC",
            video: Some(VideoConfig { description: None, ..h264(&avc_c, 10, 10, [30, 1]) }),
            audio: None,
            timescale: None,
            samples: vec![],
            fail_at: 0,
        },
        Case {
            name: "AAC without a rate",
            video: None,
            audio: Some(AudioConfig { sample_rate: 0, ..aac(2, None) }),
            timescale: None,
            samples: vec![],
            fail_at: 0,
        },
        Case {
            name: "FLAC",
            video: None,
            audio: Some(AudioConfig { codec: "flac".into(), ..aac(2, None) }),
            timescale: None,
            samples: vec![],
            fail_at: 0,
        },
    ]
}

#[test]
fn the_writer_writes_the_same_bytes_as_the_javascript() {
    let cases = cases();
    let calls: Vec<Value> = cases
        .iter()
        .map(|c| {
            let samples: Vec<Value> = c
                .samples
                .iter()
                .map(|p| {
                    json!([
                        if p.video { "v" } else { "a" },
                        p.size,
                        p.seed,
                        p.timestamp,
                        p.duration,
                        p.key,
                        p.video.then_some(p.cto)
                    ])
                })
                .collect();
            json!(["write", {
                "video": c.video.as_ref().map(video_json), "audio": c.audio.as_ref().map(audio_json),
                "timescale": c.timescale, "samples": samples, "failAt": c.fail_at,
            }])
        })
        .collect();
    for (c, theirs) in cases.iter().zip(ask_scenario("formats", &calls)) {
        let ours = match run(c) {
            Err(e) => {
                assert_eq!(json!(e.to_string()), theirs["create"], "{}: create refuses the same", c.name);
                continue;
            }
            Ok(o) => o,
        };
        let writes = theirs["writes"].as_array().expect("the writes");
        assert_eq!(ours.writes.len(), writes.len(), "{}: as many writes", c.name);
        for (i, ((pos, b), w)) in ours.writes.iter().zip(writes).enumerate() {
            assert_eq!(json!(pos), w[0], "{}: write {i} at the same position", c.name);
            assert!(*b == unbytes(&w[1]), "{}: write {i} has the same {} bytes", c.name, b.len());
        }
        // The JavaScript's add hears of a sink error one call later (its writes settle after it returns).
        let threw = theirs["threw"].as_i64().expect("threw");
        let expected = ours.failed.map_or(-1, |i| if i + 1 < c.samples.len() { i as i64 + 1 } else { -1 });
        assert_eq!(threw, expected, "{}: the add that fails", c.name);
        assert_eq!(json!(ours.finish), theirs["finish"], "{}: finish", c.name);
        assert_eq!(json!(ours.size), theirs["size"], "{}: the file size", c.name);
    }
}

#[test]
fn a_written_file_reads_back_as_it_was_written() {
    let c = cases().remove(0);
    let file: Vec<u8> = {
        let o = run(&c).expect("it writes");
        let mut f = Vec::new();
        for (pos, b) in o.writes {
            Sink::write(&mut f, &b, pos).expect("memory takes it");
        }
        f
    };
    let src = open(&file);
    assert!(src.error.is_none(), "{:?}", src.error);
    let [v, a] = &src.tracks[..] else { panic!("two tracks") };
    for (track, video) in [(v, true), (a, false)] {
        let plan: Vec<&Planned> = c.samples.iter().filter(|p| p.video == video).collect();
        let s = &track.samples;
        assert_eq!(s.count(), plan.len());
        for (i, p) in plan.iter().enumerate() {
            assert_eq!(
                (s.size[i] as usize, s.pts[i], s.dts[i], s.key[i]),
                (p.size, p.timestamp, p.dts, p.key || !video),
                "sample {i}"
            );
        }
        let r = MemReader(&file);
        let mut n = 0;
        probe::read_samples(&r, track, 0, s.count(), |i, b| {
            assert_eq!(b, fill(plan[i].size, plan[i].seed), "sample {i} reads back");
            n += 1;
        })
        .expect("the samples read");
        assert_eq!(n, plan.len());
    }
    assert_eq!(
        src.duration,
        (90 * FRAME).max(c.samples.iter().filter(|p| !p.video).map(|p| p.timestamp + AAC).max().unwrap())
    );
}

#[test]
fn past_4_gb_offsets_are_64_bit() {
    struct Sparse {
        small: Vec<(u64, Vec<u8>)>,
        len: u64,
    }
    impl Sink for Sparse {
        fn write(&mut self, b: &[u8], position: Option<u64>) -> io::Result<()> {
            let at = position.unwrap_or(self.len);
            if b.len() < 1 << 20 {
                self.small.push((at, b.to_vec()));
            }
            self.len = self.len.max(at + b.len() as u64);
            Ok(())
        }
    }
    let (avc, _) = records();
    let mut w =
        Mp4Writer::create(Some(h264(&avc[0], 1920, 1080, [30, 1])), None, Sparse { small: vec![], len: 0 }, None)
            .expect("a writer");
    let f = TICKS / 30;
    for i in 0..70 {
        w.add_video(Sample {
            data: vec![0; 64 << 20],
            timestamp: i * f,
            duration: f,
            key: i % 10 == 0,
            composition_offset: 0,
        })
        .expect("written");
    }
    let size = w.finish().expect("finished");
    assert!(size > 4_500_000_000);
    let sink = w.into_sink();
    struct Holes(Vec<(u64, Vec<u8>)>, u64);
    impl cut_formats::Reader for Holes {
        fn size(&self) -> u64 {
            self.1
        }
        fn read(&self, offset: u64, len: usize) -> io::Result<std::borrow::Cow<'_, [u8]>> {
            let mut out = vec![0; len.min((self.1 - offset) as usize)];
            for (at, part) in &self.0 {
                let (a, b) = (offset.max(*at), (offset + out.len() as u64).min(at + part.len() as u64));
                if a < b {
                    out[(a - offset) as usize..(b - offset) as usize]
                        .copy_from_slice(&part[(a - at) as usize..(b - at) as usize]);
                }
            }
            Ok(out.into())
        }
    }
    let src = probe::open(&Holes(sink.small, size), "big.mp4");
    let s = &src.tracks[0].samples;
    assert_eq!(s.count(), 70);
    assert!(s.offset[69] > 1 << 32 && s.offset[69] == 48 + 69 * (64 << 20), "{}", s.offset[69]);
}
