//! The Color workspace's panels in the window, run headless (egui_kittest on wgpu) on a project of solids (a grey,
//! a 75% red and a 75% blue, as `verify/cut-color.mjs` makes) and a grey ramp image: the Lumetri Scopes count what
//! the Program monitor shows, a drag on the curve square brightens the picture in one undo step, a .cube LUT loaded
//! through the file dialog's stand-in (`CUT_DIALOG`, key `pickLut`) turns the red cyan and bad files are refused
//! with the parser's reason, and the HSL eyedropper's colour keys the red.

#[path = "../examples/demo_project.rs"]
mod demo;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::fx::color::{Dropper, LUMETRI};
use cut_app::shell::Shell;
use cut_app::workspaces::Ws;
use cut_app::{cmd, doc, i18n, import};
use cut_model::Id;
use cut_time::TICKS;
use eframe::egui::{self, Event, Modifiers, PointerButton, Pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

type H = Harness<'static, Shell>;

fn ticks(s: f64) -> i64 {
    (s * TICKS as f64).round() as i64
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-fx-color-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// V1: grey 0-4 s, 75% red 4-8 s, 75% blue 8-12 s, a grey ramp image from 12 s.
fn project(dir: &Path) -> String {
    let mut h = doc::fresh_history();
    let seq = h.project().sequences[0].id;
    for (i, color) in ["#808080", "#bf0000", "#0000bf"].iter().enumerate() {
        h.apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
            "track": "V1", "at": ticks(i as f64 * 4.0), "duration": ticks(4.0),
            "source": { "generator": "solid", "color": color },
        } }))
        .expect("a solid");
    }
    let ramp = dir.join("ramp.png");
    image::RgbaImage::from_fn(1920, 1080, |x, _| {
        let v = ((x * 255) as f64 / 1919.0).round() as u8;
        image::Rgba([v, v, v, 255])
    })
    .save(&ramp)
    .unwrap();
    let media = import::probe_file(&ramp).result.expect("the ramp is imported");
    let r = h.apply(&cmd::import_media(vec![media], None)).expect("import");
    let id = Id::new(r["ids"][0].as_str().unwrap());
    h.apply(&cmd::place(seq, id, Some(Id::new("V1")), None, ticks(12.0), "overwrite")).expect("the ramp");
    h.serialize()
}

/// The project opened in the Color workspace (English), Basic Correction folded so the other sections fit.
fn open(dir: &Path) -> H {
    let file = dir.join("color.ncut");
    std::fs::write(&file, project(dir)).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    i18n::set_lang(i18n::Lang::En);
    s.features.workspace.current = Ws::Color;
    s.features.fx.color.collapsed = Some(["basic", "vignette"].map(String::from).into());
    let mut h = Harness::builder()
        .with_size(egui::vec2(1600.0, 1100.0))
        // a double click is two clicks within 0.3 s of the input's time
        .with_step_dt(1.0 / 60.0)
        .wgpu_setup(demo::media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while h.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(h.state().monitors.is_some(), "the window gave the monitors its GPU device");
    h.state_mut().transport.set_output_gain(0.0);
    h
}

/// Steps until `done` holds (up to 10 s).
fn until(h: &mut H, what: &str, done: impl Fn(&Shell) -> bool) {
    let start = Instant::now();
    while !done(h.state()) {
        assert!(start.elapsed() < Duration::from_secs(10), "{what}");
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// The V1 clip `i` in time order.
fn clip(s: &Shell, i: usize) -> Id {
    let seq = s.app.sequence().unwrap();
    let mut v: Vec<_> = seq.clips_in_order().filter(|c| c.track.as_str() == "V1").collect();
    v.sort_by_key(|c| c.start);
    v[i].id
}

/// Selects V1's clip `i` and moves the playhead to `at` seconds.
fn on(h: &mut H, i: usize, at: f64) {
    let c = clip(h.state(), i);
    let s = h.state_mut();
    s.app.select([c], false, false);
    s.app.set_time(ticks(at));
}

/// The stored parameters of the clip's Lumetri Color.
fn lumetri(s: &Shell, i: usize) -> Option<serde_json::Map<String, Json>> {
    let seq = s.app.sequence()?;
    seq.clip(clip(s, i))?.effects.iter().find(|e| e.kind == LUMETRI).map(|e| e.params.clone())
}

/// The window's picture, saved in the folder `CUT_SHOTS` names (when it does) to look at.
fn shot(h: &mut H, name: &str) {
    if let Some(d) = std::env::var_os("CUT_SHOTS") {
        // the scopes' pictures are made on their own thread: a few frames for the newest to arrive
        for _ in 0..5 {
            h.step();
            std::thread::sleep(Duration::from_millis(30));
        }
        h.render().expect("a picture").save(Path::new(&d).join(format!("fx-color-{name}.png"))).unwrap();
    }
}

fn steps(s: &Shell) -> usize {
    s.app.history.position()
}

/// The Program monitor's middle pixel once its picture shows the project as it is now.
fn middle(h: &mut H) -> [u8; 3] {
    for _ in 0..3 {
        h.step();
    }
    let m = h.state().monitors.as_ref().unwrap();
    m.settle();
    let (w, hh, px) = m.program.pixels().expect("a picture");
    let i = (((hh / 2) * w + w / 2) * 4) as usize;
    [px[i], px[i + 1], px[i + 2]]
}

/// What the tests read off the last count: the vectorscope's fullest bin (angle, magnitude) and the waveform's
/// fullest level per column (`scopes.js`'s `vectorPeak`, `peaks`).
struct Seen {
    angle: f64,
    magnitude: f64,
    wave: Vec<i32>,
}

fn seen(s: &Shell) -> Seen {
    let count = s.features.fx.scopes.last.as_ref().expect("a count");
    let l = count.layout;
    let vector = &count.bins[l.vector as usize..][..(l.size * l.size) as usize];
    let at = (0..vector.len()).fold(0, |b, i| if vector[i] > vector[b] { i } else { b });
    let (n, range) = (f64::from(l.size), cut_app::fx::scopes::RANGE);
    let x = (at % l.size as usize) as f64 + 0.5;
    let y = (at / l.size as usize) as f64 + 0.5;
    let angle = ((n / 2.0 - y).atan2(x - n / 2.0).to_degrees() + 360.0) % 360.0;
    let (cb, cr) = ((x * 2.0 * range) / n - range, range - (y * 2.0 * range) / n);
    let cols = l.cols as usize;
    let wave = (0..cols)
        .map(|c| {
            let (mut best, mut at) = (0, -1);
            for lv in 0..256 {
                let k = count.bins[l.wave as usize + lv * cols + c];
                if k > best {
                    best = k;
                    at = lv as i32;
                }
            }
            at
        })
        .collect();
    Seen { angle, magnitude: cb.hypot(cr), wave }
}

/// Moves the playhead to `at` and waits for a count of the picture there.
fn scopes_at(h: &mut H, at: f64, what: &str) -> Seen {
    let before = h.state().features.fx.scopes.count;
    h.state_mut().app.set_time(ticks(at));
    let t = ticks(at);
    until(h, what, |s| {
        s.features.fx.scopes.count > before && s.features.fx.scopes.last.as_ref().is_some_and(|c| c.t == t)
    });
    seen(h.state())
}

#[test]
fn the_scopes_follow_the_program_monitor() {
    let dir = folder("scopes");
    let mut h = open(&dir);
    let grey = scopes_at(&mut h, 1.0, "the scopes of the grey solid");
    let mid = grey.wave[grey.wave.len() / 2];
    eprintln!("grey: vectorscope magnitude {:.4}, waveform level {mid}", grey.magnitude);
    assert!(grey.magnitude < 0.02 && (126..=130).contains(&mid), "the grey: the middle of the vectorscope, level 128");
    let red = scopes_at(&mut h, 5.0, "the scopes of the red solid");
    eprintln!("red: {:.1} degrees", red.angle);
    assert!((red.angle - 102.9).abs() < 2.0, "the 75% red at red's angle ({:.1})", red.angle);
    let blue = scopes_at(&mut h, 9.0, "the scopes of the blue solid");
    eprintln!("blue: {:.1} degrees", blue.angle);
    assert!((blue.angle - 354.8).abs() < 2.0, "the 75% blue at blue's angle ({:.1})", blue.angle);
    let ramp = scopes_at(&mut h, 13.0, "the scopes of the ramp");
    let (first, last) = (ramp.wave[0], ramp.wave[ramp.wave.len() - 1]);
    eprintln!("ramp: waveform from {first} to {last}");
    assert!(first <= 2 && last >= 253 && ramp.wave.windows(2).all(|p| p[1] >= p[0]), "the ramp is the diagonal");
    let cost = h.state().features.fx.scopes.last.as_ref().unwrap().cost;
    eprintln!("a count cost the UI thread {:.2} ms", cost.as_secs_f64() * 1000.0);
    shot(&mut h, "scopes");

    // another tab in the scopes' slot: nothing is counted
    h.state_mut().features.workspace.open_panel("source");
    h.run_steps(2);
    let before = h.state().features.fx.scopes.count;
    for at in [1.0, 5.0, 9.0] {
        h.state_mut().app.set_time(ticks(at));
        h.run_steps(3);
    }
    assert_eq!(h.state().features.fx.scopes.count, before, "a scopes panel off screen counts nothing");
    h.state_mut().features.workspace.open_panel("scopes");
    let back = scopes_at(&mut h, 5.0, "the scopes on screen again");
    assert!((back.angle - 102.9).abs() < 2.0);
    let _ = std::fs::remove_dir_all(&dir);
}

fn square(s: &Shell, u: f32, v: f32) -> Pos2 {
    let r = s.features.fx.color.curves.square.shrink(8.0);
    Pos2::new(r.left() + u * r.width(), r.top() + (1.0 - v) * r.height())
}

fn drag(h: &mut H, a: Pos2, b: Pos2) {
    h.hover_at(a);
    h.step();
    h.drag_at(a);
    h.step();
    for i in 1..=10 {
        h.hover_at(a + (b - a) * (i as f32 / 10.0));
        h.step();
    }
    h.drop_at(b);
    h.step();
}

fn click(h: &mut H, at: Pos2, modifiers: Modifiers) {
    h.hover_at(at);
    h.event(Event::ModifiersChanged(modifiers));
    h.event(Event::PointerButton { pos: at, button: PointerButton::Primary, pressed: true, modifiers });
    h.event(Event::PointerButton { pos: at, button: PointerButton::Primary, pressed: false, modifiers });
    h.event(Event::ModifiersChanged(Modifiers::NONE));
    h.step();
}

fn curve(s: &Shell, i: usize, k: &str) -> Option<Vec<f64>> {
    lumetri(s, i)?.get(k)?.as_array().map(|a| a.iter().filter_map(Json::as_f64).collect())
}

#[test]
fn a_curve_drag_brightens_the_picture_in_one_undo_step() {
    let dir = folder("curves");
    let mut h = open(&dir);
    on(&mut h, 0, 1.0);
    h.run_steps(3);
    let base = middle(&mut h);
    let steps0 = steps(h.state());
    let (a, b) = (square(h.state(), 0.5, 0.5), square(h.state(), 0.5, 0.75));
    drag(&mut h, a, b);
    let master = curve(h.state(), 0, "curveMaster").expect("a master curve");
    eprintln!("the master curve after the drag: {master:?}");
    assert!(master.len() == 6 && (master[2] - 0.5).abs() < 0.03 && (master[3] - 0.75).abs() < 0.03, "{master:?}");
    assert_eq!(steps(h.state()), steps0 + 1, "the point, its drag and the new Lumetri Color are one undo step");
    let lifted = middle(&mut h);
    eprintln!("the grey: {base:?} -> {lifted:?}");
    assert!(lifted[0] > base[0] + 25 && lifted[0] == lifted[2], "the program monitor's grey gets brighter");
    let t = ticks(1.0);
    until(&mut h, "a count of the brighter grey", |s| {
        s.features.fx.scopes.last.as_ref().is_some_and(|c| c.t == t) && {
            let w = seen(s).wave;
            w[w.len() / 2] > 150
        }
    });
    shot(&mut h, "curves");

    // the red channel: lowers red only
    h.state_mut().features.fx.color.curves.channel = 1;
    h.step();
    let (a, b) = (square(h.state(), 0.5, 0.5), square(h.state(), 0.5, 0.2));
    drag(&mut h, a, b);
    let red = curve(h.state(), 0, "curveRed").expect("a red curve");
    let px = middle(&mut h);
    eprintln!("the red curve {red:?}: {lifted:?} -> {px:?}");
    assert!(red.len() == 6 && px[0] + 20 < lifted[0] && px[1].abs_diff(lifted[1]) <= 1, "red only goes down");
    // Ctrl+click on its point removes it
    let p = square(h.state(), red[2] as f32, red[3] as f32);
    click(&mut h, p, Modifiers::COMMAND);
    assert!(curve(h.state(), 0, "curveRed").is_none_or(|c| c.len() == 4), "Ctrl+click removes the point");
    // a double click straightens the master curve; its first click's new point is taken back
    h.state_mut().features.fx.color.curves.channel = 0;
    h.step();
    let p = square(h.state(), 0.2, 0.9);
    let before = steps(h.state());
    click(&mut h, p, Modifiers::NONE);
    click(&mut h, p, Modifiers::NONE);
    assert!(curve(h.state(), 0, "curveMaster").is_none(), "a double click straightens the master curve");
    assert_eq!(steps(h.state()), before + 1, "the straightening is one step, the double click's point taken back");
    assert!(h.state_mut().app.undo());
    assert_eq!(curve(h.state(), 0, "curveMaster"), Some(master), "undo brings the bent master curve back");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_hsl_eyedropper_keys_the_picked_red() {
    let dir = folder("hsl");
    let mut h = open(&dir);
    on(&mut h, 1, 5.0);
    h.run_steps(3);
    let red = middle(&mut h);
    // the overlay's answer to a click on the monitor
    h.state_mut().features.fx.picked_color = Some((Dropper::HslKey, red));
    h.run_steps(2);
    let p = cut_model::effects::resolve(LUMETRI, &lumetri(h.state(), 1).expect("a Lumetri Color"));
    eprintln!("the key around {red:?}: {p:?}");
    assert_eq!(p.get("hslHueRange").and_then(Json::as_f64), Some(50.0));
    assert_eq!(p.get("hslSatHigh").and_then(Json::as_f64), Some(100.0));
    assert!(p.get("hslHue").and_then(Json::as_f64).is_none_or(|v| v.abs() < 3.0), "the hue of red");
    // saturation 0 inside the key turns the red grey
    let c = clip(h.state(), 1);
    let s = h.state_mut();
    cut_app::fx::color::set(
        &mut s.app,
        c,
        LUMETRI,
        &[("hslSaturation", cut_model::keyframes::Value::Num(0.0))],
        "Color",
    );
    let grey = middle(&mut h);
    eprintln!("saturation 0 in the key: {grey:?}");
    assert!(grey.iter().max().unwrap() - grey.iter().min().unwrap() <= 2 && (60..120).contains(&grey[0]));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A .cube of `n` points a side through `f` (as the JavaScript test writes them).
fn cube(n: usize, f: impl Fn(f64, f64, f64) -> [f64; 3], head: &str) -> String {
    let mut out = format!("{head}TITLE \"Invert\"\nLUT_3D_SIZE {n}\n");
    let k = (n - 1) as f64;
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let v = f(r as f64 / k, g as f64 / k, b as f64 / k);
                out.push_str(&format!("{:.6} {:.6} {:.6}\n", v[0], v[1], v[2]));
            }
        }
    }
    out
}

/// The file dialog's stand-in answers `pickLut` with `file`.
fn answer(dialog: &Path, file: &Path) {
    std::fs::write(dialog, json!({ "pickLut": file.to_string_lossy() }).to_string()).unwrap();
}

#[test]
fn a_lut_loaded_through_the_dialog_turns_the_red_cyan() {
    // CUT_DIALOG is read from the environment: the test runs again in a process of its own that has it
    let Some(dialog) = std::env::var_os("CUT_DIALOG").map(PathBuf::from) else {
        let dir = folder("lut");
        let dialog = dir.join("dialog.json");
        answer(&dialog, &dir.join("none.cube"));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "a_lut_loaded_through_the_dialog_turns_the_red_cyan", "--nocapture"])
            .env("CUT_DIALOG", &dialog)
            .status()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(status.success(), "the test in its own process passed");
        return;
    };
    let dir = dialog.parent().unwrap().to_owned();
    let invert = dir.join("invert.cube");
    std::fs::write(&invert, cube(17, |r, g, b| [1.0 - r, 1.0 - g, 1.0 - b], "# a test look\n")).unwrap();
    let short = dir.join("short.cube");
    let lines: Vec<String> = cube(17, |r, g, b| [r, g, b], "").lines().map(String::from).collect();
    std::fs::write(&short, lines[..lines.len() - 39].join("\n")).unwrap();
    let one_d = dir.join("curve1d.cube");
    std::fs::write(&one_d, "LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1\n").unwrap();

    let mut h = open(&dir);
    on(&mut h, 1, 5.0);
    h.run_steps(3);
    let before = middle(&mut h);
    let steps0 = steps(h.state());
    answer(&dialog, &invert);
    h.get_by_label("Browse…").click();
    until(&mut h, "the Look is set", |s| lumetri(s, 1).is_some_and(|p| p.contains_key("lut")));
    let p = lumetri(h.state(), 1).unwrap();
    let id = p["lut"].as_str().unwrap().to_owned();
    let entry =
        h.state().app.project().luts.as_ref().and_then(|l| l.get(&id)).cloned().expect("the LUT is in the project");
    assert_eq!((entry["size"].as_u64(), entry["name"].as_str()), (Some(17), Some("invert.cube")));
    assert_eq!(steps(h.state()), steps0 + 1, "loading the Look is one undo step");
    let inv = middle(&mut h);
    eprintln!("the inverting look: {before:?} -> {inv:?}");
    assert!((62..=66).contains(&inv[0]) && inv[1] >= 253 && inv[2] >= 253, "the 75% red turns cyan");
    shot(&mut h, "lut");

    for (file, want) in [
        (&short, "The LUT has 4874 data lines; LUT_3D_SIZE 17 needs 4913."),
        (&one_d, "1D LUTs are not supported. Load a 3D LUT (LUT_3D_SIZE)."),
    ] {
        answer(&dialog, file);
        h.get_by_label("Browse…").click();
        until(&mut h, "the refusal shows", |s| s.features.fx.color.look.error.is_some());
        let shown = h.state().features.fx.color.look.error.clone().unwrap();
        let name = file.file_name().unwrap().to_string_lossy();
        eprintln!("refused: {shown}");
        assert_eq!(shown, format!("{name}: {want}"));
        assert_eq!(steps(h.state()), steps0 + 1, "nothing changed");
        assert_eq!(lumetri(h.state(), 1).unwrap()["lut"].as_str(), Some(id.as_str()));
        h.state_mut().features.fx.color.look.error = None;
    }
    assert!(h.state_mut().app.undo());
    assert!(lumetri(h.state(), 1).is_none(), "undo takes the Look and its Lumetri Color away");
    assert!(h.state().app.project().luts.as_ref().and_then(Json::as_object).is_none_or(|l| l.is_empty()));
    assert_eq!(middle(&mut h), before, "and the red is back");
}

#[test]
fn the_scopes_fill_for_a_picture_drawn_before_they_were_shown() {
    // The Color workspace opened on a picture already on the Program monitor: no time, edit or input follows. This
    // harness draws a frame at every step, so it shows that the count comes with nothing changing, not that an idle
    // window asks for the frames it takes (`RETRY` in scopes/mod.rs: seen in the running app, where the scopes stayed
    // empty until the pointer moved).
    let dir = folder("scopes-first");
    let mut h = open(&dir);
    until(&mut h, "the scopes of the picture that was there", |s| s.features.fx.scopes.last.is_some());
    assert!(h.state().features.fx.scopes.count >= 1);
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
