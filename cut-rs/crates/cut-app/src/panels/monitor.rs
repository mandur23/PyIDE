//! The Source and Program monitors (`ui-monitors.js`): the picture, the timecode and the length, the time bar, and
//! Premiere's row of buttons. The picture is not this layer's: [`picture`] shows whatever texture the engine hands
//! it, or the empty screen while it has none.

use cut_time::{Ticks, snap, timecode};
use eframe::egui::{
    self, Align, Align2, Button, Color32, FontId, Layout, Rect, RichText, Sense, Stroke, TextureId, Vec2,
};

use crate::i18n::tr;
use crate::icons;
use crate::shell::Shell;
use crate::state::Panel;

/// A picture to show: the engine's texture and its size in pixels.
#[derive(Debug, Clone, Copy)]
pub struct Picture {
    pub texture: TextureId,
    pub size: Vec2,
}

/// The size in pixels a picture of `frame`'s shape takes fitted into `rect` (letterboxed), at the window's pixel scale.
pub fn fitted_pixels(ui: &egui::Ui, rect: Rect, frame: Vec2) -> (u32, u32) {
    if frame.x <= 0.0 || frame.y <= 0.0 {
        return (1, 1);
    }
    let ppp = ui.ctx().pixels_per_point();
    let k = (rect.width() / frame.x).min(rect.height() / frame.y) * ppp;
    (((frame.x * k).floor() as u32).max(1), ((frame.y * k).floor() as u32).max(1))
}

/// Draws `picture` fitted into `rect` on the monitor's background (letterboxed), or the background alone when there is
/// nothing to show yet. `frame` is the sequence's frame size for the empty screen's shape. A picture made at the size
/// [`fitted_pixels`] gives is drawn one texel to a screen pixel, on the pixel grid.
pub fn picture(ui: &mut egui::Ui, rect: Rect, bg: Color32, picture: Option<Picture>, frame: Vec2) -> Rect {
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, 0.0, bg);
    let size = picture.map_or(frame, |p| p.size);
    if size.x <= 0.0 || size.y <= 0.0 {
        return Rect::NOTHING;
    }
    let ppp = ui.ctx().pixels_per_point();
    let natural = size / ppp;
    let fitted = if picture.is_some() && natural.x <= rect.width() + 0.5 && natural.y <= rect.height() + 0.5 {
        let min = ((rect.center() - natural / 2.0) * ppp).round() / ppp;
        Rect::from_min_size(min, natural)
    } else {
        let k = (rect.width() / size.x).min(rect.height() / size.y);
        Rect::from_center_size(rect.center(), size * k)
    };
    match picture {
        Some(p) => {
            painter.image(
                p.texture,
                fitted,
                Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                Color32::WHITE,
            );
        }
        None => {
            painter.rect_filled(fitted, 0.0, Color32::BLACK);
        }
    }
    fitted
}

/// The Program monitor: the active sequence at the playhead.
pub fn program(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    // what the panel shows of the sequence (no copy of its clips each frame)
    let Some((name, seq_id, (w, h), fps, duration)) =
        s.app.sequence().map(|q| (q.name.clone(), q.id, (q.w, q.h), q.fps, q.duration()))
    else {
        return;
    };
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.label(RichText::new(&name).color(pal.gray[9]));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_space(8.0);
            let full = Button::new(RichText::new(icons::FULLSCREEN).size(13.0)).frame(false);
            if ui.add(full).on_hover_text(tr("Full Screen")).clicked() {
                let ctx = ui.ctx().clone();
                s.run_action("fullscreen", &ctx);
            }
            zoom_select(ui, &mut s.features.view.zoom);
        });
    });
    let controls = 76.0;
    let avail = ui.available_rect_before_wrap();
    let screen = Rect::from_min_max(
        avail.min + Vec2::new(6.0, 0.0),
        egui::pos2(avail.right() - 6.0, (avail.bottom() - controls).max(avail.top() + 20.0)),
    );
    let r = ui.allocate_rect(screen, Sense::click());
    if r.clicked() {
        s.focus(Panel::Program);
    }
    let frame = Vec2::new(w as f32, h as f32);
    let view = zoomed(ui, screen, frame, s.features.view.zoom);
    let px = fitted_pixels(ui, view, frame);
    let revision = s.app.history.revision();
    let captions = crate::captions::shown(s);
    if let Some(times) = s.timeline.trim_view {
        trim_view(s, ui, screen, seq_id, times);
    } else {
        let shown = s
            .monitors
            .as_mut()
            .and_then(|m| m.program(s.app.history.project(), revision, seq_id, s.app.t, px, captions));
        let outer = ui.clip_rect();
        ui.painter_at(screen).rect_filled(screen, 0.0, pal.monitor_bg);
        ui.set_clip_rect(outer.intersect(screen));
        let at = picture(ui, view, pal.monitor_bg, shown, frame);
        ui.set_clip_rect(outer);
        if crate::prefs::flag(&s.doc.settings, "program.safe") {
            safe_margins(ui, at);
        }
        if !crate::text_ui::owns_monitor(s) {
            crate::fx::overlay::program(s, ui, at);
        }
        crate::text_ui::editor::program(s, ui, at);
        if let Some(m) = &mut s.monitors {
            m.program.rect = at;
        }
    }
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        let id = ui.scope_id().with("cut-program-tc");
        let look = (egui::FontId::monospace(14.0), pal.accent);
        if let Some(t) = super::timecode::inline(ui, id, (s.app.t, fps), look, &tr("Playhead position")) {
            s.app.set_time(t.max(0));
        }
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_space(8.0);
            ui.label(RichText::new(timecode(duration, fps)).monospace().color(pal.gray[9]));
            crate::prefs::proxy_switch(s, ui);
            if s.play.dropped > 0 {
                let n = s.play.dropped.to_string();
                ui.label(RichText::new(crate::i18n::trf("{n} dropped frames", &[("n", &n)])).color(pal.gray[8]));
            }
        });
    });
    if let Some(t) = time_bar(ui, &pal, s.app.t, duration.max(1), s.app.in_out.in_, s.app.in_out.out) {
        s.focus(Panel::Program);
        s.app.set_time(snap(t, fps, true));
    }
    super::bar::bar(s, ui, super::bar::Monitor::Program, 0.0, |_, _| {});
}

/// The Program monitor's zoom (`ZOOMS`): Fit, or a percentage of the picture's own pixels.
pub const ZOOMS: [Option<f32>; 8] =
    [None, Some(0.25), Some(0.5), Some(0.75), Some(1.0), Some(1.5), Some(2.0), Some(4.0)];

fn zoom_label(z: Option<f32>) -> String {
    z.map_or_else(|| tr("Fit").into_owned(), |z| format!("{}%", (z * 100.0).round()))
}

/// A monitor's zoom menu (`ZOOMS`): Fit, or a percentage of the picture's own pixels.
pub fn zoom_select(ui: &mut egui::Ui, zoom: &mut Option<f32>) {
    let now = *zoom;
    ui.menu_button(RichText::new(zoom_label(now)).size(12.0), |ui| {
        for z in ZOOMS {
            if ui.selectable_label(now == z, zoom_label(z)).clicked() {
                *zoom = z;
                ui.close();
            }
        }
    })
    .response
    .on_hover_text(tr("Zoom"));
}

/// The rectangle a picture of `frame` takes at `zoom` (screen pixels per picture pixel) in `screen`: its middle in
/// the middle, cut at the screen; `None` fits it.
pub fn zoomed(ui: &egui::Ui, screen: Rect, frame: Vec2, zoom: Option<f32>) -> Rect {
    match zoom {
        Some(z) => Rect::from_center_size(screen.center(), frame * z / ui.ctx().pixels_per_point()),
        None => screen,
    }
}

/// The safe margins over a monitor's picture (`.cut-safe`): action safe 3.5 % in from each edge, a solid line;
/// title safe 5 % in, dashed.
pub fn safe_margins(ui: &egui::Ui, at: Rect) {
    let p = ui.painter_at(at);
    let line = Stroke::new(1.0, Color32::from_white_alpha(140));
    let inset = |k: f32| Rect::from_min_max(at.min + at.size() * k, at.max - at.size() * k);
    p.rect_stroke(inset(0.035), 0.0, line, egui::StrokeKind::Inside);
    let t = inset(0.05);
    let corners = [t.left_top(), t.right_top(), t.right_bottom(), t.left_bottom(), t.left_top()];
    for w in corners.windows(2) {
        p.extend(egui::Shape::dashed_line(&[w[0], w[1]], line, 4.0, 3.0));
    }
}

/// The trim view in place of the Program monitor's picture (`.cut-trim-view`): the two frames side by side, 6 points
/// apart and in from the edges, each fitted on black.
fn trim_view(s: &mut Shell, ui: &mut egui::Ui, screen: Rect, seq_id: cut_model::Id, times: [Option<Ticks>; 2]) {
    let revision = s.app.history.revision();
    let ctx = ui.ctx().clone();
    let project = s.app.history.project();
    let Some(seq) = project.sequence(seq_id) else { return };
    let frame = Vec2::new(seq.w as f32, seq.h as f32);
    let shown = s.monitors.as_mut().map_or([None, None], |m| m.trim(&ctx, project, revision, seq, times));
    ui.painter_at(screen).rect_filled(screen, 0.0, s.palette.monitor_bg);
    let inner = screen.shrink(6.0);
    let w = (inner.width() - 6.0) / 2.0;
    for (i, pic) in shown.into_iter().enumerate() {
        let left = inner.left() + i as f32 * (w + 6.0);
        let cell = Rect::from_min_size(egui::pos2(left, inner.top()), Vec2::new(w, inner.height()));
        let k = (cell.width() / frame.x).min(cell.height() / frame.y);
        let fitted = Rect::from_center_size(cell.center(), frame * k);
        let p = ui.painter_at(cell);
        p.rect_filled(fitted, 0.0, Color32::BLACK);
        if let Some(pic) = pic {
            let uv = Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0));
            p.image(pic.texture, fitted, uv, Color32::WHITE);
        }
        if let Some(t) = s.monitors.as_mut().and_then(|m| m.trim_screens.as_mut()) {
            t[i].rect = fitted;
        }
    }
}

/// The time bar under a monitor: the In/Out range, the playhead; a click or a drag moves the playhead. -> the time
/// clicked.
pub fn time_bar(
    ui: &mut egui::Ui,
    pal: &crate::theme::Palette,
    t: Ticks,
    duration: Ticks,
    i: Option<Ticks>,
    o: Option<Ticks>,
) -> Option<Ticks> {
    let w = ui.available_width() - 16.0;
    let (rect, r) = ui.allocate_exact_size(Vec2::new(w.max(10.0), 16.0), Sense::click_and_drag());
    let rect = rect.translate(Vec2::new(8.0, 0.0));
    let p = ui.painter_at(rect.expand(6.0));
    p.rect_filled(rect.shrink2(Vec2::new(0.0, 3.0)), 3.0, pal.gray[3]);
    let x_of = |v: Ticks| rect.left() + rect.width() * (v as f32 / duration as f32).clamp(0.0, 1.0);
    if i.is_some() || o.is_some() {
        let a = i.map_or(rect.left(), x_of);
        let b = o.map_or(rect.right(), x_of);
        p.rect_filled(
            Rect::from_x_y_ranges(a..=b, rect.top() + 3.0..=rect.bottom() - 3.0),
            3.0,
            pal.accent.gamma_multiply(0.5),
        );
    }
    let x = x_of(t);
    p.vline(x, rect.y_range(), Stroke::new(2.0, pal.playhead));
    p.text(egui::pos2(x, rect.top()), Align2::CENTER_BOTTOM, "", FontId::proportional(8.0), pal.playhead);
    if (r.clicked() || r.dragged())
        && let Some(pos) = r.interact_pointer_pos()
    {
        let f = ((pos.x - rect.left()) / rect.width()).clamp(0.0, 1.0);
        return Some((f64::from(f) * duration as f64) as Ticks);
    }
    None
}
