//! The editor's colours, read from the JavaScript editor's CSS variables (embedded at build time): the IDE's grays and
//! blues (`renderer/core/styles.css`, the light theme's in `renderer/features/settings/style.css`) and Cut's own
//! tokens (`renderer/features/cut/style.css`). Dark and light are the two themes of the JavaScript editor.

use std::collections::HashMap;

use eframe::egui::{self, Color32, CornerRadius, Sense, Stroke, Vec2, Visuals};

const CORE_CSS: &str = include_str!("../../../../renderer/core/styles.css");
const LIGHT_CSS: &str = include_str!("../../../../renderer/features/settings/style.css");
const CUT_CSS: &str = include_str!("../../../../renderer/features/cut/style.css");

/// A theme of the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeKind {
    Dark,
    Light,
}

impl ThemeKind {
    pub fn code(self) -> &'static str {
        match self {
            ThemeKind::Dark => "dark",
            ThemeKind::Light => "light",
        }
    }
}

/// The colours the panels paint with: the CSS variables by name.
#[derive(Debug, Clone)]
pub struct Palette {
    pub kind: ThemeKind,
    pub gray: [Color32; 13],
    pub blue6: Color32,
    pub blue8: Color32,
    pub blue2: Color32,
    pub accent: Color32,
    pub playhead: Color32,
    pub clip_video: Color32,
    pub clip_audio: Color32,
    pub clip_text: Color32,
    pub clip_solid: Color32,
    pub clip_nest: Color32,
    pub selected: Color32,
    pub monitor_bg: Color32,
    pub red: Color32,
}

/// The `--name: value` declarations of the first CSS block whose selector is exactly `selector`.
fn block(css: &str, selector: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = css;
    while let Some(open) = rest.find('{') {
        let head = rest[..open].rsplit(['}', '\n']).next().unwrap_or("").trim();
        let Some(close) = rest[open..].find('}') else { break };
        let body = &rest[open + 1..open + close];
        if head == selector {
            for decl in body.split(';') {
                let decl = strip_comments(decl);
                if let Some((k, v)) = decl.split_once(':')
                    && let Some(name) = k.trim().strip_prefix("--")
                {
                    out.insert(name.to_owned(), v.trim().to_owned());
                }
            }
            return out;
        }
        rest = &rest[open + close + 1..];
    }
    out
}

fn strip_comments(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(a) = rest.find("/*") {
        out.push_str(&rest[..a]);
        rest = rest[a..].find("*/").map_or("", |b| &rest[a + b + 2..]);
    }
    out.push_str(rest);
    out
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa`.
pub fn hex(s: &str) -> Option<Color32> {
    let h = s.trim().strip_prefix('#')?;
    let n = |i: usize, w: usize| u8::from_str_radix(&h[i..i + w], 16).ok();
    match h.len() {
        3 => Some(Color32::from_rgb(n(0, 1)? * 17, n(1, 1)? * 17, n(2, 1)? * 17)),
        6 => Some(Color32::from_rgb(n(0, 2)?, n(2, 2)?, n(4, 2)?)),
        8 => Some(Color32::from_rgba_unmultiplied(n(0, 2)?, n(2, 2)?, n(4, 2)?, n(6, 2)?)),
        _ => None,
    }
}

impl Palette {
    /// The palette of a theme, from the CSS.
    pub fn of(kind: ThemeKind) -> Palette {
        let mut vars = block(CORE_CSS, ":root");
        vars.extend(block(CUT_CSS, ":root"));
        if kind == ThemeKind::Light {
            vars.extend(block(LIGHT_CSS, ":root[data-theme=\"light\"]"));
            vars.extend(block(CORE_CSS, ":root[data-theme=\"light\"]"));
            vars.extend(block(CUT_CSS, ":root[data-theme=\"light\"]"));
        }
        let get = |name: &str, fallback: Color32| vars.get(name).and_then(|v| hex(v)).unwrap_or(fallback);
        let mut gray = [Color32::BLACK; 13];
        for (i, g) in gray.iter_mut().enumerate().skip(1) {
            *g = get(&format!("gray{i}"), Color32::GRAY);
        }
        Palette {
            kind,
            gray,
            blue6: get("blue6", Color32::from_rgb(0x35, 0x74, 0xf0)),
            blue8: get("blue8", Color32::from_rgb(0x54, 0x8a, 0xf7)),
            blue2: get("blue2", Color32::from_rgb(0x2e, 0x43, 0x6e)),
            accent: get("cut-accent", Color32::from_rgb(0xe8, 0x74, 0x3b)),
            playhead: get("cut-playhead", Color32::from_rgb(0xe0, 0x55, 0x55)),
            clip_video: get("cut-clip-video", Color32::from_rgb(0x2f, 0x4a, 0x78)),
            clip_audio: get("cut-clip-audio", Color32::from_rgb(0x2c, 0x61, 0x52)),
            clip_text: get("cut-clip-text", Color32::from_rgb(0x7a, 0x4b, 0xb0)),
            clip_solid: get("cut-clip-solid", Color32::from_rgb(0x6b, 0x5a, 0x2a)),
            clip_nest: get("cut-clip-nest", Color32::from_rgb(0x4f, 0x7a, 0x2e)),
            selected: get("cut-selected", Color32::from_rgb(0xf2, 0xc5, 0x5c)),
            monitor_bg: get("cut-monitor-bg", Color32::from_rgb(0x0f, 0x10, 0x12)),
            red: get("red", Color32::from_rgb(0xdb, 0x5c, 0x5c)),
        }
    }

    pub fn light(&self) -> bool {
        self.kind == ThemeKind::Light
    }

    /// Text on a coloured clip: light on the dark clip colours in both themes, as the JavaScript's canvas draws it.
    pub fn clip_text_color(&self) -> Color32 {
        Color32::from_rgb(0xec, 0xee, 0xf2)
    }

    /// egui's look built from the palette.
    pub fn visuals(&self) -> Visuals {
        let g = &self.gray;
        let mut v = if self.light() { Visuals::light() } else { Visuals::dark() };
        v.override_text_color = Some(g[11]);
        v.panel_fill = g[2];
        v.window_fill = g[2];
        v.extreme_bg_color = g[1];
        v.faint_bg_color = g[3];
        v.code_bg_color = g[1];
        v.window_stroke = Stroke::new(1.0, g[4]);
        v.hyperlink_color = self.blue8;
        v.selection.bg_fill = if self.light() { self.blue2 } else { Color32::from_rgb(0x2e, 0x43, 0x6e) };
        v.selection.stroke = Stroke::new(1.0, self.blue8);
        let radius = CornerRadius::same(4);
        for (w, fill) in [
            (&mut v.widgets.noninteractive, g[2]),
            (&mut v.widgets.inactive, g[2]),
            (&mut v.widgets.hovered, g[3]),
            (&mut v.widgets.active, g[4]),
            (&mut v.widgets.open, g[3]),
        ] {
            w.bg_fill = fill;
            w.weak_bg_fill = fill;
            w.corner_radius = radius;
            w.fg_stroke = Stroke::new(1.0, g[11]);
        }
        v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, g[3]);
        v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, g[11]);
        // a button, a field and a list show their edge at rest, so they read as controls and not as text; the bars'
        // icon buttons are drawn without a frame and keep none
        v.widgets.inactive.bg_stroke = Stroke::new(1.0, g[5]);
        // a slider's rail and a scroll bar use bg_fill; buttons keep the panel colour (weak_bg_fill)
        v.widgets.inactive.bg_fill = g[4];
        v.widgets.hovered.bg_stroke = Stroke::new(1.0, g[4]);
        // a dialog, a menu and a panel of the main window are the same card: one corner, one edge
        v.window_corner_radius = CornerRadius::same(CARD_RADIUS);
        v.menu_corner_radius = CornerRadius::same(6);
        v.window_shadow = egui::Shadow {
            offset: [0, 8],
            blur: 24,
            spread: 0,
            color: Color32::from_black_alpha(if self.light() { 40 } else { 110 }),
        };
        v.popup_shadow = egui::Shadow {
            offset: [0, 4],
            blur: 12,
            spread: 0,
            color: Color32::from_black_alpha(if self.light() { 30 } else { 90 }),
        };
        v
    }

    /// The edge of a card: a dialog's and a panel's.
    pub fn card_stroke(&self) -> Stroke {
        Stroke::new(1.0, self.gray[4])
    }

    /// The fill of a button that carries out its dialog (Export, OK, Save): the same in the top bar and the dialogs.
    pub fn primary(&self) -> Color32 {
        self.blue6
    }

    pub fn apply(&self, ctx: &egui::Context) {
        ctx.set_visuals(self.visuals());
    }
}

/// The corner of a card: a dialog, a panel of the main window.
pub const CARD_RADIUS: u8 = 8;

/// A tab: its name, filled as the row in use of a dialog's list when it is the one shown. A panel's tabs and the
/// workspaces' are drawn with it, so the tab in use looks the same wherever it is. `sense` adds dragging for a tab
/// that can be pulled out of its row.
pub fn tab(
    ui: &mut egui::Ui,
    pal: &Palette,
    text: &str,
    active: bool,
    enabled: bool,
    height: f32,
    sense: Sense,
) -> egui::Response {
    let color = if !enabled {
        pal.gray[6]
    } else if active {
        pal.gray[12]
    } else {
        pal.gray[9]
    };
    let font = egui::FontId::proportional(13.5);
    let galley = ui.painter().layout_no_wrap(text.to_owned(), font, color);
    let size = Vec2::new(galley.size().x + 18.0, height);
    let (rect, r) = ui.allocate_exact_size(size, if enabled { sense } else { Sense::hover() });
    if ui.is_rect_visible(rect) {
        let pill = rect.shrink2(Vec2::new(0.0, ((height - 24.0) / 2.0).max(1.0)));
        if active {
            ui.painter().rect_filled(pill, CornerRadius::same(5), ui.visuals().selection.bg_fill);
        } else if enabled && r.hovered() {
            ui.painter().rect_filled(pill, CornerRadius::same(5), pal.gray[3]);
        }
        ui.painter().galley(rect.center() - galley.size() / 2.0, galley, color);
    }
    r.widget_info(|| egui::WidgetInfo::selected(egui::Role::Button, enabled, active, text));
    r
}

/// The bars' icon buttons carry no edge at rest: the buttons `ui` draws from here on are their icons alone.
pub fn flat(ui: &mut egui::Ui) {
    ui.visuals_mut().widgets.inactive.bg_stroke = Stroke::NONE;
}

/// A list's arrow: the chevron the other Nano Studio apps draw on a select, in place of egui's filled triangle.
pub fn combo_icon(ui: &egui::Ui, rect: egui::Rect, visuals: &egui::style::WidgetVisuals, _open: bool) {
    let c = rect.center();
    let (w, h) = (3.5, 2.0);
    let stroke = Stroke::new(1.4, visuals.fg_stroke.color);
    ui.painter().line_segment([egui::pos2(c.x - w, c.y - h), egui::pos2(c.x, c.y + h)], stroke);
    ui.painter().line_segment([egui::pos2(c.x, c.y + h), egui::pos2(c.x + w, c.y - h)], stroke);
}
