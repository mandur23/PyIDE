//! The command objects of `commands.js`'s builders, as JSON: what the panels hand to `History::apply`. Field names and
//! option shapes are the JavaScript's (`Cut.commands.move(seqId, ids, {delta, trackDelta, linked})` is [`move_clips`]).

use cut_model::Id;
use cut_time::Ticks;
use serde_json::{Value as Json, json};

fn ids(list: &[Id]) -> Json {
    Json::Array(list.iter().map(|i| json!(i.as_str())).collect())
}

pub fn import_media(media: Vec<Json>, bin: Option<Id>) -> Json {
    json!({ "type": "importMedia", "media": media, "binId": bin.map(Id::as_str) })
}

pub fn remove_media(list: &[Id]) -> Json {
    json!({ "type": "removeMedia", "ids": ids(list) })
}

pub fn add_bin(name: &str, parent: Option<Id>) -> Json {
    json!({ "type": "addBin", "name": name, "parent": parent.map(Id::as_str) })
}

pub fn remove_bin(id: Id) -> Json {
    json!({ "type": "removeBin", "id": id.as_str() })
}

pub fn rename_item(id: Id, name: &str) -> Json {
    json!({ "type": "renameItem", "id": id.as_str(), "name": name })
}

pub fn move_to_bin(list: &[Id], bin: Option<Id>) -> Json {
    json!({ "type": "moveToBin", "ids": ids(list), "binId": bin.map(Id::as_str) })
}

pub fn add_sequence(opts: Json) -> Json {
    json!({ "type": "addSequence", "opts": opts })
}

pub fn remove_sequence(id: Id) -> Json {
    json!({ "type": "removeSequence", "id": id.as_str() })
}

pub fn add_track(seq: Id, kind: &str) -> Json {
    json!({ "type": "addTrack", "seqId": seq.as_str(), "kind": kind, "index": null, "opts": {} })
}

pub fn set_track(seq: Id, track: Id, patch: Json) -> Json {
    json!({ "type": "setTrack", "seqId": seq.as_str(), "trackId": track.as_str(), "patch": patch })
}

/// Places media at `at` on the given tracks (`mode`: `overwrite` or `insert`).
pub fn place(seq: Id, media: Id, video: Option<Id>, audio: Option<Id>, at: Ticks, mode: &str) -> Json {
    json!({ "type": "place", "seqId": seq.as_str(), "opts": {
        "source": { "media": media.as_str() },
        "video": video.map(Id::as_str), "audio": audio.map(Id::as_str), "at": at, "mode": mode,
    } })
}

/// `trackDelta` is `{video, audio}` rows; `linked: false` moves only these clips.
pub fn move_clips(seq: Id, clips: &[Id], delta: Ticks, track_delta: (i64, i64), insert: bool, linked: bool) -> Json {
    json!({ "type": "move", "seqId": seq.as_str(), "clipIds": ids(clips), "opts": {
        "delta": delta, "trackDelta": { "video": track_delta.0, "audio": track_delta.1 }, "insert": insert, "linked": linked,
    } })
}

/// `edge` is `start` or `end`, `mode` `normal`, `ripple` or `roll`.
pub fn trim(seq: Id, clip: Id, edge: &str, delta: Ticks, mode: &str, linked: bool) -> Json {
    json!({ "type": "trim", "seqId": seq.as_str(), "clipId": clip.as_str(), "opts": {
        "edge": edge, "delta": delta, "mode": mode, "linked": linked,
    } })
}

/// Splits the given clips at `t` (the razor on a clip).
pub fn split_clips(seq: Id, t: Ticks, clips: &[Id], linked: bool) -> Json {
    json!({ "type": "split", "seqId": seq.as_str(), "t": t, "opts": { "clipIds": ids(clips), "linked": linked } })
}

/// Splits every unlocked track at `t` (Shift+razor, Add Edit to All Tracks).
pub fn split_all(seq: Id, t: Ticks, linked: bool) -> Json {
    json!({ "type": "split", "seqId": seq.as_str(), "t": t, "opts": { "allTracks": true, "linked": linked } })
}

pub fn remove(seq: Id, clips: &[Id], ripple: bool, linked: bool) -> Json {
    json!({ "type": "remove", "seqId": seq.as_str(), "clipIds": ids(clips), "opts": { "ripple": ripple, "linked": linked } })
}

pub fn set_clip(seq: Id, clip: Id, patch: Json, linked: bool) -> Json {
    let opts = if linked { json!({}) } else { json!({ "linked": false }) };
    json!({ "type": "setClip", "seqId": seq.as_str(), "clipId": clip.as_str(), "patch": patch, "opts": opts })
}

pub fn link(seq: Id, clips: &[Id]) -> Json {
    json!({ "type": "link", "seqId": seq.as_str(), "clipIds": ids(clips) })
}

pub fn unlink(seq: Id, clips: &[Id]) -> Json {
    json!({ "type": "unlink", "seqId": seq.as_str(), "clipIds": ids(clips) })
}

pub fn group(seq: Id, clips: &[Id]) -> Json {
    json!({ "type": "group", "seqId": seq.as_str(), "clipIds": ids(clips) })
}

pub fn ungroup(seq: Id, clips: &[Id]) -> Json {
    json!({ "type": "ungroup", "seqId": seq.as_str(), "clipIds": ids(clips) })
}

/// A marker at `t`: on the sequence, or on `clip` (a selected clip under the playhead).
pub fn add_marker(seq: Id, t: Ticks, clip: Option<Id>) -> Json {
    let opts = match clip {
        Some(c) => json!({ "clipId": c.as_str() }),
        None => json!({}),
    };
    json!({ "type": "addMarker", "seqId": seq.as_str(), "marker": { "t": t }, "opts": opts })
}

pub fn remove_marker(seq: Id, id: Id) -> Json {
    json!({ "type": "removeMarker", "seqId": seq.as_str(), "id": id.as_str() })
}

/// Pastes clip copies (each with `kind` and `trackIndex`, as the JavaScript's clipboard keeps them).
pub fn paste(seq: Id, clips: Vec<Json>, at: Ticks, video: Option<Id>, audio: Option<Id>, insert: bool) -> Json {
    json!({ "type": "paste", "seqId": seq.as_str(), "clips": clips, "opts": {
        "at": at, "mode": if insert { "insert" } else { "overwrite" },
        "video": video.map(Id::as_str), "audio": audio.map(Id::as_str),
    } })
}

pub fn batch(label: &str, list: Vec<Json>) -> Json {
    json!({ "type": "batch", "label": label, "commands": list })
}
