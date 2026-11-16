//! Captions (the cases of `ui-captions.js` and the caption rows of `ui-timeline.js`): SRT import of UTF-8 and CP949
//! files and the export that round-trips them, a caption typed in the Captions panel, moved and trimmed on the
//! timeline and deleted, each one undo step that undoes and redoes, and the shown caption track drawn by the Program
//! monitor.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::captions::{self, files, panel, track};
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_app::state::Panel;
use cut_app::timeline::layout::{Layout, View};
use cut_model::Id;
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use serde_json::json;

const S: i64 = TICKS;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cut-app-captions-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn shell(d: &Path) -> Shell {
    let mut s = Shell::new(Home::at(d.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s
}

fn items(s: &Shell) -> Vec<(i64, i64, String)> {
    captions::track_of(&s.app, &s.features.captions)
        .map(|t| t.items.iter().map(|c| (c.start, c.end, c.text.clone())).collect())
        .unwrap_or_default()
}

fn label(s: &Shell) -> String {
    s.app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap_or_default()
}

const SRT: &str = "1\r\n00:00:01,000 --> 00:00:02,500\r\n안녕하세요, 자막입니다\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nHello world\r\nsecond line\r\n";

/// "안녕하세요, 자막입니다" and the UHC-only syllables of "똠방각하 뷁" in CP949.
const CP949: [&[u8]; 2] = [
    &[190, 200, 179, 231, 199, 207, 188, 188, 191, 228, 44, 32, 192, 218, 184, 183, 192, 212, 180, 207, 180, 217],
    &[140, 99, 185, 230, 176, 162, 199, 207, 32, 148, 238],
];

#[test]
fn srt_files_come_in_as_utf8_and_cp949_and_go_out_the_same() {
    let d = dir("srt");
    let mut s = shell(&d);
    let utf8 = d.join("한글.srt");
    std::fs::write(&utf8, SRT).unwrap();
    let steps = s.app.history.position();
    assert_eq!(files::import_file(&mut s, &utf8, false), 2);
    assert_eq!(s.app.history.position(), steps + 1, "the import is one step");
    let t = captions::track_of(&s.app, &s.features.captions).unwrap();
    assert_eq!(t.name, "한글", "a track of the file's name is made");
    assert_eq!(
        items(&s),
        vec![
            (S, 5 * S / 2, "안녕하세요, 자막입니다".to_owned()),
            (3 * S, 4 * S, "Hello world\nsecond line".to_owned())
        ]
    );
    let out = d.join("out.srt");
    assert!(files::export_file(&mut s, &out));
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(bytes[..3], [0xef, 0xbb, 0xbf], "with a byte-order mark");
    assert_eq!(std::str::from_utf8(&bytes[3..]).unwrap(), SRT, "the export is the file imported");

    // a CP949 file replaces the shown track's captions (the same track, one more step)
    let mut cp = b"1\r\n00:00:00,500 --> 00:00:01,000\r\n".to_vec();
    cp.extend_from_slice(CP949[0]);
    cp.extend_from_slice(b"\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\n");
    cp.extend_from_slice(CP949[1]);
    cp.extend_from_slice(b"\r\n");
    assert!(std::str::from_utf8(&cp).is_err(), "the bytes are not UTF-8");
    let cpf = d.join("cp949.srt");
    std::fs::write(&cpf, &cp).unwrap();
    let tracks = s.app.sequence().unwrap().captions.len();
    assert_eq!(files::import_file(&mut s, &cpf, false), 2);
    assert_eq!(s.app.sequence().unwrap().captions.len(), tracks, "into the shown track");
    assert_eq!(items(&s).iter().map(|x| x.2.as_str()).collect::<Vec<_>>(), ["안녕하세요, 자막입니다", "똠방각하 뷁"]);
    assert!(files::export_file(&mut s, &out));
    let back = String::from_utf8(std::fs::read(&out).unwrap()[3..].to_vec()).unwrap();
    assert_eq!(
        back,
        "1\r\n00:00:00,500 --> 00:00:01,000\r\n안녕하세요, 자막입니다\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\n똠방각하 뷁\r\n"
    );
    s.app.undo();
    assert_eq!(items(&s).len(), 2);
    assert_eq!(items(&s)[0].2, "안녕하세요, 자막입니다", "undo puts the first file's captions back");
    assert_eq!(items(&s)[1].0, 3 * S);

    // a WebVTT file, an empty one, one that is not there
    let vtt = d.join("a.vtt");
    std::fs::write(&vtt, "WEBVTT\n\n00:01.000 --> 00:02.000\nTom &amp; Jerry\n").unwrap();
    assert_eq!(files::import_file(&mut s, &vtt, true), 1);
    assert_eq!(items(&s), vec![(S, 2 * S, "Tom & Jerry".to_owned())], "a new track of its own, now shown");
    assert_eq!(s.app.sequence().unwrap().captions.len(), tracks + 1);
    let empty = d.join("empty.srt");
    std::fs::write(&empty, "").unwrap();
    assert_eq!(files::import_file(&mut s, &empty, false), 0);
    assert_eq!(files::import_file(&mut s, &d.join("gone.srt"), false), 0);
    assert!(s.app.notices.iter().any(|n| n.text.contains("The file is gone.")), "{:?}", s.app.notices);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn captions_are_added_moved_trimmed_and_deleted_in_steps_that_undo_and_redo() {
    let d = dir("edit");
    let mut s = shell(&d);
    let ctx = egui::Context::default();
    s.app.set_time(S);
    let id = panel::add_at_playhead(&mut s).expect("a caption is added");
    assert_eq!(items(&s), vec![(S, 3 * S, String::new())], "two seconds at the playhead");
    s.app.set_time(2 * S);
    panel::add_at_playhead(&mut s);
    assert_eq!(items(&s)[1], (2 * S, 4 * S, String::new()));
    s.app.undo();
    s.app.set_time(0);
    panel::add_at_playhead(&mut s);
    assert_eq!(items(&s)[0], (0, S, String::new()), "up to the next caption");
    s.app.undo();
    let seq = s.app.sequence().unwrap().clone();
    let tr = seq.captions[0].id;
    s.app.exec(&cut_model::commands::build::set_caption(
        seq.id.as_str(),
        tr.as_str(),
        id.as_str(),
        json!({ "text": "Hi" }),
    ));

    // the timeline: the body dragged 100 points (1 s at 100 points a second) moves it, frames whole
    let seq = s.app.sequence().unwrap().clone();
    let l = Layout::of(&seq);
    let view = View { pps: 100.0, scroll_x: 0.0, scroll_y: 0.0 };
    let row = l.rows.iter().find(|r| r.id == Some(tr)).unwrap().clone();
    let y = row.y + row.h / 2.0;
    let mut e = track::CaptionEdit::default();
    let steps = s.app.history.position();
    assert!(e.press(&mut s.app, &seq, &l, &view, (200.0, y), Vec::new()), "a press on the caption takes it");
    assert!(e.is_selected(tr, id));
    for x in [210.0, 260.0, 301.0] {
        e.step(&mut s.app, &seq, &view, x, false);
    }
    e.release(&mut s.app);
    assert_eq!(items(&s), vec![(2 * S, 4 * S, "Hi".to_owned())]);
    assert_eq!((s.app.history.position(), label(&s)), (steps + 1, "Edit Caption".to_owned()), "one step");
    // its end trimmed 50 points back
    let seq = s.app.sequence().unwrap().clone();
    assert!(e.press(&mut s.app, &seq, &l, &view, (399.0, y), Vec::new()));
    e.step(&mut s.app, &seq, &view, 349.0, false);
    e.release(&mut s.app);
    assert_eq!(items(&s)[0].1, 7 * S / 2, "the end edge trims");
    // its start trimmed past its end stops a frame before it
    let seq = s.app.sequence().unwrap().clone();
    assert!(e.press(&mut s.app, &seq, &l, &view, (201.0, y), Vec::new()));
    e.step(&mut s.app, &seq, &view, 900.0, false);
    e.release(&mut s.app);
    let f = cut_time::frame_start(1, seq.fps);
    assert_eq!(items(&s)[0].0, 7 * S / 2 - f, "a caption is at least a frame long");
    s.app.undo();
    s.app.undo();
    assert_eq!(items(&s), vec![(2 * S, 4 * S, "Hi".to_owned())], "two undos take back both trims");
    s.app.redo();
    assert_eq!(items(&s)[0].1, 7 * S / 2, "redo trims again");
    s.app.undo();
    s.app.undo();
    assert_eq!(items(&s), vec![(S, 3 * S, "Hi".to_owned())], "and the move");
    s.app.redo();
    assert_eq!(items(&s)[0].0, 2 * S);
    // snapping: dragged to 1.05 s, the start comes to the playhead at 1 s, 8 points away at most
    let seq = s.app.sequence().unwrap().clone();
    assert!(e.press(&mut s.app, &seq, &l, &view, (300.0, y), vec![S]));
    e.step(&mut s.app, &seq, &view, 205.0, true);
    assert_eq!(e.guide, Some(S), "the guide shows where it snapped");
    e.release(&mut s.app);
    assert_eq!(items(&s)[0].0, S, "the start snaps to the playhead");
    s.app.undo();
    // a press that does not move puts the playhead at the caption's start
    let seq = s.app.sequence().unwrap().clone();
    s.app.set_time(0);
    assert!(e.press(&mut s.app, &seq, &l, &view, (300.0, y), Vec::new()));
    e.release(&mut s.app);
    assert_eq!(s.app.t, 2 * S);
    // a press elsewhere drops the selection; Delete with one selected removes it
    assert!(!e.press(&mut s.app, &seq, &l, &view, (300.0, y + 200.0), Vec::new()));
    assert!(e.selected.is_none());
    s.timeline.captions.press(&mut s.app, &seq, &l, &view, (300.0, y), Vec::new());
    s.timeline.captions.release(&mut s.app);
    s.app.focus = Some(Panel::Timeline);
    assert!(s.action_enabled("delete"));
    s.run_action("delete", &ctx);
    assert!(items(&s).is_empty(), "Delete removes the selected caption");
    s.app.undo();
    assert_eq!(items(&s).len(), 1, "and undo brings it back");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn a_caption_typed_in_the_panel_is_one_step() {
    let d = dir("panel");
    let mut s = shell(&d);
    let file = d.join("a.srt");
    std::fs::write(&file, SRT).unwrap();
    files::import_file(&mut s, &file, false);
    let mut h =
        Harness::builder().with_size(egui::vec2(1280.0, 800.0)).build_ui_state(|ui, s: &mut Shell| s.frame(ui), s);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("workspace.captions", &ctx);
    h.run_steps(3);
    h.query_all_by_value("안녕하세요, 자막입니다").next().expect("the caption's text field").click();
    h.run_steps(2);
    let steps = h.state().app.history.position();
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::A);
    h.event(egui::Event::Text("반갑습니다".into()));
    h.run_steps(2);
    assert_eq!(items(h.state())[0].2, "안녕하세요, 자막입니다", "nothing is committed while typing");
    h.key_press(egui::Key::Enter);
    h.run_steps(2);
    assert_eq!(items(h.state())[0].2, "반갑습니다", "Enter commits the text");
    assert_eq!(h.state().app.history.position(), steps + 1, "in one step");
    // the start typed as a timecode
    h.query_all_by_value("00:00:03:00").next().expect("the start field").click();
    h.run_steps(2);
    h.key_press_modifiers(egui::Modifiers::COMMAND, egui::Key::A);
    h.event(egui::Event::Text("00:00:02:15".into()));
    h.key_press(egui::Key::Enter);
    h.run_steps(2);
    let fps = h.state().app.sequence().unwrap().fps;
    assert_eq!(items(h.state())[1].0, cut_time::parse_timecode("00:00:02:15", fps, 0).unwrap());
    h.state_mut().app.undo();
    h.state_mut().app.undo();
    h.run_steps(2);
    assert_eq!(items(h.state())[0].2, "안녕하세요, 자막입니다");
    assert!(h.query_all_by_value("안녕하세요, 자막입니다").next().is_some(), "the field shows the text undone");
    let _ = std::fs::remove_dir_all(&d);
}

/// Mean brightness of the program picture's rows in `[a, b)` (fractions of its height).
fn band(px: &[u8], w: u32, h: u32, a: f64, b: f64) -> f64 {
    let (y0, y1) = ((f64::from(h) * a) as u32, (f64::from(h) * b) as u32);
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in 0..w {
            let p = &px[((y * w + x) * 4) as usize..][..3];
            sum += f64::from(p[0]) + f64::from(p[1]) + f64::from(p[2]);
        }
    }
    sum / f64::from((y1 - y0) * w * 3)
}

#[test]
fn the_program_monitor_draws_the_caption_track_the_panel_shows() {
    let d = dir("monitor");
    let mut s = shell(&d);
    let tone = cut_app::import::probe_file(&media::tone_aac()).result.unwrap();
    let r = s.app.exec(&cut_app::cmd::import_media(vec![tone], None)).unwrap();
    let seq = s.app.sequence_id.unwrap();
    s.app
        .exec(&cut_app::cmd::place(
            seq,
            Id::new(r["ids"][0].as_str().unwrap()),
            None,
            Some(Id::new("A1")),
            0,
            "overwrite",
        ))
        .unwrap();
    let file = d.join("bottom.srt");
    std::fs::write(&file, "1\r\n00:00:00,000 --> 00:00:05,000\r\nBOTTOM BOTTOM BOTTOM\r\n").unwrap();
    files::import_file(&mut s, &file, true);
    let top = d.join("top.srt");
    std::fs::write(&top, "1\r\n00:00:00,000 --> 00:00:05,000\r\nTOP TOP TOP TOP\r\n").unwrap();
    files::import_file(&mut s, &top, true);
    let tracks: Vec<Id> = s.app.sequence().unwrap().captions.iter().map(|c| c.id).collect();
    s.app.exec(&cut_model::commands::build::set_caption_track(
        seq.as_str(),
        tracks[1].as_str(),
        json!({ "style": { "position": "top" } }),
    ));
    s.app.set_time(S);
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while h.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(h.state().monitors.is_some());
    h.state_mut().transport.set_output_gain(0.0);
    let look = |h: &mut Harness<'_, Shell>| {
        let start = Instant::now();
        for _ in 0..4 {
            h.step();
        }
        while !h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete)
            && start.elapsed() < Duration::from_secs(20)
        {
            h.step();
            std::thread::sleep(Duration::from_millis(10));
        }
        h.step();
        h.state().monitors.as_ref().unwrap().settle();
        let (w, hh, px) = h.state().monitors.as_ref().unwrap().program.pixels().expect("a picture");
        (band(&px, w, hh, 0.0, 0.3), band(&px, w, hh, 0.7, 1.0))
    };
    assert_eq!(captions::shown(h.state()), Some(tracks[1]), "the track imported last is shown");
    let (t, b) = look(&mut h);
    eprintln!("top track shown: top {t:.2}, bottom {b:.2}");
    assert!(
        t > b + 1.0 && t > 2.0,
        "the top track's caption is drawn at the top, nothing at the bottom ({t:.2}, {b:.2})"
    );
    captions::choose(h.state_mut(), tracks[0]);
    let (t2, b2) = look(&mut h);
    eprintln!("bottom track shown: top {t2:.2}, bottom {b2:.2}");
    assert!(b2 > t2 + 1.0 && b2 > 2.0, "choosing the other track draws it instead ({t2:.2}, {b2:.2})");

    // export burns in the track shown, the second one here, not the sequence's first
    captions::choose(h.state_mut(), tracks[1]);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("export", &ctx);
    h.step();
    let out = d.join("burn.mp4");
    {
        let s = h.state_mut();
        s.app.set_in_out(Some(Some(0)), Some(Some(S / 2)));
        s.features.export.form.preset = 3;
        h.step();
        let f = &mut h.state_mut().features.export.form;
        f.in_out = true;
        f.loudness = None;
        f.captions = Some(cut_export::CaptionMode::Burn);
        f.path = out.to_string_lossy().into_owned();
        f.path_touched = true;
    }
    cut_app::export::start_export(h.state_mut(), false, &ctx);
    let start = Instant::now();
    while h.state().features.export.outcome.is_none() && start.elapsed() < Duration::from_secs(120) {
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(matches!(h.state().features.export.outcome, Some(cut_app::export::Outcome::Done(_))), "the export ends");
    drop(h);
    let reader = cut_formats::FileReader::open(&out).unwrap();
    let source = cut_formats::probe::open(&reader, "burn.mp4");
    let vt = source.tracks.iter().find(|t| t.kind() == cut_formats::Kind::Video).unwrap();
    let mut dec = cut_decode::VideoDecoder::new(vt, cut_decode::Accel::Software).unwrap();
    let mut samples = Vec::new();
    cut_formats::probe::read_samples(&reader, vt, 0, vt.samples.count(), |i, b| samples.push((i, b.to_vec()))).unwrap();
    let mut luma = None;
    for (i, b) in samples {
        dec.send(i, &b).unwrap();
        if let Ok(Some(f)) = dec.receive() {
            luma = Some((f.width, f.height, f.to_memory().unwrap().into_owned()));
            break;
        }
    }
    if luma.is_none() {
        dec.finish().unwrap();
        if let Ok(Some(f)) = dec.receive() {
            luma = Some((f.width, f.height, f.to_memory().unwrap().into_owned()));
        }
    }
    let (w, hh, px) = luma.expect("a frame decodes");
    let mean = |a: f64, b: f64| {
        let (y0, y1) = ((f64::from(hh) * a) as u32, (f64::from(hh) * b) as u32);
        let rows = &px[(y0 * w) as usize..(y1 * w) as usize];
        rows.iter().map(|v| f64::from(*v)).sum::<f64>() / rows.len() as f64
    };
    let (t3, b3) = (mean(0.0, 0.3), mean(0.7, 1.0));
    eprintln!("exported frame: top luma {t3:.2}, bottom {b3:.2}");
    assert!(t3 > b3 + 1.0, "the exported picture has the shown track's caption at the top ({t3:.2}, {b3:.2})");
    let _ = std::fs::remove_dir_all(&d);
}
