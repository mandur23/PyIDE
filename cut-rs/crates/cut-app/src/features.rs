//! The screens of the sound, captions, text and graphics, and the preferences: their state on the shell, their
//! actions and their windows, in one place so the shell, the action table and the menus each call them once.
//!
//! Each feature module answers three questions about an action id: whether it is its own and can run now
//! ([`enabled`]), running it ([`run`]), and drawing its floating windows each frame ([`windows`]).

use eframe::egui;

use crate::shell::Shell;

/// The state of these screens, one field per feature.
#[derive(Default)]
pub struct Features {
    pub workspace: crate::workspaces::Workspaces,
    pub audio: crate::audio::AudioUi,
    pub captions: crate::captions::CaptionsUi,
    pub text: crate::text_ui::TextUi,
    pub prefs: crate::prefs::Prefs,
    pub fx: crate::fx::Fx,
    pub controls: crate::controls::Controls,
    pub export: crate::export::ExportUi,
    pub auto: crate::auto::AutoUi,
    pub view: crate::view::View,
    pub ai: crate::ai::AiUi,
    pub speakers: crate::speakers::SpeakersUi,
    pub voice: crate::voice::VoiceUi,
    pub speech: crate::speech::SpeechUi,
    pub control: crate::control::Control,
}

impl Features {
    /// The screens as the settings left them (the workspace last shown).
    pub fn new(doc: &crate::doc::Doc) -> Self {
        let mut f = Features::default();
        crate::prefs::start(doc);
        if let Some(ws) = doc.setting("workspace").and_then(crate::workspaces::Ws::from_id).filter(|w| w.ready()) {
            f.workspace.current = ws;
        }
        f.workspace.load_saved(doc.settings.get(crate::workspaces::SAVED));
        f.workspace
            .load_arranged(doc.settings.get(crate::workspaces::ARRANGED), doc.settings.get(crate::workspaces::NAMED));
        f
    }
}

/// `Some(can run now)` when `id` is one of these features' actions; `None` leaves it to the shell's own table.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    crate::controls::enabled(s, id)
        .or_else(|| crate::edit::actions::enabled(s, id))
        .or_else(|| crate::workspaces::enabled(s, id))
        .or_else(|| crate::audio::enabled(s, id))
        .or_else(|| crate::captions::enabled(s, id))
        .or_else(|| crate::text_ui::enabled(s, id))
        .or_else(|| crate::prefs::enabled(s, id))
        .or_else(|| crate::fx::actions::enabled(s, id))
        .or_else(|| crate::export::enabled(s, id))
        .or_else(|| crate::auto::enabled(s, id))
        .or_else(|| crate::panels::new_item::enabled(s, id))
        .or_else(|| crate::timeline::direct::enabled(s, id))
        .or_else(|| crate::view::enabled(s, id))
        .or_else(|| crate::ai::enabled(s, id))
        .or_else(|| crate::voice::enabled(s, id))
        .or_else(|| crate::speakers::enabled(s, id))
        .or_else(|| crate::speech::enabled(s, id))
        .or_else(|| crate::update::enabled(s, id))
}

/// Runs `id` when it is one of these features' actions -> whether it was.
pub fn run(s: &mut Shell, id: &str, ctx: &egui::Context) -> bool {
    if enabled(s, id).is_none() {
        return false;
    }
    if enabled(s, id) == Some(true) {
        let _ = crate::controls::run(s, id, ctx)
            || crate::edit::actions::run(s, id, ctx)
            || crate::fx::actions::run(s, id, ctx)
            || crate::workspaces::run(s, id, ctx)
            || crate::audio::run(s, id, ctx)
            || crate::captions::run(s, id, ctx)
            || crate::text_ui::run(s, id, ctx)
            || crate::prefs::run(s, id, ctx)
            || crate::export::run(s, id, ctx)
            || crate::auto::run(s, id, ctx)
            || crate::panels::new_item::run(s, id, ctx)
            || crate::timeline::direct::run(s, id, ctx)
            || crate::view::run(s, id, ctx)
            || crate::ai::run(s, id, ctx)
            || crate::voice::run(s, id, ctx)
            || crate::speakers::run(s, id, ctx)
            || crate::speech::run(s, id, ctx)
            || crate::update::run(s, id, ctx);
    }
    true
}

/// The features' windows and dialogs, drawn over the workspace each frame; what each took is in the shell's
/// `panel_ms` (the report and the benchmarks read it).
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    type Part = fn(&mut Shell, &egui::Context);
    let parts: [(&'static str, Part); 16] = [
        ("(layouts)", crate::workspaces::windows),
        ("(edit)", crate::edit::frame),
        ("(audio windows)", crate::audio::windows),
        ("(captions windows)", crate::captions::windows),
        ("(text windows)", crate::text_ui::windows),
        ("(preferences)", crate::prefs::windows),
        ("(export windows)", crate::export::windows),
        ("(automation)", crate::auto::windows),
        ("(new item)", crate::panels::new_item::windows),
        ("(timeline marks)", crate::timeline::direct::frame),
        ("(view windows)", crate::view::windows),
        ("(claude)", crate::ai::windows),
        ("(speakers)", crate::speakers::windows),
        ("(voice)", crate::voice::windows),
        ("(speech)", crate::speech::windows),
        ("(control)", crate::control::panel::windows),
    ];
    for (name, part) in parts {
        let t = std::time::Instant::now();
        part(s, ctx);
        s.panel_ms.insert(name, t.elapsed().as_secs_f32() * 1000.0);
    }
}
