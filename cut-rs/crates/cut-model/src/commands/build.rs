//! The commands as [`History::apply`](crate::History::apply) takes them, one builder each (port of the command
//! builders at the end of `commands.js`, which the panels and tests call). Ids are `&str`, times and lengths ticks;
//! the arguments are the JavaScript's in its order, so a command the screen builds has every field the JavaScript's
//! has, named as there. Options and patches (`opts`, `patch`) stay JSON, with the fields the commands read; pass
//! `json!({})` for none.

use cut_time::Ticks;
use serde_json::{Value as Json, json};

fn null_or<T: serde::Serialize>(v: Option<T>) -> Json {
    v.map_or(Json::Null, |v| json!(v))
}

/// `importMedia`: media files (`{ path, name?, kind, duration, video, audio, size?, mtime? }`) into a bin or none.
pub fn import_media(media: Json, bin_id: Option<&str>) -> Json {
    json!({ "type": "importMedia", "media": media, "binId": bin_id })
}

/// `removeMedia`: media and every clip of them.
pub fn remove_media(ids: &[&str]) -> Json {
    json!({ "type": "removeMedia", "ids": ids })
}

/// `relinkMedia`: a media item to another file (`{ path, size?, mtime?, duration?, video?, audio? }`).
pub fn relink_media(id: &str, file: Json) -> Json {
    json!({ "type": "relinkMedia", "id": id, "file": file })
}

/// `addBin`.
pub fn add_bin(name: &str, parent: Option<&str>) -> Json {
    json!({ "type": "addBin", "name": name, "parent": parent })
}

/// `removeBin`.
pub fn remove_bin(id: &str) -> Json {
    json!({ "type": "removeBin", "id": id })
}

/// `renameItem`: a media item, bin or sequence.
pub fn rename_item(id: &str, name: &str) -> Json {
    json!({ "type": "renameItem", "id": id, "name": name })
}

/// `moveToBin`: media and sequences into a bin, or out of every bin.
pub fn move_to_bin(ids: &[&str], bin_id: Option<&str>) -> Json {
    json!({ "type": "moveToBin", "ids": ids, "binId": bin_id })
}

/// `addSequence`: `opts` `{ name?, w?, h?, fps?, from? }` (`from`: a sequence to duplicate).
pub fn add_sequence(opts: Json) -> Json {
    json!({ "type": "addSequence", "opts": opts })
}

/// `removeSequence`.
pub fn remove_sequence(id: &str) -> Json {
    json!({ "type": "removeSequence", "id": id })
}

/// `setSequence`: `patch` `{ name?, w?, h?, fps?, background?, masterGain? }`.
pub fn set_sequence(id: &str, patch: Json) -> Json {
    json!({ "type": "setSequence", "id": id, "patch": patch })
}

/// `addTrack`: a `"video"` or `"audio"` track at `index` among its kind (the end when `None`).
pub fn add_track(seq_id: &str, kind: &str, index: Option<usize>, opts: Json) -> Json {
    json!({ "type": "addTrack", "seqId": seq_id, "kind": kind, "index": null_or(index), "opts": opts })
}

/// `removeTrack`.
pub fn remove_track(seq_id: &str, track_id: &str) -> Json {
    json!({ "type": "removeTrack", "seqId": seq_id, "trackId": track_id })
}

/// `setTrack`: `patch` `{ name?, locked?, syncLock?, height?, visible?, mute?, solo?, volume?, pan? }`.
pub fn set_track(seq_id: &str, track_id: &str, patch: Json) -> Json {
    json!({ "type": "setTrack", "seqId": seq_id, "trackId": track_id, "patch": patch })
}

/// `place`: `opts` `{ source, in, out, at | endAt, video?, audio?, mode: "overwrite" | "insert", name? }`.
pub fn place(seq_id: &str, opts: Json) -> Json {
    json!({ "type": "place", "seqId": seq_id, "opts": opts })
}

/// `placeRange`: three-point editing, `opts` `{ source, in?, out?, range: { in?, out? }, video?, audio?, mode }`.
pub fn place_range(seq_id: &str, opts: Json) -> Json {
    json!({ "type": "placeRange", "seqId": seq_id, "opts": opts })
}

/// `move`: `opts` `{ delta, trackDelta?, insert?, nudge?, linked? }`.
pub fn move_clips(seq_id: &str, clip_ids: &[&str], opts: Json) -> Json {
    json!({ "type": "move", "seqId": seq_id, "clipIds": clip_ids, "opts": opts })
}

/// `move` of clips by `delta` ticks and `track_delta` tracks, linked clips with them.
pub fn move_by(seq_id: &str, clip_ids: &[&str], delta: Ticks, track_delta: i64) -> Json {
    move_clips(seq_id, clip_ids, json!({ "delta": delta, "trackDelta": track_delta }))
}

/// `trim`: `opts` `{ edge: "start" | "end", delta, mode?: "normal" | "ripple" | "roll", linked? }`.
pub fn trim(seq_id: &str, clip_id: &str, opts: Json) -> Json {
    json!({ "type": "trim", "seqId": seq_id, "clipId": clip_id, "opts": opts })
}

/// `split` at `t`: `opts` `{ allTracks? , trackIds?, clipIds?, linked? }`.
pub fn split(seq_id: &str, t: Ticks, opts: Json) -> Json {
    json!({ "type": "split", "seqId": seq_id, "t": t, "opts": opts })
}

/// `remove`: `opts` `{ ripple?, linked? }`.
pub fn remove(seq_id: &str, clip_ids: &[&str], opts: Json) -> Json {
    json!({ "type": "remove", "seqId": seq_id, "clipIds": clip_ids, "opts": opts })
}

/// `rippleToPlayhead`: `side` `"before"` or `"after"`, `opts` `{ trackIds? }`.
pub fn ripple_to_playhead(seq_id: &str, t: Ticks, side: &str, opts: Json) -> Json {
    json!({ "type": "rippleToPlayhead", "seqId": seq_id, "t": t, "side": side, "opts": opts })
}

/// `closeGap`: the gap at `t` on a track.
pub fn close_gap(seq_id: &str, track_id: &str, t: Ticks) -> Json {
    json!({ "type": "closeGap", "seqId": seq_id, "trackId": track_id, "t": t })
}

/// `lift`: what is between `in_t` and `out_t` on the tracks (every unlocked one when `None`), leaving a gap.
pub fn lift(seq_id: &str, in_t: Ticks, out_t: Ticks, track_ids: Option<&[&str]>) -> Json {
    json!({ "type": "lift", "seqId": seq_id, "in": in_t, "out": out_t, "trackIds": track_ids })
}

/// `extract`: as [`lift`], closing the gap.
pub fn extract(seq_id: &str, in_t: Ticks, out_t: Ticks, track_ids: Option<&[&str]>) -> Json {
    json!({ "type": "extract", "seqId": seq_id, "in": in_t, "out": out_t, "trackIds": track_ids })
}

/// `setClip`: `patch` `{ props?, speed?, duration?, ripple?, reverse?, enabled?, name?, label?, role?, fadeIn?,
/// fadeOut?, sampling? }`, `opts` `{ linked? }`.
pub fn set_clip(seq_id: &str, clip_id: &str, patch: Json, opts: Json) -> Json {
    json!({ "type": "setClip", "seqId": seq_id, "clipId": clip_id, "patch": patch, "opts": opts })
}

/// `setKeyframes`: a property's keyframes (`[{ t, v, ease, h? }]`), or `None` to clear them.
pub fn set_keyframes(seq_id: &str, clip_id: &str, prop: &str, keyframes: Option<Json>) -> Json {
    json!({ "type": "setKeyframes", "seqId": seq_id, "clipId": clip_id, "prop": prop, "keyframes": keyframes })
}

/// `setRemap`: a time remapping curve (`{ at, speeds, keys, duration }`), or `None` for none.
pub fn set_remap(seq_id: &str, clip_id: &str, remap: Option<Json>) -> Json {
    json!({ "type": "setRemap", "seqId": seq_id, "clipId": clip_id, "remap": remap })
}

/// `link`.
pub fn link(seq_id: &str, clip_ids: &[&str]) -> Json {
    json!({ "type": "link", "seqId": seq_id, "clipIds": clip_ids })
}

/// `unlink`.
pub fn unlink(seq_id: &str, clip_ids: &[&str]) -> Json {
    json!({ "type": "unlink", "seqId": seq_id, "clipIds": clip_ids })
}

/// `group`.
pub fn group(seq_id: &str, clip_ids: &[&str]) -> Json {
    json!({ "type": "group", "seqId": seq_id, "clipIds": clip_ids })
}

/// `nest`: clips into a new sequence, `opts` `{ name?, linked? }`.
pub fn nest(seq_id: &str, clip_ids: &[&str], opts: Json) -> Json {
    json!({ "type": "nest", "seqId": seq_id, "clipIds": clip_ids, "opts": opts })
}

/// `ungroup`.
pub fn ungroup(seq_id: &str, clip_ids: &[&str]) -> Json {
    json!({ "type": "ungroup", "seqId": seq_id, "clipIds": clip_ids })
}

/// `slip`: `opts` `{ delta, linked? }`.
pub fn slip(seq_id: &str, clip_id: &str, opts: Json) -> Json {
    json!({ "type": "slip", "seqId": seq_id, "clipId": clip_id, "opts": opts })
}

/// `slide`: `opts` `{ delta, linked? }`.
pub fn slide(seq_id: &str, clip_id: &str, opts: Json) -> Json {
    json!({ "type": "slide", "seqId": seq_id, "clipId": clip_id, "opts": opts })
}

/// `stretch` (Rate Stretch): `opts` `{ edge, delta, linked? }`.
pub fn stretch(seq_id: &str, clip_id: &str, opts: Json) -> Json {
    json!({ "type": "stretch", "seqId": seq_id, "clipId": clip_id, "opts": opts })
}

/// `extendEdit`: the nearest edit to `t`, `opts` `{ clipIds? , trackIds?, linked? }`.
pub fn extend_edit(seq_id: &str, t: Ticks, opts: Json) -> Json {
    json!({ "type": "extendEdit", "seqId": seq_id, "t": t, "opts": opts })
}

/// `addEffect`: an effect of the registry ([`crate::effects`]) at `index` (the end when `None`).
pub fn add_effect(seq_id: &str, clip_id: &str, effect_type: &str, index: Option<usize>, params: Json) -> Json {
    json!({
        "type": "addEffect", "seqId": seq_id, "clipId": clip_id, "effectType": effect_type, "index": null_or(index),
        "params": params,
    })
}

/// `removeEffect`.
pub fn remove_effect(seq_id: &str, clip_id: &str, effect_id: &str) -> Json {
    json!({ "type": "removeEffect", "seqId": seq_id, "clipId": clip_id, "effectId": effect_id })
}

/// `setEffect`: `patch` `{ on?, params? }` (a parameter set to null goes back to its default).
pub fn set_effect(seq_id: &str, clip_id: &str, effect_id: &str, patch: Json) -> Json {
    json!({ "type": "setEffect", "seqId": seq_id, "clipId": clip_id, "effectId": effect_id, "patch": patch })
}

/// `moveEffect`.
pub fn move_effect(seq_id: &str, clip_id: &str, effect_id: &str, index: usize) -> Json {
    json!({ "type": "moveEffect", "seqId": seq_id, "clipId": clip_id, "effectId": effect_id, "index": index })
}

/// `addMask`: on Opacity, or on the effect `effect_id`.
pub fn add_mask(seq_id: &str, clip_id: &str, mask: Json, effect_id: Option<&str>) -> Json {
    json!({ "type": "addMask", "seqId": seq_id, "clipId": clip_id, "mask": mask, "opts": { "effectId": effect_id } })
}

/// `setMask`: `patch` `{ mode?, inverted?, path?, feather?, opacity?, expansion? }`.
pub fn set_mask(seq_id: &str, clip_id: &str, mask_id: &str, patch: Json, effect_id: Option<&str>) -> Json {
    json!({
        "type": "setMask", "seqId": seq_id, "clipId": clip_id, "maskId": mask_id, "patch": patch,
        "opts": { "effectId": effect_id },
    })
}

/// `removeMask`.
pub fn remove_mask(seq_id: &str, clip_id: &str, mask_id: &str, effect_id: Option<&str>) -> Json {
    json!({
        "type": "removeMask", "seqId": seq_id, "clipId": clip_id, "maskId": mask_id, "opts": { "effectId": effect_id },
    })
}

/// `addTransition`: `opts` `{ track, at, type, duration?, align?, params? }`.
pub fn add_transition(seq_id: &str, opts: Json) -> Json {
    json!({ "type": "addTransition", "seqId": seq_id, "opts": opts })
}

/// `removeTransition`.
pub fn remove_transition(seq_id: &str, id: &str) -> Json {
    json!({ "type": "removeTransition", "seqId": seq_id, "id": id })
}

/// `setTransition`: `patch` `{ type?, duration?, align?, params? }`.
pub fn set_transition(seq_id: &str, id: &str, patch: Json) -> Json {
    json!({ "type": "setTransition", "seqId": seq_id, "id": id, "patch": patch })
}

/// `addGenerated`: a text, solid, adjustment or graphic clip, `opts` `{ track, at, duration?, source, mode?, name? }`.
pub fn add_generated(seq_id: &str, opts: Json) -> Json {
    json!({ "type": "addGenerated", "seqId": seq_id, "opts": opts })
}

/// `freezeFrame`: the frame at `t` held for `duration` (the project's setting when `None`).
pub fn freeze_frame(seq_id: &str, clip_id: &str, t: Ticks, duration: Option<Ticks>) -> Json {
    let mut c = json!({ "type": "freezeFrame", "seqId": seq_id, "clipId": clip_id, "t": t });
    if let Some(d) = duration {
        c["duration"] = json!(d);
    }
    c
}

/// `addMarker`: `marker` `{ t, duration?, name?, note?, kind?, color? }`, `opts` `{ clipId? }` for a clip marker.
pub fn add_marker(seq_id: &str, marker: Json, opts: Json) -> Json {
    json!({ "type": "addMarker", "seqId": seq_id, "marker": marker, "opts": opts })
}

/// `setMarker`.
pub fn set_marker(seq_id: &str, id: &str, patch: Json) -> Json {
    json!({ "type": "setMarker", "seqId": seq_id, "id": id, "patch": patch })
}

/// `removeMarker`.
pub fn remove_marker(seq_id: &str, id: &str) -> Json {
    json!({ "type": "removeMarker", "seqId": seq_id, "id": id })
}

/// `addCaptionTrack`: `opts` `{ lang?, name?, items?, syncLock?, style? }`.
pub fn add_caption_track(seq_id: &str, opts: Json) -> Json {
    json!({ "type": "addCaptionTrack", "seqId": seq_id, "opts": opts })
}

/// `setCaptionTrack`.
pub fn set_caption_track(seq_id: &str, track_id: &str, patch: Json) -> Json {
    json!({ "type": "setCaptionTrack", "seqId": seq_id, "trackId": track_id, "patch": patch })
}

/// `removeCaptionTrack`.
pub fn remove_caption_track(seq_id: &str, track_id: &str) -> Json {
    json!({ "type": "removeCaptionTrack", "seqId": seq_id, "trackId": track_id })
}

/// `setCaptions`: every caption of a track (`[{ start, end, text, words?, doubt?, speaker? }]`).
pub fn set_captions(seq_id: &str, track_id: &str, items: Json) -> Json {
    json!({ "type": "setCaptions", "seqId": seq_id, "trackId": track_id, "items": items })
}

/// `addCaption`.
pub fn add_caption(seq_id: &str, track_id: &str, item: Json) -> Json {
    json!({ "type": "addCaption", "seqId": seq_id, "trackId": track_id, "item": item })
}

/// `setCaption`.
pub fn set_caption(seq_id: &str, track_id: &str, item_id: &str, patch: Json) -> Json {
    json!({ "type": "setCaption", "seqId": seq_id, "trackId": track_id, "itemId": item_id, "patch": patch })
}

/// `removeCaption`.
pub fn remove_caption(seq_id: &str, track_id: &str, item_id: &str) -> Json {
    json!({ "type": "removeCaption", "seqId": seq_id, "trackId": track_id, "itemId": item_id })
}

/// `setProxy`: `{ path }` of the smaller file, or `None` for none.
pub fn set_proxy(id: &str, proxy: Option<Json>) -> Json {
    json!({ "type": "setProxy", "id": id, "proxy": proxy })
}

/// `setSettings`: `patch` `{ fit?, stillDuration?, transitionDuration?, freezeDuration?, textStyles?, ... }`.
pub fn set_settings(patch: Json) -> Json {
    json!({ "type": "setSettings", "patch": patch })
}

/// `setSpeakers`: `patch` `{ list?, turns?, count? }`, or `None` to clear the speaker labels.
pub fn set_speakers(patch: Option<Json>) -> Json {
    json!({ "type": "setSpeakers", "patch": patch })
}

/// `addLut`: `{ id, entry }` as Lumetri Color's `store()` makes it.
pub fn add_lut(id: &str, entry: Json) -> Json {
    json!({ "type": "addLut", "id": id, "entry": entry })
}

/// `paste`: copied clips (each with its track's `kind`), `opts` `{ at, mode?, video?, audio? }`.
pub fn paste(seq_id: &str, clips: Json, opts: Json) -> Json {
    json!({ "type": "paste", "seqId": seq_id, "clips": clips, "opts": opts })
}

/// `setGenerator`: `patch` `{ color? }` of a solid, `{ layers? }` of a text or graphic clip.
pub fn set_generator(seq_id: &str, clip_id: &str, patch: Json) -> Json {
    json!({ "type": "setGenerator", "seqId": seq_id, "clipId": clip_id, "patch": patch })
}

/// `setLayer`: fields of one text or graphic layer.
pub fn set_layer(seq_id: &str, clip_id: &str, layer_id: &str, patch: Json) -> Json {
    json!({ "type": "setLayer", "seqId": seq_id, "clipId": clip_id, "layerId": layer_id, "patch": patch })
}

/// `addLayer`: at `index` (the top when `None`).
pub fn add_layer(seq_id: &str, clip_id: &str, layer: Json, index: Option<usize>) -> Json {
    json!({ "type": "addLayer", "seqId": seq_id, "clipId": clip_id, "layer": layer, "index": null_or(index) })
}

/// `removeLayer`.
pub fn remove_layer(seq_id: &str, clip_id: &str, layer_id: &str) -> Json {
    json!({ "type": "removeLayer", "seqId": seq_id, "clipId": clip_id, "layerId": layer_id })
}

/// `setRole`: `"dialogue"`, `"music"`, `"effects"`, `"ambience"` or `None`, `opts` `{ linked? }`.
pub fn set_role(seq_id: &str, clip_ids: &[&str], role: Option<&str>, opts: Json) -> Json {
    json!({ "type": "setRole", "seqId": seq_id, "clipIds": clip_ids, "role": role, "opts": opts })
}

/// `replaceAudio`: audio clips play another media item's sound.
pub fn replace_audio(seq_id: &str, clip_ids: &[&str], media_id: &str) -> Json {
    json!({ "type": "replaceAudio", "seqId": seq_id, "clipIds": clip_ids, "mediaId": media_id })
}

/// `batch`: commands as one step named `label`.
pub fn batch(label: &str, commands: Vec<Json>) -> Json {
    json!({ "type": "batch", "label": label, "commands": commands })
}
