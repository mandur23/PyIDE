//! The control API's tools against the JavaScript's own (`tools/scenarios/control.cjs` runs control*.js): the tool
//! table as MCP lists it (names, schemas, descriptions, annotations), `check` on every tool's schema with fuzzed
//! arguments, the step lines, and scripts of calls run on the same project by both sides, answer by answer, then the
//! project after them field by field. `CUT_CONTROL_WRITE=1` writes `src/control/table.json` from the JavaScript's
//! table first (after a change of control*.js).

use cut_app::control::call::{self, Started};
use cut_app::control::host::{Bare, Live};
use cut_app::control::{schema, table};
use cut_app::state::App;
use cut_model::{History, Project};
use cut_oracle::Inputs;
use serde_json::{Value as Json, json};

fn ask(calls: &[Json]) -> Vec<Json> {
    cut_oracle::ask("scenario/control", calls)
}

/// Equal as JSON, numbers by value (an integer and the same float are one number).
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap_or(f64::NAN), y.as_f64().unwrap_or(f64::NAN));
            x == y || (x - y).abs() <= 1e-9 * x.abs().max(1.0)
        }
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Where two values first differ, as a path.
fn diff(a: &Json, b: &Json, at: &str) -> Option<String> {
    if same(a, b) {
        return None;
    }
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                if let Some(d) =
                    diff(x.get(k).unwrap_or(&Json::Null), y.get(k).unwrap_or(&Json::Null), &format!("{at}.{k}"))
                {
                    return Some(d);
                }
                if x.contains_key(k) != y.contains_key(k) {
                    return Some(format!("{at}.{k}: only on one side"));
                }
            }
            None
        }
        (Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| diff(p, q, &format!("{at}[{i}]")))
        }
        _ => Some(format!("{at}: rust {a} / js {b}")),
    }
}

#[test]
fn the_tool_table_is_the_javascripts() {
    if std::env::var_os("CUT_CONTROL_WRITE").is_some() {
        let t = ask(&[json!(["table"])]).remove(0);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/control/table.json");
        std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&t).unwrap())).unwrap();
        panic!("wrote {}; build again", path.display());
    }
    let js = ask(&[json!(["definitions"]), json!(["instructions"]), json!(["kinds"]), json!(["actions"])]);
    let rust = table::definitions();
    let names = |l: &[Json]| l.iter().map(|d| d["name"].as_str().unwrap_or_default().to_owned()).collect::<Vec<_>>();
    let js_defs = js[0].as_array().unwrap();
    assert_eq!(names(&rust), names(js_defs), "the same tools in the same order");
    assert!(rust.len() >= 73, "{} tools", rust.len());
    for (r, j) in rust.iter().zip(js_defs) {
        assert!(diff(r, j, "").is_none(), "{}: {:?}", r["name"], diff(r, j, ""));
    }
    assert_eq!(table::instructions(), js[1].as_str().unwrap());
    for pair in js[2].as_array().unwrap() {
        let k = format!("{:?}", table::tool(pair[0].as_str().unwrap()).unwrap().kind).to_lowercase();
        assert_eq!(k, pair[1].as_str().unwrap(), "{pair}");
    }
    let acts: Vec<Json> = table::actions()
        .iter()
        .map(|a| json!({ "id": a.id, "what": a.what, "needs": a.needs, "view": a.view, "panel": a.panel }))
        .collect();
    assert!(same(&Json::Array(acts), &js[3]), "run_action's actions");
    for a in table::actions() {
        if let Some(n) = &a.needs {
            assert!(!table::needs(n).is_empty(), "the needs sentence of {n}");
        }
    }
    for t in table::tools() {
        assert!(call::describe(&t.name, &json!({})).0.len() > 2);
    }
}

/// A value of a random JSON type, sometimes near a schema's edges.
fn value(rng: &mut Inputs, depth: u32) -> Json {
    match rng.range(0, if depth > 1 { 6 } else { 8 }) {
        0 => Json::Null,
        1 => json!(rng.range(0, 1) == 1),
        2 => json!(rng.range(-5, 3000)),
        3 => json!(rng.range(-100000, 100000) as f64 / 7.0),
        4 => {
            json!(rng.pick(&["", "a", "video", "audio", "center", "#ff0000", "fade", "x".repeat(70).as_str(), "링크"]))
        }
        5 => json!(rng.pick(&["ellipse", "comment", "markers", "h264", "srt", "list", "beat"])),
        6 => Json::Array((0..rng.range(0, 5)).map(|_| value(rng, depth + 1)).collect()),
        _ => {
            let keys =
                ["x", "kind", "speed", "until", "hold", "color", "start", "end", "text", "from", "to", "id", "after"];
            Json::Object((0..rng.range(0, 3)).map(|_| (rng.pick(&keys).to_owned(), value(rng, depth + 1))).collect())
        }
    }
}

#[test]
fn check_refuses_as_the_javascript_does() {
    let mut rng = Inputs::new(17);
    let mut calls = Vec::new();
    let mut mine = Vec::new();
    for t in table::tools() {
        let props: Vec<String> = t.input.properties.iter().flatten().map(|(k, _)| k.clone()).collect();
        for _ in 0..40 {
            let mut args = serde_json::Map::new();
            for _ in 0..rng.range(0, 3) {
                let k = if rng.range(0, 9) == 0 || props.is_empty() {
                    "nope".to_owned()
                } else {
                    props[rng.range(0, props.len() as i64 - 1) as usize].clone()
                };
                args.insert(k, value(&mut rng, 0));
            }
            // one key a call, so the order of several bad ones (JSON objects here keep none) does not decide
            let args: serde_json::Map<String, Json> = args.into_iter().take(1).collect();
            let a = Json::Object(args);
            calls.push(json!(["check", t.name, a]));
            mine.push(schema::check(&t.input, &a, "arguments"));
        }
    }
    let js = ask(&calls);
    let mut bad = Vec::new();
    for (i, (r, j)) in mine.iter().zip(&js).enumerate() {
        if Some(r.as_str()) != j.as_str() {
            bad.push(format!("{}: rust {r:?} / js {j}", calls[i][2]));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), mine.len(), bad[..bad.len().min(20)].join("\n"));
}

/// The project both sides start from.
fn fresh() -> Json {
    ask(&[json!(["fresh"])]).remove(0)
}

/// A script on the Rust side, as the scenario runs it: `{results, project, app}`.
fn run_rust(project: &Json, setup: &Json, calls: &[(String, Json)]) -> Json {
    let p = Project::from_json(project.clone()).expect("the project loads");
    let mut app = App::new(History::new(p, usize::MAX).unwrap(), None);
    if let Some(s) = setup["sequence"].as_str() {
        app.set_sequence(cut_model::Id::new(s));
    }
    if let Some(t) = setup["t"].as_i64() {
        app.set_time(t);
    }
    if let Some(sel) = setup["selection"].as_array() {
        app.select(sel.iter().filter_map(Json::as_str).map(cut_model::Id::new), false, false);
    }
    let mut host = Bare(app);
    let floor = setup["undoFloor"].as_u64().map(|x| x as usize);
    let mut results = Vec::new();
    for (name, args) in calls {
        let live = Live::default();
        let answer = match call::call(name, args, &mut host, &live, floor) {
            Started::Done(a) => a,
            Started::Waiting(mut p) => loop {
                if let Some(a) = p.poll(&mut host, &live) {
                    break a;
                }
            },
        };
        results.push(answer.plain());
    }
    let app = &host.0;
    let steps: Vec<String> = app.history.list().into_iter().filter(|x| x.done).map(|x| x.label).collect();
    json!({
        "results": results,
        "project": serde_json::to_value(app.project()).unwrap(),
        "app": {
            "sequence": app.sequence_id.map(|i| i.as_str()), "t": app.t, "steps": steps,
            "selection": cut_app::control::call::selection(app), "inOut": { "in": app.in_out.in_, "out": app.in_out.out },
        },
    })
}

/// Sorts what the native editor keeps without the JavaScript's order: the selection (a set) and a clip's keyframed
/// properties (a sorted map).
fn unordered(v: &mut Json) {
    match v {
        Json::Object(o) => {
            for (k, x) in o.iter_mut() {
                if (k == "selection" || k == "keyframed") && x.is_array() {
                    let mut l: Vec<String> = x.as_array().unwrap().iter().map(|s| s.to_string()).collect();
                    l.sort();
                    *x = Json::Array(l.into_iter().map(Json::String).collect());
                } else {
                    unordered(x);
                }
            }
        }
        Json::Array(l) => l.iter_mut().for_each(unordered),
        _ => {}
    }
}

/// Runs the script on both sides and compares; `ok`: whether every call must succeed (`Some(true)`), be refused
/// (`Some(false)`), or either.
fn compare(name: &str, setup: Json, calls: Vec<(&str, Json)>, ok: Option<bool>) {
    let project = fresh();
    let calls: Vec<(String, Json)> = calls.into_iter().map(|(n, a)| (n.to_owned(), a)).collect();
    let script: Vec<Json> = calls.iter().map(|(n, a)| json!([n, a])).collect();
    let mut js = ask(&[json!(["run", { "project": project, "setup": setup, "calls": script }])]).remove(0);
    let mut rust = run_rust(&project, &setup, &calls);
    unordered(&mut js);
    unordered(&mut rust);
    let mut bad = Vec::new();
    for (i, (r, j)) in rust["results"].as_array().unwrap().iter().zip(js["results"].as_array().unwrap()).enumerate() {
        if let Some(d) = diff(r, j, "") {
            bad.push(format!("#{i} {} {}: {d}", calls[i].0, calls[i].1));
        }
    }
    if let Some(d) = diff(&rust["app"], &js["app"], "app") {
        bad.push(d);
    }
    if let Some(d) = diff(&rust["project"], &js["project"], "project") {
        bad.push(d);
    }
    assert!(bad.is_empty(), "{name}: {} differences:\n{}", bad.len(), bad.join("\n"));
    if let Some(want) = ok {
        let off: Vec<String> = rust["results"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, r)| r["ok"].as_bool() != Some(want))
            .map(|(i, r)| format!("#{i} {}: {r}", calls[i].0))
            .collect();
        assert!(
            off.is_empty(),
            "{name}: calls that did not {}:\n{}",
            if want { "succeed" } else { "refuse" },
            off.join("\n")
        );
    }
}

#[test]
fn reading_tools_answer_as_the_javascript() {
    compare(
        "reads",
        json!({}),
        vec![
            ("get_project", json!({})),
            ("get_sequence", json!({})),
            ("get_sequence", json!({ "from": 3, "to": 7, "max_clips": 2 })),
            ("get_sequence", json!({ "sequence_id": "s9" })),
            ("get_clip", json!({ "clip_id": "c5" })),
            ("get_clip", json!({ "clip_id": "c6" })),
            ("get_clip", json!({ "clip_id": "c9" })),
            ("get_clip", json!({ "clip_id": "c99" })),
            ("get_media", json!({})),
            ("get_markers", json!({})),
            ("get_captions", json!({})),
            ("get_captions", json!({ "track_id": "cc11", "from": 2.5, "max_items": 1 })),
            ("get_captions", json!({ "track_id": "cc1" })),
            ("get_transcript", json!({})),
            ("list_effects", json!({})),
            ("list_effects", json!({ "kind": "audio", "search": "eq" })),
            ("list_effects", json!({ "search": "dissolve" })),
            ("get_frame", json!({})),
            ("get_frame", json!({ "time": 99 })),
            ("get_state", json!({})),
            ("list_actions", json!({})),
            ("list_actions", json!({ "search": "marker playhead" })),
            ("run_action", json!({ "id": "nope" })),
            ("run_action", json!({ "id": "saveAs" })),
            ("run_action", json!({ "id": "speed" })),
            ("run_action", json!({ "id": "auto.silence" })),
            ("run_action", json!({ "id": "markIn" })),
            ("get_project", json!({ "x": 1 })),
            ("get_sequence", json!({ "max_clips": 0 })),
        ],
        None,
    );
}

#[test]
fn editing_tools_edit_as_the_javascript() {
    compare(
        "edits",
        json!({}),
        vec![
            ("place_clip", json!({ "media_id": "m2", "at": 10 })),
            ("place_clip", json!({ "media_id": "m3", "at": 12, "duration": 1.5, "video_track": "V2" })),
            (
                "place_clip",
                json!({ "media_id": "m2", "at": 0, "mode": "insert", "source_in": 2, "source_out": 3, "audio_track": null }),
            ),
            ("move_clips", json!({ "clip_ids": ["c7"], "delta": 0.5 })),
            ("move_clips", json!({ "clip_ids": ["c9"], "to": 14, "track_delta": -1 })),
            ("trim_clip", json!({ "clip_id": "c5", "edge": "end", "delta": -0.5 })),
            ("trim_clip", json!({ "clip_id": "c5", "edge": "start", "to": 1.2, "mode": "ripple" })),
            ("trim_clip", json!({ "clip_id": "c5", "mode": "slip", "delta": 0.3 })),
            ("trim_clip", json!({ "clip_id": "c7", "edge": "end", "delta": 0.4, "mode": "stretch" })),
            ("razor", json!({ "at": 5 })),
            ("razor", json!({ "at": 6.5, "track_ids": ["V1"] })),
            ("delete_range", json!({ "from": 0, "to": 0.5 })),
            ("delete_range", json!({ "from": 1, "to": 1.5, "ripple": false, "track_ids": ["V1", "A1"] })),
            ("link_clips", json!({ "clip_ids": ["c5", "c6"], "action": "unlink" })),
            ("link_clips", json!({ "clip_ids": ["c5", "c6"], "action": "group" })),
            (
                "set_clip",
                json!({ "clip_id": "c5", "opacity": 50, "scale": 120, "name": "Talk", "label": "rose", "linked": false }),
            ),
            ("set_clip", json!({ "clip_id": "c6", "volume": -6, "pan": 20, "fade_in": 0.5, "role": "dialogue" })),
            ("set_speed", json!({ "clip_id": "c5", "speed": 50 })),
            ("set_speed", json!({ "clip_id": "c5", "duration": 4, "reverse": true })),
            (
                "set_keyframes",
                json!({ "clip_id": "c9", "property": "opacity", "keyframes": [{ "time": 16.8, "value": 0 }, { "time": 17.8, "value": 100, "ease": "easeOut" }] }),
            ),
            ("add_effect", json!({ "clip_id": "c7", "type": "blur.gaussian", "params": { "blurriness": 10 } })),
            ("set_effect", json!({ "clip_id": "c7", "effect_id": "e1", "on": false })),
            (
                "set_color",
                json!({ "clip_id": "c7", "exposure": 0.5, "curves": { "master": [0, 0, 0.5, 0.6, 1, 1] }, "hsl": { "hue": 120, "show_mask": true } }),
            ),
            ("add_mask", json!({ "clip_id": "c7", "shape": "ellipse", "x": 0.4, "feather": 20 })),
            (
                "set_mask",
                json!({ "clip_id": "c7", "mask_id": "m1", "shape": "rectangle", "width": 0.3, "inverted": true }),
            ),
            ("get_clip", json!({ "clip_id": "c7" })),
            ("remove_mask", json!({ "clip_id": "c7", "mask_id": "m1" })),
            ("remove_effect", json!({ "clip_id": "c7", "effect_id": "e1" })),
            (
                "add_text",
                json!({ "text": "Title\nline two", "at": 1, "duration": 2, "color": "#ff0000", "box": "#00000099", "stroke": { "color": "#000000" } }),
            ),
            ("set_text", json!({ "clip_id": "c9", "text": "Bye", "size": 80, "animation": "fade" })),
            ("set_text", json!({ "clip_id": "c9", "add_layer": true, "text": "Second" })),
            ("add_transition", json!({ "track": "V1", "at": 5 })),
            ("set_transition", json!({ "transition_id": "t31", "duration": 0.5, "align": "start" })),
            ("add_captions", json!({ "track_id": "cc11", "items": [{ "start": 5, "end": 6, "text": "More" }] })),
            (
                "add_captions",
                json!({ "name": "English", "lang": "en", "items": [{ "start": 0, "end": 1, "text": "Hello" }] }),
            ),
            ("set_caption", json!({ "track_id": "cc11", "caption_id": "cap12", "text": "Changed" })),
            ("remove_captions", json!({ "track_id": "cc11", "caption_ids": ["cap13"] })),
            (
                "set_caption_track",
                json!({ "track_id": "cc11", "name": "KO", "style": { "size": 40, "color": "#ffff00", "background": null, "speakers": "both" } }),
            ),
            ("add_marker", json!({ "at": 2, "name": "Here", "color": "red", "note": "n", "duration": 1 })),
            ("add_marker", json!({ "at": 0.5, "clip_id": "c6", "kind": "beat" })),
            ("set_marker", json!({ "marker_id": "mk10", "at": 3.5, "name": "Start" })),
            ("get_markers", json!({})),
            ("remove_markers", json!({ "kind": "comment" })),
            ("set_track", json!({ "track_id": "A1", "volume": -3, "mute": true, "name": "Voice" })),
            ("set_sequence", json!({ "name": "Main", "master_gain": -2, "background": "#101010" })),
            ("add_track", json!({ "kind": "audio", "name": "Music" })),
            ("add_color_matte", json!({ "at": 2, "duration": 1, "color": "#336699" })),
            (
                "add_graphic",
                json!({ "at": 3, "layers": [{ "kind": "rect", "size": [200, 100], "fill": "#ff0000" }, { "kind": "text", "text": "{value}", "value": 10 }] }),
            ),
            (
                "set_graphic",
                json!({ "clip_id": "c38", "update": [{ "id": "g1", "radius": 8 }], "add": [{ "kind": "ellipse", "after": "g1" }] }),
            ),
            ("set_project_settings", json!({ "still_duration": 3, "speech_terms": ["Nano  Studio", "Cut", "Cut"] })),
            ("project_items", json!({ "action": "new_bin", "name": "Footage" })),
            ("project_items", json!({ "action": "move", "item_ids": ["m2"], "bin_id": "b39" })),
            ("project_items", json!({ "action": "rename", "item_id": "m3", "name": "Logo" })),
            ("add_sequence", json!({ "name": "Second", "preset": "square" })),
            ("add_sequence", json!({ "duplicate_of": "s1", "active": false })),
            ("essential_sound", json!({ "sequence_id": "s1", "clip_ids": ["c6"], "action": "clarity" })),
            ("speakers", json!({})),
            ("nest_clips", json!({ "sequence_id": "s1", "clip_ids": ["c7"], "name": "Logo nest" })),
            ("select_clips", json!({ "sequence_id": "s1", "clip_ids": ["c5"] })),
            ("seek", json!({ "sequence_id": "s1", "time": 2.01 })),
            ("undo", json!({})),
            ("redo", json!({})),
            ("get_state", json!({})),
            ("get_sequence", json!({})),
            ("get_project", json!({})),
        ],
        Some(true),
    );
}

#[test]
fn refusals_change_nothing_as_in_the_javascript() {
    compare(
        "refusals",
        json!({ "undoFloor": 0 }),
        vec![
            ("place_clip", json!({ "at": 1 })),
            ("place_clip", json!({ "media_id": "C:/x.mp4", "at": 1 })),
            ("place_clip", json!({ "media_id": "m9", "at": 1 })),
            ("place_clip", json!({ "media_id": "m2", "at": 99 })),
            ("place_clip", json!({ "media_id": "m2", "at": 1, "audio_track": "A2" })),
            ("place_clip", json!({ "media_id": "m2", "at": 1, "video_track": "A1" })),
            ("place_clip", json!({ "media_id": "m2", "at": 1, "source_in": 30 })),
            ("place_clip", json!({ "nest_sequence_id": "s1", "at": 1 })),
            ("move_clips", json!({ "clip_ids": ["c8"], "delta": 1 })),
            ("move_clips", json!({ "clip_ids": ["c5"], "to": 1, "delta": 1 })),
            ("move_clips", json!({ "clip_ids": ["c5"], "delta": -5 })),
            ("move_clips", json!({ "clip_ids": ["c5"] })),
            ("trim_clip", json!({ "clip_id": "c5" })),
            ("trim_clip", json!({ "clip_id": "c5", "edge": "end" })),
            ("trim_clip", json!({ "clip_id": "c5", "mode": "slip", "edge": "end", "delta": 1 })),
            ("razor", json!({ "at": 10 })),
            ("razor", json!({ "at": 1, "track_ids": ["A2"] })),
            ("delete_clips", json!({ "clip_ids": ["c99"] })),
            ("delete_range", json!({ "from": 1, "to": 1.01 })),
            ("link_clips", json!({ "clip_ids": ["c5"], "action": "link" })),
            ("set_clip", json!({ "clip_id": "c5" })),
            ("set_clip", json!({ "clip_id": "c5", "volume": 3 })),
            ("set_clip", json!({ "clip_id": "c6", "opacity": 3 })),
            ("set_clip", json!({ "clip_id": "c5", "position": [1] })),
            ("set_clip", json!({ "clip_id": "c5", "scale": [1, 20000] })),
            ("set_clip", json!({ "clip_id": "c5", "color": "#ffffff" })),
            ("set_clip", json!({ "clip_id": "c9", "color": "#ffffff" })),
            ("set_speed", json!({ "clip_id": "c5" })),
            ("set_speed", json!({ "clip_id": "c7", "speed": 50 })),
            ("set_speed", json!({ "clip_id": "c5", "speed": 50, "duration": 2 })),
            ("set_time_remap", json!({ "clip_id": "c6", "off": true })),
            ("set_time_remap", json!({ "clip_id": "c5" })),
            ("set_time_remap", json!({ "clip_id": "c5", "segments": [{ "speed": 50, "until": 3 }, { "hold": 1 }] })),
            (
                "set_time_remap",
                json!({ "clip_id": "c5", "segments": [{ "speed": 50, "until": 30 }, { "speed": 100 }] }),
            ),
            ("set_time_remap", json!({ "clip_id": "c5", "segments": [{ "speed": 50 }, { "speed": 100, "until": 3 }] })),
            ("set_keyframes", json!({ "clip_id": "c5", "property": "volume", "keyframes": [] })),
            (
                "set_keyframes",
                json!({ "clip_id": "c5", "property": "opacity", "keyframes": [{ "time": 30, "value": 1 }] }),
            ),
            (
                "set_keyframes",
                json!({ "clip_id": "c5", "property": "opacity", "keyframes": [{ "time": 1, "value": 200 }] }),
            ),
            (
                "set_keyframes",
                json!({ "clip_id": "c9", "property": "layers.l1.color", "keyframes": [{ "time": 6, "value": 1 }] }),
            ),
            ("add_effect", json!({ "clip_id": "c5", "type": "nope" })),
            ("add_effect", json!({ "clip_id": "c5", "type": "dissolve" })),
            ("add_effect", json!({ "clip_id": "c6", "type": "blur.gaussian" })),
            ("add_effect", json!({ "clip_id": "c5", "type": "blur.gaussian", "params": { "radius": 3 } })),
            ("add_effect", json!({ "clip_id": "c5", "type": "blur.gaussian", "params": { "blurriness": -3 } })),
            ("set_effect", json!({ "clip_id": "c5", "effect_id": "e9" })),
            ("remove_effect", json!({ "clip_id": "c5", "effect_id": "e9" })),
            ("set_color", json!({ "clip_id": "c5" })),
            ("set_color", json!({ "clip_id": "c5", "lut": "lut-x" })),
            ("set_color", json!({ "clip_id": "c6", "exposure": 1 })),
            ("add_transition", json!({ "track": "V1", "at": 3 })),
            ("add_transition", json!({ "track": "A1", "at": 10, "type": "dissolve" })),
            ("add_transition", json!({ "track": "V1", "at": 10, "type": "nope" })),
            ("remove_transition", json!({ "transition_id": "t9" })),
            ("add_text", json!({ "text": "  ", "at": 1 })),
            ("add_text", json!({ "text": "a", "at": 1, "color": "red" })),
            ("set_text", json!({ "clip_id": "c5", "text": "x" })),
            ("set_text", json!({ "clip_id": "c9" })),
            ("set_text", json!({ "clip_id": "c9", "remove_layer": true, "layer_id": "l1" })),
            ("add_captions", json!({ "items": [{ "start": 1, "end": 1, "text": "x" }] })),
            ("add_captions", json!({ "track_id": "cc9", "items": [{ "start": 1, "end": 2, "text": "x" }] })),
            ("set_caption", json!({ "track_id": "cc11", "caption_id": "cap99" })),
            ("set_caption", json!({ "track_id": "cc11", "caption_id": "cap12" })),
            ("remove_captions", json!({ "track_id": "cc11" })),
            ("add_marker", json!({ "at": 15, "clip_id": "c7" })),
            ("set_marker", json!({ "marker_id": "mk99", "name": "x" })),
            ("set_marker", json!({ "marker_id": "mk10" })),
            ("remove_markers", json!({})),
            ("remove_markers", json!({ "kind": "beat" })),
            ("add_mask", json!({ "clip_id": "c6", "shape": "ellipse" })),
            ("add_mask", json!({ "clip_id": "c5", "shape": "ellipse", "effect_id": "e9" })),
            ("set_mask", json!({ "clip_id": "c5", "mask_id": "m1", "x": 0.5 })),
            ("nest_clips", json!({ "clip_ids": ["c8"] })),
            ("set_track", json!({ "track_id": "A2", "mute": true })),
            ("set_track", json!({ "track_id": "V1", "mute": true })),
            ("set_track", json!({ "track_id": "A1", "visible": true })),
            ("set_track", json!({ "track_id": "V1" })),
            ("set_sequence", json!({ "width": 641 })),
            ("set_sequence", json!({ "background": "black" })),
            ("set_sequence", json!({})),
            ("remove_silence", json!({ "longer_than": 1 })),
            ("select_clips", json!({ "clip_ids": ["c99"] })),
            ("seek", json!({ "time": 50 })),
            ("undo", json!({})),
            ("redo", json!({})),
            ("export_sequence", json!({ "preset": "youtube-1080p", "file_name": "a/b" })),
            ("export_sequence", json!({ "preset": "audio-m4a", "width": 640 })),
            ("export_sequence", json!({ "preset": "youtube-1080p" })),
            ("import_media", json!({ "paths": ["\\\\server\\share\\a.mp4"] })),
            ("import_media", json!({ "paths": ["C:\\a\\..\\b.mp4"] })),
            ("import_media", json!({ "paths": ["a.mp4"] })),
            ("import_media", json!({ "paths": ["C:\\a.mp4"], "folder": true })),
            ("import_media", json!({ "paths": ["C:\\a.mp4"] })),
            ("remove_media", json!({})),
            ("remove_media", json!({ "media_ids": ["m2"] })),
            ("remove_media", json!({ "unused": true })),
            ("project_items", json!({ "action": "remove_bin" })),
            ("project_items", json!({ "action": "rename", "item_id": "x9", "name": "y" })),
            ("project_items", json!({ "action": "new_bin", "item_id": "m2" })),
            ("add_sequence", json!({ "duplicate_of": "s1", "fps": "25" })),
            ("add_sequence", json!({ "width": 641 })),
            ("remove_sequence", json!({ "sequence_id": "s1" })),
            ("add_track", json!({ "kind": "video", "index": 9 })),
            ("remove_track", json!({ "track_id": "A2" })),
            ("set_transition", json!({ "transition_id": "t9" })),
            ("set_caption_track", json!({ "track_id": "cc9" })),
            ("set_caption_track", json!({ "track_id": "cc11", "style": { "color": "red" } })),
            ("add_color_matte", json!({ "at": 1, "color": "blue" })),
            ("set_project_settings", json!({})),
            ("save_project", json!({})),
            ("export_frame", json!({ "file_name": "?" })),
            ("export_captions", json!({ "track_id": "cc9" })),
            ("export_queue", json!({})),
            ("proxies", json!({})),
            ("create_shorts", json!({ "ranges": [{ "from": 1, "to": 3 }, { "from": 2, "to": 4 }] })),
            ("automation", json!({ "action": "detect_scenes", "every": "bar" })),
            ("automation", json!({ "action": "detect_scenes", "from": 1 })),
            ("automation", json!({ "action": "detect_scenes", "threshold": 2 })),
            ("automation", json!({ "action": "detect_scenes", "clip_ids": ["c6"] })),
            ("automation", json!({ "action": "auto_color", "clip_ids": ["c5"], "time": 12 })),
            ("automation", json!({ "action": "match_loudness", "target": -14 })),
            ("essential_sound", json!({ "clip_ids": ["c7"], "action": "clarity" })),
            ("speakers", json!({ "action": "rename", "speaker_id": "s1", "name": "A" })),
            ("speakers", json!({ "name": "A" })),
            ("add_graphic", json!({ "at": 1, "layers": [{ "kind": "rect", "size": "big" }] })),
            ("set_graphic", json!({ "clip_id": "c9", "layers": [{ "kind": "rect" }] })),
            ("set_graphic", json!({ "clip_id": "c5" })),
            ("run_action", json!({ "id": "markIn", "time": 99 })),
            ("nope_tool", json!({})),
        ],
        Some(false),
    );
}

#[test]
fn shorts_and_remapping_as_in_the_javascript() {
    compare(
        "shorts",
        json!({}),
        vec![
            (
                "set_time_remap",
                json!({ "clip_id": "c5", "segments": [{ "speed": 50, "until": 3, "ramp": 0.5 }, { "speed": 200, "until": 6 }, { "hold": 1 }, { "speed": 100 }] }),
            ),
            ("get_clip", json!({ "clip_id": "c5" })),
            (
                "set_time_remap",
                json!({ "clip_id": "c5", "segments": [{ "speed": 100, "until": 4 }, { "reverse": 1 }, { "speed": 100 }] }),
            ),
            ("set_time_remap", json!({ "clip_id": "c5", "off": true })),
            ("delete_clips", json!({ "clip_ids": ["c7"], "ripple": true })),
            ("remove_track", json!({ "track_id": "V3" })),
            ("create_shorts", json!({ "ranges": [{ "from": 4, "to": 6 }, { "from": 0.5, "to": 2 }], "name": "Short" })),
            ("get_sequence", json!({})),
            ("remove_sequence", json!({ "sequence_id": "s1" })),
            ("get_project", json!({})),
        ],
        Some(true),
    );
}
