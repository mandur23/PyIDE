//! What the editor's own UI thread spends, in the real window run headless on the GPU (no screen, so no wait for
//! the refresh): `cargo test -p cut-app --release --test bench_ui -- --ignored --nocapture --test-threads 1`.
//! Each scenario opens a generated project (20 tracks; clips spread over them; media pointing at the generated test
//! files) and prints the medians of [`Shell::frame_ms`] (this crate's code and egui's layout, the part a project's
//! size can change) and of the whole step, over frames at rest and while the timeline scrolls; then one command at
//! 10,000 clips with the frame after it, undo, redo, the autosave's text and the process's memory.
//! `bench_projects` writes the same projects to `CUT_BENCH_OUT` for runs of the real app.

#[path = "media/mod.rs"]
mod media;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_model::History;
use cut_model::commands::build as C;
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;
use serde_json::{Value as Json, json};

type H = Harness<'static, Shell>;

/// What a generated project holds.
#[derive(Clone, Copy)]
struct Size {
    clips: usize,
    media: usize,
    captions: usize,
    keyframes: usize,
    steps: usize,
}

const BASE: Size = Size { clips: 0, media: 2, captions: 0, keyframes: 0, steps: 0 };

/// The project's text: 10 video and 10 audio tracks, `clips` one-second clips spread over them, `media` items
/// alternating the 720p test video and the tone, a caption track of `captions`, `keyframes` keyframes on each of the
/// first clip's opacity, scale and position.
fn project(z: Size) -> String {
    let (video, tone) = (media::h264_720p(), media::tone_aac());
    let mut h = cut_app::doc::fresh_history();
    let seq = h.project().sequences[0].id.as_str().to_owned();
    for kind in ["video", "audio"] {
        while h.project().sequences[0]
            .tracks
            .iter()
            .filter(|t| format!("{:?}", t.kind).eq_ignore_ascii_case(kind))
            .count()
            < 10
        {
            h.apply(&C::add_track(&seq, kind, None, json!({}))).unwrap();
        }
    }
    let media: Vec<Json> = (0..z.media.max(2))
        .map(|i| {
            if i % 2 == 0 {
                json!({ "path": video.to_string_lossy(), "name": format!("video {i:05}.mp4"), "kind": "video",
                    "duration": 3 * TICKS, "video": { "w": 1280, "h": 720 } })
            } else {
                json!({ "path": tone.to_string_lossy(), "name": format!("tone {i:05}.m4a"), "kind": "audio",
                    "duration": 8 * TICKS, "audio": { "rate": 48000, "channels": 2 } })
            }
        })
        .collect();
    h.apply(&C::import_media(json!(media), None)).unwrap();
    let ids: Vec<String> = h.project().media.iter().map(|m| m.id.as_str().to_owned()).collect();
    let tracks: Vec<(String, bool)> = h.project().sequences[0]
        .tracks
        .iter()
        .map(|t| (t.id.as_str().to_owned(), format!("{:?}", t.kind) == "Video"))
        .collect();
    let v1 = tracks.iter().find(|t| t.1).unwrap().0.clone();
    let a1 = tracks.iter().find(|t| !t.1).unwrap().0.clone();
    h.apply(&C::place(
        &seq,
        json!({ "source": { "media": ids[0] }, "video": v1, "at": 0, "out": TICKS, "mode": "overwrite" }),
    ))
    .unwrap();
    h.apply(&C::place(
        &seq,
        json!({ "source": { "media": ids[1] }, "audio": a1, "at": 0, "out": TICKS, "mode": "overwrite" }),
    ))
    .unwrap();
    let mut j: Json = serde_json::from_str(&h.serialize()).unwrap();
    let tpl = j["sequences"][0]["clips"].as_array().unwrap().clone();
    let (vt, at) =
        (tpl.iter().find(|c| c["track"] == json!(v1)).unwrap(), tpl.iter().find(|c| c["track"] == json!(a1)).unwrap());
    let mut next = j["nextId"].as_u64().unwrap() as usize;
    let list: Vec<Json> = (0..z.clips)
        .map(|i| {
            let (track, is_video) = &tracks[i % tracks.len()];
            let mut c = if *is_video { vt.clone() } else { at.clone() };
            let m = (i % (ids.len() / 2)) * 2 + usize::from(!is_video);
            c["id"] = json!(format!("c{next}"));
            next += 1;
            c["track"] = json!(track);
            c["link"] = Json::Null;
            c["start"] = json!((i / tracks.len()) as i64 * TICKS);
            c["name"] = json!(format!("clip {i}"));
            c["source"] = json!({ "media": ids[m] });
            c
        })
        .collect();
    j["sequences"][0]["clips"] = Json::Array(list);
    if z.captions > 0 {
        let items: Vec<Json> = (0..z.captions)
            .map(|i| {
                next += 1;
                json!({ "id": format!("cap{next}"), "start": i as i64 * TICKS, "end": i as i64 * TICKS + TICKS * 9 / 10,
                    "text": format!("Caption number {i}, a line of words") })
            })
            .collect();
        next += 1;
        j["sequences"][0]["captions"] = json!([{ "id": format!("ct{next}"), "name": "Captions", "lang": "en", "style": {}, "syncLock": false, "items": items }]);
    }
    j["nextId"] = json!(next + 1);
    let mut h = History::new(cut_model::Project::load(&j.to_string()).unwrap(), 1000).unwrap();
    if z.keyframes > 0 && z.clips > 0 {
        let clip = h.project().sequences[0].clip_order()[0].as_str().to_owned();
        for prop in ["opacity", "scale", "position"] {
            let keys: Vec<Json> = (0..z.keyframes)
                .map(|k| {
                    let v = if prop == "position" { json!([k as f64, 0.0]) } else { json!(50.0 + (k % 50) as f64) };
                    json!({ "t": k as i64 * TICKS / z.keyframes as i64, "v": v })
                })
                .collect();
            h.apply(&C::set_keyframes(&seq, &clip, prop, Some(json!(keys)))).unwrap();
        }
    }
    let first = h.project().sequences[0].id.as_str().to_owned();
    for i in 0..z.steps {
        h.apply(&C::rename_item(&first, &format!("Sequence step {i}"))).unwrap();
    }
    h.serialize()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-bench-ui-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The editor on the project `z` in English at 1600 x 1000, every media online, the monitors on the GPU.
fn open(name: &str, z: Size) -> (H, PathBuf) {
    let dir = scratch(name);
    let file = dir.join("bench.ncut");
    std::fs::write(&file, project(z)).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.doc.open(&mut s.app, &file, now_ms()).expect("the project opens");
    let mut h = Harness::builder()
        .with_size(egui::vec2(1600.0, 1000.0))
        .with_step_dt(1.0 / 60.0)
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while h.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(h.state().monitors.is_some(), "the monitors started");
    h.state_mut().transport.set_output_gain(0.0);
    (h, dir)
}

fn act(h: &mut H, id: &str) {
    let ctx = h.ctx.clone();
    h.state_mut().run_action(id, &ctx);
    h.step();
}

/// Medians and the 90th percentile.
fn stat(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(f64::total_cmp);
    (v[v.len() / 2], v[v.len() * 9 / 10], v[v.len() - 1])
}

/// `n` frames after a settling second: (panel code ms, whole step ms) medians, p90 and max.
fn frames(h: &mut H, n: usize, mut each: impl FnMut(&mut H)) -> ((f64, f64, f64), (f64, f64, f64)) {
    let settle = Instant::now();
    while settle.elapsed() < Duration::from_secs(1) {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    let (mut code, mut whole) = (Vec::new(), Vec::new());
    let mut parts: std::collections::BTreeMap<&'static str, Vec<f64>> = Default::default();
    for _ in 0..n {
        each(h);
        h.state_mut().panel_ms.clear();
        let t0 = Instant::now();
        h.step();
        whole.push(t0.elapsed().as_secs_f64() * 1000.0);
        code.push(f64::from(h.state().frame_ms));
        for (k, v) in &h.state().panel_ms {
            parts.entry(k).or_default().push(f64::from(*v));
        }
    }
    let mut parts: Vec<(f64, &str)> = parts.into_iter().map(|(k, v)| (stat(v).0, k)).collect();
    parts.sort_by(|a, b| b.0.total_cmp(&a.0));
    let top: Vec<String> = parts.iter().take(5).map(|(v, k)| format!("{k} {v:.2}")).collect();
    eprintln!("    parts (medians, ms): {}", top.join(", "));
    (stat(code), stat(whole))
}

fn line(name: &str, ((cm, c90, cmax), (wm, w90, _)): ((f64, f64, f64), (f64, f64, f64))) {
    println!("| {name:<44} | {cm:8.3} | {c90:8.3} | {cmax:8.3} | {wm:8.3} | {w90:8.3} |");
}

fn private_mb() -> f64 {
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("(Get-Process -Id {}).PrivateMemorySize64", std::process::id())])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1048576.0
}

fn scroll(h: &mut H) {
    let s = h.state_mut();
    s.timeline.view.scroll_x += 23.0;
    let t = s.app.t + TICKS / 30;
    s.app.set_time(t);
}

#[test]
#[ignore = "benchmark"]
fn ui_frame_costs() {
    println!("| scenario | code median ms | code p90 | code max | step median ms | step p90 |");
    println!("|---|---|---|---|---|---|");
    for clips in [0, 100, 1_000, 10_000] {
        let (mut h, dir) = open(&format!("clips{clips}"), Size { clips, media: 200, ..BASE });
        line(&format!("Editing, {clips} clips, at rest"), frames(&mut h, 120, |_| {}));
        h.state_mut().timeline.view.pps = 60.0;
        line(&format!("Editing, {clips} clips, scrolling"), frames(&mut h, 240, scroll));
        h.state_mut().timeline.view.pps = 0.5;
        line(&format!("Editing, {clips} clips, whole sequence in view"), frames(&mut h, 60, |_| {}));
        println!("|   memory after {clips} clips: {:.0} MB private |", private_mb());
        drop(h);
        let _ = std::fs::remove_dir_all(dir);
    }
    {
        let (mut h, dir) = open("project5000", Size { clips: 1_000, media: 5_000, ..BASE });
        line("Project panel, 5,000 items, list", frames(&mut h, 120, |_| {}));
        line(
            "Project panel, 5,000 items, list scrolled",
            frames(&mut h, 120, |h| {
                h.event(egui::Event::PointerMoved(egui::pos2(200.0, 800.0)));
                h.event(egui::Event::MouseWheel {
                    unit: egui::MouseWheelUnit::Point,
                    delta: egui::vec2(0.0, -40.0),
                    modifiers: egui::Modifiers::NONE,
                    phase: egui::TouchPhase::Move,
                    source: egui::MouseWheelSource::Wheel,
                });
            }),
        );
        h.state_mut().project.set_icons(true);
        line("Project panel, 5,000 items, icons", frames(&mut h, 120, |_| {}));
        drop(h);
        let _ = std::fs::remove_dir_all(dir);
    }
    {
        let (mut h, dir) = open("history", Size { clips: 1_000, steps: 1_000, ..BASE });
        h.state_mut().lower_tab = cut_app::shell::LowerTab::History;
        line("History panel, 1,000 steps", frames(&mut h, 120, |_| {}));
        drop(h);
        let _ = std::fs::remove_dir_all(dir);
    }
    {
        let (mut h, dir) = open("controls", Size { clips: 1_000, keyframes: 500, ..BASE });
        let first = h.state().app.project().sequences[0].clip_order()[0];
        h.state_mut().app.select([first], false, false);
        act(&mut h, "window.controls");
        line("Effect Controls, 3 x 500 keyframes", frames(&mut h, 120, |_| {}));
        drop(h);
        let _ = std::fs::remove_dir_all(dir);
    }
    {
        let (mut h, dir) = open("captions", Size { clips: 1_000, captions: 2_000, ..BASE });
        act(&mut h, "workspace.captions");
        act(&mut h, "window.captions");
        line("Captions workspace, 2,000 captions", frames(&mut h, 120, |_| {}));
        line("Captions workspace, 2,000 captions, scrolling", frames(&mut h, 240, scroll));
        drop(h);
        let _ = std::fs::remove_dir_all(dir);
    }
    {
        let (mut h, dir) = open("audio", Size { clips: 1_000, ..BASE });
        act(&mut h, "workspace.audio");
        act(&mut h, "window.mixer");
        line("Audio workspace (mixer, 20 strips, meters)", frames(&mut h, 120, |_| {}));
        drop(h);
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// One command at 10,000 clips: its time in `History::apply` and the frame after it (the timeline's index rebuilt,
/// the sound given the project), undo and redo, and the autosave.
#[test]
#[ignore = "benchmark"]
fn edits_at_10000_clips() {
    let (mut h, dir) = open("edits", Size { clips: 10_000, media: 200, ..BASE });
    let _ = frames(&mut h, 30, |_| {});
    let seq = h.state().app.project().sequences[0].id.as_str().to_owned();
    let clip = |h: &H, i: usize| h.state().app.project().sequences[0].clip_order()[i].as_str().to_owned();
    println!("| command at 10,000 clips | apply ms | next frame code ms | next step ms | undo ms | redo ms |");
    println!("|---|---|---|---|---|---|");
    for name in ["move", "trim", "split", "ripple delete"] {
        let (mut apply, mut code, mut step, mut undo, mut redo) = (vec![], vec![], vec![], vec![], vec![]);
        for k in 0..7 {
            let c = clip(&h, 5_000 + k * 20);
            let start = {
                let q = &h.state().app.project().sequences[0];
                q.clip(q.clip_order()[5_000 + k * 20]).unwrap().start
            };
            let cmd = match name {
                "move" => C::move_by(&seq, &[&c], TICKS / 2, 0),
                "trim" => C::trim(&seq, &c, json!({ "edge": "end", "delta": -TICKS / 4 })),
                "split" => C::split(&seq, start + TICKS / 2, json!({ "clipIds": [c] })),
                _ => C::remove(&seq, &[&c], json!({ "ripple": true })),
            };
            let t0 = Instant::now();
            h.state_mut().app.exec(&cmd).expect("the command applies");
            apply.push(t0.elapsed().as_secs_f64() * 1000.0);
            h.state_mut().panel_ms.clear();
            let t0 = Instant::now();
            h.step();
            step.push(t0.elapsed().as_secs_f64() * 1000.0);
            code.push(f64::from(h.state().frame_ms));
            if k == 0 {
                let mut parts: Vec<(f32, &str)> = h.state().panel_ms.iter().map(|(k, v)| (*v, *k)).collect();
                parts.sort_by(|a, b| b.0.total_cmp(&a.0));
                let top: Vec<String> = parts.iter().take(5).map(|(v, k)| format!("{k} {v:.2}")).collect();
                eprintln!("    {name}, the frame after (ms): {}", top.join(", "));
            }
            let t0 = Instant::now();
            assert!(h.state_mut().app.history.undo());
            undo.push(t0.elapsed().as_secs_f64() * 1000.0);
            h.step();
            let t0 = Instant::now();
            assert!(h.state_mut().app.history.redo());
            redo.push(t0.elapsed().as_secs_f64() * 1000.0);
            h.step();
            h.state_mut().app.history.undo();
            h.step();
        }
        let m = |v: Vec<f64>| {
            let (m, _, x) = stat(v);
            format!("{m:.2} (max {x:.2})")
        };
        println!("| {name} | {} | {} | {} | {} | {} |", m(apply), m(code), m(step), m(undo), m(redo));
    }
    let mut ser = Vec::new();
    for _ in 0..5 {
        let t0 = Instant::now();
        let text = h.state().app.history.serialize();
        ser.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert!(text.len() > 1_000_000);
    }
    let (sm, _, sx) = stat(ser);
    println!("autosave text at 10,000 clips: serialize median {sm:.1} ms (max {sx:.1})");
    // the frame in which the autosave is written: an edit, then frames for 2.5 s of wall time
    let c = clip(&h, 100);
    h.state_mut().app.exec(&C::move_by(&seq, &[&c], TICKS / 2, 0)).unwrap();
    let mut worst: f64 = 0.0;
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(2600) {
        let t0 = Instant::now();
        h.step();
        worst = worst.max(t0.elapsed().as_secs_f64() * 1000.0);
        std::thread::sleep(Duration::from_millis(15));
    }
    assert!(h.state().doc.last_autosave.is_some(), "the autosave ran");
    println!("longest step while the autosave was written: {worst:.1} ms");
    drop(h);
    let _ = std::fs::remove_dir_all(dir);
}

/// The bench projects as files for the real app: `CUT_BENCH_OUT=<folder>`.
#[test]
#[ignore = "writes files"]
fn bench_projects() {
    let Some(out) = std::env::var_os("CUT_BENCH_OUT").map(PathBuf::from) else { return };
    std::fs::create_dir_all(&out).unwrap();
    for clips in [100, 1_000, 10_000] {
        let path: &Path = &out.join(format!("clips-{clips}.ncut"));
        std::fs::write(path, project(Size { clips, media: 200, ..BASE })).unwrap();
    }
}
