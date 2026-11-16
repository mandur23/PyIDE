//! The dialogs the editing actions open (ports of `speedDialog` and `nestDialog` in `ui-timeline.js`, `edit` in
//! `ui-markers.js`, `newSequenceDialog(app, seq)` in `ui-project.js`, and the prompts of the transition, clip and
//! track menus). Each OK is one undo step; a field keeps its text until OK reads it.

use cut_model::{Id, MarkerKind};
use cut_time::{FRAME_RATES, Ticks, parse_timecode, timecode};
use eframe::egui::{self, Button, RichText, Vec2};
use serde_json::json;

use super::markers::{COLORS, KINDS};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use cut_model::commands::build as C;

/// The dialog on screen and what its fields hold.
#[derive(Debug, Clone, PartialEq)]
pub enum EditDialog {
    /// Clip Speed / Duration for the selected clips (`clips[0]` gives the values shown).
    Speed {
        clips: Vec<Id>,
        speed: String,
        duration: String,
        reverse: bool,
        ripple: bool,
        still: bool,
    },
    Nest {
        clips: Vec<Id>,
        name: String,
    },
    Marker {
        id: Id,
        clip: bool,
        name: String,
        note: String,
        t: String,
        duration: String,
        kind: MarkerKind,
        color: &'static str,
    },
    Sequence {
        id: Id,
        name: String,
        preset: Option<usize>,
        w: i64,
        h: i64,
        fps: usize,
        background: String,
    },
    TransitionLength {
        id: Id,
        text: String,
    },
    RenameClip {
        id: Id,
        name: String,
    },
    RenameTrack {
        id: Id,
        name: String,
    },
    /// The track menu's Set Volume… (`askVolume`): a percentage, 0 to 200.
    TrackVolume {
        id: Id,
        text: String,
    },
    /// Delete Track of a track with clips: asked first.
    DeleteTrack {
        id: Id,
        name: String,
    },
}

impl EditDialog {
    /// The Speed/Duration dialog for the selection, or why there is none.
    pub fn speed(app: &crate::state::App) -> Result<EditDialog, &'static str> {
        let seq = app.sequence().ok_or("Select a clip first.")?;
        let clips: Vec<&cut_model::Clip> = app.selected().iter().filter_map(|id| seq.clip(*id)).collect();
        let c = clips.first().ok_or("Select a clip first.")?;
        if clips.iter().any(|x| x.remap.is_some()) {
            return Err("This clip has Time Remapping. Change its speed with Time Remapping.");
        }
        Ok(EditDialog::Speed {
            clips: clips.iter().map(|x| x.id).collect(),
            speed: format!("{}", (c.speed * 1000.0).round() / 10.0),
            duration: timecode(c.duration(), seq.fps),
            reverse: c.reverse,
            ripple: true,
            still: app.project().is_still(c),
        })
    }

    /// The Nested Sequence Name dialog: the first free "Nested Sequence N".
    pub fn nest(app: &crate::state::App) -> Result<EditDialog, &'static str> {
        let clips = app.selected();
        if clips.is_empty() {
            return Err("Select the clips to nest.");
        }
        Ok(EditDialog::Nest { clips, name: free_nest_name(app.project()) })
    }

    /// The marker dialog of a sequence or clip marker.
    pub fn marker(app: &crate::state::App, id: Id) -> Option<EditDialog> {
        let seq = app.sequence()?;
        let row = super::markers::markers_of(seq).into_iter().find(|r| r.marker.id == id)?;
        let m = &row.marker;
        let color = COLORS.iter().find(|c| c.0 == m.color).map_or(COLORS[0].0, |c| c.0);
        Some(EditDialog::Marker {
            id,
            clip: row.clip.is_some(),
            name: m.name.clone(),
            note: m.note.clone(),
            t: timecode(row.t, seq.fps),
            duration: timecode(m.duration, seq.fps),
            kind: m.kind,
            color,
        })
    }

    /// Sequence Settings of a sequence.
    pub fn sequence(app: &crate::state::App, id: Id) -> Option<EditDialog> {
        let seq = app.project().sequence(id)?;
        Some(EditDialog::Sequence {
            id,
            name: seq.name.clone(),
            preset: None,
            w: seq.w,
            h: seq.h,
            fps: FRAME_RATES.iter().position(|r| *r == seq.fps).unwrap_or(4),
            background: seq.background.clone(),
        })
    }
}

/// The first "Nested Sequence N" no sequence is called.
pub fn free_nest_name(p: &cut_model::Project) -> String {
    (1..)
        .map(|n| trf("Nested Sequence {n}", &[("n", &n.to_string())]))
        .find(|n| !p.sequences.iter().any(|s| &s.name == n))
        .unwrap_or_default()
}

/// The patch of each selected clip that Speed/Duration's OK sets (`speedDialog`'s OK): only what changed, and only
/// clips something changed for.
pub fn speed_patches(
    seq: &cut_model::Sequence,
    clips: &[Id],
    speed_pct: f64,
    duration: Option<Ticks>,
    reverse: bool,
    ripple: bool,
    still: bool,
) -> Vec<(Id, serde_json::Value)> {
    let Some(c) = clips.first().and_then(|id| seq.clip(*id)) else { return Vec::new() };
    let d0 = c.duration();
    clips
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter_map(|x| {
            let mut patch = json!({ "ripple": ripple });
            if !still && (speed_pct / 100.0 - c.speed).abs() > 1e-9 {
                patch["speed"] = json!(speed_pct / 100.0);
            } else if let Some(d) = duration.filter(|d| *d != d0) {
                patch["duration"] = json!(d);
            }
            if !still && reverse != x.reverse {
                patch["reverse"] = json!(reverse);
            }
            (patch.as_object().map_or(0, serde_json::Map::len) > 1).then_some((x.id, patch))
        })
        .collect()
}

fn buttons(ui: &mut egui::Ui, list: &[(&str, bool)]) -> Option<usize> {
    let mut out = None;
    ui.add_space(10.0);
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        for (i, (label, primary)) in list.iter().enumerate().rev() {
            let mut b = Button::new(RichText::new(tr(label)).size(13.5)).min_size(Vec2::new(84.0, 28.0));
            if *primary {
                b = b.fill(egui::Color32::from_rgb(0x35, 0x74, 0xf0));
            }
            if ui.add(b).clicked() {
                out = Some(i);
            }
        }
    });
    out
}

fn row(ui: &mut egui::Ui, label: &str, add: impl FnOnce(&mut egui::Ui)) {
    ui.label(tr(label));
    add(ui);
    ui.end_row();
}

/// Runs a list of commands as one step named `label`, reporting a refusal.
fn batch(s: &mut Shell, label: &str, list: Vec<serde_json::Value>) -> Option<serde_json::Value> {
    if list.is_empty() {
        return None;
    }
    s.app.exec(&C::batch(label, list))
}

/// Draws the dialog that is open, if any.
#[allow(clippy::too_many_lines)]
pub fn show(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut d) = s.app.edit.dialog.clone() else { return };
    let fps = s.app.sequence().map_or(cut_time::Fps { num: 30, den: 1 }, |q| q.fps);
    let mut close = false;
    let modal = egui::Modal::new(egui::Id::unique("cut-edit-dialog")).show(ctx, |ui| {
        ui.set_width(420.0);
        let grid = |ui: &mut egui::Ui, id: &str, f: &mut dyn FnMut(&mut egui::Ui)| {
            egui::Grid::new(id).num_columns(2).spacing([12.0, 8.0]).show(ui, |ui| f(ui));
        };
        match &mut d {
            EditDialog::Speed { clips, speed, duration, reverse, ripple, still } => {
                ui.heading(tr("Clip Speed / Duration"));
                grid(ui, "speed", &mut |ui| {
                    if !*still {
                        row(ui, "Speed", |ui| {
                            ui.horizontal(|ui| {
                                ui.add(egui::TextEdit::singleline(speed).desired_width(80.0));
                                ui.label("%");
                            });
                        });
                    }
                    row(ui, "Duration", |ui| {
                        ui.add(egui::TextEdit::singleline(duration).desired_width(120.0).font(egui::TextStyle::Monospace));
                    });
                    if !*still {
                        row(ui, "Reverse Speed", |ui| {
                            ui.checkbox(reverse, "");
                        });
                    }
                    row(ui, "Ripple Edit, Shifting Trailing Clips", |ui| {
                        ui.checkbox(ripple, "");
                    });
                });
                match buttons(ui, &[("OK", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        let pct = speed.trim().trim_end_matches('%').trim().parse::<f64>().unwrap_or(100.0).clamp(1.0, 10000.0);
                        let dur = parse_timecode(duration, fps, 0);
                        if let Some(seq) = s.app.sequence() {
                            let sid = seq.id;
                            let list = speed_patches(seq, clips, pct, dur, *reverse, *ripple, *still)
                                .into_iter()
                                .map(|(id, p)| C::set_clip(sid.as_str(), id.as_str(), p, json!({})))
                                .collect();
                            batch(s, "Clip Settings", list);
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            EditDialog::Nest { clips, name } => {
                ui.heading(tr("Nested Sequence Name"));
                grid(ui, "nest", &mut |ui| row(ui, "Name", |ui| {
                    ui.text_edit_singleline(name).request_focus();
                }));
                match buttons(ui, &[("OK", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        let n = if name.trim().is_empty() { free_nest_name(s.app.project()) } else { name.trim().to_owned() };
                        if let Some(seq) = s.app.sequence_id {
                            let ids: Vec<&str> = clips.iter().map(|c| c.as_str()).collect();
                            let c = C::nest(seq.as_str(), &ids, json!({ "name": n, "linked": s.app.linked_selection }));
                            if let Some(r) = s.app.exec(&c) {
                                let made = r["ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(Id::new);
                                s.app.select(made, false, false);
                            }
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            EditDialog::Marker { id, clip, name, note, t, duration, kind, color } => {
                ui.heading(if *clip { tr("Clip Marker") } else { tr("Marker") });
                grid(ui, "marker", &mut |ui| {
                    row(ui, "Name", |ui| {
                        ui.text_edit_singleline(name);
                    });
                    row(ui, "Comment", |ui| {
                        ui.add(egui::TextEdit::multiline(note).desired_rows(3));
                    });
                    row(ui, "Time", |ui| {
                        ui.add(egui::TextEdit::singleline(t).font(egui::TextStyle::Monospace));
                    });
                    row(ui, "Duration", |ui| {
                        ui.add(egui::TextEdit::singleline(duration).font(egui::TextStyle::Monospace));
                    });
                    row(ui, "Type", |ui| {
                        egui::ComboBox::from_id_salt("marker-kind").selected_text(tr(super::markers::kind_name(*kind))).show_ui(ui, |ui| {
                            for (k, label) in KINDS {
                                ui.selectable_value(kind, k, tr(label));
                            }
                        });
                    });
                    row(ui, "Color", |ui| {
                        let shown = COLORS.iter().find(|c| c.0 == *color).map_or("Green", |c| c.1);
                        egui::ComboBox::from_id_salt("marker-color").selected_text(tr(shown)).show_ui(ui, |ui| {
                            for (k, label, _) in COLORS {
                                ui.selectable_value(color, k, tr(label));
                            }
                        });
                    });
                });
                match buttons(ui, &[("OK", true), ("Delete", false), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        marker_ok(s, *id, name, note, t, duration, *kind, color);
                    }
                    Some(1) => {
                        close = true;
                        if let Some(seq) = s.app.sequence_id {
                            s.app.exec(&C::remove_marker(seq.as_str(), id.as_str()));
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            EditDialog::Sequence { id, name, preset, w, h, fps: rate, background } => {
                ui.heading(tr("Sequence Settings"));
                grid(ui, "sequence", &mut |ui| {
                    row(ui, "Name", |ui| {
                        ui.text_edit_singleline(name);
                    });
                    row(ui, "Preset", |ui| {
                        let list = cut_export::presets::SEQUENCE;
                        let shown = preset.map_or_else(|| tr("Custom").into_owned(), |i| tr(list[i].name).into_owned());
                        egui::ComboBox::from_id_salt("seq-settings-preset").selected_text(shown).show_ui(ui, |ui| {
                            for (i, p) in list.iter().enumerate() {
                                if ui.selectable_label(*preset == Some(i), tr(p.name)).clicked() {
                                    *preset = Some(i);
                                    (*w, *h) = (i64::from(p.w), i64::from(p.h));
                                    *rate = FRAME_RATES.iter().position(|r| *r == p.fps).unwrap_or(4);
                                }
                            }
                            if ui.selectable_label(preset.is_none(), tr("Custom")).clicked() {
                                *preset = None;
                            }
                        });
                    });
                    row(ui, "Width", |ui| {
                        ui.add(egui::DragValue::new(w).range(16..=7680).speed(2).suffix(" px"));
                    });
                    row(ui, "Height", |ui| {
                        ui.add(egui::DragValue::new(h).range(16..=4320).speed(2).suffix(" px"));
                    });
                    row(ui, "Frame rate", |ui| {
                        egui::ComboBox::from_id_salt("seq-settings-fps").selected_text(fps_label(*rate)).show_ui(ui, |ui| {
                            for i in 0..FRAME_RATES.len() {
                                ui.selectable_value(rate, i, fps_label(i));
                            }
                        });
                    });
                    row(ui, "Sample rate", |ui| {
                        ui.label("48 kHz");
                    });
                    row(ui, "Background", |ui| {
                        let mut c = parse_hex(background);
                        if ui.color_edit_button_srgb(&mut c).changed() {
                            *background = format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]);
                        }
                    });
                });
                match buttons(ui, &[("OK", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        let r = FRAME_RATES[(*rate).min(FRAME_RATES.len() - 1)];
                        let n = if name.trim().is_empty() { tr("Sequence").into_owned() } else { name.trim().to_owned() };
                        let opts = json!({
                            "name": n, "w": *w - *w % 2, "h": *h - *h % 2, "fps": [r.num, r.den], "background": background,
                        });
                        s.app.exec(&C::set_sequence(id.as_str(), opts));
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            EditDialog::TransitionLength { id, text } => {
                ui.heading(tr("Set Duration…").trim_end_matches('…'));
                ui.label(tr("Transition duration (timecode or frames)"));
                ui.add(egui::TextEdit::singleline(text).font(egui::TextStyle::Monospace)).request_focus();
                match buttons(ui, &[("OK", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        if let (Some(d), Some(seq)) = (parse_timecode(text, fps, 0).filter(|d| *d > 0), s.app.sequence_id) {
                            s.app.exec(&C::set_transition(seq.as_str(), id.as_str(), json!({ "duration": d })));
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            EditDialog::RenameClip { id, name } => {
                if let Some(text) = prompt(ui, "Clip name", name, &mut close)
                    && let Some(seq) = s.app.sequence_id
                {
                    s.app.exec(&C::set_clip(seq.as_str(), id.as_str(), json!({ "name": text }), json!({})));
                }
            }
            EditDialog::RenameTrack { id, name } => {
                if let Some(text) = prompt(ui, "Track name", name, &mut close).filter(|t| !t.trim().is_empty())
                    && let Some(seq) = s.app.sequence_id
                {
                    s.app.exec(&C::set_track(seq.as_str(), id.as_str(), json!({ "name": text.trim() })));
                }
            }
            EditDialog::TrackVolume { id, text } => {
                let typed = prompt(ui, "Track volume (0 to 200%)", text, &mut close);
                if let Some(pct) = typed.and_then(|t| t.replace('%', "").trim().parse::<f64>().ok()).filter(|p| p.is_finite())
                    && let Some(seq) = s.app.sequence_id
                {
                    let db = crate::timeline::editing::track_db(pct);
                    s.app.exec(&C::set_track(seq.as_str(), id.as_str(), json!({ "volume": db })));
                }
            }
            EditDialog::DeleteTrack { id, name } => {
                ui.label(trf("Delete track {name} and its clips?", &[("name", name)]));
                match buttons(ui, &[("Delete", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        if let Some(seq) = s.app.sequence_id {
                            s.app.exec(&C::remove_track(seq.as_str(), id.as_str()));
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
        }
    });
    if modal.should_close() {
        close = true;
    }
    s.app.edit.dialog = if close { None } else { Some(d) };
}

/// A one-field prompt (`ide.ui.prompt`): the text on OK.
fn prompt(ui: &mut egui::Ui, label: &str, text: &mut String, close: &mut bool) -> Option<String> {
    ui.label(tr(label));
    ui.text_edit_singleline(text).request_focus();
    match buttons(ui, &[("OK", true), ("Cancel", false)]) {
        Some(0) => {
            *close = true;
            Some(text.clone())
        }
        Some(_) => {
            *close = true;
            None
        }
        None => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn marker_ok(s: &mut Shell, id: Id, name: &str, note: &str, t: &str, duration: &str, kind: MarkerKind, color: &str) {
    let Some(seq) = s.app.sequence() else { return };
    let fps = seq.fps;
    let Some(now) = super::markers::markers_of(seq).into_iter().find(|r| r.marker.id == id) else { return };
    let dur = parse_timecode(duration, fps, 0).unwrap_or(now.marker.duration);
    let mut patch = json!({ "name": name, "note": note, "kind": kind, "color": color, "duration": dur });
    let at = parse_timecode(t, fps, 0).unwrap_or(now.t);
    if at != now.t {
        patch["t"] = json!(at);
    }
    let m = &now.marker;
    let same =
        at == now.t && m.name == name && m.note == note && m.kind == kind && m.color == color && m.duration == dur;
    if !same {
        let sid = seq.id;
        s.app.exec(&C::set_marker(sid.as_str(), id.as_str(), patch));
    }
}

/// A frame rate as the menus write it (`fpsLabel`): 29.97, 30 ...
pub fn fps_label(i: usize) -> String {
    let r = FRAME_RATES[i.min(FRAME_RATES.len() - 1)];
    let v = f64::from(r.num) / f64::from(r.den);
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} fps")
}

fn parse_hex(s: &str) -> [u8; 3] {
    let h = s.trim_start_matches('#');
    let b = |i: usize| h.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(0);
    [b(0), b(2), b(4)]
}
