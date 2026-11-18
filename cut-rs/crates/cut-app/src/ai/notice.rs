//! Before and after a Claude request (`ui-ai.js`'s `acknowledged`, `explain`, `failed` and its settings section):
//! the notice of what is sent, the explanation when Claude Code is missing, signed out or out of quota, the error
//! that says nothing was changed, and the Preferences page's Claude section.

use eframe::egui::{self, RichText};
use serde_json::Value as Json;

use super::ask::Why;
use super::claude::Code;
use crate::auto::dialog;
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// A step that waits for the notice's Continue.
pub type Pending = Box<dyn FnOnce(&mut Shell)>;

/// The notice, the explanation and the error dialog.
#[derive(Default)]
pub struct NoticeUi {
    pending: Option<Pending>,
    explain: Option<(Code, String)>,
    error: Option<(&'static str, String)>,
    /// Whether Claude Code was found, for the Preferences page (looked for on a thread once the page shows).
    installed: Option<bool>,
    looking: Option<std::sync::mpsc::Receiver<bool>>,
    /// The offer to recognise the speech first: the clips, and what runs once it is recognised.
    offer: Option<(Vec<cut_model::Id>, Pending)>,
    after: Option<Pending>,
}

impl NoticeUi {
    /// Shows the notice; `then` runs after Continue.
    pub fn ask(&mut self, then: Pending) {
        self.pending = Some(then);
    }

    /// Whether the notice is open.
    pub fn asking(&self) -> bool {
        self.pending.is_some()
    }

    /// Offers to recognise the clips' speech first; `then` runs once speech recognition has run.
    pub fn transcribe(&mut self, clips: Vec<cut_model::Id>, then: Pending) {
        self.offer = Some((clips, then));
    }

    /// What waited for the words is dropped: a setup was declined, or the recognition cancelled or failed.
    pub fn forget_after(&mut self) {
        self.after = None;
    }

    /// The explanation's code, when one is open.
    pub fn explaining(&self) -> Option<Code> {
        self.explain.as_ref().map(|e| e.0)
    }

    /// The error dialog's code and text, when one is open.
    pub fn error(&self) -> Option<(&'static str, &str)> {
        self.error.as_ref().map(|(c, t)| (*c, t.as_str()))
    }
}

/// Whether the person has acknowledged what is sent (`cut.ai.acknowledged`).
pub fn acknowledged(s: &Shell) -> bool {
    s.doc.settings.get("ai.acknowledged").and_then(Json::as_bool) == Some(true)
}

/// `explain`: why Claude cannot answer, in plain words.
pub fn explain(s: &mut Shell, code: Code, detail: &str) {
    s.features.ai.notice.explain = Some((code, detail.to_owned()));
}

/// `failed`: a job's failure: the explanation for a missing, signed-out or limited Claude Code, else the error.
pub fn failed(s: &mut Shell, why: &Why) {
    match why {
        Why::Claude(f) if matches!(f.code, Code::NotInstalled | Code::Auth | Code::Quota) => {
            explain(s, f.code, if f.code == Code::Quota { &f.error } else { "" });
        }
        Why::Claude(f) if f.code == Code::Timeout => {
            let text = tr("Claude did not answer in time. Try again, or ask for less at once.").into_owned();
            s.features.ai.notice.error = Some((why.code(), text));
        }
        Why::Claude(f) => {
            let text = trf("Claude Code failed: {error}", &[("error", &f.error)]);
            s.features.ai.notice.error = Some((why.code(), text));
        }
        Why::Invalid(e) => {
            let text = trf("Claude's answer could not be used, even when asked again: {error}", &[("error", e)]);
            s.features.ai.notice.error = Some((why.code(), text));
        }
    }
}

fn note(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.label(RichText::new(text).color(s.palette.gray[8]).size(12.0));
}

/// Transcribe pressed: speech recognition's setup dialogs when a model is missing (`sp.ensureReady`), then the clips
/// recognised under its progress box, then what waited for it.
pub fn transcribe_go(s: &mut Shell) {
    let Some((clips, then)) = s.features.ai.notice.offer.take() else { return };
    s.features.ai.notice.after = Some(then);
    crate::speech::dialogs::ensure_ready(s, None, crate::speech::Goal::Claude { ids: clips });
}

/// What waited for speech recognition, once it has run (`crate::speech::Goal::Claude`).
pub fn resume(s: &mut Shell) {
    if let Some(then) = s.features.ai.notice.after.take() {
        then(s);
    }
}

/// The notice, the explanation and the error, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    if s.features.ai.notice.offer.is_some() {
        let (mut go, mut cancel) = (false, false);
        dialog("Claude", "cutAiTranscribe", 460.0).show(ctx, |ui| {
            ui.label(tr("This needs the words of the sequence. Recognize its speech on this PC first?"));
            ui.horizontal(|ui| {
                go = ui.button(tr("Transcribe")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        if go {
            transcribe_go(s);
        } else if cancel {
            s.features.ai.notice.offer = None;
        }
    }
    if s.features.ai.notice.pending.is_some() {
        let (mut go, mut cancel) = (false, false);
        dialog("Claude", "cutAiNotice", 480.0).show(ctx, |ui| {
            ui.label(tr("These features send text to Claude (Anthropic) through Claude Code on this PC: the transcript or the caption text, and clip, track and marker names with their times."));
            note(ui, s, &tr("No video, sound or file paths are sent. Claude Code uses your own Claude account."));
            ui.horizontal(|ui| {
                go = ui.button(tr("Continue")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        if go {
            s.doc.settings.set("ai.acknowledged", Json::Bool(true));
            let _ = s.doc.settings.save();
            if let Some(then) = s.features.ai.notice.pending.take() {
                then(s);
            }
        } else if cancel {
            s.features.ai.notice.pending = None;
        }
    }
    if let Some((code, detail)) = s.features.ai.notice.explain.clone() {
        let mut close = false;
        dialog("Claude Code", "cutAiMissing", 500.0).show(ctx, |ui| {
            match code {
                Code::Auth => {
                    ui.label(tr("Claude Code is not signed in, or its sign-in has expired."));
                    note(ui, s, &tr("Open a terminal (Windows Terminal or PowerShell), run claude, and sign in with your Claude account (type /login if it does not ask). Then try again."));
                }
                Code::Quota => {
                    ui.label(tr("Your Claude account has reached its usage limit for now."));
                    note(ui, s, &tr("The limit resets after a while (Claude Code says when). Try again later, or choose a smaller model in the settings."));
                }
                _ => {
                    ui.label(tr("Claude Code is not installed on this PC."));
                    note(ui, s, &tr("These features use Claude Code, the command-line Claude app, signed in with your Claude account (Pro or Max, or an Anthropic Console account). Install it from claude.com/claude-code, run claude once in a terminal and sign in, then try again."));
                    note(ui, s, &tr("Speech recognition and the other automation work without it."));
                }
            }
            if !detail.is_empty() {
                note(ui, s, &detail);
            }
            close = ui.button(tr("Close")).clicked();
        });
        if close {
            s.features.ai.notice.explain = None;
        }
    }
    if let Some((_, text)) = s.features.ai.notice.error.clone() {
        let mut close = false;
        dialog("Claude", "cutAiError", 500.0).show(ctx, |ui| {
            ui.label(&text);
            note(ui, s, &tr("Nothing was changed."));
            close = ui.button(tr("Close")).clicked();
        });
        if close {
            s.features.ai.notice.error = None;
        }
    }
}

/// The Preferences page's Claude rows (`settingsSection`, two columns of the page's grid): the model, the notice,
/// whether Claude Code is there.
pub fn settings_section(s: &mut Shell, ui: &mut egui::Ui) {
    let models = [
        ("haiku", "Claude Haiku (fastest)"),
        ("sonnet", "Claude Sonnet"),
        ("opus", "Claude Opus (most capable, slowest)"),
    ];
    let now = super::model(s);
    ui.label(tr("Model:"));
    let shown = models.iter().find(|m| m.0 == now).map_or(now.clone(), |m| tr(m.1).into_owned());
    egui::ComboBox::from_id_salt("cut-ai-model").icon(crate::theme::combo_icon).selected_text(shown).show_ui(
        ui,
        |ui| {
            for (id, label) in models {
                if ui.selectable_label(now == id, tr(label)).clicked() {
                    crate::prefs::set(s, "ai.model", Json::from(id));
                }
            }
        },
    );
    ui.end_row();
    ui.label("");
    let mut ack = acknowledged(s);
    if ui
        .checkbox(&mut ack, tr("I know these features send text to Claude (Anthropic); do not show the notice"))
        .changed()
    {
        crate::prefs::set(s, "ai.acknowledged", Json::Bool(ack));
    }
    ui.end_row();
    ui.label("");
    let n = &mut s.features.ai.notice;
    if n.installed.is_none() && n.looking.is_none() {
        let (tx, rx) = std::sync::mpsc::channel();
        let runner = s.features.ai.runner.clone();
        std::thread::spawn(move || {
            let _ = tx.send(runner.installed());
        });
        n.looking = Some(rx);
    }
    if let Some(found) = n.looking.as_ref().and_then(|r| r.try_recv().ok()) {
        n.installed = Some(found);
        n.looking = None;
    }
    let state = match n.installed {
        None => {
            ui.ctx().request_repaint_after(std::time::Duration::from_millis(100));
            "Looking for Claude Code…"
        }
        Some(true) => "Claude Code is installed.",
        Some(false) => "Claude Code is not installed: install it from claude.com/claude-code and sign in.",
    };
    ui.vertical(|ui| {
        ui.set_max_width(560.0);
        note(ui, s, &tr(state));
        note(ui, s, &tr("Caption polish and translation, YouTube titles and chapters, highlights to shorts and edit commands send the transcript or caption text and clip and marker names to Claude through Claude Code. No video, sound or file paths are sent."));
    });
    ui.end_row();
}
