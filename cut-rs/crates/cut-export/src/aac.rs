//! The AAC encoder's priming (`aacDelay`, `aacSetup`): an AAC encoder puts samples in front of the sound. The delay is
//! measured once per configuration by encoding a noise burst, writing it as an M4A in memory, decoding that the way
//! an import does and finding the lag with the best correlation; the export shifts its sound by it, so the writer's
//! edit list hides the priming and a beep stays on its frame.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use cut_decode::encode::{AAC_BITRATES, AacEncoder};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample};
use cut_formats::{Kind, MemReader, probe};
use cut_time::TICKS;

use crate::sink::Failure;

/// The measured encoder delay by (sample rate, channels, bitrate).
type Delays = Mutex<HashMap<(u32, u32, u32), i64>>;

fn cache() -> &'static Delays {
    static C: OnceLock<Delays> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn failed(e: impl std::fmt::Display) -> Failure {
    Failure::new("audio", &e.to_string())
}

/// Samples between a sample going into the AAC encoder and coming out of the decoder at the output's time.
pub fn aac_delay(rate: u32, channels: u32, bitrate: u32) -> Result<i64, Failure> {
    let key = (rate, channels, bitrate);
    if let Some(d) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(*d);
    }
    let n = (f64::from(rate) * 0.6).round() as usize;
    let at = (f64::from(rate) * 0.15).round() as usize;
    let len = 2048;
    let mut src = vec![0f32; n];
    let mut seed: u64 = 12345;
    for v in &mut src[at..at + len] {
        seed = (seed.wrapping_mul(1_103_515_245).wrapping_add(12345)) & 0x7fff_ffff;
        *v = ((seed as f64 / f64::from(0x7fff_ffff_u32)) * 2.0 - 1.0) as f32 * 0.5;
    }
    let mut enc = AacEncoder::new(rate, channels, bitrate).map_err(failed)?;
    let mut packets = Vec::new();
    let planes = vec![src.as_slice(); channels as usize];
    enc.push(&planes, &mut packets).map_err(failed)?;
    enc.finish(&mut packets).map_err(failed)?;
    let cfg = AudioConfig {
        codec: "mp4a.40.2".into(),
        sample_rate: rate,
        channels,
        description: Some(enc.description().to_vec()),
    };
    let mut w = Mp4Writer::create(None, Some(cfg), Vec::new(), None).map_err(failed)?;
    let block = 1024 * TICKS / i64::from(rate);
    for (i, p) in packets.into_iter().enumerate() {
        let s = Sample { data: p.data, timestamp: i as i64 * block, duration: block, key: true, composition_offset: 0 };
        w.add_audio(s).map_err(failed)?;
    }
    w.finish().map_err(failed)?;
    let file = MemReader(w.into_sink());
    let source = probe::open(&file, "delay.m4a");
    let track = source.tracks.iter().find(|t| t.kind() == Kind::Audio).ok_or_else(|| failed("no sound"))?;
    let pcm = cut_decode::decode_audio(&file, track).map_err(failed)?;
    let out = pcm.data.first().ok_or_else(|| failed("no sound"))?;
    let (mut best, mut best_score) = (0i64, f64::NEG_INFINITY);
    for lag in -2048i64..=6144 {
        let mut s = 0.0;
        for i in 0..len {
            let j = (at + i) as i64 + lag;
            if j >= 0 && (j as usize) < out.len() {
                s += f64::from(src[at + i]) * f64::from(out[j as usize]);
            }
        }
        if s > best_score {
            best_score = s;
            best = lag;
        }
    }
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(key, best);
    Ok(best)
}

/// The bitrate to encode AAC at and its delay: the one asked for, else the next lower one the encoder takes.
pub fn aac_setup(rate: u32, channels: u32, want: u32) -> Result<(u32, i64), Failure> {
    let mut last = Failure::new("audio", "no AAC encoder");
    let lower = AAC_BITRATES.iter().rev().copied().filter(|b| *b < want);
    for bitrate in std::iter::once(want).chain(lower) {
        match aac_delay(rate, channels, bitrate) {
            Ok(d) => return Ok((bitrate, d)),
            Err(e) => last = e,
        }
    }
    Err(last)
}
