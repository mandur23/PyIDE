//! Highlights to Shorts (`ai.js`'s highlights and shorts): the prompt, the check that Claude's ranges are inside the
//! sequence, of the asked lengths and not overlapping, and the edits that make the 9:16 copy of them.

use cut_formats::table::js_round;
use cut_model::commands::build as C;
use cut_model::{Project, Sequence, TrackKind};
use serde_json::{Value as Json, json};

use super::js::{T, cut, fin, num, one_line, sec1, to_fixed};

/// A checked highlight: its range (ticks on frames) and Claude's title and reason.
#[derive(Debug, Clone, PartialEq)]
pub struct Highlight {
    pub start: f64,
    pub end: f64,
    pub title: String,
    pub reason: String,
}

/// How many highlights, and how long each may be (seconds): the dialog's fields.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ask {
    pub count: f64,
    pub min: f64,
    pub max: f64,
}

/// `highlightsPrompt` (`duration` in ticks).
pub fn highlights_prompt(duration: f64, transcript: &str, o: Ask) -> String {
    let seconds = to_fixed(duration / T, 1);
    [
        "Task: highlights".to_owned(),
        format!(
            "Pick up to {} of the most engaging, self-contained moments of this {seconds} s video for vertical shorts.",
            num(o.count)
        ),
        format!(
            "Each one {} to {} seconds long, inside 0 to {seconds} s, none overlapping another, ordered by start.",
            num(o.min),
            num(o.max)
        ),
        "Start and end where a sentence starts and ends (use the transcript times). Titles short, in the transcript's language.".into(),
        "Answer: {\"highlights\": [{\"start\": 12.0, \"end\": 41.5, \"title\": \"...\", \"reason\": \"...\"}]}".into(),
        "Transcript ([start-end] seconds, text):".into(),
        if transcript.is_empty() { "(no words)".into() } else { transcript.to_owned() },
    ]
    .join("\n")
}

/// `validateHighlights` (`duration` and `frame` in ticks). -> the highlights by start, or the reason (English).
pub fn validate_highlights(value: &Json, duration: f64, o: Ask, frame: f64) -> Result<Vec<Highlight>, String> {
    let Some(list) = value.as_object().and_then(|v| v.get("highlights")).and_then(Json::as_array) else {
        return Err("The answer must be an object with a \"highlights\" list.".into());
    };
    if list.is_empty() {
        return Err("The \"highlights\" list is empty.".into());
    }
    if list.len() as f64 > o.count {
        return Err(format!("Give at most {} highlights; the answer has {}.", num(o.count), list.len()));
    }
    let mut out = Vec::new();
    for (k, h) in list.iter().enumerate() {
        let n = k + 1;
        let (Some(_), Some(hs), Some(he)) = (h.as_object(), h.get("start").and_then(fin), h.get("end").and_then(fin))
        else {
            return Err(format!("Highlight {n} needs numbers \"start\" and \"end\" (seconds)."));
        };
        if hs < -0.5 || he > duration / T + 0.5 {
            return Err(format!(
                "Highlight {n} ({}-{} s) is outside the video (0-{} s).",
                num(hs),
                num(he),
                to_fixed(duration / T, 1)
            ));
        }
        let start = (js_round((hs.max(0.0) * T) / frame) * frame).max(0.0);
        let end = ((duration / frame).floor() * frame).min(js_round((he * T) / frame) * frame);
        let len = (end - start) / T;
        if end.partial_cmp(&start) != Some(std::cmp::Ordering::Greater) {
            return Err(format!("Highlight {n} ends before it starts."));
        }
        if len < o.min - 0.5 || len > o.max + 0.5 {
            return Err(format!(
                "Highlight {n} is {} s long; each must be {} to {} s.",
                to_fixed(len, 1),
                num(o.min),
                num(o.max)
            ));
        }
        let text = |key: &str, max: usize| cut(&one_line(h.get(key).and_then(Json::as_str).unwrap_or("")), max);
        out.push(Highlight { start, end, title: text("title", 100), reason: text("reason", 300) });
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    for w in out.windows(2) {
        if w[1].start < w[0].end {
            return Err(format!(
                "Highlights overlap: {}-{} s and {}-{} s.",
                sec1(w[0].start),
                sec1(w[0].end),
                sec1(w[1].start),
                sec1(w[1].end)
            ));
        }
    }
    Ok(out)
}

/// `complement`: what is left out of `[0, duration)` when `keep` (sorted, not overlapping) stays, latest first.
pub fn complement(keep: &[(f64, f64)], duration: f64) -> Vec<(f64, f64)> {
    let mut gaps = Vec::new();
    let mut at: f64 = 0.0;
    for &(a, b) in keep {
        if a > at {
            gaps.push((at, a));
        }
        at = at.max(b);
    }
    if duration > at {
        gaps.push((at, duration));
    }
    gaps.reverse();
    gaps
}

/// How the shorts' video meets the 9:16 frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    Fill,
    Fit,
}

impl Fit {
    /// `fill` or `fit`, as the setting `cut.ai.shortsFit` keeps it.
    pub fn id(self) -> &'static str {
        match self {
            Fit::Fill => "fill",
            Fit::Fit => "fit",
        }
    }
}

/// `shortsEdits`: the commands that fit or fill the video and image clips of `seq` (now its new size) centered: each
/// clip's scale is multiplied by what the chosen mode needs over the project's own fit, its position goes to the
/// centre.
pub fn shorts_edits(project: &Project, seq: &Sequence, mode: Fit) -> Vec<Json> {
    let fit = project.settings.get("fit").and_then(Json::as_str);
    let (sw, sh) = (seq.w as f64, seq.h as f64);
    let id = seq.id.as_str();
    let mut out = Vec::new();
    for c in seq.clips_in_order() {
        if seq.kind_of(c.track) != Some(TrackKind::Video) {
            continue;
        }
        let Some(v) = c.media_id().and_then(|m| project.media(m)).and_then(|m| m.video.as_ref()) else { continue };
        let (w, h) = (v.w, v.h);
        if !(w > 0.0 && h > 0.0) {
            continue;
        }
        let k =
            cut_engine::plan::fit_scale(w, h, sw, sh, Some(mode.id())) / cut_engine::plan::fit_scale(w, h, sw, sh, fit);
        let mul = |x: f64| js_round(x * k * 1000.0) / 1000.0;
        let mul_json = |v: &Json| match v {
            Json::Array(a) => Json::Array(a.iter().map(|x| json!(mul(x.as_f64().unwrap_or(f64::NAN)))).collect()),
            v => json!(mul(v.as_f64().unwrap_or(f64::NAN))),
        };
        let cut_model::Props::Video(p) = &c.props else { continue };
        let scale = json!([mul(p.scale[0]), mul(p.scale[1])]);
        let cid = c.id.as_str();
        out.push(C::set_clip(
            id,
            cid,
            json!({ "props": { "scale": scale, "position": [0, 0] } }),
            json!({ "linked": false }),
        ));
        if let Some(list) = c.keyframes.get("scale").filter(|l| !l.is_empty()) {
            let list: Vec<Json> = list
                .iter()
                .map(|kf| {
                    let mut x = serde_json::to_value(kf).unwrap_or(Json::Null);
                    if let Some(v) = x.get("v").map(mul_json) {
                        x["v"] = v;
                    }
                    x
                })
                .collect();
            out.push(C::set_keyframes(id, cid, "scale", Some(Json::Array(list))));
        }
        if c.keyframes.get("position").is_some_and(|l| !l.is_empty()) {
            out.push(C::set_keyframes(id, cid, "position", None));
        }
    }
    out
}
