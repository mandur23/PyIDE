//! The Source monitor (port of `ui-monitors.js`'s `mountSource`): the media file or sequence opened there, at its own
//! time, with its own transport, In and Out, a time bar, its bar of buttons (the Program monitor's table, with Insert
//! and Overwrite), its zoom, and handles that drag the clip (or only its video or its sound) onto the timeline. A file the Project panel selects opens here; an audio file shows its
//! waveform. Its clock and sound are [`crate::edit::source::SourceMonitor`]'s.

use cut_model::MediaKind;
use cut_time::{Ticks, snap, timecode};
use eframe::egui::{self, Align, Button, Color32, Layout, Rect, RichText, Sense, Vec2};

use super::monitor::{fitted_pixels, picture, time_bar};
use crate::edit::source::{self, SourceClip, SourceItem};
use crate::i18n::tr;
use crate::icons;
use crate::shell::Shell;
use crate::state::Panel;

/// The handle that drags the clip, its video or its sound alone.
fn handle(s: &mut Shell, ui: &mut egui::Ui, glyph: &str, title: &str, video: bool, audio: bool) {
    let r =
        ui.add(Button::new(RichText::new(glyph).size(13.0)).frame(false).sense(Sense::drag())).on_hover_text(tr(title));
    drag_from(s, ui, &r, video, audio);
}

fn drag_from(s: &mut Shell, ui: &egui::Ui, r: &egui::Response, video: bool, audio: bool) {
    if r.drag_started()
        && let Some(src) = s.app.edit.source.clip
        && let Some(d) = source::drag_of(s.app.project(), &src, video, audio)
    {
        egui::DragAndDrop::set_payload(ui.ctx(), d);
    }
    if r.dragged() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Grabbing);
    }
}

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    // its own sound device is opened once there is something to hear (opening one takes a few hundred ms)
    if s.monitors.is_some() && s.app.edit.source.clip.is_some() {
        s.app.edit.source.with_sound();
    }
    // a new choice in the Project panel opens in the source monitor
    let chosen = s.project.selected().iter().find_map(|id| s.app.project().media(*id)).map(|m| m.id);
    if chosen.is_some() && chosen != s.app.edit.source.picked {
        s.app.edit.source.picked = chosen;
        if let Some(id) = chosen {
            s.app.edit.source.open(SourceClip::media(id));
        }
    }
    let clip = s.app.edit.source.clip.filter(|c| source::timing(s.app.history.project(), c.item).is_some());
    if clip.is_none() && s.app.edit.source.clip.is_some() {
        s.app.edit.source.close();
    }
    let p = s.app.history.project();
    let name = clip.map(|c| match c.item {
        SourceItem::Media(id) => p.media(id).map_or_else(String::new, |m| m.name.clone()),
        SourceItem::Sequence(id) => p.sequence(id).map_or_else(String::new, |q| q.name.clone()),
    });
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.label(RichText::new(name.clone().unwrap_or_else(|| tr("Source").into_owned())).color(pal.gray[9]));
        let recent: Vec<(cut_model::Id, String)> = s
            .app
            .edit
            .source
            .recent
            .iter()
            .filter_map(|id| s.app.project().media(*id).map(|m| (m.id, m.name.clone())))
            .collect();
        ui.add_enabled_ui(!recent.is_empty(), |ui| {
            ui.menu_button("\u{E70D}", |ui| {
                for (id, n) in recent {
                    let on = clip.is_some_and(|c| c.item == SourceItem::Media(id));
                    if ui.selectable_label(on, n).clicked() {
                        s.app.edit.source.open(SourceClip::media(id));
                        ui.close();
                    }
                }
            })
            .response
            .on_hover_text(tr("Recent Clips"));
        });
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_space(8.0);
            super::monitor::zoom_select(ui, &mut s.features.view.source_zoom);
        });
    });
    let controls = 76.0;
    let avail = ui.available_rect_before_wrap();
    let screen = Rect::from_min_max(
        avail.min + Vec2::new(6.0, 0.0),
        egui::pos2(avail.right() - 6.0, (avail.bottom() - controls).max(avail.top() + 20.0)),
    );
    let r = ui.allocate_rect(screen, Sense::click_and_drag());
    if r.clicked() || r.drag_started() {
        s.focus(Panel::Source);
    }
    drag_from(s, ui, &r, true, true);
    let p = s.app.history.project();
    let revision = s.app.history.revision();
    let (fps, end) = clip.and_then(|c| source::timing(p, c.item)).unwrap_or((cut_time::Fps { num: 30, den: 1 }, 0));
    let at = clip.map_or(0, |c| c.t);
    if r.hovered() && clip.is_some() {
        let wheel = ui.input(|i| i.smooth_scroll_delta.y);
        if wheel != 0.0 && !ui.input(|i| i.modifiers.ctrl) {
            let f = cut_time::frame_start(1, fps).max(1);
            s.app.edit.source.scrub(p, at - wheel.signum() as Ticks * f);
        }
    }
    let media = clip.and_then(|c| match c.item {
        SourceItem::Media(id) => p.media(id),
        SourceItem::Sequence(_) => None,
    });
    let size = match (clip.map(|c| c.item), media) {
        (Some(SourceItem::Sequence(id)), _) => {
            p.sequence(id).map_or(Vec2::new(16.0, 9.0), |q| Vec2::new(q.w as f32, q.h as f32))
        }
        (_, Some(m)) => m.video.as_ref().map_or(Vec2::new(16.0, 9.0), |v| Vec2::new(v.w as f32, v.h as f32)),
        _ => Vec2::ZERO,
    };
    let view = super::monitor::zoomed(ui, screen, size, s.features.view.source_zoom);
    let px = fitted_pixels(ui, view, size);
    let shown = match (clip, s.monitors.as_mut()) {
        (Some(c), Some(mon)) => match c.item {
            SourceItem::Media(id) if media.is_some_and(|m| m.kind != MediaKind::Audio) => {
                mon.source(p, revision, id, at, px)
            }
            SourceItem::Sequence(id) => mon.source_sequence(p, revision, id, at, px),
            SourceItem::Media(_) => None,
        },
        _ => None,
    };
    let audio_only = media.is_some_and(|m| m.kind == MediaKind::Audio);
    let outer = ui.clip_rect();
    ui.painter_at(screen).rect_filled(screen, 0.0, pal.monitor_bg);
    ui.set_clip_rect(outer.intersect(screen));
    let drawn = picture(ui, view, pal.monitor_bg, shown, if audio_only { Vec2::ZERO } else { size });
    ui.set_clip_rect(outer);
    if audio_only && let (Some(m), Some(th)) = (media, s.thumbs.as_mut()) {
        let m = m.clone();
        if let Some(peaks) = th.peaks(&m) {
            wave(
                ui,
                screen.shrink2(Vec2::new(0.0, screen.height() * 0.2)),
                &peaks.data,
                Color32::from_rgb(0x3f, 0xae, 0x8c),
            );
        }
    }
    if clip.is_none() {
        ui.painter().text(
            screen.center(),
            egui::Align2::CENTER_CENTER,
            tr("Double-click a clip in the project to open it here."),
            egui::FontId::proportional(12.5),
            pal.gray[8],
        );
    }
    if let Some(m) = &mut s.monitors {
        m.source.rect = drawn;
    }
    let (i, o) = clip.map_or((None, None), |c| (c.in_, c.out));
    let len = if i.is_some() || o.is_some() { o.unwrap_or(end) - i.unwrap_or(0) } else { end };
    ui.add_space(4.0);
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.label(RichText::new(timecode(at, fps)).monospace().color(pal.accent).size(14.0));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_space(8.0);
            let tip = if i.is_some() || o.is_some() { tr("In to Out duration") } else { tr("Duration") };
            ui.label(RichText::new(timecode(len.max(0), fps)).monospace().color(pal.gray[9])).on_hover_text(tip);
        });
    });
    if let Some(t) = time_bar(ui, &pal, at, end.max(1), i, o) {
        s.focus(Panel::Source);
        let p = s.app.history.project();
        s.app.edit.source.scrub(p, snap(t, fps, true));
    }
    let handles = 2.0 * 26.0 + 12.0;
    super::bar::bar(s, ui, super::bar::Monitor::Source, handles, |s, ui| {
        ui.add_space(6.0);
        handle(s, ui, icons::VIDEO, "Drag Video Only", true, false);
        handle(s, ui, icons::AUDIO, "Drag Audio Only", false, true);
    });
}

/// An audio file's waveform across the monitor (`drawWave`): `peaks` as min/max pairs.
fn wave(ui: &egui::Ui, r: Rect, peaks: &[f32], color: Color32) {
    let n = peaks.len() / 2;
    if n == 0 {
        return;
    }
    let p = ui.painter_at(r);
    let w = r.width().max(1.0) as usize;
    let mid = r.center().y;
    for x in 0..w {
        let i = (x * n / w) * 2;
        let (lo, hi) = (peaks.get(i).copied().unwrap_or(0.0), peaks.get(i + 1).copied().unwrap_or(0.0));
        let xf = r.left() + x as f32;
        let (a, b) = (mid - hi * r.height() / 2.0, mid - lo * r.height() / 2.0);
        p.vline(xf, a..=b.max(a + 1.0), egui::Stroke::new(1.0, color));
    }
}
