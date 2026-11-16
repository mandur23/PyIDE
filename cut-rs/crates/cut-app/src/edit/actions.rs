//! The keyboard and menu actions of the editing features (ports of `ui-timeline.js`'s `api` and `act` list and of
//! `ui-monitors.js`'s source actions): Insert, Overwrite, Match Frame, Extend Edit, Speed/Duration, the default
//! transitions, Nest, Lift and Extract, the tools, and the actions that work on the targeted tracks. The panel with
//! the keyboard decides first: the Source monitor answers its transport keys, the Markers panel Delete and M.
//!
//! [`enabled`] and [`run`] are asked before the shell's own table (`Shell::action_enabled`, `Shell::run_action`).

use cut_model::commands::build as C;
use cut_model::{Id, Sequence, TrackKind};
use cut_time::{Ticks, frame_start};
use eframe::egui;
use serde_json::{Value as Json, json};

use super::dialogs::EditDialog;
use super::source::{self, SourceClip, SourceItem};
use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::{App, Panel, Tool};
use crate::timeline::gesture;

/// The actions built here.
pub const ACTIONS: &[&str] = &[
    "insert",
    "overwrite",
    "matchFrame",
    "extendEdit",
    "speed",
    "transitionVideo",
    "transitionAudio",
    "transitionBoth",
    "nest",
    "tool.rate",
    "tool.slip",
    "tool.slide",
    "tool.pen",
    "lift",
    "extract",
    "split",
    "rippleStart",
    "rippleEnd",
    "selectAtPlayhead",
    "freezeFrame",
];

/// Whether the source monitor takes this action now.
fn source_takes(s: &Shell, id: &str) -> bool {
    s.app.focus == Some(Panel::Source) && s.app.edit.source.clip.is_some() && source::ACTIONS.contains(&id)
}

/// Whether the timeline's selected transition or gap takes Delete.
fn selection_takes(s: &Shell, id: &str) -> bool {
    matches!(id, "delete" | "rippleDelete")
        && s.app.focus == Some(Panel::Timeline)
        && (s.app.edit.transition.is_some() || (s.app.selection.is_empty() && s.app.edit.gap.is_some()))
}

fn markers_take(s: &Shell, id: &str) -> bool {
    s.app.focus == Some(Panel::Markers) && matches!(id, "delete" | "addMarker" | "prevEdit" | "nextEdit")
}

/// Whether `id` can run now, when it is one of these actions (`None`: the shell's table decides).
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    if source_takes(s, id) || selection_takes(s, id) || markers_take(s, id) {
        return Some(true);
    }
    if !ACTIONS.contains(&id) {
        return None;
    }
    let seq = s.app.sequence().is_some();
    let some = !s.app.selection.is_empty();
    let io = s.app.in_out;
    Some(match id {
        "insert" | "overwrite" => seq && s.app.edit.source.clip.is_some(),
        "speed" | "nest" => some,
        "lift" | "extract" => seq && (io.in_.is_some() || io.out.is_some()),
        _ if id.starts_with("tool.") => true,
        _ => seq,
    })
}

/// Runs `id` when it is one of these actions. -> whether it was.
pub fn run(s: &mut Shell, id: &str, ctx: &egui::Context) -> bool {
    if s.app.edit.dialog.is_some() {
        return true;
    }
    if source_takes(s, id) {
        let p = s.app.history.project();
        s.app.edit.source.run(p, id);
        ctx.request_repaint();
        return true;
    }
    if markers_take(s, id) {
        crate::panels::markers::action(s, id);
        return true;
    }
    if selection_takes(s, id) {
        delete_selection(s);
        return true;
    }
    if !ACTIONS.contains(&id) {
        return false;
    }
    if let Some(tool) = id.strip_prefix("tool.").and_then(Tool::from_id) {
        s.app.tool = tool;
        return true;
    }
    match id {
        "insert" | "overwrite" => place(s, id),
        "matchFrame" => match_frame(s),
        "speed" => match EditDialog::speed(&s.app) {
            Ok(d) => s.app.edit.dialog = Some(d),
            Err(why) => s.app.toast(tr(why)),
        },
        "nest" => match EditDialog::nest(&s.app) {
            Ok(d) => s.app.edit.dialog = Some(d),
            Err(why) => s.app.toast(tr(why)),
        },
        "transitionVideo" => add_transitions(s, true, false),
        "transitionAudio" => add_transitions(s, false, true),
        "transitionBoth" => add_transitions(s, true, true),
        _ => targeted_edit(s, id),
    }
    true
}

fn targets(s: &Shell) -> Vec<Id> {
    s.app.sequence().map_or_else(Vec::new, |q| super::targeted(q, s.app.edit.targets.as_deref()))
}

fn strs(ids: &[Id]) -> Vec<&str> {
    ids.iter().map(|i| i.as_str()).collect()
}

/// The edits on the targeted tracks (the timeline `api`'s `split`, `rippleTrim`, `liftRange`, `selectAtPlayhead`,
/// `freezeFrame`, `extendEdit`).
fn targeted_edit(s: &mut Shell, id: &str) {
    let Some(seq) = s.app.sequence().cloned() else { return };
    let (t, sid, tracks) = (s.app.t, seq.id, targets(s));
    let sel: Vec<cut_model::Clip> = s.app.selected().iter().filter_map(|i| seq.clip(*i).cloned()).collect();
    let linked = s.app.linked_selection;
    match id {
        "split" => {
            let under: Vec<Id> = sel.iter().filter(|c| c.start < t && t < c.end()).map(|c| c.id).collect();
            let opts = if under.is_empty() {
                json!({ "trackIds": strs(&tracks), "linked": linked })
            } else {
                json!({ "clipIds": strs(&under), "linked": false })
            };
            s.app.exec(&C::split(sid.as_str(), t, opts));
        }
        "rippleStart" | "rippleEnd" => {
            let side = if id == "rippleStart" { "before" } else { "after" };
            let r = s.app.exec(&C::ripple_to_playhead(sid.as_str(), t, side, json!({ "trackIds": strs(&tracks) })));
            if side == "before"
                && let Some(a) = r.as_ref().and_then(|r| r["range"].get(0)).and_then(Json::as_i64)
            {
                s.app.set_time(a);
            }
        }
        "lift" | "extract" => {
            let (a, b) = (s.app.in_out.in_, s.app.in_out.out);
            if a.is_none() && b.is_none() {
                s.app.toast(tr("Set an In and an Out point."));
                return;
            }
            if tracks.is_empty() {
                s.app.toast(tr("Choose a target track."));
                return;
            }
            let (a, b) = (a.unwrap_or(0), b.unwrap_or_else(|| seq.duration()));
            let list = strs(&tracks);
            let c = if id == "extract" {
                C::extract(sid.as_str(), a, b, Some(&list))
            } else {
                C::lift(sid.as_str(), a, b, Some(&list))
            };
            if let Some(r) = s.app.exec(&c)
                && let Some(at) = r["range"].get(0).and_then(Json::as_i64)
            {
                s.app.set_in_out(Some(None), Some(None));
                s.app.set_time(at);
            }
        }
        "selectAtPlayhead" => {
            let mut ids = Vec::new();
            for c in seq.clips().filter(|c| tracks.contains(&c.track) && c.start <= t && t < c.end()) {
                for p in gesture::partners(&seq, c.id, false, linked) {
                    if !ids.contains(&p) {
                        ids.push(p);
                    }
                }
            }
            s.app.select(ids, false, false);
            s.app.edit.gap = None;
            s.app.edit.transition = None;
        }
        "freezeFrame" => {
            let video = |c: &cut_model::Clip| seq.kind_of(c.track) == Some(TrackKind::Video);
            let clip = sel.iter().find(|c| video(c) && c.start <= t && t < c.end()).map(|c| c.id).or_else(|| {
                seq.clips_at(t, Some(TrackKind::Video))
                    .into_iter()
                    .rev()
                    .find(|c| tracks.contains(&c.track))
                    .map(|c| c.id)
            });
            let Some(c) = clip else {
                s.app.toast(tr("Put the playhead on a video clip."));
                return;
            };
            if let Some(r) = s.app.exec(&C::freeze_frame(sid.as_str(), c.as_str(), t, None))
                && let Some(made) = r["id"].as_str()
            {
                s.app.select([Id::new(made)], false, false);
            }
        }
        "extendEdit" => {
            let opts = if sel.is_empty() {
                json!({ "trackIds": strs(&tracks), "linked": linked })
            } else {
                json!({ "clipIds": sel.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), "linked": linked })
            };
            if let Some(r) = s.app.exec(&C::extend_edit(sid.as_str(), t, opts))
                && let Some(c) = r["clamped"].as_str()
            {
                s.app.toast(tr(crate::timeline::tools::clamp_text(c)));
            }
        }
        _ => {}
    }
}

/// Delete with a transition or a gap selected (`deleteSelection`'s first cases).
fn delete_selection(s: &mut Shell) {
    let Some(sid) = s.app.sequence_id else { return };
    if let Some(t) = s.app.edit.transition.take() {
        s.app.exec(&C::remove_transition(sid.as_str(), t.as_str()));
    } else if let Some(g) = s.app.edit.gap.take() {
        s.app.exec(&C::close_gap(sid.as_str(), g.track.as_str(), g.t));
    }
}

/// Insert (`,`) and Overwrite (`.`) from the source monitor (`place(mode)`).
pub fn place(s: &mut Shell, mode: &str) {
    let (Some(src), Some(_)) = (s.app.edit.source.clip, s.app.sequence()) else {
        s.app.toast(tr("Open a clip in the source monitor first."));
        return;
    };
    s.transport.pause();
    let media = match src.item {
        source::SourceItem::Media(m) => Some(m),
        source::SourceItem::Sequence(_) => None,
    };
    let mode = mode.to_owned();
    super::mismatch::before(&mut s.app, media, None, move |app: &mut crate::state::App| {
        let Some(seq) = app.sequence() else { return };
        let io = (app.in_out.in_, app.in_out.out);
        let c = match source::place_command(app.project(), seq, &src, &app.edit.patch, io, app.t, &mode) {
            Ok(c) => c,
            Err(why) => {
                app.toast(tr(why));
                return;
            }
        };
        let Some(r) = app.exec(&c) else { return };
        let ids = r["ids"].as_array().into_iter().flatten().filter_map(Json::as_str).map(Id::new);
        app.select(ids, false, false);
        app.set_in_out(Some(None), Some(None));
        let end = r["at"].as_i64().unwrap_or(0) + r["duration"].as_i64().unwrap_or(0);
        app.set_time(end);
    });
}

/// The clip Match Frame takes (`matchFrame`): the selected clip under the playhead, else the top video clip on the
/// targeted tracks, else the first on them, else the top video clip, else the first with a source.
pub fn match_clip(app: &crate::state::App) -> Option<&cut_model::Clip> {
    let seq = app.sequence()?;
    let t = app.t;
    let tracks = super::targeted(seq, app.edit.targets.as_deref());
    let p = app.project();
    let under: Vec<&cut_model::Clip> =
        seq.clips_at(t, None).into_iter().filter(|c| c.media_id().and_then(|m| p.media(m)).is_some()).collect();
    let video = |c: &cut_model::Clip| seq.kind_of(c.track) == Some(TrackKind::Video);
    let targeted = |c: &cut_model::Clip| tracks.contains(&c.track);
    under
        .iter()
        .find(|c| app.selection.contains(&c.id))
        .or_else(|| under.iter().rev().find(|c| video(c) && targeted(c)))
        .or_else(|| under.iter().find(|c| targeted(c)))
        .or_else(|| under.iter().rev().find(|c| video(c)))
        .or_else(|| under.first())
        .copied()
}

/// F: the clip's source in the source monitor at the frame the playhead shows, its In/Out marked.
fn match_frame(s: &mut Shell) {
    let Some(c) = match_clip(&s.app) else {
        s.app.toast(tr("There is no source clip under the playhead."));
        return;
    };
    let Some(m) = c.media_id().and_then(|m| s.app.project().media(m)) else { return };
    let image = m.kind == cut_model::MediaKind::Image;
    let clip = SourceClip {
        item: SourceItem::Media(m.id),
        in_: (!image).then(|| c.in_.round() as i64),
        out: (!image).then(|| c.out.round() as i64),
        t: if image { 0 } else { c.source_time(s.app.t as f64).round() as i64 },
    };
    s.app.edit.source.open(clip);
    s.app.edit.source.picked = s.project.selected().iter().find_map(|id| s.app.project().media(*id)).map(|m| m.id);
    s.focus(Panel::Source);
}

/// Default transitions (`addTransitions` with the types set in the Effects panel, else the registry's).
pub fn add_transitions(s: &mut Shell, video: bool, audio: bool) {
    let kinds: Vec<TrackKind> =
        [(video, TrackKind::Video), (audio, TrackKind::Audio)].into_iter().filter(|k| k.0).map(|k| k.1).collect();
    let doc = &s.doc;
    let type_of = |k: TrackKind| {
        let (key, ek) = if k == TrackKind::Video {
            ("defaultVideoTransition", cut_model::effects::Kind::Video)
        } else {
            ("defaultAudioTransition", cut_model::effects::Kind::Audio)
        };
        doc.setting(key)
            .filter(|v| !v.is_empty())
            .map_or_else(|| cut_model::effects::default_transition(ek).to_owned(), str::to_owned)
    };
    place_transitions(&mut s.app, &kinds, &type_of);
}

/// Transitions of the type `type_of` gives each track kind (`addTransitions`): at both ends of the selected clips
/// of those kinds, else at the edit point nearest the playhead on each targeted track of the kinds; each point once,
/// one undo step. False, with a message, when there is no edit point.
pub fn place_transitions(app: &mut App, kinds: &[TrackKind], type_of: &dyn Fn(TrackKind) -> String) -> bool {
    let Some(seq) = app.sequence() else { return false };
    let t = app.t;
    let mut plan: Vec<(Id, i64, TrackKind)> = Vec::new();
    let clips: Vec<&cut_model::Clip> = app
        .selected()
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter(|c| seq.kind_of(c.track).is_some_and(|k| kinds.contains(&k)))
        .collect();
    if clips.is_empty() {
        for id in super::targeted(seq, app.edit.targets.as_deref()) {
            let Some(tk) = seq.track(id).filter(|tk| kinds.contains(&tk.kind)) else { continue };
            let best = tk.clips.iter().flat_map(|c| [c.start, c.end()]).fold(None, |b: Option<i64>, at| match b {
                Some(b) if (b - t).abs() <= (at - t).abs() => Some(b),
                _ => Some(at),
            });
            if let Some(at) = best {
                plan.push((id, at, tk.kind));
            }
        }
    } else {
        for c in &clips {
            let k = seq.kind_of(c.track).unwrap_or(TrackKind::Video);
            plan.push((c.track, c.start, k));
            plan.push((c.track, c.end(), k));
        }
    }
    let mut seen = Vec::new();
    plan.retain(|p| {
        let k = (p.0, p.1);
        let fresh = !seen.contains(&k);
        seen.push(k);
        fresh
    });
    if plan.is_empty() {
        app.toast(tr("There is no edit point here."));
        return false;
    }
    let list: Vec<Json> = plan
        .iter()
        .map(|(track, at, k)| {
            C::add_transition(
                seq.id.as_str(),
                json!({ "track": track.as_str(), "at": at, "type": type_of(*k), "align": align_at(seq, *track, *at) }),
            )
        })
        .collect();
    app.exec(&C::batch("Add Transition", list)).is_some()
}

/// The alignment of a transition at `at` on a track: centred on a cut between two clips, else starting or ending
/// there.
pub fn align_at(seq: &Sequence, track: Id, at: Ticks) -> &'static str {
    let Some(t) = seq.track(track) else { return "center" };
    let before = t.clips.iter().any(|c| c.end() == at);
    let after = t.clips.iter().any(|c| c.start == at);
    match (before, after) {
        (true, true) => "center",
        (false, true) => "start",
        _ => "end",
    }
}

/// The frame of the active sequence.
pub fn frame_of(s: &Shell) -> i64 {
    s.app.sequence().map_or(1, |q| frame_start(1, q.fps).max(1))
}
