//! External AIs in the editor (ui-assistant.js's settings section and banner, ui-control.js's `ask`): the Preferences
//! page AI Control (allow, the setup text to copy, New Token), the banner while one is connected (Disconnect), and
//! the questions the tools ask the user before they import or write a file. Each frame [`windows`] also applies the
//! setting and runs the calls that came ([`super::Control::pump`]).

use std::cell::RefCell;
use std::rc::Rc;

use eframe::egui::{self, RichText};
use serde_json::json;

use super::ShellHost;
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The setting that allows external AIs (off by default; the JavaScript Cut's `cut.control.external`, carried over
/// by `studio.rs`).
pub const SETTING: &str = "control.external";
/// Set once the person chose external access in this app: a `control.external` that came from the JavaScript Cut
/// counts only after they confirmed it here (the question at the first start).
pub const CONFIRMED: &str = "control.confirmed";

/// The question about a carried-over permission, in Korean.
pub const KO: [(&str, &str); 4] = [
    ("External AI access", "외부 AI 접근"),
    (
        "Your earlier Nano Studio Cut let AI apps on this PC (Claude Code, Claude Desktop or another MCP client) read and edit the open project with its token. Keep allowing it in this Cut?",
        "이전 Nano Studio Cut에서는 이 PC의 AI 앱(Claude Code, Claude Desktop 또는 다른 MCP 클라이언트)이 토큰으로 열린 프로젝트를 읽고 편집할 수 있었습니다. 이 Cut에서도 계속 허용할까요?",
    ),
    ("Keep Allowing", "계속 허용"),
    ("Turn Off", "끄기"),
];

/// A yes/no question that lists rows (`[label, value]`) or files under a message.
pub struct Ask {
    pub id: u64,
    pub title: String,
    pub message: String,
    pub rows: Vec<(String, String)>,
    pub list: Vec<String>,
    pub note: String,
    pub yes: String,
    pub no: String,
    pub answer: Option<bool>,
}

/// The questions on screen, shared with the tasks that wait for their answers.
#[derive(Default)]
pub struct Asks {
    next: u64,
    list: Vec<Ask>,
}

impl Asks {
    /// Puts a question on screen -> its id.
    pub fn ask(&mut self, mut a: Ask) -> u64 {
        self.next += 1;
        a.id = self.next;
        a.answer = None;
        self.list.push(a);
        self.next
    }

    /// The answer once given (the question then leaves).
    pub fn answer(&mut self, id: u64) -> Option<bool> {
        let i = self.list.iter().position(|a| a.id == id)?;
        let a = self.list[i].answer?;
        self.list.remove(i);
        Some(a)
    }

    /// Answers the question shown first (tests, `CUT_ACTIONS`): `yes` or no.
    pub fn reply(&mut self, yes: bool) -> bool {
        match self.list.iter_mut().find(|a| a.answer.is_none()) {
            Some(a) => {
                a.answer = Some(yes);
                true
            }
            None => false,
        }
    }

    /// The questions waiting for an answer: (title, message).
    pub fn open(&self) -> Vec<(String, String)> {
        self.list.iter().filter(|a| a.answer.is_none()).map(|a| (a.title.clone(), a.message.clone())).collect()
    }
}

/// The settings page's and the questions' state.
#[derive(Default)]
pub struct Panel {
    pub asks: Rc<RefCell<Asks>>,
    /// The question about a carried-over permission, while it is on screen.
    carried: Option<u64>,
}

/// The setup text for Claude Code and for other MCP clients (`config`).
pub fn setup_text(url: &str, token: &str) -> (String, String) {
    let command = format!("claude mcp add --transport http nano-cut {url} --header \"Authorization: Bearer {token}\"");
    let config = json!({ "mcpServers": { "nano-cut": { "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {token}") } } } });
    (command, serde_json::to_string_pretty(&config).unwrap_or_default())
}

fn flag(s: &Shell, key: &str) -> Option<bool> {
    s.doc.settings.get(key).and_then(serde_json::Value::as_bool)
}

/// Whether external AIs may connect: allowed, and confirmed in this app.
pub fn allowed(s: &Shell) -> bool {
    flag(s, SETTING) == Some(true) && flag(s, CONFIRMED) == Some(true)
}

/// A permission carried over from the JavaScript Cut and not confirmed yet: asked once; Yes keeps it (with the
/// token file the client knows), No turns it off. Either answer is remembered.
fn confirm_carried(s: &mut Shell) {
    if flag(s, SETTING) != Some(true) || flag(s, CONFIRMED).is_some() {
        return;
    }
    let asks = s.features.control.panel.asks.clone();
    match s.features.control.panel.carried {
        None => {
            let id = asks.borrow_mut().ask(Ask {
                id: 0,
                title: tr("External AI access").into_owned(),
                message: tr("Your earlier Nano Studio Cut let AI apps on this PC (Claude Code, Claude Desktop or another MCP client) read and edit the open project with its token. Keep allowing it in this Cut?").into_owned(),
                rows: Vec::new(),
                list: Vec::new(),
                note: String::new(),
                yes: tr("Keep Allowing").into_owned(),
                no: tr("Turn Off").into_owned(),
                answer: None,
            });
            s.features.control.panel.carried = Some(id);
        }
        Some(id) => {
            let Some(yes) = asks.borrow_mut().answer(id) else { return };
            s.features.control.panel.carried = None;
            if !yes {
                s.doc.settings.set(SETTING, json!(false));
            }
            crate::prefs::set(s, CONFIRMED, json!(true));
        }
    }
}

/// Each frame: the setting applied, the calls run, the questions and the banner drawn.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    confirm_carried(s);
    let on = allowed(s);
    let asks = s.features.control.panel.asks.clone();
    let mut stand_in = super::Control::new(None);
    stand_in.panel.asks = asks.clone();
    let mut control = std::mem::replace(&mut s.features.control, stand_in);
    control.set_context(ctx);
    control.follow_setting(on);
    control.pump(&mut ShellHost { s, ctx });
    if control.busy() {
        ctx.request_repaint_after(std::time::Duration::from_millis(50));
    }
    let connected = if on { control.connected() } else { Vec::new() };
    s.features.control = control;
    questions(ctx, &asks);
    if !connected.is_empty() {
        let names: Vec<String> = connected.into_iter().map(|c| c.name).collect();
        egui::Area::new(egui::Id::unique("cut-control-banner")).anchor(egui::Align2::CENTER_TOP, [0.0, 34.0]).show(
            ctx,
            |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("●").color(egui::Color32::from_rgb(80, 200, 120)));
                        ui.label(trf("An external AI ({name}) is editing in Cut.", &[("name", &names.join(", "))]));
                        if ui.button(tr("Disconnect")).clicked() {
                            disconnect(s);
                        }
                    });
                });
            },
        );
    }
}

/// Disconnect and New Token (`disconnect`).
pub fn disconnect(s: &mut Shell) {
    s.features.control.disconnect();
    s.app.toast(tr("The external AI was disconnected. It needs the new token to connect again."));
}

fn questions(ctx: &egui::Context, asks: &Rc<RefCell<Asks>>) {
    let mut asks = asks.borrow_mut();
    for a in asks.list.iter_mut().filter(|a| a.answer.is_none()) {
        let mut answer = None;
        egui::Window::new(&a.title)
            .id(egui::Id::unique(("cut-control-ask", a.id)))
            .collapsible(false)
            .resizable(false)
            .default_width(540.0)
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .show(ctx, |ui| {
                ui.label(&a.message);
                if !a.rows.is_empty() {
                    egui::Grid::new(("cut-control-rows", a.id)).num_columns(2).show(ui, |ui| {
                        for (k, v) in &a.rows {
                            ui.label(RichText::new(k).weak());
                            ui.label(v);
                            ui.end_row();
                        }
                    });
                }
                for x in &a.list {
                    ui.label(RichText::new(x).monospace());
                }
                if !a.note.is_empty() {
                    ui.label(RichText::new(&a.note).weak().size(11.0));
                }
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    if ui.button(RichText::new(&a.yes).strong()).clicked() {
                        answer = Some(true);
                    }
                    if ui.button(&a.no).clicked() {
                        answer = Some(false);
                    }
                });
            });
        if answer.is_some() {
            a.answer = answer;
        }
    }
}

/// The Preferences page AI Control (`settingsSection`).
pub fn rows(s: &mut Shell, ui: &mut egui::Ui) {
    let mut on = allowed(s);
    ui.label("");
    if ui.checkbox(&mut on, tr("Let external AIs operate Cut")).changed() {
        s.doc.settings.set(CONFIRMED, json!(true));
        crate::prefs::set(s, SETTING, json!(on));
        s.features.control.follow_setting(on);
    }
    ui.end_row();
    ui.label("");
    ui.vertical(|ui| {
        ui.set_max_width(360.0);
        ui.label(RichText::new(tr("An AI app on this PC (Claude Code, Claude Desktop or another MCP client) can then read and edit the open project with the same tools as the AI assistant. It needs the token below; a connection without it is refused. Its edits show live and can be undone.")).weak());
        if !on {
            return;
        }
        let c = &s.features.control;
        let Some(e) = c.external().cloned() else {
            let t = if c.error().is_some() { tr("The control server could not start.") } else { tr("Starting…") };
            ui.label(RichText::new(t).weak());
            return;
        };
        let (command, config) = setup_text(&e.url, &e.token);
        let mut copied = false;
        for (label, text) in [(tr("Claude Code (run in a terminal):"), command), (tr("Other MCP clients (JSON):"), config)] {
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.label(label);
                if ui.button(tr("Copy")).clicked() {
                    ui.ctx().copy_text(text.clone());
                    copied = true;
                }
            });
            let mut shown = text.as_str();
            ui.add(egui::TextEdit::multiline(&mut shown).font(egui::TextStyle::Monospace).desired_width(f32::INFINITY).desired_rows(2));
        }
        if copied {
            s.app.toast(tr("Copied"));
        }
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            if ui.button(tr("New Token")).clicked() {
                disconnect(s);
            }
            ui.label(RichText::new(tr("A new token disconnects every external AI; set them up again with the new one.")).weak());
        });
    });
    ui.end_row();
}
