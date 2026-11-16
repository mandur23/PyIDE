//! Where each file on screen is decoded, chosen per file when its frame source opens.
//!
//! Measured on this PC (`tests/playback.rs`, `tests/sessions.rs`, NEXT.md): with the engine's device on Direct3D 12,
//! a hardware decoder on that adapter hands its frames over on the GPU ([`cut_decode::share`]) and beats the software
//! decoder at every size and layer count (1080p: 684 against 260 frames a second for one layer, 131 against 54 for
//! six), so it goes first. Neither GPU here limits how many decoders open (96 opened on each without a failure); what
//! runs out is video memory, about 90 MB a 1080p decoder (`tests/playback.rs memory_by_stage`), so a file decodes in
//! software once the process uses more than [`VIDEO_MEMORY_SHARE`] of what the OS lets it have on that adapter. So
//! does a codec or bit depth the adapter has no DXVA profile for, and any file whose hardware decoder fails to open.
//! Without a bridge (another backend, or no NV12 textures) every frame is read back to memory and uploaded, which
//! costs more than software decoding up to 1920 x 1088 (the JavaScript's rule): then hardware goes first only above
//! that size.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use cut_decode::share::Bridge;
use cut_decode::{Accel, Codec, PixelFormat};
use cut_formats::{Media, Track};

/// The part of an adapter's video memory budget past which new files decode in software.
const VIDEO_MEMORY_SHARE: f64 = 0.75;

/// Up to 1920 x 1088 the software decoder goes first when frames cannot stay on the GPU (decoder.js
/// `SOFTWARE_FIRST_PIXELS`).
const SOFTWARE_FIRST_PIXELS: u64 = 1920 * 1088;

/// How one file is decoded.
pub(crate) struct Route {
    pub accel: Accel,
    /// Frames are copied into the engine's device (a hardware decoder on the bridge's adapter).
    pub bridge: Option<Bridge>,
}

impl Route {
    pub(crate) fn software() -> Self {
        Self { accel: Accel::Software, bridge: None }
    }
}

/// Whether the process has video memory left on adapter `index` for another decoder.
fn room_on(index: u32) -> bool {
    cut_decode::metrics::video_memory()
        .iter()
        .find(|m| m.index == index)
        .is_none_or(|m| (m.local as f64) < m.budget as f64 * VIDEO_MEMORY_SHARE)
}

/// Whether adapter `adapter` decodes the codec at the format on the GPU, asked once each.
fn dxva(adapter: u32, codec: Codec, format: PixelFormat) -> bool {
    type Answers = Mutex<HashMap<(u32, Codec, PixelFormat), bool>>;
    static ANSWERS: OnceLock<Answers> = OnceLock::new();
    let mut a = ANSWERS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    *a.entry((adapter, codec, format)).or_insert_with(|| cut_decode::gpu_decodes(Some(adapter), codec, format))
}

/// The route for a video track drawn by an engine whose device `bridge` reaches (`None`: a caller that reads the
/// bytes, as thumbnails do). `share` false reads a hardware decoder's frames on the bridge's adapter back to memory
/// instead of sharing them (the test that both routes give the same pixels).
pub(crate) fn choose(track: &Track, bridge: Option<&Bridge>, share: bool) -> Route {
    let Media::Video(v) = &track.media else { return Route::software() };
    let format = if v.bit_depth > 8 { PixelFormat::P010 } else { PixelFormat::Nv12 };
    let pixels = u64::from(v.width) * u64::from(v.height);
    let Some(codec) = Codec::of(&track.codec) else { return Route::software() };
    if let Some(b) = bridge.filter(|b| !share || b.shares(format))
        && dxva(b.adapter(), codec, format)
    {
        if !room_on(b.adapter()) {
            return Route::software();
        }
        return Route { accel: Accel::Hardware { adapter: Some(b.adapter()) }, bridge: share.then(|| b.clone()) };
    }
    if pixels <= SOFTWARE_FIRST_PIXELS { Route::software() } else { Route { accel: Accel::Auto, bridge: None } }
}
