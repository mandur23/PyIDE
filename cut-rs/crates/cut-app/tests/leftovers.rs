//! The editor's smaller pieces of round three, in the real window run headless (egui_kittest on the PC's GPU) where
//! something shows: the Program monitor's trim view while an edit point rolls (`ui-monitors.js showTrim`), the
//! frequency response above the equalizer in Effect Controls (`ui-audiofx.js responseView`), an effect dragged from
//! the Effects panel onto Effect Controls and an effect's header dragged to reorder (`ui-controls.js`), the Clip
//! Mismatch question (`ui-project.js matchSequence`), the Caption Style dialog's list of the system's fonts, and
//! `cut.speech.markUncertain`; without a window, new projects taking the Preferences' default lengths.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::i18n::tr;
use cut_app::shell::Shell;
use cut_model::commands::build as C;
use cut_model::{History, Id};
use cut_time::{TICKS, Ticks};
use eframe::egui::{self, Color32, Modifiers, Pos2, Rect, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::{Value as Json, json};

type H = Harness<'static, Shell>;

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-leftovers-{name}-{}", std::process::id()));
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
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// Steps until the Program monitor's picture is the exact one.
fn settle(h: &mut H) {
    h.step();
    let start = Instant::now();
    while !h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete) && start.elapsed().as_secs() < 20 {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..3 {
        h.step();
    }
}

/// The editor on a project `build` makes, in English, 1280 x 800, the playhead at `t` seconds.
fn open(dir: &Path, t: f64, build: impl FnOnce(&mut History, &str)) -> H {
    let mut hist = cut_app::doc::fresh_history();
    let seq = hist.project().sequences[0].id.as_str().to_owned();
    build(&mut hist, &seq);
    let file = dir.join("leftovers.ncut");
    std::fs::write(&file, hist.serialize()).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    s.app.set_time(secs(t));
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

fn apply(h: &mut History, cmd: Json) -> Json {
    h.apply(&cmd).unwrap_or_else(|e| panic!("{cmd}: {}", e.message))
}

fn solid(h: &mut History, seq: &str, at: f64, len: f64, color: &str) -> Id {
    let r = apply(
        h,
        json!({ "type": "addGenerated", "seqId": seq, "opts": {
            "source": { "generator": "solid", "color": color }, "at": secs(at), "duration": secs(len), "track": "V1", "name": color,
        } }),
    );
    Id::new(r["id"].as_str().unwrap())
}

fn button(h: &mut H, p: Pos2, pressed: bool) {
    h.event(egui::Event::PointerButton {
        pos: p,
        button: egui::PointerButton::Primary,
        pressed,
        modifiers: Modifiers::NONE,
    });
    h.step();
}

/// A press at `from` moved to `to` in steps, not released.
fn hold_drag(h: &mut H, from: Pos2, to: Pos2) {
    h.hover_at(from);
    h.step();
    button(h, from, true);
    for i in 1..=10 {
        h.hover_at(from + (to - from) * (i as f32 / 10.0));
        h.step();
    }
}

fn drag(h: &mut H, from: Pos2, to: Pos2) {
    hold_drag(h, from, to);
    button(h, to, false);
    h.step();
}

fn click(h: &mut H, p: Pos2) {
    h.hover_at(p);
    h.step();
    button(h, p, true);
    button(h, p, false);
    h.step();
}

/// The screen point at `t` seconds on `track`, `k` of the way down its row.
fn pt(h: &H, t: f64, track: &str, k: f32) -> Pos2 {
    let tl = &h.state().timeline;
    let l = tl.direct.lanes.expect("the timeline drew its lanes");
    let r = tl.layout().rows.iter().find(|r| r.id.is_some_and(|i| i.as_str() == track)).expect("the track's row");
    pos2(l.left() + tl.view.x_of(secs(t)) as f32, l.top() + r.y - tl.view.scroll_y + r.h * k)
}

/// The window's pixel at `p` (points).
fn pixel(img: &image::RgbaImage, ppp: f32, p: Pos2) -> [u8; 3] {
    let c = img.get_pixel((p.x * ppp) as u32, (p.y * ppp) as u32).0;
    [c[0], c[1], c[2]]
}

fn picture(h: &mut H) -> (image::RgbaImage, f32) {
    h.hover_at(pos2(2.0, 790.0));
    h.step();
    let ppp = h.ctx.pixels_per_point();
    (h.render().expect("a picture of the window"), ppp)
}

fn label(h: &H) -> String {
    h.state().app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

#[test]
fn the_program_monitor_shows_both_sides_of_a_rolling_edit() {
    let dir = scratch("trim");
    let mut h = open(&dir, 1.0, |hist, seq| {
        solid(hist, seq, 0.0, 4.0, "#ffffff");
        solid(hist, seq, 4.0, 4.0, "#000000");
    });
    let ctx = h.ctx.clone();
    h.state_mut().run_action("tool.roll", &ctx);
    h.step();
    let (from, to) = (pt(&h, 4.0, "V1", 0.5), pt(&h, 5.0, "V1", 0.5));
    hold_drag(&mut h, from, to);
    let times = h.state().timeline.trim_view.expect("the trim view shows while the edit point rolls");
    let f = TICKS / 30;
    let at = h.state().app.sequence().unwrap().clips().find(|c| c.start > 0).unwrap().start;
    assert_eq!(times, [Some(at - f), Some(at)], "the frames on either side of the edit point now");
    assert!((at - secs(5.0)).abs() <= f, "the edit point followed the pointer ({at})");
    // the two pictures drawn: the outgoing clip's last frame white, the incoming first black
    let start = Instant::now();
    while !h
        .state()
        .monitors
        .as_ref()
        .and_then(|m| m.trim_screens.as_ref())
        .is_some_and(|t| t.iter().all(|x| x.stats.complete))
        && start.elapsed() < Duration::from_secs(20)
    {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.step();
    let rects: Vec<Rect> =
        h.state().monitors.as_ref().unwrap().trim_screens.as_ref().unwrap().iter().map(|s| s.rect).collect();
    let img = h.render().expect("a picture");
    let ppp = h.ctx.pixels_per_point();
    let (l, r) = (pixel(&img, ppp, rects[0].center()), pixel(&img, ppp, rects[1].center()));
    eprintln!("trim view: left {l:?} at {:?}, right {r:?} at {:?}", rects[0], rects[1]);
    assert!(rects[0].right() < rects[1].left() && rects[0].width() > 50.0, "side by side");
    assert!(l.iter().all(|v| *v > 240) && r.iter().all(|v| *v < 20), "white on the left, black on the right");
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        img.save(Path::new(&d).join("trim-view.png")).unwrap();
    }
    button(&mut h, to, false);
    h.step();
    assert!(h.state().timeline.trim_view.is_none(), "the trim view goes when the drag ends");
    assert_eq!(label(&h), "Trim", "the roll is one undo step");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The rows of the graph's rect whose pixel in column `x` is near `c`.
fn curve_rows(img: &image::RgbaImage, ppp: f32, r: Rect, x: f32, c: Color32) -> Vec<f32> {
    let mut out = Vec::new();
    let mut y = r.top() + 1.0;
    while y < r.bottom() - 1.0 {
        let p = pixel(img, ppp, pos2(x, y));
        let d = (i32::from(p[0]) - i32::from(c.r())).abs()
            + (i32::from(p[1]) - i32::from(c.g())).abs()
            + (i32::from(p[2]) - i32::from(c.b())).abs();
        if d < 60 {
            out.push(y);
        }
        y += 0.5;
    }
    out
}

#[test]
fn effect_controls_draws_the_equalizers_frequency_response() {
    let dir = scratch("eq");
    let tone = cut_app::import::probe_file(&media::tone_aac()).result.unwrap();
    let mut h = open(&dir, 1.0, |hist, seq| {
        let r = apply(hist, C::import_media(json!([tone]), None));
        let m = r["ids"][0].as_str().unwrap();
        let r = apply(
            hist,
            json!({ "type": "place", "seqId": seq, "opts": { "source": { "media": m }, "at": 0, "video": null, "audio": "A1", "mode": "overwrite" } }),
        );
        let c = r["ids"][0].as_str().unwrap();
        apply(hist, C::add_effect(seq, c, "audio.eq", None, json!({ "b2Gain": 12 })));
    });
    let clip = h.state().app.sequence().unwrap().clips().next().unwrap().id;
    let eid = h.state().app.sequence().unwrap().clip(clip).unwrap().effects[0].id;
    h.state_mut().app.select([clip], false, false);
    h.state_mut().features.workspace.open_panel("controls");
    for _ in 0..4 {
        h.step();
    }
    // Volume, Panner and Speed folded so the equalizer's section is in view
    for sec in ["volume", "panner", "speed"] {
        let r = h.state().features.controls.rect(&format!("sec:{sec}:{clip}/head")).expect("the section's header");
        click(&mut h, pos2(r.left() + 14.0, r.center().y));
    }
    let name = format!("graph:{}", eid.as_str());
    let rect = h.state().features.controls.rect(&name).expect("the equalizer's graph is drawn above its rows");
    assert!((rect.height() - cut_app::audio::response::HEIGHT).abs() < 1.0, "96 points tall");
    let x_of = |f: f64| rect.left() + ((f / 20.0).log10() / 1000f64.log10() * f64::from(rect.width())) as f32;
    let y_of = |d: f64| {
        rect.top() + (f64::from(rect.height()) / 2.0 - d / 24.0 * (f64::from(rect.height()) / 2.0 - 4.0)) as f32
    };
    let accent = h.state().palette.accent;
    let (img, ppp) = picture(&mut h);
    let at_1k = curve_rows(&img, ppp, rect, x_of(1000.0), accent);
    let at_40 = curve_rows(&img, ppp, rect, x_of(40.0), accent);
    eprintln!("curve at 1 kHz {at_1k:?} (+12 dB at {}), at 40 Hz {at_40:?} (0 dB at {})", y_of(12.0), y_of(0.0));
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        img.save(Path::new(&d).join("eq-graph.png")).unwrap();
    }
    assert!(at_1k.iter().any(|y| (y - y_of(12.0)).abs() < 3.0), "the bell reaches +12 dB at 1 kHz");
    assert!(
        at_40.iter().any(|y| (y - y_of(0.0)).abs() < 3.0) && !at_40.iter().any(|y| (y - y_of(12.0)).abs() < 6.0),
        "flat far below it"
    );
    // a keyframe at the playhead moves the band: the graph shows the value there
    let seq = h.state().app.sequence_id.unwrap();
    let path = format!("effects.{}.b2Gain", eid.as_str());
    let keys = json!([{ "t": 0, "v": -12, "ease": "linear" }, { "t": secs(4.0), "v": -12, "ease": "linear" }]);
    h.state_mut().app.exec(&C::set_keyframes(seq.as_str(), clip.as_str(), &path, Some(keys))).unwrap();
    for _ in 0..3 {
        h.step();
    }
    let (img, ppp) = picture(&mut h);
    assert!(
        curve_rows(&img, ppp, rect, x_of(1000.0), accent).iter().any(|y| (y - y_of(-12.0)).abs() < 3.0),
        "a dip of 12 dB now"
    );
    // switched off, the curve is drawn in the text grey, not the accent
    h.state_mut().app.exec(&C::set_effect(seq.as_str(), clip.as_str(), eid.as_str(), json!({ "on": false }))).unwrap();
    for _ in 0..3 {
        h.step();
    }
    let (img, ppp) = picture(&mut h);
    assert!(
        curve_rows(&img, ppp, rect, x_of(1000.0), accent).is_empty(),
        "an effect switched off draws no accent curve"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_effect_dragged_onto_effect_controls_and_a_header_dragged_to_reorder() {
    let dir = scratch("fxdrop");
    let mut h = open(&dir, 1.0, |hist, seq| {
        solid(hist, seq, 0.0, 4.0, "#ffffff");
    });
    let clip = h.state().app.sequence().unwrap().clips().next().unwrap().id;
    h.state_mut().app.select([clip], false, false);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.effects", &ctx);
    h.state_mut().features.fx.effects.search = "Invert".into();
    for _ in 0..4 {
        h.step();
    }
    let row = h.get_all_by_label(&tr("Invert")).next().expect("the Effects panel lists Invert").rect().center();
    let panel = h.state().features.controls.rect("sec:motion/head").expect("Effect Controls shows the clip").center();
    let steps = h.state().app.history.position();
    drag(&mut h, row, panel + egui::vec2(0.0, 60.0));
    let kinds = |h: &H| -> Vec<String> {
        h.state().app.sequence().unwrap().clip(clip).unwrap().effects.iter().map(|e| e.kind.clone()).collect()
    };
    assert_eq!(kinds(&h), ["color.invert"], "Invert dropped on Effect Controls goes on the clip shown");
    assert_eq!(h.state().app.history.position(), steps + 1, "in one step");
    settle(&mut h);
    let m = h.state().monitors.as_ref().unwrap().program.rect;
    let (img, ppp) = picture(&mut h);
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        img.save(Path::new(&d).join("effect-dropped.png")).unwrap();
    }
    let px = pixel(&img, ppp, pos2(m.left() + m.width() * 0.25, m.top() + m.height() * 0.75));
    assert!(px.iter().all(|v| *v < 20), "the white solid is drawn inverted ({px:?} at {m:?})");
    // a second effect, then its header dragged above the first
    h.state_mut().features.fx.effects.search = "Black & White".into();
    for _ in 0..3 {
        h.step();
    }
    let row =
        h.get_all_by_label(&tr("Black & White")).next().expect("the Effects panel lists Black & White").rect().center();
    drag(&mut h, row, panel + egui::vec2(0.0, 60.0));
    assert_eq!(kinds(&h), ["color.invert", "color.bw"], "the second effect goes after the first");
    let fx = h.state().app.sequence().unwrap().clip(clip).unwrap().effects.iter().map(|e| e.id).collect::<Vec<_>>();
    // every section but the second effect's folded, so both effects' headers are in view
    let names = ["motion".to_owned(), "opacity".to_owned(), "crop".to_owned(), format!("fx:{clip}:{}", fx[0])];
    for sec in names {
        let r = h.state().features.controls.rect(&format!("sec:{sec}/head")).unwrap();
        click(&mut h, pos2(r.left() + 14.0, r.center().y));
    }
    let head = |h: &H, e: Id| h.state().features.controls.rect(&format!("sec:fx:{clip}:{e}/head")).expect("the header");
    let (first, second) = (head(&h, fx[0]), head(&h, fx[1]));
    let steps = h.state().app.history.position();
    drag(&mut h, pos2(second.center().x + 40.0, second.center().y), pos2(first.center().x + 40.0, first.top() + 3.0));
    assert_eq!(kinds(&h), ["color.bw", "color.invert"], "the header dragged above the first moves its effect there");
    assert_eq!(h.state().app.history.position(), steps + 1, "one step");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_clip_that_differs_from_the_sequence_asks_once() {
    let dir = scratch("mismatch");
    let v720 = cut_app::import::probe_file(&media::h264_720p()).result.unwrap();
    let v1080 = cut_app::import::probe_file(&media::h264_1080p()).result.unwrap();
    let mut h = open(&dir, 0.0, |hist, _| {
        apply(hist, C::import_media(json!([v720, v1080]), None));
    });
    let media: Vec<Id> = h.state().app.project().media.iter().map(|m| m.id).collect();
    let ctx = h.ctx.clone();
    let source = |h: &mut H, m: Id, at: f64| {
        let s = h.state_mut();
        s.app.edit.source.open(cut_app::edit::source::SourceClip {
            item: cut_app::edit::source::SourceItem::Media(m),
            in_: Some(0),
            out: Some(secs(1.0)),
            t: 0,
        });
        s.app.set_time(secs(at));
    };
    // the empty sequence takes the first clip's settings without asking
    source(&mut h, media[0], 0.0);
    h.state_mut().run_action("overwrite", &ctx);
    h.step();
    let sq = |h: &H| {
        let s = h.state().app.sequence().unwrap();
        (s.w, s.h, s.fps.num, s.fps.den)
    };
    assert_eq!(sq(&h), (1280, 720, 30, 1), "an empty sequence follows its first clip");
    assert!(h.state().app.edit.mismatch.open.is_none());
    // a 1080p clip into it: the question, its words, and nothing placed until it is answered
    source(&mut h, media[1], 1.0);
    h.state_mut().run_action("overwrite", &ctx);
    h.step();
    h.step();
    let text = tr("This clip does not match the sequence settings ({clip}). Change the sequence to match the clip?")
        .replace("{clip}", "1920x1080 30 fps");
    assert!(h.query_by_label(&text).is_some(), "Clip Mismatch asks: {text}");
    assert_eq!(h.state().app.sequence().unwrap().clips().count(), 1, "the clip waits for the answer");
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        h.render().unwrap().save(Path::new(&d).join("clip-mismatch.png")).unwrap();
    }
    h.get_by_label(&tr("Change Sequence Settings")).click();
    h.step();
    h.step();
    assert_eq!(sq(&h), (1920, 1080, 30, 1), "Change Sequence Settings takes the clip's");
    assert_eq!(h.state().app.sequence().unwrap().clips().count(), 2, "and the clip is placed");
    // asked once a sequence: the 720p clip again goes in without a question
    source(&mut h, media[0], 2.0);
    h.state_mut().run_action("overwrite", &ctx);
    h.step();
    assert!(h.state().app.edit.mismatch.open.is_none() && h.state().app.sequence().unwrap().clips().count() == 3);
    // a timeline drop makes the change and the placement one undo step
    let new_seq = h.state_mut().app.exec(&C::add_sequence(json!({ "name": "B" }))).unwrap();
    let id = Id::new(new_seq["id"].as_str().unwrap());
    h.state_mut().app.set_sequence(id);
    let steps = h.state().app.history.position();
    let m = media[0];
    cut_app::edit::mismatch::before(
        &mut h.state_mut().app,
        Some(m),
        Some("Place"),
        move |app: &mut cut_app::state::App| {
            let seq = app.sequence_id.unwrap();
            app.exec(&cut_app::cmd::place(seq, m, Some(Id::new("V1")), None, 0, "overwrite"));
        },
    );
    assert_eq!((h.state().app.history.position(), label(&h)), (steps + 1, "Place".to_owned()), "one step");
    assert_eq!(sq(&h), (1280, 720, 30, 1));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn caption_style_lists_the_systems_fonts_and_doubtful_words_follow_the_setting() {
    let dir = scratch("captions");
    let mut h = open(&dir, 1.0, |_, _| {});
    let srt = dir.join("a.srt");
    std::fs::write(&srt, "1\r\n00:00:00,000 --> 00:00:03,000\r\nHello world\r\n").unwrap();
    cut_app::captions::files::import_file(h.state_mut(), &srt, true);
    let seq = h.state().app.sequence_id.unwrap();
    let (track, item) = {
        let t = &h.state().app.sequence().unwrap().captions[0];
        (t.id, t.items[0].id)
    };
    let doubt = json!({ "doubt": [{ "text": "world", "at": secs(1.0), "p": 0.4 }] });
    h.state_mut().app.exec(&C::set_caption(seq.as_str(), track.as_str(), item.as_str(), doubt)).unwrap();
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.captions", &ctx);
    for _ in 0..3 {
        h.step();
    }
    let unsure = tr("{n} captions, {u} with uncertain words").replace("{n}", "1").replace("{u}", "1");
    assert!(h.query_by_label(&unsure).is_some(), "the doubtful word is marked by default");
    h.state_mut().doc.settings.set("speech.markUncertain", json!(false));
    for _ in 0..2 {
        h.step();
    }
    assert!(h.query_by_label(&unsure).is_none(), "with cut.speech.markUncertain off it is not");
    assert!(h.query_by_label(&tr("{n} captions").replace("{n}", "1")).is_some());
    // Caption Style: the font is picked from the installed families
    h.state_mut().run_action("captions.style", &ctx);
    assert!(until(&mut h, 20, |s| s.features.text.panel.fonts.is_some()), "the families are read on a thread");
    h.step();
    h.step();
    // the first list of the dialog is the font's, showing the track's family by its label
    let combo = h.get_all_by_role(egui::accesskit::Role::ComboBox).next().expect("the font list").rect();
    assert!(combo.width() > 0.0);
    click(&mut h, combo.center());
    h.step();
    let arial = h.get_all_by_label("Arial").next().expect("the list has Arial").rect().center();
    click(&mut h, arial);
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        h.render().unwrap().save(Path::new(&d).join("caption-style.png")).unwrap();
    }
    h.get_by_label(&tr("OK")).click();
    h.step();
    let font = h.state().app.sequence().unwrap().captions[0].style.get("font").cloned();
    assert_eq!(font, Some(json!("Arial")), "OK sets the chosen family");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn new_projects_take_the_default_lengths_of_the_preferences() {
    let dir = scratch("defaults");
    std::fs::create_dir_all(dir.join("home")).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    let t = |s: &Shell, k: &str| s.app.project().settings.get(k).and_then(Json::as_i64);
    assert_eq!((t(&s, "transitionDuration"), t(&s, "stillDuration")), (Some(TICKS), Some(5 * TICKS)), "the defaults");
    cut_app::prefs::set(&mut s, "transitionSeconds", json!(0.5));
    cut_app::prefs::set(&mut s, "stillSeconds", json!(3));
    let ctx = egui::Context::default();
    s.run_action("newProject", &ctx);
    assert_eq!(
        (t(&s, "transitionDuration"), t(&s, "stillDuration")),
        (Some(TICKS / 2), Some(3 * TICKS)),
        "File > New > Project takes the lengths set in the Preferences"
    );
    drop(s);
    // and a new start too
    let s = Shell::new(Home::at(dir.join("home")));
    assert_eq!((t(&s, "transitionDuration"), t(&s, "stillDuration")), (Some(TICKS / 2), Some(3 * TICKS)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn color_matte_safe_margins_remove_unused_and_track_volume() {
    let dir = scratch("items");
    let png = dir.join("unused.png");
    image::RgbImage::from_pixel(32, 18, image::Rgb([10, 200, 10])).save(&png).unwrap();
    let mut h = open(&dir, 1.0, |hist, seq| {
        solid(hist, seq, 0.0, 4.0, "#000000");
        apply(hist, C::import_media(json!([cut_app::import::probe_file(&png).result.unwrap()]), None));
    });
    let ctx = h.ctx.clone();
    // Graphics and Titles > New Layer > Color Matte: a blue solid at the playhead, selected, one step
    let steps = h.state().app.history.position();
    h.state_mut().run_action("graphics.colorMatte", &ctx);
    let id = *h.state().app.selection.iter().next().expect("the matte is selected");
    let c = h.state().app.sequence().unwrap().clip(id).unwrap().clone();
    assert_eq!(
        (c.start, h.state().app.history.position(), label(&h)),
        (secs(1.0), steps + 1, "Add Graphic".to_owned()),
        "{c:?}"
    );
    assert!(serde_json::to_string(&c.source).unwrap().contains("#2f6fdb"), "a Color Matte in blue: {:?}", c.source);
    h.state_mut().app.undo();
    // View > Safe Margins: the action-safe line 3.5 % in from the picture's edge, over the black solid
    cut_app::prefs::set(h.state_mut(), "program.safe", json!(true));
    settle(&mut h);
    let m = h.state().monitors.as_ref().unwrap().program.rect;
    let (img, ppp) = picture(&mut h);
    let x = m.left() + m.width() * 0.035;
    let line = (-2..=2).map(|d| pixel(&img, ppp, pos2(x + d as f32 * 0.5, m.center().y))[1]).max().unwrap();
    let inside = pixel(&img, ppp, pos2(m.left() + m.width() * 0.2, m.center().y))[1];
    assert!(line > 90 && inside < 20, "a light line over the black picture ({line}), black inside ({inside})");
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        img.save(Path::new(&d).join("safe-margins.png")).unwrap();
    }
    // Edit > Remove Unused…: the PNG no clip uses, after the question
    h.state_mut().run_action("removeUnused", &ctx);
    for _ in 0..3 {
        h.step();
    }
    assert_eq!(h.state().project.new_item.unused.as_ref().map(Vec::len), Some(1), "one unused item is listed");
    h.get_by_label(&tr("Remove")).click();
    h.step();
    h.step();
    assert!(h.state().app.project().media.is_empty(), "it is removed from the project");
    assert!(png.is_file(), "the file stays where it is");
    // the track menu's Track Volume: the header's percentages and Set Volume…
    assert_eq!(cut_app::timeline::editing::track_db(50.0), -6.02);
    assert_eq!(cut_app::timeline::editing::track_db(0.0), -144.0);
    assert_eq!(cut_app::timeline::editing::track_db(250.0), 6.02, "kept within 200 %");
    assert!((cut_app::timeline::editing::track_percent(-6.02) - 50.0).abs() < 0.1);
    // the header's free strip under its buttons
    let p = pt(&h, 0.5, "A1", 0.75);
    let head = pos2(h.state().timeline.direct.lanes.unwrap().left() - 90.0, p.y);
    h.hover_at(head);
    h.step();
    h.event(egui::Event::PointerButton {
        pos: head,
        button: egui::PointerButton::Secondary,
        pressed: true,
        modifiers: Modifiers::NONE,
    });
    h.step();
    h.event(egui::Event::PointerButton {
        pos: head,
        button: egui::PointerButton::Secondary,
        pressed: false,
        modifiers: Modifiers::NONE,
    });
    for _ in 0..3 {
        h.step();
    }
    if let Ok(d) = std::env::var("CUT_LEFTOVER_SHOTS") {
        h.render().unwrap().save(Path::new(&d).join("track-menu.png")).unwrap();
    }
    h.get_by_label(&tr("Track Volume")).hover();
    h.step();
    h.step();
    h.get_by_label("     50%").click();
    h.step();
    let vol = h.state().app.sequence().unwrap().track(Id::new("A1")).unwrap().volume;
    assert_eq!(vol, Some(-6.02), "A1 at 50 %");
    let _ = std::fs::remove_dir_all(&dir);
}
