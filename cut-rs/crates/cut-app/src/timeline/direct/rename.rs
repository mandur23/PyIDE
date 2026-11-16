//! Renaming a clip in its bar: a double click on the name opens a one-line field over it; Enter or a click elsewhere
//! sets the name (one `setClip` step, none when it did not change), Escape leaves it. The JavaScript asks for the name
//! in a prompt (`renameClip`); the field is the native app's own.

use cut_model::{Clip, Id, Sequence};
use eframe::egui::{self, Key, Rect};

use super::super::Timeline;
use crate::state::App;

/// The clip whose name is being typed.
#[derive(Debug, Clone)]
pub struct Rename {
    pub clip: Id,
    pub text: String,
    /// Where the field was drawn last (a press there is the field's).
    pub rect: Option<Rect>,
    focused: bool,
}

impl Rename {
    pub fn new(c: &Clip) -> Rename {
        Rename { clip: c.id, text: c.name.clone(), rect: None, focused: false }
    }
}

impl Timeline {
    pub(super) fn rename_ui(&mut self, ui: &mut egui::Ui, lanes: Rect, app: &mut App, seq: &Sequence) {
        let Some(clip) = self.direct.rename.as_ref().map(|r| r.clip) else { return };
        let Some(rect) = self.label_rect(seq, clip, lanes) else {
            self.direct.rename = None;
            return;
        };
        let rect = Rect::from_min_size(rect.min - egui::vec2(2.0, 1.0), egui::vec2(rect.width().max(120.0), 18.0));
        let Some(r) = self.direct.rename.as_mut() else { return };
        r.rect = Some(rect);
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect));
        let mut out = egui::TextEdit::singleline(&mut r.text)
            .desired_width(rect.width())
            .font(egui::FontId::proportional(11.5))
            .margin(egui::Margin::symmetric(3, 1))
            .id_salt("cut-clip-rename")
            .show(&mut child);
        let field = out.response.clone();
        if !r.focused {
            // the whole name selected, so typing replaces it (as a rename in Explorer)
            let all = egui::text::CCursorRange::two(
                egui::text::CCursor::new(0),
                egui::text::CCursor::new(r.text.chars().count()),
            );
            out.state.cursor.set_char_range(Some(all));
            out.state.store(ui.ctx(), field.id);
            field.request_focus();
            r.focused = true;
        }
        let (enter, escape) = ui.input(|i| (i.key_pressed(Key::Enter), i.key_pressed(Key::Escape)));
        if escape {
            self.direct.rename = None;
        } else if enter || field.lost_focus() {
            let name = r.text.clone();
            self.direct.rename = None;
            if seq.clip(clip).is_some_and(|c| c.name != name) {
                app.exec(&crate::cmd::set_clip(seq.id, clip, serde_json::json!({ "name": name }), false));
            }
        }
    }
}
