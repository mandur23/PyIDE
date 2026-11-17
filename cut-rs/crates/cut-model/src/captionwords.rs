//! A caption's word timings, for the word-by-word highlight (port of `captionwords.js`, docs/cut-architecture.md
//! section 6).
//!
//! A caption item made from speech carries `words`: one entry per token of its text (a run of characters without white
//! space, across its lines), in order, with times in whole ticks from the caption's start. Times may lie before the start
//! or past the end, and `t0` never decreases. Words that do not fit their text are never highlighted ([`valid`]), and
//! every edit that changes the text goes through [`realign`].
//!
//! Text is compared as the JavaScript compares it: white space is JavaScript's `\s`, case is folded by Unicode's full
//! lowercase mapping (as `toLowerCase`), and punctuation and symbols are `\p{P}` and `\p{S}` of Unicode 16, the version
//! of the Node.js the oracle runs (`PUNCT_OR_SYMBOL`, generated from that regex).

use std::ops::Range;

use cut_time::Ticks;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A token of a caption's text with its time, whole ticks from the caption's start (may lie outside it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub t0: Ticks,
    pub t1: Ticks,
    pub text: String,
}

/// A word speech recognition was unsure of: `at` whole ticks from the caption's start, `p` its confidence 0-1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Doubt {
    pub at: Ticks,
    pub text: String,
    pub p: f64,
}

/// How a lit word is drawn: its text in the highlight color, or a box behind it.
pub const MODES: [&str; 2] = ["color", "box"];

/// JavaScript's `\s`: Unicode's space separators and line ends plus U+FEFF, without U+0085 (Rust's `is_whitespace`
/// differs on both).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript's `Math.round`: halves go up, also below zero (`-2.5` -> `-2`), unlike `f64::round`.
pub(crate) fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// The tokens of a caption's text: its runs without white space, across its lines.
pub fn tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_space).filter(|t| !t.is_empty())
}

/// The byte range of each token of one line, for drawing it. The JavaScript gives UTF-16 offsets; these are the same
/// tokens as byte offsets into `line`, so they slice it.
pub fn spans(line: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut from = None;
    for (i, c) in line.char_indices() {
        match (is_space(c), from) {
            (true, Some(f)) => {
                out.push(f..i);
                from = None;
            }
            (false, None) => from = Some(i),
            _ => {}
        }
    }
    if let Some(f) = from {
        out.push(f..line.len());
    }
    out
}

/// `\p{P}` or `\p{S}` of the JavaScript's regular expressions (Unicode 16).
pub fn is_punct_or_symbol(c: char) -> bool {
    PUNCT_OR_SYMBOL.partition_point(|&x| x <= c as u32) % 2 == 1
}

/// A token compared without case and punctuation, so "hello" corrected to "Hello," keeps its time. A token of
/// punctuation only is compared as it is.
fn key(s: &str) -> String {
    let k: String = s.to_lowercase().chars().filter(|&c| !is_punct_or_symbol(c)).collect();
    if k.is_empty() { s.to_owned() } else { k }
}

fn whole(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|x| x.is_finite() && x.fract() == 0.0)
}

/// Whether `words` (a caption's `words` as read from a file) fit `text`: one word per token, in order, whole ticks,
/// `t1` not before `t0`, `t0` never decreasing. What the model's validation asks.
pub fn valid(words: &Value, text: &str) -> bool {
    let Some(words) = words.as_array() else { return false };
    let mut toks = tokens(text);
    let mut last = f64::NEG_INFINITY;
    for w in words {
        let (Some(tok), Some(w)) = (toks.next(), w.as_object()) else { return false };
        if w.get("text").and_then(Value::as_str) != Some(tok) {
            return false;
        }
        let (Some(t0), Some(t1)) = (whole(w.get("t0")), whole(w.get("t1"))) else { return false };
        if t1 < t0 || t0 < last {
            return false;
        }
        last = t0;
    }
    toks.next().is_none()
}

/// [`valid`] for words already read.
pub fn fits(words: &[Word], text: &str) -> bool {
    let mut toks = tokens(text);
    let mut last = Ticks::MIN;
    for w in words {
        if toks.next() != Some(w.text.as_str()) || w.t1 < w.t0 || w.t0 < last {
            return false;
        }
        last = w.t0;
    }
    toks.next().is_none()
}

fn snap(x: f64, f: f64) -> f64 {
    js_round(x / f) * f
}

/// Below this magnitude an `f64` time converts to ticks exactly.
const TICKS_LIMIT: f64 = 9_223_372_036_854_775_807.0;

/// An old token: its share of its word's time, and its comparison key.
struct Old {
    t0: f64,
    t1: f64,
    key: String,
}

/// `words` (any JSON, maybe stale) fitted to `text`: the tokens matched to the old words by the longest common run keep
/// their times (snapped to `frame`); a run of new tokens takes the time of the old words it replaces, or the pause
/// between its neighbours (0 and `duration` at the ends), split evenly on frames. `None` (no highlight) when a run has
/// less than a frame a word, when no token matches, or for anything that is not words. `frame`: the sequence's frame
/// ticks (1 when not positive); `duration`: the caption's length (`None`: up to the last old word's end).
///
/// Times are computed in `f64` as the JavaScript does; a result beyond the range of ticks gives `None`.
pub fn realign(words: &Value, text: &str, frame: Ticks, duration: Option<Ticks>) -> Option<Vec<Word>> {
    let words = words.as_array()?;
    let toks: Vec<&str> = tokens(text).collect();
    let f = if frame > 0 { frame as f64 } else { 1.0 };
    let mut old = Vec::new();
    for w in words {
        let w = w.as_object()?;
        let t0 = w.get("t0")?.as_f64()?;
        let t1 = w.get("t1")?.as_f64()?;
        let parts: Vec<&str> = tokens(w.get("text")?.as_str()?).collect();
        // a word holding several tokens shares its time between them
        let len = (t1 - t0).max(0.0);
        let count = parts.len() as f64;
        for (i, p) in parts.into_iter().enumerate() {
            old.push(Old { t0: t0 + (len * i as f64) / count, t1: t0 + (len * (i + 1) as f64) / count, key: key(p) });
        }
    }
    let (n, m) = (old.len(), toks.len());
    if n == 0 || m == 0 || n.checked_mul(m).is_none_or(|nm| nm > 1_000_000) {
        return None;
    }
    let keys: Vec<String> = toks.iter().map(|t| key(t)).collect();
    // the longest common run of tokens, in order: lcs[i * w + j] for old[i..] and toks[j..]
    let w = m + 1;
    let mut lcs = vec![0_u16; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * w + j] = if old[i].key == keys[j] {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }
    if lcs[0] == 0 {
        return None;
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if old[i].key == keys[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    let mut out = vec![(0.0, 0.0); m];
    for &(i, j) in &pairs {
        out[j] = (snap(old[i].t0, f), snap(old[i].t1, f));
    }
    let end = duration.map_or(old[n - 1].t1, |d| d as f64);
    let anchors: Vec<(isize, isize)> = std::iter::once((-1, -1))
        .chain(pairs.iter().map(|&(i, j)| (i as isize, j as isize)))
        .chain(std::iter::once((n as isize, m as isize)))
        .collect();
    for a in anchors.windows(2) {
        let [(i0, j0), (i1, j1)] = [a[0], a[1]];
        let k = j1 - j0 - 1;
        if k <= 0 {
            continue;
        }
        // new words take the time of the old ones they replace, or the gap between their neighbours
        let (lo, hi) = if i1 - i0 > 1 {
            (old[(i0 + 1) as usize].t0, old[(i1 - 1) as usize].t1)
        } else {
            (if i0 < 0 { 0.0 } else { old[i0 as usize].t1 }, if i1 >= n as isize { end } else { old[i1 as usize].t0 })
        };
        let (lo, hi) = (snap(lo, f), snap(hi, f));
        let first = (j0 + 1) as usize;
        let k = k as usize;
        if hi - lo < k as f64 * f {
            return None;
        }
        let step = (hi - lo) / k as f64 / f;
        for (q, slot) in out[first..first + k].iter_mut().enumerate() {
            let q = q as f64;
            *slot = (lo + js_round(step * q) * f, lo + js_round(step * (q + 1.0)) * f);
        }
    }
    // times that never go back: t0 the running maximum, t1 at least t0
    let mut last = f64::NEG_INFINITY;
    let mut words = Vec::with_capacity(m);
    for ((t0, t1), text) in out.into_iter().zip(toks) {
        let t0 = t0.max(last);
        last = t0;
        let t1 = t1.max(t0);
        if !(t0.abs() < TICKS_LIMIT && t1.abs() < TICKS_LIMIT) {
            return None;
        }
        words.push(Word { t0: t0 as Ticks, t1: t1 as Ticks, text: text.to_owned() });
    }
    Some(words)
}

/// A time relative to `from` through `fun`, made relative to `to` again.
fn moved(t: Ticks, from: Ticks, to: Ticks, fun: &mut impl FnMut(Ticks, bool) -> Ticks, is_end: bool) -> Ticks {
    fun(from.saturating_add(t), is_end).saturating_sub(to)
}

/// Each word's absolute time (`from + t`) through `fun(x, is_end)` (`is_end`: a word's end), made relative to `to`
/// again, with times that never go back: what a ripple does to a caption's words.
pub fn remap(words: &[Word], from: Ticks, to: Ticks, mut fun: impl FnMut(Ticks, bool) -> Ticks) -> Vec<Word> {
    let mut last = Ticks::MIN;
    words
        .iter()
        .map(|w| {
            let t0 = moved(w.t0, from, to, &mut fun, false).max(last);
            last = t0;
            let t1 = moved(w.t1, from, to, &mut fun, true).max(t0);
            Word { t0, t1, text: w.text.clone() }
        })
        .collect()
}

/// A caption's doubt moved as [`remap`] moves its words, each `at` as a word start. Unlike its words, a doubt stays only
/// while the caption, now `length` ticks long, holds its start.
pub fn remap_doubt(
    doubt: &[Doubt],
    from: Ticks,
    to: Ticks,
    mut fun: impl FnMut(Ticks, bool) -> Ticks,
    length: Ticks,
) -> Vec<Doubt> {
    doubt
        .iter()
        .map(|d| Doubt { at: moved(d.at, from, to, &mut fun, false), ..d.clone() })
        .filter(|d| d.at >= 0 && d.at <= length)
        .collect()
}

/// The word lit at `rel` ticks into its caption: the last one begun, until the next begins (the last one until it
/// ends). Words of no length (cut away by a ripple) are never lit.
pub fn lit(words: &[Word], rel: Ticks) -> Option<usize> {
    let mut best = None;
    let mut next = None;
    for (i, w) in words.iter().enumerate() {
        if w.t1 <= w.t0 {
            continue;
        }
        if w.t0 <= rel {
            best = Some(i);
        } else {
            next = Some(i);
            break;
        }
    }
    let best = best?;
    let until = next.map_or(words[best].t1, |n| words[n].t0);
    (rel < until).then_some(best)
}

/// The token of a caption item (its `words`, `text` and `start`) lit at sequence time `t`; `None` when nothing is lit
/// or the words do not fit the text.
pub fn lit_at(words: &[Word], text: &str, start: Ticks, t: Ticks) -> Option<usize> {
    if fits(words, text) { lit(words, t.saturating_sub(start)) } else { None }
}

/// `[\p{P}\p{S}]` as sorted code point ranges `start, end (exclusive), ...`, generated from JavaScript's regex under
/// Unicode 16: a code point is in it when an odd number of bounds are at or below it.
#[rustfmt::skip]
const PUNCT_OR_SYMBOL: [u32; 698] = [
    0x21, 0x30, 0x3A, 0x41, 0x5B, 0x61, 0x7B, 0x7F, 0xA1, 0xAA, 0xAB, 0xAD,
    0xAE, 0xB2, 0xB4, 0xB5, 0xB6, 0xB9, 0xBB, 0xBC, 0xBF, 0xC0, 0xD7, 0xD8,
    0xF7, 0xF8, 0x2C2, 0x2C6, 0x2D2, 0x2E0, 0x2E5, 0x2EC, 0x2ED, 0x2EE, 0x2EF, 0x300,
    0x375, 0x376, 0x37E, 0x37F, 0x384, 0x386, 0x387, 0x388, 0x3F6, 0x3F7, 0x482, 0x483,
    0x55A, 0x560, 0x589, 0x58B, 0x58D, 0x590, 0x5BE, 0x5BF, 0x5C0, 0x5C1, 0x5C3, 0x5C4,
    0x5C6, 0x5C7, 0x5F3, 0x5F5, 0x606, 0x610, 0x61B, 0x61C, 0x61D, 0x620, 0x66A, 0x66E,
    0x6D4, 0x6D5, 0x6DE, 0x6DF, 0x6E9, 0x6EA, 0x6FD, 0x6FF, 0x700, 0x70E, 0x7F6, 0x7FA,
    0x7FE, 0x800, 0x830, 0x83F, 0x85E, 0x85F, 0x888, 0x889, 0x964, 0x966, 0x970, 0x971,
    0x9F2, 0x9F4, 0x9FA, 0x9FC, 0x9FD, 0x9FE, 0xA76, 0xA77, 0xAF0, 0xAF2, 0xB70, 0xB71,
    0xBF3, 0xBFB, 0xC77, 0xC78, 0xC7F, 0xC80, 0xC84, 0xC85, 0xD4F, 0xD50, 0xD79, 0xD7A,
    0xDF4, 0xDF5, 0xE3F, 0xE40, 0xE4F, 0xE50, 0xE5A, 0xE5C, 0xF01, 0xF18, 0xF1A, 0xF20,
    0xF34, 0xF35, 0xF36, 0xF37, 0xF38, 0xF39, 0xF3A, 0xF3E, 0xF85, 0xF86, 0xFBE, 0xFC6,
    0xFC7, 0xFCD, 0xFCE, 0xFDB, 0x104A, 0x1050, 0x109E, 0x10A0, 0x10FB, 0x10FC, 0x1360, 0x1369,
    0x1390, 0x139A, 0x1400, 0x1401, 0x166D, 0x166F, 0x169B, 0x169D, 0x16EB, 0x16EE, 0x1735, 0x1737,
    0x17D4, 0x17D7, 0x17D8, 0x17DC, 0x1800, 0x180B, 0x1940, 0x1941, 0x1944, 0x1946, 0x19DE, 0x1A00,
    0x1A1E, 0x1A20, 0x1AA0, 0x1AA7, 0x1AA8, 0x1AAE, 0x1B4E, 0x1B50, 0x1B5A, 0x1B6B, 0x1B74, 0x1B80,
    0x1BFC, 0x1C00, 0x1C3B, 0x1C40, 0x1C7E, 0x1C80, 0x1CC0, 0x1CC8, 0x1CD3, 0x1CD4, 0x1FBD, 0x1FBE,
    0x1FBF, 0x1FC2, 0x1FCD, 0x1FD0, 0x1FDD, 0x1FE0, 0x1FED, 0x1FF0, 0x1FFD, 0x1FFF, 0x2010, 0x2028,
    0x2030, 0x205F, 0x207A, 0x207F, 0x208A, 0x208F, 0x20A0, 0x20C1, 0x2100, 0x2102, 0x2103, 0x2107,
    0x2108, 0x210A, 0x2114, 0x2115, 0x2116, 0x2119, 0x211E, 0x2124, 0x2125, 0x2126, 0x2127, 0x2128,
    0x2129, 0x212A, 0x212E, 0x212F, 0x213A, 0x213C, 0x2140, 0x2145, 0x214A, 0x214E, 0x214F, 0x2150,
    0x218A, 0x218C, 0x2190, 0x242A, 0x2440, 0x244B, 0x249C, 0x24EA, 0x2500, 0x2776, 0x2794, 0x2B74,
    0x2B76, 0x2B96, 0x2B97, 0x2C00, 0x2CE5, 0x2CEB, 0x2CF9, 0x2CFD, 0x2CFE, 0x2D00, 0x2D70, 0x2D71,
    0x2E00, 0x2E2F, 0x2E30, 0x2E5E, 0x2E80, 0x2E9A, 0x2E9B, 0x2EF4, 0x2F00, 0x2FD6, 0x2FF0, 0x3000,
    0x3001, 0x3005, 0x3008, 0x3021, 0x3030, 0x3031, 0x3036, 0x3038, 0x303D, 0x3040, 0x309B, 0x309D,
    0x30A0, 0x30A1, 0x30FB, 0x30FC, 0x3190, 0x3192, 0x3196, 0x31A0, 0x31C0, 0x31E6, 0x31EF, 0x31F0,
    0x3200, 0x321F, 0x322A, 0x3248, 0x3250, 0x3251, 0x3260, 0x3280, 0x328A, 0x32B1, 0x32C0, 0x3400,
    0x4DC0, 0x4E00, 0xA490, 0xA4C7, 0xA4FE, 0xA500, 0xA60D, 0xA610, 0xA673, 0xA674, 0xA67E, 0xA67F,
    0xA6F2, 0xA6F8, 0xA700, 0xA717, 0xA720, 0xA722, 0xA789, 0xA78B, 0xA828, 0xA82C, 0xA836, 0xA83A,
    0xA874, 0xA878, 0xA8CE, 0xA8D0, 0xA8F8, 0xA8FB, 0xA8FC, 0xA8FD, 0xA92E, 0xA930, 0xA95F, 0xA960,
    0xA9C1, 0xA9CE, 0xA9DE, 0xA9E0, 0xAA5C, 0xAA60, 0xAA77, 0xAA7A, 0xAADE, 0xAAE0, 0xAAF0, 0xAAF2,
    0xAB5B, 0xAB5C, 0xAB6A, 0xAB6C, 0xABEB, 0xABEC, 0xFB29, 0xFB2A, 0xFBB2, 0xFBC3, 0xFD3E, 0xFD50,
    0xFDCF, 0xFDD0, 0xFDFC, 0xFE00, 0xFE10, 0xFE1A, 0xFE30, 0xFE53, 0xFE54, 0xFE67, 0xFE68, 0xFE6C,
    0xFF01, 0xFF10, 0xFF1A, 0xFF21, 0xFF3B, 0xFF41, 0xFF5B, 0xFF66, 0xFFE0, 0xFFE7, 0xFFE8, 0xFFEF,
    0xFFFC, 0xFFFE, 0x10100, 0x10103, 0x10137, 0x10140, 0x10179, 0x1018A, 0x1018C, 0x1018F, 0x10190, 0x1019D,
    0x101A0, 0x101A1, 0x101D0, 0x101FD, 0x1039F, 0x103A0, 0x103D0, 0x103D1, 0x1056F, 0x10570, 0x10857, 0x10858,
    0x10877, 0x10879, 0x1091F, 0x10920, 0x1093F, 0x10940, 0x10A50, 0x10A59, 0x10A7F, 0x10A80, 0x10AC8, 0x10AC9,
    0x10AF0, 0x10AF7, 0x10B39, 0x10B40, 0x10B99, 0x10B9D, 0x10D6E, 0x10D6F, 0x10D8E, 0x10D90, 0x10EAD, 0x10EAE,
    0x10F55, 0x10F5A, 0x10F86, 0x10F8A, 0x11047, 0x1104E, 0x110BB, 0x110BD, 0x110BE, 0x110C2, 0x11140, 0x11144,
    0x11174, 0x11176, 0x111C5, 0x111C9, 0x111CD, 0x111CE, 0x111DB, 0x111DC, 0x111DD, 0x111E0, 0x11238, 0x1123E,
    0x112A9, 0x112AA, 0x113D4, 0x113D6, 0x113D7, 0x113D9, 0x1144B, 0x11450, 0x1145A, 0x1145C, 0x1145D, 0x1145E,
    0x114C6, 0x114C7, 0x115C1, 0x115D8, 0x11641, 0x11644, 0x11660, 0x1166D, 0x116B9, 0x116BA, 0x1173C, 0x11740,
    0x1183B, 0x1183C, 0x11944, 0x11947, 0x119E2, 0x119E3, 0x11A3F, 0x11A47, 0x11A9A, 0x11A9D, 0x11A9E, 0x11AA3,
    0x11B00, 0x11B0A, 0x11BE1, 0x11BE2, 0x11C41, 0x11C46, 0x11C70, 0x11C72, 0x11EF7, 0x11EF9, 0x11F43, 0x11F50,
    0x11FD5, 0x11FF2, 0x11FFF, 0x12000, 0x12470, 0x12475, 0x12FF1, 0x12FF3, 0x16A6E, 0x16A70, 0x16AF5, 0x16AF6,
    0x16B37, 0x16B40, 0x16B44, 0x16B46, 0x16D6D, 0x16D70, 0x16E97, 0x16E9B, 0x16FE2, 0x16FE3, 0x1BC9C, 0x1BC9D,
    0x1BC9F, 0x1BCA0, 0x1CC00, 0x1CCF0, 0x1CD00, 0x1CEB4, 0x1CF50, 0x1CFC4, 0x1D000, 0x1D0F6, 0x1D100, 0x1D127,
    0x1D129, 0x1D165, 0x1D16A, 0x1D16D, 0x1D183, 0x1D185, 0x1D18C, 0x1D1AA, 0x1D1AE, 0x1D1EB, 0x1D200, 0x1D242,
    0x1D245, 0x1D246, 0x1D300, 0x1D357, 0x1D6C1, 0x1D6C2, 0x1D6DB, 0x1D6DC, 0x1D6FB, 0x1D6FC, 0x1D715, 0x1D716,
    0x1D735, 0x1D736, 0x1D74F, 0x1D750, 0x1D76F, 0x1D770, 0x1D789, 0x1D78A, 0x1D7A9, 0x1D7AA, 0x1D7C3, 0x1D7C4,
    0x1D800, 0x1DA00, 0x1DA37, 0x1DA3B, 0x1DA6D, 0x1DA75, 0x1DA76, 0x1DA84, 0x1DA85, 0x1DA8C, 0x1E14F, 0x1E150,
    0x1E2FF, 0x1E300, 0x1E5FF, 0x1E600, 0x1E95E, 0x1E960, 0x1ECAC, 0x1ECAD, 0x1ECB0, 0x1ECB1, 0x1ED2E, 0x1ED2F,
    0x1EEF0, 0x1EEF2, 0x1F000, 0x1F02C, 0x1F030, 0x1F094, 0x1F0A0, 0x1F0AF, 0x1F0B1, 0x1F0C0, 0x1F0C1, 0x1F0D0,
    0x1F0D1, 0x1F0F6, 0x1F10D, 0x1F1AE, 0x1F1E6, 0x1F203, 0x1F210, 0x1F23C, 0x1F240, 0x1F249, 0x1F250, 0x1F252,
    0x1F260, 0x1F266, 0x1F300, 0x1F6D8, 0x1F6DC, 0x1F6ED, 0x1F6F0, 0x1F6FD, 0x1F700, 0x1F777, 0x1F77B, 0x1F7DA,
    0x1F7E0, 0x1F7EC, 0x1F7F0, 0x1F7F1, 0x1F800, 0x1F80C, 0x1F810, 0x1F848, 0x1F850, 0x1F85A, 0x1F860, 0x1F888,
    0x1F890, 0x1F8AE, 0x1F8B0, 0x1F8BC, 0x1F8C0, 0x1F8C2, 0x1F900, 0x1FA54, 0x1FA60, 0x1FA6E, 0x1FA70, 0x1FA7D,
    0x1FA80, 0x1FA8A, 0x1FA8F, 0x1FAC7, 0x1FACE, 0x1FADD, 0x1FADF, 0x1FAEA, 0x1FAF0, 0x1FAF9, 0x1FB00, 0x1FB93,
    0x1FB94, 0x1FBF0,
];
