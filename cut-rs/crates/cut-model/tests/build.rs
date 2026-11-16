//! Every command builder makes a command `History::apply` runs, on a project the scenario builds with the editor's
//! own commands, and together they make every command type there is.

mod common;

use std::collections::BTreeSet;

use common::projects;
use cut_model::commands::{LABELS, build as b};
use cut_model::{History, Project, TrackKind};
use serde_json::{Value, json};

const F: i64 = 254016000000 / 30;

fn first_on(h: &History, seq: &str, kind: TrackKind) -> String {
    let s = h.project().sequences.iter().find(|s| s.id.as_str() == seq).unwrap();
    s.clips()
        .find(|c| s.track(c.track).is_some_and(|t| t.kind == kind) && c.media_id().is_some() && c.remap.is_none())
        .map(|c| c.id.as_str().to_owned())
        .expect("a clip of that kind")
}

#[test]
fn every_builder_makes_a_command_apply_runs() {
    let text = projects().remove(2);
    let mut h = History::new(Project::load(&text).expect("loads"), usize::MAX).expect("valid");
    let s = h.project().sequences[0].id.as_str().to_owned();
    let s = s.as_str();
    let media: Vec<String> = h.project().media.iter().map(|m| m.id.as_str().to_owned()).collect();
    let mut kinds = BTreeSet::new();
    let mut run = |h: &mut History, cmd: Value| -> Value {
        kinds.insert(cmd["type"].as_str().unwrap().to_owned());
        match h.apply(&cmd) {
            Ok(r) => r,
            Err(e) => panic!("{cmd}: {e:?}"),
        }
    };
    let id = |v: &Value| v["id"].as_str().unwrap().to_owned();
    let video =
        media.iter().find(|m| h.project().media(cut_model::Id::new(m)).unwrap().video.is_some()).unwrap().clone();

    let r = run(
        &mut h,
        b::import_media(
            json!([{ "path": "D:/x.mp4", "kind": "video", "duration": 30 * 254016000000i64, "video": { "w": 1920, "h": 1080, "fps": [30, 1] }, "audio": { "rate": 48000, "channels": 2 } }]),
            None,
        ),
    );
    let new_media = r["ids"][0].as_str().unwrap().to_owned();
    let bin = id(&run(&mut h, b::add_bin("bin", None)));
    run(&mut h, b::rename_item(&bin, "renamed"));
    run(&mut h, b::move_to_bin(&[&new_media], Some(&bin)));
    run(&mut h, b::relink_media(&new_media, json!({ "path": "E:/y.mp4" })));
    run(&mut h, b::set_proxy(&new_media, Some(json!({ "path": "cache:p1" }))));
    run(&mut h, b::set_settings(json!({ "fit": "fill" })));
    run(
        &mut h,
        b::set_speakers(Some(
            json!({ "list": [{ "id": "sp1", "name": "A", "color": "#ff0000" }], "turns": {}, "count": 1 }),
        )),
    );
    let s2 = id(&run(&mut h, b::add_sequence(json!({ "name": "second" }))));
    run(&mut h, b::set_sequence(&s2, json!({ "name": "other" })));
    let track = id(&run(&mut h, b::add_track(s, "video", None, json!({}))));
    run(&mut h, b::set_track(s, &track, json!({ "height": 80 })));
    run(&mut h, b::remove_track(s, &track));

    let far = 3000 * F;
    let r = run(
        &mut h,
        b::place(
            s,
            json!({ "source": { "media": video }, "in": 0, "out": 60 * F, "at": far, "video": "V1", "audio": "A1", "mode": "overwrite" }),
        ),
    );
    let (pv, pa) = (r["ids"][0].as_str().unwrap().to_owned(), r["ids"][1].as_str().unwrap().to_owned());
    run(
        &mut h,
        b::place_range(
            s,
            json!({ "source": { "media": video }, "in": 0, "out": 30 * F, "range": { "in": far + 200 * F }, "video": "V1", "audio": "A1", "mode": "overwrite" }),
        ),
    );
    run(&mut h, b::move_by(s, &[&pv], 10 * F, 0));
    run(&mut h, b::move_clips(s, &[&pv], json!({ "delta": -10 * F })));
    run(&mut h, b::trim(s, &pv, json!({ "edge": "end", "delta": -5 * F })));
    let r = run(&mut h, b::split(s, far + 20 * F, json!({ "clipIds": [pv] })));
    let right = r["ids"][0].as_str().unwrap().to_owned();
    run(&mut h, b::set_clip(s, &pv, json!({ "name": "left" }), json!({})));
    run(&mut h, b::set_keyframes(s, &pv, "opacity", Some(json!([{ "t": 0, "v": 50, "ease": "linear" }]))));
    run(&mut h, b::set_keyframes(s, &pv, "opacity", None));
    run(&mut h, b::set_remap(s, &pv, Some(json!({ "at": 0, "speeds": [1], "keys": [], "duration": 20 * F }))));
    run(&mut h, b::set_remap(s, &pv, None));
    run(&mut h, b::unlink(s, &[&pv, &pa]));
    run(&mut h, b::link(s, &[&pv, &pa]));
    run(&mut h, b::group(s, &[&pv, &right]));
    run(&mut h, b::ungroup(s, &[&pv]));
    run(&mut h, b::slip(s, &right, json!({ "delta": F })));
    run(&mut h, b::slide(s, &right, json!({ "delta": -F })));
    run(&mut h, b::stretch(s, &right, json!({ "edge": "end", "delta": F })));
    run(&mut h, b::extend_edit(s, far + 25 * F, json!({ "clipIds": [right] })));
    let e = id(&run(&mut h, b::add_effect(s, &pv, "blur.gaussian", None, json!({ "amount": 3 }))));
    run(&mut h, b::add_effect(s, &pv, "color.basic", Some(0), json!({})));
    run(&mut h, b::set_effect(s, &pv, &e, json!({ "on": false })));
    run(&mut h, b::move_effect(s, &pv, &e, 0));
    let path = json!([0.2, 0.2, 0, 0, 0, 0, 0.8, 0.2, 0, 0, 0, 0, 0.5, 0.9, 0, 0, 0, 0]);
    let m = id(&run(&mut h, b::add_mask(s, &pv, json!({ "path": path }), Some(&e))));
    run(&mut h, b::set_mask(s, &pv, &m, json!({ "feather": 20 }), Some(&e)));
    run(&mut h, b::remove_mask(s, &pv, &m, Some(&e)));
    run(&mut h, b::remove_effect(s, &pv, &e));
    let edge = h.project().sequences[0].clip(cut_model::Id::new(&pv)).unwrap().end();
    let t = id(&run(
        &mut h,
        b::add_transition(s, json!({ "track": "V1", "at": edge, "type": "dissolve", "duration": 4 * F })),
    ));
    run(&mut h, b::set_transition(s, &t, json!({ "align": "start" })));
    run(&mut h, b::remove_transition(s, &t));
    let fz = first_on(&h, s, TrackKind::Video);
    let fz_start = h.project().sequences[0].clip(cut_model::Id::new(&fz)).unwrap().start;
    run(&mut h, b::freeze_frame(s, &fz, fz_start + F, Some(10 * F)));
    let text_clip = id(&run(
        &mut h,
        b::add_generated(
            s,
            json!({ "track": "V2", "at": far + 400 * F, "duration": 30 * F, "source": { "generator": "text", "layers": [{ "text": "a" }] } }),
        ),
    ));
    let l = id(&run(&mut h, b::add_layer(s, &text_clip, json!({ "text": "b" }), None)));
    run(&mut h, b::set_layer(s, &text_clip, &l, json!({ "text": "c" })));
    run(&mut h, b::remove_layer(s, &text_clip, &l));
    run(&mut h, b::set_generator(s, &text_clip, json!({ "layers": [{ "text": "d" }] })));
    let g = id(&run(
        &mut h,
        b::add_generated(
            s,
            json!({ "track": "V2", "at": far + 500 * F, "duration": 30 * F, "source": { "generator": "graphic", "layers": [{ "kind": "rect" }] } }),
        ),
    ));
    run(&mut h, b::add_layer(s, &g, json!({ "kind": "ellipse" }), Some(0)));
    let mk = id(&run(&mut h, b::add_marker(s, json!({ "t": 10 * F, "name": "m" }), json!({}))));
    run(&mut h, b::set_marker(s, &mk, json!({ "name": "n" })));
    run(&mut h, b::remove_marker(s, &mk));
    let ct = id(&run(&mut h, b::add_caption_track(s, json!({ "lang": "ko" }))));
    run(&mut h, b::set_caption_track(s, &ct, json!({ "name": "자막" })));
    run(&mut h, b::set_captions(s, &ct, json!([{ "start": 0, "end": 30 * F, "text": "a" }])));
    let it = id(&run(&mut h, b::add_caption(s, &ct, json!({ "start": 60 * F, "end": 90 * F, "text": "b" }))));
    run(&mut h, b::set_caption(s, &ct, &it, json!({ "text": "c" })));
    run(&mut h, b::remove_caption(s, &ct, &it));
    run(&mut h, b::remove_caption_track(s, &ct));
    let lut =
        json!({ "name": "x", "title": "", "size": 2, "min": [0, 0, 0], "max": [1, 1, 1], "data": "A".repeat(128) });
    run(&mut h, b::add_lut("lut-0123456789abcdef", lut));
    let copy = h.project().sequences[0].clip(cut_model::Id::new(&right)).unwrap().clone();
    let mut copy = serde_json::to_value(copy).unwrap();
    copy["kind"] = json!("video");
    run(&mut h, b::paste(s, json!([copy]), json!({ "at": far + 800 * F })));
    run(&mut h, b::set_role(s, &[&pa], Some("dialogue"), json!({})));
    let music =
        media.iter().find(|m| h.project().media(cut_model::Id::new(m)).unwrap().video.is_none()).unwrap().clone();
    run(&mut h, b::replace_audio(s, &[&pa], &music));
    run(&mut h, b::lift(s, far + 700 * F, far + 710 * F, None));
    run(&mut h, b::extract(s, far + 700 * F, far + 710 * F, Some(&["V1"])));
    run(&mut h, b::close_gap(s, "V1", far + 100 * F));
    run(&mut h, b::ripple_to_playhead(s, far + 21 * F, "before", json!({ "trackIds": ["V1"] })));
    run(&mut h, b::nest(s, &[&right], json!({ "name": "nest" })));
    run(&mut h, b::remove(s, &[&pv], json!({ "ripple": false })));
    run(&mut h, b::batch("two", vec![b::add_bin("p", None), b::add_bin("q", None)]));
    run(&mut h, b::remove_bin(&bin));
    run(&mut h, b::remove_sequence(&s2));
    run(&mut h, b::remove_media(&[&new_media]));
    let all: BTreeSet<String> = LABELS.iter().map(|(k, _)| (*k).to_owned()).collect();
    let missing: Vec<&String> = all.difference(&kinds).collect();
    assert!(missing.is_empty(), "no builder made {missing:?}");
}
