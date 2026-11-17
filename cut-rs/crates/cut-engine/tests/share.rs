//! The GPU the engine runs on and the two ways a hardware decoder's frames reach it: shared on the GPU
//! (`cut_decode::share`) and read back to memory, which must give the same pictures.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::Duration;

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind, Project};

#[test]
fn the_engine_runs_on_direct3d_12_when_there_is_an_adapter_for_it() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
    for a in &adapters {
        let i = a.get_info();
        eprintln!("adapter: {} {:?} {:?}", i.name, i.backend, i.device_type);
    }
    // what eframe asks for when told nothing (egui-wgpu 0.37 `WgpuSetupCreateNew::without_display_handle`)
    let default = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
        apply_limit_buckets: false,
    }));
    if let Ok(d) = default {
        let i = d.get_info();
        eprintln!("eframe's default: {} {:?}", i.name, i.backend);
    }
    let picked = cut_engine::gpu::pick_adapter(&adapters).expect("an adapter");
    let i = picked.get_info();
    eprintln!("picked: {} {:?}", i.name, i.backend);
    if adapters.iter().any(|a| a.get_info().backend == wgpu::Backend::Dx12) {
        assert_eq!(i.backend, wgpu::Backend::Dx12);
    }
    let e = Engine::headless().expect("a GPU");
    eprintln!("frame sharing: {:?}", e.frame_sharing());
    if i.backend == wgpu::Backend::Dx12 && picked.features().contains(wgpu::Features::TEXTURE_FORMAT_NV12) {
        assert!(e.frame_sharing().is_ok(), "{:?}", e.frame_sharing());
    }
}

fn one_clip(path: &str, w: u32, h: u32, frames: u32) -> Project {
    let mut p = project(i64::from(w), i64::from(h));
    let len = i64::from(frames) * F;
    let m = media(&mut p, "m1", path, MediaKind::Video, f64::from(w), f64::from(h), len as f64);
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, len as f64, of_media(m)));
    reload(&p).0
}

/// Frames `at` of the file drawn by an engine whose frames are shared, then by one whose frames are read back.
fn both_routes(name: &str, path: &str, w: u32, h: u32, frames: u32, at: &[u32]) {
    let p = one_clip(path, w, h, frames);
    let wait = RenderOptions { wait: Some(Duration::from_secs(30)), ..Default::default() };
    let mut pictures = Vec::new();
    for share in [true, false] {
        let mut e = Engine::headless().expect("a GPU");
        if e.frame_sharing().is_err() {
            eprintln!("{name}: no frame sharing here ({:?}), nothing to compare", e.frame_sharing());
            return;
        }
        e.set_frame_sharing(share);
        let mut got = Vec::new();
        for &f in at {
            let r = e.render(&p, Id::new("s1"), i64::from(f) * F, (w, h), &wait).expect("a render");
            assert!(r.complete && r.failed.is_empty(), "{name} frame {f} drawn whole");
            got.push(e.read_pixels());
        }
        let decoder = e.decoders().into_iter().next().and_then(|(_, d)| d).unwrap_or_default();
        eprintln!("{name} share {share}: {decoder}");
        if !decoder.starts_with("Hardware") {
            eprintln!("{name}: decoded in software here, nothing to compare");
            return;
        }
        assert_eq!(decoder.ends_with(" shared"), share, "{name}: {decoder}");
        pictures.push(got);
    }
    for (k, (a, b)) in pictures[0].iter().zip(&pictures[1]).enumerate() {
        let differ = a.iter().zip(b).filter(|(x, y)| x != y).count();
        let worst = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        if differ > 0 {
            write_png(&format!("share-{name}-{k}-shared.png"), a, w, h);
            write_png(&format!("share-{name}-{k}-memory.png"), b, w, h);
        }
        assert_eq!((differ, worst), (0, 0), "{name} frame {}: bytes that differ, largest difference", at[k]);
    }
}

#[test]
fn shared_frames_are_the_frames_read_back_h264() {
    let path = decode_common::make::video(
        "share-h264-1280x720.mp4",
        &decode_common::make::settings(Codec::H264, 1280, 720),
        60,
        decode_common::make::Timing::Constant,
    );
    both_routes("h264", path.to_str().expect("a path"), 1280, 720, 60, &[0, 1, 17, 45, 30, 59]);
}

#[test]
fn shared_frames_are_the_frames_read_back_hevc() {
    let s = decode_common::make::settings(Codec::Hevc, 1280, 720);
    // Windows has an HEVC encoder only with the HEVC Video Extension (a CI runner has none).
    if let Err(e) = cut_decode::encode::encode_video(&s, 1, |i, px| decode_common::make::draw(i, px, 1280, 720, false))
    {
        eprintln!("skipped: no HEVC file can be made here: {e}");
        return;
    }
    let path = decode_common::make::video("share-hevc-1280x720.mp4", &s, 60, decode_common::make::Timing::Constant);
    both_routes("hevc", path.to_str().expect("a path"), 1280, 720, 60, &[0, 2, 31, 59]);
}

#[test]
fn shared_frames_are_the_frames_read_back_vp9() {
    let path = decode_common::more::vpx_webm("share-vp9-640x360.webm", Codec::Vp9, 640, 360, 30);
    both_routes("vp9", path.to_str().expect("a path"), 640, 360, 30, &[0, 5, 29]);
}

#[test]
fn shared_frames_are_the_frames_read_back_hevc_10_bit() {
    let s =
        cut_decode::encode::VideoSettings { ten_bit: true, ..decode_common::make::settings(Codec::Hevc, 1280, 720) };
    // P010 frames need a Main 10 file, and this PC may have no encoder that writes one.
    let probe = cut_decode::encode::encode_video(&s, 1, |i, px| decode_common::make::draw(i, px, 1280, 720, true));
    if let Err(e) = probe {
        eprintln!("no Main 10 file can be made here: {e}");
        return;
    }
    let path = decode_common::make::video("share-hevc10-1280x720.mp4", &s, 60, decode_common::make::Timing::Constant);
    both_routes("hevc10", path.to_str().expect("a path"), 1280, 720, 60, &[0, 3, 40]);
}
