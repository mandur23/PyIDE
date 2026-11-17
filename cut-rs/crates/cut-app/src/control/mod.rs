//! The control API an AI drives the editor through (docs/cut-ai-control.md): the tools of `Cut.control`
//! (control*.js, [`table`], [`call`], `tools/`), the MCP server on 127.0.0.1 (main/cut/control.js, [`server`]) and the
//! page that runs the calls on the UI thread one at a time (ui-assistant.js's bridge and ui-control.js's services,
//! [`Control::pump`], `shell_host.rs`), and the settings for external AIs ([`panel`]).
//!
//! # For the AI assistant (cut-app/src/ai): the API to use
//! The control lives on the shell as `shell.features.control` ([`Control`]):
//! - [`Control::issue`]`(turn, undo_floor) -> Option<String>`: a chat turn's Bearer token (starts the server when
//!   needed). `undo_floor` is `app.history.position()` when the turn starts: the turn's `undo` stops there.
//! - [`Control::revoke`]`(&token)`: the turn ended or was stopped; its calls are refused from then on, and a call of
//!   it still running is stopped.
//! - [`Control::url`]`() -> Option<String>`: `http://127.0.0.1:<port>/mcp` for the CLI's `--mcp-config`.
//! - [`Control::tool_names`]`()`: every tool tools/list gives (`wait_job` last), for `--allowedTools mcp__cut__<name>`.
//! - [`Control::take_events`]`()`: what happened since the last call ([`Event`]: an external AI's calls, a long
//!   call's progress), for the panel's steps.
//! - [`call::describe`]`(name, args)`: a call's step line, English for `tr`, with its parameters.
//! - [`table::instructions`]`()`: `Cut.control.INSTRUCTIONS`, for the system prompt.
//!
//! # Where the external AI's token is kept
//! `%APPDATA%\Nano Studio\cut-control.json` (`{"port": n, "token": "<48 hex>"}`): the JavaScript editor's own file
//! and format, so a client set up once for either editor keeps working. `CUT_CONTROL_FILE` names another file
//! (tests, scripted runs).

pub mod call;
pub mod host;
mod http;
mod jobs;
mod native;
pub mod panel;
pub mod schema;
pub mod server;
mod shell_host;
pub mod table;
mod tools;

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};

use cut_model::Id;
use serde_json::Value as Json;

use self::call::{Answer, Pending, Started};
use self::host::Host;
use self::server::{Client, Connected, External, Server, Slot};

pub use shell_host::ShellHost;

/// Something the panels show: an external AI's call, a long call's progress.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    External { name: String, args: Json, ok: bool, error: String },
    Progress { turn: Option<u64>, name: String, fraction: Option<f64>, text: String },
}

/// The control API on the shell: the server (started when first needed), the calls waiting for the UI thread, and
/// the call running there.
pub struct Control {
    config: Option<PathBuf>,
    hold: std::time::Duration,
    tx: Sender<Arc<Slot>>,
    rx: Receiver<Arc<Slot>>,
    server: Option<Server>,
    current: Option<(Arc<Slot>, Pending)>,
    events: Vec<Event>,
    repaint: Arc<Mutex<Option<eframe::egui::Context>>>,
    /// Whether external AIs are allowed now, as last applied.
    external: Option<External>,
    applied: Option<bool>,
    error: Option<String>,
    pub panel: panel::Panel,
}

impl Default for Control {
    fn default() -> Self {
        Control::new(default_config())
    }
}

/// `CUT_CONTROL_FILE`, else `%APPDATA%\Nano Studio\cut-control.json`.
pub fn default_config() -> Option<PathBuf> {
    let set = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    set("CUT_CONTROL_FILE").or_else(|| set("APPDATA").map(|d| d.join("Nano Studio").join("cut-control.json")))
}

impl Control {
    /// A control whose external token is kept in `config`.
    pub fn new(config: Option<PathBuf>) -> Self {
        Control::with_hold(config, Server::default_hold())
    }

    /// A control whose calls answer `{running: true, …}` after `hold` (25 s in the app).
    pub fn with_hold(config: Option<PathBuf>, hold: std::time::Duration) -> Self {
        let (tx, rx) = channel();
        Control {
            config,
            hold,
            tx,
            rx,
            server: None,
            current: None,
            events: Vec::new(),
            repaint: Arc::default(),
            external: None,
            applied: None,
            error: None,
            panel: panel::Panel::default(),
        }
    }

    fn server(&mut self) -> &Server {
        if self.server.is_none() {
            let repaint = self.repaint.clone();
            let waker: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                if let Ok(c) = repaint.lock()
                    && let Some(c) = c.as_ref()
                {
                    c.request_repaint();
                }
            });
            self.server = Some(Server::new(self.config.clone(), self.hold, self.tx.clone(), waker));
        }
        self.server.as_ref().expect("made above")
    }

    /// Starts listening -> the port.
    pub fn start(&mut self) -> Option<u16> {
        self.server().start()
    }

    pub fn port(&self) -> Option<u16> {
        self.server.as_ref()?.port()
    }

    /// `http://127.0.0.1:<port>/mcp` once listening.
    pub fn url(&self) -> Option<String> {
        self.port().map(|p| format!("http://127.0.0.1:{p}/mcp"))
    }

    /// A chat turn's token (`issue(turn, owner)`), good until [`Control::revoke`].
    pub fn issue(&mut self, turn: u64, undo_floor: usize) -> Option<String> {
        self.start()?;
        Some(self.server().issue(turn, Some(undo_floor)))
    }

    /// Ends a turn's token: its later calls are refused, a call of it still running is stopped.
    pub fn revoke(&mut self, token: &str) {
        if let Some(s) = &self.server {
            s.revoke(token);
        }
        if let Some((slot, _)) = &self.current
            && matches!(&slot.client, Client::Chat { token: t, .. } if t == token)
        {
            slot.live.abort();
        }
    }

    /// Every tool tools/list gives.
    pub fn tool_names(&mut self) -> Vec<String> {
        self.server().tool_names()
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// The external AIs connected now (an `initialize` within 10 minutes).
    pub fn connected(&self) -> Vec<Connected> {
        self.server.as_ref().map(Server::connected).unwrap_or_default()
    }

    /// The external AI's address and token while it is allowed.
    pub fn external(&self) -> Option<&External> {
        self.external.as_ref()
    }

    /// Why the server could not start, when it could not.
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// Allows external AIs or stops allowing them (the setting `cut.control.external`).
    pub fn set_external(&mut self, on: bool) {
        self.applied = Some(on);
        match self.server().set_external(on) {
            Ok(e) => {
                self.external = e;
                self.error = None;
            }
            Err(e) => {
                self.external = None;
                self.error = Some(e);
            }
        }
        if !on
            && let Some((slot, _)) = &self.current
            && slot.client == Client::External
        {
            slot.live.abort();
        }
    }

    /// Disconnect and New Token: the external AI's sessions end and its token is replaced.
    pub fn disconnect(&mut self) {
        if let Some((slot, _)) = &self.current
            && slot.client == Client::External
        {
            slot.live.abort();
        }
        if let Some(e) = self.server.as_ref().and_then(Server::disconnect) {
            self.external = Some(e);
        }
    }

    /// Applies the setting when it changed since the last frame.
    pub fn follow_setting(&mut self, on: bool) {
        if self.applied != Some(on) && (on || self.applied.is_some()) {
            self.set_external(on);
        }
    }

    /// The context whose repaint a waiting call asks for.
    pub fn set_context(&self, ctx: &eframe::egui::Context) {
        if let Ok(mut c) = self.repaint.lock()
            && c.is_none()
        {
            *c = Some(ctx.clone());
        }
    }

    /// Whether a call runs or waits (the UI keeps painting meanwhile).
    pub fn busy(&self) -> bool {
        self.current.is_some()
    }

    /// The page (ui-assistant.js's bridge): runs the calls that came, one at a time, on `host`. Call each frame.
    pub fn pump(&mut self, host: &mut dyn Host) {
        loop {
            if let Some((slot, mut pending)) = self.current.take() {
                if !self.allowed(&slot) {
                    slot.live.abort();
                }
                match pending.poll(host, &slot.live) {
                    Some(answer) => self.finish(&slot, answer, host),
                    None => {
                        self.report(&slot);
                        self.current = Some((slot, pending));
                        return;
                    }
                }
                continue;
            }
            let slot = match self.rx.try_recv() {
                Ok(s) => s,
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return,
            };
            if slot.answered() {
                continue;
            }
            let refusal = match &slot.client {
                Client::Chat { .. } if !self.allowed(&slot) => {
                    Some("This request has ended; nothing more can be changed in it.")
                }
                Client::External if !self.allowed(&slot) => {
                    Some("External AIs are not allowed in Nano Studio Cut's settings.")
                }
                _ => None,
            };
            if let Some(r) = refusal {
                self.finish(&slot, Answer::Refused(r.to_owned()), host);
                continue;
            }
            let floor = match &slot.client {
                Client::Chat { token, .. } => self.server.as_ref().and_then(|s| s.turn_of(token)).flatten(),
                Client::External => None,
            };
            match call::call(&slot.name, &slot.args, host, &slot.live, floor) {
                Started::Done(answer) => self.finish(&slot, answer, host),
                Started::Waiting(p) => self.current = Some((slot, p)),
            }
        }
    }

    fn allowed(&self, slot: &Slot) -> bool {
        let Some(s) = &self.server else { return false };
        match &slot.client {
            Client::Chat { token, .. } => s.turn_of(token).is_some(),
            Client::External => s.external_on(),
        }
    }

    fn report(&mut self, slot: &Slot) {
        if let Some(p) = slot.live.last() {
            let turn = match &slot.client {
                Client::Chat { turn, .. } => Some(*turn),
                Client::External => None,
            };
            let e = Event::Progress { turn, name: slot.name.clone(), fraction: p.fraction, text: p.text };
            if self.events.last() != Some(&e) {
                self.events.push(e);
            }
        }
    }

    fn finish(&mut self, slot: &Slot, answer: Answer, host: &mut dyn Host) {
        if let Answer::Done { edit: Some(e), .. } = &answer
            && self.allowed(slot)
        {
            land(host, e.seq, e.at, &e.clips);
        }
        if slot.client == Client::External {
            let (ok, error) = match &answer {
                Answer::Done { .. } => (true, String::new()),
                Answer::Refused(e) => (false, e.clone()),
            };
            self.events.push(Event::External { name: slot.name.clone(), args: slot.args.clone(), ok, error });
        }
        slot.answer(answer.content());
    }

    /// Stops the server (the app closes).
    pub fn close(&mut self) {
        if let Some(s) = self.server.take() {
            s.close();
        }
    }
}

/// An edit landed (`land`): its sequence in front, its clips flashing, the playhead on it when not playing.
fn land(host: &mut dyn Host, seq: Option<Id>, at: Option<i64>, clips: &[Id]) {
    let app = host.app_mut();
    if let Some(id) = seq
        && app.sequence_id != Some(id)
        && app.project().sequence(id).is_some()
    {
        app.set_sequence(id);
    }
    if !clips.is_empty() {
        host.flash(clips);
    }
    if let Some(t) = at
        && !host.playing()
    {
        let fps = host.app().sequence().map(|s| s.fps);
        let t = fps.map_or(t.max(0), |f| cut_time::snap(t.max(0), f, false));
        host.seek(t);
    }
}
