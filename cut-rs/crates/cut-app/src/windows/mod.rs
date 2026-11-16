//! Panels in windows of their own. Any panel of a workspace (Tools excepted) can leave the main window for an OS
//! window and come back: right-click its tab ("Open in New Window" / "Return to Main Window"), the Window menu, or
//! drag its tab out of the window (and a detached panel's tab back onto it). Closing a panel's window returns the
//! panel to its place; closing the main window closes them all.
//!
//! This file is the model, without egui: per workspace, which panels are in windows and where each window was, as
//! saved in the settings (`panelWindows`), and where a window goes on the screens there are now ([`place_on`]).
//! [`view`] draws the windows (egui viewports, every panel drawing from the one shell); [`relay`] carries drags
//! between them.
//!
//! Positions are physical pixels: an outer top-left relative to the screen it was on (named by its device name), and
//! the inner size; a screen that is gone puts the window on the main window's screen at the same offset, clamped.

pub mod relay;
pub mod view;

use std::collections::{BTreeMap, HashMap};

use eframe::egui;
use serde_json::{Map, Value, json};

use crate::workspaces::Ws;

pub use view::{menu, screens, show, slot_tabs};

/// The settings key the windows are remembered under.
pub const SETTING: &str = "panelWindows";

/// A rectangle of the desktop in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl PxRect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }

    fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
}

/// A screen as the system lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    /// The device name (`\\.\DISPLAY1`).
    pub name: String,
    pub rect: PxRect,
    /// Physical pixels per logical pixel.
    pub scale: f32,
    pub primary: bool,
}

/// Where a panel's window was: its screen, its outer top-left relative to that screen, its inner size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placement {
    pub screen: Option<String>,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Placement {
    /// The placement of a window at `rect` (absolute): relative to the screen holding its top-left corner, else the
    /// screen nearest to it, else to the desktop.
    pub fn of(rect: PxRect, screens: &[Screen]) -> Placement {
        let screen = screens.iter().find(|s| s.rect.contains(rect.x, rect.y)).or_else(|| {
            screens.iter().min_by_key(|s| {
                let (cx, cy) = s.rect.center();
                i64::from(cx - rect.x).pow(2) + i64::from(cy - rect.y).pow(2)
            })
        });
        let (ox, oy) = screen.map_or((0, 0), |s| (s.rect.x, s.rect.y));
        Placement { screen: screen.map(|s| s.name.clone()), x: rect.x - ox, y: rect.y - oy, w: rect.w, h: rect.h }
    }
}

/// The smallest window a panel gets (physical pixels).
pub const MIN_SIZE: (i32, i32) = (320, 200);

/// Where a window placed at `place` goes now (absolute): on its own screen when that is still there, else on the
/// screen of the main window (`main`, absolute), else the primary one, at the same offset; clamped so that it is
/// whole on that screen. `None` when no screen is known (headless).
pub fn place_on(place: &Placement, screens: &[Screen], main: Option<PxRect>) -> Option<PxRect> {
    let own = place.screen.as_deref().and_then(|n| screens.iter().find(|s| s.name == n));
    let of_main = main.and_then(|m| {
        let (cx, cy) = m.center();
        screens.iter().find(|s| s.rect.contains(cx, cy))
    });
    let screen = own.or(of_main).or_else(|| screens.iter().find(|s| s.primary)).or(screens.first())?;
    let r = screen.rect;
    let w = place.w.clamp(MIN_SIZE.0.min(r.w), r.w);
    let h = place.h.clamp(MIN_SIZE.1.min(r.h), r.h);
    let x = (r.x + place.x).clamp(r.x, r.x + r.w - w);
    let y = (r.y + place.y).clamp(r.y, r.y + r.h - h);
    Some(PxRect { x, y, w, h })
}

/// Where a point of one window is in another window (its points), or `None` when it is not over it: `inner` is the
/// first window's inner top-left and `pos` the point, both in its points at `ppp` physical pixels each; `to` is the
/// other window's inner rectangle in physical pixels at `to_ppp` (the two can be on screens of different scales).
pub fn to_window(inner: egui::Pos2, pos: egui::Pos2, ppp: f32, to: PxRect, to_ppp: f32) -> Option<egui::Pos2> {
    let x = ((inner.x + pos.x) * ppp).round() as i32;
    let y = ((inner.y + pos.y) * ppp).round() as i32;
    to.contains(x, y).then(|| egui::pos2((x - to.x) as f32 / to_ppp, (y - to.y) as f32 / to_ppp))
}

/// The logical position and inner size (winit's, before egui's zoom) to make a window with so that it lands at `r`
/// (physical pixels, wholly on one screen). winit makes the window on the screen Windows creates it on (the primary
/// one) and turns the position into pixels with that screen's scale; once the window is moved onto a screen of
/// another scale, Windows tells it the new scale and winit keeps its logical size, so the size is turned into pixels
/// with the scale of the screen it ends on. `fallback` is the scale when no screen is known.
pub fn created_at(r: PxRect, screens: &[Screen], fallback: f32) -> (egui::Pos2, egui::Vec2) {
    let primary = screens.iter().find(|s| s.primary).or(screens.first()).map_or(fallback, |s| s.scale);
    let own = screens.iter().find(|s| s.rect.contains(r.x, r.y)).map_or(primary, |s| s.scale);
    (egui::pos2(r.x as f32 / primary, r.y as f32 / primary), egui::vec2(r.w as f32 / own, r.h as f32 / own))
}

/// A panel's window in one workspace: whether it is open, and where it was last.
#[derive(Debug, Clone, PartialEq, Default)]
struct Entry {
    open: bool,
    place: Option<Placement>,
}

/// Which panels of each workspace are in windows of their own, and where those windows were.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Layouts {
    of: HashMap<Ws, BTreeMap<&'static str, Entry>>,
}

impl Layouts {
    /// Puts `panel` of `ws` in a window of its own, at `place` when given (else where it was last).
    pub fn detach(&mut self, ws: Ws, panel: &'static str, place: Option<Placement>) {
        if !detachable(panel) {
            return;
        }
        let e = self.of.entry(ws).or_default().entry(panel).or_default();
        e.open = true;
        if place.is_some() {
            e.place = place;
        }
    }

    /// Puts `panel` back in the main window; where its window was is kept for the next time.
    pub fn dock(&mut self, ws: Ws, panel: &str) {
        if let Some(e) = self.of.get_mut(&ws).and_then(|m| m.get_mut(panel)) {
            e.open = false;
        }
    }

    pub fn is_open(&self, ws: Ws, panel: &str) -> bool {
        self.of.get(&ws).and_then(|m| m.get(panel)).is_some_and(|e| e.open)
    }

    /// The panels of `ws` in windows of their own, in a stable order.
    pub fn open_in(&self, ws: Ws) -> Vec<&'static str> {
        self.of.get(&ws).map(|m| m.iter().filter(|(_, e)| e.open).map(|(p, _)| *p).collect()).unwrap_or_default()
    }

    pub fn place(&self, ws: Ws, panel: &str) -> Option<&Placement> {
        self.of.get(&ws).and_then(|m| m.get(panel)).and_then(|e| e.place.as_ref())
    }

    /// Remembers where `panel`'s window is now -> whether that changed anything.
    pub fn moved(&mut self, ws: Ws, panel: &'static str, place: Placement) -> bool {
        let e = self.of.entry(ws).or_default().entry(panel).or_default();
        if e.place.as_ref() == Some(&place) {
            return false;
        }
        e.place = Some(place);
        true
    }

    /// Forgets `ws`'s windows (Reset to Saved Layout): every panel back in the main window, no placement kept.
    pub fn reset(&mut self, ws: Ws) {
        self.of.remove(&ws);
    }

    /// The settings value: `{ws: {panel: {open, screen, x, y, w, h}}}`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        for ws in Ws::ALL {
            let Some(m) = self.of.get(&ws).filter(|m| !m.is_empty()) else { continue };
            let mut panels = Map::new();
            for (p, e) in m {
                let mut v = json!({ "open": e.open });
                if let Some(pl) = &e.place {
                    v["screen"] = pl.screen.as_ref().map_or(Value::Null, |s| json!(s));
                    v["x"] = json!(pl.x);
                    v["y"] = json!(pl.y);
                    v["w"] = json!(pl.w);
                    v["h"] = json!(pl.h);
                }
                panels.insert((*p).to_owned(), v);
            }
            out.insert(ws.id().to_owned(), Value::Object(panels));
        }
        Value::Object(out)
    }

    /// The layouts a settings value holds; unknown workspaces and panels, and malformed entries, are skipped.
    pub fn from_json(v: Option<&Value>) -> Layouts {
        let mut out = Layouts::default();
        let Some(obj) = v.and_then(Value::as_object) else { return out };
        for (ws, panels) in obj {
            let (Some(ws), Some(panels)) = (Ws::from_id(ws), panels.as_object()) else { continue };
            for (p, e) in panels {
                let Some(panel) = panel_id(p) else { continue };
                let int = |k: &str| e.get(k).and_then(Value::as_i64).and_then(|v| i32::try_from(v).ok());
                let place = match (int("x"), int("y"), int("w"), int("h")) {
                    (Some(x), Some(y), Some(w), Some(h)) if w > 0 && h > 0 => Some(Placement {
                        screen: e.get("screen").and_then(Value::as_str).map(str::to_owned),
                        x,
                        y,
                        w,
                        h,
                    }),
                    _ => None,
                };
                let open = e.get("open").and_then(Value::as_bool).unwrap_or(false);
                out.of.entry(ws).or_default().insert(panel, Entry { open, place });
            }
        }
        out
    }
}

/// Every panel a workspace can show, by id.
const PANELS: [&str; 19] = [
    "project",
    "source",
    "program",
    "timeline",
    "tools",
    "controls",
    "effects",
    "mixer",
    "essential",
    "color",
    "scopes",
    "text",
    "captions",
    "transcript",
    "markers",
    "history",
    "meters",
    "export",
    "queue",
];

/// The static id of a panel named in the settings.
fn panel_id(name: &str) -> Option<&'static str> {
    PANELS.into_iter().find(|p| *p == name)
}

/// Whether `panel` can have a window of its own: every panel the app has, except the Tools column.
pub fn detachable(panel: &str) -> bool {
    panel != "tools" && crate::workspaces::has_panel(panel)
}
