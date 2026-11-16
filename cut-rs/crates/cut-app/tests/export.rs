//! The export screens on the demo project, run headless: the Export Media dialog opens from its action, exports In to
//! Out of the sequence with the form's settings to a file that checks itself, and the export queue runs two jobs one
//! after the other while the window keeps drawing.

#[path = "../examples/demo_project.rs"]
mod demo;

use std::time::{Duration, Instant};

use cut_app::export::{JobState, Outcome};
use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;

fn open(name: &str) -> (Harness<'static, Shell>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("cut-app-export-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("demo.ncut");
    std::fs::write(&file, demo::build(0)).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.doc.open(&mut s.app, &file, now_ms()).expect("the demo project opens");
    let mut h = Harness::builder()
        .with_size(egui::vec2(1400.0, 900.0))
        .wgpu_setup(demo::media::gpu_setup())
        .build_eframe(move |_cc| s);
    let start = Instant::now();
    while h.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    h.state_mut().transport.set_output_gain(0.0);
    (h, dir)
}

fn until(h: &mut Harness<'_, Shell>, secs: u64, done: impl Fn(&Shell) -> bool) {
    let start = Instant::now();
    while !done(h.state()) && start.elapsed() < Duration::from_secs(secs) {
        h.step();
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_dialog_exports_in_to_out_and_the_queue_runs_its_jobs() {
    let (mut h, dir) = open("dialog");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("export", &ctx);
    h.step();
    assert!(h.state().features.export.open, "Export Media opens");
    assert!(
        h.state().action_enabled("export") && h.state().action_enabled("exportFrame"),
        "the export actions are enabled"
    );
    {
        let s = h.state_mut();
        s.app.set_in_out(Some(Some(TICKS)), Some(Some(3 * TICKS)));
        s.features.export.form.preset = 3;
        h.step();
        let s = h.state_mut();
        s.features.export.form.in_out = true;
        s.features.export.form.loudness = None;
        s.features.export.form.path = dir.join("range.mp4").to_string_lossy().into_owned();
        s.features.export.form.path_touched = true;
    }
    h.state_mut().features.export.form.in_out = true;
    cut_app::export::start_export(h.state_mut(), false, &ctx);
    assert!(h.state().features.export.busy(), "the export runs");
    until(&mut h, 120, |s| s.features.export.outcome.is_some());
    match &h.state().features.export.outcome {
        Some(Outcome::Done(d)) => {
            eprintln!(
                "exported {} ({} bytes, {} frames, {:?}) in {:.1} s",
                d.path.display(),
                d.bytes,
                d.frames,
                d.encoder,
                d.seconds
            );
            assert_eq!(d.frames, 60, "In to Out is 2 s");
            assert!(d.verified.as_ref().is_some_and(|v| v.ok), "the file checks itself: {:?}", d.verified);
            assert!(d.faststart);
        }
        Some(Outcome::Failed(f)) => panic!("the export failed: {} {}", f.code, f),
        _ => panic!("no result"),
    }
    // two queued jobs run one after the other
    for name in ["q1.mp4", "q2.mp4"] {
        let s = h.state_mut();
        s.features.export.form.path = dir.join(name).to_string_lossy().into_owned();
        // typed in, as the path field marks it; adding to the queue clears the mark for the next suggestion
        s.features.export.form.path_touched = true;
        cut_app::export::start_export(s, true, &ctx);
    }
    assert_eq!(h.state().features.export.queue.len(), 2);
    until(&mut h, 240, |s| s.features.export.queue.iter().all(|j| !j.live()));
    let states: Vec<JobState> = h.state().features.export.queue.iter().map(|j| j.state).collect();
    assert_eq!(states, [JobState::Done, JobState::Done], "both queued exports ran");
    for name in ["q1.mp4", "q2.mp4", "range.mp4"] {
        assert!(dir.join(name).exists(), "{name} written");
    }
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
