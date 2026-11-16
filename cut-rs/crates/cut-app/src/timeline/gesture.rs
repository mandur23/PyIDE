//! The timeline's pointer gestures as pure functions from pointer positions to commands (port of `ui-timeline.js`'s
//! `onDown`, `selectClip`, `startMove`, `startTrim` and `razorAt`). The panel feeds them positions and modifier
//! keys; they answer what to select and which command object to run, so every rule is tested without a window.

use cut_model::{Id, Sequence, TrackKind};
use cut_time::{Fps, Ticks, snap};
use serde_json::Value as Json;

use super::layout::{Hit, Layout, Part, RowKind, View, frames_delta, snap_delta, snap_limit};
use crate::cmd;
use crate::state::Tool;

/// The modifier keys of a pointer event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

/// A pointer must move this far before a press becomes a move drag (`Math.hypot(...) < 4`).
pub const MOVE_SLOP: f64 = 4.0;
/// ... or a trim (`Math.abs(dx) < 2`).
pub const TRIM_SLOP: f64 = 2.0;

/// What a click on clip `c` selects (`partnersOf`): its group always, what they link to with Linked Selection on,
/// only `c` with Alt.
pub fn partners(seq: &Sequence, c: Id, alt: bool, linked: bool) -> Vec<Id> {
    if alt {
        return vec![c];
    }
    let Some(clip) = seq.clip(c) else { return vec![c] };
    let mut out = vec![c];
    if let Some(g) = clip.group {
        out.extend(seq.clips().filter(|x| x.group == Some(g) && x.id != c).map(|x| x.id));
    }
    if linked {
        for id in out.clone() {
            if let Some(l) = seq.clip(id).and_then(|x| x.link) {
                for x in seq.clips() {
                    if x.link == Some(l) && !out.contains(&x.id) {
                        out.push(x.id);
                    }
                }
            }
        }
    }
    out
}

/// A change of the selection: replace it, add to it, or take some out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selecting {
    Keep,
    Set(Vec<Id>),
    Add(Vec<Id>),
    Remove(Vec<Id>),
}

/// What a click on a clip does to the selection right away (`selectClip`; Ctrl and a click on a selected clip
/// decide on release instead: [`release_selection`]).
pub fn press_selection(seq: &Sequence, selection: &[Id], c: Id, m: Mods, linked: bool) -> Selecting {
    if m.ctrl {
        return Selecting::Keep;
    }
    let group = partners(seq, c, m.alt, linked);
    let selected = selection.contains(&c);
    if m.shift {
        if selected { Selecting::Remove(group) } else { Selecting::Add(group) }
    } else if selected {
        Selecting::Keep
    } else {
        Selecting::Set(group)
    }
}

/// What a click on a clip that did not become a drag does on release: Ctrl toggles the clip's partners, a plain click
/// on a selected clip selects just it and its partners.
pub fn release_selection(seq: &Sequence, selection: &[Id], c: Id, m: Mods, linked: bool) -> Selecting {
    let group = partners(seq, c, m.alt, linked);
    if m.ctrl {
        if selection.contains(&c) { Selecting::Remove(group) } else { Selecting::Add(group) }
    } else if !m.shift && selection.contains(&c) {
        Selecting::Set(group)
    } else {
        Selecting::Keep
    }
}

/// The clips Track Select Forward / Backward picks at time `t` (Shift: only the track under the pointer).
pub fn track_select(seq: &Sequence, t: f64, forward: bool, only: Option<Id>) -> Vec<Id> {
    seq.clips_in_order()
        .filter(|c| only.is_none_or(|tr| c.track == tr))
        .filter(|c| if forward { c.end() as f64 > t } else { (c.start as f64) < t })
        .map(|c| c.id)
        .collect()
}

/// The trim mode an edge press starts: the Ripple and Rolling tools, Ctrl for a ripple with the Selection tool.
pub fn trim_mode(tool: Tool, m: Mods) -> &'static str {
    match tool {
        Tool::Ripple => "ripple",
        Tool::Roll => "roll",
        _ if m.ctrl => "ripple",
        _ => "normal",
    }
}

/// The razor's cut (`razorAt`): at the frame nearest the pointer, snapped when snapping is on; Shift cuts every track,
/// Alt only the clip under the pointer and not its link.
pub fn razor(seq: &Sequence, h: &Hit, m: Mods, fps: Fps, pts: Option<(&[Ticks], f64)>) -> Option<Json> {
    let clip = h.clip?;
    let mut t = snap(h.t.max(0.0).round() as Ticks, fps, true);
    if let Some((pts, lim)) = pts {
        t += snap_delta(&[t], 0, pts, lim).0;
    }
    Some(if m.shift { cmd::split_all(seq.id, t, !m.alt) } else { cmd::split_clips(seq.id, t, &[clip], !m.alt) })
}

/// A move drag (`startMove`): ghosts follow the pointer in whole frames, snapped, and change rows only within the
/// grabbed clip's kind; one command on release.
#[derive(Debug, Clone)]
pub struct MoveDrag {
    pub clips: Vec<Id>,
    pub grabbed: Id,
    kind: RowKind,
    grab_row: usize,
    min_idx: usize,
    max_idx: usize,
    kind_rows: usize,
    min_start: Ticks,
    cands: [Ticks; 4],
    pts: Vec<Ticks>,
    x0: f64,
    y0: f32,
    scroll0: f64,
    pub moved: bool,
    pub delta: Ticks,
    pub rows: i64,
    pub guide: Option<Ticks>,
}

impl MoveDrag {
    /// Starts a drag of the selection (or of `grabbed` alone when nothing is selected) at lane point `(x, y)`.
    pub fn new(
        seq: &Sequence,
        layout: &Layout,
        selection: &[Id],
        grabbed: Id,
        pts: Vec<Ticks>,
        (x, y): (f64, f32),
        view: &View,
    ) -> Option<MoveDrag> {
        let g = seq.clip(grabbed)?;
        let mut clips: Vec<Id> = if selection.is_empty() { vec![grabbed] } else { selection.to_vec() };
        clips.retain(|id| seq.clip(*id).is_some());
        if !clips.contains(&grabbed) {
            clips.push(grabbed);
        }
        let all = clips.iter().filter_map(|id| seq.clip(*id));
        let min_start = all.clone().map(|c| c.start).min()?;
        let max_end = all.map(|c| c.end()).max()?;
        let grab_row = layout.row_of(g.track)?;
        let kind = grab_row.kind;
        let idxs: Vec<usize> = clips
            .iter()
            .filter_map(|id| seq.clip(*id))
            .filter_map(|c| layout.row_of(c.track))
            .filter(|r| r.kind == kind)
            .map(|r| r.index)
            .collect();
        Some(MoveDrag {
            grabbed,
            kind,
            grab_row: grab_row.index,
            min_idx: idxs.iter().copied().min().unwrap_or(0),
            max_idx: idxs.iter().copied().max().unwrap_or(0),
            kind_rows: layout.rows.iter().filter(|r| r.kind == kind).count(),
            min_start,
            cands: [min_start, max_end, g.start, g.end()],
            pts,
            x0: x,
            y0: y,
            scroll0: view.scroll_x,
            moved: false,
            delta: 0,
            rows: 0,
            guide: None,
            clips,
        })
    }

    /// The pointer is at lane point `(x, y)`; `snapping` is the toggle (Shift inverts it, as the JavaScript does).
    pub fn step(&mut self, layout: &Layout, view: &View, (x, y): (f64, f32), m: Mods, snapping: bool, frame: Ticks) {
        if !self.moved && (x - self.x0).hypot(f64::from(y - self.y0)) < MOVE_SLOP {
            return;
        }
        self.moved = true;
        let mut delta = frames_delta((x + view.scroll_x) - (self.x0 + self.scroll0), view.pps, frame);
        if self.min_start + delta < 0 {
            delta = -self.min_start;
        }
        let (d, at) = if snapping != m.shift {
            snap_delta(&self.cands, delta, &self.pts, snap_limit(view.pps))
        } else {
            (delta, None)
        };
        self.delta = d.max(-self.min_start);
        self.guide = at;
        let grab_y = layout.rows.iter().find(|r| r.kind == self.kind && r.index == self.grab_row).map_or(0.0, |r| r.y);
        let mut dr: i64 = 0;
        if let Some(pr) = layout.row_at(y + view.scroll_y) {
            if pr.kind == self.kind {
                dr = pr.index as i64 - self.grab_row as i64;
            } else if (pr.y < grab_y && self.kind == RowKind::Audio) || (pr.y > grab_y && self.kind == RowKind::Video) {
                // over the other kind's tracks: as far toward them as this kind goes (V1 or A1)
                dr = -(self.grab_row as i64);
            }
        }
        // Rows are counted from V1 / A1 upward for video (the row index), so moving up a video row is +1.
        let lo = -(self.min_idx as i64);
        let hi = self.kind_rows as i64 - 1 - self.max_idx as i64;
        self.rows = dr.clamp(lo, hi.max(lo));
    }

    /// The command on release, or `None` when nothing moved. Alt at the drop copies instead (built by the caller
    /// from the clips' JSON: [`MoveDrag::copy`]).
    pub fn finish(&self, seq: &Sequence, m: Mods) -> Option<Json> {
        if !self.moved || (self.delta == 0 && self.rows == 0) || m.alt {
            return None;
        }
        let td = if self.kind == RowKind::Video { (self.rows, 0) } else { (0, self.rows) };
        Some(cmd::move_clips(seq.id, &self.clips, self.delta, td, m.ctrl, false))
    }

    /// Alt+drag: copies of the clips pasted at the drop, linked and grouped among themselves (`C.paste`).
    pub fn copy(&self, seq: &Sequence, m: Mods) -> Option<Json> {
        if !self.moved || !m.alt {
            return None;
        }
        let mut copies = Vec::new();
        let mut lowest = [usize::MAX; 2];
        for id in &self.clips {
            let c = seq.clip(*id)?;
            let track = seq.track(c.track)?;
            let k = usize::from(track.kind == TrackKind::Audio);
            let index = seq.tracks.iter().filter(|t| t.kind == track.kind).position(|t| t.id == track.id)?;
            lowest[k] = lowest[k].min(index);
            let mut v = serde_json::to_value(c).ok()?;
            v["kind"] = Json::from(if k == 0 { "video" } else { "audio" });
            v["trackIndex"] = Json::from(index);
            copies.push(v);
        }
        let track_at = |k: usize| -> Option<Id> {
            if lowest[k] == usize::MAX {
                return None;
            }
            let kind = if k == 0 { TrackKind::Video } else { TrackKind::Audio };
            let own = (k == 0) == (self.kind == RowKind::Video);
            let i = lowest[k] as i64 + if own { self.rows } else { 0 };
            seq.tracks.iter().filter(|t| t.kind == kind).nth(usize::try_from(i).ok()?).map(|t| t.id)
        };
        Some(cmd::paste(seq.id, copies, self.min_start + self.delta, track_at(0), track_at(1), m.ctrl))
    }
}

/// A trim drag (`startTrim`): the command is applied live inside a history group on every step.
#[derive(Debug, Clone)]
pub struct TrimDrag {
    pub clip: Id,
    pub edge: Part,
    pub mode: &'static str,
    pub linked: bool,
    /// The edit point when the drag started.
    pub pos: Ticks,
    pts: Vec<Ticks>,
    x0: f64,
    scroll0: f64,
    pub moved: bool,
    pub guide: Option<Ticks>,
}

impl TrimDrag {
    /// `pts` are the snap points without this clip, its links and (rolling) its partner: [`trim_exclude`].
    pub fn new(
        seq: &Sequence,
        clip: Id,
        (edge, mode): (Part, &'static str),
        m: Mods,
        pts: Vec<Ticks>,
        x: f64,
        view: &View,
    ) -> Option<TrimDrag> {
        let c = seq.clip(clip)?;
        let pos = if edge == Part::Start { c.start } else { c.end() };
        Some(TrimDrag {
            clip,
            edge,
            mode,
            linked: !m.alt,
            pos,
            pts,
            x0: x,
            scroll0: view.scroll_x,
            moved: false,
            guide: None,
        })
    }

    /// The trim command for the pointer at lane x, or `None` before it moved.
    pub fn step(&mut self, seq: &Sequence, view: &View, x: f64, m: Mods, snapping: bool, frame: Ticks) -> Option<Json> {
        if !self.moved && (x - self.x0).abs() < TRIM_SLOP {
            return None;
        }
        self.moved = true;
        let delta = frames_delta(x + view.scroll_x - (self.x0 + self.scroll0), view.pps, frame);
        let (delta, at) = if snapping != m.shift {
            snap_delta(&[self.pos], delta, &self.pts, snap_limit(view.pps))
        } else {
            (delta, None)
        };
        self.guide = at;
        let edge = if self.edge == Part::Start { "start" } else { "end" };
        Some(cmd::trim(seq.id, self.clip, edge, delta, self.mode, self.linked))
    }
}

/// The clips a trim's snapping leaves out: the clip, what it links to, and the rolling partner.
pub fn trim_exclude(seq: &Sequence, clip: Id, edge: Part, mode: &str) -> Vec<Id> {
    let Some(c) = seq.clip(clip) else { return vec![clip] };
    let mut out = vec![clip];
    if let Some(l) = c.link {
        out.extend(seq.clips().filter(|x| x.link == Some(l) && x.id != clip).map(|x| x.id));
    }
    if mode == "roll" {
        let pos = if edge == Part::End { c.end() } else { c.start };
        if let Some(p) = seq.clips().find(|x| {
            x.id != clip && x.track == c.track && if edge == Part::End { x.start == pos } else { x.end() == pos }
        }) {
            out.push(p.id);
        }
    }
    out
}

/// What a press with the primary button starts.
#[derive(Debug, Clone, PartialEq)]
pub enum Press {
    Nothing,
    /// Hand tool (or the middle button): the view follows the pointer.
    Hand,
    /// Zoom tool: zoom in (out with Alt) around the time under the pointer.
    Zoom {
        t: f64,
        factor: f64,
    },
    Razor(Json),
    /// Track select: select these and start a move drag of them.
    TrackSelect(Vec<Id>, Option<Id>),
    Trim {
        clip: Id,
        edge: Part,
        mode: &'static str,
    },
    Move {
        clip: Id,
    },
    /// An empty spot: clear the selection (unless Shift) and start a marquee.
    Empty,
}

/// The decision of `onDown` for a press at `h` with `tool`.
pub fn press(
    seq: &Sequence,
    layout: &Layout,
    h: &Hit,
    tool: Tool,
    m: Mods,
    fps: Fps,
    snap_pts: Option<(&[Ticks], f64)>,
) -> Press {
    match tool {
        Tool::Hand => return Press::Hand,
        Tool::Zoom => return Press::Zoom { t: h.t, factor: if m.alt { 0.5 } else { 2.0 } },
        Tool::Razor => {
            return h.clip.and_then(|_| razor(seq, h, m, fps, snap_pts)).map_or(Press::Nothing, Press::Razor);
        }
        Tool::TrackForward | Tool::TrackBackward => {
            let only = if m.shift { h.row.and_then(|i| layout.rows[i].id) } else { None };
            let pick = track_select(seq, h.t, tool == Tool::TrackForward, only);
            let grab = h.clip.filter(|c| pick.contains(c)).or_else(|| pick.first().copied());
            return Press::TrackSelect(pick, grab);
        }
        _ => {}
    }
    match (h.clip, h.part) {
        (Some(clip), Some(edge @ (Part::Start | Part::End)))
            if matches!(tool, Tool::Select | Tool::Ripple | Tool::Roll) =>
        {
            Press::Trim { clip, edge, mode: trim_mode(tool, m) }
        }
        (Some(clip), _) => Press::Move { clip },
        (None, _) => Press::Empty,
    }
}
