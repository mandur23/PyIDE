//! Captions' lines for the text AI (`ai.js`'s `lineBreak`, `keepLines`, `cjkTokens`, `diffChars`, and `speech.js`'s
//! `layout` and `isKorean` they use): a translated caption is broken again by the editor's caption rules, a
//! polished one keeps its line breaks when they still fit, and the review marks what changed character by character.

use super::js::{chars, is_space, one_line};
use super::unicode::{CJK, CLOSING, HANGUL, within};

/// The languages the text AI names (`LANGS`).
pub const LANGS: [(&str, &str); 5] =
    [("ko", "Korean"), ("en", "English"), ("ja", "Japanese"), ("zh", "Simplified Chinese"), ("es", "Spanish")];

/// Whether `lang` is one of [`LANGS`].
pub fn known(lang: Option<&str>) -> bool {
    lang.is_some_and(|l| LANGS.iter().any(|(c, _)| *c == l))
}

/// `isKorean`: the text has Hangul.
pub fn is_korean(text: &str) -> bool {
    text.chars().any(|c| within(c, HANGUL))
}

fn cjk_lang(lang: Option<&str>) -> bool {
    matches!(lang, Some("ja" | "zh"))
}

/// `speech.layout`: lines of words, each at most `max_chars` long (a longer word gets a line of its own), at most
/// `max_lines` of them, the longest as short as it can be; `None` when the words do not fit.
pub fn layout(texts: &[String], max_chars: usize, max_lines: usize, sep: &str) -> Option<Vec<String>> {
    let n = texts.len();
    let len: Vec<i64> = texts.iter().map(|t| chars(t) as i64).collect();
    let sep_len = sep.encode_utf16().count() as i64;
    let span = |i: usize, j: usize| len[i..j].iter().sum::<i64>() + sep_len * (j as i64 - i as i64 - 1);
    let max = max_chars as i64;
    if span(0, n) <= max {
        return Some(vec![texts.join(sep)]);
    }
    if max_lines < 2 {
        return None;
    }
    let soft = |t: &str| t.chars().last().is_some_and(|c| matches!(c, ',' | ';' | ':' | '，' | '、'));
    fn solve(
        i: usize,
        k: usize,
        n: usize,
        max: i64,
        span: &dyn Fn(usize, usize) -> i64,
        soft: &dyn Fn(usize) -> bool,
    ) -> Option<(i64, Vec<usize>)> {
        if i == n {
            return Some((0, Vec::new()));
        }
        if k == 0 {
            return None;
        }
        let mut pick: Option<(i64, Vec<usize>)> = None;
        for j in i + 1..=n {
            let w = span(i, j);
            if w > max && j > i + 1 {
                break;
            }
            let Some((rest, cuts)) = solve(j, k - 1, n, max, span, soft) else { continue };
            // a cut after a comma reads better: it counts as one character shorter
            let worst = (w - i64::from(j < n && soft(j - 1))).max(rest);
            if pick.as_ref().is_none_or(|p| worst < p.0) {
                let mut all = vec![j];
                all.extend(cuts);
                pick = Some((worst, all));
            }
        }
        pick
    }
    let soft_at = |j: usize| soft(&texts[j]);
    let (_, cuts) = solve(0, max_lines, n, max, &span, &soft_at)?;
    let mut lines = Vec::new();
    let mut at = 0;
    for c in cuts {
        lines.push(texts[at..c].join(sep));
        at = c;
    }
    Some(lines)
}

/// `cjkTokens`: Japanese and Chinese "words" for line breaking: a character each, a run of Latin letters or digits
/// kept whole, a closing mark (。、！」…) never at the start of a line.
pub fn cjk_tokens(text: &str) -> Vec<String> {
    let latin = |c: char| c.is_ascii_alphanumeric() || matches!(c, '\'' | '’' | '.' | '%' | '-');
    let closing = |p: &str| {
        let mut it = p.chars();
        matches!((it.next(), it.next()), (Some(c), None) if within(c, CLOSING) || c == 'ー' || c == '〜')
    };
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        let take = if latin(c) {
            rest.find(|x: char| !latin(x)).unwrap_or(rest.len())
        } else if is_space(c) {
            rest.find(|x: char| !is_space(x)).unwrap_or(rest.len())
        } else {
            c.len_utf8()
        };
        let piece = &rest[..take];
        rest = &rest[take..];
        if piece.chars().all(is_space) {
            if let Some(last) = out.last_mut() {
                last.push(' ');
            }
            continue;
        }
        match out.last_mut() {
            Some(last) if closing(piece) => last.push_str(piece),
            _ => out.push(piece.to_owned()),
        }
    }
    out
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

fn greedy(tokens: &[String], max: usize, sep: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for t in tokens {
        let next = if cur.is_empty() { t.clone() } else { format!("{cur}{sep}{t}") };
        if !cur.is_empty() && chars(js_trim(&next)) > max {
            lines.push(js_trim(&cur).to_owned());
            cur = t.clone();
        } else {
            cur = next;
        }
    }
    if !js_trim(&cur).is_empty() {
        lines.push(js_trim(&cur).to_owned());
    }
    lines
}

/// `lineBreak`: a caption's text broken into lines by the editor's caption rules: at most two balanced lines of 18
/// characters for Korean, 16 for Japanese and Chinese (no spaces between words), 42 otherwise; longer text wraps on.
pub fn line_break(text: &str, lang: Option<&str>, max_chars: usize, max_lines: usize) -> String {
    let flat = one_line(text);
    if flat.is_empty() {
        return String::new();
    }
    let unknown = !known(lang);
    let cjk = cjk_lang(lang) || (unknown && flat.chars().any(|c| within(c, CJK)) && !is_korean(&flat));
    let max = if max_chars > 0 {
        max_chars
    } else if lang == Some("ko") || (unknown && is_korean(&flat)) {
        18
    } else if cjk {
        16
    } else {
        42
    };
    let sep = if cjk { "" } else { " " };
    let tokens: Vec<String> = if cjk { cjk_tokens(&flat) } else { flat.split(' ').map(str::to_owned).collect() };
    let lines = layout(&tokens, max, max_lines, sep).unwrap_or_else(|| greedy(&tokens, max, sep));
    lines.iter().map(|l| js_trim(l)).collect::<Vec<_>>().join("\n")
}

/// `keepLines`: a polished caption keeps the original's line breaks when it still fits them; otherwise it is broken
/// again.
pub fn keep_lines(before: &str, after: &str, lang: Option<&str>) -> String {
    let want = before.split('\n').count();
    let lines: Vec<&str> = after.split('\n').collect();
    let max = if lang == Some("ko") || (!known(lang) && is_korean(after)) {
        18
    } else if cjk_lang(lang) {
        16
    } else {
        42
    };
    if lines.len() == want && lines.iter().all(|l| chars(l) <= max) {
        return lines.join("\n");
    }
    line_break(after, lang, 0, 2)
}

/// A run of the before/after comparison: kept, removed or added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Keep,
    Remove,
    Add,
}

impl Op {
    /// `=`, `-` or `+`, as the JavaScript writes it.
    pub fn sign(self) -> &'static str {
        match self {
            Op::Keep => "=",
            Op::Remove => "-",
            Op::Add => "+",
        }
    }
}

/// `diffChars`: the characters of `a` and `b` as runs kept, removed and added, from their longest common
/// subsequence.
pub fn diff_chars(a: &str, b: &str) -> Vec<(Op, String)> {
    let x: Vec<char> = a.chars().collect();
    let y: Vec<char> = b.chars().collect();
    if x.len() * y.len() > 250_000 {
        let mut out = Vec::new();
        if !x.is_empty() {
            out.push((Op::Remove, a.to_owned()));
        }
        if !y.is_empty() {
            out.push((Op::Add, b.to_owned()));
        }
        return out;
    }
    let (n, m) = (x.len(), y.len());
    let w = m + 1;
    let mut l = vec![0_u16; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            l[i * w + j] =
                if x[i] == y[j] { l[(i + 1) * w + j + 1] + 1 } else { l[(i + 1) * w + j].max(l[i * w + j + 1]) };
        }
    }
    let mut out: Vec<(Op, String)> = Vec::new();
    let mut push = |op: Op, c: char| match out.last_mut() {
        Some((o, s)) if *o == op => s.push(c),
        _ => out.push((op, c.to_string())),
    };
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if x[i] == y[j] {
            push(Op::Keep, x[i]);
            i += 1;
            j += 1;
        } else if l[(i + 1) * w + j] >= l[i * w + j + 1] {
            push(Op::Remove, x[i]);
            i += 1;
        } else {
            push(Op::Add, y[j]);
            j += 1;
        }
    }
    for c in &x[i..] {
        push(Op::Remove, *c);
    }
    for c in &y[j..] {
        push(Op::Add, *c);
    }
    out
}
