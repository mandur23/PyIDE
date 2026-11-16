//! Decoding in Nano Studio Cut: the pictures and sound of a [`cut_formats::Track`], without FFmpeg.
//!
//! The native counterpart of `renderer/features/cut/decoder.js` (section 8 of `docs/cut-architecture.md`, "Cut.decoder").
//! Where the JavaScript has WebCodecs, this crate drives Windows Media Foundation decoder transforms (MFTs) directly:
//! cut-formats reads the samples and their times from the file's own tables, and each sample goes into the transform
//! stamped with its presentation rank, so a picture coming out maps back to its sample whatever the decoder does with
//! times. Media Foundation's source reader is not used: the sample tables are the source of truth.
//!
//! [`VideoDecoder`] turns samples into [`Frame`]s (NV12 or P010, in system memory or as a D3D11 texture);
//! [`FrameSource`] answers "the frame shown at time t" the way the engine asks it; [`decode_audio`] gives a whole
//! track as float PCM from time 0.

// The Windows calls are COM through raw pointers: unsafe is allowed in this crate only, every unsafe block sits in a
// small safe wrapper that owns its COM object (`mf`, `d3d`), and the public API is safe.
#![allow(unsafe_code)]

pub mod alac;
mod annexb;
mod error;

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod audio_part;
#[cfg(windows)]
mod d3d;
#[cfg(windows)]
pub mod disk;
#[cfg(windows)]
pub mod encode;
#[cfg(windows)]
pub mod encode_formats;
#[cfg(windows)]
mod flac;
#[cfg(windows)]
mod formats;
#[cfg(windows)]
pub mod metrics;
#[cfg(windows)]
mod mf;
#[cfg(windows)]
mod opus;
#[cfg(windows)]
pub use formats::{Format, Listed};
#[cfg(windows)]
pub mod share;
#[cfg(windows)]
mod source;
#[cfg(windows)]
mod video;

#[cfg(windows)]
pub use audio::{Pcm, decode_audio};
#[cfg(windows)]
pub use audio_part::{Blocks, OPUS_SURROUND, audio_decoder_names, audio_refusal, decode_audio_samples, decodes_audio};
pub use error::{DecodeError, Result};
#[cfg(windows)]
pub use source::{FrameSource, Stats};
#[cfg(windows)]
pub use video::{Accel, Frame, GpuFrame, Path, PixelFormat, Pixels, TextureInfo, VideoDecoder};

/// The decoders this PC's Media Foundation lists for a codec, by name, hardware ones marked; for reports and tests.
#[cfg(windows)]
pub fn decoders(codec: Codec) -> Vec<String> {
    mf::list(codec, false)
}

/// The encoders this PC's Media Foundation lists for a codec (the test media generator uses them).
#[cfg(windows)]
pub fn encoders(codec: Codec) -> Vec<String> {
    mf::list(codec, true)
}

/// The GPUs DXGI lists, in the order `Accel::Hardware { adapter }` counts them.
#[cfg(windows)]
pub fn adapters() -> Vec<String> {
    d3d::adapters()
}

/// Makes DXGI adapter `index` the one decoders open on when not told which (`Accel::Auto`,
/// `Accel::Hardware { adapter: None }`): the app's own GPU, so frames never cross between adapters.
#[cfg(windows)]
pub fn prefer_adapter(index: u32) {
    d3d::prefer(index);
}

/// Whether GPU `adapter` (`None`: the preferred one) has a DXVA decoder for `codec` at `format` (H.264 8-bit, HEVC Main,
/// HEVC Main 10).
#[cfg(windows)]
pub fn gpu_decodes(adapter: Option<u32>, codec: Codec, format: PixelFormat) -> bool {
    d3d::Device::shared(adapter).is_ok_and(|d| d.decodes(codec, format))
}

/// The codecs this crate hands to a decoder transform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Codec {
    H264,
    Hevc,
    Aac,
    Vp8,
    Vp9,
    Av1,
}

impl Codec {
    /// The codec of a WebCodecs codec string (`avc1.*`, `avc3.*`, `hvc1.*`, `hev1.*`, `mp4a.40.*`, `vp8`, `vp09.*`,
    /// `av01.*`; `vp9` as Matroska names a stream without its features), or `None`.
    pub fn of(codec: &str) -> Option<Self> {
        let family = codec.split('.').next().unwrap_or("");
        match family {
            "avc1" | "avc3" => Some(Codec::H264),
            "hvc1" | "hev1" => Some(Codec::Hevc),
            "mp4a" if codec.starts_with("mp4a.40.") => Some(Codec::Aac),
            "vp8" => Some(Codec::Vp8),
            "vp09" | "vp9" => Some(Codec::Vp9),
            "av01" => Some(Codec::Av1),
            _ => None,
        }
    }

    /// Whether samples go to the decoder as they are in the file (VP8, VP9 and AV1 frames), not as Annex B.
    pub fn is_frame_stream(self) -> bool {
        matches!(self, Codec::Vp8 | Codec::Vp9 | Codec::Av1)
    }

    /// The sentence that says why video of this codec is not played on a PC without its decoder, naming the Windows
    /// extension that adds one.
    pub fn missing_decoder(self) -> &'static str {
        match self {
            Codec::Vp8 | Codec::Vp9 => {
                "This PC has no VP8/VP9 decoder. Install the VP9 Video Extensions from the Microsoft Store."
            }
            Codec::Av1 => "This PC has no AV1 decoder. Install the AV1 Video Extension from the Microsoft Store.",
            Codec::Hevc => "This PC has no HEVC decoder. Install the HEVC Video Extensions from the Microsoft Store.",
            Codec::H264 => "This PC has no H.264 decoder.",
            Codec::Aac => "This PC has no AAC decoder.",
        }
    }
}
