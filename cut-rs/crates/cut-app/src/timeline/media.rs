//! What a clip shows under its name (ui-timeline.js `drawClip`, `thumbsFor`, `drawWave`): a video clip's frames as
//! tiles at the picture's own aspect, each the strip frame under its middle; an audio clip's waveform, one column a
//! pixel, scaled by the clip's volume. Only clips on screen ask, and only for what they show.

use cut_model::{Clip, Media, MediaKind, Props};
use cut_time::TICKS;
use eframe::egui::{Color32, Painter, Pos2, Rect, Vec2, pos2};

use super::layout::View;
use crate::thumbs::{Thumbs, file_key};

/// Pixels: a narrower clip shows no picture, so it asks for none (`THUMB_MIN_W`).
const THUMB_MIN_W: f32 = 8.0;
/// The name bar's height above the pictures.
pub const NAME_H: f32 = 15.0;

/// Draws the thumbnails or waveform of `clip` (on screen at `r`, clipped to `lanes`).
#[allow(clippy::too_many_arguments)]
pub fn draw(
    painter: &Painter,
    thumbs: &mut Thumbs,
    view: &View,
    lanes: Rect,
    r: Rect,
    clip: &Clip,
    m: &Media,
    audio_track: bool,
    light: bool,
) {
    let body = Rect::from_min_max(pos2(r.left(), r.top() + NAME_H), r.max);
    if body.height() < 14.0 {
        return;
    }
    let p = painter.with_clip_rect(body.intersect(lanes));
    if audio_track {
        wave(&p, thumbs, view, lanes, body, clip, m, light);
    } else if matches!(m.kind, MediaKind::Video | MediaKind::Image) {
        tiles(&p, thumbs, view, lanes, body, clip, m);
    }
}

#[allow(clippy::too_many_arguments)]
fn tiles(p: &Painter, thumbs: &mut Thumbs, view: &View, lanes: Rect, body: Rect, clip: &Clip, m: &Media) {
    let (x1, x2) = (body.left(), body.right());
    let cw = (x2 - x1).max(1.0);
    if cw < THUMB_MIN_W {
        return;
    }
    let bh = body.height();
    let aspect = m.video.as_ref().filter(|v| v.w > 0.0 && v.h > 0.0).map_or(16.0 / 9.0, |v| v.w / v.h) as f32;
    let still = m.kind == MediaKind::Image || clip.is_freeze();
    let tw = (bh * aspect).max(12.0);
    let count = if still { 1 } else { 2usize.pow((cw / tw).max(1.0).log2().ceil() as u32).min(64) };
    let hb = if bh <= 40.0 {
        40
    } else if bh <= 72.0 {
        72
    } else {
        120
    };
    let prefix =
        format!("{}|{}|{}|{}|", file_key(m), u8::from(clip.reverse), clip.in_.round() as i64, clip.out.round() as i64);
    let (lo, hi) = (clip.in_.min(clip.out), clip.in_.max(clip.out));
    let (from, to) = if still { (clip.in_, clip.in_) } else { (lo, hi) };
    let Some(list) = thumbs.strip(m, &prefix, from, to, count, hb) else { return };
    let n = list.len();
    if n == 0 {
        return;
    }
    let first = ((lanes.left() - x1) / tw).floor().max(0.0) as i64;
    let last = ((lanes.right().min(x2) - x1) / tw).ceil() as i64;
    let span = (hi - lo).max(1.0);
    let at = |k: i64| -> usize {
        let mid = x1 + (k as f32 + 0.5) * tw;
        let i = if clip.remap.is_some() {
            let t = view.t_of(f64::from(mid - lanes.left()));
            ((clip.source_time(t) - lo) / span * n as f64).floor()
        } else {
            (f64::from((k as f32 + 0.5) * tw / cw) * n as f64).floor()
        };
        let i = (i.max(0.0) as usize).min(n - 1);
        if clip.reverse { n - 1 - i } else { i }
    };
    let uv = Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0));
    for k in first..last.max(first) {
        let tex = &list[if still { 0 } else { at(k) }];
        let tile = Rect::from_min_size(pos2(x1 + k as f32 * tw, body.top()), Vec2::new(tw, bh));
        p.image(tex.id(), tile, uv, Color32::WHITE);
    }
}

#[allow(clippy::too_many_arguments)]
fn wave(p: &Painter, thumbs: &mut Thumbs, view: &View, lanes: Rect, body: Rect, clip: &Clip, m: &Media, light: bool) {
    let Some(peaks) = thumbs.peaks(m) else { return };
    let n = peaks.data.len() / 2;
    if n == 0 {
        return;
    }
    let mid = body.center().y;
    let half = body.height() / 2.0;
    let volume = match &clip.props {
        Props::Audio(a) => a.volume,
        Props::Video(_) => 0.0,
    };
    let gain = 10f64.powf(volume / 20.0);
    let color = if light {
        Color32::from_rgba_unmultiplied(10, 40, 30, 140)
    } else {
        Color32::from_rgba_unmultiplied(170, 235, 210, 191)
    };
    let xa = body.left().max(lanes.left()).floor() as i64;
    let xb = body.right().min(lanes.right()).ceil() as i64;
    let t_of = |x: i64| view.t_of((x as f32 - lanes.left()) as f64);
    for x in xa..xb {
        let (s0, s1) = (clip.source_time(t_of(x)), clip.source_time(t_of(x + 1)));
        let mut i0 = (s0.min(s1) / TICKS as f64 * peaks.per_sec).floor() as i64;
        let mut i1 = (s0.max(s1) / TICKS as f64 * peaks.per_sec).ceil() as i64;
        if i1 <= i0 {
            i1 = i0 + 1;
        }
        i0 = i0.max(0);
        i1 = i1.min(n as i64);
        let (mut lo, mut hi) = (0f32, 0f32);
        for i in i0..i1 {
            lo = lo.min(peaks.data[2 * i as usize]);
            hi = hi.max(peaks.data[2 * i as usize + 1]);
        }
        let top = mid - (f64::from(hi) * gain).min(1.0) as f32 * half;
        let bot = mid - (f64::from(lo) * gain).max(-1.0) as f32 * half;
        let r = Rect::from_min_max(pos2(x as f32, top), pos2(x as f32 + 1.0, bot.max(top + 1.0)));
        p.rect_filled(r, 0.0, color);
    }
}
