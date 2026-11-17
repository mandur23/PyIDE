//! Part of an audio track decoded on its own: samples `[i0, i1)` through a fresh decoder transform, each decoded block
//! stamped with its sample's time, the way the JavaScript's `decoder.audioReader` decodes a window of a long file (it
//! creates an AudioDecoder per read). AAC goes through the AAC decoder; MP3, FLAC and Opus through Media Foundation's
//! own decoders ([`Format`]), each given the codec-private data the container carries; ALAC through this crate's
//! own decoder ([`crate::alac`]), Vorbis through lewton ([`crate::vorbis`]).
//!
//! The container's times already place the sound: an Opus track's pre-skip is in its pts (Matroska's CodecDelay, an
//! MP4 edit list), so the decoder is told none and the priming lands before 0, where `assemble` leaves it out, as
//! WebCodecs' output does in the JavaScript.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use cut_formats::codecs::audio::{
    OpusHead, build_opus_head, parse_audio_specific_config, parse_flac_stream_info, parse_opus_head,
};
use cut_formats::probe::read_samples;
use cut_formats::{Media, Reader, Track};
use cut_time::{TICKS, to_scale};
use windows::Win32::Media::MediaFoundation::{
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_SUBTYPE, MF_MT_USER_DATA, MFAudioFormat_Float,
    MFAudioFormat_PCM, MFMediaType_Audio, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT,
};
use windows::core::GUID;

use crate::Codec;
use crate::error::{DecodeError, Result};
use crate::formats::Format;
use crate::mf::{MediaType, Pull, Sample, Transform};

/// Decoded blocks of part of a track: each block's start in seconds (from its sample's pts, as the decoder stamps it)
/// and its samples a channel, at the decoder's output `rate` (HE-AAC doubles the track's).
#[derive(Debug, Clone, PartialEq)]
pub struct Blocks {
    pub rate: u32,
    pub channels: u32,
    pub pieces: Vec<(f64, Vec<Vec<f32>>)>,
}

/// How a codec string reaches a decoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Route {
    Aac,
    Other(Format),
}

fn route(codec: &str) -> Option<Route> {
    match (Codec::of(codec), Format::of(codec)) {
        (Some(Codec::Aac), _) => Some(Route::Aac),
        (_, Some(f)) => Some(Route::Other(f)),
        _ => None,
    }
}

/// The audio formats this PC's Media Foundation lists decoders for, by name (`aac`, `mp3`, `flac`, `opus`, `vorbis`,
/// `alac`), each with the transforms' names (FFmpeg wrappers, never used, included); for reports and tests.
pub fn audio_decoder_names() -> Vec<(&'static str, Vec<String>)> {
    let mut out = vec![("aac", crate::decoders(Codec::Aac))];
    for (name, f) in [
        ("mp3", Format::Mp3),
        ("flac", Format::Flac),
        ("opus", Format::Opus),
        ("vorbis", Format::Vorbis),
        ("alac", Format::Alac),
    ] {
        out.push((name, f.transforms(false).into_iter().map(|l| l.name).collect()));
    }
    out
}

/// Whether [`decode_audio_samples`] decodes a track of this codec string on this PC (AAC, MP3, FLAC, Opus when a
/// decoder this crate may use is listed; ALAC and Vorbis always); asked once a codec.
pub fn decodes_audio(codec: &str) -> bool {
    static ANSWERS: OnceLock<Mutex<HashMap<Route, bool>>> = OnceLock::new();
    let Some(r) = route(codec) else {
        return false;
    };
    if matches!(r, Route::Other(Format::Alac | Format::Vorbis)) {
        return true;
    }
    let mut answers = ANSWERS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    *answers.entry(r).or_insert_with(|| match r {
        Route::Aac => !crate::decoders(Codec::Aac).is_empty(),
        Route::Other(f) => f.decodable(),
    })
}

/// The sentence that says why sound of this codec string is not played (for a codec [`decodes_audio`] refuses).
pub fn audio_refusal(codec: &str) -> &'static str {
    match route(codec) {
        Some(Route::Other(f)) => f.refusal(),
        Some(Route::Aac) => Codec::Aac.missing_decoder(),
        None => "This audio codec is not supported.",
    }
}

/// Samples `[i0, i1)` of an AAC, MP3, FLAC, Opus, ALAC or Vorbis track decoded by a fresh decoder, the blocks in the
/// order they come out.
pub fn decode_audio_samples<R: Reader + ?Sized>(reader: &R, track: &Track, i0: usize, i1: usize) -> Result<Blocks> {
    let Media::Audio(a) = &track.media else {
        return Err(DecodeError::Unsupported("not an audio track".into()));
    };
    match route(&track.codec) {
        Some(Route::Other(Format::Alac)) => return decode_alac(reader, track, i0, i1),
        Some(Route::Other(Format::Vorbis)) => return decode_vorbis(reader, track, i0, i1),
        _ => {}
    }
    if route(&track.codec) == Some(Route::Other(Format::Opus))
        && let Some(d) = track.description.as_deref()
    {
        let head = parse_opus_head(d).map_err(|e| DecodeError::Damaged(e.detail.into_owned()))?;
        if head.channels > 2 {
            return decode_opus_streams(reader, track, &head, i0, i1);
        }
    }
    let Opened { mut mft, mut head, contiguous, flac } = open(track, a.sample_rate, a.channels)?;
    let mut variable = None;
    let mut out = Output::of(&mft, a.sample_rate, a.channels)?;
    let mut pieces = Vec::new();
    let mut failed = None;
    let s = &track.samples;
    let hns = |t: i64| to_scale(t, 10_000_000);
    let (i0, i1) = (i0.min(s.count()), i1.min(s.count()));
    read_samples(reader, track, i0, i1, |i, bytes| {
        if failed.is_some() {
            return;
        }
        let silence;
        let bytes = match flac {
            Some(bits) if !crate::flac::whole(bytes) => {
                let blocks = variable.unwrap_or(false);
                let samples = (to_scale(s.duration[i], a.sample_rate.into()).max(1)) as u32;
                let number = if blocks { to_scale(s.pts[i], a.sample_rate.into()).max(0) as u64 } else { i as u64 };
                silence = crate::flac::silent(samples, a.channels, bits, number, blocks);
                &silence[..]
            }
            Some(_) => {
                variable.get_or_insert(crate::flac::variable(bytes));
                bytes
            }
            None => bytes,
        };
        let joined;
        let bytes = match head.take() {
            Some(mut h) => {
                h.extend_from_slice(bytes);
                joined = h;
                &joined[..]
            }
            None => bytes,
        };
        failed = feed(&mut mft, &mut out, &mut pieces, bytes, hns(s.pts[i]), hns(s.duration[i])).err();
    })?;
    if let Some(e) = failed {
        return Err(e);
    }
    mft.drain()?;
    drain_out(&mut mft, &mut out, &mut pieces)?;
    if contiguous && let Some(&first) = s.pts.get(i0) {
        let mut at = first as f64 / TICKS as f64;
        for (t, planes) in &mut pieces {
            *t = at;
            at += planes.first().map_or(0, Vec::len) as f64 / f64::from(out.rate);
        }
    }
    Ok(Blocks { rate: out.rate, channels: out.channels, pieces })
}

/// One sample into a decoder, and the blocks it gives into `pieces`.
fn feed(mft: &mut Transform, out: &mut Output, pieces: &mut Pieces, bytes: &[u8], at: i64, len: i64) -> Result<()> {
    let sample = Sample::with_bytes(bytes, at, len, true)?;
    while !mft.push(&sample)? {
        if drain_out(mft, out, pieces)? == 0 {
            return Err(DecodeError::Platform {
                call: "IMFTransform::ProcessInput",
                hresult: 0,
                message: format!("{} refuses input and has no output", mft.name),
            });
        }
    }
    drain_out(mft, out, pieces).map(drop)
}

type Pieces = Vec<(f64, Vec<Vec<f32>>)>;

/// Samples `[i0, i1)` of an Opus track of more than two channels: each stream through a decoder of its own
/// ([`crate::opus`]), the channels put in the track's order, which for mapping family 1 (Vorbis order) is then
/// WebCodecs' ([`crate::vorbis::wave_order`]), so the first two channels are left and right.
fn decode_opus_streams<R: Reader + ?Sized>(
    reader: &R,
    track: &Track,
    head: &OpusHead,
    i0: usize,
    i1: usize,
) -> Result<Blocks> {
    let mut layout = crate::opus::Layout::of(head.channels.into(), &head.mapping)?;
    if head.family == 1
        && let Some(order) = crate::vorbis::wave_order(layout.sources.len())
    {
        layout.sources = order.iter().map(|&k| layout.sources[k]).collect();
    }
    let mut streams = (0..layout.streams)
        .map(|k| {
            let channels = layout.channels_of(k);
            let one =
                OpusHead { channels: channels as u8, pre_skip: 0, family: 0, mapping: Vec::new(), ..head.clone() };
            let mft = transform(Format::Opus, 48000, channels, Some(&build_opus_head(&one)), None)?;
            let out = Output::of(&mft, 48000, channels)?;
            Ok((mft, out, Pieces::new()))
        })
        .collect::<Result<Vec<_>>>()?;
    let s = &track.samples;
    let hns = |t: i64| to_scale(t, 10_000_000);
    let (i0, i1) = (i0.min(s.count()), i1.min(s.count()));
    let mut failed = None;
    read_samples(reader, track, i0, i1, |i, bytes| {
        if failed.is_some() {
            return;
        }
        let r = crate::opus::split(bytes, layout.streams).and_then(|packets| {
            for ((mft, out, pieces), p) in streams.iter_mut().zip(&packets) {
                feed(mft, out, pieces, p, hns(s.pts[i]), hns(s.duration[i]))?;
            }
            Ok(())
        });
        failed = r.err();
    })?;
    if let Some(e) = failed {
        return Err(e);
    }
    for (mft, out, pieces) in &mut streams {
        mft.drain()?;
        drain_out(mft, out, pieces)?;
    }
    let blocks = streams.iter().map(|(_, _, p)| p.len()).min().unwrap_or(0);
    let pieces = (0..blocks)
        .map(|j| {
            let len = streams.iter().map(|(_, _, p)| p[j].1.first().map_or(0, Vec::len)).min().unwrap_or(0);
            let planes = layout
                .sources
                .iter()
                .map(|src| match src {
                    Some((k, c)) => streams[*k].2[j].1.get(*c).map_or_else(|| vec![0.0; len], |p| p[..len].to_vec()),
                    None => vec![0.0; len],
                })
                .collect();
            (streams[0].2[j].0, planes)
        })
        .collect();
    Ok(Blocks { rate: streams[0].1.rate, channels: head.channels.into(), pieces })
}

/// Samples `[i0, i1)` decoded packet by packet by one of this crate's own decoders, which gives each packet's planes
/// and how many seconds after its sample's time they start: a block there (a packet that gives none adds no block).
fn per_packet<R: Reader + ?Sized>(
    reader: &R,
    track: &Track,
    i0: usize,
    i1: usize,
    mut decode: impl FnMut(&[u8]) -> Result<(f64, Vec<Vec<f32>>)>,
) -> Result<Pieces> {
    let s = &track.samples;
    let (i0, i1) = (i0.min(s.count()), i1.min(s.count()));
    let mut pieces = Vec::with_capacity(i1.saturating_sub(i0));
    let mut failed = None;
    read_samples(reader, track, i0, i1, |i, bytes| {
        if failed.is_none() {
            match decode(bytes) {
                Ok((after, planes)) if planes.first().is_some_and(|p| !p.is_empty()) => {
                    pieces.push((s.pts[i] as f64 / TICKS as f64 + after, planes));
                }
                Ok(_) => {}
                Err(e) => failed = Some(e),
            }
        }
    })?;
    failed.map_or(Ok(pieces), Err)
}

/// Samples `[i0, i1)` of an ALAC track: each frame a block at its sample's time.
fn decode_alac<R: Reader + ?Sized>(reader: &R, track: &Track, i0: usize, i1: usize) -> Result<Blocks> {
    let cookie = track.description.as_deref().ok_or_else(|| DecodeError::Damaged("ALAC without its config".into()))?;
    let mut dec = crate::alac::AlacDecoder::new(crate::alac::AlacConfig::parse(cookie)?);
    let pieces = per_packet(reader, track, i0, i1, |b| Ok((0.0, dec.decode(b)?)))?;
    let c = dec.config();
    Ok(Blocks { rate: c.sample_rate, channels: c.channels.into(), pieces })
}

/// Samples `[i0, i1)` of a Vorbis track: each packet's finished samples a block at its sample's time; a packet the
/// decoder refuses leaves a gap of silence.
fn decode_vorbis<R: Reader + ?Sized>(reader: &R, track: &Track, i0: usize, i1: usize) -> Result<Blocks> {
    let headers =
        track.description.as_deref().ok_or_else(|| DecodeError::Damaged("Vorbis without its headers".into()))?;
    let mut dec = crate::vorbis::VorbisDecoder::new(headers)?;
    let rate = f64::from(dec.rate());
    let pieces = per_packet(reader, track, i0, i1, |b| {
        Ok(dec.decode(b).map_or_else(Default::default, |(lead, planes)| (lead as f64 / rate, planes)))
    })?;
    Ok(Blocks { rate: dec.rate(), channels: dec.channels(), pieces })
}

/// A decoder made for a track.
struct Opened {
    mft: Transform,
    /// Bytes the first sample fed must start with.
    head: Option<Vec<u8>>,
    /// The decoder's times are not its blocks' (it stamps a block with the time of the sample after it): the blocks
    /// run on without gaps from the first sample's time.
    contiguous: bool,
    /// FLAC's sample size: each frame is checked first ([`crate::flac`]).
    flac: Option<u32>,
}

/// The decoder for the track.
fn open(track: &Track, rate: u32, channels: u32) -> Result<Opened> {
    let description = track.description.as_deref();
    let format = match route(&track.codec) {
        Some(Route::Aac) => {
            let asc = description.ok_or_else(|| DecodeError::Damaged("no AudioSpecificConfig".into()))?;
            parse_audio_specific_config(asc).map_err(|e| DecodeError::Damaged(e.detail.into_owned()))?;
            let mft = crate::audio::open(rate, channels, asc)?;
            return Ok(Opened { mft, head: None, contiguous: false, flac: None });
        }
        Some(Route::Other(f @ (Format::Mp3 | Format::Flac | Format::Opus))) => f,
        Some(Route::Other(f)) => return Err(DecodeError::Unsupported(f.refusal().into())),
        None => return Err(DecodeError::Unsupported(format!("no Media Foundation decoder here for {}", track.codec))),
    };
    let (mut bits, mut head) = (None, None);
    let user = match format {
        Format::Flac => {
            let d = description.ok_or_else(|| DecodeError::Damaged("FLAC without its STREAMINFO".into()))?;
            let si =
                parse_flac_stream_info(d).ok_or_else(|| DecodeError::Damaged("FLAC without its STREAMINFO".into()))?;
            bits = Some(si.bits);
            head = Some(
                crate::flac::stream_header(d)
                    .ok_or_else(|| DecodeError::Damaged("FLAC without its STREAMINFO".into()))?,
            );
            None
        }
        Format::Opus => {
            let head = match description {
                Some(d) => parse_opus_head(d).map_err(|e| DecodeError::Damaged(e.detail.into_owned()))?,
                None => OpusHead { channels: channels.min(2) as u8, ..OpusHead::default() },
            };
            // More than two channels go through `decode_opus_streams`: Microsoft's Opus decoder refuses them.
            Some(build_opus_head(&OpusHead { pre_skip: 0, ..head }))
        }
        _ => None,
    };
    let mft = transform(format, rate, channels, user.as_deref(), bits)?;
    // Microsoft's FLAC decoder parses a byte stream, as Windows' own FLAC source hands it the whole file: the
    // `fLaC` marker and the metadata go before the first frame, and it gives a frame once the next one starts.
    Ok(Opened { mft, contiguous: head.is_some(), head, flac: bits })
}

/// A started decoder transform of `format` for this input: its codec-private `user` data, FLAC's sample size `bits`.
fn transform(format: Format, rate: u32, channels: u32, user: Option<&[u8]>, bits: Option<u32>) -> Result<Transform> {
    let list = format.usable(MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER)?;
    let first = list.first().ok_or_else(|| DecodeError::Unsupported(format.refusal().into()))?;
    let mut mft = Transform::create(first)?;
    let input = MediaType::new(MFMediaType_Audio, format.subtype())?;
    input.set_u32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
    input.set_u32(MF_MT_AUDIO_NUM_CHANNELS, channels)?;
    if let Some(u) = user {
        input.set_blob(MF_MT_USER_DATA, u)?;
    }
    if let Some(b) = bits {
        // Microsoft's FLAC decoder wants the stream's sample size and block alignment in its input type.
        input.set_u32(MF_MT_AUDIO_BITS_PER_SAMPLE, b)?;
        input.set_u32(MF_MT_AUDIO_BLOCK_ALIGNMENT, b.div_ceil(8) * channels)?;
        input.set_u32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, b.div_ceil(8) * channels * rate)?;
    }
    mft.set_input(&input)?;
    pick_output(&mut mft)?;
    mft.begin()?;
    Ok(mft)
}

/// What comes out of the decoder: 32-bit float or 16-bit integer samples, interleaved.
struct Output {
    rate: u32,
    channels: u32,
    float: bool,
}

impl Output {
    fn of(mft: &Transform, rate: u32, channels: u32) -> Result<Self> {
        let t = mft.output_type()?;
        Ok(Self {
            rate: t.u32(MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(rate),
            channels: t.u32(MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(channels).max(1),
            float: t.guid(MF_MT_SUBTYPE) == Some(MFAudioFormat_Float),
        })
    }
}

/// The decoder's float output, else its 16-bit PCM output.
fn pick_output(mft: &mut Transform) -> Result<()> {
    let mut types = mft.output_types();
    let has = |types: &[MediaType], g: GUID, bits: u32| {
        types.iter().position(|t| t.guid(MF_MT_SUBTYPE) == Some(g) && t.u32(MF_MT_AUDIO_BITS_PER_SAMPLE) == Some(bits))
    };
    let at = has(&types, MFAudioFormat_Float, 32)
        .or_else(|| has(&types, MFAudioFormat_PCM, 16))
        .ok_or_else(|| DecodeError::Unsupported(format!("{} gives no float or 16-bit output", mft.name)))?;
    let t = types.swap_remove(at);
    mft.set_output(&t)
}

/// Pulls every block the decoder holds (how many); a format change picks the output type again.
fn drain_out(mft: &mut Transform, out: &mut Output, pieces: &mut Pieces) -> Result<usize> {
    let before = pieces.len();
    loop {
        match mft.pull()? {
            Pull::NeedInput => return Ok(pieces.len() - before),
            Pull::StreamChange => {
                pick_output(mft)?;
                *out = Output::of(mft, out.rate, out.channels)?;
            }
            Pull::Sample(s) => {
                let at = s.time().unwrap_or(0) as f64 / 1e7;
                let (n, float) = (out.channels as usize, out.float);
                let planes = s.read(|b, _| deinterleave(b, n, float))?;
                pieces.push((at, planes));
            }
        }
    }
}

fn deinterleave(b: &[u8], n: usize, float: bool) -> Vec<Vec<f32>> {
    let width = if float { 4 } else { 2 };
    let frames = b.len() / width / n;
    let mut planes = vec![Vec::with_capacity(frames); n];
    if float {
        for (k, v) in b.as_chunks::<4>().0.iter().take(frames * n).enumerate() {
            planes[k % n].push(f32::from_le_bytes(*v));
        }
    } else {
        for (k, v) in b.as_chunks::<2>().0.iter().take(frames * n).enumerate() {
            planes[k % n].push(f32::from(i16::from_le_bytes(*v)) / 32768.0);
        }
    }
    planes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deinterleaves_float_and_integer_samples() {
        let f: Vec<u8> = [1.0f32, -1.0, 0.5, -0.5].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(deinterleave(&f, 2, true), vec![vec![1.0, 0.5], vec![-1.0, -0.5]]);
        let i: Vec<u8> = [16384i16, -32768].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(deinterleave(&i, 1, false), vec![vec![0.5, -1.0]]);
    }

    #[test]
    fn codec_strings_route_to_their_decoders() {
        assert_eq!(route("mp4a.40.2"), Some(Route::Aac));
        assert_eq!(route("opus"), Some(Route::Other(Format::Opus)));
        assert_eq!(route("vp8"), None);
        assert_eq!(route("vorbis"), Some(Route::Other(Format::Vorbis)));
        assert!(decodes_audio("vorbis"), "lewton decodes Vorbis on any PC");
    }
}
