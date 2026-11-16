//! The Tools panel (port of `ui-toolspanel.js`): Premiere's tool groups standing in a column between the Project panel
//! and the timeline; each button shows its group's last used tool, and a right click opens the group's flyout with
//! the tools and their keys. Tools whose gestures the native timeline does not have yet are disabled in the flyout.

use eframe::egui::{self, Button, RichText, Vec2};

use crate::i18n::tr;
use crate::icons;
use crate::keys;
use crate::shell::Shell;
use crate::state::Tool;

/// The groups (`GROUPS` in ui-toolspanel.js): Selection / Track Select / Ripple, Rolling, Rate Stretch / Razor /
/// Slip, Slide / Pen / Hand, Zoom / Type.
pub const GROUPS: [&[Tool]; 8] = [
    &[Tool::Select],
    &[Tool::TrackForward, Tool::TrackBackward],
    &[Tool::Ripple, Tool::Roll, Tool::Rate],
    &[Tool::Razor],
    &[Tool::Slip, Tool::Slide],
    &[Tool::Pen],
    &[Tool::Hand, Tool::Zoom],
    &[Tool::Text],
];

/// The icon of each tool.
pub fn glyph(t: Tool) -> &'static str {
    match t {
        Tool::Select => icons::POINTER,
        Tool::TrackForward => icons::TRACK_FORWARD,
        Tool::TrackBackward => icons::TRACK_BACKWARD,
        Tool::Ripple => icons::RIPPLE,
        Tool::Roll => icons::ROLL,
        Tool::Rate => icons::RATE,
        Tool::Razor => icons::RAZOR,
        Tool::Slip => icons::SLIP,
        Tool::Slide => icons::SLIDE,
        Tool::Pen => icons::PEN,
        Tool::Hand => icons::HAND,
        Tool::Zoom => icons::ZOOM_IN,
        Tool::Text => icons::TEXT,
    }
}

fn ready(s: &Shell, t: Tool) -> bool {
    s.action_enabled(&format!("tool.{}", t.id()))
}

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    ui.vertical_centered(|ui| {
        ui.add_space(6.0);
        ui.spacing_mut().item_spacing.y = 6.0;
        for (gi, group) in GROUPS.iter().enumerate() {
            let shown = group.iter().copied().find(|t| *t == s.app.tool).unwrap_or_else(|| s.tools_last(gi));
            let active = group.contains(&s.app.tool);
            let key = keys::shown(&format!("tool.{}", shown.id()), s.preset);
            let tip = format!("{} ({key})", tr(shown.title()));
            let color = if active { egui::Color32::WHITE } else { pal.gray[10] };
            let b = Button::new(RichText::new(glyph(shown)).size(15.0).color(color))
                .fill(if active { pal.blue6 } else { egui::Color32::TRANSPARENT })
                .min_size(Vec2::splat(28.0));
            let r = ui.add_enabled(ready(s, shown), b).on_hover_text(&tip).on_disabled_hover_text(&tip);
            if r.clicked() {
                s.app.tool = shown;
            }
            if group.len() > 1 {
                let corner = r.rect.right_bottom() - Vec2::new(3.0, 3.0);
                ui.painter().line_segment([corner - Vec2::new(4.0, 0.0), corner], egui::Stroke::new(1.0, pal.gray[8]));
                ui.painter().line_segment([corner - Vec2::new(0.0, 4.0), corner], egui::Stroke::new(1.0, pal.gray[8]));
                r.context_menu(|ui| {
                    for t in group.iter().copied() {
                        let key = keys::shown(&format!("tool.{}", t.id()), s.preset);
                        let label = format!("{}  {}", glyph(t), tr(t.title()));
                        if ui.add_enabled(ready(s, t), Button::new(label).shortcut_text(key)).clicked() {
                            s.app.tool = t;
                            s.set_tools_last(gi, t);
                            ui.close();
                        }
                    }
                });
            }
            if active {
                s.set_tools_last(gi, s.app.tool);
            }
        }
    });
}
