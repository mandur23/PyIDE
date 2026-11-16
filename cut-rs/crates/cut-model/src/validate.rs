//! `validate`: what every project must satisfy, before it is edited and after every edit (port of model.js's
//! `validate`; the messages are the JavaScript's).
//!
//! The types already hold what the JavaScript checks of a value's JSON type (a flag that is a boolean, a time that
//! is a number), so those checks are not repeated here: a file that breaks one does not load as a [`Project`]. Graphic
//! layers are checked by [`crate::graphic`] and LUT entries by [`crate::lumetri`], as the JavaScript's validate asks
//! `graphic.js` and `lumetri.js`.

use std::collections::{HashMap, HashSet};

use cut_time::{MAX_TICKS, Ticks};

use crate::captionwords;
use crate::id::Id;
use crate::keyframes::Value as KfValue;
use crate::masks;
use crate::project::{Clip, Generator, Marker, MediaKind, Project, Props, Sequence, Source, TrackKind};
use crate::query::{VERSION, frame, valid_fps};
use crate::remap as R;

/// The outcome: the problems found, at most 200 (none: the project is valid).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Validation {
    pub errors: Vec<String>,
}

impl Validation {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

struct Check<'a> {
    errors: Vec<String>,
    ids: HashSet<Id>,
    /// Whether a claim checks that no other claim had the id (a scoped check leaves that to its caller's counts).
    unique: bool,
    next_id: i64,
    project: &'a Project,
}

impl Check<'_> {
    fn err(&mut self, msg: String) {
        if self.errors.len() < 200 {
            self.errors.push(msg);
        }
    }

    fn claim(&mut self, id: Id, what: impl std::fmt::Display) {
        if id.as_str().is_empty() {
            return self.err(format!("{what} has no id"));
        }
        if self.unique && !self.ids.insert(id) {
            self.err(format!("id {id} is used twice ({what})"));
        }
        if let Some(n) = id.number()
            && n >= self.next_id
        {
            self.err(format!("id {id} is not below nextId {}", self.next_id));
        }
    }
}

pub(crate) fn is_color(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() == 7 || b.len() == 9) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

/// The prop paths keyframes may animate on this clip: a property, an effect parameter, a mask field, a layer field.
pub fn valid_prop_path(clip: &Clip, kind: TrackKind, prop: &str) -> bool {
    let parts: Vec<&str> = prop.split('.').collect();
    let effect = |id: &str| clip.effects.iter().find(|e| e.id.as_str() == id);
    match parts[..] {
        [p] => match kind {
            TrackKind::Audio => matches!(p, "volume" | "pan" | "duck"),
            TrackKind::Video => crate::defaults::VIDEO_PROPS.contains(&p),
        },
        ["effects", _, "masks"] => false,
        ["effects", id, param] => !param.is_empty() && effect(id).is_some(),
        ["masks", id, field] => {
            kind == TrackKind::Video
                && masks::FIELDS.contains(&field)
                && clip.masks.iter().flatten().any(|m| m.id.as_str() == id)
        }
        ["effects", e, "masks", id, field] => {
            kind == TrackKind::Video
                && masks::FIELDS.contains(&field)
                && effect(e).and_then(|e| e.masks.as_ref()).into_iter().flatten().any(|m| m.id.as_str() == id)
        }
        ["layers", id, field] => {
            !field.is_empty()
                && match &clip.source {
                    Source::Generator { layers: Some(l), .. } => {
                        l.iter().any(|x| x.get("id").and_then(|v| v.as_str()) == Some(id))
                    }
                    _ => false,
                }
        }
        _ => false,
    }
}

fn kf_value_ok(v: &KfValue) -> bool {
    match v {
        KfValue::Num(x) => x.is_finite(),
        KfValue::List(a) => !a.is_empty() && a.iter().all(|x| x.is_finite()),
        KfValue::Text(_) | KfValue::Flag(_) => true,
    }
}

/// Checks a project; see the module's notes for what the types check instead.
pub fn validate(project: &Project) -> Validation {
    let mut c = Check { errors: Vec::new(), ids: HashSet::new(), unique: true, next_id: project.next_id, project };
    project_fields(&mut c, project);
    let mut media_kind = HashMap::new();
    for m in &project.media {
        c.claim(m.id, "media");
        media_kind.insert(m.id, m);
        if !m.duration.is_finite() || m.duration < 0.0 {
            c.err(format!("media {}: duration", m.id));
        }
        if m.kind == MediaKind::Video && m.video.is_none() {
            c.err(format!("media {}: a video without a video stream", m.id));
        }
        if m.kind == MediaKind::Audio && m.audio.is_none() {
            c.err(format!("media {}: audio without an audio stream", m.id));
        }
    }
    let seq_ids: HashSet<Id> = project.sequences.iter().map(|s| s.id).collect();
    let mut in_bin = HashSet::new();
    let bins: HashMap<Id, Option<Id>> = project.bins.iter().map(|b| (b.id, b.parent)).collect();
    for b in &project.bins {
        c.claim(b.id, "bin");
        for item in &b.items {
            if !media_kind.contains_key(item) && !seq_ids.contains(item) {
                c.err(format!("bin {}: item {item} is not media or a sequence", b.id));
            }
            if !in_bin.insert(*item) {
                c.err(format!("item {item} is in two bins"));
            }
        }
    }
    for b in &project.bins {
        if let Some(p) = b.parent
            && !bins.contains_key(&p)
        {
            c.err(format!("bin {}: parent {p} missing", b.id));
        }
        let mut seen = HashSet::new();
        let mut at = Some(b.id);
        while let Some(id) = at {
            let Some(&parent) = bins.get(&id) else { break };
            if parent.is_none() {
                break;
            }
            if !seen.insert(id) {
                c.err(format!("bin {}: its parents loop", b.id));
                break;
            }
            at = parent;
        }
    }
    let mut link_seq: HashMap<Id, Id> = HashMap::new();
    for seq in &project.sequences {
        c.claim(seq.id, "sequence");
        validate_sequence(&mut c, seq, &media_kind, &mut link_seq, &seq_ids);
    }
    if let Some(id) = first_loop(project) {
        c.err(format!("sequence {id} nests itself"));
    }
    project_extras(&mut c, project);
    Validation { errors: c.errors }
}

fn project_fields(c: &mut Check, project: &Project) {
    if project.format != "ncut" {
        c.err("format is not ncut".into());
    }
    if project.version != VERSION {
        c.err(format!("version {} is not {VERSION}", project.version));
    }
    if project.next_id < 1 {
        c.err("nextId is not a positive integer".into());
    }
}

fn project_extras(c: &mut Check, project: &Project) {
    if let Some(sp) = &project.speakers {
        validate_speakers(c, sp);
    }
    if let Some(l) = &project.luts {
        validate_luts(c, l);
    }
}

/// [`validate`] of what a step touched (see `history::scope`), the project valid before the step: the same verdict
/// as validating the whole project, except for ids used twice, which the history counts. Its errors are among the
/// whole check's.
pub(crate) fn validate_scope(project: &Project, scope: &crate::history::scope::Scope) -> Vec<String> {
    let mut c = Check { errors: Vec::new(), ids: HashSet::new(), unique: false, next_id: project.next_id, project };
    if scope.project {
        project_fields(&mut c, project);
        project_extras(&mut c, project);
    }
    let media: HashMap<Id, &crate::project::Media> = project.media.iter().map(|m| (m.id, m)).collect();
    let seq_ids: HashSet<Id> = project.sequences.iter().map(|s| s.id).collect();
    let mut nest = false;
    for (sid, t) in &scope.seqs {
        let Some(seq) = project.sequence(*sid) else { continue };
        let s = format!("sequence {}", seq.id);
        let Some((f, tracks)) = seq_fields(&mut c, seq, &s, t.info) else { continue };
        for id in &t.clips {
            let Some(clip) = seq.clip(*id) else { continue };
            let Some(tr) = seq.track(clip.track) else { continue };
            nest |= matches!(clip.source, crate::project::Source::Nest { .. });
            validate_clip(&mut c, seq, tr.kind, clip, &media, &seq_ids, f, &s);
            let i = tr.clips.partition_point(|x| x.start < clip.start);
            let i = i + tr.clips[i..].iter().position(|x| x.id == clip.id).unwrap_or(0);
            for (a, b) in [(i.wrapping_sub(1), i), (i, i + 1)] {
                if let (Some(a), Some(b)) = (tr.clips.get(a), tr.clips.get(b))
                    && a.end() > b.start
                {
                    c.err(format!("{s}: clips {} and {} overlap on {}", a.id, b.id, tr.id));
                }
            }
        }
        for l in &t.links {
            let n = seq.link_members(*l).len();
            if n == 1 {
                c.err(format!("{s}: link {l} has one clip"));
            }
            if n > 0 && project.sequences.iter().any(|o| o.id != seq.id && !o.link_members(*l).is_empty()) {
                c.err(format!("link {l} is in two sequences"));
            }
        }
        if t.transitions || t.info || !t.clips.is_empty() {
            validate_transitions(&mut c, seq, f, &tracks, &s);
        }
        if t.markers {
            validate_markers(&mut c, &seq.markers, &format!("{s} markers"), f, false);
        }
        if t.captions {
            validate_captions(&mut c, seq, f, &s);
        }
    }
    if nest && let Some(id) = first_loop(project) {
        c.err(format!("sequence {id} nests itself"));
    }
    c.errors
}

fn validate_luts(c: &mut Check, luts: &serde_json::Value) {
    let Some(l) = luts.as_object() else { return c.err("luts: not an object".into()) };
    for (id, e) in l {
        if !crate::lumetri::valid_id(id) || !crate::lumetri::valid_entry(e) {
            c.err(format!("luts: {id}"));
        }
    }
}

/// The first sequence (in order) that shows itself through nest clips.
fn first_loop(project: &Project) -> Option<Id> {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Open,
        Done,
    }
    fn walk(p: &Project, id: Id, state: &mut HashMap<Id, State>) -> bool {
        match state.get(&id) {
            Some(State::Open) => return true,
            Some(State::Done) => return false,
            None => {}
        }
        state.insert(id, State::Open);
        let mut found = false;
        if let Some(seq) = p.sequence(id) {
            for next in seq.nested_ids() {
                if p.sequence(next).is_some() && walk(p, next, state) {
                    found = true;
                    break;
                }
            }
        }
        state.insert(id, State::Done);
        found
    }
    let mut state = HashMap::new();
    project.sequences.iter().map(|s| s.id).find(|&id| walk(project, id, &mut state))
}

fn validate_speakers(c: &mut Check, sp: &serde_json::Value) {
    use serde_json::Value as J;
    let is_id = |s: &str| s.len() > 2 && s.starts_with("sp") && s[2..].bytes().all(|b| b.is_ascii_digit());
    let fields = sp.as_object().and_then(|o| {
        let count = o.get("count")?.as_f64().filter(|x| x.fract() == 0.0 && (0.0..=10.0).contains(x))?;
        Some((o.get("list")?.as_array()?, o.get("turns")?.as_object()?, count))
    });
    let Some((list, turns, _)) = fields else { return c.err("speakers: fields".into()) };
    let mut ids = HashSet::new();
    for s in list {
        let ok = s.as_object().is_some_and(|o| {
            let id = o.get("id").and_then(J::as_str);
            id.is_some_and(|id| is_id(id) && !ids.contains(id))
                && o.get("name").is_some_and(J::is_string)
                && o.get("color").and_then(J::as_str).is_some_and(is_color)
        });
        if !ok {
            return c.err("speakers: list".into());
        }
        ids.insert(s["id"].as_str().unwrap_or_default().to_owned());
    }
    for (media, t) in turns {
        let Some(t) = t.as_array() else {
            c.err(format!("speakers: turns of {media}"));
            continue;
        };
        let mut last = f64::NEG_INFINITY;
        for x in t {
            let turn = x
                .as_array()
                .filter(|a| a.len() == 3)
                .and_then(|a| Some((a[0].as_f64()?, a[1].as_f64()?, a[2].as_str()?)));
            match turn {
                Some((t0, t1, id)) if t0 >= last && t1 > t0 && ids.contains(id) => last = t1,
                _ => {
                    c.err(format!("speakers: turns of {media}"));
                    break;
                }
            }
        }
    }
}

fn validate_sequence(
    c: &mut Check,
    seq: &Sequence,
    media: &HashMap<Id, &crate::project::Media>,
    link_seq: &mut HashMap<Id, Id>,
    seq_ids: &HashSet<Id>,
) {
    let s = format!("sequence {}", seq.id);
    let Some((f, tracks)) = seq_fields(c, seq, &s, true) else { return };
    let mut links: Vec<(Id, usize)> = Vec::new();
    let mut link_at: HashMap<Id, usize> = HashMap::new();
    for clip in seq.clips_in_order() {
        if let Some(tr) = seq.track(clip.track) {
            validate_clip(c, seq, tr.kind, clip, media, seq_ids, f, &s);
            if let Some(l) = clip.link {
                match link_at.get(&l) {
                    Some(&i) => links[i].1 += 1,
                    None => {
                        link_at.insert(l, links.len());
                        links.push((l, 1));
                    }
                }
            }
        }
    }
    for (id, n) in links {
        if n < 2 {
            c.err(format!("{s}: link {id} has one clip"));
        }
        if link_seq.insert(id, seq.id).is_some() {
            c.err(format!("link {id} is in two sequences"));
        }
    }
    for tr in &seq.tracks {
        for (i, clip) in tr.clips.iter().enumerate() {
            if i > 0 && tr.clips[i - 1].end() > clip.start {
                c.err(format!("{s}: clips {} and {} overlap on {}", tr.clips[i - 1].id, clip.id, tr.id));
            }
        }
    }
    validate_transitions(c, seq, f, &tracks, &s);
    validate_markers(c, &seq.markers, &format!("{s} markers"), f, false);
    validate_captions(c, seq, f, &s);
}

/// A sequence's own fields and its tracks (their problems reported when `info`); -> its frame and track ids, `None`
/// when its frame rate is not one (nothing else of it can be checked).
fn seq_fields(c: &mut Check, seq: &Sequence, s: &str, info: bool) -> Option<(Ticks, HashSet<Id>)> {
    let mut quiet =
        Check { errors: Vec::new(), ids: HashSet::new(), unique: false, next_id: c.next_id, project: c.project };
    let c = if info { c } else { &mut quiet };
    if seq.w < 16 || seq.h < 16 || seq.w > 16384 || seq.h > 16384 {
        c.err(format!("{s}: size"));
    }
    if !valid_fps(seq.fps) {
        c.err(format!("{s}: fps"));
        return None;
    }
    if seq.rate != 48000 {
        c.err(format!("{s}: rate"));
    }
    if !is_color(&seq.background) {
        c.err(format!("{s}: background"));
    }
    if !seq.master_gain.is_finite() {
        c.err(format!("{s}: masterGain"));
    }
    let mut tracks = HashSet::new();
    for tr in &seq.tracks {
        if tr.id.as_str().is_empty() {
            c.err(format!("{s}: a track has no id"));
            continue;
        }
        if !tracks.insert(tr.id) {
            c.err(format!("{s}: track id {} twice", tr.id));
        }
        let t = Label(s, " track ", tr.id);
        if tr.height.is_nan() || tr.height <= 0.0 {
            c.err(format!("{t}: height"));
        }
        match tr.kind {
            TrackKind::Video => {
                if tr.visible.is_none() {
                    c.err(format!("{t}: visible"));
                }
            }
            TrackKind::Audio => {
                if tr.mute.is_none() {
                    c.err(format!("{t}: mute"));
                }
                if tr.solo.is_none() {
                    c.err(format!("{t}: solo"));
                }
                if tr.volume.is_none_or(|v| !v.is_finite()) {
                    c.err(format!("{t}: volume"));
                }
                if tr.pan.is_none_or(|p| !(-100.0..=100.0).contains(&p)) {
                    c.err(format!("{t}: pan"));
                }
            }
        }
    }
    Some((frame(seq.fps), tracks))
}

fn validate_transitions(c: &mut Check, seq: &Sequence, f: Ticks, tracks: &HashSet<Id>, s: &str) {
    let aligned = |t: Ticks| t % f == 0;
    let mut at = HashSet::new();
    for t in &seq.transitions {
        c.claim(t.id, Label("transition in ", "", seq.id));
        let x = Label(s, " transition ", t.id);
        if !tracks.contains(&t.track) {
            c.err(format!("{x}: track {} missing", t.track));
        }
        if !aligned(t.at) {
            c.err(format!("{x}: at"));
        } else if !seq.track(t.track).is_some_and(|tr| tr.has_edge(t.at)) {
            c.err(format!("{x}: not on a clip edge"));
        }
        if !aligned(t.duration) || t.duration < f {
            c.err(format!("{x}: duration"));
        }
        if !at.insert((t.track, t.at)) {
            c.err(format!("{x}: two transitions at one point"));
        }
    }
}

fn validate_captions(c: &mut Check, seq: &Sequence, f: Ticks, s: &str) {
    let aligned = |t: Ticks| t % f == 0;
    for ct in &seq.captions {
        c.claim(ct.id, Label("caption track in ", "", seq.id));
        let x = Label(s, " caption track ", ct.id);
        let mut last = -1;
        for it in &ct.items {
            c.claim(it.id, Label("caption in ", "", ct.id));
            if !aligned(it.start) || !aligned(it.end) || it.start < 0 || it.end <= it.start {
                c.err(format!("{x}: caption {} times", it.id));
            }
            if it.start < last {
                c.err(format!("{x}: captions are not in order"));
            }
            last = it.start;
            if it.doubt.as_ref().is_some_and(|d| d.iter().any(|d| d.at < 0 || !(0.0..=1.0).contains(&d.p))) {
                c.err(format!("{x}: caption {} doubt", it.id));
            }
            if it.words.as_ref().is_some_and(|w| !captionwords::fits(w, &it.text)) {
                c.err(format!("{x}: caption {} words", it.id));
            }
            if it.speaker.as_ref().is_some_and(|sp| {
                !(sp.len() > 2 && sp.starts_with("sp") && sp[2..].bytes().all(|b| b.is_ascii_digit()))
            }) {
                c.err(format!("{x}: caption {} speaker", it.id));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_clip(
    c: &mut Check,
    seq: &Sequence,
    kind: TrackKind,
    clip: &Clip,
    media: &HashMap<Id, &crate::project::Media>,
    seq_ids: &HashSet<Id>,
    f: Ticks,
    s: &str,
) {
    c.claim(clip.id, Label("clip in ", "", seq.id));
    let x = Label(s, " clip ", clip.id);
    let aligned = |t: Ticks| t % f == 0;
    if !aligned(clip.start) || clip.start < 0 {
        c.err(format!("{x}: start {} is not on a frame", clip.start));
    }
    if !clip.in_.is_finite() || !clip.out.is_finite() {
        return c.err(format!("{x}: in/out"));
    }
    if !clip.speed.is_finite() || clip.speed <= 0.0 {
        return c.err(format!("{x}: speed"));
    }
    if let Some(r) = &clip.remap
        && !R::valid(r, f)
    {
        return c.err(format!("{x}: remap"));
    }
    let d = clip.duration();
    if !aligned(d) || d < f {
        c.err(format!("{x}: duration {d} is not a whole number of frames"));
    }
    if clip.start + d > MAX_TICKS {
        c.err(format!("{x}: ends after the longest sequence"));
    }
    match &clip.source {
        Source::Generator { generator, layers, color, .. } => {
            if kind != TrackKind::Video {
                c.err(format!("{x}: a generator on an audio track"));
            }
            match generator {
                Generator::Text => match layers {
                    None => c.err(format!("{x}: text layers")),
                    Some(layers) => {
                        let mut lids = HashSet::new();
                        for l in layers {
                            let id = l.get("id").and_then(|v| v.as_str());
                            match id {
                                Some(id) if l.is_object() && lids.insert(id.to_owned()) => {}
                                _ => c.err(format!("{x}: text layer id")),
                            }
                            let ok = l.get("text").is_some_and(|v| v.is_string())
                                && l.get("size").and_then(|v| v.as_f64()).is_some()
                                && l.get("position")
                                    .and_then(|v| v.as_array())
                                    .is_some_and(|p| p.len() == 2 && p.iter().all(|v| v.as_f64().is_some()));
                            if l.is_object() && !ok {
                                let id = l.get("id").map_or("undefined".to_owned(), crate::migrate::js_string);
                                c.err(format!("{x}: text layer {id}"));
                            }
                        }
                    }
                },
                Generator::Solid => {
                    if !color.as_deref().is_some_and(is_color) {
                        c.err(format!("{x}: solid color"));
                    }
                }
                Generator::Graphic => {
                    let list = layers.as_ref().map(|l| serde_json::Value::Array(l.clone()));
                    for e in crate::graphic::validate(list.as_ref()) {
                        c.err(format!("{x}: graphic {e}"));
                    }
                }
                Generator::Adjustment => {}
            }
        }
        Source::Nest { sequence, .. } => {
            if *sequence == seq.id {
                c.err(format!("{x}: a nest of its own sequence"));
            } else if !seq_ids.contains(sequence) {
                c.err(format!("{x}: sequence {sequence} missing"));
            }
            if clip.in_ < -0.5 {
                c.err(format!("{x}: in {} before the nested sequence", js_num(clip.in_)));
            }
        }
        Source::Media { media: id, freeze, .. } => match media.get(id) {
            None => c.err(format!("{x}: media {id} missing")),
            Some(m) => {
                if kind == TrackKind::Video && !(m.video.is_some() || m.kind == MediaKind::Image) {
                    c.err(format!("{x}: media without video on a video track"));
                }
                if kind == TrackKind::Audio && m.audio.is_none() {
                    c.err(format!("{x}: media without audio on an audio track"));
                }
                if *freeze {
                    if clip.in_ < 0.0 || clip.in_ > m.duration {
                        c.err(format!("{x}: freeze time outside the media"));
                    }
                } else if m.kind != MediaKind::Image && (clip.in_ < -0.5 || clip.out > m.duration + 0.5) {
                    c.err(format!(
                        "{x}: in/out {}..{} outside the media (0..{})",
                        js_num(clip.in_),
                        js_num(clip.out),
                        js_num(m.duration)
                    ));
                }
            }
        },
    }
    if clip.out <= clip.in_ {
        c.err(format!("{x}: out is not after in"));
    }
    if let Some(r) = &clip.remap {
        if kind != TrackKind::Video {
            c.err(format!("{x}: time remapping on an audio track"));
        }
        if c.project.is_still(clip) {
            c.err(format!("{x}: time remapping on a still"));
        }
        if clip.speed != 1.0 || clip.reverse {
            c.err(format!("{x}: time remapping with a speed or reverse"));
        }
        let (lo, hi) = R::range(r);
        let tol = 0.5 + 1e-9 * hi.abs();
        if (clip.in_ - lo).abs() > tol || (clip.out - hi).abs() > tol {
            c.err(format!(
                "{x}: in/out {}..{} are not the remapped range {}..{}",
                js_num(clip.in_),
                js_num(clip.out),
                js_num(lo),
                js_num(hi)
            ));
        }
    }
    match (&clip.props, kind) {
        (Props::Video(p), TrackKind::Video) => {
            for (k, ok) in [
                ("position", p.position.iter().all(|v| v.is_finite())),
                ("scale", p.scale.iter().all(|v| v.is_finite())),
                ("rotation", p.rotation.is_finite()),
                ("anchor", p.anchor.iter().all(|v| v.is_finite())),
                ("opacity", p.opacity.is_finite()),
                ("crop", p.crop.iter().all(|v| v.is_finite())),
            ] {
                if !ok {
                    c.err(format!("{x}: prop {k}"));
                }
            }
        }
        (Props::Audio(p), TrackKind::Audio) => {
            for (k, ok) in [("volume", p.volume.is_finite()), ("pan", p.pan.is_finite())] {
                if !ok {
                    c.err(format!("{x}: prop {k}"));
                }
            }
        }
        (Props::Video(_), TrackKind::Audio) => {
            for k in crate::defaults::VIDEO_PROPS {
                c.err(format!("{x}: unknown prop {k}"));
            }
        }
        (Props::Audio(_), TrackKind::Video) => {
            for k in ["volume", "pan"] {
                c.err(format!("{x}: unknown prop {k}"));
            }
        }
    }
    for (prop, list) in &clip.keyframes {
        if !valid_prop_path(clip, kind, prop) {
            c.err(format!("{x}: keyframes for unknown property {prop}"));
        }
        if list.is_empty() {
            c.err(format!("{x}: keyframes {prop} is empty"));
            continue;
        }
        let mask_field = if prop.starts_with("masks.") || prop.contains(".masks.") {
            masks::parse_path(prop, false).map(|p| p.field)
        } else {
            None
        };
        let mut last = i64::MIN;
        let mut first = true;
        for k in list {
            if !aligned(k.t) {
                c.err(format!("{x}: keyframe time {} of {prop}", k.t));
            }
            if !first && k.t <= last {
                c.err(format!("{x}: keyframes of {prop} are not in order"));
            }
            first = false;
            last = k.t;
            if !kf_value_ok(&k.v) {
                c.err(format!("{x}: keyframe value of {prop}"));
            }
            if let Some(field) = mask_field
                && !masks::valid_field(field, &serde_json::to_value(&k.v).unwrap_or_default())
            {
                c.err(format!("{x}: keyframe value of {prop}"));
            }
            if k.ease == crate::keyframes::Ease::Bezier
                && !k.h.as_ref().is_some_and(|h| {
                    h.len() == 4
                        && h.iter().all(|v| v.is_finite())
                        && (0.0..=1.0).contains(&h[0])
                        && (0.0..=1.0).contains(&h[2])
                })
            {
                c.err(format!("{x}: bezier handles"));
            }
        }
    }
    let mut eids = HashSet::new();
    for e in &clip.effects {
        if e.id.as_str().is_empty() || !eids.insert(e.id) {
            c.err(format!("{x}: effect id"));
        }
    }
    if clip.masks.is_some() || clip.effects.iter().any(|e| e.masks.is_some()) {
        validate_masks(c, clip, kind, &x.to_string());
    }
    for (k, v) in [("fadeIn", clip.fade_in), ("fadeOut", clip.fade_out)] {
        if !(v >= 0 && v % f == 0) {
            c.err(format!("{x}: {k}"));
        }
    }
    if clip.fade_in + clip.fade_out > d {
        c.err(format!("{x}: fades are longer than the clip"));
    }
    if let Some(m) = &clip.markers {
        validate_markers(c, m, &format!("{x} markers"), f, true);
    }
}

fn validate_masks(c: &mut Check, clip: &Clip, kind: TrackKind, x: &str) {
    let mut seen = HashSet::new();
    let holders =
        std::iter::once((None, clip.masks.as_ref())).chain(clip.effects.iter().map(|e| (Some(e.id), e.masks.as_ref())));
    for (effect, list) in holders {
        let Some(list) = list else { continue };
        let l = match effect {
            Some(e) => format!("{x} effect {e} masks"),
            None => format!("{x} masks"),
        };
        if kind != TrackKind::Video {
            c.err(format!("{l}: masks on an audio track"));
            continue;
        }
        if list.is_empty() || list.len() > masks::MAX_MASKS {
            c.err(format!("{l}: not a list of 1 to {}", masks::MAX_MASKS));
            continue;
        }
        for m in list {
            let why = masks::problem(&serde_json::to_value(m).unwrap_or_default());
            if let Some(why) = why {
                c.err(format!("{l}: mask {}: {why}", m.id));
            } else if !seen.insert(m.id) {
                c.err(format!("{l}: mask id {} twice", m.id));
            }
        }
    }
}

fn validate_markers(c: &mut Check, list: &[Marker], m: &str, f: Ticks, in_clip: bool) {
    for mk in list {
        c.claim(mk.id, m);
        if !(mk.t % f == 0 && (in_clip || mk.t >= 0)) {
            c.err(format!("{m}: {} time", mk.id));
        }
        if !(mk.duration >= 0 && mk.duration % f == 0) {
            c.err(format!("{m}: {} duration", mk.id));
        }
    }
}

/// A name in a message (`sequence s1 clip c7`), written only when a message is.
struct Label<'a>(&'a str, &'static str, Id);

impl std::fmt::Display for Label<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}{}{}", self.0, self.1, self.2)
    }
}

/// A number as JavaScript's `String(x)` writes it (for the messages).
pub(crate) fn js_num(x: f64) -> String {
    crate::migrate::js_string(&serde_json::Value::from(x))
}
