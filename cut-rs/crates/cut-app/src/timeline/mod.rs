//! The timeline panel (port of `ui-timeline.js`): the sequence tab with the snap and linked-selection toggles and the
//! zoom buttons, the playhead timecode, the ruler with In/Out and markers, the track headers (lock, sync lock, output,
//! mute, solo, height), the clips and the playhead. Only what is on screen is drawn: each track's clips are found by
//! binary search in [`layout::Layout`], rebuilt only when the project changes. Edits are commands built by
//! [`gesture`]; a trim is applied live inside a history group and committed on release, as the JavaScript does.

pub mod bands;
pub mod direct;
pub mod editing;
pub mod gesture;
pub mod head_volume;
pub mod layout;
mod marks;
mod media;
mod ruler;
pub mod tools;

use std::time::Instant;

use cut_model::{Id, Sequence, Source, TrackKind};
use cut_time::{Fps, TICKS, Ticks, frame_start, snap, timecode};
use eframe::egui::{
    self, Align2, Color32, CornerRadius, CursorIcon, FontId, Pos2, Rect, Sense, Stroke, StrokeKind, Vec2,
    text::LayoutJob,
};
use serde_json::json;

use crate::cmd;
use crate::i18n::tr;
use crate::state::{App, MediaDrag, Panel, Tool};
use crate::theme::Palette;
use crate::thumbs::Thumbs;
use gesture::{Mods, MoveDrag, Press, Selecting, TrimDrag};
use layout::{HEADER_W, Hit, Layout, Part, RULER_H, RowKind, View};

/// The bar above the ruler (sequence tab, toggles, zoom).
const BAR_H: f32 = 30.0;
/// The horizontal scroll bar under the lanes.
const SCROLLBAR_H: f32 = 10.0;

#[derive(Debug)]
enum Drag {
    None,
    Scrub,
    Hand {
        x0: f32,
        y0: f32,
        sx: f64,
        sy: f32,
    },
    Move {
        d: MoveDrag,
        pending: Option<(Id, Mods)>,
    },
    Trim {
        d: TrimDrag,
        open: bool,
    },
    Height {
        track: Id,
        y0: f32,
        h0: f64,
        open: bool,
    },
    Marquee {
        from: Pos2,
        add: bool,
    },
    ScrollBar {
        x0: f32,
        sx: f64,
    },
    /// A tool or handle editing live ([`tools::Live`]).
    Tool {
        d: tools::Live,
        open: bool,
        source_end: bool,
    },
    Marker(tools::MarkerDrag),
}

/// The timeline panel's own state.
pub struct Timeline {
    pub view: View,
    layout: Layout,
    /// The sequence as of `built`: shared, so a frame does not copy 10,000 clips.
    seq: Option<std::rc::Rc<Sequence>>,
    built: Option<(u64, Id)>,
    drag: Drag,
    /// The lanes' width at the last frame (zoom keys need it).
    view_w: f64,
    fitted: Option<Id>,
    /// Time spent in the last [`Timeline::show`] (ms), for the status bar and the benchmark.
    pub frame_ms: f32,
    /// The text of the tip near the pointer while dragging.
    tip: Option<String>,
    edit: editing::Local,
    /// The caption selected on the caption rows and its drag.
    pub captions: crate::captions::track::CaptionEdit,
    /// Editing clips in place: the Type tool, renaming, dropped files, the marks ([`direct`]).
    pub direct: direct::Direct,
    /// Ranges an automation previews over the lanes (`setOverlay`).
    pub overlay: Option<crate::auto::silence::Overlay>,
    /// The sequence times the Program monitor's trim view shows while an edit point is trimmed, slipped or slid
    /// (`program.trimTimes`: left, right; a side before the first frame is `None`).
    pub trim_view: Option<[Option<Ticks>; 2]>,
    volume_drag: Option<head_volume::VolumeDrag>,
    /// The tool buttons in the timeline's own bar (`cut.timelineTools`, Window > Timeline Tool Bar).
    pub tool_bar: bool,
    /// The clips an AI's edit just changed and when their flash ends (`highlight`, `flash`).
    pub flashing: Option<(std::collections::HashSet<Id>, std::time::Instant)>,
}

impl Default for Timeline {
    fn default() -> Self {
        Timeline {
            view: View::default(),
            layout: Layout::default(),
            seq: None,
            built: None,
            drag: Drag::None,
            view_w: 800.0,
            fitted: None,
            frame_ms: 0.0,
            tip: None,
            edit: editing::Local::default(),
            captions: crate::captions::track::CaptionEdit::default(),
            direct: direct::Direct::default(),
            overlay: None,
            trim_view: None,
            volume_drag: None,
            tool_bar: false,
            flashing: None,
        }
    }
}

fn mods(m: egui::Modifiers) -> Mods {
    Mods { ctrl: m.ctrl || m.command, alt: m.alt, shift: m.shift }
}

/// Clips narrower than this (points) are drawn as their colour alone.
const TINY_W: f32 = 4.0;

/// Draws `text` at `pos` cut to `max_w` with an ellipsis (`fitText`).
pub fn fit_text(painter: &egui::Painter, pos: Pos2, text: &str, max_w: f32, font: FontId, color: Color32) {
    if max_w <= 6.0 {
        return;
    }
    let mut job = LayoutJob::single_section(text.to_owned(), egui::TextFormat::simple(font, color));
    job.wrap.max_width = max_w;
    job.wrap.max_rows = 1;
    job.wrap.break_anywhere = true;
    job.wrap.overflow_character = Some('…');
    let galley = painter.layout_job(job);
    painter.galley(pos, galley, color);
}

fn fps_value(fps: Fps) -> f64 {
    fps.value()
}

fn frame_of(seq: &Sequence) -> Ticks {
    frame_start(1, seq.fps).max(1)
}

impl Timeline {
    /// The clips an AI's edit changed flash for 1.4 s (`timeline.flash`).
    pub fn flash(&mut self, ids: &[Id]) {
        self.flashing = (!ids.is_empty()).then(|| {
            (ids.iter().copied().collect(), std::time::Instant::now() + std::time::Duration::from_millis(1400))
        });
    }

    /// Rebuilds the clip index when the project or the sequence changed.
    fn refresh(&mut self, app: &App) {
        let Some(seq) = app.sequence() else {
            self.layout = Layout::default();
            self.seq = None;
            self.built = None;
            return;
        };
        let key = (app.history.revision(), seq.id);
        if self.built != Some(key) {
            self.layout = Layout::of(seq);
            self.seq = app.shared_sequence();
            self.built = Some(key);
        }
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    fn pps_range(&self, app: &App) -> (f64, f64) {
        let fps = app.sequence().map_or(30.0, |s| fps_value(s.fps));
        (layout::min_pps(self.view_w, self.layout.end), layout::max_pps(self.view_w, self.layout.end, fps))
    }

    /// Zooms by `k` around the playhead when it is in view, else the middle (`zoomBy`, `anchorForZoom`).
    pub fn zoom_by(&mut self, app: &App, k: f64) {
        let x = self.view.x_of(app.t);
        let (t, x) = if (0.0..=self.view_w).contains(&x) {
            (app.t, x)
        } else {
            (self.view.t_of(self.view_w / 2.0) as Ticks, self.view_w / 2.0)
        };
        self.zoom_at(app, self.view.pps * k, t, x);
    }

    fn zoom_at(&mut self, app: &App, pps: f64, t: Ticks, x: f64) {
        let (lo, hi) = self.pps_range(app);
        self.view.zoom_to(pps.clamp(lo, hi), t, x);
    }

    /// Zoom to Sequence (`zoomFit`).
    pub fn zoom_fit(&mut self, app: &App) {
        let d = self.layout.end.max(10 * TICKS) as f64 / TICKS as f64;
        let (lo, hi) = self.pps_range(app);
        self.view.pps = (self.view_w * 0.96 / d).clamp(lo, hi);
        self.view.scroll_x = 0.0;
    }

    /// The edit points of the sequence, for the Up/Down keys.
    pub fn edit_points(&mut self, app: &App) -> Vec<Ticks> {
        self.refresh(app);
        layout::edit_points(&self.layout, None)
    }

    /// Shows the panel. `playing` follows the playhead while playback runs.
    pub fn show(
        &mut self,
        ui: &mut egui::Ui,
        app: &mut App,
        pal: &Palette,
        playing: bool,
        thumbs: Option<&mut Thumbs>,
    ) {
        let started = Instant::now();
        self.refresh(app);
        let full = ui.available_rect_before_wrap();
        let resp = ui.allocate_rect(full, Sense::click_and_drag());
        if resp.clicked() || resp.drag_started() {
            app.focus = Some(Panel::Timeline);
        }
        let painter = ui.painter_at(full);
        painter.rect_filled(full, 0.0, pal.gray[1]);
        let Some(seq) = self.seq.clone() else {
            painter.text(
                full.center(),
                Align2::CENTER_CENTER,
                tr("No sequence is open. Create one in the Project panel."),
                FontId::proportional(13.0),
                pal.gray[8],
            );
            return;
        };
        if self.fitted != Some(seq.id) {
            self.fitted = Some(seq.id);
            self.view_w = f64::from((full.width() - HEADER_W).max(100.0));
            if self.layout.end > 0 {
                self.zoom_fit(app);
            }
        }

        let bar = Rect::from_min_size(full.min, Vec2::new(full.width(), BAR_H));
        let corner = Rect::from_min_size(Pos2::new(full.left(), bar.bottom()), Vec2::new(HEADER_W, RULER_H));
        let ruler =
            Rect::from_min_max(Pos2::new(corner.right(), bar.bottom()), Pos2::new(full.right(), corner.bottom()));
        let heads =
            Rect::from_min_max(Pos2::new(full.left(), ruler.bottom()), Pos2::new(corner.right(), full.bottom()));
        let lanes = Rect::from_min_max(
            Pos2::new(heads.right(), ruler.bottom()),
            Pos2::new(full.right(), full.bottom() - SCROLLBAR_H),
        );
        let hbar = Rect::from_min_max(Pos2::new(lanes.left(), lanes.bottom()), Pos2::new(full.right(), full.bottom()));
        self.view_w = f64::from(lanes.width());
        self.clamp_scroll(lanes);
        if playing {
            let x = self.view.x_of(app.t);
            if x > self.view_w - 20.0 || x < 0.0 {
                self.view.scroll_x = (self.view.scroll_x + x - 20.0).max(0.0);
            }
        }

        self.bar(ui, bar, app, pal);
        // Timecode of the playhead, typed into to move it.
        painter.rect_filled(corner, 0.0, pal.gray[2]);
        let tc = Rect::from_min_max(corner.min + Vec2::new(8.0, 6.0), corner.max - Vec2::new(8.0, 6.0));
        let look = (FontId::monospace(14.0), pal.accent);
        let id = ui.scope_id().with("cut-timeline-tc");
        if let Some(t) = crate::panels::timecode::field(ui, tc, id, (app.t, seq.fps), look, &tr("Playhead Position")) {
            app.set_time(t.max(0));
        }
        ruler::draw(&painter, ruler, &self.view, &seq, app, pal);
        self.heads(ui, heads, app, pal, &seq);
        self.lanes(ui, lanes, app, pal, &seq, thumbs);
        self.direct_ui(ui, lanes, app, &seq);
        self.scrollbar(ui, hbar, pal);
        self.edit_input(ui, &resp, [ruler, lanes], app, &seq);
        self.input(ui, resp.id, [full, ruler, lanes], app, &seq);
        self.drop_media(ui, lanes, app, &seq);
        self.drop_source(ui, lanes, app, &seq);
        crate::fx::effects::drop_on_timeline(self, ui, lanes, app, &seq);
        self.frame_ms = started.elapsed().as_secs_f32() * 1000.0;
    }

    fn clamp_scroll(&mut self, lanes: Rect) {
        let content_w = self.content_w();
        self.view.scroll_x = self.view.scroll_x.clamp(0.0, (content_w - self.view_w).max(0.0));
        let max_y = (self.layout.content_h - lanes.height()).max(0.0);
        self.view.scroll_y = self.view.scroll_y.clamp(0.0, max_y);
    }

    /// The scrollable width (`contentW`): the sequence and half a view more.
    fn content_w(&self) -> f64 {
        let view_t = self.view_w / self.view.pps * TICKS as f64;
        let d = (self.layout.end as f64 + view_t * 0.5).max(view_t);
        (d / TICKS as f64 * self.view.pps).min(30e6)
    }

    fn bar(&mut self, ui: &mut egui::Ui, rect: Rect, app: &mut App, pal: &Palette) {
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 0.0, pal.gray[2]);
        painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, pal.gray[3]));
        let mut child = ui.new_child(
            egui::UiBuilder::new()
                .max_rect(rect.shrink2(Vec2::new(8.0, 3.0)))
                .layout(egui::Layout::left_to_right(egui::Align::Center)),
        );
        Self::tabs(&mut child, app, pal);
        if self.tool_bar {
            child.add_space(10.0);
            for t in crate::panels::tools::GROUPS.iter().flat_map(|g| g.iter().copied()) {
                let glyph = egui::RichText::new(crate::panels::tools::glyph(t)).size(13.0);
                let b = child.add(egui::Button::new(glyph).selected(app.tool == t)).on_hover_text(tr(t.title()));
                if b.clicked() {
                    app.tool = t;
                }
            }
        }
        child.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button(crate::icons::FIT).on_hover_text(tr("Zoom to Sequence")).clicked() {
                self.zoom_fit(app);
            }
            if ui.button(crate::icons::ZOOM_IN).on_hover_text(tr("Zoom In")).clicked() {
                self.zoom_by(app, 1.6);
            }
            let (lo, hi) = self.pps_range(app);
            let mut r = ((self.view.pps / lo).ln() / (hi / lo).ln() * 1000.0).clamp(0.0, 1000.0);
            let slider = ui.add(egui::Slider::new(&mut r, 0.0..=1000.0).show_value(false)).on_hover_text(tr("Zoom"));
            if slider.changed() {
                let pps = lo * (r / 1000.0 * (hi / lo).ln()).exp();
                self.zoom_by(app, pps / self.view.pps);
            }
            if ui.button(crate::icons::ZOOM_OUT).on_hover_text(tr("Zoom Out")).clicked() {
                self.zoom_by(app, 1.0 / 1.6);
            }
            ui.add_space(8.0);
            let linked = ui
                .add(egui::Button::new(crate::icons::LINK).selected(app.linked_selection))
                .on_hover_text(tr("Linked Selection"));
            if linked.clicked() {
                app.linked_selection = !app.linked_selection;
            }
            let snap = ui
                .add(egui::Button::new(egui::RichText::new("U").strong()).selected(app.snapping))
                .on_hover_text(tr("Snap in Timeline"));
            if snap.clicked() {
                app.snapping = !app.snapping;
            }
        });
    }

    fn heads(&mut self, ui: &mut egui::Ui, rect: Rect, app: &mut App, pal: &Palette, seq: &Sequence) {
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 0.0, pal.gray[2]);
        painter.vline(rect.right() - 0.5, rect.y_range(), Stroke::new(1.0, pal.gray[3]));
        let rows = self.layout.rows.clone();
        for row in &rows {
            let top = rect.top() + row.y - self.view.scroll_y;
            let r = Rect::from_min_size(Pos2::new(rect.left(), top), Vec2::new(rect.width() - 1.0, row.h));
            if r.bottom() < rect.top() || r.top() > rect.bottom() {
                continue;
            }
            match row.kind {
                RowKind::Divider => {
                    painter.rect_filled(r, 0.0, pal.gray[3]);
                    continue;
                }
                RowKind::Caption => {
                    let Some(ct) = row.id.and_then(|id| seq.captions.iter().find(|c| c.id == id)) else { continue };
                    let name = [ct.name.as_str(), ct.lang.as_str()].into_iter().find(|n| !n.is_empty());
                    let at = painter.text(
                        Pos2::new(r.left() + 10.0, r.center().y),
                        Align2::LEFT_CENTER,
                        name.map_or_else(|| tr("Captions"), Into::into),
                        FontId::proportional(12.0),
                        pal.gray[11],
                    );
                    // Sync lock of the caption track (ripple edits move its captions), on unless turned off.
                    let b = Rect::from_center_size(Pos2::new(at.right() + 16.0, r.center().y), Vec2::splat(20.0));
                    let icon = egui::Button::new(egui::RichText::new(crate::icons::SYNC).size(11.0));
                    let sync = ui.put(b, icon.selected(ct.sync_lock)).on_hover_text(tr("Sync Lock"));
                    let on = ct.sync_lock;
                    sync.widget_info(|| egui::WidgetInfo::selected(egui::Role::Button, true, on, tr("Sync Lock")));
                    if sync.clicked() {
                        let patch = json!({ "syncLock": !on });
                        let id = (seq.id.as_str(), ct.id.as_str());
                        app.exec(&cut_model::commands::build::set_caption_track(id.0, id.1, patch));
                    }
                    continue;
                }
                _ => {}
            }
            let Some(track) = row.id.and_then(|id| seq.track(id)) else { continue };
            painter.hline(r.x_range(), r.bottom() - 0.5, Stroke::new(1.0, pal.gray[1]));
            let head = ui.interact(r, ui.scope_id().with(("head", track.id.as_str())), Sense::click());
            self.head_menu(&head, app, track.id, &track.name);
            let mut child = ui.new_child(
                egui::UiBuilder::new()
                    .max_rect(Rect::from_min_size(
                        r.min + Vec2::new(6.0, 4.0),
                        Vec2::new(r.width() - 10.0, 22.0_f32.min(r.height() - 4.0)),
                    ))
                    .layout(egui::Layout::left_to_right(egui::Align::Center)),
            );
            child.set_clip_rect(r.intersect(rect));
            child.spacing_mut().item_spacing.x = 4.0;
            let small = |s: &str| egui::RichText::new(s).size(11.0);
            let mut patch = None;
            Self::patch_button(&mut child, app, seq, track.id, row.index, track.kind);
            let lock = child
                .add(
                    egui::Button::new(small(if track.locked { crate::icons::LOCK } else { crate::icons::UNLOCK }))
                        .selected(track.locked)
                        .min_size(Vec2::splat(20.0)),
                )
                .on_hover_text(tr("Toggle Track Lock"));
            if lock.clicked() {
                patch = Some(json!({ "locked": !track.locked }));
            }
            Self::target_button(&mut child, app, seq, track.id, &track.name, pal);
            let sync = child
                .add(egui::Button::new(small(crate::icons::SYNC)).selected(track.sync_lock).min_size(Vec2::splat(20.0)))
                .on_hover_text(tr("Toggle Sync Lock"));
            if sync.clicked() {
                patch = Some(json!({ "syncLock": !track.sync_lock }));
            }
            if track.kind == TrackKind::Video {
                let on = track.visible != Some(false);
                let eye = child
                    .add(
                        egui::Button::new(small(if on { crate::icons::EYE } else { crate::icons::EYE_OFF }))
                            .selected(!on)
                            .min_size(Vec2::splat(20.0)),
                    )
                    .on_hover_text(tr("Toggle Track Output"));
                if eye.clicked() {
                    patch = Some(json!({ "visible": !on }));
                }
            } else {
                let mute = track.mute == Some(true);
                let solo = track.solo == Some(true);
                if child
                    .add(egui::Button::new(small("M")).selected(mute).min_size(Vec2::splat(20.0)))
                    .on_hover_text(tr("Mute Track"))
                    .clicked()
                {
                    patch = Some(json!({ "mute": !mute }));
                }
                if child
                    .add(egui::Button::new(small("S")).selected(solo).min_size(Vec2::splat(20.0)))
                    .on_hover_text(tr("Solo Track"))
                    .clicked()
                {
                    patch = Some(json!({ "solo": !solo }));
                }
            }
            if let Some(p) = patch {
                app.exec(&cmd::set_track(seq.id, track.id, p));
            }
            if track.kind == TrackKind::Audio {
                let h = head_volume::Head { seq, track, rect: r, clip: r.intersect(rect) };
                // the header's menu opens on the slider too; a double click there types a volume, not a name
                if let Some(v) = head_volume::show(ui, &mut self.volume_drag, app, pal, &h)
                    && !v.double_clicked()
                {
                    self.head_menu(&v, app, track.id, &track.name);
                }
            }
            // The bottom edge of a header changes the track's height (one undo step).
            let grip =
                Rect::from_min_max(Pos2::new(r.left(), r.bottom() - 4.0), Pos2::new(r.right(), r.bottom() + 1.0));
            let g = ui
                .interact(grip, ui.scope_id().with(("height", track.id.as_str())), Sense::drag())
                .on_hover_text(tr("Drag to change the track height"));
            if g.hovered() || g.dragged() {
                ui.ctx().set_cursor_icon(CursorIcon::ResizeVertical);
            }
            if g.drag_started()
                && let Some(p) = g.interact_pointer_pos()
            {
                self.drag = Drag::Height { track: track.id, y0: p.y, h0: track.height, open: false };
            }
        }
    }

    fn clip_color(&self, pal: &Palette, seq: &Sequence, clip: &cut_model::Clip) -> Color32 {
        let audio = seq.track(clip.track).is_some_and(|t| t.kind == TrackKind::Audio);
        let base = match &clip.source {
            Source::Nest { .. } => pal.clip_nest,
            Source::Generator { generator, .. } => match generator.name() {
                "text" => pal.clip_text,
                "graphic" => Color32::from_rgb(0xa2, 0x4f, 0x86),
                _ => pal.clip_solid,
            },
            Source::Media { .. } if self.direct.marks.offline_clip(clip) => Color32::from_rgb(0xa0, 0x30, 0x30),
            _ if audio => pal.clip_audio,
            _ => pal.clip_video,
        };
        if clip.enabled { base } else { base.gamma_multiply(0.45) }
    }

    fn lanes(
        &mut self,
        ui: &mut egui::Ui,
        rect: Rect,
        app: &App,
        pal: &Palette,
        seq: &Sequence,
        mut thumbs: Option<&mut Thumbs>,
    ) {
        let painter = ui.painter_at(rect);
        let v = self.view;
        let a = v.t_of(-10.0).floor() as Ticks;
        let b = v.t_of(f64::from(rect.width()) + 10.0).ceil() as Ticks;
        let x_of = |t: Ticks| rect.left() + v.x_of(t) as f32;
        // In/Out shading over the lanes
        if let (Some(i), Some(o)) = (app.in_out.in_, app.in_out.out) {
            let r = Rect::from_x_y_ranges(x_of(i)..=x_of(o), rect.y_range());
            painter.rect_filled(r, 0.0, Color32::from_rgba_unmultiplied(84, 138, 247, 30));
        }
        let font = FontId::proportional(11.5);
        let mx = marks::Ctx {
            painter: &painter,
            lanes: rect,
            view: &v,
            project: app.project(),
            seq,
            bands: &app.edit.band,
            frame: frame_of(seq),
            hover: self.edit.hover,
            pal,
            marks: &self.direct.marks,
        };
        for (ri, row) in self.layout.rows.iter().enumerate() {
            let top = rect.top() + row.y - v.scroll_y;
            let rr = Rect::from_min_size(Pos2::new(rect.left(), top), Vec2::new(rect.width(), row.h));
            if rr.bottom() < rect.top() || rr.top() > rect.bottom() {
                continue;
            }
            let bg = match row.kind {
                RowKind::Divider => pal.gray[3],
                _ if ri % 2 == 0 => pal.gray[1],
                _ => pal.gray[2].lerp_to_gamma(pal.gray[1], 0.5),
            };
            painter.rect_filled(rr, 0.0, bg);
            painter.hline(rr.x_range(), rr.bottom() - 0.5, Stroke::new(1.0, pal.gray[2]));
            if row.kind == RowKind::Caption {
                if let Some(ct) = row.id.and_then(|id| seq.captions.iter().find(|c| c.id == id)) {
                    crate::captions::track::draw(&painter, rr, ct, (a, b), &x_of, &self.captions, pal, &font);
                }
                continue;
            }
            let Some(track) = row.id else { continue };
            if seq.track(track).is_some_and(|t| t.locked) {
                marks::locked(&mx, rr);
            }
            for s in self.layout.visible(track, a, b) {
                let Some(clip) = seq.clip(s.id) else { continue };
                let x0 = x_of(s.start);
                let x1 = x_of(s.end).max(x0 + 1.0);
                let r = Rect::from_x_y_ranges(x0..=x1, rr.top() + 1.0..=rr.bottom() - 2.0);
                let fill = self.clip_color(pal, seq, clip);
                painter.rect_filled(r, CornerRadius::same(2), fill);
                // a clip a few points wide has no room for its picture, name or marks (at the whole-sequence zoom of
                // a long sequence nearly every clip is one): its colour and selection alone
                if r.width() < TINY_W {
                    if app.selection.contains(&clip.id) {
                        painter.rect_stroke(
                            r,
                            CornerRadius::same(2),
                            Stroke::new(2.0, pal.selected),
                            StrokeKind::Inside,
                        );
                    }
                    continue;
                }
                if let (Some(th), Some(m)) = (thumbs.as_deref_mut(), clip.media_id().and_then(|id| app.media(id))) {
                    let audio = row.kind == RowKind::Audio;
                    // the waveform's colour against the clip's (the JavaScript's light theme has light clips)
                    let light = egui::Rgba::from(fill).intensity() > 0.5;
                    media::draw(&painter, th, &v, rect, r, clip, m, audio, light);
                }
                painter.hline(r.x_range(), r.top() + 0.5, Stroke::new(1.0, Color32::from_white_alpha(40)));
                let selected = app.selection.contains(&clip.id);
                if r.width() > 3.0 {
                    painter.vline(r.right() - 0.5, r.y_range(), Stroke::new(1.0, Color32::from_black_alpha(90)));
                }
                if selected {
                    painter.rect_stroke(r, CornerRadius::same(2), Stroke::new(2.0, pal.selected), StrokeKind::Inside);
                }
                if let Some((ids, until)) = &self.flashing
                    && ids.contains(&clip.id)
                    && *until > std::time::Instant::now()
                {
                    // a bright edge that fades over its last 450 ms
                    let left = until.saturating_duration_since(std::time::Instant::now()).as_secs_f32();
                    let k = (left / 0.45).min(1.0);
                    painter.rect_filled(r, CornerRadius::same(2), pal.accent.gamma_multiply(0.3 * k));
                    painter.rect_stroke(
                        r,
                        CornerRadius::same(2),
                        Stroke::new(2.0, pal.accent.gamma_multiply(k)),
                        StrokeKind::Inside,
                    );
                    painter.ctx().request_repaint();
                }
                marks::clip(&mx, clip, row, r, selected);
                let badge = direct::badges::clip(&painter, &self.direct.marks, clip, r);
                let label = clip.label.as_deref().filter(|l| !l.is_empty());
                let name = if clip.name.is_empty() { label.unwrap_or("") } else { clip.name.as_str() };
                let name = if self.direct.marks.offline_clip(clip) {
                    format!("{name} — {}", tr("Media Offline"))
                } else {
                    format!("{name}{}", marks::name_suffix(clip))
                };
                let kind = if row.kind == RowKind::Audio { TrackKind::Audio } else { TrackKind::Video };
                let tx = r.left().max(rect.left()) + 4.0;
                let tx = tx + if tx == r.left() + 4.0 { marks::badge_w(clip, kind, r.width()) } else { 0.0 };
                fit_text(
                    &painter,
                    Pos2::new(tx, r.top() + 2.0),
                    &name,
                    r.right() - tx - 3.0 - badge,
                    font.clone(),
                    pal.clip_text_color(),
                );
            }
        }
        marks::transitions(&mx, &self.layout.rows, app.edit.transition);
        if let Some(g) = &app.edit.gap {
            marks::gap(&mx, &self.layout.rows, g);
        }
        // the move ghosts, the snap guide and the playhead
        if let Drag::Move { d, .. } = &self.drag
            && d.moved
        {
            for id in &d.clips {
                let Some(c) = seq.clip(*id) else { continue };
                let Some(row) = self.layout.row_of(c.track) else { continue };
                let shift = if row.kind == RowKind::Video || row.kind == RowKind::Audio { d.rows } else { 0 };
                let target = self
                    .layout
                    .rows
                    .iter()
                    .find(|r| r.kind == row.kind && r.index as i64 == row.index as i64 + shift)
                    .unwrap_or(row);
                let top = rect.top() + target.y - v.scroll_y;
                let r = Rect::from_x_y_ranges(
                    x_of(c.start + d.delta)..=x_of(c.end() + d.delta),
                    top + 1.0..=top + target.h - 2.0,
                );
                painter.rect_stroke(r, CornerRadius::same(2), Stroke::new(1.5, pal.gray[12]), StrokeKind::Inside);
            }
        }
        let guide = match &self.drag {
            Drag::Move { d, .. } => d.guide,
            Drag::Trim { d, .. } => d.guide,
            _ => self.edit_guide(),
        };
        if let Some(g) = guide {
            painter.vline(x_of(g), rect.y_range(), Stroke::new(1.0, Color32::from_rgb(0x4f, 0xc3, 0xf7)));
        }
        if let Drag::Marquee { from, .. } = self.drag
            && let Some(p) = ui.ctx().pointer_latest_pos()
        {
            let r = Rect::from_two_pos(from, p);
            painter.rect_filled(r, 0.0, Color32::from_rgba_unmultiplied(84, 138, 247, 30));
            painter.rect_stroke(r, 0.0, Stroke::new(1.0, pal.blue8), StrokeKind::Inside);
        }
        if let Some(o) = &self.overlay {
            let xf = |t: f64| rect.left() + v.x_of(t as Ticks) as f32;
            crate::auto::silence::paint(&painter, rect, &self.layout.rows, v.scroll_y, xf, o, pal.playhead);
        }
        let px = x_of(frame_start(cut_time::frame_at(app.t, seq.fps), seq.fps));
        if rect.x_range().contains(px) {
            painter.vline(px, rect.y_range(), Stroke::new(1.5, pal.playhead));
        }
        if let Some(tip) = &self.tip
            && let Some(p) = ui.ctx().pointer_latest_pos()
        {
            let at = Pos2::new((p.x + 14.0).min(rect.right() - 160.0), (p.y - 26.0).max(rect.top()));
            let g = painter.layout_no_wrap(tip.clone(), FontId::proportional(12.0), pal.gray[12]);
            let bg = Rect::from_min_size(at, g.size() + Vec2::new(10.0, 6.0));
            painter.rect_filled(bg, CornerRadius::same(4), pal.gray[3]);
            painter.galley(at + Vec2::new(5.0, 3.0), g, pal.gray[12]);
        }
    }

    fn scrollbar(&mut self, ui: &mut egui::Ui, rect: Rect, pal: &Palette) {
        let painter = ui.painter_at(rect);
        painter.rect_filled(rect, 0.0, pal.gray[1]);
        let content = self.content_w().max(1.0);
        let frac = (self.view_w / content).min(1.0) as f32;
        let w = (rect.width() * frac).max(24.0);
        let x = rect.left() + (self.view.scroll_x / content) as f32 * rect.width();
        let thumb = Rect::from_min_size(Pos2::new(x, rect.top() + 2.0), Vec2::new(w, rect.height() - 4.0));
        painter.rect_filled(thumb, CornerRadius::same(3), pal.gray[5]);
        let r = ui.interact(rect, ui.scope_id().with("hscroll"), Sense::drag());
        if r.drag_started()
            && let Some(p) = r.interact_pointer_pos()
        {
            self.drag = Drag::ScrollBar { x0: p.x, sx: self.view.scroll_x };
        }
        if let (Drag::ScrollBar { x0, sx }, Some(p)) = (&self.drag, r.interact_pointer_pos()) {
            self.view.scroll_x = (sx + f64::from(p.x - x0) / f64::from(rect.width()) * content).max(0.0);
        }
        if r.drag_stopped() {
            self.drag = Drag::None;
        }
    }

    fn hit_at(&self, lanes: Rect, p: Pos2) -> Hit {
        layout::hit(&self.layout, &self.view, f64::from(p.x - lanes.left()), p.y - lanes.top())
    }

    fn snap_pts(&self, seq: &Sequence, app: &App, exclude: &[Id]) -> Vec<Ticks> {
        self.layout.snap_points(seq, app.t, [app.in_out.in_, app.in_out.out], exclude)
    }

    fn apply_selection(app: &mut App, s: Selecting) {
        match s {
            Selecting::Keep => {}
            Selecting::Set(ids) => app.select(ids, false, false),
            Selecting::Add(ids) => app.select(ids, true, false),
            Selecting::Remove(ids) => {
                for id in ids {
                    app.selection.remove(&id);
                }
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    fn input(
        &mut self,
        ui: &mut egui::Ui,
        own: egui::Id,
        [full, ruler, lanes]: [Rect; 3],
        app: &mut App,
        seq: &Sequence,
    ) {
        let ctx = ui.ctx().clone();
        let (pointer, pressed, released, down, middle, m, scroll, zoom) = ctx.input(|i| {
            (
                i.pointer.latest_pos(),
                i.pointer.primary_pressed(),
                i.pointer.any_released(),
                i.pointer.primary_down(),
                i.pointer.button_pressed(egui::PointerButton::Middle),
                mods(i.modifiers),
                i.smooth_scroll_delta,
                i.modifiers.ctrl || i.modifiers.alt,
            )
        });
        let frame = frame_of(seq);
        let over = pointer.is_some_and(|p| full.contains(p));
        let blocked = ctx.dragged_id().is_some_and(|d| d != own)
            || egui::DragAndDrop::has_any_payload(&ctx)
            || pointer.is_some_and(|p| self.direct_blocks(p))
            // a menu or a window over the lanes takes its own clicks
            || pointer.is_some_and(|p| ctx.layer_id_at(p).is_some_and(|l| l != ui.layer_id()));
        // wheel: scroll in time (Shift) or across tracks; Ctrl/Alt zooms around the pointer
        if over && let Some(p) = pointer {
            if zoom && scroll.y != 0.0 {
                let x = f64::from(p.x - lanes.left());
                let t = self.view.t_of(x).max(0.0) as Ticks;
                self.zoom_at(app, self.view.pps * (f64::from(scroll.y) / 200.0).exp(), t, x);
            } else if m.shift && scroll.y != 0.0 || scroll.x != 0.0 {
                self.view.scroll_x =
                    (self.view.scroll_x - f64::from(scroll.x + if m.shift { scroll.y } else { 0.0 })).max(0.0);
            } else if scroll.y != 0.0 && p.y > ruler.bottom() {
                self.view.scroll_y = (self.view.scroll_y - scroll.y).max(0.0);
            }
        }
        if let Some(p) = pointer
            && !blocked
            && matches!(self.drag, Drag::None)
        {
            if middle && lanes.contains(p) {
                self.drag = Drag::Hand { x0: p.x, y0: p.y, sx: self.view.scroll_x, sy: self.view.scroll_y };
            } else if pressed && ruler.contains(p) {
                app.focus = Some(Panel::Timeline);
                if !self.press_ruler(app, seq, ruler, p) {
                    self.drag = Drag::Scrub;
                }
            } else if pressed && lanes.contains(p) && app.tool == Tool::Text {
                app.focus = Some(Panel::Timeline);
                self.type_at(app, seq, lanes, p);
            } else if pressed && lanes.contains(p) {
                app.focus = Some(Panel::Timeline);
                let at = (f64::from(p.x - lanes.left()), p.y - lanes.top());
                let on_caption = crate::captions::track::hit(seq, &self.layout, &self.view, at.0, at.1).is_some();
                let pts = if on_caption { self.snap_pts(seq, app, &[]) } else { Vec::new() };
                let took = self.captions.press(app, seq, &self.layout, &self.view, at, pts);
                if !took && !self.press_edit(app, seq, lanes, p, m) {
                    self.press(app, seq, lanes, p, m);
                }
            }
        }
        let Some(p) = pointer else { return };
        let lx = f64::from(p.x - lanes.left());
        let ly = p.y - lanes.top();
        if self.captions.dragging() {
            let snap = app.snapping != m.shift;
            self.captions.step(app, seq, &self.view, lx, snap);
        }
        match &mut self.drag {
            Drag::None | Drag::ScrollBar { .. } => {
                if lanes.contains(p) {
                    let h = self.hit_at(lanes, p);
                    let edit = self.edit_cursor(app, seq, lanes, p);
                    let icon = edit.unwrap_or(match (app.tool, h.part) {
                        (Tool::Razor, _) => CursorIcon::Crosshair,
                        (Tool::Hand, _) => CursorIcon::Grab,
                        (Tool::Zoom, _) => CursorIcon::ZoomIn,
                        (Tool::Text, _) => CursorIcon::Text,
                        (Tool::Select | Tool::Ripple | Tool::Roll, Some(Part::Start | Part::End)) => {
                            CursorIcon::ResizeHorizontal
                        }
                        _ => CursorIcon::Default,
                    });
                    ctx.set_cursor_icon(icon);
                }
            }
            Drag::Scrub => {
                let x = f64::from(p.x - ruler.left());
                let t = self.view.t_of(x).max(0.0) as Ticks;
                app.set_time(snap(t, seq.fps, true));
            }
            Drag::Hand { x0, y0, sx, sy } => {
                self.view.scroll_x = (*sx - f64::from(p.x - *x0)).max(0.0);
                self.view.scroll_y = (*sy - (p.y - *y0)).max(0.0);
                ctx.set_cursor_icon(CursorIcon::Grabbing);
            }
            Drag::Move { d, .. } => {
                d.step(&self.layout, &self.view, (lx, ly), m, app.snapping, frame);
                if d.moved {
                    let sign = if d.delta < 0 { "-" } else { "+" };
                    let mut tip = format!("{sign}{}", timecode(d.delta.abs(), seq.fps));
                    if m.alt {
                        tip.push_str(&format!("  {}", tr("Duplicate")));
                    }
                    if m.ctrl {
                        tip.push_str(&format!("  {}", tr("Insert")));
                    }
                    self.tip = Some(tip);
                }
            }
            Drag::Trim { d, open } => {
                if let Some(c) = d.step(seq, &self.view, lx, m, app.snapping, frame) {
                    if *open {
                        app.history.cancel();
                    }
                    app.history.begin("Trim");
                    *open = true;
                    let r = app.history.apply(&c);
                    let applied =
                        r.as_ref().ok().and_then(|r| r.get("applied")).and_then(serde_json::Value::as_i64).unwrap_or(0);
                    // the edit point after this try: the trim view shows the frames on either side of it
                    let at = if d.mode == "ripple" && d.edge == Part::Start { d.pos } else { d.pos + applied };
                    self.trim_view = Some([(at >= frame).then(|| at - frame), Some(at)]);
                    let name = match d.mode {
                        "ripple" => tr("Ripple Edit"),
                        "roll" => tr("Rolling Edit"),
                        _ => tr("Trim"),
                    };
                    let sign = if applied < 0 { "-" } else { "+" };
                    let why = match &r {
                        Err(e) => format!(" — {}", tr(&e.message)),
                        Ok(v) => match v.get("clamped").and_then(serde_json::Value::as_str) {
                            Some("source") => format!(" — {}", tr("Source end")),
                            Some("neighbour") => format!(" — {}", tr("The next clip is in the way")),
                            Some("length") => format!(" — {}", tr("A clip is at least one frame long")),
                            Some(_) => format!(" — {}", tr("Stopped")),
                            None => String::new(),
                        },
                    };
                    self.tip = Some(format!("{name} {sign}{}{why}", timecode(applied.abs(), seq.fps)));
                }
                ctx.set_cursor_icon(CursorIcon::ResizeHorizontal);
            }
            Drag::Height { track, y0, h0, open } => {
                let h = (*h0 + f64::from(p.y - *y0))
                    .clamp(f64::from(layout::TRACK_MIN), f64::from(layout::TRACK_MAX))
                    .round();
                if *open {
                    app.history.cancel();
                }
                app.history.begin("Track Height");
                *open = true;
                let _ = app.history.apply(&cmd::set_track(seq.id, *track, json!({ "height": h })));
                ctx.set_cursor_icon(CursorIcon::ResizeVertical);
            }
            Drag::Marquee { .. } => {}
            Drag::Tool { .. } => self.step_tool(app, seq, lanes, p, m),
            Drag::Marker(_) => self.step_marker(app, seq, ruler, p),
        }
        if released && !down {
            self.captions.release(app);
            self.release(app, seq, lanes, p, m);
        }
    }

    fn press(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2, m: Mods) {
        let h = self.hit_at(lanes, p);
        let snaps = app.snapping.then(|| self.snap_pts(seq, app, &[]));
        let lim = layout::snap_limit(self.view.pps);
        let decided = gesture::press(seq, &self.layout, &h, app.tool, m, seq.fps, snaps.as_deref().map(|s| (s, lim)));
        let lx = f64::from(p.x - lanes.left());
        let ly = p.y - lanes.top();
        let selection = app.selected();
        match decided {
            Press::Nothing => {}
            Press::Hand => self.drag = Drag::Hand { x0: p.x, y0: p.y, sx: self.view.scroll_x, sy: self.view.scroll_y },
            Press::Zoom { t, factor } => self.zoom_at(app, self.view.pps * factor, t as Ticks, lx),
            Press::Razor(c) => {
                if let Some(r) = app.exec(&c)
                    && r.get("ids").and_then(|v| v.as_array()).is_some_and(Vec::is_empty)
                {
                    app.toast(tr("Nothing to cut here."));
                }
            }
            Press::TrackSelect(pick, grab) => {
                app.select(pick.iter().copied(), false, false);
                if let Some(g) = grab {
                    let pts = self.snap_pts(seq, app, &pick);
                    if let Some(d) = MoveDrag::new(seq, &self.layout, &pick, g, pts, (lx, ly), &self.view) {
                        self.drag = Drag::Move { d, pending: None };
                    }
                }
            }
            Press::Trim { clip, edge, mode } => {
                Self::apply_selection(app, gesture::press_selection(seq, &selection, clip, m, app.linked_selection));
                let pts = self.snap_pts(seq, app, &gesture::trim_exclude(seq, clip, edge, mode));
                if let Some(d) = TrimDrag::new(seq, clip, (edge, mode), m, pts, lx, &self.view) {
                    self.drag = Drag::Trim { d, open: false };
                }
            }
            Press::Move { clip } => {
                let pending = (m.ctrl || (!m.shift && selection.contains(&clip))).then_some((clip, m));
                Self::apply_selection(app, gesture::press_selection(seq, &selection, clip, m, app.linked_selection));
                let sel = app.selected();
                let pts = self.snap_pts(seq, app, &sel);
                if let Some(d) = MoveDrag::new(seq, &self.layout, &sel, clip, pts, (lx, ly), &self.view) {
                    self.drag = Drag::Move { d, pending };
                }
            }
            Press::Empty => {
                if !m.shift {
                    app.selection.clear();
                }
                self.drag = Drag::Marquee { from: p, add: m.shift };
            }
        }
    }

    fn release(&mut self, app: &mut App, seq: &Sequence, lanes: Rect, p: Pos2, m: Mods) {
        let drag = std::mem::replace(&mut self.drag, Drag::None);
        self.tip = None;
        self.trim_view = None;
        match drag {
            Drag::Move { d, pending } => {
                if !d.moved {
                    if let Some((clip, pm)) = pending {
                        let sel = app.selected();
                        Self::apply_selection(
                            app,
                            gesture::release_selection(seq, &sel, clip, pm, app.linked_selection),
                        );
                    }
                } else if let Some(c) = d.copy(seq, m) {
                    if let Some(r) = app.exec(&c)
                        && let Some(ids) = r.get("ids").and_then(|v| v.as_array())
                    {
                        let ids: Vec<Id> = ids.iter().filter_map(|v| v.as_str()).map(Id::new).collect();
                        app.select(ids, false, false);
                    }
                } else if let Some(c) = d.finish(seq, m) {
                    app.exec(&c);
                }
            }
            Drag::Trim { d, open } => {
                if open {
                    if d.moved {
                        app.history.commit()
                    } else {
                        app.history.cancel()
                    }
                    app.prune_selection();
                }
            }
            Drag::Height { open, .. } => {
                if open {
                    app.history.commit();
                }
            }
            Drag::Marquee { from, add } => {
                let r = Rect::from_two_pos(from, p);
                if r.width() > 3.0 || r.height() > 3.0 {
                    let a = self.view.t_of(f64::from(r.left() - lanes.left())) as Ticks;
                    let b = self.view.t_of(f64::from(r.right() - lanes.left())) as Ticks;
                    let mut ids = Vec::new();
                    for row in &self.layout.rows {
                        let top = lanes.top() + row.y - self.view.scroll_y;
                        if top + row.h < r.top() || top > r.bottom() {
                            continue;
                        }
                        if let Some(track) = row.id {
                            ids.extend(
                                self.layout
                                    .visible(track, a, b)
                                    .iter()
                                    .filter(|s| s.end > a && s.start < b)
                                    .map(|s| s.id),
                            );
                        }
                    }
                    app.select(ids, add, false);
                } else {
                    self.pick_gap(app, seq, lanes, p);
                }
            }
            Drag::Tool { d, open, source_end } => Self::release_tool(app, &d, open, source_end),
            Drag::Marker(d) => Self::release_marker(app, seq, &d),
            Drag::None | Drag::Scrub | Drag::Hand { .. } | Drag::ScrollBar { .. } => {}
        }
    }

    /// Media dragged from the Project panel and dropped on a track: placed there (overwrite; Ctrl inserts).
    fn drop_media(&mut self, ui: &mut egui::Ui, lanes: Rect, app: &mut App, seq: &Sequence) {
        let Some(p) = ui.ctx().pointer_latest_pos() else { return };
        if !lanes.contains(p) {
            return;
        }
        let dragging = egui::DragAndDrop::has_payload_of_type::<MediaDrag>(ui.ctx());
        if dragging {
            let painter = ui.painter_at(lanes);
            painter.vline(p.x, lanes.y_range(), Stroke::new(1.0, Color32::from_rgb(0x4f, 0xc3, 0xf7)));
        }
        let released = ui.input(|i| i.pointer.any_released());
        if !(dragging && released) {
            return;
        }
        let Some(payload) = egui::DragAndDrop::take_payload::<MediaDrag>(ui.ctx()) else { return };
        let insert = ui.input(|i| i.modifiers.ctrl);
        let h = self.hit_at(lanes, p);
        let row = h.row.map(|i| self.layout.rows[i].clone());
        let video = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).collect::<Vec<_>>();
        let audio = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).collect::<Vec<_>>();
        let (v, a) = match row.as_ref().map(|r| (r.kind, r.index)) {
            Some((RowKind::Video, i)) => (video.get(i).map(|t| t.id), audio.get(i).or(audio.first()).map(|t| t.id)),
            Some((RowKind::Audio, i)) => (video.get(i).or(video.first()).map(|t| t.id), audio.get(i).map(|t| t.id)),
            _ => (video.first().map(|t| t.id), audio.first().map(|t| t.id)),
        };
        let mut at = snap(h.t.max(0.0) as Ticks, seq.fps, true);
        if app.snapping {
            let pts = self.snap_pts(seq, app, &[]);
            at += layout::snap_delta(&[at], 0, &pts, layout::snap_limit(self.view.pps)).0;
        }
        let mode = if insert { "insert" } else { "overwrite" };
        let seq_id = seq.id;
        let p = app.project();
        let first =
            payload.0.iter().copied().find(|m| p.media(*m).is_some_and(|m| m.kind == cut_model::MediaKind::Video));
        let list = payload.0.clone();
        crate::edit::mismatch::before(app, first, Some("Place"), move |app: &mut App| {
            app.history.begin("Place");
            let mut t = at;
            for id in &list {
                match app.history.apply(&cmd::place(seq_id, *id, v, a, t, mode)) {
                    Ok(r) => {
                        let ids = r.get("ids").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        let seq_now = app.sequence();
                        t = ids
                            .iter()
                            .filter_map(|v| v.as_str())
                            .filter_map(|id| seq_now.and_then(|s| s.clip(Id::new(id))).map(|c| c.end()))
                            .max()
                            .unwrap_or(t);
                    }
                    Err(e) => {
                        app.history.cancel();
                        app.report(tr(&e.message).into_owned());
                        return;
                    }
                }
            }
            app.history.commit();
            app.prune_selection();
            app.set_time(at);
        });
    }
}
