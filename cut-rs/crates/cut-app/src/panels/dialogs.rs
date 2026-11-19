//! The dialogs (`ui-shell.js`, `ui-project.js`): unsaved changes, overwrite a file changed on disk, recovery after
//! a crash, Restore Autosave, the import errors, deleting a nested sequence, New Sequence. One at a time, modal.

use eframe::egui::{self, Button, RichText, Vec2};

use cut_export::presets::SEQUENCE;

use crate::cmd;
use crate::files::{self, now_ms, stamp_of};
use crate::i18n::{tr, trf};
use crate::shell::{Dialog, Shell, Then};

/// A time in ms as `YYYY-MM-DD HH:MM:SS` (UTC).
pub fn when(ms: i64) -> String {
    let s = stamp_of(ms);
    if s.len() < 15 {
        return s;
    }
    format!("{}-{}-{} {}:{}:{} UTC", &s[0..4], &s[4..6], &s[6..8], &s[9..11], &s[11..13], &s[13..15])
}

/// A dialog's row of buttons, at its right. The row is as tall as its buttons and no taller: a right-to-left layout
/// left to itself takes all the height its window may have, which set the buttons in the middle of an empty stretch
/// under the dialog's contents and made the window that much taller (the Settings window on a page with wrapped text).
pub fn buttons(ui: &mut egui::Ui, list: &[(&str, bool)]) -> Option<usize> {
    let mut out = None;
    ui.add_space(10.0);
    let row = Vec2::new(ui.available_width(), 28.0);
    ui.allocate_ui_with_layout(row, egui::Layout::right_to_left(egui::Align::Center), |ui| {
        for (i, (label, primary)) in list.iter().enumerate().rev() {
            let mut b = Button::new({
                let t = RichText::new(tr(label)).size(13.5);
                if *primary { t.color(egui::Color32::WHITE) } else { t }
            })
            .min_size(Vec2::new(84.0, 28.0));
            if *primary {
                b = b.fill(egui::Color32::from_rgb(0x35, 0x74, 0xf0)).stroke(egui::Stroke::NONE);
            }
            if ui.add(b).clicked() {
                out = Some(i);
            }
        }
    });
    out
}

#[allow(clippy::too_many_lines)]
pub fn show(s: &mut Shell, ctx: &egui::Context) {
    let Some(dialog) = s.dialog.clone() else { return };
    let mut close = false;
    let mut then: Option<Then> = None;
    let modal = egui::Modal::new(egui::Id::unique("cut-dialog")).show(ctx, |ui| {
        ui.set_width(460.0);
        match &dialog {
            Dialog::SaveChanges { then: next, closing } => {
                ui.heading(tr("Save Changes?"));
                ui.add_space(6.0);
                ui.label(trf("Save the changes to {name}?", &[("name", &s.doc.name(&s.app))]));
                ui.label(RichText::new(if *closing {
                    tr("Your changes are lost if you close without saving.")
                } else {
                    tr("Your changes are lost if you go on without saving.")
                }).color(s.palette.gray[8]));
                match buttons(ui, &[("Save", true), ("Don't Save", false), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        s.dialog = None;
                        s.save(next.clone(), ctx);
                    }
                    Some(1) => {
                        close = true;
                        s.doc.force_dirty = false;
                        then = Some(next.clone());
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            Dialog::Overwrite { path, then: next } => {
                ui.heading(tr("Save Project"));
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                ui.label(trf("{name} was changed on disk after it was opened here, by another window or program. Overwrite it with this project?", &[("name", &name)]));
                match buttons(ui, &[("Overwrite", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        s.dialog = None;
                        s.overwrite(path.clone(), next.clone(), ctx);
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            Dialog::Recovery(list) => {
                ui.heading(tr("Recover Project"));
                ui.label(tr("Nano Studio Cut did not close properly last time. These projects have changes that were autosaved but not saved:"));
                ui.add_space(6.0);
                let chosen_id = egui::Id::unique("cut-recovery-choice");
                let mut chosen: usize = ctx.data_mut(|d| d.get_temp(chosen_id)).unwrap_or(0);
                for (i, o) in list.iter().enumerate() {
                    let name = if o.key.starts_with("untitled-") {
                        tr("Untitled").into_owned()
                    } else {
                        std::path::Path::new(&o.key).file_stem().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
                    };
                    let r = ui.radio_value(&mut chosen, i, format!("{name}    {}", when(o.time)));
                    if !o.key.starts_with("untitled-") {
                        r.on_hover_text(&o.key);
                    }
                }
                ctx.data_mut(|d| d.insert_temp(chosen_id, chosen));
                match buttons(ui, &[("Recover", true), ("Discard", false)]) {
                    Some(0) => {
                        close = true;
                        if let Some(o) = list.get(chosen) {
                            if let Err(e) = s.doc.recover(&mut s.app, o, now_ms()) {
                                s.app.report(e);
                            }
                            s.timeline = crate::timeline::Timeline::default();
                            for other in list.iter().filter(|x| x.key != o.key) {
                                let _ = s.doc.projects.dismiss(&other.key);
                            }
                        }
                    }
                    Some(_) => {
                        close = true;
                        for o in list {
                            let _ = s.doc.projects.dismiss(&o.key);
                        }
                    }
                    None => {}
                }
            }
            Dialog::Autosaves(list) => {
                ui.heading(tr("Restore Autosave"));
                ui.label(trf("Choose an autosave of {name} to open in its place. The project stays unsaved until you save it.", &[("name", &s.doc.name(&s.app))]));
                let chosen_id = egui::Id::unique("cut-autosave-choice");
                let mut chosen: usize = ctx.data_mut(|d| d.get_temp(chosen_id)).unwrap_or(0);
                egui::ScrollArea::vertical().max_height(280.0).show(ui, |ui| {
                    for (i, a) in list.iter().enumerate() {
                        let kind = if a.latest { tr("Latest state") } else { tr("Autosave copy") };
                        ui.radio_value(&mut chosen, i, format!("{}    {kind}", when(a.time)));
                    }
                });
                ctx.data_mut(|d| d.insert_temp(chosen_id, chosen));
                match buttons(ui, &[("Restore", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        if let Some(a) = list.get(chosen) {
                            let offer = files::Offer { key: s.doc.key.clone(), file: a.file.clone(), time: a.time };
                            match s.doc.recover(&mut s.app, &offer, now_ms()) {
                                Ok(()) => s.app.toast(trf("Restored the autosave of {time}", &[("time", &when(a.time))])),
                                Err(e) => s.app.report(e),
                            }
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            Dialog::ImportErrors(list) => {
                ui.heading(tr("Import"));
                ui.label(tr("These files could not be imported:"));
                egui::ScrollArea::vertical().max_height(300.0).show(ui, |ui| {
                    egui::Grid::new("import-errors").num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                        for (path, reason) in list {
                            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                            ui.label(RichText::new(name).strong()).on_hover_text(path.to_string_lossy());
                            ui.label(tr(reason));
                            ui.end_row();
                        }
                    });
                });
                if buttons(ui, &[("OK", true)]).is_some() {
                    close = true;
                }
            }
            Dialog::RemoveMedia { ids, used } => {
                ui.heading(tr("Delete Nested Sequence"));
                ui.label(format!("{} {}", used.join(" "), tr("Deleting it also removes those nest clips. Delete it?")));
                match buttons(ui, &[("Delete", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        s.project.remove_now(&mut s.app, ids);
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
            Dialog::NewSequence { name, preset } => {
                ui.heading(tr("New Sequence"));
                let (mut name, mut preset) = (name.clone(), *preset);
                egui::Grid::new("new-seq").num_columns(2).spacing([12.0, 8.0]).show(ui, |ui| {
                    ui.label(tr("Name"));
                    ui.text_edit_singleline(&mut name);
                    ui.end_row();
                    ui.label(tr("Preset"));
                    egui::ComboBox::from_id_salt("seq-preset").icon(crate::theme::combo_icon).selected_text(tr(SEQUENCE[preset].name)).show_ui(ui, |ui| {
                        for (i, p) in SEQUENCE.iter().enumerate() {
                            ui.selectable_value(&mut preset, i, tr(p.name));
                        }
                    });
                    ui.end_row();
                });
                s.dialog = Some(Dialog::NewSequence { name: name.clone(), preset });
                match buttons(ui, &[("OK", true), ("Cancel", false)]) {
                    Some(0) => {
                        close = true;
                        let p = SEQUENCE[preset];
                        let opts =
                            serde_json::json!({ "name": name, "w": p.w, "h": p.h, "fps": [p.fps.num, p.fps.den] });
                        if let Some(r) = s.app.exec(&cmd::add_sequence(opts))
                            && let Some(id) = r.get("id").and_then(|v| v.as_str())
                        {
                            s.app.set_sequence(cut_model::Id::new(id));
                        }
                    }
                    Some(_) => close = true,
                    None => {}
                }
            }
        }
    });
    if modal.should_close() && !matches!(dialog, Dialog::Recovery(_)) {
        close = true;
    }
    if close {
        if matches!(s.dialog, Some(ref d) if std::mem::discriminant(d) == std::mem::discriminant(&dialog)) {
            s.dialog = None;
        }
        if let Some(t) = then {
            s.after(t, ctx);
        }
    }
}
