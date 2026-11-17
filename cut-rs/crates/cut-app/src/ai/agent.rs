//! The AI assistant's turns (`main/cut/agent.js`): one request of the chat panel runs the Claude Code CLI connected to
//! the editor's control server and to nothing else:
//!   `--tools ""`              no built-in tool: no Bash, no file, no web tool
//!   `--strict-mcp-config`     only the MCP server of `--mcp-config`, never the user's own servers
//!   `--allowedTools`          exactly the Cut tools (`mcp__cut__<name>`), which run without asking
//!   `--permission-mode dontAsk`   anything else is refused, never asked
//! The MCP config (a file in the CLI's empty working folder, with this turn's token) goes when the turn ends.
//!
//! The CLI's stream-json lines become [`Event`]s: text (what Claude says, as it streams), a tool call, a tool's
//! result, and last [`Done`] with its code (`not-installed`, `auth`, `quota`, `cli`, `cancelled`, `timeout`,
//! `badArgs`) and the usage the result line reports.
//!
//! Threads: [`Agent::run`] blocks the turn's own thread; [`Agent::stop`] may be called from the UI thread. The token
//! is the control's (UI thread): it is issued before the turn and revoked by the panel at Stop and at the end.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value as Json, json};

use super::claude::{self, Cli, Code, Failure, js_text, kill_tree, launch, system_prompt_file};
use super::js::truthy;
use super::runner::{MODELS, is_id};

/// The server's name in the MCP config: the tools are `mcp__cut__<name>`.
pub const SERVER: &str = "cut";
const PROMPT_LIMIT: usize = 100_000;
const SYSTEM_LIMIT: usize = 20_000;
/// How long a turn may take (`TIMEOUT_MS`).
pub const TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// How many model turns a request may take (`MAX_TURNS`).
pub const MAX_TURNS: u32 = 80;

/// A turn asked: its id, the control server's address, the turn's token and the tools (from the control on the UI
/// thread, which revokes the token when the turn ends or is stopped), the prompts and the model.
#[derive(Debug, Clone, Default)]
pub struct Turn {
    pub id: String,
    pub url: String,
    pub token: String,
    pub tools: Vec<String>,
    pub system: String,
    pub prompt: String,
    pub model: Option<String>,
}

/// What a turn used, as its result line reports it (`usageOf`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Usage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub turns: u64,
    pub model: String,
    pub models: Vec<String>,
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Done {
    pub ok: bool,
    pub text: String,
    pub code: Option<Code>,
    pub error: String,
    pub usage: Option<Usage>,
}

impl Done {
    fn failed(f: Failure) -> Done {
        Done { ok: false, code: Some(f.code), error: f.error, ..Done::default() }
    }
}

/// What the CLI says while a turn runs.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// What Claude has written so far of this message; `last` once the message is whole.
    Text {
        text: String,
        last: bool,
    },
    /// A tool call (the name without `mcp__cut__`).
    Tool {
        id: String,
        name: String,
        input: Json,
    },
    /// A tool's answer: refused when not `ok`.
    Result {
        id: String,
        ok: bool,
        text: String,
    },
    Done(Done),
}

/// `Number(v)` of a JSON value.
fn js_number(v: &Json) -> f64 {
    match v {
        Json::Null => 0.0,
        Json::Bool(b) => f64::from(u8::from(*b)),
        Json::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Json::String(s) => {
            let t = super::js::trim(s);
            if t.is_empty() {
                0.0
            } else {
                t.parse().ok().filter(|x: &f64| !x.is_nan() || t == "NaN").unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

fn count(v: &Json) -> u64 {
    match v.as_f64() {
        Some(x) if x.is_finite() && x >= 0.0 => cut_formats::table::js_round(x) as u64,
        _ => 0,
    }
}

/// `usageOf`: the result line's usage, `None` when it reports none.
pub fn usage_of(result: Option<&Json>, alias: &str) -> Option<Usage> {
    let r = result.filter(|r| r.is_object())?;
    let u = r.get("usage").filter(|u| u.is_object()).cloned().unwrap_or_else(|| json!({}));
    let models = r.get("modelUsage").and_then(Json::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let cost = r.get("total_cost_usd").map_or(f64::NAN, js_number);
    let out = Usage {
        input: count(&u["input_tokens"]),
        cache_read: count(&u["cache_read_input_tokens"]),
        cache_write: count(&u["cache_creation_input_tokens"]),
        output: count(&u["output_tokens"]),
        cost_usd: (cost.is_finite() && cost >= 0.0).then_some(cost),
        duration_ms: count(&r["duration_ms"]),
        turns: count(&r["num_turns"]),
        model: alias.to_owned(),
        models,
    };
    (out.input > 0 || out.cache_read > 0 || out.cache_write > 0 || out.output > 0 || out.cost_usd.is_some())
        .then_some(out)
}

/// `textOf`: a tool result's content as text.
fn text_of(content: &Json) -> String {
    match content {
        Json::String(s) => s.clone(),
        Json::Array(_) => claude::text_blocks(content, "\n"),
        _ => String::new(),
    }
}

/// The first `n` UTF-16 units of `s` (`slice(0, n)`).
fn units(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > n {
            break;
        }
        out.push(c);
    }
    out
}

/// The turns of the assistant: the CLI, the time limit, and the turns running.
pub struct Agent {
    pub cli: Arc<Cli>,
    pub timeout: Duration,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

static CONFIGS: AtomicU64 = AtomicU64::new(0);

/// A name no other turn's config file has.
fn config_name() -> String {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(CONFIGS.fetch_add(1, Ordering::Relaxed));
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    h.write_u32(std::process::id());
    format!("cut-mcp-{:012x}.json", h.finish() & 0xffff_ffff_ffff)
}

/// The flags of a turn's CLI, in the JavaScript's order.
pub fn args(model: &str, config: &str, names: &[String], system_file: &str) -> Vec<String> {
    let allowed: Vec<String> = names.iter().map(|n| format!("mcp__{SERVER}__{n}")).collect();
    [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        config,
        "--allowedTools",
        &allowed.join(","),
        "--permission-mode",
        "dontAsk",
        "--max-turns",
        &MAX_TURNS.to_string(),
        "--no-session-persistence",
        "--disable-slash-commands",
        "--system-prompt-file",
        system_file,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

impl Agent {
    pub fn new(cli: Arc<Cli>, timeout: Duration) -> Agent {
        Agent { cli, timeout, running: Mutex::new(HashMap::new()) }
    }

    /// Whether a turn runs.
    pub fn running(&self) -> usize {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// `stop`: ends a running turn (cancelled) -> whether there was one.
    pub fn stop(&self, turn: &str) -> bool {
        match self.running.lock().unwrap_or_else(|e| e.into_inner()).get(turn) {
            Some(f) => {
                f.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// `run`: one turn. `emit` gets its events (the last is [`Event::Done`] once the CLI ran); the same end is
    /// returned, also for a turn refused before the CLI started.
    pub fn run(&self, t: &Turn, emit: &mut dyn FnMut(Event)) -> Done {
        let bad = |e: &str| Done::failed(Failure::new(Code::BadArgs, e));
        let model = t.model.as_deref().unwrap_or("sonnet");
        if !is_id(&t.id) {
            return bad("a turn needs an id");
        }
        if !MODELS.contains(&model) {
            return bad(&format!("unknown model {model}"));
        }
        if t.system.is_empty() || t.system.encode_utf16().count() > SYSTEM_LIMIT {
            return bad("the system prompt is missing or too long");
        }
        if super::js::trim(&t.prompt).is_empty() || t.prompt.encode_utf16().count() > PROMPT_LIMIT {
            return bad("the request is missing or too long");
        }
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            if running.contains_key(&t.id) {
                return bad("that turn is running already");
            }
            running.insert(t.id.clone(), stop.clone());
        }
        let done = self.turn(t, model, &stop, emit);
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&t.id);
        done
    }

    fn turn(&self, t: &Turn, model: &str, stop: &AtomicBool, emit: &mut dyn FnMut(Event)) -> Done {
        let Some(bin) = self.cli.find() else {
            return Done::failed(Failure::new(Code::NotInstalled, "Claude Code is not installed"));
        };
        if t.url.is_empty() || t.token.is_empty() {
            return Done::failed(Failure::new(Code::Cli, "the control server could not start"));
        }
        if t.tools.is_empty() {
            return Done::failed(Failure::new(Code::Cli, "the editor has not listed its tools"));
        }
        let config: PathBuf = claude::work_dir().join(config_name());
        let cleanup = |config: &PathBuf| {
            let _ = std::fs::remove_file(config);
        };
        let body = json!({ "mcpServers": { SERVER: {
            "type": "http", "url": t.url, "headers": { "Authorization": format!("Bearer {}", t.token) },
        } } });
        let written =
            std::fs::create_dir_all(claude::work_dir()).and_then(|()| std::fs::write(&config, body.to_string()));
        if let Err(e) = written {
            cleanup(&config);
            return Done::failed(Failure::new(Code::Cli, format!("cannot write the MCP settings: {e}")));
        }
        let system = match system_prompt_file(&t.system) {
            Ok(f) => f,
            Err(e) => {
                cleanup(&config);
                return Done::failed(Failure::new(Code::Cli, e.to_string()));
            }
        };
        let argv = args(model, &config.to_string_lossy(), &t.tools, &system.to_string_lossy());
        let mut child = match launch(&bin, &argv, &[("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1")]) {
            Ok(c) => c,
            Err(f) => {
                cleanup(&config);
                return Done::failed(f);
            }
        };
        let out = claude::Output::read(&mut child, &t.prompt);
        let deadline = Instant::now() + self.timeout;
        let mut ended: Option<Code> = None;
        let (mut result, mut streamed, mut saw_delta) = (None::<Json>, String::new(), false);
        let own = |n: &Json| {
            let n = n.as_str().unwrap_or("");
            n.strip_prefix(&format!("mcp__{SERVER}__")).unwrap_or(n).to_owned()
        };
        loop {
            if ended.is_none() {
                if stop.load(Ordering::SeqCst) {
                    ended = Some(Code::Cancelled);
                } else if Instant::now() >= deadline {
                    ended = Some(Code::Timeout);
                }
                if ended.is_some() {
                    kill_tree(&mut child);
                }
            }
            let line = match out.next(Duration::from_millis(50)) {
                claude::Next::Line(l) => l,
                claude::Next::Idle => continue,
                claude::Next::Ended => break,
            };
            let Ok(msg) = serde_json::from_str::<Json>(&line) else { continue };
            match msg["type"].as_str() {
                Some("stream_event") => {
                    let ev = &msg["event"];
                    if ev["type"] == "message_start" {
                        streamed.clear();
                    }
                    if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                        saw_delta = true;
                        streamed.push_str(&js_text(&ev["delta"]["text"]));
                        emit(Event::Text { text: streamed.clone(), last: false });
                    }
                }
                Some("assistant") => {
                    let blocks = &msg["message"]["content"];
                    let text = claude::text_blocks(blocks, "");
                    if !text.is_empty() && !saw_delta {
                        emit(Event::Text { text: text.clone(), last: false });
                    }
                    if !text.is_empty() {
                        emit(Event::Text { text, last: true });
                    }
                    saw_delta = false;
                    streamed.clear();
                    for b in blocks.as_array().map_or(&[][..], Vec::as_slice).iter().filter(|b| b["type"] == "tool_use")
                    {
                        let input = if b["input"].is_object() { b["input"].clone() } else { json!({}) };
                        emit(Event::Tool { id: js_text(&b["id"]), name: own(&b["name"]), input });
                    }
                }
                Some("user") => {
                    let blocks = &msg["message"]["content"];
                    for b in
                        blocks.as_array().map_or(&[][..], Vec::as_slice).iter().filter(|b| b["type"] == "tool_result")
                    {
                        let text = units(&text_of(&b["content"]), 2000);
                        emit(Event::Result { id: js_text(&b["tool_use_id"]), ok: !truthy(&b["is_error"]), text });
                    }
                }
                Some("result") => result = Some(msg),
                _ => {}
            }
        }
        let code = child.wait().ok().and_then(|s| s.code());
        cleanup(&config);
        let mut done = match ended {
            Some(Code::Cancelled) => Done::failed(Failure::new(Code::Cancelled, "Stopped")),
            Some(_) => Done::failed(Failure::new(Code::Timeout, "Claude Code did not finish in time")),
            None => match &result {
                Some(r) if !truthy(&r["is_error"]) && r["subtype"] == "success" => {
                    Done { ok: true, text: r["result"].as_str().unwrap_or("").to_owned(), ..Done::default() }
                }
                _ => {
                    let from_result = result.as_ref().map(|r| {
                        let m = js_text(&r["result"]);
                        if m.is_empty() { js_text(&r["subtype"]) } else { m }
                    });
                    let message = from_result
                        .filter(|m| !m.is_empty())
                        .or_else(|| Some(out.stderr_tail()).filter(|s| !s.is_empty()))
                        .unwrap_or_else(|| {
                            format!("Claude Code exited with code {}", code.map_or("null".into(), |c| c.to_string()))
                        });
                    let max_turns = result.as_ref().is_some_and(|r| r["subtype"] == "error_max_turns");
                    let code = if max_turns { Code::Cli } else { claude::classify(&message) };
                    Done::failed(Failure::new(code, message))
                }
            },
        };
        done.usage = usage_of(result.as_ref(), model);
        emit(Event::Done(done.clone()));
        done
    }
}
