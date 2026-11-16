//! The automation of `ui-auto.js` the native app has (the cases of `verify/cut-auto.mjs` 'silence', 'duck' and
//! 'color'): Remove Silence previews the quiet stretches on the timeline and ripple-deletes them from the dialogue and
//! not from a locked track; Auto Ducking writes the music's `duck` curve 12 dB down under the speech, and the rendered
//! mix is that much quieter there; Auto Color makes a warm picture neutral, the rendered frame's average included,
//! and its arithmetic is the JavaScript's (`analyze.autoColor` through the oracle). Each is one undo step.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::auto::{color, duck, silence};
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_engine::{Engine, RenderOptions};
use cut_model::commands::build as C;
use cut_model::keyframes::{Value, value_at};
use cut_model::{Id, TrackKind};
use cut_oracle::{Inputs, ask};
use cut_time::{TICKS, Ticks};
use eframe::egui;
use egui_kittest::Harness;
use serde_json::{Value as Json, json};

const S: f64 = TICKS as f64;
const F: f64 = S / 30.0;
/// The dialogue's quiet stretches (s): one shorter than the half-second minimum.
const GAPS: [(f64, f64); 3] = [(2.0, 3.0), (5.0, 5.3), (7.0, 8.2)];

fn secs(x: f64) -> Ticks {
    (x * S).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-auto-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 16-bit stereo 48 kHz WAV of `f(t)` (-1..1), as the JavaScript test writes it.
fn wav(path: &Path, seconds: f64, f: impl Fn(f64) -> f64) -> PathBuf {
    let rate = 48000u32;
    let n = (f64::from(rate) * seconds).round() as u32;
    let mut b = Vec::with_capacity(44 + n as usize * 4);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 4).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 4).to_le_bytes());
    b.extend_from_slice(&4u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 4).to_le_bytes());
    for i in 0..n {
        let v = (f(f64::from(i) / f64::from(rate)) * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
        b.extend_from_slice(&v.to_le_bytes());
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
    path.to_owned()
}

/// 10 s of a 1 kHz tone at 0.3, silent in [`GAPS`].
fn talk(dir: &Path) -> PathBuf {
    wav(&dir.join("talk.wav"), 10.0, |t| {
        if GAPS.iter().any(|(a, b)| t >= *a && t < *b) {
            0.0
        } else {
            0.3 * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()
        }
    })
}

/// 12 s of 440 Hz at -20 dBFS RMS.
fn music(dir: &Path) -> PathBuf {
    let amp = 10f64.powf(-20.0 / 20.0) * std::f64::consts::SQRT_2;
    wav(&dir.join("music.wav"), 12.0, move |t| amp * (2.0 * std::f64::consts::PI * 440.0 * t).sin())
}

/// A shell in English on a 30 fps sequence with the files placed: `(file, track, at, length, locked)`.
fn shell(dir: &Path, clips: &[(&Path, &str, f64, f64, bool)]) -> Shell {
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    let seq = s.app.sequence_id.unwrap();
    s.app.exec(&C::set_sequence(seq.as_str(), json!({ "fps": [30, 1], "w": 1280, "h": 720 }))).unwrap();
    for (file, track, at, len, locked) in clips {
        let media = cut_app::import::probe_file(file).result.expect("the file probes");
        let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
        let m = r["ids"][0].as_str().unwrap();
        let kind = if track.starts_with('V') { "video" } else { "audio" };
        let (v, a) = if kind == "video" { (Json::from(*track), Json::Null) } else { (Json::Null, Json::from(*track)) };
        s.app
            .exec(&C::place(
                seq.as_str(),
                json!({ "source": { "media": m }, "in": 0, "out": secs(*len), "at": secs(*at), "video": v, "audio": a, "mode": "overwrite" }),
            ))
            .unwrap();
        if *locked {
            s.app.exec(&cut_app::cmd::set_track(seq, Id::new(track), json!({ "locked": true }))).unwrap();
        }
    }
    s.app.selection.clear();
    s
}

fn clip_on(s: &Shell, track: &str) -> cut_model::Clip {
    s.app.sequence().unwrap().clips().find(|c| c.track.as_str() == track).unwrap().clone()
}

fn label(s: &Shell) -> String {
    s.app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

/// Polls an analysis until it is done.
fn until(s: &mut Shell, done: impl Fn(&Shell) -> bool, poll: impl Fn(&mut Shell)) {
    let start = Instant::now();
    while !done(s) {
        assert!(start.elapsed() < Duration::from_secs(60), "the analysis ends");
        poll(s);
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// RMS of the left channel of the mix over `[a, b)` seconds.
fn rms(p: &cut_model::Project, seq: Id, a: f64, b: f64) -> f64 {
    let mut m = cut_audio::Mixer::new(48000, cut_app::transport::file_audio(cut_audio::Library::default()));
    let out = cut_audio::offline::render(&mut m, p, seq, secs(a), secs(b), 0.0);
    (out[0].iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / out[0].len() as f64).sqrt()
}

/// `track:start-end[in]` of the clips, in seconds to the millisecond.
fn lay(s: &Shell, track: &str) -> Vec<(f64, f64, f64)> {
    let r = |x: f64| (x / S * 1000.0).round() / 1000.0;
    let mut v: Vec<_> = s
        .app
        .sequence()
        .unwrap()
        .clips()
        .filter(|c| c.track.as_str() == track)
        .map(|c| (r(c.start as f64), r(c.end() as f64), r(c.in_)))
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v
}

#[test]
fn remove_silence_previews_and_ripple_deletes_the_quiet_stretches() {
    let dir = scratch("silence");
    let (t, m) = (talk(&dir), music(&dir));
    let s = shell(&dir, &[(&t, "A1", 0.0, 10.0, false), (&m, "A2", 0.0, 12.0, true)]);
    let before = s.app.history.serialize();
    let a2 = lay(&s, "A2");
    let mut h =
        Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("auto.silence", &ctx);
    let start = Instant::now();
    while h.state().features.auto.silence.open.is_none() {
        assert!(start.elapsed() < Duration::from_secs(60), "the sound is measured");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(2);
    let ranges = |h: &Harness<'_, Shell>| -> Vec<(f64, f64)> {
        h.state()
            .timeline
            .overlay
            .as_ref()
            .map_or_else(Vec::new, |o| o.ranges.iter().map(|(a, b)| (a / S, b / S)).collect())
    };
    let want = [(2.1, 2.9), (7.1, 8.1)];
    let got = ranges(&h);
    assert!(
        got.len() == 2
            && got
                .iter()
                .zip(want)
                .all(|(g, w)| (g.0 - w.0).abs() <= F / S + 1e-6 && (g.1 - w.1).abs() <= F / S + 1e-6),
        "the preview shows two cuts before anything changes: {got:?}"
    );
    let tracks = h.state().timeline.overlay.as_ref().and_then(|o| o.tracks.clone()).unwrap();
    assert!(
        tracks.contains(&Id::new("A1")) && !tracks.contains(&Id::new("A2")),
        "over the dialogue, not the locked music"
    );
    assert_eq!(h.state().app.history.serialize(), before, "the preview changes nothing");
    // a shorter minimum length lets the 0.3 s gap go too
    h.state_mut().features.auto.silence.open.as_mut().unwrap().1.min_length = 0.2;
    h.run_steps(2);
    assert_eq!(ranges(&h).len(), 3, "a 0.2 s minimum adds the 0.3 s gap");
    h.state_mut().features.auto.silence.open.as_mut().unwrap().1.min_length = 0.5;
    h.run_steps(2);
    let steps = h.state().app.history.position();
    assert!(silence::remove(h.state_mut()), "Remove");
    h.run_steps(2);
    let a1 = lay(h.state(), "A1");
    let want = [(0.0, 2.1, 0.0), (2.1, 6.3, 2.9), (6.3, 8.2, 8.1)];
    assert!(
        a1.len() == 3
            && a1
                .iter()
                .zip(want)
                .all(|(g, w)| (g.0 - w.0).abs() < 0.034 && (g.1 - w.1).abs() < 0.034 && (g.2 - w.2).abs() < 0.034),
        "the silences are ripple-deleted from the dialogue: {a1:?}"
    );
    assert_eq!(lay(h.state(), "A2"), a2, "the locked music track keeps its clip");
    assert_eq!(
        (h.state().app.history.position(), label(h.state()), h.state().timeline.overlay.is_none()),
        (steps + 1, "Remove Silence".to_owned(), true),
        "one undo step named Remove Silence, and the overlay is gone"
    );
    h.state_mut().app.undo();
    assert_eq!(h.state().app.history.serialize(), before, "Ctrl+Z gives back the project as it was");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn auto_ducking_lowers_the_music_under_the_dialogue() {
    let dir = scratch("duck");
    let (t, m) = (talk(&dir), music(&dir));
    let mut s = shell(&dir, &[(&t, "A1", 0.0, 10.0, false), (&m, "A2", 0.0, 12.0, false)]);
    let ctx = egui::Context::default();
    let seq = s.app.sequence_id.unwrap();
    // without roles there is nothing to duck: the question about them
    s.run_action("auto.duck", &ctx);
    assert!(matches!(s.features.auto.duck.open, Some(duck::Open::Roles)), "Auto Ducking asks for the roles first");
    s.features.auto.duck.open = None;
    let (a1, a2) = (clip_on(&s, "A1").id, clip_on(&s, "A2").id);
    s.app.exec(&C::set_role(seq.as_str(), &[a1.as_str()], Some("dialogue"), json!({}))).unwrap();
    s.app.exec(&C::set_role(seq.as_str(), &[a2.as_str()], Some("music"), json!({}))).unwrap();
    let before = s.app.history.serialize();
    let steps = s.app.history.position();
    let run = |s: &mut Shell| {
        s.run_action("auto.duck", &egui::Context::default());
        let Some(duck::Open::Ask { o, dialogue, music }) = &s.features.auto.duck.open else { panic!("the dialog") };
        assert_eq!((*dialogue, *music, o.amount, o.fade, o.threshold), (1, 1, -12.0, 0.3, -40.0), "the defaults");
        let o = *o;
        duck::start(s, o);
        until(s, |s| s.features.auto.duck.job.is_none(), |s| duck::poll(s, false));
    };
    run(&mut s);
    let keys = clip_on(&s, "A2").keyframes.get("duck").cloned().expect("the music has a duck curve");
    let at = |x: f64| match value_at(&keys, x * S) {
        Some(Value::Num(v)) => v,
        _ => 0.0,
    };
    let (speech, short, gap, ramp, after) = (at(1.0), at(5.15), at(7.6), at(7.15), at(11.0));
    eprintln!(
        "duck: {} keyframes; {speech} dB under speech, {short} in the short pause, {gap} in the gap, {ramp} on the ramp, {after} after",
        keys.len()
    );
    assert!(
        keys.len() > 4
            && speech == -12.0
            && short == -12.0
            && gap == 0.0
            && ramp < -2.0
            && ramp > -10.0
            && after == 0.0,
        "12 dB down while the dialogue speaks and through the short pause, back up in the long gap and after"
    );
    assert!(!clip_on(&s, "A2").keyframes.contains_key("volume"), "the volume keyframes stay the user's");
    assert_eq!((s.app.history.position(), label(&s)), (steps + 1, "Auto Ducking".to_owned()), "one undo step");
    // heard: with the dialogue muted, the music under the speech is 12 dB below the music in the gap
    let mut probe = s.app.project().clone();
    probe.sequences[0].tracks.iter_mut().filter(|t| t.id.as_str() == "A1").for_each(|t| t.mute = Some(true));
    let (under, free) = (rms(&probe, seq, 0.5, 1.5), rms(&probe, seq, 7.35, 7.85));
    let db = 20.0 * (under / free).log10();
    eprintln!("music under the speech {db:.3} dB against the gap");
    assert!((db + 12.0).abs() < 0.1, "the mix ducks the music by 12 dB ({db:.3})");
    // again: the dips are replaced, not lowered twice
    let json = serde_json::to_string(&keys).unwrap();
    run(&mut s);
    let again = serde_json::to_string(clip_on(&s, "A2").keyframes.get("duck").unwrap()).unwrap();
    assert_eq!(again, json, "ducking again replaces the dips");
    // the second run changed nothing, so the history (which keeps no empty steps) has one step to take back
    eprintln!("steps after the second run: {}", s.app.history.position() - steps);
    while s.app.history.position() > steps {
        s.app.undo();
    }
    assert_eq!(s.app.history.serialize(), before, "Ctrl+Z takes the keyframes back");
    assert_eq!(s.app.sequence().unwrap().track(Id::new("A2")).map(|t| t.kind), Some(TrackKind::Audio));
    let _ = std::fs::remove_dir_all(&dir);
}

/// The average colour of the sequence's frame at 1 s, drawn by an engine of its own.
fn average(engine: &mut Engine, p: &cut_model::Project, seq: Id) -> [f64; 3] {
    let opts = RenderOptions { wait: Some(Duration::from_secs(20)), ..RenderOptions::default() };
    engine.render(p, seq, TICKS, (320, 180), &opts).expect("a render");
    let px = engine.read_pixels();
    let n = (px.len() / 4) as f64;
    let mut sum = [0.0; 3];
    for c in px.as_chunks::<4>().0 {
        for i in 0..3 {
            sum[i] += f64::from(c[i]);
        }
    }
    sum.map(|v| v / n)
}

fn spread(c: [f64; 3]) -> f64 {
    c.iter().copied().fold(f64::MIN, f64::max) - c.iter().copied().fold(f64::MAX, f64::min)
}

#[test]
fn auto_color_makes_a_warm_picture_neutral() {
    let dir = scratch("color");
    let warm = dir.join("warm.png");
    image::RgbImage::from_pixel(320, 180, image::Rgb([0x88, 0x7c, 0x6e])).save(&warm).unwrap();
    let mut s = shell(&dir, &[(&warm, "V1", 0.0, 2.0, false)]);
    let ctx = egui::Context::default();
    let seq = s.app.sequence_id.unwrap();
    let clip = clip_on(&s, "V1").id;
    assert!(!s.action_enabled("auto.color"), "nothing selected: Auto Color waits for a video clip");
    let mut engine = Engine::headless().expect("a GPU");
    let a0 = average(&mut engine, s.app.project(), seq);
    s.app.select([clip], false, false);
    s.app.set_time(TICKS);
    s.run_action("auto.color", &ctx);
    until(&mut s, |s| s.features.auto.color.job.is_none(), |s| color::poll(s, false));
    let c = clip_on(&s, "V1");
    let e = c.effects.iter().find(|e| e.kind == "color.basic").expect("color.basic is set");
    let p = |k: &str| e.params.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN);
    let a1 = average(&mut engine, s.app.project(), seq);
    eprintln!(
        "auto color: temperature {}, tint {}, exposure {}; frame {a0:.0?} -> {a1:.0?}",
        p("temperature"),
        p("tint"),
        p("exposure")
    );
    assert!(
        p("temperature") < -10.0 && p("tint").is_finite() && p("exposure").is_finite(),
        "a warm picture gets cooler"
    );
    assert!(spread(a1) < spread(a0) / 3.0, "the rendered frame's average becomes neutral ({a0:?} -> {a1:?})");
    assert_eq!(label(&s), "Auto Color", "one undo step named Auto Color");
    s.app.undo();
    assert!(clip_on(&s, "V1").effects.is_empty(), "Ctrl+Z removes the correction");
    // the clip's existing correction is set again, not doubled
    s.run_action("auto.color", &ctx);
    until(&mut s, |s| s.features.auto.color.job.is_none(), |s| color::poll(s, false));
    s.run_action("auto.color", &ctx);
    until(&mut s, |s| s.features.auto.color.job.is_none(), |s| color::poll(s, false));
    assert_eq!(clip_on(&s, "V1").effects.iter().filter(|e| e.kind == "color.basic").count(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn auto_colors_arithmetic_is_the_javascripts() {
    let mut r = Inputs::new(11);
    let mut sets: Vec<Vec<(Vec<u8>, u32, u32)>> = Vec::new();
    let solid = |rgb: [u8; 3], w: u32, h: u32| ((0..w * h).flat_map(|_| [rgb[0], rgb[1], rgb[2], 255]).collect(), w, h);
    sets.push(vec![solid([0x88, 0x7c, 0x6e], 64, 36)]);
    sets.push(vec![solid([0, 0, 0], 8, 8)]);
    sets.push(vec![solid([255, 255, 255], 8, 8)]);
    sets.push(vec![solid([250, 10, 10], 8, 8), solid([20, 40, 200], 8, 8)]);
    for _ in 0..60 {
        let n = r.range(1, 5) as usize;
        let mut set = Vec::new();
        for _ in 0..n {
            let (w, h) = (r.range(1, 24) as u32, r.range(1, 16) as u32);
            let base = [r.range(0, 255), r.range(0, 255), r.range(0, 255)];
            let spread = r.range(0, 120);
            let px: Vec<u8> = (0..w * h)
                .flat_map(|_| {
                    let mut c = base.map(|b| (b + r.range(-spread, spread)).clamp(0, 255) as u8).to_vec();
                    c.push(255);
                    c
                })
                .collect();
            set.push((px, w, h));
        }
        sets.push(set);
    }
    let calls: Vec<Json> = sets
        .iter()
        .map(|set| {
            json!(["autoColor", set.iter().map(|(px, w, h)| json!({ "rgba": px, "w": w, "h": h })).collect::<Vec<_>>()])
        })
        .collect();
    let want = ask("analyze", &calls);
    let mut bad = Vec::new();
    for (set, w) in sets.iter().zip(&want) {
        let images: Vec<color::Image> =
            set.iter().map(|(px, w, h)| color::Image { rgba: px.clone(), w: *w, h: *h }).collect();
        let got = color::auto_color(&images);
        let same = match (got, w) {
            (None, Json::Null) => true,
            (Some(g), Json::Object(o)) => {
                let f = |k: &str| o.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN);
                (g.temperature - f("temperature")).abs() < 1e-9
                    && (g.tint - f("tint")).abs() < 1e-9
                    && (g.exposure - f("exposure")).abs() < 1e-9
            }
            _ => false,
        };
        if !same {
            bad.push(format!("{got:?} vs {w}"));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), sets.len(), bad[..bad.len().min(5)].join("\n"));
    eprintln!("autoColor: {} picture sets agree with analyze.js", sets.len());
}

/// The literal texts of `tr("...")` and `trf("...", ..)` calls in a source file.
fn texts(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for start in ["tr(\"", "trf(\""] {
        let mut rest = src;
        while let Some(i) = rest.find(start) {
            let before = rest[..i].chars().last();
            rest = &rest[i + start.len()..];
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            let end = rest.find('"').unwrap_or(rest.len());
            out.push(rest[..end].to_owned());
        }
    }
    out
}

#[test]
fn every_text_of_round_threes_screens_is_translated() {
    let sources = [
        include_str!("../src/auto/mod.rs"),
        include_str!("../src/auto/duck.rs"),
        include_str!("../src/auto/silence.rs"),
        include_str!("../src/auto/color.rs"),
        include_str!("../src/auto/levels.rs"),
        include_str!("../src/auto/scenes.rs"),
        include_str!("../src/auto/beats.rs"),
        include_str!("../src/audio/response.rs"),
        include_str!("../src/edit/mismatch.rs"),
        include_str!("../src/panels/new_item.rs"),
    ];
    let mut all: Vec<String> = sources.iter().flat_map(|s| texts(s)).collect();
    all.extend(
        [
            "Remove Silence…",
            "Detect Scene Changes…",
            "Detect Beats…",
            "Add Scene Markers",
            "Split at Scene Changes",
            "Add Beat Markers",
            "Auto Ducking…",
            "Auto Color",
            "Auto",
            "The clip's media cannot be read.",
            "Auto Color: neutral white balance and mid-grey exposure from the picture at the playhead",
            "Track volume (0 to 200%)",
            "Delete track {name} and its clips?",
            "Set Volume…",
            "Track Volume",
            "Safe Margins",
            "Nothing to undo",
            "Nothing to redo",
            "Bin added",
            "Choose two or more clips to group.",
            "No selected clip is in a group.",
            "There are no media files in that folder.",
        ]
        .map(str::to_owned),
    );
    let missing: Vec<&String> = all.iter().filter(|t| !cut_app::i18n::has_korean(t)).collect();
    assert!(all.len() > 50, "{} texts found", all.len());
    assert!(missing.is_empty(), "untranslated: {missing:?}");
}
