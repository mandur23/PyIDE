//! The Program monitor's handles in the real window, run headless (egui_kittest on wgpu) with pointer events on the
//! monitor: dragging the box moves the picture, a corner grows it; an ellipse mask cuts the picture to it and a
//! dragged vertex takes the coverage along; the pen draws a mask; the Lumetri eyedropper reads the monitor's pixel.
//! Each assertion reads the window's own pixels where the monitor drew the picture.

#[path = "../examples/demo_project.rs"]
mod demo;

use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::fx::overlay::{self, Shape};
use cut_app::fx::{Pick, PickKind, color::Dropper};
use cut_app::shell::Shell;
use cut_model::Id;
use cut_time::TICKS;
use eframe::egui::{self, Pos2, pos2};
use egui_kittest::Harness;
use serde_json::json;

/// A 1920 x 1080 sequence with a white solid on V1 for four seconds at `scale` percent, selected, the playhead at 1 s.
fn open(name: &str, scale: f64) -> (Harness<'static, Shell>, Id) {
    let mut h = cut_app::doc::fresh_history();
    let seq = h.project().sequences[0].id;
    h.apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
        "source": { "generator": "solid", "color": "#ffffff" }, "at": 0, "duration": 4 * TICKS, "track": "V1", "name": "White",
    } }))
    .expect("the solid");
    let clip = h.project().sequences[0].clips().next().map(|c| c.id).expect("a clip");
    h.apply(&cut_model::commands::build::set_clip(
        seq.as_str(),
        clip.as_str(),
        json!({ "props": { "scale": [scale, scale] } }),
        json!({}),
    ))
    .expect("the scale");
    let dir = std::env::temp_dir().join(format!("cut-app-fx-overlay-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("overlay.ncut");
    std::fs::write(&file, h.serialize()).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    s.app.select([clip], false, false);
    s.app.set_time(TICKS);
    let mut harness = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .wgpu_setup(demo::media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while harness.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        harness.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(harness.state().monitors.is_some(), "the window gave the monitors its GPU device");
    harness.state_mut().transport.set_output_gain(0.0);
    settle(&mut harness);
    (harness, clip)
}

fn settle(h: &mut Harness<'_, Shell>) {
    let start = Instant::now();
    loop {
        h.step();
        if h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete) || start.elapsed().as_secs() > 20 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    h.step();
    h.step();
}

/// The screen point (points) of a sequence pixel.
fn at(h: &Harness<'_, Shell>, x: f64, y: f64) -> Pos2 {
    let r = h.state().monitors.as_ref().unwrap().program.rect;
    let k = f64::from(r.width()) / 1920.0;
    pos2(r.left() + (x * k) as f32, r.top() + (y * k) as f32)
}

/// The window's luma at sequence pixels, read where the monitor drew its picture.
fn luma(h: &mut Harness<'_, Shell>, points: &[(f64, f64)]) -> Vec<u8> {
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    points
        .iter()
        .map(|&(x, y)| {
            let p = at(h, x, y);
            let px = img.get_pixel((p.x * ppp).round() as u32, (p.y * ppp).round() as u32).0;
            ((u32::from(px[0]) * 2 + u32::from(px[1]) * 5 + u32::from(px[2])) / 8) as u8
        })
        .collect()
}

/// A press at `from`, the pointer moved to `to` in steps, released there; then the picture settles.
fn drag(h: &mut Harness<'_, Shell>, from: (f64, f64), to: (f64, f64), mods: egui::Modifiers) {
    let (from, to) = (at(h, from.0, from.1), at(h, to.0, to.1));
    h.hover_at(from);
    h.step();
    h.event(egui::Event::PointerButton {
        pos: from,
        button: egui::PointerButton::Primary,
        pressed: true,
        modifiers: mods,
    });
    h.step();
    for i in 1..=6 {
        h.hover_at(from + (to - from) * (i as f32 / 6.0));
        h.step();
    }
    h.event(egui::Event::PointerButton {
        pos: to,
        button: egui::PointerButton::Primary,
        pressed: false,
        modifiers: mods,
    });
    h.step();
    settle(h);
}

fn click(h: &mut Harness<'_, Shell>, p: (f64, f64)) {
    drag(h, p, p, egui::Modifiers::NONE);
}

fn prop(h: &Harness<'_, Shell>, clip: Id, name: &str) -> serde_json::Value {
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    serde_json::to_value(&c).unwrap()["props"][name].clone()
}

fn last_label(h: &Harness<'_, Shell>) -> String {
    let list = h.state().app.history.list();
    list.iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn save(h: &mut Harness<'_, Shell>, name: &str) {
    if let Ok(dir) = std::env::var("CUT_OVERLAY_SHOTS") {
        h.render().unwrap().save(std::path::Path::new(&dir).join(format!("{name}.png"))).unwrap();
    }
}

#[test]
fn dragging_the_box_moves_the_picture_and_a_corner_grows_it() {
    let (mut h, clip) = open("box", 50.0);
    // the half size solid covers x 480..1440, y 270..810 of the frame
    let before = luma(&mut h, &[(600.0, 540.0), (300.0, 540.0), (1550.0, 540.0)]);
    eprintln!("before: {before:?}");
    assert!(before[0] > 200 && before[1] < 30 && before[2] < 30, "the white box in the middle ({before:?})");
    save(&mut h, "box-before");
    let steps = h.state().app.history.position();
    drag(&mut h, (700.0, 400.0), (1000.0, 400.0), egui::Modifiers::NONE);
    let pos = prop(&h, clip, "position");
    eprintln!("position after the drag: {pos}");
    assert!((pos[0].as_f64().unwrap() - 300.0).abs() < 3.0 && pos[1].as_f64().unwrap().abs() < 0.01, "{pos}");
    assert_eq!(h.state().app.history.position(), steps + 1, "one undo step");
    assert_eq!(last_label(&h), "Position");
    let moved = luma(&mut h, &[(600.0, 540.0), (1550.0, 540.0), (1700.0, 540.0)]);
    eprintln!("after the move: {moved:?}");
    assert!(moved[0] < 30 && moved[1] > 200 && moved[2] > 200, "the picture moved right ({moved:?})");
    save(&mut h, "box-moved");
    // the bottom right corner (1740, 810) pulled out half as far again from the anchor (1260, 540)
    let corner = (1740.0, 810.0);
    drag(&mut h, corner, (1980.0, 945.0), egui::Modifiers::NONE);
    let scale = prop(&h, clip, "scale");
    eprintln!("scale after the corner drag: {scale}");
    assert!((scale[0].as_f64().unwrap() - 75.0).abs() < 1.0 && scale[0] == scale[1], "{scale}");
    assert_eq!(last_label(&h), "Scale");
    let grown = luma(&mut h, &[(1260.0, 300.0), (1260.0, 160.0), (500.0, 540.0)]);
    eprintln!("after the corner drag: {grown:?}");
    assert!(grown[0] > 200 && grown[1] > 200 && grown[2] < 30, "the picture grew about its anchor ({grown:?})");
    save(&mut h, "box-scaled");
}

#[test]
fn an_ellipse_mask_cuts_the_picture_and_a_dragged_vertex_takes_the_coverage_along() {
    let (mut h, clip) = open("mask", 100.0);
    let all = luma(&mut h, &[(960.0, 540.0), (100.0, 100.0), (1360.0, 540.0)]);
    assert!(all.iter().all(|v| *v > 200), "the whole frame is white ({all:?})");
    let steps = h.state().app.history.position();
    {
        let s = h.state_mut();
        overlay::create(&mut s.features.fx.overlay, &mut s.app, clip, None, Shape::Ellipse);
    }
    assert_eq!(h.state().app.history.position(), steps + 1, "Create Ellipse Mask is one step");
    assert!(h.state().features.fx.overlay.selected.is_some(), "the new mask is selected");
    settle(&mut h);
    // a circle of radius 270 about the center
    let cut = luma(&mut h, &[(960.0, 540.0), (100.0, 100.0), (1360.0, 540.0), (960.0 + 200.0, 540.0)]);
    eprintln!("with the mask: {cut:?}");
    assert!(cut[0] > 200 && cut[1] < 30 && cut[2] < 30 && cut[3] > 200, "only inside the ellipse shows ({cut:?})");
    save(&mut h, "mask-ellipse");
    // the right vertex (1230, 540) dragged 200 px out
    drag(&mut h, (1230.0, 540.0), (1430.0, 540.0), egui::Modifiers::NONE);
    assert_eq!(h.state().app.history.position(), steps + 2, "the vertex drag is one step");
    assert_eq!(last_label(&h), "Mask Path");
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    let path = &c.masks.as_ref().unwrap()[0].path;
    eprintln!("the right vertex is at x {}", path[6] * 1920.0);
    assert!((path[6] * 1920.0 - 1430.0).abs() < 4.0);
    let follow = luma(&mut h, &[(1360.0, 540.0), (960.0, 540.0), (1360.0, 300.0)]);
    eprintln!("after the vertex drag: {follow:?}");
    assert!(follow[0] > 200 && follow[1] > 200 && follow[2] < 30, "the coverage follows the vertex ({follow:?})");
    save(&mut h, "mask-vertex");
    // a click outside lets the mask go; the box comes back
    click(&mut h, (100.0, 100.0));
    assert!(h.state().features.fx.overlay.selected.is_none(), "a click outside lets the mask go");
}

#[test]
fn the_pen_draws_a_mask_and_escape_gives_up() {
    let (mut h, clip) = open("pen", 100.0);
    h.state_mut().features.fx.overlay.pen = Some((clip, None));
    let steps = h.state().app.history.position();
    for (x, y) in [(500.0, 300.0), (1400.0, 300.0), (960.0, 900.0)] {
        click(&mut h, (x, y));
    }
    assert_eq!(h.state().features.fx.overlay.pen_points().len(), 3);
    assert_eq!(h.state().app.history.position(), steps, "the points make no step");
    save(&mut h, "pen-points");
    click(&mut h, (501.0, 301.0));
    assert_eq!(h.state().app.history.position(), steps + 1, "closing the path is one step");
    assert_eq!(last_label(&h), "Add Mask");
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    assert_eq!(c.masks.as_ref().map(|m| m[0].path.len()), Some(18), "three corners");
    assert!(h.state().features.fx.overlay.pen.is_none() && h.state().features.fx.overlay.selected.is_some());
    settle(&mut h);
    let px = luma(&mut h, &[(960.0, 450.0), (200.0, 900.0), (1700.0, 900.0)]);
    eprintln!("the drawn mask: {px:?}");
    assert!(px[0] > 200 && px[1] < 30 && px[2] < 30, "the triangle shows, the rest is cut ({px:?})");
    save(&mut h, "pen-closed");
    // Escape ends a pen without a mask and keeps the clip selected
    h.state_mut().features.fx.overlay.pen = Some((clip, None));
    click(&mut h, (300.0, 300.0));
    h.key_press(egui::Key::Escape);
    h.step();
    h.step();
    assert!(h.state().features.fx.overlay.pen.is_none(), "Escape gives up the pen");
    assert!(h.state().app.selection.contains(&clip), "and is not Deselect All");
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    assert_eq!(c.masks.as_ref().map(Vec::len), Some(1), "no second mask");
}

#[test]
fn the_lumetri_eyedropper_reads_the_monitors_pixel() {
    let (mut h, clip) = open("pick", 50.0);
    h.state_mut().features.fx.pick =
        Some(Pick { clip, path: String::new(), kind: PickKind::Lumetri(Dropper::WhiteBalance) });
    click(&mut h, (960.0, 540.0));
    let got = h.state().features.fx.picked_color;
    eprintln!("picked {got:?}");
    assert!(h.state().features.fx.pick.is_none(), "the pick ends");
    let Some((Dropper::WhiteBalance, rgb)) = got else { panic!("a colour was picked: {got:?}") };
    assert!(rgb.iter().all(|c| *c > 240), "white ({rgb:?})");
    // outside the picture the pick ends with nothing
    h.state_mut().features.fx.picked_color = None;
    h.state_mut().features.fx.pick = Some(Pick { clip, path: String::new(), kind: PickKind::Lumetri(Dropper::HslKey) });
    click(&mut h, (960.0, -30.0));
    assert!(h.state().features.fx.pick.is_none() && h.state().features.fx.picked_color.is_none());
}
