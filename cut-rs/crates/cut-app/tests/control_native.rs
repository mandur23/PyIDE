//! The control API's jobs that run the editor's own analyses, through the real server over HTTP with the window
//! run headless on the PC's GPU and the fake backends (speech recognition: one word per burst of sound; speakers:
//! a window's energy at 24 frequencies; voice isolation: the vocals are the sound itself): every `automation` job,
//! `remove_silence` and `get_transcript`, each answered after the job's progress (`wait_job`), a job stopped when
//! its turn's token is revoked, the caption export with speaker names, and the frame with the caption track burned
//! in (`get_frame`) and written (`export_frame`). No dialog opens on the desktop: the questions are the window's own
//! and are answered here.

#[path = "media/mod.rs"]
mod media;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use cut_app::control::Control;
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_app::speech::engine::Speech;
use cut_sidecar::sound::SoundFiles;
use cut_time::{TICKS, Ticks};
use eframe::egui;
use egui_kittest::Harness;
use serde_json::{Value as Json, json};

type H = Harness<'static, Shell>;

fn secs(x: f64) -> Ticks {
    (x * TICKS as f64).round() as Ticks
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cut-app-control-native-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Three voices of different pitch (300, 1500, 800 Hz), words every 0.5 s, 18 s of mono 48 kHz.
fn talk(path: &Path) -> PathBuf {
    let plan = [(0.0, 7, 300.0), (4.5, 6, 1500.0), (8.5, 6, 800.0), (12.5, 4, 300.0), (15.5, 4, 1500.0)];
    let rate = 48000u32;
    let n = rate * 18;
    let mut pcm = vec![0i16; n as usize];
    for (at, count, hz) in plan {
        for k in 0..count {
            let a = ((at + f64::from(k) * 0.5) * f64::from(rate)).round() as usize;
            let len = (0.35 * f64::from(rate)) as usize;
            for (i, v) in pcm.iter_mut().enumerate().skip(a).take(len) {
                *v = (0.3 * (std::f64::consts::TAU * hz * i as f64 / f64::from(rate)).sin() * 32767.0).round() as i16;
            }
        }
    }
    let mut b = Vec::with_capacity(44 + pcm.len() * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 2).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    for v in [16u32.to_le_bytes(), [1, 0, 1, 0], rate.to_le_bytes(), (rate * 2).to_le_bytes(), [2, 0, 16, 0]] {
        b.extend_from_slice(&v);
    }
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 2).to_le_bytes());
    for v in pcm {
        b.extend_from_slice(&v.to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
    path.to_owned()
}

fn until(h: &mut H, secs: u64, done: impl Fn(&Shell) -> bool) -> bool {
    let start = Instant::now();
    while !done(h.state()) {
        if start.elapsed() > Duration::from_secs(secs) {
            return false;
        }
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// The window with the talk on A1 (and on A2 as music, for ducking) and a video on V1, the fake backends, a control
/// that holds a call 300 ms.
fn open(dir: &Path) -> H {
    let file = talk(&dir.join("talk.wav"));
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.features.speakers.backend = cut_app::speakers::backend::Backend::fake("");
    s.features.voice.backend = cut_app::voice::backend::Backend::fake("");
    s.features.speech.set_backend(Speech::fake("", Arc::new(SoundFiles::new(dir.join("sound")))));
    s.features.control = Control::with_hold(Some(dir.join("cut-control.json")), Duration::from_millis(300));
    let seq = s.app.sequence_id.unwrap();
    let probe = |p: &Path| cut_app::import::probe_file(p).result.unwrap();
    let r = s.app.exec(&cut_app::cmd::import_media(vec![probe(&file), probe(&media::h264_720p())], None)).unwrap();
    let (m, v) = (r["ids"][0].as_str().unwrap().to_owned(), r["ids"][1].as_str().unwrap().to_owned());
    let place = |track: &str, media: &str, kind: &str, out: f64| {
        json!({ "source": { "media": media }, "in": 0, "out": secs(out), "at": 0,
                "video": if kind == "v" { json!(track) } else { Json::Null }, "audio": if kind == "a" { json!(track) } else { Json::Null }, "mode": "overwrite" })
    };
    for (track, media, kind, out) in [("A1", &m, "a", 18.0), ("A2", &m, "a", 18.0), ("V1", &v, "v", 3.0)] {
        s.app.exec(&cut_model::commands::build::place(seq.as_str(), place(track, media, kind, out))).unwrap();
    }
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .with_step_dt(1.0 / 30.0)
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the window gave the monitors its GPU device");
    h.state_mut().transport.set_output_gain(0.0);
    h
}

fn raw(port: u16, token: &str, body: &str) -> Json {
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(120))).unwrap();
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    c.write_all(req.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = c.read_to_string(&mut out);
    let body = out.split_once("\r\n\r\n").map_or("", |x| x.1);
    serde_json::from_str(body).unwrap_or(Json::Null)
}

/// One call -> (its value or refusal, isError).
fn tool(port: u16, token: &str, name: &str, args: &Json) -> (Json, bool) {
    let body =
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } });
    let r = raw(port, token, &body.to_string());
    let text = r["result"]["content"][0]["text"].as_str().unwrap_or_default().to_owned();
    (serde_json::from_str(&text).unwrap_or(Json::String(text)), r["result"]["isError"].as_bool().unwrap_or(true))
}

/// A call answered to the end: its running answers followed by wait_job; the progress seen on the way.
fn job(port: u16, token: &str, name: &str, args: Json) -> (Json, bool, Vec<Json>) {
    let (mut v, mut err) = tool(port, token, name, &args);
    let mut seen = Vec::new();
    while !err && v["running"] == true {
        seen.push(v["progress"].clone());
        let j = v["job"].as_str().unwrap().to_owned();
        (v, err) = tool(port, token, "wait_job", &json!({ "job": j }));
    }
    (v, err, seen)
}

/// Runs `client` on a thread while the window steps; `answer` replies to the control's questions.
fn page<T: Send + 'static>(h: &mut H, answer: Option<bool>, client: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(client());
    });
    let start = Instant::now();
    loop {
        if let Ok(v) = rx.try_recv() {
            return v;
        }
        assert!(start.elapsed() < Duration::from_secs(240), "the client did not finish");
        assert!(!h.state().asking(), "no file dialog of the system may open");
        h.step();
        if let Some(yes) = answer {
            h.state().features.control.panel.asks.borrow_mut().reply(yes);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn run(h: &mut H, port: u16, t: &str, name: &'static str, args: Json) -> (Json, bool, Vec<Json>) {
    let t = t.to_owned();
    page(h, None, move || job(port, &t, name, args))
}

#[test]
fn every_job_runs_the_editors_own_analysis() {
    let dir = scratch("jobs");
    let mut h = open(&dir);
    let port = h.state_mut().features.control.start().unwrap();
    let floor = h.state().app.history.position();
    let t = h.state_mut().features.control.issue(1, floor).unwrap();
    let ids = |h: &H, track: &str| -> String {
        let s = h.state();
        let q = s.app.sequence().unwrap();
        q.clips_in_order().find(|c| c.track.as_str() == track).unwrap().id.as_str().to_owned()
    };
    let (a1, a2, v1) = (ids(&h, "A1"), ids(&h, "A2"), ids(&h, "V1"));

    let (v, err, _) = run(&mut h, port, &t, "get_transcript", json!({}));
    assert!(!err && v["note"].is_string(), "nothing recognised yet: {v}");
    let (v, err, _) = run(&mut h, port, &t, "automation", json!({ "action": "transcribe", "clip_ids": [a1] }));
    assert!(!err && v["job"] == "transcribe" && v["note"].is_string(), "{v}");
    let (v, err, _) = run(&mut h, port, &t, "get_transcript", json!({}));
    assert!(!err && v.as_array().is_some_and(|l| !l.is_empty()), "the recognised words as segments: {v}");

    let (v, err, _) = run(&mut h, port, &t, "automation", json!({ "action": "label_speakers", "speakers": 3 }));
    assert!(!err && v["speakers"].as_u64() == Some(3), "{v}");

    let (v, err, _) = run(
        &mut h,
        port,
        &t,
        "automation",
        json!({ "action": "auto_captions", "clip_ids": [a1], "chars_per_line": 20 }),
    );
    assert!(!err && v["count"].as_u64().is_some_and(|n| n > 0), "{v}");
    assert!(
        h.state().app.sequence().unwrap().captions.iter().any(|c| c.name == "Auto Captions"),
        "the Auto Captions track"
    );

    // the caption export names the speakers when the track's style shows names
    let track = h
        .state()
        .app
        .sequence()
        .unwrap()
        .captions
        .iter()
        .find(|c| c.name == "Auto Captions")
        .unwrap()
        .id
        .as_str()
        .to_owned();
    let (v, err, _) =
        run(&mut h, port, &t, "set_caption_track", json!({ "track_id": track, "style": { "speakers": "name" } }));
    assert!(!err, "{v}");
    let t2 = t.clone();
    let (v, err, _) = page(&mut h, Some(true), move || {
        job(port, &t2, "export_captions", json!({ "track_id": track, "file_name": "named" }))
    });
    assert!(!err && v["saved"] == "named.srt", "{v}");
    let srt = std::fs::read_to_string(h.state().doc.home.projects.join("named.srt")).unwrap();
    let tj = serde_json::to_value(h.state().app.project()).unwrap();
    assert!(
        srt.contains("Speaker 1"),
        "speaker names before the text:\n{srt}\n{}\n{}",
        tj["speakers"],
        tj["sequences"][0]["captions"]
    );

    let (v, err, seen) = run(&mut h, port, &t, "remove_silence", json!({ "longer_than": 0.3, "threshold": -40 }));
    assert!(!err && v["cuts"].as_u64().is_some_and(|n| n > 0), "{v}");
    let _ = seen;
    let (v, err, _) = run(
        &mut h,
        port,
        &t,
        "automation",
        json!({ "action": "remove_fillers", "fillers": true, "pauses": true, "pause_length": 0.3 }),
    );
    assert!(!err && v["cuts"].is_number(), "{v}");

    let (v, err, _) =
        run(&mut h, port, &t, "automation", json!({ "action": "detect_beats", "clip_ids": [a2], "every": "beat" }));
    assert!(!err && v["bpm"].is_number(), "{v}");

    let (v, err, _) = run(&mut h, port, &t, "set_clip", json!({ "clip_id": a2, "role": "music" }));
    assert!(!err, "{v}");
    let a1_now = ids(&h, "A1");
    let (v, err, _) = run(&mut h, port, &t, "set_clip", json!({ "clip_id": a1_now, "role": "dialogue" }));
    assert!(!err, "{v}");
    let (v, err, _) = run(&mut h, port, &t, "automation", json!({ "action": "auto_duck", "amount": -10 }));
    assert!(!err && v["count"].is_number(), "{v}");

    let (v, err, _) = run(&mut h, port, &t, "automation", json!({ "action": "isolate_voice", "clip_ids": [a1_now] }));
    assert!(!err && v["media"].as_array().is_some_and(|m| !m.is_empty()), "the vocals came in as media: {v}");

    let (v, err, _) =
        run(&mut h, port, &t, "automation", json!({ "action": "detect_scenes", "clip_ids": [v1], "mode": "markers" }));
    assert!(
        !err && v["count"].is_number() || (err && v.as_str().is_some_and(|e| e.contains("No scene changes"))),
        "{v}"
    );
    let (v, err, _) = run(&mut h, port, &t, "automation", json!({ "action": "auto_color", "clip_ids": [v1] }));
    assert!(!err && v["exposure"].is_number(), "{v}");

    // the frame: as a picture with the shown captions burned in, and written as a new PNG after the user's yes
    let (v, err, _) = run(&mut h, port, &t, "get_frame", json!({ "time": 1, "width": 320 }));
    assert!(!err && v["width"] == 320 && v["height"] == 180, "{v}");
    let t3 = t.clone();
    let (v, err, _) =
        page(&mut h, Some(true), move || job(port, &t3, "export_frame", json!({ "time": 1, "file_name": "still" })));
    assert!(!err && v["saved"] == "still.png", "{v}");
    let png = std::fs::read(h.state().doc.home.projects.join("still.png")).unwrap();
    assert_eq!(&png[1..4], b"PNG");
    h.state_mut().features.control.revoke(&t);
    h.state_mut().features.control.close();
}

#[test]
fn a_revoked_turn_stops_its_job() {
    let dir = scratch("revoke");
    let mut h = open(&dir);
    h.state_mut().features.control = Control::with_hold(None, Duration::from_millis(1));
    let port = h.state_mut().features.control.start().unwrap();
    let t = h.state_mut().features.control.issue(2, 0).unwrap();
    let t2 = t.clone();
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(tool(port, &t2, "automation", &json!({ "action": "transcribe" })));
    });
    let start = Instant::now();
    let first = loop {
        if let Ok(v) = rx.try_recv() {
            break v;
        }
        h.step();
        std::thread::sleep(Duration::from_millis(5));
        assert!(start.elapsed() < Duration::from_secs(60));
    };
    assert!(first.0["running"] == true, "the recognition outlasts the hold: {:?}", first.0);
    assert!(until(&mut h, 20, |s| s.features.speech.job.is_some()), "the recognition runs");
    h.state_mut().features.control.revoke(&t);
    assert!(until(&mut h, 30, |s| s.features.speech.job.is_none()), "revoked: the recognition is cancelled");
    assert!(!h.state().features.control.busy(), "the call ended");
    h.state_mut().features.control.close();
}
