//! Claude in the editor (`ui-ai.js`, `main/cut/ai.js`, `main/ai/claude.js`): Claude, through Claude Code on this PC,
//! works on text only, and every result is checked and reviewed before it becomes one undo step.
//!
//! - Polish and Translate Captions ([`captions_ui`]), in the Automation menu and the Captions panel's Claude menu.
//! - YouTube Title, Description and Chapters ([`metadata_ui`]), with Add as Chapter Markers.
//! - Highlights to Shorts ([`shorts_ui`]): ranges picked by Claude, reviewed, then a new 1080x1920 sequence.
//! - Edit Command (Ctrl+J, [`command_ui`]): a request in plain words -> a plan of whitelisted operations, previewed,
//!   applied as one undo step.
//! - AI Assistant ([`assistant`], [`agent`]): a chat whose requests Claude carries out with the control API's tools.
//!
//! The checks of Claude's answers are pure ([`js`], [`captions`], [`lines`], [`metadata`], [`highlights`], [`plan`]);
//! the CLI is [`claude`], one request with its time limit [`runner`], a job with its one retry [`ask`]. Before the
//! first request a notice says what is sent (the setting `cut.ai.acknowledged`); without Claude Code (or signed out,
//! or out of quota) a dialog explains it ([`notice`]).
//!
//! Threads: each job runs its requests on a thread of its own (one job at a time, as the automation's analyses); the
//! CLI's output is read on threads of its own; the window keeps drawing and takes the result when it is there.

pub mod agent;
pub mod ask;
pub mod assistant;
pub mod captions;
pub mod captions_ui;
pub mod claude;
pub mod command_ui;
pub mod highlights;
pub mod js;
pub mod lines;
pub mod metadata;
pub mod metadata_ui;
pub mod notice;
pub mod plan;
pub mod runner;
pub mod shorts_ui;
pub mod unicode;

use std::sync::Arc;
use std::time::Duration;

use eframe::egui::{self, Align2, ProgressBar, Vec2};
use serde_json::Value as Json;

use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// What a job hands the UI thread: the edit or the review that follows its answer.
pub type Then = Box<dyn FnOnce(&mut Shell) + Send>;

/// The text AI's state: the CLI's requests, the job that runs, and each feature's dialogs.
pub struct AiUi {
    pub runner: Arc<runner::Runner>,
    pub job: Option<ask::Job<Then>>,
    pub notice: notice::NoticeUi,
    pub captions: captions_ui::CaptionsAi,
    pub metadata: metadata_ui::MetadataAi,
    pub shorts: shorts_ui::ShortsAi,
    pub command: command_ui::CommandAi,
    pub assistant: assistant::AssistantUi,
}

impl Default for AiUi {
    fn default() -> Self {
        AiUi {
            runner: Arc::new(runner::Runner::new(claude::Cli::from_env(), runner::TIMEOUT)),
            job: None,
            notice: notice::NoticeUi::default(),
            captions: captions_ui::CaptionsAi::default(),
            metadata: metadata_ui::MetadataAi::default(),
            shorts: shorts_ui::ShortsAi::default(),
            command: command_ui::CommandAi::default(),
            assistant: assistant::AssistantUi::default(),
        }
    }
}

/// The actions of the Automation menu's Claude items (`Cut.auto.ai*`).
pub const ACTIONS: [(&str, &str); 6] = [
    ("auto.aiPolish", "Polish Captions with Claude…"),
    ("auto.aiTranslate", "Translate Captions with Claude…"),
    ("auto.aiMetadata", "YouTube Title, Description and Chapters…"),
    ("auto.aiHighlights", "Highlights to Shorts…"),
    ("auto.aiCommand", "Edit Command…"),
    ("auto.aiAssistant", "AI Assistant"),
];

/// The model of Cut's Claude features (`cut.ai.model`, `sonnet` unless it names one of the models).
pub fn model(s: &Shell) -> String {
    let m = s.doc.settings.get("ai.model").and_then(Json::as_str).unwrap_or("sonnet");
    if runner::MODELS.contains(&m) { m.to_owned() } else { "sonnet".into() }
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    ACTIONS.iter().any(|(a, _)| *a == id).then(|| id == "auto.aiAssistant" || s.app.sequence().is_some())
}

/// Runs one of this feature's actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    match id {
        "auto.aiPolish" => captions_ui::polish(s),
        "auto.aiTranslate" => captions_ui::translate(s),
        "auto.aiMetadata" => metadata_ui::open(s),
        "auto.aiHighlights" => shorts_ui::open(s),
        "auto.aiCommand" => command_ui::open(s),
        "auto.aiAssistant" => assistant::toggle(s),
        _ => return false,
    }
    true
}

/// Whether a job of Claude's or an analysis of the automation runs (`ui.auto.running`).
pub fn busy(s: &Shell) -> bool {
    s.features.ai.job.is_some() || s.features.auto.running()
}

/// `job`: runs `work` under the progress box once the notice is acknowledged and Claude Code is there; its result
/// runs on the UI thread; a failure is explained, a cancel said.
pub fn job(s: &mut Shell, title: &str, work: impl FnOnce(&ask::Ctx) -> Result<Then, ask::Stop> + Send + 'static) {
    if !notice::acknowledged(s) {
        let title = title.to_owned();
        s.features.ai.notice.ask(Box::new(move |s: &mut Shell| job(s, &title, work)));
        return;
    }
    if !s.features.ai.runner.installed() {
        notice::explain(s, claude::Code::NotInstalled, "");
        return;
    }
    if busy(s) {
        s.app.toast(tr("Another analysis is running."));
        return;
    }
    let runner = s.features.ai.runner.clone();
    s.features.ai.job = Some(ask::Job::start(tr(title).into_owned(), runner, model(s), work));
}

fn take(s: &mut Shell, out: ask::Outcome<Then>) {
    match out {
        ask::Outcome::Done(then) => then(s),
        ask::Outcome::Cancelled => s.app.toast(tr("The analysis was cancelled.")),
        ask::Outcome::Failed(why) => notice::failed(s, &why),
    }
}

/// Waits for the running job and takes its outcome, as the next frame would (tests and scripted runs).
pub fn settle(s: &mut Shell) {
    if let Some(out) = s.features.ai.job.as_ref().and_then(ask::Job::wait) {
        s.features.ai.job = None;
        take(s, out);
    }
}

/// The progress line of a running job, as the JavaScript's box says it.
fn progress_line(p: &ask::Progress) -> String {
    let label = p.part.map_or(String::new(), |(i, n)| {
        format!("{} · ", trf("Part {i} of {n}", &[("i", &i.to_string()), ("n", &n.to_string())]))
    });
    let line = match p.line {
        ask::Line::Waiting => tr("Waiting for Claude…").into_owned(),
        ask::Line::Again => tr("Asking Claude again…").into_owned(),
        ask::Line::Writing(n) => trf("Claude is writing… {n} characters", &[("n", &n.to_string())]),
        ask::Line::Percent => return format!("{}%", cut_formats::table::js_round(p.fraction * 100.0)),
    };
    format!("{label}{line}")
}

/// The job's outcome taken in, the progress box, and every dialog of these features, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    if !ctx.egui_wants_keyboard_input() && ctx.input_mut(|i| i.consume_key(egui::Modifiers::COMMAND, egui::Key::J)) {
        let ctx2 = ctx.clone();
        s.run_action("auto.aiCommand", &ctx2);
    }
    if let Some(out) = s.features.ai.job.as_ref().and_then(ask::Job::poll) {
        s.features.ai.job = None;
        take(s, out);
    }
    if let Some(j) = &s.features.ai.job {
        ctx.request_repaint_after(Duration::from_millis(50));
        let p = j.progress();
        let mut stop = false;
        egui::Window::new(j.title.clone())
            .id(egui::Id::unique("cut-ai-task"))
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_TOP, Vec2::new(0.0, 60.0))
            .show(ctx, |ui| {
                ui.add(ProgressBar::new(p.fraction as f32).desired_width(260.0));
                ui.label(progress_line(&p));
                stop = ui.button(tr("Cancel")).clicked();
            });
        if stop {
            j.cancel();
        }
    }
    notice::windows(s, ctx);
    captions_ui::windows(s, ctx);
    metadata_ui::windows(s, ctx);
    shorts_ui::windows(s, ctx);
    command_ui::windows(s, ctx);
    assistant::windows(s, ctx);
}

/// The Automation menu's Claude items and AI Assistant, after the speech items (`ui-auto.js`'s `ITEMS`).
pub fn menu_items(s: &mut Shell, ui: &mut egui::Ui) {
    for (id, label) in ACTIONS {
        if ui.add_enabled(s.action_enabled(id), egui::Button::new(tr(label))).clicked() {
            let ctx = ui.ctx().clone();
            s.run_action(id, &ctx);
            ui.close();
        }
    }
}

/// The Captions panel's Claude menu: polish or translate the shown track.
pub fn captions_menu(s: &mut Shell, ui: &mut egui::Ui) {
    ui.menu_button(tr("Claude"), |ui| {
        for (id, label) in &ACTIONS[..2] {
            if ui.button(tr(label)).clicked() {
                let ctx = ui.ctx().clone();
                s.run_action(id, &ctx);
                ui.close();
            }
        }
    })
    .response
    .on_hover_text(tr("Polish or translate the captions with Claude"));
}
