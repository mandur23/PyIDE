//! YouTube's title, description, chapters and tags from Claude (`ai.js`'s metadata half): the prompt, and the answer
//! made to fit YouTube's rules whatever came back (chapters whole seconds inside the video, the first at 0:00, at
//! least 3 of 10 s or more; tags 500 characters in all).

use serde_json::Value as Json;

use super::js::{T, chars, clock, cut, fin, num, one_line, quote, sec1, to_fixed, trim};

const TITLE_MAX: usize = 100;
const DESCRIPTION_MAX: usize = 5000;
const TAGS_MAX: usize = 500;
/// The shortest chapter YouTube takes, in seconds (`CHAPTER_MIN`).
pub const CHAPTER_MIN: f64 = 10.0;

/// A chapter: its start in whole seconds and its title.
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    pub t: f64,
    pub title: String,
}

/// A checked answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Metadata {
    pub titles: Vec<String>,
    pub description: String,
    pub chapters: Vec<Chapter>,
    pub tags: Vec<String>,
    /// What was fixed for YouTube, as English sentences the screen translates.
    pub fixed: Vec<&'static str>,
}

/// A sequence marker as the prompt shows it.
pub struct MarkerLine<'a> {
    pub t: f64,
    pub kind: &'a str,
    pub name: &'a str,
}

/// `metadataPrompt` (`duration` in ticks).
pub fn metadata_prompt(name: &str, duration: f64, transcript: &str, markers: &[MarkerLine]) -> String {
    let seconds = duration / T;
    let short = seconds < 3.0 * CHAPTER_MIN;
    let markers = if markers.is_empty() {
        "Markers: none".to_owned()
    } else {
        let list: Vec<String> =
            markers.iter().map(|m| format!("{} {} {}", sec1(m.t), m.kind, quote(&one_line(m.name)))).collect();
        format!("Markers (seconds, kind, name):\n{}", list.join("\n"))
    };
    [
        "Task: YouTube metadata".to_owned(),
        format!("Video: {}, {} long ({} s).", quote(&one_line(name)), clock(seconds), to_fixed(seconds, 1)),
        "Write everything in the language the transcript is spoken in.".into(),
        format!("Give 3 to 5 title options (at most {TITLE_MAX} characters each), a description of 2 to 4 short paragraphs (no chapter list, no hashtags),"),
        if short {
            "no chapters (the video is too short for them: \"chapters\": []),".into()
        } else {
            format!("chapters (start times in whole seconds: the first at 0, at least 3, each at least {} s long including the last, inside the video, short titles),", num(CHAPTER_MIN))
        },
        "and 5 to 15 tags (words or short phrases, no # signs).".into(),
        "Answer: {\"titles\": [\"...\"], \"description\": \"...\", \"chapters\": [{\"t\": 0, \"title\": \"...\"}], \"tags\": [\"...\"]}".into(),
        markers,
        "Transcript ([start-end] seconds, text):".into(),
        if transcript.is_empty() { "(no words)".into() } else { transcript.to_owned() },
    ]
    .join("\n")
}

/// `fixChapters`: chapters as YouTube needs them, whatever came back. -> the chapters and what was fixed.
pub fn fix_chapters(list: &Json, duration_seconds: f64, intro: &str) -> (Vec<Chapter>, Vec<&'static str>) {
    let mut fixed = Vec::new();
    let given: &[Json] = list.as_array().map_or(&[], Vec::as_slice);
    let mut ch: Vec<Chapter> = given
        .iter()
        .filter_map(|c| {
            let t = c.as_object().and(c.get("t")).and_then(fin)?;
            let title = c.get("title").and_then(Json::as_str).map(one_line).filter(|t| !t.is_empty())?;
            Some(Chapter { t: t.floor().max(0.0), title: cut(&title, TITLE_MAX) })
        })
        .collect();
    if list.is_array() && ch.len() < given.len() {
        fixed.push("Chapters without a time or a title were left out.");
    }
    let before = ch.len();
    ch.retain(|c| c.t < duration_seconds);
    if ch.len() < before {
        fixed.push("Chapters past the end were left out.");
    }
    ch.sort_by(|a, b| a.t.total_cmp(&b.t));
    if ch.first().is_some_and(|c| c.t > 0.0) {
        if ch[0].t < CHAPTER_MIN {
            ch[0].t = 0.0;
        } else {
            ch.insert(0, Chapter { t: 0.0, title: intro.to_owned() });
        }
        fixed.push("The first chapter now starts at 0:00.");
    }
    let mut kept: Vec<Chapter> = Vec::new();
    for c in &ch {
        if kept.last().is_none_or(|l| c.t - l.t >= CHAPTER_MIN) {
            kept.push(c.clone());
        }
    }
    while kept.len() > 1 && kept.last().is_some_and(|l| duration_seconds - l.t < CHAPTER_MIN) {
        kept.pop();
    }
    if kept.len() < ch.len() {
        fixed.push("Chapters less than 10 seconds long were left out.");
    }
    (kept, fixed)
}

/// `cleanTags`: words without `#`, commas or angle brackets, each once, 500 characters in all.
pub fn clean_tags(list: &Json) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    for t in list.as_array().map_or(&[][..], Vec::as_slice) {
        let Some(t) = t.as_str() else { continue };
        let t = t.trim_start_matches('#').replace([',', '<', '>'], " ");
        let tag = one_line(&t);
        let key = tag.to_lowercase();
        if tag.is_empty() || seen.contains(&key) || chars(&tag) > 100 {
            continue;
        }
        let add = chars(&tag) + usize::from(!out.is_empty());
        if total + add > TAGS_MAX {
            break;
        }
        seen.insert(key);
        out.push(tag);
        total += add;
    }
    out
}

/// The first `n` UTF-16 units of `s` (`slice(0, n)`; a pair cut in two is left out).
fn utf16_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// `validateMetadata` (`duration` in ticks). -> the metadata, or the reason (English).
pub fn validate_metadata(value: &Json, duration: f64, intro: &str) -> Result<Metadata, String> {
    let Some(o) = value.as_object() else { return Err("The answer must be an object.".into()) };
    let seconds = duration / T;
    let mut titles: Vec<String> = Vec::new();
    for t in o.get("titles").and_then(Json::as_array).map_or(&[][..], Vec::as_slice) {
        let Some(t) = t.as_str().map(one_line).filter(|t| !t.is_empty()) else { continue };
        let t = cut(&t, TITLE_MAX);
        if !titles.contains(&t) {
            titles.push(t);
        }
    }
    if titles.is_empty() {
        return Err("\"titles\" must be a list of title strings.".into());
    }
    let Some(description) = o.get("description").and_then(Json::as_str).filter(|d| !trim(d).is_empty()) else {
        return Err("\"description\" must be a non-empty string.".into());
    };
    let Some(chapters) = o.get("chapters").filter(|c| c.is_array()) else {
        return Err("\"chapters\" must be a list.".into());
    };
    let Some(tags) = o.get("tags").filter(|t| t.is_array()) else {
        return Err("\"tags\" must be a list of strings.".into());
    };
    let (chapters, fixed) = fix_chapters(chapters, seconds, intro);
    let short = seconds < 3.0 * CHAPTER_MIN;
    if !short && chapters.len() < 3 {
        return Err(format!(
            "YouTube needs at least 3 chapters, each at least {} s long; after removing the invalid ones {} remain.",
            num(CHAPTER_MIN),
            chapters.len()
        ));
    }
    let description = description.replace("\r\n", "\n").replace('\r', "\n");
    let description = utf16_prefix(trim(&description), DESCRIPTION_MAX).to_owned();
    titles.truncate(5);
    Ok(Metadata {
        titles,
        description,
        chapters: if short { Vec::new() } else { chapters },
        tags: clean_tags(tags),
        fixed,
    })
}

/// `chapterText`: "0:00 Intro" lines for the description.
pub fn chapter_text(chapters: &[Chapter]) -> String {
    chapters.iter().map(|c| format!("{} {}", clock(c.t), c.title)).collect::<Vec<_>>().join("\n")
}
