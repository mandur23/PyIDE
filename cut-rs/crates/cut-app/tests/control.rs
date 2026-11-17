//! The control server over real HTTP on 127.0.0.1 (an ephemeral port), with the real shell answering the calls on
//! this thread as the window's frames do: who may call (no token, a wrong one, Origin, Host, a revoked turn, the
//! external token only while allowed, Disconnect), the HTTP and JSON-RPC edges (GET, DELETE, a large body, broken
//! JSON, a batch, a notification, an unknown tool), the token kept with the port in the config file, every tool of
//! the table called once or more, the questions that wait for the user, and a long job answered by wait_job.

#[path = "media/mod.rs"]
mod media;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use cut_app::control::{Control, ShellHost, table};
use cut_app::files::Home;
use cut_app::i18n::{self, Lang};
use cut_app::import;
use cut_app::shell::Shell;
use cut_model::Id;
use eframe::egui;
use serde_json::{Value as Json, json};

fn scratch(name: &str) -> PathBuf {
    let base = std::env::var_os("CUT_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!("cut-app-control-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join("verify/fixtures").join(rel)
}

/// A shell with a video on V1 three times and a tone on A1, and a control whose file is in `dir`.
fn shell(dir: &Path) -> Shell {
    i18n::set_lang(Lang::En);
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.features.control = Control::with_hold(Some(dir.join("cut-control.json")), Duration::from_millis(300));
    let media = import::probe_file(&fixture("viewers/video/clip.mp4")).result.unwrap();
    let r = s.app.exec(&cut_app::cmd::import_media(vec![media], None)).unwrap();
    let m = Id::new(r["ids"][0].as_str().unwrap());
    let seq = s.app.sequence_id.unwrap();
    for i in 0..3 {
        s.app
            .exec(&cut_app::cmd::place(
                seq,
                m,
                Some(Id::new("V1")),
                Some(Id::new("A1")),
                i * 2 * cut_time::TICKS,
                "overwrite",
            ))
            .unwrap();
    }
    let tone = import::probe_file(&media::tone_aac()).result.unwrap();
    let r = s.app.exec(&cut_app::cmd::import_media(vec![tone], None)).unwrap();
    let m = Id::new(r["ids"][0].as_str().unwrap());
    s.app.exec(&cut_app::cmd::place(seq, m, None, Some(Id::new("A1")), 0, "overwrite")).unwrap();
    s
}

/// One frame of the page: the calls that came run on the shell.
fn pump(s: &mut Shell, ctx: &egui::Context) {
    let asks = s.features.control.panel.asks.clone();
    let mut stand_in = Control::new(None);
    stand_in.panel.asks = asks;
    let mut c = std::mem::replace(&mut s.features.control, stand_in);
    c.pump(&mut ShellHost { s, ctx });
    s.features.control = c;
}

/// A raw request -> (status, head, body).
fn raw(port: u16, request: &[u8]) -> (u16, String, String) {
    let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    c.write_all(request).unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 65536];
    loop {
        match c.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&out);
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if body.len() >= len {
                        break;
                    }
                }
            }
        }
    }
    let text = String::from_utf8_lossy(&out).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split(' ').nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    (status, head.to_owned(), body.to_owned())
}

fn request(port: u16, method: &str, token: Option<&str>, extra: &str, body: &str) -> (u16, String, String) {
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let r = format!(
        "{method} /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    raw(port, r.as_bytes())
}

fn rpc(port: u16, token: &str, method: &str, params: Json) -> Json {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
    let (status, _, text) = request(port, "POST", Some(token), "", &body);
    assert_eq!(status, 200, "{method}: {text}");
    serde_json::from_str(&text).unwrap()
}

/// A tools/call -> (its value or refusal text, isError).
fn tool(port: u16, token: &str, name: &str, args: Json) -> (Json, bool) {
    let r = rpc(port, token, "tools/call", json!({ "name": name, "arguments": args }));
    let res = &r["result"];
    let text = res["content"][0]["text"].as_str().unwrap_or_default().to_owned();
    let err = res["isError"].as_bool().unwrap_or(true);
    (serde_json::from_str(&text).unwrap_or(Json::String(text)), err)
}

/// A call followed to its own answer: a running answer (a slow machine, a job) is waited for with wait_job.
fn settled(port: u16, token: &str, name: &str, args: Json) -> (Json, bool) {
    let (mut v, mut err) = tool(port, token, name, args);
    while !err && v["running"] == true {
        let job = v["job"].as_str().unwrap_or_default().to_owned();
        (v, err) = tool(port, token, "wait_job", json!({ "job": job }));
    }
    (v, err)
}

/// Runs `client` on a thread while this thread pumps the page; `answer` replies to the questions that show.
fn with_page<T: Send + 'static>(s: &mut Shell, answer: Option<bool>, client: impl FnOnce() -> T + Send + 'static) -> T {
    let ctx = egui::Context::default();
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(client());
    });
    let start = Instant::now();
    loop {
        if let Ok(v) = rx.try_recv() {
            return v;
        }
        assert!(start.elapsed() < Duration::from_secs(120), "the client did not finish");
        pump(s, &ctx);
        if let Some(yes) = answer {
            s.features.control.panel.asks.borrow_mut().reply(yes);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn who_may_call_and_the_http_edges() {
    let dir = scratch("security");
    let mut s = shell(&dir);
    let port = s.features.control.start().unwrap();
    let chat = s.features.control.issue(1, 0).unwrap();
    let wrong = "0".repeat(48);
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "Test" } } }).to_string();
    let (st, head, body) = request(port, "POST", None, "", &init);
    assert_eq!(st, 401, "no token");
    assert!(head.contains("WWW-Authenticate: Bearer"), "{head}");
    assert!(body.contains("A valid token is needed."));
    assert_eq!(request(port, "POST", Some(&wrong), "", &init).0, 401, "a wrong token");
    assert_eq!(request(port, "POST", Some(&chat[..47]), "", &init).0, 401, "a shorter token");
    let (st, _, body) = request(port, "POST", Some(&chat), "Origin: https://evil.example\r\n", &init);
    assert_eq!((st, body.contains("Web pages may not call")), (403, true), "an Origin header, before the token");
    assert_eq!(
        request(port, "POST", None, "Origin: http://localhost\r\n", &init).0,
        403,
        "Origin is refused before the token"
    );
    let other = format!(
        "POST /mcp HTTP/1.1\r\nHost: evil.example:{port}\r\nAuthorization: Bearer {chat}\r\nContent-Length: {}\r\n\r\n{init}",
        init.len()
    );
    let (st, _, body) = raw(port, other.as_bytes());
    assert_eq!((st, body.contains("Wrong host.")), (403, true), "another Host");
    let local = format!(
        "POST /mcp HTTP/1.1\r\nHost: localhost:{port}\r\nAuthorization: Bearer {chat}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{init}",
        init.len()
    );
    assert_eq!(raw(port, local.as_bytes()).0, 200, "localhost:<port> is this host");
    let (st, head, _) = request(port, "GET", Some(&chat), "", "");
    assert_eq!(st, 405, "GET");
    assert!(head.contains("Allow: POST"));
    assert_eq!(request(port, "DELETE", Some(&chat), "", "").0, 405, "DELETE");
    assert_eq!(
        raw(port, format!("POST /other HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\n\r\n").as_bytes()).0,
        404
    );
    let big = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {chat}\r\nContent-Length: {}\r\n\r\n",
        2 * 1024 * 1024
    );
    assert_eq!(raw(port, big.as_bytes()).0, 413, "a body over 1 MB");
    let (st, _, body) = request(port, "POST", Some(&chat), "", "{not json");
    assert_eq!(st, 400);
    assert_eq!(serde_json::from_str::<Json>(&body).unwrap()["error"]["code"], -32700, "a parse error");
    let (st, _, body) = request(port, "POST", Some(&chat), "", "[]");
    assert_eq!(
        (st, serde_json::from_str::<Json>(&body).unwrap()["error"]["code"].as_i64()),
        (400, Some(-32600)),
        "a batch"
    );
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
    assert_eq!(request(port, "POST", Some(&chat), "", &note).0, 202, "a notification");
    let (st, head, body) = request(port, "POST", Some(&chat), "", &init);
    assert_eq!(st, 200);
    assert!(head.contains("Mcp-Session-Id: "), "{head}");
    let r: Json = serde_json::from_str(&body).unwrap();
    assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(r["result"]["serverInfo"]["name"], "Nano Studio Cut");
    assert_eq!(r["result"]["instructions"], table::instructions());
    assert_eq!(rpc(port, &chat, "ping", json!({}))["result"], json!({}));
    assert_eq!(rpc(port, &chat, "nope", json!({}))["error"]["code"], -32601);
    let list = rpc(port, &chat, "tools/list", json!({}));
    let names: Vec<&str> =
        list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(names.len(), table::tools().len() + 1);
    assert_eq!(names.last(), Some(&"wait_job"));
    let r = rpc(port, &chat, "tools/call", json!({ "name": "rm_rf" }));
    assert_eq!(r["error"]["code"], -32602, "a tool that is not listed never reaches the page");
    let r = rpc(port, &chat, "tools/call", json!({ "name": "get_state", "arguments": [1] }));
    assert_eq!(r["error"]["code"], -32602);
    let (v, err) = with_page(&mut s, None, {
        let chat = chat.clone();
        move || tool(port, &chat, "get_state", json!({}))
    });
    assert!(!err && v["sequence"].is_string(), "{v}");
    // the external token only while allowed; Disconnect replaces it; the turn's token dies with revoke
    s.features.control.set_external(true);
    let ext = s.features.control.external().unwrap().clone();
    assert_eq!(ext.url, format!("http://127.0.0.1:{port}/mcp"));
    assert_eq!(ext.token.len(), 48);
    let (_, err) = with_page(&mut s, None, {
        let t = ext.token.clone();
        move || tool(port, &t, "get_project", json!({}))
    });
    assert!(!err, "the external AI while allowed");
    let saved: Json = serde_json::from_str(&std::fs::read_to_string(dir.join("cut-control.json")).unwrap()).unwrap();
    assert_eq!(saved, json!({ "port": port, "token": ext.token }), "the JavaScript's file and format");
    s.features.control.disconnect();
    let again = s.features.control.external().unwrap().clone();
    assert_ne!(again.token, ext.token);
    assert_eq!(request(port, "POST", Some(&ext.token), "", &init).0, 401, "the old token after Disconnect");
    s.features.control.set_external(false);
    assert_eq!(request(port, "POST", Some(&again.token), "", &init).0, 401, "off: the external token is refused");
    s.features.control.revoke(&chat);
    assert_eq!(request(port, "POST", Some(&chat), "", &init).0, 401, "a revoked turn's token");
    s.features.control.close();
    // a restart keeps the port and the token: a client set up once keeps working
    let mut c = Control::new(Some(dir.join("cut-control.json")));
    c.set_external(true);
    let back = c.external().unwrap().clone();
    assert_eq!(back.token, again.token);
    c.close();
}

#[test]
fn every_tool_through_the_server() {
    let dir = scratch("tools");
    let mut s = shell(&dir);
    let port = s.features.control.start().unwrap();
    let t = s.features.control.issue(7, 0).unwrap();
    let seq = with_page(&mut s, None, {
        let t = t.clone();
        move || tool(port, &t, "get_sequence", json!({})).0
    });
    let first = |track: &str| {
        seq["clips"].as_array().unwrap().iter().find(|c| c["track"] == track).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (v1, a1) = (first("V1"), first("A1"));
    let media = s.app.project().media[0].id.as_str().to_owned();
    let mut done: Vec<String> = Vec::new();
    let calls: Vec<(&str, Json, bool)> = vec![
        ("get_project", json!({}), false),
        ("get_sequence", json!({ "max_clips": 2 }), false),
        ("get_clip", json!({ "clip_id": v1 }), false),
        ("get_media", json!({}), false),
        ("get_markers", json!({}), false),
        ("get_captions", json!({}), false),
        ("get_transcript", json!({}), false),
        ("list_effects", json!({ "kind": "video" }), false),
        ("get_frame", json!({ "time": 1 }), true),
        ("get_state", json!({}), false),
        ("list_actions", json!({ "search": "marker" }), false),
        ("place_clip", json!({ "media_id": media, "at": 6 }), false),
        ("move_clips", json!({ "clip_ids": [v1], "delta": 0.1 }), false),
        ("trim_clip", json!({ "clip_id": v1, "edge": "end", "delta": -0.2 }), false),
        ("razor", json!({ "at": 0.5 }), false),
        ("delete_clips", json!({ "clip_ids": ["c999"] }), true),
        ("delete_range", json!({ "from": 0, "to": 0.1 }), false),
        ("link_clips", json!({ "clip_ids": [v1, a1], "action": "group" }), false),
        ("set_clip", json!({ "clip_id": v1, "opacity": 80 }), false),
        ("set_speed", json!({ "clip_id": v1, "speed": 50 }), false),
        ("set_time_remap", json!({ "clip_id": v1, "off": true }), false),
        ("set_keyframes", json!({ "clip_id": v1, "property": "rotation", "keyframes": [] }), false),
        ("add_effect", json!({ "clip_id": v1, "type": "blur.gaussian" }), false),
        ("set_effect", json!({ "clip_id": v1, "effect_id": "e1", "on": false }), false),
        ("remove_effect", json!({ "clip_id": v1, "effect_id": "e1" }), false),
        ("set_color", json!({ "clip_id": v1, "exposure": 0.2 }), false),
        ("add_transition", json!({ "track": "V1", "at": 2.2 }), false),
        ("remove_transition", json!({ "transition_id": "t9999" }), true),
        ("add_text", json!({ "text": "Title", "at": 1 }), false),
        ("set_text", json!({ "clip_id": v1, "text": "x" }), true),
        ("add_captions", json!({ "items": [{ "start": 0, "end": 1, "text": "Hi" }] }), false),
        ("set_caption", json!({ "track_id": "cc0", "caption_id": "cap0" }), true),
        ("remove_captions", json!({ "track_id": "cc0" }), true),
        ("add_marker", json!({ "at": 1, "name": "M" }), false),
        ("set_marker", json!({ "marker_id": "mk0" }), true),
        ("remove_markers", json!({ "kind": "all" }), false),
        ("add_mask", json!({ "clip_id": v1, "shape": "ellipse" }), false),
        ("set_mask", json!({ "clip_id": v1, "mask_id": "m1", "feather": 5 }), false),
        ("remove_mask", json!({ "clip_id": v1, "mask_id": "m1" }), false),
        ("nest_clips", json!({ "clip_ids": ["c999"] }), true),
        ("set_track", json!({ "track_id": "A1", "volume": -2 }), false),
        ("set_sequence", json!({ "master_gain": -1 }), false),
        ("remove_silence", json!({ "longer_than": 1 }), true),
        ("select_clips", json!({ "clip_ids": [v1] }), false),
        ("seek", json!({ "time": 1 }), false),
        ("play", json!({}), false),
        ("stop", json!({}), false),
        ("undo", json!({}), false),
        ("redo", json!({}), false),
        ("remove_media", json!({ "unused": true }), true),
        ("project_items", json!({ "action": "new_bin", "name": "B" }), false),
        ("add_sequence", json!({ "name": "S2", "active": false }), false),
        ("remove_sequence", json!({ "sequence_id": "s999" }), true),
        ("add_track", json!({ "kind": "audio" }), false),
        ("remove_track", json!({ "track_id": "A9" }), true),
        ("set_transition", json!({ "transition_id": "t9999" }), true),
        ("set_caption_track", json!({ "track_id": "cc0" }), true),
        ("add_color_matte", json!({ "at": 0, "duration": 1 }), false),
        ("set_project_settings", json!({ "fit": "fill" }), false),
        ("export_queue", json!({}), false),
        ("proxies", json!({}), false),
        ("create_shorts", json!({ "ranges": [{ "from": 0, "to": 1 }] }), false),
        ("automation", json!({ "action": "detect_beats" }), true),
        ("essential_sound", json!({ "sequence_id": "s1", "clip_ids": [a1], "action": "hard_limiter" }), false),
        ("speakers", json!({}), false),
        ("add_graphic", json!({ "sequence_id": "s1", "at": 0, "layers": [{ "kind": "rect" }] }), false),
        ("set_graphic", json!({ "sequence_id": "s1", "clip_id": v1 }), true),
        ("run_action", json!({ "id": "markIn", "time": 0.5 }), false),
    ];
    for (name, args, want_err) in calls {
        let (v, err) = with_page(&mut s, None, {
            let (t, args) = (t.clone(), args.clone());
            move || settled(port, &t, name, args)
        });
        assert_eq!(err, want_err, "{name} {args}: {v}");
        done.push(name.to_owned());
    }
    // the questions: a declined export changes nothing; an accepted caption export and frame write new files
    let seq_id = s.app.project().sequences[0].id.as_str().to_owned();
    let (v, err) = with_page(&mut s, Some(false), {
        let (t, seq_id) = (t.clone(), seq_id.clone());
        move || settled(port, &t, "export_sequence", json!({ "sequence_id": seq_id, "preset": "720p" }))
    });
    assert!(err && v.as_str().unwrap().contains("said no"), "{v}");
    assert!(s.features.export.queue.is_empty());
    let (v, err) = with_page(&mut s, Some(true), {
        let (t, seq_id) = (t.clone(), seq_id.clone());
        move || {
            settled(port, &t, "export_sequence", json!({ "sequence_id": seq_id, "preset": "720p", "file_name": "ai" }))
        }
    });
    assert!(!err && v["queued"] == "ai.mp4", "{v}");
    assert_eq!(s.features.export.queue.len(), 1, "it joined the queue");
    let (v, err) = with_page(&mut s, Some(true), {
        let (t, seq_id) = (t.clone(), seq_id.clone());
        move || settled(port, &t, "export_captions", json!({ "sequence_id": seq_id, "file_name": "subs" }))
    });
    assert!(!err && v["saved"] == "subs.srt", "{v}");
    assert!(s.doc.home.projects.join("subs.srt").is_file(), "written in Projects (the project was never saved)");
    let (v, err) = with_page(&mut s, Some(true), {
        let (t, seq_id) = (t.clone(), seq_id.clone());
        move || settled(port, &t, "export_frame", json!({ "sequence_id": seq_id, "file_name": "f" }))
    });
    assert!(err && v.as_str().unwrap().contains("could not be saved"), "no GPU monitors in this test: {v}");
    let outside = scratch("outside").join("x.mp4");
    std::fs::copy(fixture("viewers/video/clip.mp4"), &outside).unwrap();
    let (v, err) = with_page(&mut s, Some(false), {
        let (t, p) = (t.clone(), outside.to_string_lossy().into_owned());
        move || settled(port, &t, "import_media", json!({ "paths": [p] }))
    });
    assert!(err && v.as_str().unwrap().contains("did not confirm"), "{v}");
    let n = s.app.project().media.len();
    let (v, err) = with_page(&mut s, Some(true), {
        let (t, p) = (t.clone(), outside.to_string_lossy().into_owned());
        move || settled(port, &t, "import_media", json!({ "paths": [p] }))
    });
    assert!(!err, "{v}");
    assert_eq!(s.app.project().media.len(), n + 1, "confirmed: it came in: {v}");
    // a project with its file saves there (an untitled one would open Save As, the user's dialog)
    let file = s.doc.home.projects.join("ai.ncut");
    s.app.path = Some(file.clone());
    let (v, err) = with_page(&mut s, None, {
        let t = t.clone();
        move || settled(port, &t, "save_project", json!({}))
    });
    assert!(!err && v["saved"] == "ai.ncut", "{v}");
    assert!(file.is_file(), "the project's own file");
    done.extend(
        ["export_sequence", "export_captions", "export_frame", "import_media", "save_project"].map(str::to_owned),
    );
    // a long job: Match Loudness of the sequence, answered by wait_job (a control that holds a call 1 ms)
    s.app.selection.clear();
    s.features.control.revoke(&t);
    s.features.control.close();
    s.features.control = Control::with_hold(None, Duration::from_millis(1));
    let port = s.features.control.start().unwrap();
    let t = s.features.control.issue(8, 0).unwrap();
    let (first, err) = with_page(&mut s, None, {
        let t = t.clone();
        move || tool(port, &t, "automation", json!({ "sequence_id": "s1", "action": "match_loudness", "target": -16 }))
    });
    assert!(!err, "{first}");
    assert_eq!(first["running"], true, "measuring outlasts the hold: {first}");
    let answer = {
        let job = first["job"].as_str().unwrap().to_owned();
        let (busy, berr) = with_page(&mut s, None, {
            let t = t.clone();
            move || tool(port, &t, "get_state", json!({}))
        });
        assert!(berr && busy.as_str().unwrap().contains("still running"), "{busy}");
        loop {
            let (v, err) = with_page(&mut s, None, {
                let (t, job) = (t.clone(), job.clone());
                move || tool(port, &t, "wait_job", json!({ "job": job }))
            });
            assert!(!err, "{v}");
            if v["running"] != true {
                break v;
            }
        }
    };
    assert!(answer["gain"].is_number() && answer["job"] == "match_loudness", "{answer}");
    done.push("automation".into());
    done.push("wait_job".into());
    let (v, err) = with_page(&mut s, None, {
        let t = t.clone();
        move || tool(port, &t, "wait_job", json!({ "job": "job1" }))
    });
    assert!(err && v.as_str().unwrap().contains("There is no running job"), "{v}");
    let missing: Vec<&str> =
        table::tools().iter().map(|x| x.name.as_str()).filter(|n| !done.iter().any(|d| d == n)).collect();
    assert!(missing.is_empty(), "tools never called through the server: {missing:?}");
    s.features.control.revoke(&t);
    s.features.control.close();
}

/// One frame of the control's own part of the window (the setting, the question, the calls), headless.
fn frame(s: &mut Shell, ctx: &egui::Context) {
    let mut out = ctx.run_pass(egui::RawInput::default(), |ctx| cut_app::control::panel::windows(s, ctx));
    out.textures_delta.clear();
}

/// `control.external` carried over from the JavaScript Cut, with its token file: off until the person answers the
/// question once; `yes` keeps it on with that token, no turns it off. The answer is remembered for the next start.
fn carried(yes: bool) {
    use cut_app::control::panel::{CONFIRMED, SETTING};
    let dir = scratch(if yes { "carried-yes" } else { "carried-no" });
    let token = "ab".repeat(24);
    std::fs::write(dir.join("cut-control.json"), json!({ "port": 0, "token": token }).to_string()).unwrap();
    let mut s = shell(&dir);
    s.doc.settings.set(SETTING, json!(true));
    let _ = s.doc.settings.save();
    let ctx = egui::Context::default();
    frame(&mut s, &ctx);
    let open = s.features.control.panel.asks.borrow().open();
    assert_eq!(open.len(), 1, "one question at the first start");
    assert!(open[0].1.contains("Claude Code"), "it names what it allows: {}", open[0].1);
    assert!(s.features.control.external().is_none(), "off until the answer");
    let port = s.features.control.start().unwrap();
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
    assert_eq!(request(port, "POST", Some(&token), "", &init).0, 401, "the carried token is refused before the answer");
    frame(&mut s, &ctx);
    assert_eq!(s.features.control.panel.asks.borrow().open().len(), 1, "asked once, not again each frame");
    assert!(s.features.control.panel.asks.borrow_mut().reply(yes));
    frame(&mut s, &ctx);
    frame(&mut s, &ctx);
    assert_eq!(s.doc.settings.get(CONFIRMED), Some(&json!(true)), "the answer is remembered");
    assert_eq!(s.doc.settings.get(SETTING), Some(&json!(yes)));
    if yes {
        assert_eq!(s.features.control.external().map(|e| e.token.clone()), Some(token.clone()), "the client's token");
        assert_eq!(request(port, "POST", Some(&token), "", &init).0, 200, "Yes: the client keeps working");
    } else {
        assert!(s.features.control.external().is_none());
        assert_eq!(request(port, "POST", Some(&token), "", &init).0, 401, "No: refused");
    }
    s.features.control.close();
    // the next start asks nothing
    let mut again = Shell::new(Home::at(dir.join("home")));
    again.features.control = Control::new(Some(dir.join("cut-control.json")));
    frame(&mut again, &ctx);
    assert!(again.features.control.panel.asks.borrow().open().is_empty(), "the answer holds at the next start");
    assert_eq!(again.features.control.external().is_some(), yes);
    again.features.control.close();
}

#[test]
fn a_carried_over_permission_is_asked_once_yes() {
    carried(true);
}

#[test]
fn a_carried_over_permission_is_asked_once_no() {
    carried(false);
}
