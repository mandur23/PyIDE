//! The edit commands and the history against `commands.js`: the editor's own random-command run (verify/cut-model.mjs)
//! replayed here step by step. After every step both projects are the same (canonical text), the result and the
//! refusal codes are the same, and undo gives back the project before the step and redo the one after.

mod common;

use common::{ask1, diff, same};
use cut_model::canon::{canonical, fingerprint};
use cut_model::{History, Project};
use serde_json::{Value, json};

fn load(text: &str) -> History {
    let p = Project::from_json(serde_json::from_str(text).expect("JSON")).expect("a valid project");
    History::new(p, usize::MAX).expect("valid")
}

struct Run {
    compared: usize,
    refused: usize,
    invalid_result: usize,
    kinds: std::collections::BTreeMap<String, usize>,
}

fn replay(seed: u64, steps: usize, extra: bool) -> Run {
    let opts = json!({ "seed": seed, "steps": steps, "extra": extra });
    let run = ask1(json!(["randomRun", opts]));
    let mut h = load(run["start"].as_str().unwrap());
    let mut out = Run { compared: 0, refused: 0, invalid_result: 0, kinds: Default::default() };
    let mut before = fingerprint(&canonical(h.project()));
    for (i, step) in run["steps"].as_array().unwrap().iter().enumerate() {
        let cmd = &step["cmd"];
        let kind = cmd["type"].as_str().unwrap().to_owned();
        let r = h.apply(cmd);
        assert!(!matches!(&r, Err(e) if e.code == cut_model::Code::Unported), "step {i} {cmd}: every command runs");
        let now = fingerprint(&canonical(h.project()));
        let js_code = step.get("code").and_then(Value::as_str);
        match (&r, js_code) {
            (Err(e), Some(code)) => {
                assert_eq!(e.code.name(), code, "step {i} {cmd}: the same refusal ({e})");
                out.refused += 1;
                out.invalid_result += usize::from(code == "invalidResult");
            }
            (Err(e), None) => panic!("step {i} {cmd}: rust refuses ({e:?}), the javascript applies it"),
            (Ok(_), Some(code)) => panic!("step {i} {cmd}: the javascript refuses ({code}), rust applies it"),
            (Ok(v), None) => {
                let theirs = step.get("result").unwrap_or(&Value::Null);
                assert!(same(v, theirs), "step {i} {cmd}: results differ: {:?}", diff(v, theirs, ""));
            }
        }
        if now != step["hash"].as_str().unwrap() {
            let text = ask1(json!(["stateAfter", { "seed": seed, "extra": extra }, i]));
            let theirs: Value = serde_json::from_str(ask1(json!(["canon", text])).as_str().unwrap()).unwrap();
            let ours: Value = serde_json::from_str(&canonical(h.project())).unwrap();
            panic!("step {i} {cmd}: projects differ: {:?}", diff(&ours, &theirs, ""));
        }
        if r.is_ok() && now != before {
            assert!(h.undo(), "step {i}: a step to undo");
            assert_eq!(
                fingerprint(&canonical(h.project())),
                before,
                "step {i} {cmd}: undo gives back the project before"
            );
            assert!(h.redo(), "step {i}: a step to redo");
            assert_eq!(fingerprint(&canonical(h.project())), now, "step {i} {cmd}: redo gives the project after");
        }
        *out.kinds.entry(kind).or_default() += 1;
        out.compared += 1;
        before = now;
    }
    out
}

#[test]
fn random_runs_match_the_javascript_step_by_step() {
    let mut total = 0;
    let mut kinds = std::collections::BTreeMap::new();
    for (seed, steps, extra) in
        [(20261105_u64, 2000, false), (7, 1500, false), (99, 1500, false), (5, 1500, true), (11, 1500, true)]
    {
        let r = replay(seed, steps, extra);
        println!(
            "seed {seed}: {} steps compared ({} refused alike, {} of them invalidResult)",
            r.compared, r.refused, r.invalid_result
        );
        total += r.compared;
        for (k, n) in r.kinds {
            *kinds.entry(k).or_insert(0) += n;
        }
    }
    println!("compared by type: {kinds:?}");
    assert!(total > 7000, "{total} steps compared");
    let missing: Vec<&str> =
        cut_model::commands::LABELS.iter().map(|(k, _)| *k).filter(|k| !kinds.contains_key(*k)).collect();
    assert!(missing.is_empty(), "command types never compared: {missing:?}");
}

#[test]
fn undoing_every_step_returns_to_the_start() {
    let run = ask1(json!(["randomRun", { "seed": 3, "steps": 600 }]));
    let mut h = load(run["start"].as_str().unwrap());
    let start = canonical(h.project());
    for step in run["steps"].as_array().unwrap() {
        let _ = h.apply(&step["cmd"]);
    }
    let end = canonical(h.project());
    let steps = h.position();
    assert!(steps > 300, "{steps} steps");
    assert!(h.go_to(0), "undo them all in one go");
    assert_eq!(canonical(h.project()), start, "undoing every step gives back the start");
    assert!(h.go_to(steps), "redo them all in one go");
    assert_eq!(canonical(h.project()), end, "redoing them gives back the end");
    assert_eq!(
        fingerprint(&end),
        run["steps"].as_array().unwrap().last().unwrap()["hash"].as_str().unwrap(),
        "the JavaScript's end"
    );
}
