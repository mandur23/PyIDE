//! The Transcript panel's Delete against the JavaScript (`tools/scenarios/transcript.cjs`: `removeSelected` of
//! ui-speech.js with ui-auto.js's `rippleTracks` and `rippleRanges` as written): on the model scenario's projects and
//! random words on their clips, nasty ones included (no words chosen, words of no length, overlapping and touching
//! words, words of several clips and tracks, the first and the last), the ranges, the tracks and the whole project after
//! the one "Delete Words" step, value for value.

use cut_app::speech::flow::ripple_command;
use cut_app::speech::text::{self, Word};
use cut_model::{History, Id, Project};
use cut_oracle::{Inputs, ask};
use serde_json::{Value as Json, json};

fn f(rng: &mut Inputs, lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * (rng.next_u64() % 1_000_000) as f64 / 1_000_000.0
}

/// Words on the clips of `seq`, in time order, each tied to the clip it lies on.
fn words_on(rng: &mut Inputs, p: &Project, seq: Id) -> Vec<Word> {
    let s = p.sequence(seq).unwrap();
    let mut out = Vec::new();
    for c in s.clips() {
        let (a, b) = (c.start as f64, c.end() as f64);
        let n = rng.range(0, 6);
        for _ in 0..n {
            let t0 = f(rng, a, b).round();
            let len = if rng.range(0, 7) == 0 { 0.0 } else { f(rng, 0.0, (b - t0).max(0.0) * 0.5).round() };
            let mut w = Word::new(t0, t0 + len, ["음", "hello", "그래요.", "x"][rng.range(0, 3) as usize], None);
            w.clip = Some(c.id);
            out.push(w);
        }
    }
    out.sort_by(|x, y| x.t0.total_cmp(&y.t0));
    out
}

fn words_json(ws: &[Word]) -> Json {
    json!(
        ws.iter()
            .map(|w| json!({ "t0": w.t0, "t1": w.t1, "text": w.text, "clip": w.clip.map(|c| c.as_str().to_owned()) }))
            .collect::<Vec<_>>()
    )
}

#[test]
fn delete_words_ranges_tracks_and_the_project_match_the_javascript() {
    let projects: Vec<String> = ask("scenario/model", &[json!(["projects"])])[0]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap().to_owned())
        .collect();
    let mut rng = Inputs::new(41);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for text in &projects {
        let p = Project::load(text).expect("the project loads");
        for seq in p.sequences.iter().map(|s| s.id) {
            for k in 0..8 {
                let ws = words_on(&mut rng, &p, seq);
                let chosen: Vec<usize> = match k {
                    0 => Vec::new(),
                    1 => (0..ws.len()).collect(),
                    2 => ws.len().checked_sub(1).into_iter().collect(),
                    _ => (0..ws.len()).filter(|_| rng.range(0, 2) == 0).collect(),
                };
                let s = p.sequence(seq).unwrap();
                let frame = cut_model::query::frame(s.fps) as f64;
                calls.push(json!(["deleteWords", text, seq.as_str(), words_json(&ws), chosen, frame]));
                let ranges = text::removal_ranges(&ws, &chosen, frame);
                let mut own: Vec<Id> = Vec::new();
                for c in chosen.iter().filter_map(|&i| ws[i].clip) {
                    if !own.contains(&c) {
                        own.push(c);
                    }
                }
                let ranges_json = json!(ranges.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>());
                let Some(cmd) = ripple_command(s, &ranges, &own, "Delete Words") else {
                    ours.push((ranges_json, Json::Null, None));
                    continue;
                };
                let tracks = cmd["commands"][0]["trackIds"].clone();
                let mut h = History::new(p.clone(), usize::MAX).expect("a history");
                h.apply(&cmd).expect("the deletion applies");
                assert_eq!(h.list().last().map(|e| e.label.as_str()), Some("Delete Words"), "one step");
                ours.push((ranges_json, tracks, Some(h.project().to_text())));
            }
        }
    }
    let theirs = ask("scenario/transcript", &calls);
    let texts: Vec<Json> = ours.iter().filter_map(|o| o.2.clone()).map(|t| json!(["canon", t])).collect();
    let canon = ask("scenario/model", &texts);
    let mut canon = canon.into_iter();
    let mut cut = 0;
    for (i, ((ranges, tracks, project), js)) in ours.iter().zip(&theirs).enumerate() {
        let nums = |a: &Json| -> Vec<f64> {
            a.as_array()
                .into_iter()
                .flatten()
                .flat_map(|r| r.as_array().cloned().unwrap_or_default())
                .filter_map(|x| x.as_f64())
                .collect()
        };
        let same = |a: &Json, b: &Json| nums(a) == nums(b);
        assert!(same(ranges, &js["ranges"]), "#{i} ranges: rust {ranges} js {}", js["ranges"]);
        assert_eq!(tracks, &js["tracks"], "#{i} tracks");
        if project.is_some() {
            cut += 1;
            assert_eq!(canon.next().unwrap(), js["project"], "#{i}: the project after Delete Words");
        } else {
            assert!(js["project"].is_null(), "#{i}: nothing to delete on both sides");
        }
    }
    assert!(cut > 20, "enough deletions compared: {cut}");
    eprintln!("{} Delete Words cases compared, {cut} with a deletion", ours.len());
}
