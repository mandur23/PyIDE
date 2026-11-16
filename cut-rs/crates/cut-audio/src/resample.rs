//! Sample-rate conversion by windowed-sinc interpolation (the engine's `resample` and `resamplePart`): 16 taps each
//! side, 1024 fractional positions, a Kaiser window (beta 8.6), the cutoff at 0.96 of the lower Nyquist.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::util::{bessel_i0, floor_i, js_round, round_i};

/// Taps on each side of the interpolated point.
pub const RS_HALF: i64 = 16;
const RS_PHASES: usize = 1024;
const RS_BETA: f64 = 8.6;
const TAPS: usize = 2 * RS_HALF as usize;

/// The filter table for a cutoff (a fraction of the input's Nyquist), shared process-wide. Like the JavaScript, the
/// cache key is the cutoff to 6 decimals, so cutoffs that agree there share the first table made.
fn table(cutoff: f64) -> Arc<[f32]> {
    static TABLES: OnceLock<Mutex<HashMap<String, Arc<[f32]>>>> = OnceLock::new();
    let key = format!("{cutoff:.6}");
    let tables = TABLES.get_or_init(Default::default);
    if let Some(t) = tables.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return t.clone();
    }
    let i0b = bessel_i0(RS_BETA);
    let mut t = vec![0f32; (RS_PHASES + 1) * TAPS];
    for p in 0..=RS_PHASES {
        let frac = p as f64 / RS_PHASES as f64;
        for k in 0..TAPS {
            let x = k as f64 - (RS_HALF - 1) as f64 - frac;
            let u = x / RS_HALF as f64;
            let w = if u.abs() >= 1.0 { 0.0 } else { bessel_i0(RS_BETA * (1.0 - u * u).sqrt()) / i0b };
            let s = if x == 0.0 {
                1.0
            } else {
                (std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * cutoff * x)
            };
            t[p * TAPS + k] = (cutoff * s * w) as f32;
        }
    }
    let t: Arc<[f32]> = t.into();
    tables.lock().unwrap_or_else(|e| e.into_inner()).entry(key).or_insert(t).clone()
}

fn cutoff(from: f64, to: f64) -> f64 {
    (to / from).min(1.0) * 0.96
}

/// One output sample at input position `pos` of `x`, which holds input samples `[x0, x0 + x.len())` of an input of
/// `n` samples (outside them it is silence).
#[inline]
fn tap(x: &[f32], x0: i64, n: i64, table: &[f32], pos: f64) -> f32 {
    let i0 = floor_i(pos);
    let p = round_i((pos - i0 as f64) * RS_PHASES as f64) as usize * TAPS;
    let base = i0 - (RS_HALF - 1);
    let row = &table[p..p + TAPS];
    let mut acc = 0f64;
    let (lo, hi) = (base.max(0).max(x0), (base + TAPS as i64).min(n).min(x0 + x.len() as i64));
    if lo == base && hi == base + TAPS as i64 {
        let s = &x[(base - x0) as usize..(base - x0) as usize + TAPS];
        for k in 0..TAPS {
            acc += f64::from(s[k]) * f64::from(row[k]);
        }
    } else {
        for i in lo..hi {
            acc += f64::from(x[(i - x0) as usize]) * f64::from(row[(i - base) as usize]);
        }
    }
    acc as f32
}

/// `channels` at `from` Hz as new channels at `to` Hz, each `round(n * to / from)` samples long.
pub fn resample(channels: &[Vec<f32>], from: f64, to: f64) -> Vec<Vec<f32>> {
    if from == to {
        return channels.to_vec();
    }
    let ratio = from / to;
    let table = table(cutoff(from, to));
    channels
        .iter()
        .map(|x| {
            let n = x.len() as i64;
            let out_len = js_round(n as f64 * to / from).max(0.0) as usize;
            (0..out_len).map(|j| tap(x, 0, n, &table, j as f64 * ratio)).collect()
        })
        .collect()
}

/// Output samples `[o0, o1)` of [`resample`] of an input of `n` samples, from `channels` holding its samples
/// `[x0, ...)`.
pub fn resample_part(channels: &[Vec<f32>], x0: i64, n: i64, from: f64, to: f64, o0: i64, o1: i64) -> Vec<Vec<f32>> {
    let ratio = from / to;
    let table = table(cutoff(from, to));
    channels.iter().map(|x| (o0..o1.max(o0)).map(|j| tap(x, x0, n, &table, j as f64 * ratio)).collect()).collect()
}
