//! The selected mask on the Program monitor (`ui-masks.js` `layoutLayer`, `hitTest`, `down`, `writePath`,
//! `penDown`): its parts on screen, which part a point takes, what a press and a drag do, and the commands that make
//! the edit. Pure: screen points and the clip in, commands out.

use cut_model::commands::build as C;
use cut_model::keyframes::Value;
use cut_model::masks::Mask;
use cut_model::masks::{self as M, Handle, PenPoint};
use cut_model::{Clip, Sequence};
use cut_time::Ticks;
use serde_json::{Value as Json, json};

use super::MaskSel;
use super::geom::{Mapping, P, dist, round1};
use crate::fx::edit;

/// The mask's holder on the clip: Opacity's masks, or an effect's.
fn masks_of(clip: &Clip, effect: Option<cut_model::Id>) -> &[Mask] {
    let list = match effect {
        None => clip.masks.as_ref(),
        Some(e) => clip.effects.iter().find(|x| x.id == e).and_then(|x| x.masks.as_ref()),
    };
    list.map_or(&[], Vec::as_slice)
}

/// The selected mask on its clip (`maskOf`).
pub fn mask_of<'c>(clip: &'c Clip, sel: &MaskSel) -> Option<&'c Mask> {
    masks_of(clip, sel.effect).iter().find(|m| m.id == sel.mask)
}

/// The keyframe path of one of the mask's fields (`prefix(sel).field`).
pub fn path_of(sel: &MaskSel, field: &str) -> String {
    format!("{}.{}.{field}", M::prefix_of(sel.effect.map(|e| e.as_str())), sel.mask.as_str())
}

/// The mask as drawn: its path (at the playhead), feather and expansion, and its parts on screen.
#[derive(Debug, Clone, PartialEq)]
pub struct MaskGeom {
    pub map: Mapping,
    /// The path in picture fractions.
    pub path: Vec<f64>,
    /// The path in screen points.
    pub sp: Vec<f64>,
    pub feather: f64,
    pub expansion: f64,
    /// The top of the mask, where the stem to the two handles starts.
    pub base: P,
    pub expand_at: P,
    pub feather_at: P,
}

/// The mask's geometry at sequence time `t`.
pub fn geometry(map: Mapping, seq: &Sequence, clip: &Clip, sel: &MaskSel, t: Ticks) -> Option<MaskGeom> {
    let m = mask_of(clip, sel)?;
    let v = |f: &str| edit::value_at(seq, clip, &path_of(sel, f), t);
    let path = match v("path") {
        Some(Value::List(p)) if M::valid_path(&p) => p,
        _ => m.path.clone(),
    };
    let num = |f: &str| match v(f) {
        Some(Value::Num(x)) if !x.is_nan() => x,
        _ => 0.0,
    };
    Some(layout(map, path, num("feather"), num("expansion")))
}

/// The parts of a mask with `path`, `feather` and `expansion` on screen: the expansion and feather handles above
/// the top of the mask, on the picture's up direction, at least 14 points apart so a small feather still has a
/// handle to take.
pub fn layout(map: Mapping, path: Vec<f64>, feather: f64, expansion: f64) -> MaskGeom {
    let sp = map.screen_path(&path);
    let [w, h] = map.p.size;
    let top = M::top_point(&path, w, h).unwrap_or([w / 2.0, h / 2.0]);
    let base = map.to(top[0] / w, top[1] / h);
    let e_at = expansion.max(0.0) * map.k_up;
    let f_at = e_at + (feather / 2.0 * map.k_up).max(14.0);
    let at = |d: f64| [base[0] + map.up[0] * d, base[1] + map.up[1] * d];
    let (expand_at, feather_at) = (at(e_at + 12.0), at(f_at + 12.0));
    MaskGeom { map, path, sp, feather, expansion, base, expand_at, feather_at }
}

/// The guide lines in screen points: the outline grown by the expansion, and by half the feather more (`None` when
/// there is nothing to show).
pub fn guides(g: &MaskGeom) -> (Option<Vec<P>>, Option<Vec<P>>) {
    let [w, h] = g.map.p.size;
    let pts = |d: f64| M::outline(&g.path, w, h, d).into_iter().map(|[x, y]| g.map.to(x / w, y / h)).collect();
    let e = (g.expansion != 0.0).then(|| pts(g.expansion));
    let f = (g.feather > 0.0).then(|| pts(g.expansion + g.feather / 2.0));
    (e, f)
}

/// A screen path flattened to points for drawing, `closed` adds its last edge.
pub fn polyline(sp: &[f64], closed: bool) -> Vec<P> {
    let n = M::count(sp);
    let mut out = Vec::new();
    let edges = if closed { n } else { n.saturating_sub(1) };
    for i in 0..edges {
        let e = M::edge(sp, i as i64, 1.0, 1.0);
        let steps = if e.straight { 1 } else { 24 };
        if i == 0 {
            out.push(e.p0);
        }
        for s in 1..=steps {
            out.push(M::cubic(&e, f64::from(s) / f64::from(steps)));
        }
    }
    if n == 1 {
        out.push([sp[0], sp[1]]);
    }
    out
}

/// The vertex `i` and its in and out handles' ends on screen.
pub fn handles_at(sp: &[f64], i: usize) -> (P, P, P) {
    let k = i * 6;
    let v = [sp[k], sp[k + 1]];
    (v, [v[0] + sp[k + 2], v[1] + sp[k + 3]], [v[0] + sp[k + 4], v[1] + sp[k + 5]])
}

/// What is under a point of the monitor while a mask is edited (`hitTest`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hit {
    Feather,
    Expansion,
    Handle(usize, Handle),
    Vertex(usize),
    /// Edge `index` at `t`.
    Edge(usize, f64),
    Inside,
    Outside,
}

/// The part of the mask under screen point `pt`.
pub fn hit(g: &MaskGeom, pt: P) -> Hit {
    if dist(g.feather_at, pt) <= 7.0 {
        return Hit::Feather;
    }
    if dist(g.expand_at, pt) <= 7.0 {
        return Hit::Expansion;
    }
    for i in 0..M::count(&g.sp) {
        if M::is_corner(&g.path, i) {
            continue;
        }
        let (_, hi, ho) = handles_at(&g.sp, i);
        if dist(hi, pt) <= 5.0 {
            return Hit::Handle(i, Handle::In);
        }
        if dist(ho, pt) <= 5.0 {
            return Hit::Handle(i, Handle::Out);
        }
    }
    let v = M::nearest_vertex(&g.sp, 1.0, 1.0, pt[0], pt[1]);
    if let Some(i) = v.index
        && v.distance <= 6.0
    {
        return Hit::Vertex(i);
    }
    let e = M::nearest_edge(&g.sp, 1.0, 1.0, pt[0], pt[1]);
    if let Some(i) = e.index
        && e.distance <= 5.0
    {
        return Hit::Edge(i, e.t);
    }
    if M::contains(&g.sp, 1.0, 1.0, pt[0], pt[1]) { Hit::Inside } else { Hit::Outside }
}

/// An edit of the vertices made on every keyframe of Mask Path (or the mask's own path), so the counts stay equal.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Structural {
    Insert(usize, f64),
    Remove(usize),
}

impl Structural {
    /// The edit made on one path.
    pub fn apply(self, path: &[f64]) -> Vec<f64> {
        match self {
            Structural::Insert(e, t) => M::insert_vertex(path, e as i64, t),
            Structural::Remove(i) => M::remove_vertex(path, i),
        }
    }
}

/// One edit of the mask a press or a drag makes.
#[derive(Debug, Clone, PartialEq)]
pub enum Edit {
    /// The path at the playhead (the keyframe there when Mask Path is keyframed).
    Path(Vec<f64>),
    Vertices(Structural),
    Feather(f64),
    Expansion(f64),
}

/// What a drag moves.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    Inside,
    Vertex(usize),
    Handle(usize, Handle),
    Feather,
    Expansion,
}

/// What a press does (`down`): let the mask go, edit at once (Ctrl+click on a vertex deletes it, Alt+click turns
/// it corner <-> smooth), or start a drag; a press on the outline adds a vertex there first and drags it.
#[derive(Debug, Clone, PartialEq)]
pub enum Press {
    Deselect,
    Once(Option<Edit>),
    Drag { first: Option<Edit>, target: Target, path0: Vec<f64> },
}

impl Press {
    /// The undo step's name.
    pub fn label(&self) -> &'static str {
        match self {
            Press::Drag { target: Target::Feather, .. } => "Mask Feather",
            Press::Drag { target: Target::Expansion, .. } => "Mask Expansion",
            _ => "Mask Path",
        }
    }
}

/// What a press on `h` does (`ctrl`: Ctrl or Cmd held, `alt`: Alt held).
pub fn press(g: &MaskGeom, h: Hit, ctrl: bool, alt: bool) -> Press {
    let [w, h_px] = g.map.p.size;
    let drag = |target| Press::Drag { first: None, target, path0: g.path.clone() };
    match h {
        Hit::Outside => Press::Deselect,
        Hit::Vertex(i) if ctrl => {
            Press::Once((M::count(&g.path) > M::MIN_POINTS).then_some(Edit::Vertices(Structural::Remove(i))))
        }
        Hit::Vertex(i) if alt => Press::Once(Some(Edit::Path(M::toggle_smooth(&g.path, i, w, h_px)))),
        Hit::Edge(e, t) => {
            let s = Structural::Insert(e, t);
            Press::Drag { first: Some(Edit::Vertices(s)), target: Target::Vertex(e + 1), path0: s.apply(&g.path) }
        }
        Hit::Vertex(i) => drag(Target::Vertex(i)),
        Hit::Handle(i, which) => drag(Target::Handle(i, which)),
        Hit::Inside => drag(Target::Inside),
        Hit::Feather => drag(Target::Feather),
        Hit::Expansion => drag(Target::Expansion),
    }
}

/// The edit a drag that started at `start` makes with the pointer at `pt` (`alt`: the handles break apart).
pub fn drag(g: &MaskGeom, target: Target, path0: &[f64], start: P, pt: P, alt: bool) -> Edit {
    let u0 = g.map.from(start);
    let u = g.map.from(pt);
    let (du, dv) = (u[0] - u0[0], u[1] - u0[1]);
    let along = ((pt[0] - start[0]) * g.map.up[0] + (pt[1] - start[1]) * g.map.up[1]) / g.map.k_up;
    match target {
        Target::Inside => Edit::Path(M::translate(path0, du, dv)),
        Target::Vertex(i) => Edit::Path(M::move_vertex(path0, i, du, dv)),
        Target::Handle(i, which) => {
            let k = i * 6;
            let [w, h] = g.map.p.size;
            Edit::Path(M::set_handle(path0, i, which, [u[0] - path0[k], u[1] - path0[k + 1]], w, h, alt))
        }
        Target::Expansion => {
            let [lo, hi] = M::RANGES.expansion;
            Edit::Expansion(round1((g.expansion + along).clamp(lo, hi)))
        }
        Target::Feather => Edit::Feather(round1((g.feather + 2.0 * along).clamp(0.0, M::RANGES.feather[1]))),
    }
}

/// The command that makes `edit` on the selected mask at sequence time `t` (`writePath`, `edit.write`).
pub fn command(seq: &Sequence, clip: &Clip, sel: &MaskSel, edit: &Edit, t: Ticks) -> Option<Json> {
    match edit {
        Edit::Path(p) => edit::write_cmd(seq, clip, &path_of(sel, "path"), &Value::List(p.clone()), t),
        Edit::Feather(v) => edit::write_cmd(seq, clip, &path_of(sel, "feather"), &Value::Num(*v), t),
        Edit::Expansion(v) => edit::write_cmd(seq, clip, &path_of(sel, "expansion"), &Value::Num(*v), t),
        Edit::Vertices(s) => {
            let kp = path_of(sel, "path");
            match clip.keyframes.get(&kp).filter(|l| !l.is_empty()) {
                Some(keys) => Some(edit::keys_cmd(seq.id, clip.id, &kp, &M::map_keyframes(keys, |p| s.apply(p)))),
                None => {
                    let path = s.apply(&mask_of(clip, sel)?.path);
                    let effect = sel.effect.map(|e| e.as_str());
                    Some(C::set_mask(
                        seq.id.as_str(),
                        clip.id.as_str(),
                        sel.mask.as_str(),
                        json!({ "path": path }),
                        effect,
                    ))
                }
            }
        }
    }
}

/// What a press with the pen does (`penDown`).
#[derive(Debug, Clone, PartialEq)]
pub enum PenPress {
    /// The first point clicked again: the path closes into a mask.
    Close(Vec<f64>),
    /// A new point (picture fractions); a drag pulls out its handles.
    Point(PenPoint),
}

/// What a press of the pen at `pt` does with `points` drawn so far.
pub fn pen_press(map: &Mapping, points: &[PenPoint], pt: P) -> PenPress {
    if points.len() >= M::MIN_POINTS && dist(map.to(points[0].x, points[0].y), pt) <= 7.0 {
        return PenPress::Close(M::from_points(points));
    }
    let [x, y] = map.from(pt);
    PenPress::Point(PenPoint { x, y, hx: 0.0, hy: 0.0 })
}

/// The point pressed at `press` with the pointer dragged to `pt`: its handle out to the pointer, once it has moved
/// 3 points.
pub fn pen_drag(map: &Mapping, p: PenPoint, press: P, pt: P) -> PenPoint {
    if dist(press, pt) < 3.0 {
        return p;
    }
    let u = map.from(pt);
    PenPoint { hx: u[0] - p.x, hy: u[1] - p.y, ..p }
}

#[cfg(test)]
mod tests {
    use super::super::geom::{Frame, Placement};
    use super::*;

    fn map() -> Mapping {
        let p = Placement {
            seq: [1280.0, 720.0],
            size: [1280.0, 720.0],
            content: [-640.0, -360.0, 1280.0, 720.0],
            position: [0.0, 0.0],
            scale: [100.0, 100.0],
            rotation: 0.0,
            anchor: [0.0, 0.0],
            crop: [0.0; 4],
        };
        Mapping::new(Frame { origin: [0.0, 0.0], k: 1.0 }, p)
    }

    fn ellipse() -> MaskGeom {
        layout(map(), M::ellipse(1280.0, 720.0, M::Place::default()), 10.0, 0.0)
    }

    #[test]
    fn the_parts_of_an_ellipse_are_where_the_javascript_puts_them() {
        let g = ellipse();
        // radius 180 px: top vertex at (640, 180); the expansion handle 12 above, the feather handle 14 more
        assert_eq!(g.base, [640.0, 180.0]);
        assert_eq!(g.expand_at, [640.0, 168.0]);
        assert_eq!(g.feather_at, [640.0, 154.0]);
        assert_eq!(hit(&g, [640.0, 155.0]), Hit::Feather);
        assert_eq!(hit(&g, [641.0, 168.0]), Hit::Expansion);
        assert_eq!(hit(&g, [822.0, 361.0]), Hit::Vertex(1));
        let (_, _, out) = handles_at(&g.sp, 0);
        assert_eq!(hit(&g, out), Hit::Handle(0, Handle::Out));
        assert_eq!(hit(&g, [640.0, 360.0]), Hit::Inside);
        assert_eq!(hit(&g, [100.0, 100.0]), Hit::Outside);
        assert!(matches!(hit(&g, [640.0 + 127.3, 360.0 - 127.3]), Hit::Edge(0, _)));
    }

    #[test]
    fn presses_delete_toggle_insert_or_drag() {
        let g = ellipse();
        assert_eq!(press(&g, Hit::Outside, false, false), Press::Deselect);
        assert_eq!(press(&g, Hit::Vertex(2), true, false), Press::Once(Some(Edit::Vertices(Structural::Remove(2)))));
        let Press::Once(Some(Edit::Path(p))) = press(&g, Hit::Vertex(1), false, true) else { panic!() };
        assert!(M::is_corner(&p, 1));
        let Press::Drag { first, target, path0 } = press(&g, Hit::Edge(0, 0.5), false, false) else { panic!() };
        assert_eq!(first, Some(Edit::Vertices(Structural::Insert(0, 0.5))));
        assert_eq!(target, Target::Vertex(1));
        assert_eq!(M::count(&path0), 5);
        assert_eq!(press(&g, Hit::Feather, false, false).label(), "Mask Feather");
        // three vertices stay
        let tri = layout(map(), M::remove_vertex(&g.path, 0), 0.0, 0.0);
        assert_eq!(press(&tri, Hit::Vertex(0), true, false), Press::Once(None));
    }

    #[test]
    fn drags_move_vertices_the_mask_handles_and_the_feather() {
        let g = ellipse();
        let Edit::Path(p) = drag(&g, Target::Vertex(1), &g.path, [820.0, 360.0], [920.0, 360.0], false) else {
            panic!()
        };
        assert!((p[6] * 1280.0 - 920.0).abs() < 1e-9);
        let Edit::Path(p) = drag(&g, Target::Inside, &g.path, [640.0, 360.0], [640.0, 432.0], false) else { panic!() };
        assert!((p[1] - (g.path[1] + 0.1)).abs() < 1e-12 && (p[7] - (g.path[7] + 0.1)).abs() < 1e-12);
        // dragging the feather handle 30 up adds 60 of feather
        assert_eq!(drag(&g, Target::Feather, &g.path, [640.0, 154.0], [640.0, 124.0], false), Edit::Feather(70.0));
        assert_eq!(drag(&g, Target::Expansion, &g.path, [640.0, 168.0], [640.0, 148.0], false), Edit::Expansion(20.0));
        // an unbroken handle turns its partner; Alt breaks them apart
        let start = handles_at(&g.sp, 0).2;
        let to = [start[0], start[1] + 50.0];
        let Edit::Path(p) = drag(&g, Target::Handle(0, Handle::Out), &g.path, start, to, false) else { panic!() };
        assert!(p[3] < 0.0, "the in handle turned the other way");
        let Edit::Path(p) = drag(&g, Target::Handle(0, Handle::Out), &g.path, start, to, true) else { panic!() };
        assert_eq!(p[3], 0.0);
    }

    #[test]
    fn the_pen_adds_points_pulls_handles_and_closes_on_the_first() {
        let m = map();
        let PenPress::Point(a) = pen_press(&m, &[], [128.0, 72.0]) else { panic!() };
        assert_eq!((a.x, a.y), (0.1, 0.1));
        assert_eq!(pen_drag(&m, a, [128.0, 72.0], [129.0, 73.0]), a);
        let b = pen_drag(&m, a, [128.0, 72.0], [256.0, 72.0]);
        assert!((b.hx - 0.1).abs() < 1e-12 && b.hy == 0.0);
        let pts = [a, b, PenPoint { x: 0.5, y: 0.5, hx: 0.0, hy: 0.0 }];
        let PenPress::Close(path) = pen_press(&m, &pts, [130.0, 70.0]) else { panic!() };
        assert_eq!(M::count(&path), 3);
        assert!(matches!(pen_press(&m, &pts[..2], [130.0, 70.0]), PenPress::Point(_)));
    }

    #[test]
    fn the_guides_follow_the_expansion_and_half_the_feather() {
        let g = layout(map(), M::ellipse(1280.0, 720.0, M::Place::default()), 40.0, 10.0);
        let (e, f) = guides(&g);
        let top = |l: &[P]| l.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min);
        // `masks.outline` moves a clockwise (on screen) path's points inward for a positive distance, so the
        // JavaScript draws these guides inside the made shapes; kept as it is
        assert!((top(&e.unwrap()) - (180.0 + 10.0)).abs() < 1e-6);
        assert!((top(&f.unwrap()) - (180.0 + 30.0)).abs() < 1e-6);
        let flat = layout(map(), g.path.clone(), 0.0, 0.0);
        assert_eq!(guides(&flat), (None, None));
    }
}
