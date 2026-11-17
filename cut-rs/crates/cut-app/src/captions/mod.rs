//! Captions (`ui-captions.js`, and the caption rows of `ui-timeline.js`): the Captions panel ([`panel`]) lists the
//! shown caption track's items as start, end and text edited in place; SRT and WebVTT files come in and SubRip goes
//! out ([`files`], through `cut_model::srt`, the encoding detected: UTF-8, UTF-16, CP949); the track's style is set in
//! a dialog ([`style`]); the timeline's caption rows move, trim, select and delete captions ([`track`]).
//!
//! The shown track (the panel's choice, else the sequence's first) is also the one the Program monitor draws and
//! export burns in. Every change is a command through the history. The Transcript tab is speech recognition's
//! (`crate::speech::panel`).

pub mod files;
pub mod panel;
pub mod style;
pub mod track;

use std::collections::HashMap;

use cut_model::{CaptionTrack, Id};
use eframe::egui;

use crate::shell::Shell;
use crate::state::{App, Panel};

/// The state of these screens.
#[derive(Default)]
pub struct CaptionsUi {
    /// The caption track the panel shows, for the sequence it was chosen in (`chosenTrack`).
    chosen: Option<(Id, Id)>,
    /// The fields being typed in, by caption id: what each holds until it is committed.
    pub fields: HashMap<(Id, panel::Field), String>,
    /// A caption added at the playhead whose text field takes the keyboard on the next frame.
    pub focus_new: Option<Id>,
    pub style: Option<style::StyleForm>,
    pub files: files::Asking,
}

/// The caption track shown (`trackOf`): the one chosen in this sequence, else its first.
pub fn track_of<'a>(app: &'a App, ui: &CaptionsUi) -> Option<&'a CaptionTrack> {
    let seq = app.sequence()?;
    let chosen = ui.chosen.filter(|(s, _)| *s == seq.id).map(|(_, t)| t);
    chosen.and_then(|id| seq.captions.iter().find(|c| c.id == id)).or_else(|| seq.captions.first())
}

/// The id of the caption track the Program monitor draws and export burns in.
pub fn shown(s: &Shell) -> Option<Id> {
    track_of(&s.app, &s.features.captions).map(|c| c.id)
}

/// Shows the caption track `id` in the panel, the monitor and export (`choose`).
pub fn choose(s: &mut Shell, id: Id) {
    if let Some(seq) = s.app.sequence_id {
        s.features.captions.chosen = Some((seq, id));
    }
}

fn has_captions(s: &Shell) -> bool {
    s.app.sequence().is_some_and(|q| !q.captions.is_empty())
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "captions.import" | "window.captions" => Some(true),
        "captions.export" | "captions.style" => Some(has_captions(s)),
        "delete" | "rippleDelete" if s.app.focus == Some(Panel::Timeline) && s.timeline.captions.selected.is_some() => {
            Some(true)
        }
        _ => None,
    }
}

/// Runs one of this feature's actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    match id {
        "captions.import" => files::ask_import(s),
        "captions.export" => files::ask_export(s),
        "captions.style" => style::open(s),
        // only when it is this feature's Delete (another panel's may be asked first in the chain)
        "delete" | "rippleDelete" if enabled(s, id).is_some() => {
            track::delete_selected(&mut s.app, &mut s.timeline.captions)
        }
        _ => return false,
    }
    true
}

/// This feature's windows, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    files::poll(s, ctx);
    style::window(s, ctx);
}
