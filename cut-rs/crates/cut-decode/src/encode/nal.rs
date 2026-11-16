//! Annex B pictures as MP4 wants them: parameter sets and access unit delimiters out (into the avcC or hvcC), 4-byte
//! lengths in front of the rest. The first parameter sets an encoder gives make the description; one that repeats
//! them before each key frame (hardware encoders do) adds nothing.

use cut_formats::codecs::avc::{avc_codec_string, build_avc_c, parse_avc_sps};
use cut_formats::codecs::hevc::{build_hvc_c, hevc_codec_string, parse_hevc_sps};

use crate::annexb::nal_units;
use crate::error::{DecodeError, Result};

/// Turns one encoder's output into MP4 samples, gathering its parameter sets.
#[derive(Debug, Default)]
pub(crate) struct Packager {
    hevc: bool,
    vps: Vec<Vec<u8>>,
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
}

impl Packager {
    pub(crate) fn new(hevc: bool) -> Self {
        Self { hevc, ..Self::default() }
    }

    /// The length-prefixed NAL units of one Annex B picture.
    pub(crate) fn sample(&mut self, annex_b: &[u8]) -> Vec<u8> {
        let mut data = Vec::with_capacity(annex_b.len() + 16);
        for nal in nal_units(annex_b) {
            let Some(&head) = nal.first() else { continue };
            let kind = if self.hevc { (head >> 1) & 63 } else { head & 31 };
            let set = match (self.hevc, kind) {
                (true, 32) => Some(&mut self.vps),
                (true, 33) | (false, 7) => Some(&mut self.sps),
                (true, 34) | (false, 8) => Some(&mut self.pps),
                (true, 35) | (false, 9) => continue,
                _ => None,
            };
            match set {
                Some(list) => {
                    if !list.iter().any(|x| x == nal) {
                        list.push(nal.to_vec());
                    }
                }
                None => {
                    data.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                    data.extend_from_slice(nal);
                }
            }
        }
        data
    }

    /// The WebCodecs codec string the SPS gives and the avcC or hvcC, once the encoder sent its parameter sets.
    pub(crate) fn description(&self) -> Result<(String, Vec<u8>)> {
        let first_sps = self.sps.first().ok_or_else(|| DecodeError::Damaged("the encoder gave no SPS".into()))?;
        let damaged = |e: cut_formats::FormatError| DecodeError::Damaged(e.detail.into_owned());
        Ok(if self.hevc {
            let info = parse_hevc_sps(first_sps).map_err(damaged)?;
            let hvc_c = build_hvc_c(&refs(&self.vps), &refs(&self.sps), &refs(&self.pps), 4).map_err(damaged)?;
            (hevc_codec_string(&info.ptl, "hvc1"), hvc_c)
        } else {
            let info = parse_avc_sps(first_sps).map_err(damaged)?;
            (
                avc_codec_string(info.profile, info.constraints, info.level, "avc1"),
                build_avc_c(&refs(&self.sps), &refs(&self.pps), 4),
            )
        })
    }
}

fn refs(v: &[Vec<u8>]) -> Vec<&[u8]> {
    v.iter().map(Vec::as_slice).collect()
}
