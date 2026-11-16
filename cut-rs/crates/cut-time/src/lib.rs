//! Time in Nano Studio Cut: integer ticks, 254,016,000,000 a second, so every frame rate the editor offers (23.976,
//! 24, 25, 29.97, 30, 50, 59.94, 60) and the 44.1 and 48 kHz sample rates are whole numbers of ticks and edits never
//! drift by a frame.
//!
//! The port of `renderer/features/cut/time.js`. Project files hold ticks as JSON numbers, so a time stays below 2^53
//! ([`MAX_TICKS`], about 9.8 hours) and both editors read the same file. Every division here is exact integer
//! arithmetic; where the JavaScript rounds, this rounds the same way (`tests/oracle.rs` compares the two).

/// Ticks in one second.
pub const TICKS: i64 = 254_016_000_000;

/// The longest time a project file can hold exactly: the whole seconds below 2^53 ticks.
pub const MAX_TICKS: i64 = (((1_i64 << 53) - 1) / TICKS) * TICKS;

/// A time or a length in ticks.
pub type Ticks = i64;

/// A frame rate as a fraction, as 30000/1001 for 29.97.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Fps {
    pub num: u32,
    pub den: u32,
}

impl Fps {
    pub const fn new(num: u32, den: u32) -> Self {
        Self { num, den }
    }

    /// Frames a second.
    pub fn value(self) -> f64 {
        f64::from(self.num) / f64::from(self.den)
    }

    /// The whole rate timecode counts in: 30 for 29.97 (non-drop-frame).
    pub fn nominal(self) -> i64 {
        div_round_up_half(i128::from(self.num), i128::from(self.den)) as i64
    }

    /// One frame's length when it is a whole number of ticks, as it is for every rate in [`FRAME_RATES`].
    pub fn frame_ticks(self) -> Option<Ticks> {
        let n = i128::from(TICKS) * i128::from(self.den);
        let d = i128::from(self.num);
        (d != 0 && n % d == 0).then(|| (n / d) as Ticks)
    }
}

/// The rates the editor offers.
pub const FRAME_RATES: [Fps; 8] = [
    Fps::new(24000, 1001),
    Fps::new(24, 1),
    Fps::new(25, 1),
    Fps::new(30000, 1001),
    Fps::new(30, 1),
    Fps::new(50, 1),
    Fps::new(60000, 1001),
    Fps::new(60, 1),
];

/// `n / d` rounded half away from zero: truncation alone is wrong for the negative times of AAC priming and B-frame
/// delay.
fn div_round(n: i128, d: i128) -> i128 {
    debug_assert!(d > 0);
    if n < 0 { (n - d / 2) / d } else { (n + d / 2) / d }
}

/// `n / d` rounded half up, as JavaScript's `Math.round` does.
fn div_round_up_half(n: i128, d: i128) -> i128 {
    debug_assert!(d > 0);
    (2 * n + d).div_euclid(2 * d)
}

/// A container's timestamp in units of `1/scale` seconds -> ticks, to the nearest tick, without the overflow that
/// 90 kHz timestamps hit in 64 bits.
pub fn rescale(value: i64, scale: u64) -> Ticks {
    div_round(i128::from(value) * i128::from(TICKS), i128::from(scale)) as Ticks
}

/// Ticks -> a timestamp in units of `1/scale` seconds, rounded.
pub fn to_scale(ticks: Ticks, scale: u64) -> i64 {
    div_round(i128::from(ticks) * i128::from(scale), i128::from(TICKS)) as i64
}

pub fn from_seconds(seconds: f64) -> Ticks {
    // Math.round: half goes up, also below zero.
    (seconds * TICKS as f64 + 0.5).floor() as Ticks
}

pub fn to_seconds(ticks: Ticks) -> f64 {
    ticks as f64 / TICKS as f64
}

/// Microseconds (what hardware decoders and encoders stamp frames with) -> ticks.
pub fn from_micros(micros: i64) -> Ticks {
    rescale(micros, 1_000_000)
}

pub fn to_micros(ticks: Ticks) -> i64 {
    to_scale(ticks, 1_000_000)
}

/// The frame on screen at `t`; frames start at 0 at `t = 0`, and a time before 0 is in a negative frame.
pub fn frame_at(t: Ticks, fps: Fps) -> i64 {
    let n = i128::from(t) * i128::from(fps.num);
    let d = i128::from(TICKS) * i128::from(fps.den);
    n.div_euclid(d) as i64
}

/// Where a frame starts.
pub fn frame_start(frame: i64, fps: Fps) -> Ticks {
    div_round_up_half(i128::from(frame) * i128::from(TICKS) * i128::from(fps.den), i128::from(fps.num)) as Ticks
}

/// `t` moved to the start of its frame, or with `nearest` to the closer frame boundary (the later one when `t` is
/// exactly between two).
pub fn snap(t: Ticks, fps: Fps, nearest: bool) -> Ticks {
    let q = frame_at(t, fps);
    let start = frame_start(q, fps);
    if !nearest {
        return start;
    }
    let next = frame_start(q + 1, fps);
    if 2 * (i128::from(t) - i128::from(start)) >= i128::from(next) - i128::from(start) { next } else { start }
}

/// `HH:MM:SS:FF` in whole frames of the nominal rate.
pub fn timecode(t: Ticks, fps: Fps) -> String {
    let nominal = fps.nominal().max(1);
    let frames = frame_at(t.abs(), fps).abs();
    let (ff, secs) = (frames % nominal, frames / nominal);
    let sign = if t < 0 { "-" } else { "" };
    format!("{sign}{:02}:{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60, ff)
}

/// Reads `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF`, a frame count, or `+N` / `-N` frames from `from` (never before 0).
/// The separators may be `:`, `;` or `.`.
pub fn parse_timecode(text: &str, fps: Fps, from: Ticks) -> Option<Ticks> {
    let s = text.trim();
    if let Some(rest) = s.strip_prefix(['+', '-']) {
        let digits = rest.trim_start();
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            let step = frame_start(digits.parse().ok()?, fps);
            return Some((if s.starts_with('-') { from - step } else { from + step }).max(0));
        }
    }
    let parts: Vec<i64> = s
        .split([':', ';', '.'])
        .map(|p| if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) { p.parse().ok() } else { None })
        .collect::<Option<_>>()?;
    match parts[..] {
        [frames] => Some(frame_start(frames, fps)),
        [.., _] if parts.len() <= 4 => {
            let mut hmsf = [0_i64; 4];
            hmsf[4 - parts.len()..].copy_from_slice(&parts);
            let [h, m, sec, ff] = hmsf;
            Some(frame_start(((h * 60 + m) * 60 + sec) * fps.nominal() + ff, fps))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NTSC: Fps = Fps::new(30000, 1001);

    #[test]
    fn every_offered_rate_and_sample_rate_is_whole_ticks() {
        for fps in FRAME_RATES {
            assert!(fps.frame_ticks().is_some(), "{fps:?}");
        }
        assert_eq!(TICKS % 44_100, 0);
        assert_eq!(TICKS % 48_000, 0);
        assert_eq!(MAX_TICKS, 9_007_153_344_000_000);
    }

    #[test]
    fn rescale_rounds_half_away_from_zero_on_both_sides() {
        assert_eq!(rescale(90_000, 90_000), TICKS);
        assert_eq!(rescale(-1024, 48_000), -1024 * (TICKS / 48_000));
        assert_eq!(to_scale(1, 2 * TICKS as u64), 2);
        assert_eq!(to_micros(TICKS / 2_000_000), 1);
        assert_eq!(to_micros(-(TICKS / 2_000_000)), -1);
        assert_eq!(from_micros(to_micros(TICKS * 3600)), TICKS * 3600);
    }

    #[test]
    fn frames_do_not_drift_near_the_longest_time() {
        let f = NTSC.frame_ticks().unwrap();
        let last = MAX_TICKS / f;
        assert_eq!(frame_at(last * f, NTSC), last);
        assert_eq!(frame_at(last * f - 1, NTSC), last - 1);
        assert_eq!(frame_start(last, NTSC), last * f);
        assert_eq!(frame_at(-1, NTSC), -1);
    }

    #[test]
    fn snap_goes_to_the_frame_start_or_the_closer_boundary() {
        let f = NTSC.frame_ticks().unwrap();
        assert_eq!(snap(5 * f + 7, NTSC, false), 5 * f);
        assert_eq!(snap(5 * f + f / 2 - 1, NTSC, true), 5 * f);
        assert_eq!(snap(5 * f + f / 2, NTSC, true), 6 * f);
    }

    #[test]
    fn timecode_counts_the_nominal_rate() {
        let f = NTSC.frame_ticks().unwrap();
        assert_eq!(timecode(0, NTSC), "00:00:00:00");
        assert_eq!(timecode(30 * f, NTSC), "00:00:01:00");
        assert_eq!(timecode(-(3600 * 30 + 29) * f, NTSC), "-01:00:00:29");
        assert_eq!(parse_timecode("00:00:01:00", NTSC, 0), Some(30 * f));
        assert_eq!(parse_timecode("1;00", NTSC, 0), Some(30 * f));
        assert_eq!(parse_timecode("45", NTSC, 0), Some(45 * f));
        assert_eq!(parse_timecode("+ 10", NTSC, 5 * f), Some(15 * f));
        assert_eq!(parse_timecode("-10", NTSC, 5 * f), Some(0));
        assert_eq!(parse_timecode("1:2:3:4:5", NTSC, 0), None);
        assert_eq!(parse_timecode("1:x", NTSC, 0), None);
        assert_eq!(parse_timecode("", NTSC, 0), None);
    }
}
