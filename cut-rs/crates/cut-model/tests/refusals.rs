//! Edits that leave the project damaged: the JavaScript refuses them with `invalidResult` after validating the whole
//! project; the history validates only what they touched and must refuse exactly the same ones (with the whole check
//! run beside it in debug builds, which stops the test where the two verdicts differ).

mod common;

use common::{ask, projects};
use cut_model::{History, Project};
use serde_json::{Value, json};

const F: i64 = 254016000000 / 30;

fn candidates(p: &Project) -> Vec<Value> {
    let s = p.sequences[0].id.as_str();
    let mut out = Vec::new();
    for c in p.sequences[0].clips() {
        let id = c.id.as_str();
        let mut copy = serde_json::to_value(c).unwrap();
        copy["kind"] = json!(p.sequences[0].track(c.track).unwrap().kind);
        out.push(json!({ "type": "paste", "seqId": s, "clips": [copy], "opts": { "at": 5000 * F } }));
        for (prop, v) in [
            ("masks.m1.opacity", json!(500)),
            ("masks.m1.feather", json!(-3)),
            ("masks.m1.path", json!([1, 2])),
            ("masks.m9.path", json!([0, 0])),
            ("opacity", json!("x")),
            ("position", json!([1])),
            ("layers.l1.size", json!(3)),
            ("effects.e1.amount", json!(2)),
        ] {
            out.push(json!({
                "type": "setKeyframes", "seqId": s, "clipId": id, "prop": prop,
                "keyframes": [{ "t": 0, "v": v, "ease": "linear" }],
            }));
        }
        for patch in [
            json!({ "fadeIn": 100000 * F }),
            json!({ "fadeOut": -F }),
            json!({ "label": 5 }),
            json!({ "props": { "opacity": "x" } }),
            json!({ "duration": 0 }),
            json!({ "name": 7 }),
        ] {
            out.push(json!({ "type": "setClip", "seqId": s, "clipId": id, "patch": patch, "opts": {} }));
        }
        out.push(json!({ "type": "addMarker", "seqId": s, "marker": { "t": -5 * F, "duration": -F }, "opts": { "clipId": id } }));
        out.push(json!({ "type": "setRemap", "seqId": s, "clipId": id, "remap": { "at": 0, "speeds": [1, 2], "keys": [{ "t": 5, "ramp": 0 }], "duration": 30 * F } }));
    }
    for ct in &p.sequences[0].captions {
        for it in &ct.items {
            for patch in [
                json!({ "text": "완전히 다른 글" }),
                json!({ "speaker": "x" }),
                json!({ "speaker": "sp9" }),
                json!({ "start": -F }),
                json!({ "doubt": [{ "at": -1, "text": "a", "p": 2 }] }),
            ] {
                out.push(
                    json!({ "type": "setCaption", "seqId": s, "trackId": ct.id, "itemId": it.id, "patch": patch }),
                );
            }
        }
    }
    out.push(json!({ "type": "setSettings", "patch": { "textStyles": 5 } }));
    out.push(json!({ "type": "setSequence", "id": s, "patch": { "background": "red" } }));
    out.push(json!({ "type": "setTrack", "seqId": s, "trackId": "A1", "patch": { "pan": 500 } }));
    out.push(json!({ "type": "setTrack", "seqId": s, "trackId": "V1", "patch": { "height": -1 } }));
    out
}

#[test]
fn damaging_edits_are_refused_alike() {
    let mut texts = projects();
    texts.truncate(5);
    let (mut compared, mut damaged) = (0, 0);
    let mut differ: Vec<String> = Vec::new();
    for text in &texts {
        let p = Project::load(text).expect("loads");
        let cmds = candidates(&p);
        let calls: Vec<Value> = cmds.iter().map(|c| json!(["historyScript", text, [["do", c]]])).collect();
        let answers = ask(&calls);
        for (cmd, js) in cmds.iter().zip(&answers) {
            let theirs = js[0]["value"].get("$code").and_then(Value::as_str).map(str::to_owned);
            let mut h = History::new(p.clone(), usize::MAX).expect("valid");
            let ours = h.apply(cmd).err().map(|e| e.code.name());
            if ours != theirs {
                differ.push(format!("{cmd}: rust {ours:?}, javascript {theirs:?}"));
            }
            compared += 1;
            damaged += usize::from(ours.as_deref() == Some("invalidResult"));
        }
    }
    eprintln!("{compared} edits compared, {damaged} refused as damaging alike");
    assert!(
        differ.is_empty(),
        "{} verdicts differ:
{}",
        differ.len(),
        differ.join(
            "
"
        )
    );
    assert!(damaged > 20, "damaging edits among them");
}
