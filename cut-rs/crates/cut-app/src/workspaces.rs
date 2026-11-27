//! The workspaces (`ui-shell.js`'s `WORKSPACES`): Premiere's panel layouts the top tabs switch between. A workspace
//! is rows of slots, a slot shows its panels as tabs. Each starts from its table here and becomes what the person makes
//! of it ([`crate::arrange`]): a tab dragged onto another slot docks there, a panel closed leaves, the Window menu puts
//! one back. A panel in a window of its own ([`crate::windows`]) leaves its slot until it comes back.
//!
//! What is kept: the arrangement as it is now (`workspaceArrangements`, so a start shows it again), the one Save
//! Changes to This Workspace kept with its splitters and tabs (`layoutSaved`, what Reset to Saved Layout brings back),
//! and named layouts any workspace can take (`savedLayouts`). Reset to Default Layout forgets the first two.

use std::collections::HashMap;

use eframe::egui::{self, Frame, Rect, RichText};
use serde_json::{Value, json};

use crate::arrange::{Arrangement, Side};
use crate::i18n::{tr, trf};
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

    /// The built-in arrangement (Reset to Default Layout).
    pub fn table(self) -> Arrangement {
        Arrangement::of(self.rows())
    }

    /// Every panel the built-in arrangement shows, in its slots' order.
    pub fn panels(self) -> Vec<&'static str> {
        self.table().panels()
    }
}

type Slot = (f32, &'static [&'static str]);

/// A named layout (`savedLayouts`): an arrangement any workspace can take.
#[derive(Debug, Clone, PartialEq)]
pub struct Named {
    pub name: String,
    pub rows: Arrangement,
}

/// The current workspace, each slot's active tab, and the panels in windows of their own.
#[derive(Default)]
pub struct Workspaces {
    pub current: Ws,
    tabs: HashMap<(Ws, usize, usize), &'static str>,
    /// Bumped by Reset to Saved Layout and by each change of an arrangement: the workspace's panels get new ids, so
    /// their sizes start over from the arrangement's shares.
    generation: HashMap<Ws, u32>,
    pub windows: crate::windows::view::Windows,
    /// Each splitter's panel size as drawn last, and as Save Changes to This Workspace kept it (`cut.layoutSaved`).
    sizes: HashMap<(Ws, String), f32>,
    saved: HashMap<(Ws, String), f32>,
    /// Each slot's active tab as Save Changes to This Workspace kept it: what a start and Reset show first.
    saved_tabs: HashMap<(Ws, usize, usize), &'static str>,
    /// Each workspace's arrangement now and as Save Changes kept it; absent: its table.
    arranged: HashMap<Ws, Arrangement>,
    saved_arranged: HashMap<Ws, Arrangement>,
    pub named: Vec<Named>,
    /// The Editing workspace's lower tab as last shown (the shell's `lower_tab`, which actions set).
    lower_seen: Option<LowerTab>,
    /// Save Layout As…: the name being typed.
    pub naming: Option<String>,
}

/// The setting Save Changes to This Workspace writes: `{ workspace: { sizes: { splitter: points }, tabs: { "row.slot":
/// panel }, rows: arrangement } }`.
pub const SAVED: &str = "layoutSaved";
/// Each workspace's arrangement as the person left it: `{ workspace: arrangement }`.
pub const ARRANGED: &str = "workspaceArrangements";
/// The named layouts: `[{ name, rows }]`.
pub const NAMED: &str = "savedLayouts";

/// The splitters of the Editing workspace before it was drawn from its arrangement, by their keys now.
const EDITING_KEYS: [(&str, &str); 3] = [("lower", "row1"), ("source", "slot0.0"), ("project", "slot1.0")];

fn arrangement_of(v: Option<&Value>) -> Option<Arrangement> {
    v.and_then(|v| Arrangement::from_json(v, crate::windows::panel_id))
}

impl Workspaces {
    /// Takes the saved layouts from the settings.
    pub fn load_saved(&mut self, v: Option<&serde_json::Value>) {
        self.saved.clear();
        self.saved_tabs.clear();
        self.saved_arranged.clear();
        for ws in Ws::ALL {
            let w = v.and_then(|v| v.get(ws.id()));
            if let Some(a) = arrangement_of(w.and_then(|w| w.get("rows"))) {
                self.saved_arranged.insert(ws, a);
            }
            let rows = self.saved_rows(ws);
            let sizes = w.and_then(|w| w.get("sizes")).and_then(|x| x.as_object());
            for (k, x) in sizes.into_iter().flatten() {
                if let Some(x) = x.as_f64().filter(|x| x.is_finite() && *x > 0.0) {
                    let k = match EDITING_KEYS.iter().find(|(old, _)| ws == Ws::Editing && old == k) {
                        Some((_, now)) => (*now).to_owned(),
                        None => k.clone(),
                    };
                    self.saved.insert((ws, k), x as f32);
                }
            }
            let tabs = w.and_then(|w| w.get("tabs")).and_then(|x| x.as_object());
            for (k, x) in tabs.into_iter().flatten() {
                let slot =
                    k.split_once('.').and_then(|(r, s)| Some((r.parse::<usize>().ok()?, s.parse::<usize>().ok()?)));
                let Some(slot) = slot else { continue };
                if let Some(p) = rows.slot_panels(slot).iter().find(|p| Some(**p) == x.as_str()) {
                    self.saved_tabs.insert((ws, slot.0, slot.1), p);
                }
            }
        }
        self.tabs.clone_from(&self.saved_tabs);
    }

    /// Takes the arrangements as they were left and the named layouts from the settings.
    pub fn load_arranged(&mut self, now: Option<&Value>, named: Option<&Value>) {
        self.arranged.clear();
        for ws in Ws::ALL {
            if let Some(a) = arrangement_of(now.and_then(|v| v.get(ws.id()))) {
                self.arranged.insert(ws, a);
            }
        }
        self.named = named
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|n| {
                let name = n.get("name")?.as_str()?.trim();
                (!name.is_empty()).then_some(Named { name: name.to_owned(), rows: arrangement_of(n.get("rows"))? })
            })
            .collect();
        // the tabs a start shows belong to the arrangement it shows
        let tabs = std::mem::take(&mut self.tabs);
        for ((ws, ri, si), p) in tabs {
            if self.rows(ws).slot_panels((ri, si)).contains(&p) {
                self.tabs.insert((ws, ri, si), p);
            }
        }
    }

    /// The arrangement of `ws` now.
    pub fn rows(&self, ws: Ws) -> Arrangement {
        self.arranged.get(&ws).cloned().unwrap_or_else(|| ws.table())
    }

    /// The arrangement Reset to Saved Layout brings back.
    pub fn saved_rows(&self, ws: Ws) -> Arrangement {
        self.saved_arranged.get(&ws).cloned().unwrap_or_else(|| ws.table())
    }

    /// Every panel `ws` shows now.
    pub fn panels_in(&self, ws: Ws) -> Vec<&'static str> {
        self.rows(ws).panels()
    }

    /// Shows `panel` in the current workspace when it has it, else in the first workspace that does -> whether one
    /// did (a feature that opens its panel: the text of a new text clip, Effect Controls, the timeline of a new
    /// sequence).
    pub fn open_panel(&mut self, panel: &str) -> bool {
        let order = std::iter::once(self.current).chain(Ws::ALL.into_iter().filter(|w| w.ready()));
        for ws in order {
            let a = self.rows(ws);
            if let Some((ri, si)) = a.slot_of(panel) {
                self.current = ws;
                if let Some(p) = a.slot_panels((ri, si)).iter().find(|p| **p == panel) {
                    self.tabs.insert((ws, ri, si), p);
                    if ws == Ws::Editing && lower_of(p).is_some() {
                        // the shell's lower tab follows at the next frame
                        self.lower_seen = None;
                    }
                }
                return true;
            }
        }
        false
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
            let rows = self.saved_arranged.get(&ws);
            if !sizes.is_empty() || !tabs.is_empty() || rows.is_some() {
                let mut v = json!({ "sizes": sizes, "tabs": tabs });
                if let Some(a) = rows {
                    v["rows"] = a.to_json();
                }
                out.insert(ws.id().to_owned(), v);
            }
        }
        serde_json::Value::Object(out)
    }

    fn arranged_json(&self) -> Value {
        let m: serde_json::Map<String, Value> =
            self.arranged.iter().map(|(ws, a)| (ws.id().to_owned(), a.to_json())).collect();
        Value::Object(m)
    }

    fn named_json(&self) -> Value {
        Value::Array(self.named.iter().map(|n| json!({ "name": n.name, "rows": n.rows.to_json() })).collect())
    }

    /// The size Save Changes to This Workspace kept for a splitter; only while the workspace has the arrangement it
    /// was saved with (the keys are places in it).
    pub fn saved_size(&self, ws: Ws, key: &str) -> Option<f32> {
        if !self.rows(ws).same_places(&self.saved_rows(ws)) {
            return None;
        }
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

    /// The arrangement of `ws` with the shares of the sizes its panels were drawn at, so that a change of it keeps
    /// what the person sized.
    pub fn drawn(&self, ws: Ws) -> Arrangement {
        let mut a = self.rows(ws);
        let heights: Option<Vec<f32>> = (0..a.rows.len()).map(|ri| self.size(ws, &format!("row{ri}"))).collect();
        if let Some(h) = heights.filter(|h| h.iter().sum::<f32>() > 0.0) {
            let total: f32 = h.iter().sum();
            for (row, h) in a.rows.iter_mut().zip(h) {
                row.size = h / total * 100.0;
            }
        }
        for (ri, row) in a.rows.iter_mut().enumerate() {
            let widths: Option<Vec<f32>> = row
                .slots
                .iter()
                .enumerate()
                .map(|(si, s)| if s.size == 0.0 { Some(0.0) } else { self.size(ws, &format!("slot{ri}.{si}")) })
                .collect();
            if let Some(w) = widths {
                for (s, w) in row.slots.iter_mut().zip(w) {
                    s.size = w;
                }
            }
        }
        a
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

fn write_settings(s: &mut Shell) {
    let w = &s.features.workspace;
    let (saved, arranged, named) = (w.saved_json(), w.arranged_json(), w.named_json());
    s.doc.settings.set(SAVED, saved);
    s.doc.settings.set(ARRANGED, arranged);
    s.doc.settings.set(NAMED, named);
    let _ = s.doc.settings.save();
}

/// Save Changes to This Workspace (`saveWorkspace`): its arrangement, its splitters and each slot's active tab as they
/// are now become what a start and Reset bring back.
pub fn save(s: &mut Shell) {
    sync_lower(s);
    let ws = s.features.workspace.current;
    let w = &mut s.features.workspace;
    let drawn = w.drawn(ws);
    w.arranged.insert(ws, drawn.clone());
    w.saved_arranged.insert(ws, drawn.clone());
    w.saved.retain(|k, _| k.0 != ws);
    let now: Vec<_> = w.sizes.iter().filter(|(k, _)| k.0 == ws).map(|(k, v)| (k.clone(), *v)).collect();
    w.saved.extend(now);
    w.saved_tabs.retain(|k, _| k.0 != ws);
    for (ri, row) in drawn.rows.iter().enumerate() {
        for (si, slot) in row.slots.iter().enumerate() {
            if let Some(p) = w.tabs.get(&(ws, ri, si)).and_then(|a| slot.panels.iter().find(|p| *p == a)) {
                w.saved_tabs.insert((ws, ri, si), p);
            }
        }
    }
    write_settings(s);
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
            | "transcript"
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
        "transcript" => Some(Panel::Transcript),
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
        "transcript" => crate::speech::panel::show(s, ui),
        _ => {
            ui.centered_and_justified(|ui| {
                ui.label(RichText::new(tr("This panel is not available.")).color(pal.gray[8]));
            });
        }
    }
}

fn lower_id(t: LowerTab) -> &'static str {
    match t {
        LowerTab::Project => "project",
        LowerTab::Effects => "effects",
        LowerTab::Markers => "markers",
        LowerTab::History => "history",
        LowerTab::Transcript => "transcript",
    }
}

fn lower_of(id: &str) -> Option<LowerTab> {
    match id {
        "project" => Some(LowerTab::Project),
        "effects" => Some(LowerTab::Effects),
        "markers" => Some(LowerTab::Markers),
        "history" => Some(LowerTab::History),
        "transcript" => Some(LowerTab::Transcript),
        _ => None,
    }
}

/// The shell's `lower_tab` (which actions and tests set to show the Editing workspace's Project, Effects, Markers,
/// History or Transcript) and the Editing tabs agree: a new value shows its panel; at the first frame the tab a start
/// shows becomes the value.
fn sync_lower(s: &mut Shell) {
    let ws = Ws::Editing;
    match s.features.workspace.lower_seen {
        Some(seen) if seen == s.lower_tab => {}
        Some(_) => {
            show_tab(s, ws, lower_id(s.lower_tab));
            s.features.workspace.lower_seen = Some(s.lower_tab);
        }
        None => {
            let w = &s.features.workspace;
            let shown = w.rows(ws).slot_of("project").and_then(|(ri, si)| w.tabs.get(&(ws, ri, si)).copied());
            match shown.and_then(lower_of) {
                Some(t) => s.lower_tab = t,
                None => show_tab(s, ws, lower_id(s.lower_tab)),
            }
            s.features.workspace.lower_seen = Some(s.lower_tab);
        }
    }
}

/// Makes `panel` its slot's active tab in `ws` (when `ws` has it).
fn show_tab(s: &mut Shell, ws: Ws, panel: &'static str) {
    if let Some((ri, si)) = s.features.workspace.rows(ws).slot_of(panel) {
        s.features.workspace.tabs.insert((ws, ri, si), panel);
    }
    if ws == Ws::Editing
        && let Some(t) = lower_of(panel)
    {
        s.lower_tab = t;
        s.features.workspace.lower_seen = Some(t);
    }
}

/// Makes `panel` its slot's active tab in the current workspace (a panel back from its window).
pub(crate) fn reveal(s: &mut Shell, panel: &'static str) {
    let ws = s.features.workspace.current;
    show_tab(s, ws, panel);
}

/// `ws` takes the arrangement `next`: the tabs follow their panels, `shown` becomes its slot's tab, the sizes start
/// from the shares, and the settings keep it.
fn rearrange(s: &mut Shell, ws: Ws, next: Arrangement, shown: Option<&'static str>) {
    let w = &mut s.features.workspace;
    let mut tabs: Vec<_> = w.tabs.iter().filter(|(k, _)| k.0 == ws).map(|(_, p)| *p).collect();
    tabs.sort_unstable();
    w.tabs.retain(|k, _| k.0 != ws);
    for p in tabs {
        if let Some((ri, si)) = next.slot_of(p) {
            w.tabs.insert((ws, ri, si), p);
        }
    }
    w.sizes.retain(|k, _| k.0 != ws);
    s.features.view.slots.retain(|(x, _), _| *x != ws);
    if s.features.view.maximized.is_some_and(|(x, _)| x == ws) {
        s.features.view.maximized = None;
    }
    if next == ws.table() {
        w.arranged.remove(&ws);
    } else {
        w.arranged.insert(ws, next);
    }
    *w.generation.entry(ws).or_default() += 1;
    if let Some(p) = shown {
        show_tab(s, ws, p);
    }
    write_settings(s);
}

/// Close Panel (a tab's menu, the Window menu): the panel leaves the current workspace; the last one stays.
pub fn close_panel(s: &mut Shell, panel: &'static str) {
    let ws = s.features.workspace.current;
    let mut a = s.features.workspace.drawn(ws);
    if !a.contains(panel) {
        return;
    }
    if !a.remove(panel) {
        s.app.toast(tr("A workspace keeps at least one panel."));
        return;
    }
    if crate::windows::view::in_window(s, panel) {
        s.features.workspace.windows.layouts.dock(ws, panel);
    }
    rearrange(s, ws, a, None);
}

/// Shows `panel` in the current workspace: its tab when the workspace has it, else put back where its table has it
/// (with the panels it shares a slot with there), else a tab of the slot that holds Project (the JavaScript's
/// `dock` slot), else of the largest slot.
pub fn show_panel(s: &mut Shell, panel: &'static str) {
    if !has_panel(panel) {
        return;
    }
    let ws = s.features.workspace.current;
    let mut a = s.features.workspace.drawn(ws);
    if a.contains(panel) {
        show_tab(s, ws, panel);
        return;
    }
    let table = ws.table();
    let neighbour =
        table.slot_of(panel).and_then(|k| table.slot_panels(k).iter().copied().find(|p| *p != panel && a.contains(p)));
    let biggest = || {
        a.rows
            .iter()
            .flat_map(|r| {
                r.slots.iter().map(move |s| (r.size * s.size / r.slots.iter().map(|x| x.size).sum::<f32>().max(1.0), s))
            })
            .filter(|(_, s)| s.size > 0.0)
            .max_by(|x, y| x.0.total_cmp(&y.0))
            .and_then(|(_, s)| s.panels.first().copied())
    };
    let anchor = neighbour.or_else(|| a.contains("project").then_some("project")).or_else(biggest);
    let placed = match anchor {
        Some(at) if panel == "tools" => a.insert(panel, at, Side::Left),
        Some(at) => a.insert(panel, at, Side::Tabs),
        None => false,
    };
    if placed {
        rearrange(s, ws, a, Some(panel));
    }
}

/// Where a tab dragged over the main window would go: the slot under `p` and the side, and the part of the window
/// it would take (for the hint). `None` where it would change nothing.
pub fn dock_target(s: &Shell, panel: &'static str, p: egui::Pos2) -> Option<(&'static str, Side, Rect)> {
    let ws = s.features.workspace.current;
    let a = s.features.workspace.rows(ws);
    let ((ri, si), r) =
        s.features.view.slots.iter().find(|((w, _), r)| *w == ws && r.contains(p)).map(|((_, k), r)| (*k, *r))?;
    let slot = a.slot((ri, si))?;
    let (dx, dy) = ((p.x - r.left()) / r.width().max(1.0), (p.y - r.top()) / r.height().max(1.0));
    let side = if p.y < r.top() + 30.0 {
        Side::Tabs
    } else {
        [(dx, Side::Left), (1.0 - dx, Side::Right), (dy, Side::Above), (1.0 - dy, Side::Below)]
            .into_iter()
            .filter(|(d, _)| *d < 0.25)
            .min_by(|x, y| x.0.total_cmp(&y.0))
            .map_or(Side::Tabs, |x| x.1)
    };
    let anchor = *slot.panels.first()?;
    if !a.clone().move_to(panel, anchor, side) {
        return None;
    }
    let row = s
        .features
        .view
        .slots
        .iter()
        .filter(|((w, (k, _)), _)| *w == ws && *k == ri)
        .fold(r, |acc, (_, x)| acc.union(*x));
    let zone = match side {
        Side::Tabs => r,
        Side::Left => Rect::from_min_max(r.min, egui::pos2(r.center().x, r.max.y)),
        Side::Right => Rect::from_min_max(egui::pos2(r.center().x, r.min.y), r.max),
        Side::Above => Rect::from_min_max(row.min, egui::pos2(row.max.x, row.center().y)),
        Side::Below => Rect::from_min_max(egui::pos2(row.min.x, row.center().y), row.max),
    };
    Some((anchor, side, zone))
}

/// A tab dragged inside the main window: the hint of where it would dock while held, the dock once released.
pub fn drag_inside(s: &mut Shell, ctx: &egui::Context, panel: &'static str, p: egui::Pos2, released: bool) {
    let Some((anchor, side, zone)) = dock_target(s, panel, p) else { return };
    if released {
        let ws = s.features.workspace.current;
        let mut a = s.features.workspace.drawn(ws);
        if a.move_to(panel, anchor, side) {
            rearrange(s, ws, a, Some(panel));
        }
        return;
    }
    let accent = s.palette.accent;
    let painter = ctx.layer_painter(egui::LayerId::new(egui::Order::Foreground, egui::Id::unique("cut-dock-hint")));
    painter.rect_filled(zone.shrink(4.0), 6.0, accent.gamma_multiply(0.22));
    painter.rect_stroke(zone.shrink(4.0), 6.0, egui::Stroke::new(2.0, accent), egui::StrokeKind::Inside);
}

/// One slot: its tabs and its active panel; the panels in windows of their own leave it, and a slot they all left
/// says where they are.
fn slot(s: &mut Shell, ui: &mut egui::Ui, ws: Ws, ri: usize, si: usize, list: &[&'static str]) {
    let pal = s.palette.clone();
    let key = (ws, ri, si);
    let stored = s.features.workspace.tabs.get(&key).copied().filter(|p| list.contains(p));
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
            show_tab(s, ws, p);
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
    let list = s.features.workspace.rows(ws).slot_panels((ri, si)).to_vec();
    slot(s, ui, ws, ri, si, &list);
}

/// Draws the current workspace from its arrangement.
pub fn layout(s: &mut Shell, ui: &mut egui::Ui) {
    sync_lower(s);
    let ws = s.features.workspace.current;
    let pal = s.palette.clone();
    let rows = s.features.workspace.rows(ws).rows;
    let total = ui.available_height();
    let g = s.features.workspace.generation(ws);
    let count: f32 = rows.iter().map(|r| r.size).sum::<f32>().max(1.0);
    for (ri, row) in rows.iter().enumerate().rev() {
        let slots = &row.slots;
        let draw_row = |s: &mut Shell, ui: &mut egui::Ui| {
            let width = ui.available_width();
            let flex: f32 = slots.iter().map(|x| x.size).sum::<f32>().max(1.0);
            let mut last = slots.len() - 1;
            // a narrow last slot (the meters) is fixed at the right and drawn first, so the slots on the left can
            // never push it out of the window; the slot before it then fills the middle
            if last > 0 && slots[last].size > 0.0 && slots[last].size / flex <= 0.1 {
                let key = format!("slot{ri}.{last}");
                let r = egui::Panel::right(("ws", ws.id(), ri, last, g))
                    .show_separator_line(false)
                    .frame(Frame::new())
                    .resizable(true)
                    .default_size(sized(s, ws, &key, (width * slots[last].size / flex).max(56.0)))
                    .size_range(56.0..=width * 0.4)
                    .show(ui, |ui| slot(s, ui, ws, ri, last, &slots[last].panels));
                note(s, ws, &key, r.response.rect.width());
                last -= 1;
            }
            for (si, sl) in slots.iter().enumerate().take(last) {
                let p = egui::Panel::left(("ws", ws.id(), ri, si, g)).show_separator_line(false).frame(Frame::new());
                let key = format!("slot{ri}.{si}");
                let p = if sl.size == 0.0 {
                    p.exact_size(40.0).resizable(false)
                } else {
                    p.resizable(true)
                        .default_size(sized(s, ws, &key, (width * sl.size / flex).max(120.0)))
                        .size_range(120.0..=width * 0.8)
                };
                let r = p.show(ui, |ui| slot(s, ui, ws, ri, si, &sl.panels));
                if sl.size != 0.0 {
                    note(s, ws, &key, r.response.rect.width());
                }
            }
            // the last slot takes what is left
            let r = egui::CentralPanel::default()
                .frame(Frame::new())
                .show(ui, |ui| slot(s, ui, ws, ri, last, &slots[last].panels));
            if slots[last].size != 0.0 {
                note(s, ws, &format!("slot{ri}.{last}"), r.response.rect.width());
            }
        };
        let key = format!("row{ri}");
        if ri == 0 {
            let r = egui::CentralPanel::default().frame(Frame::new().fill(pal.gray[1])).show(ui, |ui| draw_row(s, ui));
            note(s, ws, &key, r.response.rect.height());
        } else {
            let id = ("ws-row", ws.id(), ri, g);
            let r = egui::Panel::bottom(id)
                .show_separator_line(false)
                .resizable(true)
                .default_size(sized(s, ws, &key, total * row.size / count))
                .size_range(120.0..=(total - 120.0).max(160.0))
                .frame(Frame::new().fill(pal.gray[1]))
                .show(ui, |ui| draw_row(s, ui));
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
        "workspace.reset" | "workspace.save" | "workspace.default" => Some(true),
        "window.dockAll" => Some(!s.features.workspace.windows.layouts.open_in(ws).is_empty()),
        _ => id
            .strip_prefix("window.detach.")
            .map(|p| crate::windows::detachable(p) && s.features.workspace.panels_in(ws).contains(&p)),
    }
}

/// Switches workspace (`workspace.<id>`), resets it (`workspace.reset`, `workspace.default`), opens a panel of these
/// features (`window.<panel>`), puts a panel in a window of its own or back (`window.detach.<panel>`,
/// `window.dockAll`).
pub fn run(s: &mut Shell, id: &str, ctx: &egui::Context) -> bool {
    if let Some(ws) = id.strip_prefix("workspace.").and_then(Ws::from_id) {
        set(s, ws);
        return true;
    }
    match id {
        "workspace.reset" => reset(s),
        "workspace.save" => save(s),
        "workspace.default" => reset_default(s),
        "window.dockAll" => crate::windows::view::dock_all(s),
        _ => {
            if let Some(p) = id.strip_prefix("window.detach.") {
                let ws = s.features.workspace.current;
                if let Some(p) = s.features.workspace.panels_in(ws).into_iter().find(|q| *q == p) {
                    if crate::windows::view::in_window(s, p) {
                        crate::windows::view::dock(s, p);
                    } else {
                        crate::windows::view::detach(s, p);
                    }
                }
                return true;
            }
            let Some(p) = id.strip_prefix("window.").and_then(crate::windows::panel_id) else { return false };
            if crate::windows::view::in_window(s, p) {
                crate::windows::view::focus_window(ctx, p);
                return true;
            }
            show_panel(s, p);
        }
    }
    true
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
/// forgotten, the arrangement and tabs it was saved with (else its table's) shown, its panels at their saved (else
/// first) sizes.
pub fn reset(s: &mut Shell) {
    let ws = s.features.workspace.current;
    let w = &mut s.features.workspace;
    w.windows.layouts.reset(ws);
    let saved = w.saved_rows(ws);
    if saved == ws.table() {
        w.arranged.remove(&ws);
    } else {
        w.arranged.insert(ws, saved);
    }
    w.sizes.retain(|k, _| k.0 != ws);
    w.tabs.retain(|k, _| k.0 != ws);
    let kept: Vec<_> = w.saved_tabs.iter().filter(|(k, _)| k.0 == ws).map(|(k, p)| (*k, *p)).collect();
    w.tabs.extend(kept);
    *w.generation.entry(ws).or_default() += 1;
    s.features.view.slots.retain(|(x, _), _| *x != ws);
    if ws == Ws::Editing {
        let w = &s.features.workspace;
        let shown = w.rows(ws).slot_of("project").and_then(|k| w.saved_tab(ws, k));
        s.lower_tab = shown.and_then(lower_of).unwrap_or(LowerTab::Project);
        s.features.workspace.lower_seen = Some(s.lower_tab);
    }
    let v = s.features.workspace.windows.layouts.to_json();
    s.doc.settings.set(crate::windows::SETTING, v);
    write_settings(s);
}

/// Reset to Default Layout: the workspace as the app first showed it; what Save Changes kept for it is forgotten.
pub fn reset_default(s: &mut Shell) {
    let ws = s.features.workspace.current;
    let w = &mut s.features.workspace;
    w.saved_arranged.remove(&ws);
    w.saved.retain(|k, _| k.0 != ws);
    w.saved_tabs.retain(|k, _| k.0 != ws);
    reset(s);
}

/// Applies the named layout `name` to the current workspace.
pub fn apply_named(s: &mut Shell, name: &str) {
    let Some(n) = s.features.workspace.named.iter().find(|n| n.name == name).cloned() else { return };
    let ws = s.features.workspace.current;
    for p in s.features.workspace.windows.layouts.open_in(ws) {
        if !n.rows.contains(p) {
            s.features.workspace.windows.layouts.dock(ws, p);
        }
    }
    rearrange(s, ws, n.rows, None);
    s.app.toast(trf("Applied the layout {name}", &[("name", &n.name)]));
}

/// Keeps the current workspace's arrangement as the named layout `name` (replacing one of that name).
pub fn save_named(s: &mut Shell, name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let ws = s.features.workspace.current;
    let rows = s.features.workspace.drawn(ws);
    let w = &mut s.features.workspace;
    match w.named.iter_mut().find(|n| n.name == name) {
        Some(n) => n.rows = rows,
        None => w.named.push(Named { name: name.to_owned(), rows }),
    }
    write_settings(s);
    s.app.toast(trf("Saved the layout {name}", &[("name", name)]));
    true
}

pub fn delete_named(s: &mut Shell, name: &str) {
    s.features.workspace.named.retain(|n| n.name != name);
    write_settings(s);
}

/// The Window menu's Workspaces entries after the workspaces themselves: Reset, Save, Reset to Default, the named
/// layouts.
pub fn layouts_menu(s: &mut Shell, ui: &mut egui::Ui) {
    if ui.button(tr("Reset to Default Layout")).clicked() {
        reset_default(s);
        ui.close();
    }
    ui.separator();
    if ui.button(tr("Save Layout As…")).clicked() {
        s.features.workspace.naming = Some(String::new());
        ui.close();
    }
    let names: Vec<String> = s.features.workspace.named.iter().map(|n| n.name.clone()).collect();
    ui.add_enabled_ui(!names.is_empty(), |ui| {
        ui.menu_button(tr("Saved Layouts"), |ui| {
            for n in &names {
                if ui.button(n).clicked() {
                    apply_named(s, n);
                    ui.close();
                }
            }
        });
        ui.menu_button(tr("Delete Layout"), |ui| {
            for n in &names {
                if ui.button(n).clicked() {
                    delete_named(s, n);
                    ui.close();
                }
            }
        });
    });
}

/// The Window menu's panels: every panel, checked when the current workspace has it; choosing a checked one closes
/// it (Premiere's Window menu), another shows it.
pub fn panels_menu(s: &mut Shell, ui: &mut egui::Ui) {
    const ORDER: [&str; 19] = [
        "project",
        "source",
        "timeline",
        "program",
        "controls",
        "mixer",
        "effects",
        "essential",
        "captions",
        "transcript",
        "text",
        "color",
        "scopes",
        "markers",
        "history",
        "meters",
        "export",
        "queue",
        "tools",
    ];
    let ws = s.features.workspace.current;
    let here = s.features.workspace.panels_in(ws);
    for p in ORDER {
        let on = here.contains(&p);
        let mark = if on { crate::icons::CHECK } else { "  " };
        let key = crate::keys::shown(&format!("window.{p}"), s.preset);
        let r = ui.add(egui::Button::new(format!("{mark}  {}", tr(panel_title(p)))).shortcut_text(key));
        if r.clicked() {
            if on {
                close_panel(s, p);
            } else {
                show_panel(s, p);
            }
            ui.close();
        }
    }
}

/// Save Layout As…'s name, while it is typed.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    use crate::panels::dialogs::Titled as _;
    let Some(mut name) = s.features.workspace.naming.clone() else { return };
    let (mut ok, mut cancel) = (false, false);
    let exists = s.features.workspace.named.iter().any(|n| n.name == name.trim());
    egui::Window::new(tr("Save Layout"))
        .id(egui::Id::unique("cutSaveLayout"))
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, egui::Vec2::ZERO)
        .show_titled(ctx, tr("Save Layout"), None, |ui| {
            ui.label(tr("Layout name"));
            let r = ui.add(egui::TextEdit::singleline(&mut name).desired_width(280.0).id_salt("cut-layout-name"));
            if !r.has_focus() && name.is_empty() {
                r.request_focus();
            }
            if exists {
                ui.label(RichText::new(trf("Replace the layout {name}?", &[("name", name.trim())])).size(11.0));
            }
            ok = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            crate::panels::dialogs::actions(ui, |ui| {
                let label = if exists { tr("Replace") } else { tr("Save") };
                ok |= crate::panels::dialogs::primary_if(ui, !name.trim().is_empty(), label).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
    cancel |= ctx.input(|i| i.key_pressed(egui::Key::Escape));
    if (ok && save_named(s, &name)) || cancel {
        s.features.workspace.naming = None;
    } else {
        s.features.workspace.naming = Some(name);
    }
}
