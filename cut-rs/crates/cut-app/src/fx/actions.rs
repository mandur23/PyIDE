//! The actions of these panels: opening Effects from the Window menu (the Editing workspace's tab, or the slot of
//! the current workspace that has the panel).

use eframe::egui;

use crate::shell::{LowerTab, Shell};
use crate::state::Panel;
use crate::workspaces::Ws;

/// `Some(can run now)` for the actions these panels own.
pub fn enabled(_s: &Shell, id: &str) -> Option<bool> {
    (id == "window.effects").then_some(true)
}

/// Runs `id` when it is one of these panels' actions -> whether it was.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    if id != "window.effects" {
        return false;
    }
    if s.features.workspace.current == Ws::Editing {
        s.lower_tab = LowerTab::Effects;
    }
    crate::workspaces::show_panel(s, "effects");
    s.focus(Panel::Effects);
    true
}
