//! The Project panel's New Item menu and what it and the menu bar add (`ui-project.js`, `ui-menubar.js`): a Color
//! Matte (the menu bar's at once in blue, the panel's after its colour dialog), Import Folder… (a folder picked on a
//! thread of its own, `CUT_DIALOG`'s `pickFolder` answering it in tests, imported as a bin with its subfolders), and
//! Remove Unused Media… (a confirmation listing what goes; the files stay). Each change is one undo step.

use std::path::PathBuf;
use std::sync::mpsc::{Receiver, channel};

use cut_model::Id;
use cut_model::commands::build as C;
use eframe::egui::{self, Align2, Button, Color32, Vec2};
use serde_json::json;

use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The blue a new Color Matte starts as (`#2f6fdb`).
pub const MATTE: Color32 = Color32::from_rgb(0x2f, 0x6f, 0xdb);

/// This module's dialogs and the folder being picked.
#[derive(Debug, Default)]
pub struct NewItem {
    /// Color Matte's dialog and its colour.
    pub matte: Option<Color32>,
    /// Remove Unused Media's confirmation and the media it lists.
    pub unused: Option<Vec<Id>>,
    picking: Option<Receiver<Option<PathBuf>>>,
}

/// `Some(can run now)` for these actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "graphics.colorMatte" | "project.colorMatte" => Some(s.app.sequence().is_some()),
        "importFolder" | "removeUnused" => Some(true),
        _ => None,
    }
}

/// Runs one of these actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    match id {
        "graphics.colorMatte" => {
            matte(s, MATTE);
        }
        "project.colorMatte" => s.project.new_item.matte = Some(MATTE),
        "importFolder" => pick_folder(s),
        "removeUnused" => {
            let ids = super::project::unused(s.app.project());
            if ids.is_empty() {
                s.app.toast(tr("There is no unused media."));
            } else {
                s.project.new_item.unused = Some(ids);
            }
        }
        _ => return false,
    }
    true
}

/// A solid of `color` at the playhead on the patched video track, selected (`newGenerated`).
pub fn matte(s: &mut Shell, color: Color32) -> Option<Id> {
    let seq = s.app.sequence()?;
    let Some(track) = crate::edit::patch_for(seq, &s.app.edit.patch).0 else {
        s.app.toast(tr("There is no video track."));
        return None;
    };
    let hex = format!("#{:02x}{:02x}{:02x}", color.r(), color.g(), color.b());
    let cmd = C::add_generated(
        seq.id.as_str(),
        json!({
            "track": track.as_str(), "at": s.app.t, "name": tr("Color Matte"), "mode": "overwrite",
            "source": { "generator": "solid", "color": hex },
        }),
    );
    let id = s.app.exec(&cmd).and_then(|r| r["id"].as_str().map(Id::new))?;
    s.app.select([id], false, false);
    s.features.workspace.open_panel("timeline");
    Some(id)
}

fn pick_folder(s: &mut Shell) {
    if s.project.new_item.picking.is_some() {
        return;
    }
    let (tx, rx) = channel();
    if let Some(answer) = Shell::dialog_override("pickFolder") {
        let _ = tx.send(answer.and_then(|v| v.into_iter().next()));
    } else {
        let title = tr("Import Folder").into_owned();
        std::thread::spawn(move || {
            let _ = tx.send(rfd::FileDialog::new().set_title(&title).pick_folder());
        });
    }
    s.project.new_item.picking = Some(rx);
}

/// The New Item menu (`newItems`): Sequence…, Bin, Text, Color Matte…, Import Folder….
pub fn menu(s: &mut Shell, ui: &mut egui::Ui) {
    let ctx = ui.ctx().clone();
    for (id, label) in [("newSequence", "Sequence…"), ("newBin", "Bin"), ("text.newLayer", "Text")] {
        if ui.add_enabled(s.action_enabled(id), Button::new(tr(label))).clicked() {
            s.run_action(id, &ctx);
            ui.close();
        }
    }
    if ui.add_enabled(s.action_enabled("project.colorMatte"), Button::new(tr("Color Matte…"))).clicked() {
        s.run_action("project.colorMatte", &ctx);
        ui.close();
    }
    ui.separator();
    if ui.button(tr("Import Folder…")).clicked() {
        s.run_action("importFolder", &ctx);
        ui.close();
    }
}

/// The dialogs and the folder picked, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    if let Some(rx) = &s.project.new_item.picking {
        match rx.try_recv() {
            Ok(folder) => {
                s.project.new_item.picking = None;
                if let Some(f) = folder {
                    let bin = s.project.current_bin();
                    s.import_paths(vec![f], bin);
                }
            }
            Err(_) => ctx.request_repaint_after(std::time::Duration::from_millis(100)),
        }
    }
    let window = |title: &str, id: &str| {
        egui::Window::new(tr(title).into_owned())
            .id(egui::Id::unique(id))
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
    };
    if let Some(mut color) = s.project.new_item.matte {
        let mut done = None;
        window("Color Matte", "cutMatteDialog").default_width(360.0).show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(tr("Color"));
                let mut v = [color.r(), color.g(), color.b()];
                if egui::color_picker::color_edit_button_srgb(ui, &mut v).changed() {
                    color = Color32::from_rgb(v[0], v[1], v[2]);
                }
            });
            ui.horizontal(|ui| {
                if ui.button(tr("OK")).clicked() {
                    done = Some(true);
                }
                if ui.button(tr("Cancel")).clicked() {
                    done = Some(false);
                }
            });
        });
        s.project.new_item.matte = if done.is_some() { None } else { Some(color) };
        if done == Some(true) {
            matte(s, color);
        }
    }
    if let Some(ids) = s.project.new_item.unused.clone() {
        let mut done = None;
        window("Remove Unused Media", "cutRemoveUnused").default_width(480.0).show(ctx, |ui| {
            ui.label(trf(
                "Remove these {n} media items that no sequence uses from the project? The files stay where they are.",
                &[("n", &ids.len().to_string())],
            ));
            egui::ScrollArea::vertical().max_height(220.0).show(ui, |ui| {
                for m in ids.iter().filter_map(|id| s.app.project().media(*id)) {
                    ui.label(&m.name).on_hover_text(&m.path);
                }
            });
            ui.horizontal(|ui| {
                if ui.button(tr("Remove")).clicked() {
                    done = Some(true);
                }
                if ui.button(tr("Cancel")).clicked() {
                    done = Some(false);
                }
            });
        });
        if let Some(yes) = done {
            s.project.new_item.unused = None;
            // checked again: an edit may have used one since the list was made
            let now = super::project::unused(s.app.project());
            let gone: Vec<Id> = ids.into_iter().filter(|id| now.contains(id)).collect();
            if yes && !gone.is_empty() && s.app.exec(&crate::cmd::remove_media(&gone)).is_some() {
                s.app.toast(trf("{n} unused media items removed", &[("n", &gone.len().to_string())]));
            }
        }
    }
}
