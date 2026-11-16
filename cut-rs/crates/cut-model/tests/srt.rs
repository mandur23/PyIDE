//! `cut_model::srt` against `renderer/features/cut/srt.js` on the same inputs.

use std::time::Instant;

use cut_model::srt::*;
use cut_oracle::{Inputs, ask};
use cut_time::{TICKS, Ticks};
use serde_json::{Value, json};

const SEC: Ticks = TICKS;
const MS: Ticks = TICKS / 1000;

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
    ask("scenario/srt", &wrapped)
}

/// JSON values equal as JavaScript sees them: numbers by value, and a time past the range of ticks (a JavaScript
/// number above 2^63, or Infinity, which arrives as null) as the saturated `Ticks::MAX` the port gives.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Null) => x.as_i64() == Some(Ticks::MAX),
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64() == y.as_f64() || (x.as_i64() == Some(Ticks::MAX) && y.as_f64() >= Some(9.223_372_036_854_775e18))
        }
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

fn cue(start: Ticks, end: Ticks, text: &str) -> Cue {
    Cue { start, end, text: text.into() }
}

fn texts(items: &[Cue]) -> Vec<&str> {
    items.iter().map(|it| it.text.as_str()).collect()
}

const FILE: &str = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\n첫 줄\r\n둘째 줄\r\n\r\n\r\n  \r\n3\r\n0:00:03.5 --> 0:00:04.25 X1:10 X2:20\r\n<i>기울임</i>\r\n\r\n00:05,000 --> 00:06,000\r\n번호 없음\r\n7\r\n00:00:07,000 --> 00:00:08,001\r\n빈 줄 없이 다음\r\n00:00:09,000 --> 00:00:09,500\r\n번호도 빈 줄도 없이\r\n\r\n100:00:00,000 --> 100:00:01,000\r\n긴 시간\r\n\r\nnot a cue\r\n\r\n";
const VTT: &str = "WEBVTT - 제목\nKind: captions\n\nNOTE 메모\n여러 줄\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.000 align:start\nA &amp; B &lt;3\n\n01:00:00.250 --> 01:00:01.000\n<v Kim>안녕</v>\n";
const KOREAN: &str = "1\r\n00:00:01,000 --> 00:00:02,000\r\n안녕하세요, 똠방각하! 뷁 갂 햏\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n가나다 ABC 123\r\n";

#[test]
fn the_javascript_tests_hold() {
    let items = parse(FILE);
    let got: Vec<_> = items.iter().map(|it| (it.start / MS, it.end / MS, it.text.as_str())).collect();
    assert_eq!(
        got,
        [
            (1000, 2500, "첫 줄\n둘째 줄"),
            (3500, 4250, "기울임"),
            (5000, 6000, "번호 없음"),
            (7000, 8001, "빈 줄 없이 다음"),
            (9000, 9500, "번호도 빈 줄도 없이"),
            (360_000_000, 360_001_000, "긴 시간")
        ]
    );
    assert_eq!(parse(&write(&items)), items, "SRT write then parse is the same");
    assert!(write(&items).starts_with("1\r\n00:00:01,000 --> 00:00:02,500\r\n첫 줄\r\n둘째 줄\r\n\r\n2\r\n"));
    assert_eq!(write(&[cue(SEC / 30, SEC, "a\n\nb")]), "1\r\n00:00:00,033 --> 00:00:01,000\r\na\r\nb\r\n");
    assert_eq!(
        parse("1\n00:00:00,000 --> 00:00:01,000\nx\r2\r00:00:01,000 --> 00:00:02,000\ry\r"),
        [cue(0, SEC, "x"), cue(SEC, 2 * SEC, "y")]
    );
    let vi = parse_vtt(VTT);
    let got: Vec<_> = vi.iter().map(|it| (it.start / MS, it.end / MS, it.text.as_str())).collect();
    assert_eq!(got, [(1000, 2000, "A & B <3"), (3_600_250, 3_601_000, "안녕")]);
    let words = parse_vtt("WEBVTT\n\n00:00.000 --> 00:01.000\nhello<00:00:00.539><c> world</c> <c.yellow>노랑</c>\n");
    assert_eq!(texts(&words), ["hello world 노랑"]);
    let tags = parse(
        "1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>기울임</i> <b>굵게</b> <font color=\"#ffff00\">노랑</font>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}위쪽 a < b <중요>\r\n",
    );
    assert_eq!(texts(&tags), ["기울임 굵게 노랑", "위쪽 a < b <중요>"]);
    let plain = [cue(0, 1500 * MS, "Tom & Jerry <3 -->"), cue(2 * SEC, 3 * SEC, "두 줄\n자막")];
    assert_eq!(parse_vtt(&write_vtt(&plain)), plain);
    assert!(write_vtt(&plain).starts_with("WEBVTT\n\n00:00.000 --> 00:01.500\nTom &amp; Jerry &lt;3 --&gt;\n"));
    assert_eq!(
        (parse_any(VTT, "x.srt").len(), parse_any(FILE, "x.srt").len(), is_vtt("", "a.VTT"), is_vtt("1 ", "a.srt")),
        (2, 6, true, false)
    );
    let utf8 = KOREAN.as_bytes();
    assert_eq!(decode(utf8).as_deref(), Ok(KOREAN));
    assert_eq!(decode(&[&[0xef, 0xbb, 0xbf], utf8].concat()).as_deref(), Ok(KOREAN));
    let le: Vec<u8> = KOREAN.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let be: Vec<u8> = KOREAN.encode_utf16().flat_map(u16::to_be_bytes).collect();
    for bytes in [[&[0xff, 0xfe], &le[..]].concat(), [&[0xfe, 0xff], &be[..]].concat(), le, be] {
        assert_eq!(decode(&bytes).as_deref(), Ok(KOREAN), "UTF-16 LE and BE, with a BOM and without");
    }
    assert_eq!(decode(b"AB").as_deref(), Ok("AB"));
    // CP949: EUC-KR 안녕 and the UHC-only 똠 뷁 갂 햏
    let cp949 =
        [b"1\r\n".as_slice(), &[0xbe, 0xc8, 0xb3, 0xe7, 0x8c, 0x63, 0x94, 0xee, 0x81, 0x41, 0xc1, 0x64]].concat();
    assert_eq!(decode(&cp949).as_deref(), Ok("1\r\n안녕똠뷁갂햏"));
    // Where the WHATWG decoder (Chromium's, which the editor runs) and the JavaScript's Node fallback part: the euro
    // and registered signs CP949 added late, the user-defined rows, a lone 0x80, a trail that is no CP949 trail.
    assert_eq!(decode(&[0x41, 0xa2, 0xe6, 0xa2, 0xe7]).as_deref(), Ok("A€®"));
    assert_eq!(decode(&[0x41, 0xc9, 0xa1, 0xfe, 0xfe]).as_deref(), Ok("A\u{fffd}\u{fffd}"));
    assert_eq!(decode(&[0x41, 0x80, 0x42]).as_deref(), Ok("A\u{fffd}B"));
    assert_eq!(decode(&[0x41, 0xb0, 0x80, 0x42]).as_deref(), Ok("A\u{fffd}B"));
    assert_eq!(decode(&[0x41, 0xb0, 0x7b, 0x42]).as_deref(), Ok("A\u{fffd}{B"));
}

const STAMPS: [&str; 24] = [
    "00:00:01,000",
    "0:00:03.5",
    "00:05,000",
    "1:2:3",
    "01:00:00.250",
    "100:00:00,000",
    "99999999:00:00,000",
    "9999:59:59,999",
    "10083:00:00,000",
    "2562047:00:00,000",
    "00:00:00,123456789",
    "00:00:00,1234567890",
    "00:00:01,",
    "00:00:01.5.5",
    "000:01:02",
    "1:234:56",
    "12:34",
    "12:345",
    "1:2",
    "00:60:99,9",
    "١:٢٣",
    "00:00:0１",
    "123456789012345678901234567890:00:00",
    "00:00:00,000000001",
];
const ARROWS: [&str; 10] = [" --> ", "-->", " -> ", " ---> ", " - > ", " => ", "\t-->\u{3000}", " --", " >", "  -->  "];
const AFTER: [&str; 6] = ["", " align:start", " X1:10 X2:20", "xyz", ",5", "\u{85}"];
const BODY: [&str; 22] = [
    "첫 줄",
    "<i>기울임</i>",
    "<b>bold</B> <FONT color=\"#ff0\">x</FONT>",
    "a < b <중요>",
    "{\\an8}위쪽 {\\} {a} {\\b1}x{\\b0}",
    "hello<00:00:00.539><c> world</c> <c.yellow>노랑</c>",
    "<1:23.4> <12:34:56.7890> <1:23:4,5> <123:45.6>",
    "A &amp; B &lt;3 &gt; &nbsp;&lrm;&rlm;&quot;&apos; &bogus; &&amp;",
    "<v Kim>안녕</v>",
    "😀 e\u{301} 👍🏽",
    "trailing spaces   ",
    "12",
    "  7  ",
    "NOTE not a block here",
    "WEBVTT",
    "<",
    "<a",
    "<<b>>",
    "tab\there",
    "\u{3000}",
    "STYLE",
    "x\u{2028}y",
];
const ENDS: [&str; 4] = ["\r\n", "\n", "\r", "\r\n"];

fn timing_line(rng: &mut Inputs) -> String {
    let lead = rng.pick(&["", "", " ", "\t", "\u{feff}"]);
    format!("{lead}{}{}{}{}", rng.pick(&STAMPS), rng.pick(&ARROWS), rng.pick(&STAMPS), rng.pick(&AFTER))
}

/// A caption file as real ones are, and worse: numbers or none, odd times and arrows, markup, NOTE and STYLE blocks,
/// blank lines with spaces, every line end, BOMs.
fn file(rng: &mut Inputs) -> String {
    let mut lines: Vec<String> = Vec::new();
    match rng.range(0, 6) {
        0 => lines.push("WEBVTT".into()),
        1 => lines.push("\u{feff}WEBVTT - 제목".into()),
        _ => {}
    }
    for n in 0..rng.range(0, 8) {
        match rng.range(0, 10) {
            0 => lines.push(rng.pick(&["NOTE 메모", "STYLE", "REGION", "NOTEx", "intro"]).into()),
            1 => lines.push(format!("{}", n + 1)),
            2 => lines.push(format!(" {} ", rng.range(0, 99))),
            _ => {}
        }
        lines.push(timing_line(rng));
        for _ in 0..rng.range(0, 4) {
            lines.push(rng.pick(&BODY).into());
        }
        for _ in 0..rng.range(0, 3) {
            lines.push(rng.pick(&["", "", "  ", "\t", "\u{a0}"]).into());
        }
    }
    let mut out = String::new();
    for l in &lines {
        out.push_str(l);
        out.push_str(rng.pick(&ENDS));
    }
    if rng.range(0, 4) == 0 {
        // truncated anywhere
        let cut = rng.range(0, out.len() as i64) as usize;
        let cut = (0..=cut).rev().find(|&i| out.is_char_boundary(i)).unwrap();
        out.truncate(cut);
    }
    out
}

#[test]
fn parsers_match_the_javascript() {
    let mut rng = Inputs::new(21);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    let mut inputs = vec![String::new(), "\u{feff}".into(), FILE.into(), VTT.into(), KOREAN.into(), "\r\n\r\n".into()];
    for _ in 0..3000 {
        inputs.push(file(&mut rng));
    }
    for _ in 0..600 {
        let line = timing_line(&mut rng);
        inputs.push(format!("{line}\nx\n"));
        inputs.push(format!("1\n{line}\n<i>a</i>\n2\n{line}\n"));
    }
    for text in &inputs {
        let name = rng.pick(&["a.srt", "a.VTT", "a.vtt.srt", "", "x.vtt"]);
        calls.push(json!(["parse", text]));
        ours.push(json!(parse(text)));
        calls.push(json!(["parseVtt", text]));
        ours.push(json!(parse_vtt(text)));
        calls.push(json!(["parseAny", text, name]));
        ours.push(json!(parse_any(text, name)));
        calls.push(json!(["isVtt", text, name]));
        ours.push(json!(is_vtt(text, name)));
    }
    compare(&calls, &ours);
}

#[test]
fn writers_and_times_match_the_javascript() {
    let mut rng = Inputs::new(22);
    let mut calls = Vec::new();
    let mut ours = Vec::new();
    let times = |rng: &mut Inputs| match rng.range(0, 5) {
        0 => rng.range(-SEC, 10 * SEC),
        1 => rng.range(0, 36_000) * SEC / 30,
        2 => rng.range(0, (1 << 53) - 1),
        3 => rng.range(0, 3_600_000) * MS + rng.pick(&[0, MS / 2, MS / 2 - 1, MS / 2 + 1, -MS / 2]),
        _ => rng.range(3_599, 3_601) * SEC + rng.range(-MS, MS),
    };
    for _ in 0..3000 {
        let t = times(&mut rng);
        let sep = rng.pick(&[",", ".", "", "::"]);
        let hours = rng.range(0, 2) == 0;
        calls.push(json!(["formatTime", t, sep, hours]));
        ours.push(json!(format_time(t, sep, hours)));
    }
    let pieces =
        ["a", "\n", "\r\n", "\r", "\n\n", "\n \n", " \n\t\n x", "  ", "&", "<3", "-->", "두 줄", "\u{3000}", "😀"];
    for _ in 0..800 {
        let items: Vec<Cue> = (0..rng.range(0, 6))
            .map(|_| {
                let text: String = (0..rng.range(0, 6)).map(|_| rng.pick(&pieces)).collect();
                Cue { start: times(&mut rng), end: times(&mut rng), text }
            })
            .collect();
        calls.push(json!(["write", items]));
        ours.push(json!(write(&items)));
        calls.push(json!(["writeVtt", items]));
        ours.push(json!(write_vtt(&items)));
        let (srt, vtt) = (write(&items), write_vtt(&items));
        calls.push(json!(["parse", srt]));
        ours.push(json!(parse(&srt)));
        calls.push(json!(["parseVtt", vtt]));
        ours.push(json!(parse_vtt(&vtt)));
    }
    compare(&calls, &ours);
}

#[test]
fn decode_matches_the_javascript() {
    let mut rng = Inputs::new(23);
    let mut inputs: Vec<Vec<u8>> = vec![
        vec![],
        vec![0xef],
        vec![0xef, 0xbb],
        vec![0xef, 0xbb, 0xbf],
        vec![0xff, 0xfe],
        vec![0xff, 0xfe, 0x41],
        vec![0xfe, 0xff, 0xd8, 0x00],
        vec![0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00],
        vec![0xff, 0xfe, 0xff, 0xfe, 0x41, 0x00],
        vec![0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41],
        vec![0x41, 0x00, 0x42],
        b"AB".to_vec(),
    ];
    let samples =
        [KOREAN, FILE, VTT, "가", "\u{ac00}\u{ac00}\u{ac00}", "😀 e\u{301}", "1\r\n00:00:01,000 --> 00:00:02,000\r\nx"];
    for text in samples {
        let le: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let be: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        inputs.push(text.as_bytes().to_vec());
        inputs.push([&[0xef, 0xbb, 0xbf], text.as_bytes()].concat());
        inputs.push([&[0xff, 0xfe], &le[..]].concat());
        inputs.push([&[0xfe, 0xff], &be[..]].concat());
        inputs.push([&le[..], &[0x41]].concat());
        inputs.push(be.clone());
        inputs.push(le);
    }
    let mut big = KOREAN.repeat(200).encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>();
    big.truncate(9001);
    inputs.push(big);
    for _ in 0..1500 {
        let base = rng.pick(&samples);
        let mut bytes = match rng.range(0, 4) {
            0 => base.as_bytes().to_vec(),
            1 => base.encode_utf16().flat_map(u16::to_le_bytes).collect(),
            2 => base.encode_utf16().flat_map(u16::to_be_bytes).collect(),
            _ => (0..rng.range(0, 60)).map(|_| rng.range(0, 255) as u8).collect(),
        };
        for _ in 0..rng.range(0, 3) {
            if !bytes.is_empty() {
                let i = rng.range(0, bytes.len() as i64 - 1) as usize;
                bytes[i] ^= 1 << rng.range(0, 7);
            }
        }
        if rng.range(0, 3) == 0 {
            bytes.truncate(rng.range(0, bytes.len() as i64) as usize);
        }
        let boms: [&[u8]; 5] = [&[], &[], &[0xef, 0xbb, 0xbf], &[0xff, 0xfe], &[0xfe, 0xff]];
        let bom = rng.pick(&boms);
        inputs.push([bom, &bytes[..]].concat());
    }
    let calls: Vec<Value> = inputs.iter().map(|b| json!(["decode", b])).collect();
    let js = ask("srt", &calls);
    let mut cp949 = 0;
    for (bytes, j) in inputs.iter().zip(&js) {
        let ours = decode(bytes).expect("decodes");
        if json!(ours) != *j {
            assert!(
                std::str::from_utf8(bytes).is_err() && encoding_rs::EUC_KR.decode_without_bom_handling(bytes).1,
                "only malformed CP949 reads differently (see cp949_matches_the_javascript): {bytes:02x?}"
            );
            cp949 += 1;
        }
    }
    eprintln!("malformed CP949 read the WHATWG way: {cp949} of {}", inputs.len());
}

#[test]
fn malformed_input_never_panics() {
    let mut rng = Inputs::new(24);
    for _ in 0..20_000 {
        let bytes: Vec<u8> = (0..rng.range(0, 200))
            .map(|_| rng.pick(b"0123456789:,.-> \r\n<>{}\\/&;aiWEBVTNOS\xef\xbb\xbf\xff\xfe\x00"))
            .collect();
        let text = String::from_utf8_lossy(&bytes);
        let _ = (parse(&text), parse_vtt(&text), decode(&bytes));
    }
}

/// `cargo test -p cut-model --release --test srt -- --ignored --nocapture`: parse time per caption of a generated
/// 10,000-caption file, next to the JavaScript's on the same file.
#[test]
#[ignore]
fn bench_parse() {
    const N: usize = 10_000;
    let text = ask_ascii(&[json!(["sample", N])])[0].as_str().unwrap().to_owned();
    let vtt = write_vtt(&parse(&text));
    for (name, run, input, vtt_flag) in
        [("parse", parse as fn(&str) -> Vec<Cue>, &text, false), ("parseVtt", parse_vtt, &vtt, true)]
    {
        let mut count = 0;
        let mut best = f64::INFINITY;
        for _ in 0..20 {
            let t0 = Instant::now();
            count += run(input).len();
            best = best.min(t0.elapsed().as_nanos() as f64);
        }
        assert_eq!(count, 20 * N, "every caption parsed");
        let js = &ask_ascii(&[json!(["bench", N, 20, vtt_flag])])[0];
        eprintln!(
            "{name} of {N} captions ({} bytes): rust {:.0} ns per caption, javascript {:.0} ns per caption",
            input.len(),
            best / N as f64,
            js["nsPerCaption"].as_f64().unwrap()
        );
    }
}

/// Every character CP949 has (KS X 1001's symbols, Hangul and Hanja, and the 8,822 syllables of the UHC extension),
/// found by decoding every two-byte code.
fn cp949_repertoire() -> Vec<char> {
    let mut chars = Vec::new();
    for lead in 0x81..=0xfeu8 {
        for trail in 0x41..=0xfeu8 {
            let pair = [lead, trail];
            let (text, _, bad) = encoding_rs::EUC_KR.decode(&pair);
            if !bad {
                chars.extend(text.chars());
            }
        }
    }
    chars
}

fn cp949_bytes(text: &str) -> Vec<u8> {
    let (bytes, _, unmappable) = encoding_rs::EUC_KR.encode(text);
    assert!(!unmappable, "only CP949 characters");
    bytes.into_owned()
}

/// Korean text in CP949 reads as the JavaScript reads it. Malformed bytes may read differently: the oracle runs the
/// JavaScript under Node, whose `euc-kr` decoder lacks the UHC extension and sends `srt.js` down its hand-built
/// fallback, while the editor runs it in Chromium, whose decoder is the WHATWG one that `encoding_rs` implements.
#[test]
fn cp949_matches_the_javascript() {
    let all = cp949_repertoire();
    let syllables = all.iter().filter(|c| ('\u{ac00}'..='\u{d7a3}').contains(*c)).count();
    assert_eq!(syllables, 11_172, "every Hangul syllable");
    assert!(all.len() > 17_000, "symbols, Hanja and Hangul: {}", all.len());
    // the euro and registered signs: the Node fallback has no code for them (see the unit test)
    let well_formed: Vec<char> = all.iter().copied().filter(|c| !matches!(c, '€' | '®')).collect();
    let mut rng = Inputs::new(25);
    let mut texts: Vec<String> = Vec::new();
    for (i, chunk) in well_formed.chunks(400).enumerate() {
        let mut body = String::new();
        for (j, c) in chunk.iter().enumerate() {
            body.push(*c);
            if j % 17 == 16 {
                body.push_str(if j % 2 == 0 { "\r\n" } else { " a1," });
            }
        }
        texts.push(format!("{}\r\n00:00:01,000 --> 00:00:02,000\r\n{body}\r\n", i + 1));
    }
    let short = texts.len();
    for _ in 0..400 {
        let n = rng.range(1, 40) as usize;
        texts.push((0..n).map(|_| if rng.range(0, 4) == 0 { 'x' } else { rng.pick(&well_formed) }).collect());
    }
    texts.extend(
        [KOREAN, "똠방각하 햏 뷁 갂", "1\r\n00:00:01,000 --> 00:00:02,000\r\n안녕하세요 <i>자막</i>\r\n"]
            .map(String::from),
    );
    let mut inputs: Vec<Vec<u8>> = texts.iter().map(|t| cp949_bytes(t)).collect();
    let well = inputs.len();
    for _ in 0..3000 {
        let mut b = inputs[rng.range(short as i64, well as i64 - 1) as usize].clone();
        for _ in 0..rng.range(1, 4) {
            let i = rng.range(0, b.len() as i64 - 1) as usize;
            match rng.range(0, 3) {
                0 => b[i] ^= 1 << rng.range(0, 7),
                1 => b.insert(i, rng.pick(&[0x80u8, 0xff, 0xc9, 0xfe, 0xa1, 0x81, 0x7f, 0x41])),
                _ => b.truncate(i.max(1)),
            }
        }
        inputs.push(b);
    }
    let calls: Vec<Value> = inputs.iter().map(|b| json!(["decode", b])).collect();
    let js = ask("srt", &calls);
    let mut same = 0;
    for (i, (b, j)) in inputs.iter().zip(&js).enumerate() {
        let ours = decode(b).expect("decodes");
        if json!(ours) == *j {
            same += 1;
            continue;
        }
        assert!(i >= well, "well-formed CP949 reads as the JavaScript reads it: {ours:?} against {j}");
        assert!(
            encoding_rs::EUC_KR.decode_without_bom_handling(b).1,
            "only malformed bytes read differently: {b:02x?}"
        );
    }
    assert!(same >= well, "all {well} well-formed inputs the same");
    eprintln!("cp949: {same} of {} inputs read as the JavaScript reads them ({well} well-formed)", inputs.len());
}
