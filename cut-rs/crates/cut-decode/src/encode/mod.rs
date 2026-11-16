//! Encoding through Media Foundation: H.264 and HEVC on each GPU's hardware encoder transform or in software, and
//! AAC-LC. [`VideoEncoder`] and [`AacEncoder`] stream (the export feeds them a picture or a second of sound at a
//! time); [`encode_video`] and [`encode_aac`] encode a whole clip at once for the test media generators. Samples come
//! back as MP4 wants them (length-prefixed NAL units with an avcC or hvcC, raw AAC with its AudioSpecificConfig),
//! ready for `cut_formats::mp4::write`.

mod audio;
mod list;
mod nal;
mod reader;
mod upload;
mod video;

pub use audio::{AAC_BITRATES, AacEncoder};
pub use list::{EncoderInfo, video_encoders};
pub use reader::{SourceReaderReport, read_with_source_reader};
pub use video::{EncoderConfig, RateControl, VideoEncoder, software};

use crate::Codec;
use crate::error::Result;

/// What to encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoSettings {
    /// H.264 (High profile) or HEVC (Main, or Main 10 with `ten_bit`).
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    /// Frames a second as `[num, den]`.
    pub fps: [u32; 2],
    /// Bits a second.
    pub bitrate: u32,
    /// A sync sample every this many frames.
    pub key_every: u32,
    /// B-frames between references (0: none).
    pub b_frames: u32,
    /// P010 pictures in, Main 10 out (HEVC only).
    pub ten_bit: bool,
}

/// An encoded video stream.
#[derive(Debug, Clone)]
pub struct EncodedVideo {
    /// The WebCodecs codec string (`avc1.640028`, `hvc1.1.6.L120.B0` ...).
    pub codec: String,
    /// The avcC or hvcC.
    pub description: Vec<u8>,
    /// In decode order.
    pub samples: Vec<EncodedSample>,
    /// The encoder used.
    pub encoder: String,
}

/// One encoded picture or block of sound: its bytes and its times in 100 ns units.
#[derive(Debug, Clone)]
pub struct EncodedSample {
    pub data: Vec<u8>,
    pub key: bool,
    pub pts: i64,
    pub dts: i64,
}

/// Encodes `frames` pictures in software, `draw(i, pixels)` painting picture `i` as NV12 (P010 when `ten_bit`) of the
/// full size.
pub fn encode_video(s: &VideoSettings, frames: u32, mut draw: impl FnMut(u32, &mut [u8])) -> Result<EncodedVideo> {
    let mut enc = software(&EncoderConfig::plain(*s))?;
    let mut pixels = vec![0u8; enc.frame_bytes()];
    let mut samples = Vec::new();
    let go_on = || false;
    for i in 0..frames {
        draw(i, &mut pixels);
        let pitch = pixels.len() / (s.height as usize * 3 / 2);
        enc.push(u64::from(i), &pixels, pitch, false, &mut samples, &go_on)?;
    }
    enc.finish(&mut samples, &go_on)?;
    let (codec, description) = enc.description()?;
    Ok(EncodedVideo { codec, description, samples, encoder: enc.name().to_owned() })
}

/// An encoded AAC stream.
#[derive(Debug, Clone)]
pub struct EncodedAudio {
    /// `mp4a.40.2`.
    pub codec: String,
    /// The AudioSpecificConfig.
    pub description: Vec<u8>,
    /// Blocks of 1024 samples a channel, their times as the encoder stamped them.
    pub samples: Vec<EncodedSample>,
}

/// Encodes interleaved 16-bit `pcm` (`rate` 44100 or 48000, `channels` 1, 2 or 6) to AAC-LC at `bytes_per_second`
/// (12000, 16000, 20000 or 24000, the encoder's choices).
pub fn encode_aac(pcm: &[i16], rate: u32, channels: u32, bytes_per_second: u32) -> Result<EncodedAudio> {
    let mut enc = AacEncoder::new(rate, channels, bytes_per_second * 8)?;
    let ch = channels as usize;
    let mut samples = Vec::new();
    let mut planes = vec![Vec::with_capacity(1024); ch];
    for chunk in pcm.chunks(1024 * ch) {
        for (c, p) in planes.iter_mut().enumerate() {
            p.clear();
            p.extend(chunk.iter().skip(c).step_by(ch).map(|v| f32::from(*v) / 32767.0));
        }
        let refs: Vec<&[f32]> = planes.iter().map(Vec::as_slice).collect();
        enc.push(&refs, &mut samples)?;
    }
    enc.finish(&mut samples)?;
    Ok(EncodedAudio { codec: "mp4a.40.2".into(), description: enc.description().to_vec(), samples })
}
