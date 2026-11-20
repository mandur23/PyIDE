//! The Captions panel (`ui-captions.js`'s `mount`): the shown track's captions as rows of number, start, end and text,
//! edited in place; a row clicked moves the playhead to its start, the caption under the playhead is highlighted. A
//! text is committed when its field is left or Enter is pressed (Shift+Enter is a line break, Esc puts it back), so
//! undo never splits what was typed. A caption with words speech recognition was unsure of lists them: a word moves
//! the playhead to it, the check mark keeps the text as it is.

use cut_model::commands::build as C;
use cut_model::{Caption, Id};
use cut_time::{Fps, TICKS, frame_start, parse_timecode, snap, timecode};
use eframe::egui::{self, Button, Key, Modifiers, RichText, Sense, TextEdit, UiBuilder, Vec2};
use serde_json::{Value as Json, json};

use crate::i18n::{self, Lang, tr, trf};
use crate::icons;
use crate::shell::Shell;

/// A row's typed fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Field {
    Start,
    End,
    Text,
}

const ROW_H: f32 = 52.0;
const DOUBT_H: f32 = 24.0;

/// The track to write into, made when the sequence has none (`ensureTrack`).
fn ensure_track(s: &mut Shell) -> Option<Id> {
    if let Some(id) = super::shown(s) {
        return Some(id);
    }
    let seq = s.app.sequence_id?;
    let lang = if i18n::lang() == Lang::Ko { "ko" } else { "en" };
    let r = s.app.exec(&C::add_caption_track(seq.as_str(), json!({ "name": tr("Captions"), "lang": lang })))?;
    let id = Id::new(r["id"].as_str()?);
    super::choose(s, id);
    Some(id)
}

/// Add Caption at Playhead (`addAtPlayhead`): two seconds, or up to the next caption, empty, its field focused.
pub fn add_at_playhead(s: &mut Shell) -> Option<Id> {
    let seq = s.app.sequence()?;
    let fps = seq.fps;
    let sid = seq.id;
    let track = ensure_track(s)?;
    let t = s.app.t;
    let next = super::track_of(&s.app, &s.features.captions)?.items.iter().find(|x| x.start > t).map(|x| x.start);
    let end = next.unwrap_or(i64::MAX).min(t + 2 * TICKS);
    let end = if end > t { end } else { t + frame_start(1, fps).max(1) };
    let r = s.app.exec(&C::add_caption(sid.as_str(), track.as_str(), json!({ "start": t, "end": end, "text": "" })))?;
    let id = Id::new(r["id"].as_str()?);
    s.features.captions.focus_new = Some(id);
    Some(id)
}

fn set(s: &mut Shell, track: Id, item: Id, patch: Json) {
    let Some(seq) = s.app.sequence_id else { return };
    s.app.exec(&C::set_caption(seq.as_str(), track.as_str(), item.as_str(), patch));
}

/// A field that holds what is typed until it is left or Enter is pressed -> the text then.
fn field(s: &mut Shell, ui: &mut egui::Ui, key: (Id, Field), shown: String, width: f32) -> Option<String> {
    let id = egui::Id::unique(("cut-cap", key.0, key.1));
    let focused = ui.memory(|m| m.has_focus(id));
    let enter = focused && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter));
    let esc = focused && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape));
    let mut buf = s.features.captions.fields.get(&key).cloned().unwrap_or_else(|| shown.clone());
    let edit = if key.1 == Field::Text {
        TextEdit::multiline(&mut buf).desired_rows(2).desired_width(width).id(id)
    } else {
        TextEdit::singleline(&mut buf).desired_width(width).font(egui::TextStyle::Monospace).id(id)
    };
    let r = ui.add(edit);
    if s.features.captions.focus_new == Some(key.0) && key.1 == Field::Text {
        r.request_focus();
        s.features.captions.focus_new = None;
    }
    if esc {
        s.features.captions.fields.remove(&key);
        r.surrender_focus();
        return None;
    }
    if enter || r.lost_focus() {
        s.features.captions.fields.remove(&key);
        r.surrender_focus();
        return (buf != shown).then_some(buf);
    }
    if r.has_focus() {
        s.features.captions.fields.insert(key, buf);
    } else {
        s.features.captions.fields.remove(&key);
    }
    None
}

/// Whether the words speech recognition was unsure of are marked (`cut.speech.markUncertain`, on by default).
pub fn marking(s: &Shell) -> bool {
    crate::prefs::flag(&s.doc.settings, "speech.markUncertain")
}

fn percent(p: f64) -> String {
    format!("{}%", (p * 100.0 + 0.5).floor())
}

fn row(s: &mut Shell, ui: &mut egui::Ui, track: Id, it: &Caption, n: usize, fps: Fps, current: bool) {
    let pal = s.palette.clone();
    let w = ui.available_width();
    let doubts = it.doubt.as_ref().filter(|d| marking(s) && !d.is_empty());
    let h = ROW_H + if doubts.is_some() { DOUBT_H } else { 0.0 };
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, h), Sense::click());
    let bg = if current { pal.accent.gamma_multiply(0.18) } else { egui::Color32::TRANSPARENT };
    ui.painter().rect_filled(rect, 0.0, bg);
    ui.painter().hline(rect.x_range(), rect.bottom() - 0.5, egui::Stroke::new(1.0, pal.gray[3]));
    if resp.clicked() {
        s.app.set_time(it.start);
    }
    ui.scope_builder(UiBuilder::new().max_rect(rect.shrink2(Vec2::new(4.0, 3.0))), |ui| {
        ui.horizontal_top(|ui| {
            ui.add_sized([22.0, 18.0], egui::Label::new(RichText::new(n.to_string()).color(pal.gray[8]).monospace()));
            ui.vertical(|ui| {
                if let Some(v) = field(s, ui, (it.id, Field::Start), timecode(it.start, fps), 100.0)
                    && let Some(t) = parse_timecode(&v, fps, it.start)
                {
                    set(s, track, it.id, json!({ "start": t }));
                }
                if let Some(v) = field(s, ui, (it.id, Field::End), timecode(it.end, fps), 100.0)
                    && let Some(t) = parse_timecode(&v, fps, it.end)
                {
                    set(s, track, it.id, json!({ "end": t }));
                }
            });
            let text_w = (ui.available_width() - 30.0).max(60.0);
            if let Some(v) = field(s, ui, (it.id, Field::Text), it.text.clone(), text_w) {
                set(s, track, it.id, json!({ "text": v }));
            }
            let del = ui
                .add(Button::new(RichText::new(icons::CLOSE).size(11.0)).frame(false))
                .on_hover_text(tr("Delete Caption"));
            if del.clicked()
                && let Some(seq) = s.app.sequence_id
            {
                s.app.exec(&C::remove_caption(seq.as_str(), track.as_str(), it.id.as_str()));
            }
        });
        if let Some(list) = doubts {
            ui.horizontal(|ui| {
                ui.add_space(26.0);
                ui.label(RichText::new(tr("Unsure:")).size(11.0).color(pal.gray[9]));
                for d in list {
                    let b = ui.small_button(format!("{} {}", d.text, percent(d.p)));
                    if b.on_hover_text(trf("Whisper was unsure of this word ({p}). Go to it.", &[("p", &percent(d.p))]))
                        .clicked()
                    {
                        s.app.set_time(snap((it.start + d.at).min(it.end - 1), fps, true));
                    }
                }
                let ok =
                    ui.small_button(icons::CHECK).on_hover_text(tr("Mark as Checked: the caption is right as it is"));
                if ok.clicked() {
                    set(s, track, it.id, json!({ "doubt": null }));
                }
            });
        }
    });
}

/// The Captions panel.
pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    let Some(seq) = s.app.shared_sequence() else { return };
    let shown = super::track_of(&s.app, &s.features.captions)
        .map(|t| t.id)
        .and_then(|id| seq.captions.iter().find(|t| t.id == id));
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        if ui.button(icons::ADD).on_hover_text(tr("Add Caption at Playhead")).clicked() {
            add_at_playhead(s);
        }
        if seq.captions.len() >= 2 {
            let name = shown.as_ref().map_or(String::new(), |t| t.name.clone());
            egui::ComboBox::from_id_salt("cut-cap-track")
                .icon(crate::theme::combo_icon)
                .selected_text(name)
                .show_ui(ui, |ui| {
                    for t in &seq.captions {
                        if ui.selectable_label(shown.as_ref().is_some_and(|x| x.id == t.id), &t.name).clicked() {
                            super::choose(s, t.id);
                        }
                    }
                })
                .response
                .on_hover_text(tr("Caption track"));
        }
        if ui.button(icons::IMPORT).on_hover_text(tr("Import SRT…")).clicked() {
            super::files::ask_import(s);
        }
        if ui.button(icons::EXPORT).on_hover_text(tr("Export SRT…")).clicked() {
            super::files::ask_export(s);
        }
        if ui.button(icons::PEN).on_hover_text(tr("Caption Style…")).clicked() {
            super::style::open(s);
        }
        if ui.button(tr("Auto Captions…")).on_hover_text(tr("Create captions from the speech (on this PC)")).clicked()
        {
            let ctx = ui.ctx().clone();
            s.run_action("auto.captions", &ctx);
        }
        crate::ai::captions_menu(s, ui);
    });
    ui.separator();
    let items = shown.as_ref().map_or(&[][..], |t| t.items.as_slice());
    let foot_h = 20.0;
    let list_h = (ui.available_height() - foot_h).max(0.0);
    if items.is_empty() {
        ui.allocate_ui(Vec2::new(ui.available_width(), list_h), |ui| {
            ui.centered_and_justified(|ui| {
                ui.label(
                    RichText::new(tr(
                        "No captions. Add one at the playhead, import an SRT file, or create them from the speech with Auto Captions.",
                    ))
                    .color(pal.gray[8]),
                );
            });
        });
        return;
    }
    let track = shown.as_ref().map(|t| t.id);
    let t = s.app.t;
    let now = items.iter().position(|x| x.start <= t && t < x.end);
    egui::ScrollArea::vertical().max_height(list_h).auto_shrink([false, false]).show_rows(
        ui,
        ROW_H,
        items.len(),
        |ui, range| {
            for i in range {
                if let Some(track) = track {
                    row(s, ui, track, &items[i], i + 1, seq.fps, now == Some(i));
                }
            }
        },
    );
    let mark = marking(s);
    let unsure = items.iter().filter(|x| mark && x.doubt.as_ref().is_some_and(|d| !d.is_empty())).count();
    let n = items.len().to_string();
    let foot = if unsure > 0 {
        trf("{n} captions, {u} with uncertain words", &[("n", &n), ("u", &unsure.to_string())])
    } else {
        trf("{n} captions", &[("n", &n)])
    };
    // in from the card's edge, as the Project panel's count is
    ui.horizontal(|ui| {
        ui.add_space(10.0);
        ui.label(RichText::new(foot).size(11.0).color(pal.gray[8]));
    });
}
