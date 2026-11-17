//! Speech recognition's pure half (port of `renderer/features/cut/speech.js`): what is done with Whisper's words.
//!
//! - Windows: long sound is recognised 30 s at a time with 5 s of overlap, or from where a window's text stopped
//!   ([`next_window`], [`text_stop`]); [`merge_windows`] joins them.
//! - Timeline: words are kept per media file in source seconds and mapped through each clip ([`clip_words`]).
//! - Captions ([`captions`]): words grouped into captions of at most two lines, split at pauses and sentence ends.
//! - Fillers and pauses ([`filler_plan`]), the ranges that remove chosen words ([`removal_ranges`]), search.
//! - Confidence ([`is_uncertain`]) and the person's word list ([`parse_terms`], [`terms_key`], [`drop_echo`]).
//!
//! Compared with the JavaScript's own functions in `tests/speech_oracle.rs`.

use cut_audio::analysis::union;
use cut_model::captionwords::{is_punct_or_symbol, is_space};
use cut_model::{Clip, Id};

use super::words::{Heard, RATE};
pub use crate::ai::lines::is_korean;
use crate::ai::lines::layout;

/// A window is 30 s, the next one starting 5 s before its end.
pub const WINDOW: i64 = 30;
pub const OVERLAP: i64 = 5;
/// Below this confidence a word is marked uncertain.
pub const UNCERTAIN: f64 = 0.5;
/// A word list keeps at most this many terms of at most this many characters.
pub const TERMS_COUNT: usize = 200;
pub const TERMS_CHARS: usize = 100;

/// `Math.round`.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// JavaScript's `trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// A recognised word: on the timeline in ticks, or in seconds where a function says so; `clip` and `src` (its index in
/// its media's transcript) once mapped through a clip.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub t0: f64,
    pub t1: f64,
    pub text: String,
    pub p: Option<f64>,
    pub clip: Option<Id>,
    pub src: usize,
}

impl Word {
    pub fn new(t0: f64, t1: f64, text: impl Into<String>, p: Option<f64>) -> Word {
        Word { t0, t1, text: text.into(), p, clip: None, src: 0 }
    }
}

/// Lower case without punctuation and symbols, for comparing and searching.
pub fn normalize(text: &str) -> String {
    let s: String = text.to_lowercase().chars().filter(|&c| !is_punct_or_symbol(c)).collect();
    js_trim(&s).to_owned()
}

fn length(text: &str) -> usize {
    text.chars().count()
}

// ---- windows -------------------------------------------------------------------------------------------------------

/// Where the next window starts (`None`: that was the last) and what this window's words count up to (samples).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub next: Option<i64>,
    pub until: Option<i64>,
}

/// After recognising `[from, to)` of `total` samples, whose text stops `end` seconds into it (`None`: no text): the
/// next window starts where the text stopped when Whisper stopped early (once in a row: `again` is false for a
/// window that itself began at such a stop), else 5 s before this one's end.
pub fn next_window(from: i64, to: i64, end: Option<f64>, total: i64, again: bool) -> Step {
    let rate = RATE as i64;
    let (size, overlap, gap) = (WINDOW * rate, OVERLAP * rate, rate);
    let stop = end.map(|e| from + js_round(e * rate as f64) as i64);
    if let Some(stop) = stop.filter(|&s| again && s >= from + gap && s <= to - overlap - gap && size > overlap) {
        return Step { next: Some(stop), until: Some(stop) };
    }
    Step { next: if to >= total { None } else { Some(to - overlap) }, until: None }
}

/// The windows covering `total` samples when the text always reaches each one's end.
pub fn windows(total: i64) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    let mut from = (total > 0).then_some(0);
    while let Some(f) = from {
        let to = total.min(f + WINDOW * RATE as i64);
        out.push((f, to));
        from = next_window(f, to, None, total, true).next;
    }
    out
}

/// Where a window's text stops (seconds into it): the end of the first word followed by 2.5 s without words, else
/// `end`.
pub fn text_stop(words: &[Heard], end: Option<f64>) -> Option<f64> {
    words.windows(2).find(|w| w[1].t0 - w[0].t1 >= 2.5).map(|w| w[0].t1).or(end)
}

/// One recognised window: its bounds in samples, what its words count up to, its words in seconds from its start.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowWords {
    pub from: i64,
    pub to: i64,
    pub until: Option<i64>,
    pub words: Vec<Heard>,
}

/// The windows' words joined, in seconds from sample 0: a window's words count up to 1.5 s before its end (or up to
/// `until`; the last window all of them), the next window gives only the words after the last one counted, and a
/// word both heard is kept once.
pub fn merge_windows(results: &[WindowWords]) -> Vec<Word> {
    let rate = RATE as f64;
    let edge = 1.5;
    let mut out: Vec<Word> = Vec::new();
    let mut boundary = f64::NEG_INFINITY;
    for (k, r) in results.iter().enumerate() {
        let last = k + 1 == results.len();
        let trust = if last { f64::INFINITY } else { r.until.map_or(r.to as f64 / rate - edge, |u| u as f64 / rate) };
        let base = r.from as f64 / rate;
        let mut words: Vec<Word> = r
            .words
            .iter()
            .map(|w| Word::new(base + w.t0, base + w.t1, js_trim(&w.text), w.p))
            .filter(|w| !w.text.is_empty())
            .collect();
        words.sort_by(|x, y| x.t0.partial_cmp(&y.t0).unwrap_or(std::cmp::Ordering::Equal));
        for w in words {
            let mid = (w.t0 + w.t1) / 2.0;
            if mid > trust || mid <= boundary {
                continue;
            }
            let t0 = w.t0.max(boundary.min(w.t1));
            out.push(Word { t0, ..w });
        }
        let tail = out.last().map_or(f64::NEG_INFINITY, |w| w.t1);
        boundary = boundary.max(tail).max(if trust == f64::INFINITY { f64::NEG_INFINITY } else { trust });
    }
    out.sort_by(|x, y| x.t0.partial_cmp(&y.t0).unwrap_or(std::cmp::Ordering::Equal));
    dedupe(out)
}

fn overlap(a: &Word, b: &Word) -> f64 {
    a.t1.min(b.t1) - a.t0.max(b.t0)
}

/// A word heard twice (the two sides of a seam) kept once: the same text starting within 0.5 s of a kept word, or
/// overlapping it by more than half.
pub fn dedupe(words: Vec<Word>) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::with_capacity(words.len());
    for w in words {
        let n = normalize(&w.text);
        let from = out.len().saturating_sub(4);
        let twin = out[from..].iter().any(|k| {
            normalize(&k.text) == n
                && ((k.t0 - w.t0).abs() < 0.5 || overlap(k, &w) > 0.5 * (k.t1 - k.t0).min(w.t1 - w.t0))
        });
        if !twin {
            out.push(w);
        }
    }
    out
}

// ---- timeline ------------------------------------------------------------------------------------------------------

/// A media file's words (seconds of source time) -> the clip's words on the timeline (ticks), those whose middle the
/// clip shows, in timeline order. A freeze frame shows none.
pub fn clip_words(clip: &Clip, words: &[Word]) -> Vec<Word> {
    if clip.is_freeze() {
        return Vec::new();
    }
    let ticks = cut_time::TICKS as f64;
    let (lo, hi) = (clip.in_.min(clip.out), clip.in_.max(clip.out));
    let mut out = Vec::new();
    for (src, w) in words.iter().enumerate() {
        let (s0, s1) = (w.t0 * ticks, w.t1 * ticks);
        let mid = (s0 + s1) / 2.0;
        if mid < lo || mid >= hi {
            continue;
        }
        let a = clip.timeline_time(lo.max(s0)).unwrap_or(0.0);
        let b = clip.timeline_time(hi.min(s1)).unwrap_or(0.0);
        out.push(Word { t0: a.min(b), t1: a.max(b), text: w.text.clone(), p: w.p, clip: Some(clip.id), src });
    }
    out.sort_by(|x, y| x.t0.partial_cmp(&y.t0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Words of several clips -> one list in timeline order, a word two overlapping clips both hold kept once.
pub fn join_clips(lists: Vec<Vec<Word>>) -> Vec<Word> {
    let mut all: Vec<Word> = lists.into_iter().flatten().collect();
    all.sort_by(|x, y| x.t0.partial_cmp(&y.t0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Word> = Vec::with_capacity(all.len());
    for w in all {
        let n = normalize(&w.text);
        let from = out.len().saturating_sub(4);
        let twin = out[from..].iter().any(|k| {
            k.clip != w.clip && normalize(&k.text) == n && overlap(k, &w) > 0.5 * (k.t1 - k.t0).min(w.t1 - w.t0)
        });
        if !twin {
            out.push(w);
        }
    }
    out
}

/// The index of the last word starting at or before t.
pub fn word_at(words: &[Word], t: f64) -> Option<usize> {
    words.partition_point(|w| w.t0 <= t).checked_sub(1)
}

// ---- captions ------------------------------------------------------------------------------------------------------

fn soft(t: &str) -> bool {
    t.chars().last().is_some_and(|c| matches!(c, ',' | ';' | ':' | '，' | '、'))
}

/// `/[.?!。…]["')\]]*$/`
fn sentence(t: &str) -> bool {
    let rest = t.trim_end_matches(['"', '\'', ')', ']']);
    rest.chars().last().is_some_and(|c| matches!(c, '.' | '?' | '!' | '。' | '…'))
}

fn korean_end(t: &str) -> bool {
    t.chars().last().is_some_and(|c| matches!(c, '다' | '요' | '죠' | '까'))
}

fn ends_sentence(w: &Word, next: Option<&Word>, pause: f64) -> bool {
    sentence(&w.text) || (is_korean(&w.text) && korean_end(&w.text) && next.is_none_or(|n| n.t0 - w.t1 >= pause / 2.0))
}

/// How captions are made (`captions`' options): times in seconds, `max_chars` 0 for 18 (Korean) or 42.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionOpts {
    pub frame: f64,
    pub max_lines: usize,
    pub max_duration: f64,
    pub pause: f64,
    pub linger: f64,
    pub min_duration: f64,
    pub max_chars: usize,
    /// The confidence under which a word is the caption's doubt (0: none).
    pub uncertain: f64,
}

impl Default for CaptionOpts {
    fn default() -> Self {
        CaptionOpts {
            frame: 1.0,
            max_lines: 2,
            max_duration: 6.0,
            pause: 0.6,
            linger: 0.3,
            min_duration: 0.8,
            max_chars: 0,
            uncertain: UNCERTAIN,
        }
    }
}

/// A caption made from words: ticks, its lines joined with `\n`, each word's time from its start (on frames) and the
/// words Whisper was unsure of.
#[derive(Debug, Clone, PartialEq)]
pub struct Caption {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: Vec<(f64, f64, String)>,
    pub doubt: Vec<(f64, String, f64)>,
}

/// Words (ticks, timeline order) -> captions, snapped to frames.
pub fn captions(words: &[Word], o: &CaptionOpts) -> Vec<Caption> {
    let t = cut_time::TICKS as f64;
    let frame = if o.frame > 0.0 { o.frame } else { 1.0 };
    let max_lines = o.max_lines.max(1);
    let (max_duration, pause, linger, min_duration) =
        (o.max_duration * t, o.pause * t, o.linger * t, o.min_duration * t);
    let list: Vec<&Word> = words.iter().filter(|w| !js_trim(&w.text).is_empty()).collect();
    let korean = list.iter().filter(|w| is_korean(&w.text)).count() * 2 >= list.len();
    let max_chars = if o.max_chars > 0 {
        o.max_chars
    } else if korean {
        18
    } else {
        42
    };
    let fits = |g: &[&Word]| {
        layout(&g.iter().map(|w| w.text.clone()).collect::<Vec<_>>(), max_chars, max_lines, " ").is_some()
    };
    let size = |g: &[&Word]| g.iter().map(|w| length(&w.text) as f64 + 1.0).sum::<f64>() - 1.0;
    let mut groups: Vec<Vec<&Word>> = Vec::new();
    let mut cur: Vec<&Word> = Vec::new();
    for &w in &list {
        if let (Some(&last), Some(&first)) = (cur.last(), cur.first()) {
            let full = size(&cur) >= max_chars as f64 * 0.5;
            let mut more = cur.clone();
            more.push(w);
            if w.t0 - last.t1 >= pause
                || w.t1 - first.t0 > max_duration
                || !fits(&more)
                || (full && ends_sentence(last, Some(w), pause))
                || (size(&cur) >= max_chars as f64 * 0.9 && soft(&last.text))
            {
                groups.push(std::mem::take(&mut cur));
            }
        }
        cur.push(w);
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    let mut out: Vec<(f64, f64, String, Vec<&Word>)> = groups
        .into_iter()
        .map(|g| {
            let texts: Vec<String> = g.iter().map(|w| w.text.clone()).collect();
            let text = layout(&texts, max_chars, max_lines, " ").unwrap_or_else(|| vec![texts.join(" ")]).join("\n");
            (g[0].t0, g[g.len() - 1].t1, text, g)
        })
        .collect();
    let snap = |x: f64| (x / frame + 1e-9).floor() * frame;
    for i in 0..out.len() {
        let next = out.get(i + 1).map_or(f64::INFINITY, |n| n.0);
        let c = &mut out[i];
        let limit = next.min(c.0 + max_duration.max(min_duration));
        let want = (c.1 + linger).max(c.0 + min_duration);
        c.1 = want.min(limit);
        c.0 = snap(c.0);
        c.1 = (c.0 + frame).max(snap(c.1));
    }
    for i in 0..out.len().saturating_sub(1) {
        let next_start = snap(out[i + 1].0);
        if out[i].1 > next_start {
            out[i].1 = (out[i].0 + frame).max(next_start);
        }
    }
    let on_frame = |x: f64| js_round(x / frame) * frame;
    out.into_iter()
        .map(|(start, end, text, g)| Caption {
            start,
            end,
            text,
            doubt: g
                .iter()
                .filter(|w| is_uncertain(w.p, o.uncertain))
                .map(|w| (js_round(w.t0 - start).max(0.0), w.text.clone(), w.p.unwrap_or(1.0)))
                .collect(),
            words: g
                .iter()
                .map(|w| (on_frame(w.t0 - start), on_frame(w.t1 - start), js_trim(&w.text).to_owned()))
                .collect(),
        })
        .collect()
}

// ---- confidence and the word list ----------------------------------------------------------------------------------

/// Whether a word of confidence `p` is uncertain below `threshold` (0: none are). A word without p is not.
pub fn is_uncertain(p: Option<f64>, threshold: f64) -> bool {
    threshold > 0.0 && p.is_some_and(|p| p < threshold)
}

/// The word list typed by the person (one term a line, or separated by commas) -> its terms, each once, in order.
pub fn parse_terms(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in text.split(['\n', ',', '，', '、', ';']) {
        let t = raw.split(is_space).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
        let cut: Vec<u16> = t.encode_utf16().take(TERMS_CHARS).collect();
        let cut = String::from_utf16_lossy(&cut);
        let t = js_trim(&cut).to_owned();
        if t.is_empty() || !seen.insert(t.to_lowercase()) {
            continue;
        }
        out.push(t);
        if out.len() >= TERMS_COUNT {
            break;
        }
    }
    out
}

/// The terms a server is given (`termsOf` of whisper.js): strings, white space joined, at most 100 characters,
/// at most 200.
pub fn terms_of(list: &[String]) -> Vec<String> {
    list.iter()
        .map(|t| t.split(is_space).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty() && t.encode_utf16().count() <= TERMS_CHARS)
        .take(TERMS_COUNT)
        .collect()
}

/// A short fingerprint of a word list for the transcript cache key (`""` for none): FNV-1a over the terms.
pub fn terms_key(terms: &[String]) -> String {
    if terms.is_empty() {
        return String::new();
    }
    let mut h: u32 = 0x811c_9dc5;
    for ch in terms.join("\n").chars() {
        h ^= ch as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Whisper reading the word list back as text where there is no speech: a run of two or more words that are each a
/// term of the list (or a word of one), all but the last ending with the list's comma, goes.
pub fn drop_echo(words: Vec<Heard>, terms: &[String]) -> Vec<Heard> {
    if terms.is_empty() {
        return words;
    }
    let known: std::collections::HashSet<String> = terms
        .iter()
        .flat_map(|t| std::iter::once(t.as_str()).chain(t.split(' ')))
        .map(normalize)
        .filter(|s| !s.is_empty())
        .collect();
    let term = |w: &Heard| known.contains(&normalize(js_trim(&w.text)));
    let comma = |w: &Heard| js_trim(&w.text).ends_with([',', '，', '、']);
    let mut drop = vec![false; words.len()];
    let mut any = false;
    let mut i = 0;
    while i < words.len() {
        if !term(&words[i]) || !comma(&words[i]) {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < words.len() && term(&words[j]) && comma(&words[j - 1]) {
            j += 1;
        }
        if j - i >= 2 {
            drop[i..j].iter_mut().for_each(|d| *d = true);
            any = true;
        }
        i = j;
    }
    if !any {
        return words;
    }
    words.into_iter().zip(drop).filter(|(_, d)| !d).map(|(w, _)| w).collect()
}

// ---- fillers and pauses --------------------------------------------------------------------------------------------

/// `^(a+b+…)$` with each group's character repeated (at least once, or any number of times when `star`).
fn repeats(text: &str, groups: &[(char, bool)]) -> bool {
    let mut it = text.chars().peekable();
    for &(c, star) in groups {
        let mut n = 0;
        while it.peek() == Some(&c) {
            it.next();
            n += 1;
        }
        if n == 0 && !star {
            return false;
        }
    }
    it.next().is_none()
}

fn always_filler(text: &str, korean: bool) -> bool {
    let p = |c| (c, false);
    let any: &[&[(char, bool)]] = if korean {
        &[&[p('음')], &[p('어')], &[p('으'), ('음', true)], &[p('흠')]]
    } else {
        &[
            &[p('u'), p('m')],
            &[p('u'), p('h')],
            &[p('e'), p('r')],
            &[p('e'), p('r'), p('m')],
            &[p('a'), p('h')],
            &[p('h'), p('m')],
            &[p('m')],
        ]
    };
    any.iter().any(|g| repeats(text, g))
}

/// Whether `words[i]` is a hesitation: always (음, 어, 으음, um, uh …), or 그, 저, 뭐 when a pause of `pause` ticks
/// follows, the text trails off, it is the last word or the next word is the same.
pub fn is_filler(words: &[Word], i: usize, pause: f64) -> bool {
    let w = &words[i];
    let text = normalize(&w.text);
    if text.is_empty() {
        return false;
    }
    let korean = is_korean(&text);
    if always_filler(&text, korean) {
        return true;
    }
    if !korean || !matches!(text.as_str(), "그" | "저" | "뭐") {
        return false;
    }
    let trimmed = js_trim(&w.text);
    let trailing = trimmed.ends_with("...") || trimmed.ends_with(['…', ',', '-']);
    match words.get(i + 1) {
        None => true,
        Some(next) => trailing || next.t0 - w.t1 >= pause || normalize(&next.text) == text,
    }
}

/// The timeline range that removes words `i..=j`: the words and the pause around them up to `ext` on each side,
/// never closer than `keep` to the words left on either side.
pub fn word_range(words: &[Word], i: usize, j: usize, ext: f64, keep: f64) -> (f64, f64) {
    let (first, last) = (&words[i], &words[j]);
    let prev = i.checked_sub(1).map(|k| &words[k]);
    let next = words.get(j + 1);
    let mut a = first.t0 - ext;
    let mut b = last.t1 + ext;
    if let Some(p) = prev {
        a = a.max(p.t1 + keep);
    }
    if let Some(n) = next {
        b = b.min(n.t0 - keep);
    }
    a = a.min(first.t0);
    b = b.max(last.t1);
    if let Some(p) = prev {
        a = a.max(p.t1);
    }
    if let Some(n) = next {
        b = b.min(n.t0);
    }
    (a, b)
}

/// Ranges (ticks) inside whole frames, joined, empty ones dropped.
pub fn on_frames(ranges: &[(f64, f64)], frame: f64) -> Vec<(f64, f64)> {
    let inside: Vec<(f64, f64)> = ranges
        .iter()
        .map(|&(a, b)| ((a / frame - 1e-9).ceil() * frame, (b / frame + 1e-9).floor() * frame))
        .filter(|(a, b)| b > a)
        .collect();
    union(&inside)
}

/// Runs of consecutive indexes: `[3, 4, 5, 9]` -> `[(3, 5), (9, 9)]`.
pub fn runs(indexes: &[usize]) -> Vec<(usize, usize)> {
    let mut s = indexes.to_vec();
    s.sort_unstable();
    s.dedup();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for i in s {
        match out.last_mut() {
            Some(last) if i == last.1 + 1 => last.1 = i,
            _ => out.push((i, i)),
        }
    }
    out
}

/// The ranges that remove the chosen words (0.25 s around them, 80 ms from the words kept), on frames.
pub fn removal_ranges(words: &[Word], indexes: &[usize], frame: f64) -> Vec<(f64, f64)> {
    let t = cut_time::TICKS as f64;
    let list: Vec<(f64, f64)> =
        runs(indexes).into_iter().map(|(i, j)| word_range(words, i, j, 0.25 * t, 0.08 * t)).collect();
    on_frames(&list, frame)
}

/// Remove Filler Words' settings (seconds).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FillerOpts {
    pub fillers: bool,
    pub pauses: bool,
    pub pause_length: f64,
    pub keep: f64,
}

impl Default for FillerOpts {
    fn default() -> Self {
        FillerOpts { fillers: true, pauses: true, pause_length: 1.0, keep: 0.15 }
    }
}

/// What Remove Filler Words cuts: the filler words' indexes, the long pauses and every range, on frames.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FillerPlan {
    pub fillers: Vec<usize>,
    pub pauses: Vec<(f64, f64)>,
    pub ranges: Vec<(f64, f64)>,
}

/// Hesitations and pauses longer than `pause_length` between words (cut down to `keep` on each side).
pub fn filler_plan(words: &[Word], o: &FillerOpts, frame: f64) -> FillerPlan {
    let t = cut_time::TICKS as f64;
    let (ext, hesitation) = (0.25, 0.3);
    let found: Vec<usize> = if o.fillers {
        (0..words.len()).filter(|&i| is_filler(words, i, hesitation * t)).collect()
    } else {
        Vec::new()
    };
    let mut cuts: Vec<(f64, f64)> =
        runs(&found).into_iter().map(|(i, j)| word_range(words, i, j, ext * t, 0.08 * t)).collect();
    let mut gaps = Vec::new();
    if o.pauses {
        let kept: Vec<&Word> = words.iter().enumerate().filter(|(i, _)| !found.contains(i)).map(|(_, w)| w).collect();
        for p in kept.windows(2) {
            let a = p[0].t1 + o.keep * t;
            let b = p[1].t0 - o.keep * t;
            if p[1].t0 - p[0].t1 >= o.pause_length * t && b > a {
                gaps.push((a, b));
            }
        }
    }
    let pauses = on_frames(&gaps, frame);
    cuts.extend(gaps);
    FillerPlan { fillers: found, pauses, ranges: on_frames(&cuts, frame) }
}

// ---- search --------------------------------------------------------------------------------------------------------

/// Matches of a query: index runs whose words hold the query's words in order (the first and last may be partial),
/// case and punctuation ignored.
pub fn search(words: &[Word], query: &str) -> Vec<(usize, usize)> {
    let q: Vec<String> = query.split(is_space).map(normalize).filter(|s| !s.is_empty()).collect();
    if q.is_empty() {
        return Vec::new();
    }
    let norm: Vec<String> = words.iter().map(|w| normalize(&w.text)).collect();
    let mut out = Vec::new();
    for i in 0..(norm.len() + 1).saturating_sub(q.len()) {
        let ok = (0..q.len()).all(|k| {
            let w = &norm[i + k];
            if q.len() == 1 {
                w.contains(&q[0])
            } else if k == 0 {
                w.ends_with(&q[k])
            } else if k == q.len() - 1 {
                w.starts_with(&q[k])
            } else {
                *w == q[k]
            }
        });
        if ok {
            out.push((i, i + q.len() - 1));
        }
    }
    out
}
