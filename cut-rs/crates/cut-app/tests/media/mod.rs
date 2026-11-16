//! The generated test media of `cut-decode`'s tests, made by its own generator (`tests/common/make.rs`, included
//! here so there is one implementation): pictures that show their frame number as a row of blocks, and a tone as AAC.
//! Files are cached by name in `CUT_DECODE_OUT` (else `%TEMP%\cut-decode`), the folder `cut-decode`'s tests use, so
//! the 720p and 1080p clips they made are reused.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use cut_decode::{Codec, PixelFormat};

#[path = "../../../cut-decode/tests/common/make.rs"]
pub mod make;
#[path = "../../../cut-decode/tests/common/mkv.rs"]
pub mod mkv;
#[path = "../../../cut-decode/tests/common/more.rs"]
pub mod more;

/// A decoded picture as `make::read_number` reads it: luma rows, then chroma.
pub struct Got {
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    pub bytes: Vec<u8>,
}

pub fn out_dir() -> PathBuf {
    let dir = std::env::var_os("CUT_DECODE_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cut-decode"));
    std::fs::create_dir_all(&dir).expect("an output directory");
    dir
}

/// The repository's viewer fixtures.
pub fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures/viewers").join(rel)
}

/// 90 frames of 1280 x 720 H.264 at 30 fps (cut-decode's `h264-720p.mp4`).
pub fn h264_720p() -> PathBuf {
    make::video("h264-720p.mp4", &make::settings(Codec::H264, 1280, 720), 90, make::Timing::Constant)
}

/// 300 frames of 1920 x 1080 H.264 at 30 fps with B-frames (cut-decode's bench file).
pub fn h264_1080p() -> PathBuf {
    let s = cut_decode::encode::VideoSettings {
        bitrate: 10_000_000,
        b_frames: 2,
        ..make::settings(Codec::H264, 1920, 1080)
    };
    make::video("bench-h264-1080p.mp4", &s, 300, make::Timing::Constant)
}

/// Eight seconds of a 440 Hz tone (left) and 660 Hz (right) as 48 kHz stereo AAC.
pub fn tone_aac() -> PathBuf {
    let name = "cut-app-tone.m4a";
    let path = out_dir().join(name);
    if path.exists() {
        return path;
    }
    let n = 48000 * 8;
    let mut pcm = Vec::with_capacity(n * 2);
    for i in 0..n {
        let t = i as f64 / 48000.0;
        for f in [440.0, 660.0] {
            pcm.push(((t * f * std::f64::consts::TAU).sin() * 0.3 * 32767.0) as i16);
        }
    }
    make::audio(name, &pcm, 2, 1024)
}

/// The frame number shown in an RGBA picture of the test video scaled to `w` x `h`: the blocks of `make::draw` (a
/// band from h/20 to 3h/20, sixteen blocks across) read at their scaled places, white above mid-grey.
pub fn number_in(rgba: &[u8], w: u32, h: u32) -> u32 {
    let (top, height, block) = (f64::from(h) / 20.0, f64::from(h) / 10.0, f64::from(w) / f64::from(make::BITS));
    let mut n = 0;
    for k in 0..make::BITS {
        let (mut sum, mut count) = (0.0, 0.0);
        let x0 = (f64::from(k) * block + block / 4.0) as u32;
        let x1 = (f64::from(k) * block + block * 3.0 / 4.0) as u32;
        for y in (top + height / 4.0) as u32..(top + height * 3.0 / 4.0) as u32 {
            for x in x0..x1.max(x0 + 1) {
                let p = &rgba[((y * w + x) * 4) as usize..][..3];
                sum += 0.2126 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[2]);
                count += 1.0;
            }
        }
        n = (n << 1) | u32::from(sum / f64::max(count, 1.0) > 127.0);
    }
    n
}

/// A wgpu setup on the PC's GPU (egui_kittest's own prefers a software rasterizer, far too slow for video).
pub fn gpu_setup() -> eframe::egui_wgpu::WgpuSetup {
    use eframe::egui_wgpu::{self, wgpu};
    let mut setup = egui_wgpu::WgpuSetupCreateNew::without_display_handle();
    setup.native_adapter_selector = Some(std::sync::Arc::new(|adapters, _surface| {
        let mut list: Vec<&wgpu::Adapter> = adapters.iter().collect();
        list.sort_by_key(|a| match a.get_info().device_type {
            wgpu::DeviceType::DiscreteGpu => 0,
            wgpu::DeviceType::IntegratedGpu => 1,
            wgpu::DeviceType::Cpu => 3,
            _ => 2,
        });
        list.first().map(|a| (*a).clone()).ok_or_else(|| "no adapter".to_owned())
    }));
    egui_wgpu::WgpuSetup::CreateNew(setup)
}
