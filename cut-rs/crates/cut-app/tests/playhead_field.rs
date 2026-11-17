//! The playhead timecodes typed into (`ui-base.js` `timecodeField`) and a caption track's Sync Lock button
//! (`ui-timeline.js` caption heads), driven by clicks and keys in the window.

use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_time::{TICKS, parse_timecode};
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

fn shell(name: &str) -> Shell {
    let dir = std::env::temp_dir().join(format!("cut-app-playhead-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = Shell::new(Home::at(dir));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    let seq = s.app.sequence_id.unwrap();
    s.app
        .exec(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
            "source": { "generator": "solid", "color": "#336699" }, "at": 0, "duration": 20 * TICKS, "track": "V1",
            "name": "Blue",
        } }))
        .expect("a clip");
    s
}

fn harness(s: Shell) -> Harness<'static, Shell> {
    let mut h =
        Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    h.run_steps(3);
    h
}

fn typed(h: &mut Harness<'static, Shell>, label: &str, text: &str, key: egui::Key) {
    // the rightmost: the Program monitor's when both monitors show one
    let x = |n: &egui_kittest::Node<'_>| n.rect().min.x;
    h.query_all_by_label(label).max_by(|a, b| x(a).total_cmp(&x(b))).expect(label).click();
    h.run_steps(2);
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::A);
    h.event(egui::Event::Text(text.into()));
    h.run_steps(1);
    h.key_press(key);
    h.run_steps(2);
}

#[test]
fn the_playhead_timecodes_take_a_typed_time() {
    let mut h = harness(shell("typed"));
    let fps = h.state().app.sequence().unwrap().fps;
    typed(&mut h, "Playhead Position", "00:00:02:10", egui::Key::Enter);
    assert_eq!(h.state().app.t, parse_timecode("00:00:02:10", fps, 0).unwrap(), "the Timeline's, a timecode");
    typed(&mut h, "Playhead Position", "+15", egui::Key::Enter);
    assert_eq!(h.state().app.t, parse_timecode("00:00:02:25", fps, 0).unwrap(), "frames from the shown time");
    let before = h.state().app.t;
    typed(&mut h, "Playhead Position", "00:00:09:00", egui::Key::Escape);
    assert_eq!(h.state().app.t, before, "Escape keeps the time");
    typed(&mut h, "Playhead position", "00:00:05:00", egui::Key::Enter);
    assert_eq!(h.state().app.t, 5 * TICKS, "the Program monitor's");
}

#[test]
fn a_caption_tracks_sync_lock_is_turned_off_and_on_in_its_header() {
    let mut s = shell("sync");
    let seq = s.app.sequence_id.unwrap();
    s.app
        .exec(&cut_model::commands::build::add_caption_track(seq.as_str(), json!({ "lang": "ko" })))
        .expect("a caption track");
    let mut h = harness(s);
    let on = |h: &Harness<'static, Shell>| h.state().app.sequence().unwrap().captions[0].sync_lock;
    assert!(on(&h), "on when made");
    h.get_by_label("Sync Lock").click();
    h.run_steps(2);
    assert!(!on(&h), "a click turns it off");
    h.get_by_label("Sync Lock").click();
    h.run_steps(2);
    assert!(on(&h), "and on again");
}
