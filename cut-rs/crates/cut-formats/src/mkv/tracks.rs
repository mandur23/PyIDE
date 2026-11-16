//! The head of a segment: elements read from the file, Info, Tracks (codecs and their settings), SeekHead and Cues.

use std::borrow::Cow;

use super::ebml::{Fields, MAX_META, elements, float, header, id, text, whole};
use crate::codecs::audio::{
    aac_codec_string, build_audio_specific_config, parse_audio_specific_config, parse_flac_stream_info, parse_opus_head,
};
use crate::codecs::avc::{avc_codec_string, parse_avc_c};
use crate::codecs::color_from_codes;
use crate::codecs::hevc::{hevc_codec_string, parse_hvc_c};
use crate::codecs::vpx::{av1_codec_string, parse_av1_c};
use crate::error::{FormatError, Result};
use crate::reader::{Reader, read_range};
use crate::source::{ColorSpace, Kind, Skipped};

// ---- the head of the segment -----------------------------------------------------------------------------------------

/// An element read from the file: its ID, size and where its data starts. Positions are signed: an
/// unknown size counts as -1, as in the JavaScript.
#[derive(Debug, Clone, Copy)]
pub(super) struct FileEl {
    pub(super) id: u64,
    pub(super) size: i64,
    pub(super) data: i64,
}

pub(super) fn at(pos: i64) -> u64 {
    pos.max(0) as u64
}

pub(super) fn read_element<R: Reader + ?Sized>(reader: &R, pos: i64) -> Result<Option<FileEl>> {
    let b = read_range(reader, at(pos), 12)?;
    Ok(header(&b, 0).map(|h| FileEl {
        id: h.id,
        size: h.size.map_or(-1, |s| s.min(i64::MAX as u64) as i64),
        data: pos.saturating_add(h.hdr as i64),
    }))
}

pub(super) fn read_whole<'r, R: Reader + ?Sized>(reader: &'r R, el: FileEl) -> Result<Option<Cow<'r, [u8]>>> {
    if el.size < 0 || el.size > MAX_META {
        return Ok(None);
    }
    let b = read_range(reader, at(el.data), el.size as u64)?;
    Ok((b.len() as i64 == el.size).then_some(b))
}

pub(super) struct Info {
    pub(super) scale: u64,
    pub(super) duration: Option<f64>,
}

pub(super) fn parse_info(b: &[u8]) -> Info {
    let f = Fields::of(b, whole(b));
    Info {
        scale: match f.uint(id::TIMESTAMP_SCALE) {
            Some(0) | None => 1_000_000,
            Some(s) => s,
        },
        duration: f.get(id::DURATION).map(|e| float(b, e)),
    }
}

/// What a track's codec gives: the codec string and the configuration, and what it says of the format.
#[derive(Default)]
pub(super) struct Codec {
    pub(super) codec: String,
    pub(super) description: Option<Vec<u8>>,
    /// The SPS of AVC and HEVC: its size, colour and bit depth.
    pub(super) sps: Option<(i64, i64, Option<ColorSpace>, u64)>,
    pub(super) bit_depth: Option<u64>,
    pub(super) channels: Option<u64>,
    pub(super) sample_rate: Option<u64>,
    /// Bytes a PCM frame.
    pub(super) pcm: Option<u64>,
    /// VP9's CodecPrivate (feature list), when there.
    pub(super) vp9: Option<Option<Vec<u8>>>,
}

pub(super) struct AudioSettings {
    pub(super) rate: f64,
    pub(super) channels: u64,
    pub(super) bits: u64,
}

fn required(p: &Option<Vec<u8>>, what: &'static str) -> Result<Vec<u8>> {
    p.clone().ok_or_else(|| FormatError::damaged(what))
}

fn codec_of(codec_id: &str, p: &Option<Vec<u8>>, audio: &AudioSettings) -> Result<Option<Codec>> {
    let c = match codec_id {
        "V_VP8" => Codec { codec: "vp8".into(), ..Codec::default() },
        "V_VP9" => Codec { codec: "vp9".into(), vp9: Some(p.clone()), ..Codec::default() },
        "V_AV1" => {
            let d = required(p, "AV1 without CodecPrivate")?;
            let c = parse_av1_c(&d)?;
            Codec {
                codec: av1_codec_string(&c),
                bit_depth: Some(c.bit_depth.into()),
                description: Some(d),
                ..Codec::default()
            }
        }
        "V_MPEG4/ISO/AVC" => {
            let d = required(p, "AVC without CodecPrivate")?;
            let c = parse_avc_c(&d)?;
            let sps = c.info.as_ref().map(|x| (x.width, x.height, x.color_space, x.bit_depth_luma));
            Codec {
                codec: avc_codec_string(c.profile.into(), c.compat.into(), c.level.into(), "avc1"),
                description: Some(d),
                sps,
                ..Codec::default()
            }
        }
        "V_MPEGH/ISO/HEVC" => {
            let d = required(p, "HEVC without CodecPrivate")?;
            let c = parse_hvc_c(&d)?;
            let sps = c.info.as_ref().map(|x| (x.width, x.height, x.color_space, x.bit_depth_luma));
            Codec {
                codec: hevc_codec_string(&c.ptl, "hvc1"),
                description: Some(d),
                sps,
                bit_depth: Some(c.bit_depth_luma.into()),
                ..Codec::default()
            }
        }
        "A_OPUS" => {
            let head = p.as_deref().map(parse_opus_head).transpose()?;
            Codec {
                codec: "opus".into(),
                description: p.clone(),
                channels: head.map(|h| h.channels.into()),
                sample_rate: Some(48000),
                ..Codec::default()
            }
        }
        "A_VORBIS" => Codec {
            codec: "vorbis".into(),
            description: Some(required(p, "Vorbis without CodecPrivate")?),
            ..Codec::default()
        },
        "A_FLAC" => {
            let si = p.as_deref().and_then(parse_flac_stream_info);
            Codec {
                codec: "flac".into(),
                description: p.clone(),
                sample_rate: si.as_ref().map(|s| s.sample_rate.into()),
                channels: si.as_ref().map(|s| s.channels.into()),
                ..Codec::default()
            }
        }
        "A_MPEG/L3" => Codec { codec: "mp3".into(), ..Codec::default() },
        "A_ALAC" => {
            let config = required(p, "ALAC without CodecPrivate")?;
            let at = if config.len() >= 28 && config[..4] == [0; 4] { 4 } else { 0 };
            let c = config.get(at..at + 24).ok_or_else(|| FormatError::damaged("an ALAC config cut short"))?;
            Codec {
                codec: "alac".into(),
                channels: Some(c[9].into()),
                sample_rate: Some(u32::from_be_bytes([c[20], c[21], c[22], c[23]]).into()),
                description: Some(c.to_vec()),
                ..Codec::default()
            }
        }
        _ if codec_id.starts_with("A_AAC") => match p {
            Some(d) if d.len() >= 2 => {
                let asc = parse_audio_specific_config(d)?;
                Codec {
                    codec: aac_codec_string(asc.object_type),
                    description: Some(d.clone()),
                    channels: Some(asc.channels),
                    ..Codec::default()
                }
            }
            _ => {
                let object_type = if codec_id.contains("MAIN") {
                    1
                } else if codec_id.contains("SBR") {
                    5
                } else if codec_id.contains("LTP") {
                    4
                } else {
                    2
                };
                let description = build_audio_specific_config(object_type, audio.rate, audio.channels as f64);
                Codec { codec: format!("mp4a.40.{object_type}"), description: Some(description), ..Codec::default() }
            }
        },
        "A_PCM/INT/LIT" | "A_PCM/INT/BIG" | "A_PCM/FLOAT/IEEE" => {
            let bits = if audio.bits == 0 { 16 } else { audio.bits };
            let kind = if codec_id == "A_PCM/FLOAT/IEEE" {
                'f'
            } else if bits == 8 {
                'u'
            } else {
                's'
            };
            if ![8, 16, 24, 32, 64].contains(&bits) || (kind == 'f' && bits < 32) {
                return Ok(None);
            }
            let big = if codec_id == "A_PCM/INT/BIG" && bits > 8 { "be" } else { "" };
            let channels = if audio.channels == 0 { 1 } else { audio.channels };
            Codec { codec: format!("pcm-{kind}{bits}{big}"), pcm: Some(bits / 8 * channels), ..Codec::default() }
        }
        _ => return Ok(None),
    };
    Ok(Some(c))
}

pub(super) struct VideoSettings {
    pub(super) width: u64,
    pub(super) height: u64,
    pub(super) dw: u64,
    pub(super) dh: u64,
    pub(super) unit: u64,
    pub(super) color: Option<ColorSpace>,
    pub(super) bits: Option<u64>,
}

/// A track entry Cut reads.
pub(super) struct Entry {
    pub(super) number: u64,
    pub(super) kind: Kind,
    pub(super) default_duration: u64,
    pub(super) codec_delay: u64,
    pub(super) pre_roll: u64,
    pub(super) prefix: Option<Vec<u8>>,
    pub(super) video: Option<VideoSettings>,
    pub(super) audio: AudioSettings,
    pub(super) c: Codec,
}

pub(super) fn parse_tracks(b: &[u8]) -> (Vec<Entry>, Vec<Skipped>) {
    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    for e in elements(b, 0, b.len()).filter(|e| e.id == id::TRACK_ENTRY) {
        let f = Fields::of(b, e);
        let number = f.uint(id::TRACK_NUMBER).unwrap_or(0);
        let kind = match f.uint(id::TRACK_TYPE) {
            Some(1) => Kind::Video,
            Some(2) => Kind::Audio,
            _ => continue,
        };
        let codec_id = f.get(id::CODEC_ID).map(|e| text(b, e)).unwrap_or_default();
        let private = f.bytes(id::CODEC_PRIVATE);
        let mut prefix = None;
        let mut refused: Option<String> = None;
        if let Some(encs) = f.get(id::CONTENT_ENCODINGS) {
            for enc in elements(b, encs.start, encs.end) {
                let ef = Fields::of(b, enc);
                let enc_type = ef.uint(id::CONTENT_ENCODING_TYPE).unwrap_or(0);
                let cf = ef.get(id::CONTENT_COMPRESSION).map(|c| Fields::of(b, c));
                let algo = cf.as_ref().and_then(|cf| cf.uint(id::CONTENT_COMP_ALGO)).unwrap_or(0);
                let settings = cf.as_ref().and_then(|cf| cf.bytes(id::CONTENT_COMP_SETTINGS));
                match settings {
                    Some(s) if enc_type == 0 && algo == 3 => prefix = Some(s),
                    _ => {
                        refused = Some(if enc_type == 1 { "encrypted".into() } else { format!("compressed ({algo})") })
                    }
                }
            }
        }
        let video = f.get(id::VIDEO).map(|v| {
            let v = Fields::of(b, v);
            let g = |id| v.uint(id).unwrap_or(0);
            let mut s = VideoSettings {
                width: g(id::PIXEL_WIDTH),
                height: g(id::PIXEL_HEIGHT),
                dw: g(id::DISPLAY_WIDTH),
                dh: g(id::DISPLAY_HEIGHT),
                unit: g(id::DISPLAY_UNIT),
                color: None,
                bits: None,
            };
            if let Some(c) = v.get(id::COLOUR) {
                let c = Fields::of(b, c);
                let cg = |id| c.uint(id).map_or(-1, |v| v.min(i64::MAX as u64) as i64);
                let full = match cg(id::RANGE) {
                    2 => Some(true),
                    1 => Some(false),
                    _ => None,
                };
                s.color = color_from_codes(
                    cg(id::PRIMARIES),
                    cg(id::TRANSFER_CHARACTERISTICS),
                    cg(id::MATRIX_COEFFICIENTS),
                    full,
                );
                if cg(id::BITS_PER_CHANNEL) > 0 {
                    s.bits = Some(cg(id::BITS_PER_CHANNEL) as u64);
                }
            }
            s
        });
        let a = f.get(id::AUDIO).map(|a| Fields::of(b, a));
        let audio = AudioSettings {
            rate: a.as_ref().and_then(|a| a.get(id::SAMPLING_FREQUENCY)).map_or(8000.0, |e| float(b, e)),
            channels: a.as_ref().and_then(|a| a.uint(id::CHANNELS)).unwrap_or(1),
            bits: a.as_ref().and_then(|a| a.uint(id::BIT_DEPTH)).unwrap_or(0),
        };
        let c = match &refused {
            Some(_) => None,
            None => codec_of(&codec_id, &private, &audio).unwrap_or_else(|err| {
                refused = Some(err.detail.into());
                None
            }),
        };
        let Some(c) = c.filter(|_| (kind == Kind::Video) == codec_id.starts_with("V_")) else {
            skipped.push(Skipped {
                id: number,
                kind,
                codec: codec_id,
                reason: refused.unwrap_or_else(|| "unsupported".into()),
            });
            continue;
        };
        tracks.push(Entry {
            number,
            kind,
            default_duration: f.uint(id::DEFAULT_DURATION).unwrap_or(0),
            codec_delay: f.uint(id::CODEC_DELAY).unwrap_or(0),
            pre_roll: f.uint(id::SEEK_PRE_ROLL).unwrap_or(0),
            prefix,
            video,
            audio,
            c,
        });
    }
    (tracks, skipped)
}

pub(super) fn parse_seek_head(b: &[u8], seek: &mut Vec<(u64, u64)>) {
    let mut here: Vec<(u64, u64)> = Vec::new();
    for e in elements(b, 0, b.len()).filter(|e| e.id == id::SEEK) {
        let f = Fields::of(b, e);
        if let (Some(k), Some(v)) = (f.uint(id::SEEK_ID), f.uint(id::SEEK_POSITION)) {
            match here.iter_mut().find(|x| x.0 == k) {
                Some(x) => x.1 = v,
                None => here.push((k, v)),
            }
        }
    }
    for (k, v) in here {
        if !seek.iter().any(|x| x.0 == k) {
            seek.push((k, v));
        }
    }
}

pub(super) fn parse_cues(b: &[u8]) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    for e in elements(b, 0, b.len()).filter(|e| e.id == id::CUE_POINT) {
        for c in elements(b, e.start, e.end).filter(|c| c.id == id::CUE_TRACK_POSITIONS) {
            if let Some(p) = Fields::of(b, c).uint(id::CUE_CLUSTER_POSITION) {
                out.push(p.min(i64::MAX as u64) as i64);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}
