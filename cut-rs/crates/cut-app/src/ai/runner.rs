//! One text AI request at a time per id (`main/cut/ai.js`): the request's shape and sizes checked, run through the
//! CLI with a time limit, how much of the answer has arrived reported as it streams, and an answer that is a value,
//! never a panic: the text, or a failure with its code (`not-installed`, `auth`, `quota`, `cli`, `cancelled`,
//! `timeout`, `badArgs`).
//!
//! Threads: [`Runner::run`] blocks the thread that calls it (a text AI job's); [`Runner::cancel`] may be called from
//! any thread.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::claude::{self, Answer, Cli, Code, Failure};

/// The models a request may name (`MODELS`).
pub const MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
/// Characters of a prompt at most; the screens condense long transcripts well below this (`PROMPT_LIMIT`).
pub const PROMPT_LIMIT: usize = 200_000;
const SYSTEM_LIMIT: usize = 20_000;
/// How long a request may take (`TIMEOUT_MS`).
pub const TIMEOUT: Duration = Duration::from_secs(180);
const PROGRESS: Duration = Duration::from_millis(100);

/// A request: its id (to cancel it), a short task name for the log, the prompts and the model (`sonnet` when none).
#[derive(Debug, Clone, Default)]
pub struct Request {
    pub request: String,
    pub task: String,
    pub system: String,
    pub prompt: String,
    pub model: Option<String>,
}

/// `ID`: a short name of word characters, dots and dashes.
pub fn is_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The CLI's requests: where it is, the time limit, and the requests running (their stop flags by id).
pub struct Runner {
    pub cli: Cli,
    pub timeout: Duration,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Runner {
    pub fn new(cli: Cli, timeout: Duration) -> Runner {
        Runner { cli, timeout, running: Mutex::new(HashMap::new()) }
    }

    /// `status`: whether Claude Code is there.
    pub fn installed(&self) -> bool {
        self.cli.find().is_some()
    }

    /// `run`: the answer, or why there is none. Setting `cancel` (or [`Runner::cancel`] with its id) ends it as
    /// `cancelled`; `chars(n)` is told how many characters (UTF-16 units, as the JavaScript counts) have arrived, at
    /// most every 100 ms.
    pub fn run(&self, req: &Request, cancel: &AtomicBool, chars: &mut dyn FnMut(usize)) -> Result<Answer, Failure> {
        let bad = |e: &str| Err(Failure::new(Code::BadArgs, e));
        let model = req.model.as_deref().unwrap_or("sonnet");
        if !is_id(&req.request) {
            return bad("a request needs an id");
        }
        if !is_id(&req.task) {
            return bad("a task is a short name");
        }
        if !MODELS.contains(&model) {
            return bad(&format!("unknown model {model}"));
        }
        if req.system.is_empty() || units(&req.system) > SYSTEM_LIMIT {
            return bad("the system prompt is missing or too long");
        }
        if req.prompt.is_empty() || units(&req.prompt) > PROMPT_LIMIT {
            return bad("the prompt is missing or too long");
        }
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            if running.contains_key(&req.request) {
                return bad("that request is running already");
            }
            running.insert(req.request.clone(), stop.clone());
        }
        let out = self.ask(req, model, &|| stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed), chars);
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&req.request);
        out
    }

    fn ask(
        &self,
        req: &Request,
        model: &str,
        stop: &dyn Fn() -> bool,
        chars: &mut dyn FnMut(usize),
    ) -> Result<Answer, Failure> {
        let Some(bin) = self.cli.find() else {
            return Err(Failure::new(Code::NotInstalled, "Claude Code is not installed"));
        };
        let deadline = Instant::now() + self.timeout;
        let timed_out = AtomicBool::new(false);
        let check = || {
            if Instant::now() >= deadline {
                timed_out.store(true, Ordering::Relaxed);
            }
            stop() || timed_out.load(Ordering::Relaxed)
        };
        let mut last: Option<Instant> = None;
        let mut on_text = |text: &str| {
            if last.is_some_and(|l| l.elapsed() < PROGRESS) {
                return;
            }
            last = Some(Instant::now());
            chars(units(text));
        };
        let ask = claude::Ask { system: &req.system, prompt: &req.prompt, model };
        match claude::complete(&bin, &ask, &check, &mut on_text) {
            Err(_) if timed_out.load(Ordering::Relaxed) => {
                Err(Failure::new(Code::Timeout, "Claude Code did not answer in time"))
            }
            r => r,
        }
    }

    /// `cancel`: ends a running request -> whether there was one.
    pub fn cancel(&self, request: &str) -> bool {
        match self.running.lock().unwrap_or_else(|e| e.into_inner()).get(request) {
            Some(s) => {
                s.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}
