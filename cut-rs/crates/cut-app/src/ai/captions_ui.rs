//! Polish and Translate Captions with Claude (`ui-ai.js`'s `polishCaptions`, `reviewPolish`, `translateCaptions`):
//! a caption track (every caption, the In-Out range or the selected caption) sent in chunks of 60; a polish is
//! reviewed change by change and applied as one undo step with the times unchanged; a translation becomes a new
//! caption track with the same times, its lines broken again for the language.

use std::collections::HashMap;

use cut_model::commands::build as C;
use cut_model::{CaptionTrack, Id};
use cut_time::Ticks;
use eframe::egui::{self, Color32, RichText};
use serde_json::{Value as Json, json};

use super::ask::Question;
use super::captions::{CHUNK, Line, SYSTEM, polish_prompt, translate_prompt, validate_lines};
use super::lines::{Op, diff_chars, is_korean, keep_lines, known, line_break};
use crate::auto::dialog;
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::App;

/// The languages a translation goes into, with the names the dialog shows (`LANG_LABELS`).
pub const LANG_LABELS: [(&str, &str); 5] =
    [("ko", "Korean"), ("en", "English"), ("ja", "Japanese"), ("zh", "Chinese"), ("es", "Spanish")];

/// Which captions of the track a polish takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    Range,
    Selected,
}

/// The Polish Captions dialog.
#[derive(Debug, Clone, PartialEq)]
pub struct PolishForm {
    pub track: Id,
    pub scope: Scope,
    range: Option<(Ticks, Ticks)>,
    picked: Option<(Id, Id)>,
}

/// The Translate Captions dialog.
#[derive(Debug, Clone, PartialEq)]
pub struct TranslateForm {
    pub track: Id,
    pub to: &'static str,
}

/// A caption Claude changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub id: Id,
    pub start: Ticks,
    pub before: String,
    pub after: String,
}

/// The Review Caption Changes dialog: the changes and which are kept.
#[derive(Debug, Clone, PartialEq)]
pub struct Review {
    pub track: Id,
    pub changes: Vec<Change>,
    pub keep: Vec<bool>,
}

/// These dialogs' state.
#[derive(Default)]
pub struct CaptionsAi {
    pub polish: Option<PolishForm>,
    pub translate: Option<TranslateForm>,
    pub review: Option<Review>,
}

fn in_out(app: &App) -> Option<(Ticks, Ticks)> {
    match (app.in_out.in_, app.in_out.out) {
        (Some(a), Some(b)) if b > a => Some((a, b)),
        _ => None,
    }
}

/// `trackLang`: the track's language when it is one of the text AI's, else Korean when it has Hangul.
pub fn track_lang(t: &CaptionTrack) -> Option<String> {
    if known(Some(&t.lang)) {
        Some(t.lang.clone())
    } else if t.items.iter().any(|it| is_korean(&it.text)) {
        Some("ko".into())
    } else {
        None
    }
}

fn shown_track(s: &Shell) -> Option<Id> {
    crate::captions::shown(s).or_else(|| s.app.sequence()?.captions.first().map(|t| t.id))
}

/// The selected caption (track, caption) when it is still there.
fn picked(s: &Shell) -> Option<(Id, Id)> {
    let (t, c) = s.timeline.captions.selected?;
    let seq = s.app.sequence()?;
    seq.captions.iter().find(|x| x.id == t)?.items.iter().any(|it| it.id == c).then_some((t, c))
}

/// Polish Captions with Claude… chosen: its dialog.
pub fn polish(s: &mut Shell) {
    let Some(seq) = s.app.sequence().filter(|q| q.captions.iter().any(|t| !t.items.is_empty())) else {
        s.app.toast(tr("There are no captions to polish."));
        return;
    };
    let _ = seq;
    let Some(track) = shown_track(s) else { return };
    let range = in_out(&s.app);
    let scope = if range.is_some() { Scope::Range } else { Scope::All };
    s.features.ai.captions.polish = Some(PolishForm { track, scope, range, picked: picked(s) });
}

fn items_of(s: &Shell, o: &PolishForm) -> Vec<cut_model::Caption> {
    let Some(t) = s.app.sequence().and_then(|q| q.captions.iter().find(|x| x.id == o.track)) else { return Vec::new() };
    t.items
        .iter()
        .filter(|it| match (o.scope, o.range, o.picked) {
            (Scope::Range, Some((a, b)), _) => it.start < b && it.end > a,
            (Scope::Selected, _, Some((pt, pc))) => it.id == pc && t.id == pt,
            _ => true,
        })
        .cloned()
        .collect()
}

fn utf16(s: &str) -> f64 {
    s.encode_utf16().count() as f64
}

/// Polish pressed: the chosen captions asked in chunks, then the review.
pub fn polish_go(s: &mut Shell) {
    let Some(o) = s.features.ai.captions.polish.take() else { return };
    let items = items_of(s, &o);
    let Some(track) = s.app.sequence().and_then(|q| q.captions.iter().find(|t| t.id == o.track)).cloned() else {
        return;
    };
    if items.is_empty() {
        s.app.toast(tr("There are no captions to polish."));
        return;
    }
    let lang = track_lang(&track);
    let numbered: Vec<(i64, Id, String)> =
        items.iter().enumerate().map(|(k, it)| (k as i64 + 1, it.id, it.text.clone())).collect();
    let parts: Vec<Vec<(i64, Id, String)>> = numbered.chunks(CHUNK).map(<[_]>::to_vec).collect();
    let track_id = o.track;
    super::job(s, "Polishing captions with Claude…", move |ctx| {
        let mut out: HashMap<Id, String> = HashMap::new();
        let n = parts.len();
        for (k, part) in parts.iter().enumerate() {
            let lines: Vec<Line> = part.iter().map(|(i, _, t)| Line { i: *i, text: t.clone() }).collect();
            let prompt = polish_prompt(&lines, lang.as_deref());
            let q = Question {
                task: "polish",
                system: SYSTEM,
                expect: utf16(&prompt) * 0.6,
                prompt,
                part: (k as f64 / n as f64, (k + 1) as f64 / n as f64),
                label: (n > 1).then_some((k + 1, n)),
            };
            let got = ctx.ask(q, |v| validate_lines(v, &lines))?;
            for (i, id, text) in part {
                out.insert(*id, keep_lines(text, &got[i], lang.as_deref()));
            }
        }
        Ok(Box::new(move |s: &mut Shell| polished(s, track_id, &items, &out)))
    });
}

fn polished(s: &mut Shell, track: Id, items: &[cut_model::Caption], out: &HashMap<Id, String>) {
    let changes: Vec<Change> = items
        .iter()
        .filter_map(|it| {
            let after = out.get(&it.id).filter(|a| **a != it.text)?;
            Some(Change { id: it.id, start: it.start, before: it.text.clone(), after: after.clone() })
        })
        .collect();
    if changes.is_empty() {
        s.app.toast(tr("Claude found nothing to fix."));
        return;
    }
    let keep = vec![true; changes.len()];
    s.features.ai.captions.review = Some(Review { track, changes, keep });
}

/// Apply pressed in the review: the kept changes as one undo step (Polish Captions) -> how many.
pub fn apply_polish(s: &mut Shell) -> usize {
    let Some(r) = s.features.ai.captions.review.take() else { return 0 };
    let Some(seq) = s.app.sequence() else { return 0 };
    let items = seq.captions.iter().find(|t| t.id == r.track).map_or(&[][..], |t| t.items.as_slice());
    let cmds: Vec<Json> = r
        .changes
        .iter()
        .zip(&r.keep)
        .filter(|(_, k)| **k)
        .filter_map(|(c, _)| {
            let it = items.iter().find(|it| it.id == c.id)?;
            // Claude did not hear the speech: a caption's doubtful words stay doubtful
            let doubt = serde_json::to_value(&it.doubt).unwrap_or(Json::Null);
            Some(C::set_caption(
                seq.id.as_str(),
                r.track.as_str(),
                c.id.as_str(),
                json!({ "text": c.after, "doubt": doubt }),
            ))
        })
        .collect();
    let n = cmds.len();
    if n == 0 || s.app.exec(&C::batch("Polish Captions", cmds)).is_none() {
        return 0;
    }
    s.app.toast(trf("Captions polished: {n}.", &[("n", &n.to_string())]));
    n
}

/// Translate Captions with Claude… chosen: its dialog.
pub fn translate(s: &mut Shell) {
    if !s.app.sequence().is_some_and(|q| q.captions.iter().any(|t| !t.items.is_empty())) {
        s.app.toast(tr("There are no captions to translate."));
        return;
    }
    let Some(track) = shown_track(s) else { return };
    let from = s.app.sequence().and_then(|q| q.captions.iter().find(|t| t.id == track)).and_then(track_lang);
    let to = if from.as_deref() == Some("ko") { "en" } else { "ko" };
    s.features.ai.captions.translate = Some(TranslateForm { track, to });
}

/// Translate pressed: every caption of the track asked in chunks, then the new track.
pub fn translate_go(s: &mut Shell) {
    let Some(o) = s.features.ai.captions.translate.take() else { return };
    let Some(track) = s.app.sequence().and_then(|q| q.captions.iter().find(|t| t.id == o.track)).cloned() else {
        return;
    };
    let src = track_lang(&track);
    let to = o.to;
    let numbered: Vec<(i64, String)> =
        track.items.iter().enumerate().map(|(k, it)| (k as i64 + 1, it.text.clone())).collect();
    let parts: Vec<Vec<(i64, String)>> = numbered.chunks(CHUNK).map(<[_]>::to_vec).collect();
    super::job(s, "Translating captions with Claude…", move |ctx| {
        let mut texts: HashMap<i64, String> = HashMap::new();
        let n = parts.len();
        for (k, part) in parts.iter().enumerate() {
            let lines: Vec<Line> = part.iter().map(|(i, t)| Line { i: *i, text: t.clone() }).collect();
            let prompt = translate_prompt(&lines, src.as_deref(), Some(to));
            let q = Question {
                task: "translate",
                system: SYSTEM,
                expect: utf16(&prompt) * 0.7,
                prompt,
                part: (k as f64 / n as f64, (k + 1) as f64 / n as f64),
                label: (n > 1).then_some((k + 1, n)),
            };
            texts.extend(ctx.ask(q, |v| validate_lines(v, &lines))?);
        }
        Ok(Box::new(move |s: &mut Shell| translated(s, &track, to, &texts)))
    });
}

fn translated(s: &mut Shell, track: &CaptionTrack, to: &'static str, texts: &HashMap<i64, String>) {
    let Some(seq) = s.app.sequence_id else { return };
    let made: Vec<Json> = track
        .items
        .iter()
        .enumerate()
        .map(|(k, it)| {
            let text = texts.get(&(k as i64 + 1)).map_or(String::new(), |t| line_break(t, Some(to), 0, 2));
            let mut o = json!({ "start": it.start, "end": it.end, "text": text });
            if let Some(sp) = &it.speaker {
                o["speaker"] = json!(sp);
            }
            o
        })
        .collect();
    let label = LANG_LABELS.iter().find(|l| l.0 == to).map_or(to, |l| l.1);
    let name = format!("{} ({})", track.name, tr(label));
    let n = made.len();
    let cmd = C::add_caption_track(
        seq.as_str(),
        json!({ "name": name, "lang": to, "style": Json::Object(track.style.clone()), "syncLock": track.sync_lock, "items": made }),
    );
    if s.app.exec(&C::batch("Translate Captions", vec![cmd])).is_some() {
        s.app.toast(trf("Translated captions: {n} in the track {name}.", &[("n", &n.to_string()), ("name", &name)]));
    }
}

fn note(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.label(RichText::new(text).color(s.palette.gray[8]).size(12.0));
}

/// The Caption track row of a dialog when the sequence has more than one.
fn track_row(s: &Shell, ui: &mut egui::Ui, track: &mut Id) {
    let Some(seq) = s.app.sequence().filter(|q| q.captions.len() > 1) else { return };
    ui.label(tr("Caption track"));
    let name = seq.captions.iter().find(|t| t.id == *track).map_or(String::new(), |t| t.name.clone());
    egui::ComboBox::from_id_salt("cut-ai-track").icon(crate::theme::combo_icon).selected_text(name).show_ui(ui, |ui| {
        for t in &seq.captions {
            ui.selectable_value(track, t.id, &t.name);
        }
    });
    ui.end_row();
}

/// The dialogs, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    if let Some(mut o) = s.features.ai.captions.polish.clone() {
        let (mut go, mut cancel) = (false, false);
        dialog("Polish Captions", "cutAiPolish", 460.0).show(ctx, |ui| {
            note(ui, s, &tr("Claude fixes spelling, spacing and punctuation; the times stay as they are. You review each change before it is applied."));
            egui::Grid::new("cut-ai-polish").num_columns(2).show(ui, |ui| {
                track_row(s, ui, &mut o.track);
                let mut options = vec![(Scope::All, "Every caption of the track")];
                if o.range.is_some() {
                    options.push((Scope::Range, "The captions from In to Out"));
                }
                if o.picked.is_some() {
                    options.push((Scope::Selected, "The selected caption"));
                }
                if options.len() > 1 {
                    ui.label(tr("Captions"));
                    let shown = options.iter().find(|x| x.0 == o.scope).map_or("", |x| x.1);
                    egui::ComboBox::from_id_salt("cut-ai-scope").icon(crate::theme::combo_icon).selected_text(tr(shown)).show_ui(ui, |ui| {
                        for (v, label) in &options {
                            ui.selectable_value(&mut o.scope, *v, tr(label));
                        }
                    });
                    ui.end_row();
                }
            });
            ui.horizontal(|ui| {
                go = ui.button(tr("Polish")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        s.features.ai.captions.polish = (!cancel).then_some(o);
        if go {
            polish_go(s);
        }
    }
    if let Some(mut o) = s.features.ai.captions.translate.clone() {
        let (mut go, mut cancel) = (false, false);
        dialog("Translate Captions", "cutAiTranslate", 460.0).show(ctx, |ui| {
            note(ui, s, &tr("Claude translates every caption into a new caption track with the same times; the lines are broken again for the language."));
            egui::Grid::new("cut-ai-translate").num_columns(2).show(ui, |ui| {
                track_row(s, ui, &mut o.track);
                ui.label(tr("Translate into"));
                let shown = LANG_LABELS.iter().find(|l| l.0 == o.to).map_or("", |l| l.1);
                egui::ComboBox::from_id_salt("cut-ai-lang").icon(crate::theme::combo_icon).selected_text(tr(shown)).show_ui(ui, |ui| {
                    for (code, label) in LANG_LABELS {
                        ui.selectable_value(&mut o.to, code, tr(label));
                    }
                });
                ui.end_row();
            });
            ui.horizontal(|ui| {
                go = ui.button(tr("Translate")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        s.features.ai.captions.translate = (!cancel).then_some(o);
        if go {
            translate_go(s);
        }
    }
    review_window(s, ctx);
}

/// A caption's before and after, the removed characters struck through and the added ones underlined.
fn diff_view(ui: &mut egui::Ui, before: &str, after: &str) {
    let parts = diff_chars(before, after);
    let (red, green) = (Color32::from_rgb(0xE5, 0x48, 0x4D), Color32::from_rgb(0x30, 0xA4, 0x6C));
    for side in [Op::Remove, Op::Add] {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            for (op, text) in parts.iter().filter(|(op, _)| *op == Op::Keep || *op == side) {
                let t = RichText::new(text);
                ui.label(match op {
                    Op::Keep => t,
                    Op::Remove => t.strikethrough().color(red),
                    Op::Add => t.underline().color(green),
                });
            }
        });
    }
}

fn review_window(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut r) = s.features.ai.captions.review.clone() else { return };
    let fps = s.app.sequence().map(|q| q.fps);
    let (mut apply, mut cancel) = (false, false);
    dialog("Review Caption Changes", "cutAiPolishReview", 620.0).show(ctx, |ui| {
        note(ui, s, &tr("Uncheck the changes you do not want. The times do not change; applying is one undo step."));
        ui.horizontal(|ui| {
            if ui.button(tr("Select All")).clicked() {
                r.keep.iter_mut().for_each(|k| *k = true);
            }
            if ui.button(tr("Select None")).clicked() {
                r.keep.iter_mut().for_each(|k| *k = false);
            }
            let chosen = r.keep.iter().filter(|k| **k).count();
            ui.label(trf(
                "{n} of {total} changes chosen",
                &[("n", &chosen.to_string()), ("total", &r.changes.len().to_string())],
            ));
        });
        egui::ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
            for (c, keep) in r.changes.iter().zip(r.keep.iter_mut()) {
                ui.horizontal(|ui| {
                    ui.checkbox(keep, "");
                    ui.vertical(|ui| {
                        if let Some(fps) = fps {
                            ui.label(RichText::new(cut_time::timecode(c.start, fps)).monospace().size(11.0));
                        }
                        diff_view(ui, &c.before, &c.after);
                    });
                });
                ui.separator();
            }
        });
        ui.horizontal(|ui| {
            apply = ui.button(tr("Apply")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    s.features.ai.captions.review = (!cancel).then_some(r);
    if apply {
        apply_polish(s);
    }
}
