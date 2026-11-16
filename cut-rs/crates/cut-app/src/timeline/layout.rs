//! The timeline's geometry, without a window (port of `ui-timeline.js`'s rows, `xOf`/`tOf`, `hit`, `points` and
//! `snapDelta`): rows from the sequence (captions, video tracks top down from the highest, a divider, audio tracks),
//! a per-track index of clip spans sorted by start so only what is on screen is looked at, hit testing of a pointer
//! position and snapping.

use std::collections::HashMap;

use cut_model::{Id, Sequence, TrackKind};
use cut_time::{TICKS, Ticks};

/// Height of the time ruler (`RULER_H`).
pub const RULER_H: f32 = 30.0;
/// Height of a caption track row (`CAPTION_H`).
pub const CAPTION_H: f32 = 28.0;
/// The gap between video and audio tracks (`DIVIDER`).
pub const DIVIDER: f32 = 6.0;
/// How near a clip edge grabs it, in points (`EDGE`).
pub const EDGE: f32 = 7.0;
/// How near a time snaps, in points (`SNAP_PX`).
pub const SNAP_PX: f64 = 8.0;
/// Width of the track headers (`.cut-tl-main` 168px column).
pub const HEADER_W: f32 = 168.0;
/// Track heights the keys and the header drag allow (`TRACK_H`).
pub const TRACK_MIN: f32 = 24.0;
pub const TRACK_MAX: f32 = 240.0;
pub const TRACK_STEP: f32 = 16.0;
pub const TRACK_EXPANDED: f32 = 100.0;

/// What a row shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Caption,
    Video,
    Divider,
    Audio,
}

/// One row of the timeline, in content coordinates (y from the top of the first row).
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub kind: RowKind,
    /// The track (or caption track) id.
    pub id: Option<Id>,
    /// The index among the tracks of its kind (V1 = 0).
    pub index: usize,
    pub y: f32,
    pub h: f32,
}

/// A clip's place on its track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub id: Id,
    pub start: Ticks,
    pub end: Ticks,
}

/// The rows and the clip index of a sequence, rebuilt when the project's revision changes.
#[derive(Debug, Clone, Default)]
pub struct Layout {
    pub rows: Vec<Row>,
    /// Track id -> its clips, sorted by start.
    pub spans: HashMap<Id, Vec<Span>>,
    pub content_h: f32,
    /// The sequence's end.
    pub end: Ticks,
}

impl Layout {
    pub fn of(seq: &Sequence) -> Layout {
        let mut rows = Vec::new();
        let mut y = 0.0;
        for ct in &seq.captions {
            rows.push(Row { kind: RowKind::Caption, id: Some(ct.id), index: 0, y, h: CAPTION_H });
            y += CAPTION_H;
        }
        let vids: Vec<_> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).collect();
        for (i, t) in vids.iter().enumerate().rev() {
            let h = t.height as f32;
            rows.push(Row { kind: RowKind::Video, id: Some(t.id), index: i, y, h });
            y += h;
        }
        rows.push(Row { kind: RowKind::Divider, id: None, index: 0, y, h: DIVIDER });
        y += DIVIDER;
        for (i, t) in seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).enumerate() {
            let h = t.height as f32;
            rows.push(Row { kind: RowKind::Audio, id: Some(t.id), index: i, y, h });
            y += h;
        }
        let mut spans: HashMap<Id, Vec<Span>> = seq.tracks.iter().map(|t| (t.id, Vec::new())).collect();
        let mut end = 0;
        for c in seq.clips() {
            let e = c.end();
            end = end.max(e);
            if let Some(list) = spans.get_mut(&c.track) {
                list.push(Span { id: c.id, start: c.start, end: e });
            }
        }
        for list in spans.values_mut() {
            list.sort_by_key(|s| (s.start, s.end));
        }
        Layout { rows, spans, content_h: y + 40.0, end }
    }

    /// The row at content height `y`.
    pub fn row_at(&self, y: f32) -> Option<&Row> {
        self.rows.iter().find(|r| y >= r.y && y < r.y + r.h)
    }

    pub fn row_of(&self, track: Id) -> Option<&Row> {
        self.rows.iter().find(|r| r.id == Some(track) && matches!(r.kind, RowKind::Video | RowKind::Audio))
    }

    /// The clips of a track that overlap `[a, b]`: a binary search, then a walk while clips start before `b`.
    ///
    /// Clips of one track never overlap, so their ends are sorted as their starts are.
    pub fn visible(&self, track: Id, a: Ticks, b: Ticks) -> &[Span] {
        let Some(list) = self.spans.get(&track) else { return &[] };
        let from = list.partition_point(|s| s.end < a);
        let to = from + list[from..].partition_point(|s| s.start <= b);
        &list[from..to]
    }

    /// Every clip edge on the tracks, with the playhead and the sequence's In/Out and markers (`points`), sorted.
    pub fn snap_points(
        &self,
        seq: &Sequence,
        playhead: Ticks,
        in_out: [Option<Ticks>; 2],
        exclude: &[Id],
    ) -> Vec<Ticks> {
        let mut pts = vec![playhead];
        pts.extend(in_out.iter().flatten());
        for m in &seq.markers {
            pts.push(m.t);
            if m.duration > 0 {
                pts.push(m.t + m.duration);
            }
        }
        for list in self.spans.values() {
            for s in list {
                if !exclude.contains(&s.id) {
                    pts.push(s.start);
                    pts.push(s.end);
                }
            }
        }
        for c in seq.clips() {
            if exclude.contains(&c.id) {
                continue;
            }
            for mk in c.markers.iter().flatten() {
                pts.push(c.start + mk.t);
            }
        }
        pts.sort_unstable();
        pts
    }
}

/// The horizontal mapping: points per second and the scroll.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    /// Points on screen for one second (`pps`).
    pub pps: f64,
    /// Content points scrolled off the left.
    pub scroll_x: f64,
    pub scroll_y: f32,
}

impl Default for View {
    fn default() -> Self {
        View { pps: 60.0, scroll_x: 0.0, scroll_y: 0.0 }
    }
}

impl View {
    /// The x (from the lanes' left edge) of a time (`xOf`).
    pub fn x_of(&self, t: Ticks) -> f64 {
        t as f64 / TICKS as f64 * self.pps - self.scroll_x
    }

    /// The time at an x (`tOf`).
    pub fn t_of(&self, x: f64) -> f64 {
        (x + self.scroll_x) / self.pps * TICKS as f64
    }

    /// The length of a duration on screen (`pxOf`).
    pub fn px(&self, d: Ticks) -> f64 {
        d as f64 / TICKS as f64 * self.pps
    }

    /// Zooms to `pps` keeping time `t` at screen `x`.
    pub fn zoom_to(&mut self, pps: f64, anchor_t: Ticks, anchor_x: f64) {
        self.pps = pps;
        self.scroll_x = (anchor_t as f64 / TICKS as f64 * pps - anchor_x).max(0.0);
    }
}

/// The least zoom (`minPps`): a quarter of the view shows the sequence (at least a minute).
pub fn min_pps(view_w: f64, seq_end: Ticks) -> f64 {
    let d = seq_end.max(60 * TICKS) as f64 / TICKS as f64;
    (view_w * 0.25 / d).clamp(1e-3, 5.0)
}

/// The most zoom (`maxPps`): 80 points a frame, and content no wider than 30 million points.
pub fn max_pps(view_w: f64, seq_end: Ticks, fps: f64) -> f64 {
    let longest = seq_end.max(60 * TICKS) as f64 / TICKS as f64;
    (80.0 * fps).min(30e6 / (longest * 1.5)).max(min_pps(view_w, seq_end) * 2.0)
}

/// What a pointer position is over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Start,
    End,
    Body,
}

/// The result of [`hit`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    /// The time under the pointer.
    pub t: f64,
    /// The index of the row in [`Layout::rows`].
    pub row: Option<usize>,
    pub clip: Option<Id>,
    pub part: Option<Part>,
}

/// What is under `(x, y)` in lane coordinates (x from the lanes' left edge, y from the top below the ruler): a clip
/// edge within [`EDGE`] (at most a third of the clip) wins over the body, the nearer edge over the farther, and at
/// a cut between two clips the edge on the side of the pointer (`hit`'s `near` rule).
pub fn hit(layout: &Layout, view: &View, x: f64, y: f32) -> Hit {
    let t = view.t_of(x);
    let row_i = layout.rows.iter().position(|r| y + view.scroll_y >= r.y && y + view.scroll_y < r.y + r.h);
    let mut out = Hit { t, row: row_i, clip: None, part: None };
    let Some(row) = row_i.map(|i| &layout.rows[i]) else { return out };
    if !matches!(row.kind, RowKind::Video | RowKind::Audio) {
        return out;
    }
    let Some(track) = row.id else { return out };
    let edge = f64::from(EDGE);
    let a = view.t_of(x - edge).floor() as Ticks;
    let b = view.t_of(x + edge).ceil() as Ticks;
    let mut under: Option<Id> = None;
    // (clip, edge, distance, pointer inside the clip)
    let mut near: Option<(Id, Part, f64, bool)> = None;
    for s in layout.visible(track, a, b) {
        let xa = view.x_of(s.start);
        let xb = view.x_of(s.end);
        let zone = edge.min((xb - xa) / 3.0);
        if x >= xa && x < xb {
            under = Some(s.id);
        }
        let da = (x - xa).abs();
        if da <= zone && near.is_none_or(|n| da < n.2) {
            near = Some((s.id, Part::Start, da, x >= xa));
        }
        let db = (x - xb).abs();
        if db <= zone && near.is_none_or(|n| db < n.2 || (db == n.2 && x < xb)) {
            near = Some((s.id, Part::End, db, x < xb));
        }
    }
    if let Some((id, part, d, inside)) = near
        && (under.is_none() || under == Some(id) || !inside || d < 3.0)
    {
        out.clip = Some(id);
        out.part = Some(part);
        return out;
    }
    if let Some(id) = under {
        out.clip = Some(id);
        out.part = Some(Part::Body);
    }
    out
}

/// The snap of times `cands` moved by `delta` to the nearest of `pts` within `lim` ticks (`snapDelta`): the new
/// delta and the time of the guide line, or the delta as it was.
pub fn snap_delta(cands: &[Ticks], delta: Ticks, pts: &[Ticks], lim: f64) -> (Ticks, Option<Ticks>) {
    let mut best: Option<(Ticks, Ticks)> = None;
    for &c in cands {
        let want = c + delta;
        let lo = pts.partition_point(|&p| p < want);
        for i in [lo.wrapping_sub(1), lo] {
            let Some(&p) = pts.get(i) else { continue };
            let d = p - want;
            if (d.abs() as f64) <= lim && best.is_none_or(|(bd, _)| d.abs() < bd.abs()) {
                best = Some((d, p));
            }
        }
    }
    match best {
        Some((d, at)) => (delta + d, Some(at)),
        None => (delta, None),
    }
}

/// The snap limit in ticks at a zoom.
pub fn snap_limit(pps: f64) -> f64 {
    SNAP_PX / pps * TICKS as f64
}

/// A pointer movement as a whole number of frames (`Math.round(dx / pps * T / f) * f`).
pub fn frames_delta(dx: f64, pps: f64, frame: Ticks) -> Ticks {
    let f = frame.max(1);
    (dx / pps * TICKS as f64 / f as f64).round() as Ticks * f
}

/// The clip edges of `tracks` (all when `None`), sorted and without repeats: what the edit point keys go through.
pub fn edit_points(layout: &Layout, tracks: Option<&[Id]>) -> Vec<Ticks> {
    let mut pts: Vec<Ticks> = layout
        .spans
        .iter()
        .filter(|(id, _)| tracks.is_none_or(|t| t.contains(id)))
        .flat_map(|(_, l)| l.iter().flat_map(|s| [s.start, s.end]))
        .collect();
    pts.sort_unstable();
    pts.dedup();
    pts
}
