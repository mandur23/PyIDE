//! The keyboard shortcut editor and the `?` cheat sheet (the screens of `ui-shortcuts.js`): every action by kind, a
//! search by name or key, Record (the next key press is the key; Tab still moves), a chip per key with its remove
//! button, Reset and Reset All, the keyboard preset; a key two actions share is marked on both and Save waits until
//! it is resolved. Save stores the keys ([`keymap::Draft::stored`]) and puts them on the keyboard at once.

use eframe::egui::{self, Color32, RichText};

use super::keymap::{self, Draft, KINDS};
use super::{Screen, set};
use crate::i18n::{tr, trf};
use crate::keys::{self, Preset};
use crate::shell::Shell;

/// Feeds the next key press to the action being recorded (`onKey`).
fn listen(d: &mut Draft, ctx: &egui::Context) {
    if d.recording.is_none() {
        return;
    }
    let events = ctx.input(|i| i.events.clone());
    for e in events {
        let egui::Event::Key { key, pressed: true, modifiers, .. } = e else { continue };
        if key == egui::Key::Tab && !modifiers.ctrl && !modifiers.alt {
            continue;
        }
        if let Some(combo) = keymap::combo_of(key, modifiers) {
            d.record(&combo);
        } else {
            d.recording = None;
        }
        break;
    }
}

fn title_of(id: &str) -> String {
    tr(keys::action(id).map_or(id, |a| a.title)).into_owned()
}

/// What a row asks for when clicked.
enum Click {
    Record(&'static str),
    Remove(&'static str, String),
    Reset(&'static str),
}

fn row(
    ui: &mut egui::Ui,
    d: &Draft,
    id: &'static str,
    clash: &std::collections::BTreeMap<String, Vec<&'static str>>,
    out: &mut Option<Click>,
) {
    let modified = d.modified(id);
    ui.horizontal(|ui| {
        let t = RichText::new(title_of(id));
        super::cell(ui, 250.0, if modified { t.strong() } else { t });
        for k in d.keys_of(id) {
            let conflict = clash.contains_key(k);
            let frame = egui::Frame::new()
                .fill(if conflict { Color32::from_rgb(0x8a, 0x2a, 0x2a) } else { ui.visuals().faint_bg_color })
                .corner_radius(3)
                .inner_margin(egui::Margin::symmetric(4, 1));
            frame.show(ui, |ui| {
                ui.spacing_mut().item_spacing.x = 2.0;
                ui.label(RichText::new(keymap::format(k)).monospace());
                let x = ui.add(egui::Button::new("×").frame(false).small());
                if x.on_hover_text(trf("Remove {key}", &[("key", &keymap::format(k))])).clicked() {
                    *out = Some(Click::Remove(id, k.clone()));
                }
            });
        }
        if d.recording == Some(id) {
            ui.label(RichText::new(tr("Press a key…")).italics());
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add_enabled(modified, egui::Button::new(tr("Reset"))).clicked() {
                *out = Some(Click::Reset(id));
            }
            let rec = if d.recording == Some(id) { tr("Cancel") } else { tr("Record") };
            if ui.button(rec).clicked() {
                *out = Some(Click::Record(id));
            }
        });
    });
    for k in d.keys_of(id) {
        if let Some(ids) = clash.get(k) {
            let others: Vec<String> = ids.iter().filter(|x| **x != id).map(|x| title_of(x)).collect();
            let text = trf("{key} is also {actions}", &[("key", &keymap::format(k)), ("actions", &others.join(", "))]);
            ui.label(RichText::new(text).color(Color32::from_rgb(0xe0, 0x60, 0x60)).size(12.0));
        }
    }
}

/// The shortcut editor, each frame while it is open.
pub fn editor(s: &mut Shell, ctx: &egui::Context) {
    let Some(Screen::Shortcuts(mut d)) = s.features.prefs.screen.take() else { return };
    let recording = d.recording.is_some();
    listen(&mut d, ctx);
    let mut close = false;
    let mut save = false;
    let modal = egui::Modal::new(egui::Id::unique("cutKeysDialog")).show(ctx, |ui| {
        ui.set_width(720.0);
        ui.heading(tr("Keyboard Shortcuts"));
        ui.horizontal(|ui| {
            ui.label(tr("Keyboard Layout Preset"));
            for p in [Preset::Premiere, Preset::Classic] {
                if ui.selectable_label(d.preset == p, tr(p.title())).clicked() && d.preset != p {
                    d.set_preset(p);
                }
            }
        });
        ui.label(
            RichText::new(tr("Click Record, then press the key. Keys apply as soon as you save; a key two actions share must be changed first."))
                .color(s.palette.gray[8])
                .size(12.0),
        );
        ui.add(egui::TextEdit::singleline(&mut d.query).hint_text(tr("Search actions or keys")).desired_width(f32::INFINITY));
        let clash = d.conflicts();
        let mut click = None;
        egui::ScrollArea::vertical().max_height((ctx.content_rect().height() - 260.0).max(160.0)).show(ui, |ui| {
            let rows = d.rows();
            if rows.is_empty() {
                ui.label(tr("No actions found"));
            }
            for (kind, ids) in rows {
                let title = KINDS.iter().find(|(k, _)| *k == kind).map_or(kind, |(_, t)| t);
                ui.add_space(4.0);
                ui.label(RichText::new(tr(title)).strong().color(s.palette.accent));
                for id in ids {
                    row(ui, &d, id, &clash, &mut click);
                }
            }
        });
        match click {
            Some(Click::Record(id)) => d.recording = if d.recording == Some(id) { None } else { Some(id) },
            Some(Click::Remove(id, k)) => d.remove(id, &k),
            Some(Click::Reset(id)) => d.reset(id),
            None => {}
        }
        if !clash.is_empty() {
            let n = clash.len().to_string();
            let text = trf("Keys used by more than one action: {n}. Change or remove them to save.", &[("n", &n)]);
            ui.label(RichText::new(text).color(Color32::from_rgb(0xe0, 0x60, 0x60)));
        }
        ui.separator();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button(tr("Cancel")).clicked() {
                close = true;
            }
            if ui.add_enabled(d.any_modified(), egui::Button::new(tr("Reset All"))).clicked() {
                d.reset_all();
            }
            if ui.add_enabled(clash.is_empty(), egui::Button::new(tr("Save"))).clicked() {
                save = true;
            }
        });
    });
    // Escape while recording is the key being recorded, not the dialog closing.
    if modal.should_close() && !recording {
        close = true;
    }
    if save {
        let old = keymap::parse_stored(s.doc.settings.get(keymap::SETTING));
        let stored = d.stored(&old);
        if d.preset != s.preset {
            s.preset = d.preset;
            s.doc.set_setting("keyPreset", d.preset.code());
        }
        set(s, keymap::SETTING, stored);
        super::start(&s.doc);
        s.app.toast(tr("Keyboard shortcuts saved"));
        return;
    }
    if !close {
        s.features.prefs.screen = Some(Screen::Shortcuts(d));
    }
}

/// The cheat sheet: the actions with keys by kind, their keys as they are now; Esc or the help key closes it.
pub fn sheet(s: &mut Shell, ctx: &egui::Context) {
    let help: Vec<keys::Combo> = keys::current("keyHelp", s.preset).iter().filter_map(|k| keys::parse(k)).collect();
    // the key press that opened it is not the one that closes it
    if s.features.prefs.sheet != Some(ctx.cumulative_frame_nr()) {
        for e in ctx.input(|i| i.events.clone()) {
            if let egui::Event::Key { key, pressed: true, modifiers, repeat: false, .. } = e
                && (key == egui::Key::Escape || help.iter().any(|c| keys::matches(*c, key, modifiers)))
            {
                s.features.prefs.sheet = None;
                return;
            }
        }
    }
    let mut edit = false;
    let modal = egui::Modal::new(egui::Id::unique("cut-keysheet")).show(ctx, |ui| {
        let width = (ctx.content_rect().width() - 80.0).clamp(400.0, 1100.0);
        ui.set_width(width);
        let n = if width < 900.0 { 2 } else { 3 };
        let col = width / n as f32 - 12.0;
        ui.horizontal(|ui| {
            ui.heading(tr("Keyboard Shortcuts"));
            let keys =
                keys::current("keyHelp", s.preset).iter().map(|k| keymap::format(k)).collect::<Vec<_>>().join(" / ");
            ui.label(RichText::new(trf("Press {key} or Esc to close", &[("key", &keys)])).color(s.palette.gray[8]));
            if ui.button(tr("Edit Shortcuts…")).clicked() {
                edit = true;
            }
        });
        egui::ScrollArea::vertical().max_height(ctx.content_rect().height() * 0.7).show(ui, |ui| {
            ui.columns(n, |cols| {
                let mut k = 0;
                for (kind, title) in KINDS {
                    let mut list: Vec<(String, Vec<String>)> = keys::ACTIONS
                        .iter()
                        .filter(|a| keymap::kind_of(a.id) == kind)
                        .map(|a| (tr(a.title).into_owned(), keys::current(a.id, s.preset)))
                        .filter(|(_, k)| !k.is_empty())
                        .collect();
                    if list.is_empty() {
                        continue;
                    }
                    list.sort_by_key(|a| a.0.to_lowercase());
                    let ui = &mut cols[k % n];
                    k += 1;
                    ui.label(RichText::new(tr(title)).strong().color(s.palette.accent));
                    for (name, keys) in list {
                        ui.horizontal(|ui| {
                            super::cell(ui, col * 0.6, name);
                            let text = keys.iter().map(|x| keymap::format(x)).collect::<Vec<_>>().join("  ");
                            super::cell(ui, col * 0.4, RichText::new(text).monospace());
                        });
                    }
                    ui.add_space(8.0);
                }
            });
        });
    });
    if modal.should_close() {
        s.features.prefs.sheet = None;
    }
    if edit {
        s.features.prefs.sheet = None;
        s.features.prefs.screen = Some(Screen::Shortcuts(Draft::new(s.preset)));
    }
}
