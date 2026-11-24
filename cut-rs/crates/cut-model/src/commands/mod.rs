//! The edit commands (port of `commands.js`, docs/cut-architecture.md section 6 `Cut.commands`).
//!
//! A command is the JavaScript's plain object, `{ type, seqId, ... }` as its builders make it, here as JSON: both
//! editors run the same command text, and the panels' options (`linked: false`, `trackDelta: {video, audio}`) keep their
//! meaning of absent, `null` and given. [`apply`] runs one on a project, recording every change in a [`Tx`]; the
//! history ([`crate::history`]) normalizes, validates and keeps the step.
//!
//! Editing rules every command follows (the commands.js header has them too): times snap to the sequence's frames;
//! linked clips move, trim, split, change speed and go together unless `linked: false`; groups move and go together;
//! a ripple changes the targeted and every sync-locked track the same way; locked tracks never change; transitions
//! follow the edge a command moves, and one left off every clip edge goes; a link or group of one clip is cleared.

pub mod build;
mod clip;
mod edit;
mod generator;
mod nest;
mod paste;
mod project;
mod timeline;

use std::collections::HashMap;

use cut_time::{Fps, Ticks};
use serde_json::{Value as Json, json};

use crate::history::journal::Tx;
use crate::id::Id;
use crate::migrate::snap_f;
use crate::project::{Bin, Clip, Media, Project, Sequence, Track};
use crate::query::{frame, js_round};

pub(crate) use edit::{normalize, normalize_scope};

/// What went wrong, as the JavaScript's `err.code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    Invalid,
    Locked,
    NoTrack,
    NoTarget,
    TooShort,
    NoRange,
    NoGap,
    GapBlocked,
    NoEdge,
    NoFrame,
    NoRoom,
    NotOnClip,
    Overlap,
    LinkOne,
    GroupOne,
    NoEdit,
    Still,
    Speed,
    Gain,
    Fps,
    Size,
    NestLoop,
    NoClips,
    EmptySequence,
    Remap,
    Source,
    BinLoop,
    InvalidResult,
    NotFound,
    BadGraphic,
    NotVideo,
    NoMasks,
    TooMany,
    NoAudio,
    NotAudio,
    /// A command this port did not run (Rust only; no command gives it now).
    Unported,
}

impl Code {
    pub fn name(self) -> String {
        serde_json::to_value(self).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
    }
}

/// A refused command: the fixed English sentence the screen shows through `tr()`, its code and sometimes a detail.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct CommandError {
    pub message: String,
    pub code: Code,
    pub detail: Option<String>,
}

impl CommandError {
    pub fn new(message: impl Into<String>, code: Code, detail: Option<String>) -> Self {
        Self { message: message.into(), code, detail }
    }
}

pub(crate) type R<T> = Result<T, CommandError>;

pub(crate) fn fail<T>(message: impl Into<String>, code: Code) -> R<T> {
    Err(CommandError::new(message, code, None))
}

pub(crate) fn fail_at<T>(message: impl Into<String>, code: Code, detail: impl Into<String>) -> R<T> {
    Err(CommandError::new(message, code, Some(detail.into())))
}

pub(crate) fn invalid<T>(message: impl Into<String>) -> R<T> {
    fail(message, Code::Invalid)
}

// ---- reading a command's JSON as the JavaScript reads its object ----

/// `v[k]` when it is neither absent nor null (the JavaScript's `?? ` and `!= null`).
pub(crate) fn given<'a>(v: &'a Json, k: &str) -> Option<&'a Json> {
    v.get(k).filter(|x| !x.is_null())
}

/// `v[k]` when it is there, null included (`!== undefined`).
pub(crate) fn defined<'a>(v: &'a Json, k: &str) -> Option<&'a Json> {
    v.get(k)
}

/// `v[k] || {}`: an object, or an empty one.
pub(crate) fn opts<'a>(v: &'a Json, k: &str) -> &'a Json {
    static EMPTY: std::sync::OnceLock<Json> = std::sync::OnceLock::new();
    match v.get(k) {
        Some(x) if !x.is_null() && x != &Json::Bool(false) && x != &json!(0) && x != &json!("") => x,
        _ => EMPTY.get_or_init(|| json!({})),
    }
}

pub(crate) fn num(x: Option<&Json>, what: &str) -> R<f64> {
    match x.and_then(Json::as_f64) {
        Some(v) if v.is_finite() => Ok(v),
        _ => invalid(format!("{what} is not a number")),
    }
}

pub(crate) fn list<'a>(x: Option<&'a Json>, what: &str) -> R<&'a Vec<Json>> {
    x.and_then(Json::as_array).map_or_else(|| invalid(format!("{what} is not a list")), Ok)
}

/// A list of ids as the JavaScript compares them (an id that is not a string matches nothing).
pub(crate) fn id_list(x: Option<&Json>, what: &str) -> R<Vec<Option<Id>>> {
    Ok(list(x, what)?.iter().map(|v| v.as_str().map(Id::new)).collect())
}

pub(crate) fn id_of(x: Option<&Json>) -> Option<Id> {
    x.and_then(Json::as_str).map(Id::new)
}

/// The own fields `{...v}` copies: an object's, a list's or a string's by index, none of anything else.
pub(crate) fn js_spread(v: &Json) -> serde_json::Map<String, Json> {
    match v {
        Json::Object(o) => o.clone(),
        Json::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        Json::String(s) => {
            let units: Vec<u16> = s.encode_utf16().collect();
            units.iter().enumerate().map(|(i, u)| (i.to_string(), json!(String::from_utf16_lossy(&[*u])))).collect()
        }
        _ => serde_json::Map::new(),
    }
}

/// JavaScript's `Number(v)` of a value the JSON may hold.
pub(crate) fn js_to_number(v: &Json) -> f64 {
    match v {
        Json::Null => 0.0,
        Json::Bool(b) => f64::from(u8::from(*b)),
        Json::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Json::String(s) => {
            let t = s.trim_matches(crate::captionwords::is_space);
            if t.is_empty() {
                0.0
            } else if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                i64::from_str_radix(h, 16).map_or(f64::NAN, |x| x as f64)
            } else {
                match t {
                    "Infinity" | "+Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ if t.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) => {
                        t.parse().unwrap_or(f64::NAN)
                    }
                    _ => f64::NAN,
                }
            }
        }
        Json::Array(a) if a.is_empty() => 0.0,
        Json::Array(a) if a.len() == 1 => js_to_number(&json!(string(&a[0]))),
        _ => f64::NAN,
    }
}

/// Where `list.splice(index, 0, x)` puts x for the index `Math.max(0, Math.min(len, index))`, the end when the index
/// is absent or null.
pub(crate) fn splice_index(index: Option<&Json>, len: usize) -> usize {
    let Some(i) = index.filter(|i| !i.is_null()) else { return len };
    let x = js_to_number(i);
    if x.is_nan() { 0 } else { x.clamp(0.0, len as f64) as usize }
}

/// JavaScript's `String(v)` of a value the JSON may hold.
pub(crate) fn string(v: &Json) -> String {
    crate::migrate::js_string(v)
}

/// The sequence a command works on, and how it snaps times.
pub(crate) struct Ctx<'a> {
    pub p: &'a mut Project,
    pub tx: &'a mut Tx,
    pub seq: Id,
    pub fps: Fps,
    pub f: Ticks,
    pub split_links: HashMap<(Id, Ticks), Id>,
}

pub(crate) fn context<'a>(p: &'a mut Project, tx: &'a mut Tx, seq: Option<&Json>) -> R<Ctx<'a>> {
    let id = id_of(seq);
    let Some(s) = id.and_then(|id| p.sequence(id)) else {
        return fail(format!("there is no sequence {}", seq.map_or("undefined".into(), string)), Code::NotFound);
    };
    let (seq, fps) = (s.id, s.fps);
    Ok(Ctx { p, tx, seq, fps, f: frame(fps), split_links: HashMap::new() })
}

/// `prefix` + nextId, recorded.
pub(crate) fn nid(p: &mut Project, tx: &mut Tx, prefix: &str) -> Id {
    tx.project(p);
    p.new_id(prefix)
}

pub(crate) fn media_of(p: &Project, id: Option<&Json>) -> R<Media> {
    match id_of(id).and_then(|i| p.media(i)) {
        Some(m) => Ok(m.clone()),
        None => fail(format!("there is no media {}", id.map_or("undefined".into(), string)), Code::NotFound),
    }
}

pub(crate) fn bin_index(p: &Project, id: Id) -> R<usize> {
    p.bins.iter().position(|b| b.id == id).map_or_else(|| fail(format!("there is no bin {id}"), Code::NotFound), Ok)
}

pub(crate) fn bins_mut<'a>(p: &'a mut Project, tx: &mut Tx) -> &'a mut Vec<Bin> {
    tx.bins(p);
    &mut p.bins
}

impl Ctx<'_> {
    pub fn seq(&self) -> &Sequence {
        self.p.sequence(self.seq).expect("the command's sequence")
    }

    /// The sequence, after a copy of its own fields and its tracks' fields is kept.
    pub fn seq_info_mut(&mut self) -> &mut Sequence {
        self.tx.seq_info(self.p, self.seq);
        self.p.sequence_mut(self.seq).expect("the command's sequence")
    }

    pub fn transitions_mut(&mut self) -> &mut Vec<crate::project::Transition> {
        self.tx.transitions(self.p, self.seq);
        &mut self.p.sequence_mut(self.seq).expect("the command's sequence").transitions
    }

    pub fn markers_mut(&mut self) -> &mut Vec<crate::project::Marker> {
        self.tx.markers(self.p, self.seq);
        &mut self.p.sequence_mut(self.seq).expect("the command's sequence").markers
    }

    pub fn captions_mut(&mut self) -> &mut Vec<crate::project::CaptionTrack> {
        self.tx.captions(self.p, self.seq);
        &mut self.p.sequence_mut(self.seq).expect("the command's sequence").captions
    }

    pub fn nid(&mut self, prefix: &str) -> Id {
        nid(self.p, self.tx, prefix)
    }

    pub fn track(&self, id: Id) -> R<&Track> {
        self.seq().track(id).map_or_else(|| fail_at("There is no track there.", Code::NoTrack, id.as_str()), Ok)
    }

    pub fn track_json(&self, id: Option<&Json>) -> R<&Track> {
        match id_of(id) {
            Some(id) => self.track(id),
            None => fail_at("There is no track there.", Code::NoTrack, id.map_or("undefined".into(), string)),
        }
    }

    pub fn unlocked(&self, id: Id) -> R<&Track> {
        let t = self.track(id)?;
        if t.locked {
            return fail_at("The track is locked.", Code::Locked, id.as_str());
        }
        Ok(t)
    }

    pub fn clip(&self, id: Id) -> R<&Clip> {
        self.seq().clip(id).map_or_else(|| fail(format!("there is no clip {id}"), Code::NotFound), Ok)
    }

    pub fn clip_json(&self, id: Option<&Json>) -> R<&Clip> {
        match id_of(id) {
            Some(id) => self.clip(id),
            None => fail(format!("there is no clip {}", id.map_or("undefined".into(), string)), Code::NotFound),
        }
    }

    pub fn kind_of(&self, clip: &Clip) -> R<crate::project::TrackKind> {
        Ok(self.track(clip.track)?.kind)
    }

    pub fn still(&self, clip: &Clip) -> bool {
        self.p.is_still(clip)
    }

    /// Changes a clip of this sequence, recorded.
    pub fn edit<T>(&mut self, id: Id, f: impl FnOnce(&mut Clip) -> T) -> T {
        self.tx.clip(self.p, self.seq, id);
        self.p.sequence_mut(self.seq).and_then(|s| s.edit_clip(id, f)).expect("an edited clip is there")
    }

    /// Puts a clip in this sequence at `pos` in the list order (the end for `None`), recorded.
    pub fn add(&mut self, clip: Clip, pos: Option<usize>) {
        let id = clip.id;
        let s = self.p.sequence_mut(self.seq).expect("the command's sequence");
        let at = pos.unwrap_or(s.clip_count()).min(s.clip_count());
        s.insert_clip(clip, Some(at));
        self.tx.added(self.seq, id, at);
    }

    /// Takes a clip out of this sequence, recorded.
    pub fn remove(&mut self, id: Id) {
        remove_clip(self.p, self.tx, self.seq, id);
    }

    /// `at`: a time snapped to the start of its frame, never before 0.
    pub fn at(&self, t: Option<&Json>, what: &str) -> R<Ticks> {
        Ok(snap_f(num(t, what)?, self.fps, false).max(0))
    }

    /// `near`: a time snapped to the nearest frame, never before 0.
    pub fn near(&self, t: Option<&Json>, what: &str) -> R<Ticks> {
        Ok(snap_f(num(t, what)?, self.fps, true).max(0))
    }

    /// `frames`: a length or delta to the nearest whole frame.
    pub fn frames(&self, d: Option<&Json>, what: &str) -> R<Ticks> {
        Ok(self.frames_of(num(d, what)?))
    }

    pub fn frames_of(&self, d: f64) -> Ticks {
        (js_round(d / self.f as f64) * self.f as f64) as Ticks
    }

    /// `floorFrames`: whole frames in `x` ticks, never below 0 (infinity stays).
    pub fn floor_frames(&self, x: f64) -> f64 {
        floor_frames(self.f, x)
    }

    /// The clips of a track in time order, as ids.
    pub fn clips_on(&self, track: Id) -> Vec<Id> {
        self.seq().track(track).map(|t| t.clips.iter().map(|c| c.id).collect()).unwrap_or_default()
    }
}

pub(crate) fn floor_frames(f: Ticks, x: f64) -> f64 {
    if x == f64::INFINITY { x } else { ((x / f as f64 + 1e-9).floor() * f as f64).max(0.0) }
}

/// Takes a clip out of a sequence, recorded.
pub(crate) fn remove_clip(p: &mut Project, tx: &mut Tx, seq: Id, id: Id) {
    if let Some((clip, pos)) = p.sequence_mut(seq).and_then(|s| s.remove_clip(id)) {
        tx.removed(seq, pos, clip);
    }
}

// ---- running a command ----

/// Runs one command on the project, recording what it changes in `tx`; the caller normalizes, validates and rolls back
/// on an error. -> the command's result.
pub fn apply(p: &mut Project, tx: &mut Tx, cmd: &Json) -> R<Json> {
    let kind = cmd.get("type").and_then(Json::as_str).unwrap_or("");
    match kind {
        "importMedia" => project::import_media(p, tx, cmd),
        "removeMedia" => project::remove_media(p, tx, cmd),
        "relinkMedia" => project::relink_media(p, tx, cmd),
        "setProxy" => project::set_proxy(p, tx, cmd),
        "setSettings" => project::set_settings(p, tx, cmd),
        "setSpeakers" => project::set_speakers(p, tx, cmd),
        "addBin" => project::add_bin(p, tx, cmd),
        "removeBin" => project::remove_bin(p, tx, cmd),
        "renameItem" => project::rename_item(p, tx, cmd),
        "moveToBin" => project::move_to_bin(p, tx, cmd),
        "addSequence" => project::add_sequence(p, tx, cmd),
        "removeSequence" => project::remove_sequence(p, tx, cmd),
        "setSequence" => project::set_sequence(p, tx, cmd),
        "addTrack" => project::add_track(p, tx, cmd),
        "removeTrack" => project::remove_track(p, tx, cmd),
        "setTrack" => project::set_track(p, tx, cmd),
        "addMarker" => project::add_marker(p, tx, cmd),
        "setMarker" => project::set_marker(p, tx, cmd),
        "removeMarker" => project::remove_marker(p, tx, cmd),
        "addCaptionTrack" => project::add_caption_track(p, tx, cmd),
        "setCaptionTrack" => project::set_caption_track(p, tx, cmd),
        "removeCaptionTrack" => project::remove_caption_track(p, tx, cmd),
        "setCaptions" => project::set_captions(p, tx, cmd),
        "addCaption" => project::add_caption(p, tx, cmd),
        "setCaption" => project::set_caption(p, tx, cmd),
        "removeCaption" => project::remove_caption(p, tx, cmd),
        "place" => timeline::place(p, tx, cmd),
        "placeRange" => timeline::place_range(p, tx, cmd),
        "move" => timeline::move_clips(p, tx, cmd),
        "trim" => timeline::trim(p, tx, cmd),
        "split" => timeline::split(p, tx, cmd),
        "remove" => timeline::remove(p, tx, cmd),
        "rippleToPlayhead" => timeline::ripple_to_playhead(p, tx, cmd),
        "closeGap" => timeline::close_gap(p, tx, cmd),
        "lift" => timeline::lift(p, tx, cmd, false),
        "extract" => timeline::lift(p, tx, cmd, true),
        "slip" => timeline::slip(p, tx, cmd),
        "slide" => timeline::slide(p, tx, cmd),
        "extendEdit" => timeline::extend_edit(p, tx, cmd),
        "addGenerated" => timeline::add_generated(p, tx, cmd),
        "setClip" => clip::set_clip(p, tx, cmd),
        "setRemap" => clip::set_remap(p, tx, cmd),
        "setKeyframes" => clip::set_keyframes(p, tx, cmd),
        "link" => clip::link(p, tx, cmd, "L"),
        "group" => clip::link(p, tx, cmd, "G"),
        "unlink" => clip::unlink(p, tx, cmd),
        "ungroup" => clip::ungroup(p, tx, cmd),
        "setRole" => clip::set_role(p, tx, cmd),
        "replaceAudio" => clip::replace_audio(p, tx, cmd),
        "addEffect" => clip::add_effect(p, tx, cmd),
        "removeEffect" => clip::remove_effect(p, tx, cmd),
        "setEffect" => clip::set_effect(p, tx, cmd),
        "moveEffect" => clip::move_effect(p, tx, cmd),
        "addMask" => clip::add_mask(p, tx, cmd),
        "setMask" => clip::set_mask(p, tx, cmd),
        "removeMask" => clip::remove_mask(p, tx, cmd),
        "addTransition" => clip::add_transition(p, tx, cmd),
        "removeTransition" => clip::remove_transition(p, tx, cmd),
        "setTransition" => clip::set_transition(p, tx, cmd),
        "setGenerator" => generator::set_generator(p, tx, cmd),
        "setLayer" => generator::set_layer(p, tx, cmd),
        "addLayer" => generator::add_layer(p, tx, cmd),
        "removeLayer" => generator::remove_layer(p, tx, cmd),
        "freezeFrame" => clip::freeze_frame(p, tx, cmd),
        "batch" => {
            let mut results = Vec::new();
            for sub in list(cmd.get("commands"), "commands")? {
                if sub.get("type").and_then(Json::as_str) == Some("batch") {
                    return invalid("a batch cannot hold a batch");
                }
                results.push(apply(p, tx, sub)?);
            }
            Ok(json!({ "results": results }))
        }
        "stretch" => paste::stretch(p, tx, cmd),
        "paste" => paste::paste(p, tx, cmd),
        "nest" => nest::nest(p, tx, cmd),
        "addLut" => project::add_lut(p, tx, cmd),
        _ => invalid(format!("unknown command {}", cmd.get("type").map_or("undefined".into(), string))),
    }
}

/// Whether this port runs commands of this type: every type the JavaScript has.
pub fn is_ported(kind: &str) -> bool {
    LABELS.iter().any(|(k, _)| *k == kind)
}

/// The English label of each command type (shown through `tr()`).
pub const LABELS: &[(&str, &str)] = &[
    ("importMedia", "Import"),
    ("removeMedia", "Remove Media"),
    ("relinkMedia", "Relink Media"),
    ("addBin", "New Bin"),
    ("removeBin", "Delete Bin"),
    ("renameItem", "Rename"),
    ("moveToBin", "Move to Bin"),
    ("addSequence", "New Sequence"),
    ("removeSequence", "Delete Sequence"),
    ("setSequence", "Sequence Settings"),
    ("addTrack", "Add Track"),
    ("removeTrack", "Delete Track"),
    ("setTrack", "Track Settings"),
    ("place", "Overwrite"),
    ("placeRange", "Overwrite"),
    ("move", "Move"),
    ("trim", "Trim"),
    ("split", "Split"),
    ("remove", "Delete"),
    ("rippleToPlayhead", "Ripple Trim to Playhead"),
    ("closeGap", "Close Gap"),
    ("lift", "Lift"),
    ("extract", "Extract"),
    ("setClip", "Clip Settings"),
    ("setKeyframes", "Keyframes"),
    ("link", "Link"),
    ("unlink", "Unlink"),
    ("addEffect", "Add Effect"),
    ("removeEffect", "Remove Effect"),
    ("setEffect", "Effect Settings"),
    ("moveEffect", "Reorder Effects"),
    ("addTransition", "Add Transition"),
    ("removeTransition", "Remove Transition"),
    ("setTransition", "Transition Settings"),
    ("addGenerated", "Add Graphic"),
    ("freezeFrame", "Freeze Frame"),
    ("addMarker", "Add Marker"),
    ("setMarker", "Edit Marker"),
    ("removeMarker", "Remove Marker"),
    ("addCaptionTrack", "Add Caption Track"),
    ("setCaptionTrack", "Caption Track Settings"),
    ("removeCaptionTrack", "Delete Caption Track"),
    ("setCaptions", "Replace Captions"),
    ("addCaption", "Add Caption"),
    ("setCaption", "Edit Caption"),
    ("removeCaption", "Remove Caption"),
    ("setProxy", "Proxy"),
    ("setSettings", "Project Settings"),
    ("setSpeakers", "Speakers"),
    ("addLut", "Load LUT"),
    ("paste", "Paste"),
    ("setGenerator", "Graphic Settings"),
    ("setLayer", "Edit Text"),
    ("addLayer", "Add Layer"),
    ("removeLayer", "Remove Layer"),
    ("setRole", "Audio Role"),
    ("replaceAudio", "Replace Audio"),
    ("batch", "Edit"),
    ("group", "Group"),
    ("ungroup", "Ungroup"),
    ("slip", "Slip"),
    ("slide", "Slide"),
    ("stretch", "Rate Stretch"),
    ("extendEdit", "Extend Edit"),
    ("nest", "Nest"),
    ("setRemap", "Time Remapping"),
    ("addMask", "Add Mask"),
    ("setMask", "Mask"),
    ("removeMask", "Remove Mask"),
];

/// The step's label of a command, as `Cut.commands.label` names it.
pub fn label(cmd: &Json) -> String {
    let o = opts(cmd, "opts");
    let kind = cmd.get("type").and_then(Json::as_str).unwrap_or("");
    let truthy = |v: Option<&Json>| {
        v.is_some_and(|v| !matches!(v, Json::Null | Json::Bool(false)) && v != &json!(0) && v != &json!(""))
    };
    let s = match kind {
        "place" | "placeRange" => {
            if o.get("mode").and_then(Json::as_str) == Some("insert") {
                "Insert"
            } else {
                "Overwrite"
            }
        }
        "trim" => match o.get("mode").and_then(Json::as_str) {
            Some("ripple") => "Ripple Trim",
            Some("roll") => "Roll Edit",
            _ => "Trim",
        },
        "remove" => {
            if truthy(o.get("ripple")) {
                "Ripple Delete"
            } else {
                "Delete"
            }
        }
        "move" => {
            if truthy(o.get("insert")) {
                "Insert Move"
            } else if truthy(o.get("nudge")) {
                "Nudge"
            } else {
                "Move"
            }
        }
        "addSequence" => {
            if given(o, "from").is_some() {
                "Duplicate Sequence"
            } else {
                "New Sequence"
            }
        }
        "addGenerated" => {
            match o.get("source").and_then(|s| s.get("generator")).and_then(Json::as_str) {
                Some("text") => "Add Text",
                // a colour matte is not a graphic: the History panel said "Add Graphic" for it
                Some("solid") => "Add Color Matte",
                _ => "Add Graphic",
            }
        }
        "setClip" => {
            let p = cmd.get("patch");
            if p.and_then(|p| p.get("speed")).is_some() || p.and_then(|p| p.get("duration")).is_some() {
                "Speed/Duration"
            } else if p.and_then(|p| p.get("sampling")).is_some() {
                "Time Interpolation"
            } else {
                "Clip Settings"
            }
        }
        "paste" => {
            if o.get("mode").and_then(Json::as_str) == Some("insert") {
                "Paste Insert"
            } else {
                "Paste"
            }
        }
        "batch" => match cmd.get("label").and_then(Json::as_str) {
            Some(l) if !l.is_empty() => return l.to_owned(),
            _ => "Edit",
        },
        _ => return LABELS.iter().find(|(k, _)| *k == kind).map_or_else(|| kind.to_owned(), |(_, l)| (*l).to_owned()),
    };
    s.to_owned()
}
