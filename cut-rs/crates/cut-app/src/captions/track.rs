//! The timeline's caption rows (`ui-timeline.js`'s `drawCaptions`, the caption part of `hit`, `startCaption` and
//! `deleteSelection`): a press on a caption selects it; dragging its body moves it, its edges trim it, a frame at a
//! time and snapping to the timeline's points (Shift turns snapping the other way), live inside one undo step named
//! Edit Caption; a press that does not move puts the playhead at its start. Delete removes the selected caption.

use cut_model::commands::build as C;
use cut_model::{CaptionTrack, Id, Sequence};
use cut_time::{Ticks, frame_start};
use eframe::egui::{self, Color32, FontId, Pos2, Rect, Stroke, StrokeKind};
use serde_json::{Value as Json, json};

use crate::state::App;
use crate::theme::Palette;
use crate::timeline::layout::{self, EDGE, Layout, RowKind, View};

/// Which part of a caption a press took.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Start,
    End,
    Body,
}

/// A caption under the pointer: its track, its id, the part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hit {
    pub track: Id,
    pub item: Id,
    pub part: Part,
}

/// The caption at `(x, y)` in lane coordinates, if the row there is a caption row: within 4 points of a caption, an
/// edge zone of up to [`EDGE`] (a third of a short caption) takes the edge, outside it the nearer edge.
pub fn hit(seq: &Sequence, l: &Layout, view: &View, x: f64, y: f32) -> Option<Hit> {
    let row = l.rows.iter().find(|r| y + view.scroll_y >= r.y && y + view.scroll_y < r.y + r.h)?;
    if row.kind != RowKind::Caption {
        return None;
    }
    let ct = seq.captions.iter().find(|c| Some(c.id) == row.id)?;
    let edge = f64::from(EDGE);
    for it in &ct.items {
        let (xa, xb) = (view.x_of(it.start), view.x_of(it.end));
        if x >= xa - 4.0 && x <= xb + 4.0 {
            let zone = edge.min((xb - xa) / 3.0);
            let part = if x < xa {
                Part::Start
            } else if x > xb {
                Part::End
            } else if x - xa < zone {
                Part::Start
            } else if xb - x < zone {
                Part::End
            } else {
                Part::Body
            };
            return Some(Hit { track: ct.id, item: it.id, part });
        }
    }
    None
}

#[derive(Debug, Clone)]
struct Drag {
    hit: Hit,
    start: Ticks,
    end: Ticks,
    x0: f64,
    pts: Vec<Ticks>,
    moved: bool,
    open: bool,
}

/// The caption selected on the timeline and the drag of one.
#[derive(Debug, Default)]
pub struct CaptionEdit {
    /// `(caption track, caption)`.
    pub selected: Option<(Id, Id)>,
    drag: Option<Drag>,
    /// Where the snap guide is, while dragging.
    pub guide: Option<Ticks>,
}

impl CaptionEdit {
    /// A press in the lanes at `(x, y)` (content x, from the lanes' left with the scroll in) -> whether a caption took
    /// it. Any other press drops the caption selection.
    pub fn press(
        &mut self,
        app: &mut App,
        seq: &Sequence,
        l: &Layout,
        view: &View,
        (x, y): (f64, f32),
        pts: Vec<Ticks>,
    ) -> bool {
        let Some(h) = hit(seq, l, view, x, y) else {
            self.selected = None;
            return false;
        };
        let Some(it) =
            seq.captions.iter().find(|c| c.id == h.track).and_then(|c| c.items.iter().find(|i| i.id == h.item))
        else {
            return false;
        };
        self.selected = Some((h.track, h.item));
        app.selection.clear();
        app.edit.transition = None;
        app.edit.gap = None;
        self.drag =
            Some(Drag { hit: h, start: it.start, end: it.end, x0: x + view.scroll_x, pts, moved: false, open: false });
        true
    }

    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }

    /// The pointer at `x` while dragging: the caption moved or trimmed live. `snap`: snapping on (after Shift).
    pub fn step(&mut self, app: &mut App, seq: &Sequence, view: &View, x: f64, snap: bool) {
        let Some(d) = &mut self.drag else { return };
        let now = x + view.scroll_x;
        if !d.moved && (now - d.x0).abs() < 3.0 {
            return;
        }
        d.moved = true;
        let f = frame_start(1, seq.fps).max(1);
        let mut delta = layout::frames_delta(now - d.x0, view.pps, f);
        let cands: Vec<Ticks> = match d.hit.part {
            Part::Start => vec![d.start],
            Part::End => vec![d.end],
            Part::Body => vec![d.start, d.end],
        };
        self.guide = None;
        if snap {
            let (nd, at) = layout::snap_delta(&cands, delta, &d.pts, layout::snap_limit(view.pps));
            delta = nd;
            self.guide = at;
        }
        let patch: Json = match d.hit.part {
            Part::Start => json!({ "start": (d.start + delta).min(d.end - f).max(0) }),
            Part::End => json!({ "end": (d.end + delta).max(d.start + f) }),
            Part::Body => {
                let dd = delta.max(-d.start);
                json!({ "start": d.start + dd, "end": d.end + dd })
            }
        };
        if d.open {
            app.history.cancel();
        }
        app.history.begin("Edit Caption");
        d.open = true;
        let _ = app.history.apply(&C::set_caption(seq.id.as_str(), d.hit.track.as_str(), d.hit.item.as_str(), patch));
    }

    /// The button went up: the edit kept as one step, or the playhead put at the caption's start.
    pub fn release(&mut self, app: &mut App) {
        let Some(d) = self.drag.take() else { return };
        self.guide = None;
        if d.open {
            app.history.commit();
        }
        if !d.moved {
            app.set_time(d.start);
        }
    }

    pub fn is_selected(&self, track: Id, item: Id) -> bool {
        self.selected == Some((track, item))
    }
}

/// A caption row's captions in `row` (`drawCaptions`): those in `[a, b]`, the selected one outlined, the text with
/// its line breaks as spaces where there is room.
#[allow(clippy::too_many_arguments)]
pub fn draw(
    p: &egui::Painter,
    row: Rect,
    ct: &CaptionTrack,
    (a, b): (Ticks, Ticks),
    x_of: &dyn Fn(Ticks) -> f32,
    edit: &CaptionEdit,
    pal: &Palette,
    font: &FontId,
) {
    let (fill, text) = if pal.light() {
        (Color32::from_rgb(0xd8, 0xc5, 0x8a), Color32::from_rgb(0x2a, 0x24, 0x10))
    } else {
        (Color32::from_rgb(0x5a, 0x50, 0x30), Color32::from_rgb(0xf0, 0xe6, 0xc0))
    };
    let (y, h) = (row.top(), row.height());
    for it in ct.items.iter().filter(|it| it.end >= a && it.start <= b) {
        let x1 = x_of(it.start).max(row.left() - 2.0);
        let x2 = x_of(it.end).min(row.right() + 2.0);
        p.rect_filled(
            Rect::from_min_size(Pos2::new(x1, y + 2.0), egui::vec2((x2 - x1 - 1.0).max(1.0), h - 4.0)),
            0.0,
            fill,
        );
        if edit.is_selected(ct.id, it.id) {
            let r = Rect::from_min_size(Pos2::new(x1 + 1.0, y + 3.0), egui::vec2(x2 - x1 - 3.0, h - 6.0));
            p.rect_stroke(r, 0.0, Stroke::new(2.0, pal.selected), StrokeKind::Middle);
        }
        if x2 - x1 > 20.0 {
            let one_line = it.text.split_whitespace().collect::<Vec<_>>().join(" ");
            crate::timeline::fit_text(p, Pos2::new(x1 + 4.0, y + 7.0), &one_line, x2 - x1 - 8.0, font.clone(), text);
        }
    }
}

/// Delete on the timeline with a caption selected.
pub fn delete_selected(app: &mut App, edit: &mut CaptionEdit) {
    let (Some((track, item)), Some(seq)) = (edit.selected.take(), app.sequence_id) else { return };
    app.exec(&C::remove_caption(seq.as_str(), track.as_str(), item.as_str()));
}
