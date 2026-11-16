//! What the Lumetri Scopes cost playback: the demo project's 1080p clip played for a few seconds in the Color
//! workspace with the scopes on screen and with the Source monitor in their slot, frames shown and dropped counted
//! (`verify/cut-color.mjs` `play`), and what each count cost the UI thread:
//! `cargo test -p cut-app --release --test fx_color_play -- --ignored --nocapture`.

#[path = "../examples/demo_project.rs"]
mod demo;

use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_app::workspaces::Ws;
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;

/// One run: playing from 3 s for `seconds` -> (frames shown, dropped, counts, the counts' costs in ms).
fn run(h: &mut Harness<'static, Shell>, seconds: f64) -> (u64, i64, u64, Vec<f64>) {
    h.state_mut().app.set_time(3 * TICKS);
    for _ in 0..20 {
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    let c0 = h.state().features.fx.scopes.count;
    let ctx = h.ctx.clone();
    h.state_mut().run_action("playPause", &ctx);
    let start = Instant::now();
    let mut costs = Vec::new();
    let mut seen = c0;
    while start.elapsed().as_secs_f64() < seconds {
        h.step();
        let sc = &h.state().features.fx.scopes;
        if sc.count != seen {
            seen = sc.count;
            costs.push(sc.last.as_ref().unwrap().cost.as_secs_f64() * 1000.0);
        }
        // a 60 Hz display's pace
        std::thread::sleep(Duration::from_millis(12));
    }
    let play = h.state().play;
    h.state_mut().run_action("playPause", &ctx);
    h.step();
    (play.shown, play.dropped, h.state().features.fx.scopes.count - c0, costs)
}

fn stats(v: &mut [f64]) -> String {
    if v.is_empty() {
        return "none".into();
    }
    v.sort_by(f64::total_cmp);
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    format!("mean {mean:.2} ms, median {:.2}, max {:.2}", v[v.len() / 2], v[v.len() - 1])
}

#[test]
#[ignore = "a measurement"]
fn the_scopes_cost_playback_no_frames() {
    let dir = std::env::temp_dir().join(format!("cut-app-fx-color-play-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("demo.ncut");
    std::fs::write(&file, demo::build(0)).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.doc.open(&mut s.app, &file, now_ms()).expect("the demo project opens");
    s.features.workspace.current = Ws::Color;
    let mut h = Harness::builder()
        .with_size(egui::vec2(1600.0, 1000.0))
        .wgpu_setup(demo::media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while h.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    h.state_mut().transport.set_output_gain(0.0);
    if let Some(e) = &h.state().sound_error {
        eprintln!("no output device ({e}): the wall clock drives playback");
    }
    let secs = 6.0;
    let _ = run(&mut h, secs);
    let (shown, dropped, counts, mut costs) = run(&mut h, secs);
    h.state_mut().features.workspace.open_panel("source");
    let (shown2, dropped2, counts2, _) = run(&mut h, secs);
    h.state_mut().features.workspace.open_panel("scopes");
    h.state_mut().app.set_time(5 * TICKS);
    let mut paused = Vec::new();
    for i in 0..40 {
        h.state_mut().app.set_time(5 * TICKS + i * TICKS / 30);
        let c = h.state().features.fx.scopes.count;
        h.run_steps(3);
        let sc = &h.state().features.fx.scopes;
        if sc.count != c {
            paused.push(sc.last.as_ref().unwrap().cost.as_secs_f64() * 1000.0);
        }
    }
    eprintln!(
        "playing the 1080p clip for {secs} s: with the scopes {shown} frames shown, {dropped} dropped, {counts} counts \
         (each {}); without them {shown2} shown, {dropped2} dropped, {counts2} counts",
        stats(&mut costs)
    );
    eprintln!("a full count while stopped: {}", stats(&mut paused));
    assert_eq!(counts2, 0, "off screen the scopes count nothing");
    assert!(counts as f64 <= secs * 1000.0 / 150.0 + 2.0, "at most every 150 ms while playing ({counts})");
    let _ = std::fs::remove_dir_all(&dir);
}
