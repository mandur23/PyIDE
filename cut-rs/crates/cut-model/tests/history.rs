//! The history against `createHistory` in commands.js: scripted calls (groups, cancel, goTo, squash, amend, save
//! marks, the step limit, refused commands), what a panel sees after each one compared.

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::{ask1, diff, same};
use cut_model::canon::{canonical, fingerprint};
use cut_model::history::{Mark, Reason};
use cut_model::{History, Project};
use serde_json::{Value, json};

fn script() -> Vec<Value> {
    let f = 254_016_000_000_i64 / 30;
    let place = |media: &str, at: i64, v: Value, a: Value| json!(["do", { "type": "place", "seqId": "s1", "opts": { "source": { "media": media }, "in": 0, "out": 90 * f, "at": at, "video": v, "audio": a, "mode": "overwrite" } }]);
    let opacity = |clip: &str, o: i64| json!(["do", { "type": "setClip", "seqId": "s1", "clipId": clip, "patch": { "props": { "opacity": o } } }]);
    vec![
        place("m2", 0, json!("V1"), json!("A1")),
        place("m3", 0, Value::Null, json!("A2")),
        json!(["begin", "Drag"]),
        opacity("c7", 10),
        opacity("c7", 20),
        json!(["commit"]),
        json!(["undo"]),
        json!(["redo"]),
        json!(["mark"]),
        json!(["markSaved"]),
        json!(["begin", "Fade"]),
        opacity("c7", 30),
        json!(["cancel"]),
        json!(["begin", "Outer"]),
        json!(["begin", "Inner"]),
        opacity("c7", 40),
        json!(["commit"]),
        opacity("c7", 50),
        json!(["commit"]),
        json!(["goTo", 1]),
        json!(["goTo", 5]),
        json!(["goTo", 2]),
        json!(["redo"]),
        opacity("c7", 60),
        json!(["redo"]),
        json!(["do", { "type": "split", "seqId": "s1", "t": 30 * f }]),
        json!(["do", { "type": "setTrack", "seqId": "s1", "trackId": "A2", "patch": { "locked": true } }]),
        json!(["do", { "type": "trim", "seqId": "s1", "clipId": "c9", "opts": { "edge": "end", "delta": -10 * f } }]),
        json!(["squash", 2, "AI turn"]),
        json!(["amend", { "type": "setProxy", "id": "m2", "proxy": { "path": "cache:x" } }]),
        json!(["mark"]),
        json!(["markSaved"]),
        json!(["undo"]),
        json!(["redo"]),
        json!(["begin", "Save during a drag"]),
        opacity("c7", 70),
        json!(["mark"]),
        json!(["markSaved"]),
        json!(["commit"]),
        json!(["do", { "type": "remove", "seqId": "s1", "clipIds": ["c7"], "opts": { "ripple": true } }]),
        json!(["do", { "type": "nope" }]),
        json!(["do", { "type": "setClip", "seqId": "s1", "clipId": "c7", "patch": { "name": "" } }]),
        json!(["squash", 0, "All"]),
        json!(["undo"]),
        json!(["undo"]),
        json!(["redo"]),
        json!(["goTo", 99]),
    ]
}

fn reason(r: Reason) -> &'static str {
    match r {
        Reason::Do => "do",
        Reason::Undo => "undo",
        Reason::Redo => "redo",
        Reason::Commit => "commit",
        Reason::Amend => "amend",
    }
}

fn drive(text: &str, ops: &[Value], limit: usize) -> Vec<Value> {
    let p = Project::from_json(serde_json::from_str(text).unwrap()).unwrap();
    let mut h = History::new(p, limit).unwrap();
    let events = Rc::new(RefCell::new(Vec::new()));
    let sink = events.clone();
    h.on_change(move |r| sink.borrow_mut().push(reason(r)));
    let mut mark: Option<Mark> = None;
    ops.iter()
        .map(|op| {
            let name = op[0].as_str().unwrap();
            let value = match name {
                "do" | "amend" => {
                    let r = if name == "do" { h.apply(&op[1]) } else { h.amend(&op[1]) };
                    r.unwrap_or_else(|e| json!({ "$code": e.code.name() }))
                }
                "undo" => json!(h.undo()),
                "redo" => json!(h.redo()),
                "begin" => {
                    h.begin(op[1].as_str().unwrap());
                    Value::Null
                }
                "commit" => {
                    h.commit();
                    Value::Null
                }
                "cancel" => {
                    h.cancel();
                    Value::Null
                }
                "goTo" => json!(h.go_to(op[1].as_u64().unwrap() as usize)),
                "squash" => json!(h.squash(op[1].as_u64().unwrap() as usize, op[2].as_str().unwrap())),
                "mark" => {
                    mark = Some(h.mark());
                    Value::Null
                }
                "markSaved" => {
                    let m = mark.unwrap_or_else(|| h.mark());
                    h.mark_saved(m);
                    Value::Null
                }
                _ => panic!("unknown op {name}"),
            };
            // the panel's view of the steps, one at a time, is the list's
            let list = h.list();
            assert_eq!(h.steps(), list.len());
            for (i, e) in list.iter().enumerate() {
                assert_eq!(h.step(i), Some((e.label.as_str(), e.done)), "step {i}");
            }
            assert_eq!(h.step(list.len()), None);
            json!({
                "value": value, "list": h.list(), "position": h.position(), "dirty": h.dirty(), "canUndo": h.can_undo(),
                "canRedo": h.can_redo(), "grouping": h.grouping(), "events": events.borrow_mut().drain(..).collect::<Vec<_>>(),
                "hash": fingerprint(&canonical(h.project())),
            })
        })
        .collect()
}

fn compare(limit: usize, ops: &[Value]) {
    let start = ask1(json!(["start"])).as_str().unwrap().to_owned();
    let theirs = ask1(json!(["historyScript", start, ops, limit]));
    let ours = drive(&start, ops, limit);
    for (i, (a, b)) in ours.iter().zip(theirs.as_array().unwrap()).enumerate() {
        assert!(same(a, b), "after {}: {:?}", ops[i], diff(a, b, ""));
    }
    assert_eq!(ours.len(), ops.len());
}

#[test]
fn scripted_history_matches_the_javascript() {
    compare(1000, &script());
}

#[test]
fn the_step_limit_drops_the_oldest_and_dirty_stays_right() {
    let f = 254_016_000_000_i64 / 30;
    let mut ops = vec![json!(["mark"]), json!(["markSaved"])];
    for i in 0..6 {
        ops.push(json!(["do", { "type": "addMarker", "seqId": "s1", "marker": { "t": i * f } }]));
    }
    for _ in 0..5 {
        ops.push(json!(["undo"]));
    }
    ops.push(json!(["goTo", 3]));
    compare(3, &ops);
}
