//! Shared by the tests: float buffers to and from the oracle, test projects the JavaScript builds, and mixers over
//! their sources.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;

use cut_audio::{Audio, AudioError, AudioRead, Mixer};
use cut_model::{Id, Project};
use cut_oracle::{bytes, unbytes};
use serde_json::Value;

pub fn f32s(v: &Value) -> Vec<f32> {
    unbytes(v).as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()
}

pub fn f64s(v: &Value) -> Vec<f64> {
    unbytes(v).as_chunks::<8>().0.iter().map(|c| f64::from_le_bytes(*c)).collect()
}

pub fn b32(x: &[f32]) -> Value {
    bytes(&x.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
}

pub fn b64(x: &[f64]) -> Value {
    bytes(&x.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
}

/// Deterministic test noise in -0.5..0.5 shaped by a few sines.
pub fn signal(n: usize, seed: u64) -> Vec<f32> {
    let mut rng = cut_oracle::Inputs::new(seed);
    (0..n)
        .map(|i| {
            let t = i as f64 / 48000.0;
            let noise = (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
            (0.3 * (2.0 * std::f64::consts::PI * (180.0 + seed as f64 * 37.0) * t).sin()
                + 0.2 * (2.0 * std::f64::consts::PI * 2900.0 * t).sin()
                + 0.3 * noise * (if (i / 9000) % 3 == 0 { 1.0 } else { 0.1 })) as f32
        })
        .collect()
}

/// Sound in memory read on demand, zeros outside it.
pub struct MemAudio {
    pub rate: f64,
    pub data: Arc<Vec<Vec<f32>>>,
}

impl AudioRead for MemAudio {
    fn rate(&self) -> f64 {
        self.rate
    }

    fn length(&self) -> i64 {
        self.data[0].len() as i64
    }

    fn read(&mut self, from: i64, to: i64) -> Result<Vec<Vec<f32>>, AudioError> {
        Ok(self
            .data
            .iter()
            .map(|c| {
                let mut o = vec![0f32; (to - from).max(0) as usize];
                let (lo, hi) = (from.max(0), to.min(c.len() as i64));
                if hi > lo {
                    o[(lo - from) as usize..(hi - from) as usize].copy_from_slice(&c[lo as usize..hi as usize]);
                }
                o
            })
            .collect())
    }
}

/// A source's rate and samples a channel.
pub type Sound = (f64, Arc<Vec<Vec<f32>>>);

/// A project the scenario built, with its sources by media name.
pub struct Built {
    pub project: Project,
    pub seq: Id,
    pub sources: HashMap<String, Sound>,
}

pub fn built(v: &Value) -> Built {
    let project = Project::load(v["project"].as_str().expect("project text")).expect("the JavaScript's project loads");
    let seq = Id::new(v["seq"].as_str().expect("seq id"));
    let sources = v["sources"]
        .as_object()
        .expect("sources")
        .iter()
        .map(|(k, s)| {
            let data: Vec<Vec<f32>> = s["data"].as_array().expect("data").iter().map(f32s).collect();
            (k.clone(), (s["rate"].as_f64().expect("rate"), Arc::new(data)))
        })
        .collect();
    Built { project, seq, sources }
}

/// A mixer at 48 kHz over a built project's sources: read on demand, or each given whole.
pub fn mixer(b: &Built, whole: bool) -> Mixer {
    let sources = b.sources.clone();
    Mixer::new(
        48000,
        Box::new(move |_p, m| {
            Ok(sources.get(&m.name).map(|(rate, data)| {
                if whole {
                    Audio::Whole { rate: *rate, data: data.as_ref().clone() }
                } else {
                    Audio::Reader(Box::new(MemAudio { rate: *rate, data: data.clone() }))
                }
            }))
        }),
    )
}

/// Mixes samples `[s0, s0 + total)` in blocks of the given sizes, in turn; the clips missing are counted.
pub fn mix_blocks(m: &mut Mixer, b: &Built, s0: i64, total: usize, blocks: &[usize]) -> ([Vec<f32>; 2], usize) {
    let mut out = [Vec::with_capacity(total), Vec::with_capacity(total)];
    let (mut at, mut k, mut missing) = (0, 0, 0);
    while at < total {
        let n = blocks[k % blocks.len()].min(total - at);
        k += 1;
        let r = m.mix_loaded(&b.project, b.seq, s0 + at as i64, n, 0.0);
        missing += r.missing;
        out[0].extend_from_slice(&r.out[0]);
        out[1].extend_from_slice(&r.out[1]);
        at += n;
    }
    (out, missing)
}

/// The largest difference of two buffers and where it is.
pub fn worst(a: &[f32], b: &[f32]) -> (f64, usize) {
    assert_eq!(a.len(), b.len(), "the same length");
    a.iter().zip(b).enumerate().fold((0.0, 0), |(w, at), (i, (x, y))| {
        let d = (f64::from(*x) - f64::from(*y)).abs();
        if d > w { (d, i) } else { (w, at) }
    })
}
