//! The scopes' cells: the pictures stretched over each cell, the levels' lines and labels, the vectorscope's circle,
//! skin tone line and colour bar targets (`ui-scopes.js`'s `drawWave`, `drawVector`, `drawHist`, `levels`).

use std::collections::HashMap;

use eframe::egui::{self, Align2, Color32, FontId, Pos2, Rect, Stroke, TextureHandle, Vec2};

use super::{BG, Kind, RANGE, SIZE, SKIN_DEGREES};
use crate::i18n::tr;

const GRID: Color32 = Color32::from_rgba_premultiplied(41, 41, 41, 41);
const TEXT: Color32 = Color32::from_rgba_premultiplied(140, 140, 140, 140);
/// The colour bars the targets mark (`scopes.js` BARS).
const BARS: [(&str, [f64; 3]); 6] = [
    ("R", [1.0, 0.0, 0.0]),
    ("MG", [1.0, 0.0, 1.0]),
    ("B", [0.0, 0.0, 1.0]),
    ("CY", [0.0, 1.0, 1.0]),
    ("G", [0.0, 1.0, 0.0]),
    ("YL", [1.0, 1.0, 0.0]),
];

/// Cb, Cr of sRGB values 0..1 (exact Rec. 709).
fn chroma(c: [f64; 3]) -> (f64, f64) {
    let y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    ((c[2] - y) / 1.8556, (c[0] - y) / 1.5748)
}

/// Where Cb, Cr fall in the vectorscope's square, in bins.
fn vector_at(cb: f64, cr: f64) -> [f64; 2] {
    let n = f64::from(SIZE);
    [((cb + RANGE) * n) / (2.0 * RANGE), ((RANGE - cr) * n) / (2.0 * RANGE)]
}

/// The cells in a grid: as many columns of at least 120 points as fit, rows sharing the height.
fn cells(area: Rect, n: usize) -> Vec<Rect> {
    let gap = 4.0;
    let inner = area.shrink(gap);
    let cols = (((inner.width() + gap) / (120.0 + gap)).floor() as usize).clamp(1, n.max(1));
    let rows = n.div_ceil(cols).max(1);
    let w = (inner.width() - gap * (cols - 1) as f32) / cols as f32;
    let h = (inner.height() - gap * (rows - 1) as f32) / rows as f32;
    (0..n)
        .map(|i| {
            let (c, r) = ((i % cols) as f32, (i / cols) as f32);
            Rect::from_min_size(inner.min + Vec2::new(c * (w + gap), r * (h + gap)), Vec2::new(w, h))
        })
        .collect()
}

fn image(p: &egui::Painter, t: &TextureHandle, at: Rect) {
    p.image(t.id(), at, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);
}

/// The lines at every 10% (labels at every 20) over a plot.
fn levels(p: &egui::Painter, plot: Rect) {
    for v in (0..=100).step_by(10) {
        let y = (plot.top() + (1.0 - v as f32 / 100.0) * plot.height()).round() + 0.5;
        p.hline(plot.x_range(), y, Stroke::new(1.0, GRID));
        if v % 20 == 0 {
            p.text(
                Pos2::new(plot.left() - 3.0, y),
                Align2::RIGHT_CENTER,
                v.to_string(),
                FontId::proportional(9.0),
                TEXT,
            );
        }
    }
}

/// The area a waveform, parade or histogram is drawn in.
fn plot_of(cell: Rect) -> Rect {
    Rect::from_min_max(cell.min + Vec2::new(24.0, 8.0), cell.max - Vec2::new(6.0, 8.0))
}

fn vector(p: &egui::Painter, cell: Rect, t: Option<&TextureHandle>) {
    let side = (cell.width().min(cell.height()) - 12.0).max(16.0);
    let sq = Rect::from_center_size(cell.center(), Vec2::splat(side));
    if let Some(t) = t {
        image(p, t, sq);
    }
    let k = side / SIZE as f32;
    let c = sq.center();
    let rad = (0.5 / RANGE) as f32 * (side / 2.0);
    let grid = Stroke::new(1.0, GRID);
    p.circle_stroke(c, rad, grid);
    p.line_segment([c - Vec2::new(rad, 0.0), c + Vec2::new(rad, 0.0)], grid);
    p.line_segment([c - Vec2::new(0.0, rad), c + Vec2::new(0.0, rad)], grid);
    let a = SKIN_DEGREES.to_radians() as f32;
    p.line_segment(
        [c, c + Vec2::new(a.cos() * rad, -a.sin() * rad)],
        Stroke::new(1.0, Color32::from_rgba_unmultiplied(255, 200, 150, 115)),
    );
    let bx = (side * 0.035).max(5.0);
    let at = |v: [f64; 2]| sq.min + Vec2::new(v[0] as f32 * k, v[1] as f32 * k);
    for (name, bar) in BARS {
        let (cb75, cr75) = chroma(bar.map(|v| v * 0.75));
        let (cb, cr) = chroma(bar);
        let t75 = at(vector_at(cb75, cr75));
        p.rect_stroke(
            Rect::from_center_size(t75, Vec2::splat(bx)),
            0.0,
            Stroke::new(1.0, Color32::from_white_alpha(140)),
            egui::StrokeKind::Middle,
        );
        p.rect_filled(
            Rect::from_center_size(at(vector_at(cb, cr)), Vec2::splat(3.0)),
            0.0,
            Color32::from_white_alpha(89),
        );
        let d = t75 - c;
        let dir = if d.length() > 0.0 { d / d.length() } else { Vec2::X };
        p.text(t75 + dir * (bx + 6.0), Align2::CENTER_CENTER, name, FontId::proportional(9.0), TEXT);
    }
}

/// Draws the cells of the scopes shown.
pub fn grid(ui: &egui::Ui, area: Rect, shown: &[Kind], tex: &HashMap<Kind, Vec<TextureHandle>>) {
    for (kind, cell) in shown.iter().zip(cells(area, shown.len())) {
        let p = ui.painter_at(cell);
        p.rect_filled(cell, 3.0, BG);
        let list = tex.get(kind).map_or(&[][..], Vec::as_slice);
        match kind {
            Kind::Wave | Kind::Hist => {
                let plot = plot_of(cell);
                if let Some(t) = list.first() {
                    image(&p, t, plot);
                }
                levels(&p, plot);
            }
            Kind::Parade => {
                let plot = plot_of(cell);
                let pw = (plot.width() - 8.0) / 3.0;
                for (k, t) in list.iter().enumerate().take(3) {
                    let at = Rect::from_min_size(
                        plot.min + Vec2::new(k as f32 * (pw + 4.0), 0.0),
                        Vec2::new(pw, plot.height()),
                    );
                    image(&p, t, at);
                }
                levels(&p, plot);
            }
            Kind::Vector => vector(&p, cell, list.first()),
        }
        p.text(
            cell.right_top() + Vec2::new(-6.0, 3.0),
            Align2::RIGHT_TOP,
            tr(kind.name()),
            FontId::proportional(10.0),
            TEXT,
        );
        p.rect_stroke(cell, 3.0, Stroke::new(1.0, Color32::from_gray(48)), egui::StrokeKind::Inside);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_targets_sit_at_the_bars_angles() {
        // 75% red: 102.9 degrees counterclockwise from +Cb, as the JavaScript's targets()
        let (cb, cr) = chroma([0.75, 0.0, 0.0]);
        let [x, y] = vector_at(cb, cr);
        let n = f64::from(SIZE);
        let a = ((n / 2.0 - y).atan2(x - n / 2.0).to_degrees() + 360.0) % 360.0;
        assert!((a - 103.0).abs() < 0.2, "{a}");
        assert_eq!(vector_at(0.0, 0.0), [n / 2.0, n / 2.0]);
    }

    #[test]
    fn the_grid_fits_as_many_columns_as_its_width_takes() {
        let area = Rect::from_min_size(Pos2::ZERO, Vec2::new(300.0, 400.0));
        assert_eq!(cells(area, 2).len(), 2);
        assert!(cells(area, 2)[1].left() > 150.0, "two side by side");
        let narrow = Rect::from_min_size(Pos2::ZERO, Vec2::new(200.0, 400.0));
        assert!(cells(narrow, 2)[1].top() > 200.0, "stacked when there is no room");
    }
}
