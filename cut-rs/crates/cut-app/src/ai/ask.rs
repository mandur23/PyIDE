//! A text AI job (`ui-ai.js`'s `ask` and `job`): on a thread of its own under the progress box (one at a time,
//! Cancel), each request asked through the [`Runner`]; an answer that does not parse or check is asked once more with
//! the reason, and a second refusal ends the job as `invalid`. Nothing in the project changes until the job's result
//! is taken on the UI thread.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};

use serde_json::Value as Json;

use super::claude::{Code, Failure};
use super::runner::{Request, Runner};

/// Why a job ended without a result.
#[derive(Debug, Clone, PartialEq)]
pub enum Why {
    /// Claude Code failed (its code and message).
    Claude(Failure),
    /// Both answers were refused: the second reason.
    Invalid(String),
}

impl Why {
    /// The JavaScript's code word (`invalid` for a refused answer).
    pub fn code(&self) -> &'static str {
        match self {
            Why::Claude(f) => f.code.id(),
            Why::Invalid(_) => "invalid",
        }
    }
}

/// How a job ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome<T> {
    Done(T),
    Failed(Why),
    Cancelled,
}

/// What the progress box says under its bar, in words the UI thread translates.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Line {
    #[default]
    Waiting,
    Again,
    Writing(usize),
    /// The request answered: the percentage alone.
    Percent,
}

/// The progress box's state: the fraction, the part (`Part {i} of {n}`) and the line.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Progress {
    pub fraction: f64,
    pub part: Option<(usize, usize)>,
    pub line: Line,
}

/// What a job's thread is handed: the runner, the model, the Cancel flag and where its progress goes.
pub struct Ctx {
    runner: Arc<Runner>,
    model: String,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Progress>>,
}

static REQUESTS: AtomicU64 = AtomicU64::new(0);

/// A job ended early: Cancel, or a failure.
pub enum Stop {
    Cancelled,
    Failed(Why),
}

/// One request of a job.
pub struct Question<'a> {
    pub task: &'a str,
    pub system: &'a str,
    pub prompt: String,
    /// Of the job's progress, the part this request fills.
    pub part: (f64, f64),
    /// How many characters the answer is expected to have, for the bar.
    pub expect: f64,
    /// `Part {i} of {n}` when the job asks in parts.
    pub label: Option<(usize, usize)>,
}

impl Ctx {
    fn set(&self, fraction: f64, line: Line, part: Option<(usize, usize)>) {
        *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = Progress { fraction, part, line };
    }

    /// `ask`: one answer that `validate` takes, asked again once with the reason when it does not.
    pub fn ask<T>(&self, q: Question, validate: impl Fn(&Json) -> Result<T, String>) -> Result<T, Stop> {
        let mut prompt = q.prompt.clone();
        let mut reason = String::new();
        for attempt in 0..2 {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(Stop::Cancelled);
            }
            let request = format!("ai{}", REQUESTS.fetch_add(1, Ordering::Relaxed) + 1);
            let (a, b) = q.part;
            let show = |n: usize| {
                let f = a + (b - a) * (n as f64 / q.expect).min(0.95);
                let line = if n > 0 {
                    Line::Writing(n)
                } else if attempt > 0 {
                    Line::Again
                } else {
                    Line::Waiting
                };
                self.set(f, line, q.label);
            };
            show(0);
            let req = Request {
                request,
                task: q.task.into(),
                system: q.system.into(),
                prompt: prompt.clone(),
                model: Some(self.model.clone()),
            };
            let r = self.runner.run(&req, &self.cancel, &mut |n| show(n));
            if self.cancel.load(Ordering::Relaxed) || r.as_ref().is_err_and(|f| f.code == Code::Cancelled) {
                return Err(Stop::Cancelled);
            }
            let answer = r.map_err(|f| Stop::Failed(Why::Claude(f)))?;
            let checked = super::js::parse_json(&answer.text).map_err(str::to_owned).and_then(|v| validate(&v));
            match checked {
                Ok(v) => {
                    self.set(b, Line::Percent, None);
                    return Ok(v);
                }
                Err(e) => {
                    reason = e;
                    prompt = super::js::retry_prompt(&q.prompt, &answer.text, &reason);
                }
            }
        }
        Err(Stop::Failed(Why::Invalid(reason)))
    }
}

/// A job running on its thread.
pub struct Job<T> {
    /// The progress box's title (translated when the job started).
    pub title: String,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Progress>>,
    rx: Receiver<Outcome<T>>,
}

impl<T: Send + 'static> Job<T> {
    /// Runs `work` on a thread with the runner and the model.
    pub fn start(
        title: String,
        runner: Arc<Runner>,
        model: String,
        work: impl FnOnce(&Ctx) -> Result<T, Stop> + Send + 'static,
    ) -> Job<T> {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Mutex::new(Progress::default()));
        let ctx = Ctx { runner, model, cancel: cancel.clone(), progress: progress.clone() };
        let (tx, rx) = channel();
        let _ = std::thread::Builder::new().name("cut-app claude".into()).spawn(move || {
            let out = match work(&ctx) {
                Ok(_) | Err(Stop::Cancelled) if ctx.cancel.load(Ordering::Relaxed) => Outcome::Cancelled,
                Ok(v) => Outcome::Done(v),
                Err(Stop::Cancelled) => Outcome::Cancelled,
                Err(Stop::Failed(w)) => Outcome::Failed(w),
            };
            let _ = tx.send(out);
        });
        Job { title, cancel, progress, rx }
    }

    pub fn progress(&self) -> Progress {
        self.progress.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// The outcome once there.
    pub fn poll(&self) -> Option<Outcome<T>> {
        self.rx.try_recv().ok()
    }

    /// Waits for the outcome (tests).
    pub fn wait(&self) -> Option<Outcome<T>> {
        self.rx.recv().ok()
    }
}
