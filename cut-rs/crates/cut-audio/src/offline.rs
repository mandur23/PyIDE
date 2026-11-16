//! The mix of a range in one go (`renderOffline`) or streamed through a loudness meter (`measure`).

use cut_model::{Id, Project};
use cut_time::TICKS;

use crate::loudness::{Loudness, Meter};
use crate::mixer::Mixer;
use crate::util::js_round;

/// The mix of `[from, to)` (sequence ticks) as two channels at the mixer's rate, mixed a second at a time.
pub fn render(mixer: &mut Mixer, project: &Project, seq_id: Id, from: i64, to: i64, master_gain: f64) -> [Vec<f32>; 2] {
    let rate = f64::from(mixer.rate());
    let tps = TICKS as f64 / rate;
    let s0 = js_round(from as f64 / tps) as i64;
    let total = (js_round(to as f64 / tps) as i64 - s0).max(0) as usize;
    let mut out = [Vec::with_capacity(total), Vec::with_capacity(total)];
    let step = 48000;
    let mut i = 0;
    while i < total {
        let n = step.min(total - i);
        let m = mixer.mix_loaded(project, seq_id, s0 + i as i64, n, master_gain);
        let [l, r] = m.out;
        out[0].extend_from_slice(&l);
        out[1].extend_from_slice(&r);
        i += n;
    }
    out
}

/// The loudness of the mix of `[from, to)` without holding it; `progress(fraction)` after each second, and `false`
/// from it stops (`None`).
pub fn measure(
    mixer: &mut Mixer,
    project: &Project,
    seq_id: Id,
    from: i64,
    to: i64,
    master_gain: f64,
    mut progress: impl FnMut(f64) -> bool,
) -> Option<Loudness> {
    let rate = f64::from(mixer.rate());
    let tps = TICKS as f64 / rate;
    let s0 = js_round(from as f64 / tps) as i64;
    let total = (js_round(to as f64 / tps) as i64 - s0).max(0) as usize;
    let mut meter = Meter::new(rate, 2);
    let step = rate as usize;
    let mut i = 0;
    while i < total {
        let m = mixer.mix_loaded(project, seq_id, s0 + i as i64, step.min(total - i), master_gain);
        meter.push(&[&m.out[0], &m.out[1]]);
        if !progress(((i + step) as f64 / total as f64).min(1.0)) {
            return None;
        }
        i += step;
    }
    Some(meter.result())
}
