//! The small JavaScript behaviours the text AI's checks depend on, so its sentences and numbers come out as the
//! JavaScript's do (`ai.js`'s helpers): whitespace as `\s`, lengths in code points, `toFixed`, `${number}`, the
//! clocks, the JSON of an answer (`parseJson`) and the prompt asked again (`retryPrompt`).

use cut_formats::table::js_round;
use serde_json::Value as Json;

/// `TICKS` as a float, for the seconds of the prompts.
pub const T: f64 = cut_time::TICKS as f64;

/// JavaScript's `\s`: white space and line terminators.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// JavaScript's `trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `oneLine`: every run of white space one space, trimmed.
pub fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for word in s.split(is_space).filter(|w| !w.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// `chars`: the length in code points.
pub fn chars(s: &str) -> usize {
    s.chars().count()
}

/// `cut`: at most `n` code points, the last one an ellipsis when cut.
pub fn cut(s: &str, n: usize) -> String {
    if chars(s) > n {
        let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    } else {
        s.to_owned()
    }
}

/// `fin`: a finite JSON number.
pub fn fin(v: &Json) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// `Number.isInteger`.
pub fn integer(v: &Json) -> Option<f64> {
    fin(v).filter(|x| x.fract() == 0.0)
}

/// A number as JavaScript prints it in a template string (`${x}`).
pub fn num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if a >= 1e21 || a < 1e-6 {
        // shortest digits with an exponent, written as JavaScript writes it: 1.5e+21, 1e-7
        let e = format!("{x:e}");
        return match e.split_once('e') {
            Some((m, ex)) if !ex.starts_with('-') => format!("{m}e+{ex}"),
            _ => e,
        };
    }
    format!("{x}")
}

/// `Number.prototype.toFixed(digits)`: the nearest of the decimals, a tie going up (away from zero).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return num(x);
    }
    let neg = x < 0.0;
    // the exact expansion well past the digits asked for: a tie is an exact 5 followed by zeros
    let s = format!("{:.*}", digits + 40, x.abs());
    let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
    let (keep, rest) = frac.split_at(digits);
    let mut digits_of: Vec<u8> = int.bytes().chain(keep.bytes()).map(|b| b - b'0').collect();
    if rest.as_bytes().first().is_some_and(|d| *d >= b'5') {
        let mut i = digits_of.len();
        loop {
            if i == 0 {
                digits_of.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_of[i] == 9 {
                digits_of[i] = 0;
            } else {
                digits_of[i] += 1;
                break;
            }
        }
    }
    let text: String = digits_of.iter().map(|d| char::from(b'0' + d)).collect();
    let (i, f) = text.split_at(text.len() - digits);
    let body = if digits == 0 { i.to_owned() } else { format!("{i}.{f}") };
    let zero = digits_of.iter().all(|d| *d == 0);
    if neg && !zero { format!("-{body}") } else { body }
}

/// `sec1`: ticks as seconds with a tenth.
pub fn sec1(ticks: f64) -> String {
    to_fixed(ticks / T, 1)
}

/// `clock`: whole seconds as YouTube writes them: 0:00, 12:34, 1:02:03.
pub fn clock(seconds: f64) -> String {
    let s = (seconds + 1e-6).floor().max(0.0);
    let s = if s.is_finite() { s as u64 } else { 0 };
    let (h, m) = (s / 3600, (s / 60) % 60);
    if h > 0 { format!("{h}:{m:02}:{:02}", s % 60) } else { format!("{m}:{:02}", s % 60) }
}

/// `clockFine`: seconds with a tenth, for the previews: 0:10.0, 1:02.5.
pub fn clock_fine(seconds: f64) -> String {
    let t = (js_round(seconds * 10.0) / 10.0).max(0.0);
    let whole = (t + 1e-9).floor();
    let tenth = (js_round((t - whole) * 10.0) as i64).rem_euclid(10);
    format!("{}.{tenth}", clock(whole))
}

/// The JSON value of an answer (`parseJson`): the first fenced block that parses, else the whole text, else the text
/// from its first `{` or `[` to the last matching bracket. -> the value, or the reason (English).
pub fn parse_json(text: &str) -> Result<Json, &'static str> {
    let s = trim(text);
    let fences = fences(s);
    let mut tries: Vec<String> = fences.iter().map(|f| trim(&s[f.body.clone()]).to_owned()).collect();
    tries.push(s.to_owned());
    let mut outside = String::with_capacity(s.len());
    let mut at = 0;
    for f in &fences {
        outside.push_str(&s[at..f.all.start]);
        outside.push(' ');
        at = f.all.end;
    }
    outside.push_str(&s[at..]);
    for t in [s, outside.as_str()] {
        let Some(first) = t.find(['[', '{']) else { continue };
        let close = if t.as_bytes()[first] == b'{' { '}' } else { ']' };
        if let Some(last) = t.rfind(close).filter(|l| *l > first) {
            tries.push(t[first..=last].to_owned());
        }
    }
    for t in tries.iter().filter(|t| !t.is_empty()) {
        if let Ok(v) = serde_json::from_str::<Json>(t) {
            return Ok(v);
        }
    }
    Err("The answer has no JSON value.")
}

struct Fence {
    all: std::ops::Range<usize>,
    body: std::ops::Range<usize>,
}

/// The matches of ```` /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g ````.
fn fences(s: &str) -> Vec<Fence> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = s[from..].find("```").map(|i| i + from) {
        let b = s.as_bytes();
        let mut j = i + 3;
        while j < b.len() && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
            j += 1;
        }
        if b.get(j) == Some(&b'\r') && b.get(j + 1) == Some(&b'\n') {
            j += 2;
        } else if b.get(j) == Some(&b'\n') {
            j += 1;
        }
        let Some(end) = s[j..].find("```").map(|k| k + j) else { break };
        out.push(Fence { all: i..end + 3, body: j..end });
        from = end + 3;
    }
    out
}

/// `retryPrompt`: the prompt again with why the last answer was refused.
pub fn retry_prompt(prompt: &str, answer: &str, error: &str) -> String {
    format!(
        "{prompt}\n\nYour previous answer could not be used: {error}\nYour previous answer was:\n{}\n\nAnswer again with only the corrected JSON, in the shape asked above.",
        cut(answer, 4000)
    )
}

/// `JSON.stringify` of a string.
pub fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// JavaScript's truthiness of a JSON value.
pub fn truthy(v: &Json) -> bool {
    match v {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Json::String(s) => !s.is_empty(),
        _ => true,
    }
}
