//! Sequences that follow their first clip (`ui-project.js matchSequence`, the timeline's `matchFirst`): placing a
//! video whose size or frame rate differ from the sequence's makes an empty sequence take the clip's settings, and
//! asks once a sequence with clips ("Clip Mismatch": Change Sequence Settings, or keep them). The placement waits
//! for the answer and runs after it; with `group` the change and the placement are one undo step, as a drop on the
//! timeline is.

use std::collections::HashSet;

use cut_model::commands::build as C;
use cut_model::{Id, MediaKind};
use cut_time::{FRAME_RATES, Fps};
use eframe::egui::{self, Align2, Vec2};
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::state::App;

/// A placement to run once the question is answered.
pub type Then = Box<dyn FnOnce(&mut App)>;

/// The question on screen: the sequence, the settings it would take, the clip's settings as words, the undo step
/// the change and the placement share (`None`: two steps), and the placement.
pub struct Asked {
    pub seq: Id,
    pub patch: Json,
    pub clip: String,
    pub group: Option<String>,
    then: Then,
}

/// The sequences asked about this session (`asked`), and the question on screen.
#[derive(Default)]
pub struct Mismatch {
    asked: HashSet<Id>,
    pub open: Option<Asked>,
}

/// How a media fits the sequence.
#[derive(Debug, Clone, PartialEq)]
pub enum Fit {
    Same,
    /// The sequence is empty: it takes the clip's settings without asking.
    Take(Json),
    /// The sequence has clips: ask, with these settings and these words for them.
    Ask(Json, String),
}

/// `fpsLabel`: `30 fps`, `29.97 fps`.
pub fn fps_label(f: Fps) -> String {
    let v = f.value();
    if v.fract() == 0.0 {
        return format!("{v} fps");
    }
    let s = format!("{v:.3}");
    format!("{} fps", s.trim_end_matches('0'))
}

/// How `media` fits the open sequence.
pub fn fit(app: &App, media: Id) -> Fit {
    let (Some(seq), Some(m)) = (app.sequence(), app.project().media(media)) else { return Fit::Same };
    let Some(v) = m.video.as_ref().filter(|v| m.kind == MediaKind::Video && v.w > 0.0 && v.h > 0.0) else {
        return Fit::Same;
    };
    let probed = crate::panels::project::fps_of(m);
    let fps =
        probed.filter(|f| FRAME_RATES.contains(f)).unwrap_or_else(|| crate::panels::project::nearest_rate(probed));
    let (w, h) = (v.w, v.h);
    if seq.w as f64 == w && seq.h as f64 == h && seq.fps == fps {
        return Fit::Same;
    }
    let patch = json!({ "w": w - w % 2.0, "h": h - h % 2.0, "fps": [fps.num, fps.den] });
    if seq.clips().next().is_none() {
        return Fit::Take(patch);
    }
    Fit::Ask(patch, format!("{w}x{h} {}", fps_label(fps)))
}

fn change(app: &mut App, seq: Id, patch: &Json) {
    app.exec(&C::set_sequence(seq.as_str(), patch.clone()));
}

/// Runs a placement of `media` (`None`: nothing that sets the sequence, such as a nested sequence): now, after the
/// sequence took the clip's settings, or once the question is answered. `group` names the one undo step a timeline
/// drop makes of both.
pub fn before(app: &mut App, media: Option<Id>, group: Option<&str>, then: impl FnOnce(&mut App) + 'static) {
    let Some(seq) = app.sequence_id else { return then(app) };
    match media.map_or(Fit::Same, |m| fit(app, m)) {
        Fit::Same => then(app),
        Fit::Take(patch) => {
            if let Some(g) = group {
                app.history.begin(g);
            }
            change(app, seq, &patch);
            then(app);
            if group.is_some() {
                app.history.commit();
            }
        }
        Fit::Ask(patch, clip) => {
            if !app.edit.mismatch.asked.insert(seq) {
                return then(app);
            }
            let group = group.map(str::to_owned);
            app.edit.mismatch.open = Some(Asked { seq, patch, clip, group, then: Box::new(then) });
        }
    }
}

/// The answer: `change` the sequence's settings or keep them; the placement runs either way.
pub fn answer(app: &mut App, change_settings: bool) {
    let Some(a) = app.edit.mismatch.open.take() else { return };
    let grouped = change_settings && a.group.is_some();
    if let (true, Some(g)) = (grouped, &a.group) {
        app.history.begin(g);
    }
    if change_settings && app.project().sequence(a.seq).is_some() {
        change(app, a.seq, &a.patch);
    }
    (a.then)(app);
    if grouped {
        app.history.commit();
    }
}

/// The question, each frame (`ui.confirm`).
pub fn show(app: &mut App, ctx: &egui::Context) {
    let Some(a) = &app.edit.mismatch.open else { return };
    let text = trf(
        "This clip does not match the sequence settings ({clip}). Change the sequence to match the clip?",
        &[("clip", &a.clip)],
    );
    let mut said = None;
    egui::Window::new(tr("Clip Mismatch"))
        .id(egui::Id::unique("cutClipMismatch"))
        .collapsible(false)
        .resizable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
        .default_width(440.0)
        .show_titled(ctx, tr("Clip Mismatch"), None, |ui| {
            ui.label(text);
            ui.add_space(6.0);
            crate::panels::dialogs::actions(ui, |ui| {
                if crate::panels::dialogs::primary(ui, tr("Change Sequence Settings")).clicked() {
                    said = Some(true);
                }
                if ui.button(tr("Cancel")).clicked() {
                    said = Some(false);
                }
            });
        });
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
        said = said.or(Some(false));
    }
    if let Some(yes) = said {
        answer(app, yes);
    }
}
