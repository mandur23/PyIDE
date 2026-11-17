//! The editor's shared state (port of `state.js`'s `Cut.app`): the open project and its history, the active
//! sequence, the playhead, the selection, the tool, the In/Out points and the panel that has the keyboard.
//!
//! The JavaScript emits an event from every setter because its DOM panels redraw only when told. egui redraws every
//! panel from this state each frame, so the events become plain method calls and the one thing a listener needed,
//! "did the project change?", is [`History::revision`]: the shell compares it frame to frame for autosave and the
//! title, and the timeline for its per-track clip index. Panels never change the project themselves: every edit goes
//! through [`App::exec`], which runs a command object on the history.

use std::collections::HashSet;
use std::path::PathBuf;
use std::rc::Rc;

use cut_model::{History, Id, Project, Sequence};
use cut_time::Ticks;
use serde_json::Value as Json;

use crate::i18n::tr;

/// The timeline tools, by the JavaScript's names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    Select,
    TrackForward,
    TrackBackward,
    Ripple,
    Roll,
    Rate,
    Razor,
    Slip,
    Slide,
    Pen,
    Hand,
    Zoom,
    Text,
}

impl Tool {
    /// Every tool in the Tools panel's order.
    pub const ALL: [Tool; 13] = [
        Tool::Select,
        Tool::TrackForward,
        Tool::TrackBackward,
        Tool::Ripple,
        Tool::Roll,
        Tool::Rate,
        Tool::Razor,
        Tool::Slip,
        Tool::Slide,
        Tool::Pen,
        Tool::Hand,
        Tool::Zoom,
        Tool::Text,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Tool::Select => "select",
            Tool::TrackForward => "trackForward",
            Tool::TrackBackward => "trackBackward",
            Tool::Ripple => "ripple",
            Tool::Roll => "roll",
            Tool::Rate => "rate",
            Tool::Razor => "razor",
            Tool::Slip => "slip",
            Tool::Slide => "slide",
            Tool::Pen => "pen",
            Tool::Hand => "hand",
            Tool::Zoom => "zoom",
            Tool::Text => "text",
        }
    }

    pub fn from_id(id: &str) -> Option<Tool> {
        Tool::ALL.into_iter().find(|t| t.id() == id)
    }

    /// The English title (the key of its translation).
    pub fn title(self) -> &'static str {
        match self {
            Tool::Select => "Selection Tool",
            Tool::TrackForward => "Track Select Forward Tool",
            Tool::TrackBackward => "Track Select Backward Tool",
            Tool::Ripple => "Ripple Edit Tool",
            Tool::Roll => "Rolling Edit Tool",
            Tool::Rate => "Rate Stretch Tool",
            Tool::Razor => "Razor Tool",
            Tool::Slip => "Slip Tool",
            Tool::Slide => "Slide Tool",
            Tool::Pen => "Pen Tool",
            Tool::Hand => "Hand Tool",
            Tool::Zoom => "Zoom Tool",
            Tool::Text => "Type Tool",
        }
    }
}

/// The panels that can have the keyboard (`app.focusPanel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Panel {
    Project,
    Source,
    Program,
    Timeline,
    Controls,
    Effects,
    Markers,
    History,
    Tools,
    Transcript,
}

/// The sequence In/Out points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InOut {
    pub in_: Option<Ticks>,
    pub out: Option<Ticks>,
}

/// Media dragged from the Project panel (the JavaScript's `media` drag payload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaDrag(pub Vec<Id>);

/// A message for the person: a short toast, or an error that stays until dismissed.
#[derive(Debug, Clone, PartialEq)]
pub struct Notice {
    pub text: String,
    pub error: bool,
}

/// The editor's state.
pub struct App {
    pub history: History,
    /// The `.ncut` file, or `None` while untitled.
    pub path: Option<PathBuf>,
    pub sequence_id: Option<Id>,
    /// The playhead.
    pub t: Ticks,
    pub selection: HashSet<Id>,
    pub tool: Tool,
    pub in_out: InOut,
    pub focus: Option<Panel>,
    /// Snap in Timeline (S).
    pub snapping: bool,
    /// Linked Selection: a click selects what the clip links to.
    pub linked_selection: bool,
    /// Copied clips, as the paste command takes them.
    pub clipboard: Vec<Json>,
    pub notices: Vec<Notice>,
    /// Targets, source patch, the source monitor's clip, the selected transition and gap, timeline tabs.
    pub edit: crate::edit::EditState,
    /// The open sequence as a shared copy, made once a revision ([`App::shared_sequence`]).
    shared: std::cell::RefCell<Option<(u64, Id, Rc<Sequence>)>>,
    /// Where each media item is in the project's list, made once a revision ([`App::media`]).
    media_at: std::cell::RefCell<Option<(u64, std::collections::HashMap<Id, usize>)>>,
}

impl App {
    /// The state of a history just opened or made (`setHistory`).
    pub fn new(history: History, path: Option<PathBuf>) -> App {
        let sequence_id = history.project().sequences.first().map(|s| s.id);
        App {
            history,
            path,
            sequence_id,
            t: 0,
            selection: HashSet::new(),
            tool: Tool::Select,
            in_out: InOut::default(),
            focus: Some(Panel::Timeline),
            snapping: true,
            linked_selection: true,
            clipboard: Vec::new(),
            notices: Vec::new(),
            edit: crate::edit::EditState::default(),
            shared: Default::default(),
            media_at: Default::default(),
        }
    }

    /// Replaces the history (open, new, recover): selection, sequence, playhead and In/Out start over.
    pub fn set_history(&mut self, history: History, path: Option<PathBuf>) {
        self.history.dispose();
        // another history counts its revisions from the start again
        self.shared.take();
        self.media_at.take();
        self.sequence_id = history.project().sequences.first().map(|s| s.id);
        self.history = history;
        self.path = path;
        self.selection.clear();
        self.t = 0;
        self.in_out = InOut::default();
        self.edit.reset();
    }

    pub fn project(&self) -> &Project {
        self.history.project()
    }

    pub fn sequence(&self) -> Option<&Sequence> {
        self.project().sequence(self.sequence_id?)
    }

    /// The media item `id`, found through an index made once a revision (the project's own lookup reads its whole
    /// list, which the timeline would do for every clip it draws).
    pub fn media(&self, id: Id) -> Option<&cut_model::Media> {
        let p = self.project();
        let rev = self.history.revision();
        let mut at = self.media_at.borrow_mut();
        if at.as_ref().is_none_or(|(r, _)| *r != rev) {
            *at = Some((rev, p.media.iter().enumerate().map(|(i, m)| (m.id, i)).collect()));
        }
        let i = *at.as_ref()?.1.get(&id)?;
        p.media.get(i).filter(|m| m.id == id)
    }

    /// The open sequence as a copy the panels can hold while they change the app: one copy a revision, shared by
    /// everything that draws it.
    pub fn shared_sequence(&self) -> Option<Rc<Sequence>> {
        let seq = self.sequence()?;
        let key = (self.history.revision(), seq.id);
        let mut shared = self.shared.borrow_mut();
        match &*shared {
            Some((r, id, q)) if (*r, *id) == key => Some(q.clone()),
            _ => {
                let q = Rc::new(seq.clone());
                *shared = Some((key.0, key.1, q.clone()));
                Some(q)
            }
        }
    }

    pub fn set_sequence(&mut self, id: Id) {
        if Some(id) == self.sequence_id {
            return;
        }
        self.sequence_id = Some(id);
        self.selection.clear();
        self.in_out = InOut::default();
    }

    /// Moves the playhead (never before 0).
    pub fn set_time(&mut self, t: Ticks) {
        self.t = t.max(0);
    }

    /// Selects `ids` (`add`: keeps the others; `toggle`: an id already selected goes).
    pub fn select(&mut self, ids: impl IntoIterator<Item = Id>, add: bool, toggle: bool) {
        if !add && !toggle {
            self.selection.clear();
        }
        for id in ids {
            if toggle && self.selection.contains(&id) {
                self.selection.remove(&id);
            } else {
                self.selection.insert(id);
            }
        }
    }

    pub fn set_in_out(&mut self, in_: Option<Option<Ticks>>, out: Option<Option<Ticks>>) {
        if let Some(v) = in_ {
            self.in_out.in_ = v;
        }
        if let Some(v) = out {
            self.in_out.out = v;
        }
    }

    pub fn toast(&mut self, text: impl Into<String>) {
        self.notices.push(Notice { text: text.into(), error: false });
    }

    pub fn report(&mut self, text: impl Into<String>) {
        self.notices.push(Notice { text: text.into(), error: true });
    }

    /// Runs a command as one undo step (`ui.exec`): its result, or `None` after telling the person why it was refused.
    pub fn exec(&mut self, cmd: &Json) -> Option<Json> {
        match self.history.apply(cmd) {
            Ok(r) => {
                self.prune_selection();
                Some(r)
            }
            Err(e) => {
                self.report(tr(&e.message).into_owned());
                None
            }
        }
    }

    pub fn undo(&mut self) -> bool {
        let done = self.history.undo();
        self.prune_selection();
        done
    }

    pub fn redo(&mut self) -> bool {
        let done = self.history.redo();
        self.prune_selection();
        done
    }

    /// Drops selected clips that are no longer in the sequence (an undo took them away).
    pub fn prune_selection(&mut self) {
        if self.sequence().is_none() {
            self.sequence_id = self.project().sequences.first().map(|s| s.id);
        }
        let Some(seq) = self.sequence() else {
            self.selection.clear();
            return;
        };
        let keep: HashSet<Id> = self.selection.iter().copied().filter(|id| seq.clip(*id).is_some()).collect();
        self.selection = keep;
    }

    /// The selection in the sequence's clip order (commands take lists).
    pub fn selected(&self) -> Vec<Id> {
        self.selected_clips().iter().map(|c| c.id).collect()
    }

    /// The selected clips in the sequence's clip order, found one by one (a selection is small, a sequence need not
    /// be: this runs every frame).
    pub fn selected_clips(&self) -> Vec<&cut_model::Clip> {
        let Some(seq) = self.sequence() else { return Vec::new() };
        let mut picked: Vec<(usize, &cut_model::Clip)> =
            self.selection.iter().filter_map(|id| Some((seq.order_of(*id)?, seq.clip(*id)?))).collect();
        picked.sort_unstable_by_key(|p| p.0);
        picked.into_iter().map(|p| p.1).collect()
    }
}
