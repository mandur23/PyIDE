//! The time questions every layer asks of the model (port of model.js's queries): how long a clip is, which clips
//! are under a time, which source time a timeline time shows, and the nest relations between sequences.

use std::collections::HashSet;

use cut_time::{FRAME_RATES, Fps, Ticks};

use crate::id::Id;
use crate::project::{Clip, MediaKind, Project, Sequence, Source, TrackKind};
use crate::remap::{self as R, Direction, Remap};

/// The format version this model reads and writes. 2: nest clips, 3: time remapping and frame sampling, 4: masks,
/// 5: graphic clips.
pub const VERSION: i64 = 5;

/// The gcd of every offered frame length (2,116,800 ticks): durations at speeds other than 1 round to it.
pub const QUANTUM: Ticks = {
    let mut g = 0_i64;
    let mut i = 0;
    while i < FRAME_RATES.len() {
        let f = FRAME_RATES[i];
        let mut a = (cut_time::TICKS * f.den as i64) / f.num as i64;
        let mut b = g;
        while b != 0 {
            let r = a % b;
            a = b;
            b = r;
        }
        g = a;
        i += 1;
    }
    g
};

/// `Math.round`: halves go up, also below zero.
pub(crate) fn js_round(x: f64) -> f64 {
    crate::captionwords::js_round(x)
}

/// Whether a sequence may run at this rate (one of [`FRAME_RATES`]); durations rely on it.
pub fn valid_fps(fps: Fps) -> bool {
    FRAME_RATES.contains(&fps)
}

/// One frame of a rate the model accepts.
pub fn frame(fps: Fps) -> Ticks {
    fps.frame_ticks().unwrap_or(1)
}

impl Clip {
    /// `(out - in) / speed` rounded to [`QUANTUM`], or the curve's duration for a remapped clip. Never compute it
    /// another way: at speeds other than 1 the float error would leave the frame grid.
    pub fn duration(&self) -> Ticks {
        match &self.remap {
            Some(r) => r.duration,
            None => (js_round((self.out - self.in_) / self.speed / QUANTUM as f64) * QUANTUM as f64) as Ticks,
        }
    }

    pub fn end(&self) -> Ticks {
        self.start + self.duration()
    }

    pub fn is_generator(&self) -> bool {
        matches!(self.source, Source::Generator { .. })
    }

    pub fn is_nest(&self) -> bool {
        matches!(self.source, Source::Nest { .. })
    }

    pub fn is_freeze(&self) -> bool {
        matches!(self.source, Source::Media { freeze: true, .. })
    }

    pub fn media_id(&self) -> Option<Id> {
        match self.source {
            Source::Media { media, .. } => Some(media),
            _ => None,
        }
    }

    pub fn nest_id(&self) -> Option<Id> {
        match self.source {
            Source::Nest { sequence, .. } => Some(sequence),
            _ => None,
        }
    }

    /// The source time timeline time t shows: speed, reverse, freeze and time remapping included. A reversed clip
    /// shows one tick before its out point first, so a decoder's "last sample at or before" lands inside it.
    pub fn source_time(&self, t: f64) -> f64 {
        if self.is_freeze() {
            return self.in_;
        }
        if let Some(r) = &self.remap {
            return self.out.min(self.in_.max(R::source_at(r, t - self.start as f64)));
        }
        let along = (t - self.start as f64) * self.speed;
        if self.reverse {
            return self.in_.max(self.out - along - 1.0);
        }
        (self.in_ + along).min(self.out)
    }

    /// The first timeline time that shows source time `src`, clamped to the clip's edges outside it; `None` for a
    /// freeze frame.
    pub fn timeline_time(&self, src: f64) -> Option<f64> {
        if self.is_freeze() {
            return None;
        }
        let end = self.end() as f64;
        let start = self.start as f64;
        if let Some(r) = &self.remap {
            let d = r.duration as f64;
            if src <= self.in_ {
                return Some(start + R::clip_time_of(r, self.in_, 0.0, d).unwrap_or(0.0));
            }
            if src >= self.out {
                return Some(start + R::clip_time_of(r, self.out, 0.0, d).unwrap_or(d));
            }
            return R::clip_time_of(r, src, 0.0, d).map(|x| end.min(start + x));
        }
        let along = if self.reverse { self.out - src } else { src - self.in_ };
        Some(end.min(start.max(start + along / self.speed)))
    }

    /// The lowest and highest source time the clip shows over timeline `[a, b)`: what to decode ahead.
    pub fn source_span(&self, a: f64, b: f64) -> (f64, f64) {
        let start = self.start as f64;
        if let (Some(r), false) = (&self.remap, self.is_freeze()) {
            let x0 = (a - start).max(0.0);
            let x1 = ((self.duration() as f64).min(b - start) - 1.0).max(0.0);
            let (lo, hi) = R::bounds(r, x0, x1);
            return (self.in_.max(lo - 1.0), self.out.min(hi));
        }
        let x = self.source_time(a);
        let y = self.source_time(a.max(b - 1.0));
        (x.min(y), x.max(y))
    }

    /// The curve the clip plays as it is now: its remap, or its constant speed and direction as a curve without keys.
    pub fn remap_of(&self) -> Remap {
        if let Some(r) = &self.remap {
            return r.clone();
        }
        let d = self.duration();
        let v = (self.out - self.in_) / d as f64;
        if self.reverse { R::constant(self.out, -v, d) } else { R::constant(self.in_, v, d) }
    }
}

/// How far a clip's source lets it grow, in timeline ticks, at its head and its tail (infinite for a still).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Room {
    pub head: f64,
    pub tail: f64,
}

impl Sequence {
    /// The end of the last clip.
    pub fn duration(&self) -> Ticks {
        self.clips().map(Clip::end).max().unwrap_or(0).max(0)
    }

    /// The track's position among the tracks of its kind (V1 is 0, A1 is 0).
    pub fn track_index(&self, id: Id) -> Option<usize> {
        let kind = self.track(id)?.kind;
        self.tracks.iter().filter(|t| t.kind == kind).position(|t| t.id == id)
    }

    pub fn kind_of(&self, track: Id) -> Option<TrackKind> {
        self.track(track).map(|t| t.kind)
    }

    /// Enabled clips under t, video tracks first (V1, V2 ...), then audio tracks in the same way.
    pub fn clips_at(&self, t: Ticks, kind: Option<TrackKind>) -> Vec<&Clip> {
        let mut out = Vec::new();
        for want in [TrackKind::Video, TrackKind::Audio] {
            if kind.is_some_and(|k| k != want) {
                continue;
            }
            for tr in self.tracks.iter().filter(|tr| tr.kind == want) {
                if let Some(c) = tr.clip_at(t).filter(|c| c.enabled) {
                    out.push(c);
                }
            }
        }
        out
    }

    /// The other clips of a clip's link.
    pub fn linked_clips(&self, clip: &Clip) -> Vec<&Clip> {
        match clip.link {
            None => Vec::new(),
            Some(l) => {
                // in the order of clips(): by track, then by place on the track
                let mut at: Vec<(usize, usize)> = self
                    .link_members(l)
                    .iter()
                    .filter(|id| **id != clip.id)
                    .filter_map(|id| self.place_of(*id))
                    .collect();
                at.sort_unstable();
                at.into_iter().map(|(t, i)| &*self.tracks[t].clips[i]).collect()
            }
        }
    }

    /// The sequences its nest clips show (directly).
    pub fn nested_ids(&self) -> HashSet<Id> {
        self.clips().filter_map(Clip::nest_id).collect()
    }
}

/// Whether a nest clip of a sequence has a picture (clips on video tracks) and sound (clips on audio tracks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NestKinds {
    pub video: bool,
    pub audio: bool,
}

impl Project {
    /// A clip whose picture does not change with time: an image, a generator, a freeze frame.
    pub fn is_still(&self, clip: &Clip) -> bool {
        match clip.source {
            Source::Generator { .. } => true,
            Source::Media { freeze: true, .. } => true,
            Source::Media { media, .. } => self.media(media).is_some_and(|m| m.kind == MediaKind::Image),
            Source::Nest { .. } => false,
        }
    }

    /// The sequence a nest clip shows.
    pub fn nest_of(&self, clip: &Clip) -> Option<&Sequence> {
        self.sequence(clip.nest_id()?)
    }

    /// How much source a clip's in/out may span: the media's duration, or a nest's sequence duration (never less than
    /// what the clip shows, since that sequence may have become shorter).
    pub fn source_length(&self, clip: &Clip) -> f64 {
        if clip.is_nest() {
            let inner = self.nest_of(clip).map_or(0, Sequence::duration) as f64;
            return inner.max(clip.out);
        }
        clip.media_id().and_then(|m| self.media(m)).map_or(0.0, |m| m.duration)
    }

    /// See [`Room`].
    pub fn source_room(&self, clip: &Clip) -> Room {
        if self.is_still(clip) {
            return Room { head: f64::INFINITY, tail: f64::INFINITY };
        }
        let len = self.source_length(clip);
        if let Some(r) = &clip.remap {
            return Room {
                head: R::stay(r, 0.0, Direction::Earlier, -0.25, len + 0.25),
                tail: R::stay(r, r.duration as f64, Direction::Later, -0.25, len + 0.25),
            };
        }
        let before = clip.in_ / clip.speed;
        let after = (len - clip.out) / clip.speed;
        if clip.reverse {
            Room { head: after.max(0.0), tail: before.max(0.0) }
        } else {
            Room { head: before.max(0.0), tail: after.max(0.0) }
        }
    }

    /// Whether sequence `from` shows sequence `to`, itself or through nest clips any levels down.
    pub fn reaches(&self, from: Id, to: Id) -> bool {
        let mut seen = HashSet::new();
        let mut stack = vec![from];
        while let Some(id) = stack.pop() {
            if id == to {
                return true;
            }
            if !seen.insert(id) {
                continue;
            }
            if let Some(seq) = self.sequence(id) {
                stack.extend(seq.nested_ids());
            }
        }
        false
    }

    /// Whether a nest clip of `inner` placed in `outer` would make a sequence show itself.
    pub fn nest_loop(&self, outer: Id, inner: Id) -> bool {
        self.reaches(inner, outer)
    }

    /// The other sequences whose nest clips show `seq`, with those clips.
    pub fn nest_uses(&self, seq: Id) -> Vec<(Id, Vec<Id>)> {
        self.sequences
            .iter()
            .filter_map(|s| {
                let clips: Vec<Id> = s.clips().filter(|c| c.nest_id() == Some(seq)).map(|c| c.id).collect();
                (!clips.is_empty()).then_some((s.id, clips))
            })
            .collect()
    }

    /// See [`NestKinds`].
    pub fn nest_kinds(&self, seq: Id) -> NestKinds {
        let has = |k| self.sequence(seq).is_some_and(|s| s.tracks.iter().any(|t| t.kind == k && !t.clips.is_empty()));
        NestKinds { video: has(TrackKind::Video), audio: has(TrackKind::Audio) }
    }

    /// The LUT ids the effects of the project name.
    pub fn luts_in_use(&self) -> HashSet<String> {
        let mut used = HashSet::new();
        for seq in &self.sequences {
            for c in seq.clips() {
                for e in &c.effects {
                    if let Some(serde_json::Value::String(l)) = e.params.get("lut")
                        && !l.is_empty()
                    {
                        used.insert(l.clone());
                    }
                }
            }
        }
        used
    }
}
