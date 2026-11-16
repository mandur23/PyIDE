//! `cut_model::captionwords` against `renderer/features/cut/captionwords.js` on the same inputs.

use cut_model::captionwords::*;
use cut_oracle::{Inputs, ask};
use cut_time::{Fps, Ticks, snap};
use serde_json::{Value, json};

/// 30 fps, the frame of the JavaScript tests.
const F: Ticks = 8_467_200_000;

fn f(n: i64) -> Ticks {
    n * F
}

/// The oracle decodes its request chunk by chunk, so a character split between two chunks comes out as U+FFFD: each
/// call goes as ASCII, its arguments a JSON text with `\u` escapes that the scenario's `ascii` parses.
fn ask_ascii(calls: &[Value]) -> Vec<Value> {
    let wrapped: Vec<Value> = calls
        .iter()
        .map(|c| {
            let c = c.as_array().unwrap();
            let mut args = String::new();
            for ch in Value::Array(c[1..].to_vec()).to_string().chars() {
                if ch.is_ascii() {
                    args.push(ch);
                } else {
                    for u in ch.encode_utf16(&mut [0; 2]) {
                        args.push_str(&format!("\\u{u:04x}"));
                    }
                }
            }
            json!(["ascii", c[0], args])
        })
        .collect();
    ask("scenario/captionwords", &wrapped)
}

/// JSON values equal as JavaScript sees them: numbers by value (1.0 is 1).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// Our answers against the JavaScript's for the same calls.
fn compare(calls: &[Value], ours: &[Value]) {
    let theirs = ask_ascii(calls);
    let differ: Vec<String> = calls
        .iter()
        .zip(ours.iter().zip(&theirs))
        .filter(|(_, (a, b))| !same(a, b))
        .take(10)
        .map(|(call, (a, b))| format!("{call} -> rust {a}, javascript {b}"))
        .collect();
    assert!(differ.is_empty(), "{} calls compared; the first differences:\n{}", calls.len(), differ.join("\n"));
    eprintln!("oracle comparisons: {}", calls.len());
}

fn index(found: Option<usize>) -> Value {
    json!(found.map_or(-1, |i| i as i64))
}

fn ws(list: &[(i64, i64, &str)]) -> Vec<Word> {
    list.iter().map(|&(a, b, text)| Word { t0: f(a), t1: f(b), text: text.into() }).collect()
}

fn frames(words: Option<Vec<Word>>) -> Option<Vec<(i64, i64, String)>> {
    words.map(|w| w.into_iter().map(|w| (w.t0 / F, w.t1 / F, w.text)).collect())
}

const SPACES: [&str; 12] =
    [" ", " ", "  ", "\n", "\r\n", "\t", "\u{3000}", "\u{a0}", "\u{2028}", "\u{feff}", "\u{200a}", " \n "];

/// Tokens of many scripts, with case, punctuation, symbols, emoji, combining marks and characters that look like white
/// space but are not in JavaScript's `\s` (U+0085, U+200B).
const VOCAB: [&str; 40] = [
    "alpha",
    "Alpha,",
    "ALPHA!",
    "beta",
    "beta.",
    "gamma",
    "gamma?!",
    "안녕",
    "안녕하세요.",
    "안녕하세요",
    "똠방각하",
    "😀",
    "👍🏽",
    "a😀",
    "e\u{301}",
    "é",
    "É",
    "ΣΑΣ",
    "σας",
    "İstanbul",
    "istanbul",
    "ǅ",
    "—",
    "...",
    "«quote»",
    "quote",
    "a.b",
    "ab",
    "x\u{200b}y",
    "ß",
    "SS",
    "ẞ",
    "Ⅻ",
    "ⅻ",
    "１２３",
    "Ａ",
    "a\u{85}b",
    "$5",
    "5",
    "™",
];

fn join(rng: &mut Inputs, toks: &[String]) -> String {
    let mut out = String::new();
    if rng.range(0, 4) == 0 {
        out.push_str(rng.pick(&SPACES));
    }
    for (i, t) in toks.iter().enumerate() {
        if i > 0 {
            out.push_str(rng.pick(&SPACES));
        }
        out.push_str(t);
    }
    if rng.range(0, 4) == 0 {
        out.push_str(rng.pick(&SPACES));
    }
    out
}

/// A text edited from `toks`: words kept, dropped, replaced, re-cased, punctuated, merged and added.
fn edit(rng: &mut Inputs, toks: &[String]) -> String {
    let mut out = Vec::new();
    for t in toks {
        match rng.range(0, 12) {
            0 => {}
            1 => out.push(rng.pick(&VOCAB).to_owned()),
            2 => out.push(t.to_uppercase()),
            3 => out.push(format!("{t},")),
            4 => {
                out.push(rng.pick(&VOCAB).to_owned());
                out.push(t.clone());
            }
            5 => {
                out.push(t.clone());
                out.push(rng.pick(&VOCAB).to_owned());
            }
            _ => out.push(t.clone()),
        }
    }
    join(rng, &out)
}

/// Words as speech recognition writes them, sometimes off the frames, fractional or several tokens in one.
fn heard(rng: &mut Inputs, frame: Ticks) -> (Value, Vec<String>) {
    let n = rng.range(0, 9);
    let mut t = rng.range(-3, 2) * frame + rng.pick(&[0, 0, 0, 1, frame / 3]);
    let mut words = Vec::new();
    let mut toks = Vec::new();
    for _ in 0..n {
        let len = rng.range(0, 20) * frame + rng.pick(&[0, 0, 0, 7]);
        let text = if rng.range(0, 8) == 0 {
            format!("{} {}", rng.pick(&VOCAB), rng.pick(&VOCAB))
        } else {
            rng.pick(&VOCAB).to_owned()
        };
        toks.extend(tokens(&text).map(str::to_owned));
        let t0 = if rng.range(0, 10) == 0 { json!(t as f64 + 0.5) } else { json!(t) };
        words.push(json!({ "t0": t0, "t1": t + len, "text": text }));
        t += len + rng.range(0, 10) * frame;
    }
    (Value::Array(words), toks)
}

#[test]
fn the_javascript_tests_hold() {
    let three = ws(&[(0, 15, "alpha"), (21, 36, "beta"), (42, 57, "gamma")]);
    let three_json = serde_json::to_value(&three).unwrap();
    let r = |text: &str| frames(realign(&three_json, text, F, Some(f(66))));
    let owned = |l: &[(i64, i64, &str)]| Some(l.iter().map(|&(a, b, t)| (a, b, t.to_owned())).collect::<Vec<_>>());
    assert_eq!(tokens(" alpha  beta\ngamma ").collect::<Vec<_>>(), ["alpha", "beta", "gamma"]);
    assert!(valid(&three_json, "alpha beta\ngamma") && !valid(&three_json, "alpha gamma"));
    let back = serde_json::to_value(ws(&[(21, 36, "alpha"), (0, 15, "beta"), (42, 57, "gamma")])).unwrap();
    assert!(!valid(&back, "alpha beta gamma"), "never going back in time");
    assert_eq!(realign(&three_json, "alpha beta gamma", F, Some(f(66))), Some(three.clone()));
    assert_eq!(r("Alpha, beta\ngamma!"), owned(&[(0, 15, "Alpha,"), (21, 36, "beta"), (42, 57, "gamma!")]));
    assert_eq!(r("alpha bravo gamma"), owned(&[(0, 15, "alpha"), (21, 36, "bravo"), (42, 57, "gamma")]));
    assert_eq!(
        r("alpha bravo charlie gamma"),
        owned(&[(0, 15, "alpha"), (21, 29, "bravo"), (29, 36, "charlie"), (42, 57, "gamma")])
    );
    assert_eq!(
        r("alpha beta gamma delta"),
        owned(&[(0, 15, "alpha"), (21, 36, "beta"), (42, 57, "gamma"), (57, 66, "delta")])
    );
    assert_eq!(
        r("alpha beta new gamma"),
        owned(&[(0, 15, "alpha"), (21, 36, "beta"), (36, 42, "new"), (42, 57, "gamma")])
    );
    let two = serde_json::to_value(ws(&[(0, 15, "alpha"), (15, 30, "beta")])).unwrap();
    assert_eq!(realign(&two, "alpha new beta", F, Some(f(66))), None, "no time for a new word");
    assert_eq!(r("something else entirely"), None);
    assert_eq!(r("alpha gamma"), owned(&[(0, 15, "alpha"), (42, 57, "gamma")]));
    let joined = json!([{ "t0": 0, "t1": f(20), "text": "two words" }]);
    assert_eq!(frames(realign(&joined, "two words", F, Some(f(66)))), owned(&[(0, 10, "two"), (10, 20, "words")]));
    assert_eq!(realign(&json!("x"), "a", 1, None), None);
    assert_eq!(realign(&json!([{ "t0": "a" }]), "a", 1, None), None);
    assert_eq!(realign(&json!([]), "a", 1, None), None);
    assert_eq!(realign(&three_json, "", 1, None), None);
    let lits: Vec<_> = [-1, 0, 14, 15, 18, 21, 40, 42, 56, 57, 70].iter().map(|&n| lit(&three, f(n))).collect();
    assert_eq!(lits, [None, Some(0), Some(0), Some(0), Some(0), Some(1), Some(1), Some(2), Some(2), None, None]);
    let gone = ws(&[(0, 5, "a"), (5, 5, "gone"), (5, 10, "c")]);
    assert_eq!([0, 5, 10].map(|n| lit(&gone, f(n))), [Some(0), Some(2), None], "a word of no length is never lit");
    assert_eq!(lit_at(&three, "alpha beta gamma", f(100), f(122)), Some(1));
    assert_eq!(lit_at(&three, "alpha beta", f(100), f(122)), None);
    assert_eq!(MODES, ["color", "box"]);
}

#[test]
fn white_space_case_and_punctuation_are_the_javascripts() {
    let all: Vec<u32> = (0..0x11_0000).filter(|c| !(0xd800..=0xdfff).contains(c)).collect();
    let chars = || all.iter().map(|&c| char::from_u32(c).unwrap());
    let calls =
        [json!(["spaces", 0, 0x11_0000]), json!(["punctOrSymbol", 0, 0x11_0000]), json!(["lower", 0, 0x11_0000])];
    let theirs = ask_ascii(&calls);
    let spaces: Vec<u32> = chars().filter(|c| tokens(&format!("a{c}b")).count() == 2).map(|c| c as u32).collect();
    assert_eq!(json!(spaces), theirs[0], "JavaScript's \\s");
    let lower: Vec<Value> = chars()
        .map(|c| (c, c.to_lowercase().collect::<String>()))
        .filter(|(c, l)| l.chars().ne([*c]))
        .map(|(c, l)| json!([c as u32, l]))
        .collect();
    let theirs_lower = theirs[2].as_array().unwrap();
    let missing: Vec<&Value> = theirs_lower.iter().filter(|v| !lower.contains(v)).take(10).collect();
    assert!(missing.is_empty(), "toLowerCase: javascript only {missing:?}");
    // Rust's tables are Unicode 17: it also lowercases the letters Unicode 16 had not assigned yet.
    let extra: Vec<&Value> = lower.iter().filter(|v| !theirs_lower.contains(v)).map(|v| &v[0]).collect();
    let unassigned = &ask_ascii(&[json!(["unassigned", extra])])[0];
    assert_eq!(&json!(extra), unassigned, "toLowerCase: rust lowercases letters javascript knows and does not");
    eprintln!("letters only Rust lowercases (new in Unicode 17): {}", extra.len());
    // A word "q<c>" keeps its time against the text "q" when c, lowercased, is all punctuation and symbols.
    let punct: Vec<u32> = theirs[1].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
    let set: std::collections::HashSet<u32> = punct.iter().copied().collect();
    let differ: Vec<u32> = chars()
        .filter(|&c| {
            let expected = c.to_lowercase().all(|l| set.contains(&(l as u32))) || is_space_js(c);
            let word = json!([{ "t0": 0, "t1": 10, "text": format!("q{c}") }]);
            expected != realign(&word, "q", 1, None).is_some()
        })
        .map(|c| c as u32)
        .take(10)
        .collect();
    assert!(differ.is_empty(), "\\p{{P}}\\p{{S}} differs at {differ:x?}");
    let texts = ["ΑΣ", "ΑΣ ΑΣ.", "ΣΑΣΑ", "İSTANBUL", "ǄǅǆΣ", "Σ", "AΣ1", "ẞ"];
    let lowered: Vec<String> = texts.iter().map(|t| t.to_lowercase()).collect();
    assert_eq!(json!(lowered), ask_ascii(&[json!(["lowerText", texts])])[0], "final sigma");
    eprintln!("oracle comparisons (character classes): {}", 3 * all.len() + texts.len());
}

fn is_space_js(c: char) -> bool {
    tokens(&format!("a{c}b")).count() == 2
}

#[test]
fn tokens_spans_and_valid_match_the_javascript() {
    let mut rng = Inputs::new(11);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    let mut texts: Vec<String> = vec![
        String::new(),
        " ".into(),
        "\u{85}".into(),
        "\u{feff}a\u{feff}b".into(),
        "안녕 하세요\n😀 e\u{301}  👍🏽x".into(),
    ];
    for _ in 0..300 {
        let toks: Vec<String> = (0..rng.range(0, 8)).map(|_| rng.pick(&VOCAB).to_owned()).collect();
        texts.push(join(&mut rng, &toks));
    }
    for text in &texts {
        calls.push(json!(["tokens", text]));
        ours.push(json!(tokens(text).collect::<Vec<_>>()));
        let utf16 = |b: usize| text[..b].encode_utf16().count();
        calls.push(json!(["spans", text]));
        ours.push(json!(spans(text).into_iter().map(|r| [utf16(r.start), utf16(r.end)]).collect::<Vec<_>>()));
    }
    for _ in 0..1500 {
        let (mut words, toks) = heard(&mut rng, F);
        let mut text = join(&mut rng, &toks);
        match rng.range(0, 14) {
            0 => text = edit(&mut rng, &toks),
            1 => words = json!({ "0": words }),
            2 => words = json!(null),
            3 if !toks.is_empty() => words[0] = json!(null),
            4 if !toks.is_empty() => words[0] = json!([1, 2]),
            5 if !toks.is_empty() => words[0]["t0"] = json!("0"),
            6 if !toks.is_empty() => words[0]["t1"] = json!(-1e9),
            7 if !toks.is_empty() => {
                words[0].as_object_mut().unwrap().remove("text");
            }
            8 if !toks.is_empty() => words[0]["t0"] = json!(1.0),
            9 => text.push_str(" extra"),
            _ => {}
        }
        calls.push(json!(["valid", words, text]));
        ours.push(json!(valid(&words, &text)));
    }
    compare(&calls, &ours);
}

#[test]
fn realign_matches_the_javascript() {
    let mut rng = Inputs::new(12);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    for n in 0..4000 {
        let frame = rng.pick(&[F, F, F, 10_160_640_000, 8_475_667_200, 1, 0, -F, 7]);
        let (words, toks) = heard(&mut rng, frame.max(1));
        let text = if n % 5 == 0 { join(&mut rng, &toks) } else { edit(&mut rng, &toks) };
        let any = f(rng.range(0, 400)) + 3;
        let duration = rng.pick(&[None, Some(f(66)), Some(0), Some(-F), Some(any)]);
        let mut opts = json!({ "frame": frame });
        if let Some(d) = duration {
            opts["duration"] = json!(d);
        }
        calls.push(json!(["realign", words, text, opts]));
        ours.push(json!(realign(&words, &text, frame, duration)));
    }
    // the size limit: n * m above 1e6 is refused, 1e6 itself is fitted
    for (n, m) in [(1000, 1000), (1001, 1000), (1, 1_000_001)] {
        let words: Vec<Value> =
            (0..n).map(|i| json!({ "t0": i * 10, "t1": i * 10 + 5, "text": format!("w{}", i % 7) })).collect();
        let text = (0..m).map(|i| format!("w{}", i % 5)).collect::<Vec<_>>().join(" ");
        let words = Value::Array(words);
        calls.push(json!(["realign", words, text, { "frame": 1, "duration": 20_000 }]));
        ours.push(json!(realign(&words, &text, 1, Some(20_000))));
    }
    // times near the largest a project holds, and far off frames
    for t in [(1_i64 << 53) - 1, 1 << 52, -(1 << 50), 123_456_789_012_345] {
        let words =
            json!([{ "t0": t, "t1": t + 3 * F + 1, "text": "a" }, { "t0": t + 4 * F, "t1": t + 9 * F, "text": "b" }]);
        for text in ["a b", "a x b", "x a y b z", "b"] {
            calls.push(json!(["realign", words, text, { "frame": F }]));
            ours.push(json!(realign(&words, text, F, None)));
        }
    }
    compare(&calls, &ours);
}

/// The maps a ripple passes, named as the scenario names them.
fn map(name: &Value) -> impl Fn(Ticks, bool) -> Ticks {
    let a = name[1].as_i64().unwrap_or(0);
    let b = name[2].as_i64().unwrap_or(0);
    let kind = name[0].as_str().unwrap().to_owned();
    move |x, is_end| match kind.as_str() {
        "identity" => x,
        "shift" => {
            if if is_end { x > a } else { x >= a } {
                x + b
            } else {
                x
            }
        }
        "remove" => {
            if x <= a {
                x
            } else if x < b {
                a
            } else {
                x - (b - a)
            }
        }
        "snap" => snap(x, Fps::new(a as u32, b as u32), true),
        _ => unreachable!(),
    }
}

#[test]
fn remap_remap_doubt_lit_and_lit_at_match_the_javascript() {
    let mut rng = Inputs::new(13);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    let mut lits = Vec::new();
    let mut lit_ours = Vec::new();
    for _ in 0..1500 {
        let (words, toks) = heard(&mut rng, F);
        let Some(words) = realign(&words, &join(&mut rng, &toks), F, Some(f(rng.range(1, 300)))) else { continue };
        let from = f(rng.range(0, 200)) + rng.pick(&[0, 0, 5]);
        let to = from + f(rng.range(-30, 30));
        let p = from + f(rng.range(-10, 120));
        let fun = match rng.range(0, 4) {
            0 => json!(["identity"]),
            1 => json!(["shift", p, f(rng.range(1, 60))]),
            2 => json!(["remove", p, p + f(rng.range(0, 60))]),
            _ => {
                let (num, den) = rng.pick(&[(25, 1), (24, 1), (30000, 1001), (60, 1)]);
                json!(["snap", num, den])
            }
        };
        calls.push(json!(["remap", words, from, to, fun]));
        ours.push(json!(remap(&words, from, to, map(&fun))));
        let mut doubt = Vec::new();
        for w in &words {
            if rng.range(0, 2) == 0 {
                doubt.push(Doubt { at: w.t0, text: w.text.clone(), p: rng.range(0, 100) as f64 / 100.0 });
            }
        }
        let length = f(rng.range(-5, 200));
        calls.push(json!(["remapDoubt", doubt, from, to, fun, length]));
        ours.push(json!(remap_doubt(&doubt, from, to, map(&fun), length)));

        let moved = remap(&words, from, to, map(&fun));
        let text = moved.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
        let start = f(rng.range(0, 100));
        for _ in 0..8 {
            let rel = f(rng.range(-5, 320)) + rng.pick(&[0, 0, 1, -1]);
            lits.push(json!(["lit", moved, rel]));
            lit_ours.push(index(lit(&moved, rel)));
            let text = if rng.range(0, 6) == 0 { format!("{text} x") } else { text.clone() };
            lits.push(json!(["litAt", { "start": start, "text": text, "words": moved }, start + rel]));
            lit_ours.push(index(lit_at(&moved, &text, start, start + rel)));
        }
    }
    lits.push(json!(["litAt", { "start": 0, "text": "" }, 0]));
    lit_ours.push(index(lit_at(&[], "", 0, 0)));
    compare(&calls, &ours);
    compare(&lits, &lit_ours);
}
