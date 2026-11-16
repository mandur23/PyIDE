//! The Curves section: the RGB curves, master and one per channel, edited on a square. A press adds a point and
//! drags it, a press on a point drags it, Ctrl+click removes one, a double click straightens the channel (the point
//! its first click added is taken back). A press and its drag are one undo step.

use cut_engine::lumetri::{self, CURVE_PARAMS, MAX_POINTS, MIN_GAP};
use cut_model::Id;
use cut_model::keyframes::Value;
use eframe::egui::{self, Color32, Pos2, Rect, RichText, Sense, Shape, Stroke, Vec2};
use serde_json::{Map, Value as Json};

use super::{LUMETRI, clip_of, effect_id, set};
use crate::fx::edit::{self, Gesture};
use crate::i18n::tr;
use crate::shell::Shell;
use crate::theme::Palette;

/// Points between the square's edge and its 0..1 area.
const PAD: f32 = 8.0;
/// The channels' names and the colours their lines are drawn in, in [`CURVE_PARAMS`]' order.
const CHANNELS: [(&str, Color32); 4] = [
    ("Master", Color32::from_rgb(0xe6, 0xe6, 0xe6)),
    ("Red", Color32::from_rgb(0xff, 0x5a, 0x5a)),
    ("Green", Color32::from_rgb(0x4f, 0xd1, 0x6a)),
    ("Blue", Color32::from_rgb(0x5a, 0x96, 0xff)),
];
/// A press this close to a point (points) takes it.
const HIT: f32 = 10.0;

/// The curve editor's state between frames.
#[derive(Debug)]
pub struct Curves {
    /// The channel edited, an index of [`CURVE_PARAMS`].
    pub channel: usize,
    /// Where the square was drawn last.
    pub square: Rect,
    /// The point being dragged.
    drag: Option<usize>,
    /// The point the last press added: when (the input's time) and whether it moved since.
    added: Option<(f64, bool)>,
    /// When and where the last click on the square ended (a second one soon after at the same place is a double click).
    last_click: Option<(f64, Pos2)>,
    gesture: Gesture,
}

impl Default for Curves {
    fn default() -> Self {
        Self {
            channel: 0,
            square: Rect::NOTHING,
            drag: None,
            added: None,
            last_click: None,
            gesture: Gesture::default(),
        }
    }
}

/// A curve parameter's flat list (anything unusable reads as the straight line).
fn flat(p: &Map<String, Json>, k: &str) -> Vec<f64> {
    p.get(k)
        .and_then(Json::as_array)
        .map_or_else(Vec::new, |a| a.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect())
}

/// The square's mapping between curve space (0..1, y up) and the screen.
struct Space {
    rect: Rect,
}

impl Space {
    fn size(&self) -> Vec2 {
        self.rect.size() - Vec2::splat(2.0 * PAD)
    }

    fn to_px(&self, p: [f64; 2]) -> Pos2 {
        let s = self.size();
        Pos2::new(self.rect.left() + PAD + p[0] as f32 * s.x, self.rect.top() + PAD + (1.0 - p[1] as f32) * s.y)
    }

    fn to_curve(&self, q: Pos2) -> [f64; 2] {
        let s = self.size();
        [f64::from((q.x - self.rect.left() - PAD) / s.x), f64::from(1.0 - (q.y - self.rect.top() - PAD) / s.y)]
    }
}

/// The section's body.
pub fn section(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, p: &Map<String, Json>, clip: Id) {
    ui.label(RichText::new(tr("RGB Curves")).color(pal.gray[9]));
    let channel = s.features.fx.color.curves.channel;
    ui.horizontal(|ui| {
        for (i, (name, color)) in CHANNELS.iter().enumerate() {
            let (rect, r) = ui.allocate_exact_size(Vec2::splat(18.0), Sense::click());
            let painter = ui.painter();
            painter.circle_filled(rect.center(), 7.0, *color);
            let ring = if i == channel { Stroke::new(2.0, pal.gray[12]) } else { Stroke::new(2.0, pal.gray[5]) };
            painter.circle_stroke(rect.center(), 8.0, ring);
            if !lumetri::is_identity_curve(&flat(p, CURVE_PARAMS[i])) {
                painter.circle_filled(rect.right_top() + Vec2::new(1.0, -1.0), 3.0, pal.accent);
            }
            if r.on_hover_text(tr(name)).clicked() {
                s.features.fx.color.curves.channel = i;
            }
        }
    });
    let side = (ui.available_width() - 20.0).clamp(60.0, 280.0);
    let (rect, r) = ui.allocate_exact_size(Vec2::splat(side), Sense::click_and_drag());
    let space = Space { rect };
    s.features.fx.color.curves.square = rect;
    interact(s, ui, &r, &space, p, clip);
    let keyed = effect_id(&s.app, clip, LUMETRI).is_some_and(|e| {
        clip_of(&s.app, clip)
            .is_some_and(|c| CURVE_PARAMS.iter().any(|k| edit::keyframed(c, &format!("effects.{e}.{k}"))))
    });
    let st = &s.features.fx.color.curves;
    draw(ui, &space, p, st.channel, st.drag, if keyed { pal.accent } else { pal.gray[5] });
    ui.label(
        RichText::new(tr(
            "Click to add a point and drag it; Ctrl+click removes a point; double-click straightens the curve.",
        ))
        .color(pal.gray[8])
        .small(),
    );
}

fn write(s: &mut Shell, clip: Id, channel: usize, pts: &[[f64; 2]]) {
    set(&mut s.app, clip, LUMETRI, &[(CURVE_PARAMS[channel], Value::List(lumetri::flatten(pts)))], "Curves");
}

fn interact(s: &mut Shell, ui: &egui::Ui, r: &egui::Response, space: &Space, p: &Map<String, Json>, clip: Id) {
    let (pressed, down, pos, delta, ctrl, now) = ui.input(|i| {
        (
            i.pointer.primary_pressed(),
            i.pointer.primary_down(),
            i.pointer.interact_pos(),
            i.pointer.delta(),
            i.modifiers.command || i.modifiers.ctrl,
            i.time,
        )
    });
    let channel = s.features.fx.color.curves.channel;
    let mut pts = lumetri::points(&flat(p, CURVE_PARAMS[channel]));
    if pressed && let Some(at) = pos.filter(|q| space.rect.contains(*q)) {
        let mut hit = None;
        let mut best = HIT;
        for (i, q) in pts.iter().enumerate() {
            let d = space.to_px(*q).distance(at);
            if d <= best {
                best = d;
                hit = Some(i);
            }
        }
        if ctrl {
            s.features.fx.color.curves.added = None;
            if let Some(h) = hit.filter(|_| pts.len() > 2) {
                pts.remove(h);
                write(s, clip, channel, &pts);
            }
        } else {
            s.features.fx.color.curves.gesture.begin(&mut s.app, "Curves");
            if hit.is_none() {
                let [u, v] = space.to_curve(at);
                let x = u.clamp(0.0, 1.0);
                if pts.len() < MAX_POINTS && !pts.iter().any(|q| (q[0] - x).abs() < MIN_GAP) {
                    pts.push([x, v.clamp(0.0, 1.0)]);
                    pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
                    hit = pts.iter().position(|q| q[0] == x);
                    write(s, clip, channel, &pts);
                    s.features.fx.color.curves.added = Some((now, false));
                }
            }
            match hit {
                Some(h) => s.features.fx.color.curves.drag = Some(h),
                None => s.features.fx.color.curves.gesture.end(&mut s.app),
            }
        }
    } else if let (Some(i), true, Some(at)) = (s.features.fx.color.curves.drag, down, pos)
        && delta != Vec2::ZERO
        && i < pts.len()
    {
        let [u, v] = space.to_curve(at);
        let lo = if i > 0 { pts[i - 1][0] + MIN_GAP } else { 0.0 };
        let hi = if i + 1 < pts.len() { pts[i + 1][0] - MIN_GAP } else { 1.0 };
        pts[i] = [u.min(hi).max(lo), v.clamp(0.0, 1.0)];
        if let Some(a) = &mut s.features.fx.color.curves.added {
            a.1 = true;
        }
        write(s, clip, channel, &pts);
    }
    let st = &mut s.features.fx.color.curves;
    if st.drag.is_some() && !down {
        st.drag = None;
        st.gesture.end(&mut s.app);
    }
    let double = r.clicked() && {
        let (delay, at) = (ui.ctx().options(|o| o.input_options.max_double_click_delay), pos.unwrap_or_default());
        let twice = st.last_click.is_some_and(|(t, p)| now - t <= delay && p.distance(at) < 6.0);
        st.last_click = if twice { None } else { Some((now, at)) };
        twice
    };
    if double {
        if st.added.is_some_and(|(at, moved)| !moved && now - at < 0.8) {
            s.app.undo();
        }
        s.features.fx.color.curves.added = None;
        write(s, clip, channel, &[[0.0, 0.0], [1.0, 1.0]]);
    }
}

/// The curve through `pts` as a line of 129 points.
fn line(space: &Space, pts: &[[f64; 2]]) -> Vec<Pos2> {
    let m = lumetri::slopes(pts);
    (0..=128)
        .map(|i| {
            let x = f64::from(i) / 128.0;
            space.to_px([x, lumetri::eval_curve(pts, x, &m)])
        })
        .collect()
}

fn draw(ui: &egui::Ui, space: &Space, p: &Map<String, Json>, channel: usize, drag: Option<usize>, border: Color32) {
    let rect = space.rect;
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, 3.0, Color32::from_rgb(0x14, 0x15, 0x18));
    let grid = Stroke::new(1.0, Color32::from_white_alpha(26));
    let inner = rect.shrink(PAD);
    for k in 0..=4 {
        let f = k as f32 / 4.0;
        painter.vline(inner.left() + f * inner.width(), inner.y_range(), grid);
        painter.hline(inner.x_range(), inner.top() + f * inner.height(), grid);
    }
    painter.line_segment([inner.left_bottom(), inner.right_top()], Stroke::new(1.0, Color32::from_white_alpha(46)));
    for (i, (_, color)) in CHANNELS.iter().enumerate() {
        let f = flat(p, CURVE_PARAMS[i]);
        if i != channel && !lumetri::is_identity_curve(&f) {
            let c = Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), 0x66);
            painter.add(Shape::line(line(space, &lumetri::points(&f)), Stroke::new(1.0, c)));
        }
    }
    let pts = lumetri::points(&flat(p, CURVE_PARAMS[channel]));
    let color = CHANNELS[channel].1;
    painter.add(Shape::line(line(space, &pts), Stroke::new(1.6, color)));
    for (i, q) in pts.iter().enumerate() {
        let fill = if drag == Some(i) { Color32::WHITE } else { color };
        painter.rect_filled(Rect::from_center_size(space.to_px(*q), Vec2::splat(7.0)), 0.0, fill);
    }
    painter.rect_stroke(rect, 3.0, Stroke::new(1.0, border), egui::StrokeKind::Inside);
}
