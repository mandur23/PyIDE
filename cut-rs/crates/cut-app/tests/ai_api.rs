//! Cut's AI over an API (Nano Studio's Settings › AI › Connection): the CLI Cut is started with is then
//! `nano-studio-api.cmd`, which runs `main/ai/api-cli.js` (here with `node`; `main/ai/connection.js` writes it with
//! Nano Studio's own executable run as Node). Against a stand-in Anthropic API on 127.0.0.1, never the real one: an
//! answer streams through `claude::complete` as from Claude Code, and a refused key or a rate limit comes back as the
//! sign-in or usage-limit failure the notices explain.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};

use cut_app::ai::claude::{Ask, Code, complete};
use serde_json::{Value as Json, json};

/// A server that answers one request with `status` and `body`, and hands over the request's JSON body.
fn server(status: &'static str, body: String) -> (String, Receiver<Json>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else { return };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
        let mut buf = vec![0; length];
        let _ = reader.read_exact(&mut buf);
        let _ = tx.send(serde_json::from_slice(&buf).unwrap_or(Json::Null));
        let kind = if status.starts_with("200") { "text/event-stream" } else { "application/json" };
        let mut out = stream;
        let _ = write!(out, "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\nconnection: close\r\n\r\n{body}");
    });
    (url, rx)
}

fn sse(events: &[Json]) -> String {
    events.iter().map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap_or("message"))).collect()
}

/// `nano-studio-api.cmd` in a scratch folder, with the connection the launcher would give.
fn shim(name: &str, url: &str, key: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("cut-app-ai-api-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../main/ai/api-cli.js").canonicalize().unwrap();
    let script = script.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    let cmd = format!(
        "@echo off\r\nset \"PYIDE_ANTHROPIC_URL={url}\"\r\nset \"PYIDE_AI_CONNECTION={{\"provider\":\"anthropic\"}}\"\r\nset \"PYIDE_AI_KEY={key}\"\r\nnode \"{script}\" %*\r\n"
    );
    let file = dir.join("nano-studio-api.cmd");
    std::fs::write(&file, cmd).unwrap();
    (dir, file)
}

#[test]
fn an_answer_streams_from_the_api_as_from_claude_code() {
    let (url, asked) = server(
        "200 OK",
        sse(&[
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 3 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "다듬은 " } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "자막" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 2 } }),
        ]),
    );
    let (dir, bin) = shim("answer", &url, "sk-test");
    let mut streamed = Vec::new();
    let r = complete(
        &bin,
        &Ask { system: "POLISH SYSTEM", prompt: "captions to polish", model: "haiku" },
        &|| false,
        &mut |t| streamed.push(t.to_owned()),
    );
    let _ = std::fs::remove_dir_all(dir);
    assert_eq!(r.map(|a| a.text), Ok("다듬은 자막".to_owned()), "the API's answer");
    assert_eq!(streamed, ["다듬은 ", "다듬은 자막"], "streamed as it came");
    let body = asked.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(body["model"], "claude-haiku-5-5", "haiku is the current Haiku");
    assert_eq!(body["system"], "POLISH SYSTEM", "the system prompt file");
    assert_eq!(body["messages"][0]["content"], "captions to polish", "the prompt from stdin");
}

#[test]
fn a_refused_key_and_a_rate_limit_are_the_failures_the_notices_explain() {
    for (status, body, code) in [
        ("401 Unauthorized", json!({ "type": "error", "error": { "message": "invalid x-api-key" } }), Code::Auth),
        ("429 Too Many Requests", json!({ "type": "error", "error": { "message": "rate limited" } }), Code::Quota),
    ] {
        let (url, _asked) = server(status, body.to_string());
        let (dir, bin) = shim(&format!("fail-{}", &status[..3]), &url, "sk-wrong");
        let r = complete(&bin, &Ask { system: "s", prompt: "p", model: "sonnet" }, &|| false, &mut |_| {});
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(r.map_err(|f| f.code), Err(code), "{status}");
    }
}
