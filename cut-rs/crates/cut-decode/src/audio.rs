//! A whole audio track to float PCM, placed on one timeline from source time 0 the way the JavaScript's `assemble`
//! does: each decoded block lands at its sample's pts, so the encoder's priming (samples before 0 after the edit list
//! or Matroska's CodecDelay) is left out and the length is the track's duration.

use cut_formats::{Reader, Track};
use cut_time::TICKS;
use windows::Win32::Media::MediaFoundation::{
    MF_MT_AAC_PAYLOAD_TYPE, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND,
    MF_MT_SUBTYPE, MF_MT_USER_DATA, MFAudioFormat_AAC, MFAudioFormat_Float, MFMediaType_Audio,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT,
};

use crate::Codec;
use crate::audio_part::decode_audio_samples;
use crate::error::{DecodeError, Result};
use crate::mf::{MediaType, Transform, candidates};

/// Decoded sound: one buffer of samples a channel at `rate`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pcm {
    pub rate: u32,
    pub channels: u32,
    pub data: Vec<Vec<f32>>,
}

/// The whole track (AAC, MP3, FLAC or Opus) as PCM from source time 0 over the track's duration, at the decoder's
/// output rate.
pub fn decode_audio<R: Reader + ?Sized>(reader: &R, track: &Track) -> Result<Pcm> {
    let b = decode_audio_samples(reader, track, 0, track.samples.count())?;
    Ok(assemble(b.rate, b.channels, &b.pieces, track.duration as f64 / TICKS as f64))
}

/// The JavaScript's `assemble`: pieces on one timeline from t = 0, cut to the track's length.
fn assemble(rate: u32, channels: u32, pieces: &[(f64, Vec<Vec<f32>>)], seconds: f64) -> Pcm {
    let rate_f = f64::from(rate);
    let mut end = (seconds * rate_f).round() as i64;
    for (at, planes) in pieces {
        end = end.max((at * rate_f).round() as i64 + planes[0].len() as i64);
    }
    if seconds > 0.0 {
        end = end.min((seconds * rate_f).round() as i64);
    }
    let len = end.max(0) as usize;
    let mut data = vec![vec![0f32; len]; channels as usize];
    for (at, planes) in pieces {
        let at = (at * rate_f).round() as i64;
        for (c, out) in data.iter_mut().enumerate() {
            let src = &planes[c.min(planes.len() - 1)];
            let skip = (-at).max(0) as usize;
            let start = at.max(0) as usize;
            let n = (src.len() as i64 - skip as i64).min(len as i64 - start as i64);
            if n > 0 {
                let n = n as usize;
                out[start..start + n].copy_from_slice(&src[skip..skip + n]);
            }
        }
    }
    Pcm { rate, channels, data }
}

/// The AAC decoder with raw AAC in (the AudioSpecificConfig after a HEAACWAVEINFO header) and float out.
pub(crate) fn open(rate: u32, channels: u32, asc: &[u8]) -> Result<Transform> {
    let list = candidates(Codec::Aac, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER)?;
    let first = list.first().ok_or_else(|| DecodeError::Unsupported("this PC has no AAC decoder".into()))?;
    let mut mft = Transform::create(first)?;
    let input = MediaType::new(MFMediaType_Audio, MFAudioFormat_AAC)?;
    input.set_u32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
    input.set_u32(MF_MT_AUDIO_NUM_CHANNELS, channels)?;
    input.set_u32(MF_MT_AAC_PAYLOAD_TYPE, 0)?;
    // HEAACWAVEINFO after its WAVEFORMATEX: wPayloadType 0 (raw), wAudioProfileLevelIndication 0xFE (unknown),
    // wStructType 0, wReserved1, dwReserved2; then the AudioSpecificConfig.
    let mut user = vec![0, 0, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    user.extend_from_slice(asc);
    input.set_blob(MF_MT_USER_DATA, &user)?;
    mft.set_input(&input)?;
    let types = mft.output_types();
    let t = types
        .iter()
        .find(|t| t.guid(MF_MT_SUBTYPE) == Some(MFAudioFormat_Float) && t.u32(MF_MT_AUDIO_BITS_PER_SAMPLE) == Some(32))
        .ok_or_else(|| DecodeError::Unsupported(format!("{} gives no float output", mft.name)))?;
    mft.set_output(t)?;
    mft.begin()?;
    Ok(mft)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assemble_drops_what_is_before_zero_and_cuts_at_the_duration() {
        let p = |at: f64, v: &[f32]| (at, vec![v.to_vec()]);
        let pcm = assemble(10, 1, &[p(-0.2, &[1., 2., 3., 4.]), p(0.2, &[5., 6., 7., 8.])], 0.5);
        assert_eq!(pcm.data, vec![vec![3., 4., 5., 6., 7.]]);
        let mono_to_stereo = assemble(10, 2, &[p(0.0, &[1., 2.])], 0.0);
        assert_eq!(mono_to_stereo.data, vec![vec![1., 2.], vec![1., 2.]]);
    }
}
