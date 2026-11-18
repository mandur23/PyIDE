//! Highlights to Shorts (`ui-ai.js`'s `highlights`, `reviewHighlights`, `createShorts`): Claude picks up to N ranges
//! of the sequence from its words; they are checked, reviewed, and the chosen ones become a new 1080x1920 sequence
//! that keeps only them, in time order, its video fitted or filling the frame, with the captions and markers that
//! fall in them. One undo step; an undo of it brings back the sequence it came from.

use std::collections::HashMap;

use cut_model::Id;
use cut_model::commands::build as C;
use eframe::egui::{self, RichText};
use serde_json::{Value as Json, json};

use super::ask::Question;
use super::captions::{BUDGET, Condensed, SYSTEM, condense};
use super::highlights::{Ask, Fit, Highlight, complement, highlights_prompt, shorts_edits, validate_highlights};
use super::js::{T, to_fixed};
use crate::auto::{dialog, number};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The review: the highlights, which are kept, and how the video meets the frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Review {
    pub ranges: Vec<Highlight>,
    pub keep: Vec<bool>,
    pub mode: Fit,
    pub condensed: Condensed,
}

/// The dialogs' state, and the shorts sequences made with the sequence each came from.
#[derive(Default)]
pub struct ShortsAi {
    pub ask: Option<Ask>,
    pub review: Option<Review>,
    made: HashMap<Id, Id>,
    shown: Option<Id>,
}

fn saved(s: &Shell) -> Ask {
    let v = s.doc.settings.get("ai.highlights");
    let get = |k: &str, d: f64| v.and_then(|o| o.get(k)).and_then(Json::as_f64).unwrap_or(d);
    Ask { count: get("count", 3.0), min: get("min", 15.0), max: get("max", 60.0) }
}

/// Highlights to Shorts… chosen: its dialog.
pub fn open(s: &mut Shell) {
    if !s.app.sequence().is_some_and(|q| q.clip_count() > 0) {
        s.app.toast(tr("The sequence is empty."));
        return;
    }
    s.features.ai.shorts.ask = Some(saved(s));
}

/// Find Highlights pressed -> whether the dialog closed.
pub fn find(s: &mut Shell) -> bool {
    let Some(o) = s.features.ai.shorts.ask else { return true };
    if o.max <= o.min {
        s.app.toast(tr("The longest must be longer than the shortest."));
        return false;
    }
    s.features.ai.shorts.ask = None;
    s.doc.settings.set("ai.highlights", json!({ "count": o.count, "min": o.min, "max": o.max }));
    let _ = s.doc.settings.save();
    ask_claude(s, o, true);
    true
}

fn ask_claude(s: &mut Shell, o: Ask, first: bool) {
    let again: Option<super::notice::Pending> =
        first.then(|| Box::new(move |s: &mut Shell| ask_claude(s, o, false)) as _);
    let Some((segments, _)) = super::metadata_ui::sequence_text(s, again) else { return };
    let Some(seq) = s.app.sequence() else { return };
    let duration = seq.duration() as f64;
    let frame = cut_model::query::frame(seq.fps) as f64;
    let condensed = condense(&segments, BUDGET, 200);
    let prompt = highlights_prompt(duration, &condensed.text, o);
    let mode =
        if s.doc.settings.get("ai.shortsFit").and_then(Json::as_str) == Some("fit") { Fit::Fit } else { Fit::Fill };
    super::job(s, "Finding highlights with Claude…", move |ctx| {
        let expect = 200.0 * o.count;
        let q = Question { task: "highlights", system: SYSTEM, prompt, part: (0.0, 1.0), expect, label: None };
        let ranges = ctx.ask(q, |v| validate_highlights(v, duration, o, frame))?;
        Ok(Box::new(move |s: &mut Shell| {
            let keep = vec![true; ranges.len()];
            s.features.ai.shorts.review = Some(Review { ranges, keep, mode, condensed });
        }))
    });
}

/// Create Shorts Sequence pressed -> the new sequence, or `None` (nothing chosen: the review stays).
pub fn create(s: &mut Shell) -> Option<Id> {
    let r = s.features.ai.shorts.review.clone()?;
    let chosen: Vec<&Highlight> = r.ranges.iter().zip(&r.keep).filter(|(_, k)| **k).map(|(h, _)| h).collect();
    if chosen.is_empty() {
        s.app.toast(tr("Choose at least one highlight."));
        return None;
    }
    s.features.ai.shorts.review = None;
    s.doc.settings.set("ai.shortsFit", Json::from(r.mode.id()));
    let _ = s.doc.settings.save();
    let ranges: Vec<(f64, f64)> = chosen.iter().map(|h| (h.start, h.end)).collect();
    create_shorts(s, &ranges, r.mode)
}

fn add(s: &mut Shell, cmd: &Json) -> Result<Json, String> {
    s.app.history.apply(cmd).map_err(|e| e.message)
}

/// `createShorts`: a copy of the sequence at 1080x1920 that keeps only `ranges` (ticks), one undo step.
pub fn create_shorts(s: &mut Shell, ranges: &[(f64, f64)], mode: Fit) -> Option<Id> {
    let src = s.app.sequence()?;
    let (src_id, name) = (src.id, src.name.clone());
    let mut keep = ranges.to_vec();
    keep.sort_by(|a, b| a.0.total_cmp(&b.0));
    s.app.history.begin("Create Shorts Sequence");
    let made = (|| -> Result<Id, String> {
        let name = trf("{name} Shorts", &[("name", &name)]);
        let r = add(s, &C::add_sequence(json!({ "from": src_id.as_str(), "name": name })))?;
        let id = Id::new(r["id"].as_str().ok_or("the new sequence has no id")?);
        let seq_of = |s: &Shell| s.app.project().sequences.iter().find(|q| q.id == id).cloned();
        let q = seq_of(s).ok_or("the new sequence is missing")?;
        for t in q.tracks.iter().filter(|t| t.locked) {
            add(s, &C::set_track(id.as_str(), t.id.as_str(), json!({ "locked": false })))?;
        }
        for ct in q.captions.iter().filter(|c| !c.sync_lock) {
            add(s, &C::set_caption_track(id.as_str(), ct.id.as_str(), json!({ "syncLock": true })))?;
        }
        add(s, &C::set_sequence(id.as_str(), json!({ "w": 1080, "h": 1920 })))?;
        let q = seq_of(s).ok_or("the new sequence is missing")?;
        let ends = q.captions.iter().flat_map(|t| t.items.iter().map(|it| it.end));
        let marks = q.markers.iter().map(|m| m.t + m.duration);
        let end = ends.chain(marks).chain([q.duration(), 0]).max().unwrap_or(0) as f64;
        for (a, b) in complement(&keep, end) {
            add(s, &C::extract(id.as_str(), a as i64, b as i64, None))?;
        }
        let q = seq_of(s).ok_or("the new sequence is missing")?;
        for cmd in shorts_edits(s.app.project(), &q, mode) {
            add(s, &cmd)?;
        }
        Ok(id)
    })();
    match made {
        Ok(id) => {
            s.app.history.commit();
            s.features.ai.shorts.made.insert(id, src_id);
            s.app.set_sequence(id);
            s.app.toast(trf("Shorts sequence created: {n} highlights.", &[("n", &keep.len().to_string())]));
            Some(id)
        }
        Err(e) => {
            s.app.history.cancel();
            s.app.report(tr(&e).into_owned());
            None
        }
    }
}

fn note(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.label(RichText::new(text).color(s.palette.gray[8]).size(12.0));
}

/// A shorts sequence an undo took away: back to the sequence it came from (each frame).
pub fn follow(s: &mut Shell) {
    let sh = &mut s.features.ai.shorts;
    let active = s.app.sequence_id;
    if let Some(gone) = sh.shown.filter(|id| !s.app.project().sequences.iter().any(|q| q.id == *id)) {
        sh.shown = None;
        if let Some(src) =
            sh.made.get(&gone).copied().filter(|src| s.app.project().sequences.iter().any(|q| q.id == *src))
        {
            s.app.set_sequence(src);
        }
    } else {
        sh.shown = active.filter(|id| sh.made.contains_key(id));
    }
}

/// The dialogs, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    follow(s);
    if let Some(mut o) = s.features.ai.shorts.ask {
        let (mut go, mut cancel) = (false, false);
        dialog("Highlights to Shorts", "cutAiHighlights", 460.0).show(ctx, |ui| {
            note(ui, s, &tr("Claude picks the best moments from the transcript. You review them, then they become a new 9:16 sequence (1080x1920)."));
            egui::Grid::new("cut-ai-highlights").num_columns(2).show(ui, |ui| {
                ui.label(tr("Number of highlights"));
                number(ui, &mut o.count, (1.0, 10.0, 1.0), 0, "");
                ui.end_row();
                ui.label(tr("Shortest"));
                number(ui, &mut o.min, (3.0, 170.0, 1.0), 0, "s");
                ui.end_row();
                ui.label(tr("Longest"));
                number(ui, &mut o.max, (5.0, 180.0, 1.0), 0, "s");
                ui.end_row();
            });
            ui.horizontal(|ui| {
                go = ui.button(tr("Find Highlights")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        s.features.ai.shorts.ask = (!cancel).then_some(o);
        if go {
            find(s);
        }
    }
    let Some(mut r) = s.features.ai.shorts.review.clone() else { return };
    let fps = s.app.sequence().map(|q| q.fps);
    let (mut go, mut cancel) = (false, false);
    dialog("Review Highlights", "cutAiHighlightsReview", 560.0).show(ctx, |ui| {
        note(
            ui,
            s,
            &tr("The chosen ranges go into a new 1080x1920 sequence in time order, with the captions. One undo step."),
        );
        egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
            for (i, (h, keep)) in r.ranges.iter().zip(r.keep.iter_mut()).enumerate() {
                ui.horizontal(|ui| {
                    ui.checkbox(keep, "");
                    ui.vertical(|ui| {
                        if let Some(fps) = fps {
                            let len = trf("{n} s", &[("n", &to_fixed((h.end - h.start) / T, 1))]);
                            let tc = |t: f64| cut_time::timecode(t as i64, fps);
                            ui.label(RichText::new(format!("{} – {} · {len}", tc(h.start), tc(h.end))).monospace());
                        }
                        let title = if h.title.is_empty() {
                            trf("Highlight {n}", &[("n", &(i + 1).to_string())])
                        } else {
                            h.title.clone()
                        };
                        ui.label(RichText::new(title).strong());
                        if !h.reason.is_empty() {
                            note(ui, s, &h.reason);
                        }
                    });
                });
            }
        });
        ui.horizontal(|ui| {
            ui.label(tr("Video"));
            let label = |m: Fit| match m {
                Fit::Fill => tr("Fill the frame (crops the sides)"),
                Fit::Fit => tr("Fit inside the frame (bars above and below)"),
            };
            egui::ComboBox::from_id_salt("cut-ai-fit")
                .icon(crate::theme::combo_icon)
                .selected_text(label(r.mode))
                .show_ui(ui, |ui| {
                    for m in [Fit::Fill, Fit::Fit] {
                        ui.selectable_value(&mut r.mode, m, label(m));
                    }
                });
        });
        let total: f64 = r.ranges.iter().zip(&r.keep).filter(|(_, k)| **k).map(|(h, _)| h.end - h.start).sum();
        let n = r.keep.iter().filter(|k| **k).count();
        ui.label(trf("{n} highlights, {time} s", &[("n", &n.to_string()), ("time", &to_fixed(total / T, 1))]));
        let trimmed = super::metadata_ui::trimmed_note(&r.condensed);
        if !trimmed.is_empty() {
            note(ui, s, &trimmed);
        }
        ui.horizontal(|ui| {
            go = ui.button(tr("Create Shorts Sequence")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    s.features.ai.shorts.review = (!cancel).then_some(r);
    if go {
        create(s);
    }
}
