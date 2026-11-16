//! The volume slider in an audio track's header (`ui-timeline.js` `volumeControl`): a percent of the clips' level, 0
//! to 200 %. Dragging sideways changes it by the distance moved, so a click alone changes nothing; a double click
//! types a value, Alt+click is 100 %. A drag is one "Track Volume" undo step.

use cut_model::{Id, Sequence, Track};
use eframe::egui::{self, Align2, FontId, Pos2, Rect, Sense, Stroke, Vec2};
use serde_json::json;

use super::editing::{track_db, track_percent};
use crate::cmd;
use crate::edit::dialogs::EditDialog;
use crate::i18n::tr;
use crate::state::App;
use crate::theme::Palette;

/// The header has room for the slider from this height on (`h < 44` hides it).
pub const MIN_HEIGHT: f32 = 44.0;
const MAX: f64 = 200.0;

/// A drag of a track's slider: where it began and the volume there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VolumeDrag {
    track: Id,
    x0: f32,
    p0: f64,
}

/// Where the slider of a header `head` is: under the buttons' row, the bar and the percentage after it.
pub fn rect(head: Rect) -> Rect {
    Rect::from_min_size(head.min + Vec2::new(8.0, 28.0), Vec2::new(head.width() - 16.0, 12.0))
}

/// An audio track's header: the track, where its header is and what of it shows.
pub struct Head<'a> {
    pub seq: &'a Sequence,
    pub track: &'a Track,
    pub rect: Rect,
    pub clip: Rect,
}

/// Draws the slider of a track in its header and handles it. -> its response (the header's menu opens on it too).
pub fn show(
    ui: &mut egui::Ui,
    drag: &mut Option<VolumeDrag>,
    app: &mut App,
    pal: &Palette,
    h: &Head<'_>,
) -> Option<egui::Response> {
    let Head { seq, track, rect: head, clip } = *h;
    if head.height() < MIN_HEIGHT {
        return None;
    }
    let all = rect(head);
    let bar = Rect::from_min_max(all.min + Vec2::new(0.0, 3.0), Pos2::new(all.right() - 40.0, all.bottom() - 3.0));
    let pct = track_percent(track.volume.unwrap_or(0.0));
    let p = ui.painter_at(clip);
    p.rect_filled(bar, 2.0, pal.gray[4]);
    let fill = bar.left() + bar.width() * ((pct / MAX) as f32).clamp(0.0, 1.0);
    p.rect_filled(Rect::from_min_max(bar.min, Pos2::new(fill, bar.bottom())), 2.0, pal.accent.gamma_multiply(0.8));
    // 100 %: the clips' own level
    p.vline(bar.center().x, all.y_range(), Stroke::new(1.0, pal.gray[8]));
    p.text(
        Pos2::new(all.right(), all.center().y),
        Align2::RIGHT_CENTER,
        format!("{}%", pct.round()),
        FontId::monospace(10.0),
        pal.gray[10],
    );
    let r = ui
        .interact(all.intersect(clip), ui.scope_id().with(("volume", track.id.as_str())), Sense::click_and_drag())
        .on_hover_text(tr("Track volume: drag sideways to change, double-click to type a value, Alt+click for 100%"));
    let set = |app: &mut App, pct: f64| {
        let db = track_db(pct);
        let now = app.sequence().and_then(|s| s.track(track.id)).and_then(|t| t.volume).unwrap_or(0.0);
        (now != db).then(|| cmd::set_track(seq.id, track.id, json!({ "volume": db })))
    };
    if r.double_clicked() {
        app.edit.dialog = Some(EditDialog::TrackVolume { id: track.id, text: format!("{}", pct.round()) });
    } else if r.clicked()
        && ui.input(|i| i.modifiers.alt)
        && let Some(c) = set(app, 100.0)
    {
        app.exec(&c);
    }
    if r.drag_started()
        && let Some(at) = r.interact_pointer_pos()
    {
        app.history.begin("Track Volume");
        *drag = Some(VolumeDrag { track: track.id, x0: at.x, p0: pct });
    }
    if let Some(d) = drag.filter(|d| d.track == track.id) {
        if r.dragged()
            && let Some(at) = r.interact_pointer_pos()
        {
            let per_px = MAX / f64::from(bar.width().max(40.0));
            if let Some(c) = set(app, d.p0 + f64::from(at.x - d.x0) * per_px) {
                let _ = app.history.apply(&c);
            }
        }
        if r.drag_stopped() || !ui.input(|i| i.pointer.primary_down()) {
            app.history.commit();
            *drag = None;
        }
    }
    Some(r)
}
