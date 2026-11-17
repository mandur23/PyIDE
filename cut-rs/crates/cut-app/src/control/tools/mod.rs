//! The tools' runs by name, and each tool's step line in the chat (`say`), as control*.js define them.

mod actions;
mod auto;
mod clip;
mod edit;
mod more;
mod project;
mod read;

use serde_json::Value as Json;

use super::call::Run;
use super::schema::js_num;

/// The run of a tool of the table.
pub fn run_of(name: &str) -> Option<Run> {
    Some(match name {
        "get_project" => read::get_project,
        "get_sequence" => read::get_sequence,
        "get_clip" => read::get_clip,
        "get_media" => read::get_media,
        "get_markers" => read::get_markers,
        "get_captions" => read::get_captions,
        "get_transcript" => read::get_transcript,
        "list_effects" => read::list_effects,
        "get_frame" => read::get_frame,
        "get_state" => read::get_state,
        "place_clip" => edit::place_clip,
        "move_clips" => edit::move_clips,
        "trim_clip" => edit::trim_clip,
        "razor" => edit::razor,
        "delete_clips" => edit::delete_clips,
        "delete_range" => edit::delete_range,
        "link_clips" => edit::link_clips,
        "set_clip" => clip::set_clip,
        "set_speed" => clip::set_speed,
        "set_time_remap" => clip::set_time_remap,
        "set_keyframes" => clip::set_keyframes,
        "add_effect" => clip::add_effect,
        "set_effect" => clip::set_effect,
        "remove_effect" => clip::remove_effect,
        "set_color" => clip::set_color,
        "add_transition" => more::add_transition,
        "remove_transition" => more::remove_transition,
        "add_text" => more::add_text,
        "set_text" => more::set_text,
        "add_captions" => more::add_captions,
        "set_caption" => more::set_caption,
        "remove_captions" => more::remove_captions,
        "add_marker" => more::add_marker,
        "set_marker" => more::set_marker,
        "remove_markers" => more::remove_markers,
        "add_mask" => more::add_mask,
        "set_mask" => more::set_mask,
        "remove_mask" => more::remove_mask,
        "nest_clips" => more::nest_clips,
        "set_track" => more::set_track,
        "set_sequence" => more::set_sequence,
        "remove_silence" => more::remove_silence,
        "select_clips" => more::select_clips,
        "seek" => more::seek,
        "play" => more::play,
        "stop" => more::stop,
        "undo" => more::undo,
        "redo" => more::redo,
        "export_sequence" => more::export_sequence,
        "import_media" => project::import_media,
        "remove_media" => project::remove_media,
        "project_items" => project::project_items,
        "add_sequence" => project::add_sequence,
        "remove_sequence" => project::remove_sequence,
        "add_track" => project::add_track,
        "remove_track" => project::remove_track,
        "set_transition" => project::set_transition,
        "set_caption_track" => project::set_caption_track,
        "add_color_matte" => project::add_color_matte,
        "set_project_settings" => project::set_project_settings,
        "save_project" => project::save_project,
        "export_frame" => project::export_frame,
        "export_captions" => project::export_captions,
        "export_queue" => project::export_queue,
        "proxies" => project::proxies,
        "create_shorts" => project::create_shorts,
        "automation" => auto::automation,
        "essential_sound" => auto::essential_sound,
        "speakers" => auto::speakers,
        "add_graphic" => auto::add_graphic,
        "set_graphic" => auto::set_graphic,
        "list_actions" => actions::list_actions,
        "run_action" => actions::run_action,
        _ => return None,
    })
}

/// `${v}` of an argument as the JavaScript writes it into a step line.
fn text(v: &Json) -> String {
    match v {
        Json::Null => "null".into(),
        Json::String(s) => s.clone(),
        Json::Number(n) => js_num(n.as_f64().unwrap_or(0.0)),
        other => other.to_string(),
    }
}

/// A tool's step line (`say`): the English text for `tr`, with its `{name}` parameters; `None` for the title.
pub fn say(name: &str, a: &Json) -> Option<(String, Vec<(String, String)>)> {
    let g = |k: &str| a.get(k).map_or_else(|| "undefined".to_owned(), text);
    let n = |k: &str| a.get(k).and_then(Json::as_array).map_or(0, Vec::len).to_string();
    let p = |pairs: &[(&str, String)]| pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect::<Vec<_>>();
    let line = |t: &str, pairs: &[(&str, String)]| Some((t.to_owned(), p(pairs)));
    let mode = a.get("mode").and_then(Json::as_str);
    let action = a.get("action").and_then(Json::as_str);
    match name {
        "place_clip" => {
            let what = a
                .get("media_id")
                .filter(|v| !v.is_null())
                .or(a.get("nest_sequence_id"))
                .map_or("undefined".into(), text);
            line("Place {what} at {at} s", &[("what", what), ("at", g("at"))])
        }
        "move_clips" => line("Move {n} clips", &[("n", n("clip_ids"))]),
        "trim_clip" => {
            let t = match (mode, a.get("edge").and_then(Json::as_str)) {
                (Some("slip"), _) => "Slip {clip}",
                (Some("slide"), _) => "Slide {clip}",
                (_, Some("start")) => "Trim the start of {clip}",
                _ => "Trim the end of {clip}",
            };
            line(t, &[("clip", g("clip_id"))])
        }
        "razor" => line("Cut at {at} s", &[("at", g("at"))]),
        "delete_clips" => line(
            if a.get("ripple").and_then(Json::as_bool) == Some(true) {
                "Ripple delete {n} clips"
            } else {
                "Delete {n} clips"
            },
            &[("n", n("clip_ids"))],
        ),
        "delete_range" => line(
            if a.get("ripple").and_then(Json::as_bool) == Some(false) {
                "Lift {from}–{to} s"
            } else {
                "Delete {from}–{to} s"
            },
            &[("from", g("from")), ("to", g("to"))],
        ),
        "link_clips" => {
            let t = match action {
                Some("link") => "Link {n} clips",
                Some("unlink") => "Unlink {n} clips",
                Some("group") => "Group {n} clips",
                Some("ungroup") => "Ungroup {n} clips",
                _ => return Some(("undefined".into(), p(&[("n", n("clip_ids"))]))),
            };
            line(t, &[("n", n("clip_ids"))])
        }
        "set_clip" => line("Change {clip}", &[("clip", g("clip_id"))]),
        "set_speed" => {
            if a.get("duration").is_some_and(|v| !v.is_null()) {
                line("Duration of {clip}: {s} s", &[("clip", g("clip_id")), ("s", g("duration"))])
            } else {
                let speed = a.get("speed").filter(|v| !v.is_null()).map_or("100".into(), text);
                line("Speed of {clip}: {speed}%", &[("clip", g("clip_id")), ("speed", speed)])
            }
        }
        "set_time_remap" => line("Time Remapping of {clip}", &[("clip", g("clip_id"))]),
        "set_keyframes" => line("Keyframes of {prop} on {clip}", &[("prop", g("property")), ("clip", g("clip_id"))]),
        "add_effect" => line("Add {type} to {clip}", &[("type", g("type")), ("clip", g("clip_id"))]),
        "set_effect" => line("Change {effect} on {clip}", &[("effect", g("effect_id")), ("clip", g("clip_id"))]),
        "remove_effect" => line("Remove {effect} from {clip}", &[("effect", g("effect_id")), ("clip", g("clip_id"))]),
        "set_color" => line("Color of {clip}", &[("clip", g("clip_id"))]),
        "add_transition" => line("Add a transition on {track} at {at} s", &[("track", g("track")), ("at", g("at"))]),
        "remove_transition" => line("Remove transition {id}", &[("id", g("transition_id"))]),
        "add_text" => {
            let u: Vec<u16> = a.get("text").map_or("undefined".into(), text).encode_utf16().take(40).collect();
            line("Add the title \"{text}\"", &[("text", String::from_utf16_lossy(&u))])
        }
        "set_text" => line("Change the title {clip}", &[("clip", g("clip_id"))]),
        "add_captions" => line("Add {n} captions", &[("n", n("items"))]),
        "set_caption" => line("Change caption {id}", &[("id", g("caption_id"))]),
        "remove_captions" => line(
            if a.get("whole_track").and_then(Json::as_bool) == Some(true) {
                "Remove caption track {id}"
            } else {
                "Remove {n} captions"
            },
            &[("id", g("track_id")), ("n", n("caption_ids"))],
        ),
        "add_marker" => line("Add a marker at {at} s", &[("at", g("at"))]),
        "set_marker" => line("Change marker {id}", &[("id", g("marker_id"))]),
        "remove_markers" => line("Remove markers", &[]),
        "add_mask" => line("Add a mask to {clip}", &[("clip", g("clip_id"))]),
        "set_mask" => line("Change mask {id}", &[("id", g("mask_id"))]),
        "remove_mask" => line("Remove mask {id}", &[("id", g("mask_id"))]),
        "nest_clips" => line("Nest {n} clips", &[("n", n("clip_ids"))]),
        "set_track" => line("Change track {id}", &[("id", g("track_id"))]),
        "set_sequence" => line("Change the sequence", &[]),
        "remove_silence" => line("Remove silences longer than {s} s", &[("s", g("longer_than"))]),
        "select_clips" => line("Select {n} clips", &[("n", n("clip_ids"))]),
        "seek" => line("Go to {t} s", &[("t", g("time"))]),
        "export_sequence" => line("Export with {preset}", &[("preset", g("preset"))]),
        "import_media" => {
            if a.get("paths").is_some_and(|v| !v.is_null()) {
                line("Import {n} files", &[("n", n("paths"))])
            } else {
                line("Import media", &[])
            }
        }
        "remove_media" => line("Remove {n} media from the project", &[("n", n("media_ids"))]),
        "project_items" => {
            let t = match action {
                Some("new_bin") => "New bin",
                Some("remove_bin") => "Delete bin {id}",
                Some("rename") => "Rename {id}",
                Some("move") => "Move {n} items",
                _ => "undefined",
            };
            let id = ["bin_id", "item_id"]
                .iter()
                .find_map(|k| a.get(*k).and_then(Json::as_str).filter(|s| !s.is_empty()))
                .unwrap_or_default()
                .to_owned();
            line(t, &[("id", id), ("n", n("item_ids"))])
        }
        "add_sequence" => line(
            "New sequence {name}",
            &[("name", a.get("name").and_then(Json::as_str).unwrap_or_default().to_owned())],
        ),
        "remove_sequence" => line("Delete sequence {id}", &[("id", g("sequence_id"))]),
        "add_track" => line("Add a {kind} track", &[("kind", g("kind"))]),
        "remove_track" => line("Delete track {id}", &[("id", g("track_id"))]),
        "set_transition" => line("Change transition {id}", &[("id", g("transition_id"))]),
        "set_caption_track" => line("Change caption track {id}", &[("id", g("track_id"))]),
        "add_color_matte" => line("Add a color matte at {at} s", &[("at", g("at"))]),
        "set_project_settings" => line("Change the project settings", &[]),
        "save_project" => line("Save the project", &[]),
        "export_frame" => line(
            "Export the frame at {t} s",
            &[("t", a.get("time").filter(|v| !v.is_null()).map_or(String::new(), text))],
        ),
        "export_captions" => line("Export the captions", &[]),
        "export_queue" => line("Export queue: {action}", &[("action", action.unwrap_or("list").to_owned())]),
        "proxies" => line("Proxies: {action}", &[("action", action.unwrap_or("status").to_owned())]),
        "create_shorts" => line("Create a shorts sequence of {n} parts", &[("n", n("ranges"))]),
        "automation" => line(auto::job_step(action.unwrap_or_default()), &[]),
        "essential_sound" => {
            let t = match action {
                Some("clarity") => "Clarity on {n} clips",
                Some("reduce_hum_50") | Some("reduce_hum_60") => "Reduce hum on {n} clips",
                Some("noise_gate") => "Noise gate on {n} clips",
                _ => "Hard limiter on {n} clips",
            };
            line(t, &[("n", n("clip_ids"))])
        }
        "speakers" => line(
            if action == Some("rename") { "Rename speaker {id}" } else { "Read the speakers" },
            &[("id", a.get("speaker_id").and_then(Json::as_str).unwrap_or_default().to_owned())],
        ),
        "add_graphic" => line("Add a graphic at {at} s ({n} layers)", &[("at", g("at")), ("n", n("layers"))]),
        "set_graphic" => line("Change graphic {clip}", &[("clip", g("clip_id"))]),
        "run_action" => line("Run {id}", &[("id", g("id"))]),
        _ => None,
    }
}
