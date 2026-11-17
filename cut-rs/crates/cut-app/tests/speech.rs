//! Speech recognition in the window with the fake backend (`PYIDE_WHISPER_BACKEND=fake`: one word per burst of
//! sound, `PYIDE_WHISPER_FAKE_SETUP` for the pretend download), the cases of `verify/cut-speech.mjs` the native app
//! has: Auto Captions makes one undo step of captions with word timings and doubts, in the language chosen; a long
//! sound is recognised in windows of at most 31 s joined without twins; the transcript is cached; the Download dialog
//! fails with each setup code and then succeeds; Remove Filler Words previews and ripple-deletes the hesitations;
//! Next / Previous Uncertain Word; the Preferences' Speech Recognition page. No model, no Python, no network.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cut_app::files::Home;
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_app::speech::dialogs::setup_error;
use cut_app::speech::engine::Speech;
use cut_model::commands::build as C;
use cut_sidecar::sound::SoundFiles;
use cut_sidecar::{SetupCode, SetupFailure};
use cut_time::{TICKS, Ticks};
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

const S: f64 = TICKS as f64;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-speech-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 16-bit mono 48 kHz WAV with a 0.3 s burst of 1 kHz every second from 0.5 s.
fn bursts(path: &Path, seconds: f64) -> PathBuf {
    let rate = 48000u32;
    let n = (f64::from(rate) * seconds) as u32;
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 2).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 2).to_le_bytes());
    for i in 0..n {
        let t = f64::from(i) / f64::from(rate);
        let on = t >= 0.5 && (t - 0.5) % 1.0 < 0.3;
        let v = if on { 0.3 * (std::f64::consts::TAU * 1000.0 * t).sin() } else { 0.0 };
        b.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
    path.to_owned()
}

fn secs(x: f64) -> Ticks {
    (x * S).round() as Ticks
}

/// A shell in English with the file on A1 for `len` s, the fake backend in `setup` mode.
fn shell(dir: &Path, file: &Path, len: f64, setup: &str) -> (Shell, Arc<Speech>) {
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    let seq = s.app.sequence_id.unwrap();
    s.app.exec(&C::set_sequence(seq.as_str(), json!({ "fps": [30, 1], "w": 1280, "h": 720 }))).unwrap();
    let media = cut_app::import::probe_file(file).result.expect("the file probes");
    let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
    let m = r["ids"][0].as_str().unwrap();
    s.app
        .exec(&C::place(
            seq.as_str(),
            json!({ "source": { "media": m }, "in": 0, "out": secs(len), "at": 0, "video": null, "audio": "A1", "mode": "overwrite" }),
        ))
        .unwrap();
    s.app.selection.clear();
    let speech = Speech::fake(setup, Arc::new(SoundFiles::new(dir.join("sound"))));
    s.features.speech.set_backend(speech.clone());
    (s, speech)
}

fn harness(s: Shell) -> Harness<'static, Shell> {
    Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s)
}

fn until(h: &mut Harness<'_, Shell>, what: &str, done: impl Fn(&Shell) -> bool) {
    let start = Instant::now();
    while !done(h.state()) {
        assert!(start.elapsed() < Duration::from_secs(60), "{what}");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(2);
}

fn label(s: &Shell) -> String {
    s.app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn auto_track(s: &Shell) -> Option<cut_model::CaptionTrack> {
    s.app.sequence().unwrap().captions.iter().find(|t| t.name == "Auto Captions").cloned()
}

fn run(h: &mut Harness<'_, Shell>, id: &str) {
    let ctx = h.ctx.clone();
    h.state_mut().run_action(id, &ctx);
    h.run_steps(2);
}

#[test]
fn auto_captions_make_one_step_of_captions_with_words_and_doubts() {
    let dir = scratch("captions");
    let f = bursts(&dir.join("talk.wav"), 12.0);
    let (s, speech) = shell(&dir, &f, 12.0, "");
    let mut h = harness(s);
    run(&mut h, "auto.captions");
    assert!(h.query_by_label(&tr("Create Captions")).is_some(), "the dialog asks first");
    assert!(h.query_by_label("The whole sequence: 1 clips with speech. Captions of up to two lines, at most 6 seconds each, split at pauses and sentence ends.").is_some());
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    until(&mut h, "recognition ends", |s| s.features.speech.job.is_none());
    let t = auto_track(h.state()).expect("a caption track named Auto Captions");
    assert_eq!(label(h.state()), "Auto Captions", "one undo step");
    assert_eq!(t.lang, "ko");
    let text: Vec<&str> = t.items.iter().map(|c| c.text.as_str()).collect();
    let all = text.join(" ");
    assert!(all.contains("자막을") && all.contains("만들어"), "the fake model's Korean words: {all}");
    assert!(t.items.iter().all(|c| c.words.as_ref().is_some_and(|w| !w.is_empty())), "word timings");
    let doubt: Vec<String> = t.items.iter().flat_map(|c| c.doubt.iter().flatten().map(|d| d.text.clone())).collect();
    assert!(
        doubt.iter().all(|d| d == "자막을") && !doubt.is_empty(),
        "the word heard at p 0.31 is the doubt: {doubt:?}"
    );
    let first = &t.items[0];
    let w0 = &first.words.as_ref().unwrap()[0];
    assert!(((first.start + w0.t0) as f64 / S - 0.5).abs() < 0.05, "the first word starts with the first burst");
    assert!(speech.stats().windows == 1, "12 s is one window");
    assert!(h.query_by_label(&tr("Captions created: {n}.").replace("{n}", &t.items.len().to_string())).is_some());
    // again: nothing is recognised twice, the track is replaced in one step
    run(&mut h, "auto.captions");
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    until(&mut h, "again", |s| s.features.speech.job.is_none());
    assert_eq!(speech.stats().windows, 1, "the transcript is reused");
    assert_eq!(h.state().app.sequence().unwrap().captions.len(), 1, "the same track");
    assert!(h.state_mut().app.undo());
    assert!(h.state_mut().app.undo());
    assert!(auto_track(h.state()).is_none(), "undone, no captions");
}

#[test]
fn english_and_a_long_sound_in_windows_joined_without_twins() {
    let dir = scratch("long");
    let f = bursts(&dir.join("long.wav"), 70.0);
    let (s, speech) = shell(&dir, &f, 70.0, "");
    let mut h = harness(s);
    run(&mut h, "auto.captions");
    h.state_mut().features.speech.captions.as_mut().unwrap().language = "en".into();
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    until(&mut h, "recognition ends", |s| s.features.speech.job.is_none());
    assert_eq!(speech.stats().windows, 3, "0-30, 25-55, 50-70 s");
    let t = auto_track(h.state()).unwrap();
    assert_eq!(t.lang, "en");
    let starts: Vec<f64> =
        t.items.iter().flat_map(|c| c.words.iter().flatten().map(move |w| (c.start + w.t0) as f64 / S)).collect();
    assert_eq!(starts.len(), 70, "one word for each burst, none twice at a seam: {starts:?}");
    for (k, x) in starts.iter().enumerate() {
        assert!((x - (0.5 + k as f64)).abs() < 0.05, "word {k} at {x}");
    }
    assert_eq!(cut_app::speech::setting(h.state(), "speech.language"), json!("en"), "the choice is kept");
}

#[test]
fn the_download_fails_with_each_code_then_succeeds() {
    for code in ["offline", "disk", "noPython"] {
        let dir = scratch(&format!("setup-{code}"));
        let f = bursts(&dir.join("talk.wav"), 4.0);
        let (s, _) = shell(&dir, &f, 4.0, code);
        let mut h = harness(s);
        run(&mut h, "auto.captions");
        h.get_by_label(&tr("Create Captions")).click();
        h.run_steps(4);
        assert!(h.state().features.speech.setup.is_some(), "{code}: the setup is asked for");
        h.run_steps(2);
        assert!(
            h.query_by_label(&tr("Download Speech Recognition")).is_some(),
            "{code}: the dialog before the download"
        );
        assert!(h.query_by_label("• Whisper large-v3 turbo model: about 1.5 GB").is_some());
        h.get_by_label(&tr("Download")).click();
        until(&mut h, "the pretend download fails", |s| {
            s.features.speech.setup.as_ref().is_some_and(|d| d.error.is_some())
        });
        let want = setup_error(&SetupFailure {
            code: SetupCode::parse(code),
            error: format!("pretend failure: {code}"),
            log: String::new(),
        });
        assert_eq!(h.state().features.speech.setup.as_ref().unwrap().error.as_ref().unwrap().0.as_str(), code);
        assert!(h.query_by_label(&want).is_some(), "{code}: {want}");
        assert!(h.query_by_label(&tr("Try Again")).is_some());
        h.get_by_label(&tr("Cancel")).click();
        h.run_steps(2);
        assert!(h.state().features.speech.setup.is_none() && auto_track(h.state()).is_none(), "declined: nothing made");
    }
    let dir = scratch("setup-ok");
    let f = bursts(&dir.join("talk.wav"), 4.0);
    let (s, speech) = shell(&dir, &f, 4.0, "ok");
    let mut h = harness(s);
    run(&mut h, "auto.captions");
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    h.get_by_label(&tr("Download")).click();
    until(&mut h, "downloaded and recognised", |s| {
        s.features.speech.setup.is_none() && s.features.speech.job.is_none()
    });
    assert!(speech.status().runtime && speech.status().model("whisper-large-v3-turbo").1);
    assert!(auto_track(h.state()).is_some(), "the captions follow the download");
    assert_eq!(speech.stats().setups, 1);
}

#[test]
fn a_model_already_here_is_offered_and_a_cancel_stops_the_download() {
    let dir = scratch("other");
    let f = bursts(&dir.join("talk.wav"), 4.0);
    let (s, speech) = shell(&dir, &f, 4.0, "");
    // the runtime is there and only small: use it, nothing to download
    speech.test_config(None, None, None, Some(&["whisper-small"]), false);
    let mut h = harness(s);
    run(&mut h, "auto.captions");
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    assert!(
        h.query_by_label(
            "Whisper small is already on this PC: use it to recognize speech now, with nothing to download."
        )
        .is_some()
    );
    h.get_by_label("Use Whisper small").click();
    h.run_steps(2);
    until(&mut h, "recognised with small", |s| s.features.speech.job.is_none() && s.features.speech.setup.is_none());
    assert_eq!(cut_app::speech::setting(h.state(), "speech.model"), json!("whisper-small"));
    assert!(auto_track(h.state()).is_some());
    assert_eq!(speech.stats().setups, 0, "nothing downloaded");
    // a download cancelled while it runs
    let dir = scratch("cancel");
    let f = bursts(&dir.join("talk.wav"), 4.0);
    let (s, _) = shell(&dir, &f, 4.0, "ok");
    let mut h = harness(s);
    run(&mut h, "auto.captions");
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    h.get_by_label(&tr("Download")).click();
    h.run_steps(6);
    assert!(h.state().features.speech.setup.as_ref().is_some_and(|d| d.busy()));
    eprintln!("cancels: {}", h.query_all_by_label(&tr("Cancel")).count());
    h.get_by_label(&tr("Cancel")).click();
    h.run_steps(2);
    assert!(h.state().features.speech.setup.is_none(), "closed");
    assert!(auto_track(h.state()).is_none(), "nothing made");
}

#[test]
fn remove_filler_words_previews_and_ripple_deletes() {
    let dir = scratch("fillers");
    let f = bursts(&dir.join("talk.wav"), 12.0);
    let (s, _) = shell(&dir, &f, 12.0, "");
    let before = s.app.history.serialize();
    let mut h = harness(s);
    run(&mut h, "auto.fillers");
    until(&mut h, "the dialog after recognition", |s| s.features.speech.fillers.is_some());
    assert_eq!(h.state().app.history.serialize(), before, "the preview changes nothing");
    let overlay = h.state().timeline.overlay.clone().expect("the preview over the lanes");
    // bursts at 0.5, 1.5 … heard as 음, 자막을, 만들어, 그 (a pause follows), 쉬워요.: 음 and 그 go, 2 of every 5
    assert!(!overlay.ranges.is_empty());
    h.get_by_label(&tr("Remove")).click();
    h.run_steps(2);
    assert_eq!(label(h.state()), "Remove Filler Words");
    assert!(h.state().timeline.overlay.is_none(), "the preview goes");
    let seq = h.state().app.sequence().unwrap();
    let end = seq.clips().map(|c| c.end()).max().unwrap() as f64 / S;
    assert!(end < 12.0 - 2.0, "the fillers and the pauses around them are cut: {end}");
    let saved = h.state().doc.settings.get("auto.fillers").cloned().unwrap();
    assert_eq!(saved["pauseLength"], json!(1.0));
}

#[test]
fn next_and_previous_uncertain_word() {
    let dir = scratch("uncertain");
    let f = bursts(&dir.join("talk.wav"), 12.0);
    let (s, _) = shell(&dir, &f, 12.0, "");
    let mut h = harness(s);
    run(&mut h, "auto.nextUncertain");
    assert!(h.query_by_label(&tr("There are no uncertain words.")).is_some(), "nothing recognised yet");
    run(&mut h, "auto.captions");
    h.get_by_label(&tr("Create Captions")).click();
    h.run_steps(4);
    until(&mut h, "captions", |s| s.features.speech.job.is_none());
    h.state_mut().app.set_time(0);
    run(&mut h, "auto.nextUncertain");
    let t1 = h.state().app.t as f64 / S;
    assert!((t1 - 1.5).abs() < 0.05, "자막을 at 1.5 s: {t1}");
    run(&mut h, "auto.nextUncertain");
    let t2 = h.state().app.t as f64 / S;
    assert!((t2 - 6.5).abs() < 0.05, "the next one at 6.5 s: {t2}");
    run(&mut h, "auto.prevUncertain");
    assert!((h.state().app.t as f64 / S - t1).abs() < 1e-6);
    run(&mut h, "auto.prevUncertain");
    assert!(h.query_by_label(&tr("No uncertain words before the playhead.")).is_some());
    h.state_mut().doc.settings.set("speech.markUncertain", Json::Bool(false));
    run(&mut h, "auto.nextUncertain");
    assert!(
        h.query_by_label(&tr(
            "Uncertain words are not marked. Turn the marks on in the settings (Video Editor, Speech Recognition)."
        ))
        .is_some()
    );
}

#[test]
fn the_preferences_page_downloads_on_request() {
    let dir = scratch("prefs");
    let f = bursts(&dir.join("talk.wav"), 4.0);
    let (s, speech) = shell(&dir, &f, 4.0, "ok");
    let mut h = harness(s);
    run(&mut h, "settings");
    h.get_by_label(&tr("Speech Recognition")).click();
    h.run_steps(2);
    assert!(h.query_by_label(&tr("Not downloaded: it is downloaded when you first use it, after you agree")).is_some());
    h.get_by_label(&tr("Download…")).click();
    h.run_steps(2);
    assert!(h.query_by_label(&tr("Download Speech Recognition")).is_some());
    h.get_by_label(&tr("Download")).click();
    until(&mut h, "downloaded", |s| s.features.speech.setup.is_none());
    assert!(speech.status().model("whisper-large-v3-turbo").1);
    assert!(h.query_by_label(&tr("Downloaded")).is_some());
    assert!(auto_track(h.state()).is_none(), "only the model");
}
