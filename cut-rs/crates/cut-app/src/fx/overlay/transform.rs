//! The selected clip's box on the Program monitor (`ui-overlay.js` `layout` and `drag`): where its parts are, which
//! part a point takes, and the property values a drag of a part writes. Pure: screen points in, values out.
//!
//! The JavaScript has the box (move), the corners (scale about the anchor, both axes by the distance), and the knob
//! (rotate, Shift: 15 degree steps). Premiere's other handles are here as well: an edge scales one axis, the anchor
//! mark moves the anchor point while the picture stays, and in crop mode the corners and edges crop.

use cut_model::keyframes::Value;

use super::geom::{Frame, P, Placement, dist, round1, seq_delta_to_layer, to_seq};

/// A part of the box a press can take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Move,
    /// Corner 0 top left, 1 top right, 2 bottom right, 3 bottom left.
    Corner(usize),
    /// Edge 0 top, 1 right, 2 bottom, 3 left (the order of `crop`).
    Edge(usize),
    Rotate,
    Anchor,
}

impl Part {
    /// The undo step's name.
    pub fn label(self, crop: bool) -> &'static str {
        match self {
            Part::Corner(_) | Part::Edge(_) if crop => "Crop",
            Part::Move => "Position",
            Part::Corner(_) | Part::Edge(_) => "Scale",
            Part::Rotate => "Rotation",
            Part::Anchor => "Anchor Point",
        }
    }
}

/// The box on screen (points).
#[derive(Debug, Clone, PartialEq)]
pub struct BoxGeom {
    pub corners: [P; 4],
    /// The middle of each edge.
    pub edges: [P; 4],
    pub top_mid: P,
    pub knob: P,
    /// The anchor point on screen (the clip's position).
    pub anchor: P,
}

/// Where the box of a clip placed as `p` is drawn in frame `fr`.
pub fn geometry(fr: &Frame, p: &Placement) -> BoxGeom {
    let [x, y, w, h] = p.content;
    let at = |q: P| fr.to_screen(to_seq(p, q));
    let corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(at);
    let edges = [[x + w / 2.0, y], [x + w, y + h / 2.0], [x + w / 2.0, y + h], [x, y + h / 2.0]].map(at);
    let top_mid = edges[0];
    let a = p.rotation.to_radians();
    let knob = [top_mid[0] + 26.0 * a.sin(), top_mid[1] - 26.0 * a.cos()];
    let anchor = fr.to_screen([p.seq[0] / 2.0 + p.position[0], p.seq[1] / 2.0 + p.position[1]]);
    BoxGeom { corners, edges, top_mid, knob, anchor }
}

/// Whether `pt` is inside the polygon (even-odd, `inside`).
fn inside(pt: P, poly: &[P]) -> bool {
    let mut inn = false;
    let mut j = poly.len().wrapping_sub(1);
    for i in 0..poly.len() {
        let ([xi, yi], [xj, yj]) = (poly[i], poly[j]);
        if (yi > pt[1]) != (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi {
            inn = !inn;
        }
        j = i;
    }
    inn
}

/// The part under `pt`, the ones drawn on top first: the corner squares (9 points), the edge squares, the knob
/// (radius 6), the anchor mark, the box itself.
pub fn hit(g: &BoxGeom, pt: P) -> Option<Part> {
    let square = |c: P, half: f64| (c[0] - pt[0]).abs() <= half && (c[1] - pt[1]).abs() <= half;
    if let Some(i) = (0..4).find(|&i| square(g.corners[i], 5.0)) {
        return Some(Part::Corner(i));
    }
    if let Some(i) = (0..4).find(|&i| square(g.edges[i], 4.5)) {
        return Some(Part::Edge(i));
    }
    if dist(g.knob, pt) <= 7.0 {
        return Some(Part::Rotate);
    }
    if dist(g.anchor, pt) <= 6.0 {
        return Some(Part::Anchor);
    }
    inside(pt, &g.corners).then_some(Part::Move)
}

/// A press on the box: what the drag starts from.
#[derive(Debug, Clone, PartialEq)]
pub struct Press {
    pub part: Part,
    pub start: P,
    pub fr: Frame,
    pub p0: Placement,
    pub g0: BoxGeom,
    /// The corners and edges crop instead of scaling.
    pub crop: bool,
}

/// The values the drag writes with the pointer at `pt` (`shift`: Shift held), as `(property, value)`.
pub fn drag(d: &Press, pt: P, shift: bool) -> Vec<(&'static str, Value)> {
    let (start, p0, k) = (d.start, &d.p0, d.fr.k);
    let anchor = d.g0.anchor;
    let delta = || {
        let (mut dx, mut dy) = ((pt[0] - start[0]) / k, (pt[1] - start[1]) / k);
        if shift {
            if dx.abs() > dy.abs() {
                dy = 0.0;
            } else {
                dx = 0.0;
            }
        }
        [dx, dy]
    };
    match d.part {
        Part::Move => {
            let [dx, dy] = delta();
            vec![("position", Value::List(vec![round1(p0.position[0] + dx), round1(p0.position[1] + dy)]))]
        }
        Part::Corner(i) | Part::Edge(i) if d.crop => {
            let dq = seq_delta_to_layer(p0, [(pt[0] - start[0]) / k, (pt[1] - start[1]) / k]);
            let [w, h] = p0.size;
            let mut crop = p0.crop;
            let sides: &[usize] = match d.part {
                Part::Corner(_) => [[0, 3], [0, 1], [2, 1], [2, 3]][i].as_slice(),
                _ => std::slice::from_ref(&[0, 1, 2, 3][i]),
            };
            for &side in sides {
                let change = match side {
                    0 => dq[1] / h,
                    1 => -dq[0] / w,
                    2 => -dq[1] / h,
                    _ => dq[0] / w,
                };
                crop[side] = round1((p0.crop[side] + change * 100.0).clamp(0.0, 100.0));
            }
            vec![("crop", Value::List(crop.to_vec()))]
        }
        Part::Corner(_) => {
            let d0 = dist(start, anchor);
            let f = dist(pt, anchor) / if d0 == 0.0 { 1.0 } else { d0 };
            vec![("scale", Value::List(p0.scale.iter().map(|s| round1(s * f).max(0.0)).collect()))]
        }
        Part::Edge(i) => {
            // along the layer's x axis for the side edges, its y axis for the top and bottom
            let a = p0.rotation.to_radians();
            let axis = if i % 2 == 1 { [a.cos(), a.sin()] } else { [-a.sin(), a.cos()] };
            let along = |q: P| (q[0] - anchor[0]) * axis[0] + (q[1] - anchor[1]) * axis[1];
            let a0 = along(start);
            let f = if a0.abs() < 1e-9 { 1.0 } else { along(pt) / a0 };
            let mut scale = p0.scale;
            let j = if i % 2 == 1 { 0 } else { 1 };
            scale[j] = round1(scale[j] * f).max(0.0);
            vec![("scale", Value::List(scale.to_vec()))]
        }
        Part::Rotate => {
            let a0 = (start[1] - anchor[1]).atan2(start[0] - anchor[0]);
            let a1 = (pt[1] - anchor[1]).atan2(pt[0] - anchor[0]);
            let r = p0.rotation + (a1 - a0).to_degrees();
            let r = if shift { (r / 15.0 + 0.5).floor() * 15.0 } else { round1(r) };
            vec![("rotation", Value::Num(r))]
        }
        Part::Anchor => {
            let d = delta();
            let dq = seq_delta_to_layer(p0, d);
            vec![
                ("anchor", Value::List(vec![round1(p0.anchor[0] + dq[0]), round1(p0.anchor[1] + dq[1])])),
                ("position", Value::List(vec![round1(p0.position[0] + d[0]), round1(p0.position[1] + d[1])])),
            ]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(part: Part, start: P, p0: Placement, crop: bool) -> Press {
        let fr = Frame { origin: [100.0, 50.0], k: 0.5 };
        let g0 = geometry(&fr, &p0);
        Press { part, start, fr, p0, g0, crop }
    }

    fn full(rotation: f64) -> Placement {
        Placement {
            seq: [1920.0, 1080.0],
            size: [1920.0, 1080.0],
            content: [-960.0, -540.0, 1920.0, 1080.0],
            position: [0.0, 0.0],
            scale: [100.0, 100.0],
            rotation,
            anchor: [0.0, 0.0],
            crop: [0.0; 4],
        }
    }

    fn list(v: &Value) -> Vec<f64> {
        match v {
            Value::List(l) => l.clone(),
            _ => panic!("{v:?}"),
        }
    }

    #[test]
    fn the_box_sits_on_the_frame_and_its_parts_are_hit() {
        let fr = Frame { origin: [100.0, 50.0], k: 0.5 };
        let g = geometry(&fr, &full(0.0));
        assert_eq!(g.corners, [[100.0, 50.0], [1060.0, 50.0], [1060.0, 590.0], [100.0, 590.0]]);
        assert_eq!(g.anchor, [580.0, 320.0]);
        assert_eq!(g.knob, [580.0, 24.0]);
        assert_eq!(hit(&g, [103.0, 52.0]), Some(Part::Corner(0)));
        assert_eq!(hit(&g, [1060.0, 320.0]), Some(Part::Edge(1)));
        assert_eq!(hit(&g, [580.0, 26.0]), Some(Part::Rotate));
        assert_eq!(hit(&g, [582.0, 321.0]), Some(Part::Anchor));
        assert_eq!(hit(&g, [300.0, 300.0]), Some(Part::Move));
        assert_eq!(hit(&g, [1200.0, 300.0]), None);
    }

    #[test]
    fn moving_writes_the_position_in_sequence_pixels_and_shift_keeps_one_axis() {
        let d = press(Part::Move, [300.0, 300.0], full(0.0), false);
        assert_eq!(list(&drag(&d, [350.0, 310.0], false)[0].1), vec![100.0, 20.0]);
        assert_eq!(list(&drag(&d, [350.0, 310.0], true)[0].1), vec![100.0, 0.0]);
    }

    #[test]
    fn a_corner_scales_by_the_distance_to_the_anchor() {
        let d = press(Part::Corner(2), [1060.0, 590.0], full(0.0), false);
        // half way back to the anchor: half the size
        let r = drag(&d, [820.0, 455.0], false);
        assert_eq!(r[0].0, "scale");
        assert_eq!(list(&r[0].1), vec![50.0, 50.0]);
    }

    #[test]
    fn an_edge_scales_its_own_axis_even_when_rotated() {
        let d = press(Part::Edge(1), [1060.0, 320.0], full(0.0), false);
        assert_eq!(list(&drag(&d, [1300.0, 400.0], false)[0].1), vec![150.0, 100.0]);
        // rotated 90 degrees the right edge points down
        let p = full(90.0);
        let fr = Frame { origin: [100.0, 50.0], k: 0.5 };
        let g = geometry(&fr, &p);
        let d = press(Part::Edge(1), g.edges[1], p, false);
        let target = [g.edges[1][0], g.anchor[1] + (g.edges[1][1] - g.anchor[1]) * 2.0];
        assert_eq!(list(&drag(&d, target, false)[0].1), vec![200.0, 100.0]);
    }

    #[test]
    fn the_knob_rotates_about_the_anchor_and_shift_snaps_to_15_degrees() {
        let d = press(Part::Rotate, [580.0, 24.0], full(0.0), false);
        let r = drag(&d, [876.0, 320.0], false);
        assert_eq!(r[0], ("rotation", Value::Num(90.0)));
        let r = drag(&d, [700.0, 100.0], true);
        let Value::Num(x) = r[0].1 else { panic!() };
        assert_eq!(x % 15.0, 0.0);
    }

    #[test]
    fn the_anchor_moves_with_the_position_so_the_picture_stays() {
        let mut p = full(30.0);
        p.scale = [50.0, 200.0];
        let d = press(Part::Anchor, [580.0, 320.0], p.clone(), false);
        let r = drag(&d, [600.0, 330.0], false);
        let (a, pos) = (list(&r[0].1), list(&r[1].1));
        let mut q = p.clone();
        q.anchor = [a[0], a[1]];
        q.position = [pos[0], pos[1]];
        for corner in [[-960.0, -540.0], [960.0, 540.0]] {
            assert!(dist(to_seq(&p, corner), to_seq(&q, corner)) < 0.5, "{corner:?} stays");
        }
    }

    #[test]
    fn in_crop_mode_the_edges_and_corners_crop() {
        let d = press(Part::Edge(3), [100.0, 320.0], full(0.0), true);
        // 96 points right is 192 sequence pixels: 10 % of the width
        assert_eq!(list(&drag(&d, [196.0, 320.0], false)[0].1), vec![0.0, 0.0, 0.0, 10.0]);
        let d = press(Part::Corner(2), [1060.0, 590.0], full(0.0), true);
        assert_eq!(list(&drag(&d, [1012.0, 563.0], false)[0].1), vec![0.0, 5.0, 5.0, 0.0]);
        assert_eq!(list(&drag(&d, [0.0, 0.0], false)[0].1), vec![0.0, 100.0, 100.0, 0.0]);
        assert_eq!(Part::Edge(0).label(true), "Crop");
    }
}
