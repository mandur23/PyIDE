//! The Type tool, the Text panel, the shortcut editor, proxies and relinking in the real window, run headless
//! (egui_kittest on the PC's GPU) with pointer, key, text and IME events, checked in the project, the settings file
//! and the window's own pixels where the Program monitor drew its picture.

#[path = "media/mod.rs"]
mod media;

use std::path::Path;
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::prefs::{self, Screen, keymap, relink};
use cut_app::shell::Shell;
use cut_app::state::{Panel, Tool};
use cut_model::Id;
use cut_time::TICKS;
use eframe::egui::{self, Key, Modifiers, Pos2, pos2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

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

fn settle(h: &mut Harness<'_, Shell>) {
    let start = Instant::now();
    loop {
        h.step();
        if h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete) || start.elapsed().as_secs() > 20 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // the rasteriser thread hands the text picture over a frame or two later
    for _ in 0..6 {
        h.step();
        std::thread::sleep(Duration::from_millis(15));
    }
    while !h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete) {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    h.step();
}

/// A workspace in a scratch home: a white solid on V1 for `white` seconds (none when 0), the playhead at 1 s.
fn open(name: &str, white: i64) -> (Harness<'static, Shell>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("cut-app-text-prefs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let h = shell_at(&dir, white);
    (h, dir)
}

fn shell_at(dir: &Path, white: i64) -> Harness<'static, Shell> {
    let mut hist = cut_app::doc::fresh_history();
    let seq = hist.project().sequences[0].id;
    if white > 0 {
        hist.apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
            "source": { "generator": "solid", "color": "#ffffff" }, "at": 0, "duration": white * TICKS, "track": "V1", "name": "White",
        } }))
        .expect("the solid");
    }
    let file = dir.join("text.ncut");
    std::fs::write(&file, hist.serialize()).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    s.app.set_time(TICKS);
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the window gave the monitors its GPU device");
    h.state_mut().transport.set_output_gain(0.0);
    settle(&mut h);
    h
}

/// The screen point (points) of a sequence pixel.
fn at(h: &Harness<'_, Shell>, x: f64, y: f64) -> Pos2 {
    let r = h.state().monitors.as_ref().unwrap().program.rect;
    let k = f64::from(r.width()) / 1920.0;
    pos2(r.left() + (x * k) as f32, r.top() + (y * k) as f32)
}

/// The highest and the mean luma of the window over a box of sequence pixels (the pointer moved out of the way).
fn luma(h: &mut Harness<'_, Shell>, x0: f64, y0: f64, x1: f64, y1: f64) -> (u8, f64) {
    h.hover_at(pos2(2.0, 790.0));
    h.step();
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    let (a, b) = (at(h, x0, y0), at(h, x1, y1));
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

fn click(h: &mut Harness<'_, Shell>, p: Pos2) {
    h.hover_at(p);
    h.step();
    for pressed in [true, false] {
        h.event(egui::Event::PointerButton {
            pos: p,
            button: egui::PointerButton::Primary,
            pressed,
            modifiers: Modifiers::NONE,
        });
        h.step();
    }
}

fn key(h: &mut Harness<'_, Shell>, k: Key, modifiers: Modifiers) {
    for pressed in [true, false] {
        h.event(egui::Event::Key { key: k, physical_key: None, pressed, repeat: false, modifiers });
        h.step();
    }
}

/// The text of the first layer of a clip.
fn text_of(s: &Shell, clip: Id) -> Option<String> {
    let c = s.app.sequence()?.clip(clip)?;
    cut_app::text_ui::layers(c).first()?.get("text")?.as_str().map(str::to_owned)
}

fn last_label(s: &Shell) -> String {
    s.app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

#[test]
fn a_text_made_with_the_type_tool_shows_in_the_frame_and_undoes_whole() {
    let (mut h, dir) = open("type", 0);
    let before = luma(&mut h, 700.0, 250.0, 1220.0, 350.0);
    assert!(before.0 < 20, "the frame is black first ({before:?})");
    let steps = h.state().app.history.position();
    let ctx = h.ctx.clone();
    h.state_mut().run_action("tool.text", &ctx);
    assert_eq!(h.state().app.tool, Tool::Text);
    let p = at(&h, 960.0, 300.0);
    click(&mut h, p);
    let clip =
        h.state().features.text.editor.as_ref().map(|e| e.clip).expect("the click made a text clip and edits it");
    assert!(h.state().app.selection.contains(&clip) && h.state().app.history.grouping(), "selected, in an open step");
    for _ in 0..3 {
        h.step();
    }
    h.event(egui::Event::Text("HELLO".into()));
    settle(&mut h);
    assert_eq!(text_of(h.state(), clip).as_deref(), Some("HELLO"), "typing reaches the layer");
    let shown = luma(&mut h, 700.0, 250.0, 1220.0, 350.0);
    eprintln!("the typed text on the monitor: {shown:?}");
    assert!(shown.0 > 200 && shown.1 > 15.0, "the typed text is drawn where it was clicked ({shown:?})");
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    let pos = cut_app::text_ui::layers(&c)[0]["position"].clone();
    assert_eq!((pos[0].as_f64(), pos[1].as_f64()), (Some(0.0), Some(-240.0)), "the layer sits where the click was");
    key(&mut h, Key::Escape, Modifiers::NONE);
    assert!(h.state().features.text.editor.is_none(), "Escape closes the editor");
    assert_eq!(h.state().app.history.position(), steps + 1, "the visit is one step");
    assert_eq!(last_label(h.state()), "Add Graphic");
    assert_eq!(h.state().app.tool, Tool::Select, "the Type tool hands back the Selection tool");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("undo", &ctx);
    settle(&mut h);
    assert!(h.state().app.sequence().unwrap().clip(clip).is_none(), "undo takes the clip away");
    let gone = luma(&mut h, 700.0, 250.0, 1220.0, 350.0);
    save(&mut h, "type-undone");
    assert!(gone.0 < 20, "and the text with it ({gone:?})");
    h.state_mut().run_action("redo", &ctx);
    settle(&mut h);
    assert_eq!(text_of(h.state(), clip).as_deref(), Some("HELLO"), "redo brings it back");
    assert!(luma(&mut h, 700.0, 250.0, 1220.0, 350.0).0 > 200);
    // a click with the Type tool on the selected text edits it; an empty new text is taken back whole
    h.state_mut().app.select([clip], false, false);
    h.state_mut().run_action("tool.text", &ctx);
    let p = at(&h, 960.0, 300.0);
    click(&mut h, p);
    assert_eq!(
        h.state().features.text.editor.as_ref().map(|e| (e.clip, e.created)),
        Some((clip, false)),
        "a click on the text edits it"
    );
    key(&mut h, Key::Escape, Modifiers::NONE);
    let n = h.state().app.sequence().unwrap().clips().count();
    let pos0 = h.state().app.history.position();
    h.state_mut().run_action("tool.text", &ctx);
    let p = at(&h, 300.0, 900.0);
    click(&mut h, p);
    assert!(h.state().features.text.editor.as_ref().is_some_and(|e| e.created));
    key(&mut h, Key::Escape, Modifiers::NONE);
    assert_eq!(
        (h.state().app.sequence().unwrap().clips().count(), h.state().app.history.position()),
        (n, pos0),
        "an empty new text leaves nothing"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hangul_composed_by_the_ime_reaches_the_model_and_the_picture() {
    let (mut h, dir) = open("ime", 0);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("tool.text", &ctx);
    let p = at(&h, 960.0, 540.0);
    click(&mut h, p);
    let clip = h.state().features.text.editor.as_ref().map(|e| e.clip).expect("an editor");
    for _ in 0..3 {
        h.step();
    }
    let pre = |t: &str| egui::Event::Ime(egui::ImeEvent::Preedit { text: t.into(), active_range_chars: None });
    // 한: ㅎ, 하, 한 composing, then committed; 글 the same
    for e in [pre("ㅎ"), pre("하"), pre("한")] {
        h.event(e);
        h.step();
    }
    assert_eq!(text_of(h.state(), clip).as_deref(), Some("한"), "the composing syllable is drawn as it composes");
    assert!(h.state().app.history.grouping(), "and nothing is recorded yet");
    h.event(egui::Event::Ime(egui::ImeEvent::Commit("한".into())));
    h.step();
    for e in [pre("ㄱ"), pre("그"), pre("글")] {
        h.event(e);
        h.step();
    }
    h.event(egui::Event::Ime(egui::ImeEvent::Commit("글".into())));
    settle(&mut h);
    assert_eq!(text_of(h.state(), clip).as_deref(), Some("한글"), "the committed Hangul is the layer's text");
    let shown = luma(&mut h, 760.0, 460.0, 1160.0, 620.0);
    eprintln!("한글 on the monitor: {shown:?}");
    assert!(shown.0 > 200 && shown.1 > 20.0, "two syllables drawn in the middle ({shown:?})");
    save(&mut h, "ime-hangul");
    let steps = h.state().app.history.position();
    key(&mut h, Key::Enter, Modifiers::CTRL);
    assert!(h.state().features.text.editor.is_none(), "Ctrl+Enter closes the editor");
    assert_eq!(h.state().app.history.position(), steps + 1, "one step for the visit");
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    assert_eq!(cut_app::text_ui::layers(&c)[0]["text"], "한글");
    let _ = std::fs::remove_dir_all(&dir);
}

fn save(h: &mut Harness<'_, Shell>, name: &str) {
    if let Ok(dir) = std::env::var("CUT_TEXT_SHOTS") {
        h.render().unwrap().save(Path::new(&dir).join(format!("{name}.png"))).unwrap();
    }
}

#[test]
fn the_text_panel_changes_the_picture_one_step_at_a_time() {
    let (mut h, dir) = open("panel", 6);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.captions", &ctx);
    settle(&mut h);
    h.get_by_label("New Text").click();
    settle(&mut h);
    let clip = cut_app::text_ui::text_clip(&h.state().app).map(|c| c.id).expect("New Text made a selected text clip");
    assert_eq!(text_of(h.state(), clip).as_deref(), Some("Title"));
    assert_eq!(last_label(h.state()), "Add Graphic");
    // white text on the white solid: the frame is all white
    let plain = luma(&mut h, 760.0, 470.0, 1160.0, 610.0);
    eprintln!("white on white: {plain:?}");
    let steps = h.state().app.history.position();
    h.get_all_by_label("Background").next().expect("the Background box").click();
    settle(&mut h);
    let boxed = luma(&mut h, 760.0, 470.0, 1160.0, 610.0);
    eprintln!("with the background box: {boxed:?}");
    assert!(plain.1 - boxed.1 > 30.0, "the dark box shows behind the text ({plain:?} -> {boxed:?})");
    assert_eq!(h.state().app.history.position(), steps + 1, "one step");
    save(&mut h, "panel-box");
    h.get_all_by_label("Background").next().expect("the Background box").click();
    h.get_all_by_label("Stroke").next().expect("the Stroke box").click();
    settle(&mut h);
    let stroked = luma(&mut h, 760.0, 470.0, 1160.0, 610.0);
    eprintln!("with the stroke: {stroked:?}");
    assert!(
        plain.1 - stroked.1 > 3.0 && stroked.1 > boxed.1,
        "the black outline shows around the letters ({stroked:?})"
    );
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    let l = &cut_app::text_ui::layers(&c)[0];
    assert!(l["box"].is_null() && l["stroke"] == json!({ "color": "#000000", "width": 4 }), "{l}");
    assert_eq!(h.state().app.history.position(), steps + 3, "each toggle one step");
    // a motion preset is one step of keyframes (a tall window, so the panel shows its last rows)
    h.set_size(egui::vec2(1280.0, 1800.0));
    settle(&mut h);
    h.get_all_by_label("Typewriter").next().expect("the In row's Typewriter").click();
    for _ in 0..3 {
        h.step();
    }
    let c = h.state().app.sequence().unwrap().clip(clip).unwrap().clone();
    assert!(c.keyframes.contains_key("layers.l1.reveal"), "Typewriter keyframes the reveal");
    assert_eq!(last_label(h.state()), "Motion Preset");
    h.state_mut().run_action("undo", &ctx);
    h.state_mut().run_action("undo", &ctx);
    settle(&mut h);
    let back = luma(&mut h, 760.0, 470.0, 1160.0, 610.0);
    assert!((back.1 - plain.1).abs() < 3.0, "undo brings the plain look back ({back:?})");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_rebound_key_works_at_once_and_after_a_restart_and_a_conflict_blocks_save() {
    let (mut h, dir) = open("keys", 6);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("keyboardShortcuts", &ctx);
    h.step();
    let set = |h: &mut Harness<'_, Shell>, f: &dyn Fn(&mut keymap::Draft)| {
        if let Some(Screen::Shortcuts(d)) = &mut h.state_mut().features.prefs.screen {
            f(d);
        }
    };
    set(&mut h, &|d| {
        d.query = "Add Marker".into();
        d.recording = Some("addMarker");
    });
    h.step();
    key(&mut h, Key::M, Modifiers::ALT | Modifiers::SHIFT);
    let draft = |h: &Harness<'_, Shell>| match &h.state().features.prefs.screen {
        Some(Screen::Shortcuts(d)) => Some(d.clone()),
        _ => None,
    };
    let d = draft(&h).expect("the editor stays open");
    assert_eq!(d.keys_of("addMarker"), ["M", "Alt+Shift+M"], "the pressed key joins the action");
    assert!(d.recording.is_none());
    // a key Add Edit has: marked, and Save does nothing
    set(&mut h, &|d| d.recording = Some("addMarker"));
    h.step();
    key(&mut h, Key::K, Modifiers::CTRL);
    let d = draft(&h).unwrap();
    assert!(
        d.conflicts()["Ctrl+K"].contains(&"split") && d.conflicts()["Ctrl+K"].contains(&"addMarker"),
        "Ctrl+K is Add Edit's too"
    );
    h.get_by_label("Keys used by more than one action: 1. Change or remove them to save.");
    h.get_by_label("Save").click();
    h.step();
    assert!(draft(&h).is_some(), "Save waits while the conflict stands");
    set(&mut h, &|d| d.remove("addMarker", "Ctrl+K"));
    h.step();
    h.get_by_label("Save").click();
    h.step();
    assert!(draft(&h).is_none(), "saved");
    let file = h.state().doc.settings.file().to_owned();
    let stored: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored[keymap::SETTING], json!({ "Cut.addMarker": ["M", "Alt+Shift+M"] }), "only the change is stored");
    // the key adds a marker at once
    h.state_mut().focus(Panel::Timeline);
    let markers = |s: &Shell| s.app.sequence().unwrap().markers.len();
    let m0 = markers(h.state());
    key(&mut h, Key::M, Modifiers::ALT | Modifiers::SHIFT);
    assert_eq!(markers(h.state()), m0 + 1, "the recorded key works without a restart");
    drop(h);
    // after a restart (a new window on the same workspace)
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    assert_eq!(cut_app::keys::current("addMarker", s.preset), ["M", "Alt+Shift+M"], "the keys are read back");
    s.doc.open(&mut s.app, &dir.join("text.ncut"), now_ms()).unwrap();
    s.app.set_time(2 * TICKS);
    let mut h = Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_eframe(move |_cc| s);
    h.step();
    h.state_mut().focus(Panel::Timeline);
    let m0 = markers(h.state());
    key(&mut h, Key::M, Modifiers::ALT | Modifiers::SHIFT);
    assert_eq!(markers(h.state()), m0 + 1, "and work after the restart");
    // the cheat sheet shows the current keys, Esc closes it
    let ctx = h.ctx.clone();
    h.state_mut().run_action("keyHelp", &ctx);
    for _ in 0..3 {
        h.step();
    }
    h.get_by_label("M  Alt+Shift+M");
    key(&mut h, Key::Escape, Modifiers::NONE);
    assert!(h.state().features.prefs.sheet.is_none(), "Esc closes the cheat sheet");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn preferences_reach_the_project_and_the_autosave() {
    let (mut h, dir) = open("prefs", 6);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("settings.timeline", &ctx);
    h.step();
    assert!(matches!(h.state().features.prefs.screen, Some(Screen::Settings(prefs::page::Page::Timeline))));
    let steps = h.state().app.history.position();
    prefs::set(h.state_mut(), "transitionSeconds", json!(2));
    prefs::apply_durations(h.state_mut());
    assert_eq!(h.state().app.project().settings["transitionDuration"], json!(2 * TICKS), "the open project follows");
    assert_eq!(h.state().app.history.position(), steps + 1);
    assert_eq!(last_label(h.state()), "Project Settings");
    assert_eq!(prefs::project_defaults(&h.state().doc.settings).0, 2 * TICKS);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A copy of the generated 720p clip (90 frames of frame numbers) in `dir`.
fn clip_copy(dir: &Path, name: &str) -> std::path::PathBuf {
    let to = dir.join(name);
    std::fs::create_dir_all(dir).unwrap();
    std::fs::copy(media::h264_720p(), &to).unwrap();
    to
}

#[test]
fn a_proxy_is_made_without_a_step_and_plays_when_the_original_is_gone() {
    let (mut h, dir) = open("proxy", 0);
    let file = clip_copy(&dir.join("media"), "p.mp4");
    h.state_mut().import_paths(vec![file.clone()], None);
    assert!(until(&mut h, 60, |s| s.app.project().media.len() == 1), "imported");
    let id = h.state().app.project().media[0].id;
    let seq = h.state().app.sequence_id.unwrap();
    h.state_mut().app.exec(&cut_app::cmd::place(seq, id, Some(Id::new("V1")), None, 0, "overwrite")).unwrap();
    // the monitor does not open the original before it goes (an open file cannot be renamed)
    h.state_mut().app.set_time(20 * TICKS);
    prefs::set(h.state_mut(), "proxyHeight", json!(540));
    let steps = h.state().app.history.list();
    assert_eq!(prefs::proxy::create(h.state_mut(), &[id]), 1, "queued");
    assert!(until(&mut h, 120, |s| s.app.project().media[0].proxy.is_some()), "the proxy is made");
    let p = h.state().app.project().media[0].proxy.clone().unwrap().path;
    assert_eq!(h.state().app.history.list(), steps, "no undo step for it");
    let cache = h.state().doc.home.cache.clone();
    assert!(Path::new(&p).starts_with(&cache) && p.ends_with("-540p.mp4"), "in the cache: {p}");
    let src = cut_formats::probe::open(&cut_formats::FileReader::open(Path::new(&p)).unwrap(), "proxy.mp4");
    let v = src.tracks.iter().find(|t| t.kind() == cut_formats::Kind::Video).expect("a picture");
    let (w, hh) = match &v.media {
        cut_formats::Media::Video(i) => (i.width, i.height),
        _ => (0, 0),
    };
    assert_eq!(
        (w, hh, v.samples.count(), v.codec.starts_with("avc1")),
        (960, 540, 90, true),
        "540p H.264, every frame"
    );
    assert!(!src.tracks.iter().any(|t| t.kind() == cut_formats::Kind::Audio), "no sound");
    // the original goes: without proxies the monitor shows the slate, with them the proxy's picture
    std::fs::rename(&file, dir.join("media").join("gone.mp4")).unwrap();
    h.state_mut().app.set_time(TICKS);
    settle(&mut h);
    assert_eq!(h.state().monitors.as_ref().unwrap().program.stats.failed, 1, "the original is offline");
    prefs::set(h.state_mut(), "proxy", json!(true));
    settle(&mut h);
    assert_eq!(h.state().monitors.as_ref().unwrap().program.stats.failed, 0, "the proxy plays in its place");
    let px = luma(&mut h, 0.0, 54.0, 1920.0, 162.0);
    assert!(px.0 > 200, "the frame-number blocks show ({px:?})");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn offline_media_is_found_in_a_folder_and_a_wrong_file_is_refused() {
    let (mut h, dir) = open("relink", 0);
    let file = clip_copy(&dir.join("media"), "a.mp4");
    h.state_mut().import_paths(vec![file.clone(), media::tone_aac()], None);
    assert!(until(&mut h, 60, |s| s.app.project().media.len() == 2), "imported");
    let id = h.state().app.project().media.iter().find(|m| m.name == "a.mp4").unwrap().id;
    let moved = dir.join("moved").join("deep");
    std::fs::create_dir_all(&moved).unwrap();
    std::fs::rename(&file, moved.join("a.mp4")).unwrap();
    let ctx = h.ctx.clone();
    h.state_mut().run_action("findMissing", &ctx);
    for _ in 0..3 {
        h.step();
    }
    assert!(matches!(h.state().features.prefs.screen, Some(Screen::Relink)), "the relink dialog opens");
    assert_eq!(h.state().features.prefs.relink.listed, [id], "listing the missing file only");
    h.get_by_label("Offline");
    // Locate with a file of another kind is refused and says why
    relink::picked(h.state_mut(), Some(id), media::tone_aac());
    assert!(until(&mut h, 30, |s| !relink::busy(s)));
    let toasts: Vec<(String, bool, f64)> =
        h.ctx.data_mut(|d| d.get_temp(egui::Id::unique("cut-toasts"))).unwrap_or_default();
    let said = toasts.iter().map(|t| t.0.clone()).collect::<Vec<_>>().join(" | ");
    assert!(said.contains("was not relinked") && said.contains("sound only"), "{said}");
    assert!(h.state().features.prefs.relink.offline.contains(&id));
    // Find in Folder: by name and size, one step
    let steps = h.state().app.history.position();
    relink::picked(h.state_mut(), None, dir.join("moved"));
    assert!(until(&mut h, 30, |s| !relink::busy(s)), "the search ends");
    let m = h.state().app.project().media(id).unwrap().clone();
    assert_eq!(Path::new(&m.path), moved.join("a.mp4"), "relinked to the moved file");
    assert!(
        h.state().features.prefs.relink.offline.is_empty() && h.state().features.prefs.screen.is_none(),
        "nothing offline, the dialog closed"
    );
    assert_eq!(h.state().app.history.position(), steps + 1);
    assert_eq!(last_label(h.state()), "Relink Media");
    h.state_mut().run_action("findMissing", &ctx);
    assert!(h.state().features.prefs.screen.is_none(), "nothing missing: no dialog");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_text_of_these_screens_is_translated() {
    let sources = [
        include_str!("../src/text_ui/mod.rs"),
        include_str!("../src/text_ui/editor.rs"),
        include_str!("../src/text_ui/panel.rs"),
        include_str!("../src/prefs/mod.rs"),
        include_str!("../src/prefs/page.rs"),
        include_str!("../src/prefs/shortcuts.rs"),
        include_str!("../src/prefs/proxy.rs"),
        include_str!("../src/prefs/relink.rs"),
        include_str!("../src/prefs/keymap.rs"),
    ];
    let mut all: Vec<String> = Vec::new();
    for src in sources {
        for start in ["tr(\"", "trf(\""] {
            let mut rest = src;
            while let Some(i) = rest.find(start) {
                let before = rest[..i].chars().last();
                rest = &rest[i + start.len()..];
                if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                all.push(rest[..rest.find('"').unwrap()].replace("\\n", "\n"));
            }
        }
    }
    all.extend(prefs::page::Page::ALL.iter().map(|p| p.title().to_owned()));
    all.extend(keymap::KINDS.iter().map(|(_, t)| (*t).to_owned()));
    all.extend(cut_app::text_ui::presets::PRESETS.iter().map(|(_, n)| (*n).to_owned()));
    all.extend(
        [
            "Keep a copy every:",
            "Copies to keep:",
            "Cache limit:",
            "In use:",
            "Default transition length:",
            "Default still image length:",
            "Playback quality:",
            "Proxy size:",
            "Family",
            "Size",
            "Tracking",
            "Leading",
            "Align",
            "Fill",
            "Stroke",
            "Shadow",
            "Background",
            "Position",
            "Style",
            "Style name",
            "Left",
            "Center",
            "Right",
            "Blur",
            "Padding",
            "Corner Radius",
            "In",
            "Out",
            "Full",
            "1/2",
            "1/4",
            "Play proxies in the monitors",
            "Offer proxies when importing 4K, HEVC or long-GOP video",
        ]
        .map(str::to_owned),
    );
    assert!(all.len() > 80, "{} texts found", all.len());
    let missing: Vec<&String> = all.iter().filter(|t| !cut_app::i18n::has_korean(t)).collect();
    assert!(missing.is_empty(), "untranslated: {missing:?}");
}
