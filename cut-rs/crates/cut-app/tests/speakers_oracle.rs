//! Speaker labels' pure half and the voice isolation's names against the JavaScript (`speakers.js`, the fake
//! backends of `main/cut/speakers.js` and `voice.js`, the cache keys of `ui-speakers.js` and `ui-voice.js`, through
//! `tools/scenarios/speakers.cjs`): segments and windows of random transcripts, the average-linkage tree, its cuts,
//! the clustering (Auto, fixed counts, strays, subsampled cores, missing embeddings), the words' speakers, turns,
//! the speaker at a time, hand changes, labels matched to those of before, new speakers' ids and colours, and names;
//! then the fake embedding, the WAV header, the vocals' file names and keys. Value for value.

use std::collections::BTreeMap;

use cut_app::speakers::core::{self as K, Opts, Speaker, Turn, Window, Word};
use cut_app::voice::files as V;
use cut_oracle::Inputs;
use serde_json::{Value as Json, json};

fn ask(calls: &[Json]) -> Vec<Json> {
    cut_oracle::ask("scenario/speakers", calls)
}

fn f(rng: &mut Inputs, lo: f64, hi: f64) -> f64 {
    lo + (hi - lo) * (rng.next_u64() % 1_000_000) as f64 / 1_000_000.0
}

const TEXTS: [&str; 8] = ["hi", "볼게요.", "Okay?\"", "yes!", "그래요", "end…)", "no", ""];

/// A transcript in time order: words of random length and pauses, some overlapping, some of no length.
fn words(rng: &mut Inputs, n: usize) -> Vec<Word> {
    let mut t = f(rng, 0.0, 3.0);
    let mut out = Vec::new();
    for _ in 0..n {
        t += match rng.range(0, 9) {
            0 => -f(rng, 0.0, 0.5),
            1..=5 => f(rng, 0.0, 0.25),
            6..=7 => f(rng, 0.3, 1.5),
            _ => f(rng, 2.0, 6.0),
        };
        t = t.max(0.0);
        let len = if rng.range(0, 19) == 0 { 0.0 } else { f(rng, 0.05, 1.2) };
        out.push(Word::new(t, t + len, rng.pick(&TEXTS), None));
    }
    out.sort_by(|a, b| a.t0.total_cmp(&b.t0));
    out
}

fn opts(rng: &mut Inputs) -> Opts {
    let mut o = Opts::default();
    if rng.range(0, 2) == 0 {
        o.gap = f(rng, 0.05, 1.0);
        o.sentences = rng.range(0, 1) == 0;
        o.short = f(rng, 2.0, 6.0);
        o.size = f(rng, 1.0, o.short);
        o.hop = f(rng, 0.3, 2.0);
        o.min = f(rng, 0.2, 2.0);
        o.min_run = f(rng, 0.2, 2.0);
    }
    o
}

/// Words as the JavaScript takes them.
fn js(words: &[Word]) -> Json {
    json!(words.iter().map(|w| json!({ "t0": w.t0, "t1": w.t1, "text": w.text })).collect::<Vec<_>>())
}

fn near(a: f64, b: &Json) -> bool {
    match b.as_f64() {
        Some(b) => a == b || (a - b).abs() <= 1e-9 * (1.0 + a.abs()),
        None => !a.is_finite(),
    }
}

fn windows_eq(got: &[Window], want: &Json) -> bool {
    let want = want.as_array().unwrap();
    got.len() == want.len()
        && got.iter().zip(want).all(|(g, w)| {
            near(g.t0, &w["t0"]) && near(g.t1, &w["t1"]) && near(g.speech, &w["speech"]) && json!(g.seg) == w["seg"]
        })
}

fn turns_eq(got: &[Turn], want: &Json) -> bool {
    let want = want.as_array().unwrap();
    got.len() == want.len()
        && got.iter().zip(want).all(|(g, w)| near(g.0, &w[0]) && near(g.1, &w[1]) && json!(g.2) == w[2])
}

#[test]
fn segments_and_windows_are_the_javascripts() {
    let mut rng = Inputs::new(11);
    let mut cases: Vec<(Vec<Word>, Opts)> = vec![(Vec::new(), Opts::default())];
    cases.push((vec![Word::new(0.0, 9.0, "", None)], Opts::default()));
    cases.push((vec![Word::new(5.0, 5.0, "a.", None)], Opts::default()));
    for n in 0..300 {
        let w = words(&mut rng, (n % 40) + 1);
        let o = opts(&mut rng);
        cases.push((w, o));
    }
    let calls: Vec<Json> =
        cases.iter().flat_map(|(w, o)| [json!(["segments", js(w), o]), json!(["windowsOf", js(w), o])]).collect();
    let answers = ask(&calls);
    for (k, (w, o)) in cases.iter().enumerate() {
        let segs: Vec<[usize; 2]> = K::segments(w, o).into_iter().map(|(a, b)| [a, b]).collect();
        assert_eq!(json!(segs), answers[2 * k], "segments of case {k}");
        assert!(windows_eq(&K::windows_of(w, o), &answers[2 * k + 1]), "windows of case {k}: {}", answers[2 * k + 1]);
    }
}

/// Vectors around `centers` speakers (dimension `dim`), in runs of one speaker.
fn embeddings(rng: &mut Inputs, n: usize, dim: usize, centers: usize, spread: f64) -> Vec<Vec<f64>> {
    let c: Vec<Vec<f64>> = (0..centers).map(|_| (0..dim).map(|_| f(rng, -1.0, 1.0)).collect()).collect();
    let mut who = 0;
    (0..n)
        .map(|i| {
            if i % 4 == 0 {
                who = rng.range(0, centers as i64 - 1) as usize;
            }
            c[who].iter().map(|x| x + spread * f(rng, -1.0, 1.0)).collect()
        })
        .collect()
}

#[test]
fn the_tree_and_its_cuts_are_the_javascripts() {
    let mut rng = Inputs::new(5);
    let mut sets: Vec<Vec<Vec<f64>>> = vec![Vec::new(), vec![vec![1.0, 0.0]]];
    for k in 0..60 {
        let n = (k % 30) + 2;
        let dim = 1 + (k % 7);
        let spread = f(&mut rng, 0.05, 1.5);
        let e = embeddings(&mut rng, n, dim, 1 + k % 4, spread);
        sets.push(
            e.iter()
                .map(|v| {
                    let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
                    v.iter().map(|x| x / n).collect()
                })
                .collect(),
        );
    }
    let answers = ask(&sets.iter().map(|s| json!(["tree", s])).collect::<Vec<_>>());
    let mut cuts = Vec::new();
    for (s, want) in sets.iter().zip(&answers) {
        let got = K::tree(s);
        let w = want.as_array().unwrap();
        assert_eq!(got.len(), w.len());
        for (g, x) in got.iter().zip(w) {
            assert!(json!(g.a) == x["a"] && json!(g.b) == x["b"] && near(g.sim, &x["sim"]), "{g:?} vs {x}");
        }
        for (cut, arg) in
            [(K::Cut::Threshold(0.5), json!({ "threshold": 0.5 })), (K::Cut::Count(2.0), json!({ "count": 2 }))]
        {
            cuts.push((K::cut(s.len(), &got, cut), json!(["cut", s.len(), want, arg])));
        }
    }
    let answers = ask(&cuts.iter().map(|c| c.1.clone()).collect::<Vec<_>>());
    for ((got, _), want) in cuts.iter().zip(answers) {
        assert_eq!(json!(got), want);
    }
}

#[test]
fn the_clustering_is_the_javascripts() {
    let mut rng = Inputs::new(23);
    struct Case {
        emb: Vec<Option<Vec<f64>>>,
        speech: Vec<f64>,
        opts: Opts,
    }
    let mut cases = vec![
        Case { emb: Vec::new(), speech: Vec::new(), opts: Opts::default() },
        Case {
            emb: vec![None, Some(vec![1.0, 0.0]), Some(vec![0.9, 0.1])],
            speech: vec![2.0; 3],
            opts: Opts::default(),
        },
        Case { emb: vec![Some(Vec::new()), Some(vec![0.0, 0.0])], speech: vec![0.1, 0.1], opts: Opts::default() },
    ];
    for k in 0..240 {
        let n = 1 + (k * 7) % 70;
        let dim = 2 + k % 24;
        let spread = f(&mut rng, 0.05, 1.2);
        let e = embeddings(&mut rng, n, dim, 1 + k % 5, spread);
        let emb = e.into_iter().map(|v| (rng.range(0, 30) != 0).then_some(v)).collect();
        let speech =
            (0..n).map(|_| if rng.range(0, 5) == 0 { f(&mut rng, 0.1, 0.8) } else { f(&mut rng, 0.8, 3.0) }).collect();
        let mut opts = Opts::default();
        match k % 6 {
            0 => {}
            1 => opts.count = Some(rng.range(1, 6) as f64),
            2 => opts.threshold = f(&mut rng, 0.1, 0.9),
            3 => {
                opts.count = Some(rng.range(1, 12) as f64);
                opts.spare = rng.range(0, 4) as f64;
            }
            4 => {
                opts.limit = rng.range(2, 20) as f64;
                opts.min_speech = f(&mut rng, 0.5, 6.0);
            }
            _ => {
                opts.trust = f(&mut rng, 0.0, 3.5);
                // a count in (0, 0.5) rounds to 0 speakers, which makes the JavaScript throw (the row offers 1 to 6)
                let c = f(&mut rng, -1.0, 4.4);
                opts.count = Some(if c > 0.0 && c < 0.5 { c + 0.5 } else { c });
            }
        }
        cases.push(Case { emb, speech, opts });
    }
    let answers = ask(&cases.iter().map(|c| json!(["cluster", c.emb, c.speech, c.opts])).collect::<Vec<_>>());
    for (k, (c, want)) in cases.iter().zip(answers).enumerate() {
        let emb: Vec<Option<&[f64]>> = c.emb.iter().map(|e| e.as_deref()).collect();
        assert_eq!(json!(K::cluster(&emb, &c.speech, &c.opts)), want, "case {k}: {:?}", c.opts);
    }
}

/// A comparison of one answer, made before the oracle is asked.
type Check = Box<dyn Fn(&Json) -> bool>;

#[test]
fn words_turns_and_hand_changes_are_the_javascripts() {
    let mut rng = Inputs::new(41);
    let ids = [None, Some("sp1"), Some("sp2"), Some("sp3")];
    let mut calls = Vec::new();
    let mut mine: Vec<Check> = Vec::new();
    for k in 0..400 {
        let w = words(&mut rng, 1 + k % 30);
        let o = if k % 3 == 0 { opts(&mut rng) } else { Opts::default() };
        let win = K::windows_of(&w, &o);
        let labels: Vec<i32> = win.iter().map(|_| rng.range(-1, 3) as i32).collect();
        calls.push(json!(["wordLabels", js(&w), win, labels, o]));
        let got = K::word_labels(&w, &win, &labels, &o);
        mine.push(Box::new(move |a| json!(got) == *a));
        let who: Vec<Option<&str>> = w.iter().map(|_| rng.pick(&ids)).collect();
        calls.push(json!(["turnsOf", js(&w), who]));
        let turns = K::turns_of(&w, &who);
        let t = turns.clone();
        mine.push(Box::new(move |a| turns_eq(&t, a)));
        for _ in 0..4 {
            let at = f(&mut rng, -1.0, 40.0);
            let reach = if rng.range(0, 1) == 0 { 1.0 } else { f(&mut rng, 0.0, 3.0) };
            calls.push(json!(["at", turns, at, reach]));
            let got = K::at(&turns, at, reach).map(str::to_owned);
            mine.push(Box::new(move |a| json!(got) == *a));
        }
        let a = f(&mut rng, -1.0, 30.0);
        let b = a + f(&mut rng, 0.0, 8.0);
        let id = rng.pick(&["sp1", "sp2", "sp9"]);
        calls.push(json!(["assign", turns, a, b, id]));
        let got = K::assign(&turns, a, b, id);
        mine.push(Box::new(move |x| turns_eq(&got, x)));
    }
    let answers = ask(&calls);
    for (k, (check, want)) in mine.iter().zip(&answers).enumerate() {
        assert!(check(want), "call {k}: {} -> {want}", calls[k]);
    }
}

fn turns_map(rng: &mut Inputs, media: &[&str], ids: &[&str]) -> BTreeMap<String, Vec<Turn>> {
    let mut out = BTreeMap::new();
    for m in media {
        if rng.range(0, 3) == 0 {
            continue;
        }
        let mut t = 0.0;
        let mut list = Vec::new();
        for _ in 0..rng.range(0, 6) {
            let a = t + f(rng, 0.0, 1.0);
            t = a + f(rng, 0.1, 5.0);
            list.push((a, t, rng.pick(ids).to_owned()));
        }
        out.insert((*m).to_owned(), list);
    }
    out
}

#[test]
fn matching_new_speakers_and_names_are_the_javascripts() {
    let mut rng = Inputs::new(77);
    let mut calls = Vec::new();
    let mut mine: Vec<Json> = Vec::new();
    for k in 0..200 {
        let old = turns_map(&mut rng, &["m1", "m2", "m3"], &["sp1", "sp2", "sp4", "sp10"]);
        let new = turns_map(&mut rng, &["m1", "m2", "m3"], &["0", "1", "2"]);
        let new_ids: Vec<String> = (0..rng.range(0, 3)).map(|i| i.to_string()).collect();
        calls.push(json!(["match", old, new, new_ids]));
        let matched = K::match_labels(&old, &new, &new_ids);
        mine.push(json!(matched.iter().map(|(a, b)| [a, b]).collect::<Vec<_>>()));
        let before: Vec<Speaker> = ["sp1", "sp2", "sp4", "sp10", "sp007"]
            .iter()
            .enumerate()
            .filter(|_| rng.range(0, 2) != 0)
            .map(|(i, id)| Speaker {
                id: (*id).to_owned(),
                name: if i % 2 == 0 { format!("N{i}") } else { String::new() },
                color: K::PALETTE[(i * 3 + k) % 10].to_owned(),
            })
            .collect();
        let taken: Vec<String> =
            ["sp3", "sp12", "x", "sp"].iter().filter(|_| rng.range(0, 2) == 0).map(|s| (*s).to_owned()).collect();
        let count = rng.range(0, 11) as usize;
        calls.push(json!(["listFor", count, before, matched.iter().map(|(a, b)| [a, b]).collect::<Vec<_>>(), taken]));
        let (list, ids) = K::list_for(count, &before, &matched, &taken);
        mine.push(json!({ "list": list, "ids": ids }));
        let sp = json!({ "list": list });
        for id in ["sp1", "sp2", "sp3", "sp99", ""] {
            calls.push(json!(["nameOf", sp, id]));
            mine.push(json!(K::name_of(&list, id, "Speaker {n}")));
        }
    }
    let answers = ask(&calls);
    for (k, (got, want)) in mine.iter().zip(&answers).enumerate() {
        assert_eq!(got, want, "call {k}: {}", calls[k]);
    }
}

#[test]
fn the_fake_backends_and_the_names_are_the_javascripts() {
    let mut rng = Inputs::new(3);
    let mut calls = Vec::new();
    let mut sounds = Vec::new();
    for n in [0, 1, 319, 320, 321, 16000, 4000] {
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let hz = [300.0, 1500.0, 800.0][n % 3];
                (0.3 * (2.0 * std::f64::consts::PI * hz * i as f64 / 16000.0).sin() + 0.01 * f(&mut rng, -1.0, 1.0))
                    as f32
            })
            .collect();
        calls.push(json!(["fakeEmbedding", x]));
        sounds.push(x);
    }
    let long = ["😀".repeat(40), "a".repeat(90) + ".wav"];
    let names = ["my: talk?.mp4", "", "a.b.c", "...", " x. ", "보이스 녹음.wav", &long[0], &long[1], "con|?.x"];
    for n in &names {
        calls.push(json!(["cleanName", n]));
        calls.push(json!(["fileName", n, "0123456789abcdef"]));
    }
    let media = [
        json!({ "path": "C:\\Media\\Talk.MP4", "size": 1234, "mtime": 1700000000123.0 }),
        json!({ "path": "D:\\x.wav", "size": 1.5, "mtime": null }),
    ];
    let ranges = [(0.0, None), (1.0625, Some(2.0005)), (12.3456, Some(99.9999)), (0.0004, Some(1e6))];
    for m in &media {
        for (a, b) in ranges {
            calls.push(json!(["voiceKey", m, a, b]));
        }
    }
    for (frames, ch) in [(0, 1), (441_000, 2), (1, 1)] {
        calls.push(json!(["wavHeader", frames, ch]));
    }
    let answers = ask(&calls);
    let mut a = answers.iter();
    for x in &sounds {
        let want: Vec<f64> = a.next().unwrap().as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let got = cut_app::speakers::backend::fake_embedding(x);
        assert_eq!(got.len(), want.len());
        for (g, w) in got.iter().zip(&want) {
            assert!((f64::from(*g) - w).abs() <= 1e-6 * (1.0 + w.abs()), "{g} vs {w}");
        }
    }
    for n in &names {
        assert_eq!(json!(V::clean_name(n)), *a.next().unwrap(), "cleanName {n}");
        assert_eq!(json!(V::file_name(n, "0123456789abcdef")), *a.next().unwrap());
    }
    for m in &media {
        let m: cut_model::Media = serde_json::from_value(json!({
            "id": "m1", "name": "x", "path": m["path"], "kind": "audio", "duration": 0, "size": m["size"], "mtime": m["mtime"],
            "video": null, "audio": null,
        }))
        .unwrap();
        for (x, y) in ranges {
            assert_eq!(json!(V::key_of(&m, x, y)), *a.next().unwrap(), "key of {x} {y:?}");
        }
    }
    for (frames, ch) in [(0, 1), (441_000, 2), (1, 1)] {
        assert_eq!(json!(V::wav_header(frames, ch).to_vec()), *a.next().unwrap());
    }
}

#[test]
fn the_embeddings_cache_key_is_the_javascripts() {
    let mut rng = Inputs::new(9);
    let m = json!({ "path": "C:\\Media\\Talk.mp4", "size": 123456, "mtime": 1700000000123.5 });
    let media: cut_model::Media = serde_json::from_value(json!({
        "id": "m1", "name": "x", "path": m["path"], "kind": "audio", "duration": 0, "size": m["size"], "mtime": m["mtime"],
        "video": null, "audio": null,
    }))
    .unwrap();
    let mut lists: Vec<Vec<Window>> = vec![Vec::new()];
    lists.push(vec![
        Window { t0: 0.0625, t1: 1.1875, seg: 0, speech: 1.0 },
        Window { t0: 2.5005, t1: 3.0, seg: 1, speech: 0.5 },
    ]);
    for n in 1..40 {
        lists.push(K::windows_of(&words(&mut rng, n), &Opts::default()));
    }
    let answers = ask(&lists.iter().map(|w| json!(["speakersKey", m, w])).collect::<Vec<_>>());
    for (w, want) in lists.iter().zip(answers) {
        assert_eq!(json!(cut_app::speakers::embed::key_of(&media, w)), want);
    }
}
