//! Playback speed and cost (ignored; `cargo test --release -p cut-engine --test playback -- --ignored --nocapture
//! --test-threads 1`): 1, 3 and 6 simultaneous 1080p layers and one 4K layer, each with Lumetri Color, every frame
//! drawn whole (decoding included); frames a second, CPU cores busy, GPU engine use, memory, and the time from a
//! random seek to its first whole frame.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::{Duration, Instant};

use common::*;
use cut_decode::Codec;
use cut_decode::metrics::{GpuUse, process_cpu, process_memory};
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind, Project, Props};
use cut_oracle::Inputs;
use serde_json::json;

const MB: f64 = 1024.0 * 1024.0;

fn file(w: u32, h: u32, frames: u32) -> String {
    let name = format!("playback-h264-{w}x{h}-{frames}.mp4");
    let path = decode_common::make::video(
        &name,
        &decode_common::make::settings(Codec::H264, w, h),
        frames,
        decode_common::make::Timing::Constant,
    );
    path.to_str().expect("a path").to_string()
}

/// `layers` clips of the file stacked on V1.. (each smaller than the one under it), Lumetri Color on each.
fn stack(path: &str, w: u32, h: u32, frames: u32, layers: usize) -> Project {
    let mut p = cut_model::defaults::project();
    p.sequences.clear();
    let o = cut_model::defaults::SequenceOpts {
        w: i64::from(w),
        h: i64::from(h),
        video_tracks: layers.max(1),
        audio_tracks: 1,
        ..Default::default()
    };
    p.sequences.push(cut_model::defaults::sequence(Id::new("s1"), &o));
    let tracks = (1..=layers).map(|i| format!("V{i}")).collect::<Vec<_>>();
    let len = i64::from(frames) * F;
    let m = media(&mut p, "m1", path, MediaKind::Video, f64::from(w), f64::from(h), len as f64);
    for (i, track) in tracks.iter().enumerate() {
        let mut c = clip(&format!("c{i}"), track, 0, 0.0, len as f64, of_media(m));
        if let Props::Video(v) = &mut c.props {
            v.scale = [100.0 - 12.0 * i as f64; 2];
            v.opacity = 90.0;
        }
        c.effects.push(effect(
            "e1",
            "color.basic",
            json!({ "exposure": 0.3, "contrast": 15, "saturation": 120, "temperature": 10 * i as i64 }),
        ));
        put(&mut p, "s1", c);
    }
    reload(&p).0
}

/// The frame number the test picture shows (`cut-decode/tests/common/make.rs draw`), read from a render's pixels.
fn number(img: &[u8], w: u32, h: u32) -> u32 {
    let (top, height, block) = (h / 20, h / 10, w / 16);
    (0..16).fold(0, |n, k| {
        let (x, y) = (k * block + block / 2, top + height / 2);
        (n << 1) | u32::from(img[((y * w + x) * 4 + 1) as usize] > 128)
    })
}

fn gpu_line(span: Vec<cut_decode::metrics::EngineUse>) -> String {
    let mut s = String::new();
    for e in span.iter().filter(|e| e.percent >= 0.5) {
        let name = e.adapter.split_whitespace().take(3).collect::<Vec<_>>().join(" ");
        s.push_str(&format!("{name} {} {:.0}%, ", e.engine, e.percent));
    }
    if s.is_empty() { "none measurable".into() } else { s.trim_end_matches(", ").into() }
}

fn play(label: &str, p: &Project, w: u32, h: u32, frames: u32) {
    let s1 = Id::new("s1");
    let mut e = Engine::headless().expect("a GPU");
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    e.render(p, s1, 0, (w, h), &wait).expect("a render");
    let _ = e.read_pixels();
    let n = i64::from(frames) - 1;
    let mut runs = Vec::new();
    let mut lines = Vec::new();
    for _ in 0..5 {
        let (cpu0, start, gpu) = (process_cpu(), Instant::now(), GpuUse::start());
        for f in 1..=n {
            let t = f * F;
            e.prefetch(p, s1, t, t + SEC, false);
            let r = e.render(p, s1, t, (w, h), &wait).expect("a render");
            assert!(r.complete && r.failed.is_empty(), "frame {f} drawn whole");
        }
        let _ = e.read_pixels();
        let wall = start.elapsed().as_secs_f64();
        let cores = (process_cpu() - cpu0).as_secs_f64() / wall;
        let fps = n as f64 / wall;
        runs.push(fps);
        let mem = process_memory();
        lines.push((fps, cores, gpu.map(GpuUse::finish).map(gpu_line).unwrap_or_default(), mem));
        // back to the start: the decoders restart at frame 1
        e.render(p, s1, 0, (w, h), &wait).expect("a render");
    }
    lines.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (fps, cores, gpu, mem) = &lines[2];
    let m = e.memory();
    let vram: Vec<String> = cut_decode::metrics::video_memory()
        .iter()
        .filter(|v| v.local + v.shared >= 1 << 20)
        .map(|v| format!("{} {:.0} MB + {:.0} MB shared", v.adapter, v.local as f64 / MB, v.shared as f64 / MB))
        .collect();
    eprintln!(
        "{label}: median {fps:.1} fps of 5 runs ({:.1} to {:.1}); {cores:.2} cores busy; GPU {gpu}; private {:.0} MB, \n         working set {:.0} MB (peak {:.0} MB); video memory {}; frames {:.0} MB in memory, {:.0} MB on the GPU, \n         pooled pictures {:.0} MB, uploaded planes {:.0} MB; decoders {:?}",
        lines[0].0,
        lines[4].0,
        mem.private as f64 / MB,
        mem.working_set as f64 / MB,
        mem.peak_working_set as f64 / MB,
        vram.join(", "),
        m.frames_ram as f64 / MB,
        m.frames_vram as f64 / MB,
        m.pooled as f64 / MB,
        m.uploads as f64 / MB,
        e.decoders().iter().map(|(_, d)| d.clone().unwrap_or_default()).collect::<Vec<_>>().first(),
    );
}

#[test]
#[ignore]
fn playback_1_3_6_1080p_layers_and_4k() {
    let hd = file(1920, 1080, 150);
    for layers in [1, 3, 6] {
        let p = stack(&hd, 1920, 1080, 150, layers);
        play(&format!("1080p x{layers} + Lumetri"), &p, 1920, 1080, 150);
    }
    let uhd = file(3840, 2160, 90);
    let p = stack(&uhd, 3840, 2160, 90, 1);
    play("4K x1 + Lumetri", &p, 3840, 2160, 90);
}

#[test]
#[ignore]
fn seek_three_1080p_sources() {
    let hd = file(1920, 1080, 150);
    let p = stack(&hd, 1920, 1080, 150, 3);
    let s1 = Id::new("s1");
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    let mut e = Engine::headless().expect("a GPU");
    e.render(&p, s1, 0, (1920, 1080), &wait).expect("a render");
    let mut r = Inputs::new(7);
    let (mut warm, mut cold) = (Vec::new(), Vec::new());
    for _ in 0..12 {
        // a fresh engine (decoders opened by the seek) and the same engine seeking elsewhere
        let t = r.range(0, 149) * F;
        let mut fresh = Engine::headless().expect("a GPU");
        fresh.render(&p, s1, 0, (1920, 1080), &RenderOptions::default()).expect("pipelines made");
        let t0 = Instant::now();
        fresh.render(&p, s1, t, (1920, 1080), &wait).expect("a render");
        let _ = fresh.read_pixels();
        cold.push(t0.elapsed());
        let to = r.range(0, 149) * F;
        let t1 = Instant::now();
        e.render(&p, s1, to, (1920, 1080), &wait).expect("a render");
        let _ = e.read_pixels();
        warm.push(t1.elapsed());
    }
    let all: Vec<Duration> = {
        let mut a = [warm.clone(), cold.clone()].concat();
        a.sort();
        a
    };
    warm.sort();
    cold.sort();
    // The first picture a seek shows from its own key frame on (renders that do not wait), read from the frame
    // number of the top clip: three plain clips of the file, the top one covering the others.
    let mut plain = stack(&hd, 1920, 1080, 150, 3);
    for t in &mut plain.sequences[0].tracks {
        for c in &mut t.clips {
            c.effects.clear();
            if let Props::Video(v) = &mut c.props {
                v.scale = [100.0; 2];
                v.opacity = 100.0;
            }
        }
    }
    let plain = reload(&plain).0;
    let mut e = Engine::headless().expect("a GPU");
    e.render(&plain, s1, 0, (1920, 1080), &wait).expect("a render");
    let mut first = Vec::new();
    let opts = RenderOptions::default();
    for _ in 0..12 {
        let f = r.range(0, 149);
        let key = f - f % 30;
        let t0 = Instant::now();
        loop {
            e.render(&plain, s1, f * F, (1920, 1080), &opts).expect("a render");
            let n = i64::from(number(&e.read_pixels(), 1920, 1080));
            if (key..=f).contains(&n) {
                break;
            }
            assert!(t0.elapsed() < Duration::from_secs(10), "a picture came");
        }
        first.push(t0.elapsed());
        e.render(&plain, s1, f * F, (1920, 1080), &wait).expect("a render");
    }
    first.sort();
    eprintln!(
        "random seek to its first picture (a render that does not wait), same engine: median {:?}, worst {:?}",
        first[first.len() / 2],
        first[first.len() - 1]
    );
    eprintln!(
        "random seek to the whole frame, 3 sources: median {:?}, worst {:?} (same engine: median {:?}, worst {:?}; \
         new engine: median {:?}, worst {:?})",
        all[all.len() / 2],
        all[all.len() - 1],
        warm[warm.len() / 2],
        warm[warm.len() - 1],
        cold[cold.len() / 2],
        cold[cold.len() - 1],
    );
}

fn memory_line(stage: &str) {
    let m = process_memory();
    let vram: Vec<String> = cut_decode::metrics::video_memory()
        .iter()
        .filter(|v| v.local + v.shared >= 1 << 20)
        .map(|v| format!("{} {:.0} + {:.0} shared", v.adapter, v.local as f64 / MB, v.shared as f64 / MB))
        .collect();
    eprintln!("{stage}: private {:.0} MB, video memory {}", m.private as f64 / MB, vram.join(", "));
}

#[test]
#[ignore]
fn memory_by_stage() {
    let hd = file(1920, 1080, 150);
    memory_line("before anything");
    let mut e = Engine::headless().expect("a GPU");
    memory_line("a device");
    let s1 = Id::new("s1");
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    for layers in [1, 3, 6] {
        let p = stack(&hd, 1920, 1080, 150, layers);
        e.render(&p, s1, 0, (1920, 1080), &wait).expect("a render");
        let _ = e.read_pixels();
        memory_line(&format!("{layers} layers, first frame"));
        for f in 1..150 {
            e.render(&p, s1, f * F, (1920, 1080), &wait).expect("a render");
        }
        let _ = e.read_pixels();
        let m = e.memory();
        memory_line(&format!(
            "{layers} layers, played (frames {:.0} MB on the GPU, pooled pictures {:.0} MB)",
            m.frames_vram as f64 / MB,
            m.pooled as f64 / MB
        ));
    }
    drop(e);
    memory_line("engine dropped");
}
