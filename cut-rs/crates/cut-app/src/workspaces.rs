//! The workspaces (`ui-shell.js`'s `WORKSPACES`): Premiere's panel layouts the top tabs switch between. A workspace
//! is rows of slots, a slot shows its panels as tabs. Editing keeps the shell's own layout ([`crate::panels::layout`])
//! with its slots drawn here; the others are drawn here from the table. A panel the native app does not have yet keeps
//! its tab, disabled. A panel in a window of its own ([`crate::windows`]) leaves its slot until it comes back.

use std::collections::HashMap;

use eframe::egui::{self, Frame, RichText};

use crate::i18n::tr;
use crate::shell::{LowerTab, Shell};
use crate::state::Panel;

/// A workspace, by the JavaScript's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Ws {
    #[default]
    Editing,
    Color,
    Effects,
    Audio,
    Captions,
    Export,
}

impl Ws {
    /// The top bar's order.
    pub const ALL: [Ws; 6] = [Ws::Editing, Ws::Color, Ws::Effects, Ws::Audio, Ws::Captions, Ws::Export];

    pub fn id(self) -> &'static str {
        match self {
            Ws::Editing => "editing",
            Ws::Color => "color",
            Ws::Effects => "effects",
            Ws::Audio => "audio",
            Ws::Captions => "captions",
            Ws::Export => "export",
        }
    }

    pub fn from_id(id: &str) -> Option<Ws> {
        Ws::ALL.into_iter().find(|w| w.id() == id)
    }

    /// The English title (the key of its translation).
    pub fn title(self) -> &'static str {
        match self {
            Ws::Editing => "Editing",
            Ws::Color => "Color",
            Ws::Effects => "Effects",
            Ws::Audio => "Audio",
            Ws::Captions => "Captions and Graphics",
            Ws::Export => "Export",
        }
    }

    /// Whether the native app has this workspace's main panels.
    pub fn ready(self) -> bool {
        matches!(self, Ws::Editing | Ws::Color | Ws::Effects | Ws::Audio | Ws::Captions | Ws::Export)
    }

    /// Rows top to bottom (sizes in percent), slots left to right: `(size, panels)`; size 0 is the Tools column.
    fn rows(self) -> &'static [(f32, &'static [Slot])] {
        const TOOLS: Slot = (0.0, &["tools"]);
        match self {
            Ws::Editing => &[
                (54.0, &[(45.0, &["source", "controls"]), (55.0, &["program"])]),
                (
                    46.0,
                    &[
                        (28.0, &["project", "effects", "markers", "history", "transcript"]),
                        TOOLS,
                        (66.0, &["timeline"]),
                        (6.0, &["meters"]),
                    ],
                ),
            ],
            Ws::Color => &[
                (60.0, &[(28.0, &["scopes", "source"]), (44.0, &["program"]), (28.0, &["color", "controls"])]),
                (40.0, &[(24.0, &["project", "effects", "history"]), TOOLS, (70.0, &["timeline"]), (6.0, &["meters"])]),
            ],
            Ws::Effects => &[
                (56.0, &[(30.0, &["controls", "source"]), (46.0, &["program"]), (24.0, &["effects", "markers"])]),
                (44.0, &[(24.0, &["project", "history"]), TOOLS, (70.0, &["timeline"]), (6.0, &["meters"])]),
            ],
            Ws::Audio => &[
                (56.0, &[(38.0, &["mixer", "controls", "source"]), (42.0, &["program"]), (20.0, &["essential"])]),
                (
                    44.0,
                    &[
                        (24.0, &["project", "effects", "markers", "history", "transcript"]),
                        TOOLS,
                        (66.0, &["timeline"]),
                        (10.0, &["meters"]),
                    ],
                ),
            ],
            Ws::Captions => &[
                (
                    58.0,
                    &[
                        (30.0, &["captions", "transcript", "markers"]),
                        (44.0, &["program"]),
                        (26.0, &["text", "controls"]),
                    ],
                ),
                (42.0, &[(26.0, &["project", "effects", "history"]), TOOLS, (74.0, &["timeline"])]),
            ],
            Ws::Export => &[
                (62.0, &[(36.0, &["export", "queue", "markers"]), (57.0, &["program"]), (7.0, &["meters"])]),
                (38.0, &[(100.0, &["timeline"])]),
            ],
        }
    }
}

impl Ws {
    /// Every panel the workspace shows, in its slots' order.
    pub fn panels(self) -> Vec<&'static str> {
        self.rows().iter().flat_map(|(_, slots)| slots.iter().flat_map(|(_, list)| list.iter().copied())).collect()
    }

    /// Where `panel` is: its row and slot.
    pub(crate) fn slot_of(self, panel: &str) -> Option<(usize, usize)> {
        self.rows()
            .iter()
            .enumerate()
            .find_map(|(ri, (_, slots))| slots.iter().position(|(_, list)| list.contains(&panel)).map(|si| (ri, si)))
    }
}

impl Ws {
    /// The panels of the slot at `(row, place)`.
    pub(crate) fn slot_panels(self, (ri, si): (usize, usize)) -> &'static [&'static str] {
        self.rows()[ri].1[si].1
    }
}

type Slot = (f32, &'static [&'static str]);

/// The current workspace, each slot's active tab, and the panels in windows of their own.
#[derive(Default)]
pub struct Workspaces {
    pub current: Ws,
    tabs: HashMap<(Ws, usize, usize), &'static str>,
    /// Bumped by Reset to Saved Layout: the workspace's panels get new ids, so their sizes start over.
    generation: HashMap<Ws, u32>,
    pub windows: crate::windows::view::Windows,
    /// Each splitter's panel size as drawn last, and as Save Changes to This Workspace kept it (`cut.layoutSaved`).
    sizes: HashMap<(Ws, String), f32>,
    saved: HashMap<(Ws, String), f32>,
    /// Each slot's active tab as Save Changes to This Workspace kept it: what a start and Reset show first.
    saved_tabs: HashMap<(Ws, usize, usize), &'static str>,
}

/// The setting Save Changes to This Workspace writes: `{ workspace: { sizes: { splitter: points }, tabs: { "row.slot":
/// panel } } }`.
pub const SAVED: &str = "layoutSaved";

impl Workspaces {
    /// Takes the saved layouts from the settings.
    pub fn load_saved(&mut self, v: Option<&serde_json::Value>) {
        self.saved.clear();
        self.saved_tabs.clear();
        for ws in Ws::ALL {
            let sizes = v.and_then(|v| v.get(ws.id())).and_then(|w| w.get("sizes")).and_then(|x| x.as_object());
            for (k, x) in sizes.into_iter().flatten() {
                if let Some(x) = x.as_f64().filter(|x| x.is_finite() && *x > 0.0) {
                    self.saved.insert((ws, k.clone()), x as f32);
                }
            }
            let tabs = v.and_then(|v| v.get(ws.id())).and_then(|w| w.get("tabs")).and_then(|x| x.as_object());
            for (k, x) in tabs.into_iter().flatten() {
                let slot =
                    k.split_once('.').and_then(|(r, s)| Some((r.parse::<usize>().ok()?, s.parse::<usize>().ok()?)));
                let Some((ri, si)) = slot.filter(|(ri, si)| ws.rows().get(*ri).is_some_and(|r| *si < r.1.len())) else {
                    continue;
                };
                if let Some(p) = ws.slot_panels((ri, si)).iter().find(|p| Some(**p) == x.as_str()) {
                    self.saved_tabs.insert((ws, ri, si), p);
                }
            }
        }
        self.tabs.clone_from(&self.saved_tabs);
    }

    /// The tab Save Changes to This Workspace kept for a slot.
    pub fn saved_tab(&self, ws: Ws, slot: (usize, usize)) -> Option<&'static str> {
        self.saved_tabs.get(&(ws, slot.0, slot.1)).copied()
    }

    fn saved_json(&self) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for ws in Ws::ALL {
            let sizes: serde_json::Map<String, serde_json::Value> = self
                .saved
                .iter()
                .filter(|((w, _), _)| *w == ws)
                .map(|((_, k), v)| (k.clone(), serde_json::json!(v)))
                .collect();
            let tabs: serde_json::Map<String, serde_json::Value> = self
                .saved_tabs
                .iter()
                .filter(|((w, ..), _)| *w == ws)
                .map(|((_, ri, si), p)| (format!("{ri}.{si}"), serde_json::json!(p)))
                .collect();
            if !sizes.is_empty() || !tabs.is_empty() {
                out.insert(ws.id().to_owned(), serde_json::json!({ "sizes": sizes, "tabs": tabs }));
            }
        }
        serde_json::Value::Object(out)
    }

    /// The size Save Changes to This Workspace kept for a splitter.
    pub fn saved_size(&self, ws: Ws, key: &str) -> Option<f32> {
        self.saved.get(&(ws, key.to_owned())).copied()
    }

    /// The size a splitter's panel was drawn at last.
    pub fn size(&self, ws: Ws, key: &str) -> Option<f32> {
        self.sizes.get(&(ws, key.to_owned())).copied()
    }

    /// The salt of `ws`'s panel ids (new after a reset).
    pub fn generation(&self, ws: Ws) -> u32 {
        self.generation.get(&ws).copied().unwrap_or(0)
    }

    /// Shows `panel` in the current workspace when it has a slot for it, else in the first workspace that does.
    pub fn open_panel(&mut self, panel: &str) {
        let order = std::iter::once(self.current).chain(Ws::ALL.into_iter().filter(|w| w.ready()));
        for ws in order {
            if let Some((ri, si)) = ws.slot_of(panel) {
                self.current = ws;
                if let Some(p) = ws.rows()[ri].1[si].1.iter().find(|p| **p == panel) {
                    self.tabs.insert((ws, ri, si), p);
                }
                return;
            }
        }
    }
}

/// The size the splitter `key` of `ws` starts at: the saved one, else the built-in `default`.
pub(crate) fn sized(s: &Shell, ws: Ws, key: &str, default: f32) -> f32 {
    s.features.workspace.saved_size(ws, key).unwrap_or(default)
}

/// Notes the size the splitter `key` of `ws` was drawn at.
pub(crate) fn note(s: &mut Shell, ws: Ws, key: &str, size: f32) {
    s.features.workspace.sizes.insert((ws, key.to_owned()), size);
}

/// Save Changes to This Workspace (`saveWorkspace`): its splitters and each slot's active tab as they are now become
/// what a start and Reset bring back.
pub fn save(s: &mut Shell) {
    let ws = s.features.workspace.current;
    let lower = lower_id(s.lower_tab);
    let w = &mut s.features.workspace;
    w.saved.retain(|k, _| k.0 != ws);
    let now: Vec<_> = w.sizes.iter().filter(|(k, _)| k.0 == ws).map(|(k, v)| (k.clone(), *v)).collect();
    w.saved.extend(now);
    w.saved_tabs.retain(|k, _| k.0 != ws);
    for (ri, (_, slots)) in ws.rows().iter().enumerate() {
        for (si, (_, list)) in slots.iter().enumerate() {
            let active = if is_lower(ws, ri, si) { Some(lower) } else { w.tabs.get(&(ws, ri, si)).copied() };
            if let Some(p) = active.and_then(|a| list.iter().find(|p| **p == a)) {
                w.saved_tabs.insert((ws, ri, si), p);
            }
        }
    }
    let v = w.saved_json();
    s.doc.settings.set(SAVED, v);
    let _ = s.doc.settings.save();
    s.app.toast(crate::i18n::trf("Saved the {name} workspace", &[("name", &tr(ws.title()))]));
}

/// The panel's English title (`panelTitle`).
pub fn panel_title(id: &str) -> &'static str {
    match id {
        "project" => "Project",
        "source" => "Source",
        "program" => "Program",
        "timeline" => "Timeline",
        "tools" => "Tools",
        "controls" => "Effect Controls",
        "effects" => "Effects",
        "mixer" => "Audio Track Mixer",
        "essential" => "Essential Sound",
        "color" => "Lumetri Color",
        "scopes" => "Lumetri Scopes",
        "text" => "Text",
        "captions" => "Captions",
        "transcript" => "Transcript",
        "markers" => "Markers",
        "history" => "History",
        "meters" => "Audio Meters",
        "export" => "Export",
        "queue" => "Export Queue",
        _ => "",
    }
}

/// Whether the native app has the panel `id`.
pub fn has_panel(id: &str) -> bool {
    matches!(
        id,
        "project"
            | "source"
            | "program"
            | "timeline"
            | "tools"
            | "history"
            | "markers"
            | "meters"
            | "effects"
            | "color"
            | "scopes"
            | "export"
            | "queue"
            | "controls"
            | "mixer"
            | "essential"
            | "captions"
            | "text"
    )
}

/// The panel that has the keyboard when `id` is clicked.
pub(crate) fn focus_of(id: &str) -> Option<Panel> {
    match id {
        "project" => Some(Panel::Project),
        "history" => Some(Panel::History),
        "markers" => Some(Panel::Markers),
        "effects" => Some(Panel::Effects),
        "source" => Some(Panel::Source),
        "program" => Some(Panel::Program),
        "timeline" => Some(Panel::Timeline),
        "controls" => Some(Panel::Controls),
        _ => None,
    }
}

/// Draws the panel `id`'s body.
pub(crate) fn panel(s: &mut Shell, ui: &mut egui::Ui, id: &'static str) {
    let started = std::time::Instant::now();
    draw_panel(s, ui, id);
    s.panel_ms.insert(id, started.elapsed().as_secs_f32() * 1000.0);
}

fn draw_panel(s: &mut Shell, ui: &mut egui::Ui, id: &str) {
    let pal = s.palette.clone();
    match id {
        "project" => crate::panels::project::show(s, ui),
        "history" => crate::panels::history::show(s, ui),
        "markers" => crate::panels::markers::show(s, ui),
        "source" => crate::panels::source::show(s, ui),
        "program" => crate::panels::monitor::program(s, ui),
        "tools" => crate::panels::tools::show(s, ui),
        "timeline" => {
            let playing = s.transport.playing();
            s.timeline.tool_bar = crate::prefs::flag(&s.doc.settings, "timelineTools");
            s.timeline.show(ui, &mut s.app, &pal, playing, s.thumbs.as_mut());
        }
        "meters" => crate::audio::meters_panel(s, ui),
        "mixer" => crate::audio::mixer::panel(s, ui),
        "essential" => crate::audio::essential::panel(s, ui),
        "captions" => crate::captions::panel::show(s, ui),
        "effects" => crate::fx::effects::panel(s, ui),
        "color" => crate::fx::color::panel(s, ui),
        "scopes" => crate::fx::scopes::panel(s, ui),
        "export" => crate::export::panel(s, ui),
        "queue" => crate::export::queue_panel(s, ui),
        "controls" => crate::controls::panel(s, ui),
        "text" => crate::text_ui::panel::show(s, ui),
        _ => {
            ui.centered_and_justified(|ui| {
                ui.label(RichText::new(tr("This panel is not available.")).color(pal.gray[8]));
            });
        }
    }
}

/// The Editing workspace's lower-left slot, whose active tab is the shell's `lower_tab`.
fn is_lower(ws: Ws, ri: usize, si: usize) -> bool {
    ws == Ws::Editing && (ri, si) == (1, 0)
}

fn lower_id(t: LowerTab) -> &'static str {
    match t {
        LowerTab::Project => "project",
        LowerTab::Effects => "effects",
        LowerTab::Markers => "markers",
        LowerTab::History => "history",
    }
}

fn lower_of(id: &str) -> Option<LowerTab> {
    match id {
        "project" => Some(LowerTab::Project),
        "effects" => Some(LowerTab::Effects),
        "markers" => Some(LowerTab::Markers),
        "history" => Some(LowerTab::History),
        _ => None,
    }
}

/// Makes `panel` its slot's active tab in the current workspace (a panel back from its window).
pub(crate) fn reveal(s: &mut Shell, panel: &'static str) {
    let ws = s.features.workspace.current;
    let Some((ri, si)) = ws.slot_of(panel) else { return };
    if is_lower(ws, ri, si) {
        if let Some(t) = lower_of(panel) {
            s.lower_tab = t;
        }
    } else {
        s.features.workspace.tabs.insert((ws, ri, si), panel);
    }
}

/// One slot: its tabs and its active panel; the panels in windows of their own leave it, and a slot they all left
/// says where they are.
fn slot(s: &mut Shell, ui: &mut egui::Ui, ws: Ws, ri: usize, si: usize, list: &'static [&'static str]) {
    let pal = s.palette.clone();
    let key = (ws, ri, si);
    let lower = is_lower(ws, ri, si);
    let stored = if lower { Some(lower_id(s.lower_tab)) } else { s.features.workspace.tabs.get(&key).copied() };
    let here = |s: &Shell, p: &str| has_panel(p) && !crate::windows::view::in_window(s, p);
    let active = stored.filter(|p| here(s, p)).or_else(|| list.iter().copied().find(|p| here(s, p)));
    let focused = active.and_then(focus_of).is_some_and(|p| s.app.focus == Some(p));
    let r = crate::panels::frame(&pal, focused).show(ui, |ui| {
        ui.set_min_size(ui.available_size());
        let Some(active) = active else {
            crate::windows::view::placeholder(s, ui, list);
            return;
        };
        if list != ["tools"]
            && let Some(p) = crate::windows::slot_tabs(s, ui, list, active)
        {
            match lower_of(p).filter(|_| lower) {
                Some(t) => s.lower_tab = t,
                None => {
                    s.features.workspace.tabs.insert(key, p);
                }
            }
            if let Some(f) = focus_of(p) {
                s.focus(f);
            }
        }
        panel(s, ui, active);
    });
    s.features.view.slots.insert((ws, (ri, si)), r.response.rect);
    if let Some(a) = active {
        crate::windows::view::docked_at(s, a, r.response.rect);
    }
}

/// The slot `(ri, si)` of `ws` drawn alone (the maximized frame).
pub(crate) fn draw_slot(s: &mut Shell, ui: &mut egui::Ui, ws: Ws, ri: usize, si: usize) {
    slot(s, ui, ws, ri, si, ws.slot_panels((ri, si)));
}

/// A slot of the Editing workspace's table drawn inside the shell's own layout (its tabs and active panel).
pub fn editing_slot(s: &mut Shell, ui: &mut egui::Ui, ri: usize, si: usize) {
    slot(s, ui, Ws::Editing, ri, si, Ws::Editing.rows()[ri].1[si].1);
}

/// Draws a workspace other than Editing from its table.
pub fn layout(s: &mut Shell, ui: &mut egui::Ui) {
    let ws = s.features.workspace.current;
    let pal = s.palette.clone();
    let rows = ws.rows();
    let total = ui.available_height();
    let g = s.features.workspace.generation(ws);
    for (ri, (size, slots)) in rows.iter().enumerate().rev() {
        let row = |s: &mut Shell, ui: &mut egui::Ui| {
            let width = ui.available_width();
            let flex: f32 = slots.iter().map(|x| x.0).sum();
            let mut last = slots.len() - 1;
            // a narrow last slot (the meters) is fixed at the right and drawn first, so the slots on the left can
            // never push it out of the window; the slot before it then fills the middle
            if last > 0 && slots[last].0 <= 10.0 {
                let (sz, list) = slots[last];
                let key = format!("slot{ri}.{last}");
                let r = egui::Panel::right(("ws", ws.id(), ri, last, g))
                    .frame(Frame::new())
                    .resizable(true)
                    .default_size(sized(s, ws, &key, (width * sz / flex).max(56.0)))
                    .size_range(56.0..=width * 0.4)
                    .show(ui, |ui| slot(s, ui, ws, ri, last, list));
                note(s, ws, &key, r.response.rect.width());
                last -= 1;
            }
            for (si, (sz, list)) in slots.iter().enumerate().take(last) {
                let p = egui::Panel::left(("ws", ws.id(), ri, si, g)).frame(Frame::new());
                let key = format!("slot{ri}.{si}");
                let p = if *sz == 0.0 {
                    p.exact_size(40.0).resizable(false)
                } else {
                    p.resizable(true)
                        .default_size(sized(s, ws, &key, (width * sz / flex).max(120.0)))
                        .size_range(120.0..=width * 0.8)
                };
                let r = p.show(ui, |ui| slot(s, ui, ws, ri, si, list));
                if *sz != 0.0 {
                    note(s, ws, &key, r.response.rect.width());
                }
            }
            // the last slot takes what is left
            let list = slots[last].1;
            egui::CentralPanel::default().frame(Frame::new()).show(ui, |ui| slot(s, ui, ws, ri, last, list));
        };
        if ri == 0 {
            egui::CentralPanel::default().frame(Frame::new().fill(pal.gray[1])).show(ui, |ui| row(s, ui));
        } else {
            let id = ("ws-row", ws.id(), ri, g);
            let key = format!("row{ri}");
            let r = egui::Panel::bottom(id)
                .resizable(true)
                .default_size(sized(s, ws, &key, total * size / 100.0))
                .size_range(160.0..=(total - 160.0).max(200.0))
                .frame(Frame::new().fill(pal.gray[1]))
                .show(ui, |ui| row(s, ui));
            note(s, ws, &key, r.response.rect.height());
        }
    }
}

/// `Some(can run)` for the workspace actions this module owns.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    if let Some(ws) = id.strip_prefix("workspace.").and_then(Ws::from_id) {
        return Some(ws.ready());
    }
    let ws = s.features.workspace.current;
    match id {
        "workspace.reset" | "workspace.save" => Some(true),
        "window.dockAll" => Some(!s.features.workspace.windows.layouts.open_in(ws).is_empty()),
        _ => id.strip_prefix("window.detach.").map(|p| crate::windows::detachable(p) && ws.panels().contains(&p)),
    }
}

/// Switches workspace (`workspace.<id>`), resets it (`workspace.reset`), opens a panel of these features
/// (`window.<panel>`), puts a panel in a window of its own or back (`window.detach.<panel>`, `window.dockAll`).
pub fn run(s: &mut Shell, id: &str, ctx: &egui::Context) -> bool {
    if let Some(ws) = id.strip_prefix("workspace.").and_then(Ws::from_id) {
        set(s, ws);
        return true;
    }
    if id == "workspace.reset" {
        reset(s);
        return true;
    }
    if id == "workspace.save" {
        save(s);
        return true;
    }
    if id == "window.dockAll" {
        crate::windows::view::dock_all(s);
        return true;
    }
    if let Some(p) = id.strip_prefix("window.detach.") {
        if let Some(p) = s.features.workspace.current.panels().into_iter().find(|q| *q == p) {
            if crate::windows::view::in_window(s, p) {
                crate::windows::view::dock(s, p);
            } else {
                crate::windows::view::detach(s, p);
            }
        }
        return true;
    }
    if let Some(p) = id.strip_prefix("window.") {
        if crate::windows::view::in_window(s, p) {
            crate::windows::view::focus_window(ctx, p);
            return true;
        }
        s.features.workspace.open_panel(p);
        let ws = s.features.workspace.current;
        s.doc.set_setting("workspace", ws.id());
        return true;
    }
    false
}

/// Shows `ws` and remembers it (`cut.workspace`).
pub fn set(s: &mut Shell, ws: Ws) {
    if !ws.ready() {
        return;
    }
    s.features.workspace.current = ws;
    s.doc.set_setting("workspace", ws.id());
}

/// Reset to Saved Layout: the current workspace's panels all back in the main window with their windows' places
/// forgotten, the tabs it was saved with (else its first tabs) shown, its panels at their saved (else first) sizes.
pub fn reset(s: &mut Shell) {
    let ws = s.features.workspace.current;
    let w = &mut s.features.workspace;
    w.windows.layouts.reset(ws);
    w.tabs.retain(|k, _| k.0 != ws);
    let kept: Vec<_> = w.saved_tabs.iter().filter(|(k, _)| k.0 == ws).map(|(k, p)| (*k, *p)).collect();
    w.tabs.extend(kept);
    *w.generation.entry(ws).or_default() += 1;
    if ws == Ws::Editing {
        s.lower_tab = w.saved_tab(ws, (1, 0)).and_then(lower_of).unwrap_or(LowerTab::Project);
    }
    let v = s.features.workspace.windows.layouts.to_json();
    s.doc.settings.set(crate::windows::SETTING, v);
    let _ = s.doc.settings.save();
}
