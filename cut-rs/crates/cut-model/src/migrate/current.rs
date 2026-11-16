//! Whether `migrate` would change a project read straight into the types: a file this version wrote needs none of
//! it, so [`crate::Project::load`] skips the JSON tree. Each check stands for one thing `migrate` does that the types
//! do not already refuse (a missing field the types require, an old ease name, a proxy as text); a project that
//! passes them all is what `migrate` would give back, which `tests/load.rs` checks on every project the tests have
//! and on thousands of broken variants of them.

use cut_time::{Fps, Ticks};

use crate::captionwords;
use crate::defaults;
use crate::masks;
use crate::migrate::snap_f;
use crate::project::{Clip, Project, Sequence, Source, TrackKind};
use crate::query::{VERSION, frame, valid_fps};
use crate::remap as R;

/// Whether `migrate` leaves this project as it is.
pub fn is_current(p: &Project) -> bool {
    if p.format != "ncut" || p.version != VERSION {
        return false;
    }
    if !defaults::default_settings().keys().all(|k| p.settings.contains_key(k)) {
        return false;
    }
    if p.media.iter().any(|m| m.size.is_null() || m.mtime.is_null()) {
        return false;
    }
    let mut max_id = 0_i64;
    let mut seen = |id: crate::id::Id| {
        if let Some(n) = id.number() {
            max_id = max_id.max(n);
        }
    };
    for m in &p.media {
        seen(m.id);
    }
    for b in &p.bins {
        seen(b.id);
    }
    for s in &p.sequences {
        seen(s.id);
        for c in s.clips() {
            seen(c.id);
            c.markers.iter().flatten().for_each(|m| seen(m.id));
        }
        s.transitions.iter().for_each(|t| seen(t.id));
        s.markers.iter().for_each(|m| seen(m.id));
        for ct in &s.captions {
            seen(ct.id);
            ct.items.iter().for_each(|it| seen(it.id));
        }
    }
    if p.next_id < max_id.saturating_add(1) {
        return false;
    }
    if !luts_current(p) {
        return false;
    }
    p.sequences.iter().all(|s| sequence_current(p, s))
}

fn luts_current(p: &Project) -> bool {
    let Some(l) = &p.luts else { return true };
    let Some(l) = l.as_object().filter(|l| !l.is_empty()) else { return false };
    let used = p.luts_in_use();
    l.iter().all(|(id, e)| used.contains(id) && crate::lumetri::valid_id(id) && crate::lumetri::valid_entry(e))
}

fn sequence_current(p: &Project, s: &Sequence) -> bool {
    if !s.parked.is_empty() {
        return false;
    }
    for t in &s.tracks {
        let full = match t.kind {
            TrackKind::Video => t.visible.is_some(),
            TrackKind::Audio => t.mute.is_some() && t.solo.is_some() && t.volume.is_some() && t.pan.is_some(),
        };
        if !full {
            return false;
        }
    }
    let style = defaults::default_caption_style();
    let short = s.w.min(s.h) as f64;
    for ct in &s.captions {
        if !style.keys().all(|k| ct.style.contains_key(k)) {
            return false;
        }
        let rescaled = ct.style.get("ref").is_none_or(serde_json::Value::is_null)
            && ct.style.get("size").and_then(serde_json::Value::as_f64).is_some_and(|x| x.is_finite() && x != 54.0)
            && short > 0.0;
        if rescaled {
            return false;
        }
    }
    let fps = valid_fps(s.fps).then_some(s.fps);
    for c in s.clips() {
        let kind = s.track(c.track).map(|t| t.kind);
        if kind != Some(c.props.kind()) || !masks_current(c, kind) {
            return false;
        }
        if let Some(fps) = fps
            && !clip_times_current(p, c, kind, fps)
        {
            return false;
        }
    }
    let Some(fps) = fps else { return true };
    let f = frame(fps);
    let sn = |t: Ticks| snap_f(t as f64, fps, true);
    if s.markers.iter().any(|m| sn(m.t) != m.t || sn(m.duration) != m.duration) {
        return false;
    }
    for ct in &s.captions {
        let mut last = Ticks::MIN;
        for it in &ct.items {
            let start = sn(it.start);
            if start != it.start || (start + f).max(sn(it.end)) != it.end || it.start < last {
                return false;
            }
            last = it.start;
            if let Some(w) = &it.words {
                let words = serde_json::to_value(w).expect("words serialize");
                if captionwords::realign(&words, &it.text, f, Some(it.end - it.start)).as_ref() != Some(w) {
                    return false;
                }
            }
        }
    }
    true
}

/// The clip's keyframe, marker and remap times as `snap_times` leaves them.
fn clip_times_current(p: &Project, c: &Clip, kind: Option<TrackKind>, fps: Fps) -> bool {
    let f = frame(fps);
    let sn = |t: Ticks| snap_f(t as f64, fps, true);
    if let Some(r) = &c.remap {
        let still = match &c.source {
            Source::Generator { .. } | Source::Media { freeze: true, .. } => true,
            Source::Media { media, .. } => {
                p.media.iter().any(|m| m.id == *media && m.kind == crate::project::MediaKind::Image)
            }
            Source::Nest { .. } => false,
        };
        if !R::valid(r, f) || kind != Some(TrackKind::Video) || still {
            return false;
        }
        let (lo, hi) = R::range(r);
        if c.in_ != lo || c.out != hi || c.speed != 1.0 || c.reverse {
            return false;
        }
    }
    for list in c.keyframes.values() {
        let mut last = Ticks::MIN;
        for k in list {
            if sn(k.t) != k.t || k.t <= last {
                return false;
            }
            last = k.t;
        }
    }
    c.markers.iter().flatten().all(|m| sn(m.t) == m.t && sn(m.duration) == m.duration)
}

/// The masks as `migrate_masks` keeps them: on a video clip, 1 to 16 a list, ids once a list, whole; keyframes only of
/// masks that are there, with values their field takes. A mask path in the keyframes of a clip without masks is
/// left to `migrate`, which knows whether the file had an empty `masks` field.
fn masks_current(c: &Clip, kind: Option<TrackKind>) -> bool {
    let holders: Vec<(Option<crate::id::Id>, &Vec<masks::Mask>)> = std::iter::once((None, c.masks.as_ref()))
        .chain(c.effects.iter().map(|e| (Some(e.id), e.masks.as_ref())))
        .filter_map(|(e, l)| l.map(|l| (e, l)))
        .collect();
    let mask_keys = c.keyframes.keys().any(|k| k.starts_with("masks.") || k.contains(".masks."));
    if holders.is_empty() {
        return !mask_keys;
    }
    if kind != Some(TrackKind::Video) {
        return false;
    }
    for (_, list) in &holders {
        if list.is_empty() || list.len() > masks::MAX_MASKS {
            return false;
        }
        let mut ids = std::collections::HashSet::new();
        for m in list.iter() {
            let whole = masks::full(&serde_json::to_value(m).expect("a mask serializes")).as_ref() == Some(m);
            if !whole || !ids.insert(m.id) {
                return false;
            }
        }
    }
    for (prop, list) in &c.keyframes {
        let parsed = masks::parse_path(prop, false);
        if parsed.is_none() && !prop.starts_with("masks.") && !prop.contains(".masks.") {
            continue;
        }
        let Some(pp) = parsed else { return false };
        let there = holders
            .iter()
            .any(|(e, l)| e.map(|e| e.as_str()) == pp.effect_id && l.iter().any(|m| m.id.as_str() == pp.mask_id));
        // an effect named twice: migrate looks in the first one only
        let first = pp.effect_id.is_none_or(|e| {
            c.effects
                .iter()
                .find(|x| x.id.as_str() == e)
                .is_some_and(|x| x.masks.as_ref().is_some_and(|l| l.iter().any(|m| m.id.as_str() == pp.mask_id)))
        });
        if !there || !first {
            return false;
        }
        let all_good =
            list.iter().all(|k| masks::valid_field(pp.field, &serde_json::to_value(&k.v).expect("a value serializes")));
        if !all_good {
            return false;
        }
    }
    true
}
