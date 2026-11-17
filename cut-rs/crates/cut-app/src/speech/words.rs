//! What is done with a window of 16 kHz mono samples around recognition (port of `main/cut/speech-words.js`):
//! Whisper's word times narrowed to the loud part of each word ([`refine`]), and the test backend that "hears" one
//! word per burst of sound ([`bursts`], [`fake_words`]), so the app's tests need no model.
//!
//! The levels are summed in `f64` from `f32` samples as the JavaScript sums them; results are compared with the
//! JavaScript's own functions in `tests/speech_oracle.rs`.

use crate::speech::text::js_round;

/// The sample rate the servers read.
pub const RATE: usize = 16000;
/// 10 ms.
const FRAME: usize = 160;

/// A word as a server gives it: seconds from the window's start, its text, whether it starts one of Whisper's
/// segments (`lead`), and how sure Whisper was (`p`).
#[derive(Debug, Clone, PartialEq)]
pub struct Heard {
    pub t0: f64,
    pub t1: f64,
    pub text: String,
    pub lead: bool,
    pub p: Option<f64>,
}

/// The level of each 10 ms frame in dBFS (a full-scale sine is -3), as `f32` like the JavaScript's `Float32Array`.
pub fn frame_db(samples: &[f32]) -> Vec<f32> {
    samples
        .as_chunks::<FRAME>()
        .0
        .iter()
        .map(|f| {
            let s: f64 = f.iter().map(|&x| f64::from(x) * f64::from(x)).sum();
            let ms = s / FRAME as f64;
            (if ms > 0.0 { (10.0 * ms.log10()).max(-200.0) } else { -200.0 }) as f32
        })
        .collect()
}

fn round3(x: f64) -> f64 {
    js_round(x * 1000.0) / 1000.0
}

/// Each word moved in to the sound of its span (never out, and only by more than 80 ms); `p` passes through. The
/// span's sound is split into runs at quiet gaps of 0.25 s or more: a word's sound is its longest run, except for the
/// first word of a segment (its start is put before the pause ahead of it), whose sound is its last run. A word with no
/// loud frame keeps its times.
pub fn refine(samples: &[f32], words: &[Heard]) -> Vec<Heard> {
    let (floor, below, slack, lead, tail, gap) = (-48.0, 38.0, 0.08, 0.02, 0.05, 0.25);
    let db = frame_db(samples);
    let peak = db.iter().fold(-200.0f64, |p, &v| p.max(f64::from(v)));
    let thr = f64::max(floor, peak - below);
    let step = FRAME as f64 / RATE as f64;
    let join = js_round(gap / step) as i64;
    words
        .iter()
        .map(|w| {
            let keep = Heard { lead: false, ..w.clone() };
            let f0 = (w.t0 / step).floor().max(0.0);
            let f1 = (w.t1 / step).ceil().min(db.len() as f64);
            let mut runs: Vec<(i64, i64)> = Vec::new();
            let mut f = f0;
            while f < f1 {
                let i = f as usize;
                if f64::from(db[i]) > thr {
                    let fi = f as i64;
                    match runs.last_mut() {
                        Some(r) if fi - r.1 <= join => r.1 = fi + 1,
                        _ => runs.push((fi, fi + 1)),
                    }
                }
                f += 1.0;
            }
            if runs.is_empty() {
                return keep;
            }
            let (s, e) = if w.lead {
                *runs.last().unwrap_or(&(0, 0))
            } else {
                runs.iter().copied().reduce(|x, y| if y.1 - y.0 > x.1 - x.0 { y } else { x }).unwrap_or((0, 0))
            };
            let a = w.t0.max(s as f64 * step - lead);
            let b = w.t1.min(e as f64 * step + tail);
            let n0 = if a - w.t0 > slack { a } else { w.t0 };
            let n1 = if w.t1 - b > slack { b } else { w.t1 };
            if n1 > n0 { Heard { t0: round3(n0), t1: round3(n1), ..keep } } else { keep }
        })
        .collect()
}

/// Runs of frames louder than -35 dBFS, gaps shorter than 30 ms closed, runs shorter than 40 ms dropped -> seconds.
pub fn bursts(samples: &[f32]) -> Vec<(f64, f64)> {
    let (threshold, join, min) = (-35.0f64, 0.03, 0.04);
    let db = frame_db(samples);
    let step = FRAME as f64 / RATE as f64;
    let mut out: Vec<(f64, f64)> = Vec::new();
    let mut start: Option<usize> = None;
    for f in 0..=db.len() {
        let loud = f < db.len() && f64::from(db[f]) > threshold;
        match (loud, start) {
            (true, None) => start = Some(f),
            (false, Some(s)) => {
                let (a, b) = (s as f64 * step, f as f64 * step);
                match out.last_mut() {
                    Some(prev) if a - prev.1 < join => prev.1 = b,
                    _ => out.push((a, b)),
                }
                start = None;
            }
            _ => {}
        }
    }
    out.into_iter().filter(|(a, b)| b - a >= min).map(|(a, b)| (round3(a), round3(b))).collect()
}

/// The fake model's words.
pub const FAKE_WORDS_KO: [&str; 10] =
    ["안녕하세요", "음", "오늘은", "자막을", "어", "만들어", "봅니다.", "그", "편집이", "쉬워요."];
pub const FAKE_WORDS_EN: [&str; 10] = ["Hello", "um", "today", "we", "uh", "make", "captions.", "This", "is", "easy."];
/// Each fake word's confidence: two of the ten are doubtful.
pub const FAKE_P: [f64; 10] = [0.98, 0.9, 0.97, 0.31, 0.88, 0.95, 0.99, 0.86, 0.42, 0.96];

/// One word per burst, its text from the burst's half second (rounded) in the file, so every window that holds a
/// burst names it the same way. Bursts cut by the window's edge are left to the window that holds them whole, except
/// at the start and end of the file. With a word list the doubtful 4th word is heard as the list's first term.
/// `offset` and `total` are samples of the file; `english` picks the English words.
pub fn fake_words(samples: &[f32], offset: u64, total: u64, english: bool, terms: &[String]) -> Vec<Heard> {
    let list = if english { FAKE_WORDS_EN } else { FAKE_WORDS_KO };
    let seconds = samples.len() as f64 / RATE as f64;
    let at_start = offset == 0;
    let at_end = offset + samples.len() as u64 >= total;
    let edge = 0.02;
    let mut out = Vec::new();
    for (a, b) in bursts(samples) {
        if (a < edge && !at_start) || (b > seconds - edge && !at_end) {
            continue;
        }
        let k = (js_round((offset as f64 / RATE as f64 + a) * 2.0) as i64).rem_euclid(list.len() as i64) as usize;
        let (text, p) = match terms.first() {
            Some(t) if k == 3 => (t.clone(), 0.99),
            _ => (list[k].to_owned(), FAKE_P[k]),
        };
        out.push(Heard { t0: a, t1: b, text, lead: false, p: Some(p) });
    }
    out
}
