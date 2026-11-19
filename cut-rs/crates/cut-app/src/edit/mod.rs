//! The editing features of the timeline and the monitors (port of the editing parts of `ui-timeline.js`,
//! `ui-monitors.js` and `ui-markers.js`): track targeting and the source patch (`ui.editing.targets`,
//! `ui.editing.patch`), the Source monitor's clip and transport, Insert and Overwrite, the actions that use them, the
//! selected transition and gap, the sequence tabs, and the dialogs those actions open.
//!
//! The state is [`EditState`], kept on [`crate::state::App`] so the timeline panel (which gets the app) and the shell
//! (which runs the actions) see the same thing. Every change of the project is a command through `App::exec`.

pub mod actions;
pub mod dialogs;
pub mod markers;
pub mod menus;
pub mod mismatch;
pub mod source;
pub mod source_frame;

use std::collections::HashMap;

use cut_model::{Id, Sequence, TrackKind};
use cut_time::Ticks;

/// Where the source patch of one kind places source clips (`ui.editing.patch[kind]`): the first track of the kind
/// until the person picks one, a track, or none (the patch turned off).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Patch {
    #[default]
    First,
    Off,
    Track(Id),
}

/// What a video clip's keyframe line shows (`view.band`, per clip, not saved).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    Opacity,
    Remap,
}

/// An empty stretch of a track picked with a click (`gapAt`): Delete closes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gap {
    pub track: Id,
    pub a: Ticks,
    pub b: Ticks,
    pub t: Ticks,
}

/// The editing state the panels share.
#[derive(Default)]
pub struct EditState {
    /// The targeted tracks (`None`: every track).
    pub targets: Option<Vec<Id>>,
    /// The source patch: video, audio.
    pub patch: [Patch; 2],
    pub source: source::SourceMonitor,
    pub band: HashMap<Id, Band>,
    /// The transition selected on the timeline.
    pub transition: Option<Id>,
    pub gap: Option<Gap>,
    /// The sequences open as timeline tabs, in their order.
    pub tabs: Vec<Id>,
    pub dialog: Option<dialogs::EditDialog>,
    pub markers: markers::MarkersView,
    /// Actions a menu inside a panel asked for, run by the shell at the end of the frame.
    pub requests: Vec<&'static str>,
    /// The Clip Mismatch question and the sequences asked about.
    pub mismatch: mismatch::Mismatch,
}

impl EditState {
    /// A project opened, made or recovered: what pointed into the old one goes (`setSource(null)`, the tabs).
    pub fn reset(&mut self) {
        self.source.close();
        self.band.clear();
        self.transition = None;
        self.gap = None;
        self.tabs.clear();
        self.dialog = None;
        self.markers.selected = None;
    }

    /// Asks the shell to run `id` once this frame is drawn.
    pub fn request(&mut self, id: &'static str) {
        if !self.requests.contains(&id) {
            self.requests.push(id);
        }
    }
}

/// Once a frame: the actions panels asked for, the source monitor's clock, the dialog.
pub fn frame(s: &mut crate::shell::Shell, ctx: &eframe::egui::Context) {
    for id in std::mem::take(&mut s.app.edit.requests) {
        s.run_action(id, ctx);
    }
    let revision = s.app.history.revision();
    let p = s.app.history.project();
    if s.app.edit.source.tick(p, revision) {
        // the frames ahead of the source monitor's playhead are decoded before it reaches them
        if let (Some(m), Some(c)) = (&mut s.monitors, s.app.edit.source.clip) {
            let item = match c.item {
                source::SourceItem::Media(id) => crate::picture::SourceWant::Media(id),
                source::SourceItem::Sequence(id) => crate::picture::SourceWant::Sequence(id),
            };
            m.prefetch_source(p, item, c.t, s.app.edit.source.rate());
        }
        ctx.request_repaint();
    }
    source_frame::poll(s, ctx);
    dialogs::show(s, ctx);
    mismatch::show(&mut s.app, ctx);
}

/// The tracks edits apply to (`targeted`): the unlocked ones among the targets.
pub fn targeted(seq: &Sequence, targets: Option<&[Id]>) -> Vec<Id> {
    seq.tracks.iter().filter(|t| !t.locked && targets.is_none_or(|ids| ids.contains(&t.id))).map(|t| t.id).collect()
}

/// Whether a track is targeted (its header's toggle shows it).
pub fn is_target(targets: Option<&[Id]>, track: Id) -> bool {
    targets.is_none_or(|ids| ids.contains(&track))
}

/// The targets after a click on a track's toggle: every track again becomes `None`.
pub fn toggle_target(seq: &Sequence, targets: Option<&[Id]>, track: Id) -> Option<Vec<Id>> {
    let all: Vec<Id> = seq.tracks.iter().map(|t| t.id).collect();
    let mut now: Vec<Id> = targets.map_or_else(|| all.clone(), <[Id]>::to_vec);
    if let Some(i) = now.iter().position(|id| *id == track) {
        now.remove(i);
    } else {
        now.push(track);
    }
    if now.len() == all.len() && all.iter().all(|id| now.contains(id)) {
        return None;
    }
    Some(all.into_iter().filter(|id| now.contains(id)).collect())
}

/// The patch checked against a sequence (`patchFor`): a track that is gone falls back to the first of its kind.
pub fn patch_for(seq: &Sequence, patch: &[Patch; 2]) -> (Option<Id>, Option<Id>) {
    let pick = |kind: TrackKind, p: Patch| -> Option<Id> {
        let first = || seq.tracks.iter().find(|t| t.kind == kind).map(|t| t.id);
        match p {
            Patch::Off => None,
            Patch::Track(id) => seq.tracks.iter().find(|t| t.id == id && t.kind == kind).map(|t| t.id).or_else(first),
            Patch::First => first(),
        }
    };
    (pick(TrackKind::Video, patch[0]), pick(TrackKind::Audio, patch[1]))
}

/// The patch after a click on a track's source patch button: on it, or off when it was the patched track.
pub fn toggle_patch(seq: &Sequence, patch: &[Patch; 2], track: Id) -> [Patch; 2] {
    let Some(kind) = seq.kind_of(track) else { return *patch };
    let k = usize::from(kind == TrackKind::Audio);
    let now = patch_for(seq, patch);
    let on = if k == 0 { now.0 } else { now.1 } == Some(track);
    let mut out = *patch;
    out[k] = if on { Patch::Off } else { Patch::Track(track) };
    out
}

/// The empty stretch of `track` under `t` that a later clip ends (`gapAt`), or `None`.
pub fn gap_at(seq: &Sequence, track: Id, t: Ticks) -> Option<Gap> {
    let tr = seq.track(track)?;
    if tr.clips.iter().any(|c| c.start <= t && t < c.end()) {
        return None;
    }
    let next = tr.clips.iter().filter(|c| c.start > t).map(|c| c.start).min()?;
    let a = tr.clips.iter().map(|c| c.end()).filter(|e| *e <= t).max().unwrap_or(0);
    Some(Gap { track, a, b: next, t })
}
