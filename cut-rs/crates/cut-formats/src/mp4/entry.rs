//! Sample entries (stsd): the codec, its decoder configuration, the size or the audio format.

use super::boxes::{Bx, boxes, child};
use crate::bytes::{byte, latin1, starts, u16, u32};
use crate::codecs::audio::{
    aac_codec_string, opus_head_from_dops, parse_audio_specific_config, parse_flac_stream_info,
};
use crate::codecs::avc::{avc_codec_string, parse_avc_c};
use crate::codecs::hevc::{hevc_codec_string, parse_hvc_c};
use crate::codecs::vpx::{av1_codec_string, parse_av1_c, parse_vpc_c, vp9_codec_string};
use crate::codecs::{color_from_codes, merge_color};
use crate::error::{Result, damaged};
use crate::source::ColorSpace;

pub(crate) struct Entry {
    pub codec: String,
    pub description: Option<Vec<u8>>,
    pub media: EntryMedia,
}

pub(crate) enum EntryMedia {
    Video {
        width: i64,
        height: i64,
        sar: Option<[u64; 2]>,
        color: Option<ColorSpace>,
        bit_depth: Option<u64>,
    },
    /// `pcm`: bytes a PCM frame, for uncompressed audio.
    Audio {
        channels: u64,
        sample_rate: f64,
        pcm: Option<u64>,
    },
}

fn read_colr(b: &[u8], bx: Option<Bx>) -> Option<ColorSpace> {
    let bx = bx?;
    if bx.len() < 10 {
        return None;
    }
    let nclx = starts(b, bx.start, b"nclx");
    if !nclx && !starts(b, bx.start, b"nclc") {
        return None;
    }
    let p = bx.start + 4;
    let full = (nclx && bx.len() >= 11).then(|| byte(b, p + 6) >> 7 != 0);
    color_from_codes(u16(b, p).into(), u16(b, p + 2).into(), u16(b, p + 4).into(), full)
}

/// A visual sample entry, or `None` for a codec Cut does not read.
pub(crate) fn video_entry(b: &[u8], e: Bx) -> Result<Option<Entry>> {
    let mut width = i64::from(u16(b, e.start + 24));
    let mut height = i64::from(u16(b, e.start + 26));
    let mut sar = None;
    let mut color = None;
    let mut bit_depth = None;
    let kids = Some(Bx { kind: e.kind, start: e.start + 78, end: e.end });
    let config = |kind: &[u8; 4], what: &'static str| -> Result<Bx> {
        match child(b, kids, kind) {
            Some(bx) => Ok(bx),
            None => damaged(what),
        }
    };
    let entry = latin1(&e.kind);
    let (codec, description) = match &e.kind {
        b"avc1" | b"avc3" => {
            let bx = config(b"avcC", "no avcC")?;
            let d = b[bx.start..bx.end].to_vec();
            let c = parse_avc_c(&d)?;
            if let Some(x) = &c.info {
                if width == 0 || height == 0 {
                    (width, height) = (x.width, x.height);
                }
                if x.sar[0] != x.sar[1] {
                    sar = Some(x.sar);
                }
                color = x.color_space;
                bit_depth = Some(x.bit_depth_luma);
            }
            (avc_codec_string(c.profile.into(), c.compat.into(), c.level.into(), &entry), Some(d))
        }
        b"hvc1" | b"hev1" => {
            let bx = config(b"hvcC", "no hvcC")?;
            let d = b[bx.start..bx.end].to_vec();
            let c = parse_hvc_c(&d)?;
            if let Some(x) = &c.info {
                if width == 0 || height == 0 {
                    (width, height) = (x.width, x.height);
                }
                if x.sar[0] != x.sar[1] {
                    sar = Some(x.sar);
                }
                color = x.color_space;
            }
            bit_depth = Some(c.bit_depth_luma.into());
            (hevc_codec_string(&c.ptl, &entry), Some(d))
        }
        b"vp09" => {
            let bx = config(b"vpcC", "no vpcC")?;
            let c = parse_vpc_c(b.get(bx.start + 4..bx.end).unwrap_or(&[]), byte(b, bx.start))?;
            color = c.color_space;
            bit_depth = Some(c.bit_depth.into());
            (vp9_codec_string(c.profile.into(), c.level.into(), c.bit_depth.into()), None)
        }
        b"av01" => {
            let bx = config(b"av1C", "no av1C")?;
            let d = b[bx.start..bx.end].to_vec();
            let c = parse_av1_c(&d)?;
            bit_depth = Some(c.bit_depth.into());
            (av1_codec_string(&c), Some(d))
        }
        _ => return Ok(None),
    };
    let color = merge_color(read_colr(b, child(b, kids, b"colr")), color);
    if let Some(pasp) = child(b, kids, b"pasp")
        && pasp.len() >= 8
    {
        let (h, v) = (u32(b, pasp.start), u32(b, pasp.start + 4));
        if h != 0 && v != 0 {
            sar = Some([h.into(), v.into()]);
        }
    }
    Ok(Some(Entry { codec, description, media: EntryMedia::Video { width, height, sar, color, bit_depth } }))
}

/// An ES_Descriptor (esds payload after version and flags) -> the object type and the decoder specific info.
fn read_esds(b: &[u8], start: usize, end: usize) -> Option<(u8, Option<Vec<u8>>)> {
    let mut p = start;
    let tag = |p: &mut usize| -> Option<(u8, usize, usize)> {
        if *p >= end {
            return None;
        }
        let t = byte(b, *p);
        *p += 1;
        let mut len = 0;
        for _ in 0..4 {
            if *p >= end {
                break;
            }
            let v = byte(b, *p);
            *p += 1;
            len = len * 128 + usize::from(v & 127);
            if v & 128 == 0 {
                break;
            }
        }
        Some((t, len, *p))
    };
    let (t, _, _) = tag(&mut p)?;
    if t != 3 {
        return None;
    }
    p += 2;
    let flags = byte(b, p);
    p += 1;
    if flags & 0x80 != 0 {
        p += 2;
    }
    if flags & 0x40 != 0 {
        p += 1 + usize::from(byte(b, p));
    }
    if flags & 0x20 != 0 {
        p += 2;
    }
    let (t, _, _) = tag(&mut p)?;
    if t != 4 {
        return None;
    }
    let oti = byte(b, p);
    p += 13;
    let asc = match tag(&mut p) {
        Some((5, len, at)) => Some(b.get(at..end.min(at + len)).unwrap_or(&[]).to_vec()),
        _ => None,
    };
    Some((oti, asc))
}

/// `kind` among the children, also inside QuickTime `wave` boxes.
fn find_deep(b: &[u8], parent: Bx, kind: &[u8; 4], depth: u32) -> Option<Bx> {
    if depth > 3 {
        return None;
    }
    for k in boxes(b, parent.start, parent.end) {
        if &k.kind == kind {
            return Some(k);
        }
        if &k.kind == b"wave"
            && let Some(inner) = find_deep(b, k, kind, depth + 1)
        {
            return Some(inner);
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pcm {
    U,
    S,
    F,
}

/// QuickTime and ISO PCM entries: the sample type, big-endian, and a fixed sample size.
fn pcm_type(kind: &[u8; 4]) -> Option<(Pcm, bool, Option<u64>)> {
    Some(match kind {
        b"sowt" => (Pcm::S, false, None),
        b"twos" => (Pcm::S, true, None),
        b"in24" => (Pcm::S, true, Some(24)),
        b"in32" => (Pcm::S, true, Some(32)),
        b"fl32" => (Pcm::F, true, Some(32)),
        b"fl64" => (Pcm::F, true, Some(64)),
        b"raw " => (Pcm::U, false, Some(8)),
        b"ipcm" => (Pcm::S, true, None),
        b"fpcm" => (Pcm::F, true, None),
        b"lpcm" => (Pcm::S, true, None),
        _ => return None,
    })
}

/// A sound sample entry (`qt`: QuickTime's version 1 and 2 layouts), or `None` for a codec Cut does not read.
pub(crate) fn audio_entry(b: &[u8], e: Bx, qt: bool) -> Result<Option<Entry>> {
    let version = u16(b, e.start + 8);
    let mut channels = u64::from(u16(b, e.start + 16));
    let mut sample_rate = f64::from(u32(b, e.start + 24)) / 65536.0;
    let mut bits = u64::from(u16(b, e.start + 18));
    let mut kids_start = e.start + 28;
    let mut lpcm_flags = 0;
    if qt && version == 1 {
        kids_start += 16;
    } else if qt && version == 2 {
        sample_rate = f64::from_bits(crate::bytes::u64(b, e.start + 32));
        channels = u32(b, e.start + 40).into();
        bits = u32(b, e.start + 48).into();
        lpcm_flags = u32(b, e.start + 52);
        kids_start += 36;
    }
    let kids = Bx { kind: e.kind, start: kids_start, end: e.end };
    let mut description = None;
    let mut pcm = None;
    let codec = match &e.kind {
        b"mp4a" | b".mp3" | b"ms\0U" => {
            let es = find_deep(b, kids, b"esds", 0).and_then(|bx| read_esds(b, bx.start + 4, bx.end));
            match es {
                _ if &e.kind != b"mp4a" => "mp3".to_string(),
                Some((0x6b | 0x69, _)) => "mp3".to_string(),
                Some((oti @ (0x40 | 0x66 | 0x67 | 0x68), Some(asc))) => {
                    let c = parse_audio_specific_config(&asc)?;
                    if c.channels != 0 {
                        channels = c.channels;
                    }
                    if sample_rate == 0.0 {
                        sample_rate = c.sample_rate as f64;
                    }
                    description = Some(asc);
                    if oti == 0x40 { aac_codec_string(c.object_type) } else { format!("mp4a.{oti:x}") }
                }
                _ => return Ok(None),
            }
        }
        b"Opus" => {
            let Some(bx) = child(b, Some(kids), b"dOps") else { return damaged("no dOps") };
            description = Some(opus_head_from_dops(&b[bx.start..bx.end])?);
            channels = byte(b, bx.start + 1).into();
            sample_rate = 48000.0;
            "opus".to_string()
        }
        b"fLaC" => {
            let Some(bx) = child(b, Some(kids), b"dfLa") else { return damaged("no dfLa") };
            let mut d = b"fLaC".to_vec();
            d.extend_from_slice(b.get(bx.start + 4..bx.end).unwrap_or(&[]));
            if let Some(si) = parse_flac_stream_info(&d) {
                sample_rate = si.sample_rate.into();
                channels = si.channels.into();
            }
            description = Some(d);
            "flac".to_string()
        }
        b"alac" => {
            // The entry's own `alac` box: version and flags, then the 24-byte ALACSpecificConfig (not read by the
            // JavaScript, whose editor has no ALAC decoder).
            let Some(bx) = child(b, Some(kids), b"alac") else { return damaged("no alac config") };
            let config = b.get(bx.start + 4..bx.end).unwrap_or(&[]);
            if config.len() < 24 {
                return damaged("an alac config cut short");
            }
            channels = config[9].into();
            sample_rate = u32(config, 20).into();
            description = Some(config.to_vec());
            "alac".to_string()
        }
        kind => {
            let Some((mut sort, mut big, size)) = pcm_type(kind) else { return Ok(None) };
            if let Some(s) = size {
                bits = s;
            }
            if let Some(c) = child(b, Some(kids), b"pcmC")
                && c.len() >= 6
            {
                big = byte(b, c.start + 4) & 1 == 0;
                bits = byte(b, c.start + 5).into();
            }
            if let Some(enda) = find_deep(b, kids, b"enda", 0)
                && enda.len() >= 2
                && u16(b, enda.start) == 1
            {
                big = false;
            }
            if kind == b"lpcm" {
                sort = if lpcm_flags & 1 != 0 {
                    Pcm::F
                } else if lpcm_flags & 4 != 0 {
                    Pcm::S
                } else {
                    Pcm::U
                };
                big = lpcm_flags & 2 != 0;
            }
            if bits == 8 {
                big = false;
                if kind == b"twos" {
                    sort = Pcm::S;
                } else if kind != b"lpcm" && kind != b"ipcm" {
                    sort = Pcm::U;
                }
            }
            if ![8, 16, 24, 32, 64].contains(&bits) || (sort == Pcm::F && bits < 32) {
                return Ok(None);
            }
            pcm = Some(bits / 8 * channels);
            let letter = match sort {
                Pcm::U => 'u',
                Pcm::S => 's',
                Pcm::F => 'f',
            };
            format!("pcm-{letter}{bits}{}", if big { "be" } else { "" })
        }
    };
    Ok(Some(Entry { codec, description, media: EntryMedia::Audio { channels, sample_rate, pcm } }))
}
