//! The History panel (port of `ui-history.js`): the undo steps oldest first, the ones that can be redone dimmed; a
//! click goes to that step at once (`history.goTo`).

use eframe::egui::{self, RichText, Sense, Vec2};

use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::Panel;

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    let n = s.app.history.steps();
    let position = s.app.history.position();
    let mut go = None;
    let row_h = 24.0;
    // only the rows in view are made (the state before the first step, then each step)
    egui::ScrollArea::vertical()
        .max_height(ui.available_height() - 24.0)
        .auto_shrink([false, false])
        .stick_to_bottom(true)
        .show_rows(ui, row_h, n + 1, |ui, rows| {
            let w = ui.available_width();
            for i in rows {
                let (label, done) = match i.checked_sub(1) {
                    None => (tr("Start").into_owned(), true),
                    Some(k) => s.app.history.step(k).map_or((String::new(), false), |(l, d)| (tr(l).into_owned(), d)),
                };
                let current = i == position;
                let (rect, r) = ui.allocate_exact_size(Vec2::new(w, row_h), Sense::click());
                r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::ListItem, true, &label));
                if current {
                    ui.painter().rect_filled(rect, 0.0, pal.blue2);
                } else if r.hovered() {
                    ui.painter().rect_filled(rect, 0.0, pal.gray[3]);
                }
                let color = if done { pal.gray[11] } else { pal.gray[7] };
                ui.painter().text(
                    rect.left_center() + Vec2::new(10.0, 0.0),
                    egui::Align2::LEFT_CENTER,
                    label,
                    egui::FontId::proportional(13.0),
                    color,
                );
                if r.clicked() {
                    go = Some(i);
                }
            }
        });
    if let Some(i) = go {
        s.focus(Panel::History);
        if s.app.history.go_to(i) {
            s.app.prune_selection();
        }
    }
    let undone = n - position;
    let foot = if undone > 0 {
        crate::i18n::trf("{n} steps, {m} undone", &[("n", &n.to_string()), ("m", &undone.to_string())])
    } else {
        crate::i18n::trf("{n} steps", &[("n", &n.to_string())])
    };
    ui.label(RichText::new(foot).size(12.0).color(pal.gray[8]));
}
