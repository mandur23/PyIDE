//! Time stretch with the pitch kept (WSOLA, the engine's `stretch` and `stretchPart`): Hann frames of 40 ms at a 20 ms
//! output hop, each taken from within 10 ms of its nominal input place where it continues the previous frame best
//! (cross-correlation searched on a 4x decimated mono mix, then refined on the full rate).

use crate::util::{ceil_i, floor_i, round_i};

/// The output hop in samples.
pub fn stretch_hop(rate: f64) -> i64 {
    round_i(rate * 0.02).max(64)
}

/// `channels` about `factor` times as long (2: half speed), the pitch kept.
pub fn stretch(channels: &[Vec<f32>], factor: f64, rate: f64) -> Vec<Vec<f32>> {
    let in_len = channels.first().map_or(0, Vec::len) as i64;
    if (factor - 1.0).abs() < 1e-9 {
        return channels.to_vec();
    }
    stretch_part(channels, 0, in_len, factor, rate, 0, round_i(in_len as f64 * factor), None)
}

/// The input samples `[x0, x1)` of `in_len` that [`stretch_part`] reads for output `[o0, o1)`: the frames' nominal
/// places with their search tolerance, the frame length and the correlation's reach.
pub fn stretch_window(factor: f64, rate: f64, o0: i64, o1: i64) -> (i64, i64) {
    let hop = stretch_hop(rate);
    let reach = 4 * hop + round_i(rate * 0.01) + 16;
    (floor_i((((o0 - hop) as f64 / factor) - reach as f64) / 4.0) * 4, ceil_i(o1 as f64 / factor) + reach)
}

/// A signal held from sample `off` of one `len` long: zero outside both.
#[inline]
fn at(arr: &[f32], off: i64, len: i64, i: i64) -> f64 {
    if i >= 0 && i < len && i - off >= 0 && i - off < arr.len() as i64 {
        f64::from(arr[(i - off) as usize])
    } else {
        0.0
    }
}

fn corr(arr: &[f32], off: i64, len: i64, a: i64, b: i64, n: i64, step: usize) -> f64 {
    let mut num = 0.0;
    let mut eb = 0.0;
    let inside = a.min(b) >= off.max(0) && a.max(b) + n <= len.min(off + arr.len() as i64);
    if inside {
        let (xa, xb) =
            (&arr[(a - off) as usize..(a - off + n) as usize], &arr[(b - off) as usize..(b - off + n) as usize]);
        for i in (0..n as usize).step_by(step) {
            let y = f64::from(xb[i]);
            num += f64::from(xa[i]) * y;
            eb += y * y;
        }
    } else {
        for i in (0..n).step_by(step) {
            let y = at(arr, off, len, b + i);
            num += at(arr, off, len, a + i) * y;
            eb += y * y;
        }
    }
    if eb > 1e-12 { num / eb.sqrt() } else { 0.0 }
}

/// Output samples `[o0, o1)` of stretching an input of `in_len` samples, from `channels` holding its samples
/// `[x0, ...)` (x0 a multiple of 4; outside them it is silence). The frames' path starts afresh every `seg` output
/// samples (a multiple of the hop; `None`: never), so each segment can be made on its own from a window of the input.
#[allow(clippy::too_many_arguments)]
pub fn stretch_part(
    channels: &[Vec<f32>],
    x0: i64,
    in_len: i64,
    factor: f64,
    rate: f64,
    o0: i64,
    o1: i64,
    seg: Option<i64>,
) -> Vec<Vec<f32>> {
    let hop = stretch_hop(rate);
    let frame = 2 * hop;
    let tol = round_i(rate * 0.01);
    const D: i64 = 4;
    let l = hop;
    let n_ch = channels.len();
    let w_len = channels.first().map_or(0, Vec::len);
    let mut mono = vec![0f32; w_len];
    for c in channels {
        for (m, &v) in mono.iter_mut().zip(c) {
            *m = (f64::from(*m) + f64::from(v) / n_ch as f64) as f32;
        }
    }
    let d_len = in_len.div_euclid(D);
    let d0 = x0 / D;
    let dec: Vec<f32> = mono
        .as_chunks::<{ D as usize }>()
        .0
        .iter()
        .map(|c| (c.iter().fold(0f64, |s, &v| s + f64::from(v)) / D as f64) as f32)
        .collect();
    let win: Vec<f32> =
        (0..frame).map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / frame as f64).cos()) as f32).collect();
    let mut out = vec![vec![0f32; (o1 - o0).max(0) as usize]; n_ch];
    let mut prev: Option<i64> = None;
    let mut k = o0.div_euclid(hop) - 1;
    while k * hop < o1 {
        let out_pos = k * hop;
        // A fresh frame is placed so that the output from its middle on reads the input from the nominal place (one at
        // outPos / factor read silence before a clip's first sample when sped up).
        if seg.is_some_and(|s| (out_pos + hop) % s == 0) {
            prev = None;
        }
        let nominal = round_i(out_pos as f64 / factor);
        let mut best = match prev {
            None => round_i((out_pos + hop) as f64 / factor) - hop,
            Some(_) => nominal,
        };
        if let Some(p) = prev {
            let target = p + hop;
            let mut best_score = f64::NEG_INFINITY;
            let dt = round_i(target as f64 / D as f64);
            let dn = round_i(nominal as f64 / D as f64);
            let d_tol = ceil_i(tol as f64 / D as f64);
            let dl = l / D;
            let mut coarse = dn;
            for d in -d_tol..=d_tol {
                let s = corr(&dec, d0, d_len, dt, dn + d, dl, 1);
                if s > best_score {
                    best_score = s;
                    coarse = dn + d;
                }
            }
            best_score = f64::NEG_INFINITY;
            for d in -D..=D {
                let cand = coarse * D + d;
                if (cand - nominal).abs() > tol + D {
                    continue;
                }
                let s = corr(&mono, x0, in_len, target, cand, l, 2);
                if s > best_score {
                    best_score = s;
                    best = cand;
                }
            }
        }
        let (n_lo, n_hi) = ((o0 - out_pos).max(0), (o1 - out_pos).min(frame));
        let (i_lo, i_hi) = (0.max(x0).max(n_lo + best), in_len.min(x0 + w_len as i64).min(n_hi + best));
        for (x, y) in channels.iter().zip(out.iter_mut()) {
            for i in i_lo..i_hi {
                let n = i - best;
                let o = (out_pos + n - o0) as usize;
                y[o] = (f64::from(y[o]) + f64::from(x[(i - x0) as usize]) * f64::from(win[n as usize])) as f32;
            }
        }
        prev = Some(best);
        k += 1;
    }
    out
}
