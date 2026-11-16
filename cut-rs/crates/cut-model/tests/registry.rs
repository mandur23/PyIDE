//! `cut_model::effects` and `cut_model::lumetri` against `effects.js` and `lumetri.js`: the registry table is the
//! JavaScript's (rerun `node tools/gen-effects.mjs` when this fails after effects.js changed), defaults and resolve
//! agree, and LUT entries and curves are checked alike.

mod common;

use common::{diff, same};
use cut_model::{effects, lumetri};
use cut_oracle::{Inputs, ask};
use serde_json::{Map, Value, json};

fn compare(module: &str, calls: &[Value], ours: &[Value]) {
    let theirs = ask(module, calls);
    for ((c, a), b) in calls.iter().zip(ours).zip(&theirs) {
        assert!(same(a, b), "{c}: {:?}", diff(a, b, ""));
    }
    eprintln!("oracle comparisons ({module}): {}", calls.len());
}

fn def_json(d: &effects::Def) -> Value {
    let params: Vec<Value> = d
        .params
        .iter()
        .map(|p| {
            let mut o = Map::new();
            o.insert("id".into(), json!(p.id));
            o.insert("name".into(), json!(p.name));
            o.insert("type".into(), json!(p.kind.name()));
            for (k, v) in [("min", p.min), ("max", p.max), ("step", p.step)] {
                if let Some(v) = v {
                    o.insert(k.into(), json!(v));
                }
            }
            o.insert("default".into(), p.default.to_json());
            o.insert("keyframable".into(), json!(p.keyframable));
            for (k, v) in [("group", p.group), ("unit", p.unit)] {
                if let Some(v) = v {
                    o.insert(k.into(), json!(v));
                }
            }
            if p.kind == effects::ParamKind::Choice {
                o.insert("choices".into(), json!(p.choices.iter().map(|(a, b)| [a, b]).collect::<Vec<_>>()));
            }
            Value::Object(o)
        })
        .collect();
    json!({
        "id": d.id, "name": d.name, "category": d.category, "kind": d.kind.name(), "transition": d.transition,
        "masks": d.masks, "extend": d.extend, "params": params,
    })
}

#[test]
fn the_table_is_the_javascript_registry() {
    let theirs = ask("scenario/registry", &[json!(["effects"])]).remove(0);
    let ours: Vec<Value> = effects::ALL.iter().map(def_json).collect();
    assert!(same(&json!(ours), &theirs), "{:?}", diff(&json!(ours), &theirs, ""));
    assert_eq!(effects::list(None).count(), 31);
    assert_eq!(effects::transitions(Some(effects::Kind::Audio)).count(), 1);
    assert!(!effects::get("edge.extend").unwrap().masks, "Edge Extend takes no masks");
    assert!(effects::get("dissolve").unwrap().transition);
    assert!(effects::get("nothing").is_none());
}

#[test]
fn defaults_and_resolve_match_the_javascript() {
    let mut rng = Inputs::new(41);
    let odd = [
        json!(null),
        json!(true),
        json!(0),
        json!(-1e9),
        json!(1e9),
        json!(0.5),
        json!("x"),
        json!(""),
        json!("#ff0000"),
        json!([1, 2]),
        json!([1, "a"]),
        json!([0.2, 0.3, 0.9, 0.1, 0.5, 0.5]),
        json!([]),
        json!({}),
    ];
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for d in effects::ALL.iter().map(|d| d.id).chain(["nothing"]) {
        calls.push(json!(["defaults", d]));
        ours.push(json!(effects::defaults(d)));
        for _ in 0..20 {
            let mut params = Map::new();
            let ids: Vec<&str> = effects::get(d).map(|x| x.params.iter().map(|p| p.id).collect()).unwrap_or_default();
            for _ in 0..rng.range(0, 5) {
                let k = if ids.is_empty() || rng.range(0, 6) == 0 { "other" } else { rng.pick(&ids) };
                params.insert(k.into(), odd[rng.range(0, odd.len() as i64 - 1) as usize].clone());
            }
            calls.push(json!(["resolve", d, params]));
            ours.push(json!(effects::resolve(d, &params)));
        }
    }
    compare("scenario/registry", &calls, &ours);
}

#[test]
fn lut_entries_and_curves_match_the_javascript() {
    let mut rng = Inputs::new(42);
    let stored = ask("scenario/registry", &[json!(["lut", 2]), json!(["lut", 3, 0.5, "x"]), json!(["lut", 17])]);
    let mut entries: Vec<Value> = stored.iter().map(|s| s["entry"].clone()).collect();
    for s in &stored {
        assert!(lumetri::valid_id(s["id"].as_str().unwrap()), "store() makes a valid id");
    }
    let base = stored[1]["entry"].clone();
    let changes = [
        ("size", json!(4)),
        ("size", json!(2.5)),
        ("size", json!(66)),
        ("size", json!(1)),
        ("size", json!("3")),
        ("min", json!([0, 0])),
        ("min", json!([1, 0, 0])),
        ("max", json!([1, 1, null])),
        ("name", json!(3)),
        ("title", json!(null)),
        ("data", json!("AAAA")),
        ("data", json!(5)),
    ];
    for _ in 0..200 {
        let mut e = base.clone();
        for _ in 0..rng.range(0, 2) {
            let (k, v) = &changes[rng.range(0, changes.len() as i64 - 1) as usize];
            e[*k] = v.clone();
        }
        entries.push(e);
    }
    entries.extend([json!(null), json!([]), json!("lut"), json!({})]);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for e in &entries {
        calls.push(json!(["validEntry", e]));
        ours.push(json!(lumetri::valid_entry(e)));
    }
    let curves = [
        json!([0, 0, 1, 1]),
        json!([0.5, 0.5, 0, 0, 1, 1]),
        json!([0, 0, 0.001, 0.5, 1, 1]),
        json!([-1, 2, 3, -4]),
        json!([0, 0, 1]),
        json!([0, 0, "a", 1]),
        json!([0.3, 0.3, 0.3, 0.9]),
        json!((0..40).map(|i| f64::from(i) / 40.0).collect::<Vec<_>>()),
    ];
    for c in &curves {
        calls.push(json!(["sanitize", c]));
        ours.push(json!(lumetri::sanitize(c.as_array().unwrap())));
    }
    for _ in 0..300 {
        let n = rng.range(0, 12);
        let c: Vec<f64> = (0..n).map(|_| (rng.range(-200, 1200) as f64) / 1000.0).collect();
        calls.push(json!(["sanitize", c]));
        ours.push(json!(lumetri::sanitize(json!(c).as_array().unwrap())));
    }
    assert!(ours.iter().filter(|v| **v == json!(true)).count() > 20, "valid entries among them");
    compare("lumetri", &calls, &ours);
}
