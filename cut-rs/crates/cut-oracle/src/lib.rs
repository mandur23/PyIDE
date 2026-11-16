//! Test support for the port: the JavaScript editor answers the same questions as the Rust code, and a test compares.
//!
//! [`ask`] runs `tools/oracle.mjs` once for a whole batch of calls, so a test can send thousands of inputs. It needs
//! `node` on PATH, as every other test of this repository does.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::{Value, json};

/// A deterministic stream of test inputs (SplitMix64): the same values on every machine and run, with no dependency.
pub struct Inputs(u64);

impl Inputs {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A value in `lo..=hi`.
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        let span = (i128::from(hi) - i128::from(lo) + 1) as u128;
        (i128::from(lo) + (u128::from(self.next_u64()) % span) as i128) as i64
    }

    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[(self.next_u64() % items.len() as u64) as usize]
    }
}

/// What `module` (a file name under `renderer/features/cut` without `.js`) returns for each call `[function, args...]`.
///
/// # Panics
/// When node cannot be started or the oracle fails: a port cannot be checked without its reference.
pub fn ask(module: &str, calls: &[Value]) -> Vec<Value> {
    run(json!({ "module": module, "calls": calls }), calls.len(), module)
}

/// What a scenario (`tools/scenarios/<name>.mjs`, which builds its inputs in JavaScript) returns for each call.
///
/// # Panics
/// As [`ask`].
pub fn ask_scenario(name: &str, calls: &[Value]) -> Vec<Value> {
    run(json!({ "scenario": name, "calls": calls }), calls.len(), name)
}

/// Binary data as an argument: the oracle hands it to the function as a `Uint8Array`.
pub fn bytes(b: &[u8]) -> Value {
    json!({ "$bytes": base64(b) })
}

/// The bytes of a `{ "$bytes": base64 }` value a scenario returned.
///
/// # Panics
/// When the value is not one.
pub fn unbytes(v: &Value) -> Vec<u8> {
    let s = v["$bytes"].as_str().expect("a { $bytes } value");
    unbase64(s)
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n =
            (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for k in 0..4 {
            out.push(if k <= c.len() { char::from(ALPHABET[(n >> (18 - 6 * k)) as usize & 63]) } else { '=' });
        }
    }
    out
}

fn unbase64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0_u32, 0);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

fn run(request: Value, n: usize, what: &str) -> Vec<Value> {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/oracle.mjs");
    let mut child = Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("node must be on PATH to compare with the JavaScript editor");
    let request = request.to_string();
    // The oracle reads all of stdin before it answers, so writing first cannot deadlock on a full pipe.
    child.stdin.take().expect("stdin is piped").write_all(request.as_bytes()).expect("the oracle reads its request");
    let out = child.wait_with_output().expect("the oracle runs to its end");
    assert!(out.status.success(), "oracle failed for {what}: {}", String::from_utf8_lossy(&out.stderr));
    let answers: Vec<Value> = serde_json::from_slice(&out.stdout).expect("the oracle answers with a JSON list");
    assert_eq!(answers.len(), n, "one answer per call");
    answers
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_round_trips() {
        for n in 0..10 {
            let b: Vec<u8> = (0..n).map(|i| (i * 37 + 200) as u8).collect();
            assert_eq!(super::unbase64(&super::base64(&b)), b);
        }
        assert_eq!(super::base64(b"Man"), "TWFu");
        assert_eq!(super::base64(b"Ma"), "TWE=");
    }
}
