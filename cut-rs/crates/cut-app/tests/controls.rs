//! Effect Controls in the real window, run headless (egui_kittest on wgpu), driven by pointer and key events on the
//! panel as a person uses it (the cases of `verify/cut-timeline.mjs` 'controls', `cut-panels.mjs` 'easing',
//! `cut-mask.mjs` 'create' and 'effect', `cut-tools.mjs`'s Speed rows): a dragged or typed value changes the picture,
//! the stopwatch and a typed value make keyframes whose values between are interpolated, a keyframe dragged in its
//! lane moves, the lane's menu changes the interpolation, a bezier handle reshapes the motion, a mask made by a click
//! cuts the picture, an effect is switched off, reordered and removed; each one undo step, undone and redone.
//! Every picture assertion reads the window's own pixels where the Program monitor drew the frame.

#[path = "media/mod.rs"]
mod media;

use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_model::Id;
use cut_model::commands::build as C;
use cut_model::keyframes::{self as K, Ease, Value};
use cut_time::{TICKS, Ticks};
use eframe::egui::{self, Modifiers, Pos2, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

const S: Ticks = TICKS;

/// A 1920 x 1080 sequence with a white solid on V1 for four seconds, selected, the playhead at 1 s, Effect Controls
/// shown; `setup` may add to the project first.
fn open(name: &str, setup: impl FnOnce(&mut cut_model::History, &str, &str)) -> (Harness<'static, Shell>, Id) {
    open_at(name, egui::vec2(1280.0, 800.0), setup)
}

/// [`open`] in a window of `size` points.
fn open_at(
    name: &str,
    size: egui::Vec2,
    setup: impl FnOnce(&mut cut_model::History, &str, &str),
) -> (Harness<'static, Shell>, Id) {
    let mut h = cut_app::doc::fresh_history();
    let seq = h.project().sequences[0].id;
    h.apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
        "source": { "generator": "solid", "color": "#ffffff" }, "at": 0, "duration": 4 * S, "track": "V1", "name": "White",
    } }))
    .expect("the solid");
    let clip = h.project().sequences[0].clips().next().map(|c| c.id).expect("a clip");
    setup(&mut h, seq.as_str(), clip.as_str());
    let dir = std::env::temp_dir().join(format!("cut-app-controls-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("controls.ncut");
    std::fs::write(&file, h.serialize()).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    s.app.select([clip], false, false);
    s.app.set_time(S);
    s.features.workspace.open_panel("controls");
    let mut harness = Harness::builder().with_size(size).wgpu_setup(media::gpu_setup()).build_eframe(move |_cc| s);
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
    h.step();
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

/// Where the panel drew the control `name` (its center).
fn at(h: &Harness<'_, Shell>, name: &str) -> Pos2 {
    h.state().features.controls.rect(name).unwrap_or_else(|| panic!("Effect Controls drew {name}")).center()
}

/// The screen point of a lane's keyframe at `t` (or of a handle of the segment leaving it).
fn key_point(h: &Harness<'_, Shell>, path: &str, t: Ticks, which: Option<usize>) -> (Pos2, bool) {
    let s = h.state();
    s.features.controls.lane_point(s, path, t, which).unwrap_or_else(|| panic!("the {path} lane has a keyframe at {t}"))
}

fn button(h: &mut Harness<'_, Shell>, p: Pos2, button: egui::PointerButton, pressed: bool, mods: Modifiers) {
    h.event(egui::Event::PointerButton { pos: p, button, pressed, modifiers: mods });
}

/// A press at `from`, moved to `to` in steps, released there; then the picture settles.
fn drag(h: &mut Harness<'_, Shell>, from: Pos2, to: Pos2, mods: Modifiers) {
    h.hover_at(from);
    h.step();
    button(h, from, egui::PointerButton::Primary, true, mods);
    h.step();
    for i in 1..=8 {
        h.hover_at(from + (to - from) * (i as f32 / 8.0));
        h.step();
    }
    button(h, to, egui::PointerButton::Primary, false, mods);
    h.step();
    settle(h);
}

/// A press and a release at `p` a frame apart (a slow press is not a click), then the picture settles.
fn click(h: &mut Harness<'_, Shell>, p: Pos2) {
    h.hover_at(p);
    h.step();
    button(h, p, egui::PointerButton::Primary, true, Modifiers::NONE);
    h.step();
    button(h, p, egui::PointerButton::Primary, false, Modifiers::NONE);
    h.step();
    settle(h);
}

fn right_click(h: &mut Harness<'_, Shell>, p: Pos2) {
    h.hover_at(p);
    h.step();
    button(h, p, egui::PointerButton::Secondary, true, Modifiers::NONE);
    h.step();
    button(h, p, egui::PointerButton::Secondary, false, Modifiers::NONE);
    h.step();
    h.step();
}

/// Clicks the open menu's item `label`.
fn menu_item(h: &mut Harness<'_, Shell>, label: &str) {
    // the menu's item, not a button of the same name under it
    h.get_all_by_label(&tr(label)).last().unwrap_or_else(|| panic!("the menu has {label}")).click();
    h.step();
    settle(h);
}

fn key(h: &mut Harness<'_, Shell>, key: egui::Key, mods: Modifiers) {
    h.event(egui::Event::Key { key, physical_key: None, pressed: true, repeat: false, modifiers: mods });
    h.event(egui::Event::Key { key, physical_key: None, pressed: false, repeat: false, modifiers: mods });
    h.step();
    settle(h);
}

/// A number field clicked, its text replaced by `text`, Enter.
fn type_into(h: &mut Harness<'_, Shell>, name: &str, text: &str) {
    let p = at(h, name);
    click(h, p);
    h.event(egui::Event::Key {
        key: egui::Key::A,
        physical_key: None,
        pressed: true,
        repeat: false,
        modifiers: Modifiers::COMMAND,
    });
    h.step();
    h.event(egui::Event::Text(text.to_owned()));
    h.step();
    key(h, egui::Key::Enter, Modifiers::NONE);
}

fn time(h: &mut Harness<'_, Shell>, t: Ticks) {
    h.state_mut().app.set_time(t);
    settle(h);
}

/// The window's luma at a sequence pixel, where the monitor drew it.
fn luma(h: &mut Harness<'_, Shell>, points: &[(f64, f64)]) -> Vec<u8> {
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    let r = h.state().monitors.as_ref().unwrap().program.rect;
    let k = f64::from(r.width()) / 1920.0;
    points
        .iter()
        .map(|&(x, y)| {
            let p = pos2(r.left() + (x * k) as f32, r.top() + (y * k) as f32);
            let px = img.get_pixel((p.x * ppp).round() as u32, (p.y * ppp).round() as u32).0;
            ((u32::from(px[0]) * 2 + u32::from(px[1]) * 5 + u32::from(px[2])) / 8) as u8
        })
        .collect()
}

fn clip_json(h: &Harness<'_, Shell>, clip: Id) -> Json {
    serde_json::to_value(h.state().app.sequence().unwrap().clip(clip).unwrap()).unwrap()
}

fn keys(h: &Harness<'_, Shell>, clip: Id, path: &str) -> Vec<K::Keyframe> {
    h.state().app.sequence().unwrap().clip(clip).unwrap().keyframes.get(path).cloned().unwrap_or_default()
}

/// A property's value at sequence time t (seconds), as the model computes it.
fn value(h: &Harness<'_, Shell>, clip: Id, path: &str, t: f64) -> f64 {
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    match K::prop_value(&c, path, t * S as f64) {
        Some(Value::Num(x)) => x,
        v => panic!("{path} at {t}: {v:?}"),
    }
}

fn steps(h: &Harness<'_, Shell>) -> usize {
    h.state().app.history.position()
}

fn label(h: &Harness<'_, Shell>) -> String {
    h.state().app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

fn save(h: &mut Harness<'_, Shell>, name: &str) {
    if let Ok(dir) = std::env::var("CUT_CONTROLS_SHOTS") {
        h.render().unwrap().save(std::path::Path::new(&dir).join(format!("{name}.png"))).unwrap();
    }
}

/// A point inside the picture away from the anchor point's mark at its center.
const CENTER: (f64, f64) = (760.0, 420.0);
const CORNER: (f64, f64) = (100.0, 100.0);

#[test]
fn a_scrubbed_opacity_changes_the_picture_and_undo_takes_it_back() {
    let (mut h, clip) = open("scrub", |_, _, _| {});
    assert!(luma(&mut h, &[CENTER])[0] > 240, "the white solid fills the monitor");
    save(&mut h, "opacity-before");
    let n = steps(&h);
    let p = at(&h, "opacity/value");
    drag(&mut h, p, p - egui::vec2(60.0, 0.0), Modifiers::NONE);
    let o = clip_json(&h, clip)["props"]["opacity"].as_f64().unwrap();
    eprintln!("opacity after the scrub: {o}");
    assert!((30.0..=50.0).contains(&o), "dragging the field left lowers the opacity ({o})");
    assert_eq!((steps(&h), label(&h).as_str()), (n + 1, "Effect Settings"), "the scrub is one undo step");
    let dim = luma(&mut h, &[CENTER])[0];
    eprintln!("luma at {o}% opacity: {dim}");
    save(&mut h, "opacity-scrubbed");
    assert!((40..200).contains(&dim), "the monitor shows the clip at that opacity ({dim})");
    key(&mut h, egui::Key::Z, Modifiers::COMMAND);
    assert!(luma(&mut h, &[CENTER])[0] > 240, "Ctrl+Z gives the full opacity back");
    key(&mut h, egui::Key::Z, Modifiers::COMMAND | Modifiers::SHIFT);
    assert_eq!(luma(&mut h, &[CENTER])[0], dim, "Ctrl+Shift+Z does it again");
    // the slider under the label sets it too
    let sl = h.state().features.controls.rect("opacity/slider").expect("the opacity slider");
    drag(&mut h, sl.center(), pos2(sl.left() + 2.0, sl.center().y), Modifiers::NONE);
    let o = clip_json(&h, clip)["props"]["opacity"].as_f64().unwrap();
    assert!(o < 10.0 && luma(&mut h, &[CENTER])[0] < 30, "the slider dragged to its left end hides the clip ({o})");
    // Reset puts the whole section back in one step
    let n = steps(&h);
    let r = at(&h, "sec:opacity/reset");
    click(&mut h, r);
    assert_eq!(clip_json(&h, clip)["props"]["opacity"].as_f64(), Some(100.0));
    assert_eq!((steps(&h), label(&h).as_str()), (n + 1, "Reset"));
}

#[test]
fn keyframes_from_the_stopwatch_interpolate_and_move_in_the_lane() {
    let (mut h, clip) = open("keys", |_, _, _| {});
    let before = steps(&h);
    let w = at(&h, "opacity/watch");
    click(&mut h, w);
    let k = keys(&h, clip, "opacity");
    assert!(
        k.len() == 1 && k[0].t == S && k[0].v == Value::Num(100.0),
        "the stopwatch makes a keyframe at the playhead ({k:?})"
    );
    time(&mut h, 3 * S);
    type_into(&mut h, "opacity/value", "20");
    let k = keys(&h, clip, "opacity");
    assert!(
        k.len() == 2 && k[1].t == 3 * S && k[1].v == Value::Num(20.0),
        "a value typed with keyframes on makes a keyframe ({k:?})"
    );
    assert!((value(&h, clip, "opacity", 2.0) - 60.0).abs() < 1e-6, "halfway between the keyframes is 60");
    let mut seen = Vec::new();
    for t in [1, 2, 3] {
        time(&mut h, t * S);
        seen.push(luma(&mut h, &[CENTER])[0]);
    }
    eprintln!("luma at 1, 2, 3 s: {seen:?}");
    assert!(
        seen[0] > 240 && seen[0] > seen[1] + 30 && seen[1] > seen[2] + 30,
        "the picture fades along the keyframes ({seen:?})"
    );
    save(&mut h, "keys-two");
    // the 3 s keyframe dragged in the lane to 3.5 s
    let (a, _) = key_point(&h, "opacity", 3 * S, None);
    let (b, _) = key_point(&h, "opacity", S, None);
    let per_s = (a.x - b.x) / 2.0;
    drag(&mut h, a, a + egui::vec2(per_s / 2.0, 0.0), Modifiers::NONE);
    let k = keys(&h, clip, "opacity");
    eprintln!("after the lane drag: {:?}", k.iter().map(|k| k.t as f64 / S as f64).collect::<Vec<_>>());
    assert!(
        k.len() == 2 && (k[1].t as f64 / S as f64 - 3.5).abs() < 0.05 && k[1].v == Value::Num(20.0),
        "the keyframe moved to 3.5 s"
    );
    assert_eq!(label(&h), "Keyframes");
    // the lane's menu: Ease Out on the first keyframe
    let (p, _) = key_point(&h, "opacity", S, None);
    right_click(&mut h, p);
    menu_item(&mut h, "Ease Out");
    assert_eq!(keys(&h, clip, "opacity")[0].ease, Ease::EaseOut, "the lane menu sets Ease Out");
    // previous and next keyframe
    time(&mut h, 2 * S);
    let nx = at(&h, "opacity/next");
    click(&mut h, nx);
    assert_eq!(h.state().app.t, keys(&h, clip, "opacity")[1].t, "the next-keyframe button moves the playhead there");
    let pv = at(&h, "opacity/prev");
    click(&mut h, pv);
    assert_eq!(h.state().app.t, S, "the previous-keyframe button moves it back");
    // Add/Remove at a keyframe takes it away
    let ad = at(&h, "opacity/add");
    click(&mut h, ad);
    assert_eq!(keys(&h, clip, "opacity").len(), 1, "the diamond at a keyframe removes it");
    let n = steps(&h) - before;
    assert_eq!(n, 5, "five undo steps: stopwatch, value, lane drag, ease, remove");
    for _ in 0..n {
        key(&mut h, egui::Key::Z, Modifiers::COMMAND);
    }
    assert!(keys(&h, clip, "opacity").is_empty(), "Ctrl+Z takes every keyframe back");
    for _ in 0..n {
        key(&mut h, egui::Key::Z, Modifiers::COMMAND | Modifiers::SHIFT);
    }
    assert_eq!(keys(&h, clip, "opacity").len(), 1, "and Ctrl+Shift+Z brings them back");
}

#[test]
fn hold_and_a_bezier_handle_reshape_the_motion() {
    let (mut h, clip) = open("easing", |h, s, c| {
        let list = json!([
            { "t": 0, "v": 0, "ease": "linear" }, { "t": 3 * S / 2, "v": 100, "ease": "linear" }, { "t": 3 * S, "v": 50, "ease": "linear" },
        ]);
        h.apply(&C::set_keyframes(s, c, "opacity", Some(list))).unwrap();
    });
    let n0 = steps(&h);
    let (p, _) = key_point(&h, "opacity", 3 * S / 2, None);
    right_click(&mut h, p);
    for item in ["Linear", "Ease In", "Ease Out", "Ease In and Out", "Bezier", "Hold", "Copy", "Paste", "Delete"] {
        assert!(h.query_by_label(&tr(item)).is_some(), "the lane's keyframe menu offers {item}");
    }
    menu_item(&mut h, "Hold");
    assert_eq!(keys(&h, clip, "opacity")[1].ease, Ease::Hold);
    assert_eq!((value(&h, clip, "opacity", 2.5), steps(&h)), (100.0, n0 + 1), "Hold keeps 100 until the next keyframe");
    time(&mut h, 5 * S / 2);
    let held = luma(&mut h, &[CENTER])[0];
    assert!(held > 240, "the picture holds full opacity at 2.5 s ({held})");
    let (p, _) = key_point(&h, "opacity", 0, None);
    right_click(&mut h, p);
    menu_item(&mut h, "Bezier");
    let k0 = keys(&h, clip, "opacity")[0].clone();
    assert!(
        k0.ease == Ease::Bezier && (value(&h, clip, "opacity", 0.75) - 50.0).abs() < 0.5,
        "Bezier from linear keeps the motion ({k0:?})"
    );
    let (h1, shown) = key_point(&h, "opacity", 0, Some(0));
    assert!(shown, "the bezier segment shows its handles");
    let (start, _) = key_point(&h, "opacity", 0, None);
    let (end, _) = key_point(&h, "opacity", 3 * S / 2, None);
    let lane = h.state().features.controls.lane_rect("opacity").expect("the opacity lane");
    let n1 = steps(&h);
    drag(&mut h, h1, pos2(start.x + (end.x - start.x) * 0.8, lane.bottom() - 4.0), Modifiers::NONE);
    let k0 = keys(&h, clip, "opacity")[0].clone();
    let hh = k0.h.clone().unwrap();
    eprintln!("the dragged handles: {hh:?}");
    assert!(hh[0] > 0.7 && hh[0] < 0.9 && hh[1].abs() < 0.15, "dragging the handle sets it ({hh:?})");
    assert_eq!((steps(&h), label(&h).as_str()), (n1 + 1, "Keyframes"), "the handle drag is one undo step");
    assert!(value(&h, clip, "opacity", 0.75) < 40.0, "the motion starts slower");
    save(&mut h, "easing-bezier");
    key(&mut h, egui::Key::Z, Modifiers::COMMAND);
    let back = keys(&h, clip, "opacity")[0].h.clone().unwrap();
    assert!((back[0] - 1.0 / 3.0).abs() < 0.01, "Ctrl+Z gives the handle back ({back:?})");
    // a click picks the last keyframe, Shift+click adds the first, Delete takes both away in one step
    let (last, _) = key_point(&h, "opacity", 3 * S, None);
    click(&mut h, last);
    let (first, _) = key_point(&h, "opacity", 0, None);
    h.hover_at(first);
    h.event(egui::Event::ModifiersChanged(Modifiers::SHIFT));
    h.step();
    button(&mut h, first, egui::PointerButton::Primary, true, Modifiers::SHIFT);
    h.step();
    button(&mut h, first, egui::PointerButton::Primary, false, Modifiers::SHIFT);
    h.step();
    h.event(egui::Event::ModifiersChanged(Modifiers::NONE));
    settle(&mut h);
    assert_eq!(h.state().features.controls.picked.len(), 2, "two keyframes picked");
    let n = steps(&h);
    key(&mut h, egui::Key::Delete, Modifiers::NONE);
    let left: Vec<Ticks> = keys(&h, clip, "opacity").iter().map(|k| k.t).collect();
    assert_eq!((left, steps(&h)), (vec![3 * S / 2], n + 1), "Delete removes the picked keyframes");
}

#[test]
fn a_mask_made_by_clicks_cuts_the_picture() {
    // tall enough for Opacity's two masks and their rows
    let (mut h, clip) = open_at("mask", egui::vec2(1280.0, 1500.0), |_, _, _| {});
    // fold Motion so the masks' rows fit the panel
    let m = h.state().features.controls.rect("sec:motion/head").expect("the Motion header");
    click(&mut h, pos2(m.left() + 14.0, m.center().y));
    let before = steps(&h);
    let b = at(&h, "masks:opacity/ellipse");
    click(&mut h, b);
    let c = clip_json(&h, clip);
    let mask = &c["masks"][0];
    assert!(
        mask["mode"] == "add"
            && mask["feather"] == 10.0
            && mask["opacity"] == 100.0
            && mask["path"].as_array().map(Vec::len) == Some(24),
        "Create Ellipse Mask puts Premiere's defaults on Opacity ({mask})"
    );
    assert_eq!((steps(&h), label(&h).as_str()), (before + 1, "Add Mask"));
    let id = Id::new(mask["id"].as_str().unwrap());
    assert_eq!(
        h.state().features.fx.overlay.selected.map(|s| s.mask),
        Some(id),
        "the new mask is edited on the monitor"
    );
    let px = luma(&mut h, &[CENTER, CORNER]);
    assert!(px[0] > 240 && px[1] < 20, "only inside the ellipse shows ({px:?})");
    save(&mut h, "mask-ellipse");
    for row in ["path", "feather", "opacity", "expansion", "inverted", "mode"] {
        let name = format!("masks.{id}.{row}/value");
        let shown = h.state().features.controls.rect(&name).is_some() || row == "path";
        assert!(shown, "the mask has its {row} row");
    }
    // Inverted: one step, the picture turns inside out
    let inv = at(&h, &format!("masks.{id}.inverted/value"));
    click(&mut h, inv);
    assert_eq!(clip_json(&h, clip)["masks"][0]["inverted"], true);
    assert_eq!(label(&h), "Mask");
    let px = luma(&mut h, &[CENTER, CORNER]);
    assert!(px[0] < 20 && px[1] > 240, "the inverted mask shows the outside ({px:?})");
    save(&mut h, "mask-inverted");
    // a click elsewhere on the monitor lets the mask go, a click on its header edits it again
    h.state_mut().features.fx.overlay.selected = None;
    let head = at(&h, &format!("mask:{id}/head"));
    click(&mut h, head);
    assert_eq!(h.state().features.fx.overlay.selected.map(|s| s.mask), Some(id), "the mask's header selects it");
    // the polygon button adds a second mask; the pen button starts the pen
    let poly = at(&h, "masks:opacity/polygon");
    click(&mut h, poly);
    assert_eq!(clip_json(&h, clip)["masks"].as_array().map(Vec::len), Some(2), "the polygon mask is added");
    let pen = at(&h, "masks:opacity/pen");
    click(&mut h, pen);
    assert_eq!(h.state().features.fx.overlay.pen, Some((clip, None)), "Free draw bezier starts the pen");
    click(&mut h, pen);
    assert_eq!(h.state().features.fx.overlay.pen, None, "a second click ends it");
    // the X removes the first mask
    let rm = at(&h, &format!("mask:{id}/remove"));
    click(&mut h, rm);
    assert_eq!(clip_json(&h, clip)["masks"].as_array().map(Vec::len), Some(1), "Remove Mask takes it away");
    key(&mut h, egui::Key::Z, Modifiers::COMMAND);
    assert_eq!(clip_json(&h, clip)["masks"].as_array().map(Vec::len), Some(2), "Ctrl+Z brings it back");
}

#[test]
fn an_effects_parameter_switch_order_and_removal() {
    let (mut h, clip) = open("effect", |h, s, c| {
        h.apply(&C::add_effect(s, c, "color.brightnessContrast", None, json!({}))).unwrap();
        h.apply(&C::add_effect(s, c, "color.invert", None, json!({}))).unwrap();
    });
    let fx: Vec<String> = clip_json(&h, clip)["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    let (bc, inv) = (fx[0].clone(), fx[1].clone());
    // Motion, Opacity and Crop folded so both effects fit
    for sec in ["motion", "opacity", "crop"] {
        let r = h.state().features.controls.rect(&format!("sec:{sec}/head")).unwrap();
        click(&mut h, pos2(r.left() + 14.0, r.center().y));
    }
    assert!(luma(&mut h, &[CENTER])[0] < 20, "Invert turns the white solid black");
    let sw = at(&h, &format!("sec:fx:{clip}:{inv}/fx"));
    click(&mut h, sw);
    assert_eq!(clip_json(&h, clip)["effects"][1]["on"], false, "the fx switch turns Invert off");
    assert!(luma(&mut h, &[CENTER])[0] > 240, "and the picture is white again");
    let n = steps(&h);
    let p = at(&h, &format!("effects.{bc}.brightness/value"));
    drag(&mut h, p, p - egui::vec2(60.0, 0.0), Modifiers::NONE);
    let b = clip_json(&h, clip)["effects"][0]["params"]["brightness"].as_f64().unwrap_or(0.0);
    let px = luma(&mut h, &[CENTER])[0];
    eprintln!("brightness {b}: luma {px}");
    assert!(b < -30.0 && px < 230, "the dragged Brightness darkens the picture ({b}, {px})");
    assert_eq!(steps(&h), n + 1);
    save(&mut h, "effect-brightness");
    // Brightness & Contrast's stopwatch and its lane work like the fixed effects'
    let w = at(&h, &format!("effects.{bc}.brightness/watch"));
    click(&mut h, w);
    assert_eq!(keys(&h, clip, &format!("effects.{bc}.brightness")).len(), 1, "an effect parameter is keyframed");
    // the right-click menu of the first effect moves it down
    let head = at(&h, &format!("sec:fx:{clip}:{bc}/head"));
    right_click(&mut h, head);
    menu_item(&mut h, "Move Down");
    let order: Vec<String> = clip_json(&h, clip)["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(order, vec![inv.clone(), bc.clone()], "Move Down swaps the effects");
    // Reset of the effect clears its parameters and keyframes in one step
    let n = steps(&h);
    let r = at(&h, &format!("sec:fx:{clip}:{bc}/reset"));
    click(&mut h, r);
    let c = clip_json(&h, clip);
    assert!(
        c["effects"][1]["params"].as_object().is_none_or(|p| p.is_empty())
            && c["keyframes"].as_object().is_none_or(|k| k.is_empty()),
        "Reset ({c})"
    );
    assert_eq!((steps(&h), label(&h).as_str()), (n + 1, "Reset"));
    // the remove button of Invert
    let head = at(&h, &format!("sec:fx:{clip}:{inv}/head"));
    right_click(&mut h, head);
    menu_item(&mut h, "Remove Effect");
    assert_eq!(clip_json(&h, clip)["effects"].as_array().map(Vec::len), Some(1), "Remove Effect takes Invert away");
    key(&mut h, egui::Key::Z, Modifiers::COMMAND);
    assert_eq!(clip_json(&h, clip)["effects"].as_array().map(Vec::len), Some(2), "Ctrl+Z brings it back");
}

#[test]
fn a_selected_transition_shows_its_settings() {
    let (mut h, _) = open("transition", |h, s, _| {
        h.apply(&json!({ "type": "addGenerated", "seqId": s, "opts": {
            "source": { "generator": "solid", "color": "#000000" }, "at": 4 * S, "duration": 4 * S, "track": "V1", "name": "Black",
        } }))
        .unwrap();
        h.apply(&C::add_transition(s, json!({ "track": "V1", "at": 4 * S, "type": "dissolve", "align": "center" })))
            .unwrap();
    });
    let tid = h.state().app.sequence().unwrap().transitions[0].id;
    {
        let s = h.state_mut();
        s.app.selection.clear();
        s.app.edit.transition = Some(tid);
    }
    settle(&mut h);
    assert!(h.state().features.controls.rect("transition/type").is_some(), "Effect Controls shows the transition");
    let n = steps(&h);
    let d = at(&h, "transition/duration");
    click(&mut h, d);
    h.event(egui::Event::Key {
        key: egui::Key::A,
        physical_key: None,
        pressed: true,
        repeat: false,
        modifiers: Modifiers::COMMAND,
    });
    h.step();
    h.event(egui::Event::Text("00:00:00:20".into()));
    h.step();
    key(&mut h, egui::Key::Enter, Modifiers::NONE);
    let t = h.state().app.sequence().unwrap().transitions[0].clone();
    assert_eq!((t.duration, steps(&h)), (20 * S / 30, n + 1), "a typed duration sets it in one step");
    let a = at(&h, "transition/align");
    click(&mut h, a);
    menu_item(&mut h, "Start at Cut");
    let t = h.state().app.sequence().unwrap().transitions[0].clone();
    assert_eq!(t.align, cut_model::Align::Start, "the alignment list sets Start at Cut");
}
