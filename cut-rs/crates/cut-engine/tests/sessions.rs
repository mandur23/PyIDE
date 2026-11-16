//! How many hardware decoders each GPU opens at once (ignored; `cargo test --release -p cut-engine --test sessions --
//! --ignored --nocapture`): decoders of a 1080p H.264 file are opened on one adapter, each decoding a frame and
//! holding it, until one fails or 96 are open, and the video memory they take (`route` decides from what this prints).

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use cut_decode::{Accel, Codec, FrameSource, PixelFormat};

#[test]
#[ignore]
fn hardware_decoders_open_at_once_per_adapter() {
    let path = decode_common::make::video(
        "playback-h264-1920x1080-150.mp4",
        &decode_common::make::settings(Codec::H264, 1920, 1080),
        150,
        decode_common::make::Timing::Constant,
    );
    let (reader, source) = decode_common::open(&path);
    let track = decode_common::video(&source);
    let t = track.samples.pts[track.samples.order[20] as usize];
    for (adapter, name) in cut_decode::adapters().iter().enumerate() {
        let adapter = adapter as u32;
        if !cut_decode::gpu_decodes(Some(adapter), Codec::H264, PixelFormat::Nv12) {
            eprintln!("{name}: no DXVA H.264 decoder");
            continue;
        }
        let mut open = Vec::new();
        let mut why = String::from("none failed");
        while open.len() < 96 {
            let opened = FrameSource::new(&reader, track, Accel::Hardware { adapter: Some(adapter) })
                .and_then(|mut fs| fs.frame_at(t).map(|_| ()).map(|()| fs));
            match opened {
                Ok(fs) => open.push(fs),
                Err(e) => {
                    why = e.to_string();
                    break;
                }
            }
        }
        let mem = cut_decode::metrics::video_memory();
        let m = mem.iter().find(|m| &m.adapter == name);
        eprintln!(
            "{name}: {} hardware decoders open at once ({why}); video memory {:.0} MB local, {:.0} MB shared, \
             budget {:.0} MB",
            open.len(),
            m.map_or(0.0, |m| m.local as f64 / 1048576.0),
            m.map_or(0.0, |m| m.shared as f64 / 1048576.0),
            m.map_or(0.0, |m| m.budget as f64 / 1048576.0),
        );
        assert!(!open.is_empty(), "{name} opens a hardware decoder");
    }
}
