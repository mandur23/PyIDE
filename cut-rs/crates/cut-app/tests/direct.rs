//! Editing clips in place on the timeline, in the real window run headless (egui_kittest on the PC's GPU): the Type
//! tool on a track, double clicks on text, stills, names and transitions, files dropped from Explorer, the clip menu's
//! Audio Role, Automation and replacements, the keyframe lines and fade handles, transitions dragged, and the offline
//! and proxy marks on the timeline and in the Project panel. Each is driven by pointer and key events and checked in
//! the project, its undo steps and, where the picture changes, the Program monitor's pixels.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_app::state::{Panel, Tool};
use cut_app::timeline::bands;
use cut_model::{History, Id};
use cut_time::{TICKS, Ticks};
use eframe::egui::{self, Key, Modifiers, Pos2, Rect, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

type H = Harness<'static, Shell>;

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
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

/// Steps until the Program monitor has drawn the frame the project asks for (the text a frame or two later).
fn settle(h: &mut H) {
    h.step();
    let start = Instant::now();
    loop {
        h.step();
        if h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete) || start.elapsed().as_secs() > 20 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..4 {
        h.step();
        std::thread::sleep(Duration::from_millis(15));
    }
    while !h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete) && start.elapsed().as_secs() < 30 {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.step();
}

/// A scratch folder of its own for each test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-direct-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A PNG of one colour, 320 x 180.
fn png(dir: &Path, name: &str, rgb: [u8; 3]) -> PathBuf {
    let path = dir.join(name);
    image::RgbImage::from_pixel(320, 180, image::Rgb(rgb)).save(&path).unwrap();
    path
}

/// A file dropped from Explorer, as egui-winit hands it over.
#[derive(Debug)]
struct Dropped(PathBuf);

impl egui::DroppedFile for Dropped {
    fn path(&self) -> &Path {
        &self.0
    }
    fn bytes(&self) -> Result<Vec<u8>, String> {
        std::fs::read(&self.0).map_err(|e| e.to_string())
    }
}

fn drop_files(h: &mut H, files: &[&PathBuf]) {
    for f in files {
        h.input_mut().dropped_files.push(std::sync::Arc::new(Dropped((*f).clone())));
    }
    h.step();
}

/// The media entry of a file, as an import makes it.
fn entry(path: &Path) -> Json {
    cut_app::import::probe_file(path).result.expect("the file imports")
}

/// The editor on a project `build` makes, in a scratch home, 1280 x 800 in English, the playhead at `t` seconds.
fn open(dir: &Path, t: f64, build: impl FnOnce(&mut History)) -> H {
    let mut hist = cut_app::doc::fresh_history();
    build(&mut hist);
    let file = dir.join("direct.ncut");
    std::fs::write(&file, hist.serialize()).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    s.app.set_time(secs(t));
    // frames a thirtieth of a second apart, so two clicks a few frames apart are a double click
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .with_step_dt(1.0 / 30.0)
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the window gave the monitors its GPU device");
    h.state_mut().transport.set_output_gain(0.0);
    settle(&mut h);
    h
}

fn seq_id(h: &History) -> String {
    h.project().sequences[0].id.as_str().to_owned()
}

fn apply(h: &mut History, cmd: Json) -> Json {
    h.apply(&cmd).unwrap_or_else(|e| panic!("{cmd}: {}", e.message))
}

/// A solid on `track` from `at` for `len` seconds.
fn solid(h: &mut History, track: &str, at: f64, len: f64, color: &str) -> Id {
    let s = seq_id(h);
    let r = apply(
        h,
        json!({ "type": "addGenerated", "seqId": s, "opts": {
            "source": { "generator": "solid", "color": color }, "at": secs(at), "duration": secs(len), "track": track, "name": color,
        } }),
    );
    Id::new(r["id"].as_str().unwrap())
}

fn import(h: &mut History, list: Vec<Json>) -> Vec<Id> {
    let r = apply(h, json!({ "type": "importMedia", "media": list, "binId": null }));
    r["ids"].as_array().unwrap().iter().map(|v| Id::new(v.as_str().unwrap())).collect()
}

/// Places media at `at` on the tracks given -> the clip on the first of them.
fn place(h: &mut History, media: Id, at: f64, video: Option<&str>, audio: Option<&str>, out: Option<f64>) -> Id {
    let s = seq_id(h);
    let mut opts = json!({ "source": { "media": media.as_str() }, "at": secs(at), "video": video, "audio": audio, "mode": "overwrite" });
    if let Some(o) = out {
        opts["out"] = json!(secs(o));
    }
    let r = apply(h, json!({ "type": "place", "seqId": s, "opts": opts }));
    Id::new(r["ids"][0].as_str().unwrap())
}

fn lanes(h: &H) -> Rect {
    h.state().timeline.direct.lanes.expect("the timeline drew its lanes")
}

/// The screen point at `t` seconds on `track`, `k` of the way down its row.
fn pt(h: &H, t: f64, track: &str, k: f32) -> Pos2 {
    let tl = &h.state().timeline;
    let l = lanes(h);
    let r = tl.layout().rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == track)).expect("the track's row");
    pos2(l.left() + tl.view.x_of(secs(t)) as f32, l.top() + r.y - tl.view.scroll_y + r.h * k)
}

/// The screen point of the keyframe line of `clip` at `t` seconds.
fn line_pt(h: &H, clip: Id, t: f64) -> Pos2 {
    let s = h.state();
    let seq = s.app.sequence().unwrap();
    let c = seq.clip(clip).unwrap();
    let tl = &s.timeline;
    let row = tl.layout().row_of(c.track).unwrap();
    let prop = if seq.kind_of(c.track) == Some(cut_model::TrackKind::Audio) { "volume" } else { "opacity" };
    let (cy, ch) = bands::clip_box(row, &tl.view);
    let v = bands::value_at(c, prop, (secs(t) - c.start) as f64);
    let l = lanes(h);
    pos2(l.left() + tl.view.x_of(secs(t)) as f32, l.top() + bands::band_y(prop, v, cy, ch))
}

/// A press or release with the keys `m` held (the panels read the held keys, not the event's).
fn button(h: &mut H, p: Pos2, b: egui::PointerButton, pressed: bool, m: Modifiers) {
    h.event(egui::Event::ModifiersChanged(m));
    h.event(egui::Event::PointerButton { pos: p, button: b, pressed, modifiers: m });
    h.step();
    if !pressed && m != Modifiers::NONE {
        h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
        h.step();
    }
}

fn click_with(h: &mut H, p: Pos2, m: Modifiers) {
    h.hover_at(p);
    h.step();
    button(h, p, egui::PointerButton::Primary, true, m);
    button(h, p, egui::PointerButton::Primary, false, m);
    h.step();
}

fn click(h: &mut H, p: Pos2) {
    click_with(h, p, Modifiers::NONE);
}

fn double_click(h: &mut H, p: Pos2) {
    h.hover_at(p);
    h.step();
    for _ in 0..2 {
        button(h, p, egui::PointerButton::Primary, true, Modifiers::NONE);
        button(h, p, egui::PointerButton::Primary, false, Modifiers::NONE);
    }
    h.step();
    h.step();
}

fn right_click(h: &mut H, p: Pos2) {
    h.hover_at(p);
    h.step();
    button(h, p, egui::PointerButton::Secondary, true, Modifiers::NONE);
    button(h, p, egui::PointerButton::Secondary, false, Modifiers::NONE);
    h.step();
    h.step();
}

fn drag(h: &mut H, from: Pos2, to: Pos2, m: Modifiers) {
    h.hover_at(from);
    h.step();
    button(h, from, egui::PointerButton::Primary, true, m);
    for i in 1..=10 {
        h.hover_at(from + (to - from) * (i as f32 / 10.0));
        h.step();
    }
    button(h, to, egui::PointerButton::Primary, false, m);
    h.step();
}

fn key(h: &mut H, k: Key, m: Modifiers) {
    h.event(egui::Event::ModifiersChanged(m));
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: k, physical_key: None, pressed, repeat: false, modifiers: m });
        h.step();
    }
    h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
    h.step();
}

/// Clicks the open menu's item whose text holds `label` (a checked item starts with its mark).
fn menu_item(h: &mut H, label: &str) {
    let text = tr(label).into_owned();
    h.get_all_by_label_contains(&text).last().unwrap_or_else(|| panic!("the menu has {label}")).click();
    h.step();
    h.step();
}

fn steps(h: &H) -> usize {
    h.state().app.history.position()
}

fn last_label(h: &H) -> String {
    h.state().app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn clip_of(h: &H, id: Id) -> cut_model::Clip {
    h.state().app.sequence().unwrap().clip(id).unwrap_or_else(|| panic!("clip {id} is there")).clone()
}

fn undo(h: &mut H) {
    let ctx = h.ctx.clone();
    h.state_mut().run_action("undo", &ctx);
    settle(h);
}

fn redo(h: &mut H) {
    let ctx = h.ctx.clone();
    h.state_mut().run_action("redo", &ctx);
    settle(h);
}

/// The highest and the mean luma of the window over a box of sequence pixels (1920 x 1080) on the Program monitor.
fn luma(h: &mut H, x0: f64, y0: f64, x1: f64, y1: f64) -> (u8, f64) {
    h.hover_at(pos2(2.0, 790.0));
    h.step();
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    let r = h.state().monitors.as_ref().unwrap().program.rect;
    let k = f64::from(r.width()) / 1920.0;
    let at = |x: f64, y: f64| pos2(r.left() + (x * k) as f32, r.top() + (y * k) as f32);
    let (a, b) = (at(x0, y0), at(x1, y1));
    let (mut max, mut sum, mut n) = (0u8, 0.0f64, 0.0f64);
    let mut y = a.y;
    while y <= b.y {
        let mut x = a.x;
        while x <= b.x {
            let px = img.get_pixel((x * ppp).round() as u32, (y * ppp).round() as u32).0;
            let l = ((u32::from(px[0]) * 2 + u32::from(px[1]) * 5 + u32::from(px[2])) / 8) as u8;
            max = max.max(l);
            sum += f64::from(l);
            n += 1.0;
            x += 1.0;
        }
        y += 1.0;
    }
    (max, sum / n.max(1.0))
}

/// The window's pixels inside `r` (points), as RGB rows.
fn pixels(h: &mut H, r: Rect) -> Vec<[u8; 3]> {
    h.hover_at(pos2(2.0, 790.0));
    h.step();
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    let mut out = Vec::new();
    let mut y = r.top();
    while y < r.bottom() {
        let mut x = r.left();
        while x < r.right() {
            let p = img.get_pixel((x * ppp) as u32, (y * ppp) as u32).0;
            out.push([p[0], p[1], p[2]]);
            x += 1.0;
        }
        y += 1.0;
    }
    out
}

/// A picture of the window into `CUT_DIRECT_SHOTS`, when it names a folder.
fn save(h: &mut H, name: &str) {
    if let Ok(dir) = std::env::var("CUT_DIRECT_SHOTS") {
        h.render().unwrap().save(Path::new(&dir).join(format!("{name}.png"))).unwrap();
    }
}

fn text_of(h: &H, clip: Id) -> Option<String> {
    let c = clip_of(h, clip);
    cut_app::text_ui::layers(&c).first()?.get("text")?.as_str().map(str::to_owned)
}

#[test]
fn the_type_tool_on_a_video_track_makes_a_text_there_and_edits_it_in_place() {
    let dir = scratch("type");
    let mut h = open(&dir, 0.0, |_| {});
    let black = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(black.0 < 20, "the frame is black first ({black:?})");
    let before = steps(&h);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("tool.text", &ctx);
    let a1 = pt(&h, 2.0, "A1", 0.5);
    click(&mut h, a1);
    assert_eq!(h.state().app.sequence().unwrap().clips().count(), 0, "an audio track takes no text");
    assert!(h.query_by_label(&tr("Click a video track to add text.")).is_some(), "the person is told where text goes");
    let v1 = pt(&h, 2.0, "V1", 0.5);
    click(&mut h, v1);
    let clip =
        h.state().features.text.editor.as_ref().map(|e| e.clip).expect("the click made a text clip and edits it");
    let c = clip_of(&h, clip);
    assert_eq!((c.track.as_str(), c.start), ("V1", secs(2.0)), "on V1 at the frame clicked");
    assert_eq!(h.state().app.tool, Tool::Select, "the Selection tool is back");
    assert_eq!(h.state().app.t, secs(2.0), "the playhead is on the new text");
    assert!(h.state().app.selection.contains(&clip) && h.state().app.history.grouping());
    assert_eq!(text_of(&h, clip).as_deref(), Some("Title"));
    settle(&mut h);
    let title = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(title.0 > 200, "the title shows in the middle of the frame ({title:?})");
    save(&mut h, "type-tool-on-the-timeline");
    // the editor has the keyboard: select its text and type over it
    key(&mut h, Key::A, Modifiers::COMMAND);
    h.event(egui::Event::Text("OK".into()));
    settle(&mut h);
    assert_eq!(text_of(&h, clip).as_deref(), Some("OK"), "typing reaches the layer");
    key(&mut h, Key::Escape, Modifiers::NONE);
    assert!(h.state().features.text.editor.is_none(), "Escape closes the editor");
    assert_eq!((steps(&h), last_label(&h).as_str()), (before + 1, "Add Text"), "the clip and its text are one step");
    undo(&mut h);
    assert!(h.state().app.sequence().unwrap().clip(clip).is_none(), "undo takes the clip away");
    let gone = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(gone.0 < 20, "and its picture ({gone:?})");
    redo(&mut h);
    assert_eq!(text_of(&h, clip).as_deref(), Some("OK"), "redo brings back the text as typed");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_double_click_on_a_text_clip_edits_it_with_the_playhead_in_the_clip() {
    let dir = scratch("text");
    let mut clip = None;
    let mut h = open(&dir, 0.0, |hist| {
        let s = seq_id(hist);
        let layer = cut_model::defaults::text_layer(&[("text".to_owned(), json!("HELLO"))].into_iter().collect());
        let r = apply(
            hist,
            json!({ "type": "addGenerated", "seqId": s, "opts": {
                "source": { "generator": "text", "layers": [layer] }, "at": secs(3.0), "duration": secs(4.0), "track": "V1", "name": "Text",
            } }),
        );
        clip = Some(Id::new(r["id"].as_str().unwrap()));
    });
    let clip = clip.unwrap();
    let before = steps(&h);
    let p = pt(&h, 5.0, "V1", 0.7);
    double_click(&mut h, p);
    assert_eq!(h.state().features.text.editor.as_ref().map(|e| (e.clip, e.created)), Some((clip, false)));
    assert_eq!(h.state().app.t, secs(3.0), "the playhead moved into the clip");
    assert_eq!(h.state().app.focus, Some(Panel::Program), "the monitor has the keyboard");
    settle(&mut h);
    let shown = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(shown.0 > 200, "the text is on the monitor ({shown:?})");
    h.event(egui::Event::Text("!".into()));
    settle(&mut h);
    assert_eq!(text_of(&h, clip).as_deref(), Some("HELLO!"));
    key(&mut h, Key::Enter, Modifiers::CTRL);
    assert_eq!((steps(&h), last_label(&h).as_str()), (before + 1, "Edit Text"));
    undo(&mut h);
    assert_eq!(text_of(&h, clip).as_deref(), Some("HELLO"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_double_click_on_a_clips_name_renames_it_in_its_bar() {
    let dir = scratch("rename");
    let mut clip = None;
    let mut h = open(&dir, 0.0, |hist| clip = Some(solid(hist, "V1", 0.0, 6.0, "#3060c0")));
    let clip = clip.unwrap();
    let before = steps(&h);
    let name = pt(&h, 3.0, "V1", 0.0) + egui::vec2(0.0, 8.0);
    double_click(&mut h, name);
    assert!(h.state().timeline.direct.rename.is_some(), "a field over the name");
    save(&mut h, "rename-in-the-bar");
    key(&mut h, Key::A, Modifiers::CTRL);
    h.event(egui::Event::Text("Sky".into()));
    h.step();
    key(&mut h, Key::Enter, Modifiers::NONE);
    assert!(h.state().timeline.direct.rename.is_none());
    assert_eq!(clip_of(&h, clip).name, "Sky");
    assert_eq!((steps(&h), last_label(&h).as_str()), (before + 1, "Clip Settings"), "one step");
    // Escape leaves the name
    double_click(&mut h, name);
    h.event(egui::Event::Text("zzz".into()));
    h.step();
    key(&mut h, Key::Escape, Modifiers::NONE);
    assert_eq!((clip_of(&h, clip).name.as_str(), steps(&h)), ("Sky", before + 1), "Escape changes nothing");
    // the ids pictures use: the selected clip's name field and its menu
    h.state_mut().app.select([clip], false, false);
    let ctx = h.ctx.clone();
    h.step();
    h.state_mut().run_action("direct.menu", &ctx);
    for _ in 0..3 {
        h.step();
    }
    assert!(h.query_by_label_contains(&tr("Audio Role")).is_some(), "direct.menu opens the clip's menu");
    key(&mut h, Key::Escape, Modifiers::NONE);
    // Escape also deselected the clip (Deselect All)
    h.state_mut().app.select([clip], false, false);
    h.state_mut().run_action("direct.rename", &ctx);
    assert!(h.state().timeline.direct.rename.is_some(), "direct.rename opens the field");
    key(&mut h, Key::Escape, Modifiers::NONE);
    undo(&mut h);
    assert_eq!(clip_of(&h, clip).name, "#3060c0");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_double_click_on_a_still_puts_its_transform_box_on_the_program_monitor() {
    let dir = scratch("still");
    let img = png(&dir, "red.png", [220, 40, 40]);
    let mut clip = None;
    let mut h = open(&dir, 0.0, |hist| {
        let m = import(hist, vec![entry(&img)])[0];
        clip = Some(place(hist, m, 4.0, Some("V1"), None, None));
    });
    let clip = clip.unwrap();
    let monitor = h.state().monitors.as_ref().unwrap().program.rect;
    let empty = pixels(&mut h, monitor);
    let p = pt(&h, 6.0, "V1", 0.7);
    double_click(&mut h, p);
    assert_eq!(h.state().app.selection.iter().copied().collect::<Vec<_>>(), [clip], "the still alone is selected");
    assert_eq!(h.state().app.t, secs(4.0), "the playhead is in it");
    assert_eq!(h.state().app.focus, Some(Panel::Program));
    assert_eq!(cut_app::fx::overlay::shown_clip(&h.state().app).map(|c| c.id), Some(clip), "its transform box shows");
    settle(&mut h);
    let red = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(red.1 > 60.0, "the still is on the monitor ({red:?})");
    // the box's outline and handles are drawn around the picture: compare with the picture alone (deselected)
    let boxed = pixels(&mut h, monitor);
    h.state_mut().app.selection.clear();
    settle(&mut h);
    let plain = pixels(&mut h, monitor);
    let differ = boxed.iter().zip(&plain).filter(|(a, b)| a != b).count();
    assert!(differ > 200, "the transform box changes the monitor's pixels ({differ})");
    assert_ne!(empty, plain, "the still was drawn");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn files_dropped_from_explorer_on_a_track_are_imported_and_placed_in_one_step() {
    let dir = scratch("drop");
    let a = png(&dir, "green.png", [40, 200, 60]);
    let b = png(&dir, "blue.png", [40, 60, 220]);
    let mut h = open(&dir, 0.0, |hist| {
        let s = seq_id(hist);
        apply(hist, json!({ "type": "setSettings", "patch": { "stillDuration": secs(3.0) } }));
        let _ = s;
    });
    let before = steps(&h);
    let p = pt(&h, 2.0, "V2", 0.5);
    h.hover_at(p);
    h.step();
    drop_files(&mut h, &[&a, &b]);
    assert!(until(&mut h, 20, |s| s.app.sequence().unwrap().clips().count() == 2), "both files were placed");
    h.step();
    let seq = h.state().app.sequence().unwrap().clone();
    let mut clips: Vec<(String, Ticks, Ticks)> =
        seq.clips().map(|c| (c.track.as_str().to_owned(), c.start, c.end())).collect();
    clips.sort_by_key(|c| c.1);
    assert_eq!(
        clips,
        [("V2".to_owned(), secs(2.0), secs(5.0)), ("V2".to_owned(), secs(5.0), secs(8.0))],
        "placed one after the other from the drop, each the still length"
    );
    assert_eq!((steps(&h), last_label(&h).as_str()), (before + 1, "Import"), "the import and the placing are one step");
    assert_eq!(h.state().app.selection.len(), 2, "the new clips are selected");
    settle(&mut h);
    let green = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(green.1 > 80.0, "the green still plays at 2 s ({green:?})");
    // a file the project has is used as it is
    let p = pt(&h, 9.0, "V1", 0.5);
    h.hover_at(p);
    h.step();
    drop_files(&mut h, &[&a]);
    assert!(until(&mut h, 20, |s| s.app.sequence().unwrap().clips().count() == 3));
    assert_eq!(h.state().app.project().media.len(), 2, "no second copy of the media");
    undo(&mut h);
    undo(&mut h);
    assert_eq!(
        (h.state().app.project().media.len(), h.state().app.sequence().unwrap().clips().count()),
        (0, 0),
        "two undos take the drops back whole"
    );
    // dropped on the Project panel, the files are only imported
    let ctx = h.ctx.clone();
    h.state_mut().run_action("window.project", &ctx);
    h.step();
    h.hover_at(pos2(80.0, 560.0));
    h.step();
    drop_files(&mut h, &[&b]);
    assert!(until(&mut h, 20, |s| s.app.project().media.len() == 1 && s.importer.pending() == 0));
    assert_eq!(h.state().app.sequence().unwrap().clips().count(), 0, "nothing placed");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_still_takes_another_image_from_its_menu_or_the_source_monitor_keeping_its_place_and_effects() {
    // CUT_DIALOG is read from the environment: the test runs again in a process of its own that has it
    let Some(dialog) = std::env::var_os("CUT_DIALOG").map(PathBuf::from) else {
        let dir = scratch("replace");
        let white = png(&dir, "white.png", [250, 250, 250]);
        let dialog = dir.join("dialog.json");
        std::fs::write(&dialog, json!({ "pickImage": white.to_string_lossy() }).to_string()).unwrap();
        let name = "a_still_takes_another_image_from_its_menu_or_the_source_monitor_keeping_its_place_and_effects";
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env("CUT_DIALOG", &dialog)
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(status.success(), "the test in its own process passed");
        return;
    };
    let dir = dialog.parent().unwrap().join("run");
    std::fs::create_dir_all(&dir).unwrap();
    let red = png(&dir, "red.png", [220, 40, 40]);
    let blue = png(&dir, "blue.png", [40, 60, 220]);
    let mut ids = (None, None);
    let mut h = open(&dir, 1.0, |hist| {
        let m = import(hist, vec![entry(&red), entry(&blue)]);
        let c = place(hist, m[0], 0.0, Some("V1"), None, None);
        let s = seq_id(hist);
        apply(
            hist,
            json!({ "type": "addEffect", "seqId": s, "clipId": c.as_str(), "effectType": "video.blackwhite", "index": null, "params": {} }),
        );
        apply(
            hist,
            json!({ "type": "setClip", "seqId": s, "clipId": c.as_str(), "patch": { "props": { "opacity": 50 } }, "opts": {} }),
        );
        ids = (Some(c), Some(m[1]));
    });
    let (clip, blue_id) = (ids.0.unwrap(), ids.1.unwrap());
    let old = clip_of(&h, clip);
    // from the Source Monitor
    h.state_mut().app.edit.source.open(cut_app::edit::source::SourceClip::media(blue_id));
    let before = steps(&h);
    let p = pt(&h, 1.0, "V1", 0.6);
    right_click(&mut h, p);
    menu_item(&mut h, "Replace With Clip");
    save(&mut h, "clip-menu-replace");
    menu_item(&mut h, "From Source Monitor");
    let seq = h.state().app.sequence().unwrap().clone();
    let now = seq.clips().next().expect("a clip in its place").clone();
    assert_eq!(now.media_id(), Some(blue_id), "it shows the source's image");
    assert_eq!(
        (now.start, now.duration(), now.track),
        (old.start, old.duration(), old.track),
        "where and as long as it was"
    );
    assert_eq!((now.in_, now.out), (old.in_, old.out), "its In and Out kept");
    assert_eq!(now.effects.len(), 1, "its effect kept");
    assert_eq!(serde_json::to_value(&now.props).unwrap()["opacity"].as_f64(), Some(50.0), "its opacity kept");
    assert_eq!((steps(&h), last_label(&h).as_str()), (before + 1, "Replace"));
    // Replace Image… from a file (the dialog answered by CUT_DIALOG's pickImage)
    let p = pt(&h, 1.0, "V1", 0.6);
    right_click(&mut h, p);
    menu_item(&mut h, "Replace Image…");
    assert!(until(&mut h, 20, |s| s.app.project().media.len() == 3), "the picked file was imported");
    h.step();
    let now = h.state().app.sequence().unwrap().clips().next().unwrap().clone();
    let white_id = h.state().app.project().media.iter().find(|m| m.name == "white.png").unwrap().id;
    assert_eq!(now.media_id(), Some(white_id));
    assert_eq!((now.start, now.duration(), now.effects.len()), (old.start, old.duration(), 1));
    assert_eq!(
        (steps(&h), last_label(&h).as_str()),
        (before + 2, "Replace"),
        "the import and the replacement are one step"
    );
    settle(&mut h);
    let shown = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    undo(&mut h);
    let back = luma(&mut h, 760.0, 440.0, 1160.0, 640.0);
    assert!(shown.1 > back.1 + 10.0, "the white image is brighter than the blue one ({shown:?} {back:?})");
    assert_eq!(h.state().app.project().media.len(), 2, "undo takes the imported file out again");
    undo(&mut h);
    assert_eq!(h.state().app.sequence().unwrap().clips().next().unwrap().media_id(), old.media_id());
}

#[test]
fn the_clip_menu_sets_the_audio_role_and_reaches_the_automation_without_leaving_the_timeline() {
    let dir = scratch("role");
    let tone = media::tone_aac();
    let mut clip = None;
    let mut h = open(&dir, 0.0, |hist| {
        let m = import(hist, vec![entry(&tone)])[0];
        clip = Some(place(hist, m, 0.0, None, Some("A1"), Some(6.0)));
    });
    let clip = clip.unwrap();
    let p = pt(&h, 3.0, "A1", 0.3);
    right_click(&mut h, p);
    menu_item(&mut h, "Audio Role");
    save(&mut h, "clip-menu-audio-role");
    menu_item(&mut h, "Music");
    assert_eq!(clip_of(&h, clip).role, Some(cut_model::Role::Music));
    assert_eq!(last_label(&h), "Audio Role");
    undo(&mut h);
    assert_eq!(clip_of(&h, clip).role, None);
    right_click(&mut h, p);
    menu_item(&mut h, "Automation");
    assert!(h.query_by_label_contains(&tr("Auto Ducking…")).is_some(), "the Automation menu lists its items");
    save(&mut h, "clip-menu-automation");
    menu_item(&mut h, "Match Clip Loudness…");
    assert!(h.state().features.audio.loudness.open.is_some(), "Match Clip Loudness opens from the clip's menu");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn keyframes_are_added_dragged_and_removed_on_the_opacity_volume_and_speed_lines() {
    let dir = scratch("lines");
    let tone = media::tone_aac();
    let video = media::h264_720p();
    let mut ids = (None, None);
    let mut h = open(&dir, 0.0, |hist| {
        let m = import(hist, vec![entry(&tone), entry(&video)]);
        let a = place(hist, m[0], 0.0, None, Some("A1"), Some(6.0));
        let s = seq_id(hist);
        for t in ["V1", "A1"] {
            apply(hist, json!({ "type": "setTrack", "seqId": s, "trackId": t, "patch": { "height": 100 } }));
        }
        let v = place(hist, m[1], 0.0, Some("V1"), None, Some(3.0));
        ids = (Some(a), Some(v));
    });
    let (audio, video_clip) = (ids.0.unwrap(), ids.1.unwrap());
    // volume: Ctrl+click on the line adds a keyframe of its value there
    let before = steps(&h);
    let p = line_pt(&h, audio, 2.0);
    click_with(&mut h, p, Modifiers::CTRL);
    let keys = clip_of(&h, audio).keyframes.get("volume").cloned().unwrap_or_default();
    assert_eq!(keys.len(), 1, "a volume keyframe");
    assert_eq!((keys[0].t, steps(&h)), (secs(2.0), before + 1));
    let p = line_pt(&h, audio, 4.0);
    click_with(&mut h, p, Modifiers::CTRL);
    // dragging the first one down lowers the volume there
    let k = line_pt(&h, audio, 2.0);
    drag(&mut h, k, k + egui::vec2(10.0, 20.0), Modifiers::NONE);
    let keys = clip_of(&h, audio).keyframes.get("volume").cloned().unwrap();
    let cut_model::keyframes::Value::Num(v) = keys[0].v else { panic!("a number") };
    assert!(v < -3.0, "the keyframe went down ({v} dB)");
    assert!(keys[0].t > secs(2.0), "and later");
    assert_eq!((last_label(&h).as_str(), steps(&h)), ("Keyframes", before + 3), "one step for the drag");
    // its menu deletes it
    let at = cut_time::frame_start(
        cut_time::frame_at(keys[0].t, cut_time::Fps { num: 30, den: 1 }),
        cut_time::Fps { num: 30, den: 1 },
    );
    let kp = line_pt(&h, audio, at as f64 / TICKS as f64);
    right_click(&mut h, kp);
    menu_item(&mut h, "Delete Keyframe");
    assert_eq!(clip_of(&h, audio).keyframes.get("volume").map_or(0, Vec::len), 1, "the menu deleted it");
    undo(&mut h);
    assert_eq!(clip_of(&h, audio).keyframes.get("volume").map_or(0, Vec::len), 2);
    // opacity of the video clip, the same way
    let p = line_pt(&h, video_clip, 1.0);
    click_with(&mut h, p, Modifiers::CTRL);
    assert_eq!(clip_of(&h, video_clip).keyframes.get("opacity").map_or(0, Vec::len), 1, "an opacity keyframe");
    let k = line_pt(&h, video_clip, 1.0);
    drag(&mut h, k, k + egui::vec2(0.0, 30.0), Modifiers::NONE);
    let keys = clip_of(&h, video_clip).keyframes.get("opacity").cloned().unwrap();
    let cut_model::keyframes::Value::Num(op) = keys[0].v else { panic!("a number") };
    assert!(op < 80.0, "dragged down to {op}%");
    settle(&mut h);
    h.state_mut().app.set_time(secs(1.0));
    settle(&mut h);
    let dim = luma(&mut h, 0.0, 0.0, 1919.0, 1079.0);
    undo(&mut h);
    let full = luma(&mut h, 0.0, 0.0, 1919.0, 1079.0);
    eprintln!("the video at {op}% opacity: {dim:?}, at 100%: {full:?}");
    assert!(dim.1 < full.1 * 0.9, "the lower opacity darkens the picture over black ({dim:?} {full:?})");
    // the speed line: Time Remapping > Speed from the fx badge's menu, Ctrl+click adds a speed key, its menu deletes it
    let badge = pt(&h, 0.0, "V1", 0.0) + egui::vec2(9.0, 8.0);
    click(&mut h, badge);
    menu_item(&mut h, "Time Remapping");
    menu_item(&mut h, "Speed");
    assert_eq!(h.state().app.edit.band.get(&video_clip), Some(&cut_app::edit::Band::Remap), "the line shows the speed");
    let s = h.state();
    let c = clip_of(&h, video_clip);
    let row = s.timeline.layout().row_of(c.track).unwrap().clone();
    let (cy, ch) = bands::clip_box(&row, &s.timeline.view);
    let l = lanes(&h);
    let y = l.top() + bands::remap_y(100.0, cy, ch);
    let x = l.left() + s.timeline.view.x_of(secs(1.5)) as f32;
    click_with(&mut h, pos2(x, y), Modifiers::CTRL);
    let r = clip_of(&h, video_clip).remap.clone().expect("a speed key made the clip remapped");
    assert_eq!(r.keys.len(), 1, "one speed key");
    assert_eq!(last_label(&h), "Time Remapping");
    // drag the speed of the second segment up: the clip gets shorter
    let d0 = clip_of(&h, video_clip).duration();
    let x2 = l.left() + h.state().timeline.view.x_of(secs(2.5)) as f32;
    drag(&mut h, pos2(x2, y), pos2(x2, y - 20.0), Modifiers::NONE);
    assert!(clip_of(&h, video_clip).duration() < d0, "a faster second part shortens the clip");
    undo(&mut h);
    let tab = l.left() + h.state().timeline.view.x_of(clip_of(&h, video_clip).start + r.keys[0].t) as f32;
    right_click(&mut h, pos2(tab, l.top() + cy + 17.0));
    menu_item(&mut h, "Delete Keyframe");
    assert!(clip_of(&h, video_clip).remap.as_ref().is_none_or(|r| r.keys.is_empty()), "the speed key is gone");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_audio_clips_fade_handle_dragged_makes_its_fade_and_enable_toggles_from_the_keys() {
    let dir = scratch("fade");
    let tone = media::tone_aac();
    let mut clip = None;
    let mut h = open(&dir, 0.0, |hist| {
        let m = import(hist, vec![entry(&tone)])[0];
        clip = Some(place(hist, m, 0.0, None, Some("A1"), Some(6.0)));
    });
    let clip = clip.unwrap();
    // the handle at the clip's top left (shown on hover), 15 points below the clip's top
    let s = h.state();
    let c = clip_of(&h, clip);
    let row = s.timeline.layout().row_of(c.track).unwrap().clone();
    let (cy, _) = bands::clip_box(&row, &s.timeline.view);
    let l = lanes(&h);
    let handle = pos2(l.left() + s.timeline.view.x_of(0) as f32 + 1.0, l.top() + cy + 17.0);
    let one_s = s.timeline.view.px(secs(1.0)) as f32;
    let before = steps(&h);
    drag(&mut h, handle, handle + egui::vec2(one_s, 0.0), Modifiers::NONE);
    let fade = clip_of(&h, clip).fade_in;
    assert!((fade - secs(1.0)).abs() <= secs(0.1), "about a second of fade in ({fade})");
    assert_eq!((steps(&h), last_label(&h).as_str()), (before + 1, "Fade"));
    // Shift+E disables the selected clip
    key(&mut h, Key::E, Modifiers::SHIFT);
    assert!(!clip_of(&h, clip).enabled, "Shift+E disables it");
    undo(&mut h);
    assert!(clip_of(&h, clip).enabled);
    undo(&mut h);
    assert_eq!(clip_of(&h, clip).fade_in, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_transition_is_lengthened_by_its_edge_realigned_by_its_body_and_opened_by_a_double_click() {
    let dir = scratch("transition");
    let mut t = None;
    let mut h = open(&dir, 0.0, |hist| {
        solid(hist, "V1", 0.0, 5.0, "#ff0000");
        solid(hist, "V1", 5.0, 5.0, "#0000ff");
        let s = seq_id(hist);
        let r = apply(
            hist,
            json!({ "type": "addTransition", "seqId": s, "opts": { "track": "V1", "at": secs(5.0), "type": "dissolve", "align": "center", "duration": secs(1.0) } }),
        );
        t = r["id"].as_str().map(Id::new);
    });
    let t = t.unwrap_or_else(|| h.state().app.sequence().unwrap().transitions[0].id);
    let tr0 = |h: &H| h.state().app.sequence().unwrap().transitions.iter().find(|x| x.id == t).unwrap().clone();
    let view = h.state().timeline.view;
    let l = lanes(&h);
    let y = pt(&h, 5.0, "V1", 0.85).y;
    let x = |s: f64| l.left() + view.x_of(secs(s)) as f32;
    // the end handle at 5.5 s dragged half a second right: centred, so twice that longer
    drag(&mut h, pos2(x(5.5) - 1.0, y), pos2(x(6.0) - 1.0, y), Modifiers::NONE);
    let d = tr0(&h).duration;
    assert!((d - secs(2.0)).abs() <= secs(0.1), "about 2 s ({d})");
    assert_eq!(last_label(&h), "Transition Settings");
    // its body dragged a second right: it starts at the cut
    let before = steps(&h);
    drag(&mut h, pos2(x(5.0), y), pos2(x(6.0), y), Modifiers::NONE);
    assert_eq!(tr0(&h).align, cut_model::Align::Start, "Start at Cut");
    assert_eq!(steps(&h), before + 1);
    settle(&mut h);
    drag(&mut h, pos2(x(6.0), y), pos2(x(4.0), y), Modifiers::NONE);
    assert_eq!(tr0(&h).align, cut_model::Align::End, "dragged to before the cut: End at Cut");
    undo(&mut h);
    assert_eq!(tr0(&h).align, cut_model::Align::Start);
    // a double click opens it in Effect Controls
    double_click(&mut h, pos2(x(6.0), y));
    h.step();
    assert_eq!(h.state().app.edit.transition, Some(t));
    assert_eq!(h.state().app.focus, Some(Panel::Controls), "Effect Controls has it");
    assert!(h.query_by_label_contains(&tr("Alignment")).is_some(), "the transition's settings are on screen");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn offline_media_and_proxies_are_marked_on_the_timeline_and_in_the_project_panel() {
    let dir = scratch("marks");
    let gone = dir.join("gone.mp4");
    let proxy = dir.join("proxy.mp4");
    std::fs::write(&proxy, b"a proxy file").unwrap();
    let mut h = open(&dir, 0.0, |hist| {
        let fake = |path: &Path, name: &str, w: u32, codec: &str| {
            json!({ "path": path.to_string_lossy(), "name": name, "kind": "video", "duration": secs(10.0), "size": 1, "mtime": 1,
                    "video": { "w": w, "h": w * 9 / 16, "fps": [30, 1], "codec": codec }, "audio": null })
        };
        let m = import(hist, vec![fake(&gone, "gone.mp4", 1280, "avc1.64001f")])[0];
        place(hist, m, 0.0, Some("V1"), None, Some(4.0));
        let here = dir.join("here.mp4");
        std::fs::write(&here, b"not read").unwrap();
        let p = import(hist, vec![fake(&here, "here.mp4", 1280, "avc1.64001f")])[0];
        place(hist, p, 5.0, Some("V1"), None, Some(4.0));
        apply(hist, json!({ "type": "setProxy", "id": p.as_str(), "proxy": { "path": proxy.to_string_lossy() } }));
    });
    let (offline, proxied) = {
        let media = &h.state().app.project().media;
        (media[0].id, media[1].id)
    };
    // the project opened with a file missing: Relink Media lists it at once (`checkOffline`); closed as Cancel does
    assert!(
        matches!(h.state().features.prefs.screen, Some(cut_app::prefs::Screen::Relink))
            && h.state().features.prefs.relink.listed == vec![offline],
        "opening the project opens Relink Media for the missing file"
    );
    h.state_mut().features.prefs.screen = None;
    h.step();
    let marks = &h.state().timeline.direct.marks;
    assert!(marks.offline.contains(&offline) && !marks.offline.contains(&proxied), "the missing file is offline");
    assert_eq!(marks.proxies.get(&proxied), Some(&cut_app::timeline::direct::badges::ProxyMark::Ready));
    // the offline clip is red on the timeline
    let c = pt(&h, 2.0, "V1", 0.85);
    let px = pixels(&mut h, Rect::from_center_size(c, egui::vec2(4.0, 2.0)));
    assert!(px.iter().all(|p| p[0] > p[1] + 40 && p[0] > p[2] + 40), "the offline clip is drawn red ({px:?})");
    // and in the Project panel: the footer counts it, its menu offers Relink and the proxies
    let ctx = h.ctx.clone();
    h.state_mut().run_action("window.project", &ctx);
    h.step();
    h.step();
    let footer = format!("{} · {}", tr("{n} items").replace("{n}", "3"), tr("{n} offline").replace("{n}", "1"));
    assert!(h.query_by_label(&footer).is_some(), "the footer counts it");
    let row = h.get_by_label("gone.mp4").rect().center();
    right_click(&mut h, row);
    assert!(h.query_by_label(&tr("Relink Media…")).is_some(), "an offline item can be relinked");
    key(&mut h, Key::Escape, Modifiers::NONE);
    let row = h.get_by_label("here.mp4").rect().center();
    right_click(&mut h, row);
    assert!(h.query_by_label(&tr("Create Proxy Again")).is_some() && h.query_by_label(&tr("Remove Proxy")).is_some());
    menu_item(&mut h, "Remove Proxy");
    assert!(h.state().app.project().media(proxied).unwrap().proxy.is_none(), "the proxy is taken off, one step");
    assert_eq!(last_label(&h), tr("Remove Proxy"));
    h.step();
    assert!(!h.state().timeline.direct.marks.proxies.contains_key(&proxied), "and its badge");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_import_of_4k_or_hevc_video_offers_proxies_in_a_bar() {
    let dir = scratch("offer");
    let mut h = open(&dir, 0.0, |_| {});
    let big = dir.join("big.mp4");
    std::fs::write(&big, b"not read").unwrap();
    let m = json!({ "path": big.to_string_lossy(), "name": "big.mp4", "kind": "video", "duration": secs(10.0), "size": 8, "mtime": 1,
                    "video": { "w": 3840, "h": 2160, "fps": [30, 1], "codec": "hvc1.1.6.L150" }, "audio": null });
    let ctx = h.ctx.clone();
    h.state_mut().run_action("window.project", &ctx);
    h.state_mut().app.exec(&json!({ "type": "batch", "label": tr("Import"), "commands": [{ "type": "importMedia", "media": [m], "binId": null }] }));
    let media = h.state().app.project().media[0].clone();
    assert_eq!(cut_app::panels::media_marks::needs(&media), ["4k", "hevc"], "4K HEVC, and no sample table to read");
    let text = tr("{n} imported clips may play slowly ({why}). Make proxies for smooth playback?")
        .replace("{n}", "1")
        .replace("{why}", "4K, HEVC");
    let start = Instant::now();
    while h.query_by_label(&text).is_none() && start.elapsed() < Duration::from_secs(10) {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(h.query_by_label(&text).is_some(), "the bar offers proxies");
    save(&mut h, "proxy-offer-bar");
    h.get_by_label(&tr("Don't Ask for This Project")).click();
    h.step();
    h.step();
    assert!(h.query_by_label(&text).is_none(), "dismissed");
    let list = h.state().doc.settings.get("proxyDismissed").cloned().unwrap_or_default();
    assert!(list.as_array().is_some_and(|l| l.len() == 1), "the project is remembered ({list})");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_text_of_the_direct_editing_reads_in_korean() {
    let texts = [
        "Click a video track to add text.",
        "Audio Role",
        "Automation",
        "Media Offline",
        "Replace With Clip",
        "From Source Monitor",
        "Replace Image…",
        "Reveal in Project",
        "Replace",
        "Open a clip in the Source Monitor first.",
        "The source is shorter than the clip.",
        "Choose an image file.",
        "Has a proxy",
        "Proxy queued",
        "Making proxy {pct}%",
        "Proxy waits while playing",
        "Proxy file missing: the original plays",
        "The proxy could not be made: {error}",
        "{n} imported clips may play slowly ({why}). Make proxies for smooth playback?",
        "Create Proxies",
        "Don't Ask for This Project",
        "keyframes far apart",
        "Relink Media…",
        "Cancel Proxy",
        "Create Proxy Again",
        "Remove Proxy",
        "Reveal in Explorer",
        "{n} offline",
        "Offline",
        "Alignment",
        "Center at Cut",
        "Start at Cut",
        "End at Cut",
    ];
    let missing: Vec<&str> = texts.iter().copied().filter(|t| !cut_app::i18n::has_korean(t)).collect();
    assert!(missing.is_empty(), "translated: {missing:?}");
}

/// Writes the project the pictures of direct editing open (`CUT_PICTURE_DIR` names the folder): a video with a proxy,
/// a dissolve into a solid, a text, a still, an offline clip, and a tone with volume keyframes and a fade.
#[test]
#[ignore = "writes the project for the pictures of the app"]
fn write_the_pictures_project() {
    let dir = PathBuf::from(std::env::var_os("CUT_PICTURE_DIR").expect("CUT_PICTURE_DIR"));
    std::fs::create_dir_all(&dir).unwrap();
    let still = png(&dir, "still.png", [230, 150, 40]);
    let proxy = dir.join("proxy.mp4");
    std::fs::copy(media::h264_720p(), &proxy).unwrap();
    let mut hist = cut_app::doc::fresh_history();
    let s = seq_id(&hist);
    let gone = json!({ "path": dir.join("moved-away.mp4").to_string_lossy(), "name": "moved-away.mp4", "kind": "video",
        "duration": secs(10.0), "size": 1, "mtime": 1, "video": { "w": 1920, "h": 1080, "fps": [30, 1], "codec": "avc1.640028" }, "audio": null });
    let m = import(&mut hist, vec![entry(&media::h264_720p()), entry(&still), entry(&media::tone_aac()), gone]);
    for t in ["V1", "A1"] {
        apply(&mut hist, json!({ "type": "setTrack", "seqId": s, "trackId": t, "patch": { "height": 72 } }));
    }
    place(&mut hist, m[0], 0.0, Some("V1"), None, Some(3.0));
    solid(&mut hist, "V1", 3.0, 3.0, "#2050a0");
    apply(
        &mut hist,
        json!({ "type": "addTransition", "seqId": s, "opts": { "track": "V1", "at": secs(3.0), "type": "dissolve", "align": "center", "duration": secs(1.0) } }),
    );
    apply(&mut hist, json!({ "type": "setProxy", "id": m[0].as_str(), "proxy": { "path": proxy.to_string_lossy() } }));
    place(&mut hist, m[1], 6.0, Some("V1"), None, None);
    place(&mut hist, m[3], 11.0, Some("V1"), None, Some(4.0));
    let layer = cut_model::defaults::text_layer(&[("text".to_owned(), json!("Nano Studio"))].into_iter().collect());
    apply(
        &mut hist,
        json!({ "type": "addGenerated", "seqId": s, "opts": {
        "source": { "generator": "text", "layers": [layer] }, "at": secs(1.0), "duration": secs(4.0), "track": "V2", "name": "Title" } }),
    );
    let a = place(&mut hist, m[2], 0.0, None, Some("A1"), Some(8.0));
    apply(
        &mut hist,
        json!({ "type": "setKeyframes", "seqId": s, "clipId": a.as_str(), "prop": "volume", "keyframes": [
        { "t": secs(2.0), "v": 0, "ease": "linear" }, { "t": secs(4.0), "v": -18, "ease": "linear" } ] }),
    );
    apply(
        &mut hist,
        json!({ "type": "setClip", "seqId": s, "clipId": a.as_str(), "patch": { "fadeIn": secs(1.0), "role": "music" }, "opts": {} }),
    );
    std::fs::write(dir.join("direct.ncut"), hist.serialize()).unwrap();
}
