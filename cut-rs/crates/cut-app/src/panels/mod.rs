//! The panels of the Editing workspace and the frames around them, in the places `ui-shell.js`'s `WORKSPACES` gives
//! them: Source (with Effect Controls) and Program above; Project (with Effects, Markers, History), Tools, Timeline
//! and Audio Meters below. Panels the native app does not have yet keep their tab, disabled.

pub mod bar;
pub mod dialogs;
pub mod history;
pub mod markers;
pub mod media_marks;
pub mod menubar;
pub mod monitor;
pub mod new_item;
pub mod project;
pub mod source;
pub mod status;
pub mod timecode;
pub mod tools;
pub mod topbar;

use eframe::egui::{self, CornerRadius, Frame, Margin, Stroke};

use crate::shell::Shell;
use crate::theme::Palette;

/// A frame around a panel group: a card as a dialog is one (the same colour, corner and edge), with the accent edge
/// when it has the keyboard.
pub fn frame(pal: &Palette, focused: bool) -> Frame {
    Frame::new()
        .fill(pal.gray[2])
        .stroke(if focused { Stroke::new(1.0, pal.accent) } else { pal.card_stroke() })
        .corner_radius(CornerRadius::same(crate::theme::CARD_RADIUS))
        .inner_margin(Margin::same(0))
        .outer_margin(Margin::same(3))
}

/// The room a tab row needs after its tabs to carry its panel's own header.
const HEADER_ROOM: f32 = 230.0;

/// Draws the header of the panel shown in a tab row after the row's tabs, when the panel has one that fits a row (the
/// monitors', the timeline's bar) and the row has the room; the panel then leaves its own header row out
/// ([`header_on_tab_row`]), and what it shows is that much taller.
pub fn header_in_tab_row(s: &mut Shell, ui: &mut egui::Ui, panel: &'static str) {
    let room = match panel {
        "program" | "source" => HEADER_ROOM,
        "timeline" if s.app.sequence_id.is_some() => s.timeline.bar_room(),
        _ => return,
    };
    if ui.available_width() < room {
        return;
    }
    ui.add_space(10.0);
    match panel {
        "program" => monitor::program_header(s, ui),
        "source" => source::header(s, ui),
        _ => {
            // the active sequence's line sits on the line under the row
            let under = ui.min_rect().bottom() + 2.0;
            let pal = s.palette.clone();
            ui.scope(|ui| {
                crate::theme::flat(ui);
                s.timeline.bar_row(ui, &mut s.app, &pal, under);
                ui.add_space(6.0);
            });
        }
    }
    let pass = ui.ctx().cumulative_pass_nr();
    ui.data_mut(|d| d.insert_temp(egui::Id::unique(("cut-header-row", panel)), pass));
}

/// Whether `panel`'s header was drawn on its tab's row in this pass.
pub fn header_on_tab_row(ui: &egui::Ui, panel: &'static str) -> bool {
    let pass = ui.ctx().cumulative_pass_nr();
    ui.data(|d| d.get_temp::<u64>(egui::Id::unique(("cut-header-row", panel)))) == Some(pass)
}

/// The whole window's layout for one frame.
pub fn layout(s: &mut Shell, ui: &mut egui::Ui) {
    if crate::view::fullscreen(s, ui, egui::ViewportId::ROOT) {
        return;
    }
    let pal = s.palette.clone();
    egui::Panel::top("menubar")
        .show_separator_line(false)
        .frame(Frame::new().fill(pal.gray[2]).inner_margin(Margin::symmetric(4, 2)))
        .show(ui, |ui| {
            menubar::show(s, ui);
        });
    egui::Panel::top("topbar")
        .show_separator_line(false)
        .frame(
            Frame::new().fill(pal.gray[2]).inner_margin(Margin::symmetric(8, 4)).stroke(Stroke::new(1.0, pal.gray[1])),
        )
        .show(ui, |ui| topbar::show(s, ui));
    crate::control::panel::banner(s, ui);
    egui::Panel::bottom("status")
        .show_separator_line(false)
        .frame(Frame::new().fill(pal.gray[2]).inner_margin(Margin::symmetric(8, 2)))
        .show(ui, |ui| {
            status::show(s, ui);
        });
    if crate::view::maximized(s, ui) {
        return;
    }
    if s.features.workspace.current != crate::workspaces::Ws::Editing {
        crate::workspaces::layout(s, ui);
        return;
    }
    let g = s.features.workspace.generation(crate::workspaces::Ws::Editing);
    let h = ui.available_height();
    let ws = crate::workspaces::Ws::Editing;
    let r = egui::Panel::bottom(("lower", g))
        .show_separator_line(false)
        .resizable(true)
        .default_size(crate::workspaces::sized(s, ws, "lower", h * 0.55))
        .size_range(200.0..=(h - 160.0).max(220.0))
        .frame(Frame::new().fill(pal.gray[1]))
        .show(ui, |ui| lower(s, ui, g));
    crate::workspaces::note(s, ws, "lower", r.response.rect.height());
    let w = ui.available_width();
    let r = egui::Panel::left(("source", g))
        .show_separator_line(false)
        .resizable(true)
        .default_size(crate::workspaces::sized(s, ws, "source", w * 0.45))
        .size_range(200.0..=(w - 240.0).max(260.0))
        .frame(Frame::new().fill(pal.gray[1]))
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 0, 0));
    crate::workspaces::note(s, ws, "source", r.response.rect.width());
    egui::CentralPanel::default()
        .frame(Frame::new().fill(pal.gray[1]))
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 0, 1));
}

fn lower(s: &mut Shell, ui: &mut egui::Ui, g: u32) {
    let w = ui.available_width();
    let ws = crate::workspaces::Ws::Editing;
    let r = egui::Panel::left(("project", g))
        .show_separator_line(false)
        .resizable(true)
        .default_size(crate::workspaces::sized(s, ws, "project", (w * 0.27).max(240.0)))
        .size_range(200.0..=(w * 0.5).max(220.0))
        .frame(Frame::new())
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 0));
    crate::workspaces::note(s, ws, "project", r.response.rect.width());
    egui::Panel::left(("tools", g))
        .show_separator_line(false)
        .exact_size(40.0)
        .resizable(false)
        .frame(Frame::new())
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 1));
    egui::Panel::right(("meters", g))
        .show_separator_line(false)
        .exact_size(56.0)
        .resizable(false)
        .frame(Frame::new())
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 3));
    egui::CentralPanel::default().frame(Frame::new()).show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 2));
}
