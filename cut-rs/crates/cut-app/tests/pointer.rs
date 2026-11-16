//! Controls added without a test that drove them, now driven by the pointer in the real window run headless: the
//! timeline header's volume slider (`ui-timeline.js` `volumeControl`), the Timeline Tool Bar, the Project panel's Uses
//! column and its sort, a sequence's Duplicate, and the Program monitor's dropped-frame count.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_app::state::Tool;
use cut_app::timeline::head_volume;
use cut_app::timeline::layout::{HEADER_W, RowKind};
use cut_model::{History, Id};
use cut_time::{TICKS, Ticks};
use eframe::egui::{self, Modifiers, Pos2, Rect, accesskit::Role, pos2, vec2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

type H = Harness<'static, Shell>;

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-pointer-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn until(h: &mut H, secs: u64, done: impl Fn(&Shell) -> bool) -> bool {
    let start = Instant::now();
    while !done(h.state()) {
        if start.elapsed() > Duration::from_secs(secs) {
            return false;
        }
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    true
}

fn apply(h: &mut History, cmd: Json) -> Json {
    h.apply(&cmd).unwrap_or_else(|e| panic!("{cmd}: {}", e.message))
}

/// The editor on the project `build` makes, in English, 1280 x 800, frames a thirtieth of a second apart.
fn open(dir: &Path, build: impl FnOnce(&mut History)) -> H {
    let mut hist = cut_app::doc::fresh_history();
    build(&mut hist);
    let file = dir.join("pointer.ncut");
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
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the monitors started");
    h.state_mut().transport.set_output_gain(0.0);
    for _ in 0..3 {
        h.step();
    }
    h
}

/// A press or release with the keys `m` held (the panels read the held keys, not the event's).
fn button(h: &mut H, at: Pos2, pressed: bool, m: Modifiers) {
    h.event(egui::Event::ModifiersChanged(m));
    h.event(egui::Event::PointerMoved(at));
    h.event(egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed, modifiers: m });
    h.step();
    if !pressed && m != Modifiers::NONE {
        h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
        h.step();
    }
}

fn click(h: &mut H, at: Pos2, m: Modifiers) {
    button(h, at, true, m);
    button(h, at, false, m);
}

fn steps(h: &H) -> Vec<String> {
    (0..h.state().app.history.steps()).filter_map(|i| h.state().app.history.step(i).map(|s| s.0.to_owned())).collect()
}

fn seq_id(h: &History) -> String {
    h.project().sequences[0].id.as_str().to_owned()
}

/// The header of the first audio track, on screen.
fn audio_head(h: &H) -> Rect {
    let s = h.state();
    let lanes = s.timeline.direct.lanes.expect("the timeline was drawn");
    let row = s.timeline.layout().rows.iter().find(|r| r.kind == RowKind::Audio).expect("an audio track").clone();
    let top = lanes.top() + row.y - s.timeline.view.scroll_y;
    Rect::from_min_size(pos2(lanes.left() - HEADER_W, top), vec2(HEADER_W, row.h))
}

fn a1_volume(h: &H) -> f64 {
    let seq = h.state().app.sequence().unwrap();
    seq.tracks.iter().find(|t| t.kind == cut_model::TrackKind::Audio).and_then(|t| t.volume).unwrap_or(0.0)
}

#[test]
fn the_header_volume_slider_drags_in_one_step_alt_click_is_100_and_a_double_click_types() {
    let dir = scratch("volume");
    let mut h = open(&dir, |hist| {
        let seq = seq_id(hist);
        let a1 = hist.project().sequences[0].tracks.iter().find(|t| t.kind == cut_model::TrackKind::Audio).unwrap().id;
        apply(hist, json!({ "type": "setTrack", "seqId": seq, "trackId": a1.as_str(), "patch": { "height": 64 } }));
    });
    let slider = head_volume::rect(audio_head(&h));
    let bar = Rect::from_min_max(slider.min, pos2(slider.right() - 40.0, slider.bottom()));
    assert_eq!(a1_volume(&h), 0.0, "100 % to begin with");

    // a drag to the right in several moves: louder, one undo step
    let from = pos2(bar.center().x, slider.center().y);
    button(&mut h, from, true, Modifiers::NONE);
    for dx in [4.0, 10.0, 18.0, 24.0] {
        h.event(egui::Event::PointerMoved(from + vec2(dx, 0.0)));
        h.step();
    }
    button(&mut h, from + vec2(24.0, 0.0), false, Modifiers::NONE);
    h.step();
    let louder = a1_volume(&h);
    assert!(louder > 0.5, "the track is louder: {louder} dB");
    assert_eq!(steps(&h), ["Track Volume"], "the whole drag is one step");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("undo", &ctx);
    h.step();
    assert_eq!(a1_volume(&h), 0.0, "and one undo takes it all back");
    h.state_mut().run_action("redo", &ctx);
    h.step();

    // a click alone changes nothing; Alt+click is 100 %
    h.step();
    click(&mut h, pos2(bar.left() + 10.0, slider.center().y), Modifiers::NONE);
    for _ in 0..12 {
        h.step();
    }
    assert_eq!(a1_volume(&h), louder, "a click is no change");
    click(&mut h, pos2(bar.left() + 10.0, slider.center().y), Modifiers::ALT);
    assert_eq!(a1_volume(&h), 0.0, "Alt+click: 100 %");
    assert_eq!(steps(&h).len(), 2);
    for _ in 0..12 {
        h.step();
    }

    // a double click opens the field to type a value
    let at = pos2(bar.right() - 6.0, slider.center().y);
    h.hover_at(at);
    h.step();
    click(&mut h, at, Modifiers::NONE);
    click(&mut h, at, Modifiers::NONE);
    h.step();
    assert!(
        matches!(h.state().app.edit.dialog, Some(cut_app::edit::dialogs::EditDialog::TrackVolume { .. })),
        "the Track Volume field is open"
    );
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_timeline_tool_bar_picks_tools() {
    let dir = scratch("toolbar");
    let mut h = open(&dir, |_| {});
    // the timeline's own bar: above its lanes, right of the Tools panel
    let bar_buttons = |h: &H, t: Tool| -> Vec<Rect> {
        let lanes = h.state().timeline.direct.lanes.unwrap();
        let glyph = cut_app::panels::tools::glyph(t);
        h.get_all_by_label(glyph)
            .map(|n| n.rect())
            .filter(|r| r.bottom() < lanes.top() && r.left() >= lanes.left() - HEADER_W)
            .collect()
    };
    assert!(bar_buttons(&h, Tool::Razor).is_empty(), "no tool bar until the View menu shows it");
    cut_app::prefs::set(h.state_mut(), "timelineTools", json!(true));
    h.step();
    h.step();
    for t in [Tool::Razor, Tool::Slip, Tool::Select] {
        let r = *bar_buttons(&h, t).first().expect("the tool's button on the timeline's bar");
        click(&mut h, r.center(), Modifiers::NONE);
        assert_eq!(h.state().app.tool, t, "the bar's button picks {t:?}");
    }
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Three media used 0, 1 and 2 times (a linked pair counts once).
fn three_media(hist: &mut History) -> [Id; 3] {
    let seq = seq_id(hist);
    let file = media::tone_aac();
    let list: Vec<Json> = ["b used once.m4a", "a unused.m4a", "c used twice.m4a"]
        .iter()
        .map(|n| {
            json!({ "path": file.to_string_lossy(), "name": n, "kind": "audio", "duration": 8 * TICKS,
            "audio": { "rate": 48000, "channels": 2 } })
        })
        .collect();
    let r = apply(hist, json!({ "type": "importMedia", "media": list, "binId": null }));
    let ids: Vec<Id> = r["ids"].as_array().unwrap().iter().map(|v| Id::new(v.as_str().unwrap())).collect();
    let a1 = hist.project().sequences[0].tracks.iter().find(|t| t.kind == cut_model::TrackKind::Audio).unwrap().id;
    for (m, at) in [(ids[0], 0.0), (ids[2], 1.0), (ids[2], 2.0)] {
        apply(
            hist,
            json!({ "type": "place", "seqId": seq, "opts": { "source": { "media": m.as_str() }, "audio": a1.as_str(),
                "at": secs(at), "out": secs(1.0), "mode": "overwrite" } }),
        );
    }
    [ids[0], ids[1], ids[2]]
}

/// The media rows of the Project panel top to bottom.
fn rows_in_order(h: &H, names: &[&str]) -> Vec<String> {
    let mut at: Vec<(f32, String)> =
        names.iter().map(|n| (h.get_by_role_and_label(Role::Button, n).rect().top(), (*n).to_owned())).collect();
    at.sort_by(|a, b| a.0.total_cmp(&b.0));
    at.into_iter().map(|x| x.1).collect()
}

#[test]
fn the_uses_column_counts_clips_and_sorts_by_a_click_on_its_header() {
    let dir = scratch("uses");
    let mut h = open(&dir, |hist| {
        three_media(hist);
    });
    let names = ["b used once.m4a", "a unused.m4a", "c used twice.m4a"];
    let p = h.state().app.project();
    let uses = cut_app::panels::project::uses_all(p);
    let n = |i: usize| uses.get(&p.media[i].id).copied().unwrap_or(0);
    assert_eq!([n(0), n(1), n(2)], [1, 0, 2], "clips of each media item");
    assert_eq!(rows_in_order(&h, &names), names, "the project's order to begin with");

    // the Uses header: the last column's title over the rows
    // (its left end: a narrow panel scrolls the rest of the row under its scroll bar)
    let r = h.get_by_role_and_label(Role::ColumnHeader, "Uses").rect();
    let header = pos2(r.left() + 6.0, r.center().y);
    click(&mut h, header, Modifiers::NONE);
    h.step();
    assert_eq!(rows_in_order(&h, &names), ["a unused.m4a", "b used once.m4a", "c used twice.m4a"], "fewest first");
    for _ in 0..12 {
        h.step();
    }
    click(&mut h, header, Modifiers::NONE);
    h.step();
    assert_eq!(rows_in_order(&h, &names), ["c used twice.m4a", "b used once.m4a", "a unused.m4a"], "then most first");
    // an edit counts again: the unused one placed twice goes to the top
    let seq = h.state().app.sequence_id.unwrap();
    let a1 =
        h.state().app.sequence().unwrap().tracks.iter().find(|t| t.kind == cut_model::TrackKind::Audio).unwrap().id;
    let unused = h.state().app.project().media[1].id;
    for at in [4.0, 6.0, 8.0] {
        h.state_mut()
            .app
            .exec(&json!({ "type": "place", "seqId": seq.as_str(), "opts": { "source": { "media": unused.as_str() },
            "audio": a1.as_str(), "at": secs(at), "out": secs(1.0), "mode": "overwrite" } }));
    }
    h.step();
    assert_eq!(rows_in_order(&h, &names)[0], "a unused.m4a", "three uses now");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_sequence_is_duplicated_from_its_menu_in_the_project_panel() {
    let dir = scratch("duplicate");
    let mut h = open(&dir, |hist| {
        three_media(hist);
    });
    let name = h.state().app.sequence().unwrap().name.clone();
    let row = h.get_by_role_and_label(Role::ListItem, &name).rect();
    h.event(egui::Event::PointerMoved(row.center()));
    for pressed in [true, false] {
        h.event(egui::Event::PointerButton {
            pos: row.center(),
            button: egui::PointerButton::Secondary,
            pressed,
            modifiers: Modifiers::NONE,
        });
        h.step();
    }
    h.step();
    h.get_by_label("Duplicate").click();
    h.step();
    h.step();
    let p = h.state().app.project();
    assert_eq!(p.sequences.len(), 2, "a second sequence");
    let copy = &p.sequences[1];
    assert_eq!(copy.name, format!("{name} Copy"));
    assert_eq!(copy.clips().count(), p.sequences[0].clips().count(), "with the clips");
    assert_eq!(h.state().app.sequence_id, Some(copy.id), "and it opens in the timeline");
    assert!(h.query_by_role_and_label(Role::ListItem, &copy.name).is_some(), "listed in the panel");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_program_monitor_counts_the_frames_playback_dropped() {
    let dir = scratch("dropped");
    let mut h = open(&dir, |hist| {
        let seq = seq_id(hist);
        apply(
            hist,
            json!({ "type": "addGenerated", "seqId": seq, "opts": { "source": { "generator": "solid", "color": "#336699" },
                "at": 0, "duration": secs(5.0), "track": "V1", "name": "blue" } }),
        );
    });
    assert!(h.query_by_label_contains("dropped frames").is_none(), "nothing dropped yet");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("playPause", &ctx);
    // frames drawn a fifth of a second apart while it plays at 30 fps: five frames go by each time
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(200));
        h.step();
    }
    h.state_mut().run_action("playPause", &ctx);
    h.step();
    let n = h.state().play.dropped;
    assert!(n >= 10, "playback skipped frames: {n}");
    h.get_by_label(&format!("{n} dropped frames"));
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_history_panel_goes_to_a_step_clicked_among_many() {
    let dir = scratch("history");
    let mut h = open(&dir, |_| {});
    let seq = h.state().app.sequence_id.unwrap();
    for i in 0..300 {
        h.state_mut().app.exec(&json!({ "type": "renameItem", "id": seq.as_str(), "name": format!("Step {i}") }));
    }
    h.state_mut().lower_tab = cut_app::shell::LowerTab::History;
    h.step();
    h.step();
    let made = h.query_all_by_role(Role::ListItem).count();
    assert!((3..80).contains(&made), "only the rows in view are made: {made} of 301");
    // the state before the first step, clicked: everything undone at once
    let start = h.get_by_role_and_label(Role::ListItem, "Start").rect();
    click(&mut h, start.center(), Modifiers::NONE);
    assert_eq!(h.state().app.history.position(), 0, "back to the start");
    assert_eq!(h.state().app.sequence().unwrap().name, "Sequence 1");
    // and the last row, after scrolling to the bottom of the list
    for _ in 0..40 {
        h.event(egui::Event::MouseWheel {
            unit: egui::MouseWheelUnit::Point,
            delta: egui::vec2(0.0, -400.0),
            modifiers: Modifiers::NONE,
            phase: egui::TouchPhase::Move,
            source: egui::MouseWheelSource::Wheel,
        });
        h.step();
    }
    let rows: Vec<Rect> = h.get_all_by_role_and_label(Role::ListItem, "Rename").map(|n| n.rect()).collect();
    let last = rows.iter().copied().max_by(|a, b| a.top().total_cmp(&b.top())).unwrap();
    click(&mut h, last.center(), Modifiers::NONE);
    assert_eq!(h.state().app.history.position(), 300, "every step done again");
    assert_eq!(h.state().app.sequence().unwrap().name, "Step 299");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
