//! A text layer's lines as glyph outlines (graphic.js `drawText`): the shown text (`{value}` formatted, `reveal`
//! cutting it by grapheme), each line shaped with cosmic-text from the font files the engine's text renderer loaded,
//! its glyphs' unhinted outlines as one path, so the layer's transform, gradient, stroke and blend apply to them as
//! they do to a canvas's `fillText` and `strokeText`.

use cosmic_text::{Attrs, Buffer, CacheKey, CacheKeyFlags, Family, Metrics, Shaping, Style, Weight};
use swash::zeno::Command;
use tiny_skia::{Path, PathBuilder};
use unicode_segmentation::UnicodeSegmentation;

use super::L;
use super::geometry::js_round;
use crate::text::TextRenderer;

/// The face a family the system does not have falls back to, the first of graphic.js's FALLBACK list on Windows.
const FALLBACK: &str = "Malgun Gothic";

/// One line: its glyphs' outlines from its left end on the baseline (`None`: nothing to draw) and its advance width,
/// in the layer's pixels.
pub(super) struct Line {
    pub path: Option<Path>,
    pub width: f64,
}

pub(super) struct Shaped {
    pub lines: Vec<Line>,
    /// From a line's middle down to its baseline (`textBaseline = 'middle'`: the middle of the em box).
    pub baseline: f64,
}

/// A number as `Intl.NumberFormat` writes it in English (and Korean): `decimals` digits, halves away from zero,
/// thousands grouped with commas.
fn format_value(v: f64, decimals: usize) -> String {
    if !v.is_finite() {
        return if v.is_nan() {
            "NaN".into()
        } else if v > 0.0 {
            "∞".into()
        } else {
            "-∞".into()
        };
    }
    // the exact decimal expansion, far enough past the digits shown for a tie to read as one
    let exact = format!("{:.*}", decimals + 30, v.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = int.bytes().chain(frac.bytes().take(decimals)).map(|b| b - b'0').collect();
    if frac.as_bytes().get(decimals).is_some_and(|d| *d >= b'5') {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let n_int = digits.len() - decimals;
    let mut out = String::new();
    if v.is_sign_negative() {
        out.push('-');
    }
    for (i, d) in digits[..n_int].iter().enumerate() {
        if i > 0 && (n_int - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(char::from(b'0' + d));
    }
    if decimals > 0 {
        out.push('.');
        out.extend(digits[n_int..].iter().map(|d| char::from(b'0' + d)));
    }
    out
}

/// The text a text layer shows: `{value}` replaced, then the first `reveal` fraction of its graphemes.
pub fn shown_text(l: &L<'_>) -> String {
    let text = l.str("text");
    let mut text = if text.contains("{value}") {
        text.replace("{value}", &format_value(l.num("value"), l.count("decimals")))
    } else {
        text.to_string()
    };
    let reveal = l.num("reveal");
    if reveal < 1.0 {
        let g: Vec<&str> = text.graphemes(true).collect();
        let n = js_round(g.len() as f64 * reveal.max(0.0)).max(0.0) as usize;
        text = g[..n.min(g.len())].concat();
    }
    text
}

/// A text layer's lines, shaped.
pub(super) fn shape(renderer: &mut TextRenderer, l: &L<'_>) -> Shaped {
    let (fonts, cache) = renderer.font_parts();
    let size = l.num("fontSize").max(1.0) as f32;
    let wanted = l.str("font");
    let known = !wanted.is_empty()
        && fonts.db().faces().any(|f| f.families.iter().any(|(n, _)| n.eq_ignore_ascii_case(wanted)));
    let family = if known { wanted } else { FALLBACK };
    let attrs = Attrs::new()
        .family(Family::Name(family))
        .weight(Weight(l.num("weight").clamp(1.0, 1000.0) as u16))
        .style(if l.flag("italic") { Style::Italic } else { Style::Normal })
        .letter_spacing((l.num("letterSpacing") / f64::from(size)) as f32)
        .cache_key_flags(CacheKeyFlags::DISABLE_HINTING);
    let mut baseline = None;
    let mut lines = Vec::new();
    for text in shown_text(l).split('\n') {
        let mut buf = Buffer::new(fonts, Metrics::new(size, size));
        buf.set_size(None, None);
        buf.set_text(text, &attrs, Shaping::Advanced, None);
        buf.shape_until_scroll(fonts, false);
        let mut b = PathBuilder::new();
        let mut width = 0.0f32;
        for run in buf.layout_runs() {
            for g in run.glyphs {
                width = width.max(g.x + g.w);
                if baseline.is_none()
                    && let Some(font) = fonts.get_font(g.font_id, g.font_weight)
                {
                    let mt = font.as_swash().metrics(&[]);
                    let (asc, desc) = (f64::from(mt.ascent), f64::from(mt.descent.abs()));
                    if asc + desc > 0.0 {
                        let em_ascent = f64::from(size) * asc / (asc + desc);
                        baseline = Some(em_ascent - f64::from(size) / 2.0);
                    }
                }
                let key =
                    CacheKey::new(g.font_id, g.glyph_id, g.font_size, (0.0, 0.0), g.font_weight, g.cache_key_flags).0;
                let (gx, gy) = (g.x + g.font_size * g.x_offset, g.y - g.font_size * g.y_offset);
                let Some(cmds) = cache.get_outline_commands(fonts, key) else { continue };
                let p = |v: swash::zeno::Point| (gx + v.x, gy - v.y);
                for c in cmds {
                    match *c {
                        Command::MoveTo(a) => {
                            let (x, y) = p(a);
                            b.move_to(x, y);
                        }
                        Command::LineTo(a) => {
                            let (x, y) = p(a);
                            b.line_to(x, y);
                        }
                        Command::QuadTo(c1, a) => {
                            let ((x1, y1), (x, y)) = (p(c1), p(a));
                            b.quad_to(x1, y1, x, y);
                        }
                        Command::CurveTo(c1, c2, a) => {
                            let ((x1, y1), (x2, y2), (x, y)) = (p(c1), p(c2), p(a));
                            b.cubic_to(x1, y1, x2, y2, x, y);
                        }
                        Command::Close => b.close(),
                    }
                }
            }
        }
        lines.push(Line { path: b.finish(), width: f64::from(width) });
    }
    Shaped { lines, baseline: baseline.unwrap_or(0.0) }
}
