//! Workspaces arranged by the person (`cut_app::arrange`, `cut_app::workspaces`), in the real window run headless: a
//! tab dragged onto another panel docks there, a panel closed from its tab's menu leaves and the Window menu puts it
//! back, the arrangement comes back at the next start, named layouts, Reset to Saved Layout and to Default Layout.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::arrange::Side;
use cut_app::files::{Home, now_ms};
use cut_app::shell::{LowerTab, Shell};
use cut_app::workspaces::{self, Ws};
use cut_model::History;
use eframe::egui::{self, Pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

type H = Harness<'static, Shell>;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-arrange-{name}-{}", std::process::id()));
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

/// The editor on an empty sequence, in English, 1280 x 800, with its settings in `dir\home`.
fn open(dir: &Path) -> H {
    let hist: History = cut_app::doc::fresh_history();
    let file = dir.join("arrange.ncut");
    if !file.exists() {
        std::fs::write(&file, hist.serialize()).unwrap();
    }
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .with_step_dt(1.0 / 30.0)
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the window gave the monitors its GPU device");
    h.state_mut().transport.set_output_gain(0.0);
    for _ in 0..3 {
        h.step();
    }
    h
}

fn slot_rect(h: &H, k: (usize, usize)) -> egui::Rect {
    h.state().features.view.slots[&(Ws::Editing, k)]
}

/// The tab named `name` inside the slot `k`.
fn tab(h: &H, k: (usize, usize), name: &str) -> Pos2 {
    let r = slot_rect(h, k);
    h.query_all_by_label(name)
        .map(|n| n.rect().center())
        .find(|c| r.contains(*c) && c.y < r.top() + 32.0)
        .unwrap_or_else(|| panic!("no {name} tab in slot {k:?}"))
}

fn pointer(h: &mut H, at: Pos2, pressed: Option<bool>) {
    h.event(egui::Event::PointerMoved(at));
    if let Some(pressed) = pressed {
        h.event(egui::Event::PointerButton {
            pos: at,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        });
    }
    h.step();
}

/// Drags from `from` to `to` in steps, as a hand does.
fn drag(h: &mut H, from: Pos2, to: Pos2) {
    pointer(h, from, Some(true));
    for k in 1..=6 {
        pointer(h, from + (to - from) * (k as f32 / 6.0), None);
    }
    pointer(h, to, Some(false));
    h.step();
    h.step();
}

fn panels(h: &H, k: (usize, usize)) -> Vec<&'static str> {
    h.state().features.workspace.rows(Ws::Editing).slot_panels(k).to_vec()
}

#[test]
fn a_tab_dragged_onto_a_panel_docks_there_and_the_next_start_shows_it() {
    let dir = scratch("drag");
    let mut h = open(&dir);
    assert_eq!(panels(&h, (1, 0)), ["project", "effects", "markers", "history", "transcript"]);
    // History onto the Program monitor's right edge: a slot of its own on the right of the top row
    let program = slot_rect(&h, (0, 1));
    let to = egui::pos2(program.right() - program.width() * 0.08, program.center().y);
    let target = workspaces::dock_target(h.state(), "history", to).map(|(a, side, _)| (a, side));
    assert_eq!(target, Some(("program", Side::Right)), "the hint names the place");
    let from = tab(&h, (1, 0), "History");
    drag(&mut h, from, to);
    assert_eq!(panels(&h, (0, 2)), ["history"], "{:?}", h.state().features.workspace.rows(Ws::Editing));
    assert!(!panels(&h, (1, 0)).contains(&"history"));
    // drawn in its new place, its slot about half of the Program monitor's old width
    let r = slot_rect(&h, (0, 2));
    assert!(r.width() > program.width() * 0.35 && r.width() < program.width() * 0.65, "{r:?} of {program:?}");
    assert!(h.query_by_label("0 steps").is_some(), "the History panel is drawn");

    // Effects onto the Timeline's tabs: it joins them, and is the tab shown
    let timeline = slot_rect(&h, (1, 2));
    let from = tab(&h, (1, 0), "Effects");
    drag(&mut h, from, egui::pos2(timeline.center().x, timeline.top() + 12.0));
    assert_eq!(panels(&h, (1, 2)), ["timeline", "effects"]);

    // the arrangement is in the settings at once, and a new start shows it
    let saved = h.state().doc.settings.get(workspaces::ARRANGED).cloned().expect("written");
    assert!(saved["editing"]["rows"].is_array(), "{saved}");
    let mine = h.state().features.workspace.rows(Ws::Editing);
    drop(h);
    let h = open(&dir);
    assert_eq!(h.state().features.workspace.rows(Ws::Editing), mine);
    assert_eq!(panels(&h, (0, 2)), ["history"]);
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_closed_panel_leaves_and_the_window_menu_and_the_lower_tab_bring_it_back() {
    let dir = scratch("close");
    let mut h = open(&dir);
    // Close Panel from the Markers tab's own menu
    let at = tab(&h, (1, 0), "Markers");
    h.event(egui::Event::PointerMoved(at));
    for pressed in [true, false] {
        h.event(egui::Event::PointerButton {
            pos: at,
            button: egui::PointerButton::Secondary,
            pressed,
            modifiers: egui::Modifiers::NONE,
        });
        h.step();
    }
    h.step();
    h.get_by_label("Close Panel").click();
    h.step();
    h.step();
    assert!(!h.state().features.workspace.panels_in(Ws::Editing).contains(&"markers"));
    // the Window menu puts it back where the table has it, as the tab shown
    workspaces::show_panel(h.state_mut(), "markers");
    h.step();
    assert_eq!(panels(&h, (1, 0)), ["project", "effects", "history", "transcript", "markers"]);
    assert_eq!(h.state().lower_tab, LowerTab::Markers);

    // a panel the workspace never had goes into the slot holding Project
    workspaces::show_panel(h.state_mut(), "mixer");
    h.step();
    assert!(panels(&h, (1, 0)).contains(&"mixer"));
    assert_eq!(h.state().features.workspace.current, Ws::Editing, "the workspace stays");

    // the lower tab set by an action shows its panel wherever it went
    h.state_mut().features.workspace.current = Ws::Editing;
    let at = tab(&h, (1, 0), "History");
    let program = slot_rect(&h, (0, 1));
    drag(&mut h, at, egui::pos2(program.center().x, program.bottom() - 20.0));
    let k = h.state().features.workspace.rows(Ws::Editing).slot_of("history").expect("history is somewhere");
    let rows = h.state().features.workspace.rows(Ws::Editing);
    assert_eq!((rows.rows.len(), rows.slot_panels(k)), (3, &["history"][..]), "a row of its own under the monitors");
    h.state_mut().lower_tab = LowerTab::Project;
    h.step();
    h.state_mut().lower_tab = LowerTab::History;
    h.step();
    h.step();
    assert!(h.query_by_label("0 steps").is_some(), "the History panel is drawn in its new place");

    // every panel but one closed: the last stays
    for p in h.state().features.workspace.panels_in(Ws::Editing) {
        workspaces::close_panel(h.state_mut(), p);
    }
    h.step();
    let left: Vec<_> =
        h.state().features.workspace.panels_in(Ws::Editing).into_iter().filter(|p| *p != "tools").collect();
    assert_eq!(left.len(), 1, "{left:?}");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn named_layouts_and_the_two_resets() {
    let dir = scratch("named");
    let mut h = open(&dir);
    let table = Ws::Editing.table();
    workspaces::close_panel(h.state_mut(), "meters");
    workspaces::close_panel(h.state_mut(), "source");
    h.step();
    let mine = h.state().features.workspace.rows(Ws::Editing);
    assert_ne!(mine, table);

    // Save Layout As… through its dialog
    h.state_mut().features.workspace.naming = Some(String::new());
    h.step();
    h.step();
    h.get_by_label("Layout name");
    h.event(egui::Event::Text("Two monitors".into()));
    h.step();
    h.key_press(egui::Key::Enter);
    h.step();
    assert!(h.state().features.workspace.naming.is_none());
    let named = h.state().doc.settings.get(workspaces::NAMED).cloned().expect("written");
    assert_eq!(named[0]["name"], "Two monitors", "{named}");

    // Save Changes keeps this one for Reset to Saved Layout
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.save", &ctx);
    h.step();
    workspaces::close_panel(h.state_mut(), "history");
    h.state_mut().run_action("workspace.reset", &ctx);
    h.step();
    assert!(h.state().features.workspace.panels_in(Ws::Editing).contains(&"history"), "Reset brings back the saved");
    assert!(!h.state().features.workspace.panels_in(Ws::Editing).contains(&"source"));

    // Reset to Default Layout: the table, and Reset to Saved Layout then has nothing else to bring back
    h.state_mut().run_action("workspace.default", &ctx);
    h.step();
    assert_eq!(h.state().features.workspace.rows(Ws::Editing), table);
    h.state_mut().run_action("workspace.reset", &ctx);
    h.step();
    assert_eq!(h.state().features.workspace.rows(Ws::Editing), table);
    let saved = h.state().doc.settings.get(workspaces::SAVED).cloned().unwrap_or(json!({}));
    assert!(saved.get("editing").is_none(), "{saved}");

    // the named layout goes to another workspace too
    workspaces::set(h.state_mut(), Ws::Color);
    h.step();
    workspaces::apply_named(h.state_mut(), "Two monitors");
    h.step();
    h.step();
    let color = h.state().features.workspace.panels_in(Ws::Color);
    assert!(!color.contains(&"source") && color.contains(&"program"), "{color:?}");
    workspaces::delete_named(h.state_mut(), "Two monitors");
    assert!(h.state().features.workspace.named.is_empty());
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
