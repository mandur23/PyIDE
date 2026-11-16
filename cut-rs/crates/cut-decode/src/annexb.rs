//! MP4/Matroska samples (NAL units behind big-endian length fields) to the Annex B byte stream Media Foundation's
//! H.264 and HEVC decoders take: each NAL behind a 00 00 00 01 start code, and the parameter sets of the avcC or hvcC
//! in front of every sync sample, so a run that starts at any key frame carries what it needs.

use cut_formats::codecs::avc::parse_avc_c;
use cut_formats::codecs::hevc::parse_hvc_c;

use crate::Codec;
use crate::error::{DecodeError, Result};

const START: [u8; 4] = [0, 0, 0, 1];

/// How a track's samples become Annex B.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnnexB {
    length_size: usize,
    /// The parameter sets, already with start codes.
    params: Vec<u8>,
}

impl AnnexB {
    /// From the track's avcC or hvcC (`None`: samples that are Annex B already are not handled; MP4 and Matroska always
    /// give a record for H.264 and HEVC).
    pub(crate) fn new(codec: Codec, description: Option<&[u8]>) -> Result<Self> {
        if codec.is_frame_stream() {
            return Ok(Self { length_size: 0, params: Vec::new() });
        }
        let desc = description.ok_or_else(|| DecodeError::Damaged("no decoder description (avcC/hvcC)".into()))?;
        let damaged = |e: cut_formats::FormatError| DecodeError::Damaged(e.detail.into_owned());
        let (length_size, sets): (u8, Vec<Vec<u8>>) = match codec {
            Codec::H264 => {
                let c = parse_avc_c(desc).map_err(damaged)?;
                (c.length_size, c.sps.into_iter().chain(c.pps).collect())
            }
            Codec::Hevc => {
                let c = parse_hvc_c(desc).map_err(damaged)?;
                (c.length_size, c.vps.into_iter().chain(c.sps).chain(c.pps).collect())
            }
            Codec::Aac | Codec::Vp8 | Codec::Vp9 | Codec::Av1 => {
                return Err(DecodeError::Unsupported(format!("{codec:?} is not a NAL stream")));
            }
        };
        if length_size == 3 {
            // ISO 14496-15 allows 1, 2 and 4.
            return Err(DecodeError::Damaged("a NAL length field of 3 bytes".into()));
        }
        let mut params = Vec::new();
        for s in &sets {
            params.extend_from_slice(&START);
            params.extend_from_slice(s);
        }
        Ok(Self { length_size: length_size.into(), params })
    }

    /// Writes sample `b` as Annex B into `out` (cleared first), the parameter sets in front when `key`.
    pub(crate) fn convert(&self, b: &[u8], key: bool, out: &mut Vec<u8>) -> Result<()> {
        out.clear();
        if self.length_size == 0 {
            // A frame stream (VP8, VP9, AV1): the sample is what the decoder takes.
            out.extend_from_slice(b);
            return Ok(());
        }
        out.reserve(b.len() + self.params.len() + 16);
        if key {
            out.extend_from_slice(&self.params);
        }
        let n = self.length_size;
        let mut p = 0;
        while p < b.len() {
            let Some(field) = b.get(p..p + n) else {
                return Err(DecodeError::Damaged(format!("a NAL length cut off at byte {p}")));
            };
            let len = field.iter().fold(0usize, |v, &x| (v << 8) | usize::from(x));
            p += n;
            let Some(nal) = b.get(p..p.saturating_add(len)) else {
                return Err(DecodeError::Damaged(format!("a NAL of {len} bytes runs past the sample at byte {p}")));
            };
            if !nal.is_empty() {
                out.extend_from_slice(&START);
                out.extend_from_slice(nal);
            }
            p += len;
        }
        Ok(())
    }
}

/// The NAL units of an Annex B stream (start codes of 3 or 4 bytes), without their start codes.
pub(crate) fn nal_units(b: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= b.len() {
        if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let ends: Vec<usize> = starts.iter().skip(1).map(|&s| s - 3).chain([b.len()]).collect();
    starts.into_iter().zip(ends).map(move |(s, e)| {
        let mut e = e;
        while e > s && b[e - 1] == 0 {
            e -= 1;
        }
        &b[s..e]
    })
}

#[cfg(test)]
mod tests {
    use cut_formats::codecs::avc::build_avc_c;

    use super::*;

    // A real 1x1 High profile SPS is not needed: avcC parsing only reads the SPS for `info`.
    const SPS: &[u8] = &[0x67, 0x64, 0x00, 0x1f, 0xac];
    const PPS: &[u8] = &[0x68, 0xee, 0x3c, 0x80];

    fn h264(length_size: u8) -> AnnexB {
        AnnexB::new(Codec::H264, Some(&build_avc_c(&[SPS], &[PPS], length_size))).expect("an avcC")
    }

    #[test]
    fn length_prefixes_become_start_codes_and_key_frames_get_the_parameter_sets() {
        let a = h264(4);
        let sample = [0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 1, 0x06];
        let mut out = Vec::new();
        a.convert(&sample, true, &mut out).expect("converts");
        let want = [&START[..], SPS, &START, PPS, &START, &[0x65, 0xaa], &START, &[0x06]].concat();
        assert_eq!(out, want);
        a.convert(&sample, false, &mut out).expect("converts");
        assert_eq!(out, [&START[..], &[0x65, 0xaa], &START, &[0x06]].concat());
    }

    #[test]
    fn short_length_fields_are_read_by_their_size() {
        let mut out = Vec::new();
        h264(2).convert(&[0, 1, 0x41, 0, 2, 0x41, 0x42], false, &mut out).expect("converts");
        assert_eq!(out, [&START[..], &[0x41], &START, &[0x41, 0x42]].concat());
        h264(1).convert(&[1, 0x41], false, &mut out).expect("converts");
        assert_eq!(out, [&START[..], &[0x41]].concat());
    }

    #[test]
    fn truncated_samples_are_damaged_not_a_panic() {
        let a = h264(4);
        let mut out = Vec::new();
        for bad in [&[0, 0, 0][..], &[0, 0, 0, 9, 1, 2], &[0xff, 0xff, 0xff, 0xff]] {
            assert!(matches!(a.convert(bad, true, &mut out), Err(DecodeError::Damaged(_))), "{bad:?}");
        }
        a.convert(&[], false, &mut out).expect("an empty sample is empty");
        assert!(out.is_empty());
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut x = 0x2545_f491_4f6c_dd1du64;
        let mut out = Vec::new();
        for n in 0..2000 {
            let len = n % 64;
            let b: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    x as u8
                })
                .collect();
            for size in [1, 2, 4] {
                let _ = h264(size).convert(&b, n % 2 == 0, &mut out);
            }
            let _ = AnnexB::new(Codec::H264, Some(&b));
            let _ = AnnexB::new(Codec::Hevc, Some(&b));
            let _ = nal_units(&b).count();
        }
    }

    #[test]
    fn nal_units_split_on_three_and_four_byte_start_codes() {
        let b = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65];
        let units: Vec<&[u8]> = nal_units(&b).collect();
        assert_eq!(units, vec![&[0x67, 1, 2][..], &[0x68, 3], &[0x65]]);
        assert_eq!(nal_units(&[1, 2, 3]).count(), 0);
    }

    #[test]
    fn a_missing_or_bad_record_is_damaged() {
        assert!(matches!(AnnexB::new(Codec::H264, None), Err(DecodeError::Damaged(_))));
        assert!(matches!(AnnexB::new(Codec::H264, Some(&[0, 1, 2])), Err(DecodeError::Damaged(_))));
        assert!(matches!(AnnexB::new(Codec::Hevc, Some(&[1; 10])), Err(DecodeError::Damaged(_))));
    }
}
