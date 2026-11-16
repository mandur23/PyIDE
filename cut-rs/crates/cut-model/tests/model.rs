//! The project document and the model's queries against `model.js`: projects the JavaScript editor builds load,
//! save and load back there as the same project; migrate, validate and every query give the JavaScript's answers.

mod common;

use common::{ask, diff, projects, same};
use cut_model::canon::canonical;
use cut_model::{Project, validate};
use serde_json::{Value, json};

#[test]
fn projects_round_trip_through_the_javascript() {
    let texts = projects();
    assert!(texts.len() > 25, "projects of every kind and states of a random run");
    let loads = ask(&texts.iter().map(|t| json!(["load", t])).collect::<Vec<_>>());
    let mut saved = Vec::new();
    let mut compared = 0;
    for (text, js) in texts.iter().zip(&loads) {
        match (Project::load(text), js.get("$code")) {
            (Err(e), Some(code)) => {
                assert_eq!(e.code(), code, "the same refusal for {}", &text[..text.len().min(200)]);
                saved.push(None);
            }
            (Err(e), None) => {
                panic!("rust refuses ({e:?}) what the javascript loads: {}", &text[..text.len().min(300)])
            }
            (Ok(_), Some(code)) => {
                panic!("rust loads what the javascript refuses ({code}): {}", &text[..text.len().min(300)])
            }
            (Ok(p), None) => {
                let ours = canonical(&p);
                let theirs = js.as_str().expect("canonical text");
                if ours != theirs {
                    let d = diff(&serde_json::from_str(&ours).unwrap(), &serde_json::from_str(theirs).unwrap(), "");
                    panic!("migrate differs: {d:?}");
                }
                compared += 1;
                saved.push(Some(p.to_text()));
            }
        }
    }
    // the text Rust writes, read by the JavaScript, is the same project
    let back = ask(&saved.iter().flatten().map(|t| json!(["load", t])).collect::<Vec<_>>());
    let firsts: Vec<&Value> = loads.iter().zip(&saved).filter(|(_, s)| s.is_some()).map(|(l, _)| l).collect();
    for (a, b) in back.iter().zip(firsts) {
        assert_eq!(a, b, "the JavaScript reads Rust's file as the project it wrote");
    }
    assert!(compared > 20, "{compared} projects compared");
}

#[test]
fn unknown_fields_of_a_newer_version_are_kept() {
    let texts: Vec<String> =
        ask(&[json!(["projects"])])[0].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
    let future = texts.iter().find(|t| t.contains("someNewThing")).expect("the scenario's newer project");
    let p = Project::load(future).expect("loads");
    let out = p.to_text();
    for field in [
        "someNewThing",
        "newSetting",
        "hdr",
        "depth",
        "colorSpace",
        "targeted",
        "stabilize",
        "\"layer\"",
        "preset",
        "icon",
        "curve",
        "burnIn",
        "italic",
    ] {
        assert!(out.contains(field), "{field} is written back");
    }
    assert_eq!(p.extra["someNewThing"], json!({ "a": [1, 2, 3] }));
}

#[test]
fn validate_finds_what_the_javascript_finds() {
    let texts: Vec<String> =
        ask(&[json!(["broken"])])[0].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
    let theirs = ask(&texts.iter().map(|t| json!(["validate", t])).collect::<Vec<_>>());
    let mut typed = 0;
    for (text, js) in texts.iter().zip(&theirs) {
        let mut js: Vec<String> = serde_json::from_value(js.clone()).expect("a list of errors");
        assert!(!js.is_empty(), "each case is broken");
        match serde_json::from_str::<Project>(text) {
            // a value of the wrong JSON type: the file is refused by the types instead
            Err(_) => {}
            Ok(p) => {
                let mut ours = validate(&p).errors;
                ours.sort();
                js.sort();
                assert_eq!(ours, js, "validate of {}", &text[..200]);
                typed += 1;
            }
        }
    }
    assert!(typed >= 20, "{typed} of {} broken projects compared error by error", texts.len());
}

fn rust_queries(p: &Project, times: &[i64]) -> Value {
    let mut seqs = Vec::new();
    for seq in &p.sequences {
        let mut nested: Vec<&str> = seq.nested_ids().into_iter().map(|i| i.as_str()).collect();
        nested.sort();
        let ids = |v: Vec<&cut_model::Clip>| v.iter().map(|c| c.id.as_str()).collect::<Vec<_>>();
        let at: Vec<Value> = times
            .iter()
            .map(|&t| json!([ids(seq.clips_at(t, None)), ids(seq.clips_at(t, Some(cut_model::TrackKind::Audio)))]))
            .collect();
        let mut clips: Vec<(String, Value)> = seq
            .clips()
            .map(|c| {
                let d = c.duration() as f64;
                let s = c.start as f64;
                let ts = [s, s + d / 2.0, s + d - 1.0, s - 5.0, s + d + 5.0];
                let room = p.source_room(c);
                let mut linked: Vec<&str> = seq.linked_clips(c).iter().map(|x| x.id.as_str()).collect();
                linked.sort();
                let xs = [c.in_, c.out, (c.in_ + c.out) / 2.0, c.in_ - 10.0, c.out + 10.0];
                (
                    c.id.as_str().to_owned(),
                    json!({
                        "id": c.id, "duration": c.duration(), "end": c.end(), "still": p.is_still(c),
                        "length": p.source_length(c),
                        "source": ts.map(|t| c.source_time(t)),
                        "timeline": xs.map(|x| c.timeline_time(x)),
                        "span": [c.source_span(s, s + d), c.source_span(s + d / 3.0, s + d / 2.0)],
                        "room": [room.head, room.tail], "remap": c.remap_of(), "linked": linked,
                    }),
                )
            })
            .collect();
        clips.sort_by(|a, b| a.0.cmp(&b.0));
        let tracks: Vec<i64> = seq.tracks.iter().map(|t| seq.track_index(t.id).map_or(-1, |i| i as i64)).collect();
        seqs.push(json!({
            "id": seq.id, "duration": seq.duration(), "nested": nested, "at": at,
            "clips": clips.into_iter().map(|c| c.1).collect::<Vec<_>>(), "tracks": tracks,
        }));
    }
    let mut nest = Vec::new();
    for x in &p.sequences {
        for y in &p.sequences {
            let k = p.nest_kinds(y.id);
            nest.push(json!([p.reaches(x.id, y.id), p.nest_loop(x.id, y.id), { "video": k.video, "audio": k.audio }]));
        }
    }
    let uses: Vec<Value> = p
        .sequences
        .iter()
        .map(|x| {
            let u: Vec<Value> = p
                .nest_uses(x.id)
                .into_iter()
                .map(|(s, clips)| {
                    let mut c: Vec<&str> = clips.iter().map(|i| i.as_str()).collect();
                    c.sort();
                    json!([s, c])
                })
                .collect();
            json!(u)
        })
        .collect();
    json!({ "seqs": seqs, "nest": nest, "uses": uses })
}

#[test]
fn queries_give_the_javascript_answers() {
    let f = cut_time::Fps::new(30, 1).frame_ticks().unwrap();
    let times = [0, f * 15, f * 30 + 7, f * 100, f * 135, f * 250, f * 700 + 3, 30 * cut_time::TICKS, -f];
    let mut compared = 0;
    let texts = projects();
    let loaded: Vec<(String, Project)> =
        texts.into_iter().filter_map(|t| Project::load(&t).ok().map(|p| (p.to_text(), p))).collect();
    let theirs = ask(&loaded.iter().map(|(t, _)| json!(["queries", t, times])).collect::<Vec<_>>());
    for ((_, p), js) in loaded.iter().zip(&theirs) {
        let ours = rust_queries(p, &times);
        if !same(&ours, js) {
            panic!("queries differ: {:?}", diff(&ours, js, ""));
        }
        compared += p.sequences.iter().map(|s| s.clip_count()).sum::<usize>();
    }
    assert!(compared > 500, "{compared} clips asked every question");
}
