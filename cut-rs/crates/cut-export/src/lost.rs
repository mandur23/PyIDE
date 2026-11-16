//! Media that cannot be shown or heard (`preflight`, `lostMedia`, `lostSound`): media offline when the export starts
//! is accepted (the dialog warned and asked) and exports as the red "media offline" picture with no sound; anything
//! else that cannot be read on the way stops the export, naming the clip, the sequence time and the reason.

use std::collections::{HashMap, HashSet};

use cut_model::{Clip, Id, Project, Sequence};
use cut_time::{Ticks, timecode};

use crate::sink::Failure;

/// A media file of the range that is not there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offline {
    pub id: Id,
    pub name: String,
    pub path: String,
}

/// The media of the clips in `[from, to)` whose files are missing, inside nests too (over the part a nest clip
/// shows).
pub fn preflight(project: &Project, seq: &Sequence, from: Ticks, to: Ticks) -> Vec<Offline> {
    fn gather<'a>(
        p: &'a Project,
        s: &'a Sequence,
        a: f64,
        b: f64,
        used: &mut HashMap<Id, &'a cut_model::Media>,
        depth: u32,
    ) {
        for c in s.clips() {
            if !c.enabled || (c.end() as f64) <= a || (c.start as f64) >= b {
                continue;
            }
            if let Some(inner) = p.nest_of(c) {
                if depth < 64 {
                    let (x, y) = c.source_span(a.max(c.start as f64), b.min(c.end() as f64));
                    gather(p, inner, x, y + 1.0, used, depth + 1);
                }
                continue;
            }
            if let Some(m) = c.media_id().and_then(|id| p.media(id)) {
                used.insert(m.id, m);
            }
        }
    }
    let mut used = HashMap::new();
    gather(project, seq, from as f64, to as f64, &mut used, 0);
    let mut out: Vec<Offline> = used
        .values()
        .filter(|m| !std::fs::metadata(&m.path).is_ok_and(|x| x.is_file()))
        .map(|m| Offline { id: m.id, name: m.name.clone(), path: m.path.clone() })
        .collect();
    out.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
    out
}

/// A picture or sound that could not be read: its clip (none for a source), its media and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lost {
    pub clip: Option<Id>,
    pub media: Option<Id>,
    pub error: String,
}

/// Picture or sound, for the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum What {
    Picture,
    Sound,
}

/// A clip by id, or the first that uses a media, in any sequence (a nest's clips are in theirs).
fn find_clip(project: &Project, id: Option<Id>, media: Option<Id>) -> Option<&Clip> {
    project.sequences.iter().find_map(|q| match id {
        Some(id) => q.clip(id),
        None => q.clips_in_order().find(|c| media.is_some() && c.media_id() == media),
    })
}

/// The failure for the first of `lost` whose media was not offline from the start (`accepted`), or none.
pub fn lost_media(
    project: &Project,
    seq: &Sequence,
    t: Ticks,
    lost: &[Lost],
    accepted: &HashSet<Id>,
    what: What,
) -> Option<Failure> {
    let x = lost.iter().find(|x| !x.media.is_some_and(|m| accepted.contains(&m)))?;
    let clip = match x.clip {
        Some(id) => find_clip(project, Some(id), None),
        None if x.media.is_some_and(|m| project.media(m).is_some()) => find_clip(project, None, x.media),
        None => None,
    };
    let media = x.media.or_else(|| clip.and_then(Clip::media_id)).and_then(|m| project.media(m));
    let name = clip
        .map(|c| c.name.clone())
        .filter(|n| !n.is_empty())
        .or_else(|| media.map(|m| m.name.clone()).filter(|n| !n.is_empty()))
        .unwrap_or_else(|| x.clip.or(x.media).map_or_else(|| "?".to_owned(), |i| i.as_str().to_owned()));
    let error = if x.error.is_empty() { "unknown error".to_owned() } else { x.error.clone() };
    let message = match what {
        What::Sound => "The sound of {clip} could not be read at {time} ({error}), so the export was stopped.",
        What::Picture => "The picture of {clip} could not be read at {time} ({error}), so the export was stopped.",
    };
    Some(Failure::with("media", message, &[("clip", name), ("time", timecode(t, seq.fps)), ("error", error)]))
}

/// The sound clips of one mix that are missing or whose source failed (`lostSound`).
pub fn lost_sound(missed: &[(Id, Option<Id>)], failures: &[cut_audio::Failure]) -> Vec<Lost> {
    let mut out: Vec<Lost> = missed
        .iter()
        .map(|(clip, media)| Lost { clip: Some(*clip), media: *media, error: "the sound is not read".into() })
        .collect();
    out.extend(failures.iter().map(|f| Lost { clip: None, media: f.media, error: f.error.clone() }));
    // a failed source makes its clips missing too: the source's reason is the useful one
    for x in &mut out {
        if x.clip.is_some()
            && let Some(f) = failures.iter().find(|f| f.media == x.media)
        {
            x.error = f.error.clone();
        }
    }
    out
}
