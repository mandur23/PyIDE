//! What the oracle tests share: Sources as the JavaScript's JSON, and the first difference between two values.
#![allow(dead_code)]

use std::path::PathBuf;

use cut_formats::{MemReader, Source, probe};
use cut_oracle::{ask_scenario, unbytes};
use serde_json::{Value, json};

pub fn json(s: &Source) -> Value {
    serde_json::to_value(s).expect("a Source serializes")
}

pub fn open(bytes: &[u8]) -> Source {
    probe::open(&MemReader(bytes), "")
}

/// Where the first difference between `a` (Rust) and `b` (JavaScript) is, or `None` when they are equal.
pub fn diff(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                let (u, v) = (x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null));
                if x.contains_key(k) != y.contains_key(k) {
                    return Some(format!("{path}.{k}: only on one side (rust {u}, js {v})"));
                }
                if let Some(d) = diff(u, v, &format!("{path}.{k}")) {
                    return Some(d);
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            for (i, (u, v)) in x.iter().zip(y).enumerate() {
                if let Some(d) = diff(u, v, &format!("{path}[{i}]")) {
                    return Some(d);
                }
            }
            (x.len() != y.len()).then(|| format!("{path}: {} items here, {} in the JavaScript", x.len(), y.len()))
        }
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => None,
        _ if a == b => None,
        _ => {
            let short = |v: &Value| {
                let s = v.to_string();
                if s.len() > 200 { format!("{}...", &s[..200]) } else { s }
            };
            Some(format!("{path}: rust {} != js {}", short(a), short(b)))
        }
    }
}

/// Whether the JavaScript's value holds a number past what an i64 tick holds (a damaged file's time past 2^63).
pub fn out_of_range(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_f64().is_some_and(|x| x.abs() >= 2f64.powi(63)),
        Value::Array(a) => a.iter().any(out_of_range),
        Value::Object(o) => o.values().any(out_of_range),
        _ => false,
    }
}

/// `v` without its times (`dts`, `pts`, `duration`, `order`), for a file whose times are out of range.
pub fn without_times(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(without_times).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| !["dts", "pts", "duration", "order"].contains(&k.as_str()))
                .map(|(k, x)| (k.clone(), without_times(x)))
                .collect(),
        ),
        x => x.clone(),
    }
}

/// A file of the JavaScript tests' media (verify/fixtures/viewers), read where it is.
pub fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures/viewers").join(rel)
}

pub const FIXTURES: [&str; 4] = ["video/clip.mp4", "video/voice.webm", "audio/tone.wav", "images/sample.png"];

/// The test's fill pattern for sample bytes (verify/cut-formats.mjs `fill`).
pub fn fill(n: usize, seed: i64) -> Vec<u8> {
    (0..n as i64).map(|i| ((seed * 131 + i * 7) & 255) as u8).collect()
}

/// The avcC and hvcC records of the files the JavaScript tests open, and of the fixtures.
pub fn records() -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let mut files: Vec<Vec<u8>> = FIXTURES.iter().map(|r| std::fs::read(fixture(r)).expect("fixture")).collect();
    let captured = ask_scenario("formats", &[json!(["capture"])]).remove(0);
    files.extend(
        captured
            .as_array()
            .expect("files")
            .iter()
            .filter(|f| f["source"]["error"].is_null())
            .map(|f| unbytes(&f["bytes"])),
    );
    let (mut avc, mut hevc) = (Vec::new(), Vec::new());
    for b in files {
        for t in open(&b).tracks {
            let Some(d) = t.description else { continue };
            let list = if t.codec.starts_with("avc") {
                &mut avc
            } else if t.codec.starts_with("hvc") || t.codec.starts_with("hev") {
                &mut hevc
            } else {
                continue;
            };
            if !list.contains(&d) {
                list.push(d);
            }
        }
    }
    assert!(!avc.is_empty() && !hevc.is_empty(), "the tests' files have H.264 and HEVC");
    (avc, hevc)
}
