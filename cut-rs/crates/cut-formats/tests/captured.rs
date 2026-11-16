//! Every file `verify/cut-formats.mjs` opens (the ones it builds byte by byte, the ones mp4write wrote, and its
//! truncated and damaged copies), opened by both editors: the whole Source must be the same.

mod common;

use common::{diff, json, open, out_of_range, without_times};
use cut_oracle::{ask_scenario, unbytes};
use serde_json::json;

#[test]
fn every_file_of_the_javascript_tests_opens_the_same() {
    let files = ask_scenario("formats", &[json!(["capture"])]).remove(0);
    let files = files.as_array().expect("a list of files");
    assert!(files.len() > 500, "the test opened {} files", files.len());
    let mut wrong = Vec::new();
    let mut timeless = 0;
    for (i, f) in files.iter().enumerate() {
        let bytes = unbytes(&f["bytes"]);
        let (mut ours, mut theirs) = (json(&open(&bytes)), f["source"].clone());
        // Ticks past 2^63 saturate here; there they are doubles. Everything else must still match.
        if out_of_range(&theirs) {
            timeless += 1;
            (ours, theirs) = (without_times(&ours), without_times(&theirs));
        }
        if let Some(d) = diff(&ours, &theirs, "source") {
            wrong.push(format!("file {i} ({} bytes): {d}", bytes.len()));
        }
    }
    assert!(wrong.is_empty(), "{} of {} files differ:\n{}", wrong.len(), files.len(), wrong.join("\n"));
    assert!(timeless <= 2, "{timeless} files with times past 2^63");
    println!("{} files the same ({timeless} compared without their out-of-range times)", files.len());
}
