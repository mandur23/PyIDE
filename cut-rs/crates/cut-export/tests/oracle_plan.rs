//! export.js's pure parts and main's faststart against the JavaScript: frame plans, chapters, captions in a range,
//! file names, PSNR, moov rewriting (with stco growing into co64) and faststart on written and broken files.

mod common;

use common::{compare, out_dir};
use cut_export::faststart::{Moved, faststart, rewrite_moov};
use cut_export::plan::{self, FramePlan};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample, VideoConfig};
use cut_oracle::{Inputs, ask, bytes, unbytes};
use cut_time::{FRAME_RATES, Fps, TICKS};
use serde_json::{Value, json};

fn marker(id: usize, t: i64, kind: &str, name: &str) -> Value {
    json!({ "id": format!("k{id}"), "t": t, "duration": 0, "name": name, "note": "", "kind": kind, "color": "green" })
}

fn markers_of(v: &[Value]) -> Vec<cut_model::Marker> {
    let seq = json!({ "id": "s1", "name": "S", "w": 1920, "h": 1080, "fps": [30, 1], "rate": 48000, "background": "#000000",
        "masterGain": 0, "tracks": [], "clips": [], "transitions": [], "markers": v, "captions": [] });
    let p = json!({ "format": "ncut", "version": 5, "settings": {}, "media": [], "bins": [], "sequences": [seq], "nextId": 100 });
    let project = cut_model::Project::load(&p.to_string()).expect("a project");
    project.sequences[0].markers.clone()
}

#[test]
fn pure_parts_match_export_js() {
    let mut r = Inputs::new(3);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let mut rates = FRAME_RATES.to_vec();
    rates.push(Fps::new(7, 3));
    for fps in rates {
        for _ in 0..60 {
            let from = r.range(0, 600 * TICKS);
            let to = from + r.range(-TICKS, 120 * TICKS);
            let p = FramePlan::new(fps, from, to);
            let times: Vec<Value> = (0..p.count.clamp(0, 40)).map(|i| json!([p.time_of(i), p.pts_of(i)])).collect();
            let frame = TICKS as f64 * f64::from(fps.den) / f64::from(fps.num);
            calls.push(json!(["framePlan", [fps.num, fps.den], from, to, 40]));
            ours.push(json!({ "count": p.count, "first": p.first, "frame": frame, "times": times }));
        }
    }
    let names = ["Intro", "  Part one ", "", "끝", "Late"];
    for k in 0..300 {
        let n = r.range(0, 6) as usize;
        let list: Vec<Value> = (0..n)
            .map(|i| {
                let t = r.pick(&[
                    0,
                    TICKS / 30,
                    TICKS - TICKS / 30,
                    TICKS,
                    9 * TICKS,
                    75 * TICKS,
                    3599 * TICKS,
                    3725 * TICKS,
                ]) + r.range(0, 3) * TICKS;
                marker(i, t, r.pick(&["chapter", "chapter", "comment", "beat"]), r.pick(&names))
            })
            .collect();
        let markers = markers_of(&list);
        let range = (k % 3 == 0).then(|| (r.range(0, 100) * TICKS, r.range(50, 4000) * TICKS));
        calls.push(json!(["chapters", list, "Start", range.map(|(a, b)| json!({ "in": a, "out": b }))]));
        ours.push(json!(plan::chapters(&markers, "Start", range)));
        calls.push(json!(["chapterProblems", list]));
        ours.push(json!(plan::chapter_problems(&markers)));
    }
    let items = json!([{ "id": "c1", "start": 0, "end": 2 * TICKS, "text": "a" }, { "id": "c2", "start": 9 * TICKS, "end": 12 * TICKS, "text": "b" },
        { "id": "c3", "start": 15 * TICKS, "end": 16 * TICKS, "text": "c" }]);
    let caps: Vec<cut_model::Caption> =
        serde_json::from_value::<Vec<Value>>(items.clone()).expect("items").iter().map(caption_of).collect();
    for _ in 0..100 {
        let (a, b) = (r.range(-2, 18) * TICKS / 2, r.range(-2, 18) * TICKS / 2);
        calls.push(json!(["captionsInRange", items, { "in": a, "out": b }]));
        ours.push(serde_json::to_value(plan::captions_in_range(&caps, Some((a, b)))).expect("json"));
        calls.push(json!(["captionsAt", items, a]));
        ours.push(serde_json::to_value(plan::captions_at(&caps, a)).expect("json"));
    }
    for p in [
        "C:\\out\\My video.mp4",
        "C:\\out\\clip.mov",
        "C:\\a.b\\c",
        "file.",
        "a..b",
        "C:/x/y.tar.gz",
        "noext",
        "C:\\out\\.hidden",
        "",
    ] {
        for ext in ["mp4", "m4a"] {
            calls.push(json!(["withExt", p, ext]));
            ours.push(json!(plan::with_ext(p, ext)));
        }
        for (lang, count) in [(None, 1), (Some("ko"), 2), (Some("ko"), 1), (Some(""), 3), (None, 3)] {
            calls.push(json!(["sidecarPath", p, lang, count]));
            ours.push(json!(plan::sidecar_path(p, lang, count)));
        }
    }
    for _ in 0..50 {
        let n = r.range(0, 8) as usize * 4;
        let a: Vec<u8> = (0..n).map(|_| r.range(0, 255) as u8).collect();
        let mut b = a.clone();
        for v in b.iter_mut().step_by(3) {
            *v = v.wrapping_add(r.range(0, 3) as u8);
        }
        let p = plan::psnr(&a, &b);
        calls.push(json!(["psnr", a, b]));
        ours.push(if p.is_finite() { json!(p) } else { Value::Null });
    }
    let theirs = ask("scenario/export", &calls);
    eprintln!("{} export.js comparisons", compare("export pure parts", &calls, &ours, &theirs));
}

#[test]
fn speaker_names_in_sidecars_match_speakers_js() {
    let mut r = Inputs::new(11);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let lists = [
        json!(null),
        json!({ "list": [], "turns": {}, "count": 0 }),
        json!({ "list": [{ "id": "sp1", "name": "", "color": "#4fc3f7" }, { "id": "sp2", "name": "민지", "color": "#ffb74d" },
            { "id": "sp3", "name": "Bob", "color": "#81c784" }], "turns": {}, "count": 0 }),
        json!({ "list": [{ "id": "sp7", "name": "", "color": "#4fc3f7" }], "turns": {}, "count": 1 }),
    ];
    let styles = [
        json!({}),
        json!({ "speakerName": true }),
        json!({ "speakerName": false, "speakerColor": true }),
        json!({ "speakerName": true, "speakerColor": true, "size": 40 }),
    ];
    let ids = [None, Some(""), Some("sp1"), Some("sp2"), Some("sp3"), Some("sp7"), Some("sp9")];
    for _ in 0..200 {
        let sp = lists[r.range(0, lists.len() as i64 - 1) as usize].clone();
        let style = styles[r.range(0, styles.len() as i64 - 1) as usize].clone();
        let items: Vec<Value> = (0..r.range(0, 5))
            .map(|k| {
                let mut it = json!({ "id": format!("c{k}"), "start": k * TICKS, "end": (k + 1) * TICKS, "text": r.pick(&["안녕하세요", "hi", ""]) });
                if let Some(id) = r.pick(&ids) {
                    it["speaker"] = json!(id);
                }
                it
            })
            .collect();
        let project = json!({ "speakers": sp });
        let track = json!({ "style": style });
        let style = style.as_object().cloned().unwrap_or_default();
        let caps = items.iter().map(caption_of).collect();
        let speakers = (!sp.is_null()).then_some(&sp);
        let got = plan::with_speakers(speakers, &style, caps, "Speaker {n}");
        calls.push(json!(["written", project, track, items]));
        ours.push(serde_json::to_value(got).expect("json"));
    }
    let theirs = ask("speakers", &calls);
    let all = Value::Array(theirs.clone()).to_string();
    for named in ["Speaker 1: ", "민지: ", "Bob: "] {
        assert!(all.contains(named), "the inputs reach a caption named {named:?}");
    }
    eprintln!("{} speakers.js written comparisons", compare("speaker names", &calls, &ours, &theirs));
}

fn caption_of(v: &Value) -> cut_model::Caption {
    cut_model::Caption {
        id: cut_model::Id::new(v["id"].as_str().unwrap_or("")),
        start: v["start"].as_i64().unwrap_or(0),
        end: v["end"].as_i64().unwrap_or(0),
        text: v["text"].as_str().unwrap_or("").into(),
        doubt: None,
        words: None,
        speaker: v.get("speaker").and_then(Value::as_str).map(str::to_owned),
        extra: Default::default(),
    }
}

fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    b.extend_from_slice(kind);
    b.extend_from_slice(body);
    b
}

fn stco(wide: bool, offsets: &[u64]) -> Vec<u8> {
    let mut body = vec![0, 0, 0, 0];
    body.extend((offsets.len() as u32).to_be_bytes());
    for o in offsets {
        if wide {
            body.extend(o.to_be_bytes());
        } else {
            body.extend((*o as u32).to_be_bytes());
        }
    }
    bx(if wide { b"co64" } else { b"stco" }, &body)
}

/// A moov of `tracks` traks, each with an stco or co64 of offsets, and other boxes copied through.
fn moov(r: &mut Inputs, tracks: usize, wide: bool, at: u64) -> Vec<u8> {
    let mut traks = bx(b"mvhd", &[7; 100]);
    for _ in 0..tracks {
        let offs: Vec<u64> = (0..r.range(0, 20)).map(|k| at + k as u64 * 1000).collect();
        let stbl = [bx(b"stsd", &[1; 20]), stco(wide, &offs), bx(b"stsz", &[2; 12])].concat();
        let minf = [bx(b"vmhd", &[0; 12]), bx(b"stbl", &stbl)].concat();
        let mdia = [bx(b"mdhd", &[0; 24]), bx(b"minf", &minf)].concat();
        traks.extend(bx(b"trak", &[bx(b"tkhd", &[0; 84]), bx(b"mdia", &mdia)].concat()));
    }
    bx(b"moov", &traks)
}

#[test]
fn rewrite_moov_matches_faststart_js() {
    let mut r = Inputs::new(5);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for k in 0..200 {
        let wide = k % 4 == 0;
        let (tracks, at) = (r.range(0, 3) as usize, 48 + r.range(0, 1000) as u64);
        let mut m = moov(&mut r, tracks, wide, at);
        // big shifts push 32-bit offsets past 4 GB: the stco becomes a co64
        let by = r.pick(&[0, 1, 4096, 0xffff_ff00, 0x1_0000_0000]);
        match k % 10 {
            7 => m.truncate(r.range(0, m.len() as i64) as usize),
            8 if !wide => {
                let i = r.range(0, m.len() as i64 - 1) as usize;
                m[i] ^= 0xff;
            }
            _ => {}
        }
        calls.push(json!(["rewriteMoov", bytes(&m), 0, by]));
        ours.push(match rewrite_moov(&m, |o| Ok(o + by)) {
            Ok(b) => bytes(&b),
            Err(e) => json!({ "error": e.message }),
        });
    }
    let theirs = ask("scenario/export", &calls);
    eprintln!("{} faststart.js rewriteMoov comparisons", compare("rewriteMoov", &calls, &ours, &theirs));
}

fn written(video: bool, audio: bool, n: usize) -> Vec<u8> {
    let v = video.then(|| VideoConfig {
        codec: "avc1.640028".into(),
        width: 64,
        height: 36,
        description: Some(vec![1, 0x64, 0, 0x28, 0xff, 0xe0, 0]),
        frame_rate: Some([30, 1]),
        color_space: None,
    });
    let a =
        audio.then(|| AudioConfig { codec: "mp4a.40.2".into(), sample_rate: 48000, channels: 2, description: None });
    let mut w = Mp4Writer::create(v, a, Vec::new(), None).expect("a writer");
    let frame = TICKS / 30;
    for i in 0..n as i64 {
        if video {
            w.add_video(Sample {
                data: vec![i as u8; 300 + i as usize],
                timestamp: i * frame,
                duration: frame,
                key: i % 10 == 0,
                composition_offset: 0,
            })
            .expect("video");
        }
        if audio {
            let d = 1024 * (TICKS / 48000);
            w.add_audio(Sample {
                data: vec![7; 200],
                timestamp: i * d - d,
                duration: d,
                key: true,
                composition_offset: 0,
            })
            .expect("audio");
        }
    }
    w.finish().expect("finished");
    w.into_sink()
}

#[test]
fn faststart_matches_faststart_js_on_files() {
    let dir = out_dir().join(format!("faststart-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let mut r = Inputs::new(9);
    let mut files: Vec<(String, Vec<u8>)> = vec![
        ("both.mp4".into(), written(true, true, 90)),
        ("video.mp4".into(), written(true, false, 30)),
        ("audio.m4a".into(), written(false, true, 200)),
    ];
    let first = files[0].1.clone();
    files.push(("empty.mp4".into(), Vec::new()));
    files.push(("cut.mp4".into(), first[..first.len() - 100].to_vec()));
    let mut two = first.clone();
    let moov_at = two.windows(4).rposition(|w| w == b"moov").expect("moov") - 4;
    let m = two[moov_at..].to_vec();
    two.extend_from_slice(&m);
    files.push(("twomoov.mp4".into(), two));
    // synthetic: ftyp, mdat, moov with stco offsets into the mdat
    let ftyp = bx(b"ftyp", b"isom\0\0\x02\0isom");
    let mdat = bx(b"mdat", &[5; 30000]);
    let mv = moov(&mut r, 2, false, ftyp.len() as u64 + 8);
    files.push(("stco.mp4".into(), [ftyp.clone(), mdat.clone(), mv.clone()].concat()));
    files.push(("front.mp4".into(), [ftyp.clone(), mv.clone(), mdat.clone()].concat()));
    files.push(("moof.mp4".into(), [ftyp.clone(), mdat.clone(), bx(b"moof", &[0; 8]), mv.clone()].concat()));
    files.push(("bad.mp4".into(), [ftyp.clone(), mdat.clone(), moov(&mut r, 1, false, 999_999)].concat()));
    files.push(("wrong.txt".into(), first.clone()));
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for (name, data) in &files {
        let ours_path = dir.join(format!("rs-{name}"));
        let js_path = dir.join(format!("js-{name}"));
        std::fs::write(&ours_path, data).expect("write");
        std::fs::write(&js_path, data).expect("write");
        let res = match faststart(&ours_path, |_| None, None) {
            Ok(Moved::Moved { bytes }) => json!({ "ok": true, "moved": true, "bytes": bytes }),
            Ok(Moved::Already { bytes }) => json!({ "ok": true, "already": true, "bytes": bytes }),
            Err(e) => json!({ "error": e.message, "code": e.code }),
        };
        let mut res = res;
        if let Ok(b) = std::fs::read(&ours_path) {
            res["file"] = bytes(&b);
        }
        calls.push(json!(["faststart", js_path.to_string_lossy()]));
        ours.push(res);
    }
    let theirs = ask("scenario/export", &calls);
    let moved = theirs.iter().filter(|t| t["moved"] == json!(true)).count();
    for t in &theirs {
        eprintln!(
            "{}",
            json!({ "error": t["error"], "code": t["code"], "moved": t["moved"], "already": t["already"] })
        );
    }
    assert!(moved >= 4, "faststart moved {moved} files");
    let head = unbytes(&theirs[0]["file"]);
    assert_eq!(&head[4..8], b"ftyp");
    let n = compare("faststart", &calls, &ours, &theirs);
    let left: Vec<_> = std::fs::read_dir(&dir).expect("dir").filter_map(Result::ok).map(|e| e.file_name()).collect();
    assert_eq!(left.len(), files.len() * 2, "no temporary file is left: {left:?}");
    std::fs::remove_dir_all(&dir).expect("cleaned up");
    eprintln!("{n} faststart.js comparisons on files");
}
