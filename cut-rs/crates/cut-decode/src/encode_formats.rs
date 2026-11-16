//! Test media in the codecs beyond H.264, HEVC and AAC that this PC's Media Foundation can encode: MP3 (the ACM
//! wrapper's encoder), FLAC (Microsoft's FLAC encoder) and VP8 / VP9 (the VP9 Video Extensions' encoder). Opus,
//! Vorbis and AV1 have no encoder here. Samples come back as the containers carry them; the caller writes the file.

use windows::Win32::Media::MediaFoundation::{
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_USER_DATA, MFAudioFormat_PCM,
    MFMediaType_Audio, MFMediaType_Video, MFSampleExtension_CleanPoint, MFT_ENUM_FLAG, MFT_ENUM_FLAG_SORTANDFILTER,
    MFT_ENUM_FLAG_SYNCMFT, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
};

use crate::Codec;
use crate::encode::EncodedSample;
use crate::error::{DecodeError, Result};
use crate::formats::Format;
use crate::mf::{Candidate, MediaType, Pull, Sample, Transform, encoders, input_of};

const FLAGS: MFT_ENUM_FLAG = MFT_ENUM_FLAG(MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0);

/// An encoded stream of a [`Format`].
#[derive(Debug, Clone)]
pub struct Encoded {
    /// The encoder's codec-private data (`MF_MT_USER_DATA` of its output type), empty when it has none.
    pub user_data: Vec<u8>,
    /// In decode order, times in 100 ns units as the encoder stamped them.
    pub samples: Vec<EncodedSample>,
    /// Outputs without bytes (the FLAC encoder's last one).
    pub empty: usize,
    /// The encoder used.
    pub encoder: String,
}

fn take(mft: &Transform, out: &mut Vec<EncodedSample>, empty: &mut usize) -> Result<()> {
    loop {
        match mft.pull()? {
            Pull::NeedInput => return Ok(()),
            Pull::StreamChange => {
                return Err(DecodeError::Platform {
                    call: "IMFTransform::ProcessOutput",
                    hresult: 0,
                    message: format!("{} changed its output", mft.name),
                });
            }
            Pull::Sample(s) => {
                let pts = s.time().unwrap_or(0);
                let key = s.attr_u32(MFSampleExtension_CleanPoint) != Some(0);
                match s.read(|b, _| b.to_vec()) {
                    Ok(data) if !data.is_empty() => out.push(EncodedSample { data, key, pts, dts: pts }),
                    _ => *empty += 1,
                }
            }
        }
    }
}

fn first(list: Vec<Candidate>, name: &str) -> Result<Transform> {
    let c = list.first().ok_or_else(|| DecodeError::Unsupported(format!("this PC has no {name} encoder")))?;
    Transform::create(c)
}

/// Encodes interleaved 16-bit `pcm` to MP3 or FLAC, at the output type nearest `bytes_per_second` (MP3; FLAC is
/// lossless and ignores it).
pub fn encode_audio(format: Format, pcm: &[i16], rate: u32, channels: u32, bytes_per_second: u32) -> Result<Encoded> {
    let mut mft = first(format.list(true, FLAGS)?, format.name())?;
    let input = MediaType::new(MFMediaType_Audio, MFAudioFormat_PCM)?;
    input.set_u32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
    input.set_u32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
    input.set_u32(MF_MT_AUDIO_NUM_CHANNELS, channels)?;
    input.set_u32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 2 * channels)?;
    input.set_u32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 2 * channels * rate)?;
    // The FLAC encoder wants its input type first; the MP3 one its output type first.
    let input_first = mft.set_input(&input).is_ok();
    let types = mft.output_types();
    let distance = |t: &MediaType| t.u32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND).unwrap_or(0).abs_diff(bytes_per_second);
    let t = types
        .iter()
        .filter(|t| t.guid(MF_MT_SUBTYPE) == Some(format.subtype()))
        .filter(|t| t.u32(MF_MT_AUDIO_SAMPLES_PER_SECOND).is_none_or(|r| r == rate))
        .filter(|t| t.u32(MF_MT_AUDIO_NUM_CHANNELS).is_none_or(|c| c == channels))
        .min_by_key(|t| distance(t))
        .ok_or_else(|| DecodeError::Unsupported(format!("{} offers no {} output here", mft.name, format.name())))?;
    let set = mft.set_output(t);
    if input_first {
        set?;
    } else {
        // Its stream info only reads once both types are set.
        mft.set_input(&input)?;
        mft.set_output(t)?;
    }
    mft.reserve_output(1 << 16);
    let user_data = mft.output_type()?.blob(MF_MT_USER_DATA).unwrap_or_default();
    mft.begin()?;
    let hns = |n: usize| (n as i64 * 10_000_000) / i64::from(rate);
    let block = 4096 * channels as usize;
    let mut samples = Vec::new();
    let mut empty = 0;
    for (k, chunk) in pcm.chunks(block).enumerate() {
        let bytes: Vec<u8> = chunk.iter().flat_map(|v| v.to_le_bytes()).collect();
        let at = k * 4096;
        let sample = Sample::with_bytes(&bytes, hns(at), hns(at + chunk.len() / channels as usize) - hns(at), true)?;
        while !mft.push(&sample)? {
            take(&mft, &mut samples, &mut empty)?;
        }
        take(&mft, &mut samples, &mut empty)?;
    }
    mft.drain()?;
    take(&mft, &mut samples, &mut empty)?;
    Ok(Encoded { user_data, samples, empty, encoder: mft.name.clone() })
}

/// Encodes `frames` NV12 pictures of `width` by `height` at `fps` to VP8 or VP9 (`codec`), `draw(i, pixels)`
/// painting picture `i`.
pub fn encode_vpx(
    codec: Codec,
    width: u32,
    height: u32,
    fps: [u32; 2],
    frames: u32,
    mut draw: impl FnMut(u32, &mut [u8]),
) -> Result<Encoded> {
    if !matches!(codec, Codec::Vp8 | Codec::Vp9) {
        return Err(DecodeError::Unsupported(format!("encoding {codec:?} as VP8 or VP9")));
    }
    let mut mft = first(encoders(codec, FLAGS)?, &format!("{codec:?}"))?;
    let out = MediaType::new(MFMediaType_Video, input_of(codec).2)?;
    out.set_u32(MF_MT_AVG_BITRATE, width * height * 4)?;
    out.set_pair(MF_MT_FRAME_RATE, fps[0], fps[1])?;
    out.set_pair(MF_MT_FRAME_SIZE, width, height)?;
    out.set_pair(MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
    out.set_u32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    mft.set_output(&out)?;
    let input = MediaType::new(MFMediaType_Video, MFVideoFormat_NV12)?;
    input.set_pair(MF_MT_FRAME_RATE, fps[0], fps[1])?;
    input.set_pair(MF_MT_FRAME_SIZE, width, height)?;
    input.set_pair(MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
    input.set_u32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    mft.set_input(&input)?;
    let user_data = mft.output_type()?.blob(MF_MT_USER_DATA).unwrap_or_default();
    mft.begin()?;
    let frame_hns = 10_000_000 * i64::from(fps[1]) / i64::from(fps[0]);
    let mut pixels = vec![0u8; (width * height * 3 / 2) as usize];
    let mut samples = Vec::new();
    let mut empty = 0;
    for i in 0..frames {
        draw(i, &mut pixels);
        let sample = Sample::with_bytes(&pixels, i64::from(i) * frame_hns, frame_hns, false)?;
        while !mft.push(&sample)? {
            take(&mft, &mut samples, &mut empty)?;
        }
        take(&mft, &mut samples, &mut empty)?;
    }
    mft.drain()?;
    take(&mft, &mut samples, &mut empty)?;
    Ok(Encoded { user_data, samples, empty, encoder: mft.name.clone() })
}
