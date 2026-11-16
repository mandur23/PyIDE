//! Real exports of small test sequences, opened again and checked: two cuts of a video whose frames show their number
//! as blocks, a dissolve between them, Black & White on the second, and a WAV of beeps. The written file is read with
//! cut-formats and decoded with cut-decode (frame count, every frame's time and number, key frames, colour tags,
//! moov in front, sound length, beeps on their samples) and opened by Windows' own Media Foundation source reader.
//! Also: a range, cancel, a full disk, offline media, audio only with a loudness target, and every encoder this PC
//! has.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use common::{Got, make, out_dir};
use cut_decode::encode::{read_with_source_reader, video_encoders};
use cut_decode::{Accel, Codec, VideoDecoder};
use cut_export::presets::{self, Overrides, Settings};
use cut_export::timing::Step;
use cut_export::{Done, Failure, Hardware, Job, Phase, Progress, run};
use cut_formats::probe::{self, read_samples};
use cut_formats::{FileReader, Kind, Matrix, Primaries, Track, Transfer};
use cut_model::commands::build as cmd;
use cut_model::{History, Id, Project};
use cut_time::{Fps, TICKS};
use serde_json::{Value, json};

const RATE: usize = 48000;
const FRAME: i64 = TICKS / 30;
/// The beeps of the WAV, in seconds: each 1 kHz at 0.5 for 50 ms.
const BEEPS: [f64; 4] = [0.5, 1.5, 2.5, 3.5];

fn sec(s: f64) -> i64 {
    (s * TICKS as f64).round() as i64
}

/// A 48 kHz stereo WAV of `seconds` with `beeps`, at `amp`, or a steady 1 kHz sine with `steady`.
fn wav(name: &str, seconds: f64, beeps: &[f64], amp: f64, steady: bool) -> PathBuf {
    let path = out_dir().join(name);
    let n = (seconds * RATE as f64) as usize;
    let mut data = Vec::with_capacity(n * 4);
    for i in 0..n {
        let t = i as f64 / RATE as f64;
        let on = steady || beeps.iter().any(|b| t >= *b && t < b + 0.05);
        let v = if on {
            amp * (std::f64::consts::TAU
                * 1000.0
                * (t - if steady { 0.0 } else { beeps.iter().rev().find(|b| **b <= t).copied().unwrap_or(0.0) }))
            .sin()
        } else {
            0.0
        };
        let s = (v * 32767.0).round() as i16;
        data.extend_from_slice(&s.to_le_bytes());
        data.extend_from_slice(&s.to_le_bytes());
    }
    let mut f = Vec::new();
    f.extend_from_slice(b"RIFF");
    f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    f.extend_from_slice(b"WAVEfmt ");
    f.extend_from_slice(&16u32.to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&2u16.to_le_bytes());
    f.extend_from_slice(&(RATE as u32).to_le_bytes());
    f.extend_from_slice(&(RATE as u32 * 4).to_le_bytes());
    f.extend_from_slice(&4u16.to_le_bytes());
    f.extend_from_slice(&16u16.to_le_bytes());
    f.extend_from_slice(b"data");
    f.extend_from_slice(&(data.len() as u32).to_le_bytes());
    f.extend_from_slice(&data);
    std::fs::write(&path, f).expect("a wav");
    path
}

/// The 720p test video: 90 frames at 30 fps, numbered.
fn video() -> PathBuf {
    let s = cut_decode::encode::VideoSettings { b_frames: 0, ..make::settings(Codec::H264, 1280, 720) };
    make::video("export-720p.mp4", &s, 90, make::Timing::Constant)
}

/// A media entry as the importer makes it, from the file's probe.
fn media_json(path: &Path) -> Value {
    let reader = FileReader::open(path).expect("the file");
    let source = probe::open(&reader, &path.to_string_lossy());
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let v = source.tracks.iter().find(|t| t.kind() == Kind::Video);
    let a = source.tracks.iter().find(|t| t.kind() == Kind::Audio);
    let video = v.map(|t| match &t.media {
        cut_formats::Media::Video(x) => json!({ "w": x.width, "h": x.height, "fps": [x.frame_rate[0], x.frame_rate[1]], "codec": t.codec, "vfr": false, "rotation": 0 }),
        cut_formats::Media::Audio(_) => Value::Null,
    });
    let audio = a.map(|t| match &t.media {
        cut_formats::Media::Audio(x) => json!({ "rate": x.sample_rate, "channels": x.channels, "codec": t.codec }),
        cut_formats::Media::Video(_) => Value::Null,
    });
    let size = std::fs::metadata(path).map_or(0, |m| m.len());
    json!({ "path": path.to_string_lossy(), "name": name, "kind": if video.is_some() { "video" } else { "audio" },
        "size": size, "mtime": 1, "duration": source.duration, "video": video, "audio": audio })
}

struct Scene {
    project: Project,
    seq: Id,
    first: Id,
    second: Id,
}

/// S1 (1280 x 720, 30 fps, 4 s): the video's 0..2 s at 0, its 1..3 s at 2 s with Black & White, a 10-frame dissolve
/// at the cut, and the beeps on A1.
fn scene(extra_media: &[PathBuf]) -> Scene {
    let mut p = cut_model::defaults::project();
    p.sequences[0].w = 1280;
    p.sequences[0].h = 720;
    let mut h = History::new(p, 100).expect("a history");
    let s = h.project().sequences[0].id.as_str().to_owned();
    let mut list = vec![media_json(&video()), media_json(&wav("export-beeps.wav", 4.0, &BEEPS, 0.5, false))];
    list.extend(extra_media.iter().map(|p| media_json(p)));
    let r = h.apply(&cmd::import_media(json!(list), None)).expect("imported");
    let ids: Vec<String> = r["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
    let place = |h: &mut History, m: &str, inn: f64, out: f64, at: f64, v: Option<&str>, a: Option<&str>| {
        let r = h
            .apply(&cmd::place(&s, json!({ "source": { "media": m }, "in": sec(inn), "out": sec(out), "at": sec(at), "video": v, "audio": a, "mode": "overwrite" })))
            .expect("placed");
        r["ids"][0].as_str().unwrap().to_owned()
    };
    let first = place(&mut h, &ids[0], 0.0, 2.0, 0.0, Some("V1"), None);
    let second = place(&mut h, &ids[0], 1.0, 3.0, 2.0, Some("V1"), None);
    place(&mut h, &ids[1], 0.0, 4.0, 0.0, None, Some("A1"));
    h.apply(&cmd::add_transition(
        &s,
        json!({ "track": "V1", "at": sec(2.0), "type": "dissolve", "duration": 10 * FRAME, "align": "center" }),
    ))
    .expect("a dissolve");
    h.apply(&cmd::add_effect(&s, &second, "color.bw", None, json!({}))).expect("black and white");
    for (k, m) in ids.iter().enumerate().skip(2) {
        place(&mut h, m, 0.0, 1.0, 1.0 + k as f64 * 0.0, Some("V2"), None);
    }
    Scene { project: h.project().clone(), seq: Id::new(&s), first: Id::new(&first), second: Id::new(&second) }
}

fn get_audio() -> cut_audio::GetAudio {
    let library = cut_audio::Library::default();
    Box::new(move |_p, m| Ok(library.audio(Path::new(&m.path))?.map(|r| cut_audio::Audio::Reader(Box::new(r)))))
}

fn settings(preset: &str, o: &Overrides) -> Settings {
    presets::resolve(presets::get(preset).expect("a preset"), Fps::new(30, 1), Some((1280.0, 720.0)), o)
}

fn job(sc: &Scene, name: &str, s: Settings) -> Job {
    let path = out_dir().join(name);
    let mut j = Job::new(Arc::new(sc.project.clone()), sc.seq, path, s, get_audio());
    j.hardware = Hardware::Software;
    j
}

fn export(j: Job) -> (Result<Done, Failure>, Vec<Progress>) {
    let mut seen = Vec::new();
    let cancel = AtomicBool::new(false);
    let r = run(j, &cancel, &mut |p| seen.push(*p));
    (r, seen)
}

/// Every frame of a video track decoded in presentation order: (pts, number, mean chroma distance from grey).
fn frames(reader: &FileReader, t: &Track) -> Vec<(i64, i64, f64)> {
    let mut dec = VideoDecoder::new(t, Accel::Software).expect("a decoder");
    let mut out = Vec::new();
    let take = |f: cut_decode::Frame, out: &mut Vec<(i64, i64, f64)>| {
        let bytes = f.to_memory().expect("pixels").into_owned();
        let (w, h) = (f.width, f.height);
        let g = Got { width: w, height: h, format: f.format, bytes };
        let chroma = &g.bytes[(w * h) as usize..];
        let grey = chroma.iter().map(|v| (f64::from(*v) - 128.0).abs()).sum::<f64>() / chroma.len() as f64;
        out.push((f.pts, i64::from(make::read_number(&g)), grey));
    };
    let mut datas = Vec::new();
    read_samples(reader, t, 0, t.samples.count(), |i, b| datas.push((i, b.to_vec()))).expect("samples");
    for (i, b) in datas {
        dec.send(i, &b).expect("sent");
        while let Ok(Some(f)) = dec.receive() {
            take(f, &mut out);
        }
    }
    dec.finish().expect("drained");
    while let Ok(Some(f)) = dec.receive() {
        take(f, &mut out);
    }
    out
}

/// The sample where each beep starts: the first over a quarter of full scale after 100 ms of quiet.
fn onsets(x: &[f32]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut quiet = 0;
    for (i, v) in x.iter().enumerate() {
        if v.abs() > 0.25 {
            if quiet > RATE / 10 {
                out.push(i);
            }
            quiet = 0;
        } else {
            quiet += 1;
        }
    }
    out
}

/// The number the S1 frame at sequence frame `k` shows, or `None` inside the dissolve (frames 55..65).
fn expected(k: i64) -> Option<i64> {
    match k {
        0..55 => Some(k),
        55..65 => None,
        _ => Some(30 + (k - 60)),
    }
}

/// Checks a written S1 export (`first` .. `first + count` of the sequence's frames).
fn check(path: &Path, first: i64, count: usize, label: &str) {
    let bytes = std::fs::read(path).expect("the file");
    assert_eq!(&bytes[4..8], b"ftyp", "{label}: starts with ftyp");
    let ftyp = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
    assert_eq!(&bytes[ftyp + 4..ftyp + 8], b"moov", "{label}: faststart puts moov right after ftyp");
    let reader = FileReader::open(path).expect("open");
    let source = probe::open(&reader, &path.to_string_lossy());
    assert!(source.error.is_none(), "{label}: {:?}", source.error);
    let vt = source.tracks.iter().find(|t| t.kind() == Kind::Video).expect("video");
    let at = source.tracks.iter().find(|t| t.kind() == Kind::Audio).expect("audio");
    assert_eq!(vt.samples.count(), count, "{label}: frame count");
    let keys: Vec<u32> = vt.samples.keys.clone();
    let want_keys: Vec<u32> = (0..count as u32).step_by(60).collect();
    assert_eq!(keys, want_keys, "{label}: a key frame every 2 s");
    if let cut_formats::Media::Video(v) = &vt.media {
        let c = v.color_space.expect("colour tags");
        assert_eq!(
            (c.primaries, c.transfer, c.matrix, c.full_range),
            (Some(Primaries::Bt709), Some(Transfer::Bt709), Some(Matrix::Bt709), Some(false)),
            "{label}: BT.709 limited range"
        );
        assert_eq!(v.frame_rate, [30, 1], "{label}: 30 fps");
    }
    let got = frames(&reader, vt);
    assert_eq!(got.len(), count, "{label}: every frame decodes");
    let mut wrong = Vec::new();
    for (i, (pts, n, grey)) in got.iter().enumerate() {
        let k = first + i as i64;
        if *pts != i as i64 * FRAME {
            wrong.push(format!("frame {i} at {pts}"));
        }
        if let Some(e) = expected(k)
            && *n != e
        {
            wrong.push(format!("frame {i}: number {n}, want {e}"));
        }
        if k >= 65 && *grey > 1.5 {
            wrong.push(format!("frame {i}: chroma {grey:.1} from grey under Black & White"));
        }
        if k < 55 && *grey < 5.0 {
            wrong.push(format!("frame {i}: no colour before the effect ({grey:.1})"));
        }
    }
    let mixed: Vec<i64> =
        got.iter().enumerate().filter(|(i, _)| (55..65).contains(&(first + *i as i64))).map(|(_, g)| g.1).collect();
    eprintln!("{label}: dissolve frames read {mixed:?}");
    assert!(wrong.is_empty(), "{label}: {}", wrong.join("; "));
    // the sound: as long as the video, the beeps on their samples
    let duration = count as i64 * FRAME;
    assert!(
        (at.duration - duration).abs() <= TICKS / 48000 * 1024,
        "{label}: sound {} ticks for {duration}",
        at.duration
    );
    let pcm = cut_decode::decode_audio(&reader, at).expect("the sound decodes");
    let found = onsets(&pcm.data[0]);
    let from = first as f64 / 30.0;
    let want: Vec<f64> = BEEPS
        .iter()
        .filter(|b| **b >= from && **b < from + count as f64 / 30.0)
        .map(|b| (b - from) * RATE as f64 + 4.0)
        .collect();
    let offs: Vec<f64> = found.iter().zip(&want).map(|(f, w)| *f as f64 - w).collect();
    eprintln!("{label}: beeps at samples {found:?}, off by {offs:?} samples ({} expected)", want.len());
    assert_eq!(found.len(), want.len(), "{label}: every beep is there");
    assert!(offs.iter().all(|o| o.abs() <= 2.0), "{label}: the beeps start on their samples ({offs:?})");
    // Windows' own reader
    let r = read_with_source_reader(path).expect("the Media Foundation source reader opens the file");
    eprintln!("{label}: source reader {r:?}");
    assert_eq!(r.frames, count as u64, "{label}: the source reader decodes every frame");
    assert_eq!(r.first_frame, Some(0), "{label}: the source reader's first frame is at 0");
    assert!(
        (r.audio_samples as i64 - (count as i64 * 1600)).abs() <= 2048,
        "{label}: the source reader's sound length {}",
        r.audio_samples
    );
}

fn tidy(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_sequence_exports_frame_for_frame_with_its_sound_on_the_samples() {
    let sc = scene(&[]);
    let s = settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() });
    let (r, seen) = export(job(&sc, "s1-software.mp4", s));
    let done = r.unwrap_or_else(|f| panic!("export: {} {f}", f.code));
    eprintln!(
        "software export: {} bytes in {:.2} s ({:.1}x), {:?}, delay {:?}",
        done.bytes, done.seconds, done.speed, done.encoder, done.audio_delay
    );
    let v = done.verified.clone().expect("verified");
    assert!(v.ok, "the export checks itself: {:?}", v.problems);
    assert!(done.faststart && done.frames == 120, "{done:?}");
    let t = |s: Step| done.timing.get(s);
    let stages = t(Step::Stages);
    assert!(
        stages > 0.0 && t(Step::Render) > 0.0 && t(Step::EncodeIn) > 0.0 && t(Step::Verify) > 0.0,
        "{:?}",
        done.timing
    );
    for s in [Step::Render, Step::Convert, Step::RenderBlocked, Step::EncodeIdle, Step::EncodeIn, Step::ReadBack] {
        assert!(t(s) <= stages * 1.05, "{} {:.3} s inside {stages:.3} s of stages", s.as_str(), t(s));
    }
    assert!(
        t(Step::Prepare) + stages + t(Step::Verify) <= done.seconds * 1.05,
        "{:?} in {} s",
        done.timing,
        done.seconds
    );
    let phases: Vec<Phase> = seen.iter().map(|p| p.phase).fold(Vec::new(), |mut a, p| {
        if a.last() != Some(&p) {
            a.push(p);
        }
        a
    });
    assert_eq!(phases, [Phase::Audio, Phase::Video, Phase::Finish, Phase::Verify], "progress phases");
    let last = seen.iter().rfind(|p| p.phase == Phase::Video).expect("video progress");
    assert_eq!((last.done, last.total, last.fraction, last.eta), (120, 120, 1.0, Some(0.0)), "the last video progress");
    check(&done.path, 0, 120, "S1 software");
    assert!(!PathBuf::from(format!("{}.part", done.path.display())).exists(), "no part file is left");
    tidy(&done.path);
}

#[test]
fn every_encoder_this_pc_has_writes_the_same_frames() {
    let sc = scene(&[]);
    for codec in [Codec::H264, Codec::Hevc] {
        for e in video_encoders(codec) {
            if codec == Codec::Hevc && !e.hardware {
                continue;
            }
            let o = Overrides {
                loudness: Some(None),
                codec: Some(if codec == Codec::Hevc { presets::Family::Hevc } else { presets::Family::H264 }),
                ..Overrides::default()
            };
            let name = format!("s1-{}.mp4", e.label().chars().filter(char::is_ascii_alphanumeric).collect::<String>());
            let mut j = job(&sc, &name, settings("720p", &o));
            j.encoders = Some(vec![e.clone()]);
            match export(j).0 {
                Ok(done) => {
                    eprintln!("{} ({codec:?}): {} bytes, {:.1}x realtime", e.label(), done.bytes, done.speed);
                    check(&done.path, 0, 120, &e.label());
                    tidy(&done.path);
                }
                Err(f) => eprintln!("{} ({codec:?}) does not run here: {} {f}", e.label(), f.code),
            }
        }
    }
}

/// A journal that records what it is told: (added, path).
#[derive(Default)]
struct Told(std::sync::Mutex<Vec<(bool, String)>>);

impl cut_export::sink::Journal for Told {
    fn add(&self, part: &Path) {
        self.0.lock().unwrap().push((true, part.to_string_lossy().into_owned()));
    }
    fn remove(&self, part: &Path) {
        self.0.lock().unwrap().push((false, part.to_string_lossy().into_owned()));
    }
}

#[test]
fn an_in_to_out_range_exports_its_frames_from_zero() {
    let sc = scene(&[]);
    let mut j = job(&sc, "s1-range.mp4", settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() }));
    j.range = Some((sec(1.0), sec(2.5)));
    let told = Arc::new(Told::default());
    j.journal = Some(told.clone());
    let done = export(j).0.unwrap_or_else(|f| panic!("{} {f}", f.code));
    assert_eq!((done.frames, done.range), (45, (sec(1.0), sec(2.5))));
    let events = told.0.lock().unwrap().clone();
    let kinds: Vec<(bool, bool)> = events.iter().map(|(add, p)| (*add, p.ends_with(".part"))).collect();
    // The index goes into the room the part file kept for it: faststart makes no copy.
    assert_eq!(kinds, [(true, true), (false, true)], "only the part file: {events:?}");
    assert!(done.verified.as_ref().is_some_and(|v| v.ok), "{:?}", done.verified);
    check(&done.path, 30, 45, "range 1..2.5 s");
    tidy(&done.path);
}

#[test]
fn cancel_and_a_full_disk_leave_no_file_behind() {
    let sc = scene(&[]);
    let s = settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() });
    // cancel at a quarter
    let j = job(&sc, "s1-cancel.mp4", s);
    let path = j.path.clone();
    let cancel = AtomicBool::new(false);
    let mut part_seen = false;
    let r = run(j, &cancel, &mut |p| {
        if p.phase == Phase::Video && p.fraction >= 0.25 {
            part_seen |= PathBuf::from(format!("{}.part", path.display())).exists();
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
    let f = r.expect_err("cancelled");
    assert_eq!(f.code, "cancelled");
    assert!(part_seen, "the part file was being written");
    assert!(
        !path.exists() && !PathBuf::from(format!("{}.part", path.display())).exists(),
        "cancel leaves no file and no part file"
    );
    // a disk that is full after 1 MB, at 40 Mbps (the writer writes 2 MB at a time)
    let fast = settings("720p", &Overrides { loudness: Some(None), bitrate: Some(40e6), ..Overrides::default() });
    let mut long = Scene { project: sc.project.clone(), seq: sc.seq, first: sc.first, second: sc.second };
    let mut h = History::new(long.project.clone(), 10).expect("history");
    let media = long.project.media[0].id.as_str().to_owned();
    for k in 0..3 {
        h.apply(&cmd::place(long.seq.as_str(), json!({ "source": { "media": media }, "in": 0, "out": sec(3.0), "at": sec(4.0 + 3.0 * f64::from(k)), "video": "V1", "audio": null, "mode": "overwrite" })))
            .expect("placed");
    }
    long.project = h.project().clone();
    let mut j = job(&long, "s1-full.mp4", fast);
    j.disk_limit = Some(1_000_000);
    let path = j.path.clone();
    let mut at_failure = 0;
    let r = run(j, &AtomicBool::new(false), &mut |p| {
        if p.phase == Phase::Video {
            at_failure = p.done;
        }
    });
    let f = r.expect_err("the disk is full");
    eprintln!("full disk: {} {f} at frame {at_failure}", f.code);
    assert_eq!((f.code.as_str(), f.to_string().as_str()), ("diskFull", "the disk is full"));
    assert!(at_failure < 200, "the export stopped at the write that failed, not at the end ({at_failure})");
    assert!(
        !path.exists() && !PathBuf::from(format!("{}.part", path.display())).exists(),
        "a full disk leaves no file and no part file"
    );
}

#[test]
fn offline_media_exports_as_the_red_picture_and_is_named() {
    let gone = out_dir().join("export-no-such-file.mp4");
    tidy(&gone);
    let mut sc = scene(&[]);
    // a clip on V2 of media whose file is not there
    let mut m = media_json(&video());
    m["path"] = json!(gone.to_string_lossy());
    let mut h = History::new(sc.project.clone(), 10).expect("history");
    let id = h.apply(&cmd::import_media(json!([m]), None)).expect("imported")["ids"][0].as_str().unwrap().to_owned();
    h.apply(&cmd::place(sc.seq.as_str(), json!({ "source": { "media": id }, "in": 0, "out": sec(1.0), "at": sec(3.0), "video": "V2", "audio": null, "mode": "overwrite" })))
        .expect("placed");
    sc.project = h.project().clone();
    let done = export(job(
        &sc,
        "s1-offline.mp4",
        settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() }),
    ))
    .0
    .expect("exported");
    let v = done.verified.clone().expect("verified");
    let codes: Vec<&str> = v.problems.iter().map(|p| p.code).collect();
    assert_eq!(codes, ["offline"], "{:?}", v.problems);
    assert_eq!(done.offline.len(), 1);
    assert!(done.offline[0] != sc.first && done.offline[0] != sc.second);
    tidy(&done.path);
}

#[test]
fn audio_only_meets_its_loudness_target() {
    let tone = wav("export-tone-20.wav", 10.0, &[], 0.1, true);
    let mut p = cut_model::defaults::project();
    p.sequences[0].w = 1280;
    let mut h = History::new(p, 10).expect("history");
    let s = h.project().sequences[0].id.as_str().to_owned();
    let id = h.apply(&cmd::import_media(json!([media_json(&tone)]), None)).expect("imported")["ids"][0]
        .as_str()
        .unwrap()
        .to_owned();
    h.apply(&cmd::place(&s, json!({ "source": { "media": id }, "in": 0, "out": sec(10.0), "at": 0, "video": null, "audio": "A1", "mode": "overwrite" })))
        .expect("placed");
    let sc = Scene { project: h.project().clone(), seq: Id::new(&s), first: Id::new("x"), second: Id::new("y") };
    let st = presets::resolve(presets::get("audio-m4a").unwrap(), Fps::new(30, 1), None, &Overrides::default());
    let done = export(job(&sc, "tone.mp4", st)).0.unwrap_or_else(|f| panic!("{} {f}", f.code));
    assert!(done.path.to_string_lossy().ends_with(".m4a"), "the preset's extension");
    assert!(done.verified.as_ref().is_some_and(|v| v.ok), "{:?}", done.verified);
    let reader = FileReader::open(&done.path).unwrap();
    let source = probe::open(&reader, "tone.m4a");
    assert_eq!(source.tracks.len(), 1);
    let at = &source.tracks[0];
    assert!((at.duration - 10 * TICKS).abs() < TICKS / 20, "10 s of sound ({})", at.duration);
    let pcm = cut_decode::decode_audio(&reader, at).unwrap();
    let l = cut_audio::loudness::loudness(&[&pcm.data[0], &pcm.data[1]], f64::from(pcm.rate));
    eprintln!("audio only: gain {:.2} dB, {:.2} LUFS, {:.2} dBTP", done.loudness_gain, l.integrated, l.true_peak);
    assert!((done.loudness_gain - 6.0).abs() <= 0.5 && (l.integrated + 14.0).abs() <= 0.5, "-20 LUFS brought to -14");
    tidy(&done.path);
    tidy(&tone);
}

#[test]
fn a_closed_gate_holds_the_frames_until_it_opens() {
    let sc = scene(&[]);
    let mut j = job(&sc, "s1-gate.mp4", settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() }));
    j.range = Some((sec(0.0), sec(1.0)));
    let gate = Arc::new(AtomicBool::new(true));
    j.gate = Some(gate.clone());
    let frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let seen = frames.clone();
    let worker = std::thread::spawn(move || {
        let cancel = AtomicBool::new(false);
        run(j, &cancel, &mut |p| {
            if p.phase == Phase::Video {
                seen.store(p.done, std::sync::atomic::Ordering::Relaxed);
            }
        })
    });
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let held = frames.load(std::sync::atomic::Ordering::Relaxed);
    assert_eq!(held, 0, "no frame is made while the gate is closed");
    gate.store(false, std::sync::atomic::Ordering::Relaxed);
    let done = worker.join().unwrap().unwrap_or_else(|f| panic!("{} {f}", f.code));
    assert_eq!(done.frames, 30, "opened, the export runs to its end");
    tidy(&done.path);
}

#[test]
fn a_lost_gpu_device_ends_the_export_and_leaves_no_file() {
    let sc = scene(&[]);
    let mut j = job(&sc, "s1-lost.mp4", settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() }));
    let (device, queue) = cut_engine::gpu::Gpu::headless().expect("a GPU");
    j.gpu = Some((device.clone(), queue));
    let path = j.path.clone();
    let started = std::time::Instant::now();
    let mut destroyed = false;
    let r = run(j, &AtomicBool::new(false), &mut |p| {
        if p.phase == Phase::Video && p.done >= 10 && !destroyed {
            destroyed = true;
            device.destroy();
        }
    });
    let f = r.expect_err("the device is gone");
    eprintln!("lost device: {} {f} after {:.1} s", f.code, started.elapsed().as_secs_f64());
    assert!(destroyed, "the device was destroyed while the frames were made");
    assert_eq!(f.code, "compositor");
    assert!(f.to_string().starts_with("the GPU device was lost: "), "{f}");
    assert!(
        !path.exists() && !PathBuf::from(format!("{}.part", path.display())).exists(),
        "a lost device leaves no file and no part file"
    );
}

#[test]
fn srt_sidecars_name_the_speakers_when_the_track_shows_names() {
    let sc = scene(&[]);
    let mut h = History::new(sc.project.clone(), 10).expect("history");
    let s = sc.seq.as_str();
    h.apply(&cmd::set_speakers(Some(json!({ "list": [{ "id": "sp1", "name": "", "color": "#4fc3f7" },
        { "id": "sp2", "name": "민지", "color": "#ffb74d" }] }))))
        .expect("speakers");
    let items = json!([{ "start": 0, "end": sec(0.5), "text": "안녕하세요", "speaker": "sp1" },
        { "start": sec(0.5), "end": sec(0.8), "text": "hi", "speaker": "sp2" }, { "start": sec(0.8), "end": sec(0.9), "text": "plain" }]);
    for (lang, names) in [("ko", true), ("en", false)] {
        h.apply(&cmd::add_caption_track(s, json!({ "lang": lang, "items": items, "style": { "speakerName": names } })))
            .expect("a caption track");
    }
    let sc = Scene { project: h.project().clone(), ..sc };
    let mut j =
        job(&sc, "s1-speakers.mp4", settings("720p", &Overrides { loudness: Some(None), ..Overrides::default() }));
    j.range = Some((0, sec(1.0)));
    j.captions = Some(cut_export::CaptionMode::Srt);
    j.speaker_label = "화자 {n}".into();
    let done = export(j).0.unwrap_or_else(|f| panic!("{} {f}", f.code));
    let texts: Vec<String> = done.sidecars.iter().map(|p| std::fs::read_to_string(p).expect("an SRT")).collect();
    assert_eq!(done.sidecars.len(), 2, "{:?}", done.sidecars);
    assert!(texts[0].contains("화자 1: 안녕하세요") && texts[0].contains("민지: hi"), "{}", texts[0]);
    assert!(texts[0].lines().any(|l| l == "plain"), "a caption without a speaker keeps its text: {}", texts[0]);
    assert!(
        texts[1].lines().any(|l| l == "안녕하세요") && !texts[1].contains("민지"),
        "no names on a track that hides them"
    );
    for p in done.sidecars.iter().chain([&done.path]) {
        tidy(p);
    }
}

#[test]
fn auto_tries_every_encoder_in_the_measured_order() {
    use cut_export::encoder_choices;
    use cut_export::presets::Family;
    let all = video_encoders(Codec::H264);
    let rank = |e: &cut_decode::encode::EncoderInfo, big: bool| match (e.direct3d12(), e.hardware, big) {
        (true, _, true) => 0,
        (false, true, _) => 1,
        (false, false, _) => 2,
        (true, _, false) => 3,
    };
    for (pixels, big) in [(1920 * 1080, false), (3840 * 2160, true)] {
        let auto = encoder_choices(Family::H264, Hardware::Auto, pixels);
        assert_eq!(auto.len(), all.len(), "Auto keeps every encoder as a fallback");
        let ranks: Vec<u8> = auto.iter().map(|e| rank(e, big)).collect();
        assert!(
            ranks.windows(2).all(|w| w[0] <= w[1]),
            "{pixels} pixels: {:?}",
            auto.iter().map(|e| e.label()).collect::<Vec<_>>()
        );
        let hw = encoder_choices(Family::H264, Hardware::Hardware, pixels);
        assert!(hw.iter().all(|e| e.hardware) && hw.len() == all.iter().filter(|e| e.hardware).count());
        let sw = encoder_choices(Family::H264, Hardware::Software, pixels);
        assert!(sw.iter().all(|e| !e.hardware) && sw.len() == all.len() - hw.len());
    }
    assert!(encoder_choices(Family::Hevc, Hardware::Software, 0).iter().all(|e| e.hardware), "HEVC only on a GPU");
}
