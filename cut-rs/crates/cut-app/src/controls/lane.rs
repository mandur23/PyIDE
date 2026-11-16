//! The keyframe lanes of Effect Controls (`ui-controls.js`'s `laneX`, `laneT`, `direction`, `segment`, `keyAt`,
//! `handleAt` and the two drags): a lane is the clip's span, 6 points in from each side, with the property's keyframes
//! on its middle line and each segment's shape from one value to the next (a step for hold, the timing curve for the
//! others; a bezier segment shows its handles where there is room to grab them).
//!
//! The geometry is pure, in lane points from the lane's top left, so `tests/controls_oracle.rs` compares it with the
//! JavaScript's own functions; [`paint`] draws a lane with it.

use cut_model::keyframes::{self as K, Ease, Keyframe, Value};
use cut_time::Ticks;
use eframe::egui::{self, Color32, Pos2, Rect, Shape, Stroke, pos2};

/// The space between a segment's lowest and highest value and the lane's edges.
pub const PAD: f64 = 4.0;

/// The x of clip time `t` in a lane `w` wide for a clip `d` ticks long (`laneX`).
pub fn lane_x(d: Ticks, w: f64, t: f64) -> f64 {
    6.0 + (t / (d.max(1) as f64)) * (w - 12.0)
}

/// The clip time at lane x (`laneT`).
pub fn lane_t(d: Ticks, w: f64, x: f64) -> f64 {
    ((x - 6.0) / (w - 12.0).max(1.0)) * d as f64
}

/// Which way a segment's value goes: up (1) or down (-1); a value that does not change counts as up (`direction`).
pub fn direction(a: &Value, b: &Value) -> i32 {
    match (a, b) {
        (Value::Num(a), Value::Num(b)) => {
            if b < a {
                -1
            } else {
                1
            }
        }
        (Value::List(a), Value::List(b)) => {
            for (x, y) in a.iter().zip(b) {
                if y != x {
                    return if y < x { -1 } else { 1 };
                }
            }
            1
        }
        _ => 1,
    }
}

/// The drawing of segment i (keyframe i to i + 1) in lane points (`segment`).
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub xa: f64,
    pub xb: f64,
    dir: i32,
    lo: f64,
    hi: f64,
    /// The bezier control points of its timing curve (none for hold).
    pub pts: Option<[[f64; 2]; 2]>,
    /// The handles shown: a bezier segment's control points when it is at least 16 points wide.
    pub handles: Option<[[f64; 2]; 2]>,
    pub ease: Ease,
}

impl Segment {
    /// The y of progress p (0 at the first value, 1 at the next).
    pub fn y_of(&self, p: f64) -> f64 {
        if self.dir > 0 { self.lo - p * (self.lo - self.hi) } else { self.hi + p * (self.lo - self.hi) }
    }

    /// The progress at y.
    pub fn p_of(&self, y: f64) -> f64 {
        if self.dir > 0 { (self.lo - y) / (self.lo - self.hi) } else { (y - self.hi) / (self.lo - self.hi) }
    }
}

/// Segment i of a lane `w` x `h` (`None` for the last keyframe).
pub fn segment(d: Ticks, list: &[Keyframe], i: usize, w: f64, h: f64) -> Option<Segment> {
    let (a, b) = (list.get(i)?, list.get(i + 1)?);
    let (xa, xb) = (lane_x(d, w, a.t as f64), lane_x(d, w, b.t as f64));
    let mut s =
        Segment { xa, xb, dir: direction(&a.v, &b.v), lo: h - PAD, hi: PAD, pts: None, handles: None, ease: a.ease };
    let hd = if a.ease == Ease::Hold { None } else { K::handles(a.ease, a.h.as_deref()) };
    s.pts = hd.map(|hd| {
        let at = |k: usize| hd.get(k).copied().unwrap_or(f64::NAN);
        [[xa + at(0) * (xb - xa), s.y_of(at(1))], [xa + at(2) * (xb - xa), s.y_of(at(3))]]
    });
    s.handles = s.pts.filter(|_| a.ease == Ease::Bezier && xb - xa >= 16.0);
    Some(s)
}

/// The keyframe within 6 points of x, the nearest (`keyAt`) -> its time.
pub fn key_at(d: Ticks, list: &[Keyframe], w: f64, x: f64) -> Option<Ticks> {
    let mut best: Option<(Ticks, f64)> = None;
    for k in list {
        let dist = (lane_x(d, w, k.t as f64) - x).abs();
        if dist <= 6.0 && best.is_none_or(|(_, b)| dist < b) {
            best = Some((k.t, dist));
        }
    }
    best.map(|b| b.0)
}

/// A bezier handle within 5 points of (x, y) (`handleAt`) -> (segment, which: 0 | 1).
pub fn handle_at(d: Ticks, list: &[Keyframe], w: f64, h: f64, x: f64, y: f64) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize, f64)> = None;
    for i in 0..list.len().saturating_sub(1) {
        let Some(hs) = segment(d, list, i, w, h).and_then(|s| s.handles) else { continue };
        for (which, [hx, hy]) in hs.into_iter().enumerate() {
            let dist = (hx - x).hypot(hy - y);
            if dist <= 5.0 && best.is_none_or(|b| dist < b.2) {
                best = Some((i, which, dist));
            }
        }
    }
    best.map(|b| (b.0, b.1))
}

/// How far a keyframe drag of `dx` points moves the keys: whole frames of `f` (`d` in the drag).
pub fn drag_delta(d: Ticks, f: Ticks, w: f64, dx: f64) -> Ticks {
    ((dx / (w - 12.0).max(1.0)) * d as f64 / f as f64).round() as Ticks * f
}

/// A keyframe list with the keys at `times` moved by `delta`, kept inside the clip's frames.
pub fn moved(base: &[Keyframe], times: &[Ticks], delta: Ticks, d: Ticks, f: Ticks) -> Vec<Keyframe> {
    let mut list: Vec<Keyframe> = base.iter().filter(|k| !times.contains(&k.t)).cloned().collect();
    for k in base.iter().filter(|k| times.contains(&k.t)) {
        let t = (k.t + delta).clamp(0, (d - f).max(0));
        list = K::insert(&list, &Keyframe { t, ..k.clone() });
    }
    list
}

/// A bezier handle dragged to lane point (x, y): x stays inside the segment (0..1), y may overshoot (-1..2), both
/// rounded to thousandths -> the keyframe's new handles.
pub fn dragged_handles(seg: &Segment, k: &Keyframe, which: usize, x: f64, y: f64) -> Vec<f64> {
    let u = ((x - seg.xa) / (seg.xb - seg.xa).max(1.0)).clamp(0.0, 1.0);
    let p = seg.p_of(y).clamp(-1.0, 2.0);
    let mut h = k.h.clone().or_else(|| K::handles(k.ease, None)).unwrap_or_else(|| K::DEFAULT_HANDLES.to_vec());
    h.resize(4, 0.0);
    h[which * 2] = (u * 1000.0).round() / 1000.0;
    h[which * 2 + 1] = (p * 1000.0).round() / 1000.0;
    h
}

/// The colours a lane is drawn in.
pub struct Colors {
    pub line: Color32,
    pub curve: Color32,
    pub text: Color32,
    pub accent: Color32,
    pub playhead: Color32,
}

/// Draws a property's lane in `rect`: its middle line, each segment's shape and handles, the keyframes (the picked
/// ones in the accent colour) and the playhead.
pub fn paint(
    p: &egui::Painter,
    rect: Rect,
    d: Ticks,
    list: &[Keyframe],
    picked: impl Fn(Ticks) -> bool,
    playhead: Option<Ticks>,
    c: &Colors,
) {
    let (w, h) = (f64::from(rect.width()), f64::from(rect.height()));
    let at = |x: f64, y: f64| pos2(rect.left() + x as f32, rect.top() + y as f32);
    p.rect_filled(
        Rect::from_x_y_ranges(rect.left() + 6.0..=rect.right() - 6.0, rect.center().y..=rect.center().y + 1.0),
        0.0,
        c.line,
    );
    for i in 0..list.len().saturating_sub(1) {
        let Some(s) = segment(d, list, i, w, h) else { continue };
        let stroke = Stroke::new(1.25, c.curve);
        let (a, b) = (at(s.xa, s.y_of(0.0)), at(s.xb, s.y_of(1.0)));
        match s.pts {
            None => {
                p.add(Shape::line(vec![a, at(s.xb, s.y_of(0.0)), b], stroke));
            }
            Some([p1, p2]) => {
                let pts = [a, at(p1[0], p1[1]), at(p2[0], p2[1]), b];
                p.add(egui::epaint::CubicBezierShape::from_points_stroke(pts, false, Color32::TRANSPARENT, stroke));
            }
        }
        if let Some([h1, h2]) = s.handles {
            let color = if picked(list[i].t) { c.accent } else { c.text };
            let (h1, h2) = (at(h1[0], h1[1]), at(h2[0], h2[1]));
            p.line_segment([a, h1], Stroke::new(1.0, color));
            p.line_segment([b, h2], Stroke::new(1.0, color));
            p.circle_filled(h1, 2.5, color);
            p.circle_filled(h2, 2.5, color);
        }
    }
    for k in list {
        let color = if picked(k.t) { c.accent } else { c.text };
        super::icons::keyframe(p, at(lane_x(d, w, k.t as f64), h / 2.0), k.ease, color);
    }
    if let Some(t) = playhead {
        let x = (rect.left() + lane_x(d, w, t as f64) as f32).round() + 0.5;
        p.rect_filled(Rect::from_x_y_ranges(x - 0.5..=x + 0.5, rect.y_range()), 0.0, c.playhead);
    }
}

/// Draws Time Remapping's lane: the speed between the keys (log scale, 10% at the bottom, 1000% at the top), each
/// ramp shaded, each key as a diamond (a split key as two).
pub fn paint_remap(p: &egui::Painter, rect: Rect, r: &cut_model::remap::Remap, d: Ticks, c: &Colors) {
    let (w, h) = (f64::from(rect.width()), f64::from(rect.height()));
    let x_of = |t: Ticks| rect.left() + lane_x(d, w, t as f64) as f32;
    let y_of = |sp: f64| {
        let pct = sp.abs() * 100.0;
        let k = if pct > 0.0 { ((pct.log10() - 1.0) / 2.0).clamp(0.0, 1.0) } else { 0.0 };
        rect.top() + (h - PAD - k * (h - 2.0 * PAD)) as f32
    };
    p.rect_filled(
        Rect::from_x_y_ranges(rect.left() + 6.0..=rect.right() - 6.0, rect.center().y..=rect.center().y + 1.0),
        0.0,
        c.line,
    );
    let shade = Color32::from_rgba_unmultiplied(128, 128, 128, 64);
    for k in r.keys.iter().filter(|k| k.ramp > 0 && k.t < d) {
        p.rect_filled(Rect::from_x_y_ranges(x_of(k.t)..=x_of(d.min(k.t + k.ramp)), rect.y_range()), 0.0, shade);
    }
    let mut pts: Vec<Pos2> = Vec::new();
    let mut px = 6.0;
    while px <= w - 6.0 {
        let t = lane_t(d, w, px).clamp(0.0, (d - 1).max(0) as f64);
        pts.push(pos2(rect.left() + px as f32, y_of(cut_model::remap::speed_at(r, t))));
        px += 2.0;
    }
    p.add(Shape::line(pts, Stroke::new(1.25, c.curve)));
    for k in r.keys.iter().filter(|k| k.t < d) {
        let ends: &[Ticks] = if k.ramp > 0 { &[k.t, k.t + k.ramp] } else { &[k.t] };
        for t in ends {
            super::icons::keyframe(p, pos2(x_of(d.min(*t)), rect.center().y), Ease::Linear, c.text);
        }
    }
}
