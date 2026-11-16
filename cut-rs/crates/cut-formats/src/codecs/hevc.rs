//! HEVC: the sequence parameter set (profile, tier, level, size, bit depth, colour) and the hvcC record.

use serde::Serialize;

use super::avc::{read_color, read_sar};
use crate::bits::{BitReader, unescape_rbsp};
use crate::bytes::{ByteWriter, u16, u32};
use crate::error::{Result, damaged};
use crate::source::ColorSpace;

/// The profile, tier and level fields an SPS and an hvcC share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ptl {
    pub profile_space: u64,
    pub tier: u64,
    pub profile: u64,
    pub compat: u64,
    pub constraints: [u8; 6],
    pub level: u64,
}

/// What an HEVC SPS says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HevcSps {
    #[serde(flatten)]
    pub ptl: Ptl,
    pub max_sub_layers_minus1: u64,
    pub temporal_id_nesting: u64,
    pub chroma_format: u64,
    pub bit_depth_luma: u64,
    pub bit_depth_chroma: u64,
    pub width: i64,
    pub height: i64,
    pub sar: [u64; 2],
    pub color_space: Option<ColorSpace>,
}

fn read_ptl(r: &mut BitReader, max_sub_layers_minus1: u64) -> Result<Ptl> {
    let mut ptl = Ptl {
        profile_space: r.u(2)?,
        tier: r.u(1)?,
        profile: r.u(5)?,
        compat: r.u(32)?,
        constraints: [0; 6],
        level: 0,
    };
    for c in &mut ptl.constraints {
        *c = r.u(8)? as u8;
    }
    ptl.level = r.u(8)?;
    let mut present = Vec::new();
    for _ in 0..max_sub_layers_minus1 {
        present.push((r.flag()?, r.flag()?));
    }
    if max_sub_layers_minus1 > 0 {
        for _ in max_sub_layers_minus1..8 {
            r.skip(2)?;
        }
    }
    for (profile, level) in present {
        if profile {
            r.skip(88)?;
        }
        if level {
            r.skip(8)?;
        }
    }
    Ok(ptl)
}

fn skip_scaling_lists(r: &mut BitReader) -> Result<()> {
    for size_id in 0..4 {
        let mut matrix_id = 0;
        while matrix_id < 6 {
            if !r.flag()? {
                r.ue()?;
            } else {
                let coefs = 64.min(1 << (4 + (size_id << 1)));
                if size_id > 1 {
                    r.se()?;
                }
                for _ in 0..coefs {
                    r.se()?;
                }
            }
            matrix_id += if size_id == 3 { 3 } else { 1 };
        }
    }
    Ok(())
}

/// The part after the bit depths: only the pixel aspect and colour are wanted, behind the reference picture sets.
fn read_vui(r: &mut BitReader, out: &mut HevcSps) -> Result<()> {
    let poc_bits = r.ue()? + 4;
    let ordering = r.flag()?;
    let msl = out.max_sub_layers_minus1;
    for _ in (if ordering { 0 } else { msl })..=msl {
        r.ue()?;
        r.ue()?;
        r.ue()?;
    }
    for _ in 0..6 {
        r.ue()?;
    }
    if r.flag()? && r.flag()? {
        skip_scaling_lists(r)?;
    }
    r.bit()?;
    r.bit()?;
    if r.flag()? {
        r.u(4)?;
        r.u(4)?;
        r.ue()?;
        r.ue()?;
        r.bit()?;
    }
    let sets = r.ue()?;
    if sets > 64 {
        return Ok(());
    }
    let mut delta_pocs: Vec<u64> = Vec::new();
    for i in 0..sets as usize {
        if i != 0 && r.flag()? {
            r.bit()?;
            r.ue()?;
            let mut n = 0;
            for _ in 0..=delta_pocs[i - 1] {
                if r.flag()? || r.flag()? {
                    n += 1;
                }
            }
            delta_pocs.push(n);
        } else {
            let neg = r.ue()?;
            let pos = r.ue()?;
            if neg + pos > 32 {
                return Ok(());
            }
            for _ in 0..neg + pos {
                r.ue()?;
                r.bit()?;
            }
            delta_pocs.push(neg + pos);
        }
    }
    if r.flag()? {
        for _ in 0..r.ue()? {
            r.u(poc_bits)?;
            r.bit()?;
        }
    }
    r.bit()?;
    r.bit()?;
    if r.flag()? {
        if r.flag()? {
            read_sar(r, &mut out.sar)?;
        }
        if r.flag()? {
            r.bit()?;
        }
        if r.flag()? {
            out.color_space = read_color(r)?;
        }
    }
    Ok(())
}

/// A sequence parameter set NAL unit (with its two-byte header).
pub fn parse_hevc_sps(nal: &[u8]) -> Result<HevcSps> {
    let rbsp = unescape_rbsp(nal);
    let r = &mut BitReader::new(&rbsp, 2);
    r.u(4)?;
    let max_sub_layers_minus1 = r.u(3)?;
    let temporal_id_nesting = r.u(1)?;
    let ptl = read_ptl(r, max_sub_layers_minus1)?;
    r.ue()?;
    let chroma_format = r.ue()?;
    if chroma_format == 3 {
        r.bit()?;
    }
    let mut width = r.ue()? as i64;
    let mut height = r.ue()? as i64;
    if r.flag()? {
        let sub_w = if chroma_format == 1 || chroma_format == 2 { 2 } else { 1 };
        let sub_h = if chroma_format == 1 { 2 } else { 1 };
        let [left, right, top, bottom] = [r.ue()?, r.ue()?, r.ue()?, r.ue()?].map(|v| v as i64);
        width -= sub_w * (left + right);
        height -= sub_h * (top + bottom);
    }
    let bit_depth_luma = r.ue()? + 8;
    let bit_depth_chroma = r.ue()? + 8;
    let mut out = HevcSps {
        ptl,
        max_sub_layers_minus1,
        temporal_id_nesting,
        chroma_format,
        bit_depth_luma,
        bit_depth_chroma,
        width,
        height,
        sar: [1, 1],
        color_space: None,
    };
    // The size and profile are known; colour stays unknown when the rest does not read.
    let _ = read_vui(r, &mut out);
    Ok(out)
}

/// One array of NAL units in an hvcC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NalArray {
    #[serde(rename = "type")]
    pub kind: u8,
    pub complete: u8,
    pub nalus: Vec<Vec<u8>>,
}

/// An HEVCDecoderConfigurationRecord.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HvcC {
    #[serde(flatten)]
    pub ptl: Ptl,
    pub chroma_format: u8,
    pub bit_depth_luma: u8,
    pub bit_depth_chroma: u8,
    pub length_size: u8,
    pub arrays: Vec<NalArray>,
    pub vps: Vec<Vec<u8>>,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
    pub info: Option<HevcSps>,
}

/// Reads an hvcC record and its first SPS.
pub fn parse_hvc_c(b: &[u8]) -> Result<HvcC> {
    if b.len() < 23 {
        return damaged("bad hvcC");
    }
    let mut constraints = [0; 6];
    constraints.copy_from_slice(&b[6..12]);
    let mut out = HvcC {
        ptl: Ptl {
            profile_space: u64::from(b[1] >> 6),
            tier: u64::from((b[1] >> 5) & 1),
            profile: u64::from(b[1] & 31),
            compat: u64::from(u32(b, 2)),
            constraints,
            level: u64::from(b[12]),
        },
        chroma_format: b[16] & 3,
        bit_depth_luma: (b[17] & 7) + 8,
        bit_depth_chroma: (b[18] & 7) + 8,
        length_size: (b[21] & 3) + 1,
        arrays: vec![],
        vps: vec![],
        sps: vec![],
        pps: vec![],
        info: None,
    };
    let mut p = 23;
    for _ in 0..b[22] {
        if p + 3 > b.len() {
            return damaged("bad hvcC");
        }
        let head = b[p];
        let kind = head & 63;
        let count = u16(b, p + 1);
        p += 3;
        let mut nalus = Vec::new();
        for _ in 0..count {
            let len = usize::from(u16(b, p));
            if p + 2 + len > b.len() {
                return damaged("bad hvcC");
            }
            nalus.push(b[p + 2..p + 2 + len].to_vec());
            p += 2 + len;
        }
        match kind {
            32 => out.vps.extend(nalus.iter().cloned()),
            33 => out.sps.extend(nalus.iter().cloned()),
            34 => out.pps.extend(nalus.iter().cloned()),
            _ => {}
        }
        out.arrays.push(NalArray { kind, complete: head >> 7, nalus });
    }
    out.info = out.sps.first().and_then(|s| parse_hevc_sps(s).ok());
    Ok(out)
}

/// An hvcC from parameter sets; the SPS (`sps` is not empty) must read.
pub fn build_hvc_c(vps: &[&[u8]], sps: &[&[u8]], pps: &[&[u8]], length_size: u8) -> Result<Vec<u8>> {
    let info = parse_hevc_sps(sps[0])?;
    let p = &info.ptl;
    let mut w = ByteWriter::new();
    w.u8(1).u8(((p.profile_space << 6) | (p.tier << 5) | p.profile) as i64).u32(p.compat as i64).bytes(&p.constraints);
    w.u8(p.level as i64);
    w.u16(0xf000).u8(0xfc).u8(0xfc | info.chroma_format as i64);
    w.u8(0xf8 | (info.bit_depth_luma as i64 - 8)).u8(0xf8 | (info.bit_depth_chroma as i64 - 8));
    w.u16(0).u8((((info.max_sub_layers_minus1 + 1) << 3)
        | (info.temporal_id_nesting << 2)
        | u64::from(length_size.wrapping_sub(1))) as i64);
    let arrays: Vec<(i64, &[&[u8]])> =
        [(32, vps), (33, sps), (34, pps)].into_iter().filter(|(_, l)| !l.is_empty()).collect();
    w.u8(arrays.len() as i64);
    for (kind, list) in arrays {
        w.u8(0x80 | kind).u16(list.len() as i64);
        for n in list {
            w.u16(n.len() as i64).bytes(n);
        }
    }
    Ok(w.done())
}

/// `hvc1.P.C.TL.CC` (the entry `hvc1` or `hev1`): profile space and profile, the compatibility bits reversed, tier
/// and level, and the constraint bytes without trailing zeros.
pub fn hevc_codec_string(p: &Ptl, entry: &str) -> String {
    let compat = (p.compat as u32).reverse_bits();
    let space = ["", "A", "B", "C"].get(p.profile_space as usize).copied().unwrap_or("");
    let n = p.constraints.iter().rposition(|&c| c != 0).map_or(0, |i| i + 1);
    let tail: String = p.constraints[..n].iter().map(|c| format!(".{c:02X}")).collect();
    format!("{entry}.{space}{}.{compat:X}.{}{}{tail}", p.profile, if p.tier != 0 { 'H' } else { 'L' }, p.level)
}
