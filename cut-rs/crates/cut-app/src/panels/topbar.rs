//! The top bar (`ui-shell.js`): the app's mark and name, New/Open/Save/Import, Undo/Redo, the project's name and
//! save state, the workspace tabs, Automation and Export. Workspaces the native app does not have yet and the features
//! behind Automation it has not ported show disabled.

use eframe::egui::{self, Align, Button, Color32, CornerRadius, Layout, RichText, Stroke, Vec2};

use crate::files::now_ms;
use crate::i18n::{tr, trf};
use crate::icons;
use crate::keys;
use crate::shell::Shell;

fn icon_button(s: &mut Shell, ui: &mut egui::Ui, glyph: &str, id: &str) {
    let title = keys::action(id).map_or(id, |a| a.title);
    let key = keys::shown(id, s.preset);
    let tip = if key.is_empty() { tr(title).into_owned() } else { format!("{} ({key})", tr(title)) };
    let r = ui
        .add_enabled(
            s.action_enabled(id),
            Button::new(RichText::new(glyph).size(15.0)).frame(false).min_size(Vec2::splat(26.0)),
        )
        .on_hover_text(&tip)
        .on_disabled_hover_text(&tip);
    if r.clicked() {
        let ctx = ui.ctx().clone();
        s.run_action(id, &ctx);
    }
}

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    let narrow = ui.available_width() < 1180.0;
    ui.horizontal(|ui| {
        ui.set_min_height(30.0);
        let (mark, _) = ui.allocate_exact_size(Vec2::splat(24.0), egui::Sense::hover());
        ui.painter().rect_filled(mark, CornerRadius::same(5), pal.accent);
        ui.painter().text(
            mark.center(),
            egui::Align2::CENTER_CENTER,
            "C",
            egui::FontId::proportional(15.0),
            Color32::WHITE,
        );
        if !narrow {
            ui.label(RichText::new("Nano Studio Cut").strong().size(14.0).color(pal.gray[12]));
        }
        ui.add_space(6.0);
        icon_button(s, ui, icons::NEW, "newProject");
        icon_button(s, ui, icons::OPEN, "open");
        icon_button(s, ui, icons::SAVE, "save");
        icon_button(s, ui, icons::IMPORT, "import");
        ui.separator();
        icon_button(s, ui, icons::UNDO, "undo");
        icon_button(s, ui, icons::REDO, "redo");
        ui.add_space(8.0);
        let dirty = s.doc.dirty(&s.app);
        let name = s.doc.name(&s.app);
        let r = ui.label(RichText::new(&name).strong().color(pal.gray[12]));
        if let Some(p) = &s.app.path {
            r.on_hover_text(p.to_string_lossy());
        }
        if dirty {
            ui.label(RichText::new("●").color(pal.accent).size(10.0));
        }
        if !narrow && dirty && s.doc.last_autosave.is_none() {
            ui.label(RichText::new(tr("Modified")).color(pal.gray[8]).size(12.0));
        }
        if !narrow && let Some(at) = s.doc.last_autosave {
            let ago = (now_ms() - at) / 1000;
            ui.label(RichText::new(trf("Autosaved {time}", &[("time", &clock(at))])).color(pal.gray[8]).size(12.0))
                .on_hover_text(format!("{ago} s"));
        }
        ui.add_space(12.0);
        // Tabs that do not fit before the right-hand buttons go into » (`ui-shell.js`'s overflow menu).
        let right = 240.0;
        let current = s.features.workspace.current;
        let mut rest = Vec::new();
        for (i, ws) in crate::workspaces::Ws::ALL.into_iter().enumerate() {
            let w = ws.title();
            let wide = ui.fonts_mut(|f| {
                f.layout_no_wrap(tr(w).into_owned(), egui::FontId::proportional(13.5), Color32::WHITE).size().x
            }) + 16.0;
            if i > 0 && ui.available_width() - wide < right {
                rest.extend_from_slice(&crate::workspaces::Ws::ALL[i..]);
                break;
            }
            let active = ws == current;
            let color = if active {
                pal.gray[12]
            } else if ws.ready() {
                pal.gray[9]
            } else {
                pal.gray[6]
            };
            let b =
                Button::new(RichText::new(tr(w)).color(color).size(13.5)).frame(false).min_size(Vec2::new(0.0, 30.0));
            let r = ui.add_enabled(ws.ready(), b);
            if active {
                ui.painter().hline(r.rect.x_range(), r.rect.bottom() + 4.0, Stroke::new(2.0, pal.accent));
            }
            if r.clicked() {
                crate::workspaces::set(s, ws);
            }
            // the tab's own menu acts on its workspace, shown first
            r.context_menu(|ui| {
                for (id, label) in
                    [("workspace.reset", "Reset to Saved Layout"), ("workspace.save", "Save Changes to This Workspace")]
                {
                    if ui.button(tr(label)).clicked() {
                        crate::workspaces::set(s, ws);
                        let ctx = ui.ctx().clone();
                        s.run_action(id, &ctx);
                        ui.close();
                    }
                }
            });
            r.on_disabled_hover_text(tr("Not available yet"));
        }
        if !rest.is_empty() {
            ui.menu_button("»", |ui| {
                for ws in rest {
                    if ui.add_enabled(ws.ready(), Button::new(tr(ws.title()))).clicked() {
                        crate::workspaces::set(s, ws);
                        ui.close();
                    }
                }
            })
            .response
            .on_hover_text(tr("More Workspaces"));
        }
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let export = Button::new(
                RichText::new(format!("{}  {}", icons::EXPORT, tr("Export"))).color(Color32::WHITE).strong(),
            )
            .fill(pal.accent)
            .corner_radius(CornerRadius::same(5))
            .min_size(Vec2::new(0.0, 28.0));
            if ui.add(export).clicked() {
                let ctx = ui.ctx().clone();
                s.run_action("export", &ctx);
            }
            if ui
                .add(Button::new(RichText::new(icons::SETTINGS).size(15.0)).frame(false))
                .on_hover_text(tr("Video Editor Settings…"))
                .clicked()
            {
                let ctx = ui.ctx().clone();
                s.run_action("settings", &ctx);
            }
            crate::audio::automation_menu(s, ui);
        });
    });
}

/// `HH:MM:SS` of a time in ms, in the computer's clock as far as std knows it (UTC).
fn clock(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let (h, m, sec) = ((s / 3600) % 24, (s / 60) % 60, s % 60);
    format!("{h:02}:{m:02}:{sec:02} UTC")
}
