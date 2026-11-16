//! `cut_model::graphic` against `renderer/features/cut/graphic.js` on the same inputs: the check of layer lists, the
//! normalized and compact forms, single field values and SVG path data.

mod common;

use common::{diff, same};
use cut_model::graphic::{self, KINDS};
use cut_oracle::{Inputs, ask};
use serde_json::{Value, json};

fn compare(calls: &[Value], ours: &[Value]) {
    let theirs = ask("graphic", calls);
    assert_eq!(theirs.len(), ours.len());
    for ((c, a), b) in calls.iter().zip(ours).zip(&theirs) {
        assert!(same(a, b), "{c}: {:?}", diff(a, b, ""));
    }
    eprintln!("oracle comparisons: {}", calls.len());
}

const PATHS: [&str; 18] = [
    "M0 0 L10 10",
    "M 10,20 l 5 5 h 3 v -2 z",
    "m1 1 2 2 3 3",
    "M0 0 C1 1 2 2 3 3 S5 5 6 6",
    "M0 0 Q1 1 2 2 T4 4 t1 1",
    "M0 0 c1 1 2 2 3 3 s1 1 2 2 q1 1 2 2 Z m5 5 l1 1",
    "L1 1",
    "M0 0 A1 1 0 0 1 2 2",
    "M0 0 Z 1",
    "M0 0 X1",
    "M1e2 .5 L-.5e-1 +3.",
    "M0 0 L1e400 1",
    "M0 0 L1",
    "1 2",
    "M0 0 L1 1 #",
    "  ",
    "M0 0 1e5 Z",
    "Z M1 1 z z",
];

fn value(rng: &mut Inputs, field: &str) -> Value {
    let picks = [
        json!(0),
        json!(1),
        json!(-1),
        json!(2.5),
        json!(100),
        json!(1e9),
        json!(30000),
        json!([1, 2]),
        json!([1, 2, 3]),
        json!([0, 25000]),
        json!("#ff0000"),
        json!("#ff000080"),
        json!("red"),
        json!(null),
        json!(true),
        json!("x"),
        json!("g1"),
        json!(""),
        json!({ "type": "linear", "from": [0, 0], "to": [10, 0], "stops": [[0, "#000000"], [1, "#ffffff"]] }),
        json!({ "type": "radial", "from": [0, 0], "to": [1, 1], "stops": [[0, "#000"]] }),
        json!({ "type": "conic" }),
        json!({ "kind": 1 }),
        json!([5, 0]),
        json!([0, 0]),
        json!("normal"),
        json!("burst"),
        json!("round"),
        json!("x".repeat(90)),
    ];
    if field == "d" && rng.range(0, 1) == 0 {
        return json!(rng.pick(&PATHS));
    }
    if field == "parent" && rng.range(0, 1) == 0 {
        return json!(format!("g{}", rng.range(0, 5)));
    }
    if let Some(&(_, _, d)) = graphic::field(field)
        && rng.range(0, 2) == 0
    {
        return d.to_json();
    }
    picks[rng.range(0, picks.len() as i64 - 1) as usize].clone()
}

fn layer(rng: &mut Inputs, i: usize) -> Value {
    if rng.range(0, 30) == 0 {
        let odd = [json!(null), json!(3), json!("rect"), json!([])];
        return odd[rng.range(0, 3) as usize].clone();
    }
    let kind = if rng.range(0, 20) == 0 { "blob" } else { rng.pick(&KINDS) };
    let mut o = serde_json::Map::new();
    match rng.range(0, 12) {
        0 => {}
        1 => {
            o.insert("id".into(), json!("g1"));
        }
        2 => {
            o.insert("id".into(), json!("bad id!"));
        }
        _ => {
            o.insert("id".into(), json!(format!("g{}", i + 1)));
        }
    }
    if rng.range(0, 15) != 0 {
        o.insert("kind".into(), json!(kind));
    }
    let fields = graphic::fields_of(kind);
    for _ in 0..rng.range(0, 6) {
        let f = if fields.is_empty() || rng.range(0, 10) == 0 {
            rng.pick(&["size", "text", "count", "nothing", "d", "parent"])
        } else {
            rng.pick(&fields)
        };
        let v = value(rng, f);
        o.insert(f.into(), v);
    }
    if kind == "path" && rng.range(0, 3) != 0 {
        o.insert("d".into(), json!(rng.pick(&PATHS)));
    }
    if kind == "particles" && rng.range(0, 4) == 0 {
        o.insert("count".into(), json!(rng.pick(&[2000, 500, 60])));
        o.insert("repeatCount".into(), json!(rng.pick(&[20, 1, 500])));
    }
    Value::Object(o)
}

#[test]
fn validate_and_normalize_match_the_javascript() {
    let mut rng = Inputs::new(31);
    let mut lists: Vec<Value> = vec![
        json!(null),
        json!({}),
        json!([]),
        json!([{ "id": "g1", "kind": "rect" }]),
        json!([{ "id": "g1", "kind": "group" }, { "id": "g2", "kind": "text", "parent": "g1" }]),
        json!([{ "id": "g1", "kind": "rect" }, { "id": "g2", "kind": "text", "parent": "g1" }]),
        json!([{ "id": "g2", "kind": "text", "parent": "g1" }, { "id": "g1", "kind": "group" }]),
        json!([{ "id": "g1", "kind": "group" }, { "id": "g1", "kind": "rect", "parent": "g1" }]),
        json!([{ "id": "g1", "kind": "particles", "count": 2000, "repeatCount": 11 }]),
        json!((0..201).map(|i| json!({ "id": format!("g{i}"), "kind": "rect" })).collect::<Vec<_>>()),
        json!([{ "id": "g1", "kind": "path" }, { "id": "g2", "kind": "path", "d": " \n" }]),
    ];
    for _ in 0..1500 {
        let n = rng.range(0, 6) as usize;
        lists.push(Value::Array((0..n).map(|i| layer(&mut rng, i)).collect()));
    }
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for l in &lists {
        calls.push(json!(["validate", l]));
        ours.push(json!(graphic::validate(Some(l))));
        for x in l.as_array().into_iter().flatten().filter(|x| x.is_object()) {
            calls.push(json!(["normalize", x]));
            ours.push(graphic::normalize(x));
            if x.get("id").is_some() {
                calls.push(json!(["compact", x]));
                ours.push(graphic::compact(x));
            }
        }
    }
    let good = lists.iter().filter(|l| graphic::validate(Some(l)).is_empty()).count();
    assert!(good > 100, "{good} of the lists are good");
    compare(&calls, &ours);
}

#[test]
fn field_values_and_kinds_match_the_javascript() {
    let mut rng = Inputs::new(32);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    let names: Vec<&str> = graphic::FIELDS.iter().map(|f| f.0).chain(["nothing", "id"]).collect();
    for name in &names {
        for _ in 0..12 {
            let v = value(&mut rng, name);
            calls.push(json!(["checkValue", name, v]));
            ours.push(json!(graphic::check_value(name, &v)));
        }
    }
    for kind in KINDS.iter().chain(&["blob"]) {
        calls.push(json!(["fieldsOf", kind]));
        ours.push(json!(graphic::fields_of(kind)));
    }
    compare(&calls, &ours);
}

fn parsed(d: &str) -> Value {
    match graphic::parse_path(d) {
        Ok(s) => json!({ "subpaths": s.iter().map(graphic::Subpath::to_json).collect::<Vec<_>>(), "error": "" }),
        Err(e) => json!({ "subpaths": [], "error": e }),
    }
}

#[test]
fn path_data_matches_the_javascript() {
    let mut rng = Inputs::new(33);
    let words = [
        "M", "m", "L", "l", "H", "h", "V", "v", "C", "c", "S", "s", "Q", "q", "T", "t", "Z", "z", "A", "X", "1",
        "-2.5", ".5", "1e2", "1e", "3.", "+4", "-.5e-1", ",", " ", "\n", "#", "é", "1e400", "0", "7", "-", ".", "E5",
        "\u{a0}",
    ];
    let mut inputs: Vec<String> = PATHS.iter().map(|s| (*s).to_owned()).collect();
    inputs.extend(["", "M", "M1", "m1 2", "M1 2 3", "1e5", "M0 0 L1 1 ".repeat(40).as_str()].map(String::from));
    for _ in 0..3000 {
        let mut s = if rng.range(0, 2) == 0 { "M0 0".to_owned() } else { String::new() };
        for _ in 0..rng.range(0, 14) {
            s.push_str(rng.pick(&words));
            if rng.range(0, 1) == 0 {
                s.push(' ');
            }
        }
        inputs.push(s);
    }
    let calls: Vec<Value> = inputs.iter().map(|d| json!(["parsePath", d])).collect();
    let ours: Vec<Value> = inputs.iter().map(|d| parsed(d)).collect();
    let drawn = ours.iter().filter(|v| v["error"] == "").count();
    assert!(drawn > 100, "{drawn} of the paths parse");
    compare(&calls, &ours);
}

#[test]
fn malformed_layers_never_panic() {
    let mut rng = Inputs::new(34);
    for _ in 0..5000 {
        let l = Value::Array((0..rng.range(0, 4)).map(|i| layer(&mut rng, i as usize)).collect());
        let _ = graphic::validate(Some(&l));
        for x in l.as_array().unwrap() {
            let _ = (graphic::normalize(x), graphic::compact(x));
        }
    }
}
