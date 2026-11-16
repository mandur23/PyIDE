//! Test sound and how to find it again: tones and sweeps as functions of the sample index, and the shift at which a
//! decoded buffer matches one, to the sample.

use std::f64::consts::PI;

/// `amp * sin` of `hz` at `rate`, starting at phase 0 on sample 0.
pub fn tone(hz: f64, rate: f64, amp: f64) -> impl Fn(i64) -> f64 {
    move |n| amp * (n as f64 * 2.0 * PI * hz / rate).sin()
}

/// A linear sweep from `f0` to `f1` Hz over `len` samples (silence outside), which matches itself at one shift only.
pub fn sweep(f0: f64, f1: f64, len: i64, rate: f64, amp: f64) -> impl Fn(i64) -> f64 {
    move |n| {
        if !(0..len).contains(&n) {
            return 0.0;
        }
        let t = n as f64 / rate;
        let k = (f1 - f0) / (len as f64 / rate);
        amp * (2.0 * PI * (f0 * t + k * t * t / 2.0)).sin()
    }
}

/// `signal` from sample `start` for `len` samples as 16-bit PCM, silence before `start`.
pub fn pcm16(signal: impl Fn(i64) -> f64, start: i64, total: usize) -> Vec<i16> {
    (0..total as i64).map(|n| (signal(n - start).clamp(-1.0, 1.0) * 32767.0).round() as i16).collect()
}

/// The shift `d` in `lags` at which `x[n]` best matches `reference(n - d)` over `window` (normalised correlation),
/// with that correlation.
pub fn best_lag(
    x: &[f32],
    reference: impl Fn(i64) -> f64,
    window: std::ops::Range<usize>,
    lags: std::ops::RangeInclusive<i64>,
) -> (i64, f64) {
    let mut best = (0, f64::MIN);
    for d in lags {
        let (mut xy, mut xx, mut yy) = (0.0, 0.0, 0.0);
        for n in window.clone() {
            let (a, b) = (f64::from(*x.get(n).unwrap_or(&0.0)), reference(n as i64 - d));
            xy += a * b;
            xx += a * a;
            yy += b * b;
        }
        let c = xy / (xx * yy).sqrt().max(1e-12);
        if c > best.1 {
            best = (d, c);
        }
    }
    best
}

/// The first sample louder than `threshold`.
pub fn onset(x: &[f32], threshold: f32) -> Option<usize> {
    x.iter().position(|v| v.abs() > threshold)
}

/// Zero crossings a second over `x[range]` at `rate`, halved: the frequency of a tone.
pub fn frequency(x: &[f32], range: std::ops::Range<usize>, rate: f64) -> f64 {
    let n = range.len();
    let crossings = x[range].windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    crossings as f64 / 2.0 * rate / n as f64
}
