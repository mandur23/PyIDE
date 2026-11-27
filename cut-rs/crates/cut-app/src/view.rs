//! Views of the whole window and of playback that no single panel owns: a frame maximized in the workspace
//! (`ui-shell.js` `toggleMaximize`), full-screen playback of the Program monitor (`ui-monitors.js` `fullscreen`),
//! Play In to Out and Loop (`ui-monitors.js` `stopAt`, `loop`), and Find Action (the IDE's `GotoAction`: every action
//! by name, run from a search box).

use std::collections::HashMap;

use cut_time::Ticks;
use eframe::egui::{self, Align, Color32, Frame, Key, Layout, Rect, RichText, Vec2};

use crate::i18n::tr;
use crate::keys;
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::Panel;
use crate::workspaces::Ws;

/// A slot of a workspace: its row and its place in the row.
type Slot = (usize, usize);

#[derive(Default)]
pub struct View {
    /// The slot that fills the workspace.
    pub maximized: Option<(Ws, Slot)>,
    /// Where each slot of the workspace shown was drawn last (for the frame under the pointer).
    pub slots: HashMap<(Ws, Slot), Rect>,
    /// The Program monitor's picture alone on the screen.
    pub fullscreen: bool,
    /// The window that went full screen for it: the Program monitor's own when it is in one, else the main window.
    pub fullscreen_in: egui::ViewportId,
    /// Play In to Out ends here.
    pub stop_at: Option<Ticks>,
    /// Playback starts over at its end.
    pub looping: bool,
    /// The Program monitor's zoom: screen pixels per picture pixel, `None` fitted to the panel.
    pub zoom: Option<f32>,
    /// The Button Editor, while it is open: the monitor whose bar it makes, each button and whether it is ticked.
    pub buttons: Option<(crate::panels::bar::Monitor, Vec<(&'static str, bool)>)>,
    /// The Source monitor's zoom (the Program monitor's is `zoom`).
    pub source_zoom: Option<f32>,
    /// Find Action's search text, while it is open.
    pub find: Option<Find>,
}

#[derive(Default)]
pub struct Find {
    pub query: String,
    /// The row the arrow keys chose.
    pub row: usize,
    focused: bool,
}

fn panel_id(p: Panel) -> Option<&'static str> {
    Some(match p {
        Panel::Project => "project",
        Panel::Source => "source",
        Panel::Program => "program",
        Panel::Timeline => "timeline",
        Panel::Controls => "controls",
        Panel::Effects => "effects",
        Panel::Markers => "markers",
        Panel::History => "history",
        Panel::Transcript => "transcript",
        Panel::Tools => return None,
    })
}

/// `Some(can run now)` for this module's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "playInToOut" => Some(s.app.sequence().is_some_and(|q| q.duration() > 0)),
        "loop" | "findAction" | "maximizePanel" | "maximizeUnderCursor" => Some(true),
        "fullscreen" => Some(s.app.sequence().is_some()),
        _ => None,
    }
}

pub fn run(s: &mut Shell, id: &str, ctx: &egui::Context) -> bool {
    match id {
        "playInToOut" => play_in_to_out(s),
        "loop" => s.features.view.looping = !s.features.view.looping,
        "findAction" => s.features.view.find = Some(Find::default()),
        "maximizePanel" => maximize(s, None),
        "maximizeUnderCursor" => maximize(s, ctx.pointer_latest_pos()),
        "fullscreen" => set_fullscreen(s, ctx, !s.features.view.fullscreen),
        _ => return false,
    }
    true
}

/// Plays from the In point (or the start) and stops at the Out point (or the end).
fn play_in_to_out(s: &mut Shell) {
    let Some(end) = s.app.sequence().map(|q| q.duration()) else { return };
    let io = s.app.in_out;
    let from = io.in_.unwrap_or(0);
    s.app.set_time(from);
    s.transport.play(from, 1.0);
    s.features.view.stop_at = Some(io.out.unwrap_or(end));
}

/// Where a playback run starts over and where it ends: the In and Out of Play In to Out, else the whole sequence.
pub fn play_range(s: &Shell, end: Ticks) -> (Ticks, Ticks) {
    match s.features.view.stop_at {
        Some(stop) => (s.app.in_out.in_.unwrap_or(0), stop.min(end)),
        None => (0, end),
    }
}

/// Maximizes the slot under `at`, or the one with the keyboard; restores when a slot is maximized.
fn maximize(s: &mut Shell, at: Option<egui::Pos2>) {
    let ws = s.features.workspace.current;
    if s.features.view.maximized.take().is_some() {
        return;
    }
    let slot = match at {
        Some(p) => s.features.view.slots.iter().find(|((w, _), r)| *w == ws && r.contains(p)).map(|((_, k), _)| *k),
        None => s.app.focus.and_then(panel_id).and_then(|p| s.features.workspace.rows(ws).slot_of(p)),
    };
    // the Tools column keeps its width (`.cut-slot.fixed`)
    if let Some(k) = slot.filter(|k| s.features.workspace.rows(ws).slot_panels(*k) != ["tools"]) {
        s.features.view.maximized = Some((ws, k));
    }
}

fn set_fullscreen(s: &mut Shell, ctx: &egui::Context, on: bool) {
    if on && !s.features.view.fullscreen {
        s.features.view.fullscreen_in = if crate::windows::view::in_window(s, "program") {
            crate::windows::view::viewport_of("program")
        } else {
            egui::ViewportId::ROOT
        };
    }
    let v = &mut s.features.view;
    v.fullscreen = on;
    ctx.send_viewport_cmd_to(v.fullscreen_in, egui::ViewportCommand::Fullscreen(on));
}

/// Draws the whole of the window `here` when full-screen playback is on in it: the Program monitor's picture on
/// black. Escape or a double click leaves it. -> whether it drew.
pub fn fullscreen(s: &mut Shell, ui: &mut egui::Ui, here: egui::ViewportId) -> bool {
    let ctx = ui.ctx().clone();
    // the Program monitor's window went full screen and was closed since
    let gone =
        s.features.view.fullscreen_in != egui::ViewportId::ROOT && !crate::windows::view::in_window(s, "program");
    if s.features.view.fullscreen && here == egui::ViewportId::ROOT && gone {
        s.features.view.fullscreen = false;
        s.features.view.fullscreen_in = egui::ViewportId::ROOT;
    }
    if !s.features.view.fullscreen || s.features.view.fullscreen_in != here {
        return false;
    }
    let Some((w, h, seq_id)) = s.app.sequence().map(|q| (q.w, q.h, q.id)) else {
        set_fullscreen(s, &ctx, false);
        return false;
    };
    let mut leave = ctx.input(|i| i.key_pressed(Key::Escape));
    egui::CentralPanel::default().frame(Frame::new().fill(Color32::BLACK)).show(ui, |ui| {
        let rect = ui.max_rect();
        let frame = Vec2::new(w as f32, h as f32);
        let px = crate::panels::monitor::fitted_pixels(ui, rect, frame);
        let revision = s.app.history.revision();
        let captions = crate::captions::shown(s);
        let shown = s
            .monitors
            .as_mut()
            .and_then(|m| m.program(s.app.history.project(), revision, seq_id, s.app.t, px, captions));
        let at = crate::panels::monitor::picture(ui, rect, Color32::BLACK, shown, frame);
        if let Some(m) = &mut s.monitors {
            m.program.rect = at;
        }
        let r = ui.allocate_rect(rect, egui::Sense::click());
        leave |= r.double_clicked();
        if r.clicked() {
            s.focus(Panel::Program);
        }
    });
    if leave {
        set_fullscreen(s, &ctx, false);
    }
    true
}

/// Draws the workspace as its maximized slot alone. -> whether it drew.
pub fn maximized(s: &mut Shell, ui: &mut egui::Ui) -> bool {
    let ws = s.features.workspace.current;
    let Some((_, (ri, si))) = s.features.view.maximized.filter(|(w, _)| *w == ws) else {
        s.features.view.maximized = None;
        return false;
    };
    let fill = s.palette.gray[1];
    egui::CentralPanel::default()
        .frame(Frame::new().fill(fill))
        .show(ui, |ui| crate::workspaces::draw_slot(s, ui, ws, ri, si));
    true
}

/// One action Find Action lists: its id and its title on screen.
pub struct Found {
    pub id: &'static str,
    pub title: String,
}

/// The actions the menus and panels run that have no place in the keymap, with the menu path to each (its items
/// translated one by one): the workspaces' and windows' items, the proxies, the caption files, new layers and the
/// Automation menu.
pub const MENU_ACTIONS: &[(&str, &[&str])] = &[
    ("workspace.save", &["Workspaces", "Save Changes to This Workspace"]),
    ("window.essential", &["Window", "Essential Sound"]),
    ("window.captions", &["Window", "Captions"]),
    ("window.transcript", &["Window", "Transcript"]),
    ("window.dockAll", &["Window", "Return All Panels to Main Window"]),
    ("importFolder", &["File", "Import Folder…"]),
    ("proxy.toggle", &["View", "Play Proxies"]),
    ("proxy.cancel", &["Proxy", "Cancel Proxy"]),
    ("proxy.remove", &["Proxy", "Remove Proxy"]),
    ("captions.import", &["Graphics and Titles", "Import Captions…"]),
    ("captions.export", &["Graphics and Titles", "Export Captions…"]),
    ("captions.style", &["Graphics and Titles", "Caption Style…"]),
    ("text.newLayer", &["New Layer", "Text"]),
    ("graphics.colorMatte", &["New Layer", "Color Matte"]),
    ("auto.autocut", &["Automation", "AutoCut…"]),
    ("auto.silence", &["Automation", "Remove Silence…"]),
    ("auto.scenes", &["Automation", "Detect Scene Changes…"]),
    ("auto.beats", &["Automation", "Detect Beats…"]),
    ("auto.loudness", &["Automation", "Match Loudness…"]),
    ("auto.clipLoudness", &["Automation", "Match Clip Loudness…"]),
    ("auto.duck", &["Automation", "Auto Ducking…"]),
    ("auto.color", &["Automation", "Auto Color"]),
];

/// The actions Find Action lists for `query`: every action of the keymap, then [`MENU_ACTIONS`], whose title (in
/// the screen's language or in English) or id has all the query's words, in that order.
pub fn found(query: &str) -> Vec<Found> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let keymap = keys::ACTIONS.iter().map(|a| (a.id, tr(a.title).into_owned(), a.title.to_owned()));
    let menus = MENU_ACTIONS.iter().map(|(id, path)| {
        let shown: Vec<String> = path.iter().map(|w| tr(w).into_owned()).collect();
        (*id, shown.join(" › "), path.join(" "))
    });
    keymap
        .chain(menus)
        .filter(|(id, title, english)| {
            let hay = format!("{title} {english} {id}").to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .map(|(id, title, _)| Found { id, title })
        .collect()
}

/// Find Action: a search box over the actions; Enter runs the chosen one, a click runs the one clicked.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    crate::panels::bar::editor(s, ctx);
    let Some(mut find) = s.features.view.find.take() else { return };
    let pal = s.palette.clone();
    let list = found(&find.query);
    let (down, up, enter, esc) = ctx.input(|i| {
        (
            i.key_pressed(Key::ArrowDown),
            i.key_pressed(Key::ArrowUp),
            i.key_pressed(Key::Enter),
            i.key_pressed(Key::Escape),
        )
    });
    if down {
        find.row += 1;
    }
    if up {
        find.row = find.row.saturating_sub(1);
    }
    find.row = find.row.min(list.len().saturating_sub(1));
    let mut chosen: Option<&'static str> = None;
    let mut open = !esc;
    egui::Window::new(tr("Find Action"))
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_TOP, Vec2::new(0.0, 90.0))
        .fixed_size(Vec2::new(460.0, 360.0))
        .show_titled(ctx, tr("Find Action"), Some(&mut open), |ui| {
            let field = ui.add(
                egui::TextEdit::singleline(&mut find.query)
                    .hint_text(tr("Search actions"))
                    .desired_width(f32::INFINITY),
            );
            if field.changed() {
                find.row = 0;
            }
            if !find.focused {
                find.focused = true;
                field.request_focus();
            }
            ui.separator();
            egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
                if list.is_empty() {
                    ui.label(RichText::new(tr("No action matches.")).color(pal.gray[8]));
                }
                for (i, a) in list.iter().enumerate() {
                    let can = s.action_enabled(a.id);
                    let key = keys::shown(a.id, s.preset);
                    let r = ui
                        .add_enabled_ui(can, |ui| {
                            ui.horizontal(|ui| {
                                let r = ui.selectable_label(i == find.row, &a.title);
                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    ui.label(RichText::new(key).monospace().color(pal.gray[8]));
                                });
                                r
                            })
                            .inner
                        })
                        .inner;
                    if i == find.row && (down || up) {
                        r.scroll_to_me(None);
                    }
                    if r.clicked() || (enter && i == find.row && can) {
                        chosen = Some(a.id);
                    }
                }
            });
        });
    match chosen {
        Some(id) => s.run_action(id, ctx),
        None if open => s.features.view.find = Some(find),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn find_action_matches_every_word_in_title_or_id() {
        crate::i18n::set_lang(crate::i18n::Lang::En);
        let ids = |q: &str| super::found(q).iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids("play in out"), ["playInToOut"]);
        assert!(ids("MARK").contains(&"markIn") && ids("mark").contains(&"addMarker"));
        assert!(ids("fullscreen").contains(&"fullscreen"), "the id matches too");
        assert!(ids("no such action at all").is_empty());
        assert_eq!(ids("").len(), crate::keys::ACTIONS.len() + super::MENU_ACTIONS.len());
        assert_eq!(ids("caption style"), ["captions.style"], "the menus' own actions too");
        assert_eq!(
            ids("automation"),
            super::MENU_ACTIONS.iter().filter(|a| a.0.starts_with("auto.")).map(|a| a.0).collect::<Vec<_>>()
        );
        for (id, _) in super::MENU_ACTIONS {
            assert!(crate::keys::action(id).is_none(), "{id} is not the keymap's");
        }
    }
}
