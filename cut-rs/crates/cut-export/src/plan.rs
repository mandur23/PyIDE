//! The pure parts of `export.js`: the frames of a range, captions cut to a range, YouTube chapter text and its
//! problems, the names of the files an export writes, and PSNR.

use cut_model::{Caption, Extra, Marker, MarkerKind};
use cut_time::{Fps, TICKS, Ticks, frame_at, frame_start};
use serde_json::Value as Json;

/// The frames of `[from, to)` (`framePlan`): every frame the range touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePlan {
    pub fps: Fps,
    /// The first frame's number in the sequence.
    pub first_frame: i64,
    pub count: i64,
    /// Where the first frame starts in the sequence.
    pub first: Ticks,
}

impl FramePlan {
    pub fn new(fps: Fps, from: Ticks, to: Ticks) -> Self {
        let first_frame = frame_at(from, fps);
        let frame = TICKS as f64 * f64::from(fps.den) / f64::from(fps.num);
        let last = first_frame.max((to as f64 / frame - 1e-9).ceil() as i64);
        Self { fps, first_frame, count: last - first_frame, first: frame_start(first_frame, fps) }
    }

    /// Where frame `i` of the plan starts in the sequence.
    pub fn time_of(&self, i: i64) -> Ticks {
        frame_start(self.first_frame + i, self.fps)
    }

    /// Frame `i`'s presentation time in the file (from 0).
    pub fn pts_of(&self, i: i64) -> Ticks {
        self.time_of(i) - self.first
    }

    /// Frame `i`'s length; frames of one rate differ by a tick at most where a frame is not a whole number of ticks.
    pub fn duration_of(&self, i: i64) -> Ticks {
        self.time_of(i + 1) - self.time_of(i)
    }
}

/// Captions of `[in, out)` moved to start at 0 and cut to the range (an item partly inside keeps the inside part).
pub fn captions_in_range(items: &[Caption], range: Option<(Ticks, Ticks)>) -> Vec<Caption> {
    let Some((a, b)) = range else { return items.to_vec() };
    items
        .iter()
        .filter_map(|x| {
            let (start, end) = (x.start.max(a), x.end.min(b));
            (end > start).then(|| Caption { start: start - a, end: end - a, ..x.clone() })
        })
        .collect()
}

/// The captions on screen at `t`.
pub fn captions_at(items: &[Caption], t: Ticks) -> Vec<&Caption> {
    items.iter().filter(|x| x.start <= t && t < x.end).collect()
}

/// JavaScript's truthiness, for fields another editor wrote.
fn truthy(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Json::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The items of a caption track with their speaker's name before the text, as an SRT file gets them
/// (`speakers.written`): only when the track's style has `speakerName` and the project has speaker labels. A speaker
/// with no name is `speaker` (`Speaker {n}`, translated) with its place in the list.
pub fn with_speakers(speakers: Option<&Json>, style: &Extra, items: Vec<Caption>, speaker: &str) -> Vec<Caption> {
    let list = speakers.and_then(|s| s.get("list")).and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
    if list.is_empty() || !truthy(style.get("speakerName")) {
        return items;
    }
    let name_of = |id: &str| {
        let i = list.iter().position(|s| s.get("id").and_then(Json::as_str) == Some(id))?;
        let own = list[i].get("name");
        Some(if truthy(own) {
            match own {
                Some(Json::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            }
        } else {
            speaker.replacen("{n}", &(i + 1).to_string(), 1)
        })
    };
    items
        .into_iter()
        .map(|mut it| {
            if let Some(name) = it.speaker.as_deref().filter(|id| !id.is_empty()).and_then(name_of) {
                it.text = format!("{name}: {}", it.text);
            }
            it
        })
        .collect()
}

/// YouTube chapter lines from the chapter markers: `MM:SS name` (`H:MM:SS` when the last one is past an hour). YouTube
/// wants the first at 0:00: one named `first_name` is added when there is none there. `range` counts from its in point.
pub fn chapters(markers: &[Marker], first_name: &str, range: Option<(Ticks, Ticks)>) -> String {
    let (from, to) = range.unwrap_or((0, Ticks::MAX));
    let mut list: Vec<(Ticks, String)> = markers
        .iter()
        .filter(|m| m.kind == MarkerKind::Chapter && m.t >= from && m.t < to)
        .map(|m| {
            let name = m.name.trim();
            (m.t - from, if name.is_empty() { "-".to_owned() } else { name.to_owned() })
        })
        .collect();
    list.sort_by_key(|c| c.0);
    let Some(first) = list.first() else { return String::new() };
    if first.0.div_euclid(TICKS) > 0 {
        list.insert(0, (0, first_name.to_owned()));
    }
    let hours = list.last().is_some_and(|c| c.0 >= 3600 * TICKS);
    let fmt = |t: Ticks| {
        let s = t.div_euclid(TICKS);
        let mm = (s / 60) % 60;
        if hours { format!("{}:{mm:02}:{:02}", s / 3600, s % 60) } else { format!("{:02}:{:02}", s / 60, s % 60) }
    };
    list.iter().map(|(t, name)| format!("{} {name}", fmt(*t))).collect::<Vec<_>>().join("\n")
}

/// What keeps YouTube from showing the chapters: English sentences for `tr()`.
pub fn chapter_problems(markers: &[Marker]) -> Vec<&'static str> {
    let mut t: Vec<Ticks> = markers.iter().filter(|m| m.kind == MarkerKind::Chapter).map(|m| m.t).collect();
    t.sort_unstable();
    let mut problems = Vec::new();
    if !t.is_empty() && t.len() < 3 {
        problems.push("YouTube shows chapters only when there are at least three.");
    }
    if t.windows(2).any(|w| w[1] - w[0] < 10 * TICKS) {
        problems.push("YouTube chapters must be at least 10 seconds long.");
    }
    problems
}

/// Where the extension of a path's last part starts, if it has one.
fn ext_start(path: &str) -> Option<usize> {
    let name = path.rfind(['\\', '/']).map_or(0, |i| i + 1);
    path[name..].rfind('.').map(|i| name + i)
}

/// The path with its extension replaced by `ext` (or `ext` added): an export file gets its preset's.
pub fn with_ext(path: &str, ext: &str) -> String {
    format!("{}.{ext}", &path[..ext_start(path).unwrap_or(path.len())])
}

/// The SRT file next to an export: `<name>.srt`, or `<name>.<lang>.srt` when the sequence has several caption tracks.
pub fn sidecar_path(path: &str, lang: Option<&str>, count: usize) -> String {
    let base = &path[..ext_start(path).unwrap_or(path.len())];
    match lang.filter(|l| count > 1 && !l.is_empty()) {
        Some(l) => format!("{base}.{l}.srt"),
        None => format!("{base}.srt"),
    }
}

/// PSNR in dB of two RGBA images over R, G and B; infinite for equal ones.
pub fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let (mut sum, mut n) = (0.0, 0.0);
    for (p, q) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0) {
        for c in 0..3 {
            let d = f64::from(p[c]) - f64::from(q[c]);
            sum += d * d;
        }
        n += 3.0;
    }
    if sum == 0.0 {
        return f64::INFINITY;
    }
    20.0 * 255f64.log10() - 10.0 * (sum / n).log10()
}
