//! Panels in windows of their own: the model without a window (detach, return, remember, restore, clamp onto the
//! screens there are), then the app headless. egui_kittest has no OS windows, so egui embeds each panel's window
//! as an egui window inside the main one; what only the real app shows (OS windows, their places on the desktop,
//! the keyboard and drags between windows) is checked with the app itself.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::i18n::{self, Lang};
use cut_app::shell::Shell;
use cut_app::windows::{Layouts, Placement, PxRect, SETTING, Screen, place_on, to_window};
use cut_app::workspaces::Ws;
use cut_time::TICKS;
use eframe::egui::{self, Modifiers, PointerButton, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

fn screen(name: &str, x: i32, y: i32, w: i32, h: i32, primary: bool) -> Screen {
    Screen { name: name.into(), rect: PxRect { x, y, w, h }, scale: 1.25, primary }
}

fn place(screen: Option<&str>, x: i32, y: i32, w: i32, h: i32) -> Placement {
    Placement { screen: screen.map(str::to_owned), x, y, w, h }
}

#[test]
fn detach_return_and_remember_per_workspace() {
    let mut l = Layouts::default();
    l.detach(Ws::Editing, "program", Some(place(Some("A"), 10, 20, 800, 450)));
    l.detach(Ws::Editing, "timeline", None);
    l.detach(Ws::Editing, "tools", None);
    assert_eq!(l.open_in(Ws::Editing), vec!["program", "timeline"], "the Tools column stays");
    assert!(l.open_in(Ws::Color).is_empty(), "each workspace has its own windows");
    l.dock(Ws::Editing, "program");
    assert!(!l.is_open(Ws::Editing, "program"));
    assert_eq!(l.place(Ws::Editing, "program"), Some(&place(Some("A"), 10, 20, 800, 450)), "the place is kept");
    l.detach(Ws::Editing, "program", None);
    assert_eq!(l.place(Ws::Editing, "program").map(|p| p.w), Some(800), "and used again");
    assert!(l.moved(Ws::Editing, "program", place(Some("A"), 30, 20, 800, 450)));
    assert!(!l.moved(Ws::Editing, "program", place(Some("A"), 30, 20, 800, 450)), "no change, nothing to save");
    l.reset(Ws::Editing);
    assert!(l.open_in(Ws::Editing).is_empty());
    assert_eq!(l.place(Ws::Editing, "program"), None, "a reset forgets the places");
}

#[test]
fn the_settings_value_round_trips_and_skips_what_it_does_not_know() {
    let mut l = Layouts::default();
    l.detach(Ws::Editing, "program", Some(place(Some(r"\\.\DISPLAY2"), -5, 7, 960, 540)));
    l.detach(Ws::Audio, "mixer", None);
    l.dock(Ws::Audio, "mixer");
    let v = l.to_json();
    assert_eq!(
        v["editing"]["program"],
        json!({"open": true, "screen": r"\\.\DISPLAY2", "x": -5, "y": 7, "w": 960, "h": 540})
    );
    assert_eq!(Layouts::from_json(Some(&v)), l);
    let odd = json!({
        "editing": {"program": {"open": true, "x": 1, "y": 2, "w": 0, "h": 5}, "nope": {"open": true}},
        "nowhere": {"timeline": {"open": true}},
        "color": "not an object",
    });
    let back = Layouts::from_json(Some(&odd));
    assert_eq!(back.open_in(Ws::Editing), vec!["program"]);
    assert_eq!(back.place(Ws::Editing, "program"), None, "a zero size is no place");
    assert_eq!(Layouts::from_json(None), Layouts::default());
    assert_eq!(Layouts::from_json(Some(&json!([1, 2]))), Layouts::default());
}

#[test]
fn a_window_goes_back_to_its_screen_or_onto_one_there_is() {
    let a = screen("A", 0, 0, 1920, 1080, true);
    let b = screen("B", 1920, -200, 2560, 1440, false);
    let main = Some(PxRect { x: 100, y: 100, w: 1280, h: 800 });
    // on its own screen, at its offset there
    let p = place(Some("B"), 100, 50, 800, 600);
    assert_eq!(place_on(&p, &[a.clone(), b.clone()], main), Some(PxRect { x: 2020, y: -150, w: 800, h: 600 }));
    // its screen is gone: on the main window's screen at the same offset
    assert_eq!(place_on(&p, std::slice::from_ref(&a), main), Some(PxRect { x: 100, y: 50, w: 800, h: 600 }));
    // past the screen's edge, or bigger than it: whole on it
    let far = place(Some("B"), 2400, 1300, 800, 600);
    assert_eq!(place_on(&far, &[a.clone(), b.clone()], main), Some(PxRect { x: 3680, y: 640, w: 800, h: 600 }));
    let big = place(Some("A"), -50, -50, 4000, 3000);
    assert_eq!(place_on(&big, std::slice::from_ref(&a), main), Some(PxRect { x: 0, y: 0, w: 1920, h: 1080 }));
    // no screen known (headless): egui places it
    assert_eq!(place_on(&p, &[], main), None);
    // a placement is taken relative to the screen holding the top-left corner, else the nearest
    let at = Placement::of(PxRect { x: 2000, y: 0, w: 640, h: 360 }, &[a.clone(), b.clone()]);
    assert_eq!(at, place(Some("B"), 80, 200, 640, 360));
    let off = Placement::of(PxRect { x: -300, y: 10, w: 640, h: 360 }, &[a, b]);
    assert_eq!(off.screen.as_deref(), Some("A"));
    assert_eq!((off.x, off.y), (-300, 10));
}

/// Where winit puts a window made with logical `pos` and `size` (Windows 0.30): it makes it on the primary screen,
/// turns the position into pixels with that screen's scale, and once it is on its own screen keeps its logical size
/// at that screen's scale (`WM_DPICHANGED`).
fn winit_places(pos: egui::Pos2, size: egui::Vec2, screens: &[Screen]) -> PxRect {
    let created = screens.iter().find(|s| s.primary).unwrap().scale;
    let (x, y) = ((pos.x * created).round() as i32, (pos.y * created).round() as i32);
    let own = screens.iter().find(|s| s.rect.contains(x, y)).unwrap().scale;
    PxRect { x, y, w: (size.x * own).round() as i32, h: (size.y * own).round() as i32 }
}

#[test]
fn a_window_is_made_where_it_was_on_screens_of_any_scale() {
    let scaled = |name, x, y, w, h, primary, scale| Screen { scale, ..screen(name, x, y, w, h, primary) };
    let layouts = [
        // a 100 % laptop with a 150 % screen on its right, one at 125 % on its left above, and the mirror case
        vec![
            scaled("A", 0, 0, 1920, 1080, true, 1.0),
            scaled("B", 1920, 0, 3840, 2160, false, 1.5),
            scaled("C", -2560, -400, 2560, 1440, false, 1.25),
        ],
        vec![scaled("A", 0, 0, 2880, 1800, true, 1.75), scaled("B", -1920, 200, 1920, 1080, false, 1.0)],
        vec![scaled("A", 0, 0, 1920, 1080, true, 1.25)],
    ];
    for screens in &layouts {
        for s in screens {
            for (dx, dy, w, h) in [(0, 0, 800, 600), (137, 91, 1281, 721), (s.rect.w - 640, s.rect.h - 360, 640, 360)] {
                let r = PxRect { x: s.rect.x + dx, y: s.rect.y + dy, w, h };
                let (pos, size) = cut_app::windows::created_at(r, screens, 1.0);
                assert_eq!(winit_places(pos, size, screens), r, "{} at {dx},{dy} {w}x{h}", s.name);
            }
        }
    }
    // no screen known: the fallback scale for both
    let (pos, size) = cut_app::windows::created_at(PxRect { x: 300, y: 150, w: 600, h: 450 }, &[], 1.5);
    assert_eq!((pos, size), (pos2(200.0, 100.0), egui::vec2(400.0, 300.0)));
}

#[test]
fn a_point_of_a_panel_window_is_found_in_the_main_window_across_scales() {
    let main = PxRect { x: 100, y: 50, w: 1600, h: 1000 };
    // both at 125 %: (400 + 80, 300 + 40) points are (600, 425) pixels, (500, 375) into the main window
    assert_eq!(to_window(pos2(400.0, 300.0), pos2(80.0, 40.0), 1.25, main, 1.25), Some(pos2(400.0, 300.0)));
    // the panel window on a 100 % screen, the main window at 150 %: (650, 510) pixels, (550, 460) into it
    assert_eq!(to_window(pos2(700.0, 500.0), pos2(-50.0, 10.0), 1.0, main, 1.5), Some(pos2(550.0 / 1.5, 460.0 / 1.5)));
    // a point past the main window's edge, or off it
    assert_eq!(to_window(pos2(400.0, 300.0), pos2(2000.0, 0.0), 1.25, main, 1.25), None);
    assert_eq!(to_window(pos2(0.0, 0.0), pos2(10.0, 10.0), 1.0, main, 1.0), None);
}

#[test]
fn every_window_text_is_korean() {
    for key in ["Open in New Window", "Return to Main Window", "Return All Panels to Main Window"] {
        assert!(i18n::has_korean(key), "{key}");
    }
    assert_eq!(i18n::text_in(Lang::Ko, "Open in New Window"), "새 창으로 열기");
    assert_eq!(i18n::text_in(Lang::Ko, "Return to Main Window"), "기본 창으로 되돌리기");
    for ws in Ws::ALL {
        for p in ws.panels().into_iter().filter(|p| cut_app::windows::detachable(p)) {
            assert!(i18n::has_korean(cut_app::workspaces::panel_title(p)), "{p}");
        }
    }
}

// ---------- the app headless ----------

fn until(h: &mut Harness<'_, Shell>, secs: u64, done: impl Fn(&Shell) -> bool) -> bool {
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

fn steps(h: &mut Harness<'_, Shell>, n: usize) {
    for _ in 0..n {
        h.step();
    }
}

/// A scratch folder with a project of a white solid on V1 for 4 s, and the workspace home inside it.
fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-windows-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut hist = cut_app::doc::fresh_history();
    let seq = hist.project().sequences[0].id;
    hist.apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
        "source": { "generator": "solid", "color": "#ffffff" }, "at": 0, "duration": 4 * TICKS, "track": "V1", "name": "White",
    } }))
    .unwrap();
    std::fs::write(dir.join("white.ncut"), hist.serialize()).unwrap();
    dir
}

fn app(dir: &Path, lang: Lang) -> Harness<'static, Shell> {
    let mut s = Shell::new(Home::at(dir.join("home")));
    i18n::set_lang(lang);
    s.dialog = None;
    s.doc.open(&mut s.app, &dir.join("white.ncut"), now_ms()).unwrap();
    s.app.set_time(TICKS);
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the monitors are up");
    h.state_mut().transport.set_output_gain(0.0);
    steps(&mut h, 4);
    h
}

fn saved(dir: &Path) -> serde_json::Value {
    let text = std::fs::read_to_string(dir.join("home").join(".cut-rs").join("settings.json")).unwrap();
    serde_json::from_str::<serde_json::Value>(&text).unwrap()[SETTING].clone()
}

/// The item `label` of the menu that opened under `tab`.
fn menu_item<'h>(h: &'h Harness<'_, Shell>, label: &'h str, tab: egui::Rect) -> egui_kittest::Node<'h> {
    h.query_all_by_label(label)
        .min_by(|a, b| {
            let d = |r: egui::Rect| (r.top() - tab.bottom()).abs() + (r.left() - tab.left()).abs();
            d(a.rect()).total_cmp(&d(b.rect()))
        })
        .expect("the menu item")
}

fn open_in(h: &Harness<'_, Shell>, ws: Ws) -> Vec<&'static str> {
    h.state().features.workspace.windows.layouts.open_in(ws)
}

/// The mean luma of the rendered window over the middle of the Program monitor's picture.
fn program_luma(h: &mut Harness<'_, Shell>) -> f64 {
    let r = h.state().monitors.as_ref().unwrap().program.rect;
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    let c = r.shrink2(r.size() * 0.3);
    let (mut sum, mut n) = (0.0, 0.0);
    let mut y = c.top();
    while y < c.bottom() {
        let mut x = c.left();
        while x < c.right() {
            let px = img.get_pixel((x * ppp) as u32, (y * ppp) as u32).0;
            sum += f64::from(u32::from(px[0]) * 2 + u32::from(px[1]) * 5 + u32::from(px[2])) / 8.0;
            n += 1.0;
            x += 4.0;
        }
        y += 4.0;
    }
    sum / n
}

#[test]
fn a_panel_opens_in_a_window_is_remembered_and_comes_back() {
    let dir = folder("cycle");
    let mut h = app(&dir, Lang::En);
    h.get_by_label("Program").click_secondary();
    steps(&mut h, 2);
    h.get_by_label("Open in New Window").click();
    steps(&mut h, 4);
    assert_eq!(open_in(&h, Ws::Editing), vec!["program"]);
    assert!(h.query_by_label("Program - Nano Studio Cut").is_some(), "the window, titled after its panel");
    assert!(h.query_by_label("Program is in its own window.").is_some(), "its place in the main window says where");
    assert_eq!(saved(&dir)["editing"]["program"]["open"], json!(true));
    // the monitor draws in the window, on the window's GPU
    assert!(until(&mut h, 20, |s| s.monitors.as_ref().is_some_and(|m| m.program.stats.complete)));
    steps(&mut h, 2);
    let win = h.get_by_label("Program - Nano Studio Cut").rect();
    let pic = h.state().monitors.as_ref().unwrap().program.rect;
    assert!(pic.width() > 100.0 && win.left() <= pic.left() && pic.top() > win.top(), "the picture is in the window");
    assert!(program_luma(&mut h) > 200.0, "the white solid is shown there");
    drop(h);

    // a restart opens it again
    let mut h = app(&dir, Lang::En);
    assert_eq!(open_in(&h, Ws::Editing), vec!["program"]);
    assert!(h.query_by_label("Program - Nano Studio Cut").is_some());
    // its tab's menu brings it back (the other such button is the one in its docked place)
    let tab = h.get_by_label("Program").rect();
    h.get_by_label("Program").click_secondary();
    steps(&mut h, 2);
    menu_item(&h, "Return to Main Window", tab).click();
    steps(&mut h, 4);
    assert!(open_in(&h, Ws::Editing).is_empty());
    assert!(h.query_by_label("Program - Nano Studio Cut").is_none());
    assert!(h.query_by_label("Program is in its own window.").is_none());
    assert_eq!(saved(&dir)["editing"]["program"]["open"], json!(false));
}

#[test]
fn workspaces_keep_their_own_windows_and_a_reset_brings_them_back() {
    let dir = folder("workspaces");
    let mut h = app(&dir, Lang::En);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("window.detach.timeline", &ctx);
    steps(&mut h, 3);
    assert!(h.query_by_label("Timeline - Nano Studio Cut").is_some());
    h.state_mut().run_action("workspace.color", &ctx);
    steps(&mut h, 3);
    assert!(h.query_by_label("Timeline - Nano Studio Cut").is_none(), "Color docks its own timeline");
    h.state_mut().run_action("window.detach.scopes", &ctx);
    steps(&mut h, 3);
    assert!(h.query_by_label("Lumetri Scopes - Nano Studio Cut").is_some());
    assert_eq!(open_in(&h, Ws::Color), vec!["scopes"]);
    h.state_mut().run_action("workspace.editing", &ctx);
    steps(&mut h, 3);
    assert!(h.query_by_label("Timeline - Nano Studio Cut").is_some(), "back to Editing, its window is back");
    assert!(h.query_by_label("Lumetri Scopes - Nano Studio Cut").is_none());
    h.state_mut().run_action("workspace.reset", &ctx);
    steps(&mut h, 3);
    assert!(open_in(&h, Ws::Editing).is_empty() && h.query_by_label("Timeline - Nano Studio Cut").is_none());
    assert_eq!(open_in(&h, Ws::Color), vec!["scopes"], "a reset is of the workspace shown");
    assert!(saved(&dir).get("editing").is_none());
    // the Window menu's entry for all of them
    h.state_mut().run_action("workspace.color", &ctx);
    steps(&mut h, 2);
    assert!(h.state().action_enabled("window.dockAll"));
    h.state_mut().run_action("window.dockAll", &ctx);
    steps(&mut h, 3);
    assert!(open_in(&h, Ws::Color).is_empty());
    assert!(!h.state().action_enabled("window.dockAll"));
    assert!(!h.state().action_enabled("window.detach.tools"));
    assert!(!h.state().action_enabled("window.detach.mixer"), "no Audio Track Mixer in Color");
}

#[test]
fn a_tab_dragged_out_of_the_window_opens_its_panel_in_one() {
    let dir = folder("drag");
    let mut h = app(&dir, Lang::En);
    let tab = h.get_by_label("Timeline").rect().center();
    h.hover_at(tab);
    h.step();
    let press = |pressed, pos| egui::Event::PointerButton {
        pos,
        button: PointerButton::Primary,
        pressed,
        modifiers: Modifiers::NONE,
    };
    h.event(press(true, tab));
    h.step();
    for p in [tab + egui::vec2(20.0, -20.0), pos2(600.0, -40.0), pos2(400.0, -80.0)] {
        h.hover_at(p);
        h.step();
    }
    h.event(press(false, pos2(400.0, -80.0)));
    steps(&mut h, 4);
    assert_eq!(open_in(&h, Ws::Editing), vec!["timeline"]);
    // a tab dragged within the window does nothing
    let tab = h.query_all_by_label("Project").next().expect("the Project tab").rect().center();
    h.hover_at(tab);
    h.step();
    h.event(press(true, tab));
    h.step();
    h.hover_at(tab + egui::vec2(120.0, 60.0));
    h.step();
    h.event(press(false, tab + egui::vec2(120.0, 60.0)));
    steps(&mut h, 3);
    assert_eq!(open_in(&h, Ws::Editing), vec!["timeline"]);
}

/// The main window's half of a drag from a panel's window: the window hands over the payload and the point, the
/// panel window's own pass drops the payload when the button comes up, the main window's next pass gets the pointer
/// and the release through the relay's egui plugin, and the Timeline places the media. (The panel window's half,
/// the pointer outside its window while Windows holds the mouse for it, is only in the real app.)
#[test]
fn a_drag_relayed_from_a_panel_window_drops_on_the_main_timeline() {
    let dir = folder("relay");
    let mut h = app(&dir, Lang::En);
    h.state_mut().import_paths(vec![media::fixture("images/sample.png")], None);
    assert!(until(&mut h, 20, |s| !s.app.project().media.is_empty()), "the still is imported");
    let id = h.state().app.project().media[0].id;
    let clips = |h: &Harness<'_, Shell>| {
        let seq = h.state().app.sequence().unwrap();
        seq.clips_in_order()
            .filter(|c| matches!(c.source, cut_model::Source::Media { media, .. } if media == id))
            .count()
    };
    assert_eq!(clips(&h), 0);
    let lane = h.query_all_by_label("V1").map(|n| n.rect().center().y).fold(0.0f32, f32::max);
    let at = pos2(1100.0, lane);
    let ctx = h.ctx.clone();
    egui::DragAndDrop::set_payload(&ctx, cut_app::state::MediaDrag(vec![id]));
    cut_app::windows::relay::relay_drop(h.state_mut(), &ctx, egui::ViewportId::ROOT, at, true, Modifiers::NONE);
    egui::DragAndDrop::clear_payload(&ctx);
    steps(&mut h, 2);
    assert_eq!(clips(&h), 1, "the still is on the timeline");
    assert!(!egui::DragAndDrop::has_any_payload(&ctx), "the drop took the payload");
    assert_eq!(ctx.input(|i| i.pointer.latest_pos()), None, "the pass after, the relayed pointer left");
}

/// A drag from the main window over a panel's window goes to that window's input alone, and leaves it after.
#[test]
fn a_relayed_drag_reaches_only_the_window_it_is_over() {
    let dir = folder("relay-in");
    let mut h = app(&dir, Lang::En);
    let ctx = h.ctx.clone();
    let timeline = cut_app::windows::view::viewport_of("timeline");
    let hook = |h: &mut Harness<'_, Shell>, id| {
        let mut raw = egui::RawInput { viewport_id: id, ..Default::default() };
        h.state().features.workspace.windows.relays.hook(&ctx, &mut raw);
        raw.events
    };
    egui::DragAndDrop::set_payload(&ctx, cut_app::state::MediaDrag(vec![]));
    let at = pos2(300.0, 120.0);
    cut_app::windows::relay::relay_drop(h.state_mut(), &ctx, timeline, at, false, Modifiers::NONE);
    assert!(hook(&mut h, egui::ViewportId::ROOT).is_empty(), "the main window gets nothing");
    assert_eq!(hook(&mut h, timeline), vec![egui::Event::PointerMoved(at)], "the Timeline's window gets the pointer");
    cut_app::windows::relay::relay_drop(h.state_mut(), &ctx, timeline, at, true, Modifiers::CTRL);
    egui::DragAndDrop::clear_payload(&ctx);
    let events = hook(&mut h, timeline);
    assert!(events.contains(&egui::Event::PointerButton {
        pos: at,
        button: PointerButton::Primary,
        pressed: false,
        modifiers: Modifiers::CTRL
    }));
    assert!(egui::DragAndDrop::has_any_payload(&ctx), "the payload is back for the drop");
    assert_eq!(hook(&mut h, timeline)[0], egui::Event::PointerGone, "then the pointer leaves it");
    assert!(hook(&mut h, timeline).is_empty());
}

#[test]
fn the_menus_speak_korean() {
    let dir = folder("korean");
    let mut h = app(&dir, Lang::Ko);
    h.get_by_label("프로그램").click_secondary();
    steps(&mut h, 2);
    h.get_by_label("새 창으로 열기").click();
    steps(&mut h, 4);
    assert!(h.query_by_label("프로그램 - Nano Studio Cut").is_some());
    assert!(h.query_by_label("프로그램 패널은 별도 창에 있습니다.").is_some());
    let tab = h.get_by_label("프로그램").rect();
    h.get_by_label("프로그램").click_secondary();
    steps(&mut h, 2);
    menu_item(&h, "기본 창으로 되돌리기", tab).click();
    steps(&mut h, 4);
    assert!(open_in(&h, Ws::Editing).is_empty());
}
