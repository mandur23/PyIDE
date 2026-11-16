//! What each keyboard and menu action does (port of `ui-keys.js`'s default handlers and the panels' own ones), and
//! whether it exists yet: an action the native app does not have yet stays in the menus, disabled, so the gaps show.

use cut_model::{Id, TrackKind};
use cut_time::{Ticks, frame_start, snap};
use eframe::egui;
use serde_json::{Value as Json, json};

use crate::cmd;
use crate::i18n::{tr, trf};
use crate::shell::{Ask, Dialog, LowerTab, Shell, Then};
use crate::state::{Panel, Tool};
use crate::timeline::layout::{TRACK_EXPANDED, TRACK_MAX, TRACK_MIN, TRACK_STEP};
use crate::transport::shuttle;

/// The actions the native app has; every other action in [`crate::keys::ACTIONS`] is shown disabled.
pub const DONE: &[&str] = &[
    "playPause",
    "shuttleBack",
    "shuttleStop",
    "shuttleForward",
    "frameBack",
    "frameForward",
    "frameBack5",
    "frameForward5",
    "prevEdit",
    "nextEdit",
    "prevEditAny",
    "nextEditAny",
    "goStart",
    "goEnd",
    "goIn",
    "goOut",
    "markIn",
    "markOut",
    "markClip",
    "markSelection",
    "clearIn",
    "clearOut",
    "clearInOut",
    "addMarker",
    "nextMarker",
    "prevMarker",
    "clearMarker",
    "clearAllMarkers",
    "splitAll",
    "rippleDelete",
    "delete",
    "toggleEnabled",
    "link",
    "group",
    "ungroup",
    "nudgeLeft",
    "nudgeRight",
    "nudgeLeft5",
    "nudgeRight5",
    "nudgeUp",
    "nudgeDown",
    "cut",
    "copy",
    "paste",
    "pasteInsert",
    "selectAll",
    "deselect",
    "tool.select",
    "tool.trackForward",
    "tool.trackBackward",
    "tool.ripple",
    "tool.roll",
    "tool.razor",
    "tool.hand",
    "tool.zoom",
    "snap",
    "zoomIn",
    "zoomOut",
    "zoomFit",
    "videoTracksTaller",
    "videoTracksShorter",
    "audioTracksTaller",
    "audioTracksShorter",
    "expandTracks",
    "minimizeTracks",
    "undo",
    "redo",
    "save",
    "saveAs",
    "saveCopy",
    "restoreAutosave",
    "open",
    "newProject",
    "newSequence",
    "newBin",
    "import",
    "selectUnused",
    "window.project",
    "window.source",
    "window.timeline",
    "window.program",
];

impl Shell {
    fn frame_ticks(&self) -> Ticks {
        self.app.sequence().map_or(1, |s| frame_start(1, s.fps).max(1))
    }

    fn selected_clips(&self) -> Vec<cut_model::Clip> {
        self.app.selected_clips().into_iter().cloned().collect()
    }

    /// Whether `id` can run now (menus grey out what cannot).
    pub fn action_enabled(&self, id: &str) -> bool {
        if let Some(on) = crate::features::enabled(self, id) {
            return on;
        }
        if !DONE.contains(&id) {
            return false;
        }
        let some = !self.app.selection.is_empty();
        let seq = self.app.sequence();
        let io = self.app.in_out;
        match id {
            "undo" => self.app.history.can_undo(),
            "redo" => self.app.history.can_redo(),
            "cut" | "copy" | "delete" | "rippleDelete" | "toggleEnabled" | "link" | "ungroup" | "nudgeUp"
            | "nudgeDown" | "markSelection" => some,
            "group" => self.app.selection.len() >= 2,
            "deselect" => some,
            "paste" | "pasteInsert" => !self.app.clipboard.is_empty(),
            "goIn" | "clearIn" => io.in_.is_some(),
            "goOut" | "clearOut" => io.out.is_some(),
            "clearInOut" => io.in_.is_some() || io.out.is_some(),
            "nextMarker" => seq.is_some_and(|s| s.markers.iter().any(|m| m.t > self.app.t)),
            "prevMarker" => seq.is_some_and(|s| s.markers.iter().any(|m| m.t < self.app.t)),
            "clearMarker" => seq.is_some_and(|s| s.markers.iter().any(|m| m.t == self.app.t)),
            "clearAllMarkers" => seq.is_some_and(|s| !s.markers.is_empty()),
            _ => true,
        }
    }

    /// Runs an action (`Cut.ui.runAction`).
    pub fn run_action(&mut self, id: &str, ctx: &egui::Context) {
        if crate::features::run(self, id, ctx) {
            return;
        }
        if !DONE.contains(&id) {
            return;
        }
        if let Some(tool) = id.strip_prefix("tool.").and_then(Tool::from_id) {
            self.app.tool = tool;
            return;
        }
        let f = self.frame_ticks();
        let t = self.app.t;
        match id {
            "undo" => {
                if !self.app.undo() {
                    self.app.toast(tr("Nothing to undo"));
                }
            }
            "redo" => {
                if !self.app.redo() {
                    self.app.toast(tr("Nothing to redo"));
                }
            }
            "save" => self.save(Then::Nothing, ctx),
            "saveAs" => self.ask(Ask::SaveAs(Then::Nothing)),
            "saveCopy" => self.ask(Ask::SaveCopy),
            "open" => self.guard(Then::Open(None), ctx),
            "newProject" => self.guard(Then::NewProject, ctx),
            "import" => self.ask(Ask::Import),
            "restoreAutosave" => {
                self.doc.flush();
                let list = self.doc.projects.autosaves_of(&self.doc.key);
                if list.is_empty() {
                    self.app.toast(trf("There are no autosaves of {name}.", &[("name", &self.doc.name(&self.app))]));
                } else {
                    self.dialog = Some(Dialog::Autosaves(list));
                }
            }
            "newSequence" => {
                let n = self.app.project().sequences.len() + 1;
                self.dialog =
                    Some(Dialog::NewSequence { name: trf("Sequence {n}", &[("n", &n.to_string())]), preset: 0 });
            }
            "newBin" => {
                let bin = self.project.current_bin();
                if let Some(r) = self.app.exec(&cmd::add_bin(&tr("Bin"), bin))
                    && let Some(id) = r.get("id").and_then(Json::as_str)
                {
                    self.project.start_rename(Id::new(id), &tr("Bin"));
                    self.app.toast(tr("Bin added"));
                }
            }
            "selectUnused" => self.project.select_unused(&self.app),
            "window.project" => {
                self.lower_tab = LowerTab::Project;
                self.focus(Panel::Project);
            }
            "window.source" => self.focus(Panel::Source),
            "window.timeline" => self.focus(Panel::Timeline),
            "window.program" => self.focus(Panel::Program),
            "playPause" => {
                if self.transport.playing() {
                    self.transport.pause();
                } else {
                    // at the last frame or after it, play starts over (player.js `play`)
                    let end = self.app.sequence().map_or(0, |s| s.duration());
                    let from = if t >= end - f { 0 } else { t };
                    self.app.set_time(from);
                    self.transport.play(from, 1.0);
                }
            }
            "shuttleForward" | "shuttleBack" => {
                let rate = shuttle(self.transport.rate(), id == "shuttleForward");
                self.features.view.stop_at = None;
                self.transport.play(t, rate);
            }
            "shuttleStop" => self.transport.pause(),
            "frameBack" => self.step(-f),
            "frameForward" => self.step(f),
            "frameBack5" => self.step(-5 * f),
            "frameForward5" => self.step(5 * f),
            "goStart" => self.app.set_time(0),
            "goEnd" => {
                let end = self.app.sequence().map_or(0, |s| s.duration());
                self.app.set_time(end);
            }
            "prevEdit" | "prevEditAny" | "nextEdit" | "nextEditAny" => {
                let pts = self.timeline.edit_points(&self.app);
                let next = if id.starts_with("next") {
                    pts.into_iter().find(|p| *p > t)
                } else {
                    pts.into_iter().rev().find(|p| *p < t)
                };
                if let Some(p) = next {
                    self.app.set_time(p);
                }
            }
            "goIn" => {
                if let Some(i) = self.app.in_out.in_ {
                    self.app.set_time(i);
                }
            }
            "goOut" => {
                if let Some(o) = self.app.in_out.out {
                    self.app.set_time(o);
                }
            }
            "markIn" => self.app.set_in_out(Some(Some(t)), None),
            "markOut" => self.app.set_in_out(None, Some(Some(t))),
            "markClip" | "markSelection" => {
                let clips = if id == "markClip" && self.app.selection.is_empty() {
                    self.app
                        .sequence()
                        .map_or_else(Vec::new, |s| s.clips().filter(|c| c.start <= t && t < c.end()).cloned().collect())
                } else {
                    self.selected_clips()
                };
                match (clips.iter().map(|c| c.start).min(), clips.iter().map(|c| c.end()).max()) {
                    (Some(a), Some(b)) => self.app.set_in_out(Some(Some(a)), Some(Some(b))),
                    _ => self.app.toast(tr("Select a clip first.")),
                }
            }
            "clearIn" => self.app.set_in_out(Some(None), None),
            "clearOut" => self.app.set_in_out(None, Some(None)),
            "clearInOut" => self.app.set_in_out(Some(None), Some(None)),
            "selectAll" => {
                let ids: Vec<Id> = self.app.sequence().map_or_else(Vec::new, |s| s.clips().map(|c| c.id).collect());
                self.app.select(ids, false, false);
            }
            "deselect" => self.app.selection.clear(),
            "snap" => {
                self.app.snapping = !self.app.snapping;
                self.app.toast(if self.app.snapping { tr("Snapping on") } else { tr("Snapping off") });
            }
            "zoomIn" => self.timeline.zoom_by(&self.app, 1.6),
            "zoomOut" => self.timeline.zoom_by(&self.app, 1.0 / 1.6),
            "zoomFit" => self.timeline.zoom_fit(&self.app),
            "videoTracksTaller" => self.heights(Some(TrackKind::Video), |h| h + TRACK_STEP),
            "videoTracksShorter" => self.heights(Some(TrackKind::Video), |h| h - TRACK_STEP),
            "audioTracksTaller" => self.heights(Some(TrackKind::Audio), |h| h + TRACK_STEP),
            "audioTracksShorter" => self.heights(Some(TrackKind::Audio), |h| h - TRACK_STEP),
            "expandTracks" => self.heights(None, |_| TRACK_EXPANDED),
            "minimizeTracks" => self.heights(None, |_| TRACK_MIN),
            _ => self.edit(id),
        }
    }

    fn step(&mut self, d: Ticks) {
        let Some(seq) = self.app.sequence() else { return };
        let t = snap(self.app.t, seq.fps, true) + d;
        self.app.set_time(t);
    }

    /// Track heights, one undo step for all of them (Ctrl/Alt+= and -, Shift+= and -).
    fn heights(&mut self, kind: Option<TrackKind>, f: impl Fn(f32) -> f32) {
        let Some(seq) = self.app.sequence() else { return };
        let list: Vec<Json> = seq
            .tracks
            .iter()
            .filter(|t| kind.is_none_or(|k| t.kind == k))
            .map(|t| {
                cmd::set_track(
                    seq.id,
                    t.id,
                    json!({ "height": f64::from(f(t.height as f32).clamp(TRACK_MIN, TRACK_MAX)) }),
                )
            })
            .collect();
        self.app.exec(&cmd::batch("Track Height", list));
    }

    /// The edits that need a sequence.
    fn edit(&mut self, id: &str) {
        let Some(seq) = self.app.sequence().cloned() else { return };
        let t = self.app.t;
        let f = frame_start(1, seq.fps).max(1);
        let sel = self.app.selected();
        let s = seq.id;
        match id {
            "splitAll" => {
                self.app.exec(&cmd::split_all(s, t, true));
            }
            "delete" | "rippleDelete" => {
                if !sel.is_empty() && self.app.exec(&cmd::remove(s, &sel, id == "rippleDelete", true)).is_some() {
                    self.app.selection.clear();
                }
            }
            "cut" => {
                self.copy();
                if !sel.is_empty() && self.app.exec(&cmd::remove(s, &sel, false, true)).is_some() {
                    self.app.selection.clear();
                }
            }
            "copy" => self.copy(),
            "paste" | "pasteInsert" => {
                if self.app.clipboard.is_empty() {
                    return;
                }
                let c = cmd::paste(s, self.app.clipboard.clone(), t, None, None, id == "pasteInsert");
                if let Some(r) = self.app.exec(&c) {
                    let ids: Vec<Id> = r
                        .get("ids")
                        .and_then(Json::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Json::as_str)
                        .map(Id::new)
                        .collect();
                    self.app.select(ids, false, false);
                }
            }
            "toggleEnabled" => {
                let clips = self.selected_clips();
                if clips.is_empty() {
                    return;
                }
                let on = !clips.iter().all(|c| c.enabled);
                let list = clips.iter().map(|c| cmd::set_clip(s, c.id, json!({ "enabled": on }), false)).collect();
                self.app.exec(&cmd::batch("Enable", list));
            }
            "link" => {
                let clips = self.selected_clips();
                if clips.is_empty() {
                    return;
                }
                let ids: Vec<Id> = clips.iter().map(|c| c.id).collect();
                let c = if clips.iter().any(|c| c.link.is_some()) { cmd::unlink(s, &ids) } else { cmd::link(s, &ids) };
                self.app.exec(&c);
            }
            "group" => {
                if sel.len() < 2 {
                    self.app.toast(tr("Choose two or more clips to group."));
                } else {
                    self.app.exec(&cmd::group(s, &sel));
                }
            }
            "ungroup" => {
                if self.selected_clips().iter().all(|c| c.group.is_none()) {
                    self.app.toast(tr("No selected clip is in a group."));
                } else {
                    self.app.exec(&cmd::ungroup(s, &sel));
                }
            }
            "nudgeLeft" | "nudgeRight" | "nudgeLeft5" | "nudgeRight5" => {
                if sel.is_empty() {
                    return;
                }
                let n = if id.ends_with('5') { 5 } else { 1 };
                let d = if id.starts_with("nudgeLeft") { -n * f } else { n * f };
                self.app.exec(&cmd::move_clips(s, &sel, d, (0, 0), false, true));
            }
            "nudgeUp" | "nudgeDown" => {
                // Video rows count up from V1, audio rows down from A1; a side with no track to go to stays.
                let up = id == "nudgeUp";
                let side = |kind: TrackKind, d: i64| -> i64 {
                    let list: Vec<Id> = seq.tracks.iter().filter(|t| t.kind == kind).map(|t| t.id).collect();
                    let idx: Vec<i64> = self
                        .selected_clips()
                        .iter()
                        .filter_map(|c| list.iter().position(|t| *t == c.track))
                        .map(|i| i as i64)
                        .collect();
                    let fits = !idx.is_empty() && idx.iter().all(|i| (0..list.len() as i64).contains(&(i + d)));
                    if fits { d } else { 0 }
                };
                let td =
                    (side(TrackKind::Video, if up { 1 } else { -1 }), side(TrackKind::Audio, if up { -1 } else { 1 }));
                if td != (0, 0) {
                    self.app.exec(&cmd::move_clips(s, &sel, 0, td, false, false));
                }
            }
            "addMarker" => {
                let clip = self.selected_clips().into_iter().find(|c| c.start <= t && t < c.end()).map(|c| c.id);
                self.app.exec(&cmd::add_marker(s, t, clip));
            }
            "nextMarker" => {
                if let Some(m) = seq.markers.iter().map(|m| m.t).filter(|m| *m > t).min() {
                    self.app.set_time(m);
                }
            }
            "prevMarker" => {
                if let Some(m) = seq.markers.iter().map(|m| m.t).filter(|m| *m < t).max() {
                    self.app.set_time(m);
                }
            }
            "clearMarker" | "clearAllMarkers" => {
                let list: Vec<Id> = if id == "clearMarker" {
                    seq.markers
                        .iter()
                        .filter(|m| m.t == t || (m.duration > 0 && m.t <= t && t < m.t + m.duration))
                        .take(1)
                        .map(|m| m.id)
                        .collect()
                } else {
                    seq.markers.iter().map(|m| m.id).collect()
                };
                match list.len() {
                    0 => self.app.toast(tr("There is no marker here.")),
                    1 => {
                        self.app.exec(&cmd::remove_marker(s, list[0]));
                    }
                    _ => {
                        self.app.exec(&cmd::batch(
                            "Clear All Markers",
                            list.iter().map(|m| cmd::remove_marker(s, *m)).collect(),
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    /// Copy: the selected clips with their track kind (`clipboard`).
    fn copy(&mut self) {
        let Some(seq) = self.app.sequence() else { return };
        let mut list = Vec::new();
        for c in self.selected_clips() {
            let Ok(mut v) = serde_json::to_value(&c) else { continue };
            let kind =
                seq.track(c.track).map_or("video", |t| if t.kind == TrackKind::Audio { "audio" } else { "video" });
            v["kind"] = json!(kind);
            list.push(v);
        }
        if list.is_empty() {
            return;
        }
        let n = list.len();
        self.app.clipboard = list;
        self.app.toast(trf("{n} clips copied", &[("n", &n.to_string())]));
    }
}
