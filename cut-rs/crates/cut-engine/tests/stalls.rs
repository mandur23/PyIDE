//! Real-time playback as the app drives it (ignored; `cargo test --release -p cut-engine --test stalls -- --ignored
//! --nocapture --test-threads 1`): the demo's start, a 720p clip from 0 to 3 s then a 1080p clip, each frame
//! prefetched 2 s ahead and rendered without waiting at 60 Hz, then the GPU drained; every frame whose render or GPU
//! work took longer than a frame is printed with its time, and the worst of each.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::{Duration, Instant};

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind, Project};

fn file(w: u32, h: u32, frames: u32) -> String {
    let name = format!("playback-h264-{w}x{h}-{frames}.mp4");
    let s = decode_common::make::settings(Codec::H264, w, h);
    let path = decode_common::make::video(&name, &s, frames, decode_common::make::Timing::Constant);
    path.to_str().expect("a path").to_string()
}

fn demo() -> Project {
    let (small, big) = (file(1280, 720, 150), file(1920, 1080, 150));
    let mut p = project(1920, 1080);
    let a = media(&mut p, "m720", &small, MediaKind::Video, 1280.0, 720.0, (150 * F) as f64);
    let b = media(&mut p, "m1080", &big, MediaKind::Video, 1920.0, 1080.0, (150 * F) as f64);
    put(&mut p, "s1", clip("c720", "V1", 0, 0.0, (90 * F) as f64, of_media(a)));
    let mut c = clip("c1080", "V1", 90 * F, 0.0, (150 * F) as f64, of_media(b));
    c.effects.push(effect("e1", "color.bw", serde_json::json!({})));
    c.effects.push(effect("e2", "color.basic", serde_json::json!({ "exposure": 0.3, "contrast": 15 })));
    put(&mut p, "s1", c);
    reload(&p).0
}

/// One frame of the run: when (s), the render's CPU time and the GPU's time to finish it (ms), complete or not.
struct Tick {
    at: f64,
    render: f64,
    gpu: f64,
    complete: bool,
}

fn run(label: &str) -> (f64, f64) {
    let p = demo();
    let s1 = Id::new("s1");
    let mut e = Engine::headless().expect("a GPU");
    let _ = e.warm_pipelines().join();
    e.render(&p, s1, 0, (1920, 1080), &RenderOptions::default()).expect("a render");
    let _ = e.device().poll(wgpu::PollType::wait_indefinitely());
    let period = Duration::from_micros(16_667);
    let start = Instant::now();
    let mut ticks = Vec::new();
    let mut next = start;
    while start.elapsed() < Duration::from_secs(6) {
        let at = start.elapsed().as_secs_f64();
        let t = (at * cut_time::TICKS as f64) as i64;
        let t0 = Instant::now();
        e.prefetch(&p, s1, t, t + 2 * SEC, false);
        let r = e.render(&p, s1, t, (1920, 1080), &RenderOptions::default()).expect("a render");
        let render = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let _ = e.device().poll(wgpu::PollType::wait_indefinitely());
        let gpu = t1.elapsed().as_secs_f64() * 1000.0;
        ticks.push(Tick { at, render, gpu, complete: r.complete });
        next += period;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
    for k in ticks.iter().filter(|k| k.render + k.gpu > 16.7) {
        eprintln!(
            "{label}: at {:.3} s render {:.1} ms, GPU {:.1} ms{}",
            k.at,
            k.render,
            k.gpu,
            if k.complete { "" } else { " (incomplete)" }
        );
    }
    let worst_render = ticks.iter().map(|k| k.render).fold(0.0, f64::max);
    let worst_gpu = ticks.iter().map(|k| k.gpu).fold(0.0, f64::max);
    let late = ticks.iter().filter(|k| k.render + k.gpu > 33.4).count();
    let mut gpu: Vec<f64> = ticks.iter().map(|k| k.gpu).collect();
    gpu.sort_by(f64::total_cmp);
    eprintln!(
        "{label}: {} frames, {late} over two periods, worst render {worst_render:.1} ms, GPU median {:.1} ms, \
         worst {worst_gpu:.1} ms",
        ticks.len(),
        gpu[gpu.len() / 2]
    );
    (worst_render, worst_gpu)
}

#[test]
#[ignore]
fn demo_start_in_real_time() {
    for i in 0..5 {
        run(&format!("run {i}"));
    }
}
