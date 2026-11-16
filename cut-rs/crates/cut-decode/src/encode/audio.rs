//! A streaming AAC-LC encoder over Media Foundation's AAC encoder transform: float sound in, raw AAC blocks of 1024
//! samples a channel out, with the AudioSpecificConfig the MP4 needs.

use windows::Win32::Media::MediaFoundation::*;

use super::EncodedSample;
use crate::Codec;
use crate::error::{DecodeError, Result};
use crate::mf::{MediaType, Pull, Sample, Transform, encoders};

/// The bitrates Windows' AAC encoder takes, bits a second.
pub const AAC_BITRATES: [u32; 4] = [96_000, 128_000, 160_000, 192_000];

/// One AAC stream being encoded. Not `Send`: it lives on the thread that made it.
pub struct AacEncoder {
    mft: Transform,
    rate: u32,
    channels: u32,
    description: Vec<u8>,
    /// Samples a channel sent so far.
    sent: u64,
    pcm: Vec<u8>,
}

impl AacEncoder {
    /// `rate` 44100 or 48000, `channels` 1, 2 or 6, `bitrate` one of [`AAC_BITRATES`] (others are refused here, as
    /// the transform refuses them).
    pub fn new(rate: u32, channels: u32, bitrate: u32) -> Result<Self> {
        if !AAC_BITRATES.contains(&bitrate) {
            return Err(DecodeError::Unsupported(format!("AAC at {bitrate} bits a second")));
        }
        let list = encoders(Codec::Aac, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER)?;
        let c = list.first().ok_or_else(|| DecodeError::Unsupported("this PC has no AAC encoder".into()))?;
        let mut mft = Transform::create(c)?;
        let input = MediaType::new(MFMediaType_Audio, MFAudioFormat_PCM)?;
        input.set_u32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        input.set_u32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
        input.set_u32(MF_MT_AUDIO_NUM_CHANNELS, channels)?;
        input.set_u32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 2 * channels)?;
        input.set_u32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 2 * channels * rate)?;
        mft.set_input(&input)?;
        let out = MediaType::new(MFMediaType_Audio, MFAudioFormat_AAC)?;
        out.set_u32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        out.set_u32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
        out.set_u32(MF_MT_AUDIO_NUM_CHANNELS, channels)?;
        out.set_u32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bitrate / 8)?;
        out.set_u32(MF_MT_AAC_PAYLOAD_TYPE, 0)?;
        mft.set_output(&out)?;
        // MF_MT_USER_DATA is a HEAACWAVEINFO tail (12 bytes) and then the AudioSpecificConfig.
        let user = mft.output_type()?.blob(MF_MT_USER_DATA).unwrap_or_default();
        let description = user.get(12..).filter(|a| !a.is_empty()).map(<[u8]>::to_vec);
        let description =
            description.ok_or_else(|| DecodeError::Damaged("no AudioSpecificConfig from the encoder".into()))?;
        mft.begin()?;
        Ok(Self { mft, rate, channels, description, sent: 0, pcm: Vec::new() })
    }

    /// The AudioSpecificConfig.
    pub fn description(&self) -> &[u8] {
        &self.description
    }

    fn hns(&self, n: u64) -> i64 {
        (i128::from(n) * 10_000_000 / i128::from(self.rate)) as i64
    }

    /// Encodes `planes` (one slice a channel, all of one length, -1..1; fewer planes than channels repeat the last)
    /// and sends what came out to `out`.
    pub fn push(&mut self, planes: &[&[f32]], out: &mut Vec<EncodedSample>) -> Result<()> {
        let n = planes.first().map_or(0, |p| p.len());
        if n == 0 {
            return Ok(());
        }
        self.pcm.clear();
        self.pcm.reserve(n * self.channels as usize * 2);
        for i in 0..n {
            for c in 0..self.channels as usize {
                let p = planes[c.min(planes.len() - 1)];
                let v = (f64::from(p.get(i).copied().unwrap_or(0.0)) * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
                self.pcm.extend_from_slice(&v.to_le_bytes());
            }
        }
        let t = self.hns(self.sent);
        let sample = Sample::with_bytes(&self.pcm, t, self.hns(self.sent + n as u64) - t, true)?;
        self.sent += n as u64;
        while !self.mft.push(&sample)? {
            self.take(out)?;
        }
        self.take(out)
    }

    /// Ends the stream: the blocks still inside come out.
    pub fn finish(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        self.mft.drain()?;
        self.take(out)
    }

    fn take(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        loop {
            match self.mft.pull()? {
                Pull::NeedInput => return Ok(()),
                Pull::StreamChange => {
                    return Err(DecodeError::Platform {
                        call: "IMFTransform::ProcessOutput",
                        hresult: 0,
                        message: "the encoder changed its output".into(),
                    });
                }
                Pull::Sample(s) => {
                    let data = s.read(|b, _| b.to_vec())?;
                    let pts = s.time().unwrap_or(0);
                    out.push(EncodedSample { data, key: true, pts, dts: pts });
                }
            }
        }
    }
}
