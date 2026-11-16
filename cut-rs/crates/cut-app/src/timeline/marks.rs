//! What the lanes draw over a clip and between clips (port of `drawClip`'s line, fades, markers, handles and group
//! outline, `drawRemap`, and `drawBase`'s transitions, gap and locked tracks): only for what is on screen, from the
//! same geometry the hit test uses ([`super::bands`]).

use std::collections::HashMap;

use cut_model::keyframes::{self as K, Value};
use cut_model::{Clip, Id, Project, Sequence, TrackKind};
use cut_time::Ticks;
use eframe::egui::{Color32, CornerRadius, FontId, Painter, Pos2, Rect, Shape, Stroke, StrokeKind, Vec2, pos2};

use super::bands::{self, Line};
use super::layout::{Row, View};
use crate::edit::{Band, Gap};
use crate::i18n::tr;
use crate::theme::Palette;

/// What every clip drawing needs.
pub struct Ctx<'a> {
    pub painter: &'a Painter,
    pub lanes: Rect,
    pub view: &'a View,
    pub project: &'a Project,
    pub seq: &'a Sequence,
    pub bands: &'a HashMap<Id, Band>,
    pub frame: Ticks,
    pub hover: Option<Id>,
    pub pal: &'a Palette,
    pub marks: &'a super::direct::badges::Marks,
}

impl Ctx<'_> {
    fn x(&self, t: Ticks) -> f32 {
        self.lanes.left() + self.view.x_of(t) as f32
    }
    fn y(&self, ly: f32) -> f32 {
        self.lanes.top() + ly
    }
}

/// The text after a clip's name (`label +=`): its speed, Time Remapping, Reversed.
pub fn name_suffix(c: &Clip) -> String {
    let mut out = String::new();
    if c.speed != 1.0 {
        out.push_str(&format!(" [{}%]", (c.speed * 1000.0).round() / 10.0));
    }
    if c.remap.is_some() {
        out.push_str(&format!(" {}", tr("(Time Remapping)")));
    }
    if c.reverse {
        out.push_str(&format!(" {}", tr("(Reversed)")));
    }
    out
}

/// The width the fx badge takes before the name (`fxW`).
pub fn badge_w(c: &Clip, kind: TrackKind, w: f32) -> f32 {
    if (!c.effects.is_empty() || kind == TrackKind::Video) && w > 40.0 { 18.0 } else { 0.0 }
}

/// A clip's extras: the fx badge, the keyframe or Speed line, audio fades, clip markers, the handle marks and a group's
/// dashed outline. `r` is the clip's rectangle on screen.
pub fn clip(cx: &Ctx, c: &Clip, row: &Row, r: Rect, selected: bool) {
    let p = cx.painter;
    let kind = cx.seq.kind_of(c.track).unwrap_or(TrackKind::Video);
    let offline = cx.marks.offline_clip(c);
    let (cy, ch) = bands::clip_box(row, cx.view);
    let (cy, x1, x2) = (cx.y(cy), cx.x(c.start), cx.x(c.end()));
    let alpha = if c.enabled { 1.0 } else { 0.4 };
    let clipped = p.with_clip_rect(r.intersect(cx.lanes));
    let fx = badge_w(c, kind, x2 - x1);
    if fx > 0.0 {
        let col = if c.effects.is_empty() {
            Color32::from_rgba_unmultiplied(242, 242, 242, 140)
        } else {
            Color32::from_rgb(0xf2, 0xc5, 0x5c)
        };
        clipped.text(
            pos2(x1 + 3.0, cy + 1.0),
            eframe::egui::Align2::LEFT_TOP,
            "fx",
            FontId::proportional(11.0),
            col.gamma_multiply(alpha),
        );
    }
    if bands::shows_band(row.h) && !offline {
        match bands::line_of(cx.project, c, kind, cx.bands) {
            Line::Remap => remap(cx, &clipped, c, (x1, x2), cy, ch),
            Line::Prop(prop) => prop_line(cx, &clipped, c, kind, prop, (x1, x2), cy, ch),
        }
    }
    if kind == TrackKind::Audio && row.h >= 30.0 {
        let shade = Color32::from_black_alpha(77);
        let (top, bottom) = (cy + 15.0, cy + ch);
        let (fi, fo) = (cx.view.px(c.fade_in) as f32, cx.view.px(c.fade_out) as f32);
        if c.fade_in > 0 {
            clipped.add(Shape::convex_polygon(
                vec![pos2(x1, bottom), pos2(x1, top), pos2(x1 + fi, top)],
                shade,
                Stroke::NONE,
            ));
        }
        if c.fade_out > 0 {
            clipped.add(Shape::convex_polygon(
                vec![pos2(x2, bottom), pos2(x2 - fo, top), pos2(x2, top)],
                shade,
                Stroke::NONE,
            ));
        }
        if selected || cx.hover == Some(c.id) {
            for x in [x1 + fi, x2 - fo] {
                clipped.rect_filled(Rect::from_min_size(pos2(x - 3.0, top), Vec2::splat(6.0)), 0.0, Color32::WHITE);
            }
        }
    }
    for mk in c.markers.iter().flatten() {
        let mx = cx.x(c.start + mk.t);
        let col = crate::edit::markers::color(&mk.color);
        clipped.add(Shape::convex_polygon(
            vec![pos2(mx - 4.0, cy), pos2(mx + 4.0, cy), pos2(mx, cy + 6.0)],
            col,
            Stroke::NONE,
        ));
    }
    if !offline && x2 - x1 > 12.0 {
        let (head, tail) = bands::room_of(cx.project, c, cx.frame);
        let mark = Color32::from_white_alpha(140);
        if head <= 0.0 {
            p.add(Shape::convex_polygon(
                vec![pos2(x1, cy), pos2(x1 + 6.0, cy), pos2(x1, cy + 6.0)],
                mark,
                Stroke::NONE,
            ));
        }
        if tail <= 0.0 {
            p.add(Shape::convex_polygon(
                vec![pos2(x2, cy), pos2(x2, cy + 6.0), pos2(x2 - 6.0, cy)],
                mark,
                Stroke::NONE,
            ));
        }
    }
    if c.group.is_some() && !selected {
        dashed_rect(p, r.shrink(0.5), Stroke::new(1.0, Color32::from_white_alpha(153)));
    }
}

fn dashed_rect(p: &Painter, r: Rect, s: Stroke) {
    let pts = [r.left_top(), r.right_top(), r.right_bottom(), r.left_bottom(), r.left_top()];
    p.extend(Shape::dashed_line(&pts, s, 4.0, 3.0));
}

/// The volume (audio) or opacity (video) line with its keyframes, an audio clip's Auto Ducking dips added.
#[allow(clippy::too_many_arguments)]
fn prop_line(cx: &Ctx, p: &Painter, c: &Clip, kind: TrackKind, prop: &str, (x1, x2): (f32, f32), cy: f32, ch: f32) {
    let list = c.keyframes.get(prop).filter(|l| !l.is_empty());
    let duck = if kind == TrackKind::Audio { c.keyframes.get("duck").filter(|l| !l.is_empty()) } else { None };
    let base = if kind == TrackKind::Audio {
        Color32::from_rgb(0xf2, 0xd3, 0x6b)
    } else {
        Color32::from_rgb(0xe8, 0xe8, 0xe8)
    };
    let col = base.gamma_multiply(if c.enabled { 0.85 } else { 0.35 });
    let num = |v: Option<Value>| match v {
        Some(Value::Num(x)) => x,
        _ => 0.0,
    };
    let (xa, xb) = (x1.max(cx.lanes.left()), x2.min(cx.lanes.right()));
    if list.is_some() || duck.is_some() {
        let mut pts = Vec::new();
        let mut x = xa;
        while x <= xb {
            let tau = cx.view.t_of(f64::from(x - cx.lanes.left())) - c.start as f64;
            let v = list.map_or_else(|| bands::value_at(c, prop, tau), |l| num(K::value_at(l, tau)))
                + duck.map_or(0.0, |d| num(K::value_at(d, tau)));
            pts.push(pos2(x, bands::band_y(prop, v, cy, ch)));
            x += 3.0;
        }
        p.add(Shape::line(pts, Stroke::new(1.0, col)));
        for k in list.into_iter().flatten() {
            let Value::Num(v) = k.v else { continue };
            let (kx, ky) = (cx.x(c.start + k.t), bands::band_y(prop, v, cy, ch));
            p.add(Shape::convex_polygon(
                vec![pos2(kx, ky - 4.0), pos2(kx + 4.0, ky), pos2(kx, ky + 4.0), pos2(kx - 4.0, ky)],
                col,
                Stroke::NONE,
            ));
        }
    } else {
        let v = match c.props.get(prop) {
            Some(Value::Num(v)) => v,
            _ => bands::range(prop).1,
        };
        let y = bands::band_y(prop, v, cy, ch).round() + 0.5;
        p.hline(xa..=xb, y, Stroke::new(1.0, col));
    }
}

/// Time Remapping > Speed: the speed along the clip, transitions shaded, reverse red and holds blue, each key as two
/// halves and a tab.
fn remap(cx: &Ctx, p: &Painter, c: &Clip, (x1, x2): (f32, f32), cy: f32, ch: f32) {
    let r = c.remap_of();
    let d = c.duration();
    let (top, bottom) = (cy + 16.0, cy + ch - 4.0);
    let fade = if c.enabled { 0.9 } else { 0.35 };
    for k in r.keys.iter().filter(|k| k.t < d && k.ramp > 0) {
        let ka = cx.x(c.start + k.t);
        let kb = cx.x(c.start + d.min(k.t + k.ramp));
        p.rect_filled(
            Rect::from_x_y_ranges(ka..=kb, top..=bottom),
            0.0,
            Color32::from_white_alpha(41).gamma_multiply(fade),
        );
    }
    let (xa, xb) = (x1.max(cx.lanes.left()), x2.min(cx.lanes.right()));
    let mut pts: Vec<(Pos2, Color32)> = Vec::new();
    let mut x = xa;
    while x <= xb + 1.0 {
        let px = x.min(xb);
        let sp = bands::speed_at(&r, d, cx.view.t_of(f64::from(px - cx.lanes.left())) - c.start as f64);
        let col = if sp < 0.0 {
            Color32::from_rgb(0xff, 0x8a, 0x80)
        } else if sp == 0.0 {
            Color32::from_rgb(0x80, 0xd8, 0xff)
        } else {
            Color32::from_rgb(0xe8, 0xe8, 0xe8)
        };
        pts.push((pos2(px, bands::remap_y(sp.abs() * 100.0, cy, ch)), col));
        x += 2.0;
    }
    p.add(Shape::line(
        pts.iter().map(|q| q.0).collect(),
        Stroke::new(3.5, Color32::from_black_alpha(166).gamma_multiply(fade)),
    ));
    for w in pts.windows(2) {
        p.line_segment([w[0].0, w[1].0], Stroke::new(1.5, w[1].1.gamma_multiply(fade)));
    }
    for g in bands::remap_keys(cx.view, c, cy, ch) {
        let l = cx.lanes.left();
        let (ka, kb, mid) = (g.ka + l, g.kb + l, g.mid + l);
        for (x, y) in [(ka - 3.0, g.ya - 6.0), (kb, g.yb - 6.0)] {
            let rr = Rect::from_min_size(pos2(x, y), Vec2::new(3.0, 12.0));
            p.rect_filled(rr, 0.0, Color32::from_gray(242));
            p.rect_stroke(rr.expand(0.5), 0.0, Stroke::new(1.0, Color32::from_black_alpha(178)), StrokeKind::Outside);
        }
        p.add(Shape::convex_polygon(
            vec![pos2(mid - 4.0, top - 2.0), pos2(mid + 4.0, top - 2.0), pos2(mid, top + 4.0)],
            Color32::from_gray(242),
            Stroke::new(1.0, Color32::from_black_alpha(178)),
        ));
    }
}

/// The transitions over the bottom of the clips of the rows on screen, the selected one outlined; striped where the
/// clips' media runs out of the frames it needs.
pub fn transitions(cx: &Ctx, rows: &[Row], selected: Option<Id>) {
    let p = cx.painter;
    let (a, b) = (cx.view.t_of(-10.0), cx.view.t_of(f64::from(cx.lanes.width()) + 10.0));
    let light = cx.pal.light();
    for t in &cx.seq.transitions {
        let Some(row) = rows.iter().find(|r| r.id == Some(t.track)) else { continue };
        let (ta, tb) = bands::span(t);
        if (tb as f64) < a || (ta as f64) > b {
            continue;
        }
        let y = cx.y(row.y - cx.view.scroll_y);
        let (x1, x2) = (cx.x(ta), cx.x(tb));
        let hh = (row.h - 4.0).min(22.0);
        let ty = y + row.h - hh - 3.0;
        let rect = Rect::from_min_size(pos2(x1, ty), Vec2::new((x2 - x1).max(2.0), hh));
        let fill = if light {
            Color32::from_rgba_unmultiplied(255, 255, 255, 217)
        } else {
            Color32::from_rgba_unmultiplied(40, 40, 46, 230)
        };
        p.rect_filled(rect, 0.0, fill);
        let on = selected == Some(t.id);
        let stroke = if on { Stroke::new(2.0, cx.pal.selected) } else { Stroke::new(1.0, cx.pal.gray[12]) };
        p.rect_stroke(rect.shrink(0.5), 0.0, stroke, StrokeKind::Inside);
        p.line_segment([pos2(x1, ty + hh), pos2(x2, ty)], stroke);
        if bands::short(cx.project, cx.seq, t, cx.frame) {
            let stripes = p.with_clip_rect(rect.intersect(cx.lanes));
            let red = Stroke::new(1.0, Color32::from_rgba_unmultiplied(224, 85, 85, 191));
            let mut x = x1 - hh;
            while x < x2 {
                stripes.line_segment([pos2(x, ty + hh), pos2(x + hh, ty)], red);
                x += 5.0;
            }
        }
        if x2 - x1 > 40.0 {
            let name = cut_model::effects::get(&t.kind).map_or_else(|| t.kind.clone(), |d| tr(d.name).into_owned());
            super::fit_text(
                p,
                pos2(x1 + 4.0, ty + 4.0),
                &name,
                x2 - x1 - 8.0,
                FontId::proportional(11.0),
                cx.pal.gray[12],
            );
        }
    }
}

/// The picked gap, a pale band over the empty part of its track.
pub fn gap(cx: &Ctx, rows: &[Row], g: &Gap) {
    let Some(row) = rows.iter().find(|r| r.id == Some(g.track)) else { return };
    let y = cx.y(row.y - cx.view.scroll_y);
    let r = Rect::from_x_y_ranges(cx.x(g.a)..=cx.x(g.b), y + 1.0..=y + row.h - 1.0);
    cx.painter.rect_filled(
        r.intersect(cx.lanes),
        CornerRadius::ZERO,
        Color32::from_rgba_unmultiplied(242, 197, 92, 64),
    );
}

/// A locked track's hatching (`drawBase`).
pub fn locked(cx: &Ctx, rr: Rect) {
    let p = cx.painter.with_clip_rect(rr.intersect(cx.lanes));
    let s = Stroke::new(1.0, cx.pal.gray[8].gamma_multiply(0.18));
    let h = rr.height();
    let mut x = rr.left() - (cx.view.scroll_x % 12.0) as f32;
    while x < rr.right() + h {
        p.line_segment([pos2(x, rr.bottom()), pos2(x + h, rr.top())], s);
        x += 12.0;
    }
}
