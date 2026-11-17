//! Speech recognition's pure parts against the JavaScript's own functions: `speech-words.js` (levels, bursts, the
//! fake model, refine) through `tools/scenarios/speech.cjs`, and `speech.js` (windows, joining windows, captions,
//! fillers, removal ranges, the word list, search, clip words) through the oracle, on generated inputs including
//! the nasty ones (empty, silent, full scale, overlapping, unsorted, punctuation only).

use cut_app::speech::text::{self, CaptionOpts, FillerOpts, WindowWords, Word};
use cut_app::speech::words::{self, Heard};
use cut_oracle::{Inputs, ask, bytes};
use serde_json::{Value as Json, json};

const T: f64 = cut_time::TICKS as f64;

/// Equal as JSON, numbers within a part in 10^9 (the JavaScript writes 3 where Rust has 3.0).
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0)
        }
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn check(what: &str, rust: &[Json], js: &[Json]) {
    assert_eq!(rust.len(), js.len());
    for (i, (r, j)) in rust.iter().zip(js).enumerate() {
        assert!(same(r, j), "{what} #{i}:\n rust {r}\n js   {j}");
    }
}

fn f32_bytes(x: &[f32]) -> Json {
    bytes(&x.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
}

/// Sound of `secs` with bursts of tone (and some noise, some full scale) at random places.
fn signal(rng: &mut Inputs, secs: f64) -> Vec<f32> {
    let n = (secs * 16000.0) as usize;
    let mut x = vec![0f32; n];
    let kind = rng.range(0, 5);
    if kind == 0 {
        return x;
    }
    let mut at = rng.range(0, 8000) as usize;
    while at < n {
        let len = rng.range(160, 16000) as usize;
        let amp = [0.002f32, 0.05, 0.3, 1.0][rng.range(0, 3) as usize];
        let f = rng.range(100, 3000) as f32;
        for (i, v) in x.iter_mut().enumerate().take((at + len).min(n)).skip(at) {
            let noise = ((rng.next_u64() % 2001) as f32 / 1000.0 - 1.0) * if kind == 4 { 0.02 } else { 0.0 };
            *v = amp * (std::f32::consts::TAU * f * i as f32 / 16000.0).sin() + noise;
        }
        at += len + rng.range(0, 24000) as usize;
    }
    x
}

fn heard_json(w: &Heard) -> Json {
    match w.p {
        Some(p) => json!([w.t0, w.t1, w.text, p]),
        None => json!([w.t0, w.t1, w.text]),
    }
}

#[test]
fn speech_words_match_the_javascript() {
    let mut rng = Inputs::new(7);
    let (mut calls, mut rust) = (Vec::new(), Vec::new());
    for k in 0..60 {
        let secs = [0.0, 0.004, 0.5, 3.0, 12.0, 31.0][k % 6];
        let x = signal(&mut rng, secs);
        let b = f32_bytes(&x);
        calls.push(json!(["frameDb", b]));
        rust.push(json!(words::frame_db(&x)));
        calls.push(json!(["bursts", b]));
        rust.push(json!(words::bursts(&x).iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()));
        let total = x.len() as u64 + rng.range(0, 1) as u64 * 32000;
        let offset = rng.range(0, 1) as u64 * rng.range(0, 480000) as u64;
        let english = rng.range(0, 1) == 1;
        let terms: Vec<String> = if rng.range(0, 1) == 1 { vec!["Nano Studio".into()] } else { Vec::new() };
        calls.push(json!(["fakeWords", b, { "offset": offset, "total": total + offset, "language": if english { "en" } else { "ko" }, "terms": terms }]));
        rust.push(json!(
            words::fake_words(&x, offset, total + offset, english, &terms).iter().map(heard_json).collect::<Vec<_>>()
        ));
        // Whisper's words: spans over the sound and the pauses, some the first of a segment, some without p
        let secs = x.len() as f64 / 16000.0;
        let mut ws = Vec::new();
        let mut t = rng.range(0, 500) as f64 / 1000.0 - 0.1;
        while t < secs + 0.5 {
            let d = rng.range(20, 1500) as f64 / 1000.0;
            let p = (rng.range(0, 3) > 0).then(|| rng.range(1, 999) as f64 / 1000.0);
            ws.push(Heard { t0: t, t1: t + d, text: format!("w{}", ws.len()), lead: rng.range(0, 3) == 0, p });
            t += d + rng.range(0, 800) as f64 / 1000.0 - 0.1;
        }
        let input: Vec<Json> = ws
            .iter()
            .map(|w| {
                let mut v = json!([w.t0, w.t1, w.text, if w.lead { 1 } else { 0 }]);
                if let Some(p) = w.p {
                    v.as_array_mut().unwrap().push(json!(p));
                }
                v
            })
            .collect();
        calls.push(json!(["refine", b, input]));
        rust.push(json!(words::refine(&x, &ws).iter().map(heard_json).collect::<Vec<_>>()));
    }
    let js = ask_scenario_cjs("speech", &calls);
    check("speech-words", &rust, &js);
    eprintln!("{} speech-words calls compared", calls.len());
}

/// `scenario/<name>` runs `tools/scenarios/<name>.cjs`.
fn ask_scenario_cjs(name: &str, calls: &[Json]) -> Vec<Json> {
    ask(&format!("scenario/{name}"), calls)
}

const VOCAB: [&str; 34] = [
    "안녕하세요",
    "음",
    "어",
    "으음",
    "그",
    "저",
    "뭐",
    "오늘은",
    "자막을",
    "만들어",
    "봅니다.",
    "했어요",
    "그렇죠",
    "할까",
    "um",
    "uh",
    "er",
    "hmm",
    "Hello,",
    "world.",
    "This",
    "is",
    "easy!",
    "\"quoted.\"",
    "Nano",
    "Studio,",
    "제주도,",
    "한라산,",
    "롯데월드",
    "...",
    "그...",
    "a-",
    "",
    "verylongwordthatdoesnotfitonaline",
];

fn word_list(rng: &mut Inputs, n: usize, ticks: bool) -> Vec<Word> {
    let unit = if ticks { T } else { 1.0 };
    let mut t = rng.range(0, 3000) as f64 / 1000.0;
    (0..n)
        .map(|_| {
            let d = rng.range(50, 900) as f64 / 1000.0;
            let text = VOCAB[rng.range(0, VOCAB.len() as i64 - 1) as usize];
            let p = (rng.range(0, 3) > 0).then(|| rng.range(1, 1000) as f64 / 1000.0);
            let w = Word::new(t * unit, (t + d) * unit, text, p);
            t += d + [0.0, 0.05, 0.2, 0.4, 0.7, 1.3, 3.0][rng.range(0, 6) as usize];
            w
        })
        .collect()
}

fn word_json(w: &Word) -> Json {
    let mut v = json!({ "t0": w.t0, "t1": w.t1, "text": w.text });
    if let Some(p) = w.p {
        v["p"] = json!(p);
    }
    v
}

fn words_json(ws: &[Word]) -> Json {
    Json::Array(ws.iter().map(word_json).collect())
}

fn caption_json(c: &text::Caption) -> Json {
    let mut v = json!({
        "start": c.start, "end": c.end, "text": c.text,
        "words": c.words.iter().map(|(a, b, t)| json!({ "t0": a, "t1": b, "text": t })).collect::<Vec<_>>(),
    });
    if !c.doubt.is_empty() {
        v["doubt"] = c.doubt.iter().map(|(at, t, p)| json!({ "at": at, "text": t, "p": p })).collect();
    }
    v
}

#[test]
fn speech_js_matches_the_javascript() {
    let mut rng = Inputs::new(11);
    let (mut calls, mut rust) = (Vec::new(), Vec::new());
    let frames = [1.0, 2_116_800.0, 1_411_200.0, 1_694_000.0];
    for k in 0..80 {
        let n = [0, 1, 2, 5, 12, 40][k % 6];
        let ws = word_list(&mut rng, n, true);
        let frame = frames[k % frames.len()];
        let o = CaptionOpts {
            frame,
            max_chars: [0, 0, 10, 30][k % 4],
            uncertain: [0.5, 0.0, 0.9][k % 3],
            ..CaptionOpts::default()
        };
        calls.push(
            json!(["captions", words_json(&ws), { "frame": frame, "maxChars": o.max_chars, "uncertain": o.uncertain }]),
        );
        rust.push(Json::Array(text::captions(&ws, &o).iter().map(caption_json).collect()));
        let fo = FillerOpts {
            fillers: k % 5 != 0,
            pauses: k % 7 != 0,
            pause_length: [1.0, 0.3, 2.5][k % 3],
            keep: [0.15, 0.0, 0.4][k % 3],
        };
        let plan = text::filler_plan(&ws, &fo, frame);
        calls.push(json!(["fillerPlan", words_json(&ws), { "fillers": fo.fillers, "pauses": fo.pauses, "pauseLength": fo.pause_length, "keep": fo.keep, "frame": frame }]));
        let ranges = |r: &[(f64, f64)]| r.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>();
        rust.push(json!({ "fillers": plan.fillers, "pauses": ranges(&plan.pauses), "ranges": ranges(&plan.ranges) }));
        for i in 0..ws.len() {
            calls.push(json!(["isFiller", words_json(&ws), i, { "pause": 0.3 * T }]));
            rust.push(json!(text::is_filler(&ws, i, 0.3 * T)));
        }
        if !ws.is_empty() {
            let pick: Vec<usize> = (0..ws.len()).filter(|_| rng.range(0, 2) == 0).collect();
            calls.push(json!(["removalRanges", words_json(&ws), pick, { "frame": frame }]));
            rust.push(json!(ranges(&text::removal_ranges(&ws, &pick, frame))));
            let q = [ws[0].text.clone(), "음".into(), "nano studio".into(), "HELLO".into(), " ".into()][k % 5].clone();
            calls.push(json!(["search", words_json(&ws), q]));
            rust.push(json!(text::search(&ws, &q).iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()));
            calls.push(json!(["runs", pick]));
            rust.push(json!(text::runs(&pick).iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()));
            let t = ws[ws.len() / 2].t0 + 1.0;
            calls.push(json!(["wordAt", words_json(&ws), t]));
            rust.push(json!(text::word_at(&ws, t).map_or(-1, |i| i as i64)));
        }
        // seconds: dedupe, and the echo of a word list
        let secs = word_list(&mut rng, n, false);
        let mut twice = secs.clone();
        twice.extend(secs.iter().take(3).map(|w| Word { t0: w.t0 + 0.1, t1: w.t1 + 0.1, ..w.clone() }));
        twice.sort_by(|a, b| a.t0.total_cmp(&b.t0));
        calls.push(json!(["dedupe", words_json(&twice)]));
        rust.push(words_json(&text::dedupe(twice.clone())));
        let terms = vec!["제주도".to_owned(), "한라산".into(), "Nano Studio".into()];
        let heard: Vec<Heard> =
            secs.iter().map(|w| Heard { t0: w.t0, t1: w.t1, text: w.text.clone(), lead: false, p: w.p }).collect();
        calls.push(json!(["dropEcho", heard.iter().map(heard_json).collect::<Vec<_>>(), terms]));
        rust.push(json!(text::drop_echo(heard.clone(), &terms).iter().map(heard_json).collect::<Vec<_>>()));
        calls.push(json!([
            "textStop",
            heard.iter().map(heard_json).collect::<Vec<_>>(),
            if k % 2 == 0 { json!(12.5) } else { Json::Null }
        ]));
        rust.push(json!(text::text_stop(&heard, if k % 2 == 0 { Some(12.5) } else { None })));
    }
    // windows and their joining
    for total in [0i64, 1, 16000, 480000, 480001, 560000, 1_000_000, 16000 * 600] {
        calls.push(json!(["windows", total]));
        rust.push(json!(text::windows(total).iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()));
        for (from, end, again) in [
            (0, None, true),
            (0, Some(4.0), true),
            (0, Some(0.5), true),
            (0, Some(26.0), true),
            (80000, Some(10.0), false),
        ] {
            let to = total.min(from + 480000);
            let s = text::next_window(from, to, end, total, again);
            calls.push(json!(["nextWindow", from, to, end, { "total": total, "again": again }]));
            let mut v = json!({ "next": s.next });
            if let Some(u) = s.until {
                v["until"] = json!(u);
            }
            rust.push(v);
        }
    }
    for k in 0..30 {
        let mut results = Vec::new();
        let mut from = 0i64;
        for w in 0..(k % 5 + 1) {
            let to = from + 480000;
            let ws: Vec<Heard> = word_list(&mut rng, 25, false)
                .into_iter()
                .filter(|x| x.t1 < 30.5)
                .map(|x| Heard { t0: x.t0, t1: x.t1, text: format!(" {} ", x.text), lead: false, p: x.p })
                .collect();
            let until = (w % 3 == 1).then_some(from + 320000);
            results.push(WindowWords { from, to, until, words: ws });
            from = until.unwrap_or(to - 80000);
        }
        let js: Vec<Json> = results
            .iter()
            .map(|r| json!({ "from": r.from, "to": r.to, "until": r.until, "words": r.words.iter().map(heard_json).collect::<Vec<_>>() }))
            .collect();
        calls.push(json!(["mergeWindows", js]));
        rust.push(words_json(&text::merge_windows(&results)));
    }
    for t in ["", "a, b\nc", " Nano   Studio ,nano studio;제주도、한라산，x", &"x".repeat(150), ",,,\n\n"] {
        calls.push(json!(["parseTerms", t]));
        rust.push(json!(text::parse_terms(t)));
        let terms = text::parse_terms(t);
        calls.push(json!(["termsKey", terms]));
        rust.push(json!(text::terms_key(&terms)));
    }
    for t in ["Hello, World!", "안녕하세요.", "  ...  ", "«Ça» va?", "ÄÖ—ü", ""] {
        calls.push(json!(["normalize", t]));
        rust.push(json!(text::normalize(t)));
    }
    let js = ask("speech", &calls);
    check("speech.js", &rust, &js);
    eprintln!("{} speech.js calls compared", calls.len());
}

#[test]
fn clip_words_match_the_javascript() {
    let mut rng = Inputs::new(3);
    let words = word_list(&mut rng, 60, false);
    let (mut calls, mut rust) = (Vec::new(), Vec::new());
    for (speed, reverse, freeze) in [(1.0, false, false), (2.0, false, false), (0.5, true, false), (1.0, false, true)] {
        let (inp, out) = (5.0 * T, 25.0 * T);
        let clip = json!({
            "id": "c1", "track": "A1", "start": (100.0 * T) as i64, "in": inp as i64, "out": out as i64, "speed": speed, "reverse": reverse,
            "enabled": true, "source": { "media": "m1", "freeze": freeze },
        });
        let c = clip_of(&clip);
        calls.push(json!(["clipWords", clip, words_json(&words)]));
        rust.push(Json::Array(
            text::clip_words(&c, &words)
                .iter()
                .map(|w| {
                    let mut v = word_json(w);
                    v["clip"] = json!("c1");
                    v["src"] = json!(w.src);
                    v
                })
                .collect(),
        ));
    }
    let js = ask("speech", &calls);
    check("clipWords", &rust, &js);
    assert!(rust[..3].iter().all(|r| r.as_array().is_some_and(|a| a.len() > 5)), "the moving clips show words");
    assert_eq!(rust[3], json!([]), "a freeze frame shows none");
}

/// A clip read the way a project file is read (`Project::load`), in a sequence with its media.
fn clip_of(clip: &Json) -> cut_model::Clip {
    let p = json!({
        "format": "ncut", "version": 5,
        "media": [{ "id": "m1", "kind": "audio", "name": "talk.wav", "path": "C:\talk.wav", "duration": (60.0 * T) as i64,
            "audio": { "rate": 48000, "channels": 2 } }],
        "sequences": [{ "id": "s1", "name": "Sequence 1", "fps": [30, 1], "w": 1280, "h": 720,
            "tracks": [{ "id": "A1", "kind": "audio" }], "clips": [clip] }],
    });
    let p = cut_model::Project::load(&p.to_string()).expect("the project loads");
    p.sequences[0].clips().next().expect("its clip").clone()
}
