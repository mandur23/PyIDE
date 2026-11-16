//! What the panel's eyedroppers make of a picked colour, and the HSL Secondary's hue bar.

use cut_engine::color::{LUMA, clamp, srgb_to_linear};
use cut_engine::lumetri;
use cut_engine::uniforms;
use eframe::egui::{self, Color32, Rect, Sense, Vec2};
use serde_json::{Map, Value as Json};

/// `Math.round(x * 10) / 10`.
fn tenths(x: f64) -> f64 {
    (x * 10.0 + 0.5).floor() / 10.0
}

/// The temperature and tint that make the picked sRGB colour neutral (`whiteBalance`). The colour was seen through
/// the clip's correction `p` (Lumetri Color's values): its white balance gains multiply, so the answer is the current
/// temperature and tint plus the engine's solve for the colour as seen, with saturation and contrast undone first
/// (the rest of the correction keeps a grey grey).
pub fn white_balance(rgb: [u8; 3], p: &Map<String, Json>) -> (f64, f64) {
    let num = |k: &str, d: f64| p.get(k).and_then(Json::as_f64).unwrap_or(d);
    let mut c = rgb.map(|v| srgb_to_linear(f64::from(v) / 255.0).max(1e-5));
    let sat = num("saturation", 100.0) / 100.0;
    if sat > 0.01 && sat != 1.0 {
        let y = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
        c = c.map(|x| (y + (x - y) / sat).max(1e-5));
    }
    let k = 1.0 + num("contrast", 0.0) / 100.0;
    if k != 1.0 {
        c = c.map(|x| 0.18 * (x / 0.18).powf(1.0 / k));
    }
    let (t, m) = uniforms::white_balance(c);
    let fit = |x: f64| tenths(x).clamp(-100.0, 100.0);
    (fit(num("temperature", 0.0) + t), fit(num("tint", 0.0) + m))
}

/// A qualifier around a picked sRGB colour (`lumetri.qualifierFor`): its hue 50 degrees wide, its saturation and luma
/// with a margin.
pub fn qualifier_for(rgb: [u8; 3]) -> [(&'static str, f64); 9] {
    let s = rgb.map(|v| clamp(f64::from(v) / 255.0, 0.0, 1.0));
    let c = s[0].max(s[1]).max(s[2]) - s[0].min(s[1]).min(s[2]);
    let l = s[0] * LUMA[0] + s[1] * LUMA[1] + s[2] * LUMA[2];
    [
        ("hslHue", tenths(lumetri::hue_of(s) * 360.0)),
        ("hslHueRange", 50.0),
        ("hslHueSoft", 30.0),
        ("hslSatLow", tenths(clamp(c - 0.3, 0.0, 1.0) * 100.0)),
        ("hslSatHigh", tenths(clamp(c + 0.3, 0.0, 1.0) * 100.0)),
        ("hslSatSoft", 10.0),
        ("hslLumLow", tenths(clamp(l - 0.35, 0.0, 1.0) * 100.0)),
        ("hslLumHigh", tenths(clamp(l + 0.35, 0.0, 1.0) * 100.0)),
        ("hslLumSoft", 10.0),
    ]
}

/// CSS `hsl(h, 90%, 50%)`.
fn hue_color(h: f64) -> Color32 {
    let (s, l): (f64, f64) = (0.9, 0.5);
    let a = s * l.min(1.0 - l);
    let f = |n: f64| {
        let k = (n + h / 30.0) % 12.0;
        let v = l - a * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0);
        (v * 255.0).round() as u8
    };
    Color32::from_rgb(f(0.0), f(8.0), f(4.0))
}

/// The hues across the panel, the ones outside the qualifier dimmed (`drawHueBar`).
pub fn hue_bar(ui: &mut egui::Ui, p: &Map<String, Json>) {
    let w = (ui.available_width() - 12.0).max(10.0);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(w, 10.0), Sense::hover());
    let q = lumetri::hsl_plan(p);
    let painter = ui.painter_at(rect);
    let cols = rect.width().round().max(1.0) as usize;
    let dim = Color32::from_rgb(20, 21, 24);
    for x in 0..cols {
        let u = x as f64 / cols as f64;
        let col = Rect::from_min_size(rect.min + Vec2::new(x as f32, 0.0), Vec2::new(1.0, rect.height()));
        painter.rect_filled(col, 0.0, hue_color(u * 360.0));
        let d = ((((u - q.hue + 0.5) % 1.0) + 1.0) % 1.0 - 0.5).abs();
        let m = 1.0 - ((d - q.half) / q.hue_soft.max(1e-4)).clamp(0.0, 1.0);
        if m < 1.0 {
            painter.rect_filled(col, 0.0, dim.gamma_multiply((0.8 * (1.0 - m)) as f32));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(v: serde_json::Value) -> Map<String, Json> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn a_grey_keeps_the_white_balance_it_was_seen_through() {
        let p = params(json!({ "temperature": 12.0, "tint": -7.0 }));
        assert_eq!(white_balance([128, 128, 128], &p), (12.0, -7.0));
        assert_eq!(white_balance([128, 128, 128], &Map::new()), (0.0, 0.0));
    }

    #[test]
    fn a_warm_pick_turns_the_temperature_down_and_saturation_is_undone_first() {
        let (t, m) = white_balance([140, 128, 116], &Map::new());
        assert!(t < 0.0 && t > -100.0, "blue is short: cooler ({t})");
        assert!((-100.0..=100.0).contains(&m));
        // at saturation 50 the same colour seen means a stronger cast underneath
        let (t2, _) = white_balance([140, 128, 116], &params(json!({ "saturation": 50.0 })));
        assert!(t2 < t, "{t2} < {t}");
        assert_eq!(white_balance([255, 0, 0], &Map::new()).0, -100.0, "clamped to the slider");
    }

    #[test]
    fn the_hue_bar_colours_are_css_hsl() {
        assert_eq!(hue_color(0.0), Color32::from_rgb(242, 13, 13));
        assert_eq!(hue_color(120.0), Color32::from_rgb(13, 242, 13));
        assert_eq!(hue_color(240.0), Color32::from_rgb(13, 13, 242));
    }
}
