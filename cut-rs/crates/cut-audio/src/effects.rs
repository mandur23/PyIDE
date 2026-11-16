//! The audio part of the effect registry (`effects.js`): the clip audio effects, their parameters and defaults, how
//! stored parameters resolve against them, and the gain effects' curves. Processors (`dsp`) are in [`crate::fx`].
//!
//! A resolved parameter set is a list of numbers in the registry's parameter order: a switch is 0 or 1, a choice the
//! number its id names (`'24'` is 24, a fade's `power` curve 1 and `linear` 0).

use serde_json::Value as Json;

use crate::fx::Dsp;

/// What a parameter is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ParamKind {
    Number {
        min: f64,
        max: f64,
    },
    Bool,
    /// The choice ids and the numbers they stand for.
    Choice(&'static [(&'static str, f64)]),
}

/// One parameter of an effect: its id, kind, default (as a number) and whether keyframes move it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Param {
    pub id: &'static str,
    pub kind: ParamKind,
    pub default: f64,
    pub keyframable: bool,
}

/// What an audio effect does to the sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `audio.gain`: a gain in dB.
    Gain,
    /// `audio.fade`: fade in and out over the clip, linear or constant power.
    Fade,
    /// A processor of `audiofx`.
    Dsp(Dsp),
}

/// An audio effect of the registry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioEffect {
    pub kind: &'static str,
    pub action: Action,
    pub params: &'static [Param],
}

const fn num(id: &'static str, default: f64, min: f64, max: f64) -> Param {
    Param { id, kind: ParamKind::Number { min, max }, default, keyframable: true }
}
const fn flag(id: &'static str, default: bool) -> Param {
    Param { id, kind: ParamKind::Bool, default: if default { 1.0 } else { 0.0 }, keyframable: false }
}
const fn choice(id: &'static str, default: f64, choices: &'static [(&'static str, f64)]) -> Param {
    Param { id, kind: ParamKind::Choice(choices), default, keyframable: false }
}

const SLOPES: &[(&str, f64)] = &[("12", 12.0), ("24", 24.0), ("48", 48.0)];

const GAIN: &[Param] = &[num("gain", 0.0, -96.0, 24.0)];
const FADE: &[Param] = &[
    num("fadeIn", 1.0, 0.0, 60.0),
    num("fadeOut", 1.0, 0.0, 60.0),
    choice("curve", 1.0, &[("power", 1.0), ("linear", 0.0)]),
];
/// Indexes into the equalizer's parameters.
pub mod eq {
    pub const HP_ON: usize = 0;
    pub const HP_FREQ: usize = 1;
    pub const HP_SLOPE: usize = 2;
    pub const LS_ON: usize = 3;
    pub const LS_FREQ: usize = 4;
    pub const LS_GAIN: usize = 5;
    /// Band b (0, 1, 2) starts at `BAND + 4 * b`: on, frequency, gain, Q.
    pub const BAND: usize = 6;
    pub const HS_ON: usize = 18;
    pub const HS_FREQ: usize = 19;
    pub const HS_GAIN: usize = 20;
    pub const LP_ON: usize = 21;
    pub const LP_FREQ: usize = 22;
    pub const LP_SLOPE: usize = 23;
    pub const OUTPUT: usize = 24;
}
const EQ: &[Param] = &[
    flag("hpOn", false),
    num("hpFreq", 80.0, 20.0, 20000.0),
    choice("hpSlope", 12.0, SLOPES),
    flag("lsOn", true),
    num("lsFreq", 100.0, 20.0, 20000.0),
    num("lsGain", 0.0, -24.0, 24.0),
    flag("b1On", true),
    num("b1Freq", 250.0, 20.0, 20000.0),
    num("b1Gain", 0.0, -24.0, 24.0),
    num("b1Q", 1.0, 0.1, 30.0),
    flag("b2On", true),
    num("b2Freq", 1000.0, 20.0, 20000.0),
    num("b2Gain", 0.0, -24.0, 24.0),
    num("b2Q", 1.0, 0.1, 30.0),
    flag("b3On", true),
    num("b3Freq", 4000.0, 20.0, 20000.0),
    num("b3Gain", 0.0, -24.0, 24.0),
    num("b3Q", 1.0, 0.1, 30.0),
    flag("hsOn", true),
    num("hsFreq", 8000.0, 20.0, 20000.0),
    num("hsGain", 0.0, -24.0, 24.0),
    flag("lpOn", false),
    num("lpFreq", 16000.0, 20.0, 20000.0),
    choice("lpSlope", 12.0, SLOPES),
    num("output", 0.0, -24.0, 24.0),
];
const BOOST: &[Param] = &[num("boost", 0.0, -24.0, 24.0)];
/// threshold, ratio, attack, release, knee, makeup.
const COMPRESSOR: &[Param] = &[
    num("threshold", -20.0, -60.0, 0.0),
    num("ratio", 4.0, 1.0, 20.0),
    num("attack", 10.0, 0.1, 200.0),
    num("release", 100.0, 5.0, 2000.0),
    num("knee", 6.0, 0.0, 24.0),
    num("makeup", 0.0, 0.0, 24.0),
];
/// ceiling, release, truePeak.
const LIMITER: &[Param] =
    &[num("ceiling", -1.0, -24.0, 0.0), num("release", 50.0, 1.0, 1000.0), flag("truePeak", false)];
/// threshold, attack, hold, release, range.
const GATE: &[Param] = &[
    num("threshold", -50.0, -90.0, 0.0),
    num("attack", 2.0, 0.1, 100.0),
    num("hold", 50.0, 0.0, 1000.0),
    num("release", 100.0, 5.0, 2000.0),
    num("range", 40.0, 0.0, 90.0),
];
/// frequency, harmonics, reduction, Q.
const DEHUM: &[Param] = &[
    choice("frequency", 60.0, &[("50", 50.0), ("60", 60.0)]),
    Param { id: "harmonics", kind: ParamKind::Number { min: 1.0, max: 10.0 }, default: 4.0, keyframable: false },
    num("reduction", 30.0, 0.0, 60.0),
    num("Q", 20.0, 4.0, 100.0),
];

/// The audio effects, in the registry's order.
pub const AUDIO_EFFECTS: &[AudioEffect] = &[
    AudioEffect { kind: "audio.gain", action: Action::Gain, params: GAIN },
    AudioEffect { kind: "audio.fade", action: Action::Fade, params: FADE },
    AudioEffect { kind: "audio.eq", action: Action::Dsp(Dsp::Eq), params: EQ },
    AudioEffect { kind: "audio.bass", action: Action::Dsp(Dsp::Bass), params: BOOST },
    AudioEffect { kind: "audio.treble", action: Action::Dsp(Dsp::Treble), params: BOOST },
    AudioEffect { kind: "audio.compressor", action: Action::Dsp(Dsp::Compressor), params: COMPRESSOR },
    AudioEffect { kind: "audio.limiter", action: Action::Dsp(Dsp::Limiter), params: LIMITER },
    AudioEffect { kind: "audio.gate", action: Action::Dsp(Dsp::Gate), params: GATE },
    AudioEffect { kind: "audio.dehum", action: Action::Dsp(Dsp::Dehum), params: DEHUM },
];

/// The audio effect of a type, or `None` (a video effect, or an unknown type).
pub fn get(kind: &str) -> Option<&'static AudioEffect> {
    AUDIO_EFFECTS.iter().find(|e| e.kind == kind)
}

impl AudioEffect {
    /// The registry's defaults.
    pub fn defaults(&self) -> Vec<f64> {
        self.params.iter().map(|p| p.default).collect()
    }

    /// Stored parameters resolved: the defaults under them, numbers clamped to their range, switches made booleans,
    /// choices that are not one of the ids replaced by the default (`effects.resolve`).
    pub fn resolve(&self, stored: &serde_json::Map<String, Json>) -> Vec<f64> {
        self.params
            .iter()
            .map(|p| match (stored.get(p.id), p.kind) {
                (None | Some(Json::Null), _) => p.default,
                (Some(Json::Number(n)), ParamKind::Number { min, max }) => {
                    n.as_f64().filter(|v| v.is_finite()).map_or(p.default, |v| v.min(max).max(min))
                }
                (Some(_), ParamKind::Number { .. }) => p.default,
                (Some(v), ParamKind::Bool) => f64::from(u8::from(truthy(v))),
                (Some(Json::String(s)), ParamKind::Choice(list)) => {
                    list.iter().find(|(id, _)| id == s).map_or(p.default, |&(_, v)| v)
                }
                (Some(_), ParamKind::Choice(_)) => p.default,
            })
            .collect()
    }

    /// The parameter's index by id.
    pub fn index(&self, id: &str) -> Option<usize> {
        self.params.iter().position(|p| p.id == id)
    }

    /// The linear gain of a gain effect at `t` seconds into a clip of `length` seconds (1 for a processor).
    pub fn gain(&self, p: &[f64], t: f64, length: f64) -> f64 {
        match self.action {
            Action::Gain => 10f64.powf(p[0] / 20.0),
            Action::Fade => {
                let (fade_in, fade_out, power) = (p[0], p[1], p[2] == 1.0);
                let mut g = 1.0;
                if fade_in > 0.0 && t < fade_in {
                    g *= (t / fade_in).clamp(0.0, 1.0);
                }
                if fade_out > 0.0 && t > length - fade_out {
                    g *= ((length - t) / fade_out).clamp(0.0, 1.0);
                }
                if power { (g * std::f64::consts::PI / 2.0).sin() } else { g }
            }
            Action::Dsp(_) => 1.0,
        }
    }
}

/// JavaScript's `!!v` of a JSON value.
fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Json::String(s) => !s.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}

/// `[outgoing, incoming]` gains of an audio transition of type `kind`, `progress` of the way through: the registry's
/// `crossfade.power`, else the engine's own constant power (the same curve, its product taken in another order).
pub fn transition_gains(kind: &str, progress: f64) -> [f64; 2] {
    use std::f64::consts::PI;
    if kind == "crossfade.power" {
        let u = progress.clamp(0.0, 1.0);
        [(u * PI / 2.0).cos(), (u * PI / 2.0).sin()]
    } else {
        [((PI / 2.0) * progress).cos(), ((PI / 2.0) * progress).sin()]
    }
}
