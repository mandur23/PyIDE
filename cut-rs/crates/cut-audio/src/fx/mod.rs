//! The clip audio effects' signal processing (`audiofx.js`): RBJ cookbook biquads (the parametric equalizer, bass,
//! treble, the hum notches), a feed-forward compressor, a look-ahead limiter and a noise gate, and the chain that runs
//! a clip's effects in order. Plain double arithmetic, no clock: a processor keeps its state between calls, so any
//! split of a signal into calls gives the same samples.

mod dynamics;
mod filters;

pub use dynamics::compress_curve;
pub use filters::{BUTTERWORTH, Filter, FilterType, design, filters_of, magnitude_db, response, ring_samples};

use crate::effects::{Action, AudioEffect};

/// Samples between parameter reads: keyframes move parameters at this rate.
pub const CONTROL: usize = 32;
/// Seconds: the longest warm-up the mixer runs before a segment.
pub const MAX_MEMORY: f64 = 4.0;
pub const BASS_HZ: f64 = 200.0;
pub const TREBLE_HZ: f64 = 4000.0;
pub const LOOKAHEAD_MS: f64 = 1.5;

/// A processor of the registry's `dsp` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dsp {
    Eq,
    Bass,
    Treble,
    Dehum,
    Compressor,
    Limiter,
    Gate,
}

/// A processor's state between calls.
#[derive(Debug, Clone)]
pub enum State {
    Filters(filters::Bank),
    Compressor(dynamics::Compressor),
    Limiter(Box<dynamics::Limiter>),
    Gate(dynamics::Gate),
}

impl Dsp {
    /// The `dsp` name of the registry (`eq`, `compressor` ...).
    pub fn of(name: &str) -> Option<Self> {
        Some(match name {
            "eq" => Self::Eq,
            "bass" => Self::Bass,
            "treble" => Self::Treble,
            "dehum" => Self::Dehum,
            "compressor" => Self::Compressor,
            "limiter" => Self::Limiter,
            "gate" => Self::Gate,
            _ => return None,
        })
    }

    /// Samples the processor delays the signal by.
    pub fn latency(self, fs: f64) -> usize {
        match self {
            Self::Limiter => dynamics::limiter_latency(fs),
            _ => 0,
        }
    }

    /// Seconds of input after which the state no longer depends on what came before (within about -100 dB).
    pub fn memory(self, p: &[f64], fs: f64) -> f64 {
        match self {
            Self::Eq | Self::Bass | Self::Treble | Self::Dehum => filters::memory(self, p, fs),
            Self::Compressor => dynamics::compressor_memory(p),
            Self::Limiter => dynamics::limiter_memory(p),
            Self::Gate => dynamics::gate_memory(p),
        }
    }

    /// A fresh state.
    pub fn create(self, fs: f64) -> State {
        match self {
            Self::Eq | Self::Bass | Self::Treble | Self::Dehum => State::Filters(filters::Bank::new(fs)),
            Self::Compressor => State::Compressor(dynamics::Compressor::new(fs)),
            Self::Limiter => State::Limiter(Box::new(dynamics::Limiter::new(fs))),
            Self::Gate => State::Gate(dynamics::Gate::new(fs)),
        }
    }

    /// Processes samples `[from, to)` of both channels in place with parameters `p`.
    pub fn process(self, st: &mut State, l: &mut [f64], r: &mut [f64], from: usize, to: usize, p: &[f64]) {
        match st {
            State::Filters(b) => b.process(self, l, r, from, to, p),
            State::Compressor(c) => c.process(l, r, from, to, p),
            State::Limiter(m) => m.process(l, r, from, to, p),
            State::Gate(g) => g.process(l, r, from, to, p),
        }
    }
}

/// A stage of a chain: a processor, or a gain effect (`audio.gain`, `audio.fade`) with the clip's length in seconds.
#[derive(Debug, Clone, Copy)]
pub enum Stage {
    Proc(Dsp),
    Gain { effect: &'static AudioEffect, length: f64 },
}

impl Stage {
    /// The stage an effect is, `None` for one that does nothing to the sound.
    pub fn of(effect: &'static AudioEffect, length: f64) -> Self {
        match effect.action {
            Action::Dsp(d) => Self::Proc(d),
            Action::Gain | Action::Fade => Self::Gain { effect, length },
        }
    }
}

/// Stages run in order over two channels (`audiofx.createChain`), a [`CONTROL`]-sample block at a time.
pub struct Chain {
    stages: Vec<Stage>,
    states: Vec<Option<State>>,
    delays: Vec<usize>,
    /// Samples the output is late by: the processors' latencies summed.
    pub latency: usize,
}

impl Chain {
    pub fn new(stages: Vec<Stage>, fs: f64) -> Self {
        let mut delays = Vec::with_capacity(stages.len());
        let mut latency = 0;
        for s in &stages {
            delays.push(latency);
            if let Stage::Proc(d) = s {
                latency += d.latency(fs);
            }
        }
        let states = stages.iter().map(|s| if let Stage::Proc(d) = s { Some(d.create(fs)) } else { None }).collect();
        Self { stages, states, delays, latency }
    }

    /// Processes samples `[0, n)` in place. `params_at(k, i)` gives stage k's parameters at processing index i (moved
    /// back by the latency of the stages before it, so a keyframe stays on its sound); `seconds_at(i)` the clip time a
    /// gain stage reads. The output at index i is the input at i - latency.
    pub fn process<'p>(
        &mut self,
        l: &mut [f64],
        r: &mut [f64],
        n: usize,
        mut params_at: impl FnMut(usize, i64) -> std::borrow::Cow<'p, [f64]>,
        seconds_at: impl Fn(i64) -> f64,
    ) {
        for q in (0..n).step_by(CONTROL) {
            let e = n.min(q + CONTROL);
            for k in 0..self.stages.len() {
                let i0 = q as i64 - self.delays[k] as i64;
                match self.stages[k] {
                    Stage::Proc(d) => {
                        let p = params_at(k, i0);
                        d.process(self.states[k].as_mut().expect("a processor has a state"), l, r, q, e, &p);
                    }
                    Stage::Gain { effect, length } => {
                        let c = CONTROL as i64;
                        let g0 = effect.gain(&params_at(k, i0), seconds_at(i0), length);
                        let g1 = effect.gain(&params_at(k, i0 + c), seconds_at(i0 + c), length);
                        if g0 == 1.0 && g1 == 1.0 {
                            continue;
                        }
                        for i in q..e {
                            let g = g0 + (g1 - g0) * (i - q) as f64 / CONTROL as f64;
                            l[i] *= g;
                            r[i] *= g;
                        }
                    }
                }
            }
        }
    }
}

/// One processor with fixed parameters over whole channels, the latency taken out; `blocks` the call sizes to use in
/// turn (default [`CONTROL`]). For tests and for measuring a curve.
pub fn process_buffer(
    dsp: Dsp,
    params: &[f64],
    l: &[f64],
    r: &[f64],
    fs: f64,
    blocks: Option<&[usize]>,
) -> [Vec<f64>; 2] {
    let lat = dsp.latency(fs);
    let n = l.len();
    let total = n + lat;
    let mut lo = vec![0.0; total];
    let mut ro = vec![0.0; total];
    lo[..n].copy_from_slice(l);
    ro[..r.len().min(n)].copy_from_slice(&r[..r.len().min(n)]);
    let mut st = dsp.create(fs);
    let (mut at, mut b) = (0, 0);
    while at < total {
        let len = blocks.map_or(CONTROL, |bl| bl[b % bl.len()].max(1));
        b += 1;
        let e = total.min(at + len);
        dsp.process(&mut st, &mut lo, &mut ro, at, e, params);
        at = e;
    }
    [lo.split_off(lat), ro.split_off(lat)]
}
