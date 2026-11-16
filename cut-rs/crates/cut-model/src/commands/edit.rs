//! The edits commands are made of (port of commands.js's "clip edits" and ripples): a clip's head or end moving, a
//! clip cut in two, a range cleared off a track, time inserted or removed on the tracks a ripple changes.

use std::collections::{HashMap, HashSet};

use cut_time::Ticks;
use serde_json::Value as Json;

use super::{Ctx, R, fail, id_list};
use crate::captionwords::{self as cw, Doubt, Word};
use crate::history::journal::Tx;
use crate::id::Id;
use crate::keyframes::{self, Ease, Keyframe};
use crate::project::{Caption, Clip, Project};
use crate::remap::{self as R_, Remap};

impl Ctx<'_> {
    /// The clips and those linked to them; with `groups`, also the members of their groups (and what those link to).
    /// In the order the JavaScript's set takes them: the given ones, then the others in list order.
    pub fn with_linked(&self, ids: Option<&Json>, linked: bool, groups: bool) -> R<Vec<Id>> {
        let mut out: Vec<Id> = Vec::new();
        for id in id_list(ids, "clipIds")? {
            let Some(id) = id.filter(|id| self.seq().clip(*id).is_some()) else {
                return fail(
                    format!("there is no clip {}", id.map_or("undefined", |i| i.as_str())),
                    super::Code::NotFound,
                );
            };
            if !out.contains(&id) {
                out.push(id);
            }
        }
        if !linked {
            return Ok(out);
        }
        let seq = self.seq();
        loop {
            let size = out.len();
            let mut seen: HashSet<Id> = out.iter().copied().collect();
            let links: HashSet<Id> = out.iter().filter_map(|id| seq.clip(*id).and_then(|c| c.link)).collect();
            let gs: HashSet<Id> = if groups {
                out.iter().filter_map(|id| seq.clip(*id).and_then(|c| c.group)).collect()
            } else {
                HashSet::new()
            };
            // the clips of those links and groups, in the file's order
            let mut hits: Vec<Id> = links
                .iter()
                .flat_map(|l| seq.link_members(*l))
                .chain(gs.iter().flat_map(|g| seq.group_members(*g)))
                .copied()
                .filter(|x| seen.insert(*x))
                .collect();
            hits.sort_by_key(|x| seq.order_of(*x));
            out.extend(hits);
            if out.len() == size {
                return Ok(out);
            }
        }
    }

    /// Keyframes and clip markers count from the clip's start: when it moves by d over the same content they move by -d.
    fn shift_keys(&mut self, id: Id, d: Ticks) {
        if d == 0 {
            return;
        }
        self.edit(id, |c| {
            for list in c.keyframes.values_mut() {
                for k in list {
                    k.t -= d;
                }
            }
            if let Some(m) = c.markers.as_mut().filter(|m| !m.is_empty()) {
                for x in m {
                    x.t -= d;
                }
            }
        });
    }

    pub fn clamp_fades(&mut self, id: Id, d: Ticks) {
        self.edit(id, |c| {
            let fi = c.fade_in.min(d);
            c.fade_in = fi;
            c.fade_out = c.fade_out.min(d - fi);
        });
    }

    /// A remapped clip plays `r` from now on; in/out become what it reaches. A curve without keys is a constant speed.
    pub fn set_curve(&mut self, id: Id, r: Remap) {
        let (lo, hi) = R_::range(&r);
        self.edit(id, |c| {
            if R_::is_constant(&r) {
                c.speed = r.speeds[0].abs();
                c.reverse = r.speeds[0] < 0.0;
                c.remap = None;
            } else {
                c.remap = Some(r);
                c.speed = 1.0;
                c.reverse = false;
            }
            c.in_ = lo;
            c.out = hi;
        });
    }

    /// The clip's head moves to `ns`, its end stays; the source side shown first follows.
    pub fn set_start(&mut self, id: Id, ns: Ticks) {
        let c = self.clip(id).expect("a clip of the command").clone();
        let d = ns - c.start;
        if d == 0 {
            return;
        }
        let nd = c.end() - ns;
        let still = self.still(&c);
        if let Some(r) = &c.remap {
            self.set_curve(id, R_::shift(r, d));
        } else if still || c.reverse {
            self.edit(id, |x| x.out = x.in_ + nd as f64 * x.speed);
        } else {
            self.edit(id, |x| x.in_ = x.out - nd as f64 * x.speed);
        }
        self.edit(id, |x| x.start = ns);
        self.shift_keys(id, d);
        self.clamp_fades(id, nd);
    }

    /// The clip's end moves to `ne`.
    pub fn set_end(&mut self, id: Id, ne: Ticks) {
        let c = self.clip(id).expect("a clip of the command").clone();
        let nd = ne - c.start;
        if nd == c.duration() {
            return;
        }
        let still = self.still(&c);
        if let Some(r) = &c.remap {
            self.set_curve(id, R_::with_duration(r, nd));
        } else if still || !c.reverse {
            self.edit(id, |x| x.out = x.in_ + nd as f64 * x.speed);
        } else {
            self.edit(id, |x| x.in_ = x.out - nd as f64 * x.speed);
        }
        self.clamp_fades(id, nd);
    }

    /// How far the source lets the clip grow at its head and its tail, in whole timeline frames.
    pub fn room(&self, clip: &Clip) -> (f64, f64) {
        let r = self.p.source_room(clip);
        (self.floor_frames(r.head), self.floor_frames(r.tail))
    }

    /// The end of the clip before and the start of the clip after on the same track (0 and infinity when none).
    pub fn neighbours(&self, clip: &Clip) -> (f64, f64) {
        let mut prev_end = 0.0_f64;
        let mut next_start = f64::INFINITY;
        let e = clip.end();
        if let Some(t) = self.seq().track(clip.track) {
            for o in t.clips.iter().filter(|o| o.id != clip.id) {
                let oe = o.end();
                if oe <= clip.start && oe as f64 > prev_end {
                    prev_end = oe as f64;
                }
                if o.start >= e && (o.start as f64) < next_start {
                    next_start = o.start as f64;
                }
            }
        }
        (prev_end, next_start)
    }

    /// Splits the clip at `p` (start < p < end): it keeps the left part and its id, a new clip after it in the list
    /// takes the right part. Right parts of linked clips cut at the same time share a new link.
    pub fn split_clip(&mut self, id: Id, p: Ticks) -> Id {
        let clip = self.clip(id).expect("a clip of the command").clone();
        let off = p - clip.start;
        let rd = clip.duration() - off;
        let mut right = clip.clone();
        right.id = self.nid("c");
        right.start = p;
        if let Some(r) = &clip.remap {
            let rr = R_::shift(r, off);
            (right.in_, right.out) = R_::range(&rr);
            if R_::is_constant(&rr) {
                right.speed = rr.speeds[0].abs();
                right.reverse = rr.speeds[0] < 0.0;
                right.remap = None;
            } else {
                right.remap = Some(rr);
            }
        } else if self.still(&clip) || clip.reverse {
            right.out = clip.in_ + rd as f64 * clip.speed;
        } else {
            right.in_ = clip.out - rd as f64 * clip.speed;
        }
        right.fade_in = 0;
        right.fade_out = clip.fade_out.min(rd);
        let mut left_keys = Vec::new();
        right.keyframes.clear();
        for (prop, list) in &clip.keyframes {
            let (l, r) = split_keys(list, off);
            left_keys.push((prop.clone(), l));
            right.keyframes.insert(prop.clone(), r);
        }
        if let Some(m) = &clip.markers {
            right.markers = Some(
                m.iter().filter(|x| x.t >= off).map(|x| crate::project::Marker { t: x.t - off, ..x.clone() }).collect(),
            );
        }
        if let Some(l) = clip.link {
            let link = match self.split_links.get(&(l, p)) {
                Some(&x) => x,
                None => {
                    let x = self.nid("L");
                    self.split_links.insert((l, p), x);
                    x
                }
            };
            right.link = Some(link);
        }
        let rid = right.id;
        let pos = self.seq().order_of(id).map(|i| i + 1);
        self.add(right, pos);
        self.edit(id, |c| c.fade_out = 0);
        self.set_end(id, p);
        self.edit(id, |c| {
            for (prop, l) in left_keys {
                c.keyframes.insert(prop, l);
            }
            if let Some(m) = c.markers.as_mut() {
                m.retain(|x| x.t < off);
            }
        });
        rid
    }

    /// Takes `[a, b)` off a track: clips inside go, clips across an end are trimmed, a clip across both is cut in two.
    pub fn clear_range(&mut self, track: Id, a: Ticks, b: Ticks) {
        for id in self.clips_on(track) {
            let Ok(c) = self.clip(id) else { continue };
            let (s, e) = (c.start, c.end());
            if e <= a || s >= b {
                continue;
            }
            if s >= a && e <= b {
                self.remove(id);
            } else if s < a && e > b {
                self.split_clip(id, b);
                self.set_end(id, a);
            } else if s < a {
                self.set_end(id, a);
            } else {
                self.set_start(id, b);
            }
        }
    }

    fn insert_time(&mut self, track: Id, p: Ticks, l: Ticks) {
        for id in self.clips_on(track) {
            let c = self.clip(id).expect("listed");
            if c.start < p && c.end() > p {
                self.split_clip(id, p);
            }
        }
        let later: Vec<Id> = self
            .seq()
            .track(track)
            .map(|t| t.clips.iter().filter(|c| c.start >= p).map(|c| c.id).collect())
            .unwrap_or_default();
        for id in later.into_iter().rev() {
            self.edit(id, |c| c.start += l);
        }
        if self.seq().transitions.iter().any(|t| t.track == track && t.at >= p) {
            for t in self.transitions_mut().iter_mut().filter(|t| t.track == track && t.at >= p) {
                t.at += l;
            }
        }
    }

    fn remove_time(&mut self, track: Id, a: Ticks, b: Ticks) {
        let l = b - a;
        self.clear_range(track, a, b);
        if self.seq().transitions.iter().any(|t| t.track == track && t.at >= a) {
            let ts = self.transitions_mut();
            ts.retain(|t| !(t.track == track && t.at >= a && t.at <= b));
            for t in ts.iter_mut().filter(|t| t.track == track && t.at > b) {
                t.at -= l;
            }
        }
        let later: Vec<Id> = self
            .seq()
            .track(track)
            .map(|t| t.clips.iter().filter(|c| c.start >= b).map(|c| c.id).collect())
            .unwrap_or_default();
        for id in later {
            self.edit(id, |c| c.start -= l);
        }
    }

    fn captions_insert(&mut self, ci: usize, p: Ticks, l: Ticks) {
        let shift = move |x: Ticks, is_end: bool| if if is_end { x > p } else { x >= p } { x + l } else { x };
        let items = self.seq().captions[ci].items.clone();
        let mut pieces = Vec::new();
        let mut next = Vec::with_capacity(items.len());
        for it in items {
            let mut it = it;
            if it.start < p {
                if it.end > p {
                    let (words, doubt) = timed(&it, p + l, it.end + l, shift, None);
                    let id = self.nid("cap");
                    pieces.push(Caption {
                        id,
                        start: p + l,
                        end: it.end + l,
                        text: it.text.clone(),
                        doubt,
                        words,
                        speaker: it.speaker.clone(),
                        extra: Default::default(),
                    });
                }
                let t = timed(&it, it.start, it.end.min(p), shift, None);
                retime(&mut it, t);
                if it.end > p {
                    it.end = p;
                }
            } else {
                it.start += l;
                it.end += l;
            }
            next.push(it);
        }
        for piece in pieces {
            insert_sorted(&mut next, piece);
        }
        self.captions_mut()[ci].items = next;
    }

    fn captions_remove(&mut self, ci: usize, a: Ticks, b: Ticks) {
        let l = b - a;
        let map = move |x: Ticks, _: bool| {
            if x <= a {
                x
            } else if x < b {
                a
            } else {
                x - l
            }
        };
        let items = self.seq().captions[ci].items.clone();
        let mut next = Vec::with_capacity(items.len());
        for mut it in items {
            let (s, e) = (map(it.start, false), map(it.end, false));
            if e <= s {
                continue;
            }
            let t = timed(&it, s, e, map, Some((a, b)));
            retime(&mut it, t);
            it.start = s;
            it.end = e;
            next.push(it);
        }
        self.captions_mut()[ci].items = next;
    }

    fn markers_insert(&mut self, p: Ticks, l: Ticks) {
        for m in self.markers_mut() {
            if m.t >= p {
                m.t += l;
            } else if m.t + m.duration > p {
                m.duration += l;
            }
        }
    }

    fn markers_remove(&mut self, a: Ticks, b: Ticks) {
        let l = b - a;
        let map = |x: Ticks| {
            if x <= a {
                x
            } else if x < b {
                a
            } else {
                x - l
            }
        };
        for m in self.markers_mut() {
            let t = map(m.t);
            m.duration = map(m.t + m.duration) - t;
            m.t = t;
        }
    }

    /// The tracks a ripple changes: the unlocked ones it targets, then every unlocked sync-locked track.
    pub fn ripple_tracks(&self, involved: &[Id]) -> R<Vec<Id>> {
        let mut out = Vec::new();
        for id in involved {
            if !self.track(*id)?.locked && !out.contains(id) {
                out.push(*id);
            }
        }
        for t in &self.seq().tracks {
            if t.sync_lock && !t.locked && !out.contains(&t.id) {
                out.push(t.id);
            }
        }
        Ok(out)
    }

    fn every_track(&self, list: &[Id]) -> bool {
        self.seq().tracks.iter().all(|t| t.locked || list.contains(&t.id))
    }

    /// Time `l` inserted at `p` on the targeted and the sync-locked tracks, captions and (when every track moves) markers.
    pub fn ripple_insert(&mut self, involved: &[Id], p: Ticks, l: Ticks) -> R<()> {
        if l <= 0 {
            return Ok(());
        }
        let list = self.ripple_tracks(involved)?;
        for id in &list {
            self.insert_time(*id, p, l);
        }
        for ci in 0..self.seq().captions.len() {
            if self.seq().captions[ci].sync_lock {
                self.captions_insert(ci, p, l);
            }
        }
        if self.every_track(&list) {
            self.markers_insert(p, l);
        }
        Ok(())
    }

    /// `[a, b)` taken away on the targeted and the sync-locked tracks, captions and (when every track moves) markers.
    pub fn ripple_remove(&mut self, involved: &[Id], a: Ticks, b: Ticks) -> R<()> {
        if b <= a {
            return Ok(());
        }
        let list = self.ripple_tracks(involved)?;
        for id in &list {
            self.remove_time(*id, a, b);
        }
        for ci in 0..self.seq().captions.len() {
            if self.seq().captions[ci].sync_lock {
                self.captions_remove(ci, a, b);
            }
        }
        if self.every_track(&list) {
            self.markers_remove(a, b);
        }
        Ok(())
    }
}

/// `arr` with `item` after the items that start at or before it.
pub(crate) fn insert_sorted(arr: &mut Vec<Caption>, item: Caption) {
    let mut i = arr.len();
    while i > 0 && arr[i - 1].start > item.start {
        i -= 1;
    }
    arr.insert(i, item);
}

/// A caption's word timings and doubt moved with their sound by `f`, for the caption now at `[to, end)`; `cut`: the
/// range a ripple took away, whose doubtful words are gone.
pub(crate) fn timed(
    it: &Caption,
    to: Ticks,
    end: Ticks,
    mut f: impl FnMut(Ticks, bool) -> Ticks,
    cut: Option<(Ticks, Ticks)>,
) -> (Option<Vec<Word>>, Option<Vec<Doubt>>) {
    let words = it.words.as_ref().map(|w| cw::remap(w, it.start, to, &mut f));
    let heard: Option<Vec<Doubt>> = match (cut, &it.doubt) {
        (Some((a, b)), Some(d)) => {
            Some(d.iter().filter(|x| it.start + x.at < a || it.start + x.at >= b).cloned().collect())
        }
        (_, d) => d.clone(),
    };
    let doubt = heard.map(|h| cw::remap_doubt(&h, it.start, to, &mut f, end - to)).filter(|d| !d.is_empty());
    (words, doubt)
}

pub(crate) fn retime(it: &mut Caption, (words, doubt): (Option<Vec<Word>>, Option<Vec<Doubt>>)) {
    if let Some(w) = words {
        it.words = Some(w);
    }
    it.doubt = doubt;
}

/// A keyframe list cut at clip time `off`: the left part ends on the value there, the right part starts on it (times
/// from the right piece's start).
pub(crate) fn split_keys(list: &[Keyframe], off: Ticks) -> (Vec<Keyframe>, Vec<Keyframe>) {
    let v = keyframes::value_at(list, off as f64).expect("a keyframe list is not empty");
    let before: Vec<&Keyframe> = list.iter().filter(|k| k.t < off).collect();
    let on = list.iter().find(|k| k.t == off);
    let after: Vec<&Keyframe> = list.iter().filter(|k| k.t > off).collect();
    let mut left: Vec<Keyframe> = before.iter().map(|k| (*k).clone()).collect();
    if let Some(on) = on {
        left.push(on.clone());
    } else if !after.is_empty() || left.is_empty() {
        left.push(Keyframe { t: off, v: v.clone(), ease: Ease::Linear, h: None });
    }
    let mut right = Vec::new();
    if let Some(on) = on {
        right.push(Keyframe { t: 0, ..on.clone() });
    } else if let Some(p) = before.last() {
        let h = if p.ease == Ease::Bezier { p.h.clone() } else { None };
        right.push(Keyframe { t: 0, v, ease: p.ease, h });
    }
    for k in after {
        right.push(Keyframe { t: k.t - off, ..k.clone() });
    }
    (left, right)
}

/// Joins overlapping or touching ranges.
pub(crate) fn merge_ranges(list: &[(Ticks, Ticks)]) -> Vec<(Ticks, Ticks)> {
    let mut sorted = list.to_vec();
    sorted.sort_by_key(|r| r.0);
    let mut out: Vec<(Ticks, Ticks)> = Vec::new();
    for r in sorted {
        match out.last_mut() {
            Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => out.push(r),
        }
    }
    out
}

/// After every command: links and groups of one clip are cleared, transitions off every clip edge (or doubled) go.
pub(crate) fn normalize(p: &mut Project, tx: &mut Tx) {
    for si in 0..p.sequences.len() {
        let seq = &p.sequences[si];
        let sid = seq.id;
        let mut links: HashMap<Id, usize> = HashMap::new();
        let mut groups: HashMap<Id, usize> = HashMap::new();
        for c in seq.clips() {
            if let Some(l) = c.link {
                *links.entry(l).or_default() += 1;
            }
            if let Some(g) = c.group {
                *groups.entry(g).or_default() += 1;
            }
        }
        let lone: Vec<(Id, bool, bool)> = seq
            .clips_in_order()
            .filter_map(|c| {
                let l = c.link.is_some_and(|l| links[&l] < 2);
                let g = c.group.is_some_and(|g| groups[&g] < 2);
                (l || g).then_some((c.id, l, g))
            })
            .collect();
        for (id, l, g) in lone {
            tx.clip(p, sid, id);
            p.sequences[si].edit_clip(id, |c| {
                if l {
                    c.link = None;
                }
                if g {
                    c.group = None;
                }
            });
        }
        drop_off_edge(p, tx, si);
    }
}

/// The transitions of a sequence off every clip edge, or a second one at a point, go.
fn drop_off_edge(p: &mut Project, tx: &mut Tx, si: usize) {
    let seq = &p.sequences[si];
    let sid = seq.id;
    let mut seen = HashSet::new();
    let keep: Vec<bool> = seq
        .transitions
        .iter()
        .map(|t| {
            let on_edge = seq.track(t.track).is_some_and(|tr| tr.has_edge(t.at));
            let ok = on_edge && !seen.contains(&(t.track, t.at));
            seen.insert((t.track, t.at));
            ok
        })
        .collect();
    if keep.contains(&false) {
        tx.transitions(p, sid);
        let mut i = 0;
        p.sequences[si].transitions.retain(|_| {
            i += 1;
            keep[i - 1]
        });
    }
}

/// [`normalize`] of what a step touched: the links and groups its clips had or have, the transitions of its
/// sequences. Nothing else can have become a link of one clip or a transition off an edge.
pub(crate) fn normalize_scope(p: &mut Project, tx: &mut Tx, scope: &crate::history::scope::Scope) {
    for (sid, t) in &scope.seqs {
        let Some(si) = p.sequences.iter().position(|s| s.id == *sid) else { continue };
        let seq = &p.sequences[si];
        let mut lone: Vec<(Id, bool)> = Vec::new();
        for l in &t.links {
            if let [c] = seq.link_members(*l) {
                lone.push((*c, true));
            }
        }
        for g in &t.groups {
            if let [c] = seq.group_members(*g) {
                lone.push((*c, false));
            }
        }
        for (id, link) in lone {
            tx.clip(p, *sid, id);
            p.sequences[si].edit_clip(id, |c| {
                if link {
                    c.link = None;
                } else {
                    c.group = None;
                }
            });
        }
        if t.transitions || t.info || !t.clips.is_empty() {
            drop_off_edge(p, tx, si);
        }
    }
}
