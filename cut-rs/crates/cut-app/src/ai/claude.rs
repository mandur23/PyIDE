//! The Claude Code CLI on this PC (`main/ai/claude.js`): finding it, starting it in an empty working folder, one
//! completion (`claude -p`, no tools, no session file) read from its stream-json lines, and telling sign-in and usage
//! limit errors apart. `PYIDE_CLAUDE_PATH` points at a stand-in (`none`: no Claude Code), as for the JavaScript.
//!
//! Threads: everything here blocks; it runs on the text AI's request thread and the assistant's turn thread, never
//! on the UI thread. The CLI's output is read on a thread of its own and handed over line by line.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value as Json;

/// Why Claude gave no answer: the JavaScript's codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    NotInstalled,
    Auth,
    Quota,
    Cli,
    Cancelled,
    Timeout,
    BadArgs,
}

impl Code {
    /// The JavaScript's code word.
    pub fn id(self) -> &'static str {
        match self {
            Code::NotInstalled => "not-installed",
            Code::Auth => "auth",
            Code::Quota => "quota",
            Code::Cli => "cli",
            Code::Cancelled => "cancelled",
            Code::Timeout => "timeout",
            Code::BadArgs => "badArgs",
        }
    }
}

/// A failure with its code and the CLI's or the editor's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: Code,
    pub error: String,
}

impl Failure {
    pub fn new(code: Code, error: impl Into<String>) -> Failure {
        Failure { code, error: error.into() }
    }
}

/// Where the CLI is looked for: the launcher's or the tests' switch as read at start, and the PATH search's memory.
pub struct Cli {
    switch: Option<String>,
    cached: Mutex<(Option<PathBuf>, Option<Instant>)>,
}

/// A PATH search that found nothing is repeated at most this often (`PATH_RECHECK_MS`).
const PATH_RECHECK: Duration = Duration::from_secs(30);

impl Cli {
    /// The lookup Nano Studio's launcher asks for (`CUT_CLAUDE_PATH`, [`switch_of`]), else `PYIDE_CLAUDE_PATH`.
    pub fn from_env() -> Cli {
        let var = |k: &str| std::env::var(k).ok();
        Cli::with_switch(switch_of(var("CUT_CLAUDE_PATH"), var("PYIDE_CLAUDE_PATH")))
    }

    /// The lookup with the switch given (`Some("none")`: no Claude Code; another value: that file).
    pub fn with_switch(switch: Option<String>) -> Cli {
        Cli { switch, cached: Mutex::new((None, None)) }
    }

    /// `findClaude`: the switch, the official installer's `~/.local/bin/claude.exe`, then PATH (an npm install puts a
    /// `claude.cmd` shim there).
    pub fn find(&self) -> Option<PathBuf> {
        match self.switch.as_deref() {
            Some("none") => return None,
            Some(p) => return Path::new(p).exists().then(|| PathBuf::from(p)),
            None => {}
        }
        let mut c = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = c.0.as_ref().filter(|p| p.exists()) {
            return Some(p.clone());
        }
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let local = PathBuf::from(home).join(".local").join("bin").join("claude.exe");
            if local.exists() {
                c.0 = Some(local.clone());
                return Some(local);
            }
        }
        if c.1.is_some_and(|at| at.elapsed() < PATH_RECHECK) {
            return None;
        }
        let found = where_claude();
        if found.is_none() {
            c.1 = Some(Instant::now());
        }
        c.0.clone_from(&found);
        found
    }
}

/// The switch from the launcher's `CUT_CLAUDE_PATH` (the CLI main/ai/claude.js found, or `none`), else the test
/// switch `PYIDE_CLAUDE_PATH`; empty or unset is no switch: look in `~/.local/bin`, then PATH.
pub fn switch_of(cut: Option<String>, pyide: Option<String>) -> Option<String> {
    cut.filter(|s| !s.is_empty()).or_else(|| pyide.filter(|s| !s.is_empty()))
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn where_claude() -> Option<PathBuf> {
    let out =
        hidden(Command::new("where.exe").arg("claude").stdin(Stdio::null()).stderr(Stdio::null())).output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|p| {
            let l = p.to_ascii_lowercase();
            l.ends_with(".exe") || l.ends_with(".cmd")
        })
        .map(PathBuf::from)
}

/// The CLI's empty working folder, so no project settings or CLAUDE.md files are picked up (`WORK_DIR`).
pub fn work_dir() -> PathBuf {
    std::env::temp_dir().join("pyide-claude")
}

/// `systemPromptFile`: the system prompt in a file named by its hash, in the working folder.
pub fn system_prompt_file(text: &str) -> std::io::Result<PathBuf> {
    use sha1::Digest;
    let hash = sha1::Sha1::digest(text.as_bytes());
    let hex: String = hash.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let file = work_dir().join(format!("system-{hex}.txt"));
    if !file.exists() {
        std::fs::create_dir_all(work_dir())?;
        std::fs::write(&file, text)?;
    }
    Ok(file)
}

fn matches_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

fn word_at(text: &str, word: &str) -> bool {
    let b = text.as_bytes();
    text.match_indices(word).any(|(i, _)| {
        let before = i == 0 || !b[i - 1].is_ascii_alphanumeric() && b[i - 1] != b'_';
        let j = i + word.len();
        let after = j >= b.len() || !b[j].is_ascii_alphanumeric() && b[j] != b'_';
        before && after
    })
}

/// `classify`: a sign-in error, a usage limit, or another failure of the CLI.
pub fn classify(message: &str) -> Code {
    let m = message.to_lowercase();
    let auth = matches_any(&m, &["not logged in", "/login", "invalid api key", "authentication", "oauth"])
        || word_at(&m, "401");
    if auth {
        return Code::Auth;
    }
    let hit_limit = m.match_indices("hit your ").any(|(i, _)| {
        let rest = &m[i + 9..];
        rest.starts_with("limit") || {
            let w: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            !w.is_empty() && rest[w.len()..].starts_with(" limit")
        }
    });
    let rate_limit = m.match_indices("rate").any(|(i, _)| {
        let rest = &m[i + 4..];
        let any = |c: char| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        rest.starts_with("limit")
            || rest.chars().next().is_some_and(|c| any(c) && rest[c.len_utf8()..].starts_with("limit"))
    });
    let quota = hit_limit
        || rate_limit
        || matches_any(&m, &["usage limit", "limit reached", "credit balance", "quota", "too many requests"])
        || word_at(&m, "429");
    if quota { Code::Quota } else { Code::Cli }
}

/// `killTree`: the CLI and what it started (a `.cmd` shim runs it under cmd.exe).
pub fn kill_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        let _ = hidden(Command::new("taskkill").args(["/pid", &child.id().to_string(), "/T", "/F"]))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.kill();
    }
}

/// `launch`: the CLI with these arguments in the empty working folder, its pipes open. A `.cmd` shim only runs through
/// cmd.exe, which expands `%VAR%` and ends a quoted argument at a quote, so such an argument is refused.
pub fn launch(bin: &Path, args: &[String], env: &[(&str, &str)]) -> Result<Child, Failure> {
    let shim = bin.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if shim {
        let bin_text = bin.to_string_lossy().into_owned();
        if let Some(bad) = std::iter::once(&bin_text).chain(args).find(|a| a.contains(['"', '%', '\r', '\n'])) {
            return Err(Failure::new(Code::Cli, format!("cannot pass {} to {}", super::js::quote(bad), bin.display())));
        }
    }
    std::fs::create_dir_all(work_dir()).map_err(|e| Failure::new(Code::Cli, e.to_string()))?;
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(work_dir()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env_remove("ELECTRON_RUN_AS_NODE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    hidden(&mut cmd).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Failure::new(Code::NotInstalled, "Claude Code is not installed")
        } else {
            Failure::new(Code::Cli, e.to_string())
        }
    })
}

/// What the CLI's output gave next.
pub enum Next {
    Line(String),
    Idle,
    Ended,
}

/// A running CLI's output: its stdout lines as they come, its stderr's last 4000 characters once it ends.
pub struct Output {
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
}

impl Output {
    /// Starts reading `child`'s output on threads of their own and writes `input` to its stdin, then closes it.
    pub fn read(child: &mut Child, input: &str) -> Output {
        let (tx, lines) = channel();
        if let Some(out) = child.stdout.take() {
            let _ = std::thread::Builder::new().name("claude stdout".into()).spawn(move || {
                for line in BufReader::new(out).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim().to_owned();
                    if !line.is_empty() && tx.send(line).is_err() {
                        break;
                    }
                }
            });
        }
        let stderr = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = child.stderr.take() {
            let keep = stderr.clone();
            let _ = std::thread::Builder::new().name("claude stderr".into()).spawn(move || {
                let mut buf = [0_u8; 4096];
                while let Ok(n) = err.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut s = keep.lock().unwrap_or_else(|e| e.into_inner());
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    let len = s.chars().count();
                    if len > 4000 {
                        *s = s.chars().skip(len - 4000).collect();
                    }
                }
            });
        }
        if let Some(mut stdin) = child.stdin.take() {
            let input = input.to_owned();
            let _ = std::thread::Builder::new().name("claude stdin".into()).spawn(move || {
                let _ = stdin.write_all(input.as_bytes());
            });
        }
        Output { lines, stderr }
    }

    /// The next line, [`Next::Idle`] when none came within `wait`.
    pub fn next(&self, wait: Duration) -> Next {
        match self.lines.recv_timeout(wait) {
            Ok(l) => Next::Line(l),
            Err(RecvTimeoutError::Timeout) => Next::Idle,
            Err(RecvTimeoutError::Disconnected) => Next::Ended,
        }
    }

    /// The last three lines of stderr.
    pub fn stderr_tail(&self) -> String {
        let s = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        let lines: Vec<&str> = s.trim().split('\n').map(|l| l.trim_end_matches('\r')).collect();
        lines[lines.len().saturating_sub(3)..].join("\n")
    }
}

/// What a completion is asked: the system prompt, the prompt (stdin) and the model.
pub struct Ask<'a> {
    pub system: &'a str,
    pub prompt: &'a str,
    pub model: &'a str,
}

/// A completion's answer and how long it took.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub text: String,
    pub ms: u128,
}

/// `complete`: one answer of the CLI. Once `stop` says so the CLI is ended and the answer is `cancelled` (the
/// caller's Cancel or its time limit); `on_text` is called with the answer so far as it streams.
pub fn complete(
    bin: &Path,
    ask: &Ask,
    stop: &dyn Fn() -> bool,
    on_text: &mut dyn FnMut(&str),
) -> Result<Answer, Failure> {
    if stop() {
        return Err(Failure::new(Code::Cancelled, "Cancelled"));
    }
    let system = system_prompt_file(ask.system).map_err(|e| Failure::new(Code::Cli, e.to_string()))?;
    let args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        ask.model,
        "--tools",
        "",
        "--max-turns",
        "1",
        "--safe-mode",
        "--no-session-persistence",
        "--system-prompt-file",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .chain(std::iter::once(system.to_string_lossy().into_owned()))
    .collect();
    let mut child = launch(bin, &args, &[])?;
    let started = Instant::now();
    let out = Output::read(&mut child, ask.prompt);
    let (mut streamed, mut saw_delta, mut result) = (String::new(), false, None::<Json>);
    let mut cancelled = false;
    loop {
        if !cancelled && stop() {
            cancelled = true;
            kill_tree(&mut child);
        }
        let line = match out.next(Duration::from_millis(50)) {
            Next::Line(l) => l,
            Next::Idle => continue,
            Next::Ended => break,
        };
        let Ok(msg) = serde_json::from_str::<Json>(&line) else { continue };
        match msg["type"].as_str() {
            Some("stream_event")
                if msg["event"]["type"] == "content_block_delta" && msg["event"]["delta"]["type"] == "text_delta" =>
            {
                saw_delta = true;
                streamed.push_str(msg["event"]["delta"]["text"].as_str().unwrap_or(""));
                on_text(&streamed);
            }
            Some("assistant") if !saw_delta => {
                streamed = text_blocks(&msg["message"]["content"], "");
                on_text(&streamed);
            }
            Some("result") => result = Some(msg),
            _ => {}
        }
    }
    let code = child.wait().ok().and_then(|s| s.code());
    let ms = started.elapsed().as_millis();
    if cancelled {
        return Err(Failure::new(Code::Cancelled, "Cancelled"));
    }
    if let Some(r) = result.as_ref().filter(|r| !super::js::truthy(&r["is_error"])) {
        let text = r["result"].as_str().map_or(streamed, str::to_owned);
        return Ok(Answer { text, ms });
    }
    let message = result
        .as_ref()
        .map(|r| js_text(&r["result"]))
        .filter(|m| !m.is_empty())
        .or_else(|| Some(out.stderr_tail()).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| format!("Claude Code exited with code {}", code.map_or("null".into(), |c| c.to_string())));
    Err(Failure::new(classify(&message), message))
}

/// The text blocks of a message's content, joined.
pub fn text_blocks(content: &Json, sep: &str) -> String {
    let list = content.as_array().map_or(&[][..], Vec::as_slice);
    list.iter().filter(|c| c["type"] == "text").map(|c| js_text(&c["text"])).collect::<Vec<_>>().join(sep)
}

/// `String(v || '')`.
pub fn js_text(v: &Json) -> String {
    match v {
        Json::Null | Json::Bool(false) => String::new(),
        Json::String(s) => s.clone(),
        Json::Number(n) if n.as_f64() == Some(0.0) => String::new(),
        v => super::plan::js_string(v),
    }
}
