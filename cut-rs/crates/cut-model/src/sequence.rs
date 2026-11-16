//! A sequence's clips: each track holds its clips sorted by start (lookups by time are binary searches), an index
//! finds a clip by id, and `order` keeps the file's list order, which the JavaScript's edits keep and depend on (the
//! order new ids are given in, the order linked clips are taken in).

use cut_time::Fps;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::id::Id;
use crate::project::{CaptionTrack, Clip, Extra, Marker, Sequence, Track, Transition};

impl Sequence {
    /// A sequence with these fields and no clips.
    pub fn new(id: Id, name: String, w: i64, h: i64, fps: Fps, background: String, tracks: Vec<Track>) -> Self {
        Sequence {
            id,
            name,
            w,
            h,
            fps,
            rate: 48000,
            background,
            master_gain: 0.0,
            tracks,
            transitions: Vec::new(),
            markers: Vec::new(),
            captions: Vec::new(),
            extra: Extra::new(),
            index: Default::default(),
            order: Default::default(),
            order_list: Default::default(),
            parked: Vec::new(),
            links: Default::default(),
            groups: Default::default(),
        }
    }

    /// The clips (on a track) whose link is `link`.
    pub fn link_members(&self, link: Id) -> &[Id] {
        self.links.get(&link).map_or(&[], Vec::as_slice)
    }

    /// The clips (on a track) whose group is `group`.
    pub fn group_members(&self, group: Id) -> &[Id] {
        self.groups.get(&group).map_or(&[], Vec::as_slice)
    }

    fn join(&mut self, id: Id, link: Option<Id>, group: Option<Id>) {
        if let Some(l) = link {
            self.links.entry(l).or_default().push(id);
        }
        if let Some(g) = group {
            self.groups.entry(g).or_default().push(id);
        }
    }

    fn leave(&mut self, id: Id, link: Option<Id>, group: Option<Id>) {
        for (map, key) in [(&mut self.links, link), (&mut self.groups, group)] {
            let Some(k) = key else { continue };
            if let Some(v) = map.get_mut(&k) {
                if let Some(i) = v.iter().position(|x| *x == id) {
                    v.swap_remove(i);
                }
                if v.is_empty() {
                    map.remove(&k);
                }
            }
        }
    }

    /// Builds the link and group lists from the tracks' clips.
    pub(crate) fn rebuild_members(&mut self) {
        self.links.clear();
        self.groups.clear();
        let members: Vec<(Id, Option<Id>, Option<Id>)> =
            self.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| (c.id, c.link, c.group)).collect();
        for (id, l, g) in members {
            self.join(id, l, g);
        }
    }

    pub fn track(&self, id: Id) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    /// A track to change its fields; its clips change through the clip methods only.
    pub fn track_mut(&mut self, id: Id) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    /// Every clip, track by track and in time order.
    pub fn clips(&self) -> impl Iterator<Item = &Clip> + Clone {
        self.tracks.iter().flat_map(|t| t.clips.iter().map(|c| &**c))
    }

    /// Every clip in the file's list order.
    pub fn clips_in_order(&self) -> impl Iterator<Item = &Clip> + Clone {
        self.order.iter().filter_map(|id| self.clip(*id))
    }

    /// The clips' ids in the file's list order.
    pub fn clip_order(&self) -> &[Id] {
        self.order_list.get_or_init(|| self.order.to_vec())
    }

    pub fn clip_count(&self) -> usize {
        self.order.len()
    }

    fn position(&self, id: Id) -> Option<(usize, usize)> {
        let &(track, start) = self.index.get(&id)?;
        let ti = self.tracks.iter().position(|t| t.id == track)?;
        let clips = &self.tracks[ti].clips;
        let from = clips.partition_point(|c| c.start < start);
        let ci = from + clips[from..].iter().take_while(|c| c.start == start).position(|c| c.id == id)?;
        Some((ti, ci))
    }

    /// The track index and the index on the track of a clip that is on a track.
    pub(crate) fn place_of(&self, id: Id) -> Option<(usize, usize)> {
        self.position(id)
    }

    pub fn clip(&self, id: Id) -> Option<&Clip> {
        match self.position(id) {
            Some((ti, ci)) => Some(&self.tracks[ti].clips[ci]),
            None => self.parked.iter().find(|c| c.id == id).map(|c| &**c),
        }
    }

    fn place(&mut self, clip: Box<Clip>) {
        self.index.insert(clip.id, (clip.track, clip.start));
        match self.tracks.iter_mut().position(|t| t.id == clip.track) {
            Some(ti) => {
                self.join(clip.id, clip.link, clip.group);
                let t = &mut self.tracks[ti];
                let i = t.upper(clip.start);
                t.clips.insert(i, clip);
            }
            None => self.parked.push(clip),
        }
    }

    fn take(&mut self, id: Id) -> Option<Box<Clip>> {
        let clip = match self.position(id) {
            Some((ti, ci)) => {
                let c = self.tracks[ti].clips.remove(ci);
                self.leave(c.id, c.link, c.group);
                c
            }
            None => {
                let i = self.parked.iter().position(|c| c.id == id)?;
                self.parked.remove(i)
            }
        };
        self.index.remove(&id);
        Some(clip)
    }

    /// Puts a clip in the sequence, at `pos` in the list order (the end when `None` or past it).
    pub fn insert_clip(&mut self, clip: Clip, pos: Option<usize>) {
        self.insert_boxed(Box::new(clip), pos);
    }

    /// [`insert_clip`](Self::insert_clip) of a clip already boxed (an undo putting back what it took).
    pub(crate) fn insert_boxed(&mut self, clip: Box<Clip>, pos: Option<usize>) {
        let pos = pos.unwrap_or(self.order.len()).min(self.order.len());
        self.order.insert(pos, clip.id);
        self.order_list.take();
        self.place(clip);
    }

    /// Takes a clip out, with its place in the list order.
    pub fn remove_clip(&mut self, id: Id) -> Option<(Clip, usize)> {
        self.remove_boxed(id).map(|(c, p)| (*c, p))
    }

    pub(crate) fn remove_boxed(&mut self, id: Id) -> Option<(Box<Clip>, usize)> {
        let clip = self.take(id)?;
        let pos = self.order.remove(id).expect("an indexed clip is in the order");
        self.order_list.take();
        Some((clip, pos))
    }

    /// [`remove_clip`](Self::remove_clip) of a clip known to be at `pos` in the list order (else found).
    pub fn remove_clip_at(&mut self, id: Id, pos: usize) -> Option<(Clip, usize)> {
        self.remove_boxed_at(id, pos).map(|(c, p)| (*c, p))
    }

    pub(crate) fn remove_boxed_at(&mut self, id: Id, pos: usize) -> Option<(Box<Clip>, usize)> {
        if self.order.get(pos) != Some(id) {
            return self.remove_boxed(id);
        }
        let clip = self.take(id)?;
        self.order.remove(id);
        self.order_list.take();
        Some((clip, pos))
    }

    /// The clip's place in the list order.
    pub fn order_of(&self, id: Id) -> Option<usize> {
        self.order.position(id)
    }

    /// Moves a clip to `to` in the list order; -> where it was.
    pub fn reorder_clip(&mut self, id: Id, to: usize) -> Option<usize> {
        let from = self.order.remove(id)?;
        self.order.insert(to.min(self.order.len()), id);
        self.order_list.take();
        Some(from)
    }

    /// Changes a clip in place; its track and its place in time follow what changed.
    pub fn edit_clip<R>(&mut self, id: Id, f: impl FnOnce(&mut Clip) -> R) -> Option<R> {
        let Some((ti, ci)) = self.position(id) else {
            let c = &mut **self.parked.iter_mut().find(|c| c.id == id)?;
            let r = f(c);
            let (track, start) = (c.track, c.start);
            self.index.insert(id, (track, start));
            return Some(r);
        };
        let clip = &mut *self.tracks[ti].clips[ci];
        let (track, start, link, group) = (clip.track, clip.start, clip.link, clip.group);
        let r = f(clip);
        let (nt, ns, nl, ng) = (clip.track, clip.start, clip.link, clip.group);
        if nl != link || ng != group {
            self.leave(id, link, group);
            self.join(id, nl, ng);
        }
        if nt != track || ns != start {
            let clips = &self.tracks[ti].clips;
            let ordered = nt == track
                && (ci == 0 || clips[ci - 1].start <= ns)
                && (ci + 1 == clips.len() || ns <= clips[ci + 1].start);
            if ordered {
                self.index.insert(id, (nt, ns));
            } else {
                let c = self.tracks[ti].clips.remove(ci);
                self.leave(c.id, c.link, c.group);
                self.place(c);
            }
        }
        Some(r)
    }

    /// Replaces the tracks' fields (not their clips) with `tracks`: clips stay with the track of their id; the clips
    /// of a track that goes wait until it comes back.
    pub fn set_tracks(&mut self, tracks: Vec<Track>) {
        let mut old: Vec<Track> = std::mem::replace(&mut self.tracks, tracks);
        for t in &mut self.tracks {
            t.clips.clear();
            if let Some(o) = old.iter_mut().find(|o| o.id == t.id) {
                t.clips = std::mem::take(&mut o.clips);
            }
        }
        for o in old {
            self.parked.extend(o.clips);
        }
        for c in std::mem::take(&mut self.parked) {
            self.place(c);
        }
        self.rebuild_members();
    }

    /// The tracks' fields without their clips.
    pub fn track_infos(&self) -> Vec<Track> {
        self.tracks.iter().map(Track::info).collect()
    }
}

// ---- the file's shape of a sequence: one `clips` list ----

fn fps_ser<S: Serializer>(f: &Fps, s: S) -> Result<S::Ok, S::Error> {
    [f.num, f.den].serialize(s)
}

#[derive(Serialize)]
struct SeqOut<'a> {
    id: Id,
    name: &'a str,
    w: i64,
    h: i64,
    #[serde(serialize_with = "fps_ser")]
    fps: Fps,
    rate: i64,
    background: &'a str,
    #[serde(rename = "masterGain")]
    master_gain: f64,
    tracks: &'a [Track],
    clips: ClipsOut<'a>,
    transitions: &'a [Transition],
    markers: &'a [Marker],
    captions: &'a [CaptionTrack],
    #[serde(flatten)]
    extra: &'a Extra,
}

struct ClipsOut<'a>(&'a Sequence);

impl Serialize for ClipsOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.clips_in_order())
    }
}

impl Serialize for Sequence {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        SeqOut {
            id: self.id,
            name: &self.name,
            w: self.w,
            h: self.h,
            fps: self.fps,
            rate: self.rate,
            background: &self.background,
            master_gain: self.master_gain,
            tracks: &self.tracks,
            clips: ClipsOut(self),
            transitions: &self.transitions,
            markers: &self.markers,
            captions: &self.captions,
            extra: &self.extra,
        }
        .serialize(s)
    }
}

struct SeqIn {
    id: Id,
    name: String,
    w: i64,
    h: i64,
    fps: [u32; 2],
    rate: i64,
    background: String,
    master_gain: f64,
    tracks: Vec<Track>,
    clips: Vec<Clip>,
    transitions: Vec<Transition>,
    markers: Vec<Marker>,
    captions: Vec<CaptionTrack>,
    extra: Extra,
}

crate::de::with_extra!(SeqIn, "a sequence" {
    id: "id", name: "name", w: "w", h: "h", fps: "fps", rate: "rate", background: "background",
    master_gain: "masterGain", tracks: "tracks", clips: "clips", transitions: "transitions", markers: "markers",
    captions: "captions",
});

impl<'de> Deserialize<'de> for Sequence {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = SeqIn::deserialize(d)?;
        let mut seq = Sequence::new(s.id, s.name, s.w, s.h, Fps::new(s.fps[0], s.fps[1]), s.background, s.tracks);
        seq.rate = s.rate;
        seq.master_gain = s.master_gain;
        seq.transitions = s.transitions;
        seq.markers = s.markers;
        seq.captions = s.captions;
        seq.extra = s.extra;
        for c in s.clips {
            let Some(t) = seq.tracks.iter_mut().find(|t| t.id == c.track) else {
                return Err(D::Error::custom(format!("sequence {} clip {}: track {} missing", seq.id, c.id, c.track)));
            };
            seq.order.insert(usize::MAX, c.id);
            seq.index.insert(c.id, (c.track, c.start));
            t.clips.push(Box::new(c));
        }
        for t in &mut seq.tracks {
            t.clips.sort_by_key(|c| c.start);
        }
        seq.rebuild_members();
        if seq.index.len() != seq.order.len() {
            return Err(D::Error::custom(format!("sequence {}: a clip id is used twice", seq.id)));
        }
        Ok(seq)
    }
}
