//! H.264: the sequence parameter set (profile, level, size, colour, timing) and the avcC record.

use serde::Serialize;

use super::{SAR, color_from_codes};
use crate::bits::{BitReader, unescape_rbsp};
use crate::bytes::{ByteWriter, byte, u16};
use crate::error::{Result, damaged};
use crate::source::ColorSpace;

pub(crate) const HIGH_PROFILES: [u64; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

/// What an H.264 SPS says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvcSps {
    pub profile: u64,
    pub constraints: u64,
    pub level: u64,
    pub chroma_format: u64,
    pub bit_depth_luma: u64,
    pub bit_depth_chroma: u64,
    pub width: i64,
    pub height: i64,
    pub interlaced: bool,
    pub sar: [u64; 2],
    pub color_space: Option<ColorSpace>,
    /// The frame rate the VUI timing gives, `[num, den]`.
    pub timing: Option<[u64; 2]>,
}

fn skip_scaling_list(r: &mut BitReader, size: usize) -> Result<()> {
    let (mut last, mut next) = (8_i64, 8_i64);
    for _ in 0..size {
        if next != 0 {
            next = (last + r.se()? + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Ok(())
}

pub(crate) fn read_color(r: &mut BitReader) -> Result<Option<ColorSpace>> {
    r.u(3)?;
    let full = Some(r.flag()?);
    Ok(if r.flag()? {
        let (p, t, m) = (r.u(8)?, r.u(8)?, r.u(8)?);
        color_from_codes(p as i64, t as i64, m as i64, full)
    } else {
        color_from_codes(0, 0, -1, full)
    })
}

pub(crate) fn read_sar(r: &mut BitReader, out: &mut [u64; 2]) -> Result<()> {
    let idc = r.u(8)?;
    if idc == 255 {
        *out = [r.u(16)?, r.u(16)?];
    } else if let Some(Some(s)) = SAR.get(idc as usize) {
        *out = *s;
    }
    Ok(())
}

fn read_vui(r: &mut BitReader, out: &mut AvcSps) -> Result<()> {
    if r.flag()? {
        read_sar(r, &mut out.sar)?;
    }
    if r.flag()? {
        r.bit()?;
    }
    if r.flag()? {
        out.color_space = read_color(r)?;
    }
    if r.flag()? {
        r.ue()?;
        r.ue()?;
    }
    if r.flag()? {
        let units = r.u(32)?;
        let scale = r.u(32)?;
        if units != 0 && scale != 0 {
            out.timing = Some(crate::table::reduce(scale, units * 2));
        }
    }
    Ok(())
}

/// A sequence parameter set NAL unit (with its one-byte header).
pub fn parse_avc_sps(nal: &[u8]) -> Result<AvcSps> {
    let rbsp = unescape_rbsp(nal);
    let r = &mut BitReader::new(&rbsp, 1);
    let profile = r.u(8)?;
    let constraints = r.u(8)?;
    let level = r.u(8)?;
    r.ue()?;
    let (mut chroma_format, mut separate, mut bit_depth_luma, mut bit_depth_chroma) = (1, 0, 8, 8);
    if HIGH_PROFILES.contains(&profile) {
        chroma_format = r.ue()?;
        if chroma_format == 3 {
            separate = r.bit()?;
        }
        bit_depth_luma = r.ue()? + 8;
        bit_depth_chroma = r.ue()? + 8;
        r.bit()?;
        if r.flag()? {
            for i in 0..if chroma_format != 3 { 8 } else { 12 } {
                if r.flag()? {
                    skip_scaling_list(r, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    r.ue()?;
    let poc_type = r.ue()?;
    if poc_type == 0 {
        r.ue()?;
    } else if poc_type == 1 {
        r.bit()?;
        r.se()?;
        r.se()?;
        for _ in 0..r.ue()? {
            r.se()?;
        }
    }
    r.ue()?;
    r.bit()?;
    let width_mbs = r.ue()? as i64 + 1;
    let height_maps = r.ue()? as i64 + 1;
    let frame_mbs_only = r.bit()? as i64;
    if frame_mbs_only == 0 {
        r.bit()?;
    }
    r.bit()?;
    let crop = if r.flag()? { [r.ue()?, r.ue()?, r.ue()?, r.ue()?].map(|v| v as i64) } else { [0; 4] };
    let array_type = if separate == 1 { 0 } else { chroma_format };
    let crop_x = if array_type == 1 || array_type == 2 { 2 } else { 1 };
    let crop_y = (if array_type == 1 { 2 } else { 1 }) * (2 - frame_mbs_only);
    let mut out = AvcSps {
        profile,
        constraints,
        level,
        chroma_format,
        bit_depth_luma,
        bit_depth_chroma,
        width: width_mbs * 16 - crop_x * (crop[0] + crop[1]),
        height: (2 - frame_mbs_only) * height_maps * 16 - crop_y * (crop[2] + crop[3]),
        interlaced: frame_mbs_only == 0,
        sar: [1, 1],
        color_space: None,
        timing: None,
    };
    // A cut VUI keeps what was read.
    if r.left() > 0 && r.flag().unwrap_or(false) {
        let _ = read_vui(r, &mut out);
    }
    Ok(out)
}

/// An AVCDecoderConfigurationRecord.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvcC {
    pub profile: u8,
    pub compat: u8,
    pub level: u8,
    pub length_size: u8,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
    /// The first SPS read, when it reads.
    pub info: Option<AvcSps>,
}

fn nal_list(b: &[u8], p: &mut usize, n: usize, out: &mut Vec<Vec<u8>>, what: &'static str) -> Result<()> {
    for _ in 0..n {
        let len = usize::from(u16(b, *p));
        if *p + 2 + len > b.len() {
            return damaged(what);
        }
        out.push(b[*p + 2..*p + 2 + len].to_vec());
        *p += 2 + len;
    }
    Ok(())
}

/// Reads an avcC record and its first SPS.
pub fn parse_avc_c(b: &[u8]) -> Result<AvcC> {
    if b.len() < 7 || b[0] != 1 {
        return damaged("bad avcC");
    }
    let mut out = AvcC {
        profile: b[1],
        compat: b[2],
        level: b[3],
        length_size: (b[4] & 3) + 1,
        sps: vec![],
        pps: vec![],
        info: None,
    };
    let mut p = 6;
    nal_list(b, &mut p, usize::from(b[5] & 31), &mut out.sps, "bad avcC")?;
    if p < b.len() {
        let n = usize::from(b[p]);
        p += 1;
        nal_list(b, &mut p, n, &mut out.pps, "bad avcC")?;
    }
    out.info = out.sps.first().and_then(|s| parse_avc_sps(s).ok());
    Ok(out)
}

/// An avcC from parameter sets (`sps` is not empty), with the High profile extension when the SPS reads.
pub fn build_avc_c(sps: &[&[u8]], pps: &[&[u8]], length_size: u8) -> Vec<u8> {
    let mut w = ByteWriter::new();
    let first = sps[0];
    w.u8(1).u8(byte(first, 1).into()).u8(byte(first, 2).into()).u8(byte(first, 3).into());
    w.u8((0xfc | (length_size.wrapping_sub(1))).into()).u8(0xe0 | sps.len() as i64);
    for s in sps {
        w.u16(s.len() as i64).bytes(s);
    }
    w.u8(pps.len() as i64);
    for s in pps {
        w.u16(s.len() as i64).bytes(s);
    }
    if HIGH_PROFILES.contains(&u64::from(byte(first, 1)))
        && let Ok(info) = parse_avc_sps(first)
    {
        w.u8(0xfc | info.chroma_format as i64)
            .u8(0xf8 | (info.bit_depth_luma as i64 - 8))
            .u8(0xf8 | (info.bit_depth_chroma as i64 - 8))
            .u8(0);
    }
    w.done()
}

/// `avc1.PPCCLL` (the entry `avc1` or `avc3`).
pub fn avc_codec_string(profile: u64, compat: u64, level: u64, entry: &str) -> String {
    format!("{entry}.{profile:02x}{compat:02x}{level:02x}")
}
