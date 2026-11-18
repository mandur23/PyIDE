//! The panels' windows on screen: an egui immediate viewport each, laid out and painted inside the main window's
//! frame (an immediate viewport's callback may borrow the shell, so a panel in a window draws exactly as docked).
//!
//! - Painting a window inside the main window's frame costs it no frame time, measured: every surface presents in
//!   FIFO order with two frames in flight, so each frame one acquire waits for the screen's refresh, and eframe
//!   counts that wait only when it is the main window's own. In a run where the panel window's acquire waits, its
//!   paint takes 13 ms and eframe's frame 15.8 ms; in another of the same build 0.9 ms and 3.5 ms; 60 frames a
//!   second in both, three windows 14.8 ms (no more than one), and with 10 ms of work added to each frame the wait
//!   shrinks (paint 3.7 ms) instead of adding up. A deferred viewport per window (a frame of its own) was tried:
//!   eframe 0.37 on Windows then repainted the panel's window at 60 Hz and the main window 14 times a second.
//! - Keys typed in a panel's window run on the same shell; a panel key goes to that window's panel, which takes the
//!   keyboard when its window is focused (the main window's panel gets it back when the main window is).
//! - Dialogs, floating windows and toasts are drawn in the window last worked in, and stay there while a modal
//!   question is open.
//! - The monitors' textures are registered once with egui-wgpu's one renderer, which paints every window's surface
//!   on the same device, so a monitor in its own window shows the same texture with no copy.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Button, Frame, Pos2, Rect, RichText, Sense, Stroke, Vec2, ViewportBuilder, ViewportClass, ViewportCommand,
    ViewportId,
};

use super::relay::{self, Relays};
use super::{Layouts, Placement, PxRect, SETTING, Screen, created_at, detachable, place_on};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::Panel;
use crate::theme::Palette;
use crate::workspaces::{Ws, panel_title};

/// The panels' windows: the remembered layouts and what the windows on screen need from frame to frame.
pub struct Windows {
    pub layouts: Layouts,
    loaded: bool,
    screens: Vec<Screen>,
    screens_at: Option<std::time::Instant>,
    /// The main window's inner rectangle (absolute physical pixels) and its physical pixels per point.
    main: Option<(PxRect, f32)>,
    /// The builder each open window was made with: sent again unchanged, so egui never moves it back.
    live: HashMap<&'static str, ViewportBuilder>,
    /// Where each docked panel was drawn last (main window points): a window opened from the menu takes its place.
    docked: HashMap<&'static str, Rect>,
    requests: Vec<Request>,
    focused: ViewportId,
    /// The window the dialogs, floating windows and toasts are drawn in.
    host: ViewportId,
    /// The main window's panel with the keyboard, while a panel's window has it.
    main_focus: Option<Panel>,
    /// Drags handed from one window to another, and the egui plugin that gives them to that window's input.
    pub relays: Relays,
    plugged: bool,
    /// When a window moved last without being saved (input time).
    unsaved_since: Option<f64>,
    /// The panels' windows' layout time, and the time eframe took to paint and present them inside the main window's
    /// frame (that holds the wait for a free buffer of their surfaces), since [`Windows::take_times`].
    ui_time: Duration,
    paint_time: Duration,
}

impl Default for Windows {
    fn default() -> Self {
        Windows {
            layouts: Layouts::default(),
            loaded: false,
            screens: Vec::new(),
            screens_at: None,
            main: None,
            live: HashMap::new(),
            docked: HashMap::new(),
            requests: Vec::new(),
            focused: ViewportId::ROOT,
            host: ViewportId::ROOT,
            main_focus: None,
            relays: Relays::default(),
            plugged: false,
            unsaved_since: None,
            ui_time: Duration::ZERO,
            paint_time: Duration::ZERO,
        }
    }
}

impl Windows {
    /// The panels' windows' layout time and the main window frame's time painting them since the last call (the
    /// app's report).
    pub fn take_times(&mut self) -> (Duration, Duration) {
        (std::mem::take(&mut self.ui_time), std::mem::take(&mut self.paint_time))
    }
}

/// A change asked for while drawing, made once the frame's windows are drawn.
#[derive(Debug, Clone)]
enum Request {
    Detach(&'static str, Option<Placement>),
    Dock(&'static str),
    DockAll,
}

/// The viewport of `panel`'s window.
pub fn viewport_of(panel: &str) -> ViewportId {
    ViewportId::from_hash_of(("cut-panel-window", panel))
}

/// The title of `panel`'s window.
pub fn title_of(panel: &str) -> String {
    format!("{} - Nano Studio Cut", tr(panel_title(panel)))
}

pub(super) fn w(s: &mut Shell) -> &mut Windows {
    &mut s.features.workspace.windows
}

fn load(s: &mut Shell) {
    if !s.features.workspace.windows.loaded {
        let layouts = Layouts::from_json(s.doc.settings.get(SETTING));
        let win = w(s);
        win.layouts = layouts;
        win.loaded = true;
    }
}

/// Writes the layouts to the settings file.
fn save(s: &mut Shell) {
    let v = s.features.workspace.windows.layouts.to_json();
    s.doc.settings.set(SETTING, v);
    let _ = s.doc.settings.save();
    w(s).unsaved_since = None;
}

/// Whether `panel` of the current workspace is in a window of its own.
pub fn in_window(s: &Shell, panel: &str) -> bool {
    s.features.workspace.windows.layouts.is_open(s.features.workspace.current, panel)
}

/// Asks for `panel` to go into a window of its own (at the end of this frame), where it was last or else where it is
/// docked now.
pub fn detach(s: &mut Shell, panel: &'static str) {
    w(s).requests.push(Request::Detach(panel, None));
}

/// Asks for `panel` to come back to the main window.
pub fn dock(s: &mut Shell, panel: &'static str) {
    w(s).requests.push(Request::Dock(panel));
}

/// Asks for every panel of the current workspace to come back to the main window.
pub fn dock_all(s: &mut Shell) {
    w(s).requests.push(Request::DockAll);
}

/// The screens there are now, from the main window's winit window (every two seconds); none headless.
pub fn screens(s: &mut Shell, frame: &eframe::Frame) {
    let win = w(s);
    if win.screens_at.is_some_and(|t| t.elapsed().as_secs() < 2) {
        return;
    }
    let Some(window) = frame.winit_window() else { return };
    win.screens_at = Some(std::time::Instant::now());
    let primary = window.primary_monitor().and_then(|m| m.name());
    win.screens = window
        .available_monitors()
        .map(|m| {
            let (p, z) = (m.position(), m.size());
            let name = m.name().unwrap_or_default();
            Screen {
                primary: primary.as_deref() == Some(name.as_str()),
                name,
                rect: PxRect { x: p.x, y: p.y, w: z.width as i32, h: z.height as i32 },
                scale: m.scale_factor() as f32,
            }
        })
        .collect();
}

pub(super) fn px_rect(min: Pos2, size: Vec2, ppp: f32) -> PxRect {
    PxRect {
        x: (min.x * ppp).round() as i32,
        y: (min.y * ppp).round() as i32,
        w: (size.x * ppp).round() as i32,
        h: (size.y * ppp).round() as i32,
    }
}

fn modal(s: &Shell) -> bool {
    s.dialog.is_some() || s.app.edit.dialog.is_some() || crate::prefs::takes_keys(s)
}

/// The panels' windows of the current workspace, then the dialogs in the window they belong to; then the changes
/// asked for during the frame. Called once a frame after the main window's layout.
pub fn show(s: &mut Shell, ctx: &egui::Context) {
    load(s);
    let ws = s.features.workspace.current;
    let open = s.features.workspace.windows.layouts.open_in(ws);
    let embedded = ctx.embed_viewports();
    let ppp = ctx.pixels_per_point();
    let main = ctx.input(|i| i.viewport().inner_rect).map(|r| (px_rect(r.min, r.size(), ppp), ppp));
    let focused = ctx.input(|i| i.raw.viewports.iter().find(|(_, v)| v.focused == Some(true)).map(|(id, _)| *id));
    let mut win = std::mem::take(&mut s.features.workspace.windows);
    if !win.plugged {
        ctx.add_plugin(relay::Plugin(win.relays.clone()));
        win.plugged = true;
    }
    win.main = main;
    win.live.retain(|p, _| open.contains(p));
    if let Some(f) = focused.filter(|f| *f != win.focused)
        && (f == ViewportId::ROOT || open.iter().any(|p| viewport_of(p) == f))
    {
        if f == ViewportId::ROOT {
            if let Some(p) = win.main_focus.take() {
                s.app.focus = Some(p);
            }
        } else if let Some(p) = open.iter().find(|p| viewport_of(p) == f).and_then(|p| crate::workspaces::focus_of(p)) {
            if win.focused == ViewportId::ROOT {
                win.main_focus = s.app.focus;
            }
            s.app.focus = Some(p);
        }
        win.focused = f;
    }
    if !modal(s) {
        win.host = win.focused;
    }
    if embedded || !open.iter().any(|p| viewport_of(p) == win.host) {
        win.host = ViewportId::ROOT;
    }
    s.features.workspace.windows = win;
    for panel in &open {
        window(s, ctx, ws, panel);
    }
    // a drag that started in the main window, now over one of the panels' windows
    relay::from(s, ctx);
    if s.features.workspace.windows.host == ViewportId::ROOT {
        overlays(s, ctx);
    }
    apply(s, ctx, ws);
    let now = ctx.input(|i| i.time);
    match s.features.workspace.windows.unsaved_since {
        Some(t) if now - t >= 0.5 => save(s),
        Some(_) => ctx.request_repaint_after(std::time::Duration::from_millis(600)),
        None => {}
    }
}

/// What is drawn over the panels: the dialogs, the features' windows and the toasts.
fn overlays(s: &mut Shell, ctx: &egui::Context) {
    crate::panels::dialogs::show(s, ctx);
    crate::features::windows(s, ctx);
    crate::panels::status::toasts(s, ctx);
}

/// A window for a panel that has never had one: where it is docked now, at its size.
fn default_place(win: &Windows, panel: &str) -> Option<Placement> {
    let (main, ppp) = win.main?;
    let r =
        win.docked.get(panel).copied().unwrap_or(Rect::from_min_size(egui::pos2(60.0, 60.0), egui::vec2(720.0, 460.0)));
    let size = r.size().max(egui::vec2(480.0, 320.0));
    let at = px_rect(r.min, size, ppp);
    Some(Placement::of(PxRect { x: main.x + at.x, y: main.y + at.y, ..at }, &win.screens))
}

fn apply(s: &mut Shell, ctx: &egui::Context, ws: Ws) {
    let requests = std::mem::take(&mut w(s).requests);
    if requests.is_empty() {
        return;
    }
    for r in requests {
        match r {
            Request::Detach(p, place) => {
                let win = w(s);
                let place =
                    place.or_else(|| win.layouts.place(ws, p).is_none().then(|| default_place(win, p)).flatten());
                win.layouts.detach(ws, p, place);
            }
            Request::Dock(p) => {
                w(s).layouts.dock(ws, p);
                crate::workspaces::reveal(s, p);
            }
            Request::DockAll => {
                for p in s.features.workspace.windows.layouts.open_in(ws) {
                    w(s).layouts.dock(ws, p);
                }
            }
        }
    }
    save(s);
    ctx.request_repaint();
}

/// The first builder of `panel`'s window: its title, and where it was, clamped onto a screen there is now.
fn builder(win: &Windows, ws: Ws, panel: &str, ctx: &egui::Context) -> ViewportBuilder {
    let b = ViewportBuilder::default().with_min_inner_size([240.0, 160.0]).with_drag_and_drop(true);
    let at = win.layouts.place(ws, panel).and_then(|p| place_on(p, &win.screens, win.main.map(|m| m.0)));
    let fallback = win.main.map_or(1.0, |m| m.1);
    match at.map(|r| created_at(r, &win.screens, fallback)) {
        Some((pos, size)) => {
            // egui-winit multiplies points by the zoom before handing them to winit as logical pixels
            let z = ctx.zoom_factor();
            b.with_position(pos / z).with_inner_size(size / z)
        }
        None => b.with_inner_size([720.0, 460.0]),
    }
}

fn window(s: &mut Shell, ctx: &egui::Context, ws: Ws, panel: &'static str) {
    let id = viewport_of(panel);
    let first = {
        let win = &s.features.workspace.windows;
        win.live.get(panel).cloned().unwrap_or_else(|| builder(win, ws, panel, ctx))
    };
    w(s).live.insert(panel, first.clone());
    let started = Instant::now();
    let mut ui_time = Duration::ZERO;
    ctx.show_viewport_immediate(id, first.with_title(title_of(panel)), |ui, class| {
        let t = Instant::now();
        body(s, ui, class, ws, panel);
        ui_time += t.elapsed();
    });
    let win = w(s);
    win.ui_time += ui_time;
    win.paint_time += started.elapsed().saturating_sub(ui_time);
}

/// A panel's window for one frame.
fn body(s: &mut Shell, ui: &mut egui::Ui, class: ViewportClass, ws: Ws, panel: &'static str) {
    let ctx = ui.ctx().clone();
    let native = class != ViewportClass::EmbeddedWindow;
    if native {
        if ctx.input(|i| i.viewport().close_requested()) {
            dock(s, panel);
        }
        track(s, &ctx, ws, panel);
        s.keyboard(&ctx);
        s.files_dropped(&ctx);
        relay::from(s, &ctx);
    }
    // full-screen playback of the Program monitor in its own window: the picture alone fills it
    if panel == "program" && crate::view::fullscreen(s, ui, viewport_of(panel)) {
        if native && s.features.workspace.windows.host == viewport_of(panel) {
            overlays(s, &ctx);
        }
        return;
    }
    let pal = s.palette.clone();
    let draw = |s: &mut Shell, ui: &mut egui::Ui| {
        let focused = crate::workspaces::focus_of(panel).is_some_and(|p| s.app.focus == Some(p));
        crate::panels::frame(&pal, focused).show(ui, |ui| {
            ui.set_min_size(ui.available_size());
            if tab_row(s, ui, &pal, &[(panel, true, true)], true).is_some()
                && let Some(p) = crate::workspaces::focus_of(panel)
            {
                s.focus(p);
            }
            crate::workspaces::panel(s, ui, panel);
        });
    };
    if native {
        egui::CentralPanel::default().frame(Frame::new().fill(pal.gray[1])).show(ui, |ui| draw(s, ui));
        if s.features.workspace.windows.host == viewport_of(panel) {
            overlays(s, &ctx);
        }
    } else {
        draw(s, ui);
    }
}

/// Remembers where a panel's window is (once it has a place on the desktop).
fn track(s: &mut Shell, ctx: &egui::Context, ws: Ws, panel: &'static str) {
    let ppp = ctx.pixels_per_point();
    let (outer, inner, minimized) =
        ctx.input(|i| (i.viewport().outer_rect, i.viewport().inner_rect, i.viewport().minimized));
    let (Some(o), Some(i)) = (outer, inner) else { return };
    if minimized == Some(true) || i.width() < 1.0 {
        return;
    }
    let rect = px_rect(o.min, i.size(), ppp);
    let now = ctx.input(|i| i.time);
    let win = w(s);
    let place = Placement::of(rect, &win.screens);
    if win.layouts.moved(ws, panel, place) {
        win.unsaved_since = Some(now);
    }
}

/// The docked tabs of a slot: the panels of `list` not in windows of their own (`active` is shown), each with its
/// right-click menu and dragging out; a narrow slot (the meters) shows its panel's name alone. -> the tab clicked.
pub fn slot_tabs(
    s: &mut Shell,
    ui: &mut egui::Ui,
    list: &[&'static str],
    active: &'static str,
) -> Option<&'static str> {
    let pal = s.palette.clone();
    if ui.available_width() < 90.0 {
        let r = ui.add(
            // a slot this narrow is the meters': their short name fits, the full one is the tooltip
            egui::Label::new(
                RichText::new(if active == "meters" { tr("Meters") } else { tr(panel_title(active)) })
                    .size(11.0)
                    .color(pal.gray[8]),
            )
            .truncate()
            .sense(Sense::click()),
        );
        menu_of(s, &r, active, false);
        return None;
    }
    let items: Vec<(&'static str, bool, bool)> =
        list.iter().filter(|p| !in_window(s, p)).map(|p| (*p, *p == active, crate::workspaces::has_panel(p))).collect();
    tab_row(s, ui, &pal, &items, false)
}

/// The right-click menu of a panel's tab.
fn menu_of(s: &mut Shell, r: &egui::Response, panel: &'static str, in_window: bool) {
    if !detachable(panel) {
        return;
    }
    r.context_menu(|ui| {
        let label = if in_window { "Return to Main Window" } else { "Open in New Window" };
        if ui.button(tr(label)).clicked() {
            if in_window {
                dock(s, panel);
            } else {
                detach(s, panel);
            }
            ui.close();
        }
    });
}

/// A row of panel tabs (title, active, available). A tab dragged out of the main window opens its panel in a window
/// there; a window's tab dragged onto the main window brings it back. -> the tab clicked.
fn tab_row(
    s: &mut Shell,
    ui: &mut egui::Ui,
    pal: &Palette,
    list: &[(&'static str, bool, bool)],
    in_window: bool,
) -> Option<&'static str> {
    let mut clicked = None;
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        ui.spacing_mut().item_spacing.x = 2.0;
        for (panel, active, enabled) in list.iter().copied() {
            let color = if !enabled {
                pal.gray[6]
            } else if active {
                pal.gray[12]
            } else {
                pal.gray[9]
            };
            let b = Button::new(RichText::new(tr(panel_title(panel))).color(color).size(13.5))
                .frame(false)
                .min_size(Vec2::new(0.0, 26.0))
                .sense(if enabled { Sense::click_and_drag() } else { Sense::click() });
            let r = ui.add_enabled(enabled, b);
            if active {
                ui.painter().hline(r.rect.x_range(), r.rect.bottom() + 1.0, Stroke::new(2.0, pal.accent));
            }
            if !enabled {
                r.clone().on_disabled_hover_text(tr("Not available yet"));
                ui.add_space(10.0);
                continue;
            }
            if r.clicked() {
                clicked = Some(panel);
            }
            menu_of(s, &r, panel, in_window);
            drag_tab(s, ui, &r, panel, in_window);
            ui.add_space(10.0);
        }
    });
    let rect = ui.min_rect();
    ui.painter().hline(rect.x_range(), rect.bottom() + 2.0, Stroke::new(1.0, pal.gray[3]));
    ui.add_space(4.0);
    clicked
}

fn drag_tab(s: &mut Shell, ui: &egui::Ui, r: &egui::Response, panel: &'static str, in_window: bool) {
    if !detachable(panel) {
        return;
    }
    let ctx = ui.ctx();
    if r.dragged()
        && let Some(p) = ctx.pointer_latest_pos()
    {
        egui::Area::new(egui::Id::unique(("tab-drag", panel)))
            .fixed_pos(p + Vec2::new(12.0, 8.0))
            .order(egui::Order::Tooltip)
            .show(ctx, |ui| {
                Frame::popup(ui.style()).show(ui, |ui| {
                    ui.label(tr(panel_title(panel)));
                });
            });
    }
    if !r.drag_stopped() {
        return;
    }
    let Some(p) = ctx.pointer_latest_pos() else { return };
    let inside = ctx.content_rect().contains(p);
    if in_window {
        let ppp = ctx.pixels_per_point();
        let over_main = ctx.input(|i| i.viewport().inner_rect).zip(w(s).main).is_some_and(|(inner, (main, _))| {
            main.contains(((inner.min.x + p.x) * ppp) as i32, ((inner.min.y + p.y) * ppp) as i32)
        });
        if !inside && over_main {
            dock(s, panel);
        }
        return;
    }
    if inside {
        return;
    }
    // the window opens under the pointer, its title where the tab was held, at the size the panel had docked
    let win = w(s);
    let place = win.main.map(|(main, ppp)| {
        let size = win.docked.get(panel).map_or(egui::vec2(720.0, 460.0), |r| r.size()).max(egui::vec2(480.0, 320.0));
        let at = px_rect(p, size, ppp);
        Placement::of(
            PxRect { x: main.x + at.x - (60.0 * ppp) as i32, y: main.y + at.y - (16.0 * ppp) as i32, ..at },
            &win.screens,
        )
    });
    win.requests.push(Request::Detach(panel, place));
}

/// Remembers where a docked panel is drawn (for a window opened from the menu in its place).
pub fn docked_at(s: &mut Shell, panel: &'static str, rect: Rect) {
    w(s).docked.insert(panel, rect);
}

/// A slot whose panels are all in windows of their own: says where they are, with a button to bring each back.
pub fn placeholder(s: &mut Shell, ui: &mut egui::Ui, list: &[&'static str]) {
    let pal = s.palette.clone();
    ui.vertical_centered(|ui| {
        ui.add_space((ui.available_height() / 2.0 - 30.0).max(8.0));
        let away: Vec<&'static str> = list.iter().copied().filter(|p| in_window(s, p)).collect();
        for p in away {
            let name = tr(panel_title(p));
            ui.label(RichText::new(trf("{panel} is in its own window.", &[("panel", &name)])).color(pal.gray[8]));
            if ui.button(tr("Return to Main Window")).clicked() {
                dock(s, p);
            }
            ui.add_space(6.0);
        }
    });
}

/// The Window menu's entries: each panel of the workspace in a window of its own or not, and all back at once.
pub fn menu(s: &mut Shell, ui: &mut egui::Ui) {
    ui.separator();
    let ws = s.features.workspace.current;
    ui.menu_button(tr("Open in New Window"), |ui| {
        for p in ws.panels().into_iter().filter(|p| detachable(p)) {
            let on = in_window(s, p);
            let mark = if on { crate::icons::CHECK } else { "  " };
            if ui.button(format!("{mark}  {}", tr(panel_title(p)))).clicked() {
                if on {
                    dock(s, p);
                } else {
                    detach(s, p);
                }
                ui.close();
            }
        }
    });
    let any = !s.features.workspace.windows.layouts.open_in(ws).is_empty();
    if ui.add_enabled(any, Button::new(tr("Return All Panels to Main Window"))).clicked() {
        dock_all(s);
        ui.close();
    }
}

/// Brings `panel`'s window to the front (Window > a panel that is in a window of its own).
pub fn focus_window(ctx: &egui::Context, panel: &str) {
    ctx.send_viewport_cmd_to(viewport_of(panel), ViewportCommand::Focus);
}
