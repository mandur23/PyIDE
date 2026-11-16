//! Loudness after ITU-R BS.1770-4 (K-weighting, the absolute and relative gates) and true peak, as the engine's
//! `createMeter`, `loudness`, `normalizeGain` and `matchGain`.

use std::sync::OnceLock;

use crate::util::{bessel_i0, gain_to_db, js_round};

/// The two K-weighting biquads for a sample rate (`[b0, b1, b2, a1, a2]` each): the shelf, then the high-pass.
pub fn k_filters(fs: f64) -> [[f64; 5]; 2] {
    let mut f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let mut q = 0.7071752369554196;
    let mut k = (std::f64::consts::PI * f0 / fs).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let mut a0 = 1.0 + k / q + k * k;
    let shelf = [
        (vh + vb * k / q + k * k) / a0,
        2.0 * (k * k - vh) / a0,
        (vh - vb * k / q + k * k) / a0,
        2.0 * (k * k - 1.0) / a0,
        (1.0 - k / q + k * k) / a0,
    ];
    f0 = 38.13547087602444;
    q = 0.5003270373238773;
    k = (std::f64::consts::PI * f0 / fs).tan();
    a0 = 1.0 + k / q + k * k;
    let hp = [1.0, -2.0, 1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0];
    [shelf, hp]
}

fn channel_weight(n: usize, c: usize) -> f64 {
    match (n, c) {
        (6, 3) => 0.0,
        (6, 4 | 5) | (5, 3 | 4) => 1.41,
        _ => 1.0,
    }
}

const TP_TAPS: usize = 16;

/// The true-peak interpolation rows for an oversampling of `l` (4, 2 or 1).
fn tp_table(l: usize) -> &'static [[f32; TP_TAPS]] {
    static TABLES: [OnceLock<Vec<[f32; TP_TAPS]>>; 3] = [OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let slot = match l {
        4 => 0,
        2 => 1,
        _ => 2,
    };
    TABLES[slot].get_or_init(|| {
        let half = (TP_TAPS / 2) as f64;
        let i0b = bessel_i0(8.0);
        (0..l)
            .map(|p| {
                let frac = p as f64 / l as f64;
                let mut row = [0f32; TP_TAPS];
                for (k, r) in row.iter_mut().enumerate() {
                    let x = k as f64 - (half - 1.0) - frac;
                    let u = x / half;
                    let w = if u.abs() >= 1.0 { 0.0 } else { bessel_i0(8.0 * (1.0 - u * u).sqrt()) / i0b };
                    let s = if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                    *r = (s * w) as f32;
                }
                row
            })
            .collect()
    })
}

/// What a meter measured: LUFS, dBTP and dBFS; -inf for silence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    pub integrated: f64,
    pub true_peak: f64,
    pub sample_peak: f64,
    pub momentary_max: f64,
    pub short_term_max: f64,
}

/// A streaming loudness meter: [`Meter::push`] sound as it comes, [`Meter::result`] at the end.
pub struct Meter {
    shelf: [f64; 5],
    hp: [f64; 5],
    weights: Vec<f64>,
    /// x1 x2 y1 y2 of each biquad, a channel.
    st: Vec<[f64; 8]>,
    seg: usize,
    seg_power: Vec<f64>,
    acc: Vec<f64>,
    acc_n: usize,
    tp: &'static [[f32; TP_TAPS]],
    hist: Vec<[f32; TP_TAPS]>,
    true_peak: f64,
    sample_peak: f64,
}

fn lufs(p: f64) -> f64 {
    if p > 0.0 { -0.691 + 10.0 * p.log10() } else { f64::NEG_INFINITY }
}

impl Meter {
    /// A meter for `channels` channels at `rate`.
    pub fn new(rate: f64, channels: usize) -> Self {
        let [shelf, hp] = k_filters(rate);
        let l = if rate >= 192000.0 {
            1
        } else if rate >= 96000.0 {
            2
        } else {
            4
        };
        Self {
            shelf,
            hp,
            weights: (0..channels).map(|c| channel_weight(channels, c)).collect(),
            st: vec![[0.0; 8]; channels],
            seg: js_round(rate / 10.0) as usize,
            seg_power: Vec::new(),
            acc: vec![0.0; channels],
            acc_n: 0,
            tp: tp_table(l),
            hist: vec![[0.0; TP_TAPS]; channels],
            true_peak: 0.0,
            sample_peak: 0.0,
        }
    }

    /// Adds one block: a slice a channel, all the same length.
    pub fn push(&mut self, channels: &[&[f32]]) {
        let n = channels.first().map_or(0, |c| c.len());
        let (sh, hp) = (self.shelf, self.hp);
        let oversample = self.tp.len() > 1;
        for i in 0..n {
            for (c, ch) in channels.iter().enumerate().take(self.st.len()) {
                let x = f64::from(ch[i]);
                let s = &mut self.st[c];
                let y1 = sh[0] * x + sh[1] * s[0] + sh[2] * s[1] - sh[3] * s[2] - sh[4] * s[3];
                s[1] = s[0];
                s[0] = x;
                s[3] = s[2];
                s[2] = y1;
                let y2 = hp[0] * y1 + hp[1] * s[4] + hp[2] * s[5] - hp[3] * s[6] - hp[4] * s[7];
                s[5] = s[4];
                s[4] = y1;
                s[7] = s[6];
                s[6] = y2;
                self.acc[c] += y2 * y2;
                let ax = x.abs();
                if ax > self.sample_peak {
                    self.sample_peak = ax;
                }
                let h = &mut self.hist[c];
                h.copy_within(1.., 0);
                h[TP_TAPS - 1] = ch[i];
                if oversample {
                    for row in self.tp {
                        let mut v = 0f64;
                        for k in 0..TP_TAPS {
                            v += f64::from(h[k]) * f64::from(row[k]);
                        }
                        let v = v.abs();
                        if v > self.true_peak {
                            self.true_peak = v;
                        }
                    }
                }
            }
            self.acc_n += 1;
            if self.acc_n == self.seg {
                let mut p = 0.0;
                for (c, a) in self.acc.iter_mut().enumerate() {
                    p += self.weights[c] * (*a / self.seg as f64);
                    *a = 0.0;
                }
                self.seg_power.push(p);
                self.acc_n = 0;
            }
        }
    }

    /// The loudness of everything pushed.
    pub fn result(&self) -> Loudness {
        let sp = &self.seg_power;
        let blocks: Vec<f64> = sp.windows(4).map(|w| (w[0] + w[1] + w[2] + w[3]) / 4.0).collect();
        let momentary_max = blocks.iter().fold(f64::NEG_INFINITY, |m, &b| m.max(lufs(b)));
        let short_term_max =
            sp.windows(30).fold(f64::NEG_INFINITY, |m, w| m.max(lufs(w.iter().fold(0.0, |s, v| s + v) / 30.0)));
        let abs: Vec<f64> = blocks.iter().copied().filter(|&b| lufs(b) > -70.0).collect();
        let mut integrated = f64::NEG_INFINITY;
        if !abs.is_empty() {
            let mean = abs.iter().fold(0.0, |a, b| a + b) / abs.len() as f64;
            let rel = lufs(mean) - 10.0;
            let gated: Vec<f64> = abs.iter().copied().filter(|&b| lufs(b) > rel).collect();
            if !gated.is_empty() {
                integrated = lufs(gated.iter().fold(0.0, |a, b| a + b) / gated.len() as f64);
            }
        }
        Loudness {
            integrated,
            true_peak: gain_to_db(self.true_peak.max(self.sample_peak)),
            sample_peak: gain_to_db(self.sample_peak),
            momentary_max,
            short_term_max,
        }
    }
}

/// The loudness of whole channels.
pub fn loudness(channels: &[&[f32]], rate: f64) -> Loudness {
    let mut m = Meter::new(rate, channels.len());
    m.push(channels);
    m.result()
}

/// The largest absolute value of some samples (or of min/max peak pairs).
pub fn peak_of(values: &[&[f32]]) -> f64 {
    values.iter().flat_map(|v| v.iter()).fold(0f64, |m, &v| m.max(f64::from(v).abs()))
}

/// The gain in dB that brings a highest peak of `peak` to `target` dBFS ("normalize max peak to -1 dB"); 0 for
/// silence.
pub fn normalize_gain(peak: f64, target: f64) -> f64 {
    let max = peak.abs();
    if max <= 0.0 || max.is_nan() {
        return 0.0;
    }
    target - gain_to_db(max)
}

/// The master gain (dB, to 0.01) that brings a measured mix to `target` LUFS without its true peak going above
/// `ceiling` dBTP.
pub fn match_gain(measured: &Loudness, target: f64, ceiling: f64) -> f64 {
    if !measured.integrated.is_finite() {
        return 0.0;
    }
    let mut g = target - measured.integrated;
    if measured.true_peak.is_finite() {
        g = g.min(ceiling - measured.true_peak);
    }
    js_round(g * 100.0) / 100.0
}
