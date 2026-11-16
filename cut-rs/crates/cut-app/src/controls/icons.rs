//! The small icon buttons of Effect Controls, drawn as the JavaScript's 16 x 16 SVG glyphs are (`GLYPHS`): the
//! stopwatch, previous/next keyframe, the keyframe diamond (filled when one is at the playhead), reset, remove, up,
//! down, the fx switch, the twisty and the three mask buttons. Each carries its tooltip as its accessible name.

use eframe::egui::{self, Color32, Pos2, Rect, Response, Sense, Shape, Stroke, Vec2, pos2, vec2};

/// Which glyph a button draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Watch,
    Prev,
    Next,
    Key,
    KeyOn,
    Reset,
    Remove,
    Up,
    Down,
    Fx,
    /// The twisty: open (pointing down) or folded (pointing right).
    Twisty(bool),
    Ellipse,
    Polygon,
    Pen,
}

/// A 20 x 20 button with `icon` and the tooltip `tip`; `on` draws it pressed (`aria-pressed`) in `on_color`.
pub fn button(ui: &mut egui::Ui, icon: Icon, tip: &str, on: bool, on_color: Color32) -> Response {
    let (rect, r) = ui.allocate_exact_size(Vec2::splat(20.0), Sense::click());
    r.widget_info(|| egui::WidgetInfo::labeled(egui::Role::Button, true, tip));
    let v = ui.visuals();
    if r.hovered() {
        ui.painter().rect_filled(rect, 3.0, v.widgets.hovered.bg_fill);
    }
    let color = if on {
        on_color
    } else if r.hovered() {
        v.strong_text_color()
    } else {
        v.weak_text_color()
    };
    draw(ui.painter(), rect, icon, color);
    r.on_hover_text(tip)
}

/// The glyph in `rect` (its 16-unit box centred there).
pub fn draw(p: &egui::Painter, rect: Rect, icon: Icon, color: Color32) {
    let o = rect.center() - vec2(8.0, 8.0);
    let at = |x: f32, y: f32| o + vec2(x, y);
    let line = Stroke::new(1.3, color);
    let poly = |pts: Vec<Pos2>, fill: bool| {
        if fill { Shape::convex_polygon(pts, color, Stroke::NONE) } else { Shape::closed_line(pts, line) }
    };
    match icon {
        Icon::Watch => {
            p.circle_stroke(at(8.0, 9.0), 5.2, line);
            p.line_segment([at(8.0, 6.0), at(8.0, 9.2)], line);
            p.line_segment([at(8.0, 9.2), at(10.0, 10.5)], line);
            p.line_segment([at(6.5, 2.0), at(9.5, 2.0)], line);
            p.line_segment([at(8.0, 2.0), at(8.0, 3.8)], line);
        }
        Icon::Prev => {
            p.add(poly(vec![at(10.5, 3.5), at(10.5, 12.5), at(4.5, 8.0)], true));
        }
        Icon::Next => {
            p.add(poly(vec![at(5.5, 3.5), at(11.5, 8.0), at(5.5, 12.5)], true));
        }
        Icon::Key | Icon::KeyOn => {
            let pts = vec![at(8.0, 3.2), at(12.8, 8.0), at(8.0, 12.8), at(3.2, 8.0)];
            p.add(poly(pts, icon == Icon::KeyOn));
        }
        Icon::Reset => {
            let c = at(8.0, 8.0);
            let arc: Vec<Pos2> = (0..=24)
                .map(|i| {
                    let a = std::f32::consts::PI + (i as f32 / 24.0) * 1.6 * std::f32::consts::PI;
                    c + vec2(a.cos(), a.sin()) * 4.5
                })
                .collect();
            p.add(Shape::line(arc, line));
            p.add(Shape::line(vec![at(3.5, 2.5), at(3.5, 5.5), at(6.5, 5.5)], line));
        }
        Icon::Remove => {
            p.line_segment([at(4.5, 4.5), at(11.5, 11.5)], line);
            p.line_segment([at(11.5, 4.5), at(4.5, 11.5)], line);
        }
        Icon::Up | Icon::Down => {
            let (tip, a, b) = if icon == Icon::Up { (3.5, 7.0, 12.5) } else { (12.5, 9.0, 3.5) };
            p.line_segment([at(8.0, tip), at(8.0, b)], line);
            p.add(Shape::line(vec![at(4.5, a), at(8.0, tip), at(11.5, a)], line));
        }
        Icon::Fx => {
            p.rect_stroke(
                Rect::from_min_max(at(2.0, 3.0), at(14.0, 13.0)),
                2.0,
                Stroke::new(1.0, color),
                egui::StrokeKind::Inside,
            );
            p.text(at(8.0, 8.0), egui::Align2::CENTER_CENTER, "fx", egui::FontId::proportional(9.0), color);
        }
        Icon::Twisty(open) => {
            let pts = if open {
                vec![at(4.0, 5.5), at(8.0, 9.5), at(12.0, 5.5)]
            } else {
                vec![at(5.5, 4.0), at(9.5, 8.0), at(5.5, 12.0)]
            };
            p.add(Shape::line(pts, Stroke::new(1.4, color)));
        }
        Icon::Ellipse => {
            p.add(Shape::ellipse_stroke(at(8.0, 8.0), vec2(5.5, 4.5), line));
        }
        Icon::Polygon => {
            p.rect_stroke(Rect::from_min_max(at(3.0, 3.5), at(13.0, 12.5)), 0.0, line, egui::StrokeKind::Middle);
        }
        Icon::Pen => {
            let pts = vec![at(3.0, 13.0), at(4.2, 9.4), at(10.5, 3.1), at(12.9, 5.5), at(6.6, 11.8)];
            p.add(Shape::closed_line(pts, Stroke::new(1.2, color)));
            p.line_segment([at(9.2, 4.4), at(11.6, 6.8)], Stroke::new(1.2, color));
        }
    }
}

/// A keyframe's glyph in a lane at `c` (`drawLanes`): linear a diamond, eased and bezier a circle, hold a square.
pub fn keyframe(p: &egui::Painter, c: Pos2, ease: cut_model::keyframes::Ease, color: Color32) {
    use cut_model::keyframes::Ease;
    let sz = 5.0;
    match ease {
        Ease::Hold => {
            p.rect_filled(Rect::from_center_size(c, Vec2::splat(2.0 * sz - 2.0)), 0.0, color);
        }
        Ease::Linear => {
            let pts = vec![pos2(c.x, c.y - sz), pos2(c.x + sz, c.y), pos2(c.x, c.y + sz), pos2(c.x - sz, c.y)];
            p.add(Shape::convex_polygon(pts, color, Stroke::NONE));
        }
        _ => {
            p.circle_filled(c, sz - 0.5, color);
        }
    }
}
