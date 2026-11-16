//! Painting the handles over the picture (the colours and sizes of `panels.css`'s `.cut-ov-*` and `.cut-mask-*`).

use cut_model::masks::{self as M, PenPoint};
use eframe::egui::{Color32, Painter, Pos2, Rect, Shape, Stroke, StrokeKind, pos2, vec2};

use super::geom::{Mapping, P};
use super::mask::{self, MaskGeom};
use super::transform::BoxGeom;

/// `--yellow` of the dark theme.
const YELLOW: Color32 = Color32::from_rgb(0xf2, 0xc5, 0x5c);

fn pt(p: P) -> Pos2 {
    pos2(p[0] as f32, p[1] as f32)
}

fn square(painter: &Painter, at: P, size: f32, fill: Color32, stroke: Stroke) {
    let r = Rect::from_center_size(pt(at), vec2(size, size));
    painter.rect_filled(r, 0.0, fill);
    painter.rect_stroke(r, 0.0, stroke, StrokeKind::Middle);
}

/// The clip's box: the frame, its corner (and edge) squares, the rotation knob on its stem, the anchor mark. In crop
/// mode the squares are hollow.
pub fn transform_box(painter: &Painter, g: &BoxGeom, blue6: Color32, blue8: Color32, crop: bool) {
    painter.add(Shape::closed_line(g.corners.iter().map(|c| pt(*c)).collect(), Stroke::new(1.2, blue8)));
    painter.line_segment([pt(g.top_mid), pt(g.knob)], Stroke::new(1.0, blue8));
    painter.circle(pt(g.knob), 6.0, blue6, Stroke::new(1.0, Color32::WHITE));
    let mark = Color32::from_white_alpha(204);
    let a = pt(g.anchor);
    painter.circle_stroke(a, 5.0, Stroke::new(1.0, mark));
    painter.line_segment([a - vec2(8.0, 0.0), a + vec2(8.0, 0.0)], Stroke::new(1.0, mark));
    painter.line_segment([a - vec2(0.0, 8.0), a + vec2(0.0, 8.0)], Stroke::new(1.0, mark));
    let fill = if crop { Color32::TRANSPARENT } else { Color32::WHITE };
    let stroke = Stroke::new(if crop { 2.0 } else { 1.0 }, if crop { Color32::WHITE } else { blue6 });
    for c in &g.corners {
        square(painter, *c, 9.0, fill, stroke);
    }
    for e in &g.edges {
        square(painter, *e, 7.0, fill, stroke);
    }
}

/// The selected mask: the guide lines, the outline, the handles of its smooth vertices, the vertices, the stem with
/// the expansion square and the feather circle.
pub fn mask(painter: &Painter, g: &MaskGeom) {
    let (e, f) = mask::guides(g);
    let guide = Stroke::new(1.0, YELLOW.gamma_multiply(0.7));
    if let Some(e) = e {
        painter.add(Shape::closed_line(e.into_iter().map(pt).collect(), guide));
    }
    if let Some(mut f) = f {
        f.push(f[0]);
        painter.extend(Shape::dashed_line(&f.into_iter().map(pt).collect::<Vec<_>>(), guide, 4.0, 3.0));
    }
    painter.add(Shape::line(mask::polyline(&g.sp, true).into_iter().map(pt).collect(), Stroke::new(1.3, YELLOW)));
    let line = Stroke::new(1.0, YELLOW);
    for i in 0..M::count(&g.sp) {
        if M::is_corner(&g.path, i) {
            continue;
        }
        let (v, hi, ho) = mask::handles_at(&g.sp, i);
        for h in [hi, ho] {
            painter.line_segment([pt(v), pt(h)], line);
            painter.circle(pt(h), 3.5, Color32::WHITE, line);
        }
    }
    for i in 0..M::count(&g.sp) {
        let fill = if M::is_corner(&g.path, i) { YELLOW } else { Color32::WHITE };
        square(painter, mask::handles_at(&g.sp, i).0, 7.0, fill, Stroke::new(0.8, Color32::BLACK));
    }
    painter.line_segment([pt(g.base), pt(g.feather_at)], line);
    square(painter, g.expand_at, 8.0, Color32::WHITE, line);
    painter.circle_stroke(pt(g.feather_at), 4.5, Stroke::new(1.5, YELLOW));
}

/// The pen's path so far: dashed, open, its points (the first one white).
pub fn pen(painter: &Painter, map: &Mapping, points: &[PenPoint]) {
    if points.is_empty() {
        return;
    }
    let sp = map.screen_path(&M::from_points(points));
    let line: Vec<Pos2> = mask::polyline(&sp, false).into_iter().map(pt).collect();
    painter.extend(Shape::dashed_line(&line, Stroke::new(1.3, YELLOW), 5.0, 3.0));
    for i in 0..M::count(&sp) {
        let at = [sp[i * 6], sp[i * 6 + 1]];
        if i == 0 {
            square(painter, at, 7.0, Color32::WHITE, Stroke::new(1.5, YELLOW));
        } else {
            square(painter, at, 7.0, YELLOW, Stroke::new(0.8, Color32::BLACK));
        }
    }
}
