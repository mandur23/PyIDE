//! The Audio workspace's screens (`ui-mixer.js`, `ui-audiofx.js`, `ui-meters.js`): the Audio Track Mixer
//! ([`mixer`]), Essential Sound ([`essential`]), the loudness matches ([`loudness`], the JavaScript's normalise) and
//! the level meters ([`meters`]) the Audio Meters panel and the mixer's strips share.
//!
//! Threads: everything here draws and edits on the UI thread; the levels are read from the playback's note of the
//! block being heard (see [`meters`]); a loudness match measures on a thread of its own.

pub mod essential;
pub mod loudness;
pub mod meters;
pub mod mixer;
pub mod response;

use eframe::egui;

use crate::i18n::tr;
use crate::shell::Shell;

/// The state of these screens.
#[derive(Default)]
pub struct AudioUi {
    pub mixer: mixer::MixerView,
    /// The Audio Meters panel's meter (one for every workspace that shows it).
    pub meters: meters::Ballistics,
    pub loudness: loudness::LoudnessUi,
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "window.mixer" | "window.essential" | "window.meters" => Some(true),
        "auto.loudness" => Some(s.app.sequence().is_some()),
        "auto.clipLoudness" => Some(!essential::sound_clips(&s.app, false).is_empty()),
        _ => None,
    }
}

/// Runs one of this feature's actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    match id {
        "auto.loudness" => {
            loudness::open_sequence(s);
            true
        }
        "auto.clipLoudness" => {
            loudness::open_clips(s);
            true
        }
        _ => false,
    }
}

/// This feature's windows, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let down = ctx.input(|i| i.pointer.primary_down());
    s.features.audio.mixer.settle(&mut s.app, down);
    mixer::typing_window(s, ctx);
    loudness::windows(s, ctx);
}

/// The top bar's Automation menu (`ui-auto.js`'s `ITEMS`): Remove Silence, the loudness matches, Auto Ducking and
/// Auto Color and scene and beat detection run ([`crate::auto`]); speech recognition ([`crate::speech`]), speaker
/// labels ([`crate::speakers`]) and voice isolation ([`crate::voice`]).
pub fn automation_menu(s: &mut Shell, ui: &mut egui::Ui) {
    let run = |s: &mut Shell, ui: &mut egui::Ui, id: &str, label: &str| {
        if ui.add_enabled(s.action_enabled(id), egui::Button::new(tr(label))).clicked() {
            let ctx = ui.ctx().clone();
            s.run_action(id, &ctx);
            ui.close();
        }
    };
    ui.menu_button(tr("Automation"), |ui| {
        run(s, ui, "auto.silence", "Remove Silence…");
        run(s, ui, "auto.scenes", "Detect Scene Changes…");
        run(s, ui, "auto.beats", "Detect Beats…");
        ui.separator();
        run(s, ui, "auto.captions", "Auto Captions…");
        run(s, ui, "auto.fillers", "Remove Filler Words…");
        run(s, ui, "auto.speakers", "Label Speakers");
        run(s, ui, "auto.nextUncertain", "Next Uncertain Word");
        run(s, ui, "auto.prevUncertain", "Previous Uncertain Word");
        ui.separator();
        crate::ai::menu_items(s, ui);
        ui.separator();
        for (id, label) in [
            ("auto.loudness", "Match Loudness…"),
            ("auto.clipLoudness", "Match Clip Loudness…"),
            ("auto.duck", "Auto Ducking…"),
        ] {
            run(s, ui, id, label);
        }
        run(s, ui, "auto.isolateVoice", "Isolate Voice");
        ui.separator();
        run(s, ui, "auto.color", "Auto Color");
    });
}

/// The Audio Meters panel: the master's level as heard now.
pub fn meters_panel(s: &mut Shell, ui: &mut egui::Ui) {
    let playing = s.transport.playing();
    let heard = if playing { s.transport.meters().map(|m| meters::master(&m)) } else { None };
    let pal = s.palette.clone();
    meters::panel(ui, &pal, &mut s.features.audio.meters, playing, heard);
}
