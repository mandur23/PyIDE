//! The Transcript panel and the links between speech recognition, speaker labels, voice isolation and Claude, driven
//! in the window with the fake backends (`PYIDE_WHISPER_BACKEND=fake`: one word per burst of sound;
//! `PYIDE_SPEAKERS_BACKEND=fake`: a tone's pitch is its speaker; `PYIDE_VOICE_BACKEND=fake`): Transcribe, a click
//! moving the playhead, Shift+click and Delete as one "Delete Words" step that undoes, the search, a word corrected in
//! place, Word List…, Fillers…, the uncertain words' button; the speakers row (chips and counts, Select Words, a
//! paragraph's menu with Change Speaker, New Speaker and Rename Speaker…), Label Speakers asking for Whisper before
//! the speakers' model, Auto Captions split by speaker with the speakers' style; the voice isolated before
//! recognition (its setup dialog after Whisper's, the vocals in the cache) and the transcripts carried to the vocals;
//! the Claude features' Transcribe offer through the setup dialog, and no "No speech was recognized." after a
//! cancel. No model, no Python, no network.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cut_app::files::Home;
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_app::speakers::backend::Backend as SpeakersBackend;
use cut_app::speakers::core::Labels;
use cut_app::speech::engine::Speech;
use cut_app::speech::text;
use cut_app::state::Panel;
use cut_model::commands::build as C;
use cut_sidecar::sound::SoundFiles;
use cut_time::{TICKS, Ticks};
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

type H = Harness<'static, Shell>;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-transcript-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

/// A 16-bit mono 48 kHz WAV: tone bursts `(start s, count, Hz)`, one every 0.5 s, 0.35 s long.
fn wav(path: &Path, seconds: f64, plan: &[(f64, usize, f64)]) -> PathBuf {
    let rate = 48000u32;
    let n = (f64::from(rate) * seconds) as u32;
    let mut pcm = vec![0i16; n as usize];
    for &(at, count, hz) in plan {
        for k in 0..count {
            let a = ((at + k as f64 * 0.5) * f64::from(rate)).round() as usize;
            for (i, v) in pcm.iter_mut().enumerate().skip(a).take((0.35 * f64::from(rate)) as usize) {
                *v = (0.3 * (std::f64::consts::TAU * hz * i as f64 / f64::from(rate)).sin() * 32767.0).round() as i16;
            }
        }
    }
    let mut b = Vec::with_capacity(44 + pcm.len() * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 2).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    for v in [16u32.to_le_bytes(), [1, 0, 1, 0], rate.to_le_bytes(), (rate * 2).to_le_bytes(), [2, 0, 16, 0]] {
        b.extend_from_slice(&v);
    }
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 2).to_le_bytes());
    for v in pcm {
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
    path.to_owned()
}

/// Speakers A (300 Hz), B (1500 Hz), C (800 Hz) taking turns, as `tests/speakers.rs`.
const TALK: [(f64, usize, f64); 5] =
    [(0.0, 7, 300.0), (4.5, 6, 1500.0), (8.5, 6, 800.0), (12.5, 4, 300.0), (15.5, 4, 1500.0)];

/// The editor in English with the file on A1, the fake backends (their pretend setups), the Transcript panel shown.
fn open(dir: &Path, file: &Path, len: f64, whisper: &str, speakers: &str, voice: &str) -> H {
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.features.speech.set_backend(Speech::fake(whisper, Arc::new(SoundFiles::new(dir.join("sound")))));
    s.features.speakers.backend = SpeakersBackend::fake(speakers);
    s.features.voice.backend = cut_app::voice::backend::Backend::fake(voice);
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
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .with_step_dt(1.0 / 60.0)
        .build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    run(&mut h, "window.transcript");
    h
}

fn run(h: &mut H, id: &str) {
    let ctx = h.ctx.clone();
    h.state_mut().run_action(id, &ctx);
    h.run_steps(3);
}

fn until(h: &mut H, what: &str, done: impl Fn(&Shell) -> bool) {
    let start = Instant::now();
    while !done(h.state()) {
        assert!(start.elapsed() < Duration::from_secs(60), "{what}");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.run_steps(3);
}

fn idle(h: &mut H) {
    until(h, "the work ends", |s| {
        s.features.speech.job.is_none()
            && s.features.speakers.job.is_none()
            && s.features.voice.job.is_none()
            && s.features.speech.setup.is_none()
            && s.features.speakers.setup.is_none()
            && s.features.voice.setup.is_none()
    });
}

fn press(h: &mut H, label: &str) {
    let text = tr(label).into_owned();
    h.get_all_by_label(&text).last().unwrap_or_else(|| panic!("there is {label}")).click();
    h.run_steps(3);
}

fn last_label(h: &H) -> String {
    h.state().app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn said(h: &H) -> Vec<String> {
    h.state().app.notices.iter().map(|n| n.text.clone()).collect()
}

fn words(h: &H) -> Vec<text::Word> {
    h.state().features.speech.panel.words.clone()
}

/// The panel's node of word `i` (words of the same text counted in order).
fn word_node<'a>(h: &'a H, i: usize) -> egui_kittest::Node<'a> {
    let ws = &h.state().features.speech.panel.words;
    let nth = ws[..i].iter().filter(|w| w.text == ws[i].text).count();
    h.get_all_by_label(&ws[i].text).nth(nth).unwrap_or_else(|| panic!("word {i} is shown"))
}

fn clip_lengths(h: &H) -> Ticks {
    h.state().app.sequence().unwrap().clips().map(|c| c.end() - c.start).sum()
}

#[test]
fn transcribe_click_select_delete_search_correct_and_the_word_list() {
    let dir = scratch("panel");
    let f = wav(&dir.join("talk.wav"), 12.0, &[(0.5, 11, 1000.0)]);
    let mut h = open(&dir, &f, 12.0, "", "", "");
    assert!(
        h.query_by_label(&tr(
            "No transcript yet. Press Transcribe to recognize the speech of the sequence on this PC."
        ))
        .is_some(),
        "the panel says how to get words"
    );
    press(&mut h, "Transcribe");
    idle(&mut h);
    let ws = words(&h);
    assert_eq!(ws.len(), 11, "a word a burst: {:?}", ws.iter().map(|w| &w.text).collect::<Vec<_>>());
    assert!(h.query_by_label("11 words").is_some(), "the foot counts them");

    word_node(&h, 2).click();
    h.run_steps(3);
    assert_eq!(h.state().app.t, ws[2].t0 as i64, "a click moves the playhead to the word");
    assert_eq!(h.state().app.focus, Some(Panel::Transcript), "the panel has the keyboard");
    word_node(&h, 4).click_modifiers(egui::Modifiers::SHIFT);
    h.run_steps(3);
    assert_eq!(h.state().features.speech.panel.sel, Some((2, 4)), "Shift+click chooses the run");
    assert_eq!(h.state().app.t, ws[2].t0 as i64, "Shift+click does not seek");

    let frame = cut_model::query::frame(h.state().app.sequence().unwrap().fps) as f64;
    let ranges = text::removal_ranges(&ws, &[2, 3, 4], frame);
    let cut: f64 = ranges.iter().map(|(a, b)| b - a).sum();
    let (before, steps0) = (clip_lengths(&h), h.state().app.history.position());
    assert!(
        cut_app::speech::panel::takes(h.state(), "delete"),
        "the panel takes Delete: focus {:?}",
        h.state().app.focus
    );
    h.key_press(egui::Key::Delete);
    h.run_steps(3);
    assert_eq!((last_label(&h).as_str(), h.state().app.history.position()), ("Delete Words", steps0 + 1));
    assert_eq!(clip_lengths(&h), before - cut as Ticks, "the words' ranges are ripple-deleted");
    assert_eq!(h.state().app.t, ranges[0].0 as i64, "the playhead at the cut");
    assert_eq!(words(&h).len(), 8, "the words deleted are gone from the panel");
    run(&mut h, "undo");
    assert_eq!((clip_lengths(&h), words(&h).len()), (before, 11), "undo gives them back");

    // the search: every match counted, Enter chooses the first
    let want = text::search(&ws, &ws[0].text);
    h.ctx.memory_mut(|m| m.request_focus(egui::Id::unique(cut_app::speech::panel::SEARCH)));
    h.run_steps(2);
    h.event(egui::Event::Text(ws[0].text.clone()));
    h.run_steps(3);
    assert!(h.query_by_label(&format!("{} found", want.len())).is_some(), "{} found", want.len());
    h.key_press(egui::Key::Enter);
    h.run_steps(3);
    assert_eq!(h.state().features.speech.panel.sel, Some(want[0]), "Enter chooses the first match");

    // a word corrected in place: a double click, typed, Enter
    let at = word_node(&h, 5).rect().center();
    h.hover_at(at);
    h.step();
    for _ in 0..2 {
        for pressed in [true, false] {
            let (button, modifiers) = (egui::PointerButton::Primary, egui::Modifiers::NONE);
            h.event(egui::Event::PointerButton { pos: at, button, pressed, modifiers });
        }
    }
    h.run_steps(3);

    assert!(h.state().features.speech.panel.editing.is_some(), "a double click edits the word");
    h.get_by_label("Correct the word").type_text("Nano");
    h.run_steps(2);
    h.key_press(egui::Key::Enter);
    h.run_steps(4);
    let w5 = &words(&h)[5];
    assert_eq!((w5.text.as_str(), w5.p), ("Nano", Some(1.0)), "the correction is kept and confirmed");

    // Word List…: the project's list, one undo step
    press(&mut h, "Word List…");
    assert!(h.state().features.speech.terms.is_some(), "the Word List dialog");
    *h.state_mut().features.speech.terms.as_mut().unwrap() = "Nano Studio, Cut".into();
    let steps1 = h.state().app.history.position();
    press(&mut h, "OK");
    assert_eq!(h.state().app.history.position(), steps1 + 1, "one undo step");
    assert_eq!(cut_app::speech::project_terms(h.state()), vec!["Nano Studio", "Cut"]);

    // Fillers… opens Remove Filler Words on the transcribed words
    press(&mut h, "Fillers…");
    until(&mut h, "the fillers dialog", |s| s.features.speech.fillers.is_some());
    h.state_mut().features.speech.fillers = None;
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_speakers_row_chips_select_and_the_paragraph_menu_changes_and_renames() {
    let dir = scratch("speakers");
    let f = wav(&dir.join("talk.wav"), 18.0, &TALK);
    let mut h = open(&dir, &f, 18.0, "", "", "");
    press(&mut h, "Label Speakers");
    idle(&mut h);
    let sp = Labels::of(h.state().app.project()).expect("labels");
    assert_eq!(sp.list.len(), 3);
    for (k, n) in [(1, 11), (2, 10), (3, 6)] {
        let chip = format!("● Speaker {k}  {n}");
        assert!(h.query_by_label(&chip).is_some(), "the chip {chip}");
    }
    h.get_by_label("● Speaker 2  10").click();
    h.run_steps(3);
    let ids = h.state().features.speech.panel.ids.clone();
    let b: Vec<usize> = (0..ids.len()).filter(|&i| ids[i].as_deref() == Some(sp.list[1].id.as_str())).collect();
    assert_eq!(h.state().features.speech.panel.pick.as_ref(), Some(&b), "a chip selects its speaker's words");

    // B's first paragraph (words 7..13) to Speaker 1 from its label's menu
    let paras = h.state().features.speech.panel.paras.clone();
    assert_eq!(paras, vec![0, 7, 13, 19, 23], "a paragraph where the speaker changes");
    let steps0 = h.state().app.history.position();
    h.get_all_by_label("● Speaker 2").next().expect("B's first paragraph label").click();
    h.run_steps(3);
    h.get_by_label(&tr("Change Speaker")).hover();
    h.run_steps(3);
    h.get_all_by_label("Speaker 1").last().expect("Speaker 1 in the submenu").click();
    h.run_steps(4);
    assert_eq!((last_label(&h).as_str(), h.state().app.history.position()), ("Change Speaker", steps0 + 1));
    let ids = h.state().features.speech.panel.ids.clone();
    assert!(ids[7..13].iter().all(|x| x.as_deref() == Some(sp.list[0].id.as_str())), "the paragraph is Speaker 1's");
    run(&mut h, "undo");

    // New Speaker from the menu, then Rename Speaker… opens the rename dialog
    h.get_all_by_label("● Speaker 3").next().expect("C's paragraph label").click();
    h.run_steps(3);
    h.get_by_label(&tr("Change Speaker")).hover();
    h.run_steps(3);
    h.get_by_label(&tr("New Speaker")).click();
    h.run_steps(4);
    assert_eq!(Labels::of(h.state().app.project()).unwrap().list.len(), 4, "a fourth speaker");
    run(&mut h, "undo");
    h.get_all_by_label("● Speaker 1").next().expect("A's label").click();
    h.run_steps(3);
    h.get_by_label(&tr("Rename Speaker…")).click();
    h.run_steps(3);
    assert_eq!(h.state().features.speakers.rename.as_ref().map(|r| r.0.as_str()), Some(sp.list[0].id.as_str()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn label_speakers_asks_for_whisper_before_the_speakers_model_and_auto_captions_split_by_speaker() {
    let dir = scratch("order");
    let f = wav(&dir.join("talk.wav"), 18.0, &TALK);
    let mut h = open(&dir, &f, 18.0, "ok", "ok", "");
    press(&mut h, "Label Speakers");
    assert!(h.state().features.speech.setup.is_some(), "Whisper's setup first");
    assert!(h.state().features.speakers.setup.is_none(), "not the speakers' yet");
    press(&mut h, "Download");
    until(&mut h, "Whisper is set up", |s| s.features.speech.setup.is_none());
    assert!(h.state().features.speakers.setup.is_some(), "then the speakers' model");
    assert!(h.state().features.speech.job.is_none(), "nothing recognised before both are there");
    press(&mut h, "Download");
    idle(&mut h);
    assert_eq!(Labels::of(h.state().app.project()).unwrap().list.len(), 3);

    run(&mut h, "auto.captions");
    press(&mut h, "Create Captions");
    idle(&mut h);
    let seq = h.state().app.sequence().unwrap();
    let t = seq.captions.iter().find(|t| t.name == "Auto Captions").expect("the track");
    assert_eq!(t.style.get("speakerColor"), Some(&json!(true)), "the speakers' colours, the default choice");
    let sp = Labels::of(h.state().app.project()).unwrap();
    let who: Vec<&str> = t.items.iter().map(|it| it.speaker.as_deref().unwrap_or("")).collect();
    assert!(who.iter().all(|w| sp.get(w).is_some()), "every caption knows its speaker: {who:?}");
    let order: Vec<usize> = who.iter().map(|w| sp.list.iter().position(|s| s.id == *w).unwrap()).collect();
    let mut runs = order.clone();
    runs.dedup();
    assert_eq!(runs, vec![0, 1, 2, 0, 1], "captions never hold two speakers");
    assert!(t.items.windows(2).all(|p| p[0].end <= p[1].start), "and never overlap");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_voice_is_isolated_before_recognition_and_transcripts_follow_the_vocals() {
    let dir = scratch("voice");
    let f = wav(&dir.join("talk.wav"), 8.0, &[(0.5, 8, 1000.0)]);
    let mut h = open(&dir, &f, 8.0, "", "", "ok");
    cut_app::speech::set_setting(h.state_mut(), "speech.isolateVoice", json!(true));
    press(&mut h, "Transcribe");
    assert!(h.state().features.voice.setup.is_some(), "the voice model's setup after Whisper's");
    assert!(h.state().features.speech.job.is_none());
    press(&mut h, "Download");
    idle(&mut h);
    assert_eq!(words(&h).len(), 8, "the vocals' words");
    assert_eq!(h.state().features.voice.backend.stats().separations, 1, "one separation");
    let cache = dir.join("home").join("Cache");
    let vocals: Vec<_> = std::fs::read_dir(&cache)
        .map(|r| r.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".wav")).collect())
        .unwrap_or_default();
    assert_eq!(vocals.len(), 1, "the vocals for speech go to the Cut cache");
    assert_eq!(cut_app::voice::isolate::temp_files().limit(), 4 << 30, "voice.js's 4 GB a temp file");

    // Isolate Voice of the clip: the vocals file has the transcript, nothing recognised again
    cut_app::speech::set_setting(h.state_mut(), "speech.isolateVoice", json!(false));
    let windows = cut_app::speech::backend(h.state_mut()).stats().windows;
    let a1 = h.state().app.sequence().unwrap().clips().next().unwrap().id;
    h.state_mut().app.select([a1], false, false);
    run(&mut h, "auto.isolateVoice");
    idle(&mut h);
    assert_eq!(last_label(&h), "Isolate Voice");
    let media = h.state().app.sequence().unwrap().clip(a1).unwrap().media_id().unwrap();
    assert!(h.state().app.project().media(media).unwrap().name.ends_with("(Voice)"), "the clip plays the vocals");
    h.run_steps(3);
    assert_eq!(words(&h).len(), 8, "the panel keeps its words");
    assert_eq!(cut_app::speech::backend(h.state_mut()).stats().windows, windows, "nothing recognised again");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn claudes_transcribe_offer_asks_for_whisper_and_says_nothing_after_a_cancel() {
    let dir = scratch("claude");
    let f = wav(&dir.join("talk.wav"), 8.0, &[(0.5, 8, 1000.0)]);
    let mut h = open(&dir, &f, 8.0, "ok", "", "");
    cut_app::ai::metadata_ui::open(h.state_mut());
    h.run_steps(3);
    press(&mut h, "Transcribe");
    assert!(h.state().features.speech.setup.is_some(), "the offer goes through Whisper's setup dialog");
    press(&mut h, "Cancel");
    h.run_steps(5);
    assert!(h.state().features.speech.job.is_none(), "nothing recognised after the decline");
    let none = tr("No speech was recognized.").into_owned();
    assert!(!said(&h).contains(&none), "no toast after the decline: {:?}", said(&h));

    // set up, then cancel the recognition itself
    cut_app::speech::backend(h.state_mut()).test_config(
        Some(3000),
        None,
        None,
        Some(&["whisper-large-v3-turbo"]),
        false,
    );

    cut_app::ai::metadata_ui::open(h.state_mut());
    h.run_steps(3);
    press(&mut h, "Transcribe");
    if h.state().features.speech.setup.is_some() {
        press(&mut h, "Download");
        until(&mut h, "set up", |s| s.features.speech.setup.is_none());
    }
    until(&mut h, "recognising", |s| s.features.speech.job.is_some());
    h.state().features.speech.job.as_ref().unwrap().0.cancel();
    until(&mut h, "cancelled", |s| s.features.speech.job.is_none());
    h.run_steps(5);
    assert!(!said(&h).contains(&none), "no toast after a cancel: {:?}", said(&h));
    assert!(h.state().features.ai.metadata.shown.is_none(), "and Claude was not asked");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Writes, into `CUT_PICTURE_HOME`, a workspace whose project has a transcribed and labelled clip and the transcript
/// in its cache, for a picture of the real app (`CUT_HOME` that folder, `CUT_OPEN` the `.ncut`): `--ignored`.
#[test]
#[ignore]
fn write_a_project_with_speakers_for_a_picture() {
    let Some(home) = std::env::var_os("CUT_PICTURE_HOME").map(PathBuf::from) else { return };
    std::fs::create_dir_all(&home).unwrap();
    let f = wav(&home.join("talk.wav"), 18.0, &TALK);
    let mut h = open(&home, &f, 18.0, "", "", "");
    press(&mut h, "Label Speakers");
    idle(&mut h);
    let sp = Labels::of(h.state().app.project()).unwrap();
    assert!(cut_app::speakers::label::rename(&mut h.state_mut().app, &sp.list[0].id, "민지"));
    let out = home.join("home").join("speakers.ncut");
    let s = h.state_mut();
    s.doc.save_copy(&s.app, &out).expect("saved");
    eprintln!("{}", out.display());
}
