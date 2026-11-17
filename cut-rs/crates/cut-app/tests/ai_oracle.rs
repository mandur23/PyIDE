//! The text AI's checks of Claude's answers against the JavaScript's own `ai.js` (`tools/scenarios/ai.cjs`): JSON
//! read out of an answer, caption lines checked, chapters and tags fixed for YouTube, highlights inside the sequence,
//! plans of the whitelist checked, described and turned into commands, captions broken into lines, the review's
//! character diff, and every prompt, on random and nasty inputs and on the model's projects.

use cut_app::ai::captions::{self, Line, Segment};
use cut_app::ai::highlights::{self, Ask, Fit};
use cut_app::ai::{js, lines, metadata, plan};
use cut_app::auto::silence::Plan as Silence;
use cut_model::{Id, Project};
use cut_oracle::Inputs;
use serde_json::{Value as Json, json};

fn ask(calls: &[Json]) -> Vec<Json> {
    cut_oracle::ask("scenario/ai", calls)
}

/// Numbers as floats, so 1 and 1.0 compare equal.
fn norm(v: &Json) -> Json {
    match v {
        Json::Number(n) => json!(n.as_f64()),
        Json::Array(a) => Json::Array(a.iter().map(norm).collect()),
        Json::Object(o) => Json::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        v => v.clone(),
    }
}

/// Compares answers one by one -> how many were compared.
fn compare(what: &str, calls: &[Json], ours: &[Json]) -> usize {
    let theirs = ask(calls);
    let mut bad = Vec::new();
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        if norm(a) != norm(b) {
            bad.push(format!("{what} #{i} {}\n  rust: {a}\n  js:   {b}", calls[i]));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), calls.len(), bad[..bad.len().min(8)].join("\n"));
    calls.len()
}

const WORDS: &[&str] = &[
    "hello",
    "world,",
    "it's",
    "café",
    "naïve",
    "3.5%",
    "x-ray",
    "e.g.",
    "Ok!",
    "really?",
    "end.",
    "안녕하세요",
    "저는",
    "편집자입니다.",
    "오늘은",
    "그래요",
    "했다",
    "됐죠",
    "뭐까",
    "こんにちは",
    "世界",
    "。",
    "、",
    "「引用」",
    "ラーメン",
    "ー",
    "〜",
    "中文",
    "测试",
    "，",
    "！",
    "”",
    "»",
    "…",
    "😀",
    "👍🏽",
    "\t",
    "  ",
    "\n",
    "\r\n",
    "\u{3000}",
    "\u{a0}",
    "\u{2028}",
    "\u{feff}",
    ",",
    ";",
    ":",
    "(note)",
    "[x]",
    "abc'd’e",
    "ABC123",
    "-",
    "--",
    "%%",
    "'",
    "’",
];

fn text(rng: &mut Inputs, n: i64) -> String {
    let k = rng.range(0, n);
    let mut s = String::new();
    for _ in 0..k {
        s.push_str(rng.pick(WORDS));
        if rng.range(0, 3) > 0 {
            s.push(' ');
        }
    }
    s
}

fn langs() -> [Option<&'static str>; 7] {
    [Some("ko"), Some("en"), Some("ja"), Some("zh"), Some("es"), None, Some("fr")]
}

#[test]
fn clocks_json_and_retry_match_the_javascript() {
    let mut rng = Inputs::new(11);
    let mut nums =
        vec![0.0, -0.0, 0.05, 0.95, 0.99, 9.95, 59.95, 59.999_999, 3599.96, 3600.0, 86399.5, 1e7, -5.0, 0.15, 2.25];
    for _ in 0..400 {
        nums.push(rng.range(-1000, 400_000) as f64 / 100.0);
    }
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for x in &nums {
        calls.push(json!(["clock", x]));
        ours.push(json!(js::clock(*x)));
        calls.push(json!(["clockFine", x]));
        ours.push(json!(js::clock_fine(*x)));
    }
    let answers = [
        "```json\n{\"lines\": [{\"i\": 1, \"text\": \"a\"}]}\n```",
        "Here you go:\n```\n[1, 2]\n```\nthanks",
        "```json {\"a\": 1}```",
        "```js\r\n{\"a\": 2}\r\n```",
        "``` \n not json \n``` then {\"b\": 3} after",
        "{\"x\": {\"y\": [1, 2]}} trailing } brace",
        "prefix [1, 2, 3] suffix ]",
        "no json at all",
        "",
        "   ",
        "```\n```",
        "```json\n{\"broken\": \n```\n{\"ok\": true}",
        "```\n{\"first\": 1}\n``` and ```\n{\"second\": 2}\n```",
        "\"just a string\"",
        "42",
        "null",
        "[{\"a\": \"\\u00e9\\n\"}]",
        "{ \"nested\": \"```\" }",
        "text ```json\n[\"a\"]",
    ];
    for a in answers {
        calls.push(json!(["parseJson", a]));
        ours.push(match js::parse_json(a) {
            Ok(v) => json!({ "value": v }),
            Err(e) => json!({ "error": e }),
        });
        let long: String = std::iter::repeat_n(a, 300).collect();
        calls.push(json!(["retryPrompt", "PROMPT", long, "the reason"]));
        ours.push(json!(js::retry_prompt("PROMPT", &long, "the reason")));
    }
    for _ in 0..200 {
        let t = text(&mut rng, 12);
        let wrapped = if rng.range(0, 1) == 0 { format!("```json\n{}\n```", json!({ "t": t })) } else { t.clone() };
        calls.push(json!(["parseJson", wrapped]));
        ours.push(match js::parse_json(&wrapped) {
            Ok(v) => json!({ "value": v }),
            Err(e) => json!({ "error": e }),
        });
    }
    // a number past f64 is Infinity (then null) for JSON.parse, an error for serde_json: the one known difference
    assert!(js::parse_json("{\"t\": 1e400}").is_err());
    let n = compare("js", &calls, &ours);
    eprintln!("{n} comparisons");
}

fn lines_answer(rng: &mut Inputs, ls: &[Line]) -> Json {
    let mut out: Vec<Json> = ls.iter().map(|l| json!({ "i": l.i, "text": format!("{} fixed", l.text) })).collect();
    match rng.range(0, 14) {
        0 => {
            out.pop();
        }
        1 => out.push(json!({ "i": ls.len() + 5, "text": "extra" })),
        2 => {
            if let Some(x) = out.first().cloned() {
                out.push(x);
            }
        }
        3 => out.push(json!({ "i": 1.5, "text": "x" })),
        4 => out.push(json!({ "i": "1", "text": "x" })),
        5 => {
            if let Some(x) = out.first_mut() {
                x["text"] = json!("  \t \r\n  ");
            }
        }
        6 => {
            if let Some(x) = out.first_mut() {
                x["text"] = json!("x".repeat(400));
            }
        }
        7 => {
            if let Some(x) = out.first_mut() {
                x["text"] = json!("a\r\nb\rc \t d\n\n  e  ");
            }
        }
        8 => return json!({ "line": out }),
        9 => return json!(out),
        10 => out.push(json!(null)),
        11 => {
            if let Some(x) = out.first_mut() {
                x["i"] = json!(1.0);
            }
        }
        12 => out.clear(),
        _ => {}
    }
    json!({ "lines": out })
}

#[test]
fn caption_prompts_condense_and_lines_match_the_javascript() {
    let mut rng = Inputs::new(22);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    calls.push(json!(["system"]));
    ours.push(json!(captions::SYSTEM));
    for round in 0..160 {
        let n = rng.range(0, 70) as usize;
        let ls: Vec<Line> = (0..n).map(|k| Line { i: k as i64 + 1, text: text(&mut rng, 8) }).collect();
        let lj: Vec<Json> = ls.iter().map(|l| json!({ "i": l.i, "text": l.text })).collect();
        let lang = langs()[round % 7];
        calls.push(json!(["polishPrompt", lj, lang]));
        ours.push(json!(captions::polish_prompt(&ls, lang)));
        calls.push(json!(["translatePrompt", lj, lang, langs()[(round + 3) % 7]]));
        ours.push(json!(captions::translate_prompt(&ls, lang, langs()[(round + 3) % 7])));
        let answer = lines_answer(&mut rng, &ls);
        calls.push(json!(["validateLines", answer, lj]));
        ours.push(match captions::validate_lines(&answer, &ls) {
            Ok(m) => {
                let mut v: Vec<(i64, String)> = m.into_iter().collect();
                v.sort();
                json!({ "value": v })
            }
            Err(e) => json!({ "error": e }),
        });
        let t = cut_time::TICKS as f64;
        let segs: Vec<Segment> = (0..rng.range(0, 300))
            .map(|k| Segment { start: k as f64 * t * 1.37, end: (k as f64 + 1.2) * t, text: text(&mut rng, 30) })
            .collect();
        let sj: Vec<Json> = segs.iter().map(|s| json!({ "start": s.start, "end": s.end, "text": s.text })).collect();
        let budget = [30000, 2000, 500, 80, 10, 1][round % 6];
        let line_max = [200, 20, 5, 1][round % 4];
        calls.push(json!(["condense", sj, { "budget": budget, "lineMax": line_max }]));
        let c = captions::condense(&segs, budget, line_max);
        ours.push(json!({ "text": c.text, "trimmed": c.trimmed, "lines": c.lines, "kept": c.kept }));
    }
    let n = compare("captions", &calls, &ours);
    eprintln!("{n} comparisons");
}

#[test]
fn line_breaks_and_the_review_diff_match_the_javascript() {
    let mut rng = Inputs::new(33);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for round in 0..900 {
        let t = text(&mut rng, 14);
        let lang = langs()[round % 7];
        let max_chars = [0, 0, 5, 10, 30][round % 5];
        let max_lines = [2, 1, 3][round % 3];
        calls.push(json!(["lineBreak", t, lang, max_chars, max_lines]));
        ours.push(json!(lines::line_break(&t, lang, max_chars, max_lines)));
        let before = if rng.range(0, 1) == 0 {
            format!("{}\n{}", text(&mut rng, 4), text(&mut rng, 4))
        } else {
            text(&mut rng, 6)
        };
        let after =
            if rng.range(0, 1) == 0 { format!("{}\n{}", text(&mut rng, 4), text(&mut rng, 4)) } else { t.clone() };
        calls.push(json!(["keepLines", before, after, lang]));
        ours.push(json!(lines::keep_lines(&before, &after, lang)));
        calls.push(json!(["cjkTokens", t]));
        ours.push(json!(lines::cjk_tokens(&t)));
        calls.push(json!(["diffChars", before, after]));
        let d: Vec<Json> =
            lines::diff_chars(&before, &after).iter().map(|(o, s)| json!({ "op": o.sign(), "s": s })).collect();
        ours.push(json!(d));
    }
    let big = "가".repeat(600);
    calls.push(json!(["diffChars", big, "나".repeat(500)]));
    let d: Vec<Json> =
        lines::diff_chars(&big, &"나".repeat(500)).iter().map(|(o, s)| json!({ "op": o.sign(), "s": s })).collect();
    ours.push(json!(d));
    let n = compare("lines", &calls, &ours);
    eprintln!("{n} comparisons");
}

fn chapters(rng: &mut Inputs, seconds: f64) -> Json {
    let n = rng.range(0, 9);
    let mut out = Vec::new();
    for _ in 0..n {
        let t = match rng.range(0, 6) {
            0 => json!(rng.range(-20, (seconds as i64).max(1) + 30)),
            1 => json!(rng.range(0, (seconds as i64 * 10).max(1)) as f64 / 10.0),
            2 => json!("12"),
            3 => json!(null),
            _ => json!(rng.range(0, (seconds as i64).max(1))),
        };
        let title = match rng.range(0, 5) {
            0 => json!("   "),
            1 => json!(42),
            2 => json!("x".repeat(140)),
            _ => json!(text(rng, 5)),
        };
        out.push(if rng.range(0, 12) == 0 { json!([t, title]) } else { json!({ "t": t, "title": title }) });
    }
    if rng.range(0, 10) == 0 { json!({ "not": "a list" }) } else { json!(out) }
}

fn tags(rng: &mut Inputs) -> Json {
    let pool =
        ["#Tag", "##two", "a,b", "<x>", "tag", "TAG", "  spaced   out ", "", "#", "x".repeat(101).leak(), "카테고리"];
    let mut out: Vec<Json> = (0..rng.range(0, 60)).map(|_| json!(rng.pick(&pool))).collect();
    if rng.range(0, 6) == 0 {
        out.push(json!(5));
    }
    json!(out)
}

#[test]
fn youtube_metadata_matches_the_javascript() {
    let mut rng = Inputs::new(44);
    let t = cut_time::TICKS as f64;
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for round in 0..400 {
        let seconds = [5.0, 29.9, 30.0, 31.0, 45.5, 120.0, 3600.0, 7322.4][round % 8];
        let duration = seconds * t;
        let ch = chapters(&mut rng, seconds);
        calls.push(json!(["fixChapters", ch, seconds, "Intro"]));
        let (c, fixed) = metadata::fix_chapters(&ch, seconds, "Intro");
        let cj: Vec<Json> = c.iter().map(|c| json!({ "t": c.t, "title": c.title })).collect();
        ours.push(json!({ "chapters": cj, "fixed": fixed }));
        calls.push(json!(["chapterText", cj]));
        ours.push(json!(metadata::chapter_text(&c)));
        let tg = tags(&mut rng);
        calls.push(json!(["cleanTags", tg]));
        ours.push(json!(metadata::clean_tags(&tg)));
        let mut value = json!({
            "titles": (0..rng.range(0, 8)).map(|_| json!(text(&mut rng, 4))).collect::<Vec<_>>(),
            "description": format!("{}\r\n\r\n{}", text(&mut rng, 20), "y".repeat([0, 10, 6000][round % 3])),
            "chapters": ch,
            "tags": tg,
        });
        match rng.range(0, 9) {
            0 => value["titles"] = json!("one"),
            1 => value["description"] = json!("  "),
            2 => value["chapters"] = json!(null),
            3 => value["tags"] = json!("a, b"),
            4 => value = json!([1]),
            5 => value["titles"] = json!(["same", "same", "  same  ", "other"]),
            _ => {}
        }
        calls.push(json!(["validateMetadata", value, duration, "Intro"]));
        ours.push(match metadata::validate_metadata(&value, duration, "Intro") {
            Ok(m) => json!({ "value": {
                "titles": m.titles, "description": m.description,
                "chapters": m.chapters.iter().map(|c| json!({ "t": c.t, "title": c.title })).collect::<Vec<_>>(),
                "tags": m.tags, "fixed": m.fixed,
            } }),
            Err(e) => json!({ "error": e }),
        });
        let markers: Vec<(f64, &str, String)> = (0..rng.range(0, 4))
            .map(|k| (k as f64 * t * 3.3, ["comment", "chapter", "beat"][k as usize % 3], text(&mut rng, 3)))
            .collect();
        let ml: Vec<metadata::MarkerLine> =
            markers.iter().map(|(t, k, n)| metadata::MarkerLine { t: *t, kind: k, name: n }).collect();
        let mj: Vec<Json> = markers.iter().map(|(t, k, n)| json!({ "t": t, "kind": k, "name": n })).collect();
        let name = text(&mut rng, 3);
        let tr = if round % 5 == 0 { String::new() } else { text(&mut rng, 10) };
        calls.push(json!(["metadataPrompt", { "name": name, "duration": duration, "transcript": tr, "markers": mj }]));
        ours.push(json!(metadata::metadata_prompt(&name, duration, &tr, &ml)));
    }
    let n = compare("metadata", &calls, &ours);
    eprintln!("{n} comparisons");
}

#[test]
fn highlights_match_the_javascript() {
    let mut rng = Inputs::new(55);
    let t = cut_time::TICKS as f64;
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for round in 0..600 {
        let seconds = [12.0, 60.0, 95.5, 600.0, 3600.0][round % 5];
        let duration = seconds * t;
        let frame = [t / 30.0, t * 1001.0 / 30000.0, t / 25.0, t / 60.0][round % 4];
        let o = Ask {
            count: [1.0, 3.0, 5.0, 10.0][round % 4],
            min: [3.0, 15.0, 10.0][round % 3],
            max: [20.0, 60.0, 30.0][round % 3],
        };
        let mut list = Vec::new();
        for _ in 0..rng.range(0, 6) {
            let a = rng.range(-10, (seconds * 10.0) as i64 + 10) as f64 / 10.0;
            let len = rng.range(0, 700) as f64 / 10.0;
            let h = match rng.range(0, 10) {
                0 => json!({ "start": a }),
                1 => json!({ "start": format!("{a}"), "end": a + len }),
                2 => json!([a, a + len]),
                3 => json!({ "start": a, "end": a - 1.0, "title": 5 }),
                _ => {
                    json!({ "start": a, "end": a + len, "title": text(&mut rng, 3), "reason": "r".repeat(rng.range(0, 400) as usize) })
                }
            };
            list.push(h);
        }
        let value = if round % 17 == 0 { json!({ "highlight": list }) } else { json!({ "highlights": list }) };
        let oj = json!({ "duration": duration, "count": o.count, "min": o.min, "max": o.max, "frame": frame });
        calls.push(json!(["validateHighlights", value, oj]));
        ours.push(match highlights::validate_highlights(&value, duration, o, frame) {
            Ok(v) => json!({ "value": v.iter().map(|h| json!({ "start": h.start, "end": h.end, "title": h.title, "reason": h.reason })).collect::<Vec<_>>() }),
            Err(e) => json!({ "error": e }),
        });
        let tr = if round % 4 == 0 { String::new() } else { text(&mut rng, 6) };
        calls.push(json!(["highlightsPrompt", { "duration": duration, "transcript": tr, "count": o.count, "min": o.min, "max": o.max }]));
        ours.push(json!(highlights::highlights_prompt(duration, &tr, o)));
        let mut keep: Vec<(f64, f64)> = (0..rng.range(0, 5))
            .map(|_| {
                let a = rng.range(0, 100) as f64;
                (a, a + rng.range(0, 30) as f64)
            })
            .collect();
        keep.sort_by(|a, b| a.0.total_cmp(&b.0));
        calls.push(json!(["complement", keep, 120.0]));
        ours.push(json!(highlights::complement(&keep, 120.0)));
    }
    let n = compare("highlights", &calls, &ours);
    eprintln!("{n} comparisons");
}

/// A plan value for the checks: mostly allowed operations with right and wrong fields.
fn plan_value(rng: &mut Inputs, end: f64, clips: &[String], tracks: &[String]) -> Json {
    let mut ops = Vec::new();
    for _ in 0..rng.range(0, 7) {
        let time = |rng: &mut Inputs| match rng.range(0, 8) {
            0 => json!(-0.04),
            1 => json!(end + 0.4),
            2 => json!(end + 3.0),
            3 => json!("5"),
            _ => json!(rng.range(0, (end * 10.0) as i64 + 1) as f64 / 10.0),
        };
        let db = |rng: &mut Inputs| json!([-6.0, 3.5, 40.0, -41.0, 0.0][rng.range(0, 4) as usize]);
        let o = match rng.range(0, 13) {
            0 => json!({ "op": "cut", "from": time(rng), "to": time(rng) }),
            1 => json!({ "op": "lift", "from": time(rng), "to": time(rng) }),
            2 => json!({ "op": "split", "at": time(rng) }),
            3 => {
                let name = ["Intro", "  a  b ", "", "x"][rng.range(0, 3) as usize];
                let kind =
                    [json!("chapter"), json!("comment"), json!("beat"), Json::Null][rng.range(0, 3) as usize].clone();
                json!({ "op": "marker", "at": time(rng), "name": name, "kind": kind })
            }
            4 => {
                let kind = ["comment", "chapter", "beat", "all", "x"][rng.range(0, 4) as usize];
                json!({ "op": "removeMarkers", "kind": kind })
            }
            5 => {
                let which = match rng.range(0, 9) {
                    0 => json!("all"),
                    1 => json!("selected"),
                    2 => json!("dialogue"),
                    3 => json!("music"),
                    4 => json!("loud"),
                    5 => json!([]),
                    6 => json!(["nope"]),
                    _ => json!(clips.iter().take(rng.range(1, 4) as usize).chain(clips.first()).collect::<Vec<_>>()),
                };
                json!({ "op": "clipVolume", "clips": which, "db": db(rng) })
            }
            6 => {
                json!({ "op": "trackVolume", "track": tracks.get(rng.range(0, tracks.len() as i64) as usize).cloned().map_or(json!(7), Json::from), "db": db(rng) })
            }
            7 => json!({ "op": "masterGain", "db": db(rng) }),
            8 => {
                let long = [0.5, 0.05, 61.0, 2.0][rng.range(0, 3) as usize];
                let thr = [json!(-40.0), json!(-4.0), json!(-91.0), Json::Null][rng.range(0, 3) as usize].clone();
                json!({ "op": "removeSilence", "longerThan": long, "threshold": thr })
            }
            9 => json!({ "op": "explode" }),
            10 => json!({ "op": "split", "at": 1.0, "extra": true }),
            11 => json!({ "op": "cut", "from": null, "to": 1.0 }),
            _ => json!("split"),
        };
        ops.push(o);
    }
    match rng.range(0, 14) {
        0 => json!({ "ops": ops, "message": 5 }),
        1 => json!({ "ops": ops, "note": "x" }),
        2 => json!({ "op": ops }),
        3 => json!({ "ops": ops, "message": format!("  {}  ", "m".repeat(rng.range(0, 700) as usize)) }),
        _ => json!({ "ops": ops }),
    }
}

fn silence_for(rng: &mut Inputs, ops: &[plan::Op], seq: &cut_model::Sequence) -> Vec<Option<Silence>> {
    let t = cut_time::TICKS as f64;
    ops.iter()
        .map(|o| {
            matches!(o, plan::Op::RemoveSilence { .. }).then(|| {
                let mut at = 0.0;
                let ranges = (0..rng.range(0, 4))
                    .map(|_| {
                        at += rng.range(1, 30) as f64 * t / 10.0;
                        let r = (at, at + rng.range(1, 10) as f64 * t / 10.0);
                        at = r.1;
                        r
                    })
                    .collect();
                let tracks: Vec<Id> = seq.tracks.iter().filter(|_| rng.range(0, 1) == 0).map(|t| t.id).collect();
                Silence { ranges, changed: tracks.clone(), tracks }
            })
        })
        .collect()
}

#[test]
fn plans_and_sequence_summaries_match_the_javascript() {
    let projects: Vec<String> =
        ask(&[json!(["projects"])])[0].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
    assert!(projects.len() >= 10, "the model's projects");
    let mut rng = Inputs::new(66);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for text in &projects {
        let Ok(p) = Project::load_migrating(text) else { continue };
        for seq in &p.sequences {
            let sid = seq.id.as_str();
            let clips: Vec<String> = seq.clips_in_order().map(|c| c.id.as_str().to_owned()).collect();
            let selection: Vec<String> = clips.iter().filter(|_| rng.range(0, 2) == 0).cloned().collect();
            for max in [150, 2] {
                calls.push(json!(["sequenceSummary", text, sid, selection, max]));
                ours.push(json!(plan::sequence_summary(&p, seq, &selection, max)));
            }
            let summary = plan::sequence_summary(&p, seq, &selection, 150);
            calls.push(json!(["commandPrompt", "cut  the\n first 10 s", summary, ""]));
            ours.push(json!(plan::command_prompt("cut  the\n first 10 s", &summary, "")));
            for mode in [Fit::Fill, Fit::Fit] {
                calls.push(json!(["shortsEdits", text, sid, mode.id()]));
                ours.push(json!(highlights::shorts_edits(&p, seq, mode)));
            }
            let ctx = plan::Context::of(seq, &Default::default());
            let ctx = plan::Context { selection: selection.clone(), ..ctx };
            let tracks: Vec<String> = ctx.tracks.iter().map(|t| t.0.clone()).collect();
            let ctx_json = json!({
                "duration": ctx.duration,
                "tracks": ctx.tracks.iter().map(|(id, k)| json!({ "id": id, "kind": plan::kind_word(*k) })).collect::<Vec<_>>(),
                "clips": ctx.clips, "selection": ctx.selection,
            });
            let end = ctx.duration / js::T;
            for _ in 0..12 {
                let value = plan_value(&mut rng, end, &clips, &tracks);
                calls.push(json!(["validatePlan", value, ctx_json]));
                let checked = plan::validate_plan(&value, &ctx);
                ours.push(match &checked {
                    Ok(pl) => json!({ "value": pl.to_json() }),
                    Err(e) => json!({ "error": e }),
                });
                let Ok(pl) = checked else { continue };
                let ops: Vec<Json> = pl.ops.iter().map(plan::Op::to_json).collect();
                let silence = silence_for(&mut rng, &pl.ops, seq);
                let sj: Vec<Json> = silence
                    .iter()
                    .map(|s| match s {
                        Some(s) => json!({ "ranges": s.ranges, "tracks": s.tracks.iter().map(|t| t.as_str()).collect::<Vec<_>>() }),
                        None => json!(null),
                    })
                    .collect();
                calls.push(json!(["planCommands", text, sid, ops, selection, sj]));
                ours.push(json!(plan::plan_commands(&pl.ops, seq, &selection, &silence)));
                calls.push(json!(["describePlan", text, sid, ops, selection, sj]));
                let d: Vec<Json> = plan::describe_plan(&pl.ops, seq, &selection, &silence)
                    .into_iter()
                    .map(|(t, ps)| json!({ "text": t, "params": ps.into_iter().map(|(k, v)| (k.to_owned(), json!(v))).collect::<serde_json::Map<_, _>>() }))
                    .collect();
                ours.push(json!(d));
            }
            for which in [
                json!("all"),
                json!("selected"),
                json!("dialogue"),
                json!("music"),
                json!(clips.iter().take(3).collect::<Vec<_>>()),
            ] {
                let value = json!({ "ops": [{ "op": "clipVolume", "clips": which, "db": 1 }] });
                let Ok(pl) = plan::validate_plan(&value, &ctx) else { continue };
                let plan::Op::ClipVolume { clips: c, .. } = &pl.ops[0] else { continue };
                calls.push(json!(["volumeClips", text, sid, which, selection]));
                ours.push(json!(
                    plan::volume_clips(seq, c, &selection).iter().map(|c| c.id.as_str()).collect::<Vec<_>>()
                ));
            }
        }
    }
    let n = compare("plans", &calls, &ours);
    eprintln!("{n} comparisons on {} projects", projects.len());
}
