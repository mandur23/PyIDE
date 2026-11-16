//! Detect Scene Changes and Detect Beats (`ui-auto.js`, the cases of `verify/cut-auto.mjs` 'scenes' and 'beats' and
//! `verify/cut-analyze.mjs` 'scenes'): a generated video with hard cuts at 2 s and 4 s gets markers on the cuts'
//! first frames, then is split there with its linked sound, each one undo step; a 45 s video's detection waits while
//! the player plays and its Cancel changes nothing, and run again it finds both cuts; a click track at 120 BPM gets a
//! beat marker on every click and, every bar, on the accents; the histograms and the scene search are the
//! JavaScript's (`analyze.histogram`, `histDistance`, `detectScenes` through the oracle).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::auto::{self, beats, pictures, scenes};
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_decode::Codec;
use cut_decode::encode::{VideoSettings, encode_aac, encode_video};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample, VideoConfig};
use cut_model::MarkerKind;
use cut_model::commands::build as C;
use cut_oracle::{Inputs, ask, ask_scenario, bytes};
use cut_time::{TICKS, Ticks, rescale};
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

const S: f64 = TICKS as f64;

fn secs(x: f64) -> Ticks {
    (x * S).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-detect-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A 320 x 180 H.264 video at 30 fps (a key frame every `key_every` frames) whose background changes colour at each
/// of `cuts` (s), with a white square moving across it; with `tone`, 48 kHz stereo AAC of a 440 Hz tone beside it.
fn scene_video(path: &Path, seconds: f64, cuts: &[f64], key_every: u32, tone: bool) -> PathBuf {
    const SCENES: [(u8, u8, u8); 4] = [(60, 90, 170), (150, 60, 200), (120, 200, 70), (40, 160, 110)];
    let (w, h) = (320u32, 180u32);
    let frames = (seconds * 30.0).round() as u32;
    let s = VideoSettings {
        codec: Codec::H264,
        width: w,
        height: h,
        fps: [30, 1],
        bitrate: 600_000,
        key_every,
        b_frames: 0,
        ten_bit: false,
    };
    let enc = encode_video(&s, frames, |i, px| {
        let scene = cuts.iter().filter(|c| f64::from(i) / 30.0 >= **c).count() % SCENES.len();
        let (y, u, v) = SCENES[scene];
        let x0 = (i * 3) % (w - 20);
        let (luma, chroma) = px.split_at_mut((w * h) as usize);
        for yy in 0..h {
            for xx in 0..w {
                let square = (80..100).contains(&yy) && (x0..x0 + 20).contains(&xx);
                luma[(yy * w + xx) as usize] = if square { 235 } else { y };
            }
        }
        for pair in chroma.as_chunks_mut::<2>().0 {
            *pair = [u, v];
        }
    })
    .expect("encoded");
    let frame = TICKS / 30;
    let video = VideoConfig {
        codec: enc.codec.clone(),
        width: w,
        height: h,
        description: Some(enc.description.clone()),
        frame_rate: Some([30, 1]),
        color_space: None,
    };
    let sound = tone.then(|| {
        let n = (48000.0 * seconds) as usize;
        let pcm: Vec<i16> = (0..n)
            .flat_map(|i| {
                let v = ((i as f64 / 48000.0 * 440.0 * std::f64::consts::TAU).sin() * 0.3 * 32767.0) as i16;
                [v, v]
            })
            .collect();
        encode_aac(&pcm, 48000, 2, 24000).expect("encoded sound")
    });
    let audio = sound.as_ref().map(|a| AudioConfig {
        codec: a.codec.clone(),
        sample_rate: 48000,
        channels: 2,
        description: Some(a.description.clone()),
    });
    let mut writer = Mp4Writer::create(Some(video), audio, Vec::new(), None).expect("a writer");
    let first = enc.samples.iter().map(|x| x.pts).min().unwrap_or(0);
    for x in &enc.samples {
        let k = (x.pts - first + 166_666) / 333_333;
        let sample =
            Sample { data: x.data.clone(), timestamp: k * frame, duration: frame, key: x.key, composition_offset: 0 };
        writer.add_video(sample).expect("a sample");
    }
    for (k, x) in sound.iter().flat_map(|a| a.samples.iter()).enumerate() {
        let at = k as i64 * 1024 - 1024;
        let sample = Sample {
            data: x.data.clone(),
            timestamp: rescale(at, 48000),
            duration: rescale(1024, 48000),
            key: true,
            composition_offset: 0,
        };
        writer.add_audio(sample).expect("a sample");
    }
    writer.finish().expect("finished");
    std::fs::write(path, writer.into_sink()).unwrap();
    path.to_owned()
}

/// 16-bit stereo 48 kHz WAV of `f(t)` (-1..1).
fn wav(path: &Path, seconds: f64, f: impl Fn(f64) -> f64) -> PathBuf {
    let rate = 48000u32;
    let n = (f64::from(rate) * seconds).round() as u32;
    let mut b = Vec::with_capacity(44 + n as usize * 4);
    for part in [&b"RIFF"[..], &(36 + n * 4).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes()] {
        b.extend_from_slice(part);
    }
    for part in [&2u16.to_le_bytes()[..], &rate.to_le_bytes(), &(rate * 4).to_le_bytes(), &4u16.to_le_bytes()] {
        b.extend_from_slice(part);
    }
    for part in [&16u16.to_le_bytes()[..], b"data", &(n * 4).to_le_bytes()] {
        b.extend_from_slice(part);
    }
    for i in 0..n {
        let v = (f(f64::from(i) / f64::from(rate)) * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
        b.extend_from_slice(&v.to_le_bytes());
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
    path.to_owned()
}

/// A shell in English on a 30 fps sequence with `file` placed at `at` s for `len` s (its picture on V1 and its sound
/// on A1, linked, when it has both).
fn shell(dir: &Path, file: &Path, at: f64, len: f64) -> Shell {
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    let seq = s.app.sequence_id.unwrap();
    s.app.exec(&C::set_sequence(seq.as_str(), json!({ "fps": [30, 1], "w": 1280, "h": 720 }))).unwrap();
    let media = cut_app::import::probe_file(file).result.expect("the file probes");
    let (v, a) = (!media["video"].is_null(), !media["audio"].is_null());
    let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
    let m = r["ids"][0].as_str().unwrap();
    let pick = |on: bool, t: &str| if on { Json::from(t) } else { Json::Null };
    s.app
        .exec(&C::place(
            seq.as_str(),
            json!({ "source": { "media": m }, "in": 0, "out": secs(len), "at": secs(at), "video": pick(v, "V1"), "audio": pick(a, "A1"), "mode": "overwrite" }),
        ))
        .unwrap();
    s.app.selection.clear();
    s
}

/// Runs the frames' work until `done`.
fn until(s: &mut Shell, done: impl Fn(&Shell) -> bool, poll: impl Fn(&mut Shell)) {
    let start = Instant::now();
    while !done(s) {
        assert!(start.elapsed() < Duration::from_secs(120), "the analysis ends");
        poll(s);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn label(s: &Shell) -> String {
    s.app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

/// `start-end` of the clips on a track, in seconds to the millisecond, by start.
fn lay(s: &Shell, track: &str) -> String {
    let seq = s.app.sequence().unwrap();
    let mut v: Vec<_> = seq.clips().filter(|c| c.track.as_str() == track).map(|c| (c.start, c.end())).collect();
    v.sort();
    v.iter().map(|(a, b)| format!("{:.3}-{:.3}", *a as f64 / S, *b as f64 / S)).collect::<Vec<_>>().join(" ")
}

fn marks(s: &Shell) -> Vec<(f64, MarkerKind, String)> {
    s.app.sequence().unwrap().markers.iter().map(|m| (m.t as f64 / S, m.kind, m.name.clone())).collect()
}

fn last_toast(s: &Shell) -> String {
    s.app.notices.last().map(|n| n.text.clone()).unwrap_or_default()
}

#[test]
fn scene_changes_become_markers_then_splits_each_one_step() {
    let dir = scratch("scenes");
    let file = scene_video(&dir.join("cuts.mp4"), 6.0, &[2.0, 4.0], 30, true);
    let mut s = shell(&dir, &file, 1.0, 6.0);
    let ctx = egui::Context::default();
    let before = s.app.history.serialize();
    let steps = s.app.history.position();
    assert!(s.action_enabled("auto.scenes") && s.action_enabled("auto.beats"), "the menu items are on");
    s.run_action("auto.scenes", &ctx);
    let ask = s.features.auto.scenes.open.expect("the dialog");
    assert_eq!((ask.threshold, ask.action, ask.clips), (35.0, scenes::Action::Markers, 1), "the defaults");
    scenes::start(&mut s, ask.threshold, ask.action);
    until(&mut s, |s| s.features.auto.scenes.job.is_none(), |s| scenes::poll(s, false));
    let m = marks(&s);
    eprintln!("scene markers: {m:?}");
    assert_eq!(
        m.iter().map(|(t, k, n)| (format!("{t:.3}"), *k, n.as_str())).collect::<Vec<_>>(),
        [("3.000".to_owned(), MarkerKind::Comment, "Scene 2"), ("5.000".to_owned(), MarkerKind::Comment, "Scene 3")],
        "markers at the two hard cuts, on their first frames"
    );
    assert_eq!(m.len(), 2);
    assert_eq!((s.app.history.position(), label(&s)), (steps + 1, "Add Scene Markers".to_owned()), "one undo step");
    assert_eq!(last_toast(&s), "Scene changes found: 2.");
    s.app.undo();
    assert_eq!(s.app.history.serialize(), before, "Ctrl+Z removes them");
    // splitting, from the clip menu's Automation submenu (the clip selected), remembered for the next time
    let v1 = s.app.sequence().unwrap().clips().find(|c| c.track.as_str() == "V1").unwrap().id;
    s.app.select([v1], false, false);
    s.run_action("auto.scenes", &ctx);
    scenes::start(&mut s, 35.0, scenes::Action::Split);
    until(&mut s, |s| s.features.auto.scenes.job.is_none(), |s| scenes::poll(s, false));
    let (v, a) = (lay(&s, "V1"), lay(&s, "A1"));
    assert_eq!((v.as_str(), a.as_str()), ("1.000-3.000 3.000-5.000 5.000-7.000", v.as_str()), "split with the sound");
    assert_eq!(label(&s), "Split at Scene Changes");
    s.app.undo();
    assert_eq!(s.app.history.serialize(), before, "Ctrl+Z joins them again");
    s.run_action("auto.scenes", &ctx);
    assert_eq!(s.features.auto.scenes.open.map(|o| o.action), Some(scenes::Action::Split), "the choice is kept");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_long_detection_waits_while_playing_and_its_cancel_changes_nothing() {
    let dir = scratch("long");
    let file = scene_video(&dir.join("long.mp4"), 45.0, &[15.0, 30.0], 60, false);
    let mut s = shell(&dir, &file, 0.0, 45.0);
    let before = s.app.history.serialize();
    scenes::start(&mut s, 35.0, scenes::Action::Markers);
    let fraction = |s: &Shell| s.features.auto.scenes.job.as_ref().map_or(1.0, |j| j.fraction());
    until(&mut s, |s| fraction(s) > 0.05, |s| scenes::poll(s, false));
    until(&mut s, |s| s.features.auto.scenes.job.as_ref().is_some_and(|j| j.paused()), |s| scenes::poll(s, true));
    let p0 = fraction(&s);
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_millis(800) {
        scenes::poll(&mut s, true);
        std::thread::sleep(Duration::from_millis(20));
    }
    let p1 = fraction(&s);
    eprintln!("paused at {p0} -> {p1}");
    assert!(p0 == p1 && p0 < 0.9, "while the player plays the detection waits ({p0} -> {p1})");
    scenes::poll(&mut s, false);
    until(&mut s, |s| !s.features.auto.scenes.job.as_ref().is_some_and(|j| j.paused()), |s| scenes::poll(s, false));
    auto::cancel(&mut s);
    until(&mut s, |s| s.features.auto.scenes.job.is_none(), |s| scenes::poll(s, false));
    assert_eq!(last_toast(&s), "The analysis was cancelled.");
    assert!(marks(&s).is_empty() && s.app.history.serialize() == before, "Cancel stops it and changes nothing");
    let t0 = Instant::now();
    scenes::start(&mut s, 35.0, scenes::Action::Markers);
    until(&mut s, |s| s.features.auto.scenes.job.is_none(), |s| scenes::poll(s, false));
    let m: Vec<String> = marks(&s).iter().map(|(t, ..)| format!("{t:.3}")).collect();
    eprintln!("45 s of video looked at in {:.2} s: {m:?}", t0.elapsed().as_secs_f64());
    assert_eq!(m, ["15.000", "30.000"], "run again, it finds both cuts of the 45 s clip");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 20 s of clicks at 120 BPM from 0.2 s, every fourth louder (`verify/cut-auto.mjs` 'beats') -> the file and the
/// click times.
fn clicks(dir: &Path) -> (PathBuf, Vec<f64>) {
    let times: Vec<f64> = (0..).map(|k| 0.2 + f64::from(k) * 0.5).take_while(|t| *t < 19.9).collect();
    let file = wav(&dir.join("clicks.wav"), 20.0, |t| {
        let k = ((t - 0.2) / 0.5).floor();
        let d = t - (0.2 + k * 0.5);
        if k < 0.0 || d > 0.03 {
            return 0.0;
        }
        let amp = if k.rem_euclid(4.0) == 0.0 { 0.9 } else { 0.35 };
        amp * (-d / 0.006).exp() * (2.0 * std::f64::consts::PI * 2000.0 * d).sin()
    });
    (file, times)
}

#[test]
fn a_click_track_gets_a_beat_marker_on_every_click_and_bars_on_the_accents() {
    let dir = scratch("beats");
    let (file, times) = clicks(&dir);
    let mut s = shell(&dir, &file, 0.0, 20.0);
    let ctx = egui::Context::default();
    s.run_action("auto.beats", &ctx);
    assert!(s.features.auto.beats.open.is_none(), "nothing selected: no dialog");
    assert_eq!(last_toast(&s), "Select an audio clip first.");
    let a1 = s.app.sequence().unwrap().clips().next().unwrap().id;
    s.app.select([a1], false, false);
    let before = s.app.history.serialize();
    s.run_action("auto.beats", &ctx);
    assert_eq!(s.features.auto.beats.open, Some(beats::Every::Beat), "the dialog, every beat");
    beats::start(&mut s, beats::Every::Beat);
    until(&mut s, |s| s.features.auto.beats.job.is_none(), |s| beats::poll(s, false));
    let m = marks(&s);
    let toast = last_toast(&s);
    let bpm: f64 = toast.split(' ').next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
    let on = times.iter().filter(|c| m.iter().any(|(t, ..)| (t - **c).abs() <= 1.0 / 30.0 + 1e-6)).count();
    eprintln!("{toast} {} markers, {on} of {} clicks", m.len(), times.len());
    assert!((bpm - 120.0).abs() < 0.3, "the tempo is 120 BPM within the JavaScript's tolerance ({toast})");
    assert!(
        m.len().abs_diff(times.len()) <= 1
            && on + 1 >= times.len()
            && m.iter().all(|(_, k, n)| *k == MarkerKind::Beat && n.is_empty()),
        "a beat marker on every click, within a frame ({} markers, {on}/{} clicks)",
        m.len(),
        times.len()
    );
    assert_eq!(toast, format!("{bpm:.1} BPM: {} beat markers.", m.len()));
    assert_eq!(label(&s), "Add Beat Markers", "one undo step named Add Beat Markers");
    // every bar, run over the beats: the earlier markers go, the new ones on the accents numbered from 1
    beats::start(&mut s, beats::Every::Bar);
    until(&mut s, |s| s.features.auto.beats.job.is_none(), |s| beats::poll(s, false));
    let bars = marks(&s);
    let accents: Vec<f64> = times.iter().step_by(4).copied().collect();
    let on = bars.iter().filter(|(t, ..)| accents.iter().any(|c| (t - c).abs() <= 1.0 / 30.0 + 1e-6)).count();
    eprintln!("every bar: {} markers, {on} on the accents", bars.len());
    assert!(
        bars.len() + 1 >= accents.len() && on + 1 >= bars.len() && bars[0].2 == "1" && bars[1].2 == "2",
        "every bar: {} markers, {on} on the accents, numbered from 1",
        bars.len()
    );
    s.app.undo();
    s.app.undo();
    assert_eq!(s.app.history.serialize(), before, "Ctrl+Z takes the markers back");
    s.run_action("auto.beats", &ctx);
    assert_eq!(s.features.auto.beats.open, Some(beats::Every::Bar), "the choice is kept");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A small picture: a background, a moving square and a bar whose length changes, a flash, fades and noise.
fn picture(rng: &mut Inputs, w: usize, h: usize, k: usize, bg: [u8; 3], noise: i64) -> Vec<u8> {
    let mut px = Vec::with_capacity(w * h * 4);
    let x0 = (k * 3) % w.saturating_sub(4).max(1);
    for y in 0..h {
        for x in 0..w {
            let square = y >= h / 4 && y < h / 2 && x >= x0 && x < x0 + 4;
            let bar = y >= 3 * h / 4 && x < (k % 10) * w / 12;
            let c = if square {
                [235; 3]
            } else if bar {
                [200; 3]
            } else {
                bg
            };
            for v in c {
                px.push((i64::from(v) + rng.range(-noise, noise)).clamp(0, 255) as u8);
            }
            px.push(255);
        }
    }
    px
}

#[test]
fn histograms_and_the_scene_search_are_the_javascripts() {
    let mut rng = Inputs::new(17);
    // histograms of random pictures at several bin counts
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for k in 0..120 {
        let (w, h) = (rng.range(0, 40) as usize, rng.range(0, 30) as usize);
        let mut px: Vec<u8> = (0..w * h * 4).map(|_| rng.range(0, 255) as u8).collect();
        if k % 10 == 9 {
            px.truncate(rng.range(0, px.len() as i64) as usize);
        }
        let bins = [8usize, 4, 5, 16, 1, 3][k % 6];
        calls.push(json!(["histogram", bytes(&px), w, h, bins]));
        ours.push(pictures::histogram(&px, w, h, bins));
    }
    let js = ask("analyze", &calls);
    let mut dist_calls = Vec::new();
    let mut dists = Vec::new();
    for ((o, j), call) in ours.iter().zip(&js).zip(&calls) {
        let j: Vec<f32> = j.as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
        assert_eq!(*o, j, "{}", &call.to_string()[..80]);
    }
    for pair in (0..ours.len() - 6).map(|i| [&ours[i], &ours[i + 6]]).filter(|p| p[0].len() == p[1].len()) {
        let f = |h: &[f32]| h.iter().map(|v| f64::from(*v)).collect::<Vec<_>>();
        dist_calls.push(json!(["histDistance", f(pair[0]), f(pair[1])]));
        dists.push(pictures::hist_distance(pair[0], pair[1]));
    }
    for (o, j) in dists.iter().zip(&ask("analyze", &dist_calls)) {
        assert_eq!(*o, j.as_f64().unwrap(), "histDistance");
    }
    // scene searches: hard cuts, white flashes, fades, noise, at random thresholds, steps and ranges
    let (w, h) = (16, 9);
    let mut cases = Vec::new();
    for c in 0..60 {
        let n = rng.range(2, 90) as usize;
        let cuts: Vec<usize> = (0..rng.range(0, 4)).map(|_| rng.range(0, n as i64 - 1) as usize).collect();
        let flash = rng.range(0, n as i64);
        let fade = rng.range(0, 2) == 0;
        let noise = rng.pick(&[0, 0, 4, 30]);
        let palette: Vec<[u8; 3]> =
            (0..5).map(|_| [rng.range(0, 255) as u8, rng.range(0, 255) as u8, rng.range(0, 255) as u8]).collect();
        let frames: Vec<Vec<u8>> = (0..n)
            .map(|k| {
                let scene = cuts.iter().filter(|x| k >= **x).count();
                let mut bg = palette[scene % palette.len()];
                if k as i64 == flash {
                    bg = [255; 3];
                }
                if fade && k < 20 {
                    bg = bg.map(|v| (f64::from(v) * k as f64 / 20.0).round() as u8);
                }
                picture(&mut rng, w, h, k, bg, noise)
            })
            .collect();
        let r0 = rng.range(0, (n / 3) as i64);
        let r1 = if c % 7 == 0 { r0 } else { rng.range(r0, n as i64 - 1) };
        let threshold = [0.35, 0.1, 0.5, 0.9, 0.05][c % 5];
        let step = [2, 1, 3, 5][c % 4];
        cases.push((frames, r0, r1, threshold, step));
    }
    let calls: Vec<Json> = cases
        .iter()
        .map(|(f, r0, r1, t, st)| {
            json!(["scenes", f.iter().map(|x| bytes(x)).collect::<Vec<_>>(), w, h, r0, r1, t, st])
        })
        .collect();
    let js = ask_scenario("analyze", &calls);
    let mut found = 0;
    for ((frames, r0, r1, t, st), j) in cases.iter().zip(&js) {
        let mut asked = Vec::new();
        let cuts = pictures::detect_scenes(
            *r0,
            *r1,
            |r| -> Result<Vec<f32>, ()> {
                asked.push(r);
                Ok(pictures::histogram(&frames[r as usize], w, h, 8))
            },
            *t,
            *st,
            |_| {},
        )
        .unwrap();
        let ints = |v: &Json| v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(
            (cuts.clone(), asked),
            (ints(&j["cuts"]), ints(&j["asked"])),
            "r {r0}..{r1}, threshold {t}, step {st}"
        );
        found += cuts.len();
    }
    // `verify/cut-analyze.mjs` 'scenes': the cut on its first frame, the flash ignored, a fade gives at most one cut
    let frame = |k: usize| {
        let bg = if k == 15 {
            [255; 3]
        } else if k >= 31 {
            [180, 90, 40]
        } else {
            [30, 42, 58]
        };
        picture(&mut Inputs::new(0), 64, 36, k, bg, 0)
    };
    let hist = |k: usize| pictures::histogram(&frame(k), 64, 36, 8);
    let mut asked = std::collections::HashSet::new();
    let cuts = pictures::detect_scenes(
        0,
        59,
        |k| -> Result<_, ()> {
            asked.insert(k);
            Ok(hist(k as usize))
        },
        0.35,
        2,
        |_| {},
    );
    assert_eq!(cuts, Ok(vec![31]), "the hard cut on the new scene's first frame; the white flash is not a cut");
    assert!(asked.len() < 45, "stepping two frames reads {} of 60 frames", asked.len());
    assert!(pictures::hist_distance(&hist(3), &hist(4)) < 0.1 && pictures::hist_distance(&hist(20), &hist(40)) > 0.8);
    let stopped = pictures::detect_scenes(
        0,
        59,
        |k| if k > 10 { Err("cancelled") } else { Ok(hist(k as usize)) },
        0.35,
        2,
        |_| {},
    );
    assert_eq!(stopped, Err("cancelled"), "a cancelled detection stops");
    let faded = |k: usize| {
        let f = ((k as f64 - 10.0) / 16.0).clamp(0.0, 1.0);
        let bg = if k >= 60 { [40, 90, 160] } else { [200u8, 190, 170].map(|v| (f64::from(v) * f).round() as u8) };
        let mut px = Vec::with_capacity(64 * 36 * 4);
        let x0 = (k * 3) % (64 - 8);
        for y in 0..36 {
            for x in 0..64 {
                let c = if (10..18).contains(&y) && (x0..x0 + 8).contains(&x) {
                    bg.map(|v| v.saturating_add(40))
                } else {
                    bg
                };
                px.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        pictures::histogram(&px, 64, 36, 8)
    };
    let fade_cuts =
        pictures::detect_scenes(0, 89, |k| -> Result<_, ()> { Ok(faded(k as usize)) }, 0.35, 2, |_| {}).unwrap();
    assert!(
        fade_cuts.iter().filter(|k| **k < 40).count() <= 1 && fade_cuts.contains(&60) && fade_cuts.len() <= 2,
        "a fade in gives at most one cut, the hard cut after it is still found ({fade_cuts:?})"
    );
    eprintln!(
        "histograms: {} pictures, {} distances; scene searches: {} ({found} cuts) agree with analyze.js",
        ours.len(),
        dists.len(),
        cases.len()
    );
}

#[test]
fn the_dialogs_detect_from_their_buttons_and_lists() {
    let dir = scratch("dialogs");
    let (file, _) = clicks(&dir);
    let mut s = shell(&dir, &file, 0.0, 20.0);
    let a1 = s.app.sequence().unwrap().clips().next().unwrap().id;
    s.app.select([a1], false, false);
    let mut h =
        Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("auto.beats", &ctx);
    h.run_steps(2);
    h.query_all_by_value("Every beat").next().expect("the list with its choice").click();
    h.run_steps(2);
    h.get_by_label("Every bar (4 beats)").click();
    h.run_steps(2);
    assert_eq!(h.state().features.auto.beats.open, Some(beats::Every::Bar), "Every bar chosen in the list");
    h.get_by_label("Detect").click();
    h.run_steps(2);
    let start = Instant::now();
    while h.state().features.auto.beats.job.is_some() {
        assert!(start.elapsed() < Duration::from_secs(60), "the analysis ends");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    let names: Vec<String> = marks(h.state()).into_iter().map(|m| m.2).take(3).collect();
    assert_eq!(names, ["1", "2", "3"], "Detect ran with every bar");
    let _ = std::fs::remove_dir_all(&dir);
}
