//! The small controls the Effect Controls rows and the Lumetri panel are made of (the native counterparts of
//! `ui-base.js`'s `numberField`, `slider` and icon buttons): a number that is dragged to scrub or clicked to type,
//! a slider, an icon button and the keyframe glyphs. A control reports when a drag starts and stops, so the caller
//! makes one undo step of it ([`super::edit::Gesture`]).

use eframe::egui::{self, Color32, Response, RichText, Vec2};

/// Icons from Segoe MDL2 Assets (shipped with Windows, loaded by the shell).
pub mod glyph {
    pub const RESET: &str = "\u{E72C}";
    pub const UP: &str = "\u{E74A}";
    pub const OPEN: &str = "\u{E70D}";
    pub const CLOSED: &str = "\u{E76C}";
    pub const DROPPER: &str = "\u{E790}";
    pub const POINT: &str = "\u{E81D}";
    pub const STAR: &str = "\u{E735}";
    pub const FOLDER: &str = "\u{E8B7}";
    pub const PEN: &str = "\u{EDFB}";
}

/// What a control did this frame.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Change {
    /// The new value, when it changed.
    pub value: Option<f64>,
    /// A drag began (open the undo step).
    pub started: bool,
    /// A drag ended or the typed value was entered (close it).
    pub stopped: bool,
}

/// A number's range, step, unit and decimals.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Num {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub unit: &'static str,
    pub decimals: usize,
}

impl Num {
    /// A number of `min..=max` moved by `step` (decimals from the step, as `numberField`'s precision).
    pub fn new(min: Option<f64>, max: Option<f64>, step: Option<f64>, unit: &'static str) -> Num {
        let step = step.unwrap_or(1.0);
        let decimals = if step < 1.0 { format!("{step}").split('.').nth(1).map_or(0, str::len) } else { 0 };
        Num { min: min.unwrap_or(f64::MIN), max: max.unwrap_or(f64::MAX), step, unit, decimals }
    }
}

fn change(r: &Response, before: f64, after: f64) -> Change {
    Change {
        value: (after != before).then_some(after),
        started: r.drag_started(),
        stopped: r.drag_stopped() || (r.changed() && !r.dragged()),
    }
}

/// A number dragged left and right to scrub it (a step per point), or clicked to type it.
pub fn number(ui: &mut egui::Ui, value: f64, n: Num) -> Change {
    number_named(ui, value, n, None).0
}

/// [`number`] named for assistive technology by the label `name` -> what it did, and its response.
pub fn number_named(ui: &mut egui::Ui, value: f64, n: Num, name: Option<egui::Id>) -> (Change, Response) {
    let mut v = value;
    let speed = n.step.max(1e-6);
    let r = ui.add(
        egui::DragValue::new(&mut v)
            .range(n.min..=n.max)
            .speed(speed)
            .max_decimals(n.decimals)
            .min_decimals(n.decimals)
            .suffix(n.unit),
    );
    let r = match name {
        Some(id) => r.labelled_by(id),
        None => r,
    };
    (change(&r, value, v), r)
}

/// A slider over `lo..=hi` (the row's slider below the label).
pub fn slider(ui: &mut egui::Ui, value: f64, lo: f64, hi: f64, step: f64, width: f32) -> Change {
    slider_named(ui, value, [lo, hi], step, width, None)
}

/// [`slider`] named for assistive technology by the label `name`.
pub fn slider_named(
    ui: &mut egui::Ui,
    value: f64,
    range: [f64; 2],
    step: f64,
    width: f32,
    name: Option<egui::Id>,
) -> Change {
    let mut v = value;
    ui.spacing_mut().slider_width = width;
    let s = egui::Slider::new(&mut v, range[0]..=range[1]).step_by(step).show_value(false);
    let r = ui.add(s.clamping(egui::SliderClamping::Never));
    let r = match name {
        Some(id) => r.labelled_by(id),
        None => r,
    };
    change(&r, value, v)
}

/// A small frameless icon button with a tooltip; `on` draws it in the accent colour.
pub fn icon(ui: &mut egui::Ui, glyph: &str, tip: &str, on: bool, accent: Color32) -> Response {
    let text = RichText::new(glyph).size(12.0);
    let text = if on { text.color(accent) } else { text };
    ui.add(egui::Button::new(text).frame(false).min_size(Vec2::splat(18.0))).on_hover_text(tip)
}

/// `#rrggbb` as a colour; `None` when it is not one.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() < 6 {
        return None;
    }
    let b = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok();
    Some([b(0)?, b(2)?, b(4)?])
}

/// A colour as `#rrggbb`.
pub fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_read_and_write_as_the_project_keeps_them() {
        assert_eq!(parse_hex("#ff8000"), Some([255, 128, 0]));
        assert_eq!(parse_hex("#ff8000cc"), Some([255, 128, 0]));
        assert_eq!(parse_hex("red"), None);
        assert_eq!(hex([1, 171, 255]), "#01abff");
    }

    #[test]
    fn a_numbers_decimals_follow_its_step() {
        assert_eq!(Num::new(Some(0.0), Some(1.0), Some(0.01), "").decimals, 2);
        assert_eq!(Num::new(None, None, Some(0.5), "%").decimals, 1);
        assert_eq!(Num::new(None, None, None, "").decimals, 0);
    }
}
