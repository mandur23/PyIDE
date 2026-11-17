//! Speaker labels with the fake backends (`PYIDE_WHISPER_BACKEND=fake`: one word per burst of sound;
//! `PYIDE_SPEAKERS_BACKEND=fake`: a window's embedding is its energy at 24 frequencies, so tones of different pitch
//! are different speakers), the cases of `verify/cut-speakers.mjs` and `cut-speakers-core.mjs`'s main side: the
//! sound is a WAV of tone bursts, "A" at 300 Hz, "B" at 1500 Hz, "C" at 800 Hz. In the window: Label Speakers from
//! the top bar's Automation menu with the setup dialog on first use, recognition of what is not transcribed, three
//! speakers each word its own, one undo step; renamed and undone; a fixed count of 2 from the cache (nothing
//! recognised or embedded again), Auto again keeping the name; Change Speaker and New Speaker as one step each; the
//! captions that name a speaker following the labels; the Caption Style dialog's Speakers row; every pretend failure
//! of the download explained; the fake backend's embeddings and its refusals.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use cut_app::files::Home;
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_app::speakers::backend::{Backend, fake_embedding};
use cut_app::speakers::core::{self as K, Labels, Opts};
use cut_app::speakers::label;
use cut_app::speech::engine::Speech;
use cut_model::Id;
use cut_sidecar::sound::SoundFiles;
use cut_time::{TICKS, Ticks};
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

type H = Harness<'static, Shell>;

/// The speakers of the WAV: who, first word (s), words, Hz; words every 0.5 s, 0.35 s long.
const PLAN: [(char, f64, usize, f64); 5] =
    [('A', 0.0, 7, 300.0), ('B', 4.5, 6, 1500.0), ('C', 8.5, 6, 800.0), ('A', 12.5, 4, 300.0), ('B', 15.5, 4, 1500.0)];

fn expected() -> Vec<char> {
    PLAN.iter().flat_map(|(w, _, n, _)| std::iter::repeat_n(*w, *n)).collect()
}

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-speakers-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn talk(path: &Path) -> PathBuf {
    let rate = 48000u32;
    let n = rate * 18;
    let mut pcm = vec![0i16; n as usize];
    for (_, at, count, hz) in PLAN {
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

/// The editor in English with `talk.wav` on A1 for 18 s, the fake recognition and the fake speaker model (its
/// pretend setup `setup`).
fn open(dir: &Path, setup: &str) -> (H, Id) {
    let file = talk(&dir.join("talk.wav"));
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.features.speakers.backend = Backend::fake(setup);
    s.features.speech.set_backend(Speech::fake("", Arc::new(SoundFiles::new(dir.join("sound")))));
    let seq = s.app.sequence_id.unwrap();
    let media = cut_app::import::probe_file(&file).result.unwrap();
    let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
    let m = Id::new(r["ids"][0].as_str().unwrap());
    s.app
        .exec(&cut_model::commands::build::place(
            seq.as_str(),
            json!({ "source": { "media": m.as_str() }, "in": 0, "out": secs(18.0), "at": 0, "video": null, "audio": "A1", "mode": "overwrite" }),
        ))
        .unwrap();
    let h = Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    (h, m)
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

fn press(h: &mut H, label: &str) {
    let text = tr(label).into_owned();
    h.get_all_by_label(&text).last().unwrap_or_else(|| panic!("there is {label}")).click();
    h.step();
    h.step();
}

fn idle(h: &mut H) {
    assert!(
        until(h, 60, |s| s.features.speakers.job.is_none()
            && s.features.speech.job.is_none()
            && s.features.speakers.setup.is_none()),
        "the labelling ends"
    );
    h.step();
}

fn labels(h: &H) -> Labels {
    Labels::of(h.state().app.project()).expect("the project has speaker labels")
}

/// Each word's speaker id, in time order.
fn word_ids(h: &mut H) -> Vec<Option<String>> {
    let words = cut_app::speech::flow::sequence_words(h.state_mut());
    let sp = Labels::of(h.state().app.project());
    label::word_speakers(&h.state().app, &words, sp.as_ref())
}

/// The speaker each word should have: A, B, C by first appearance.
fn truth(sp: &Labels) -> Vec<Option<String>> {
    expected().into_iter().map(|w| Some(sp.list["ABC".find(w).unwrap()].id.clone())).collect()
}

fn steps(h: &H) -> usize {
    h.state().app.history.position()
}

fn last_label(h: &H) -> String {
    h.state().app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn last_said(h: &H) -> String {
    let shown: Vec<(String, bool, f64)> =
        h.ctx.data_mut(|d| d.get_temp(egui::Id::unique("cut-toasts"))).unwrap_or_default();
    let mut all: Vec<String> = shown.into_iter().map(|t| t.0).collect();
    all.extend(h.state().app.notices.iter().map(|n| n.text.clone()));
    all.pop().unwrap_or_default()
}

#[test]
fn label_speakers_finds_the_three_then_renames_counts_and_changes_by_hand() {
    let dir = scratch("labels");
    let (mut h, media) = open(&dir, "ok");
    let steps0 = steps(&h);
    press(&mut h, "Automation");
    press(&mut h, "Label Speakers");
    assert!(h.state().features.speakers.setup.is_some(), "the setup dialog on first use");
    assert!(h.query_by_label_contains("WeSpeaker ResNet34-LM model: about 25 MB").is_some(), "the model and its size");
    assert!(h.query_by_label_contains("It runs entirely on this PC: the sound is never sent anywhere.").is_some());
    assert_eq!(h.state().features.speakers.backend.stats().setups, 0, "nothing downloaded before Download");
    press(&mut h, "Download");
    idle(&mut h);
    let sp = labels(&h);
    assert_eq!(sp.list.len(), 3, "Label Speakers (Auto) finds the three speakers: {sp:?}");
    assert_eq!(word_ids(&mut h), truth(&sp), "every word has its speaker");
    assert_eq!((last_label(&h).as_str(), steps(&h)), ("Label Speakers", steps0 + 1), "one undo step");
    assert_eq!(last_said(&h), "Speakers labeled: 3.");
    let colours: std::collections::HashSet<&str> = sp.list.iter().map(|s| s.color.as_str()).collect();
    assert_eq!(colours.len(), 3, "each speaker has its own colour");
    assert!(sp.turns.contains_key(media.as_str()));
    assert_eq!(label::name_of(&h.state().app, &sp.list[1].id), "Speaker 2", "unnamed speakers show as Speaker N");

    // rename through the dialog, undo and redo
    let first = sp.list[0].id.clone();
    h.state_mut().features.speakers.rename = Some((first.clone(), String::new()));
    h.step();
    h.step();
    assert!(h.query_by_label_contains("Empty: \"Speaker 1\".").is_some(), "the rename dialog says what empty means");
    h.state_mut().features.speakers.rename.as_mut().unwrap().1 = "  Mina  ".into();
    press(&mut h, "OK");
    assert_eq!(label::name_of(&h.state().app, &first), "Mina");
    assert_eq!(last_label(&h), "Rename Speaker");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("undo", &ctx);
    assert_eq!(label::name_of(&h.state().app, &first), "Speaker 1", "undo takes the name back");
    h.state_mut().run_action("redo", &ctx);
    assert_eq!(label::name_of(&h.state().app, &first), "Mina", "redo gives it again");

    // a fixed count of 2: from the cache, nothing recognised or embedded again
    let (windows0, embeds0) =
        (h.state_mut().features.speech.job.is_none(), h.state().features.speakers.backend.stats().embeds);
    assert!(windows0);
    let heard0 = cut_app::speech::backend(h.state_mut()).stats().windows;
    label::start(h.state_mut(), Some(2));
    idle(&mut h);
    let sp2 = labels(&h);
    assert_eq!((sp2.list.len(), sp2.count), (2, 2), "two speakers with 2 chosen");
    assert_eq!(h.state().features.speakers.backend.stats().embeds, embeds0, "the embeddings came from memory");
    assert_eq!(cut_app::speech::backend(h.state_mut()).stats().windows, heard0, "nothing recognised again");
    assert!(sp2.list.iter().any(|s| s.name == "Mina"), "the renamed speaker keeps its name");
    let ids = word_ids(&mut h);
    let of = |w: char| {
        ids.iter()
            .zip(expected())
            .filter(|(_, x)| *x == w)
            .map(|(i, _)| i.clone())
            .collect::<std::collections::HashSet<_>>()
    };
    assert!(of('A').len() == 1 && of('B').len() == 1, "A's and B's words stay together");
    label::start(h.state_mut(), Some(0));
    idle(&mut h);
    let back = labels(&h);
    assert!(back.count == 0 && back.list.len() == 3 && word_ids(&mut h) == truth(&back), "Auto again gives the three");
    assert_eq!(
        (back.list[0].id.as_str(), back.list[0].name.as_str()),
        (first.as_str(), "Mina"),
        "the first is still Mina"
    );

    // Change Speaker: B's first paragraph (words 7..13) to Mina, one step, undone
    let words = cut_app::speech::flow::sequence_words(h.state_mut());
    let steps1 = steps(&h);
    assert!(label::reassign(&mut h.state_mut().app, &words[7..13], &words, Some(&first)));
    let mut want = truth(&back);
    for w in &mut want[7..13] {
        *w = Some(first.clone());
    }
    assert_eq!(word_ids(&mut h), want, "the paragraph's words are Mina's, and only them");
    assert_eq!((last_label(&h).as_str(), steps(&h)), ("Change Speaker", steps1 + 1));
    h.state_mut().run_action("undo", &ctx);
    assert_eq!(word_ids(&mut h), truth(&back), "undo gives them back");
    // New Speaker: a fourth speaker with the next id and a colour not used yet
    assert!(label::reassign(&mut h.state_mut().app, &words[19..23], &words, None));
    let four = labels(&h);
    assert_eq!(four.list.len(), 4);
    assert_eq!(four.list[3].id, "sp4");
    assert!(!back.list.iter().any(|s| s.color == four.list[3].color), "a colour not used yet");
    assert_eq!(word_ids(&mut h)[19..23], vec![Some("sp4".to_owned()); 4][..]);
    h.state_mut().run_action("undo", &ctx);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn captions_follow_the_labels_and_caption_style_shows_speakers() {
    let dir = scratch("captions");
    let (mut h, _) = open(&dir, "");
    let seq = h.state().app.sequence_id.unwrap();
    let items: Vec<_> = PLAN
        .iter()
        .map(|(_, at, n, _)| json!({ "start": secs(*at), "end": secs(at + *n as f64 * 0.5 - 0.1), "text": "x" }))
        .collect();
    let r = h
        .state_mut()
        .app
        .exec(&cut_model::commands::build::add_caption_track(
            seq.as_str(),
            json!({ "name": "A", "items": items, "style": { "speakerColor": true } }),
        ))
        .unwrap();
    let track = Id::new(r["id"].as_str().unwrap());
    label::start(h.state_mut(), None);
    idle(&mut h);
    let sp = labels(&h);
    let ct = h.state().app.sequence().unwrap().captions.iter().find(|c| c.id == track).unwrap().clone();
    let got: Vec<Option<String>> = ct.items.iter().map(|it| it.speaker.clone()).collect();
    let want: Vec<Option<String>> =
        PLAN.iter().map(|(w, ..)| Some(sp.list["ABC".find(*w).unwrap()].id.clone())).collect();
    assert_eq!(got, want, "each caption knows its speaker, in the same step as the labels");
    // the Caption Style dialog: its Speakers row shows the track's choice and OK sets names and colours
    let form = cut_app::captions::style::StyleForm::of(&ct);
    assert_eq!(form.speakers, "color");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("captions.style", &ctx);
    h.step();
    h.step();
    assert!(h.query_by_label("Speakers").is_some(), "Caption Style has the Speakers row");
    h.state_mut().features.captions.style.as_mut().unwrap().speakers = "both";
    press(&mut h, "OK");
    let style = h.state().app.sequence().unwrap().captions.iter().find(|c| c.id == track).unwrap().style.clone();
    assert_eq!((style["speakerColor"].clone(), style["speakerName"].clone()), (json!(true), json!(true)));
    assert_eq!(cut_app::speakers::label::mode_of(&style), "both");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_pretend_download_failure_is_explained_and_cancel_labels_nothing() {
    for (code, says) in [
        ("offline", "The download could not reach the internet. Check the connection and try again."),
        ("disk", "There is not enough free disk space. Free up space and try again (pretend failure: disk)."),
        (
            "noPython",
            "Python was not found on this PC. Speaker labels need Python 3 (64-bit, from python.org). Install Python and try again.",
        ),
        ("busy", "The AI environment is in use by another Nano Studio window. Close it and try again."),
        ("noTorch", "The download failed: pretend failure: noTorch"),
    ] {
        let dir = scratch(&format!("fail-{code}"));
        let (mut h, _) = open(&dir, code);
        label::start(h.state_mut(), None);
        assert!(h.state().features.speakers.setup.is_some(), "{code}: the setup dialog");
        h.step();
        h.step();
        press(&mut h, "Download");
        assert!(until(&mut h, 20, |s| s.features.speakers.setup.as_ref().is_some_and(|d| d.error.is_some())), "{code}");
        let (got, text) = h.state().features.speakers.setup.as_ref().unwrap().error.clone().unwrap();
        assert_eq!((got.as_str(), text.as_str()), (code, says));
        assert!(h.query_by_label("Try Again").is_some());
        press(&mut h, "Cancel");
        for _ in 0..5 {
            h.step();
        }
        assert!(
            h.state().features.speakers.setup.is_none() && Labels::of(h.state().app.project()).is_none(),
            "{code}: nothing labelled"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn the_fake_tells_two_tones_apart_and_refuses_bad_windows() {
    let dir = scratch("fake");
    let r = 16000.0;
    let tone = |f: f64, k: f64| -> Vec<f32> {
        (0..32000)
            .map(|i| {
                (0.3 * (std::f64::consts::TAU * f * i as f64 / r).sin() * (1.0 + k * (i as f64 / 900.0).sin())) as f32
            })
            .collect()
    };
    let cos = |a: &[f32], b: &[f32]| {
        let n = |v: &[f32]| v.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt();
        a.iter().zip(b).map(|(x, y)| f64::from(*x) * f64::from(*y)).sum::<f64>() / (n(a) * n(b))
    };
    let (a1, a2, b) =
        (fake_embedding(&tone(300.0, 0.0)), fake_embedding(&tone(300.0, 0.1)), fake_embedding(&tone(1500.0, 0.0)));
    assert!(cos(&a1, &a2) > 0.95 && cos(&a1, &b) < 0.3, "same tone {}, other tone {}", cos(&a1, &a2), cos(&a1, &b));
    let files = SoundFiles::new(dir.join("sound"));
    let id = files.open().unwrap();
    files.write(&id, &tone(300.0, 0.0)).unwrap();
    files.write(&id, &tone(1500.0, 0.0)).unwrap();
    let sk = Backend::fake("");
    let never = AtomicBool::new(false);
    let e = sk.embed(&files, &id, &[(0, 16000), (16000, 16000), (32000, 16000), (48000, 16000)], &never).unwrap();
    assert_eq!((e.dim, e.data.len()), (24, 96), "one row of 24 per window");
    let rows: Vec<&[f32]> = e.data.chunks(24).collect();
    let opts = Opts { threshold: 0.45, ..Opts::default() };
    assert_eq!(K::cluster(&rows.iter().map(|r| Some(*r)).collect::<Vec<_>>(), &[1.0; 4], &opts), [0, 0, 1, 1]);
    assert_eq!(sk.embed(&files, "s99", &[(0, 16000)], &never).unwrap_err().code, "notFound");
    assert_eq!(sk.embed(&files, &id, &[(0, 31 * 16000)], &never).unwrap_err().code, "badArgs");
    assert_eq!(sk.embed(&files, &id, &[(0, 0)], &never).unwrap_err().code, "badArgs");
    sk.set_delay(30);
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    assert_eq!(sk.embed(&files, &id, &vec![(0, 16000); 50], &cancel).unwrap_err().code, "cancelled");
    t.join().unwrap();
    let missing = Backend::fake("offline");
    assert!(!missing.status().installed, "the pretend setup starts with the model missing");
    assert_eq!(missing.embed(&files, &id, &[(0, 16000)], &never).unwrap_err().code, "notInstalled");
    files.close(&id);
    for t in [
        "Label Speakers",
        "Labeling speakers…",
        "Download Speaker Labels",
        "Speakers labeled: {n}.",
        "No speech was recognized.",
        "Rename Speaker",
        "Change Speaker",
        "New Speaker",
        "Speaker {n}",
        "Speakers",
        "Speaker colors and names",
        "Speaker labels failed: {error}",
    ] {
        assert!(cut_app::i18n::has_korean(t), "{t} has its Korean");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
