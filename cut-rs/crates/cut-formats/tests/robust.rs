//! The real media fixtures of the JavaScript tests, and random truncations and bit flips of them and of files the
//! JavaScript tests build: both editors give an error code or a Source, the same one, and never a panic or a hang.

mod common;

use std::sync::mpsc;
use std::time::Duration;

use common::{FIXTURES, diff, fixture, json, open, out_of_range, without_times};
use cut_formats::{FileReader, MemReader, Source, probe};
use cut_oracle::{Inputs, ask_scenario, bytes, unbytes};
use serde_json::{Value, json};

#[test]
fn the_media_fixtures_open_the_same_from_a_file_and_from_memory() {
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for rel in FIXTURES {
        let path = fixture(rel);
        let data = std::fs::read(&path).expect("the fixture is there");
        let from_file = probe::open(&FileReader::open(&path).expect("it opens"), rel);
        let from_memory = probe::open(&MemReader(&data), rel);
        assert_eq!(from_file, from_memory, "{rel}: the file reader and the memory reader agree");
        assert!(from_file.error.is_none(), "{rel}: {:?}", from_file.error);
        calls.push(json!(["probeBytes", bytes(&data)]));
        ours.push(json(&from_file));
    }
    for ((rel, ours), theirs) in FIXTURES.iter().zip(&ours).zip(ask_scenario("formats", &calls)) {
        assert_eq!(diff(ours, &theirs, rel), None);
    }
}

/// Opens `b` on a thread of its own: a panic or a hang fails the test with what it was.
fn open_guarded(b: Vec<u8>, what: &str) -> (Source, Vec<u8>) {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let s = open(&b);
        let _ = tx.send((s, b));
    });
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(r) => r,
        Err(_) => panic!("{what}: no answer in 10 s (a panic or a hang)"),
    }
}

/// What the JavaScript test checks of every damaged file, and that its samples read.
fn usable(s: &Source, b: &[u8], what: &str) {
    assert!(s.error.is_some() || !s.tracks.is_empty() || s.image.is_some(), "{what}: no tracks and no error");
    for t in &s.tracks {
        let x = &t.samples;
        let n = x.count();
        assert!(n > 0, "{what}: an empty track");
        for col in [x.size.len(), x.dts.len(), x.pts.len(), x.duration.len(), x.key.len(), x.order.len()] {
            assert_eq!(col, n, "{what}: columns of one length");
        }
        for i in 0..n {
            assert!(x.offset[i] + u64::from(x.size[i]) <= b.len() as u64, "{what}: sample {i} inside the file");
            assert!(x.duration[i] >= 0, "{what}: durations are not negative");
            if i > 0 {
                assert!(x.pts[x.order[i] as usize] >= x.pts[x.order[i - 1] as usize], "{what}: order sorts by pts");
            }
        }
        let r = MemReader(b);
        probe::read_sample(&r, t, 0).unwrap_or_else(|e| panic!("{what}: read_sample: {e}"));
        probe::read_samples(&r, t, 0, n, |_, _| {}).unwrap_or_else(|e| panic!("{what}: read_samples: {e}"));
        probe::key_before(t, n as i64 - 1).expect("a sync sample");
        probe::sample_at_time(t, t.duration / 2).expect("a sample");
    }
}

fn variants(base: &[u8], rng: &mut Inputs) -> Vec<(String, Vec<u8>)> {
    let n = base.len();
    let mut out = Vec::new();
    for k in 0..20 {
        out.push((format!("cut at {}", n * k / 20), base[..n * k / 20].to_vec()));
    }
    for _ in 0..10 {
        let at = rng.range(0, n as i64 - 1) as usize;
        out.push((format!("cut at {at}"), base[..at].to_vec()));
    }
    for _ in 0..30 {
        let mut b = base.to_vec();
        let at = rng.range(0, n as i64 - 1) as usize;
        for _ in 0..rng.range(1, 16) {
            let i = (at + rng.range(0, 63) as usize).min(n - 1);
            b[i] = rng.range(0, 255) as u8;
        }
        out.push((format!("corrupt near {at}"), b));
    }
    for _ in 0..10 {
        let mut b = base.to_vec();
        let at = rng.range(0, n as i64 - 9) as usize;
        let bit = rng.range(0, 63);
        b[at..at + 8].copy_from_slice(&u64::MAX.to_be_bytes());
        b[at + (bit as usize / 8)] ^= 1 << (bit % 8);
        out.push((format!("huge size near {at}"), b));
    }
    out
}

/// One file of each kind the JavaScript tests build, no bigger than 64 kB, besides the real fixtures.
fn bases() -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> =
        FIXTURES.iter().map(|rel| (rel.to_string(), std::fs::read(fixture(rel)).expect("the fixture"))).collect();
    let files = ask_scenario("formats", &[json!(["capture"])]).remove(0);
    let mut kinds: Vec<String> = Vec::new();
    for f in files.as_array().expect("files") {
        let s = &f["source"];
        let kind = format!("{} {}", s["container"], s["tracks"].as_array().map_or(0, |t| t.len()));
        let b = unbytes(&f["bytes"]);
        if s["error"].is_null() && b.len() <= 64 * 1024 && !kinds.contains(&kind) {
            kinds.push(kind.clone());
            out.push((kind, b));
        }
    }
    out
}

#[test]
fn damaged_files_give_an_error_or_a_source_the_same_as_the_javascript() {
    let mut rng = Inputs::new(77);
    let mut cases: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, base) in bases() {
        for (what, b) in variants(&base, &mut rng) {
            cases.push((format!("{name} {what}"), b));
        }
    }
    let calls: Vec<Value> = cases.iter().map(|(_, b)| json!(["probeBytes", bytes(b)])).collect();
    let theirs = ask_scenario("formats", &calls);
    let mut wrong = Vec::new();
    for ((what, b), theirs) in cases.into_iter().zip(theirs) {
        let (s, b) = open_guarded(b, &what);
        usable(&s, &b, &what);
        let (mut ours, mut theirs) = (json(&s), theirs);
        if out_of_range(&theirs) {
            (ours, theirs) = (without_times(&ours), without_times(&theirs));
        }
        if let Some(d) = diff(&ours, &theirs, "source") {
            wrong.push(format!("{what}: {d}"));
        }
    }
    println!("{} damaged files compared", calls.len());
    assert!(wrong.is_empty(), "{} damaged files differ:\n{}", wrong.len(), wrong.join("\n"));
}
