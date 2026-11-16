//! The undo history of a project (port of commands.js's `createHistory`, docs/cut-architecture.md sections 4 and 6).
//!
//! Its behaviour is the JavaScript's: steps with labels, groups (`begin`/`commit`/`cancel`), `goTo`, `squash`,
//! `amend`, `dirty` with save marks, a step limit and change events. Underneath, a step holds the copies its commands
//! made of what they touched ([`journal`]) instead of the JavaScript's list of field writes.

pub mod journal;
pub(crate) mod scope;

use serde_json::Value as Json;

use crate::commands::{self, CommandError};
use crate::id::{Id, IdMap};
use crate::project::{LoadError, Project};
use journal::{Change, Tx};

/// Why the history changed: what a listener hears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Do,
    Undo,
    Redo,
    /// A group became a step, or steps were joined: the list changed, the project did not.
    Commit,
    Amend,
}

/// A point of the history to compare with: what `mark()` gives and `mark_saved` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    entry: u64,
    amends: u64,
}

struct Step {
    id: u64,
    label: String,
    changes: Vec<Change>,
}

struct Group {
    label: String,
    changes: Vec<Change>,
    depth: u32,
}

/// One entry of [`History::list`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Entry {
    pub label: String,
    pub done: bool,
}

type Listener = Box<dyn FnMut(Reason)>;

/// A project and the steps that can be undone and redone.
pub struct History {
    project: Project,
    undo: Vec<Step>,
    redo: Vec<Step>,
    group: Option<Group>,
    limit: usize,
    /// Stands for "nothing left to undo"; when the oldest step is dropped it becomes that step's id.
    base: u64,
    saved: u64,
    amends: u64,
    saved_amends: u64,
    next: u64,
    revision: u64,
    listeners: Vec<(u64, Listener)>,
    /// How many times validation claims each id: an edit checks only what it touched, and these counts say whether a
    /// touched id is used elsewhere too.
    ids: IdMap<Id, u32>,
    /// Also validate the whole project after every edit and stop when the verdicts differ (on in debug builds).
    verify: bool,
}

/// The id counts after a step: all of them, or what changes.
enum Counts {
    Whole(IdMap<Id, u32>),
    Delta(IdMap<Id, i64>),
}

impl History {
    /// A history of a valid project (`damaged` otherwise), keeping at most `limit` steps (the JavaScript's 1000).
    pub fn new(project: Project, limit: usize) -> Result<Self, LoadError> {
        let v = crate::validate::validate(&project);
        if !v.ok() {
            return Err(LoadError::Damaged(v.errors.iter().take(5).cloned().collect::<Vec<_>>().join("; ")));
        }
        let ids = scope::claims(&project);
        Ok(History {
            project,
            undo: Vec::new(),
            redo: Vec::new(),
            group: None,
            limit,
            base: 0,
            saved: 0,
            amends: 0,
            saved_amends: 0,
            next: 1,
            revision: 0,
            listeners: Vec::new(),
            ids,
            verify: cfg!(debug_assertions),
        })
    }

    /// Whether every edit is also checked against a validation of the whole project (a panic when they disagree):
    /// on in debug builds, where a full check per edit is the price of the proof.
    pub fn set_verify(&mut self, on: bool) {
        self.verify = on;
    }

    pub fn project(&self) -> &Project {
        &self.project
    }

    /// How many changes the project has had: caches of what it holds key on it.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty() || self.group.as_ref().is_some_and(|g| !g.changes.is_empty())
    }

    pub fn can_redo(&self) -> bool {
        self.group.is_none() && !self.redo.is_empty()
    }

    pub fn grouping(&self) -> bool {
        self.group.is_some()
    }

    fn top(&self) -> u64 {
        self.undo.last().map_or(self.base, |s| s.id)
    }

    pub fn dirty(&self) -> bool {
        self.top() != self.saved
            || self.group.as_ref().is_some_and(|g| !g.changes.is_empty())
            || self.amends != self.saved_amends
    }

    /// How many steps are done: the index in [`list`](Self::list) of the first step that can be redone.
    pub fn position(&self) -> usize {
        self.undo.len()
    }

    fn emit(&mut self, reason: Reason) {
        if reason != Reason::Commit {
            self.revision += 1;
        }
        for (_, f) in &mut self.listeners {
            f(reason);
        }
    }

    /// Hears every change; -> the id to remove the listener with.
    pub fn on_change(&mut self, f: impl FnMut(Reason) + 'static) -> u64 {
        self.next += 1;
        self.listeners.push((self.next, Box::new(f)));
        self.next
    }

    pub fn remove_listener(&mut self, id: u64) {
        self.listeners.retain(|(i, _)| *i != id);
    }

    fn new_id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    fn push(&mut self, label: String, changes: Vec<Change>) {
        let id = self.new_id();
        self.undo.push(Step { id, label, changes });
        while self.undo.len() > self.limit {
            self.base = self.undo.remove(0).id;
        }
    }

    /// Applies a command, normalizes and validates the result; nothing changes when it fails. Only what the
    /// command touched is normalized and validated (`scope`), with the verdict of a check of the whole project.
    fn run(&mut self, cmd: &Json) -> Result<(Json, Tx), CommandError> {
        let mut tx = Tx::default();
        let result = match commands::apply(&mut self.project, &mut tx, cmd) {
            Ok(r) => {
                let s = scope::scope(&tx.changes, &self.project);
                if s.full() {
                    commands::normalize(&mut self.project, &mut tx);
                } else {
                    commands::normalize_scope(&mut self.project, &mut tx, &s);
                }
                let s = scope::scope(&tx.changes, &self.project);
                let (errors, ids) = self.check(&s, &tx.changes);
                if self.verify {
                    let whole = crate::validate::validate(&self.project);
                    assert_eq!(
                        whole.ok(),
                        errors.is_empty(),
                        "the scoped check ({errors:?}) disagrees with the whole one ({:?}) after {cmd}",
                        whole.errors
                    );
                }
                if errors.is_empty() {
                    match ids {
                        Counts::Whole(ids) => self.ids = ids,
                        Counts::Delta(d) => {
                            for (id, n) in d {
                                let now = i64::from(self.ids.get(&id).copied().unwrap_or(0)) + n;
                                if now > 0 {
                                    self.ids.insert(id, now as u32);
                                } else {
                                    self.ids.remove(&id);
                                }
                            }
                        }
                    }
                    Ok(r)
                } else {
                    Err(CommandError::new(
                        "The edit would leave the project damaged.",
                        commands::Code::InvalidResult,
                        Some(errors.iter().take(5).cloned().collect::<Vec<_>>().join("; ")),
                    ))
                }
            }
            Err(e) => Err(e),
        };
        match result {
            Ok(r) => {
                if self.verify {
                    assert!(self.ids == scope::claims(&self.project), "the id counts hold after {cmd}");
                }
                tx.prune(&self.project);
                Ok((r, tx))
            }
            Err(e) => {
                tx.rollback(&mut self.project);
                Err(e)
            }
        }
    }

    /// The problems of what a step touched, and how its id counts change.
    fn check(&self, s: &scope::Scope, changes: &[Change]) -> (Vec<String>, Counts) {
        if s.full() {
            return (crate::validate::validate(&self.project).errors, Counts::Whole(scope::claims(&self.project)));
        }
        let mut errors = crate::validate::validate_scope(&self.project, s);
        let mut delta: IdMap<Id, i64> = IdMap::default();
        for id in scope::ids_before(changes) {
            *delta.entry(id).or_default() -= 1;
        }
        let after = scope::ids_now(s, &self.project);
        for id in &after {
            *delta.entry(*id).or_default() += 1;
        }
        for id in &after {
            let n = i64::from(self.ids.get(id).copied().unwrap_or(0)) + delta[id];
            if n > 1 && !id.as_str().is_empty() {
                errors.push(format!("id {id} is used twice"));
            }
        }
        (errors, Counts::Delta(delta))
    }

    /// Undoes (or redoes) recorded changes, keeping the id counts.
    fn flip(&mut self, changes: &mut [Change], back: bool) {
        journal::flip_counting(changes, &mut self.project, back, &mut self.ids);
        if self.verify {
            assert!(self.ids == scope::claims(&self.project), "the id counts hold after an undo or redo");
        }
    }

    /// Applies a command as one step (or into the open group). -> the command's result.
    pub fn apply(&mut self, cmd: &Json) -> Result<Json, CommandError> {
        let (result, tx) = self.run(cmd)?;
        if tx.is_empty() {
            return Ok(result);
        }
        self.redo.clear();
        let changes = tx.into_changes();
        match &mut self.group {
            Some(g) => g.changes.extend(changes),
            None => self.push(commands::label(cmd), changes),
        }
        self.emit(Reason::Do);
        Ok(result)
    }

    /// A change that is no edit of the person's (a background job linking the proxy it made): kept and saved, but
    /// no step; undo and redo never take it back.
    pub fn amend(&mut self, cmd: &Json) -> Result<Json, CommandError> {
        let (result, tx) = self.run(cmd)?;
        if !tx.is_empty() {
            self.amends += 1;
            self.emit(Reason::Amend);
        }
        Ok(result)
    }

    pub fn undo(&mut self) -> bool {
        if self.group.is_some() {
            self.commit_all();
        }
        let Some(mut step) = self.undo.pop() else { return false };
        self.flip(&mut step.changes, true);
        self.redo.push(step);
        self.emit(Reason::Undo);
        true
    }

    pub fn redo(&mut self) -> bool {
        if self.group.is_some() {
            self.commit_all();
        }
        let Some(mut step) = self.redo.pop() else { return false };
        self.flip(&mut step.changes, false);
        self.undo.push(step);
        self.emit(Reason::Redo);
        true
    }

    /// Groups the commands applied until [`commit`](Self::commit) into one step (a slider drag); nested pairs join
    /// the outer group.
    pub fn begin(&mut self, label: &str) {
        match &mut self.group {
            Some(g) => g.depth += 1,
            None => self.group = Some(Group { label: label.to_owned(), changes: Vec::new(), depth: 1 }),
        }
    }

    pub fn commit(&mut self) {
        let Some(g) = &mut self.group else { return };
        g.depth -= 1;
        if g.depth == 0 {
            self.commit_all();
        }
    }

    fn commit_all(&mut self) {
        let Some(g) = self.group.take() else { return };
        if !g.changes.is_empty() {
            self.push(g.label, g.changes);
            self.emit(Reason::Commit);
        }
    }

    /// Takes back everything since the outer `begin`.
    pub fn cancel(&mut self) {
        let Some(mut g) = self.group.take() else { return };
        if !g.changes.is_empty() {
            self.flip(&mut g.changes, true);
            self.emit(Reason::Undo);
        }
    }

    /// Undoes or redoes until `position` steps are done, with one event. -> whether it moved.
    pub fn go_to(&mut self, position: usize) -> bool {
        if self.group.is_some() {
            self.commit_all();
        }
        let target = position.min(self.undo.len() + self.redo.len());
        if target == self.undo.len() {
            return false;
        }
        let reason = if target < self.undo.len() { Reason::Undo } else { Reason::Redo };
        while self.undo.len() > target {
            let mut s = self.undo.pop().expect("more done than the target");
            self.flip(&mut s.changes, true);
            self.redo.push(s);
        }
        while self.undo.len() < target {
            let mut s = self.redo.pop().expect("fewer done than the target");
            self.flip(&mut s.changes, false);
            self.undo.push(s);
        }
        self.emit(reason);
        true
    }

    /// Joins the steps done after `position` into one step named `label` (an AI assistant's turn). -> whether there
    /// was a step to name.
    pub fn squash(&mut self, position: usize, label: &str) -> bool {
        if self.group.is_some() {
            self.commit_all();
        }
        let from = position.min(self.undo.len());
        if from >= self.undo.len() {
            return false;
        }
        let parts: Vec<Step> = self.undo.drain(from..).collect();
        let last = parts.last().map(|s| s.id);
        let id = self.new_id();
        let changes = parts.into_iter().flat_map(|s| s.changes).collect();
        self.undo.push(Step { id, label: label.to_owned(), changes });
        if last == Some(self.saved) {
            self.saved = id;
        }
        self.emit(Reason::Commit);
        true
    }

    /// Oldest first: the steps that can be undone, then those that can be redone, next first.
    pub fn list(&self) -> Vec<Entry> {
        let done = self.undo.iter().map(|s| Entry { label: s.label.clone(), done: true });
        let undone = self.redo.iter().rev().map(|s| Entry { label: s.label.clone(), done: false });
        done.chain(undone).collect()
    }

    /// How many steps [`list`](Self::list) has.
    pub fn steps(&self) -> usize {
        self.undo.len() + self.redo.len()
    }

    /// The step at `i` of [`list`](Self::list), without copying the others: its label and whether it is done.
    pub fn step(&self, i: usize) -> Option<(&str, bool)> {
        match i.checked_sub(self.undo.len()) {
            None => Some((self.undo[i].label.as_str(), true)),
            Some(k) => {
                let at = self.redo.len().checked_sub(k + 1)?;
                Some((self.redo[at].label.as_str(), false))
            }
        }
    }

    /// The state the project file has now, for [`mark_saved`](Self::mark_saved) once it is written. Inside a group
    /// with changes in it (a drag) it is no step, so the project stays dirty until the next save.
    pub fn mark(&mut self) -> Mark {
        let entry = if self.group.as_ref().is_some_and(|g| !g.changes.is_empty()) { self.new_id() } else { self.top() };
        Mark { entry, amends: self.amends }
    }

    pub fn mark_saved(&mut self, at: Mark) {
        self.saved = at.entry;
        self.saved_amends = at.amends;
    }

    /// The project file's text.
    pub fn serialize(&self) -> String {
        self.project.to_text()
    }

    pub fn dispose(&mut self) {
        self.listeners.clear();
        self.undo.clear();
        self.redo.clear();
        self.group = None;
    }
}
