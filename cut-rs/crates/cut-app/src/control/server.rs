//! The control server (port of main/cut/control.js): MCP's Streamable HTTP transport on 127.0.0.1 without a
//! server-sent stream. A JSON-RPC request is a POST to /mcp and its answer is the response body; GET and DELETE
//! answer 405.
//!
//! Who may call: `Authorization: Bearer <token>`, compared in constant time. A token is a chat turn's ([`issue`],
//! dropped by [`revoke`]) or the external one, which exists only while the user allows external AIs and is kept with
//! the port in `cut-control.json` (the JavaScript editor's file and format: `{"port": n, "token": "<48 hex>"}`), so a
//! client set up once keeps working. A request with an `Origin` header or another `Host` is refused before the token
//! is read.
//!
//! The tools run on the UI thread ([`super::Page`]): a call goes there through a channel and its answer comes back
//! on the call's slot. No call holds its request longer than `hold`: one still running answers `{running: true,
//! job, …}`, and `wait_job` waits again. While a client's job runs, its other calls are refused; a job belongs to
//! the client that started it, and a turn's jobs go with its token.
//!
//! [`issue`]: Server::issue
//! [`revoke`]: Server::revoke

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::BufReader;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value as Json, json};

use super::host::Live;
use super::http::{self, BodyError, Got};

pub const PROTOCOL: &str = "2025-06-18";
pub const WAIT_TOOL: &str = "wait_job";
const BODY_LIMIT: usize = 1024 * 1024;
const CALL_LIMIT: Duration = Duration::from_secs(15 * 60);
const HOLD: Duration = Duration::from_secs(25);
const SESSION_IDLE: Duration = Duration::from_secs(10 * 60);
const MAX_CONNECTIONS: usize = 64;

/// Who calls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Client {
    /// A chat turn of the AI assistant, by its token.
    Chat {
        turn: u64,
        token: String,
    },
    External,
}

/// A call on its way to the page and back.
pub struct Slot {
    pub id: u64,
    pub name: String,
    pub args: Json,
    pub client: Client,
    pub live: Live,
    started: Instant,
    /// The progress reports counted at the last sign of life, and when it was.
    life: Mutex<(u64, Instant)>,
    answer: Mutex<Option<Json>>,
    ready: Condvar,
}

impl Slot {
    /// The page's answer (`{content, isError}`); the first one counts.
    pub fn answer(&self, result: Json) {
        if let Ok(mut a) = self.answer.lock()
            && a.is_none()
        {
            *a = Some(result);
            self.ready.notify_all();
        }
    }

    pub fn answered(&self) -> bool {
        self.answer.lock().is_ok_and(|a| a.is_some())
    }

    /// Waits up to `d` for the answer; fails the call when it showed no sign of life (the call, its progress) for
    /// [`CALL_LIMIT`].
    fn wait(&self, d: Duration) -> Option<Json> {
        let end = Instant::now() + d;
        let mut a = self.answer.lock().ok()?;
        loop {
            if let Some(r) = a.clone() {
                return Some(r);
            }
            let now = Instant::now();
            if let Ok(mut life) = self.life.lock() {
                if self.live.reports() != life.0 {
                    *life = (self.live.reports(), now);
                }
                if now.duration_since(life.1) > CALL_LIMIT {
                    *a = Some(text("The editor did not answer in time.", true));
                    continue;
                }
            }
            if now >= end {
                return None;
            }
            let step = (end - now).min(Duration::from_millis(500));
            a = self.ready.wait_timeout(a, step).ok()?.0;
        }
    }
}

/// An MCP client that said `initialize`.
#[derive(Debug, Clone)]
struct Session {
    external: bool,
    name: String,
    since: u64,
    seen: Instant,
}

/// A connected external AI, for the banner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connected {
    pub name: String,
    /// Milliseconds since 1970 when it connected.
    pub since: u64,
}

/// The external AI's address and token while it is allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct External {
    pub url: String,
    pub token: String,
}

#[derive(Default)]
struct State {
    port: Option<u16>,
    turns: HashMap<String, (u64, Option<usize>)>,
    external: Option<String>,
    sessions: HashMap<String, Session>,
    jobs: HashMap<String, Arc<Slot>>,
    pending: HashMap<u64, Arc<Slot>>,
    seq: u64,
    refused: u64,
    calls: u64,
}

/// The server: its listener thread and what the connections share.
pub struct Server {
    state: Arc<Mutex<State>>,
    config: Option<PathBuf>,
    hold: Duration,
    page: Sender<Arc<Slot>>,
    waker: Arc<dyn Fn() + Send + Sync>,
    stop: Arc<AtomicBool>,
    instructions: String,
}

/// A fresh token: 24 bytes of the system's randomness as hex. `RandomState` keys come from the operating system's
/// generator (per thread, once), and SipHash under them is a keyed pseudo-random function, so three outputs over a
/// counter and the clock are unpredictable without the keys; no dependency is needed for it.
pub fn token() -> String {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    let n = COUNT.fetch_add(1, Ordering::SeqCst) as u64;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    (0..3u64)
        .map(|i| {
            let seed = std::thread::spawn(std::collections::hash_map::RandomState::new).join();
            let mut h = seed.unwrap_or_default().build_hasher();
            h.write_u64(n);
            h.write_u64(i);
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// Two tokens compared without an early exit on the first difference.
pub fn same_token(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    if x.len() != y.len() {
        return false;
    }
    x.iter().zip(y).fold(0u8, |d, (p, q)| d | (p ^ q)) == 0
}

fn valid_token(t: &str) -> bool {
    t.len() == 48 && t.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn text(t: &str, error: bool) -> Json {
    json!({ "content": [{ "type": "text", "text": t }], "isError": error })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Server {
    /// A server that is not listening yet. `config`: `cut-control.json` (`None`: kept nowhere), `page`: where calls
    /// go, `waker`: tells the UI thread a call is waiting.
    pub fn new(
        config: Option<PathBuf>,
        hold: Duration,
        page: Sender<Arc<Slot>>,
        waker: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Server {
            state: Arc::default(),
            config,
            hold,
            page,
            waker,
            stop: Arc::new(AtomicBool::new(false)),
            instructions: super::table::instructions().to_owned(),
        }
    }

    /// `PYIDE_CUT_HOLD_MS` (at least 200), else 25 s.
    pub fn default_hold() -> Duration {
        std::env::var("PYIDE_CUT_HOLD_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|ms| *ms >= 200)
            .map_or(HOLD, Duration::from_millis)
    }

    fn read_config(&self) -> serde_json::Map<String, Json> {
        self.config
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Json>(&t).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn write_config(&self, patch: Json) {
        let Some(path) = &self.config else { return };
        let mut cfg = self.read_config();
        if let Some(p) = patch.as_object() {
            cfg.extend(p.clone());
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, Json::Object(cfg).to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    pub fn port(&self) -> Option<u16> {
        self.state.lock().ok()?.port
    }

    /// Listens on 127.0.0.1, on the port the config file keeps when it is free, else on one the system picks.
    pub fn start(&self) -> Option<u16> {
        if let Some(p) = self.port() {
            return Some(p);
        }
        let cfg = self.read_config();
        let want = cfg.get("port").and_then(Json::as_u64).filter(|p| *p > 1024 && *p < 65536).map_or(0, |p| p as u16);
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], want)))
            .or_else(|_| TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))))
            .ok()?;
        let port = listener.local_addr().ok()?.port();
        if cfg.get("port").and_then(Json::as_u64) != Some(u64::from(port)) {
            self.write_config(json!({ "port": port }));
        }
        self.state.lock().ok()?.port = Some(port);
        let ctx = Ctx {
            state: self.state.clone(),
            hold: self.hold,
            page: self.page.clone(),
            waker: self.waker.clone(),
            instructions: self.instructions.clone(),
            port,
            open: Arc::new(AtomicUsize::new(0)),
        };
        let stop = self.stop.clone();
        std::thread::Builder::new()
            .name("cut-control".into())
            .spawn(move || {
                for conn in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(conn) = conn else { continue };
                    if ctx.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                        ctx.open.fetch_sub(1, Ordering::SeqCst);
                        continue;
                    }
                    let c = ctx.clone();
                    let spawned = std::thread::Builder::new().name("cut-control-conn".into()).spawn(move || {
                        c.serve(conn);
                        c.open.fetch_sub(1, Ordering::SeqCst);
                    });
                    if spawned.is_err() {
                        ctx.open.fetch_sub(1, Ordering::SeqCst);
                    }
                }
            })
            .ok()?;
        Some(port)
    }

    /// A chat turn's token, good until [`Server::revoke`]; `undo_floor` is the history position the turn's undo
    /// stops at.
    pub fn issue(&self, turn: u64, undo_floor: Option<usize>) -> String {
        let t = token();
        if let Ok(mut s) = self.state.lock() {
            s.turns.insert(t.clone(), (turn, undo_floor));
        }
        t
    }

    /// Ends a turn's token and the jobs of its turn.
    pub fn revoke(&self, t: &str) {
        let Ok(mut s) = self.state.lock() else { return };
        if let Some((turn, _)) = s.turns.remove(t) {
            s.jobs.retain(|_, j| !matches!(&j.client, Client::Chat { turn: n, .. } if *n == turn));
        }
    }

    /// Whether a chat token is still good, and the undo floor of its turn.
    pub fn turn_of(&self, t: &str) -> Option<Option<usize>> {
        self.state.lock().ok()?.turns.get(t).map(|x| x.1)
    }

    /// Whether the external AI is allowed now.
    pub fn external_on(&self) -> bool {
        self.state.lock().is_ok_and(|s| s.external.is_some())
    }

    /// Allows external AIs (the token kept in the config file, or a new one) or stops allowing them.
    pub fn set_external(&self, on: bool) -> Result<Option<External>, String> {
        if !on {
            if let Ok(mut s) = self.state.lock() {
                s.external = None;
                s.jobs.retain(|_, j| j.client != Client::External);
                s.sessions.retain(|_, x| !x.external);
            }
            return Ok(None);
        }
        let Some(port) = self.start() else { return Err("The control server could not start.".into()) };
        let cfg = self.read_config();
        let mut s = self.state.lock().map_err(|_| "The control server could not start.".to_owned())?;
        let tok = match &s.external {
            Some(t) => t.clone(),
            None => {
                let t = cfg
                    .get("token")
                    .and_then(Json::as_str)
                    .filter(|t| valid_token(t))
                    .map_or_else(token, str::to_owned);
                s.external = Some(t.clone());
                drop(s);
                if cfg.get("token").and_then(Json::as_str) != Some(t.as_str()) {
                    self.write_config(json!({ "port": port, "token": t }));
                }
                t
            }
        };
        Ok(Some(External { url: format!("http://127.0.0.1:{port}/mcp"), token: tok }))
    }

    /// Ends the external AI's sessions and replaces its token, so it cannot come back with the old one.
    pub fn disconnect(&self) -> Option<External> {
        let port = self.port()?;
        let t = token();
        {
            let mut s = self.state.lock().ok()?;
            s.external.as_ref()?;
            s.external = Some(t.clone());
            s.jobs.retain(|_, j| j.client != Client::External);
            s.sessions.retain(|_, x| !x.external);
        }
        self.write_config(json!({ "port": port, "token": t }));
        Some(External { url: format!("http://127.0.0.1:{port}/mcp"), token: t })
    }

    /// The external AIs that said `initialize` within the last 10 minutes.
    pub fn connected(&self) -> Vec<Connected> {
        let Ok(mut s) = self.state.lock() else { return Vec::new() };
        s.sessions.retain(|_, x| x.seen.elapsed() <= SESSION_IDLE);
        let mut out: Vec<Connected> = s
            .sessions
            .values()
            .filter(|x| x.external)
            .map(|x| Connected { name: x.name.clone(), since: x.since })
            .collect();
        out.sort_by_key(|c| c.since);
        out
    }

    /// The tools tools/list gives, by name.
    pub fn tool_names(&self) -> Vec<String> {
        listed().iter().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect()
    }

    /// Refusals and calls so far.
    pub fn stats(&self) -> (u64, u64) {
        self.state.lock().map_or((0, 0), |s| (s.refused, s.calls))
    }

    /// The page went away: its calls end as errors.
    pub fn abandon(&self) {
        let pending: Vec<Arc<Slot>> =
            self.state.lock().map(|s| s.pending.values().cloned().collect()).unwrap_or_default();
        for c in pending {
            c.answer(text("The Nano Studio Cut window was reloaded or closed.", true));
        }
    }

    /// Stops listening; the calls on their way end as errors.
    pub fn close(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.abandon();
        if let Some(p) = self.state.lock().ok().and_then(|mut s| s.port.take()) {
            let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], p)), Duration::from_millis(200));
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}

/// The page's tools and the server's own `wait_job`.
fn listed() -> Vec<Json> {
    let mut t = super::table::definitions();
    let hold = Server::default_hold().as_secs_f64().round() as u64;
    t.push(json!({
        "name": WAIT_TOOL,
        "description": format!("Waits for a job: a tool call that ran longer than {hold} s answered {{running: true, job, progress}} and goes on running on this PC. wait_job waits up to {hold} s more and answers that tool's own result when it ends, or {{running: true, progress (0..1, or null when the job does not measure it), step, elapsed_s}} while it runs; call it again until the job ends. Never start the tool again for a job that runs. The user sees the progress and can stop it."),
        "inputSchema": { "type": "object", "properties": { "job": { "type": "string", "description": "The job from the running answer.", "maxLength": 40 } }, "required": ["job"], "additionalProperties": false },
        "annotations": { "title": "Wait for a job", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false },
    }));
    t
}

/// What a connection thread needs.
#[derive(Clone)]
struct Ctx {
    state: Arc<Mutex<State>>,
    hold: Duration,
    page: Sender<Arc<Slot>>,
    waker: Arc<dyn Fn() + Send + Sync>,
    instructions: String,
    port: u16,
    open: Arc<AtomicUsize>,
}

/// A response: status, extra headers, body.
type Reply = (u16, Vec<(&'static str, String)>, Option<Json>);

fn refusal(status: u16, message: &str) -> Reply {
    (status, Vec::new(), Some(json!({ "error": message })))
}

impl Ctx {
    fn serve(&self, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let _ = stream.set_nodelay(true);
        let Ok(mut out) = stream.try_clone() else { return };
        let mut r = BufReader::new(stream);
        loop {
            let head = match http::read_head(&mut r) {
                Got::Head(h) => h,
                Got::Closed => return,
                Got::Bad => {
                    let _ =
                        http::respond(&mut out, 400, &[], Some(&json!({ "error": "Bad request." }).to_string()), true);
                    return;
                }
            };
            let (status, headers, body, close) = self.request(&head, &mut r);
            let close = close || head.closes();
            let body = body.map(|b| b.to_string());
            if http::respond(&mut out, status, &headers, body.as_deref(), close).is_err() || close {
                return;
            }
        }
    }

    fn refused(&self, reply: Reply) -> (u16, Vec<(&'static str, String)>, Option<Json>, bool) {
        if let Ok(mut s) = self.state.lock() {
            s.refused += 1;
        }
        (reply.0, reply.1, reply.2, false)
    }

    /// One request: the checks in the JavaScript's order, then JSON-RPC.
    fn request(
        &self,
        head: &http::Head,
        r: &mut BufReader<TcpStream>,
    ) -> (u16, Vec<(&'static str, String)>, Option<Json>, bool) {
        let host = head.header("host").unwrap_or_default();
        if host != format!("127.0.0.1:{}", self.port) && host != format!("localhost:{}", self.port) {
            return self.closing(self.refused(refusal(403, "Wrong host.")));
        }
        if head.header("origin").is_some() {
            return self.closing(self.refused(refusal(403, "Web pages may not call Nano Studio Cut.")));
        }
        let path = head.target.split('?').next().unwrap_or_default();
        if path != "/mcp" {
            return self.closing(self.refused(refusal(404, "Not found.")));
        }
        let Some(client) = self.client_of(head.header("authorization").unwrap_or_default()) else {
            let mut x = refusal(401, "A valid token is needed.");
            x.1.push(("WWW-Authenticate", "Bearer".into()));
            return self.closing(self.refused(x));
        };
        if head.method != "POST" {
            let mut x = refusal(405, "Only POST.");
            x.1.push(("Allow", "POST".into()));
            return self.closing(self.refused(x));
        }
        let body = match http::read_body(r, head, BODY_LIMIT) {
            Ok(b) => b,
            Err(BodyError::TooLarge) => return self.closing(self.refused(refusal(413, "Too large."))),
            Err(BodyError::Bad) => return (400, Vec::new(), Some(json!({ "error": "Bad request." })), true),
        };
        let parse = |code: i64, message: &str| {
            (
                400,
                Vec::new(),
                Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": code, "message": message } })),
                false,
            )
        };
        let Ok(msg) = serde_json::from_slice::<Json>(&body) else { return parse(-32700, "Parse error") };
        if msg.is_array() {
            return parse(-32600, "Batches are not supported");
        }
        let sid = head.header("mcp-session-id").unwrap_or_default().to_owned();
        let (status, headers, body) = self.rpc(&msg, &client, &sid);
        (status, headers, body, false)
    }

    /// A refusal before the body is read ends the connection: the body may still be on its way.
    fn closing(
        &self,
        x: (u16, Vec<(&'static str, String)>, Option<Json>, bool),
    ) -> (u16, Vec<(&'static str, String)>, Option<Json>, bool) {
        (x.0, x.1, x.2, true)
    }

    fn client_of(&self, auth: &str) -> Option<Client> {
        let (scheme, rest) = auth.split_once(char::is_whitespace)?;
        let t = rest.trim();
        if !scheme.eq_ignore_ascii_case("bearer") || t.is_empty() || t.contains(char::is_whitespace) {
            return None;
        }
        let s = self.state.lock().ok()?;
        let mut found = None;
        for (k, (turn, _)) in &s.turns {
            if same_token(t, k) {
                found = Some(Client::Chat { turn: *turn, token: k.clone() });
            }
        }
        if found.is_none() && s.external.as_deref().is_some_and(|e| same_token(t, e)) {
            found = Some(Client::External);
        }
        found
    }

    fn rpc(&self, msg: &Json, client: &Client, sid: &str) -> Reply {
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Json::as_str);
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let ok = |r: Json| (200, Vec::new(), Some(json!({ "jsonrpc": "2.0", "id": id.clone(), "result": r })));
        let error = |code: i64, message: String| {
            (
                200,
                Vec::new(),
                Some(
                    json!({ "jsonrpc": "2.0", "id": id.clone().unwrap_or(Json::Null), "error": { "code": code, "message": message } }),
                ),
            )
        };
        let Some(method) = method else { return error(-32600, "Invalid request".into()) };
        if id.is_none() {
            return (202, Vec::new(), None);
        }
        if method == "initialize" {
            let sid = token();
            let external = *client == Client::External;
            let name = params["clientInfo"]["name"]
                .as_str()
                .filter(|n| !n.is_empty())
                .map_or_else(|| if external { "AI" } else { "Claude" }.to_owned(), str::to_owned);
            if let Ok(mut s) = self.state.lock() {
                s.sessions.insert(
                    sid.clone(),
                    Session { external, name: name.chars().take(80).collect(), since: now_ms(), seen: Instant::now() },
                );
            }
            let version = params["protocolVersion"].as_str().unwrap_or(PROTOCOL);
            let mut r = ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "Nano Studio Cut", "version": env!("CARGO_PKG_VERSION") },
                "instructions": self.instructions,
            }));
            r.1.push(("Mcp-Session-Id", sid));
            return r;
        }
        if !sid.is_empty()
            && let Ok(mut s) = self.state.lock()
            && let Some(x) = s.sessions.get_mut(sid)
        {
            x.seen = Instant::now();
        }
        match method {
            "ping" => ok(json!({})),
            "tools/list" => ok(json!({ "tools": listed() })),
            "tools/call" => {
                let name = params.get("name").and_then(Json::as_str).unwrap_or_default();
                let known = !name.is_empty() && (name == WAIT_TOOL || super::table::tool(name).is_some());
                if !known {
                    let shown = params
                        .get("name")
                        .map_or("undefined".into(), |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned));
                    return error(-32602, format!("Unknown tool {shown}"));
                }
                let args = match params.get("arguments") {
                    None | Some(Json::Null) => json!({}),
                    Some(a @ Json::Object(_)) => a.clone(),
                    Some(_) => return error(-32602, "arguments must be an object".into()),
                };
                if let Ok(mut s) = self.state.lock() {
                    s.calls += 1;
                }
                if name == WAIT_TOOL {
                    return ok(self.wait_job(&args, client));
                }
                if let Some(busy) = self.job_of(client) {
                    let pct = busy
                        .live
                        .last()
                        .and_then(|p| p.fraction)
                        .map(|f| format!(" ({}%)", (f * 100.0).round()))
                        .unwrap_or_default();
                    return ok(text(
                        &format!(
                            "job{0} ({1}) is still running{pct}. Call {WAIT_TOOL} with job \"job{0}\" until it ends; nothing else runs before it.",
                            busy.id, busy.name
                        ),
                        true,
                    ));
                }
                ok(self.hold(self.call(name, args, client.clone())))
            }
            _ => error(-32601, format!("Method not found: {method}")),
        }
    }

    /// Sends a call to the page (`callRenderer`).
    fn call(&self, name: &str, args: Json, client: Client) -> Arc<Slot> {
        let id = self.state.lock().map(|mut s| {
            s.seq += 1;
            s.seq
        });
        let slot = Arc::new(Slot {
            id: id.unwrap_or(0),
            name: name.to_owned(),
            args,
            client,
            live: Live::default(),
            started: Instant::now(),
            life: Mutex::new((0, Instant::now())),
            answer: Mutex::new(None),
            ready: Condvar::new(),
        });
        if let Ok(mut s) = self.state.lock() {
            s.pending.insert(slot.id, slot.clone());
        }
        if self.page.send(slot.clone()).is_err() {
            slot.answer(text("The Nano Studio Cut window is not open.", true));
        } else {
            (self.waker)();
        }
        slot
    }

    fn running(&self, call: &Slot) -> Json {
        let p = call.live.last();
        let hold = self.hold.as_secs_f64().round() as u64;
        text(
            &json!({
                "running": true, "job": format!("job{}", call.id), "tool": call.name,
                "progress": p.as_ref().and_then(|p| p.fraction), "step": p.as_ref().map(|p| p.text.clone()).filter(|t| !t.is_empty()),
                "elapsed_s": call.started.elapsed().as_secs_f64().round() as u64,
                "note": format!("Still running on this PC; the user sees its progress. Call {WAIT_TOOL} with this job until it ends (each call waits up to {hold} s). Do not start {} again; other tools are refused until it ends.", call.name),
            })
            .to_string(),
            false,
        )
    }

    /// The call's answer within `hold`, else its running answer (and it becomes a job).
    fn hold(&self, call: Arc<Slot>) -> Json {
        let key = format!("job{}", call.id);
        match call.wait(self.hold) {
            Some(r) => {
                if let Ok(mut s) = self.state.lock() {
                    s.jobs.remove(&key);
                    s.pending.remove(&call.id);
                }
                r
            }
            None => {
                let r = self.running(&call);
                if let Ok(mut s) = self.state.lock() {
                    s.jobs.insert(key, call);
                }
                r
            }
        }
    }

    fn same_client(a: &Client, b: &Client) -> bool {
        match (a, b) {
            (Client::External, Client::External) => true,
            (Client::Chat { turn: x, .. }, Client::Chat { turn: y, .. }) => x == y,
            _ => false,
        }
    }

    fn job_of(&self, client: &Client) -> Option<Arc<Slot>> {
        let s = self.state.lock().ok()?;
        let mut mine: Vec<&Arc<Slot>> = s.jobs.values().filter(|j| Self::same_client(&j.client, client)).collect();
        mine.sort_by_key(|j| j.id);
        mine.first().map(|j| (*j).clone())
    }

    fn wait_job(&self, args: &Json, client: &Client) -> Json {
        let id = args.get("job").and_then(Json::as_str).unwrap_or_default();
        let call = self
            .state
            .lock()
            .ok()
            .and_then(|s| s.jobs.get(id).cloned())
            .filter(|c| Self::same_client(&c.client, client));
        let Some(call) = call else {
            let shown = if id.is_empty() { "(none given)" } else { id };
            let hold = self.hold.as_secs_f64().round() as u64;
            return text(
                &match self.job_of(client) {
                    Some(m) => format!("There is no job {shown}; the running job is job{} ({}).", m.id, m.name),
                    None => format!(
                        "There is no running job {shown}; its answer was given already, or it never ran longer than {hold} s."
                    ),
                },
                true,
            );
        };
        self.hold(call)
    }
}
