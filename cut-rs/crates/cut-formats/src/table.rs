//! Sample tables as every reader builds them: container clocks to ticks, the builder, and the finishing every track
//! gets (presentation order, sync samples, nominal frame rate, VFR).

use std::collections::HashMap;

use cut_time::{TICKS, Ticks};

use crate::error::{Result, damaged};
use crate::source::{SampleTable, Video};

/// A table holds at most this many samples (2.7 GB of columns): beyond it a file is taken as damaged, where the
/// JavaScript runs out of memory.
pub const MAX_SAMPLES: usize = 1 << 26;

/// JavaScript's `Math.round`: halves go up, also below zero.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// A float to an integer the way the JavaScript's numbers become table entries (out of range saturates, NaN is 0).
pub fn to_i64(x: f64) -> i64 {
    x as i64
}

/// A size or a rate as a table field: below 0 is 0, past `u32::MAX` saturates (NaN is 0).
pub fn dim(v: f64) -> u32 {
    v as u32
}

/// A container time in units of `1/scale` seconds -> ticks, rounded half away from zero (saturating past the range
/// of ticks, where a damaged file's numbers go). `scale` is not 0.
pub fn rescale(v: i64, scale: u64) -> Ticks {
    let q = i128::from(v) * i128::from(TICKS) / i128::from(scale);
    if q > i128::from(i64::MAX) {
        i64::MAX
    } else if q < i128::from(i64::MIN) {
        i64::MIN
    } else {
        cut_time::rescale(v, scale)
    }
}

/// [`rescale`] of a value that may have a fraction: the value is rounded first, symmetrically around 0.
pub fn rescale_f(v: f64, scale: u64) -> Ticks {
    let r = to_i64(js_round(v.abs()));
    if v < 0.0 { -rescale(r, scale) } else { rescale(r, scale) }
}

/// Ticks -> units of `1/scale` seconds, rounded half away from zero.
pub fn to_scale(t: Ticks, scale: u64) -> i64 {
    cut_time::to_scale(t, scale)
}

/// One container clock: an exact multiply when the scale divides [`TICKS`] (every common rate does).
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    scale: u64,
    k: Option<i64>,
}

impl Clock {
    /// `scale` is not 0.
    pub fn new(scale: u64) -> Self {
        let k = (TICKS as u64).is_multiple_of(scale).then(|| (TICKS as u64 / scale) as i64);
        Self { scale, k }
    }

    /// Container units -> ticks.
    pub fn ticks(self, v: i64) -> Ticks {
        match self.k {
            Some(k) => v.saturating_mul(k),
            None => rescale(v, self.scale),
        }
    }

    /// Ticks -> container units, rounded half up.
    pub fn units(self, t: Ticks) -> i64 {
        match self.k {
            // Math.round(t / k): halves go up. In i64 when it cannot overflow (it is the writer's hot path).
            Some(k) => match t.checked_mul(2).and_then(|t2| t2.checked_add(k)) {
                Some(n) => n.div_euclid(2 * k),
                None => (2 * i128::from(t) + i128::from(k)).div_euclid(2 * i128::from(k)) as i64,
            },
            None => to_scale(t, self.scale),
        }
    }
}

/// Appends samples one at a time.
#[derive(Debug, Default)]
pub struct TableBuilder {
    pub t: SampleTable,
}

impl TableBuilder {
    /// Room for `n` samples (at most 4 million ahead: a damaged count must not take the memory).
    pub fn new(n: usize) -> Self {
        let n = n.clamp(16, 1 << 22);
        let t = SampleTable {
            offset: Vec::with_capacity(n),
            size: Vec::with_capacity(n),
            dts: Vec::with_capacity(n),
            pts: Vec::with_capacity(n),
            duration: Vec::with_capacity(n),
            key: Vec::with_capacity(n),
            order: Vec::new(),
            keys: Vec::new(),
        };
        Self { t }
    }

    pub fn len(&self) -> usize {
        self.t.offset.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t.offset.is_empty()
    }

    /// Appends a sample; its index.
    pub fn push(
        &mut self,
        offset: u64,
        size: u32,
        dts: Ticks,
        pts: Ticks,
        duration: Ticks,
        key: bool,
    ) -> Result<usize> {
        let t = &mut self.t;
        let i = t.offset.len();
        if i >= MAX_SAMPLES {
            return damaged("too many samples");
        }
        t.offset.push(offset);
        t.size.push(size);
        t.dts.push(dts);
        t.pts.push(pts);
        t.duration.push(duration);
        t.key.push(key);
        Ok(i)
    }
}

/// Keeps the samples where `keep(i)` is true; whether any went.
pub fn retain(t: &mut SampleTable, keep: impl Fn(&SampleTable, usize) -> bool) -> bool {
    let Some(first) = (0..t.count()).position(|i| !keep(t, i)) else { return false };
    let mask: Vec<bool> = (0..t.count()).map(|i| i < first || (i > first && keep(t, i))).collect();
    fn col<T: Copy>(v: &mut Vec<T>, mask: &[bool]) {
        let mut i = 0;
        v.retain(|_| {
            i += 1;
            mask[i - 1]
        });
    }
    col(&mut t.offset, &mask);
    col(&mut t.size, &mask);
    col(&mut t.dts, &mask);
    col(&mut t.pts, &mask);
    col(&mut t.duration, &mask);
    col(&mut t.key, &mask);
    true
}

const STANDARD_RATES: [[u64; 2]; 21] = [
    [24000, 1001],
    [24, 1],
    [25, 1],
    [30000, 1001],
    [30, 1],
    [48, 1],
    [50, 1],
    [60000, 1001],
    [60, 1],
    [90, 1],
    [100, 1],
    [120000, 1001],
    [120, 1],
    [144, 1],
    [240, 1],
    [15, 1],
    [12, 1],
    [10, 1],
    [8, 1],
    [5, 1],
    [1, 1],
];

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

/// `[num, den]` in lowest terms.
pub fn reduce(num: u64, den: u64) -> [u64; 2] {
    let g = gcd(num, den).max(1);
    [num / g, den / g]
}

/// The frame rate of frames `ticks` long: a standard rate within `tolerance` (relative), else the exact rate.
pub fn fps_from_ticks(ticks: f64, tolerance: f64) -> [u64; 2] {
    if ticks.is_nan() || ticks <= 0.0 {
        return [30, 1];
    }
    let v = TICKS as f64 / ticks;
    let mut best: Option<([u64; 2], f64)> = None;
    for r in STANDARD_RATES {
        let d = (r[0] as f64 / r[1] as f64 - v).abs() / v;
        if d <= tolerance && best.is_none_or(|(_, bd)| d < bd) {
            best = Some((r, d));
        }
    }
    if let Some((r, _)) = best {
        return r;
    }
    if ticks.fract() == 0.0 && TICKS as f64 % ticks == 0.0 {
        return [(TICKS as f64 / ticks) as u64, 1];
    }
    reduce(js_round(v * 1000.0) as u64, 1000)
}

/// How often each frame duration occurs. A file has a handful of them, so a short list with the last hit first does
/// better than hashing every frame; past 32 it becomes a map.
#[derive(Default)]
struct Counts {
    few: Vec<(i64, u32)>,
    last: usize,
    many: Option<HashMap<i64, u32>>,
}

impl Counts {
    /// Counts `d`; returns its count so far.
    fn add(&mut self, d: i64) -> u32 {
        if let Some(m) = &mut self.many {
            let c = m.entry(d).or_insert(0);
            *c += 1;
            return *c;
        }
        if self.few.get(self.last).is_some_and(|x| x.0 == d) {
            self.few[self.last].1 += 1;
            return self.few[self.last].1;
        }
        if let Some(i) = self.few.iter().position(|x| x.0 == d) {
            self.last = i;
            self.few[i].1 += 1;
            return self.few[i].1;
        }
        if self.few.len() < 32 {
            self.last = self.few.len();
            self.few.push((d, 1));
            return 1;
        }
        let mut m: HashMap<i64, u32> = self.few.drain(..).collect();
        m.insert(d, 1);
        self.many = Some(m);
        1
    }

    fn values(&self) -> Box<dyn Iterator<Item = i64> + '_> {
        match &self.many {
            Some(m) => Box::new(m.keys().copied()),
            None => Box::new(self.few.iter().map(|x| x.0)),
        }
    }
}

/// Finishes a table: presentation order and the sync sample index, and for video the nominal frame rate (the most
/// common frame duration) and VFR. `quantum` is one unit of the container's clock in ticks: Matroska's millisecond
/// timestamps make a steady 29.97 look like 33, 33, 34 ms.
pub fn finish_track(t: &mut SampleTable, video: Option<&mut Video>, quantum: f64) {
    let n = t.count();
    let mut order: Vec<u32> = (0..n as u32).collect();
    if t.pts.windows(2).any(|w| w[1] < w[0]) {
        let pts = &t.pts;
        order.sort_unstable_by_key(|&i| (pts[i as usize], i));
    }
    t.keys = (0..n as u32).filter(|&i| t.key[i as usize]).collect();
    let Some(v) = video else {
        t.order = order;
        return;
    };
    if n < 2 {
        v.frame_rate = fps_from_ticks(if n > 0 { t.duration[0] as f64 } else { 0.0 }, 0.002);
        v.vfr = false;
        t.order = order;
        return;
    }
    let mut counts = Counts::default();
    let (mut mode, mut best) = (0_i64, 0_u32);
    for k in 0..n - 1 {
        let d = t.pts[order[k + 1] as usize].saturating_sub(t.pts[order[k] as usize]);
        let c = counts.add(d);
        if c > best || (c == best && d < mode) {
            best = c;
            mode = d;
        }
    }
    let tolerance = (mode as f64 * 0.01).max(quantum * 1.01);
    let vfr = counts.values().any(|d| (d as f64 - mode as f64).abs() > tolerance);
    let mean = (t.pts[order[n - 1] as usize] as f64 - t.pts[order[0] as usize] as f64) / (n - 1) as f64;
    let relative = (if mode != 0 { quantum * 1.01 / mode as f64 } else { 0.0 }).max(0.002);
    v.frame_rate = fps_from_ticks(if vfr { mode as f64 } else { mean }, relative);
    v.vfr = vfr;
    t.order = order;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_and_clocks() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(rescale_f(-2.5, 1), -3 * TICKS);
        let c = Clock::new(44100);
        assert_eq!(c.ticks(-1105), -1105 * 5_760_000);
        assert_eq!(c.units(-6_364_800_000), -1105);
        assert_eq!(rescale(7, 10_000_000), 177_811);
        assert_eq!(rescale(i64::MAX / 2, 3), i64::MAX);
        assert_eq!(rescale(-(1 << 60), 1), i64::MIN);
    }

    #[test]
    fn frame_rates_from_durations() {
        assert_eq!(fps_from_ticks(TICKS as f64 * 1001.0 / 30000.0, 0.002), [30000, 1001]);
        assert_eq!(fps_from_ticks(0.0, 0.002), [30, 1]);
        assert_eq!(fps_from_ticks(TICKS as f64 / 7.0, 0.002), [7, 1]);
    }
}
