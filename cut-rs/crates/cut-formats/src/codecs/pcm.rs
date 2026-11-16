//! Uncompressed audio: the `pcm-*` codec strings and their decoding to float.

use crate::error::{FormatError, Result, unsupported};

/// The sample type of a `pcm-*` codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PcmType {
    Unsigned,
    Signed,
    Float,
}

/// What a codec string `pcm-u8`, `pcm-s16`, `pcm-s24be`, `pcm-f32` ... says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcmFormat {
    pub kind: PcmType,
    pub bits: u32,
    pub big: bool,
}

impl PcmFormat {
    /// Bytes a sample.
    pub fn bytes(self) -> usize {
        self.bits as usize / 8
    }
}

/// What a `pcm-*` codec string says, or `None` for another codec.
pub fn pcm_format(codec: &str) -> Option<PcmFormat> {
    let rest = codec.strip_prefix("pcm-")?;
    let kind = match rest.as_bytes().first()? {
        b'u' => PcmType::Unsigned,
        b's' => PcmType::Signed,
        b'f' => PcmType::Float,
        _ => return None,
    };
    let rest = &rest[1..];
    let (digits, big) = match rest.strip_suffix("be") {
        Some(d) => (d, true),
        None => (rest, false),
    };
    let bits = match digits {
        "8" => 8,
        "16" => 16,
        "24" => 24,
        "32" => 32,
        "64" => 64,
        _ => return None,
    };
    Some(PcmFormat { kind, bits, big })
}

fn word<const N: usize>(b: &[u8], p: usize) -> Result<[u8; N]> {
    b.get(p..p + N)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| FormatError::damaged("Offset is outside the bounds of the DataView"))
}

/// Interleaved PCM -> one buffer a channel, in -1..1. A trailing partial frame is left out.
pub fn pcm_to_float(b: &[u8], codec: &str, channels: usize) -> Result<Vec<Vec<f32>>> {
    let Some(f) = pcm_format(codec) else { return unsupported(format!("not PCM: {codec}")) };
    if channels == 0 {
        return Ok(Vec::new());
    }
    let step = f.bytes();
    let frames = b.len() / (step * channels);
    let used = &b[..frames * step * channels];
    let mut out: Vec<Vec<f32>> = (0..channels).map(|_| Vec::with_capacity(frames)).collect();
    let big = f.big;
    match (f.kind, f.bits) {
        (PcmType::Float, 32) => {
            planes::<4>(used, &mut out, |w| if big { f32::from_be_bytes(w) } else { f32::from_le_bytes(w) })
        }
        (PcmType::Float, 64) => {
            planes::<8>(used, &mut out, |w| (if big { f64::from_be_bytes(w) } else { f64::from_le_bytes(w) }) as f32)
        }
        // A float of another width reads 8 bytes at each sample's offset (the JavaScript's getFloat64), so the last
        // samples can run past the end: kept word by word for that error.
        (PcmType::Float, _) => {
            let mut p = 0;
            for _ in 0..frames {
                for ch in &mut out {
                    let w = word::<8>(b, p)?;
                    ch.push((if big { f64::from_be_bytes(w) } else { f64::from_le_bytes(w) }) as f32);
                    p += step;
                }
            }
        }
        (PcmType::Unsigned, 8) => planes::<1>(used, &mut out, |[x]| (f32::from(x) - 128.0) / 128.0),
        (_, 8) => planes::<1>(used, &mut out, |[x]| f32::from(x as i8) / 128.0),
        (_, 16) => planes::<2>(used, &mut out, |w| {
            f32::from(if big { i16::from_be_bytes(w) } else { i16::from_le_bytes(w) }) / 32768.0
        }),
        (_, 24) => planes::<3>(used, &mut out, |w| {
            let x = if big { [w[0], w[1], w[2], 0] } else { [w[2], w[1], w[0], 0] };
            (i32::from_be_bytes(x) >> 8) as f32 / 8_388_608.0
        }),
        (_, 32) => planes::<4>(used, &mut out, |w| int32(w, big)),
        // 64-bit integers: the first four bytes of each, as the JavaScript reads them.
        _ => planes::<8>(used, &mut out, |w| int32([w[0], w[1], w[2], w[3]], big)),
    }
    Ok(out)
}

fn int32(w: [u8; 4], big: bool) -> f32 {
    (f64::from(if big { i32::from_be_bytes(w) } else { i32::from_le_bytes(w) }) / 2_147_483_648.0) as f32
}

/// Deinterleaves whole frames of `N`-byte samples into one buffer a channel, each converted by `f`.
fn planes<const N: usize>(b: &[u8], out: &mut [Vec<f32>], f: impl Fn([u8; N]) -> f32 + Copy) {
    let (words, _) = b.as_chunks::<N>();
    match out {
        [mono] => mono.extend(words.iter().map(|&w| f(w))),
        [left, right] => {
            let (pairs, _) = words.as_chunks::<2>();
            left.resize(pairs.len(), 0.0);
            right.resize(pairs.len(), 0.0);
            for ((l, r), &[a, b]) in left.iter_mut().zip(right.iter_mut()).zip(pairs) {
                *l = f(a);
                *r = f(b);
            }
        }
        _ => {
            let channels = out.len();
            for (c, ch) in out.iter_mut().enumerate() {
                ch.extend(words.iter().skip(c).step_by(channels).map(|&w| f(w)));
            }
        }
    }
}
