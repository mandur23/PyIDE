//! The check of a written export (`verifyFile`, `decodeRange`): the file is opened again with the probe, its frame
//! count and track lengths compared with what was asked, and its first and last frames decoded.

use std::path::Path;

use cut_decode::{Accel, VideoDecoder};
use cut_formats::probe::{self, key_before, read_samples};
use cut_formats::{FileReader, Kind, Track};
use cut_time::{Fps, TICKS, Ticks};

/// Something the check found: a code, an English message for `tr(message, params)`, its params.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub code: &'static str,
    pub message: &'static str,
    pub params: Vec<(&'static str, String)>,
}

impl Problem {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message, params: Vec::new() }
    }
}

/// What the check found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Verified {
    pub ok: bool,
    pub frames: usize,
    pub expected_frames: usize,
    /// Ticks.
    pub duration: Ticks,
    pub audio_duration: Ticks,
    pub first_frame: bool,
    pub last_frame: bool,
    pub problems: Vec<Problem>,
}

/// Decodes samples `[from, to]` of a video track -> the frames that came out, and whether the decoder failed. On the
/// GPU when it decodes the codec (a 4K group of pictures takes seconds in software), else in software.
pub fn decode_range(reader: &FileReader, track: &Track, from: usize, to: usize) -> (usize, bool) {
    let Ok(mut dec) = VideoDecoder::new(track, Accel::Auto) else { return (0, true) };
    let mut got = 0;
    let mut error = false;
    let mut datas = Vec::new();
    if read_samples(reader, track, from, to + 1, |i, b| datas.push((i, b.to_vec()))).is_err() {
        return (0, true);
    }
    for (i, b) in datas {
        if dec.send(i, &b).is_err() {
            error = true;
            break;
        }
        while let Ok(Some(_)) = dec.receive() {
            got += 1;
        }
    }
    if dec.finish().is_err() {
        error = true;
    }
    loop {
        match dec.receive() {
            Ok(Some(_)) => got += 1,
            Ok(None) => break,
            Err(_) => {
                error = true;
                break;
            }
        }
    }
    (got, error)
}

fn secs(t: Ticks) -> String {
    format!("{}", (t as f64 / TICKS as f64 * 1000.0).round() / 1000.0)
}

/// Opens `path` again: `video` the sequence's frame rate when the export has a picture, `frames` and `duration` what
/// it should hold, `audio` whether it has sound.
pub fn verify_file(path: &Path, video: Option<Fps>, frames: usize, duration: Ticks, audio: bool) -> Verified {
    let mut out = Verified { expected_frames: frames, ..Verified::default() };
    let unreadable = || Problem::new("unreadable", "The exported file cannot be read.");
    let Ok(reader) = FileReader::open(path) else {
        out.problems.push(unreadable());
        return out;
    };
    let source = probe::open(&reader, &path.to_string_lossy());
    if source.error.is_some() {
        out.problems.push(unreadable());
        return out;
    }
    let vt = source.tracks.iter().find(|t| t.kind() == Kind::Video);
    let at = source.tracks.iter().find(|t| t.kind() == Kind::Audio);
    let frame_len = video.map_or(0, |f| TICKS * i64::from(f.den) / i64::from(f.num));
    if video.is_some() {
        match vt {
            None => out.problems.push(Problem::new("noVideo", "The exported file has no video.")),
            Some(vt) => {
                let s = &vt.samples;
                out.frames = s.count();
                let end = (0..s.count()).map(|i| s.pts[i] + s.duration[i]).max().unwrap_or(0);
                let start = s.pts.iter().copied().min().unwrap_or(0);
                out.duration = if s.count() > 0 { end - start } else { 0 };
                if s.count() != frames {
                    out.problems.push(Problem {
                        code: "frames",
                        message: "The file has {got} frames where {want} were expected.",
                        params: vec![("got", s.count().to_string()), ("want", frames.to_string())],
                    });
                }
                if (out.duration - duration).abs() > frame_len / 2 {
                    out.problems.push(Problem {
                        code: "duration",
                        message: "The video is {got} s long where {want} s was expected.",
                        params: vec![("got", secs(out.duration)), ("want", secs(duration))],
                    });
                }
                if s.count() > 0 {
                    let (n, err) = decode_range(&reader, vt, 0, 0);
                    out.first_frame = n == 1 && !err;
                    let last = s.order[s.count() - 1] as i64;
                    let k = key_before(vt, last).unwrap_or(0);
                    let (n, err) = decode_range(&reader, vt, k, s.count() - 1);
                    out.last_frame = n == s.count() - k && !err;
                    if !out.first_frame {
                        out.problems.push(Problem::new("firstFrame", "The first frame does not decode."));
                    }
                    if !out.last_frame {
                        out.problems.push(Problem::new("lastFrame", "The last frame does not decode."));
                    }
                }
            }
        }
    }
    if audio {
        match at {
            None => out.problems.push(Problem::new("noAudio", "The exported file has no sound.")),
            Some(at) => {
                out.audio_duration = at.duration;
                let rate = match &at.media {
                    cut_formats::Media::Audio(a) => f64::from(a.sample_rate),
                    cut_formats::Media::Video(_) => 48000.0,
                };
                // Two AAC frames of slack: the encoder's last frame runs past the end.
                let slack = (2048.0 * TICKS as f64 / if rate > 0.0 { rate } else { 48000.0 }) as i64;
                if (out.audio_duration - duration).abs() > slack + frame_len {
                    out.problems.push(Problem {
                        code: "audioDuration",
                        message: "The sound is {got} s long where {want} s was expected.",
                        params: vec![("got", secs(out.audio_duration)), ("want", secs(duration))],
                    });
                }
            }
        }
    }
    out.ok = out.problems.is_empty();
    out
}
