//! Voice isolation with the fake backend (`PYIDE_VOICE_BACKEND=fake`: the vocals are the sound itself), the cases of
//! `verify/cut-voice-core.mjs` and `verify/cut-voice.mjs` 'command', 'cancel', 'bin' and 'missing': the WAV in the
//! workspace's Media folder through a `.part` that never stays, the key that finds it again, Cancel leaving nothing,
//! the real backend with an empty Hugging Face cache downloading nothing; in the window, Isolate Voice from the top
//! bar's Automation menu with the setup dialog on first use (each pretend failure code explained, Try Again, Cancel),
//! the clip keeping its place, in, out and link as one undo step, the file made before used again, the clip menu's and
//! Essential Sound's items, Cancel in the progress box, a failed separation leaving no file and no step, and the
//! Project panel's Isolate Voice leaving the timeline as it is.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cut_app::files::Home;
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_app::voice::backend::{Backend, Sound};
use cut_app::voice::files::{self, Place};
use cut_model::Id;
use cut_sidecar::sound::SoundFiles;
use cut_time::{TICKS, Ticks};
use eframe::egui::{self, Modifiers, Pos2, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

/// The tests share the process's temp files of sound: one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

type H = Harness<'static, Shell>;

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-voice-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 16-bit stereo 48 kHz WAV of 1 kHz beeps of 0.3 s every second.
fn beeps(path: &Path, seconds: f64) -> PathBuf {
    let rate = 48000u32;
    let n = (f64::from(rate) * seconds) as u32;
    let mut b = Vec::with_capacity(44 + n as usize * 4);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 4).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    for v in [16u32.to_le_bytes(), [1, 0, 2, 0], rate.to_le_bytes(), (rate * 4).to_le_bytes(), [4, 0, 16, 0]] {
        b.extend_from_slice(&v);
    }
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 4).to_le_bytes());
    for i in 0..n {
        let t = f64::from(i) / f64::from(rate);
        let v = if t.fract() < 0.3 { ((t * 1000.0 * std::f64::consts::TAU).sin() * 0.4 * 32767.0) as i16 } else { 0 };
        b.extend_from_slice(&v.to_le_bytes());
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
    path.to_owned()
}

fn wavs(dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_lowercase().ends_with(".wav") || n.to_lowercase().ends_with(".wav.part"))
        .collect();
    v.sort();
    v
}

/// The RMS of source seconds `[a, b)` of a file's sound, all channels.
fn rms(path: &str, a: f64, b: f64) -> f64 {
    let mut r = cut_audio::Library::default().audio(Path::new(path)).unwrap().unwrap();
    let rate = cut_audio::AudioRead::rate(&r);
    let planes = cut_audio::AudioRead::read(&mut r, (a * rate) as i64, (b * rate) as i64).unwrap();
    let (mut s, mut n) = (0.0_f64, 0.0_f64);
    for p in &planes {
        for x in p {
            s += f64::from(*x) * f64::from(*x);
            n += 1.0;
        }
    }
    (s / n.max(1.0)).sqrt()
}

#[test]
fn the_fake_writes_the_vocals_through_a_part_file_and_cancel_leaves_nothing() {
    let _one = serial();
    let dir = scratch("core");
    let home = Home::at(dir.join("home"));
    let sounds = SoundFiles::new(dir.join("tmp"));
    let v = Backend::fake("");
    let st = v.status();
    assert!(st.backend == "fake" && st.runtime && st.installed, "the fake backend is ready");
    assert!(files::find(&home, "talk.mp4", "0123456789abcdef").is_none(), "nothing made yet");
    let id = sounds.open().unwrap();
    let frames = 44100 * 3;
    let pcm: Vec<f32> = (0..frames * 2).map(|i| 0.5 * (i as f32 / 20.0).sin()).collect();
    sounds.write(&id, &pcm).unwrap();
    let out = Place::Media.dir(&home).join(files::file_name("talk.mp4", "0123456789abcdef"));
    let never = AtomicBool::new(false);
    let seen = Mutex::new(Vec::new());
    let n = v
        .separate(
            Sound { files: &sounds, id: &id, channels: 2 },
            frames as u64 + 44100,
            &out,
            &|f| seen.lock().unwrap().push(f),
            &never,
        )
        .unwrap();
    assert_eq!(n, frames as u64 + 44100);
    assert!(out.exists() && !files::part_of(&out).exists(), "the vocals are a WAV in the media folder, no .part left");
    assert_eq!(out.file_name().unwrap().to_string_lossy(), "talk voice 0123456789abcdef.wav");
    let wav = std::fs::read(&out).unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 2);
    assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 44100);
    assert_eq!(
        u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize,
        (frames + 44100) * 4,
        "padded to the frames asked for"
    );
    let s200 = f64::from(i16::from_le_bytes([wav[44 + 400], wav[45 + 400]])) / 32767.0;
    assert!((s200 - f64::from(pcm[200])).abs() < 1e-3, "the fake's vocals are the sound itself");
    assert!(seen.lock().unwrap().last() == Some(&1.0), "progress ends at 1");
    assert_eq!(
        files::find(&home, "talk.mp4", "0123456789abcdef").map(|x| x.0),
        Some(out.clone()),
        "found again by its key"
    );
    sounds.close(&id);
    assert_eq!(std::fs::read_dir(dir.join("tmp")).unwrap().count(), 0, "closing deletes the temp file");

    v.set_delay(100);
    let b = sounds.open().unwrap();
    sounds.write(&b, &vec![0.0; 44100 * 25]).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let stop = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        c2.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    let out = Place::Cache.dir(&home).join(files::file_name("long", "fedcba9876543210"));
    let r = v.separate(Sound { files: &sounds, id: &b, channels: 1 }, 0, &out, &|_| {}, &cancel);
    stop.join().unwrap();
    assert_eq!(r.unwrap_err().code, "cancelled");
    assert!(wavs(&Place::Cache.dir(&home)).is_empty(), "Cancel leaves no WAV and no .part");
    assert_eq!(v.stats().cancelled, 1);
    sounds.close(&b);

    let _ = std::fs::remove_dir_all(&dir);
}

/// The real backend pointed at an empty Hugging Face cache (`HF_HUB_CACHE`, set for a run of the test below in a
/// process of its own: the environment of this one is not changed): the model is missing and nothing is downloaded.
#[test]
fn the_real_backend_with_an_empty_model_cache_says_not_installed_and_downloads_nothing() {
    let dir = scratch("missing");
    let empty = dir.join("hf-empty");
    std::fs::create_dir_all(&empty).unwrap();
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "real_backend_in_a_process_of_its_own", "--ignored", "--nocapture"])
        .env("HF_HUB_CACHE", &empty)
        .env("PYIDE_VOICE_BACKEND", "")
        .env("CUT_VOICE_TEST_DIR", &dir)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success() && text.contains("1 passed"), "{text}{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(std::fs::read_dir(&empty).unwrap().count(), 0, "nothing was downloaded");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "run by the test above with HF_HUB_CACHE set"]
fn real_backend_in_a_process_of_its_own() {
    let dir = PathBuf::from(std::env::var_os("CUT_VOICE_TEST_DIR").expect("run by the test above"));
    let home = Home::at(dir.join("home"));
    let sounds = SoundFiles::new(dir.join("tmp"));
    let real = Backend::from_env();
    let st = real.status();
    assert!(st.backend == "demucs" && !st.installed, "pointed at an empty cache, the model is missing: {st:?}");
    let f = sounds.open().unwrap();
    sounds.write(&f, &[0.0; 441]).unwrap();
    let out = Place::Media.dir(&home).join(files::file_name("x", "1111111122222222"));
    let r = real.separate(Sound { files: &sounds, id: &f, channels: 1 }, 0, &out, &|_| {}, &AtomicBool::new(false));
    assert_eq!(r.unwrap_err().code, "notInstalled");
    assert!(!out.exists() && !files::part_of(&out).exists());
}
/// The editor in English on a 30 fps sequence: `talk.wav` (12 s of beeps) on A1 from 1 s (its 2..10 s), a 720p video
/// on V1 linked to it, the fake voice backend with the pretend setup `setup`.
fn open(dir: &Path, setup: &str, seconds: f64) -> (H, Id, Id, Id) {
    std::fs::create_dir_all(dir.join("src")).unwrap();
    let talk = beeps(&dir.join("src").join("talk.wav"), seconds);
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.features.voice.backend = Backend::fake(setup);
    let seq = s.app.sequence_id.unwrap();
    let media =
        [talk.clone(), media::h264_720p()].map(|f| cut_app::import::probe_file(&f).result.expect("the file probes"));
    let r = s.app.exec(&cut_app::cmd::import_media(media.to_vec(), None)).unwrap();
    let ids: Vec<Id> = r["ids"].as_array().unwrap().iter().map(|v| Id::new(v.as_str().unwrap())).collect();
    let place = |s: &mut Shell, m: Id, inn: f64, len: f64, v: Option<&str>, a: Option<&str>| {
        let r = s
            .app
            .exec(&cut_model::commands::build::place(
                seq.as_str(),
                json!({ "source": { "media": m.as_str() }, "in": secs(inn), "out": secs(inn + len), "at": secs(1.0), "video": v, "audio": a, "mode": "overwrite" }),
            ))
            .unwrap();
        Id::new(r["ids"][0].as_str().unwrap())
    };
    let len = (seconds - 4.0).min(8.0);
    let a1 = place(&mut s, ids[0], 2.0, len, None, Some("A1"));
    let v1 = place(&mut s, ids[1], 0.0, 1.0, Some("V1"), None);
    s.app.exec(&cut_app::cmd::link(seq, &[a1, v1])).unwrap();
    s.app.selection.clear();
    let h = Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    (h, ids[0], a1, v1)
}

fn until(h: &mut H, secs: u64, done: impl Fn(&Shell) -> bool) -> bool {
    let start = Instant::now();
    while !done(h.state()) {
        if start.elapsed() > Duration::from_secs(secs) {
            return false;
        }
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

fn button(h: &mut H, p: Pos2, b: egui::PointerButton, pressed: bool) {
    h.event(egui::Event::PointerButton { pos: p, button: b, pressed, modifiers: Modifiers::NONE });
    h.step();
}

fn click_at(h: &mut H, p: Pos2, b: egui::PointerButton) {
    h.hover_at(p);
    h.step();
    button(h, p, b, true);
    button(h, p, b, false);
    h.step();
    h.step();
}

/// Clicks the last widget labelled `label` (an open menu's item, not a button of the same name under it).
fn press(h: &mut H, label: &str) {
    let text = tr(label).into_owned();
    h.get_all_by_label(&text).last().unwrap_or_else(|| panic!("there is {label}")).click();
    h.step();
    h.step();
}

/// The screen point at `t` seconds on `track`, `k` of the way down its row.
fn pt(h: &H, t: f64, track: &str, k: f32) -> Pos2 {
    let tl = &h.state().timeline;
    let l = tl.direct.lanes.expect("the timeline drew its lanes");
    let r = tl.layout().rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == track)).expect("the track's row");
    pos2(l.left() + tl.view.x_of(secs(t)) as f32, l.top() + r.y - tl.view.scroll_y + r.h * k)
}

/// The last message shown: its text and whether it is an error.
fn last_said(h: &H) -> (String, bool) {
    let shown: Vec<(String, bool, f64)> =
        h.ctx.data_mut(|d| d.get_temp(egui::Id::unique("cut-toasts"))).unwrap_or_default();
    let mut all: Vec<(String, bool)> = shown.into_iter().map(|(t, e, _)| (t, e)).collect();
    all.extend(h.state().app.notices.iter().map(|n| (n.text.clone(), n.error)));
    all.pop().unwrap_or_default()
}

fn steps(h: &H) -> usize {
    h.state().app.history.position()
}

fn last_label(h: &H) -> String {
    h.state().app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn clip(h: &H, id: Id) -> cut_model::Clip {
    h.state().app.sequence().unwrap().clip(id).unwrap().clone()
}

fn automation(h: &mut H, item: &str) {
    press(h, "Automation");
    press(h, item);
}

#[test]
fn isolate_voice_asks_to_download_first_then_the_clip_plays_the_vocals_as_one_step() {
    let _one = serial();
    let dir = scratch("command");
    let (mut h, source, a1, v1) = open(&dir, "ok", 12.0);
    let before = clip(&h, a1);
    let steps0 = steps(&h);
    let p = pt(&h, 1.5, "V1", 0.55);
    click_at(&mut h, p, egui::PointerButton::Primary);
    assert!(h.state().app.selection.contains(&v1), "the video clip is selected");
    automation(&mut h, "Isolate Voice");
    let setup = h.state().features.voice.setup.as_ref().expect("the setup dialog on first use");
    assert_eq!(setup.id(), "cutVoiceSetup");
    assert!(
        h.query_by_label_contains("HTDemucs model: about 80 MB").is_some(),
        "the dialog names the model and its size"
    );
    assert!(h.query_by_label_contains("It runs entirely on this PC: the sound is never sent anywhere.").is_some());
    assert!(
        h.query_by_label_contains("Nothing is downloaded until you press Download.").is_some(),
        "and that nothing is downloaded before"
    );
    assert_eq!(h.state().features.voice.backend.stats().setups, 0, "nothing is downloaded before Download is pressed");
    press(&mut h, "Download");
    assert!(
        until(&mut h, 10, |s| s.features.voice.setup.as_ref().is_some_and(|d| d.fraction().is_some_and(|f| f > 0.0))),
        "the download's progress"
    );
    assert!(until(&mut h, 20, |s| s.features.voice.setup.is_none()), "the dialog closes when ready");
    assert!(
        until(&mut h, 60, |s| s.features.voice.job.is_none() && s.app.history.position() > steps0),
        "the voice is isolated"
    );
    assert_eq!(last_label(&h), "Isolate Voice");
    assert_eq!(steps(&h), steps0 + 1, "one undo step");
    let media_dir = dir.join("home").join("Media");
    let made = wavs(&media_dir);
    assert!(
        made.len() == 1 && made[0].starts_with("talk voice ") && made[0].len() == "talk voice .wav".len() + 16,
        "one vocals WAV in the workspace's Media folder: {made:?}"
    );
    assert_eq!(wavs(&dir.join("src")), ["talk.wav"], "nothing is written next to the source file");
    let p = h.state().app.project();
    assert_eq!(p.media.len(), 3);
    let vocal =
        p.media.iter().find(|m| m.name == "talk.wav (Voice)").expect("the WAV imported as talk.wav (Voice)").clone();
    assert_eq!(Path::new(&vocal.path), media_dir.join(&made[0]));
    let src = p.media(source).unwrap();
    assert!((vocal.duration - src.duration).abs() / TICKS as f64 <= 0.05, "the WAV is as long as the media");
    let after = clip(&h, a1);
    assert_eq!(after.media_id(), Some(vocal.id), "the audio clip plays the vocals");
    assert_ne!(clip(&h, v1).media_id(), Some(vocal.id), "the video clip keeps its own media");
    assert_eq!(
        (after.start, after.in_, after.out, after.link),
        (before.start, before.in_, before.out, before.link),
        "the clip keeps its place, in, out and link"
    );
    let (loud, orig) = (rms(&vocal.path, 2.0, 9.0), rms(&src.path, 2.0, 9.0));
    assert!(
        loud > 0.01 && (loud - orig).abs() / orig < 0.1,
        "the fake's vocals are the sound itself: {loud} vs {orig}"
    );
    let toast = last_said(&h).0;
    assert_eq!(toast, "The voice was isolated in 1 clips. Undo brings the original sound back.");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("undo", &ctx);
    h.step();
    assert!(
        clip(&h, a1).media_id() == Some(source) && h.state().app.project().media.len() == 2,
        "undo gives the clip its own sound back and takes the WAV out"
    );
    h.state_mut().run_action("redo", &ctx);
    h.step();
    assert_eq!(clip(&h, a1).media_id(), Some(vocal.id), "redo isolates it again");
    h.state_mut().run_action("undo", &ctx);
    h.step();
    let separations = h.state().features.voice.backend.stats().separations;
    // the clip menu's Automation item, run again: the file made before is used
    let p = pt(&h, 4.0, "A1", 0.4);
    click_at(&mut h, p, egui::PointerButton::Secondary);
    press(&mut h, "Automation");
    press(&mut h, "Isolate Voice");
    assert!(
        until(&mut h, 30, |s| s.features.voice.job.is_none() && s.app.history.position() == steps0 + 1),
        "isolated again from the clip menu"
    );
    assert_eq!(h.state().features.voice.backend.stats().separations, separations, "the WAV made before is used");
    assert_eq!(wavs(&media_dir).len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_pretend_download_failure_is_explained_and_try_again_or_cancel_follow() {
    let _one = serial();
    for (code, says) in [
        ("offline", "The download could not reach the internet. Check the connection and try again."),
        ("disk", "There is not enough free disk space. Free up space and try again (pretend failure: disk)."),
        (
            "noPython",
            "Python was not found on this PC. Voice isolation needs Python 3 (64-bit, from python.org) with PyTorch. Install Python and try again.",
        ),
        (
            "noTorch",
            "PyTorch cannot be installed for the Python on this PC. Install a 64-bit Python 3.10 to 3.13 from python.org and try again.",
        ),
        ("busy", "The AI environment is in use by another Nano Studio window. Close it and try again."),
        ("weird", "The download failed: pretend failure: weird"),
    ] {
        let dir = scratch(&format!("fail-{code}"));
        let (mut h, _, a1, _) = open(&dir, code, 6.0);
        h.state_mut().app.select([a1], false, false);
        let steps0 = steps(&h);
        automation(&mut h, "Isolate Voice");
        press(&mut h, "Download");
        assert!(
            until(&mut h, 20, |s| s.features.voice.setup.as_ref().is_some_and(|d| d.error.is_some())),
            "{code}: the failure"
        );
        let (got, text) = h.state().features.voice.setup.as_ref().unwrap().error.clone().unwrap();
        assert_eq!((got.as_str(), text.as_str()), (if code == "weird" { "failed" } else { code }, says));
        assert!(h.query_by_label(&tr("Try Again")).is_some(), "{code}: Download became Try Again");
        press(&mut h, "Cancel");
        assert!(h.state().features.voice.setup.is_none(), "{code}: Cancel closes the dialog");
        for _ in 0..5 {
            h.step();
        }
        assert!(h.state().features.voice.job.is_none() && steps(&h) == steps0, "{code}: nothing isolated");
        assert!(wavs(&dir.join("home").join("Media")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
    // Cancel while it downloads stops it: the model stays missing
    let dir = scratch("fail-cancel");
    let (mut h, _, a1, _) = open(&dir, "ok", 6.0);
    h.state_mut().app.select([a1], false, false);
    automation(&mut h, "Isolate Voice");
    press(&mut h, "Download");
    assert!(until(&mut h, 10, |s| s.features.voice.setup.as_ref().is_some_and(|d| d.busy())), "the download runs");
    // the dialog grows a line once progress comes: wait for it so the button is where it is drawn
    assert!(until(&mut h, 10, |s| s.features.voice.setup.as_ref().is_some_and(|d| d.fraction().is_some())), "progress");
    h.step();
    press(&mut h, "Cancel");
    assert!(h.state().features.voice.setup.is_none(), "Cancel closes the dialog while it downloads");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!h.state().features.voice.backend.status().installed, "a cancelled download leaves the model missing");
    assert!(h.state().features.voice.job.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancel_while_the_voice_is_isolated_and_a_failed_separation_leave_nothing() {
    let _one = serial();
    let dir = scratch("cancel");
    let (mut h, _, a1, _) = open(&dir, "", 20.0);
    h.state().features.voice.backend.set_delay(600);
    let media0 = h.state().app.project().media.len();
    let steps0 = steps(&h);
    let media_dir = dir.join("home").join("Media");
    h.state_mut().app.select([a1], false, false);
    // Essential Sound's button
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.audio", &ctx);
    h.step();
    h.step();
    press(&mut h, "Isolate Voice");
    assert!(
        until(&mut h, 30, |s| s.features.voice.job.as_ref().is_some_and(|j| j.fraction() > 0.3)),
        "the separation under way"
    );
    assert!(wavs(&media_dir).iter().any(|n| n.ends_with(".part")), "while it runs, a .part is there");
    let temp = std::env::temp_dir().join("nano-studio-cut-voice");
    assert_eq!(std::fs::read_dir(&temp).unwrap().count(), 1, "and one temp file of sound");
    press(&mut h, "Cancel");
    assert!(until(&mut h, 15, |s| s.features.voice.job.is_none()), "Cancel ends it");
    assert!(wavs(&media_dir).is_empty(), "Cancel leaves no WAV and no .part: {:?}", wavs(&media_dir));
    assert_eq!(std::fs::read_dir(&temp).unwrap().count(), 0, "Cancel leaves no temp file");
    assert!(
        h.state().app.project().media.len() == media0 && steps(&h) == steps0,
        "Cancel changes nothing in the project"
    );
    assert_eq!(h.state().features.voice.backend.stats().cancelled, 1, "the backend saw the cancel");
    assert_eq!(last_said(&h).0, "The analysis was cancelled.");

    // a separation that fails at its end (a folder where the WAV goes) leaves no file and no step
    h.state().features.voice.backend.set_delay(0);
    let m = h.state().app.project().media.iter().find(|m| m.name == "talk.wav").unwrap().clone();
    let out = media_dir.join(files::file_name(&m.name, &files::key_of(&m, 0.0, None)));
    std::fs::create_dir_all(out.join("in the way")).unwrap();
    h.state_mut().run_action("auto.isolateVoice", &ctx);
    assert!(until(&mut h, 30, |s| s.features.voice.job.is_none()), "the separation ends");
    let (text, error) = last_said(&h);
    assert!(error && text.starts_with("Voice isolation failed: "), "the failure is reported: {text}");
    assert!(
        wavs(&media_dir).iter().all(|f| !f.ends_with(".part")) && out.is_dir(),
        "no .part left: {:?}",
        wavs(&media_dir)
    );
    assert!(
        h.state().app.project().media.len() == media0 && steps(&h) == steps0,
        "a failure changes nothing in the project"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_project_panels_isolate_voice_imports_the_vocals_and_leaves_the_timeline() {
    let _one = serial();
    let dir = scratch("bin");
    let (mut h, source, _, _) = open(&dir, "", 6.0);
    let clips0: Vec<_> = h.state().app.sequence().unwrap().clips().cloned().collect();
    let steps0 = steps(&h);
    let item = h.get_all_by_label("talk.wav").next().expect("the Project panel lists talk.wav").rect().center();
    click_at(&mut h, item, egui::PointerButton::Secondary);
    press(&mut h, "Isolate Voice");
    assert!(
        until(&mut h, 30, |s| s.features.voice.job.is_none() && s.app.project().media.len() == 3),
        "the vocals imported"
    );
    let clips: Vec<_> = h.state().app.sequence().unwrap().clips().cloned().collect();
    assert_eq!(clips, clips0, "the Project panel's Isolate Voice leaves the timeline as it is");
    assert_eq!((last_label(&h).as_str(), steps(&h)), ("Isolate Voice", steps0 + 1), "one undo step");
    assert_eq!(last_said(&h).0, "The isolated voice is in the project: 1 files.");
    assert!(h.state().app.project().media(source).is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn nothing_selected_asks_for_a_clip_and_the_texts_have_their_korean() {
    let _one = serial();
    let dir = scratch("texts");
    let (mut h, _, _, _) = open(&dir, "ok", 6.0);
    automation(&mut h, "Isolate Voice");
    assert!(h.state().features.voice.setup.is_none(), "no clip, no dialog");
    assert_eq!(last_said(&h).0, "Select a clip with sound to isolate its voice.");
    for t in [
        "Isolate Voice",
        "Isolating voice…",
        "Loading the voice isolation model…",
        "Download Voice Isolation",
        "{name} model: about {size}",
        "The voice was isolated in {n} clips. Undo brings the original sound back.",
        "The isolated voice is in the project: {n} files.",
        "{name} (Voice)",
        "Voice isolation failed: {error}",
        "Select a clip with sound to isolate its voice.",
        "Try Again",
    ] {
        assert!(cut_app::i18n::has_korean(t), "{t} has its Korean");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

mod media;
