//! The monitors' rows of buttons (`ui-monitors.js` `BUTTONS`, `DEFAULT_BUTTONS`, `shownButtons`, `buttonEditor`): one
//! table for the Source and the Program monitor, each bar's choice kept in the settings, and the Button Editor that
//! makes it.

use eframe::egui::{self, Button, Key, RichText, Vec2};

use crate::edit::source;
use crate::i18n::tr;
use crate::icons;
use crate::keys;
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::Panel;

/// The monitor a bar belongs to (`kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Monitor {
    Source,
    Program,
}

impl Monitor {
    /// The setting the Button Editor writes: the ids of the buttons shown (`cut.<kind>.buttons`).
    pub fn setting(self) -> &'static str {
        match self {
            Monitor::Source => "source.buttons",
            Monitor::Program => "program.buttons",
        }
    }

    /// Premiere Pro's default bar (`DEFAULT_BUTTONS[kind]`).
    pub fn defaults(self) -> &'static [&'static str] {
        match self {
            Monitor::Source => &SOURCE_DEFAULT,
            Monitor::Program => &PROGRAM_DEFAULT,
        }
    }

    fn panel(self) -> Panel {
        match self {
            Monitor::Source => Panel::Source,
            Monitor::Program => Panel::Program,
        }
    }
}

/// Which monitors have a button (`kinds`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Has {
    Both,
    Program,
    Source,
}

/// Insert and Overwrite (Segoe MDL2 Assets).
const INSERT: &str = "\u{E8C8}";
const OVERWRITE: &str = "\u{E70B}";

/// Every button a monitor can show, in the bar's order: id, glyph and the monitors that have it.
const BUTTONS: [(&str, &str, Has); 22] = [
    ("addMarker", icons::MARKER, Has::Program),
    ("markIn", "{", Has::Both),
    ("markOut", "}", Has::Both),
    ("markClip", "{}", Has::Program),
    ("clearIn", "{x", Has::Both),
    ("clearOut", "x}", Has::Both),
    ("goIn", icons::TO_START, Has::Both),
    ("prevMarker", "\u{25C0}\u{E7C1}", Has::Program),
    ("prevEdit", "|\u{25C0}", Has::Program),
    ("frameBack", icons::STEP_BACK, Has::Both),
    ("playPause", icons::PLAY, Has::Both),
    ("frameForward", icons::STEP_FORWARD, Has::Both),
    ("nextEdit", "\u{25B6}|", Has::Program),
    ("nextMarker", "\u{E7C1}\u{25B6}", Has::Program),
    ("goOut", icons::TO_END, Has::Both),
    ("playInToOut", icons::PLAY_IN_OUT, Has::Both),
    ("loop", icons::LOOP, Has::Both),
    ("insert", INSERT, Has::Source),
    ("overwrite", OVERWRITE, Has::Source),
    ("lift", icons::LIFT, Has::Program),
    ("extract", icons::EXTRACT, Has::Program),
    ("exportFrame", icons::CAMERA, Has::Both),
];

const PROGRAM_DEFAULT: [&str; 11] = [
    "addMarker",
    "markIn",
    "markOut",
    "goIn",
    "frameBack",
    "playPause",
    "frameForward",
    "goOut",
    "lift",
    "extract",
    "exportFrame",
];

/// The Source monitor has no Add Marker: there are no markers on media files.
const SOURCE_DEFAULT: [&str; 10] = [
    "markIn",
    "markOut",
    "goIn",
    "frameBack",
    "playPause",
    "frameForward",
    "goOut",
    "insert",
    "overwrite",
    "exportFrame",
];

/// The buttons `m`'s bar can show, in the bar's order (`availableButtons`).
pub fn available(m: Monitor) -> Vec<&'static str> {
    BUTTONS
        .iter()
        .filter(|b| {
            matches!((b.2, m), (Has::Both, _) | (Has::Program, Monitor::Program) | (Has::Source, Monitor::Source))
        })
        .map(|b| b.0)
        .collect()
}

fn glyph_of(id: &str) -> &'static str {
    BUTTONS.iter().find(|b| b.0 == id).map_or("", |b| b.1)
}

/// The title of a bar button (its action's, or Loop's).
pub fn button_title(id: &str) -> &'static str {
    if id == "loop" { "Loop" } else { keys::action(id).map_or("", |a| a.title) }
}

/// The buttons under `m`'s picture (`shownButtons`): the chosen ones in the bar's order, Play always among them; the
/// default set when none were chosen.
pub fn shown_buttons(s: &Shell, m: Monitor) -> Vec<&'static str> {
    let chosen: Option<Vec<&str>> = s
        .doc
        .settings
        .get(m.setting())
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect());
    available(m)
        .into_iter()
        .filter(|id| match &chosen {
            Some(list) => *id == "playPause" || list.contains(id),
            None => m.defaults().contains(id),
        })
        .collect()
}

fn looping(s: &Shell, m: Monitor) -> bool {
    match m {
        Monitor::Source => s.app.edit.source.looping,
        Monitor::Program => s.features.view.looping,
    }
}

fn button(s: &mut Shell, ui: &mut egui::Ui, m: Monitor, id: &'static str) {
    let pal = s.palette.clone();
    let title = button_title(id);
    let key = keys::shown(id, s.preset);
    let tip = if key.is_empty() { tr(title).into_owned() } else { format!("{} ({key})", tr(title)) };
    let source_on = s.app.edit.source.clip.is_some();
    let (enabled, playing) = match m {
        Monitor::Program => (id == "loop" || s.action_enabled(id), s.transport.playing()),
        Monitor::Source => (
            match id {
                "loop" => source_on,
                "exportFrame" => crate::edit::source_frame::can(s),
                _ => source_on && (source::ACTIONS.contains(&id) || s.action_enabled(id)),
            },
            s.app.edit.source.playing(),
        ),
    };
    let glyph = match id {
        "playPause" if playing => icons::PAUSE,
        _ => glyph_of(id),
    };
    let mut text = RichText::new(glyph).size(15.0);
    if id == "loop" {
        text = text.color(if looping(s, m) { pal.accent } else { pal.gray[10] });
    }
    let b = Button::new(text).frame(false).min_size(Vec2::splat(26.0));
    let r = ui.add_enabled(enabled, b).on_hover_text(&tip).on_disabled_hover_text(&tip);
    r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, enabled, tr(title)));
    if !r.clicked() {
        return;
    }
    s.focus(m.panel());
    match (m, id) {
        (Monitor::Program, "loop") => s.features.view.looping = !s.features.view.looping,
        (Monitor::Source, "loop") => s.app.edit.source.looping = !s.app.edit.source.looping,
        (Monitor::Source, "exportFrame") => crate::edit::source_frame::ask(s),
        _ => {
            let ctx = ui.ctx().clone();
            s.run_action(id, &ctx);
        }
    }
}

/// `m`'s row of buttons, centred, the Button Editor's + at its end, then `more` (`extra` widths wide).
pub fn bar(s: &mut Shell, ui: &mut egui::Ui, m: Monitor, extra: f32, more: impl FnOnce(&mut Shell, &mut egui::Ui)) {
    let pal = s.palette.clone();
    ui.horizontal(|ui| {
        let shown = shown_buttons(s, m);
        let n = shown.len() as f32 + 1.0;
        ui.add_space(((ui.available_width() - (26.0 * n + 6.0 * (n - 1.0)) - extra) / 2.0).max(0.0));
        for id in shown {
            button(s, ui, m, id);
        }
        let plus = Button::new(RichText::new(icons::ADD).size(13.0).color(pal.gray[8])).frame(false);
        if ui.add(plus.min_size(Vec2::splat(26.0))).on_hover_text(tr("Button Editor")).clicked() {
            open_editor(s, m);
        }
        more(s, ui);
    });
}

/// Opens the Button Editor of `m`'s bar: a box per button it can show, ticked when shown.
pub fn open_editor(s: &mut Shell, m: Monitor) {
    let now = shown_buttons(s, m);
    let boxes = available(m).into_iter().map(|id| (id, now.contains(&id))).collect();
    s.features.view.buttons = Some((m, boxes));
}

/// The Button Editor (`buttonEditor`): a box per button of the bar; OK keeps the choice, Reset Layout ticks Premiere's
/// set.
pub fn editor(s: &mut Shell, ctx: &egui::Context) {
    let Some((m, mut boxes)) = s.features.view.buttons.take() else { return };
    let (mut ok, mut cancel) = (false, ctx.input(|i| i.key_pressed(Key::Escape)));
    let mut open = true;
    egui::Window::new(tr("Button Editor"))
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
        .show_titled(ctx, tr("Button Editor"), Some(&mut open), |ui| {
            ui.set_width(420.0);
            ui.label(RichText::new(tr("Choose the buttons under the picture.")).color(s.palette.gray[9]));
            ui.add_space(4.0);
            egui::Grid::new("button-editor").num_columns(2).spacing([24.0, 4.0]).show(ui, |ui| {
                for (i, (id, on)) in boxes.iter_mut().enumerate() {
                    ui.add_enabled(*id != "playPause", egui::Checkbox::new(on, tr(button_title(id))));
                    if i % 2 == 1 {
                        ui.end_row();
                    }
                }
            });
            ui.add_space(6.0);
            crate::panels::dialogs::actions(ui, |ui| {
                ok = crate::panels::dialogs::primary(ui, tr("OK")).clicked();
                if ui.button(tr("Reset Layout")).clicked() {
                    for (id, on) in &mut boxes {
                        *on = m.defaults().contains(id) || *id == "playPause";
                    }
                }
                cancel |= ui.button(tr("Cancel")).clicked();
            });
        });
    if ok {
        let ids: Vec<&str> = boxes.iter().filter(|b| b.1 || b.0 == "playPause").map(|b| b.0).collect();
        crate::prefs::set(s, m.setting(), serde_json::json!(ids));
    } else if open && !cancel {
        s.features.view.buttons = Some((m, boxes));
    }
}
