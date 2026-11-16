//! Measurements of sound: waveform peaks for the timeline (`thumbs.computePeaks`, `coarsen`, `peaks`), RMS levels in
//! short windows and the loud, silent and speech ranges they give (`analyze.levelMeter`, `loudRanges`,
//! `silenceRanges`, `speechRanges`), the range algebra they use, and Auto Ducking's keyframes (`duckKeyframes`).
//! Ranges are `(a, b)` pairs: seconds for what is measured, ticks for timeline ranges. Onsets, tempo and beats
//! ([`Flux`], [`tempo`], [`track_beats`], [`fn@beats`]) are in `analysis/beats.rs`.

mod beats;
pub use beats::*;

use cut_model::keyframes::{Ease, Keyframe, Value};
use cut_time::TICKS;

use crate::source::{AudioError, AudioRead};
use crate::util::js_round;

/// The level of digital silence (instead of -inf).
pub const QUIET: f64 = -200.0;
/// Samples a peak of the finest peaks kept; coarser peaks are merged from these.
pub const BASE_SPP: usize = 256;

// ---- peaks ------------------------------------------------------------------------------------------------------------

/// Min/max pairs over blocks of `spp` samples, every channel together: `[min0, max0, min1, max1, ...]`.
pub fn compute_peaks(data: &[&[f32]], spp: usize) -> Vec<f32> {
    let len = data.first().map_or(0, |c| c.len());
    let spp = spp.max(1);
    let n = len.div_ceil(spp);
    let mut out = vec![0f32; n * 2];
    for b in 0..n {
        let (a, e) = (b * spp, (b * spp + spp).min(len));
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for ch in data {
            for &v in &ch[a..e.min(ch.len())] {
                lo = lo.min(v);
                hi = hi.max(v);
            }
        }
        out[2 * b] = if lo == f32::INFINITY { 0.0 } else { lo };
        out[2 * b + 1] = if hi == f32::NEG_INFINITY { 0.0 } else { hi };
    }
    out
}

/// Peaks of `k` neighbouring blocks merged: the peaks of blocks k times as long.
pub fn coarsen(fine: &[f32], k: usize) -> Vec<f32> {
    let n = fine.len() / 2;
    let k = k.max(1);
    let mut out = vec![0f32; n.div_ceil(k) * 2];
    for (b, o) in out.as_chunks_mut::<2>().0.iter_mut().enumerate() {
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for i in b * k..(b * k + k).min(n) {
            lo = lo.min(fine[2 * i]);
            hi = hi.max(fine[2 * i + 1]);
        }
        o[0] = lo;
        o[1] = hi;
    }
    out
}

/// The peaks of a whole source at `spp` samples of its own rate a peak, read about ten seconds at a time so the whole
/// track's sound is never held.
pub fn peaks(reader: &mut dyn AudioRead, spp: usize) -> Result<Vec<f32>, AudioError> {
    let spp = spp.max(1);
    let length = reader.length().max(0) as usize;
    let win = spp * (js_round(reader.rate() * 10.0 / spp as f64) as usize).max(1);
    let mut out = vec![0f32; length.div_ceil(spp) * 2];
    let mut a = 0;
    let mut planes = Vec::new();
    while a < length {
        let e = length.min(a + win);
        reader.read_into(a as i64, e as i64, &mut planes)?;
        let refs: Vec<&[f32]> = planes.iter().map(Vec::as_slice).collect();
        let p = compute_peaks(&refs, spp);
        out[a / spp * 2..a / spp * 2 + p.len()].copy_from_slice(&p);
        a = e;
    }
    Ok(out)
}

// ---- levels -----------------------------------------------------------------------------------------------------------

/// Streams sound into RMS levels of short windows: the louder channel's mean square in dBFS (a full-scale sine is
/// -3), [`QUIET`] for digital silence.
pub struct LevelMeter {
    /// Samples a window.
    pub size: usize,
    /// Seconds a window.
    pub step: f64,
    out: Vec<f32>,
    fill: usize,
    acc: Vec<f64>,
}

impl LevelMeter {
    pub fn new(rate: f64, window_sec: f64) -> Self {
        let size = (js_round(rate * window_sec) as usize).max(1);
        Self { size, step: size as f64 / rate, out: Vec::new(), fill: 0, acc: Vec::new() }
    }

    fn level(&self) -> f32 {
        let m = self.acc.iter().fold(0f64, |m, &s| m.max(s / self.fill.max(1) as f64));
        (if m > 0.0 { (10.0 * m.log10()).max(QUIET) } else { QUIET }) as f32
    }

    /// Adds a block: a slice a channel, all the same length; any block sizes give the same levels.
    pub fn push(&mut self, planes: &[&[f32]]) {
        let len = planes.first().map_or(0, |p| p.len());
        if self.acc.len() != planes.len() {
            self.acc.resize(planes.len(), 0.0);
        }
        let mut i = 0;
        while i < len {
            let take = (self.size - self.fill).min(len - i);
            for (c, p) in planes.iter().enumerate() {
                let mut s = self.acc[c];
                for &v in &p[i..i + take] {
                    let v = f64::from(v);
                    s += v * v;
                }
                self.acc[c] = s;
            }
            self.fill += take;
            i += take;
            if self.fill == self.size {
                let l = self.level();
                self.out.push(l);
                self.fill = 0;
                self.acc.iter_mut().for_each(|a| *a = 0.0);
            }
        }
    }

    /// The levels so far, the last partial window included.
    pub fn levels(&self) -> Vec<f32> {
        let mut res = self.out.clone();
        if self.fill > 0 {
            res.push(self.level());
        }
        res
    }
}

/// The windows louder than `threshold` dBFS as seconds.
pub fn loud_ranges(levels: &[f32], step: f64, threshold: f64) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut start = None;
    for i in 0..=levels.len() {
        let loud = i < levels.len() && f64::from(levels[i]) > threshold;
        match (loud, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s as f64 * step, i as f64 * step));
                start = None;
            }
            _ => {}
        }
    }
    out
}

// ---- ranges -----------------------------------------------------------------------------------------------------------

/// Overlapping or touching ranges joined, sorted.
pub fn union(list: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut sorted: Vec<(f64, f64)> = list.iter().copied().filter(|r| r.1 > r.0).collect();
    sorted.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for r in sorted {
        match out.last_mut() {
            Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => out.push(r),
        }
    }
    out
}

/// What of `spans` is not in `cuts`.
pub fn subtract(spans: &[(f64, f64)], cuts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let (a, b) = (union(spans), union(cuts));
    let mut out = Vec::new();
    let mut j = 0;
    for (s, e) in a {
        let mut at = s;
        while j < b.len() && b[j].1 <= at {
            j += 1;
        }
        let mut k = j;
        while k < b.len() && b[k].0 < e {
            if b[k].0 > at {
                out.push((at, b[k].0));
            }
            at = at.max(b[k].1);
            if at >= e {
                break;
            }
            k += 1;
        }
        if at < e {
            out.push((at, e));
        }
    }
    out
}

/// What is in both.
pub fn intersect(x: &[(f64, f64)], y: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let (a, b) = (union(x), union(y));
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let s = a[i].0.max(b[j].0);
        let e = a[i].1.min(b[j].1);
        if e > s {
            out.push((s, e));
        }
        if a[i].1 < b[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// The summed length.
pub fn total(list: &[(f64, f64)]) -> f64 {
    list.iter().fold(0.0, |n, r| n + (r.1 - r.0))
}

/// The silences to cut (ticks): the parts of `spans` that `loud` does not cover, at least `min_length` long, less
/// `margin` at both ends, then inside whole frames of `frame` ticks.
pub fn silence_ranges(
    spans: &[(f64, f64)],
    loud: &[(f64, f64)],
    min_length: f64,
    margin: f64,
    frame: f64,
) -> Vec<(f64, f64)> {
    subtract(spans, loud)
        .into_iter()
        .filter(|(a, b)| b - a >= min_length)
        .filter_map(|(a, b)| {
            let s = ((a + margin) / frame - 1e-9).ceil() * frame;
            let e = ((b - margin) / frame + 1e-9).floor() * frame;
            (e > s).then_some((s, e))
        })
        .collect()
}

/// The speech in `spans`: what is left once silences of `hold` ticks or longer are taken out (half a second is the
/// JavaScript's default).
pub fn speech_ranges(spans: &[(f64, f64)], loud: &[(f64, f64)], hold: f64) -> Vec<(f64, f64)> {
    subtract(spans, &silence_ranges(spans, loud, hold, 0.0, 1.0))
}

/// The default `hold` of [`speech_ranges`]: half a second.
pub const SPEECH_HOLD: f64 = 0.5 * TICKS as f64;

/// The mean of the channels.
pub fn mono(planes: &[&[f32]]) -> Vec<f32> {
    let len = planes.first().map_or(0, |p| p.len());
    if planes.len() == 1 {
        return planes[0].to_vec();
    }
    let mut out = vec![0f32; len];
    for p in planes {
        for (o, &v) in out.iter_mut().zip(p.iter()) {
            *o = (f64::from(*o) + f64::from(v)) as f32;
        }
    }
    for o in &mut out {
        *o = (f64::from(*o) / planes.len() as f64) as f32;
    }
    out
}

/// Keyframes for a clip's `duck` curve: `amount` dB down during each of `speech` (clip time ticks), with straight
/// `fade` ramps before and after; dips whose ramps would meet are joined; times in whole frames of `frame` ticks.
pub fn duck_keyframes(duration: f64, speech: &[(f64, f64)], amount: f64, fade: f64, frame: f64) -> Vec<Keyframe> {
    let snap = |t: f64| (js_round(t / frame) * frame).min(duration).max(0.0);
    let mut dips: Vec<(f64, f64)> = Vec::new();
    for (a0, b0) in union(speech) {
        let (a, b) = (snap(a0), snap(b0));
        if b <= 0.0 || a >= duration || b <= a {
            continue;
        }
        match dips.last_mut() {
            Some(last) if a - fade <= last.1 + fade => last.1 = last.1.max(b),
            _ => dips.push((a, b)),
        }
    }
    if dips.is_empty() {
        return Vec::new();
    }
    let dip_at = |t: f64| {
        if dips.iter().any(|&(a, b)| t >= a && t <= b) {
            return amount;
        }
        for &(a, b) in &dips {
            if t > a - fade && t < a {
                return amount * (t - (a - fade)) / fade;
            }
            if t > b && t < b + fade {
                return amount * (b + fade - t) / fade;
            }
        }
        0.0
    };
    let mut times = vec![0.0, duration];
    for &(a, b) in &dips {
        times.extend([a - fade, a, b, b + fade].into_iter().filter(|t| *t >= 0.0 && *t <= duration));
    }
    times.sort_by(f64::total_cmp);
    times.dedup();
    let out: Vec<(f64, f64)> = times.iter().map(|&t| (t, js_round(dip_at(t) * 100.0) / 100.0)).collect();
    out.iter()
        .enumerate()
        .filter(|(i, k)| *i == 0 || *i == out.len() - 1 || !(out[i - 1].1 == k.1 && out[i + 1].1 == k.1))
        .map(|(_, &(t, v))| Keyframe { t: t as i64, v: Value::Num(v), ease: Ease::Linear, h: None })
        .collect()
}
