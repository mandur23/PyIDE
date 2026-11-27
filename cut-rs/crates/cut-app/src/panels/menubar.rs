//! The menu bar (port of `ui-menubar.js`): Premiere's File, Edit, Clip, Sequence, Markers, Graphics and Titles, View,
//! Window and Help, each item an action with its key from the keymap. Items whose feature the native app does not
//! have yet are shown disabled, not left out.

use eframe::egui::{self, Button, RichText};

use crate::cmd;
use crate::i18n::tr;
use crate::keys;
use crate::shell::{Shell, Then};

fn item(s: &mut Shell, ui: &mut egui::Ui, id: &str, label: Option<&str>) {
    let title = label.unwrap_or_else(|| keys::action(id).map_or(id, |a| a.title));
    let key = keys::shown(id, s.preset);
    let enabled = s.action_enabled(id);
    let r = ui.add_enabled(enabled, Button::new(tr(title)).shortcut_text(key));
    if r.clicked() {
        let ctx = ui.ctx().clone();
        s.run_action(id, &ctx);
        ui.close();
    }
}

fn checked(ui: &mut egui::Ui, label: &str, on: bool) -> bool {
    let text = if on { format!("{}  {}", crate::icons::CHECK, tr(label)) } else { format!("     {}", tr(label)) };
    let r = ui.button(text).clicked();
    if r {
        ui.close();
    }
    r
}

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    egui::MenuBar::new().ui(ui, |ui| {
        ui.menu_button(RichText::new(tr("File")), |ui| file(s, ui));
        ui.menu_button(tr("Edit"), |ui| edit(s, ui));
        ui.menu_button(tr("Clip"), |ui| clip(s, ui));
        ui.menu_button(tr("Sequence"), |ui| sequence(s, ui));
        ui.menu_button(tr("Markers"), |ui| markers(s, ui));
        ui.menu_button(tr("Graphics and Titles"), |ui| {
            ui.menu_button(tr("New Layer"), |ui| {
                item(s, ui, "text.newLayer", Some("Text"));
                item(s, ui, "graphics.colorMatte", Some("Color Matte"));
            });
            item(s, ui, "tool.text", None);
            ui.separator();
            item(s, ui, "captions.import", Some("Import Captions…"));
            item(s, ui, "captions.export", Some("Export Captions…"));
            item(s, ui, "captions.style", Some("Caption Style…"));
        });
        ui.menu_button(tr("View"), |ui| {
            ui.menu_button(tr("Playback Resolution"), |ui| {
                let q = crate::prefs::number(&s.doc.settings, "quality");
                for (v, label) in [(1.0, "Full"), (0.5, "1/2"), (0.25, "1/4")] {
                    if checked(ui, label, q == v) {
                        crate::prefs::set(s, "quality", serde_json::json!(v));
                    }
                }
            });
            if checked(ui, "Play Proxies", crate::prefs::flag(&s.doc.settings, "proxy")) {
                let ctx = ui.ctx().clone();
                s.run_action("proxy.toggle", &ctx);
            }
            if checked(ui, "Safe Margins", crate::prefs::flag(&s.doc.settings, "program.safe")) {
                let on = !crate::prefs::flag(&s.doc.settings, "program.safe");
                crate::prefs::set(s, "program.safe", serde_json::json!(on));
            }
            ui.separator();
            item(s, ui, "fullscreen", None);
            item(s, ui, "maximizePanel", None);
            item(s, ui, "maximizeUnderCursor", None);
            ui.separator();
            if checked(ui, "Timeline Tool Bar", crate::prefs::flag(&s.doc.settings, "timelineTools")) {
                let on = !crate::prefs::flag(&s.doc.settings, "timelineTools");
                crate::prefs::set(s, "timelineTools", serde_json::json!(on));
            }
            item(s, ui, "keyHelp", None);
        });
        ui.menu_button(tr("Window"), |ui| {
            ui.menu_button(tr("Workspaces"), |ui| {
                for id in [
                    "workspace.editing",
                    "workspace.color",
                    "workspace.effects",
                    "workspace.audio",
                    "workspace.captions",
                    "workspace.export",
                ] {
                    item(s, ui, id, None);
                }
                ui.separator();
                item(s, ui, "workspace.reset", None);
                item(s, ui, "workspace.save", Some("Save Changes to This Workspace"));
                crate::workspaces::layouts_menu(s, ui);
            });
            ui.separator();
            crate::workspaces::panels_menu(s, ui);
            crate::windows::menu(s, ui);
        });
        ui.menu_button(tr("Help"), |ui| {
            item(s, ui, "keyHelp", None);
            item(s, ui, "keyboardShortcuts", None);
            item(s, ui, "findAction", Some("Find Action…"));
            ui.separator();
            item(s, ui, "checkForUpdates", Some("Check for Updates…"));
            item(s, ui, "about", Some(crate::update::KO[0].0));
        });
    });
    crate::update::about(ui.ctx());
}

fn file(s: &mut Shell, ui: &mut egui::Ui) {
    ui.menu_button(tr("New"), |ui| {
        item(s, ui, "newProject", Some("Project…"));
        item(s, ui, "newSequence", Some("Sequence…"));
        item(s, ui, "newBin", Some("Bin"));
    });
    item(s, ui, "open", None);
    let recent = s.doc.recent();
    ui.add_enabled_ui(!recent.is_empty(), |ui| {
        ui.menu_button(tr("Recent Projects"), |ui| {
            for p in recent {
                let label = p.file_stem().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                if ui.button(label).on_hover_text(p.to_string_lossy()).clicked() {
                    let ctx = ui.ctx().clone();
                    s.guard(Then::Open(Some(p)), &ctx);
                    ui.close();
                }
            }
        });
    });
    ui.separator();
    item(s, ui, "save", Some("Save"));
    item(s, ui, "saveAs", Some("Save As…"));
    item(s, ui, "saveCopy", None);
    item(s, ui, "restoreAutosave", None);
    ui.separator();
    item(s, ui, "import", Some("Import…"));
    item(s, ui, "importFolder", Some("Import Folder…"));
    item(s, ui, "findMissing", None);
    ui.separator();
    ui.menu_button(tr("Export"), |ui| {
        item(s, ui, "export", Some("Media…"));
        item(s, ui, "exportFrame", Some("Frame…"));
        item(s, ui, "captions.export", Some("Captions…"));
    });
}

fn edit(s: &mut Shell, ui: &mut egui::Ui) {
    for id in ["undo", "redo"] {
        item(s, ui, id, None);
    }
    ui.separator();
    for id in ["cut", "copy", "paste", "pasteInsert"] {
        item(s, ui, id, None);
    }
    ui.separator();
    item(s, ui, "delete", None);
    item(s, ui, "rippleDelete", None);
    ui.separator();
    item(s, ui, "selectAll", None);
    item(s, ui, "deselect", None);
    ui.separator();
    item(s, ui, "selectUnused", None);
    item(s, ui, "removeUnused", None);
    ui.separator();
    item(s, ui, "keyboardShortcuts", None);
    item(s, ui, "settings", Some("Preferences…"));
}

fn clip(s: &mut Shell, ui: &mut egui::Ui) {
    item(s, ui, "speed", None);
    ui.separator();
    item(s, ui, "insert", None);
    item(s, ui, "overwrite", None);
    ui.separator();
    for id in ["toggleEnabled", "link", "group", "ungroup"] {
        item(s, ui, id, None);
    }
    ui.separator();
    item(s, ui, "nest", None);
    ui.separator();
    ui.menu_button(tr("Video Options"), |ui| {
        item(s, ui, "freezeFrame", None);
        crate::edit::menus::time_interpolation(s, ui);
    });
    ui.menu_button(tr("Proxy"), |ui| {
        item(s, ui, "createProxy", None);
        item(s, ui, "proxy.cancel", Some("Cancel Proxy"));
        item(s, ui, "proxy.remove", Some("Remove Proxy"));
    });
    ui.separator();
    item(s, ui, "nudgeUp", None);
    item(s, ui, "nudgeDown", None);
}

fn sequence(s: &mut Shell, ui: &mut egui::Ui) {
    crate::edit::menus::sequence_settings(s, ui);
    ui.separator();
    for id in ["matchFrame", "split", "splitAll", "rippleStart", "rippleEnd", "extendEdit"] {
        item(s, ui, id, None);
    }
    ui.separator();
    for id in ["transitionVideo", "transitionAudio", "transitionBoth"] {
        item(s, ui, id, None);
    }
    ui.separator();
    item(s, ui, "lift", None);
    item(s, ui, "extract", None);
    ui.separator();
    for id in ["zoomIn", "zoomOut", "zoomFit"] {
        item(s, ui, id, None);
    }
    ui.separator();
    if checked(ui, "Snap in Timeline", s.app.snapping) {
        s.app.snapping = !s.app.snapping;
    }
    ui.separator();
    let seq = s.app.sequence_id;
    for (label, kind) in [("Add Video Track", "video"), ("Add Audio Track", "audio")] {
        if ui.add_enabled(seq.is_some(), Button::new(tr(label))).clicked() {
            if let Some(id) = seq {
                s.app.exec(&cmd::add_track(id, kind));
            }
            ui.close();
        }
    }
}

fn markers(s: &mut Shell, ui: &mut egui::Ui) {
    for id in ["markIn", "markOut", "markClip", "markSelection"] {
        item(s, ui, id, None);
    }
    ui.separator();
    item(s, ui, "playInToOut", None);
    if checked(ui, "Loop", s.features.view.looping) {
        s.features.view.looping = !s.features.view.looping;
    }
    ui.separator();
    item(s, ui, "goIn", None);
    item(s, ui, "goOut", None);
    ui.separator();
    for id in ["clearIn", "clearOut", "clearInOut"] {
        item(s, ui, id, None);
    }
    ui.separator();
    for id in ["addMarker", "nextMarker", "prevMarker", "clearMarker", "clearAllMarkers"] {
        item(s, ui, id, None);
    }
    crate::edit::menus::edit_marker(s, ui);
}
