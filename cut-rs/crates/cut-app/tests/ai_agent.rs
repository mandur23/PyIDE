//! The AI assistant's turn (`main/cut/agent.js`) with the stand-in CLI (`tools/fake-claude.mjs`; never the real
//! Claude): the CLI started with exactly the JavaScript's flags and environment, the MCP config with the turn's token
//! there while it runs and gone after, the stream-json lines turned into text, tool and result events, the usage,
//! Stop, the time limit and every failure code.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cut_app::ai::agent::{self, Agent, Event, Turn};
use cut_app::ai::claude::{Cli, Code, system_prompt_file, work_dir};
use serde_json::{Value as Json, json};

struct Fake {
    dir: PathBuf,
}

impl Fake {
    fn new(name: &str, runs: Json) -> Fake {
        let dir = std::env::temp_dir().join(format!("cut-app-agent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/fake-claude.mjs").canonicalize().unwrap();
        let script = script.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
        let cmd = format!("@echo off\r\nset FAKE_CLAUDE_DIR={}\r\nnode \"{script}\" %*\r\n", dir.display());
        std::fs::write(dir.join("claude.cmd"), cmd).unwrap();
        std::fs::write(dir.join("scenario.json"), json!({ "runs": runs }).to_string()).unwrap();
        Fake { dir }
    }

    fn agent(&self, timeout: Duration) -> Agent {
        Agent::new(
            Arc::new(Cli::with_switch(Some(self.dir.join("claude.cmd").to_string_lossy().into_owned()))),
            timeout,
        )
    }

    fn calls(&self) -> Vec<Json> {
        let text = std::fs::read_to_string(self.dir.join("calls.jsonl")).unwrap_or_default();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn turn(id: &str) -> Turn {
    Turn {
        id: id.into(),
        url: "http://127.0.0.1:45678/mcp".into(),
        token: "tok123".into(),
        tools: vec!["get_state".into(), "razor".into(), "wait_job".into()],
        system: "You edit.".into(),
        prompt: "The user's request: cut it".into(),
        model: Some("opus".into()),
    }
}

fn run(a: &Agent, t: &Turn) -> (Vec<Event>, agent::Done) {
    let mut events = Vec::new();
    let done = a.run(t, &mut |e| events.push(e));
    (events, done)
}

fn after<'a>(args: &'a [&'a str], flag: &str) -> &'a str {
    args[args.iter().position(|a| *a == flag).unwrap() + 1]
}

#[test]
fn a_turn_runs_the_cli_with_exactly_the_flags_and_its_events() {
    let lines = json!([
        { "type": "stream_event", "event": { "type": "message_start" } },
        { "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Cutting" } } },
        { "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": " now." } } },
        { "type": "assistant", "message": { "content": [
            { "type": "text", "text": "Cutting now." },
            { "type": "tool_use", "id": "tu1", "name": "mcp__cut__razor", "input": { "at": 3 } },
            { "type": "tool_use", "id": "tu2", "name": "mcp__other__x", "input": "bad" },
        ] } },
        { "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": "tu1", "content": [{ "type": "text", "text": "{\"cut\":2}" }] },
            { "type": "tool_result", "tool_use_id": "tu2", "is_error": true, "content": "x".repeat(2500) },
        ] } },
        { "type": "assistant", "message": { "content": [{ "type": "text", "text": "Done: cut at 3 s." }] } },
        { "type": "result", "subtype": "success", "is_error": false, "result": "Done: cut at 3 s.",
          "usage": { "input_tokens": 1200, "cache_read_input_tokens": 30000, "cache_creation_input_tokens": 500, "output_tokens": 450 },
          "total_cost_usd": 0.0421, "duration_ms": 17300, "num_turns": 3, "modelUsage": { "claude-opus": {} } },
    ]);
    let fake = Fake::new("events", json!([{ "lines": lines }]));
    let a = fake.agent(Duration::from_secs(60));
    let t = turn("turn1");
    let (events, done) = run(&a, &t);
    let call = &fake.calls()[0];
    let args: Vec<&str> = call["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    let config = after(&args, "--mcp-config").to_owned();
    let system = system_prompt_file("You edit.").unwrap();
    let want = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "opus",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        &config,
        "--allowedTools",
        "mcp__cut__get_state,mcp__cut__razor,mcp__cut__wait_job",
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        "80",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--system-prompt-file",
        &system.to_string_lossy(),
    ];
    assert_eq!(args, want);
    assert_eq!(call["disableClaudeMds"], "1");
    assert_eq!(call["stdin"], "The user's request: cut it");
    let cwd = PathBuf::from(call["cwd"].as_str().unwrap()).canonicalize().unwrap();
    assert_eq!(cwd, work_dir().canonicalize().unwrap());
    assert!(Path::new(&config).starts_with(work_dir()), "the config is in the CLI's empty folder");
    let mcp: Json =
        serde_json::from_str(call["mcpConfig"].as_str().expect("the config was there while it ran")).unwrap();
    assert_eq!(
        mcp,
        json!({ "mcpServers": { "cut": { "type": "http", "url": "http://127.0.0.1:45678/mcp", "headers": { "Authorization": "Bearer tok123" } } } })
    );
    assert!(!Path::new(&config).exists(), "the config is gone after the turn");

    let texts: Vec<(&str, bool)> = events
        .iter()
        .filter_map(|e| if let Event::Text { text, last } = e { Some((text.as_str(), *last)) } else { None })
        .collect();
    assert_eq!(
        texts,
        [
            ("Cutting", false),
            ("Cutting now.", false),
            ("Cutting now.", true),
            ("Done: cut at 3 s.", false),
            ("Done: cut at 3 s.", true)
        ]
    );
    let tools: Vec<(&str, &str, &Json)> = events
        .iter()
        .filter_map(|e| {
            if let Event::Tool { id, name, input } = e { Some((id.as_str(), name.as_str(), input)) } else { None }
        })
        .collect();
    assert_eq!(tools, [("tu1", "razor", &json!({ "at": 3 })), ("tu2", "mcp__other__x", &json!({}))]);
    let results: Vec<(&str, bool, usize)> = events
        .iter()
        .filter_map(
            |e| if let Event::Result { id, ok, text } = e { Some((id.as_str(), *ok, text.len())) } else { None },
        )
        .collect();
    assert_eq!(results, [("tu1", true, 9), ("tu2", false, 2000)]);
    assert!(matches!(events.last(), Some(Event::Done(d)) if *d == done));
    assert!(done.ok && done.text == "Done: cut at 3 s.");
    let u = done.usage.unwrap();
    assert_eq!(
        (u.input, u.cache_read, u.cache_write, u.output, u.turns, u.duration_ms),
        (1200, 30000, 500, 450, 3, 17300)
    );
    assert_eq!(
        (u.cost_usd, u.model.as_str(), u.models.as_slice()),
        (Some(0.0421), "opus", &["claude-opus".to_owned()][..])
    );
    let total = cut_app::ai::assistant::Total { turns: 1, input: 31700, output: 450, cost_usd: 0.0421 };
    let (line, tip) = cut_app::ai::assistant::usage_line(&u, &total);
    assert_eq!(line, "Opus · 32k in · 450 out · 17 s · ≈$0.042");
    assert!(
        tip.starts_with("Tokens in: 31,700 (new 1,200, read from the cache 30,000, written to the cache 500)"),
        "{tip}"
    );
}

#[test]
fn stop_and_the_time_limit_end_a_turn_and_take_the_config() {
    let fake = Fake::new("stop", json!([{ "sleepMs": 30000, "lines": [] }]));
    let a = Arc::new(fake.agent(Duration::from_secs(60)));
    let stopper = a.clone();
    let h = std::thread::spawn(move || {
        while stopper.running() == 0 {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(800));
        assert!(stopper.stop("turn2"));
    });
    let started = Instant::now();
    let (_, done) = run(&a, &turn("turn2"));
    h.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!((done.code, done.error.as_str(), done.usage.is_none()), (Some(Code::Cancelled), "Stopped", true));
    assert!(!a.stop("turn2"), "nothing runs after");
    let config = fake.calls()[0]["args"].as_array().unwrap().iter().position(|x| x == "--mcp-config").unwrap();
    let config = fake.calls()[0]["args"][config + 1].as_str().unwrap().to_owned();
    assert!(!Path::new(&config).exists());

    let a = fake.agent(Duration::from_secs(1));
    let (_, done) = run(&a, &turn("turn3"));
    assert_eq!((done.code, done.error.as_str()), (Some(Code::Timeout), "Claude Code did not finish in time"));
}

#[test]
fn every_failure_has_its_code() {
    let fake = Fake::new(
        "codes",
        json!([
            { "lines": [{ "type": "result", "subtype": "error_max_turns", "is_error": true }] },
            { "lines": [{ "type": "result", "subtype": "success", "is_error": true, "result": "Claude AI usage limit reached" }] },
            { "lines": [{ "type": "result", "subtype": "success", "is_error": true, "result": "Invalid API key · Please run /login" }] },
            { "stderr": "boom\n", "exit": 2 },
        ]),
    );
    let a = fake.agent(Duration::from_secs(60));
    let codes: Vec<(Option<Code>, String)> = (0..4)
        .map(|k| {
            let d = run(&a, &turn(&format!("t{k}"))).1;
            (d.code, d.error)
        })
        .collect();
    assert_eq!(
        codes,
        [
            (Some(Code::Cli), "error_max_turns".to_owned()),
            (Some(Code::Quota), "Claude AI usage limit reached".to_owned()),
            (Some(Code::Auth), "Invalid API key · Please run /login".to_owned()),
            (Some(Code::Cli), "boom".to_owned()),
        ]
    );

    let none = Agent::new(Arc::new(Cli::with_switch(Some("none".into()))), Duration::from_secs(5));
    let (events, d) = run(&none, &turn("t9"));
    assert_eq!((d.code, events.len()), (Some(Code::NotInstalled), 0));
    let calls = fake.calls().len();
    for (t, why) in [
        (Turn { tools: Vec::new(), ..turn("t5") }, "the editor has not listed its tools"),
        (Turn { url: String::new(), ..turn("t6") }, "the control server could not start"),
    ] {
        let (_, d) = run(&a, &t);
        assert_eq!((d.code, d.error.as_str()), (Some(Code::Cli), why));
    }
    for (t, why) in [
        (Turn { id: "no spaces".into(), ..turn("x") }, "a turn needs an id"),
        (Turn { model: Some("gpt".into()), ..turn("t7") }, "unknown model gpt"),
        (Turn { prompt: "  ".into(), ..turn("t8") }, "the request is missing or too long"),
        (Turn { system: String::new(), ..turn("t8") }, "the system prompt is missing or too long"),
    ] {
        let (_, d) = run(&a, &t);
        assert_eq!((d.code, d.error.as_str()), (Some(Code::BadArgs), why));
    }
    assert_eq!(fake.calls().len(), calls, "the CLI never started for them");
}
