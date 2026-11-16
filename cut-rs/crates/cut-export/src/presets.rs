//! Export and sequence presets (`presets.js`): what each export preset writes, the settings it resolves to for a
//! sequence (size, the codec string with the H.264 or HEVC level that fits, the bitrate for the frame rate, the key
//! frame interval in frames), the size and time estimates the dialog shows, and the New Sequence dialog's presets.

use cut_time::{FRAME_RATES, Fps, TICKS, Ticks};
use serde::{Deserialize, Serialize};

/// Video or sound only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Audio,
}

/// The video codec family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    H264,
    Hevc,
}

/// Rate control as the dialog offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RateMode {
    Variable,
    Constant,
}

/// A preset's video: bits a second at up to 30 fps and above 30 fps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoPreset {
    pub codec: Family,
    pub bitrate: [f64; 2],
    pub mode: RateMode,
    pub key_seconds: f64,
}

/// An export preset; `name` is English, shown through `tr()`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    pub ext: &'static str,
    pub w: Option<u32>,
    pub h: Option<u32>,
    pub video: Option<VideoPreset>,
    pub audio_bitrate: u32,
    pub loudness: Option<f64>,
}

const fn video(w: u32, h: u32, low: f64, high: f64) -> (Option<u32>, Option<u32>, Option<VideoPreset>) {
    let v = VideoPreset { codec: Family::H264, bitrate: [low, high], mode: RateMode::Variable, key_seconds: 2.0 };
    (Some(w), Some(h), Some(v))
}

const fn preset(
    id: &'static str,
    name: &'static str,
    size: (Option<u32>, Option<u32>, Option<VideoPreset>),
    audio: u32,
) -> Preset {
    let kind = if size.2.is_some() { Kind::Video } else { Kind::Audio };
    let ext = if size.2.is_some() { "mp4" } else { "m4a" };
    Preset { id, name, kind, ext, w: size.0, h: size.1, video: size.2, audio_bitrate: audio, loudness: Some(-14.0) }
}

/// The export presets, in the dialog's order.
pub const EXPORT: [Preset; 5] = [
    preset("youtube-1080p", "YouTube 1080p", video(1920, 1080, 10e6, 15e6), 192_000),
    preset("youtube-4k", "YouTube 4K", video(3840, 2160, 40e6, 60e6), 192_000),
    preset("shorts", "Shorts and Reels", video(1080, 1920, 10e6, 15e6), 192_000),
    preset("720p", "720p light", video(1280, 720, 5e6, 7.5e6), 160_000),
    preset("audio-m4a", "Audio only (M4A)", (None, None, None), 192_000),
];

/// A loudness target the dialog offers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessTarget {
    pub id: &'static str,
    pub name: &'static str,
    pub lufs: f64,
}

pub const LOUDNESS: [LoudnessTarget; 2] = [
    LoudnessTarget { id: "youtube", name: "YouTube", lufs: -14.0 },
    LoudnessTarget { id: "broadcast", name: "Broadcast", lufs: -24.0 },
];

/// AAC bitrates: Windows' AAC encoder (Media Foundation) takes 96, 128, 160 and 192 kbps only.
pub const AUDIO_BITRATES: [u32; 3] = [128_000, 160_000, 192_000];
pub const AUDIO_RATE: u32 = 48_000;

/// A preset of the New Sequence dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SequencePreset {
    pub id: &'static str,
    pub name: &'static str,
    pub w: u32,
    pub h: u32,
    pub fps: Fps,
}

pub const SEQUENCE: [SequencePreset; 4] = [
    SequencePreset { id: "youtube-1080p30", name: "YouTube 1080p30", w: 1920, h: 1080, fps: Fps::new(30, 1) },
    SequencePreset { id: "youtube-4k30", name: "YouTube 4K30", w: 3840, h: 2160, fps: Fps::new(30, 1) },
    SequencePreset { id: "shorts", name: "Shorts 1080x1920", w: 1080, h: 1920, fps: Fps::new(30, 1) },
    SequencePreset { id: "square", name: "Square 1080x1080", w: 1080, h: 1080, fps: Fps::new(30, 1) },
];

/// The export preset of an id.
pub fn get(id: &str) -> Option<&'static Preset> {
    EXPORT.iter().find(|p| p.id == id)
}

/// `Math.round`: half goes up, below zero too.
pub(crate) fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// H.264 levels: level_idc, max macroblocks a second, max frame size in macroblocks, max High-profile bitrate.
const AVC_LEVELS: [(u32, f64, f64, f64); 12] = [
    (30, 40500.0, 1620.0, 12.5e6),
    (31, 108_000.0, 3600.0, 17.5e6),
    (32, 216_000.0, 5120.0, 25e6),
    (40, 245_760.0, 8192.0, 25e6),
    (41, 245_760.0, 8192.0, 62.5e6),
    (42, 522_240.0, 8704.0, 62.5e6),
    (50, 589_824.0, 22080.0, 168.75e6),
    (51, 983_040.0, 36864.0, 300e6),
    (52, 2_073_600.0, 36864.0, 300e6),
    (60, 4_177_920.0, 139_264.0, 300e6),
    (61, 8_355_840.0, 139_264.0, 600e6),
    (62, 16_711_680.0, 139_264.0, 1000e6),
];

/// The smallest H.264 level that holds the picture size, the macroblock rate, the bitrate and the side limit (a side
/// of at most sqrt(8 * MaxFS) macroblocks).
pub fn avc_level(w: f64, h: f64, fps: f64, bitrate: f64) -> u32 {
    let (mbw, mbh) = ((w / 16.0).ceil(), (h / 16.0).ceil());
    let fs = mbw * mbh;
    let rate = fs * fps;
    for (idc, mbps, max_fs, max_br) in AVC_LEVELS {
        let side = (8.0 * max_fs).sqrt();
        if fs <= max_fs && rate <= mbps && bitrate <= max_br && mbw <= side && mbh <= side {
            return idc;
        }
    }
    62
}

/// `avc1.6400LL`: High profile, no constraint flags.
pub fn avc_codec(w: f64, h: f64, fps: f64, bitrate: f64) -> String {
    format!("avc1.6400{:02x}", avc_level(w, h, fps, bitrate))
}

/// HEVC Main tier levels: level * 30, max luma picture size, max luma samples a second, max bitrate.
const HEVC_LEVELS: [(u32, f64, f64, f64); 10] = [
    (90, 552_960.0, 16_588_800.0, 6e6),
    (93, 983_040.0, 33_177_600.0, 10e6),
    (120, 2_228_224.0, 66_846_720.0, 12e6),
    (123, 2_228_224.0, 133_693_440.0, 20e6),
    (150, 8_912_896.0, 267_386_880.0, 25e6),
    (153, 8_912_896.0, 534_773_760.0, 40e6),
    (156, 8_912_896.0, 1_069_547_520.0, 60e6),
    (180, 35_651_584.0, 1_069_547_520.0, 60e6),
    (183, 35_651_584.0, 2_139_095_040.0, 120e6),
    (186, 35_651_584.0, 4_278_190_080.0, 240e6),
];

/// The smallest HEVC Main tier level (times 30) that holds the picture size, sample rate, bitrate and side limit.
pub fn hevc_level(w: f64, h: f64, fps: f64, bitrate: f64) -> u32 {
    let ps = w * h;
    for (lv, max_ps, max_sr, max_br) in HEVC_LEVELS {
        let side = (8.0 * max_ps).sqrt();
        if ps <= max_ps && ps * fps <= max_sr && bitrate <= max_br && w <= side && h <= side {
            return lv;
        }
    }
    186
}

/// `hvc1.1.6.L<level>.B0`: Main profile, Main tier.
pub fn hevc_codec(w: f64, h: f64, fps: f64, bitrate: f64) -> String {
    format!("hvc1.1.6.L{}.B0", hevc_level(w, h, fps, bitrate))
}

fn even(n: f64) -> u32 {
    (js_round(n / 2.0) * 2.0).max(2.0) as u32
}

fn nearest_audio_bitrate(b: f64) -> u32 {
    AUDIO_BITRATES.iter().copied().fold(AUDIO_BITRATES[0], |best, v| {
        if (f64::from(v) - b).abs() < (f64::from(best) - b).abs() { v } else { best }
    })
}

/// The export dialog's changes to a preset. A JavaScript falsy number (0, NaN) counts as not given, as `o.w || p.w`
/// does there.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overrides {
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub codec: Option<Family>,
    pub bitrate: Option<f64>,
    pub mode: Option<RateMode>,
    pub key_seconds: Option<f64>,
    pub audio_bitrate: Option<f64>,
    /// `None`: the preset's; `Some(None)`: "Do not change" (no target); `Some(Some(lufs))`: that target.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub loudness: Option<Option<f64>>,
}

/// A key that is there, even as `null`, is `Some`.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<f64>>, D::Error> {
    Option::<f64>::deserialize(d).map(Some)
}

fn given(v: Option<f64>) -> Option<f64> {
    v.filter(|x| *x != 0.0 && !x.is_nan())
}

/// The video part of resolved settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub family: Family,
    /// The WebCodecs codec string with the level that fits.
    pub codec: String,
    pub bitrate: u32,
    pub mode: RateMode,
    /// A key frame every this many frames.
    pub key_interval: u32,
}

/// The sound part of resolved settings: AAC-LC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AudioSettings {
    pub codec: String,
    pub rate: u32,
    pub channels: u32,
    pub bitrate: u32,
}

/// The concrete settings of one export (`presets.resolve`), in the JavaScript's JSON shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub ext: String,
    pub width: u32,
    pub height: u32,
    #[serde(with = "fps_pair")]
    pub fps: Fps,
    pub video: Option<VideoSettings>,
    /// `None`: no sound track (a proxy); a preset always has one.
    pub audio: Option<AudioSettings>,
    /// The loudness target in LUFS, or none.
    pub loudness: Option<f64>,
}

mod fps_pair {
    use cut_time::Fps;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(f: &Fps, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq([f.num, f.den])
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Fps, D::Error> {
        let [num, den] = <[u32; 2]>::deserialize(d)?;
        Ok(Fps::new(num, den))
    }
}

/// The settings an export of a sequence of frame rate `fps` and size `size` (`None`: none known) uses with `p`. The
/// frame rate is always the sequence's.
pub fn resolve(p: &Preset, fps: Fps, size: Option<(f64, f64)>, o: &Overrides) -> Settings {
    let fps_v = fps.value();
    let seq_w = size.map(|s| s.0).filter(|v| *v != 0.0 && !v.is_nan());
    let seq_h = size.map(|s| s.1).filter(|v| *v != 0.0 && !v.is_nan());
    let width = even(given(o.w).or(p.w.map(f64::from)).or(seq_w).unwrap_or(1920.0));
    let height = even(given(o.h).or(p.h.map(f64::from)).or(seq_h).unwrap_or(1080.0));
    let audio = AudioSettings {
        codec: "mp4a.40.2".into(),
        rate: AUDIO_RATE,
        channels: 2,
        bitrate: nearest_audio_bitrate(given(o.audio_bitrate).unwrap_or(f64::from(p.audio_bitrate))),
    };
    let video = p.video.map(|v| {
        let family = o.codec.unwrap_or(v.codec);
        let base = if fps_v > 31.0 { v.bitrate[1] } else { v.bitrate[0] };
        let (w, h) = (f64::from(width), f64::from(height));
        let scale = (w * h) / (p.w.map_or(w, f64::from) * p.h.map_or(h, f64::from));
        let bitrate = js_round(given(o.bitrate).unwrap_or(base * scale));
        let key_seconds = given(o.key_seconds).unwrap_or(v.key_seconds);
        VideoSettings {
            family,
            codec: match family {
                Family::Hevc => hevc_codec(w, h, fps_v, bitrate),
                Family::H264 => avc_codec(w, h, fps_v, bitrate),
            },
            bitrate: bitrate.clamp(0.0, f64::from(u32::MAX)) as u32,
            mode: o.mode.unwrap_or(v.mode),
            key_interval: js_round(key_seconds * fps_v).max(1.0).min(f64::from(u32::MAX)) as u32,
        }
    });
    Settings {
        id: p.id.into(),
        name: p.name.into(),
        kind: p.kind,
        ext: p.ext.into(),
        width,
        height,
        fps,
        video,
        audio: Some(audio),
        loudness: o.loudness.unwrap_or(p.loudness),
    }
}

/// Problems with settings a person typed: English sentences for `tr()`.
pub fn validate(s: &Settings) -> Vec<&'static str> {
    let mut errors = Vec::new();
    if s.kind == Kind::Video {
        let (w, h) = (s.width, s.height);
        if !((16..=8192).contains(&w) && (16..=8192).contains(&h)) {
            errors.push("The size must be between 16 and 8192 pixels.");
        }
        if w % 2 != 0 || h % 2 != 0 {
            errors.push("The width and height must be even.");
        }
        if !s.video.as_ref().is_some_and(|v| (100_000..=400_000_000).contains(&v.bitrate)) {
            errors.push("The video bitrate must be between 0.1 and 400 Mbps.");
        }
    }
    if s.audio.as_ref().is_some_and(|a| !AUDIO_BITRATES.contains(&a.bitrate)) {
        errors.push("The audio bitrate must be 128, 160 or 192 kbps.");
    }
    errors
}

/// Container bytes besides the samples: ftyp and mdat headers, moov with about 8 bytes of tables a video frame and
/// 4 an audio frame (1024 samples).
fn overhead(seconds: f64, fps: f64, video: bool) -> f64 {
    let per = (if video { fps * 8.0 } else { 0.0 }) + (f64::from(AUDIO_RATE) / 1024.0) * 4.0;
    1024.0 + (seconds * per).ceil()
}

/// Bytes an export of `duration` ticks with these settings writes, about.
pub fn estimate(s: &Settings, duration: Ticks) -> u64 {
    let seconds = duration.max(0) as f64 / TICKS as f64;
    let bps =
        f64::from(s.video.as_ref().map_or(0, |v| v.bitrate)) + f64::from(s.audio.as_ref().map_or(0, |a| a.bitrate));
    js_round(bps * seconds / 8.0 + overhead(seconds, s.fps.value(), s.video.is_some())) as u64
}

/// The pixels a second a guess assumes before any export was measured: 1080p at about 3x realtime.
pub const GUESS_PIXELS_PER_SECOND: f64 = 1920.0 * 1080.0 * 30.0 * 3.0;

/// Seconds an export will take on this PC; `speed` is the pixels a second the last export measured.
pub fn estimate_seconds(s: &Settings, duration: Ticks, speed: Option<f64>) -> f64 {
    let seconds = duration.max(0) as f64 / TICKS as f64;
    if s.video.is_none() {
        return seconds / 200.0;
    }
    let pixels = f64::from(s.width) * f64::from(s.height) * s.fps.value() * seconds;
    pixels / speed.filter(|v| *v > 0.0).unwrap_or(GUESS_PIXELS_PER_SECOND)
}

/// The sequence settings that fit a media item's picture (a first clip dropped on an empty timeline): its size after
/// rotation and the offered frame rate nearest to its own. `None`: no picture.
pub fn sequence_for(video: Option<(f64, f64, Option<f64>, f64)>) -> (u32, u32, Fps) {
    let Some((w, h, fps, rotation)) = video else { return (1920, 1080, Fps::new(30, 1)) };
    let turned = rotation == 90.0 || rotation == 270.0;
    let (w, h) = if turned { (h, w) } else { (w, h) };
    let want = fps.unwrap_or(30.0);
    let mut best = (f64::INFINITY, Fps::new(30, 1));
    for r in FRAME_RATES {
        let d = (r.value() - want).abs();
        if d < best.0 - 1e-9 {
            best = (d, r);
        }
    }
    (even(w), even(h), best.1)
}
