//! The time ruler: labelled marks at the smallest step that keeps labels 90 points apart, the In/Out range, the
//! sequence markers and the playhead's head.

use cut_model::Sequence;
use cut_time::{Fps, Ticks, frame_at, frame_start, timecode};
use eframe::egui::{Align2, Color32, FontId, Painter, Pos2, Rect, Shape, Stroke};

use super::layout::View;
use crate::state::App;
use crate::theme::{Palette, hex};

/// The closest two labelled marks may come, in points (`pxOf(ticks) >= 90`).
const MIN_LABEL_GAP: f64 = 90.0;

/// The step between labelled marks: whole frames, then seconds and minutes.
pub fn label_step(view: &View, fps: Fps) -> Ticks {
    let frame = frame_start(1, fps).max(1);
    let second = frame * fps.nominal().max(1);
    [1, 2, 5, 10]
        .map(|n| n * frame)
        .into_iter()
        .chain([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map(|n| n * second))
        .find(|s| view.px(*s) >= MIN_LABEL_GAP)
        .unwrap_or(3600 * second)
}

/// The marker colours (`MARKER_COLORS`).
pub fn marker_color(name: &str) -> Color32 {
    let hexv = match name {
        "green" => "#5fb236",
        "red" => "#e05555",
        "purple" => "#a26be0",
        "orange" => "#e8913b",
        "yellow" => "#e6c84a",
        "white" => "#e8e8e8",
        "blue" => "#4a8fe6",
        "cyan" => "#3fc1c9",
        other => other,
    };
    hex(hexv).unwrap_or(Color32::from_rgb(0x5f, 0xb2, 0x36))
}

pub fn draw(painter: &Painter, rect: Rect, view: &View, seq: &Sequence, app: &App, pal: &Palette) {
    let painter = painter.with_clip_rect(rect);
    painter.rect_filled(rect, 0.0, pal.gray[2]);
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, pal.gray[3]));
    let x_of = |t: Ticks| rect.left() + view.x_of(t) as f32;
    if app.in_out.in_.is_some() || app.in_out.out.is_some() {
        let a = app.in_out.in_.map_or(rect.left(), x_of);
        let b = app.in_out.out.map_or(rect.right(), x_of);
        painter.rect_filled(
            Rect::from_x_y_ranges(a..=b, rect.bottom() - 8.0..=rect.bottom()),
            0.0,
            Color32::from_rgba_unmultiplied(84, 138, 247, 90),
        );
    }
    let step = label_step(view, seq.fps);
    let minor = if step / 5 >= frame_start(1, seq.fps) { step / 5 } else { step };
    let start = view.t_of(0.0).max(0.0) as Ticks;
    let end = view.t_of(f64::from(rect.width())) as Ticks;
    let mut t = start / minor * minor;
    while t <= end {
        let x = x_of(t);
        let major = t % step == 0;
        let h = if major { 10.0 } else { 4.0 };
        painter.vline(x, rect.bottom() - h..=rect.bottom(), Stroke::new(1.0, pal.gray[7]));
        if major {
            painter.text(
                Pos2::new(x + 4.0, rect.top() + 4.0),
                Align2::LEFT_TOP,
                timecode(t, seq.fps),
                FontId::monospace(11.0),
                pal.gray[9],
            );
        }
        t += minor;
    }
    for m in &seq.markers {
        let x = x_of(m.t);
        if x < rect.left() - 20.0 || x > rect.right() + 20.0 {
            continue;
        }
        let c = marker_color(&m.color);
        if m.duration > 0 {
            painter.rect_filled(
                Rect::from_x_y_ranges(x..=x_of(m.t + m.duration), rect.top() + 14.0..=rect.top() + 20.0),
                0.0,
                c,
            );
        }
        painter.add(Shape::convex_polygon(
            vec![
                Pos2::new(x - 5.0, rect.top() + 12.0),
                Pos2::new(x + 5.0, rect.top() + 12.0),
                Pos2::new(x + 5.0, rect.top() + 20.0),
                Pos2::new(x, rect.top() + 25.0),
                Pos2::new(x - 5.0, rect.top() + 20.0),
            ],
            c,
            Stroke::NONE,
        ));
    }
    let x = x_of(frame_start(frame_at(app.t, seq.fps), seq.fps));
    painter.add(Shape::convex_polygon(
        vec![
            Pos2::new(x - 6.0, rect.bottom() - 12.0),
            Pos2::new(x + 6.0, rect.bottom() - 12.0),
            Pos2::new(x + 6.0, rect.bottom() - 6.0),
            Pos2::new(x, rect.bottom()),
            Pos2::new(x - 6.0, rect.bottom() - 6.0),
        ],
        pal.playhead,
        Stroke::NONE,
    ));
    painter.vline(x, rect.bottom() - 6.0..=rect.bottom(), Stroke::new(1.0, pal.playhead));
}
