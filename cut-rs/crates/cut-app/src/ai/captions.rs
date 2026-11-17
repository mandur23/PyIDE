//! What the text AI sends about captions and what it accepts back (`ai.js`'s transcripts, polish and translate):
//! segments of text with their times, condensed to fit a prompt; the polish and translate prompts; the check that an
//! answer gives one text for every caption asked about.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use super::js::{chars, cut, integer, num, one_line, sec1, trim};
use super::lines::LANGS;

/// Characters of transcript in one prompt (`BUDGET`).
pub const BUDGET: usize = 30000;
/// Captions per polish or translate request (`CHUNK`).
pub const CHUNK: usize = 60;

/// The system prompt of every text AI request (`SYSTEM`).
pub const SYSTEM: &str = "You help a person edit a video in Nano Studio Cut, a video editor.\nYou receive text only: transcripts or captions with their times in seconds, and clip, track and marker names.\nReply with one JSON value in a ```json fenced block, exactly in the shape the request asks for, and nothing else.\nNever invent fields, operations or times outside what the request allows.";

/// A stretch of words with its times (ticks).
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A caption as a prompt line: its number and text.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub i: i64,
    pub text: String,
}

/// What [`condense`] made: the prompt's lines, whether they were shortened, how many there were and were kept.
#[derive(Debug, Clone, PartialEq)]
pub struct Condensed {
    pub text: String,
    pub trimmed: bool,
    pub lines: usize,
    pub kept: usize,
}

/// `segmentsFromCaptions`: the captions with text.
pub fn segments_from_captions(items: &[cut_model::Caption]) -> Vec<Segment> {
    items
        .iter()
        .map(|it| Segment { start: it.start as f64, end: it.end as f64, text: one_line(&it.text) })
        .filter(|s| !s.text.is_empty())
        .collect()
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `condense`: segments as prompt lines "[start-end] text" (seconds) within `budget` characters. Over it, each line
/// is cut to `line_max` characters, then evenly spaced lines are kept (the first and the last always).
pub fn condense(segments: &[Segment], budget: usize, line_max: usize) -> Condensed {
    let list: Vec<&Segment> = segments.iter().filter(|s| !one_line(&s.text).is_empty()).collect();
    let line = |s: &Segment, max: Option<usize>| {
        let t = one_line(&s.text);
        let t = max.map_or(t.clone(), |m| cut(&t, m));
        format!("[{}-{}] {t}", sec1(s.start), sec1(s.end))
    };
    let size = |ls: &[String]| ls.iter().map(|l| utf16(l) + 1).sum::<usize>();
    let full: Vec<String> = list.iter().map(|s| line(s, None)).collect();
    if size(&full) <= budget {
        return Condensed { text: full.join("\n"), trimmed: false, lines: list.len(), kept: list.len() };
    }
    let short: Vec<String> = list.iter().map(|s| line(s, Some(line_max))).collect();
    let mut picked = short.clone();
    let start = ((budget as f64 / size(&short) as f64) * short.len() as f64).floor().max(2.0) as usize;
    let mut keep = start;
    while size(&picked) > budget && keep >= 1 {
        let mut at: Vec<usize> = (0..keep)
            .map(|k| {
                if keep == 1 {
                    0
                } else {
                    cut_formats::table::js_round((k * (short.len() - 1)) as f64 / (keep - 1) as f64) as usize
                }
            })
            .collect();
        at.sort_unstable();
        at.dedup();
        picked = at.iter().map(|i| short[*i].clone()).collect();
        keep -= 1;
    }
    Condensed { text: picked.join("\n"), trimmed: true, lines: list.len(), kept: picked.len() }
}

/// `langName`: a language for a prompt, `Korean (ko)`, or the captions' own.
pub fn lang_name(code: Option<&str>) -> String {
    match LANGS.iter().find(|(c, _)| Some(*c) == code) {
        Some((c, name)) => format!("{name} ({c})"),
        None => "the language of the captions".into(),
    }
}

fn lines_json(lines: &[Line]) -> String {
    Json::Array(lines.iter().map(|l| json!({ "i": l.i, "text": l.text })).collect()).to_string()
}

/// `polishPrompt`'s prompt (its system prompt is [`SYSTEM`]).
pub fn polish_prompt(lines: &[Line], lang: Option<&str>) -> String {
    [
        "Task: polish captions".to_owned(),
        format!("Language: {}", lang_name(lang)),
        "Fix the spelling, the spacing between words and the punctuation of each caption. Keep its meaning, wording and language:".into(),
        "do not translate, rephrase, shorten, merge or split captions. Keep a line break (\\n) where the caption has one.".into(),
        "Return every caption, also those that need no change, with its number i.".into(),
        "Answer: {\"lines\": [{\"i\": 1, \"text\": \"the polished caption\"}]}".into(),
        "Captions (JSON):".into(),
        lines_json(lines),
    ]
    .join("\n")
}

/// `translatePrompt`.
pub fn translate_prompt(lines: &[Line], from: Option<&str>, to: Option<&str>) -> String {
    [
        "Task: translate captions".to_owned(),
        format!("From: {}", lang_name(from)),
        format!("Target language: {}", lang_name(to)),
        "Translate each caption on its own into short, natural subtitle language. Keep names and numbers. One caption out for".into(),
        "each caption in, with the same number i, none merged or split. No line breaks: the editor breaks the lines itself.".into(),
        "Answer: {\"lines\": [{\"i\": 1, \"text\": \"the translated caption\"}]}".into(),
        "Captions (JSON):".into(),
        lines_json(lines),
    ]
    .join("\n")
}

/// The text of a line of an answer, as `validateLines` cleans it: line breaks kept, spaces and tabs one space,
/// each line trimmed, empty lines dropped.
fn clean(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    for l in text.split('\n') {
        let mut s = String::with_capacity(l.len());
        let mut blank = false;
        for c in l.chars() {
            if c == ' ' || c == '\t' {
                blank = true;
                continue;
            }
            if blank {
                s.push(' ');
                blank = false;
            }
            s.push(c);
        }
        if blank {
            s.push(' ');
        }
        let t = trim(&s);
        if !t.is_empty() {
            out.push(t.to_owned());
        }
    }
    out.join("\n")
}

/// `validateLines`: the answer's text for every caption of `lines`. -> number -> text, or the reason (English).
pub fn validate_lines(value: &Json, lines: &[Line]) -> Result<HashMap<i64, String>, String> {
    let Some(list) = value.as_object().and_then(|o| o.get("lines")).and_then(Json::as_array) else {
        return Err("The answer must be an object with a \"lines\" list.".into());
    };
    let want: HashMap<i64, &str> = lines.iter().map(|l| (l.i, l.text.as_str())).collect();
    let mut out: HashMap<i64, String> = HashMap::new();
    for l in list {
        let (i, text) = match (l.as_object(), l.get("i").and_then(integer), l.get("text").and_then(Json::as_str)) {
            (Some(_), Some(i), Some(t)) => (i, t),
            _ => return Err("Every line needs a number \"i\" and a string \"text\".".into()),
        };
        let key = i as i64;
        if (key as f64) != i || !want.contains_key(&key) {
            return Err(format!("There is no caption {}.", num(i)));
        }
        if out.contains_key(&key) {
            return Err(format!("Caption {} is given twice.", num(i)));
        }
        let text = clean(text);
        if text.is_empty() {
            return Err(format!("Caption {} is empty.", num(i)));
        }
        if chars(&text) > 4 * chars(want[&key]) + 40 {
            return Err(format!("Caption {} is much longer than the original.", num(i)));
        }
        out.insert(key, text);
    }
    let missing: Vec<String> =
        lines.iter().filter(|l| !out.contains_key(&l.i)).take(10).map(|l| l.i.to_string()).collect();
    if !missing.is_empty() {
        return Err(format!("Captions missing from the answer: {}.", missing.join(", ")));
    }
    Ok(out)
}
