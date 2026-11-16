//! What a command changed, so undo puts back exactly the project before it and redo the one after.
//!
//! The JavaScript records every field it sets on its live JSON (`recorder()`). Here an edit first keeps a copy of the
//! one thing it is about to change (one clip, a sequence's transition list, the project's settings ...), once per
//! command; undo swaps each copy with what is there now, last first, which leaves the copies holding the state after
//! the command, so redo is the same swaps first to last. A command costs copies of what it touches, never of the
//! project.

use std::collections::HashSet;

use cut_time::Fps;

use crate::id::{Id, IdMap};
use crate::project::{Bin, CaptionTrack, Clip, Extra, Marker, Media, Project, Sequence, Track, Transition};

/// A sequence's own fields and its tracks' fields, without clips, transitions, markers and captions.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SeqInfo {
    name: String,
    w: i64,
    h: i64,
    fps: Fps,
    rate: i64,
    background: String,
    master_gain: f64,
    extra: Extra,
    tracks: Vec<Track>,
}

impl SeqInfo {
    /// Whether `s` has this frame rate and these tracks (ids and kinds), so its clips need no new check.
    pub(crate) fn same_frame(&self, s: &Sequence) -> bool {
        self.fps == s.fps
            && self.tracks.len() == s.tracks.len()
            && self.tracks.iter().zip(&s.tracks).all(|(a, b)| a.id == b.id && a.kind == b.kind)
    }

    fn of(s: &Sequence) -> Self {
        SeqInfo {
            name: s.name.clone(),
            w: s.w,
            h: s.h,
            fps: s.fps,
            rate: s.rate,
            background: s.background.clone(),
            master_gain: s.master_gain,
            extra: s.extra.clone(),
            tracks: s.track_infos(),
        }
    }

    fn swap(&mut self, s: &mut Sequence) {
        std::mem::swap(&mut self.name, &mut s.name);
        std::mem::swap(&mut self.w, &mut s.w);
        std::mem::swap(&mut self.h, &mut s.h);
        std::mem::swap(&mut self.fps, &mut s.fps);
        std::mem::swap(&mut self.rate, &mut s.rate);
        std::mem::swap(&mut self.background, &mut s.background);
        std::mem::swap(&mut self.master_gain, &mut s.master_gain);
        std::mem::swap(&mut self.extra, &mut s.extra);
        let now = s.track_infos();
        s.set_tracks(std::mem::replace(&mut self.tracks, now));
    }
}

/// The project's own fields: format, version, settings, nextId, speakers, LUTs and the unknown ones.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProjectInfo {
    format: String,
    version: i64,
    settings: Extra,
    next_id: i64,
    speakers: Option<serde_json::Value>,
    luts: Option<serde_json::Value>,
    extra: Extra,
}

impl ProjectInfo {
    pub(crate) fn next_id(&self) -> i64 {
        self.next_id
    }

    fn of(p: &Project) -> Self {
        ProjectInfo {
            format: p.format.clone(),
            version: p.version,
            settings: p.settings.clone(),
            next_id: p.next_id,
            speakers: p.speakers.clone(),
            luts: p.luts.clone(),
            extra: p.extra.clone(),
        }
    }

    fn swap(&mut self, p: &mut Project) {
        std::mem::swap(&mut self.format, &mut p.format);
        std::mem::swap(&mut self.version, &mut p.version);
        std::mem::swap(&mut self.settings, &mut p.settings);
        std::mem::swap(&mut self.next_id, &mut p.next_id);
        std::mem::swap(&mut self.speakers, &mut p.speakers);
        std::mem::swap(&mut self.luts, &mut p.luts);
        std::mem::swap(&mut self.extra, &mut p.extra);
    }
}

/// One recorded change; [`Change::flip`] applies its copy and keeps what was there instead.
#[derive(Debug, Clone)]
pub(crate) enum Change {
    Clip { seq: Id, image: Box<Clip> },
    Added { seq: Id, id: Id, pos: usize },
    Removed { seq: Id, pos: usize, clip: Box<Clip> },
    Transitions { seq: Id, image: Vec<Transition> },
    Markers { seq: Id, image: Vec<Marker> },
    Captions { seq: Id, image: Vec<CaptionTrack> },
    SeqInfo { seq: Id, image: Box<SeqInfo> },
    Project { image: Box<ProjectInfo> },
    Media { image: Vec<Media> },
    Bins { image: Vec<Bin> },
    SeqAdded { id: Id },
    SeqRemoved { pos: usize, seq: Box<Sequence> },
}

fn seq_of(p: &mut Project, id: Id) -> &mut Sequence {
    p.sequence_mut(id).expect("a recorded change names a sequence that is there")
}

impl Change {
    /// Puts the copy in place and keeps what was there, so flipping again restores it.
    pub(crate) fn flip(&mut self, p: &mut Project) {
        match self {
            Change::Clip { seq, image } => {
                let id = image.id;
                seq_of(p, *seq).edit_clip(id, |c| std::mem::swap(c, image)).expect("the recorded clip is there");
            }
            Change::Added { seq, id, pos } => {
                let (clip, pos) = seq_of(p, *seq).remove_boxed_at(*id, *pos).expect("the added clip is there");
                *self = Change::Removed { seq: *seq, pos, clip };
            }
            Change::Removed { seq, pos, clip } => {
                let (seq, pos, id) = (*seq, *pos, clip.id);
                let Change::Removed { clip, .. } = std::mem::replace(self, Change::Added { seq, id, pos }) else {
                    unreachable!()
                };
                seq_of(p, seq).insert_boxed(clip, Some(pos));
            }
            Change::Transitions { seq, image } => std::mem::swap(image, &mut seq_of(p, *seq).transitions),
            Change::Markers { seq, image } => std::mem::swap(image, &mut seq_of(p, *seq).markers),
            Change::Captions { seq, image } => std::mem::swap(image, &mut seq_of(p, *seq).captions),
            Change::SeqInfo { seq, image } => image.swap(seq_of(p, *seq)),
            Change::Project { image } => image.swap(p),
            Change::Media { image } => std::mem::swap(image, &mut p.media),
            Change::Bins { image } => std::mem::swap(image, &mut p.bins),
            Change::SeqAdded { id } => {
                let pos = p.sequences.iter().position(|s| s.id == *id).expect("the added sequence is there");
                let seq = p.sequences.remove(pos);
                *self = Change::SeqRemoved { pos, seq: Box::new(seq) };
            }
            Change::SeqRemoved { pos, seq } => {
                let id = seq.id;
                let s = std::mem::replace(seq.as_mut(), crate::defaults::sequence(id, &Default::default()));
                p.sequences.insert((*pos).min(p.sequences.len()), s);
                *self = Change::SeqAdded { id };
            }
        }
    }

    /// Whether the change leaves things as they were (a copy equal to what is there now).
    fn is_noop(&self, p: &Project) -> bool {
        let seq = |id: &Id| p.sequence(*id);
        match self {
            Change::Clip { seq: s, image } => {
                seq(s).and_then(|s| s.clip(image.id)).is_some_and(|c| c == image.as_ref())
            }
            Change::Transitions { seq: s, image } => seq(s).is_some_and(|s| &s.transitions == image),
            Change::Markers { seq: s, image } => seq(s).is_some_and(|s| &s.markers == image),
            Change::Captions { seq: s, image } => seq(s).is_some_and(|s| &s.captions == image),
            Change::SeqInfo { seq: s, image } => seq(s).is_some_and(|s| SeqInfo::of(s) == **image),
            Change::Project { image } => ProjectInfo::of(p) == **image,
            Change::Media { image } => &p.media == image,
            Change::Bins { image } => &p.bins == image,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum List {
    Transitions,
    Markers,
    Captions,
    Info,
}

/// The changes of one command (or of a group of them), recorded as it runs.
#[derive(Default)]
pub struct Tx {
    pub(crate) changes: Vec<Change>,
    clips: crate::id::IdSet<(Id, Id)>,
    lists: HashSet<(Id, List)>,
    project: bool,
    media: bool,
    bins: bool,
}

impl Tx {
    pub(crate) fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// Keeps a copy of a clip before its first change.
    pub(crate) fn clip(&mut self, p: &Project, seq: Id, id: Id) {
        if self.clips.insert((seq, id))
            && let Some(c) = p.sequence(seq).and_then(|s| s.clip(id))
        {
            self.changes.push(Change::Clip { seq, image: Box::new(c.clone()) });
        }
    }

    pub(crate) fn added(&mut self, seq: Id, id: Id, pos: usize) {
        self.changes.push(Change::Added { seq, id, pos });
    }

    pub(crate) fn removed(&mut self, seq: Id, pos: usize, clip: Clip) {
        self.changes.push(Change::Removed { seq, pos, clip: Box::new(clip) });
    }

    fn list(&mut self, seq: Id, which: List) -> bool {
        self.lists.insert((seq, which))
    }

    pub(crate) fn transitions(&mut self, p: &Project, seq: Id) {
        if self.list(seq, List::Transitions) {
            let image = p.sequence(seq).map(|s| s.transitions.clone()).unwrap_or_default();
            self.changes.push(Change::Transitions { seq, image });
        }
    }

    pub(crate) fn markers(&mut self, p: &Project, seq: Id) {
        if self.list(seq, List::Markers) {
            let image = p.sequence(seq).map(|s| s.markers.clone()).unwrap_or_default();
            self.changes.push(Change::Markers { seq, image });
        }
    }

    pub(crate) fn captions(&mut self, p: &Project, seq: Id) {
        if self.list(seq, List::Captions) {
            let image = p.sequence(seq).map(|s| s.captions.clone()).unwrap_or_default();
            self.changes.push(Change::Captions { seq, image });
        }
    }

    pub(crate) fn seq_info(&mut self, p: &Project, seq: Id) {
        if self.list(seq, List::Info)
            && let Some(s) = p.sequence(seq)
        {
            self.changes.push(Change::SeqInfo { seq, image: Box::new(SeqInfo::of(s)) });
        }
    }

    pub(crate) fn project(&mut self, p: &Project) {
        if !self.project {
            self.project = true;
            self.changes.push(Change::Project { image: Box::new(ProjectInfo::of(p)) });
        }
    }

    pub(crate) fn media(&mut self, p: &Project) {
        if !self.media {
            self.media = true;
            self.changes.push(Change::Media { image: p.media.clone() });
        }
    }

    pub(crate) fn bins(&mut self, p: &Project) {
        if !self.bins {
            self.bins = true;
            self.changes.push(Change::Bins { image: p.bins.clone() });
        }
    }

    pub(crate) fn seq_added(&mut self, id: Id) {
        self.changes.push(Change::SeqAdded { id });
    }

    pub(crate) fn seq_removed(&mut self, pos: usize, seq: Sequence) {
        self.changes.push(Change::SeqRemoved { pos, seq: Box::new(seq) });
    }

    /// Takes back every change, last first.
    pub(crate) fn rollback(&mut self, p: &mut Project) {
        undo(&mut self.changes, p);
        self.changes.clear();
    }

    /// Drops the copies of things the command left as they were.
    pub(crate) fn prune(&mut self, p: &Project) {
        self.changes.retain(|c| !c.is_noop(p));
    }

    pub(crate) fn into_changes(self) -> Vec<Change> {
        self.changes
    }
}

/// Undoes recorded changes (last first); afterwards they redo.
pub(crate) fn undo(changes: &mut [Change], p: &mut Project) {
    for c in changes.iter_mut().rev() {
        c.flip(p);
    }
}

/// The ids validation claims of a clip: its own and its markers'.
fn clip_claims(c: &Clip) -> impl Iterator<Item = Id> + '_ {
    std::iter::once(c.id).chain(c.markers.iter().flatten().map(|m| m.id))
}

fn caption_claims(l: &[CaptionTrack]) -> Vec<Id> {
    l.iter().flat_map(|ct| std::iter::once(ct.id).chain(ct.items.iter().map(|it| it.id))).collect()
}

/// Moves the counts from `gone` to `came`, skipping what the two share at their start and end (a list that got or
/// lost one item).
fn recount(ids: &mut IdMap<Id, u32>, gone: &[Id], came: &[Id]) {
    let head = gone.iter().zip(came).take_while(|(a, b)| a == b).count();
    let tail = gone[head..].iter().rev().zip(came[head..].iter().rev()).take_while(|(a, b)| a == b).count();
    for id in &gone[head..gone.len() - tail] {
        if let Some(n) = ids.get_mut(id) {
            *n -= 1;
            if *n == 0 {
                ids.remove(id);
            }
        }
    }
    for id in &came[head..came.len() - tail] {
        *ids.entry(*id).or_default() += 1;
    }
}

impl Change {
    /// After [`flip`](Self::flip): the copy holds the state just left, the project the state now.
    fn recount(&self, p: &Project, ids: &mut IdMap<Id, u32>) {
        let seq = |id: &Id| p.sequence(*id);
        match self {
            Change::Clip { seq: s, image } => {
                let now: Vec<Id> =
                    seq(s).and_then(|s| s.clip(image.id)).map(|c| clip_claims(c).collect()).unwrap_or_default();
                recount(ids, &clip_claims(image).collect::<Vec<_>>(), &now);
            }
            Change::Added { seq: s, id, .. } => {
                let now: Vec<Id> =
                    seq(s).and_then(|s| s.clip(*id)).map(|c| clip_claims(c).collect()).unwrap_or_default();
                recount(ids, &[], &now);
            }
            Change::Removed { clip, .. } => recount(ids, &clip_claims(clip).collect::<Vec<_>>(), &[]),
            Change::Transitions { seq: s, image } => {
                let now: Vec<Id> = seq(s).map(|s| s.transitions.iter().map(|x| x.id).collect()).unwrap_or_default();
                recount(ids, &image.iter().map(|x| x.id).collect::<Vec<_>>(), &now);
            }
            Change::Markers { seq: s, image } => {
                let now: Vec<Id> = seq(s).map(|s| s.markers.iter().map(|x| x.id).collect()).unwrap_or_default();
                recount(ids, &image.iter().map(|x| x.id).collect::<Vec<_>>(), &now);
            }
            Change::Captions { seq: s, image } => {
                let now = seq(s).map(|s| caption_claims(&s.captions)).unwrap_or_default();
                recount(ids, &caption_claims(image), &now);
            }
            _ => {}
        }
    }
}

/// Undoes (`back`) or redoes recorded changes and keeps `ids`, the count of each id validation claims, as the
/// project's: change by change, from what each one swapped, or counted again after media, bins or sequences came
/// or went.
pub(crate) fn flip_counting(changes: &mut [Change], p: &mut Project, back: bool, ids: &mut IdMap<Id, u32>) {
    let structural = changes.iter().any(|c| {
        matches!(c, Change::Media { .. } | Change::Bins { .. } | Change::SeqAdded { .. } | Change::SeqRemoved { .. })
    });
    let mut each = |c: &mut Change| {
        c.flip(p);
        if !structural {
            c.recount(p, ids);
        }
    };
    if back {
        changes.iter_mut().rev().for_each(&mut each);
    } else {
        changes.iter_mut().for_each(&mut each);
    }
    if structural {
        *ids = crate::history::scope::claims(p);
    }
}
