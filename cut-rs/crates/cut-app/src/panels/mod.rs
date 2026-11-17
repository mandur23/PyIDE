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

/// A frame around a panel group: the panel colour, a thin border, the accent border when it has the keyboard.
pub fn frame(pal: &Palette, focused: bool) -> Frame {
    Frame::new()
        .fill(pal.gray[2])
        .stroke(Stroke::new(1.0, if focused { pal.accent } else { pal.gray[3] }))
        .corner_radius(CornerRadius::same(4))
        .inner_margin(Margin::same(0))
        .outer_margin(Margin::same(2))
}

/// The whole window's layout for one frame.
pub fn layout(s: &mut Shell, ui: &mut egui::Ui) {
    if crate::view::fullscreen(s, ui, egui::ViewportId::ROOT) {
        return;
    }
    let pal = s.palette.clone();
    egui::Panel::top("menubar").frame(Frame::new().fill(pal.gray[2]).inner_margin(Margin::symmetric(4, 2))).show(
        ui,
        |ui| {
            menubar::show(s, ui);
        },
    );
    egui::Panel::top("topbar")
        .frame(
            Frame::new().fill(pal.gray[2]).inner_margin(Margin::symmetric(8, 4)).stroke(Stroke::new(1.0, pal.gray[1])),
        )
        .show(ui, |ui| topbar::show(s, ui));
    egui::Panel::bottom("status").frame(Frame::new().fill(pal.gray[2]).inner_margin(Margin::symmetric(8, 2))).show(
        ui,
        |ui| {
            status::show(s, ui);
        },
    );
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
        .resizable(true)
        .default_size(crate::workspaces::sized(s, ws, "lower", h * 0.55))
        .size_range(200.0..=(h - 160.0).max(220.0))
        .frame(Frame::new().fill(pal.gray[1]))
        .show(ui, |ui| lower(s, ui, g));
    crate::workspaces::note(s, ws, "lower", r.response.rect.height());
    let w = ui.available_width();
    let r = egui::Panel::left(("source", g))
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
        .resizable(true)
        .default_size(crate::workspaces::sized(s, ws, "project", (w * 0.27).max(240.0)))
        .size_range(200.0..=(w * 0.5).max(220.0))
        .frame(Frame::new())
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 0));
    crate::workspaces::note(s, ws, "project", r.response.rect.width());
    egui::Panel::left(("tools", g))
        .exact_size(40.0)
        .resizable(false)
        .frame(Frame::new())
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 1));
    egui::Panel::right(("meters", g))
        .exact_size(56.0)
        .resizable(false)
        .frame(Frame::new())
        .show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 3));
    egui::CentralPanel::default().frame(Frame::new()).show(ui, |ui| crate::workspaces::editing_slot(s, ui, 1, 2));
}
