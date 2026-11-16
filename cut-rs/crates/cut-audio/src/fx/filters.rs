//! Biquads from the RBJ Audio EQ Cookbook in transposed direct form II, the filter lists of the equalizer, bass,
//! treble and hum remover, and the frequency response the effect controls draw.

use std::f64::consts::{PI, SQRT_2};

use super::{BASS_HZ, Dsp, MAX_MEMORY, TREBLE_HZ};
use crate::effects::eq;
use crate::util::{db_to_gain, js_round};

const SQRT1_2: f64 = SQRT_2 / 2.0;

/// A biquad's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterType {
    Lowpass,
    Highpass,
    Peaking,
    Lowshelf,
    Highshelf,
    Notch,
    /// `1 - (1 - g) BP`: the hum notches, whose bandwidth stays Q at any depth.
    Cut,
}

impl FilterType {
    /// The JavaScript's name; anything unknown is a peaking band, as `design`'s default case.
    pub fn of(name: &str) -> Self {
        match name {
            "lowpass" => Self::Lowpass,
            "highpass" => Self::Highpass,
            "lowshelf" => Self::Lowshelf,
            "highshelf" => Self::Highshelf,
            "notch" => Self::Notch,
            "cut" => Self::Cut,
            _ => Self::Peaking,
        }
    }
}

/// `[b0, b1, b2, a1, a2]` normalized by a0.
pub fn design(kind: FilterType, f0: f64, gain_db: f64, q: f64, fs: f64) -> [f64; 5] {
    let f = f0.min(fs * 0.49).max(1.0);
    let w0 = 2.0 * PI * f / fs;
    let cs = w0.cos();
    let alpha = w0.sin() / (2.0 * q.max(1e-3));
    let a = 10f64.powf(gain_db / 40.0);
    let (b0, b1, b2, a0, a1, a2);
    match kind {
        FilterType::Lowpass => {
            (b0, b1, b2) = ((1.0 - cs) / 2.0, 1.0 - cs, (1.0 - cs) / 2.0);
            (a0, a1, a2) = (1.0 + alpha, -2.0 * cs, 1.0 - alpha);
        }
        FilterType::Highpass => {
            (b0, b1, b2) = ((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0);
            (a0, a1, a2) = (1.0 + alpha, -2.0 * cs, 1.0 - alpha);
        }
        FilterType::Notch => {
            (b0, b1, b2) = (1.0, -2.0 * cs, 1.0);
            (a0, a1, a2) = (1.0 + alpha, -2.0 * cs, 1.0 - alpha);
        }
        FilterType::Cut => {
            let g = 10f64.powf(gain_db.min(0.0) / 20.0);
            (b0, b1, b2) = (1.0 + g * alpha, -2.0 * cs, 1.0 - g * alpha);
            (a0, a1, a2) = (1.0 + alpha, -2.0 * cs, 1.0 - alpha);
        }
        FilterType::Lowshelf => {
            let s = 2.0 * a.sqrt() * alpha;
            b0 = a * ((a + 1.0) - (a - 1.0) * cs + s);
            b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cs);
            b2 = a * ((a + 1.0) - (a - 1.0) * cs - s);
            a0 = (a + 1.0) + (a - 1.0) * cs + s;
            a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cs);
            a2 = (a + 1.0) + (a - 1.0) * cs - s;
        }
        FilterType::Highshelf => {
            let s = 2.0 * a.sqrt() * alpha;
            b0 = a * ((a + 1.0) + (a - 1.0) * cs + s);
            b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cs);
            b2 = a * ((a + 1.0) + (a - 1.0) * cs - s);
            a0 = (a + 1.0) - (a - 1.0) * cs + s;
            a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cs);
            a2 = (a + 1.0) - (a - 1.0) * cs - s;
        }
        FilterType::Peaking => {
            (b0, b1, b2) = (1.0 + alpha * a, -2.0 * cs, 1.0 - alpha * a);
            (a0, a1, a2) = (1.0 + alpha / a, -2.0 * cs, 1.0 - alpha / a);
        }
    }
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

/// |H| in dB of a biquad at f Hz.
pub fn magnitude_db(c: &[f64; 5], f: f64, fs: f64) -> f64 {
    let w = 2.0 * PI * f / fs;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let nr = c[0] + c[1] * c1 + c[2] * c2;
    let ni = -(c[1] * s1 + c[2] * s2);
    let dr = 1.0 + c[3] * c1 + c[4] * c2;
    let di = -(c[3] * s1 + c[4] * s2);
    10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
}

/// Samples after which a biquad's impulse response is down by e^-12 (about -104 dB), from its poles' radius.
pub fn ring_samples(c: &[f64; 5]) -> f64 {
    let (a1, a2) = (c[3], c[4]);
    let disc = a1 * a1 - 4.0 * a2;
    let r = if disc < 0.0 {
        a2.max(0.0).sqrt()
    } else {
        ((-a1 + disc.sqrt()) / 2.0).abs().max(((-a1 - disc.sqrt()) / 2.0).abs())
    };
    if r >= 1.0 || r.is_nan() {
        return f64::INFINITY;
    }
    if r <= 0.0 { 0.0 } else { 12.0 / -r.ln() }
}

/// The sections' Q of a Butterworth high- or low-pass of slope 12, 24 or 48 dB/octave.
pub const BUTTERWORTH: [&[f64]; 3] = [
    &[SQRT1_2],
    &[0.5411961001461969, 1.3065629648763766],
    &[0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055],
];

fn sections_q(slope: f64) -> &'static [f64] {
    if slope == 24.0 {
        BUTTERWORTH[1]
    } else if slope == 48.0 {
        BUTTERWORTH[2]
    } else {
        BUTTERWORTH[0]
    }
}

/// One filter of an effect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Filter {
    pub kind: FilterType,
    pub f: f64,
    pub gain: f64,
    pub q: f64,
}

const fn filter(kind: FilterType, f: f64, gain: f64, q: f64) -> Filter {
    Filter { kind, f, gain, q }
}

fn eq_filters(p: &[f64]) -> Vec<Filter> {
    let on = |i: usize| p[i] != 0.0;
    let mut out = Vec::new();
    if on(eq::HP_ON) {
        out.extend(sections_q(p[eq::HP_SLOPE]).iter().map(|&q| filter(FilterType::Highpass, p[eq::HP_FREQ], 0.0, q)));
    }
    if on(eq::LS_ON) {
        out.push(filter(FilterType::Lowshelf, p[eq::LS_FREQ], p[eq::LS_GAIN], SQRT1_2));
    }
    for b in 0..3 {
        let i = eq::BAND + 4 * b;
        if on(i) {
            out.push(filter(FilterType::Peaking, p[i + 1], p[i + 2], p[i + 3]));
        }
    }
    if on(eq::HS_ON) {
        out.push(filter(FilterType::Highshelf, p[eq::HS_FREQ], p[eq::HS_GAIN], SQRT1_2));
    }
    if on(eq::LP_ON) {
        out.extend(sections_q(p[eq::LP_SLOPE]).iter().map(|&q| filter(FilterType::Lowpass, p[eq::LP_FREQ], 0.0, q)));
    }
    out
}

/// The hum remover: a cut of `reduction` dB, Q wide, at the mains frequency and each harmonic up to `harmonics`.
fn hum_filters(p: &[f64], fs: f64) -> Vec<Filter> {
    let f0 = if p[0] == 50.0 { 50.0 } else { 60.0 };
    let mut out = Vec::new();
    let n = js_round(p[1].clamp(1.0, 10.0)) as i64;
    for k in 1..=n {
        let f = f0 * k as f64;
        if f >= fs * 0.45 {
            break;
        }
        out.push(filter(FilterType::Cut, f, -p[2].abs(), p[3]));
    }
    out
}

/// The filters an effect is made of, for a frequency response graph (empty for dynamics).
pub fn filters_of(dsp: Dsp, p: &[f64], fs: f64) -> Vec<Filter> {
    match dsp {
        Dsp::Eq => eq_filters(p),
        Dsp::Bass => vec![filter(FilterType::Lowshelf, BASS_HZ, p[0], SQRT1_2)],
        Dsp::Treble => vec![filter(FilterType::Highshelf, TREBLE_HZ, p[0], SQRT1_2)],
        Dsp::Dehum => hum_filters(p, fs),
        _ => Vec::new(),
    }
}

/// The frequency response in dB of a filter effect at the given frequencies.
pub fn response(dsp: Dsp, p: &[f64], freqs: &[f64], fs: f64) -> Vec<f64> {
    let cs: Vec<[f64; 5]> = filters_of(dsp, p, fs).iter().map(|f| design(f.kind, f.f, f.gain, f.q, fs)).collect();
    let out = if dsp == Dsp::Eq { p[eq::OUTPUT] } else { 0.0 };
    freqs.iter().map(|&f| cs.iter().fold(out, |s, c| s + magnitude_db(c, f, fs))).collect()
}

pub(super) fn memory(dsp: Dsp, p: &[f64], fs: f64) -> f64 {
    let worst =
        filters_of(dsp, p, fs).iter().fold(0f64, |w, f| w.max(ring_samples(&design(f.kind, f.f, f.gain, f.q, fs))));
    (worst / fs).min(MAX_MEMORY)
}

/// The state of a filter effect: coefficients for the parameters last seen, a channel pair of memories a filter.
#[derive(Debug, Clone)]
pub struct Bank {
    fs: f64,
    sig: Option<Vec<f64>>,
    coeffs: Vec<[f64; 5]>,
    /// z1L z2L z1R z2R of each filter, by its place in the list (a moving parameter keeps the filter's state).
    mems: Vec<[f64; 4]>,
    out: f64,
}

fn is_identity(c: &[f64; 5]) -> bool {
    c[0] == 1.0 && c[1] == c[3] && c[2] == c[4]
}

/// A decayed state is flushed to zero: subnormal doubles are a hundred times slower.
fn flush(z: f64) -> f64 {
    if z.abs() < 1e-30 { 0.0 } else { z }
}

fn biquad(c: &[f64; 5], m: &mut [f64; 4], l: &mut [f64], r: &mut [f64], from: usize, to: usize) {
    let [b0, b1, b2, a1, a2] = *c;
    for (x, k) in [(l, 0), (r, 2)] {
        let (mut z1, mut z2) = (m[k], m[k + 1]);
        for v in &mut x[from..to] {
            let xi = *v;
            let y = b0 * xi + z1;
            z1 = b1 * xi - a1 * y + z2;
            z2 = b2 * xi - a2 * y;
            *v = y;
        }
        m[k] = flush(z1);
        m[k + 1] = flush(z2);
    }
}

impl Bank {
    pub(super) fn new(fs: f64) -> Self {
        Self { fs, sig: None, coeffs: Vec::new(), mems: Vec::new(), out: 1.0 }
    }

    pub(super) fn process(&mut self, dsp: Dsp, l: &mut [f64], r: &mut [f64], from: usize, to: usize, p: &[f64]) {
        if self.sig.as_deref() != Some(p) {
            self.sig = Some(p.to_vec());
            let fl = filters_of(dsp, p, self.fs);
            self.coeffs = fl.iter().map(|f| design(f.kind, f.f, f.gain, f.q, self.fs)).collect();
            self.mems.resize(self.coeffs.len(), [0.0; 4]);
            self.out = if dsp == Dsp::Eq { db_to_gain(p[eq::OUTPUT]) } else { 1.0 };
        }
        for (c, m) in self.coeffs.iter().zip(self.mems.iter_mut()) {
            if !is_identity(c) {
                biquad(c, m, l, r, from, to);
            }
        }
        if self.out != 1.0 {
            for i in from..to {
                l[i] *= self.out;
                r[i] *= self.out;
            }
        }
    }
}
