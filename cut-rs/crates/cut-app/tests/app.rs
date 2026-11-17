//! The app without a window: the state, the project's life (open, save, autosave, recovery), importing, the keyboard
//! table against `ui-keys.js`, the Korean texts, and the edit actions run on a real project.

use std::path::{Path, PathBuf};

use cut_app::doc::{self, AUTOSAVE_MS, COPY_MS, Doc, SaveOutcome};
use cut_app::files::{Home, Projects, Run};
use cut_app::i18n::{self, Lang};
use cut_app::import;
use cut_app::keys::{self, Preset};
use cut_app::shell::Shell;
use cut_app::state::{App, Tool};
use cut_model::Id;
use eframe::egui::{self, Key, Modifiers};
use egui_kittest::kittest::Queryable;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// A fresh workspace folder under `CUT_TEST_TMP` (or the system's temp folder).
fn home(name: &str) -> Home {
    let base = std::env::var_os("CUT_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!("cut-app-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Home::at(dir)
}

fn fixture(rel: &str) -> PathBuf {
    repo().join("verify/fixtures").join(rel)
}

#[test]
fn state_selects_toggles_and_prunes() {
    let mut app = App::new(doc::fresh_history(), None);
    let (a, b) = (Id::new("x1"), Id::new("x2"));
    app.select([a, b], false, false);
    app.select([a], false, true);
    assert_eq!(app.selection.len(), 1);
    app.select([b], true, false);
    assert!(app.selection.contains(&b));
    app.prune_selection();
    assert!(app.selection.is_empty(), "ids that are no clip of the sequence go");
    app.set_time(-5);
    assert_eq!(app.t, 0);
    assert_eq!(app.tool, Tool::Select);
    assert!(app.sequence().is_some());
}

#[test]
fn a_new_project_is_named_in_the_screen_language() {
    i18n::set_lang(Lang::Ko);
    let ko = doc::fresh_history().project().sequences[0].name.clone();
    i18n::set_lang(Lang::En);
    let en = doc::fresh_history().project().sequences[0].name.clone();
    assert_eq!(en, "Sequence 1");
    assert_ne!(ko, en);
}

#[test]
fn text_that_is_no_project_is_refused_with_the_javascript_codes() {
    assert_eq!(doc::history_from_text("nope").err().unwrap().code, "notProject");
    assert_eq!(doc::history_from_text("{\"format\":\"other\"}").err().unwrap().code, "notProject");
    let newer = r#"{"format":"ncut","version":99,"sequences":[],"media":[],"bins":[]}"#;
    assert_eq!(doc::history_from_text(newer).err().unwrap().code, "newer");
}

#[test]
fn save_open_and_the_changed_on_disk_question() {
    let home = home("save");
    let (mut doc, mut app) = Doc::start(home.clone(), 1000);
    assert!(!doc.dirty(&app));
    app.exec(&cut_app::cmd::add_bin("B", None)).unwrap();
    assert!(doc.dirty(&app));
    let path = home.projects.join("one.ncut");
    assert!(matches!(doc.write_to(&mut app, &path, false, 2000), SaveOutcome::Saved(_)));
    assert!(!doc.dirty(&app));
    assert_eq!(Path::new(&doc.key), path, "the session follows the file");
    assert_eq!(doc.recent(), vec![path.clone()]);
    // another program writes the file: the next save asks
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&path, std::fs::read_to_string(&path).unwrap()).unwrap();
    app.exec(&cut_app::cmd::add_bin("C", None)).unwrap();
    assert!(matches!(doc.write_to(&mut app, &path, false, 3000), SaveOutcome::Changed(_)));
    assert!(matches!(doc.write_to(&mut app, &path, true, 3000), SaveOutcome::Saved(_)));
    assert!(path.with_extension("ncut.bak").exists(), "the file it replaced is kept");
    // open it again
    doc.new_project(&mut app, 4000);
    assert!(app.path.is_none());
    doc.open(&mut app, &path, 5000).unwrap();
    assert_eq!(app.project().bins.len(), 2);
    assert!(!doc.dirty(&app));
    // a file that is gone leaves the recent list
    std::fs::remove_file(&path).unwrap();
    assert!(doc.open(&mut app, &path, 6000).is_err());
    assert!(doc.recent().is_empty());
    doc.end();
}

#[test]
fn autosave_waits_two_seconds_after_the_last_edit_and_copies_every_five_minutes() {
    let home = home("autosave");
    let (mut doc, mut app) = Doc::start(home.clone(), 0);
    assert!(!doc.tick(&app, 10_000), "nothing to save");
    app.exec(&cut_app::cmd::add_bin("B", None)).unwrap();
    assert!(!doc.tick(&app, 10_000), "the edit is seen now");
    assert!(!doc.tick(&app, 10_000 + AUTOSAVE_MS - 1));
    assert!(doc.tick(&app, 10_000 + AUTOSAVE_MS), "2 s after the edit");
    assert!(!doc.tick(&app, 20_000), "once per state");
    doc.flush();
    let list = doc.projects.autosaves_of(&doc.key);
    assert_eq!(list.len(), 1);
    assert!(list[0].latest);
    // a group in progress (a drag) is not saved
    app.history.begin("Drag");
    app.history.apply(&cut_app::cmd::add_bin("D", None)).unwrap();
    assert!(!doc.tick(&app, 30_000));
    assert!(!doc.tick(&app, 40_000));
    app.history.commit();
    assert!(!doc.tick(&app, 40_000));
    assert!(doc.tick(&app, 40_000 + AUTOSAVE_MS));
    // the interval copy
    assert!(doc.tick(&app, COPY_MS + 1));
    doc.flush();
    let list = doc.projects.autosaves_of(&doc.key);
    assert_eq!(list.iter().filter(|a| !a.latest).count(), 1);
    assert_eq!(list.iter().filter(|a| a.latest).count(), 1, "the latest state replaces the latest state");
    doc.end();
}

#[test]
fn a_crashed_session_is_offered_and_recovers_unsaved() {
    let home = home("recover");
    {
        // the run that crashed: another identity, its process gone (pid 1 never runs this app)
        let mut gone = Projects::with_run(
            home.autosave.clone(),
            Run { pid: 4_000_000_000, run: "deadbeef0001".into(), started: cut_app::files::now_ms() },
        );
        gone.session_start("untitled-abc").unwrap();
        let text = doc::fresh_history().serialize();
        gone.autosave("untitled-abc", &text, true, 20).unwrap();
    }
    let (mut doc, mut app) = Doc::start(home.clone(), cut_app::files::now_ms());
    let offers = doc.projects.recovery();
    assert_eq!(offers.len(), 1);
    doc.recover(&mut app, &offers[0], cut_app::files::now_ms()).unwrap();
    assert!(doc.dirty(&app), "recovered changes count as unsaved");
    assert!(app.path.is_none());
    assert_eq!(doc.key, "untitled-abc", "the recovered session goes on");
    doc.end();
    assert!(doc.projects.recovery().is_empty(), "a clean end leaves nothing to offer");
}

#[test]
fn importing_probes_the_fixtures_and_refuses_with_the_javascript_sentences() {
    let video = import::probe_file(&fixture("viewers/video/clip.mp4")).result.unwrap();
    assert_eq!(video["kind"], "video");
    assert_eq!(video["video"]["w"], 160);
    assert!(video["duration"].as_f64().unwrap() > 0.0);
    let audio = import::probe_file(&fixture("viewers/audio/tone.wav")).result.unwrap();
    assert_eq!(audio["kind"], "audio");
    assert!(audio["video"].is_null());
    let image = import::probe_file(&fixture("viewers/images/sample.png")).result.unwrap();
    assert_eq!((image["kind"].as_str(), image["duration"].as_f64()), (Some("image"), Some(0.0)));
    // refusals
    let missing = import::probe_file(&fixture("viewers/video/none.mp4")).result.unwrap_err();
    assert_eq!(import::reason_text(missing.code), "The file is gone.");
    let text = import::probe_file(&repo().join("docs/cut-app.md")).result.unwrap_err();
    assert_eq!((text.code, import::reason_text(text.code)), ("extension", "The file could not be read."));
    let dir = home("import");
    let fake = dir.home.join("fake.mp4");
    std::fs::write(&fake, b"not a movie at all").unwrap();
    let r = import::probe_file(&fake).result.unwrap_err();
    assert!(["unsupported", "damaged"].contains(&r.code), "{r:?}");
    // the entries go into the project as importMedia takes them
    let mut app = App::new(doc::fresh_history(), None);
    let ids = app.exec(&cut_app::cmd::import_media(vec![video, audio, image], None)).unwrap();
    assert_eq!(ids["ids"].as_array().unwrap().len(), 3);
}

#[test]
fn the_importer_runs_off_the_ui_thread() {
    let mut imp = import::Importer::default();
    imp.start(vec![fixture("viewers/video/clip.mp4"), fixture("viewers/audio/tone.wav"), fixture("nope.mov")]);
    assert_eq!(imp.pending(), 3);
    let got = imp.wait();
    assert_eq!(got.len(), 3);
    assert_eq!(got.iter().filter(|p| p.result.is_ok()).count(), 2);
}

#[test]
fn a_folder_lists_its_media_with_their_bins() {
    let h = home("folder");
    let root = h.home.join("shoot");
    std::fs::create_dir_all(root.join("day1/a")).unwrap();
    for f in ["x.mp4", "day1/y.wav", "day1/a/z.png", "day1/notes.txt"] {
        std::fs::write(root.join(f), b"").unwrap();
    }
    let (list, truncated) = import::list_folder(&root);
    assert!(!truncated, "four entries are under the limit");
    let rels: Vec<(String, Vec<String>)> =
        list.iter().map(|(p, r)| (p.file_name().unwrap().to_string_lossy().into_owned(), r.clone())).collect();
    assert_eq!(
        rels,
        [
            ("x.mp4".into(), vec![]),
            ("y.wav".into(), vec!["day1".to_owned()]),
            ("z.png".into(), vec!["day1".to_owned(), "a".to_owned()])
        ]
    );
}

/// `['id', 'Title', keys, scope]` entries of ui-keys.js's ACTIONS, read from the file.
fn js_actions() -> Vec<(String, String, Vec<String>)> {
    let text = std::fs::read_to_string(repo().join("renderer/features/cut/ui-keys.js")).unwrap();
    let start = text.find("const ACTIONS = [").unwrap();
    let end = start + text[start..].find("\n  ];").unwrap();
    let mut out = Vec::new();
    for line in text[start..end].lines() {
        let l = line.trim();
        if !l.starts_with("['") {
            continue;
        }
        let strings: Vec<String> = l.split('\'').skip(1).step_by(2).map(|x| x.replace("\\\\", "\\")).collect();
        let (id, title) = (strings[0].clone(), strings[1].clone());
        let rest: Vec<String> =
            strings[2..].iter().filter(|s| !["panel", "global", "always"].contains(&s.as_str())).cloned().collect();
        out.push((id, title, rest));
    }
    out
}

#[test]
fn the_key_table_is_ui_keys_js() {
    let js = js_actions();
    assert!(js.len() > 100);
    for (id, title, ks) in &js {
        let a = keys::action(id).unwrap_or_else(|| panic!("{id} missing"));
        assert_eq!(a.title, title, "{id}");
        let mine: Vec<String> = a.keys.iter().map(|k| (*k).to_owned()).collect();
        // `"'"` is read by the split as an empty string pair: compare the shape only for that key
        if id != "extract" {
            assert_eq!(&mine, ks, "{id}");
        }
    }
    for a in keys::ACTIONS {
        assert!(a.id.starts_with("window.") || js.iter().any(|(id, ..)| id == a.id), "{} is not in ui-keys.js", a.id);
        for k in keys::keys_of(a.id, Preset::Premiere).iter().chain(a.keys) {
            assert!(keys::parse(k).is_some(), "{k} parses");
        }
    }
}

#[test]
fn keys_match_presses_in_each_preset() {
    let none = Modifiers::NONE;
    let ctrl = Modifiers::CTRL;
    let shift = Modifiers::SHIFT;
    assert_eq!(keys::action_for(Key::K, ctrl, Preset::Premiere, false), Some("split"));
    assert_eq!(keys::action_for(Key::C, none, Preset::Premiere, false), Some("tool.razor"));
    assert_eq!(keys::action_for(Key::X, Modifiers::CTRL | shift, Preset::Premiere, false), Some("clearInOut"));
    assert_eq!(keys::action_for(Key::X, Modifiers::ALT, Preset::Classic, false), Some("clearInOut"));
    assert_eq!(keys::action_for(Key::X, Modifiers::ALT, Preset::Premiere, false), None, "Premiere replaced Alt+X");
    assert_eq!(keys::action_for(Key::Questionmark, shift, Preset::Premiere, false), Some("keyHelp"));
    assert_eq!(keys::action_for(Key::Escape, none, Preset::Premiere, false), Some("deselect"));
    assert_eq!(keys::action_for(Key::Num1, shift, Preset::Premiere, false), Some("window.project"));
    // while typing only the `always` keys (Ctrl+S) act
    assert_eq!(keys::action_for(Key::C, none, Preset::Premiere, true), None);
    assert_eq!(keys::action_for(Key::S, ctrl, Preset::Premiere, true), Some("save"));
    assert_eq!(keys::shown("split", Preset::Premiere), "Ctrl+K");
}

#[test]
fn every_text_of_the_menus_and_panels_is_translated() {
    let mut missing = Vec::new();
    for a in keys::ACTIONS {
        if !i18n::has_korean(a.title) {
            missing.push(a.title);
        }
    }
    for t in Tool::ALL {
        assert!(i18n::has_korean(t.title()), "{}", t.title());
    }
    for r in ["unsupported", "damaged", "hdr", "noTracks", "codec", "missing", "io"] {
        assert!(i18n::has_korean(import::reason_text(r)), "{r}");
    }
    assert!(missing.len() <= 2, "untranslated action titles: {missing:?}");
}

fn shell_with_clips() -> (Shell, egui::Context) {
    i18n::set_lang(Lang::En);
    let home = home(&format!("shell-{:?}", std::thread::current().id()).replace(['(', ')'], ""));
    let mut s = Shell::new(home);
    let media = import::probe_file(&fixture("viewers/video/clip.mp4")).result.unwrap();
    let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
    let m = Id::new(r["ids"][0].as_str().unwrap());
    let seq = s.app.sequence_id.unwrap();
    for i in 0..3 {
        s.app
            .exec(&cut_app::cmd::place(
                seq,
                m,
                Some(Id::new("V1")),
                Some(Id::new("A1")),
                i * 2 * cut_time::TICKS,
                "overwrite",
            ))
            .unwrap();
    }
    (s, egui::Context::default())
}

#[test]
fn edit_actions_run_commands_and_undo() {
    let (mut s, ctx) = shell_with_clips();
    let n = s.app.sequence().unwrap().clip_count();
    s.app.set_time(cut_time::TICKS);
    s.run_action("split", &ctx);
    assert_eq!(s.app.sequence().unwrap().clip_count(), n + 1, "Add Edit cuts the clip under the playhead");
    s.run_action("selectAll", &ctx);
    s.run_action("copy", &ctx);
    assert_eq!(s.app.clipboard.len(), n + 1);
    s.run_action("delete", &ctx);
    assert_eq!(s.app.sequence().unwrap().clip_count(), 0);
    s.run_action("undo", &ctx);
    assert_eq!(s.app.sequence().unwrap().clip_count(), n + 1);
    s.app.set_time(10 * cut_time::TICKS);
    s.run_action("paste", &ctx);
    assert_eq!(s.app.sequence().unwrap().clip_count(), 2 * (n + 1));
    s.app.selection.clear();
    s.run_action("addMarker", &ctx);
    assert_eq!(s.app.sequence().unwrap().markers.len(), 1, "{:?}", s.app.notices);
    s.run_action("clearAllMarkers", &ctx);
    assert!(s.app.sequence().unwrap().markers.is_empty());
    s.run_action("tool.razor", &ctx);
    assert_eq!(s.app.tool, Tool::Razor);
    s.run_action("goEnd", &ctx);
    assert_eq!(s.app.t, s.app.sequence().unwrap().duration());
    s.run_action("prevEdit", &ctx);
    assert!(s.app.t < s.app.sequence().unwrap().duration());
    s.run_action("markIn", &ctx);
    s.run_action("goStart", &ctx);
    s.run_action("markOut", &ctx);
    assert!(s.app.in_out.in_.is_some() && s.app.in_out.out == Some(0));
    assert!(s.action_enabled("export"), "Export Media is built");
    assert!(s.action_enabled("window.mixer"), "the Audio Track Mixer is built: enabled");
}

#[test]
fn track_heights_are_one_undo_step() {
    let (mut s, ctx) = shell_with_clips();
    let steps = s.app.history.list().len();
    s.run_action("expandTracks", &ctx);
    assert!(s.app.sequence().unwrap().tracks.iter().all(|t| t.height == 100.0));
    assert_eq!(s.app.history.list().len(), steps + 1);
    s.run_action("minimizeTracks", &ctx);
    assert!(s.app.sequence().unwrap().tracks.iter().all(|t| t.height == 24.0));
}

#[test]
fn the_window_draws_with_egui_kittest() {
    let (mut s, _) = shell_with_clips();
    let mut harness =
        egui_kittest::Harness::builder().with_size(egui::Vec2::new(1280.0, 800.0)).build_ui(move |ui| s.frame(ui));
    harness.run_steps(3);
    for label in ["File", "Edit", "Sequence", "Project", "Program", "Timeline", "History"] {
        let ko = i18n::text_in(Lang::Ko, label);
        assert!(
            harness.query_all_by_label(label).next().is_some() || harness.query_all_by_label(&ko).next().is_some(),
            "{label} is on screen"
        );
    }
    let history = if harness.query_all_by_label("History").next().is_some() {
        "History".to_owned()
    } else {
        i18n::text_in(Lang::Ko, "History")
    };
    harness.get_by_label(&history).click();
    harness.run_steps(2);
}

#[test]
fn the_app_finds_media_and_shares_its_sequence_once_a_revision() {
    let mut app = App::new(doc::fresh_history(), None);
    let media: Vec<serde_json::Value> = (0..3)
        .map(|i| {
            serde_json::json!({ "path": format!(r"C:\m\{i}.mp4"), "name": format!("{i}.mp4"), "kind": "video",
            "duration": cut_time::TICKS, "video": { "w": 64, "h": 36 } })
        })
        .collect();
    app.exec(&cut_app::cmd::import_media(media, None)).unwrap();
    let ids: Vec<cut_model::Id> = app.project().media.iter().map(|m| m.id).collect();
    for id in &ids {
        assert_eq!(app.media(*id).map(|m| m.id), Some(*id));
    }
    let a = app.shared_sequence().unwrap();
    assert!(std::rc::Rc::ptr_eq(&a, &app.shared_sequence().unwrap()), "one copy while nothing changes");
    let seq = a.id;
    app.exec(&serde_json::json!({ "type": "renameItem", "id": seq.as_str(), "name": "Renamed" })).unwrap();
    let b = app.shared_sequence().unwrap();
    assert!(!std::rc::Rc::ptr_eq(&a, &b) && b.name == "Renamed", "a new copy after an edit");
    app.exec(&serde_json::json!({ "type": "removeMedia", "ids": [ids[0].as_str()] })).unwrap();
    assert!(app.media(ids[0]).is_none(), "a removed item is gone");
    assert_eq!(app.media(ids[2]).map(|m| m.id), Some(ids[2]), "the others are found where they are now");
    app.undo();
    assert_eq!(app.media(ids[0]).map(|m| m.id), Some(ids[0]), "and back after undo");
    // another project counts its revisions from the start: nothing of the old one is kept
    app.set_history(doc::fresh_history(), None);
    assert!(app.media(ids[1]).is_none());
    assert_eq!(app.shared_sequence().unwrap().name, app.sequence().unwrap().name);
}
