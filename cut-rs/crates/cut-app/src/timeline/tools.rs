//! The tools and handles that edit a clip live while the pointer moves (port of `ui-timeline.js`'s `startStretch`,
//! `startSlipSlide`, `startPen`, `startFade`, `startBand`, `addRemapKey`, `startRemapBand`, `startRemapKey`,
//! `startTransitionDrag` and `startMarkerDrag`), as pure functions from pointer positions and modifier keys to
//! commands. [`press`] decides what a press starts; a [`Live`] answers the command for each pointer position, which
//! the panel applies inside one history group (cancel and do again on every step, commit on release).

use cut_model::keyframes::{self as K, Ease, Keyframe, Value};
use cut_model::remap::{self as R, Segment, Side};
use cut_model::{Id, Project, Sequence, TrackKind};
use cut_time::{TICKS, Ticks, timecode};
use serde_json::{Value as Json, json};

use super::bands::{self, Extra, Half, Line, TPart};
use super::gesture::Mods;
use super::layout::{Hit, Layout, Part, View, snap_delta, snap_limit};
use crate::edit::Band;
use crate::i18n::tr;
use crate::state::Tool;
use cut_model::commands::build as C;

/// `Math.round`: halves up, below zero too.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// A pointer movement as whole frames, rounded as the JavaScript rounds.
fn frames(dx: f64, pps: f64, f: Ticks) -> Ticks {
    js_round(dx / pps * TICKS as f64 / f as f64) as Ticks * f
}

/// A time as a whole frame of a clip, inside `[lo, hi]`.
fn frame_in(t: f64, f: Ticks, lo: Ticks, hi: Ticks) -> Ticks {
    (js_round(t / f as f64) as Ticks * f).clamp(lo, hi.max(lo))
}

/// What a Ctrl, Alt or plain drag of a speed key does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyMode {
    Split,
    Move,
    Slide,
    Reverse,
    Hold,
}

/// The edit a live drag makes.
#[derive(Debug, Clone)]
pub enum LiveKind {
    Stretch {
        clip: Id,
        edge: Part,
        pos: Ticks,
    },
    Slip {
        clip: Id,
    },
    Slide {
        clip: Id,
        s0: Ticks,
        e0: Ticks,
    },
    /// The Pen's new keyframe `index` of `next`, dragged on.
    Pen {
        clip: Id,
        prop: &'static str,
        next: Vec<Keyframe>,
        index: usize,
        dur: Ticks,
        start: Ticks,
    },
    Fade {
        clip: Id,
        out: bool,
        base: Ticks,
    },
    /// The keyframe line, or one of its keyframes.
    Line {
        clip: Id,
        prop: &'static str,
        list: Vec<Keyframe>,
        index: Option<usize>,
        v0: f64,
        dur: Ticks,
        start: Ticks,
    },
    RemapLine {
        clip: Id,
        base: R::Remap,
        seg: usize,
        old: f64,
    },
    RemapKey {
        clip: Id,
        base: R::Remap,
        index: usize,
        mode: KeyMode,
        half: Half,
    },
    TransitionLength {
        id: Id,
        duration: Ticks,
        k: f64,
        sign: f64,
    },
    /// The transition's body dragged along the cut: its alignment is the one whose span is nearest the pointer's.
    TransitionAlign {
        id: Id,
        at: Ticks,
        duration: Ticks,
        align: cut_model::Align,
    },
}

/// A live drag: its edit, where it started, and what the tip says.
#[derive(Debug, Clone)]
pub struct Live {
    pub kind: LiveKind,
    /// The undo step's name.
    pub label: &'static str,
    linked: bool,
    pts: Vec<Ticks>,
    x0: f64,
    y0: f32,
    scroll0: f64,
    /// The clip's row in content coordinates (top, height) for the lines.
    row: (f32, f32),
    pub moved: bool,
    /// A Pen keyframe stays even when the pointer did not move.
    pub keep_unmoved: bool,
    pub guide: Option<Ticks>,
    note: String,
}

impl Live {
    fn new(kind: LiveKind, label: &'static str, linked: bool, pts: Vec<Ticks>, at: (f64, f32), view: &View) -> Live {
        Live {
            kind,
            label,
            linked,
            pts,
            x0: at.0,
            y0: at.1,
            scroll0: view.scroll_x,
            row: (0.0, 0.0),
            moved: false,
            keep_unmoved: false,
            guide: None,
            note: String::new(),
        }
    }

    fn with_row(mut self, row: (f32, f32)) -> Live {
        self.row = row;
        self
    }

    fn line_box(&self, view: &View) -> (f32, f32) {
        (self.row.0 - view.scroll_y + 1.0, self.row.1 - 3.0)
    }

    /// The command for the pointer at lane point `(x, y)`, or `None` while it has not moved far enough.
    pub fn step(
        &mut self,
        seq: &Sequence,
        view: &View,
        (x, y): (f64, f32),
        m: Mods,
        snapping: bool,
        f: Ticks,
    ) -> Option<Json> {
        let dx = x + view.scroll_x - (self.x0 + self.scroll0);
        let slop = match self.kind {
            LiveKind::Stretch { .. } | LiveKind::Slip { .. } | LiveKind::Slide { .. } => dx.abs() < 2.0,
            LiveKind::Pen { .. } => (x - self.x0).hypot(f64::from(y - self.y0)) < 3.0,
            LiveKind::RemapLine { .. } => (y - self.y0).abs() < 2.0,
            LiveKind::RemapKey { .. } | LiveKind::TransitionAlign { .. } => dx.abs() < 3.0,
            _ => false,
        };
        if !self.moved && slop {
            return None;
        }
        self.moved = true;
        let s = seq.id.as_str();
        let snap = |cands: &[Ticks], d: Ticks, pts: &[Ticks]| {
            if snapping != m.shift { snap_delta(cands, d, pts, snap_limit(view.pps)) } else { (d, None) }
        };
        let (ly, lh) = self.line_box(view);
        let linked = self.linked;
        Some(match &self.kind {
            LiveKind::Stretch { clip, edge, pos } => {
                let (d, at) = snap(&[*pos], frames(dx, view.pps, f), &self.pts);
                self.guide = at;
                let edge = if *edge == Part::Start { "start" } else { "end" };
                C::stretch(s, clip.as_str(), json!({ "edge": edge, "delta": d, "linked": linked }))
            }
            LiveKind::Slip { clip } => {
                C::slip(s, clip.as_str(), json!({ "delta": -frames(dx, view.pps, f), "linked": linked }))
            }
            LiveKind::Slide { clip, s0, e0 } => {
                let (d, at) = snap(&[*s0, *e0], frames(dx, view.pps, f), &self.pts);
                self.guide = at;
                C::slide(s, clip.as_str(), json!({ "delta": d, "linked": linked }))
            }
            LiveKind::Pen { clip, prop, next, index, dur, start } => {
                let lo = if *index > 0 { next[index - 1].t + f } else { 0 };
                let hi = next.get(index + 1).map_or(dur - f, |k| k.t - f);
                let t2 = frame_in(view.t_of(x) - *start as f64, f, lo, hi);
                let v2 = bands::band_value(prop, y, ly, lh);
                let mut moved = next.clone();
                moved[*index] = Keyframe { t: t2, v: Value::Num(v2), ..next[*index].clone() };
                self.note = value_text(prop, v2);
                C::set_keyframes(s, clip.as_str(), prop, Some(json!(moved)))
            }
            LiveKind::Fade { clip, out, base } => {
                let d = if *out { -dx } else { dx };
                let val = ((js_round((*base as f64 + d / view.pps * TICKS as f64) / f as f64)) as Ticks * f).max(0);
                let fps = seq.fps;
                self.note = format!("{} {}", if *out { tr("Fade Out") } else { tr("Fade In") }, timecode(val, fps));
                let key = if *out { "fadeOut" } else { "fadeIn" };
                C::set_clip(s, clip.as_str(), json!({ key: val }), json!({ "linked": false }))
            }
            LiveKind::Line { clip, prop, list, index, v0, dur, start } => {
                let val = bands::band_value(prop, y, ly, lh);
                self.note = value_text(prop, val);
                match index {
                    None if !list.is_empty() => {
                        let dv = val - v0;
                        let next: Vec<Keyframe> = list
                            .iter()
                            .map(|k| {
                                let v = match k.v {
                                    Value::Num(v) => Value::Num(bands::clamp_band(prop, v + dv)),
                                    ref other => other.clone(),
                                };
                                Keyframe { v, ..k.clone() }
                            })
                            .collect();
                        C::set_keyframes(s, clip.as_str(), prop, Some(json!(next)))
                    }
                    None => {
                        C::set_clip(s, clip.as_str(), json!({ "props": { *prop: val } }), json!({ "linked": false }))
                    }
                    Some(i) => {
                        let lo = if *i > 0 { list[i - 1].t + f } else { 0 };
                        let hi = list.get(i + 1).map_or(dur - f, |k| k.t - f);
                        let kt = frame_in(view.t_of(x) - *start as f64, f, lo, hi);
                        let mut next = list.clone();
                        next[*i] = Keyframe { t: kt, v: Value::Num(val), ..list[*i].clone() };
                        C::set_keyframes(s, clip.as_str(), prop, Some(json!(next)))
                    }
                }
            }
            LiveKind::RemapLine { clip, base, seg, old } => {
                let pct = bands::remap_pct(y, ly, lh, if m.shift { 5.0 } else { 1.0 });
                let next = R::set_segment_speed(base, *seg, old.signum() * pct / 100.0, f);
                self.note = format!("{}{pct}%", if *old < 0.0 { "-" } else { "" });
                C::set_remap(s, clip.as_str(), Some(json!(next)))
            }
            LiveKind::RemapKey { clip, base, index, mode, half } => {
                let dt = frames(dx, view.pps, f);
                let i = *index;
                let fps = seq.fps;
                let next = match mode {
                    KeyMode::Split => {
                        let side = if *half == Half::Left { Side::Left } else { Side::Right };
                        let n = R::split_key(base, i, side, if *half == Half::Left { -dt } else { dt }, f);
                        self.note = format!(
                            "{} {}",
                            tr("Speed Transition"),
                            timecode(n.keys.get(i).map_or(0, |k| k.ramp), fps)
                        );
                        n
                    }
                    KeyMode::Move | KeyMode::Slide => {
                        let n = R::move_key(base, i, dt, f, *mode == KeyMode::Slide);
                        self.note = format!("{}%", js_round(n.speeds.get(i).copied().unwrap_or(0.0).abs() * 100.0));
                        n
                    }
                    KeyMode::Reverse | KeyMode::Hold => {
                        let len = if *mode == KeyMode::Reverse {
                            dt.max(0).min(R::reverse_room(base, i, f, 0.0) as Ticks)
                        } else {
                            dt.max(0)
                        };
                        let n = if len <= 0 {
                            base.clone()
                        } else if *mode == KeyMode::Reverse {
                            R::insert_reverse(base, i, len).unwrap_or_else(|| base.clone())
                        } else {
                            R::insert_freeze(base, i, len).unwrap_or_else(|| base.clone())
                        };
                        let what = if *mode == KeyMode::Reverse { tr("Reverse") } else { tr("Hold") };
                        self.note = format!("{what} {}", timecode(len, fps));
                        n
                    }
                };
                C::set_remap(s, clip.as_str(), Some(json!(next)))
            }
            LiveKind::TransitionLength { id, duration, k, sign } => {
                let d = dx * sign;
                let dur =
                    ((js_round((*duration as f64 + d / view.pps * TICKS as f64 * k) / f as f64)) as Ticks * f).max(f);
                self.note = format!("{} {}", tr("Duration"), timecode(dur, seq.fps));
                C::set_transition(s, id.as_str(), json!({ "duration": dur }))
            }
            LiveKind::TransitionAlign { id, at, duration, align } => {
                let a = align_for(*at, *duration, *align, dx / view.pps * TICKS as f64);
                self.note = format!("{}: {}", tr("Alignment"), tr(align_name(a)));
                C::set_transition(s, id.as_str(), json!({ "align": align_code(a) }))
            }
        })
    }

    /// The tip by the pointer after a step was applied: `r` is what the command answered, `now` the sequence after it.
    pub fn tip(&self, r: &Result<Json, cut_model::CommandError>, now: Option<&Sequence>) -> String {
        let why = match r {
            Err(e) => format!(" — {}", tr(&e.message)),
            Ok(v) => match v.get("clamped").and_then(Json::as_str) {
                Some(c) => format!(" — {}", tr(clamp_text(c))),
                None => String::new(),
            },
        };
        let applied = r.as_ref().ok().and_then(|v| v.get("applied")).and_then(Json::as_i64).unwrap_or(0);
        let fps = now.map_or(cut_time::Fps { num: 30, den: 1 }, |s| s.fps);
        let delta = |d: Ticks| format!("{}{}", if d < 0 { "-" } else { "+" }, timecode(d.abs(), fps));
        match &self.kind {
            LiveKind::Stretch { clip, .. } => {
                let speed = now.and_then(|s| s.clip(*clip)).map_or(1.0, |c| c.speed);
                format!("{} {}%{why}", tr("Rate Stretch"), js_round(speed * 1000.0) / 10.0)
            }
            LiveKind::Slip { .. } => format!("{} {}{why}", tr("Slip"), delta(-applied)),
            LiveKind::Slide { .. } => format!("{} {}{why}", tr("Slide"), delta(applied)),
            LiveKind::RemapLine { clip, .. } => {
                let d = now.and_then(|s| s.clip(*clip)).map_or(0, cut_model::Clip::duration);
                format!("{}  {}", self.note, timecode(d, fps))
            }
            _ => self.note.clone(),
        }
    }

    /// Whether the clip's source ran out during the drag (`d.clampedSource`: a toast on release).
    pub fn source_end(r: &Result<Json, cut_model::CommandError>) -> bool {
        r.as_ref().ok().and_then(|v| v.get("clamped")).and_then(Json::as_str) == Some("source")
    }
}

/// The alignment of a transition of `duration` at cut `at` whose span's middle is nearest where the grabbed one's middle
/// is after moving `dt` ticks (Start at Cut lies after the cut, End at Cut before it).
pub fn align_for(at: Ticks, duration: Ticks, from: cut_model::Align, dt: f64) -> cut_model::Align {
    use cut_model::Align as A;
    let mid = |a: A| match a {
        A::Start => at as f64 + duration as f64 / 2.0,
        A::Center => at as f64,
        A::End => at as f64 - duration as f64 / 2.0,
    };
    let want = mid(from) + dt;
    [A::End, A::Center, A::Start]
        .into_iter()
        .min_by(|a, b| (mid(*a) - want).abs().total_cmp(&(mid(*b) - want).abs()))
        .unwrap_or(from)
}

/// The menu's name of an alignment.
pub fn align_name(a: cut_model::Align) -> &'static str {
    match a {
        cut_model::Align::Center => "Center at Cut",
        cut_model::Align::Start => "Start at Cut",
        cut_model::Align::End => "End at Cut",
    }
}

/// The project file's name of an alignment.
pub fn align_code(a: cut_model::Align) -> &'static str {
    match a {
        cut_model::Align::Center => "center",
        cut_model::Align::Start => "start",
        cut_model::Align::End => "end",
    }
}

/// The reason a drag stopped (`CLAMPS`).
pub fn clamp_text(c: &str) -> &'static str {
    match c {
        "source" => "Source end",
        "neighbour" => "The next clip is in the way",
        "length" => "A clip is at least one frame long",
        "speed" => "Speed must be between 1% and 10000%.",
        _ => "Stopped",
    }
}

fn value_text(prop: &str, v: f64) -> String {
    if prop == "volume" { format!("{v:.1} dB") } else { format!("{}%", js_round(v)) }
}

/// What a press on the lanes does with these tools and handles; `None` leaves it to [`super::gesture::press`].
#[derive(Debug, Clone)]
pub enum Pressed {
    /// Select the clip as a click does (`selectClip`), then drag live; `first` is applied at once (the Pen's key).
    Live {
        select: Option<Id>,
        live: Live,
        first: Option<Json>,
    },
    /// Select the clip, then run one command.
    Exec {
        select: Option<Id>,
        cmd: Json,
    },
    /// Select the clip and say why nothing happens.
    Refuse {
        select: Option<Id>,
        why: &'static str,
    },
    /// Select a transition (the clips are deselected), dragging its edge (its length) or its body (its alignment).
    Transition {
        id: Id,
        live: Live,
    },
    /// The fx badge's menu.
    FxMenu(Id),
    Nothing,
}

/// The press's context: what the press is over and the panel's state.
pub struct At<'a> {
    pub project: &'a Project,
    pub seq: &'a Sequence,
    pub layout: &'a Layout,
    pub view: &'a View,
    pub bands: &'a std::collections::HashMap<Id, Band>,
    pub hit: &'a Hit,
    pub extra: Option<Extra>,
    pub pos: (f64, f32),
    pub frame: Ticks,
}

/// The decision of `onDown` for the tools and handles the plain gestures do not have, in the JavaScript's order.
pub fn press(at: &At, tool: Tool, m: Mods, snaps: &dyn Fn(&[Id]) -> Vec<Ticks>) -> Option<Pressed> {
    if matches!(tool, Tool::Hand | Tool::Zoom | Tool::Razor | Tool::Text | Tool::TrackForward | Tool::TrackBackward) {
        return None;
    }
    let (seq, view, f) = (at.seq, at.view, at.frame);
    let linked = !m.alt;
    if let Some(Extra::Transition { id, part }) = at.extra {
        let t = seq.transitions.iter().find(|t| t.id == id)?;
        let kind = if part == TPart::Body {
            LiveKind::TransitionAlign { id, at: t.at, duration: t.duration, align: t.align }
        } else {
            let k = if t.align == cut_model::Align::Center { 2.0 } else { 1.0 };
            let sign = if part == TPart::End { 1.0 } else { -1.0 };
            LiveKind::TransitionLength { id, duration: t.duration, k, sign }
        };
        let live = Live::new(kind, "Transition Settings", true, Vec::new(), at.pos, view);
        return Some(Pressed::Transition { id, live });
    }
    let clip_id = match at.extra {
        Some(
            Extra::Keyframe { clip, .. }
            | Extra::Fade { clip, .. }
            | Extra::RemapKey { clip, .. }
            | Extra::Fx(clip)
            | Extra::RemapLine(clip)
            | Extra::Line { clip, .. },
        ) => Some(clip),
        _ => at.hit.clip,
    };
    let c = seq.clip(clip_id?)?;
    let kind = seq.kind_of(c.track).unwrap_or(TrackKind::Video);
    let row = at.layout.row_of(c.track).map(|r| (r.y, r.h)).unwrap_or_default();
    let select = Some(c.id);
    let with_links = |extra: &[Id]| {
        let mut ex = vec![c.id];
        ex.extend(seq.linked_clips(c).iter().map(|x| x.id));
        ex.extend_from_slice(extra);
        ex
    };
    let live = |kind: LiveKind, label: &'static str, pts: Vec<Ticks>| {
        Live::new(kind, label, linked, pts, at.pos, view).with_row(row)
    };
    if matches!(tool, Tool::Slip | Tool::Slide) {
        let (s0, e0) = (c.start, c.end());
        let touching: Vec<Id> = seq
            .track(c.track)
            .map(|t| t.clips.iter().filter(|x| x.end() == s0 || x.start == e0).map(|x| x.id).collect())
            .unwrap_or_default();
        let pts = snaps(&with_links(&touching));
        let (kind, label) = if tool == Tool::Slip {
            (LiveKind::Slip { clip: c.id }, "Slip")
        } else {
            (LiveKind::Slide { clip: c.id, s0, e0 }, "Slide")
        };
        return Some(Pressed::Live { select, live: live(kind, label, pts), first: None });
    }
    let line = bands::line_of(at.project, c, kind, at.bands);
    if tool == Tool::Pen {
        return Some(match at.extra {
            Some(Extra::Keyframe { prop, index, .. }) => line_drag(at, c, prop, Some(index), m, select, &live),
            Some(Extra::RemapKey { index, half, .. }) => remap_key(c, index, half, m, select, &live),
            _ if line == Line::Remap => {
                if at.pos.1 > row.0 - view.scroll_y + 16.0 {
                    add_remap_key(seq, c, at.hit.t, f, select)
                } else {
                    Pressed::Nothing
                }
            }
            _ => pen(at, c, kind, row, select, &live),
        });
    }
    if tool == Tool::Rate && at.extra.is_none() && matches!(at.hit.part, Some(Part::Start | Part::End)) {
        let edge = at.hit.part.unwrap_or(Part::End);
        let pos = if edge == Part::Start { c.start } else { c.end() };
        let kind = LiveKind::Stretch { clip: c.id, edge, pos };
        return Some(Pressed::Live { select, live: live(kind, "Rate Stretch", snaps(&with_links(&[]))), first: None });
    }
    Some(match at.extra? {
        Extra::Keyframe { prop, index, .. } => line_drag(at, c, prop, Some(index), m, select, &live),
        Extra::Line { prop, .. } => line_drag(at, c, prop, None, m, select, &live),
        Extra::Fx(id) => Pressed::FxMenu(id),
        Extra::RemapKey { index, half, .. } => remap_key(c, index, half, m, select, &live),
        Extra::RemapLine(_) => {
            if m.ctrl {
                add_remap_key(seq, c, at.hit.t, f, select)
            } else {
                remap_line(c, at.hit.t, select, &live)
            }
        }
        Extra::Fade { out, .. } => {
            let base = if out { c.fade_out } else { c.fade_in };
            Pressed::Live {
                select,
                live: live(LiveKind::Fade { clip: c.id, out, base }, "Fade", Vec::new()),
                first: None,
            }
        }
        Extra::Transition { .. } => return None,
    })
}

type MakeLive<'a> = &'a dyn Fn(LiveKind, &'static str, Vec<Ticks>) -> Live;

fn keyframes_of(c: &cut_model::Clip, prop: &str) -> Vec<Keyframe> {
    c.keyframes.get(prop).cloned().unwrap_or_default()
}

/// The keyframe line's drag (`startBand`); Ctrl+click adds a keyframe of the line's value there instead.
fn line_drag(
    at: &At,
    c: &cut_model::Clip,
    prop: &'static str,
    index: Option<usize>,
    m: Mods,
    select: Option<Id>,
    live: MakeLive,
) -> Pressed {
    let f = at.frame;
    let list = keyframes_of(c, prop);
    let dur = c.duration();
    if m.ctrl {
        let kt = frame_in(at.hit.t - c.start as f64, f, 0, dur - f);
        let val = bands::value_at(c, prop, kt as f64);
        let ease = K::prev(&list, kt).map_or(Ease::Linear, |k| k.ease);
        let next = K::insert(&list, &Keyframe { t: kt, v: Value::Num(val), ease, h: None });
        return Pressed::Exec {
            select,
            cmd: C::set_keyframes(at.seq.id.as_str(), c.id.as_str(), prop, Some(json!(next))),
        };
    }
    let v0 = bands::value_at(c, prop, at.hit.t - c.start as f64);
    let kind = LiveKind::Line { clip: c.id, prop, list, index, v0, dur, start: c.start };
    Pressed::Live { select, live: live(kind, "Keyframes", Vec::new()), first: None }
}

/// The Pen's click in the keyframe area (`startPen`): a keyframe at that frame, on the line its value, elsewhere the
/// value of that height; dragging on moves it.
fn pen(at: &At, c: &cut_model::Clip, kind: TrackKind, row: (f32, f32), select: Option<Id>, live: MakeLive) -> Pressed {
    let ry = row.0 - at.view.scroll_y + 1.0;
    if !bands::shows_band(row.1) || at.pos.1 <= ry + 15.0 {
        return Pressed::Nothing;
    }
    let prop = bands::prop_of(kind);
    let f = at.frame;
    let dur = c.duration();
    let list = keyframes_of(c, prop);
    let kt = frame_in(at.hit.t - c.start as f64, f, 0, dur - f);
    let line_value = bands::value_at(c, prop, kt as f64);
    let h = row.1 - 3.0;
    let val = if (bands::band_y(prop, line_value, ry, h) - at.pos.1).abs() <= 3.0 {
        line_value
    } else {
        bands::band_value(prop, at.pos.1, ry, h)
    };
    let ease = K::prev(&list, kt).map_or(Ease::Linear, |k| k.ease);
    let next = K::insert(&list, &Keyframe { t: kt, v: Value::Num(val), ease, h: None });
    let index = next.iter().position(|k| k.t == kt).unwrap_or(0);
    let first = C::set_keyframes(at.seq.id.as_str(), c.id.as_str(), prop, Some(json!(next)));
    let mut l = live(LiveKind::Pen { clip: c.id, prop, next, index, dur, start: c.start }, "Keyframes", Vec::new());
    l.keep_unmoved = true;
    Pressed::Live { select, live: l, first: Some(first) }
}

/// A speed key at the clicked frame (`addRemapKey`).
fn add_remap_key(seq: &Sequence, c: &cut_model::Clip, t: f64, f: Ticks, select: Option<Id>) -> Pressed {
    let at = js_round((t - c.start as f64) / f as f64) as Ticks * f;
    match R::add_key(&c.remap_of(), at) {
        Some(next) => Pressed::Exec { select, cmd: C::set_remap(seq.id.as_str(), c.id.as_str(), Some(json!(next))) },
        None => Pressed::Refuse { select, why: "A speed keyframe cannot go there." },
    }
}

/// Dragging the Speed line sets the speed of the segment under the press (`startRemapBand`).
fn remap_line(c: &cut_model::Clip, t: f64, select: Option<Id>, live: MakeLive) -> Pressed {
    let base = c.remap_of();
    let tau = ((t - c.start as f64).max(0.0) as Ticks).min((c.duration() - 1).max(0));
    let Segment::Index(seg) = R::segment_at(&base, tau) else { return Pressed::Nothing };
    let old = base.speeds.get(seg).copied().unwrap_or(0.0);
    if old == 0.0 {
        return Pressed::Refuse { select, why: "A hold has no speed to change." };
    }
    Pressed::Live {
        select,
        live: live(LiveKind::RemapLine { clip: c.id, base, seg, old }, "Time Remapping", Vec::new()),
        first: None,
    }
}

/// Dragging a speed key (`startRemapKey`): a half splits it into a transition, the tab moves it (Alt keeping the
/// speeds), Ctrl makes a reverse segment, Ctrl+Alt a hold.
fn remap_key(c: &cut_model::Clip, index: usize, half: Half, m: Mods, select: Option<Id>, live: MakeLive) -> Pressed {
    let base = c.remap_of();
    let Some(k) = base.keys.get(index) else { return Pressed::Nothing };
    let mode = match (m.ctrl, m.alt) {
        (true, true) => KeyMode::Hold,
        (true, false) => KeyMode::Reverse,
        (false, true) => KeyMode::Slide,
        _ if half == Half::Tab => KeyMode::Move,
        _ => KeyMode::Split,
    };
    if matches!(mode, KeyMode::Hold | KeyMode::Reverse) && k.ramp > 0 {
        return Pressed::Refuse { select, why: "Join the speed transition first." };
    }
    let kind = LiveKind::RemapKey { clip: c.id, base, index, mode, half };
    Pressed::Live { select, live: live(kind, "Time Remapping", Vec::new()), first: None }
}

/// A marker grabbed on the ruler (`startMarkerDrag`): its flag moves it (a range keeps its length), a range's end
/// handle changes its length; whole frames, snapped; one `setMarker` on release, a click puts the playhead on it.
#[derive(Debug, Clone)]
pub struct MarkerDrag {
    pub id: Id,
    pub end: bool,
    t0: Ticks,
    dur0: Ticks,
    pts: Vec<Ticks>,
    x0: f64,
    pub moved: bool,
    pub t: Ticks,
    pub duration: Ticks,
    pub guide: Option<Ticks>,
}

impl MarkerDrag {
    /// `pts` are the snap points; the marker's own times are left out here.
    pub fn new(m: &cut_model::Marker, end: bool, pts: &[Ticks], x0: f64) -> MarkerDrag {
        let pts = pts.iter().copied().filter(|p| *p != m.t && *p != m.t + m.duration).collect();
        MarkerDrag {
            id: m.id,
            end,
            t0: m.t,
            dur0: m.duration,
            pts,
            x0,
            moved: false,
            t: m.t,
            duration: m.duration,
            guide: None,
        }
    }

    /// The pointer at ruler x; `snapping` is the toggle.
    pub fn step(&mut self, view: &View, x: f64, snapping: bool, f: Ticks) {
        let dx = x - self.x0;
        if !self.moved && dx.abs() < 3.0 {
            return;
        }
        self.moved = true;
        let own = if self.end { self.t0 + self.dur0 } else { self.t0 };
        let mut nt = (js_round((own as f64 + dx / view.pps * TICKS as f64) / f as f64) as Ticks * f).max(0);
        if snapping {
            nt += snap_delta(&[nt], 0, &self.pts, snap_limit(view.pps)).0;
        }
        if self.end {
            nt = nt.max(self.t0 + f);
            self.duration = nt - self.t0;
        } else {
            self.t = nt;
        }
        self.guide = Some(nt);
    }

    /// The command on release, or the time to put the playhead at for a click.
    pub fn finish(&self, seq: &Sequence) -> Result<Option<Json>, Ticks> {
        let s = seq.id.as_str();
        if !self.moved {
            return Err(if self.end { self.t0 + self.dur0 } else { self.t0 });
        }
        Ok(if self.end && self.duration != self.dur0 {
            Some(C::set_marker(s, self.id.as_str(), json!({ "duration": self.duration })))
        } else if !self.end && self.t != self.t0 {
            Some(C::set_marker(s, self.id.as_str(), json!({ "t": self.t })))
        } else {
            None
        })
    }
}

/// The marker under a ruler point (`markerHit`, y from the ruler's top): the nearest flag within 6 points, else the
/// nearest range end within 4.
pub fn marker_hit<'a>(seq: &'a Sequence, view: &View, x: f64, y: f32) -> Option<(&'a cut_model::Marker, bool)> {
    if !(10.0..=25.0).contains(&y) {
        return None;
    }
    let best = |end: bool, lim: f64| {
        seq.markers
            .iter()
            .filter(|m| !end || m.duration > 0)
            .map(|m| (m, (view.x_of(if end { m.t + m.duration } else { m.t }) - x).abs()))
            .filter(|(_, d)| *d <= lim)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(m, _)| (m, end))
    };
    best(false, 6.0).or_else(|| best(true, 4.0))
}
