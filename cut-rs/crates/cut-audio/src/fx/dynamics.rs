//! Dynamics: the compressor (feed-forward, stereo linked, soft knee, smoothed in dB), the hard limiter (1.5 ms
//! look-ahead, optional 4x true peak) and the noise gate.

use super::{LOOKAHEAD_MS, MAX_MEMORY};
use crate::util::{db_to_gain, js_round};

fn coef(ms: f64, fs: f64) -> f64 {
    if ms > 0.0 { (-1000.0 / (ms * fs)).exp() } else { 0.0 }
}

fn level_db(x: f64) -> f64 {
    if x > 1e-10 { 20.0 * x.log10() } else { -200.0 }
}

/// JavaScript's `x || 0` of a number.
fn or0(x: f64) -> f64 {
    if x.is_nan() { 0.0 } else { x }
}

/// The compressor's static curve: the output level (dB) for an input level, with a soft knee of `knee` dB.
pub fn compress_curve(x: f64, threshold: f64, ratio: f64, knee: f64) -> f64 {
    let d = x - threshold;
    if knee > 0.0 && 2.0 * d.abs() <= knee {
        return x + ((1.0 / ratio - 1.0) * (d + knee / 2.0).powi(2)) / (2.0 * knee);
    }
    if d > 0.0 { threshold + d / ratio } else { x }
}

pub(super) fn compressor_memory(p: &[f64]) -> f64 {
    (6.0 * (or0(p[2]) + or0(p[3])) / 1000.0).min(MAX_MEMORY)
}

/// threshold, ratio, attack, release, knee, makeup.
#[derive(Debug, Clone)]
pub struct Compressor {
    fs: f64,
    gs: f64,
}

impl Compressor {
    pub(super) fn new(fs: f64) -> Self {
        Self { fs, gs: 0.0 }
    }

    pub(super) fn process(&mut self, l: &mut [f64], r: &mut [f64], from: usize, to: usize, p: &[f64]) {
        let aa = coef(p[2], self.fs);
        let ar = coef(p[3], self.fs);
        let ratio = p[1].max(1.0);
        let knee = p[4].max(0.0);
        let t = p[0];
        let makeup = or0(p[5]);
        let mut gs = self.gs;
        for i in from..to {
            let lev = l[i].abs().max(r[i].abs());
            let x = level_db(lev);
            let gc = compress_curve(x, t, ratio, knee) - x;
            gs = if gc < gs { aa * gs + (1.0 - aa) * gc } else { ar * gs + (1.0 - ar) * gc };
            let g = 10f64.powf((gs + makeup) / 20.0);
            l[i] *= g;
            r[i] *= g;
        }
        self.gs = if gs.abs() < 1e-12 { 0.0 } else { gs };
    }
}

const TP_HALF: usize = 8;
const TP_W: usize = 2 * TP_HALF;

/// 4x interpolation rows between two samples (phases 1/4, 1/2, 3/4), Kaiser-windowed sinc normalized to unit sum.
fn tp_rows() -> &'static [[f64; TP_W]; 3] {
    static ROWS: std::sync::OnceLock<[[f64; TP_W]; 3]> = std::sync::OnceLock::new();
    ROWS.get_or_init(|| {
        let bessel = |x: f64| {
            let (mut s, mut t) = (1.0, 1.0);
            let q = x * x / 4.0;
            for k in 1..40 {
                let k = f64::from(k);
                t *= q / (k * k);
                s += t;
            }
            s
        };
        let beta = 6.0;
        let i0b = bessel(beta);
        [0.25, 0.5, 0.75].map(|ph: f64| {
            let mut row = [0.0; TP_W];
            let mut sum = 0.0;
            for (t, v) in row.iter_mut().enumerate() {
                let x = t as f64 - (TP_HALF as f64 - 1.0) - ph;
                let u = x / TP_HALF as f64;
                let w = if u.abs() >= 1.0 { 0.0 } else { bessel(beta * (1.0 - u * u).sqrt()) / i0b };
                *v = (if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) }) * w;
                sum += *v;
            }
            for v in &mut row {
                *v /= sum;
            }
            row
        })
    })
}

fn look_samples(fs: f64) -> usize {
    (js_round(LOOKAHEAD_MS * fs / 1000.0) as usize).max(1)
}

pub(super) fn limiter_latency(fs: f64) -> usize {
    look_samples(fs) + TP_HALF
}

pub(super) fn limiter_memory(p: &[f64]) -> f64 {
    (6.0 * or0(p[1]) / 1000.0 + LOOKAHEAD_MS / 1000.0).min(MAX_MEMORY)
}

/// ceiling, release, truePeak. Ring buffers of the input and of the gain each sample needs.
#[derive(Debug, Clone)]
pub struct Limiter {
    fs: f64,
    look: usize,
    xl: Vec<f64>,
    xr: Vec<f64>,
    xm: i64,
    hr: Vec<f64>,
    hm: i64,
    n: i64,
    g: f64,
    ip: f64,
    low: f64,
}

impl Limiter {
    pub(super) fn new(fs: f64) -> Self {
        let look = look_samples(fs);
        let h = (4 * TP_HALF + look + 2).next_power_of_two();
        let m = (look + 2).next_power_of_two();
        Self {
            fs,
            look,
            xl: vec![0.0; h],
            xr: vec![0.0; h],
            xm: h as i64 - 1,
            hr: vec![1.0; m],
            hm: m as i64 - 1,
            n: 0,
            g: 1.0,
            ip: 0.0,
            low: f64::NEG_INFINITY,
        }
    }

    /// The largest of the 4x points between samples m and m + 1 (ring indexes wrap by the mask, negatives too).
    fn between(arr: &[f64], xm: i64, m: i64) -> f64 {
        let base = m - (TP_HALF as i64 - 1);
        let mut worst = 0f64;
        for row in tp_rows() {
            let mut v = 0.0;
            for (t, w) in row.iter().enumerate() {
                v += w * arr[((base + t as i64) & xm) as usize];
            }
            let v = v.abs();
            if v > worst {
                worst = v;
            }
        }
        worst
    }

    pub(super) fn process(&mut self, l: &mut [f64], r: &mut [f64], from: usize, to: usize, p: &[f64]) {
        let (look, xm, hm) = (self.look as i64, self.xm, self.hm);
        let d_lat = look + TP_HALF as i64;
        let c = db_to_gain(p[0]);
        let beta = coef(p[1], self.fs);
        let tp = p[2] != 0.0;
        let (mut g, mut n, mut ip, mut low) = (self.g, self.n, self.ip, self.low);
        for i in from..to {
            self.xl[(n & xm) as usize] = l[i];
            self.xr[(n & xm) as usize] = r[i];
            let q = n - TP_HALF as i64;
            let mut peak = self.xl[(q & xm) as usize].abs().max(self.xr[(q & xm) as usize].abs());
            if tp {
                let next = Self::between(&self.xl, xm, q).max(Self::between(&self.xr, xm, q));
                if ip > peak {
                    peak = ip;
                }
                if next > peak {
                    peak = next;
                }
                ip = next;
            }
            let rq = if peak > c { c / peak } else { 1.0 };
            self.hr[(q & hm) as usize] = rq;
            if rq < 1.0 {
                low = q as f64;
            }
            let d = n - d_lat;
            let mut want = g + (1.0 - g) * (1.0 - beta);
            if low >= d as f64 {
                for k in 0..=look {
                    let rk = self.hr[((d + k) & hm) as usize];
                    if rk < 1.0 {
                        let v = rk + ((1.0 - rk) * k as f64) / (look + 1) as f64;
                        if v < want {
                            want = v;
                        }
                    }
                }
            }
            g = want;
            let yl = (self.xl[(d & xm) as usize] * g).min(c).max(-c);
            let yr = (self.xr[(d & xm) as usize] * g).min(c).max(-c);
            l[i] = yl;
            r[i] = yr;
            n += 1;
        }
        (self.g, self.n, self.ip, self.low) = (g, n, ip, low);
    }
}

const GATE_FOLLOW_MS: f64 = 5.0;

pub(super) fn gate_memory(p: &[f64]) -> f64 {
    ((or0(p[2]) + 6.0 * (or0(p[1]) + or0(p[3])) + 6.0 * GATE_FOLLOW_MS) / 1000.0).min(MAX_MEMORY)
}

/// threshold, attack, hold, release, range. Starts closed.
#[derive(Debug, Clone)]
pub struct Gate {
    fs: f64,
    env: f64,
    hold: i64,
    g: f64,
}

impl Gate {
    pub(super) fn new(fs: f64) -> Self {
        Self { fs, env: 0.0, hold: 0, g: -1.0 }
    }

    pub(super) fn process(&mut self, l: &mut [f64], r: &mut [f64], from: usize, to: usize, p: &[f64]) {
        let fs = self.fs;
        let thr = db_to_gain(p[0]);
        let floor = db_to_gain(-p[4].abs());
        let aa = coef(p[1], fs);
        let ar = coef(p[3], fs);
        let fall = coef(GATE_FOLLOW_MS, fs);
        let hold_n = js_round(or0(p[2]) * fs / 1000.0) as i64;
        let (mut env, mut hold, mut g) = (self.env, self.hold, self.g);
        if g < 0.0 {
            g = floor;
        }
        for i in from..to {
            let lev = l[i].abs().max(r[i].abs());
            env = if lev > env { lev } else { env * fall };
            let target = if env >= thr {
                hold = hold_n;
                1.0
            } else if hold > 0 {
                hold -= 1;
                1.0
            } else {
                floor
            };
            g = if target > g { target + (g - target) * aa } else { target + (g - target) * ar };
            l[i] *= g;
            r[i] *= g;
        }
        self.env = if env < 1e-30 { 0.0 } else { env };
        self.hold = hold;
        self.g = g;
    }
}
