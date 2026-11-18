//! The AI Assistant (`ui-assistant.js`'s chat turn and panel): a request runs one Claude Code turn ([`super::agent`])
//! allowed the Cut tools only; what Claude says shows as it streams and each tool call as a step that turns done or
//! refused. Stop ends the turn at once. The edits of a turn are one undo step named after the request
//! (`history.squash`), each of them a step while it runs. A new project ends the turn. Usage and cost show under the
//! answer. The calls themselves reach the editor through the control server ([`crate::control`]), which runs them
//! on the UI thread; this panel only shows them.
//!
//! The panel is a window of its own beside the workspace (the JavaScript docks it on the right); the Automation
//! menu's AI Assistant opens and closes it.
//!
//! Threads: a turn runs its CLI on a thread of its own; its events come back over a channel taken each frame.

use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use eframe::egui::{self, RichText};
use serde_json::{Value as Json, json};

use super::agent::{Agent, Done, Event, Turn, Usage};
use super::claude::Code;
use crate::i18n::{tr, trf};
use crate::shell::Shell;

const HISTORY_TURNS: usize = 6;
const EXAMPLES: [&str; 3] =
    ["Cut the first 3 seconds and add a title", "Make the music 6 dB quieter", "Add a chapter marker at every scene"];
const MODELS: [(&str, &str, &str); 3] = [
    ("haiku", "Haiku", "Fastest, uses the least"),
    ("sonnet", "Sonnet", "Balanced"),
    ("opus", "Opus", "Most capable, slowest, uses the most"),
];

/// The assistant's instructions (`SYSTEM`), with the tools' conventions.
pub fn system() -> String {
    [
        "You are the editing assistant inside Nano Studio Cut, a video editor. The user watches the timeline and the program",
        "monitor change while you work, step by step.",
        "Do what the user asks with the Cut tools. Read first when you need ids or details (get_sequence, get_clip; get_frame",
        "shows you the picture), then edit. Make only the edits that were asked for. Times are seconds on the timeline.",
        "A tool result says what changed; a refused edit changed nothing, so fix the arguments or explain.",
        "When you are done, answer in one to three short sentences, in the language the user wrote in (Korean when they",
        "write Korean), saying what you changed. Never claim an edit that did not succeed.",
        "You cannot open other projects, delete files or run programs. import_media, the exports and save_project ask the",
        "user where the tools say so, and a job that needs a model asks the user to download it; when the user says no,",
        "tell them what was not done. For a keyboard or menu command without its own tool, use list_actions and run_action.",
        crate::control::table::instructions(),
    ]
    .join(" ")
}

/// A step's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Running,
    Done,
    Refused,
    Stopped,
}

/// What a reply lists: what Claude said before its next calls, and its calls.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Note(String),
    Step {
        id: String,
        name: String,
        line: String,
        state: State,
        error: String,
        job: Option<String>,
        progress: Option<(f64, String)>,
    },
}

/// The conversation's usage so far.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Total {
    pub turns: u64,
    pub input: u64,
    pub output: u64,
    pub cost_usd: f64,
}

/// An answer: its steps, the text, and how it ended.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Reply {
    pub turn: String,
    pub items: Vec<Item>,
    pub text: String,
    pub thinking: bool,
    /// `ok` or the code it ended with, once it has.
    pub result: Option<String>,
    pub edits: usize,
    pub usage: Option<(Usage, Total)>,
}

/// A bubble of the log.
#[derive(Debug, Clone, PartialEq)]
pub enum Bubble {
    User(String),
    Assistant(Box<Reply>),
    Missing,
    External(Vec<Item>),
}

struct Running {
    id: String,
    request: String,
    floor: usize,
    project: String,
    token: String,
    stopped: bool,
    closed: bool,
    answer: String,
    rx: Receiver<Event>,
}

/// The panel's state, the turn running, and this project's conversation.
pub struct AssistantUi {
    pub open: bool,
    pub input: String,
    pub log: Vec<Bubble>,
    pub agent: Arc<Agent>,
    turn: Option<Running>,
    conversation: Vec<(String, String, Option<Usage>)>,
    conversation_of: Option<String>,
    turns: u64,
    status: Option<String>,
    notice: Option<String>,
}

impl Default for AssistantUi {
    fn default() -> Self {
        AssistantUi {
            open: false,
            input: String::new(),
            log: Vec::new(),
            agent: Arc::new(Agent::new(Arc::new(super::claude::Cli::from_env()), super::agent::TIMEOUT)),
            turn: None,
            conversation: Vec::new(),
            conversation_of: None,
            turns: 0,
            status: None,
            notice: None,
        }
    }
}

impl AssistantUi {
    /// The turn running (`ui.assistant.running`): its id and request.
    pub fn running(&self) -> Option<(&str, &str)> {
        self.turn.as_ref().map(|t| (t.id.as_str(), t.request.as_str()))
    }
}

/// The label of a turn's undo step: the request on one line, at most 60 characters.
pub fn label_of(request: &str) -> String {
    super::js::cut(&super::js::one_line(request), 60)
}

/// `tokens`: 950, 12.3k, 450k, 1.2M.
pub fn tokens(n: u64) -> String {
    let x = n as f64;
    if n < 1000 {
        n.to_string()
    } else if n < 10_000 {
        format!("{}k", super::js::to_fixed(x / 1000.0, 1))
    } else if n < 1_000_000 {
        format!("{}k", cut_formats::table::js_round(x / 1000.0))
    } else {
        format!("{}M", super::js::to_fixed(x / 1e6, 1))
    }
}

/// `dollars`: <$0.001, $0.042, $1.25.
pub fn dollars(v: f64) -> String {
    if v < 0.001 { "<$0.001".into() } else { format!("${}", super::js::to_fixed(v, if v < 0.1 { 3 } else { 2 })) }
}

/// A count with thousands separators (`toLocaleString` in English).
fn grouped(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `usageLine`: "Sonnet · 12.3k in · 450 out · 17 s · ≈$0.042" and its tooltip.
pub fn usage_line(u: &Usage, t: &Total) -> (String, String) {
    let input = u.input + u.cache_read + u.cache_write;
    let name = MODELS.iter().find(|m| m.0 == u.model).map_or(u.model.as_str(), |m| m.1);
    let mut parts =
        vec![name.to_owned(), trf("{n} in", &[("n", &tokens(input))]), trf("{n} out", &[("n", &tokens(u.output))])];
    if u.duration_ms > 0 {
        let s = cut_formats::table::js_round(u.duration_ms as f64 / 1000.0).max(1.0);
        parts.push(trf("{n} s", &[("n", &super::js::num(s))]));
    }
    if let Some(c) = u.cost_usd {
        parts.push(format!("≈{}", dollars(c)));
    }
    let mut tip = vec![
        trf(
            "Tokens in: {n} (new {a}, read from the cache {b}, written to the cache {c})",
            &[
                ("n", &grouped(input)),
                ("a", &grouped(u.input)),
                ("b", &grouped(u.cache_read)),
                ("c", &grouped(u.cache_write)),
            ],
        ),
        trf("Tokens out: {n}", &[("n", &grouped(u.output))]),
    ];
    if u.turns > 0 {
        tip.push(trf("Claude's steps: {n}", &[("n", &u.turns.to_string())]));
    }
    if let Some(c) = u.cost_usd {
        tip.push(trf("≈{cost}: Claude Code's estimate at API prices. On a Claude subscription it is not charged; it counts toward the plan's usage limit.", &[("cost", &dollars(c))]));
    }
    if t.turns > 1 {
        tip.push(trf(
            "This conversation: {n} requests, {i} in, {o} out, ≈{cost}",
            &[
                ("n", &t.turns.to_string()),
                ("i", &tokens(t.input)),
                ("o", &tokens(t.output)),
                ("cost", &dollars(t.cost_usd)),
            ],
        ));
    }
    (parts.join(" · "), tip.join("\n"))
}

/// The AI Assistant item of the Automation menu: the panel opens (or closes).
pub fn toggle(s: &mut Shell) {
    let a = &mut s.features.ai.assistant;
    a.open = !a.open;
}

fn acknowledged(s: &Shell) -> bool {
    s.doc.settings.get("assistant.acknowledged").and_then(Json::as_bool) == Some(true)
}

/// The editor now, for the prompt (`get_state` and `get_sequence` with 150 clips at most).
fn editor_now(s: &mut Shell, ctx: &egui::Context) -> String {
    use crate::control::call::{Answer, Started, call};
    let live = crate::control::host::Live::default();
    let mut host = crate::control::ShellHost { s, ctx };
    let mut value = |name: &str, args: Json| match call(name, &args, &mut host, &live, None) {
        Started::Done(Answer::Done { value, .. }) => Some(value),
        _ => None,
    };
    let state = value("get_state", json!({})).unwrap_or(Json::Null);
    let seq = value("get_sequence", json!({ "max_clips": 150 })).unwrap_or(Json::Null);
    format!("{{\"state\":{state},\"sequence\":{seq}}}")
}

/// The prompt of a turn: the earlier requests of this conversation, the editor now, the request.
pub fn prompt(earlier: &[(String, String, Option<Usage>)], editor: &str, request: &str) -> String {
    let from = earlier.len().saturating_sub(HISTORY_TURNS);
    let earlier: Vec<String> = earlier[from..]
        .iter()
        .map(|(r, a, _)| {
            let mut used = 0;
            let a: String = a
                .chars()
                .take_while(|c| {
                    used += c.len_utf16();
                    used <= 600
                })
                .collect();
            format!("User: {r}\nAssistant: {a}")
        })
        .collect();
    let earlier = earlier.join("\n\n");
    [
        if earlier.is_empty() { String::new() } else { format!("Earlier in this conversation:\n{earlier}\n") },
        format!("The editor now (JSON):\n{editor}"),
        String::new(),
        format!("The user's request: {request}"),
    ]
    .join("\n")
}

/// `ask`: Send pressed with `request`. -> whether a turn started.
pub fn ask(s: &mut Shell, ctx: &egui::Context, request: &str) -> bool {
    if s.features.ai.assistant.turn.is_some() || super::js::trim(request).is_empty() {
        return false;
    }
    if !acknowledged(s) {
        s.features.ai.assistant.notice = Some(request.to_owned());
        return false;
    }
    if s.features.ai.assistant.agent.cli.find().is_none() {
        super::notice::explain(s, Code::NotInstalled, "");
        s.features.ai.assistant.log.push(Bubble::Missing);
        return false;
    }
    if s.features.ai.assistant.conversation_of.as_deref() != Some(s.doc.key.as_str()) {
        s.features.ai.assistant.conversation.clear();
        s.features.ai.assistant.conversation_of = Some(s.doc.key.clone());
    }
    let model = super::model(s);
    let floor = s.app.history.position();
    let editor = editor_now(s, ctx);
    let a = &mut s.features.ai.assistant;
    a.turns += 1;
    let (number, id) = (a.turns, format!("turn{}", a.turns));
    let prompt = prompt(&a.conversation, &editor, request);
    let token = s.features.control.issue(number, floor);
    let url = s.features.control.url().unwrap_or_default();
    let tools = if token.is_some() { s.features.control.tool_names() } else { Vec::new() };
    let token = token.unwrap_or_default();
    let turn = Turn { id: id.clone(), url, token: token.clone(), tools, system: system(), prompt, model: Some(model) };
    let (tx, rx) = channel();
    let agent = s.features.ai.assistant.agent.clone();
    let wake = ctx.clone();
    let _ = std::thread::Builder::new().name("cut-app assistant".into()).spawn(move || {
        let mut emitted = false;
        let done = agent.run(&turn, &mut |e| {
            emitted |= matches!(e, Event::Done(_));
            let _ = tx.send(e);
            wake.request_repaint();
        });
        if !emitted {
            let _ = tx.send(Event::Done(done));
        }
        wake.request_repaint();
    });
    let a = &mut s.features.ai.assistant;
    a.log.push(Bubble::User(request.to_owned()));
    a.log.push(Bubble::Assistant(Box::new(Reply { turn: id.clone(), thinking: true, ..Reply::default() })));
    a.status = Some("Claude is working on it…".into());
    a.turn = Some(Running {
        id,
        request: request.to_owned(),
        floor,
        project: s.doc.key.clone(),
        token,
        stopped: false,
        closed: false,
        answer: String::new(),
        rx,
    });
    true
}

/// `stop`: Stop pressed: the turn's token goes at once (nothing of it lands after Stop) and its CLI is ended.
pub fn stop(s: &mut Shell) -> bool {
    let Some(t) = s.features.ai.assistant.turn.as_mut() else { return false };
    t.stopped = true;
    let (id, token) = (t.id.clone(), t.token.clone());
    s.features.control.revoke(&token);
    s.features.ai.assistant.agent.stop(&id);
    s.features.ai.assistant.status = Some("Stopping…".into());
    true
}

fn reply<'a>(log: &'a mut [Bubble], turn: &str) -> Option<&'a mut Reply> {
    log.iter_mut().rev().find_map(|b| match b {
        Bubble::Assistant(r) if r.turn == turn => Some(r.as_mut()),
        _ => None,
    })
}

fn step_line(name: &str, input: &Json) -> String {
    let (text, mut params) = crate::control::call::describe(name, input);
    if name == "run_action" {
        for (k, v) in &mut params {
            if k == "id"
                && let Some(a) = crate::keys::ACTIONS.iter().find(|a| a.id == v.as_str())
            {
                *v = tr(a.title).into_owned();
            }
        }
    }
    let p: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    trf(&text, &p)
}

/// A call's answer that it still runs (`{running: true, job}`): the job.
fn running_job(text: &str) -> Option<String> {
    let v: Json = serde_json::from_str(text).ok()?;
    (v["running"] == true).then(|| v["job"].as_str().map(str::to_owned)).flatten()
}

/// The turn's events, the control's progress and external calls, a new project that ends the turn (each frame).
pub fn poll(s: &mut Shell) {
    for e in s.features.control.take_events() {
        let a = &mut s.features.ai.assistant;
        match e {
            crate::control::Event::External { name, args, ok, error } => {
                let item = Item::Step {
                    id: String::new(),
                    line: step_line(&name, &args),
                    name,
                    state: if ok { State::Done } else { State::Refused },
                    error,
                    job: None,
                    progress: None,
                };
                match a.log.last_mut() {
                    Some(Bubble::External(items)) => items.push(item),
                    _ => a.log.push(Bubble::External(vec![item])),
                }
            }
            crate::control::Event::Progress { turn, name, fraction, text } => {
                let Some(t) = a.turn.as_ref().filter(|t| turn.is_some_and(|n| format!("turn{n}") == t.id)) else {
                    continue;
                };
                let id = t.id.clone();
                let Some(r) = reply(&mut a.log, &id) else { continue };
                let step = r
                    .items
                    .iter_mut()
                    .rev()
                    .find(|i| matches!(i, Item::Step { state: State::Running, name: n, .. } if *n == name));
                if let Some(Item::Step { progress, .. }) = step {
                    *progress = Some((fraction.unwrap_or(0.0).clamp(0.0, 1.0), text));
                }
            }
        }
    }
    if let Some(t) = s.features.ai.assistant.turn.as_mut()
        && t.project != s.doc.key
        && !t.closed
    {
        t.closed = true;
        stop(s);
    }
    loop {
        let Some(t) = s.features.ai.assistant.turn.as_mut() else { return };
        let Ok(e) = t.rx.try_recv() else { return };
        let id = t.id.clone();
        if let Event::Text { text, last: false } = &e {
            t.answer.clone_from(text);
        }
        if let Event::Done(done) = e {
            end(s, done);
            continue;
        }
        let a = &mut s.features.ai.assistant;
        let Some(r) = reply(&mut a.log, &id) else { continue };
        match e {
            Event::Text { text, last } => {
                r.thinking = last;
                if last {
                    r.items.push(Item::Note(text));
                    r.text.clear();
                } else {
                    r.text = text;
                }
            }
            Event::Tool { id: call, name, input } => {
                if name == crate::control::server::WAIT_TOOL {
                    // waiting for a job is not a step of its own: its answer finishes the job's step
                    let job = input["job"].as_str().map(str::to_owned);
                    for i in &mut r.items {
                        if let Item::Step { job: Some(j), id, .. } = i
                            && Some(j.as_str()) == job.as_deref()
                        {
                            id.clone_from(&call);
                        }
                    }
                    continue;
                }
                let line = step_line(&name, &input);
                r.items.push(Item::Step {
                    id: call,
                    name,
                    line,
                    state: State::Running,
                    error: String::new(),
                    job: None,
                    progress: None,
                });
                let n = r.items.iter().filter(|i| matches!(i, Item::Step { .. })).count();
                a.status = Some(trf("Step {n}…", &[("n", &n.to_string())]));
            }
            Event::Result { id: call, ok, text } => {
                let Some(Item::Step { state, error, job, progress, .. }) =
                    r.items.iter_mut().find(|i| matches!(i, Item::Step { id, .. } if *id == call))
                else {
                    continue;
                };
                if let Some(j) = running_job(&text).filter(|_| ok) {
                    *job = Some(j);
                    continue;
                }
                *progress = None;
                *state = if ok { State::Done } else { State::Refused };
                if !ok {
                    *error = text;
                }
            }
            Event::Done(_) => {}
        }
    }
}

/// The turn ended: its edits one undo step, the answer or why it stopped, the usage.
fn end(s: &mut Shell, done: Done) {
    let Some(t) = s.features.ai.assistant.turn.take() else { return };
    s.features.control.revoke(&t.token);
    let same = t.project == s.doc.key;
    let steps = if same { s.app.history.position().saturating_sub(t.floor) } else { 0 };
    if steps > 0 {
        s.app.history.squash(t.floor, &label_of(&t.request));
    }
    let a = &mut s.features.ai.assistant;
    a.conversation.push((
        t.request.clone(),
        if done.ok { done.text.clone() } else { String::new() },
        done.usage.clone(),
    ));
    let mut total = Total::default();
    for u in a.conversation.iter().filter_map(|c| c.2.as_ref()) {
        total.turns += 1;
        total.input += u.input + u.cache_read + u.cache_write;
        total.output += u.output;
        total.cost_usd += u.cost_usd.unwrap_or(0.0);
    }
    let code = if t.closed { Some("closed") } else { done.code.map(Code::id) };
    let ok = done.ok && !t.closed;
    a.status = None;
    if let Some(r) = reply(&mut a.log, &t.id) {
        for i in &mut r.items {
            if let Item::Step { state: st @ State::Running, .. } = i {
                *st = if ok { State::Done } else { State::Stopped };
            }
        }
        let final_text = if ok { super::js::trim(&done.text).to_owned() } else { String::new() };
        if !final_text.is_empty() && matches!(r.items.last(), Some(Item::Note(n)) if *n == final_text) {
            r.items.pop();
        }
        r.thinking = false;
        r.text = if ok {
            if final_text.is_empty() { tr("Done.").into_owned() } else { final_text }
        } else {
            match code {
                Some("cancelled") => tr("Stopped. What was done so far is kept as one undo step.").into_owned(),
                Some("closed") => {
                    tr("Stopped because another project was opened; the request changes nothing in it.").into_owned()
                }
                Some("not-installed") => tr("Claude Code is not installed on this PC.").into_owned(),
                Some("auth") => tr("Claude Code is not signed in, or its sign-in has expired.").into_owned(),
                Some("quota") => tr("Your Claude account has reached its usage limit for now.").into_owned(),
                Some("timeout") => tr("Claude did not finish in time.").into_owned(),
                _ => trf("Claude Code failed: {error}", &[("error", &done.error)]),
            }
        };
        r.result = Some(if ok { "ok".into() } else { code.unwrap_or("error").to_owned() });
        r.edits = steps;
        r.usage = done.usage.clone().map(|u| (u, total));
    }
    if let Some(c) = done.code.filter(|c| matches!(c, Code::NotInstalled | Code::Auth | Code::Quota)) {
        super::notice::explain(s, c, if c == Code::Quota { &done.error } else { "" });
    }
}

/// Waits for the running turn's end (tests and scripted runs).
pub fn settle(s: &mut Shell, limit: Duration) {
    let until = std::time::Instant::now() + limit;
    while s.features.ai.assistant.turn.is_some() && std::time::Instant::now() < until {
        poll(s);
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn steps_ui(ui: &mut egui::Ui, s: &Shell, items: &[Item]) {
    let gray = s.palette.gray[8];
    for i in items {
        match i {
            Item::Note(n) => {
                ui.label(RichText::new(n).color(gray));
            }
            Item::Step { line, state, error, progress, .. } => {
                let mark = match state {
                    State::Running => "…",
                    State::Done => "✓",
                    State::Refused => "✗",
                    State::Stopped => "■",
                };
                ui.label(format!("{mark} {line}"));
                if let Some((f, text)) = progress {
                    let pct = cut_formats::table::js_round(f * 100.0);
                    let line = if text.is_empty() { format!("{pct}%") } else { format!("{pct}% · {text}") };
                    ui.add(egui::ProgressBar::new(*f as f32).text(line));
                }
                if !error.is_empty() {
                    ui.label(RichText::new(error).color(s.palette.red).size(11.0));
                }
            }
        }
    }
}

/// The panel and its notice, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    poll(s);
    if let Some(request) = s.features.ai.assistant.notice.clone() {
        let (mut go, mut cancel) = (false, false);
        crate::auto::dialog("AI Assistant", "cutAsNotice", 500.0).show(ctx, |ui| {
            ui.label(tr("The AI assistant sends your request and a description of the project (clip, track and marker names and times, captions) to Claude (Anthropic) through Claude Code on this PC, and lets Claude edit the project with Cut's tools."));
            ui.label(RichText::new(tr("When Claude asks to see a frame, a picture of the program monitor is sent too. Files and file paths are not sent, and Claude cannot change files on this PC.")).color(s.palette.gray[8]).size(12.0));
            ui.horizontal(|ui| {
                go = ui.button(tr("Continue")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        if go || cancel {
            s.features.ai.assistant.notice = None;
        }
        if go {
            s.doc.settings.set("assistant.acknowledged", Json::Bool(true));
            let _ = s.doc.settings.save();
            ask(s, ctx, &request);
        }
    }
    if !s.features.ai.assistant.open {
        return;
    }
    let mut open = true;
    let (mut send, mut stop_now) = (false, false);
    let mut model_pick: Option<&str> = None;
    let working = s.features.ai.assistant.turn.is_some();
    let model = super::model(s);
    let mut input = s.features.ai.assistant.input.clone();
    egui::Window::new(tr("AI Assistant"))
        .id(egui::Id::unique("cut-assistant"))
        .open(&mut open)
        .default_width(380.0)
        .default_height(520.0)
        .anchor(egui::Align2::RIGHT_TOP, egui::Vec2::new(-8.0, 48.0))
        .show(ctx, |ui| {
            let log = s.features.ai.assistant.log.clone();
            egui::ScrollArea::vertical().max_height(ui.available_height() - 110.0).stick_to_bottom(true).show(ui, |ui| {
                if log.is_empty() {
                    ui.label(RichText::new(tr("Ask the AI to edit")).strong());
                    ui.label(RichText::new(tr("Claude edits this project with Cut's tools while you watch. Each request is one undo step.")).color(s.palette.gray[8]));
                    for x in EXAMPLES {
                        if ui.button(tr(x)).clicked() {
                            input = tr(x).into_owned();
                        }
                    }
                }
                for b in &log {
                    match b {
                        Bubble::User(t) => {
                            ui.label(RichText::new(t).strong());
                        }
                        Bubble::Missing => {
                            ui.label(RichText::new(tr("Claude Code is not installed on this PC.")).color(s.palette.red));
                        }
                        Bubble::External(items) => {
                            ui.label(RichText::new(tr("External AI")).strong());
                            steps_ui(ui, s, items);
                        }
                        Bubble::Assistant(r) => {
                            steps_ui(ui, s, &r.items);
                            if r.thinking && r.text.is_empty() {
                                ui.label(RichText::new(tr("Thinking…")).italics().color(s.palette.gray[8]));
                            } else {
                                ui.label(&r.text);
                            }
                            if r.edits > 0 {
                                ui.label(RichText::new(trf("{n} edits · Ctrl+Z undoes them all", &[("n", &r.edits.to_string())])).size(11.0));
                            }
                            if let Some((u, t)) = &r.usage {
                                let (line, tip) = usage_line(u, t);
                                ui.label(RichText::new(line).size(11.0).color(s.palette.gray[8])).on_hover_text(tip);
                            }
                        }
                    }
                    ui.separator();
                }
            });
            let r = ui.add(
                egui::TextEdit::multiline(&mut input)
                    .desired_rows(2)
                    .desired_width(f32::INFINITY)
                    .hint_text(tr("Ask for an edit, e.g. cut the first 3 seconds and add a title")),
            );
            let r = r.on_hover_text(tr("Request"));
            if r.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift) {
                send = true;
            }
            ui.horizontal(|ui| {
                let name = MODELS.iter().find(|m| m.0 == model).map_or(model.as_str(), |m| m.1);
                ui.add_enabled_ui(!working, |ui| {
                    egui::ComboBox::from_id_salt("cut-as-model").icon(crate::theme::combo_icon)
                        .selected_text(name)
                        .show_ui(ui, |ui| {
                            for (id, label, note) in MODELS {
                                if ui.selectable_label(model == id, label).on_hover_text(tr(note)).clicked() {
                                    model_pick = Some(id);
                                }
                            }
                        })
                        .response
                        .on_hover_text(tr("Claude model"));
                });
                if working {
                    stop_now = ui.button(tr("Stop")).clicked();
                } else {
                    send |= ui.button(tr("Send")).clicked();
                }
            });
            if let Some(st) = &s.features.ai.assistant.status {
                ui.label(RichText::new(tr(st)).size(11.0).color(s.palette.gray[8]));
            }
        });
    if let Some(m) = model_pick {
        crate::prefs::set(s, "ai.model", Json::from(m));
    }
    s.features.ai.assistant.open = open;
    if send && !working {
        let text = super::js::trim(&input).trim_end_matches('\n').to_owned();
        if !text.is_empty() {
            input.clear();
            ask(s, ctx, &text);
        }
    }
    s.features.ai.assistant.input = input;
    if stop_now {
        stop(s);
    }
    if working {
        ctx.request_repaint_after(Duration::from_millis(100));
    }
}
