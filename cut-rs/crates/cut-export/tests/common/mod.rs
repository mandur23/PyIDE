#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::Value;

/// cut-decode's test media generator (pictures that show their frame number as blocks), included so there is one.
#[path = "../../../cut-decode/tests/common/make.rs"]
pub mod make;

/// A decoded picture as `make::read_number` reads it: luma rows, then chroma.
pub struct Got {
    pub width: u32,
    pub height: u32,
    pub format: cut_decode::PixelFormat,
    pub bytes: Vec<u8>,
}

/// Where test media and exports go: `CUT_EXPORT_OUT` when set, else the system temporary directory.
pub fn out_dir() -> PathBuf {
    let dir = std::env::var_os("CUT_EXPORT_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cut-export"));
    std::fs::create_dir_all(&dir).expect("an output directory");
    dir
}

/// JSON equality with numbers compared as numbers (Rust writes -14.0 where JavaScript writes -14).
pub fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Asserts that every answer matches, naming the first few that do not.
pub fn compare(label: &str, calls: &[Value], ours: &[Value], theirs: &[Value]) -> usize {
    let bad: Vec<String> = calls
        .iter()
        .zip(ours.iter().zip(theirs))
        .filter(|(_, (o, t))| !same(o, t))
        .take(5)
        .map(|(c, (o, t))| format!("{c}\n  rust {o}\n  js   {t}"))
        .collect();
    assert!(bad.is_empty(), "{label}: {} differ, first:\n{}", bad.len(), bad.join("\n"));
    calls.len()
}
