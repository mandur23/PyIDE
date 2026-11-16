//! What a clip draws over its picture and what a pointer can grab there (port of `ui-timeline.js`'s `bandY`,
//! `bandValue`, `remapY`, `remapPct`, `remapKeysOf`, `transitionSpan`, `roomOf` and the parts of `hit` past the
//! clip edges): the keyframe line (volume of audio, opacity of video, or a video's Time Remapping > Speed), its
//! keyframes, the audio fade handles, the fx badge and the transitions over the bottom of the clips.
//!
//! Coordinates are the lanes': x from the lanes' left edge, y from the top of the first row on screen.

use std::collections::HashMap;

use cut_model::remap::{self as R, Remap};
use cut_model::{Clip, Id, Project, Sequence, TrackKind, Transition};
use cut_time::{TICKS, Ticks};

use super::layout::{Hit, Layout, Part, Row, RowKind, View};
use crate::edit::Band;

/// The range of a keyframe line (`BAND`).
pub fn range(prop: &str) -> (f64, f64) {
    if prop == "volume" { (-60.0, 15.0) } else { (0.0, 100.0) }
}

/// The line's property of a track kind (`bandProp`).
pub fn prop_of(kind: TrackKind) -> &'static str {
    if kind == TrackKind::Audio { "volume" } else { "opacity" }
}

/// Whether a row is tall enough to show the line (`showsBand`).
pub fn shows_band(h: f32) -> bool {
    h >= 34.0
}

/// What a clip's line shows (`bandOf`): Speed for a video clip chosen so or remapped (never a still), else its
/// property.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Line {
    Prop(&'static str),
    Remap,
}

pub fn line_of(project: &Project, clip: &Clip, kind: TrackKind, chosen: &HashMap<Id, Band>) -> Line {
    if kind == TrackKind::Audio {
        return Line::Prop("volume");
    }
    let remap = match chosen.get(&clip.id) {
        Some(Band::Remap) => true,
        Some(Band::Opacity) => false,
        None => clip.remap.is_some(),
    };
    if remap && !project.is_still(clip) { Line::Remap } else { Line::Prop("opacity") }
}

/// The height of value `val` on the line of a clip drawn from `y` with height `h` (`bandY`).
pub fn band_y(prop: &str, val: f64, y: f32, h: f32) -> f32 {
    let (lo, hi) = range(prop);
    let (top, bottom) = (y + 16.0, y + h - 4.0);
    let k = ((val.clamp(lo, hi) - lo) / (hi - lo)) as f32;
    bottom - k * (bottom - top)
}

/// The value at height `py` (`bandValue`), to a tenth.
pub fn band_value(prop: &str, py: f32, y: f32, h: f32) -> f64 {
    let (lo, hi) = range(prop);
    let (top, bottom) = (y + 16.0, y + h - 4.0);
    let k = f64::from(((bottom - py) / (bottom - top)).clamp(0.0, 1.0));
    ((lo + k * (hi - lo)) * 10.0).round() / 10.0
}

/// The height of a speed in percent on the Speed line: a log scale, 10% at the bottom, 1000% at the top (`remapY`).
pub fn remap_y(pct: f64, y: f32, h: f32) -> f32 {
    let (top, bottom) = (y + 16.0, y + h - 4.0);
    let k = if pct > 0.0 { ((pct.log10() - 1.0) / 2.0).clamp(0.0, 1.0) } else { 0.0 };
    bottom - k as f32 * (bottom - top)
}

/// The speed in percent at height `py`, in steps of `step` (`remapPct`).
pub fn remap_pct(py: f32, y: f32, h: f32, step: f64) -> f64 {
    let (top, bottom) = (y + 16.0, y + h - 4.0);
    let k = f64::from(((bottom - py) / (bottom - top)).clamp(0.0, 1.0));
    ((10f64.powf(1.0 + 2.0 * k) / step).round() * step).clamp(10.0, 1000.0)
}

/// A keyframe line value clamped to its range, to a tenth (`clampBand`).
pub fn clamp_band(prop: &str, val: f64) -> f64 {
    let (lo, hi) = range(prop);
    ((val * 10.0).round() / 10.0).clamp(lo, hi)
}

/// The time span a transition covers (`transitionSpan`).
pub fn span(t: &Transition) -> (Ticks, Ticks) {
    let d = t.duration;
    match t.align {
        cut_model::Align::Start => (t.at, t.at + d),
        cut_model::Align::End => (t.at - d, t.at),
        cut_model::Align::Center => (t.at - d / 2, t.at + d / 2),
    }
}

/// Source left beyond each end of a clip in timeline ticks (`roomOf`): a still has no limit, offline media none.
pub fn room_of(project: &Project, clip: &Clip, frame: Ticks) -> (f64, f64) {
    if project.is_still(clip) {
        return (f64::INFINITY, f64::INFINITY);
    }
    if !clip.is_nest() && clip.media_id().and_then(|m| project.media(m)).is_none() {
        return (0.0, 0.0);
    }
    let r = project.source_room(clip);
    let f = frame as f64;
    (if r.head >= f { r.head } else { 0.0 }, if r.tail >= f { r.tail } else { 0.0 })
}

/// Whether the clips around a transition lack the source frames it needs (`transitionShort`: drawn striped).
pub fn short(project: &Project, seq: &Sequence, t: &Transition, frame: Ticks) -> bool {
    let Some(track) = seq.track(t.track) else { return false };
    let out = track.clips.iter().find(|c| c.end() == t.at);
    let inc = track.clips.iter().find(|c| c.start == t.at);
    let (a, b) = span(t);
    if let Some(c) = out
        && b > t.at
        && room_of(project, c, frame).1 < (b - t.at) as f64
    {
        return true;
    }
    inc.is_some_and(|c| a < t.at && room_of(project, c, frame).0 < (t.at - a) as f64)
}

/// Where one key of a remapped clip is drawn (`remapKeysOf`): its halves' x and their line heights, and its tab.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeyMark {
    pub i: usize,
    pub ka: f32,
    pub kb: f32,
    pub mid: f32,
    pub ya: f32,
    pub yb: f32,
}

pub fn remap_keys(view: &View, clip: &Clip, cy: f32, ch: f32) -> Vec<KeyMark> {
    let r = clip.remap_of();
    let d = clip.duration();
    let x = |t: Ticks| view.x_of(clip.start + t) as f32;
    r.keys
        .iter()
        .enumerate()
        .filter(|(_, k)| k.t < d)
        .map(|(i, k)| {
            let (ka, kb) = (x(k.t), x(k.t + k.ramp));
            let sp = |j: usize| r.speeds.get(j).copied().unwrap_or(0.0).abs() * 100.0;
            KeyMark { i, ka, kb, mid: (ka + kb) / 2.0, ya: remap_y(sp(i), cy, ch), yb: remap_y(sp(i + 1), cy, ch) }
        })
        .collect()
}

/// The speed of a clip's curve at clip time `tau`, clamped into the clip.
pub fn speed_at(r: &Remap, d: Ticks, tau: f64) -> f64 {
    R::speed_at(r, tau.clamp(0.0, (d - 1).max(0) as f64))
}

/// Which half of a remap key a press took.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Half {
    Left,
    Right,
    Tab,
}

/// A transition's grab: its start or end handle, or its body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TPart {
    Start,
    End,
    Body,
}

/// What a pointer is on beyond a clip's edges and body (`hit`'s other parts).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Extra {
    Transition {
        id: Id,
        part: TPart,
    },
    Keyframe {
        clip: Id,
        prop: &'static str,
        index: usize,
    },
    Fade {
        clip: Id,
        out: bool,
    },
    RemapKey {
        clip: Id,
        index: usize,
        half: Half,
    },
    /// On the body: the fx badge, the Speed line, the keyframe line.
    Fx(Id),
    RemapLine(Id),
    Line {
        clip: Id,
        prop: &'static str,
    },
}

/// The clip geometry of a row on screen: its top and height (`cy`, `ch` of `drawClip`).
pub fn clip_box(row: &Row, view: &View) -> (f32, f32) {
    (row.y - view.scroll_y + 1.0, row.h - 3.0)
}

/// The part under `(x, y)` that [`super::layout::hit`] does not know, in the JavaScript's order: transitions first,
/// then a remapped clip's keys, keyframes and fade handles (over the edges), then on the body the badge and the
/// lines. `None` where the plain hit stands.
pub fn extra(
    project: &Project,
    seq: &Sequence,
    layout: &Layout,
    view: &View,
    chosen: &HashMap<Id, Band>,
    base: &Hit,
    (x, y): (f64, f32),
) -> Option<Extra> {
    let row = layout.rows.get(base.row?)?;
    if !matches!(row.kind, RowKind::Video | RowKind::Audio) {
        return None;
    }
    let track = row.id?;
    let kind = if row.kind == RowKind::Audio { TrackKind::Audio } else { TrackKind::Video };
    let ry = row.y - view.scroll_y;
    let xf = x as f32;
    for t in seq.transitions.iter().filter(|t| t.track == track) {
        let (ta, tb) = span(t);
        let (xa, xb) = (view.x_of(ta) as f32, view.x_of(tb) as f32);
        let hh = (row.h - 4.0).min(22.0);
        if xf >= xa - 3.0 && xf <= xb + 3.0 && y >= ry + row.h - hh - 3.0 {
            let part = if xf - xa < 5.0 {
                TPart::Start
            } else if xb - xf < 5.0 {
                TPart::End
            } else {
                TPart::Body
            };
            return Some(Extra::Transition { id: t.id, part });
        }
    }
    let under = layout
        .visible(track, view.t_of(x - 1.0).floor() as Ticks, view.t_of(x + 1.0).ceil() as Ticks)
        .iter()
        .find(|s| x >= view.x_of(s.start) && x < view.x_of(s.end))
        .and_then(|s| seq.clip(s.id))?;
    let (cy, ch) = clip_box(row, view);
    let line = line_of(project, under, kind, chosen);
    let band = shows_band(row.h);
    let remap_line = band && y > ry + 12.0 && line == Line::Remap;
    if remap_line {
        for g in remap_keys(view, under, cy, ch) {
            let one = g.ka == g.kb;
            if (xf - g.mid).abs() <= 5.0 && y >= ry + 13.0 && y <= ry + 22.0 {
                return Some(Extra::RemapKey { clip: under.id, index: g.i, half: Half::Tab });
            }
            if xf >= g.ka - 6.0 && xf <= g.ka + if one { 0.0 } else { 2.0 } && (y - g.ya).abs() <= 8.0 {
                return Some(Extra::RemapKey { clip: under.id, index: g.i, half: Half::Left });
            }
            if xf >= g.kb - if one { 0.0 } else { 2.0 } && xf <= g.kb + 6.0 && (y - g.yb).abs() <= 8.0 {
                return Some(Extra::RemapKey { clip: under.id, index: g.i, half: Half::Right });
            }
        }
    }
    let prop = prop_of(kind);
    if !remap_line && band && y > ry + 15.0 {
        for (i, k) in under.keyframes.get(prop).into_iter().flatten().enumerate() {
            let cut_model::keyframes::Value::Num(v) = k.v else { continue };
            let kx = view.x_of(under.start + k.t) as f32;
            if (kx - xf).abs() <= 5.0 && (band_y(prop, v, cy, ch) - y).abs() <= 5.0 {
                return Some(Extra::Keyframe { clip: under.id, prop, index: i });
            }
        }
        if kind == TrackKind::Audio && row.h >= 30.0 {
            let fy = ry + 1.0 + 15.0;
            if y >= fy - 2.0 && y <= fy + 8.0 {
                let xa = view.x_of(under.start) + view.px(under.fade_in);
                let xb = view.x_of(under.end()) - view.px(under.fade_out);
                if (x - xa).abs() <= 5.0 {
                    return Some(Extra::Fade { clip: under.id, out: false });
                }
                if (x - xb).abs() <= 5.0 {
                    return Some(Extra::Fade { clip: under.id, out: true });
                }
            }
        }
    }
    if base.part != Some(Part::Body) || base.clip != Some(under.id) {
        return None;
    }
    let xa = view.x_of(under.start) as f32;
    let w = view.x_of(under.end()) as f32 - xa;
    if kind == TrackKind::Video && y <= ry + 15.0 && xf >= xa + 1.0 && xf <= xa + 18.0 && w > 40.0 {
        return Some(Extra::Fx(under.id));
    }
    let tau = base.t - under.start as f64;
    if remap_line {
        let sp = speed_at(&under.remap_of(), under.duration(), tau);
        return ((remap_y(sp.abs() * 100.0, cy, ch) - y).abs() <= 4.0).then_some(Extra::RemapLine(under.id));
    }
    if band && y > ry + 15.0 {
        let val = value_at(under, prop, tau);
        if (band_y(prop, val, cy, ch) - y).abs() <= 3.0 {
            return Some(Extra::Line { clip: under.id, prop });
        }
    }
    None
}

/// A numeric property of a clip at clip time `tau` (`K.propValue(c, prop, tau, c.props[prop])`).
pub fn value_at(clip: &Clip, prop: &str, tau: f64) -> f64 {
    match cut_model::keyframes::prop_value(clip, prop, tau) {
        Some(cut_model::keyframes::Value::Num(v)) => v,
        _ => 0.0,
    }
}

/// Seconds as ticks, for the pointer arithmetic.
pub fn ticks_of(dx: f64, pps: f64) -> f64 {
    dx / pps * TICKS as f64
}
