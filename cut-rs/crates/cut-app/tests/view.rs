//! Views of the whole window and of playback (`cut_app::view`), in the real window run headless: Play In to Out and
//! Loop (`ui-monitors.js` `stopAt`, `loop`), a frame maximized and restored (`ui-shell.js` `toggleMaximize`),
//! full-screen playback, and Find Action.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_app::state::Panel;
use cut_app::workspaces::Ws;
use cut_model::History;
use cut_time::{TICKS, Ticks, frame_start};
use eframe::egui::{self, Key, Modifiers};
use egui_kittest::Harness;
use serde_json::json;

type H = Harness<'static, Shell>;

const CHECK: egui::accesskit::Role = egui::accesskit::Role::CheckBox;
const BUTTON: egui::accesskit::Role = egui::accesskit::Role::Button;

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-view-{name}-{}", std::process::id()));
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

/// The editor on a sequence with one white solid of `len` seconds, in English, 1280 x 800.
fn open(dir: &Path, len: f64) -> H {
    let mut hist: History = cut_app::doc::fresh_history();
    let seq = hist.project().sequences[0].id.as_str().to_owned();
    hist.apply(&json!({ "type": "addGenerated", "seqId": seq, "opts": {
        "source": { "generator": "solid", "color": "#ffffff" }, "at": 0, "duration": secs(len), "track": "V1", "name": "white",
    } }))
    .unwrap_or_else(|e| panic!("{}", e.message));
    let file = dir.join("view.ncut");
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
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the window gave the monitors its GPU device");
    h.state_mut().transport.set_output_gain(0.0);
    for _ in 0..3 {
        h.step();
    }
    h
}

fn act(h: &mut H, id: &str) {
    let ctx = h.ctx.clone();
    h.state_mut().run_action(id, &ctx);
    h.step();
}

fn key(h: &mut H, key: Key) {
    h.key_press_modifiers(Modifiers::NONE, key);
    h.step();
}

#[test]
fn play_in_to_out_stops_at_the_out_point_and_loop_starts_over() {
    let dir = scratch("inout");
    let mut h = open(&dir, 6.0);
    let fps = h.state().app.sequence().unwrap().fps;
    let frame = frame_start(1, fps);
    h.state_mut().app.set_in_out(Some(Some(secs(1.0))), Some(Some(secs(1.5))));
    h.state_mut().app.set_time(secs(4.0));

    act(&mut h, "playInToOut");
    assert!(h.state().transport.playing(), "it plays");
    assert_eq!(h.state().features.view.stop_at, Some(secs(1.5)));
    let mut seen = Vec::new();
    let start = Instant::now();
    while h.state().transport.playing() && start.elapsed() < Duration::from_secs(10) {
        h.step();
        seen.push(h.state().app.t);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!h.state().transport.playing(), "playback stopped by itself");
    assert_eq!(h.state().app.t, secs(1.5) - frame, "on the last frame before the Out point");
    assert!(seen.iter().all(|t| (secs(1.0)..secs(1.5)).contains(t)), "never outside In..Out: {seen:?}");
    h.step();
    assert_eq!(h.state().features.view.stop_at, None, "the stop point ends with the run");

    // Loop: the same run starts over at the In point instead of stopping
    h.state_mut().features.view.looping = true;
    act(&mut h, "playInToOut");
    let (mut wrapped, mut last) = (0, h.state().app.t);
    let start = Instant::now();
    while wrapped < 2 && start.elapsed() < Duration::from_secs(15) {
        h.step();
        let t = h.state().app.t;
        if t < last {
            wrapped += 1;
            assert!(t < secs(1.0) + 6 * frame, "it starts over at the In point, was at {t}");
        }
        assert!((secs(1.0)..secs(1.5)).contains(&t), "inside In..Out while looping: {t}");
        last = t;
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(wrapped, 2, "it went round twice");
    assert!(h.state().transport.playing(), "and is still playing");
    act(&mut h, "playPause");
    assert!(!h.state().transport.playing());

    // a plain play runs to the sequence's end again
    h.state_mut().features.view.looping = false;
    h.state_mut().app.set_time(secs(5.7));
    act(&mut h, "playPause");
    assert!(until(&mut h, 10, |s| !s.transport.playing()), "it stops at the end");
    assert_eq!(h.state().app.t, secs(6.0) - frame);
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_frame_fills_the_workspace_and_the_program_fills_the_screen() {
    let dir = scratch("max");
    let mut h = open(&dir, 3.0);
    let timeline = (Ws::Editing, (1, 2));
    let rect = |h: &H, k| h.state().features.view.slots[&k];
    let docked = rect(&h, timeline);
    assert!(docked.width() < 1000.0 && docked.height() < 500.0, "the Timeline in its place: {docked:?}");

    h.state_mut().focus(Panel::Timeline);
    act(&mut h, "maximizePanel");
    h.step();
    assert_eq!(h.state().features.view.maximized, Some(timeline));
    let big = rect(&h, timeline);
    assert!(big.width() > 1250.0 && big.height() > 650.0, "the Timeline fills the workspace: {big:?}");
    // the menu bar, the top bar and the status bar stay
    assert!(big.top() > 40.0 && big.bottom() < 790.0, "{big:?}");
    act(&mut h, "maximizePanel");
    h.step();
    assert_eq!(h.state().features.view.maximized, None);
    assert_eq!(rect(&h, timeline), docked, "restored to the same place");

    // the frame under the pointer, whatever has the keyboard
    let program = (Ws::Editing, (0, 1));
    h.hover_at(rect(&h, program).center());
    h.step();
    act(&mut h, "maximizeUnderCursor");
    assert_eq!(h.state().features.view.maximized, Some(program));
    // another workspace is not maximized
    act(&mut h, "workspace.color");
    h.step();
    assert_eq!(h.state().features.view.maximized, None);
    act(&mut h, "workspace.editing");
    // the Tools column cannot be maximized
    h.state_mut().focus(Panel::Tools);
    act(&mut h, "maximizePanel");
    assert_eq!(h.state().features.view.maximized, None);

    // full screen: the picture alone, on the whole window; Escape leaves it
    act(&mut h, "fullscreen");
    assert!(until(&mut h, 20, |s| s.monitors.as_ref().is_some_and(|m| m.program.rect.height() > 700.0)), "the picture");
    let pic = h.state().monitors.as_ref().unwrap().program.rect;
    assert!(pic.width() > 1200.0 && pic.top() < 45.0, "over the menu bar's place too: {pic:?}");
    key(&mut h, Key::Escape);
    assert!(!h.state().features.view.fullscreen);
    h.step();
    assert!(h.state().monitors.as_ref().unwrap().program.rect.height() < 500.0, "back in its panel");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Full screen with the Program monitor in a window of its own: that window goes full screen, the main window keeps
/// its panels.
#[test]
fn full_screen_takes_the_program_monitors_own_window() {
    use egui_kittest::kittest::Queryable;
    let dir = scratch("fullscreen-window");
    let mut h = open(&dir, 3.0);
    act(&mut h, "window.detach.program");
    h.step();
    assert!(cut_app::windows::view::in_window(h.state(), "program"));
    act(&mut h, "fullscreen");
    h.step();
    let v = &h.state().features.view;
    assert!(v.fullscreen);
    assert_eq!(v.fullscreen_in, cut_app::windows::view::viewport_of("program"), "the monitor's own window");
    assert!(h.query_by_label("File").is_some(), "the main window still shows its menus and panels");
    assert!(h.state().timeline.direct.lanes.is_some());
    key(&mut h, Key::Escape);
    assert!(!h.state().features.view.fullscreen, "Escape leaves it");
    // docked again, it is the main window's
    act(&mut h, "window.detach.program");
    h.step();
    act(&mut h, "fullscreen");
    h.step();
    assert_eq!(h.state().features.view.fullscreen_in, egui::ViewportId::ROOT);
    assert!(h.query_by_label("File").is_none(), "the picture alone on the main window");
    key(&mut h, Key::Escape);
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn find_action_runs_the_action_chosen() {
    let dir = scratch("find");
    let mut h = open(&dir, 3.0);
    let markers = |h: &H| h.state().app.sequence().unwrap().markers.len();
    h.state_mut().app.set_time(secs(1.0));
    act(&mut h, "findAction");
    h.step();
    assert!(h.state().features.view.find.is_some());
    // while it is open the editor's own keys wait: M adds no marker
    h.event(egui::Event::Text("add mark".into()));
    h.step();
    h.step();
    assert_eq!(h.state().features.view.find.as_ref().unwrap().query, "add mark");
    assert_eq!(markers(&h), 0);
    assert_eq!(cut_app::view::found("add mark").first().map(|a| a.id), Some("addMarker"));
    key(&mut h, Key::Enter);
    assert!(h.state().features.view.find.is_none(), "it closes");
    assert_eq!(markers(&h), 1, "and Add Marker ran");

    act(&mut h, "findAction");
    h.step();
    key(&mut h, Key::Escape);
    assert!(h.state().features.view.find.is_none(), "Escape closes it");
    assert_eq!(markers(&h), 1);
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn zoom_unused_media_and_a_saved_workspace() {
    use egui_kittest::kittest::Queryable;
    let dir = scratch("more");
    let mut h = open(&dir, 3.0);
    // the Program monitor's zoom: 100 % shows the picture's own pixels, cut at the panel
    let fitted = h.state().monitors.as_ref().unwrap().program.rect;
    assert!(fitted.width() < 800.0, "fitted into the panel: {fitted:?}");
    h.state_mut().features.view.zoom = Some(1.0);
    h.step();
    h.step();
    let ppp = h.ctx.pixels_per_point();
    let full = h.state().monitors.as_ref().unwrap().program.rect;
    assert!((full.width() - 1920.0 / ppp).abs() < 1.0, "1920 picture pixels across: {full:?}");
    assert!(full.center().distance(fitted.center()) < 1.0, "its middle stays in the middle (on the pixel grid)");
    h.state_mut().features.view.zoom = None;
    h.step();

    // Select Unused Media: the unused media of the whole project, here none, until Show All
    act(&mut h, "selectUnused");
    h.step();
    assert!(h.query_by_label("Unused media in the whole project").is_some());
    assert!(h.query_by_label("Every media item is used.").is_some());
    h.get_by_label("Show All").click();
    h.step();
    h.step();
    assert!(h.query_by_label("Unused media in the whole project").is_none());

    // Save Changes to This Workspace keeps the splitters as they are
    let lower = h.state().features.workspace.size(Ws::Editing, "lower").expect("the lower row was drawn");
    act(&mut h, "workspace.save");
    let saved = h.state().doc.settings.get(cut_app::workspaces::SAVED).cloned().expect("written to the settings");
    assert_eq!(saved["editing"]["sizes"]["lower"].as_f64().map(|v| v as f32), Some(lower));
    assert!(saved["editing"]["sizes"]["source"].is_number() && saved["editing"]["sizes"]["project"].is_number());
    assert!(saved.get("color").is_none(), "only the workspace shown");
    // and a new start reads it back
    let mut again = cut_app::workspaces::Workspaces::default();
    again.load_saved(Some(&saved));
    assert_eq!(again.saved_size(Ws::Editing, "lower"), Some(lower));

    // it keeps each slot's active tab too, which a start and Reset to Saved Layout show again
    h.state_mut().lower_tab = cut_app::shell::LowerTab::History;
    act(&mut h, "window.controls");
    act(&mut h, "workspace.save");
    let saved = h.state().doc.settings.get(cut_app::workspaces::SAVED).cloned().unwrap();
    assert_eq!(saved["editing"]["tabs"]["1.0"], "history", "{saved}");
    assert_eq!(saved["editing"]["tabs"]["0.0"], "controls");
    act(&mut h, "window.project");
    assert_eq!(h.state().lower_tab, cut_app::shell::LowerTab::Project);
    act(&mut h, "workspace.reset");
    h.step();
    assert_eq!(h.state().lower_tab, cut_app::shell::LowerTab::History, "Reset shows the saved tab");
    assert!(h.query_by_label("0 steps").is_some(), "the History panel is drawn");
    let mut again = cut_app::workspaces::Workspaces::default();
    again.load_saved(Some(&saved));
    assert_eq!(again.saved_tab(Ws::Editing, (0, 0)), Some("controls"), "and a new start");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_button_editor_chooses_the_program_monitors_buttons() {
    use cut_app::panels::bar::{Monitor, available, open_editor, shown_buttons};
    use egui_kittest::kittest::Queryable;
    let dir = scratch("buttons");
    let mut h = open(&dir, 3.0);
    let program = Monitor::Program;
    assert_eq!(shown_buttons(h.state(), program), program.defaults(), "Premiere's bar to begin with");
    assert!(!available(program).contains(&"insert"), "Insert is the Source monitor's");
    open_editor(h.state_mut(), program);
    h.step();
    h.step();
    h.get_by_label("Choose the buttons under the picture.");
    h.get_by_role_and_label(CHECK, "Loop").click();
    h.get_by_role_and_label(CHECK, "Play In to Out").click();
    h.get_by_role_and_label(CHECK, "Lift").click();
    h.step();
    h.get_by_label("OK").click();
    h.step();
    h.step();
    assert!(h.state().features.view.buttons.is_none(), "OK closes it");
    let shown = shown_buttons(h.state(), program);
    assert!(shown.contains(&"loop") && shown.contains(&"playInToOut") && !shown.contains(&"lift"), "{shown:?}");
    let at = |id: &str| shown.iter().position(|x| *x == id).unwrap();
    assert!(at("goOut") < at("playInToOut") && at("playInToOut") < at("loop"), "in the bar's own order");
    assert!(h.state().doc.settings.get(program.setting()).is_some_and(|v| v.is_array()), "kept in the settings");
    assert_eq!(shown_buttons(h.state(), Monitor::Source), Monitor::Source.defaults(), "the Source bar is its own");

    // the bar's Loop button, clicked: the Program monitor loops
    assert!(!h.state().features.view.looping);
    h.get_by_role_and_label(BUTTON, "Loop").click();
    h.step();
    assert!(h.state().features.view.looping, "the Loop button toggles looping");

    // Reset Layout ticks the default set again; Play cannot be taken away
    let none = |h: &mut H| {
        let boxes = available(program).into_iter().map(|id| (id, false)).collect();
        h.state_mut().features.view.buttons = Some((program, boxes));
        h.step();
        h.step();
    };
    none(&mut h);
    h.get_by_label("OK").click();
    h.step();
    h.step();
    assert_eq!(shown_buttons(h.state(), program), ["playPause"]);
    none(&mut h);
    h.get_by_label("Reset Layout").click();
    h.step();
    h.get_by_label("OK").click();
    h.step();
    h.step();
    assert_eq!(shown_buttons(h.state(), program), program.defaults());
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The Source monitor's bar from the same table: its own choice of buttons, Loop and Play In to Out on its own
/// clock, its zoom, and Export Frame writing the frame it shows.
#[test]
fn the_source_monitors_bar_zoom_loop_and_export_frame() {
    use cut_app::edit::source::SourceClip;
    use cut_app::edit::source_frame::Saving;
    use cut_app::panels::bar::{Monitor, available, open_editor, shown_buttons};
    use egui_kittest::kittest::Queryable;
    let dir = scratch("source-bar");
    let mut h = open(&dir, 3.0);
    let file = media::h264_720p();
    let r = h.state_mut().app.exec(&json!({ "type": "importMedia", "binId": null, "media": [{
        "path": file.to_string_lossy(), "name": "h264-720p.mp4", "kind": "video", "duration": 3 * TICKS,
        "video": { "w": 1280, "h": 720, "fps": [30, 1] } }] }));
    let id = cut_model::Id::new(r.unwrap()["ids"][0].as_str().unwrap());
    h.state_mut().app.edit.source.open(SourceClip::media(id));
    assert!(until(&mut h, 20, |s| s.monitors.as_ref().is_some_and(|m| m.source.rect.width() > 10.0)), "the picture");
    let source = Monitor::Source;
    let list = available(source);
    assert!(list.contains(&"insert") && list.contains(&"overwrite") && !list.contains(&"addMarker"), "{list:?}");

    // the Button Editor of this bar: Loop and Play In to Out added, Insert taken away
    open_editor(h.state_mut(), source);
    h.step();
    h.step();
    h.get_by_role_and_label(CHECK, "Loop").click();
    h.get_by_role_and_label(CHECK, "Play In to Out").click();
    h.get_by_role_and_label(CHECK, "Insert").click();
    h.step();
    h.get_by_label("OK").click();
    h.step();
    h.step();
    let shown = shown_buttons(h.state(), source);
    assert!(shown.contains(&"loop") && shown.contains(&"playInToOut") && !shown.contains(&"insert"), "{shown:?}");
    assert_eq!(shown_buttons(h.state(), Monitor::Program), Monitor::Program.defaults(), "the Program bar is unchanged");

    // Play In to Out on the source's own clock, then Loop clicked on its bar: it goes round instead of stopping
    if let Some(c) = h.state_mut().app.edit.source.clip.as_mut() {
        c.in_ = Some(secs(0.5));
        c.out = Some(secs(1.0));
    }
    h.get_by_role_and_label(BUTTON, "Play In to Out").click();
    h.step();
    assert!(h.state().app.edit.source.playing(), "the source plays");
    let t = |h: &H| h.state().app.edit.source.clip.unwrap().t;
    assert!(until(&mut h, 10, |s| !s.app.edit.source.playing()), "and stops by itself");
    let frame = frame_start(1, cut_time::Fps { num: 30, den: 1 });
    assert_eq!(t(&h), secs(1.0) - frame, "on the last frame before its Out point");
    assert_eq!(h.state().app.t, 0, "the sequence's playhead never moved");
    h.get_by_role_and_label(BUTTON, "Loop").click();
    h.step();
    assert!(h.state().app.edit.source.looping);
    h.get_by_role_and_label(BUTTON, "Play In to Out").click();
    let (mut wrapped, mut last) = (0, t(&h));
    let start = Instant::now();
    while wrapped < 2 && start.elapsed() < Duration::from_secs(15) {
        h.step();
        let now = t(&h);
        wrapped += usize::from(now < last);
        assert!((secs(0.5)..secs(1.0)).contains(&now), "inside In..Out while looping: {now}");
        last = now;
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(wrapped, 2, "it went round twice");
    act(&mut h, "window.source");
    h.state_mut().app.edit.source.pause();

    // its zoom: 100 % shows the file's own pixels
    let fitted = h.state().monitors.as_ref().unwrap().source.rect;
    h.state_mut().features.view.source_zoom = Some(1.0);
    h.step();
    h.step();
    let full = h.state().monitors.as_ref().unwrap().source.rect;
    let ppp = h.ctx.pixels_per_point();
    assert!((full.width() - 1280.0 / ppp).abs() < 1.0, "1280 picture pixels across: {full:?} (fitted {fitted:?})");
    assert!(
        full.center().distance(fitted.center()) < 2.0,
        "its middle stays in the middle (to the pixel grid): {full:?} {fitted:?}"
    );

    // Export Frame: the frame the Source monitor shows, as a PNG of the file's size
    let png = dir.join("source frame.png");
    let (tx, rx) = std::sync::mpsc::channel();
    tx.send(Some(png.clone())).unwrap();
    h.state_mut().app.edit.source.saving = Saving::Picking(cut_app::edit::source::SourceItem::Media(id), secs(0.5), rx);
    assert!(until(&mut h, 20, |_| png.is_file()), "the file is written");
    let img = image::open(&png).expect("a PNG").to_rgba8();
    assert_eq!((img.width(), img.height()), (1280, 720));
    assert_eq!(media::number_in(img.as_raw(), 1280, 720), 15, "frame 15 of the file (0.5 s at 30 fps)");
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
