//! The timeline's frame time with 10,000 clips while it scrolls: `cargo test -p cut-app --release --test bench --
//! --ignored --nocapture`. It runs egui without a window: the panel's own time (layout lookups and painting) and the
//! whole frame through tessellation, which is all the CPU does before the GPU draws the triangles.

use std::time::Instant;

use cut_app::state::App;
use cut_app::theme::{Palette, ThemeKind};
use cut_app::timeline::Timeline;
use cut_model::{History, Project};
use eframe::egui;
use serde_json::json;

fn project(n: usize) -> Project {
    let mut p = cut_model::defaults::project();
    p.sequences[0].fps = cut_time::Fps { num: 30, den: 1 };
    let mut h = History::new(p, 10).unwrap();
    let s = cut_time::TICKS;
    h.apply(&json!({ "type": "importMedia", "media": [{ "path": "C:\\m\\a.mp4", "name": "a.mp4", "kind": "video", "duration": 10 * s,
        "video": { "w": 1920, "h": 1080 } }], "binId": null }))
        .unwrap();
    h.apply(&json!({ "type": "place", "seqId": "s1", "opts": { "source": { "media": "m2" }, "video": "V1", "at": 0, "out": s, "mode": "overwrite" } }))
        .unwrap();
    let mut json: serde_json::Value = serde_json::from_str(&h.serialize()).unwrap();
    let tpl = json["sequences"][0]["clips"][0].clone();
    let list: Vec<_> = (0..n)
        .map(|i| {
            let mut c = tpl.clone();
            c["id"] = json!(format!("c{}", 100 + i));
            c["track"] = json!(if i % 2 == 0 { "V1" } else { "V2" });
            c["start"] = json!((i / 2) as i64 * s);
            c["name"] = json!(format!("clip {i}"));
            c
        })
        .collect();
    json["sequences"][0]["clips"] = serde_json::Value::Array(list);
    json["nextId"] = json!(100 + n);
    Project::load(&json.to_string()).unwrap()
}

#[test]
#[ignore = "benchmark"]
fn timeline_frame_time_with_10000_clips() {
    let p = project(10_000);
    let mut app = App::new(History::new(p, 1000).unwrap(), None);
    let pal = Palette::of(ThemeKind::Dark);
    let mut tl = Timeline::default();
    let ctx = egui::Context::default();
    let input = || egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(1280.0, 400.0))),
        ..Default::default()
    };
    let mut panel = Vec::new();
    let mut whole = Vec::new();
    for frame in 0..400 {
        let t0 = Instant::now();
        let out = ctx.run_ui(input(), |ui| {
            egui::CentralPanel::default().show(ui, |ui| tl.show(ui, &mut app, &pal, false, None));
        });
        let prims = ctx.tessellate(out.shapes, out.pixels_per_point);
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(!prims.is_empty());
        if frame == 2 {
            // zoomed to show a few seconds per screen: about 30 clips per row in view
            tl.view.pps = 60.0;
        }
        if frame > 10 {
            panel.push(f64::from(tl.frame_ms));
            whole.push(dt);
        }
        tl.view.scroll_x += 37.0;
        app.t += cut_time::TICKS / 30;
    }
    let stat = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        (v[v.len() / 2], v[v.len() * 99 / 100])
    };
    let (pm, p99) = stat(&mut panel);
    let (wm, w99) = stat(&mut whole);
    println!(
        "10,000 clips, scrolling: timeline panel median {pm:.3} ms (p99 {p99:.3}); whole frame with tessellation median {wm:.3} ms (p99 {w99:.3})"
    );
    let fit = {
        tl.view.pps = 0.5;
        let t0 = Instant::now();
        let out = ctx.run_ui(input(), |ui| {
            egui::CentralPanel::default().show(ui, |ui| tl.show(ui, &mut app, &pal, false, None));
        });
        let _ = ctx.tessellate(out.shapes, out.pixels_per_point);
        t0.elapsed().as_secs_f64() * 1000.0
    };
    println!("whole sequence in view (every clip on screen at once): {fit:.3} ms");
    assert!(wm < 16.0, "a frame at 60 Hz");
}
