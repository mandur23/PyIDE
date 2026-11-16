//! Audio configuration records: AAC's AudioSpecificConfig, Opus's OpusHead and its MP4 form dOps, FLAC STREAMINFO.

use serde::Serialize;

use crate::bits::{BitReader, BitWriter};
use crate::bytes::{ByteWriter, le16, le32, starts, u16, u24, u32};
use crate::error::{Result, damaged};

/// The AAC sample rates by index.
pub const AAC_RATES: [u32; 13] =
    [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// What an AAC AudioSpecificConfig says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSpecificConfig {
    pub object_type: u64,
    /// The output rate (with SBR, the extension's).
    pub sample_rate: u64,
    pub channel_config: u64,
    pub channels: u64,
    /// Samples a frame: 1024, or 960.
    pub frame_length: u64,
}

/// Reads an AudioSpecificConfig.
pub fn parse_audio_specific_config(b: &[u8]) -> Result<AudioSpecificConfig> {
    let r = &mut BitReader::new(b, 0);
    let object_type = match r.u(5)? {
        31 => 32 + r.u(6)?,
        t => t,
    };
    let rate = |r: &mut BitReader, index: u64| -> Result<u64> {
        Ok(if index == 15 { r.u(24)? } else { AAC_RATES.get(index as usize).map_or(0, |&v| v.into()) })
    };
    let index = r.u(4)?;
    let mut sample_rate = rate(r, index)?;
    if sample_rate == 0 {
        return damaged("bad AudioSpecificConfig");
    }
    let channel_config = r.u(4)?;
    let mut core = object_type;
    if object_type == 5 || object_type == 29 {
        let ext = r.u(4)?;
        let ext_rate = rate(r, ext)?;
        if ext_rate != 0 {
            sample_rate = ext_rate;
        }
        core = r.u(5)?;
    }
    let mut frame_length = 1024;
    if [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].contains(&core) && r.left() > 0 && r.flag()? {
        frame_length = 960;
    }
    let channels = if channel_config == 7 { 8 } else { channel_config };
    Ok(AudioSpecificConfig { object_type, sample_rate, channel_config, channels, frame_length })
}

/// An AudioSpecificConfig for `object_type` (2 is AAC-LC); `sample_rate` and `channels` as numbers of any kind a
/// file may give (a rate not in the table is written out, channels past 8 become 0).
pub fn build_audio_specific_config(object_type: i64, sample_rate: f64, channels: f64) -> Vec<u8> {
    let mut w = BitWriter::new();
    w.put(object_type, 5);
    match AAC_RATES.iter().position(|&r| f64::from(r) == sample_rate) {
        Some(i) => w.put(i as i64, 4),
        None => w.put(15, 4).put(sample_rate.floor() as i64, 24),
    };
    let config = if channels <= 6.0 {
        channels.floor() as i64
    } else if channels == 8.0 {
        7
    } else {
        0
    };
    w.put(config, 4).put(0, 3);
    w.done()
}

/// `mp4a.40.N`.
pub fn aac_codec_string(object_type: u64) -> String {
    format!("mp4a.40.{object_type}")
}

/// An OpusHead (the Ogg/WebM header, little-endian; what WebCodecs takes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpusHead {
    pub channels: u8,
    pub pre_skip: u16,
    pub input_rate: u32,
    pub gain: i16,
    pub family: u8,
    pub mapping: Vec<u8>,
}

impl Default for OpusHead {
    fn default() -> Self {
        Self { channels: 2, pre_skip: 0, input_rate: 48000, gain: 0, family: 0, mapping: Vec::new() }
    }
}

/// Reads an OpusHead.
pub fn parse_opus_head(b: &[u8]) -> Result<OpusHead> {
    if b.len() < 19 || !starts(b, 0, b"OpusHead") {
        return damaged("bad OpusHead");
    }
    Ok(OpusHead {
        channels: b[9],
        pre_skip: le16(b, 10),
        input_rate: le32(b, 12),
        gain: le16(b, 16) as i16,
        family: b[18],
        mapping: b[19..].to_vec(),
    })
}

/// The OpusHead bytes; the channel mapping only goes in for a family other than 0.
pub fn build_opus_head(h: &OpusHead) -> Vec<u8> {
    let mut b = b"OpusHead".to_vec();
    b.extend([1, h.channels]);
    b.extend(h.pre_skip.to_le_bytes());
    b.extend(h.input_rate.to_le_bytes());
    b.extend(h.gain.to_le_bytes());
    b.push(h.family);
    if h.family != 0 {
        b.extend_from_slice(&h.mapping);
    }
    b
}

/// The OpusHead an MP4 dOps payload stands for.
pub fn opus_head_from_dops(b: &[u8]) -> Result<Vec<u8>> {
    if b.len() < 11 {
        return damaged("bad dOps");
    }
    Ok(build_opus_head(&OpusHead {
        channels: b[1],
        pre_skip: u16(b, 2),
        input_rate: u32(b, 4),
        gain: u16(b, 8) as i16,
        family: b[10],
        mapping: b[11..].to_vec(),
    }))
}

/// The dOps payload for an OpusHead.
pub fn dops_from_opus_head(b: &[u8]) -> Result<Vec<u8>> {
    let h = parse_opus_head(b)?;
    let mut w = ByteWriter::new();
    w.u8(0)
        .u8(h.channels.into())
        .u16(h.pre_skip.into())
        .u32(h.input_rate.into())
        .u16(h.gain.into())
        .u8(h.family.into());
    if h.family != 0 {
        w.bytes(&h.mapping);
    }
    Ok(w.done())
}

/// The STREAMINFO fields of FLAC metadata blocks (a dfLa payload or a file's, with or without `fLaC`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlacStreamInfo {
    pub sample_rate: u32,
    pub channels: u32,
    pub bits: u32,
    pub total_samples: u64,
}

/// The STREAMINFO of FLAC metadata blocks, when there is one.
pub fn parse_flac_stream_info(b: &[u8]) -> Option<FlacStreamInfo> {
    let mut p = if starts(b, 0, b"fLaC") { 4 } else { 0 };
    while p + 4 <= b.len() {
        let kind = b[p] & 127;
        let len = u24(b, p + 1) as usize;
        if kind == 0 && len >= 18 && p + 4 + 18 <= b.len() {
            let s = p + 4;
            let at = |i: usize| u32::from(b[s + i]);
            return Some(FlacStreamInfo {
                sample_rate: (at(10) << 12) | (at(11) << 4) | (at(12) >> 4),
                channels: ((at(12) >> 1) & 7) + 1,
                bits: (((at(12) & 1) << 4) | (at(13) >> 4)) + 1,
                total_samples: (u64::from(at(13) & 15) << 32) | u64::from(u32(b, s + 14)),
            });
        }
        if b[p] & 128 != 0 {
            break;
        }
        p += 4 + len;
    }
    None
}
