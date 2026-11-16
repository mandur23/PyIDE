//! What Effect Controls shows for a clip and what its buttons do, without a window: the sections and rows of a video,
//! an audio, a text and a remapped clip (as `ui-controls.js` builds them), an effect's rows from the registry with
//! Lumetri's group headings, the masks' rows, and the keyframe edits (`edit.setKeyframing`, `toggleKeyframe`,
//! `jumpKeyframe`, the lane menu, Copy and Paste, Reset, Speed and Time Remapping's row) read back from the project.

use cut_app::controls::keys;
use cut_app::controls::spec::{self, Ctl, Item, Kind, Section};
use cut_app::state::App;
use cut_model::commands::build as C;
use cut_model::keyframes::{Ease, Value};
use cut_model::{History, Id};
use cut_time::{TICKS, Ticks};
use serde_json::json;

const S: Ticks = TICKS;

/// A 30 fps project: a 60 s video with sound placed at 0 for 10 s (linked V1 and A1), a text clip on V2 at 10 s.
fn app() -> (App, Id, Id, Id) {
    let mut p = cut_model::defaults::project();
    p.sequences[0].fps = cut_time::Fps { num: 30, den: 1 };
    let mut h = History::new(p, 1000).unwrap();
    let media = json!([{ "path": "C:\\m\\a.mp4", "name": "a.mp4", "kind": "video", "duration": 60 * S,
        "video": { "w": 640, "h": 360, "fps": [30, 1], "codec": "avc1" }, "audio": { "rate": 48000, "channels": 2 } }]);
    h.apply(&C::import_media(media, None)).unwrap();
    let m = h.project().media[0].id.as_str().to_owned();
    let seq = h.project().sequences[0].id.as_str().to_owned();
    let opts = json!({ "source": { "media": m }, "at": 0, "in": 0, "out": 10 * S, "video": "V1", "audio": "A1", "mode": "overwrite" });
    h.apply(&C::place(&seq, opts)).unwrap();
    h.apply(&json!({ "type": "addGenerated", "seqId": seq, "opts": {
        "source": { "generator": "text", "layers": [{ "text": "Hello\nworld" }] }, "at": 10 * S, "duration": 2 * S, "track": "V1", "name": "T",
    } }))
    .unwrap();
    let app = App::new(h, None);
    let s = app.sequence().unwrap();
    let find = |track: &str, at: Ticks| s.clips().find(|c| c.track.as_str() == track && c.start == at).unwrap().id;
    let (v, a, t) = (find("V1", 0), find("A1", 0), find("V1", 10 * S));
    (app, v, a, t)
}

fn sections(app: &App, clip: Id) -> Vec<Section> {
    let seq = app.sequence().unwrap();
    spec::sections(app.project(), seq, &app.selection, seq.clip(clip).unwrap())
}

fn names(list: &[Section]) -> Vec<String> {
    list.iter().map(|s| s.name.clone()).collect()
}

fn rows(sec: &Section) -> Vec<String> {
    sec.specs().map(spec::Spec::key).collect()
}

fn seq_id(app: &App) -> String {
    app.sequence().unwrap().id.as_str().to_owned()
}

#[test]
fn a_video_clip_shows_motion_opacity_time_remapping_crop_speed_and_its_linked_sound() {
    let (mut app, v, a, _) = app();
    app.select([v], false, false);
    let list = sections(&app, v);
    assert_eq!(names(&list), ["Motion", "Opacity", "Time Remapping", "Crop", "Speed"]);
    assert_eq!(rows(&list[0]), ["position", "scale", "rotation", "anchor"]);
    assert_eq!(rows(&list[3]), ["crop[0]", "crop[1]", "crop[2]", "crop[3]"]);
    let crop: Vec<bool> = list[3].specs().map(spec::Spec::watch).collect();
    assert_eq!(crop, [true, false, false, false], "crop is one keyframed property: one stopwatch");
    assert!(matches!(list[1].items[0], Item::MaskTools(None)), "Opacity starts with the mask buttons");
    let speed: Vec<bool> = list[4].specs().map(spec::Spec::watch).collect();
    assert_eq!(speed, [false, false], "the speed rows have no stopwatch");
    // the linked audio selected with it adds its sound sections
    app.select([v, a], false, false);
    let list = sections(&app, v);
    assert_eq!(
        names(&list),
        ["Motion", "Opacity", "Time Remapping", "Crop", "Speed", "Volume (linked audio)", "Panner"]
    );
    let audio = sections(&app, a);
    assert_eq!(names(&audio), ["Volume", "Panner", "Speed"]);
    assert_eq!(rows(&audio[0]), ["volume", "fadeIn", "fadeOut"]);
    assert!(audio[0].specs().nth(1).is_some_and(|s| s.ctl == Ctl::Duration && !s.watch()));
}

#[test]
fn a_text_clip_has_its_layers_fields_and_no_time_remapping() {
    let (mut app, _, _, t) = app();
    app.select([t], false, false);
    let list = sections(&app, t);
    assert_eq!(names(&list), ["Motion", "Opacity", "Crop", "Text: Hello"], "a still has no Time Remapping or Speed");
    let layer = &list[3];
    let fields: Vec<String> = rows(layer).iter().map(|p| p.rsplit('.').next().unwrap().to_owned()).collect();
    assert_eq!(fields, ["position", "size", "opacity", "tracking", "reveal", "fill"]);
    let seq = app.sequence().unwrap();
    let c = seq.clip(t).unwrap();
    let opacity = layer.specs().nth(2).unwrap();
    assert_eq!(
        keys::value(seq, c, opacity, 10 * S),
        Some(Value::Num(100.0)),
        "a layer's opacity shows 100 without keyframes"
    );
    // its size written as a layer field, its opacity as a keyframe at the playhead (it has no static value)
    app.set_time(11 * S);
    let size = layer.specs().nth(1).unwrap().clone();
    keys::write(&mut app, t, &size, Value::Num(150.0));
    let op = layer.specs().nth(2).unwrap().clone();
    keys::write(&mut app, t, &op, Value::Num(40.0));
    let c = app.sequence().unwrap().clip(t).unwrap().clone();
    let j = serde_json::to_value(&c).unwrap();
    assert_eq!(j["source"]["layers"][0]["size"], 150.0);
    assert_eq!(c.keyframes[&op.path].len(), 1);
    assert_eq!(c.keyframes[&op.path][0].t, S);
}

#[test]
fn an_effects_rows_come_from_the_registry_with_its_masks_and_lumetris_groups() {
    let (mut app, v, _, _) = app();
    app.select([v], false, false);
    let s = seq_id(&app);
    let key = app.exec(&C::add_effect(&s, v.as_str(), "key.chroma", None, json!({}))).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    app.exec(&C::add_effect(&s, v.as_str(), "color.basic", None, json!({}))).unwrap();
    app.exec(&C::add_mask(
        &s,
        v.as_str(),
        json!({ "path": [0.5, 0.2, 0, 0, 0, 0, 0.8, 0.5, 0, 0, 0, 0, 0.5, 0.8, 0, 0, 0, 0] }),
        Some(&key),
    ))
    .unwrap();
    let list = sections(&app, v);
    assert_eq!(&names(&list)[5..], ["Chroma Key", "Lumetri Color"]);
    let ck = &list[5];
    assert!(matches!(ck.kind, Kind::Effect { index: 0, count: 2, .. }));
    let ids: Vec<String> = rows(ck).iter().map(|p| p.rsplit('.').next().unwrap().to_owned()).collect();
    for want in ["color", "similarity", "smoothness", "spill", "output"] {
        assert!(ids.contains(&want.to_owned()), "Chroma Key shows {want} ({ids:?})");
    }
    let mask_rows: Vec<&str> = ck.specs().filter(|s| s.path.contains(".masks.")).map(|s| s.label).collect();
    assert_eq!(mask_rows, ["Mask Path", "Mask Feather", "Mask Opacity", "Mask Expansion", "Inverted", "Mask Mode"]);
    assert!(ck.items.iter().any(|i| matches!(i, Item::MaskHead { n: 1, .. })), "Mask (1)'s header");
    assert!(ck.specs().any(|s| s.path
        == format!(
            "effects.{key}.masks.{}.feather",
            app.sequence().unwrap().clip(v).unwrap().effects[0].masks.as_ref().unwrap()[0].id
        )));
    let heads: Vec<&str> =
        list[6].items.iter().filter_map(|i| if let Item::Heading(h) = i { Some(*h) } else { None }).collect();
    assert_eq!(heads, ["Basic Correction", "Creative", "Curves", "HSL Secondary"]);
    let curve = list[6].specs().find(|s| s.path.ends_with(".curveMaster")).unwrap();
    assert!(curve.ctl == Ctl::Curve && curve.watch(), "the curve row keyframes the curve");
    let lut = list[6].specs().find(|s| s.path.ends_with(".lut")).unwrap();
    assert_eq!(lut.ctl, Ctl::Lut);
}

#[test]
fn the_stopwatch_a_typed_value_and_the_keyframe_buttons() {
    let (mut app, v, _, _) = app();
    app.select([v], false, false);
    app.set_time(2 * S);
    keys::set_keyframing(&mut app, v, "opacity", true);
    let c = || app.sequence().unwrap().clip(v).unwrap().clone();
    let k = c().keyframes["opacity"].clone();
    assert!(k.len() == 1 && k[0].t == 2 * S && k[0].v == Value::Num(100.0));
    let n = app.history.position();
    let spec = sections(&app, v)[1].specs().next().unwrap().clone();
    app.set_time(6 * S);
    keys::write(&mut app, v, &spec, Value::Num(20.0));
    let c1 = app.sequence().unwrap().clip(v).unwrap().clone();
    assert_eq!(c1.keyframes["opacity"].len(), 2);
    assert_eq!(cut_model::keyframes::prop_value(&c1, "opacity", (4 * S) as f64), Some(Value::Num(60.0)));
    assert_eq!(app.history.position(), n + 1);
    app.set_time(4 * S);
    assert_eq!(keys::jump(&mut app, v, "opacity", 1), Some(6 * S));
    assert_eq!(app.t, 6 * S);
    keys::jump(&mut app, v, "opacity", -1);
    assert_eq!(app.t, 2 * S);
    // the diamond between the keyframes adds one with the value there and the ease before it
    app.set_time(4 * S);
    keys::toggle_keyframe(&mut app, v, "opacity");
    let c2 = app.sequence().unwrap().clip(v).unwrap().clone();
    assert_eq!(c2.keyframes["opacity"][1].v, Value::Num(60.0));
    keys::toggle_keyframe(&mut app, v, "opacity");
    assert_eq!(app.sequence().unwrap().clip(v).unwrap().keyframes["opacity"].len(), 2);
    // the lane menu: Hold on the first, then Copy both and Paste at 8 s
    let picked = vec![(v, "opacity".to_owned(), 2 * S), (v, "opacity".to_owned(), 6 * S)];
    keys::set_ease(&mut app, v, &picked[..1], Ease::Hold);
    let c3 = app.sequence().unwrap().clip(v).unwrap().clone();
    assert_eq!(c3.keyframes["opacity"][0].ease, Ease::Hold);
    let board = keys::copy(&c3, &picked);
    assert_eq!(board.iter().map(|k| k.t).collect::<Vec<_>>(), [0, 4 * S]);
    app.set_time(8 * S);
    keys::paste(&mut app, v, &board);
    let ts: Vec<Ticks> = app.sequence().unwrap().clip(v).unwrap().keyframes["opacity"].iter().map(|k| k.t).collect();
    assert_eq!(ts, [2 * S, 6 * S, 8 * S], "the pasted keyframe past the clip's end is left out");
    keys::delete(&mut app, v, &[(v, "opacity".to_owned(), 8 * S)]);
    // the stopwatch off keeps the value at the playhead as the static value
    app.set_time(4 * S);
    keys::set_keyframing(&mut app, v, "opacity", false);
    let c4 = app.sequence().unwrap().clip(v).unwrap().clone();
    assert!(!c4.keyframes.contains_key("opacity"));
    assert_eq!(c4.props.get("opacity"), Some(Value::Num(100.0)), "the held value at 4 s stays");
    let label = app.history.list().iter().rev().find(|e| e.done).map(|e| e.label.clone()).unwrap();
    assert_eq!(label, "Keyframes", "the stopwatch off is one step");
}

#[test]
fn speed_reverse_and_reset_change_the_clip_and_move_the_next_one() {
    let (mut app, v, _, t) = app();
    app.select([v], false, false);
    let speed = sections(&app, v).into_iter().find(|s| s.name == "Speed").unwrap();
    let specs: Vec<spec::Spec> = speed.specs().cloned().collect();
    keys::write(&mut app, v, &specs[0], Value::Num(200.0));
    let seq = app.sequence().unwrap();
    assert_eq!(seq.clip(v).unwrap().duration(), 5 * S, "200% halves the clip");
    assert_eq!(seq.clip(t).unwrap().start, 5 * S, "and pulls the next clip in");
    assert_eq!(keys::value(seq, seq.clip(v).unwrap(), &specs[0], 0), Some(Value::Num(200.0)));
    keys::write(&mut app, v, &specs[1], Value::Flag(true));
    assert!(app.sequence().unwrap().clip(v).unwrap().reverse);
    let refs: Vec<&spec::Spec> = specs.iter().collect();
    keys::reset(&mut app, v, &refs, None);
    let seq = app.sequence().unwrap();
    let c = seq.clip(v).unwrap();
    assert!(c.speed == 1.0 && !c.reverse && c.duration() == 10 * S && seq.clip(t).unwrap().start == 10 * S, "Reset");
}

#[test]
fn time_remapping_speed_row() {
    let (mut app, v, _, _) = app();
    app.select([v], false, false);
    app.set_time(0);
    keys::remap_watch(&mut app, v);
    let r = app.sequence().unwrap().clip(v).unwrap().remap.clone().unwrap();
    assert_eq!(
        r.keys.iter().map(|k| k.t).collect::<Vec<_>>(),
        [5 * S],
        "the stopwatch at the start puts a key in the middle"
    );
    assert!(names(&sections(&app, v)).iter().all(|n| n != "Speed"), "a remapped clip has no Speed section");
    app.set_time(7 * S);
    keys::remap_set_speed(&mut app, v, 50.0);
    let seq = app.sequence().unwrap();
    let c = seq.clip(v).unwrap();
    assert_eq!(c.remap.as_ref().unwrap().speeds, [1.0, 0.5], "the segment under the playhead plays at 50%");
    assert_eq!(c.duration(), 10 * S, "the slower curve stops at the next clip");
    assert!((keys::remap_speed(seq, c, 7 * S) - 0.5).abs() < 1e-9);
    keys::remap_toggle(&mut app, v);
    assert_eq!(
        app.sequence().unwrap().clip(v).unwrap().remap.as_ref().unwrap().keys.len(),
        2,
        "the diamond adds a key at the playhead"
    );
    app.set_time(S);
    keys::remap_jump(&mut app, v, 1);
    assert_eq!(app.t, 5 * S, "the next arrow goes to the first key");
    keys::remap_watch(&mut app, v);
    assert!(app.sequence().unwrap().clip(v).unwrap().remap.is_none(), "the stopwatch off is a constant speed again");
}
