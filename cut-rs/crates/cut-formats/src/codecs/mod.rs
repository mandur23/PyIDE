//! Codec configuration records and their WebCodecs codec strings: avcC and hvcC with their SPS, vpcC, av1C and the
//! VP9 frame header, AudioSpecificConfig, OpusHead/dOps, FLAC STREAMINFO, PCM to float, and colour code points.

pub mod audio;
pub mod avc;
pub mod hevc;
pub mod pcm;
pub mod vpx;

use crate::source::{ColorSpace, Matrix, Primaries, Transfer};

/// Pixel aspect ratios by `aspect_ratio_idc` (H.264 and HEVC VUI).
pub(crate) const SAR: [Option<[u64; 2]>; 17] = [
    None,
    Some([1, 1]),
    Some([12, 11]),
    Some([10, 11]),
    Some([16, 11]),
    Some([40, 33]),
    Some([24, 11]),
    Some([20, 11]),
    Some([32, 11]),
    Some([80, 33]),
    Some([18, 11]),
    Some([15, 11]),
    Some([64, 33]),
    Some([160, 99]),
    Some([4, 3]),
    Some([3, 2]),
    Some([2, 1]),
];

fn primaries(code: i64) -> Option<Primaries> {
    Some(match code {
        1 => Primaries::Bt709,
        5 => Primaries::Bt470bg,
        6 => Primaries::Smpte170m,
        9 => Primaries::Bt2020,
        12 => Primaries::Smpte432,
        _ => return None,
    })
}

fn transfer(code: i64) -> Option<Transfer> {
    Some(match code {
        1 | 14 | 15 => Transfer::Bt709,
        6 => Transfer::Smpte170m,
        8 => Transfer::Linear,
        13 => Transfer::Srgb,
        16 => Transfer::Pq,
        18 => Transfer::Hlg,
        _ => return None,
    })
}

fn matrix(code: i64) -> Option<Matrix> {
    Some(match code {
        0 => Matrix::Rgb,
        1 => Matrix::Bt709,
        5 => Matrix::Bt470bg,
        6 => Matrix::Smpte170m,
        9 => Matrix::Bt2020Ncl,
        _ => return None,
    })
}

/// ISO/IEC 23091-2 code points -> the WebCodecs names (others are left out: `VideoColorSpace` throws on them), or
/// `None` when nothing is known.
pub fn color_from_codes(p: i64, t: i64, m: i64, full_range: Option<bool>) -> Option<ColorSpace> {
    let cs = ColorSpace { primaries: primaries(p), transfer: transfer(t), matrix: matrix(m), full_range };
    (cs.primaries.is_some() || cs.transfer.is_some() || cs.matrix.is_some() || cs.full_range.is_some()).then_some(cs)
}

/// Colour code points for a `colr` box; what is not known is 2 (unspecified).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorCodes {
    pub primaries: u16,
    pub transfer: u16,
    pub matrix: u16,
    pub full_range: bool,
}

/// The code points of a colour space (2, unspecified, for what it leaves out).
pub fn codes_from_color(cs: Option<&ColorSpace>) -> ColorCodes {
    let cs = cs.copied().unwrap_or_default();
    ColorCodes {
        primaries: match cs.primaries {
            Some(Primaries::Bt709) => 1,
            Some(Primaries::Bt470bg) => 5,
            Some(Primaries::Smpte170m) => 6,
            Some(Primaries::Bt2020) => 9,
            Some(Primaries::Smpte432) => 12,
            None => 2,
        },
        transfer: match cs.transfer {
            Some(Transfer::Bt709) => 1,
            Some(Transfer::Smpte170m) => 6,
            Some(Transfer::Linear) => 8,
            Some(Transfer::Srgb) => 13,
            Some(Transfer::Pq) => 16,
            Some(Transfer::Hlg) => 18,
            None => 2,
        },
        matrix: match cs.matrix {
            Some(Matrix::Rgb) => 0,
            Some(Matrix::Bt709) => 1,
            Some(Matrix::Bt470bg) => 5,
            Some(Matrix::Smpte170m) => 6,
            Some(Matrix::Bt2020Ncl) => 9,
            None => 2,
        },
        full_range: cs.full_range == Some(true),
    }
}

/// The fields `base` leaves unknown, filled from `extra` (a container's colr wins over the bitstream).
pub fn merge_color(base: Option<ColorSpace>, extra: Option<ColorSpace>) -> Option<ColorSpace> {
    let (Some(b), Some(e)) = (base, extra) else { return base.or(extra) };
    Some(ColorSpace {
        primaries: b.primaries.or(e.primaries),
        transfer: b.transfer.or(e.transfer),
        matrix: b.matrix.or(e.matrix),
        full_range: b.full_range.or(e.full_range),
    })
}

/// What a WebCodecs codec string says, for the writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecInfo {
    /// `avc1` / `avc3` (the sample entry, in the case given).
    Avc {
        entry: String,
        profile: u8,
        compat: u8,
        level: u8,
    },
    Hevc {
        entry: String,
    },
    Vp9 {
        profile: u64,
        level: u64,
        bit_depth: u64,
    },
    Av1,
    Aac {
        object_type: u32,
    },
    Opus,
}

fn digits(s: &str) -> Option<(&str, &str)> {
    let n = s.bytes().take_while(u8::is_ascii_digit).count();
    (n > 0).then(|| s.split_at(n))
}

/// Digits as a number; too many saturate.
fn number(d: &str) -> u64 {
    d.parse().unwrap_or(u64::MAX)
}

/// What a WebCodecs codec string names (the writer's codecs and the ones Cut reads), or `None`.
pub fn parse_codec_string(codec: &str) -> Option<CodecInfo> {
    let s = codec;
    let lower = s.to_ascii_lowercase();
    if (lower.starts_with("avc1.") || lower.starts_with("avc3.")) && s.len() == 11 {
        let hex = &s[5..];
        if hex.bytes().all(|c| c.is_ascii_hexdigit()) {
            let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
            return Some(CodecInfo::Avc {
                entry: s[..4].to_string(),
                profile: byte(0),
                compat: byte(2),
                level: byte(4),
            });
        }
    }
    if lower.starts_with("hvc1.") || lower.starts_with("hev1.") {
        return Some(CodecInfo::Hevc { entry: s[..4].to_string() });
    }
    if let Some(rest) = s.strip_prefix("vp09.") {
        let parsed = (|| {
            let (a, r) = digits(rest)?;
            let (b, r) = digits(r.strip_prefix('.')?)?;
            let (c, _) = digits(r.strip_prefix('.')?)?;
            Some(CodecInfo::Vp9 { profile: number(a), level: number(b), bit_depth: number(c) })
        })();
        if parsed.is_some() {
            return parsed;
        }
    }
    if s.starts_with("av01.") {
        return Some(CodecInfo::Av1);
    }
    if let Some(rest) = s.strip_prefix("mp4a.40.")
        && let Some((d, "")) = digits(rest)
    {
        return Some(CodecInfo::Aac { object_type: number(d).min(u32::MAX.into()) as u32 });
    }
    (s == "opus").then_some(CodecInfo::Opus)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_strings_parse() {
        assert_eq!(
            parse_codec_string("AVC1.64002A"),
            Some(CodecInfo::Avc { entry: "AVC1".into(), profile: 100, compat: 0, level: 42 })
        );
        assert_eq!(parse_codec_string("avc1.64002"), None);
        assert_eq!(
            parse_codec_string("vp09.00.40.08.01"),
            Some(CodecInfo::Vp9 { profile: 0, level: 40, bit_depth: 8 })
        );
        assert_eq!(parse_codec_string("mp4a.40.2"), Some(CodecInfo::Aac { object_type: 2 }));
        assert_eq!(parse_codec_string("mp4a.40.2x"), None);
        assert_eq!(parse_codec_string("hev1.1.6.L93.B0"), Some(CodecInfo::Hevc { entry: "hev1".into() }));
    }

    #[test]
    fn colour_codes_round_trip() {
        let cs = color_from_codes(9, 18, 9, Some(false)).unwrap();
        assert_eq!(cs.transfer, Some(Transfer::Hlg));
        assert_eq!(color_from_codes(2, 2, 2, None), None);
        assert_eq!(
            codes_from_color(Some(&cs)),
            ColorCodes { primaries: 9, transfer: 18, matrix: 9, full_range: false }
        );
    }
}
