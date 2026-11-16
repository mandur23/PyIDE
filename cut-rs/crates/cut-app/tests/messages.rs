//! The messages the JavaScript editor gives where something cannot be done, given here too (`tests/inventory.rs`
//! listed them as missing): Clear Cache's failure, a folder that cannot be listed, a caption file that cannot be
//! written, and Create Proxy with no video media it can read.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_model::History;
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

type H = Harness<'static, Shell>;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-messages-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn open(dir: &Path, build: impl FnOnce(&mut History)) -> H {
    let mut hist = cut_app::doc::fresh_history();
    build(&mut hist);
    let file = dir.join("messages.ncut");
    std::fs::write(&file, hist.serialize()).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .with_step_dt(1.0 / 30.0)
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while h.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    h.state_mut().transport.set_output_gain(0.0);
    h.step();
    h
}

/// The messages waiting to be shown, as their texts.
fn notices(h: &H) -> Vec<String> {
    h.state().app.notices.iter().map(|n| n.text.clone()).collect()
}

#[test]
fn clear_cache_says_when_its_folder_cannot_be_read() {
    let dir = scratch("cache");
    let mut h = open(&dir, |_| {});
    // the cache folder is a file now: it cannot be listed
    let cache = h.state().doc.home.cache.clone();
    let _ = std::fs::remove_dir_all(&cache);
    std::fs::write(&cache, b"not a folder").unwrap();
    let ctx = h.ctx.clone();
    h.state_mut().run_action("settings.cache", &ctx);
    h.step();
    h.step();
    h.get_by_label("Clear Cache").click();
    h.step();
    h.step();
    // the question's own button
    h.get_all_by_label("Clear Cache").last().expect("the question").click();
    h.step();
    h.step();
    assert!(
        h.query_by_label_contains("The cache could not be cleared:").is_some(),
        "the failure is reported (the JavaScript's sentence)"
    );
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_folder_that_cannot_be_listed_is_reported() {
    // a folder Windows lets no one list: the old profile junction, with a deny on listing for everyone
    let denied = Path::new(r"C:\Documents and Settings");
    if !denied.is_dir() || std::fs::read_dir(denied).is_ok() {
        eprintln!("no unlistable folder on this PC; skipped");
        return;
    }
    let dir = scratch("folder");
    let mut h = open(&dir, |_| {});
    let bins = h.state().app.project().bins.len();
    h.state_mut().import_paths(vec![denied.to_owned()], None);
    let said = notices(&h);
    assert!(said.iter().any(|n| n.starts_with("The folder could not be read: ")), "{said:?}");
    assert_eq!(h.state().app.project().bins.len(), bins, "no bin is made for it");
    assert_eq!(h.state().importer.pending(), 0, "and nothing is imported");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_caption_file_that_cannot_be_written_says_so() {
    let dir = scratch("captions");
    let mut h = open(&dir, |hist| {
        let seq = hist.project().sequences[0].id.as_str().to_owned();
        let r = hist
            .apply(&json!({ "type": "addCaptionTrack", "seqId": seq, "opts": { "name": "Captions", "lang": "en" } }))
            .unwrap();
        let track = r["id"].as_str().unwrap().to_owned();
        hist.apply(&json!({ "type": "addCaption", "seqId": seq, "trackId": track,
            "item": { "start": 0, "end": TICKS, "text": "Hello" } }))
            .unwrap();
    });
    // a folder in the way is a file
    let blocker = dir.join("not a folder");
    std::fs::write(&blocker, b"x").unwrap();
    let written = cut_app::captions::files::export_file(h.state_mut(), &blocker.join("captions.srt"));
    assert!(!written);
    let said = notices(&h);
    assert!(
        said.iter().any(|n| n.starts_with("The captions could not be exported: The file could not be written.")),
        "{said:?}"
    );
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn create_proxy_with_no_video_it_can_read_says_what_to_choose() {
    let dir = scratch("proxy");
    let gone = dir.join("gone.mp4");
    let mut h = open(&dir, |hist| {
        hist.apply(&json!({ "type": "importMedia", "binId": null, "media": [{ "path": gone.to_string_lossy(),
            "name": "gone.mp4", "kind": "video", "duration": 3 * TICKS, "video": { "w": 1920, "h": 1080 } }] }))
            .unwrap();
    });
    // the file is offline: the Relink dialog opened at once is let go
    h.state_mut().features.prefs.screen = None;
    h.step();
    let id = h.state().app.project().media[0].id;
    h.state_mut().project.select([id]);
    h.step();
    let ctx = h.ctx.clone();
    h.state_mut().run_action("createProxy", &ctx);
    assert!(notices(&h).iter().any(|n| n == "Choose video media to make proxies of."), "{:?}", notices(&h));
    // with nothing chosen at all it says where to choose
    h.state_mut().project.select([]);
    h.state_mut().app.notices.clear();
    h.state_mut().run_action("createProxy", &ctx);
    assert!(notices(&h).iter().any(|n| n == "Select video media in the Project panel first."), "{:?}", notices(&h));
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
