//! What the model's oracle tests share: the scenario's projects and a comparison of JSON values by value.

#![allow(dead_code)]

use serde_json::{Value, json};

/// Asks `tools/scenarios/model.cjs`.
pub fn ask(calls: &[Value]) -> Vec<Value> {
    cut_oracle::ask("scenario/model", calls)
}

pub fn ask1(call: Value) -> Value {
    ask(&[call]).remove(0)
}

/// The projects the scenario builds, and states of a random run of the editor's commands.
pub fn projects() -> Vec<String> {
    let answers = ask(&[
        json!(["projects"]),
        json!(["sampled", { "steps": 1200, "every": 60 }]),
        json!(["sampled", { "steps": 1200, "every": 60, "seed": 5, "extra": true }]),
    ]);
    answers
        .iter()
        .flat_map(|a| a.as_array().expect("a list").iter().map(|t| t.as_str().expect("text").to_owned()))
        .collect()
}

/// Whether two JSON values are the same, numbers compared as f64 (the JavaScript writes 5 where Rust writes 5.0).
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// The first place two JSON values differ, as a path, for a failure message.
pub fn diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().find_map(|(i, (a, b))| diff(a, b, &format!("{path}[{i}]")))
        }
        (Value::Object(x), Value::Object(y)) => {
            for (k, v) in x {
                match y.get(k) {
                    Some(w) => {
                        if let Some(d) = diff(v, w, &format!("{path}.{k}")) {
                            return Some(d);
                        }
                    }
                    None => return Some(format!("{path}.{k}: only rust has {v}")),
                }
            }
            y.keys().find(|k| !x.contains_key(*k)).map(|k| format!("{path}.{k}: only javascript has {}", y[k]))
        }
        _ if same(a, b) => None,
        _ => Some(format!("{path}: rust {a}, javascript {b}")),
    }
}
