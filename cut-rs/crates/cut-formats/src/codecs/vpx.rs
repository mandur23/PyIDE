//! VP9 (vpcC, the key frame header, levels) and AV1 (av1C).

use serde::Serialize;

use super::color_from_codes;
use crate::bits::BitReader;
use crate::error::{Result, damaged};
use crate::source::ColorSpace;

/// A VPCodecConfigurationRecord.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpcC {
    pub profile: u8,
    pub level: u8,
    pub bit_depth: u8,
    pub chroma_subsampling: u8,
    pub full_range: bool,
    pub color_space: Option<ColorSpace>,
}

/// The vpcC payload after its version and flags; version 0 is the older layout without colour.
pub fn parse_vpc_c(b: &[u8], version: u8) -> Result<VpcC> {
    if b.len() < 6 {
        return damaged("bad vpcC");
    }
    if version == 0 {
        return Ok(VpcC {
            profile: b[0],
            level: b[1],
            bit_depth: b[2] >> 4,
            chroma_subsampling: b[3] >> 4,
            full_range: b[4] & 0x80 != 0,
            color_space: None,
        });
    }
    let full = b[2] & 1 != 0;
    Ok(VpcC {
        profile: b[0],
        level: b[1],
        bit_depth: b[2] >> 4,
        chroma_subsampling: (b[2] >> 1) & 7,
        full_range: full,
        color_space: color_from_codes(b[3].into(), b[4].into(), b[5].into(), Some(full)),
    })
}

/// `vp09.PP.LL.DD` (an unknown level is 10, an unknown bit depth 8).
pub fn vp9_codec_string(profile: u64, level: u64, bit_depth: u64) -> String {
    let level = if level == 0 { 10 } else { level };
    let bit_depth = if bit_depth == 0 { 8 } else { bit_depth };
    format!("vp09.{profile:02}.{level:02}.{bit_depth:02}")
}

/// The VP9 levels by luma picture size and luma sample rate.
const VP9_LEVELS: [(u64, f64, f64); 14] = [
    (10, 36864.0, 829440.0),
    (11, 73728.0, 2764800.0),
    (20, 122880.0, 4608000.0),
    (21, 245760.0, 9216000.0),
    (30, 552960.0, 20736000.0),
    (31, 983040.0, 36864000.0),
    (40, 2228224.0, 83558400.0),
    (41, 2228224.0, 160432128.0),
    (50, 8912896.0, 311951360.0),
    (51, 8912896.0, 588251136.0),
    (52, 8912896.0, 1176502272.0),
    (60, 35651584.0, 1176502272.0),
    (61, 35651584.0, 2353004544.0),
    (62, 35651584.0, 4706009088.0),
];

/// The lowest VP9 level for a picture size at `fps`.
pub fn vp9_level(width: u32, height: u32, fps: f64) -> u64 {
    let size = f64::from(width) * f64::from(height);
    VP9_LEVELS.iter().find(|&&(_, max_size, max_rate)| size <= max_size && size * fps <= max_rate).map_or(62, |l| l.0)
}

/// What a key frame's uncompressed header says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vp9Key {
    pub bit_depth: u64,
    pub chroma_subsampling: u64,
    pub full_range: bool,
    pub width: u64,
    pub height: u64,
    pub color_space: Option<ColorSpace>,
}

/// The start of a VP9 frame: its profile, and for a key frame the rest of [`Vp9Key`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vp9Frame {
    pub profile: u64,
    pub key: Option<Vp9Key>,
}

/// As the JavaScript's `{ profile, key: boolean, ...the key frame fields }`.
impl Serialize for Vp9Frame {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Out<'a> {
            profile: u64,
            key: bool,
            #[serde(flatten)]
            info: Option<&'a Vp9Key>,
        }
        Out { profile: self.profile, key: self.key.is_some(), info: self.key.as_ref() }.serialize(s)
    }
}

/// VP9 colour space codes -> (primaries, transfer, matrix).
fn vp9_color(space: u64) -> Option<(i64, i64, i64)> {
    Some(match space {
        1 | 3 => (6, 6, 6),
        2 => (1, 1, 1),
        5 => (9, 0, 9),
        7 => (1, 13, 0),
        _ => return None,
    })
}

/// The uncompressed header of a VP9 frame, or `None` when it is not one (or shows an existing frame).
pub fn parse_vp9_frame(b: &[u8]) -> Result<Option<Vp9Frame>> {
    let r = &mut BitReader::new(b, 0);
    if r.u(2)? != 2 {
        return Ok(None);
    }
    let profile = r.bit()? | (r.bit()? << 1);
    if profile == 3 {
        r.bit()?;
    }
    if r.flag()? {
        return Ok(None);
    }
    if r.flag()? {
        return Ok(Some(Vp9Frame { profile, key: None }));
    }
    r.bit()?;
    r.bit()?;
    if r.u(24)? != 0x49_8342 {
        return Ok(None);
    }
    let mut bit_depth = 8;
    if profile >= 2 {
        bit_depth = if r.flag()? { 12 } else { 10 };
    }
    let space = r.u(3)?;
    let mut full_range = space == 7;
    let mut chroma_subsampling = 1;
    if space != 7 {
        full_range = r.flag()?;
        if profile == 1 || profile == 3 {
            let x = r.flag()?;
            let y = r.flag()?;
            chroma_subsampling = if x && y {
                1
            } else if x {
                2
            } else {
                3
            };
            r.bit()?;
        }
    } else if profile == 1 || profile == 3 {
        chroma_subsampling = 3;
        r.bit()?;
    }
    let width = r.u(16)? + 1;
    let height = r.u(16)? + 1;
    let (p, t, m) = vp9_color(space).unwrap_or((0, 0, -1));
    let color_space = color_from_codes(p, t, m, Some(full_range));
    Ok(Some(Vp9Frame {
        profile,
        key: Some(Vp9Key { bit_depth, chroma_subsampling, full_range, width, height, color_space }),
    }))
}

/// An AV1CodecConfigurationRecord.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Av1C {
    pub profile: u8,
    pub level: u8,
    pub tier: u8,
    pub bit_depth: u8,
    pub monochrome: u8,
    pub subsampling_x: u8,
    pub subsampling_y: u8,
    pub config_obus: Vec<u8>,
}

/// Reads an av1C record.
pub fn parse_av1_c(b: &[u8]) -> Result<Av1C> {
    if b.len() < 4 || b[0] & 0x80 == 0 {
        return damaged("bad av1C");
    }
    let high = (b[2] >> 6) & 1 != 0;
    let twelve = (b[2] >> 5) & 1 != 0;
    Ok(Av1C {
        profile: b[1] >> 5,
        level: b[1] & 31,
        tier: b[2] >> 7,
        bit_depth: if high { if twelve { 12 } else { 10 } } else { 8 },
        monochrome: (b[2] >> 4) & 1,
        subsampling_x: (b[2] >> 3) & 1,
        subsampling_y: (b[2] >> 2) & 1,
        config_obus: b[4..].to_vec(),
    })
}

/// `av01.P.LLT.DD`.
pub fn av1_codec_string(c: &Av1C) -> String {
    format!("av01.{}.{:02}{}.{:02}", c.profile, c.level, if c.tier != 0 { 'H' } else { 'M' }, c.bit_depth)
}
