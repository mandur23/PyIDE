//! A long-lived Python server (`startSidecar`): one JSON request a line on its stdin, JSON lines on its stdout.
//! Replies carry the request's id; lines without one are events; stderr is log text; a line that is not JSON is
//! skipped. Once no request is in flight for the idle timeout, stdin is closed and the server ends on its own (the
//! servers end on end-of-input); from then on [`Sidecar::alive`] is false and the caller starts a fresh one, so a
//! request never waits on a server that is shutting down. A server that ignores the end of its input is killed 10 s
//! later. When the process ends, every request still in flight is answered `{"error": "server exited (<code>)"}`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::{Value as Json, json};

use crate::Runtime;
use crate::job::{NO_WINDOW, pump};

type Event = Box<dyn Fn(Json) + Send + Sync>;
type Text = Box<dyn Fn(&str) + Send + Sync>;
type Exit = Box<dyn Fn(Option<i32>) + Send + Sync>;

/// How to start a server.
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Added to this process's environment (after `PYTHONIOENCODING`, `HF_HUB_DISABLE_TELEMETRY`,
    /// `TOKENIZERS_PARALLELISM`).
    pub env: Vec<(String, String)>,
    /// The idle timeout in ms, read whenever the server falls idle (0: never). Shared, so a setting can change it.
    pub idle_ms: Arc<AtomicU64>,
    pub on_event: Event,
    pub on_log: Text,
    pub on_exit: Exit,
}

impl Spec {
    /// The environment's Python running `script` unbuffered in the environment's folder.
    pub fn python(rt: &Runtime, script: &Path) -> Spec {
        Spec {
            program: rt.python.clone(),
            args: vec!["-u".into(), script.display().to_string()],
            cwd: rt.dir.clone(),
            env: Vec::new(),
            idle_ms: Arc::new(AtomicU64::new(0)),
            on_event: Box::new(|_| {}),
            on_log: Box::new(|_| {}),
            on_exit: Box::new(|_| {}),
        }
    }
}

struct State {
    stdin: Option<ChildStdin>,
    pending: HashMap<u64, Sender<Json>>,
    next_id: u64,
    alive: bool,
    stopping: bool,
    /// Since when nothing is in flight (the idle clock runs), `None` while a request is or before the first reply.
    idle_since: Option<Instant>,
    code: Option<Option<i32>>,
}

struct Inner {
    state: Mutex<State>,
    wake: Condvar,
    child: Mutex<Option<Child>>,
    idle_ms: Arc<AtomicU64>,
    on_event: Event,
    on_exit: Exit,
}

/// A running server; clones share it.
#[derive(Clone)]
pub struct Sidecar(Arc<Inner>);

/// The answer to one request.
pub struct Reply {
    pub id: u64,
    rx: Receiver<Json>,
}

impl Reply {
    /// Waits for the answer (`{"error": …}` when the server ended first).
    pub fn wait(self) -> Json {
        self.rx.recv().unwrap_or_else(|_| json!({ "error": "server is not running" }))
    }

    /// The answer when it comes within `d`, else `None` (the request stays in flight).
    pub fn wait_for(&self, d: Duration) -> Option<Json> {
        match self.rx.recv_timeout(d) {
            Ok(v) => Some(v),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => Some(json!({ "error": "server is not running" })),
        }
    }
}

static ALL: Mutex<Vec<Weak<Inner>>> = Mutex::new(Vec::new());

/// Kills every server of this process and waits for them to end (before the environment they run from is replaced).
pub fn kill_all() {
    let all: Vec<Sidecar> = {
        let mut g = ALL.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|w| w.strong_count() > 0);
        g.iter().filter_map(Weak::upgrade).map(Sidecar).collect()
    };
    for s in all {
        s.kill();
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Sidecar {
    /// Starts the server. A process that cannot start is a server that has ended at once (code -1, the reason in
    /// `on_log`): every request is answered with an error.
    pub fn start(spec: Spec) -> Sidecar {
        let Spec { program, args, cwd, env, idle_ms, on_event, on_log, on_exit } = spec;
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                stdin: None,
                pending: HashMap::new(),
                next_id: 1,
                alive: true,
                stopping: false,
                idle_since: None,
                code: None,
            }),
            wake: Condvar::new(),
            child: Mutex::new(None),
            idle_ms,
            on_event,
            on_exit,
        });
        let me = Sidecar(inner);
        let mut c = Command::new(&program);
        c.args(&args)
            .current_dir(&cwd)
            .creation_flags(NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONIOENCODING", "utf-8")
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("TOKENIZERS_PARALLELISM", "false");
        for (k, v) in &env {
            c.env(k, v);
        }
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => {
                on_log(&format!("{e}\n"));
                me.exited(Some(-1));
                return me;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        lock(&me.0.state).stdin = child.stdin.take();
        *lock(&me.0.child) = Some(child);
        lock(&ALL).push(Arc::downgrade(&me.0));
        if let Some(mut err) = stderr {
            let _ =
                std::thread::Builder::new().name("cut-sidecar stderr".into()).spawn(move || pump(&mut err, &on_log));
        }
        let out = me.clone();
        let _ = std::thread::Builder::new().name("cut-sidecar stdout".into()).spawn(move || {
            if let Some(so) = stdout {
                for line in BufReader::new(so).split(b'\n').map_while(Result::ok) {
                    out.line(&String::from_utf8_lossy(&line));
                }
            }
            let code = loop {
                let got = lock(&out.0.child).as_mut().map(|c| c.try_wait());
                match got {
                    Some(Ok(Some(st))) => break st.code(),
                    Some(Ok(None)) => std::thread::sleep(Duration::from_millis(10)),
                    _ => break None,
                }
            };
            out.exited(code);
        });
        let clock = Arc::downgrade(&me.0);
        let _ = std::thread::Builder::new().name("cut-sidecar idle".into()).spawn(move || idle_clock(&clock));
        me
    }

    fn line(&self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(msg) = serde_json::from_str::<Json>(line) else { return };
        let to = msg.get("id").and_then(Json::as_u64).and_then(|id| {
            let mut st = lock(&self.0.state);
            let tx = st.pending.remove(&id)?;
            if st.pending.is_empty() {
                st.idle_since = Some(Instant::now());
                self.0.wake.notify_all();
            }
            Some(tx)
        });
        match to {
            Some(tx) => {
                let _ = tx.send(msg);
            }
            None if msg.get("event").is_some_and(|e| !e.is_null()) => (self.0.on_event)(msg),
            None => {}
        }
    }

    fn exited(&self, code: Option<i32>) {
        let pending = {
            let mut st = lock(&self.0.state);
            if !st.alive {
                return;
            }
            st.alive = false;
            st.stdin = None;
            st.code = Some(code);
            std::mem::take(&mut st.pending)
        };
        let text = code.map_or_else(|| "null".to_owned(), |c| c.to_string());
        for tx in pending.into_values() {
            let _ = tx.send(json!({ "error": format!("server exited ({text})") }));
        }
        lock(&ALL).retain(|w| w.upgrade().is_some_and(|i| !Arc::ptr_eq(&i, &self.0)));
        (self.0.on_exit)(code);
        self.0.wake.notify_all();
    }

    fn write(st: &mut State, msg: &Json) {
        if !st.alive || st.stopping {
            return;
        }
        if let Some(w) = st.stdin.as_mut() {
            // a write racing the process's end fails; the end answers what is in flight
            let _ = writeln!(w, "{msg}").and_then(|()| w.flush());
        }
    }

    /// Sends a request (its `id` is added) -> the reply to wait for.
    pub fn send(&self, msg: Json) -> Reply {
        let (tx, rx) = channel();
        let mut st = lock(&self.0.state);
        let id = st.next_id;
        st.next_id += 1;
        if !st.alive || st.stopping {
            let _ = tx.send(json!({ "error": "server is not running" }));
            return Reply { id, rx };
        }
        st.idle_since = None;
        st.pending.insert(id, tx);
        let mut m = msg;
        if let Some(o) = m.as_object_mut() {
            o.insert("id".into(), json!(id));
        }
        Self::write(&mut st, &m);
        Reply { id, rx }
    }

    /// Sends a message that has no answer (`{"op": "cancel", "target": id}`).
    pub fn notify(&self, msg: &Json) {
        Self::write(&mut lock(&self.0.state), msg);
    }

    /// Running and not shutting down.
    pub fn alive(&self) -> bool {
        let st = lock(&self.0.state);
        st.alive && !st.stopping
    }

    /// Whether the process has ended, and its exit code then.
    pub fn exit_code(&self) -> Option<Option<i32>> {
        lock(&self.0.state).code
    }

    /// Re-reads the idle timeout (the setting changed while the server sits idle): the clock restarts now.
    pub fn idle(&self) {
        let mut st = lock(&self.0.state);
        if st.alive && !st.stopping && st.pending.is_empty() {
            st.idle_since = Some(Instant::now());
        }
        self.0.wake.notify_all();
    }

    /// Closes the server's input so it ends on its own; killed if it still runs 10 s later.
    pub fn stop(&self) {
        {
            let mut st = lock(&self.0.state);
            if !st.alive || st.stopping {
                return;
            }
            st.stopping = true;
            st.stdin = None;
        }
        let me = Arc::downgrade(&self.0);
        let _ = std::thread::Builder::new().name("cut-sidecar stop".into()).spawn(move || {
            let Some(inner) = me.upgrade() else { return };
            let st = lock(&inner.state);
            let (st, _) = inner
                .wake
                .wait_timeout_while(st, Duration::from_secs(10), |s| s.alive)
                .unwrap_or_else(|e| e.into_inner());
            if st.alive {
                drop(st);
                if let Some(c) = lock(&inner.child).as_mut() {
                    let _ = c.kill();
                }
            }
        });
    }

    /// Kills the process and waits until it has ended and let its files go.
    pub fn kill(&self) {
        if let Some(c) = lock(&self.0.child).as_mut() {
            let _ = c.kill();
        }
        let st = lock(&self.0.state);
        drop(self.0.wake.wait_while(st, |s| s.alive));
    }
}

/// Stops the server once nothing has been in flight for the idle timeout.
fn idle_clock(me: &Weak<Inner>) {
    loop {
        let Some(inner) = me.upgrade() else { return };
        let st = lock(&inner.state);
        if !st.alive || st.stopping {
            return;
        }
        let ms = inner.idle_ms.load(Ordering::Relaxed);
        let due = st.idle_since.filter(|_| st.pending.is_empty() && ms > 0).map(|t| t + Duration::from_millis(ms));
        match due {
            Some(at) if Instant::now() >= at => {
                drop(st);
                Sidecar(inner).stop();
                return;
            }
            Some(at) => {
                let wait = at.saturating_duration_since(Instant::now());
                drop(inner.wake.wait_timeout(st, wait));
            }
            // woken by a reply, `idle` or the end; a second at most, so the weak handle is looked at again
            None => drop(inner.wake.wait_timeout(st, Duration::from_secs(1))),
        }
    }
}
