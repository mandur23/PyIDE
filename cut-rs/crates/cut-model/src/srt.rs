//! Caption files: SubRip (.srt) and WebVTT (.vtt) in and out, and the text encoding of a caption file's bytes (port of
//! `srt.js`, docs/cut-architecture.md section 6).
//!
//! The parsers take what real files contain: a missing or wrong cue number, '.' for ',', no hours, one to three
//! fraction digits, position settings after the times, CRLF or CR, blank lines with spaces, a BOM. White space is
//! JavaScript's `\s`, and every pattern matches what the JavaScript's regular expression matches, backtracking included.

use cut_time::{TICKS, Ticks};
use serde::{Deserialize, Serialize};

use crate::captionwords::{is_space, js_round};

/// A caption read from or written to a file: its times and its text, which keeps its line breaks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cue {
    pub start: Ticks,
    pub end: Ticks,
    pub text: String,
}

/// Why caption bytes could not be read as text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// Kept for callers that match on it: [`decode`] reads CP949 now and no longer returns this.
    #[error("cp949: CP949 caption files are not supported yet")]
    Cp949,
}

const MS: f64 = (TICKS / 1000) as f64;

fn skip_spaces(s: &str, from: usize) -> usize {
    s[from..].find(|c| !is_space(c)).map_or(s.len(), |i| from + i)
}

fn digits(b: &[u8], from: usize) -> usize {
    b.get(from..).map_or(0, |rest| rest.iter().take_while(|c| c.is_ascii_digit()).count())
}

fn blank(s: &str) -> bool {
    s.chars().all(is_space)
}

fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// The captures of `(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,9}))?`.
#[derive(Clone, Copy)]
struct Stamp<'a> {
    h: Option<&'a str>,
    mm: &'a str,
    ss: &'a str,
    frac: Option<&'a str>,
}

/// Each way the stamp pattern can match at `from`, in the order the regex tries them, given to `found` with its end
/// until it accepts one. Ways that fail at once (a shorter digit run before a ':') are left out.
fn stamps<'a>(s: &'a str, from: usize, found: &mut impl FnMut(usize, Stamp<'a>) -> bool) -> bool {
    let b = s.as_bytes();
    for hours in [true, false] {
        let (h, p) = if hours {
            let d = digits(b, from);
            if d == 0 || b.get(from + d) != Some(&b':') {
                continue;
            }
            (Some(&s[from..from + d]), from + d + 1)
        } else {
            (None, from)
        };
        let dm = digits(b, p);
        for lm in [2, 1] {
            if lm > dm || b.get(p + lm) != Some(&b':') {
                continue;
            }
            let q = p + lm + 1;
            let ds = digits(b, q);
            for ls in [2, 1] {
                if ls > ds {
                    continue;
                }
                let r = q + ls;
                let (mm, ss) = (&s[p..p + lm], &s[q..r]);
                if matches!(b.get(r), Some(b',' | b'.')) {
                    let df = digits(b, r + 1).min(9);
                    for lf in (1..=df).rev() {
                        if found(r + 1 + lf, Stamp { h, mm, ss, frac: Some(&s[r + 1..r + 1 + lf]) }) {
                            return true;
                        }
                    }
                }
                if found(r, Stamp { h, mm, ss, frac: None }) {
                    return true;
                }
            }
        }
    }
    false
}

/// `^\s*STAMP\s*-+>\s*STAMP`: the start and end stamps of a timing line.
fn timing(line: &str) -> Option<(Stamp<'_>, Stamp<'_>)> {
    let b = line.as_bytes();
    let mut out = None;
    stamps(line, skip_spaces(line, 0), &mut |e, start| {
        let p = skip_spaces(line, e);
        let dashes = b[p..].iter().take_while(|&&c| c == b'-').count();
        if dashes == 0 || b.get(p + dashes) != Some(&b'>') {
            return false;
        }
        stamps(line, skip_spaces(line, p + dashes + 1), &mut |_, end| {
            out = Some((start, end));
            true
        })
    });
    out
}

/// A stamp's time in ticks, computed in `f64` as the JavaScript does. A fraction of fewer than three digits is a
/// decimal fraction (",5" = 500 ms). Beyond the range of ticks (about 10,000 hours) it saturates.
fn ticks(st: Stamp<'_>) -> Ticks {
    // up to 15 digits an integer is exact as an f64, and summing them is much faster than a float parse
    let num = |s: &str| {
        if s.len() <= 15 {
            s.bytes().fold(0_u64, |n, d| n * 10 + u64::from(d - b'0')) as f64
        } else {
            s.parse::<f64>().unwrap_or(0.0)
        }
    };
    let h = st.h.map_or(0.0, num);
    // digits / 10^len rounds to the double nearest the decimal, as Number(`0.${digits}`) does
    let frac = st.frac.map_or(0.0, |f| js_round(num(f) / 10_f64.powi(f.len() as i32) * 1000.0));
    (((h * 3600.0 + num(st.mm) * 60.0 + num(st.ss)) * 1000.0 + frac) * MS) as Ticks
}

/// The lines of a caption file, without its BOM: split at CRLF, CR or LF.
fn lines(text: &str) -> Vec<&str> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let b = text.as_bytes();
    let mut out = Vec::new();
    let (mut from, mut i) = (0, 0);
    while i < b.len() {
        match b[i] {
            b'\r' | b'\n' => {
                out.push(&text[from..i]);
                i += if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
                from = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[from..]);
    out
}

/// The end of the cue markup players read and do not show, `<\/?[a-z][^<>]*>|<\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}>`
/// (case-insensitive), starting at the `<` at `i`: <i>, <b>, <font ...>, and VTT's <c>, <v Name> and <00:00:01.500>.
fn tag_end(b: &[u8], i: usize) -> Option<usize> {
    let letter = |p: usize| b.get(p).is_some_and(u8::is_ascii_alphabetic);
    let open = if letter(i + 1) {
        Some(i + 2)
    } else if b.get(i + 1) == Some(&b'/') && letter(i + 2) {
        Some(i + 3)
    } else {
        None
    };
    if let Some(p) = open {
        return b[p..].iter().position(|&c| c == b'<' || c == b'>').filter(|&k| b[p + k] == b'>').map(|k| p + k + 1);
    }
    let mut p = i + 1;
    let d = digits(b, p);
    if !(1..=2).contains(&d) || b.get(p + d) != Some(&b':') || digits(b, p + d + 1) < 2 {
        return None;
    }
    p += d + 3;
    if b.get(p) == Some(&b':') && digits(b, p + 1) >= 2 {
        p += 3;
    }
    if !matches!(b.get(p), Some(b'.' | b',')) {
        return None;
    }
    let f = digits(b, p + 1).min(3);
    (f >= 1 && b.get(p + 1 + f) == Some(&b'>')).then_some(p + 2 + f)
}

/// `s` without the spans `end(bytes, i)` matches at each `start` byte, scanning as a global regex replace does.
fn strip(s: &str, start: u8, end: impl Fn(&[u8], usize) -> Option<usize>) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let (mut copied, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == start
            && let Some(e) = end(b, i)
        {
            out.push_str(&s[copied..i]);
            copied = e;
            i = e;
        } else {
            i += 1;
        }
    }
    out.push_str(&s[copied..]);
    out
}

/// The end of an ASS override such as `{\an8}` (`\{\\[^{}]*\}`) starting at the `{` at `i`.
fn ass_end(b: &[u8], i: usize) -> Option<usize> {
    if b.get(i + 1) != Some(&b'\\') {
        return None;
    }
    let p = i + 2;
    b[p..].iter().position(|&c| c == b'{' || c == b'}').filter(|&k| b[p + k] == b'}').map(|k| p + k + 1)
}

/// Text without cue markup; kept, it was drawn as text and burned into exports. A "<" before a non-letter ("a < b")
/// stays.
fn plain(mut s: String) -> String {
    if s.contains('<') {
        s = strip(&s, b'<', tag_end);
    }
    if s.contains('{') {
        s = strip(&s, b'{', ass_end);
    }
    s
}

/// The cues of a file: a block's timing line is its first or second line (after a cue number, which is not checked).
fn cues(all: &[&str], from: usize, vtt: bool) -> Vec<Cue> {
    let mut items = Vec::new();
    let mut i = from;
    let skip_block = |i: &mut usize| {
        while *i < all.len() && !blank(all[*i]) {
            *i += 1;
        }
    };
    while i < all.len() {
        while i < all.len() && blank(all[i]) {
            i += 1;
        }
        if i >= all.len() {
            break;
        }
        // NOTE, STYLE and REGION blocks carry no cue.
        if vtt && is_vtt_block(all[i]) {
            skip_block(&mut i);
            continue;
        }
        let mut m = timing(all[i]);
        if m.is_none() && i + 1 < all.len() {
            m = timing(all[i + 1]);
            if m.is_some() {
                i += 1;
            }
        }
        let Some((start, end)) = m else {
            skip_block(&mut i);
            continue;
        };
        i += 1;
        let from = i;
        while i < all.len() && !blank(all[i]) {
            // A timing line without the blank line before it starts the next SRT cue.
            if !vtt
                && (timing(all[i]).is_some()
                    || (i + 1 < all.len() && is_number(all[i]) && timing(all[i + 1]).is_some()))
            {
                break;
            }
            i += 1;
        }
        let mut text = plain(all[from..i].join("\n"));
        if vtt && text.contains('&') {
            text = unescape(&text);
        }
        text.truncate(trim_end(&text).len());
        items.push(Cue { start: ticks(start), end: ticks(end), text });
    }
    items
}

/// `^\s*\d+\s*$`: a cue number.
fn is_number(s: &str) -> bool {
    let t = s.trim_matches(is_space);
    !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit())
}

/// `^(NOTE|STYLE|REGION)(\s|$)`.
fn is_vtt_block(s: &str) -> bool {
    ["NOTE", "STYLE", "REGION"]
        .iter()
        .any(|w| s.strip_prefix(w).is_some_and(|rest| rest.chars().next().is_none_or(is_space)))
}

/// The cues of a SubRip file.
pub fn parse(text: &str) -> Vec<Cue> {
    cues(&lines(text), 0, false)
}

/// The cues of a WebVTT file: its header, NOTE, STYLE and REGION blocks skipped, entities read.
pub fn parse_vtt(text: &str) -> Vec<Cue> {
    let all = lines(text);
    let mut i = 0;
    if all[0].starts_with("WEBVTT") {
        i = 1;
        while i < all.len() && !blank(all[i]) {
            i += 1;
        }
    }
    cues(&all, i, true)
}

/// A time as a file writes it, `[hh:]mm:ss<sep>mmm`, rounded to the millisecond, below zero as zero. Without `hours`
/// the hours are written only from one hour on.
pub fn format_time(ticks: Ticks, sep: &str, hours: bool) -> String {
    let total = js_round(ticks as f64 / MS).max(0.0) as i64;
    let (ms, s) = (total % 1000, total / 1000);
    let head = if hours || s >= 3600 { format!("{:02}:", s / 3600) } else { String::new() };
    format!("{head}{:02}:{:02}{sep}{ms:03}", s / 60 % 60, s % 60)
}

/// A caption's text for a file: line ends as LF, and a blank line inside it, which would end the cue early in every
/// player, collapsed.
fn body(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    // `\n\s*\n` -> `\n`: from a line end over the white space after it, up to its last line end
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut i) = (0, 0);
    while i < b.len() {
        if b[i] == b'\n' {
            let run = skip_spaces(&text, i + 1);
            if let Some(last) = text[i + 1..run].rfind('\n') {
                out.push_str(&text[copied..=i]);
                i += 1 + last + 1;
                copied = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    trim_end(out.trim_start_matches('\n')).to_owned()
}

/// A SubRip file of `items`, numbered from 1, with CRLF line ends.
pub fn write(items: &[Cue]) -> String {
    let mut out = String::new();
    for (n, it) in items.iter().enumerate() {
        if n > 0 {
            out.push_str("\r\n");
        }
        let start = format_time(it.start, ",", true);
        let end = format_time(it.end, ",", true);
        let text = body(&it.text).replace('\n', "\r\n");
        out.push_str(&format!("{}\r\n{start} --> {end}\r\n{text}\r\n", n + 1));
    }
    out
}

const ENTITIES: [(&str, &str); 8] = [
    ("amp;", "&"),
    ("lt;", "<"),
    ("gt;", ">"),
    ("nbsp;", "\u{a0}"),
    ("lrm;", "\u{200e}"),
    ("rlm;", "\u{200f}"),
    ("quot;", "\""),
    ("apos;", "'"),
];

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        match ENTITIES.iter().find(|(name, _)| rest.starts_with(name)) {
            Some((name, ch)) => {
                out.push_str(ch);
                rest = &rest[name.len()..];
            }
            None => out.push('&'),
        }
    }
    out.push_str(rest);
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A WebVTT file of `items`, with LF line ends, short times and `& < >` escaped.
pub fn write_vtt(items: &[Cue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (n, it) in items.iter().enumerate() {
        if n > 0 {
            out.push('\n');
        }
        let start = format_time(it.start, ".", false);
        let end = format_time(it.end, ".", false);
        out.push_str(&format!("{start} --> {end}\n{}\n", escape(&body(&it.text))));
    }
    out
}

/// Whether a file needs the WebVTT parser, by its content (it starts with WEBVTT) or its name.
pub fn is_vtt(text: &str, name: &str) -> bool {
    text.strip_prefix('\u{feff}').unwrap_or(text).starts_with("WEBVTT")
        || name.len() >= 4 && name.as_bytes()[name.len() - 4..].eq_ignore_ascii_case(b".vtt")
}

/// The cues of a caption file, read by the parser [`is_vtt`] picks.
pub fn parse_any(text: &str, name: &str) -> Vec<Cue> {
    if is_vtt(text, name) { parse_vtt(text) } else { parse(text) }
}

/// UTF-16 as the WHATWG decoder reads it: a leading BOM dropped, a lone surrogate or a last odd byte as U+FFFD.
fn utf16(b: &[u8], little: bool) -> String {
    let (pairs, _) = b.as_chunks::<2>();
    let units = pairs.iter().map(|&p| if little { u16::from_le_bytes(p) } else { u16::from_be_bytes(p) });
    let mut out: String = char::decode_utf16(units).map(|c| c.unwrap_or('\u{fffd}')).collect();
    // a last odd byte after a lone lead surrogate ends the same error
    let lead = b.len() >= 3 && (0xd8..=0xdb).contains(&b[b.len() - if little { 2 } else { 3 }]);
    if b.len() % 2 == 1 && !lead {
        out.push('\u{fffd}');
    }
    match out.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => out,
    }
}

/// The text of a caption file's bytes: UTF-8 with or without BOM, UTF-16 by BOM or by its zero bytes, else CP949,
/// which Korean Windows tools still write. Never fails; the `Result` stays for callers written when CP949 was not read.
pub fn decode(b: &[u8]) -> Result<String, DecodeError> {
    if let Some(rest) = b.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return Ok(String::from_utf8_lossy(rest).into_owned());
    }
    if b.starts_with(&[0xff, 0xfe]) {
        return Ok(utf16(b, true));
    }
    if b.starts_with(&[0xfe, 0xff]) {
        return Ok(utf16(b, false));
    }
    // UTF-16 without a BOM: the digits and arrows of the timing lines have a zero in every other byte (a few
    // syllables such as U+AC00 put a zero on the other side).
    if b.len() >= 4 {
        let pairs = b.len().min(4096) >> 1;
        let even = b[..pairs * 2].iter().step_by(2).filter(|&&c| c == 0).count() as f64;
        let odd = b[1..pairs * 2].iter().step_by(2).filter(|&&c| c == 0).count() as f64;
        let whole = &b[..b.len() & !1];
        let pairs = pairs as f64;
        if odd > pairs * 0.3 && even < pairs * 0.05 {
            return Ok(utf16(whole, true));
        }
        if even > pairs * 0.3 && odd < pairs * 0.05 {
            return Ok(utf16(whole, false));
        }
    }
    Ok(match std::str::from_utf8(b) {
        Ok(text) => text.to_owned(),
        Err(_) => cp949(b),
    })
}

/// CP949 (EUC-KR with the UHC extension) as the WHATWG Encoding Standard's `euc-kr` decoder reads it, which is what
/// the JavaScript gets from Chromium's `TextDecoder('euc-kr')` inside the editor.
pub fn cp949(b: &[u8]) -> String {
    encoding_rs::EUC_KR.decode_without_bom_handling(b).0.into_owned()
}
