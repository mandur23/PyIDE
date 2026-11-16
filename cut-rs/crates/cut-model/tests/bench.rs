//! A long timeline, Rust against the JavaScript on the same input: 10,000 clips on 20 tracks, the time to load the
//! project, to find the clips at a time, and to apply and undo 1,000 commands.
//! `cargo test --release -p cut-model --test bench -- --ignored --nocapture`

mod common;

use std::time::Instant;

use common::ask1;
use cut_model::canon::canonical;
use cut_model::{History, Project};
use serde_json::json;

#[test]
#[ignore]
fn long_timeline() {
    let js = ask1(json!(["bench", {}]));
    let text = js["text"].as_str().unwrap();
    let times: Vec<i64> = serde_json::from_value(js["times"].clone()).unwrap();
    let cmds = js["cmds"].as_array().unwrap();

    let t0 = Instant::now();
    let p = Project::load(text).expect("loads");
    let mut h = History::new(p, usize::MAX).expect("valid");
    let load = t0.elapsed();
    let start = canonical(h.project());

    let t0 = Instant::now();
    let seq = &h.project().sequences[0];
    let found: usize = times.iter().map(|t| seq.clips_at(*t, None).len()).sum();
    let clips_at = t0.elapsed();

    let t0 = Instant::now();
    let applied = cmds.iter().filter(|c| h.apply(c).is_ok()).count();
    let apply = t0.elapsed();

    let t0 = Instant::now();
    while h.undo() {}
    let undo = t0.elapsed();

    assert_eq!(found as u64, js["found"].as_u64().unwrap(), "the same clips found");
    assert_eq!(applied as u64, js["applied"].as_u64().unwrap(), "the same commands applied");
    assert_eq!(canonical(h.project()), start, "undoing every step gives back the project");

    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
    let t0 = Instant::now();
    let straight: Project = serde_json::from_str(text).unwrap();
    let read = t0.elapsed();
    let t0 = Instant::now();
    assert!(cut_model::migrate::is_current(&straight), "the benchmark file needs no migrate");
    let current = t0.elapsed();
    let t0 = Instant::now();
    let _ = Project::load_migrating(text).unwrap();
    let through = t0.elapsed();
    println!(
        "straight load: types {:.1} ms, current check {:.2} ms; through migrate {:.1} ms",
        ms(read),
        ms(current),
        ms(through)
    );
    let t0 = Instant::now();
    let json: serde_json::Value = serde_json::from_str(text).unwrap();
    let parse = t0.elapsed();
    let t0 = Instant::now();
    let migrated = cut_model::migrate::migrate(json).unwrap();
    let migrate = t0.elapsed();
    let t0 = Instant::now();
    let typed: Project = serde_json::from_value(migrated).unwrap();
    let types = t0.elapsed();
    let t0 = Instant::now();
    assert!(cut_model::validate(&typed).ok());
    let check = t0.elapsed();
    let t0 = Instant::now();
    let saved = typed.to_text();
    let save = t0.elapsed();
    println!(
        "migrate path in parts: parse {:.1} ms, migrate {:.1} ms, types {:.1} ms, validate {:.1} ms; save {:.1} ms ({} bytes)",
        ms(parse),
        ms(migrate),
        ms(types),
        ms(check),
        ms(save),
        saved.len()
    );
    let n = times.len() as f64;
    let c = cmds.len() as f64;
    println!("10,000 clips on 20 tracks ({} bytes)", text.len());
    println!("load:      rust {:9.2} ms   javascript {:9.2} ms", ms(load), js["ms"]["load"].as_f64().unwrap());
    println!(
        "clips at t: rust {:9.4} ms   javascript {:9.4} ms (each, {} times)",
        ms(clips_at) / n,
        js["ms"]["clipsAt"].as_f64().unwrap() / n,
        times.len()
    );
    println!(
        "apply:     rust {:9.3} ms   javascript {:9.3} ms (each, {applied} of {} applied)",
        ms(apply) / c,
        js["ms"]["apply"].as_f64().unwrap() / c,
        cmds.len()
    );
    println!("undo all:  rust {:9.2} ms   javascript {:9.2} ms", ms(undo), js["ms"]["undo"].as_f64().unwrap());
}
