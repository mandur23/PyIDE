//! Writes a project to look at and to measure: `cargo run -p cut-app --example demo_project -- <out.ncut> [clips]`
//! (without a clip count: [`showcase`], with one: [`build`]).
//!
//! The media are cut-decode's generated test clips (720p and the 1080p bench file, each frame showing its number as
//! a row of blocks), a generated AAC tone, and the repository's still and WAV fixtures, imported through the app's own
//! importer and placed with the model's commands, with a cross dissolve, a Black & White effect and a Lumetri Color
//! with an ellipse mask on the 1080p clip, opacity and volume keyframes, a time-remapped 720p clip, a text clip, a
//! shape graphic, a caption, sequence and clip markers, and tall V1 and A1 rows so the keyframe lines show. With a
//! clip count it fills two video and two audio tracks with that many clips (copies of
//! the placed ones, back to back) for the timeline's frame-time measurement.

#![allow(dead_code)]

#[path = "../tests/media/mod.rs"]
pub mod media;

use std::path::PathBuf;

use cut_app::{cmd, doc, import};
use cut_model::Id;
use cut_model::commands::build as B;
use serde_json::{Value as Json, json};

fn main() {
    let mut args = std::env::args().skip(1);
    let out = PathBuf::from(args.next().expect("an output path"));
    let many: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let text = if many > 0 { build(many) } else { showcase() };
    std::fs::write(&out, text).expect("the project is written");
    println!("{}", out.display());
}

/// Where things are in the demo project (seconds), for the tests that look at its pictures; the parts named after
/// "remapped", Lumetri, mask, keyframes, shapes and named markers are only in [`showcase`].
pub mod at {
    /// The 720p clip on V1 from 0 to 3 (remapped: normal speed to 1 s, then half speed), the 1080p clip (Black &
    /// White, Lumetri Color, an ellipse mask, opacity keyframes) from 3 to 13, a cross dissolve of one second around
    /// 3, the still from 13 to 18; a text clip on V2 from 4 to 8, a shape graphic on V2 from 9 to 12; a caption from
    /// 1 to 2.5; markers at 3 (sequence), 6 and 10 (named), and on the 1080p clip at 5.
    pub const CLIP_720: f64 = 0.0;
    pub const CLIP_1080: f64 = 3.0;
    pub const STILL: f64 = 13.0;
    pub const TEXT: (f64, f64) = (4.0, 8.0);
    pub const SHAPES: (f64, f64) = (9.0, 12.0);
    pub const CAPTION: (f64, f64) = (1.0, 2.5);
}

fn seconds(s: f64) -> i64 {
    (s * cut_time::TICKS as f64).round() as i64
}

/// What the later screens show: Lumetri, a mask and keyframes on the 1080p clip, a remapped 720p clip, a shape
/// graphic, named markers, volume keyframes and tall rows.
fn extras(h: &mut cut_model::History, seq: Id, b_clip: Id) {
    let s = seq.as_str();
    let b = b_clip.as_str();
    let p = h.project().sequence(seq).expect("the sequence");
    let (w, hh) = (p.w as f64, p.h as f64);
    let v720 = p.clips().find(|c| c.track.as_str() == "V1" && c.start == 0).expect("the 720p clip").id;
    let a1 = p.clips().find(|c| c.track.as_str() == "A1").expect("the tone").id;
    let cmds = [
        B::add_effect(s, b, "color.basic", None, json!({ "temperature": 30, "saturation": 140, "contrast": 20 })),
        B::add_mask(
            s,
            b,
            json!({ "path": cut_model::masks::ellipse(w, hh, cut_model::masks::Place::default()),
            "feather": 40 }),
            None,
        ),
        B::set_keyframes(
            s,
            b,
            "opacity",
            Some(json!([{ "t": 0, "v": 100 }, { "t": seconds(4.0), "v": 40 },
            { "t": seconds(8.0), "v": 100 }])),
        ),
        B::set_keyframes(
            s,
            a1.as_str(),
            "volume",
            Some(json!([{ "t": 0, "v": -20 }, { "t": seconds(2.0), "v": 0 },
            { "t": seconds(6.0), "v": -6 }])),
        ),
        B::set_remap(
            s,
            v720.as_str(),
            Some(json!({ "at": 0, "speeds": [1, 0.5], "keys": [{ "t": seconds(1.0),
            "ramp": 0 }], "duration": seconds(3.0) })),
        ),
        B::add_generated(
            s,
            json!({ "source": { "generator": "graphic", "layers": [
            { "id": "bg", "kind": "rect", "size": [900, 240], "radius": 24, "fill": "#102040cc", "position": [0, 300] },
            { "id": "dot", "kind": "ellipse", "size": [160, 160], "fill": "#ff8800", "position": [-520, -260] },
            { "id": "t", "kind": "text", "text": "그래픽 Graphic", "fontSize": 80, "position": [0, 300] } ] },
            "at": seconds(at::SHAPES.0), "duration": seconds(at::SHAPES.1 - at::SHAPES.0), "track": "V2",
            "name": "Shapes" }),
        ),
        B::add_marker(
            s,
            json!({ "t": seconds(6.0), "name": "Chorus", "color": "red", "kind": "chapter",
            "note": "the loud part" }),
            json!({}),
        ),
        B::add_marker(
            s,
            json!({ "t": seconds(10.0), "name": "Check the sound", "color": "yellow",
            "duration": seconds(1.5) }),
            json!({}),
        ),
        B::add_marker(s, json!({ "t": seconds(5.0), "name": "Clip note" }), json!({ "clipId": b })),
        B::set_track(s, "V1", json!({ "height": 90 })),
        B::set_track(s, "A1", json!({ "height": 80 })),
    ];
    for c in cmds {
        h.apply(&c).unwrap_or_else(|e| panic!("{c}: {e:?}"));
    }
}

/// The project's text with `many` extra clips (0: just the hand-placed ones), without [`extras`]: the tests read
/// frame numbers off its pictures.
pub fn build(many: usize) -> String {
    text(many, false)
}

/// The project to look at: the hand-placed clips and [`extras`].
pub fn showcase() -> String {
    text(0, true)
}

fn text(many: usize, more: bool) -> String {
    let mut h = doc::fresh_history();
    let seq = h.project().sequences[0].id;
    let files = [
        media::h264_720p(),
        media::h264_1080p(),
        media::fixture("images/sample.png"),
        media::tone_aac(),
        media::fixture("audio/tone.wav"),
    ];
    let mut entries = Vec::new();
    for f in &files {
        let p = import::probe_file(f);
        entries.push(p.result.unwrap_or_else(|e| panic!("{}: {e:?}", f.display())));
    }
    let r = h.apply(&cmd::import_media(entries, None)).expect("import");
    let ids: Vec<Id> = r["ids"].as_array().unwrap().iter().map(|v| Id::new(v.as_str().unwrap())).collect();
    let (v720, v1080, still, aac, wav) = (ids[0], ids[1], ids[2], ids[3], ids[4]);
    let (v1, v2, a1, a2) = (Id::new("V1"), Id::new("V2"), Id::new("A1"), Id::new("A2"));
    h.apply(&cmd::place(seq, v720, Some(v1), None, seconds(at::CLIP_720), "overwrite")).expect("720p");
    let b = h.apply(&cmd::place(seq, v1080, Some(v1), None, seconds(at::CLIP_1080), "overwrite")).expect("1080p");
    let b_clip = b["ids"].as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).map(Id::new).expect("a clip");
    h.apply(&cmd::place(seq, still, Some(v1), None, seconds(at::STILL), "overwrite")).expect("still");
    h.apply(&json!({ "type": "addTransition", "seqId": seq.as_str(), "opts": {
        "track": "V1", "at": seconds(at::CLIP_1080), "type": "dissolve", "duration": seconds(1.0), "align": "center",
    } }))
    .expect("transition");
    h.apply(&json!({ "type": "addEffect", "seqId": seq.as_str(), "clipId": b_clip.as_str(), "effectType": "color.bw",
        "index": null, "params": {} }))
        .expect("effect");
    h.apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
        "source": { "generator": "text", "layers": [{ "text": "Nano Studio Cut", "size": 110 }] },
        "at": seconds(at::TEXT.0), "duration": seconds(at::TEXT.1 - at::TEXT.0), "track": v2.as_str(), "name": "Title",
    } }))
    .expect("text");
    h.apply(&json!({ "type": "addCaptionTrack", "seqId": seq.as_str(), "opts": {
        "name": "Captions", "lang": "en",
        "items": [{ "start": seconds(at::CAPTION.0), "end": seconds(at::CAPTION.1), "text": "Captions are burned in" }],
    } }))
    .expect("captions");
    h.apply(&cmd::place(seq, aac, None, Some(a1), 0, "overwrite")).expect("aac");
    h.apply(&cmd::place(seq, wav, None, Some(a2), seconds(2.0), "overwrite")).expect("wav");
    h.apply(&cmd::add_marker(seq, seconds(at::CLIP_1080), None)).expect("marker");
    if more {
        extras(&mut h, seq, b_clip);
    }
    h.apply(&cmd::add_bin("Footage", None)).expect("bin");
    let mut json: Json = serde_json::from_str(&h.serialize()).unwrap();
    if many > 0 {
        let clips = json["sequences"][0]["clips"].as_array().unwrap().clone();
        let templates: Vec<Json> =
            clips.iter().filter(|c| c["track"] == "V1" || c["track"] == "A1").take(2).cloned().collect();
        let mut list = Vec::with_capacity(many);
        let len = templates[0]["out"].as_f64().unwrap() as i64 - templates[0]["in"].as_f64().unwrap() as i64;
        let mut next = json["nextId"].as_i64().unwrap();
        for i in 0..many {
            let tpl = &templates[i % 2];
            let row = i / 2;
            let track = match (i % 2, row % 2) {
                (0, 0) => "V1",
                (0, _) => "V2",
                (_, 0) => "A1",
                _ => "A2",
            };
            let mut c = tpl.clone();
            c["id"] = json!(format!("c{next}"));
            next += 1;
            c["track"] = json!(track);
            c["start"] = json!((row / 2) as i64 * len);
            c["link"] = Json::Null;
            c["name"] = json!(format!("clip {row}"));
            list.push(c);
        }
        json["sequences"][0]["clips"] = Json::Array(list);
        json["sequences"][0]["transitions"] = json!([]);
        json["nextId"] = json!(next);
    }
    let text = json.to_string();
    cut_model::Project::load(&text).expect("the demo project is valid");
    text
}
