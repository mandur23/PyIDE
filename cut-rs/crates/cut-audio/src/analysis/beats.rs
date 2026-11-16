//! Onsets, tempo and beats (`analyze.js` `createFft`, `createFlux`, `onsetStrength`, `tempo`, `trackBeats`,
//! `barPhase`, `beats`): spectral flux, its autocorrelation for the tempo, and a dynamic-programming beat tracker
//! (Ellis 2007); the bar phase is the one whose beats carry the most onset strength. Values the JavaScript keeps in a
//! `Float32Array` (the envelope, the strength) are rounded to `f32` where it stores them.

use crate::util::js_round;

/// An in-place radix-2 FFT of `n` points (`createFft`), its tables made once.
pub struct Fft {
    rev: Vec<u32>,
    cos: Vec<f64>,
    sin: Vec<f64>,
}

impl Fft {
    /// `None` unless `n` is a power of two.
    pub fn new(n: usize) -> Option<Fft> {
        if !n.is_power_of_two() || n > u32::MAX as usize {
            return None;
        }
        let levels = n.trailing_zeros();
        let rev = (0..n as u32).map(|i| if levels == 0 { 0 } else { i.reverse_bits() >> (32 - levels) }).collect();
        let angle = |i: usize| (2.0 * std::f64::consts::PI * i as f64) / n as f64;
        let cos = (0..n / 2).map(|i| angle(i).cos()).collect();
        let sin = (0..n / 2).map(|i| -angle(i).sin()).collect();
        Some(Fft { rev, cos, sin })
    }

    /// Transforms `re` and `im` (both `n` long) in place.
    pub fn run(&self, re: &mut [f64], im: &mut [f64]) {
        let n = self.rev.len();
        for i in 0..n {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            for i in (0..n).step_by(size) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (i + k, i + k + half);
                    let xr = re[b] * wr - im[b] * wi;
                    let xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr;
                    im[b] = im[a] - xi;
                    re[a] += xr;
                    im[a] += xi;
                }
            }
            size *= 2;
        }
    }
}

/// `Math.hypot(x, y)` as V8 computes it (scaled by the larger, Kahan-summed), so magnitudes round as the
/// JavaScript's do.
fn js_hypot(x: f64, y: f64) -> f64 {
    let (a, b) = (x.abs(), y.abs());
    if a.is_infinite() || b.is_infinite() {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = if b > a { b } else { a };
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}

/// Streams mono samples into a spectral flux envelope (`createFlux`): frames of `size` samples every `hop`, Hann
/// window, log magnitude, the sum of each bin's rise since the frame before. Frame i is centred on sample
/// `i * hop + size / 2`.
pub struct Flux {
    pub size: usize,
    pub hop: usize,
    pub rate: f64,
    fft: Fft,
    win: Vec<f64>,
    re: Vec<f64>,
    im: Vec<f64>,
    mag: Vec<f64>,
    prev: Option<Vec<f64>>,
    buf: Vec<f32>,
    have: usize,
    env: Vec<f32>,
}

impl Flux {
    /// `None` unless `size` is a power of two; `hop` is kept within `1..=size`.
    pub fn new(rate: f64, size: usize, hop: usize) -> Option<Flux> {
        let fft = Fft::new(size)?;
        let win =
            (0..size).map(|i| 0.5 - 0.5 * ((2.0 * std::f64::consts::PI * i as f64) / size as f64).cos()).collect();
        Some(Flux {
            size,
            hop: hop.clamp(1, size),
            rate,
            fft,
            win,
            re: vec![0.0; size],
            im: vec![0.0; size],
            mag: vec![0.0; size / 2 + 1],
            prev: None,
            buf: vec![0.0; size],
            have: 0,
            env: Vec::new(),
        })
    }

    /// Seconds a hop.
    pub fn hop_seconds(&self) -> f64 {
        self.hop as f64 / self.rate
    }

    /// The time (seconds) of envelope frame `i` (fractional frames too).
    pub fn time_of(&self, i: f64) -> f64 {
        (i * self.hop as f64 + self.size as f64 / 2.0) / self.rate
    }

    fn frame(&mut self) {
        let size = self.size;
        for i in 0..size {
            self.re[i] = f64::from(self.buf[i]) * self.win[i];
            self.im[i] = 0.0;
        }
        self.fft.run(&mut self.re, &mut self.im);
        for k in 0..self.mag.len() {
            self.mag[k] = (1000.0 * js_hypot(self.re[k], self.im[k]) / size as f64).ln_1p();
        }
        let mut flux = 0.0;
        if let Some(prev) = &self.prev {
            for (m, p) in self.mag.iter().zip(prev) {
                let d = m - p;
                if d > 0.0 {
                    flux += d;
                }
            }
        }
        match &mut self.prev {
            Some(p) => p.copy_from_slice(&self.mag),
            None => self.prev = Some(self.mag.clone()),
        }
        self.env.push(flux as f32);
        self.buf.copy_within(self.hop..size, 0);
        self.have = size - self.hop;
    }

    /// Adds samples; any block sizes give the same envelope.
    pub fn push(&mut self, mono: &[f32]) {
        let mut i = 0;
        while i < mono.len() {
            let take = (self.size - self.have).min(mono.len() - i);
            self.buf[self.have..self.have + take].copy_from_slice(&mono[i..i + take]);
            self.have += take;
            i += take;
            if self.have == self.size {
                self.frame();
            }
        }
    }

    /// The envelope so far.
    pub fn envelope(&self) -> &[f32] {
        &self.env
    }
}

/// The onset strength (`onsetStrength`): the envelope less its local mean over about `window_sec`, rectified and
/// scaled to unit deviation.
pub fn onset_strength(env: &[f32], hop_seconds: f64, window_sec: f64) -> Vec<f32> {
    let n = env.len() as i64;
    let w = (js_round(window_sec / hop_seconds / 2.0) as i64).max(1);
    let mut out = vec![0f32; env.len()];
    let mut sum = 0.0f64;
    let (mut lo, mut hi) = (0i64, -1i64);
    for i in 0..n {
        while hi < (n - 1).min(i + w) {
            hi += 1;
            sum += f64::from(env[hi as usize]);
        }
        while lo < i - w {
            sum -= f64::from(env[lo as usize]);
            lo += 1;
        }
        out[i as usize] = (f64::from(env[i as usize]) - sum / (hi - lo + 1) as f64).max(0.0) as f32;
    }
    let sq = out.iter().fold(0.0f64, |a, &v| a + f64::from(v) * f64::from(v));
    let sd = (sq / env.len().max(1) as f64).sqrt();
    let sd = if sd == 0.0 || sd.is_nan() { 1.0 } else { sd };
    for v in &mut out {
        *v = (f64::from(*v) / sd) as f32;
    }
    out
}

/// A tempo (`tempo`): beats a minute, the period in envelope frames and how sure (0..1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tempo {
    pub bpm: f64,
    pub period: f64,
    pub confidence: f64,
}

/// The tempo of an onset strength curve: the autocorrelation's best lag between `min` and `max` BPM, weighted
/// toward 120 BPM (one octave of spread) so a half or double tempo loses; the lag refined by a parabola.
pub fn tempo(strength: &[f32], hop_seconds: f64, min: f64, max: f64) -> Tempo {
    let n = strength.len() as i64;
    let lag_of = |bpm: f64| 60.0 / bpm / hop_seconds;
    let l0 = (lag_of(max).floor() as i64).max(1);
    let l1 = (n - 1).min(lag_of(min).ceil() as i64);
    if l1 <= l0 + 1 {
        return Tempo { bpm: 0.0, period: 0.0, confidence: 0.0 };
    }
    let s = |i: i64| f64::from(strength[i as usize]);
    let mut ac = vec![0.0f64; (l1 + 2) as usize];
    let zero = (0..n).fold(0.0, |a, i| a + s(i) * s(i));
    for l in l0 - 1..=l1 + 1 {
        let mut sum = 0.0;
        let mut i = 0;
        while i + l < n {
            sum += s(i) * s(i + l);
            i += 1;
        }
        // 0 / 0 at a lag of the whole curve, as the JavaScript's NaN
        ac[l as usize] = sum / (n - l) as f64;
    }
    let weight = |l: i64| (-0.5 * (60.0 / (l as f64 * hop_seconds) / 120.0).log2().powi(2)).exp();
    let (mut best, mut best_score) = (l0, f64::NEG_INFINITY);
    for l in l0..=l1 {
        let score = ac[l as usize] * weight(l);
        if score > best_score {
            best_score = score;
            best = l;
        }
    }
    let (y0, y1, y2) = (ac[(best - 1) as usize], ac[best as usize], ac[(best + 1) as usize]);
    let den = y0 - 2.0 * y1 + y2;
    let period = best as f64 + if den < 0.0 { ((0.5 * (y0 - y2)) / den).clamp(-0.5, 0.5) } else { 0.0 };
    let confidence = if zero > 0.0 { ((y1 * n as f64) / zero).clamp(0.0, 1.0) } else { 0.0 };
    Tempo { bpm: 60.0 / (period * hop_seconds), period, confidence }
}

/// Beat frames (`trackBeats`): the path through the strength curve that collects the most strength while its steps
/// stay near `period` frames (a log-ratio penalty times `tightness`), by dynamic programming traced back from the
/// best end; each beat moved to the strength peak within two frames and refined to a fraction of a frame.
pub fn track_beats(strength: &[f32], period: f64, tightness: f64) -> Vec<f64> {
    let n = strength.len() as i64;
    // NaN periods too
    if period.partial_cmp(&2.0).is_none_or(|o| o.is_lt()) || n < 2 {
        return Vec::new();
    }
    let st = |i: i64| if i >= 0 && i < n { f64::from(strength[i as usize]) } else { 0.0 };
    let mut score = vec![0.0f64; n as usize];
    let mut back = vec![-1i64; n as usize];
    let lo = js_round(period / 2.0) as i64;
    let hi = js_round(period * 2.0) as i64;
    for i in 0..n {
        let (mut best, mut arg) = (0.0f64, -1i64);
        for j in (i - hi).max(0)..=i - lo {
            let s = score[j as usize] - tightness * ((i - j) as f64 / period).ln().powi(2);
            if arg < 0 || s > best {
                best = s;
                arg = j;
            }
        }
        score[i as usize] = st(i) + if arg >= 0 { best.max(0.0) } else { 0.0 };
        back[i as usize] = if arg >= 0 && best > 0.0 { arg } else { -1 };
    }
    let from = (n - period.ceil() as i64).max(0);
    let mut end = from;
    for i in from..n {
        if score[i as usize] > score[end as usize] {
            end = i;
        }
    }
    let mut path = Vec::new();
    let mut i = end;
    while i >= 0 {
        path.push(i);
        i = back[i as usize];
    }
    path.reverse();
    path.into_iter()
        .map(|b| {
            let mut m = b;
            for k in (b - 2).max(0)..=(n - 1).min(b + 2) {
                if st(k) > st(m) {
                    m = k;
                }
            }
            let (y0, y1, y2) = (st(m - 1), st(m), st(m + 1));
            let den = y0 - 2.0 * y1 + y2;
            m as f64 + if den < 0.0 { ((0.5 * (y0 - y2)) / den).clamp(-0.5, 0.5) } else { 0.0 }
        })
        .collect()
}

/// Which of the `per` beat phases starts the bars (`barPhase`): the one whose beats carry the most strength.
pub fn bar_phase(strength: &[f32], beat_frames: &[f64], per: usize) -> usize {
    let per = per.max(1);
    let mut sums = vec![0.0f64; per];
    for (i, b) in beat_frames.iter().enumerate() {
        let k = js_round(*b);
        let v = if k >= 0.0 && (k as usize) < strength.len() { f64::from(strength[k as usize]) } else { 0.0 };
        sums[i % per] += if v.is_nan() { 0.0 } else { v };
    }
    let mut best = 0;
    for p in 1..per {
        if sums[p] > sums[best] {
            best = p;
        }
    }
    best
}

/// The beats of a piece of sound (`beats`).
#[derive(Debug, Clone, PartialEq)]
pub struct Beats {
    pub bpm: f64,
    /// Seconds from the start of what was analysed.
    pub beats: Vec<f64>,
    /// The index of the first downbeat (bars of four).
    pub phase: usize,
    pub confidence: f64,
}

/// The beats of a flux envelope with the JavaScript's defaults (60 to 200 BPM, tightness 100, bars of four); the
/// tempo given is the slope of the beats against their numbers, finer than one lag.
pub fn beats(flux: &Flux, env: &[f32]) -> Beats {
    let strength = onset_strength(env, flux.hop_seconds(), 0.5);
    let t = tempo(&strength, flux.hop_seconds(), 60.0, 200.0);
    let frames = track_beats(&strength, t.period, 100.0);
    let list: Vec<f64> = frames.iter().map(|&f| flux.time_of(f)).collect();
    let mut bpm = t.bpm;
    if list.len() >= 4 {
        let k = list.len() as f64;
        let mi = (k - 1.0) / 2.0;
        let mt = list.iter().fold(0.0, |a, b| a + b) / k;
        let (mut num, mut den) = (0.0, 0.0);
        for (i, x) in list.iter().enumerate() {
            num += (i as f64 - mi) * (x - mt);
            den += (i as f64 - mi).powi(2);
        }
        if num > 0.0 {
            bpm = 60.0 / (num / den);
        }
    }
    Beats { bpm, beats: list, phase: bar_phase(&strength, &frames, 4), confidence: t.confidence }
}
