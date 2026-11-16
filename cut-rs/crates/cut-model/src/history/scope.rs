//! What a step touched, read from its recorded changes: the clips, lists and fields that normalizing and validating
//! must look at again. Everything else was valid before the step and still is, except for the checks across the
//! project that the scope also names (a link's other clips, the transitions on a touched clip's track, the clips next
//! to it, ids used twice), so the checks of a step cost what it touched, not the size of the project.

use std::collections::{HashMap, HashSet};

use crate::id::Id;
use crate::project::{Clip, Project, Sequence};

use super::journal::Change;

/// What one sequence had touched.
#[derive(Debug, Default)]
pub(crate) struct SeqTouch {
    /// Clips changed, added or removed (by id; a removed one is no longer there).
    pub clips: HashSet<Id>,
    /// The links and groups those clips had before or have now.
    pub links: HashSet<Id>,
    pub groups: HashSet<Id>,
    pub transitions: bool,
    pub markers: bool,
    pub captions: bool,
    /// The sequence's own fields or its tracks' fields.
    pub info: bool,
    /// Its frame rate or its set of tracks changed: every clip of it is checked again.
    pub whole: bool,
}

/// What a step touched.
#[derive(Debug, Default)]
pub(crate) struct Scope {
    /// Media, bins or sequences were added, removed or changed: the whole project is checked.
    pub structural: bool,
    /// nextId went down: every id is checked against it.
    pub next_id_down: bool,
    pub project: bool,
    pub seqs: HashMap<Id, SeqTouch>,
}

impl Scope {
    /// Whether only a check of the whole project will do.
    pub fn full(&self) -> bool {
        self.structural || self.next_id_down || self.seqs.values().any(|s| s.whole)
    }
}

fn mark(touch: &mut SeqTouch, c: &Clip) {
    touch.clips.insert(c.id);
    if let Some(l) = c.link {
        touch.links.insert(l);
    }
    if let Some(g) = c.group {
        touch.groups.insert(g);
    }
}

/// The scope of recorded changes, against the project as it is now.
pub(crate) fn scope(changes: &[Change], p: &Project) -> Scope {
    let mut s = Scope::default();
    for c in changes {
        match c {
            Change::Clip { seq, image } => mark(s.seqs.entry(*seq).or_default(), image),
            Change::Added { seq, id, .. } => {
                s.seqs.entry(*seq).or_default().clips.insert(*id);
            }
            Change::Removed { seq, clip, .. } => mark(s.seqs.entry(*seq).or_default(), clip),
            Change::Transitions { seq, .. } => s.seqs.entry(*seq).or_default().transitions = true,
            Change::Markers { seq, .. } => s.seqs.entry(*seq).or_default().markers = true,
            Change::Captions { seq, .. } => s.seqs.entry(*seq).or_default().captions = true,
            Change::SeqInfo { seq, image } => {
                let t = s.seqs.entry(*seq).or_default();
                t.info = true;
                t.whole |= !p.sequence(*seq).is_some_and(|now| image.same_frame(now));
            }
            Change::Project { image } => {
                s.project = true;
                s.next_id_down |= image.next_id() > p.next_id;
            }
            Change::Media { .. } | Change::Bins { .. } | Change::SeqAdded { .. } | Change::SeqRemoved { .. } => {
                s.structural = true;
            }
        }
    }
    for (sid, t) in &mut s.seqs {
        let Some(seq) = p.sequence(*sid) else {
            s.structural = true;
            continue;
        };
        let now: Vec<&Clip> = t.clips.iter().filter_map(|id| seq.clip(*id)).collect();
        for c in now {
            if let Some(l) = c.link {
                t.links.insert(l);
            }
            if let Some(g) = c.group {
                t.groups.insert(g);
            }
        }
    }
    s
}

fn clip_ids(c: &Clip, out: &mut Vec<Id>) {
    out.push(c.id);
    out.extend(c.markers.iter().flatten().map(|m| m.id));
}

fn list_ids(seq: &Sequence, t: &SeqTouch, out: &mut Vec<Id>) {
    if t.transitions {
        out.extend(seq.transitions.iter().map(|x| x.id));
    }
    if t.markers {
        out.extend(seq.markers.iter().map(|x| x.id));
    }
    if t.captions {
        for ct in &seq.captions {
            out.push(ct.id);
            out.extend(ct.items.iter().map(|it| it.id));
        }
    }
}

/// The ids validation claims of what the scope names, as the project holds them now.
pub(crate) fn ids_now(s: &Scope, p: &Project) -> Vec<Id> {
    let mut out = Vec::new();
    for (sid, t) in &s.seqs {
        let Some(seq) = p.sequence(*sid) else { continue };
        for id in &t.clips {
            if let Some(c) = seq.clip(*id) {
                clip_ids(c, &mut out);
            }
        }
        list_ids(seq, t, &mut out);
    }
    out
}

/// The ids validation claimed of the same things before the changes of a command were made: the first copy each
/// change kept (a clip the command added had none). Only for a scope that is not structural.
pub(crate) fn ids_before(changes: &[Change]) -> Vec<Id> {
    let mut out = Vec::new();
    let mut clips: HashSet<(Id, Id)> = HashSet::new();
    for c in changes {
        match c {
            Change::Clip { seq, image } => {
                if clips.insert((*seq, image.id)) {
                    clip_ids(image, &mut out);
                }
            }
            Change::Removed { seq, clip, .. } => {
                if clips.insert((*seq, clip.id)) {
                    clip_ids(clip, &mut out);
                }
            }
            Change::Added { seq, id, .. } => {
                clips.insert((*seq, *id));
            }
            Change::Transitions { image, .. } => out.extend(image.iter().map(|x| x.id)),
            Change::Markers { image, .. } => out.extend(image.iter().map(|x| x.id)),
            Change::Captions { image, .. } => {
                for ct in image {
                    out.push(ct.id);
                    out.extend(ct.items.iter().map(|it| it.id));
                }
            }
            _ => {}
        }
    }
    out
}

/// How many times validation claims each id of the project.
pub(crate) fn claims(p: &Project) -> crate::id::IdMap<Id, u32> {
    let mut n: crate::id::IdMap<Id, u32> = Default::default();
    let mut add = |id: Id| *n.entry(id).or_default() += 1;
    p.media.iter().for_each(|m| add(m.id));
    p.bins.iter().for_each(|b| add(b.id));
    for s in &p.sequences {
        add(s.id);
        let mut ids = Vec::new();
        for c in s.clips() {
            clip_ids(c, &mut ids);
        }
        let all = SeqTouch { transitions: true, markers: true, captions: true, ..Default::default() };
        list_ids(s, &all, &mut ids);
        ids.into_iter().for_each(&mut add);
    }
    n
}
