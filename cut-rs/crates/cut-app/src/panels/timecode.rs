//! The playhead's timecode in the Timeline and the monitors (`ui-base.js` `timecodeField`): text that a click (or
//! Enter while it has the keyboard) turns into a field taking a timecode, a frame count, or +N / -N frames from the
//! shown time; Enter or leaving the field goes there, Escape leaves the time as it was.

use cut_time::{Fps, Ticks, parse_timecode, timecode};
use eframe::egui::{self, Color32, FontId, Rect, Sense, Vec2};

/// The field in `rect` showing `t` -> the time typed, once it is committed.
pub fn field(
    ui: &mut egui::Ui,
    rect: Rect,
    id: egui::Id,
    (t, fps): (Ticks, Fps),
    (font, color): (FontId, Color32),
    title: &str,
) -> Option<Ticks> {
    let editing = ui.data(|d| d.get_temp::<String>(id));
    let Some(mut text) = editing else {
        let r = ui.interact(rect, id.with("shown"), Sense::click()).on_hover_text(title);
        r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, title));
        ui.painter().text(rect.left_center(), egui::Align2::LEFT_CENTER, timecode(t, fps), font, color);
        let enter = r.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
        if r.clicked() || enter {
            let text = timecode(t, fps);
            let mut state = egui::text_edit::TextEditState::default();
            state.cursor.set_char_range(Some(egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(text.chars().count()),
            )));
            state.store(ui.ctx(), id);
            ui.data_mut(|d| d.insert_temp(id, text));
            ui.memory_mut(|m| m.request_focus(id));
        }
        return None;
    };
    let edit = egui::TextEdit::singleline(&mut text).id(id).font(font).text_color(color).margin(Vec2::new(2.0, 0.0));
    let r = ui.put(rect, edit);
    if r.has_focus() {
        ui.data_mut(|d| d.insert_temp(id, text));
        return None;
    }
    ui.data_mut(|d| d.remove::<String>(id));
    if ui.input(|i| i.key_pressed(egui::Key::Escape)) {
        return None;
    }
    parse_timecode(&text, fps, t).filter(|v| *v != t)
}

/// [`field`] laid out in the current row, as wide as a timecode in `font`.
pub fn inline(
    ui: &mut egui::Ui,
    id: egui::Id,
    at: (Ticks, Fps),
    (font, color): (FontId, Color32),
    title: &str,
) -> Option<Ticks> {
    let wide = ui.painter().layout_no_wrap("00:00:00:00".into(), font.clone(), color).size();
    let (rect, _) = ui.allocate_exact_size(wide + Vec2::new(6.0, 2.0), Sense::hover());
    field(ui, rect, id, at, (font, color), title)
}
