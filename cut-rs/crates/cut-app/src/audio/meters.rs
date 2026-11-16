//! The level meters (`ui-meters.js`, and the strips of `ui-mixer.js`, which run the same arithmetic): each channel's
//! level on a dB scale from -60 to 0 that rises at once and falls 30 dB a second, a peak-hold line that stays 1.5 s and
//! then falls 20 dB a second, and for the Audio Meters panel the RMS solid under the lighter peak, a clip light per
//! channel that stays on after 0 dBFS until it is clicked, the highest peak since then, and a dashed -1 dBTP line.
//!
//! The levels come from `cut-audio`'s [`Playback::meters`](cut_audio::playback::Playback::meters): the mixing thread
//! notes each block's peaks and RMS when it pushes the block into the device's ring, and the UI thread reads the note of
//! the block sounding now under a mutex the device callback never takes, so drawing the meters never waits on the
//! sound and the sound never waits on the meters.

use cut_model::Id;
use eframe::egui::{self, Color32, CornerRadius, FontId, Pos2, Rect, Sense, Stroke, Vec2};

use crate::i18n::tr;
use crate::theme::Palette;

/// The bottom of the scale (dBFS).
const FLOOR: f64 = -60.0;
/// The true-peak ceiling the export presets aim under, drawn dashed.
const CEILING: f64 = -1.0;
const HOLD_MS: f64 = 1500.0;
/// dB a second the hold falls once it ran out.
const HOLD_FALL: f64 = 20.0;
/// dB a second a bar falls (it rises at once).
const BAR_FALL: f64 = 30.0;
const TICKS: [f64; 11] = [0.0, -6.0, -12.0, -18.0, -24.0, -30.0, -36.0, -42.0, -48.0, -54.0, -60.0];
const LOW: Color32 = Color32::from_rgb(0x3f, 0xae, 0x5a);
const MID: Color32 = Color32::from_rgb(0xe6, 0xc8, 0x4a);
/// The clip light and the loudest zone (`--cut-meter-high`).
const HIGH: Color32 = Color32::from_rgb(0xe0, 0x55, 0x55);

/// What one channel pair is hearing now (dBFS, -inf for silence).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Heard {
    pub peak: [f64; 2],
    pub rms: [f64; 2],
}

/// One meter's moving state, per channel (dBFS; -inf below the floor).
#[derive(Debug, Clone, PartialEq)]
pub struct Ballistics {
    pub peak: [f64; 2],
    pub rms: [f64; 2],
    pub hold: [f64; 2],
    hold_at: [f64; 2],
    /// The highest peak since the last reset (the readout), and whether 0 dBFS was reached.
    pub max: [f64; 2],
    pub clip: [bool; 2],
    /// The time of the frame before (ms), while the meter keeps moving.
    last: Option<f64>,
    /// The UI frame that drew it last: a gap means it was off screen, and it goes on from where it was.
    drawn: Option<u64>,
}

impl Default for Ballistics {
    fn default() -> Self {
        let q = f64::NEG_INFINITY;
        Self {
            peak: [q; 2],
            rms: [q; 2],
            hold: [q; 2],
            hold_at: [0.0; 2],
            max: [q; 2],
            clip: [false; 2],
            last: None,
            drawn: None,
        }
    }
}

impl Ballistics {
    /// One animation frame at `now` (ms) with what is heard (`None` while not playing) -> whether the meter still
    /// moves and wants another frame (`frame`'s `busy`).
    pub fn frame(&mut self, now: f64, playing: bool, heard: Option<Heard>) -> bool {
        let dt = self.last.map_or(0.0, |l| ((now - l) / 1000.0).min(0.25));
        self.last = Some(now);
        let mut busy = playing;
        let q = f64::NEG_INFINITY;
        for ch in 0..2 {
            let (peak, rms) = heard.map_or((q, q), |h| (h.peak[ch], h.rms[ch]));
            self.peak[ch] = if peak >= self.peak[ch] { peak } else { peak.max(self.peak[ch] - BAR_FALL * dt) };
            self.rms[ch] = if rms >= self.rms[ch] { rms } else { rms.max(self.rms[ch] - BAR_FALL * dt) };
            if peak >= self.hold[ch] {
                self.hold[ch] = peak;
                self.hold_at[ch] = now;
            } else if now - self.hold_at[ch] > HOLD_MS {
                self.hold[ch] -= HOLD_FALL * dt;
            }
            if self.peak[ch] < FLOOR {
                self.peak[ch] = q;
            }
            if self.rms[ch] < FLOOR {
                self.rms[ch] = q;
            }
            if self.hold[ch] < FLOOR {
                self.hold[ch] = q;
            }
            if peak > self.max[ch] {
                self.max[ch] = peak;
            }
            if peak >= 0.0 {
                self.clip[ch] = true;
            }
            if self.peak[ch] > q || self.hold[ch] > q {
                busy = true;
            }
        }
        if !busy {
            self.last = None;
        }
        busy
    }

    /// The clip lights off and the readout back to -inf (a click on a light).
    pub fn reset(&mut self) {
        self.clip = [false; 2];
        self.max = [f64::NEG_INFINITY; 2];
    }

    /// [`Ballistics::frame`] for the UI frame being drawn: off screen in between, it goes on from where it was with
    /// no time passed, as the JavaScript's panel does when it comes back into view. Asks for the next frame while the
    /// meter moves.
    pub fn tick(&mut self, ctx: &egui::Context, playing: bool, heard: Option<Heard>) {
        let nr = ctx.cumulative_frame_nr();
        if self.drawn == Some(nr) {
            return;
        }
        if self.drawn.is_none_or(|d| d + 1 != nr) {
            self.last = None;
        }
        self.drawn = Some(nr);
        let now = ctx.input(|i| i.time) * 1000.0;
        if self.frame(now, playing, heard) {
            ctx.request_repaint();
        }
    }
}

/// The master's levels from the playback's meters (`masterChannels`, `masterRms`).
pub fn master(m: &cut_audio::playback::Meters) -> Heard {
    Heard { peak: m.master_channels, rms: m.master_rms }
}

/// A track's levels (`trackChannels[id]`, else `tracks[id]` in both channels, else silence).
pub fn track(m: &cut_audio::playback::Meters, id: Id) -> Heard {
    let q = f64::NEG_INFINITY;
    let peak = m
        .track_channels
        .iter()
        .find(|(t, _)| *t == id)
        .map(|(_, v)| *v)
        .or_else(|| m.tracks.iter().find(|(t, _)| *t == id).map(|(_, v)| [*v, *v]))
        .unwrap_or([q, q]);
    Heard { peak, rms: [q, q] }
}

/// A channel's readout: the highest peak to a tenth of a dB, `-∞` before any.
pub fn readout_text(max: f64) -> String {
    if max.is_finite() { format!("{max:.1}") } else { "-∞".to_owned() }
}

/// A level filling from the floor up in the colour of each zone it reaches.
fn fill(p: &egui::Painter, x: std::ops::RangeInclusive<f32>, db: f64, y_of: &dyn Fn(f64) -> f32, alpha: f32) {
    if db.is_nan() || db <= FLOOR {
        return;
    }
    for (a, b, c) in [(FLOOR, -18.0, LOW), (-18.0, -6.0, MID), (-6.0, 0.0, HIGH)] {
        if db <= a {
            break;
        }
        let (y1, y2) = (y_of(db.min(b)), y_of(a));
        p.rect_filled(Rect::from_x_y_ranges(x.clone(), y1..=y2), 0.0, c.gamma_multiply(alpha));
    }
}

fn hold_line(p: &egui::Painter, x: std::ops::RangeInclusive<f32>, db: f64, y_of: &dyn Fn(f64) -> f32, pal: &Palette) {
    if db > FLOOR {
        let y = y_of(db).round();
        p.rect_filled(Rect::from_x_y_ranges(x, y - 1.0..=y + 1.0), 0.0, if db >= 0.0 { HIGH } else { pal.gray[12] });
    }
}

/// The Audio Meters panel: the clip lights, the scale and the two bars, the highest peaks.
pub fn panel(ui: &mut egui::Ui, pal: &Palette, st: &mut Ballistics, playing: bool, heard: Option<Heard>) {
    st.tick(ui.ctx(), playing, heard);
    let area = ui.available_rect_before_wrap().shrink2(Vec2::new(4.0, 2.0));
    let w = area.width();
    let scale_w = 24f32.min((w * 0.32).max(16.0));
    let gap = 3.0;
    let bar_w = ((w - scale_w - gap * 3.0) / 2.0).max(4.0);
    let bars = [0, 1].map(|i| area.left() + scale_w + gap + i as f32 * (bar_w + gap));
    let lights = Rect::from_min_size(area.min, Vec2::new(w, 8.0));
    let readout = Rect::from_min_max(Pos2::new(area.left(), area.bottom() - 12.0), area.max);
    let canvas =
        Rect::from_min_max(Pos2::new(area.left(), lights.bottom() + 3.0), Pos2::new(area.right(), readout.top() - 3.0));
    let p = ui.painter_at(area);
    // the lights and the readouts sit in two columns right of the scale's margin, each cut to its column
    let margin = 24f32.min(w * 0.32);
    let col_w = ((w - margin - gap) / 2.0).max(1.0);
    for ch in 0..2 {
        let x = area.left() + margin + ch as f32 * (col_w + gap);
        let r = Rect::from_min_size(Pos2::new(x, lights.top()), Vec2::new(col_w, 8.0));
        let on = st.clip[ch];
        p.rect(
            r,
            CornerRadius::same(2),
            if on { HIGH } else { pal.gray[3] },
            Stroke::new(1.0, if on { HIGH } else { pal.gray[5] }),
            egui::StrokeKind::Inside,
        );
        let resp = ui
            .interact(r, ui.scope_id().with(("meter-clip", ch)), Sense::click())
            .on_hover_text(tr("Clipped: click to reset"));
        if resp.clicked() {
            st.reset();
        }
        let cell = Rect::from_x_y_ranges(x..=x + col_w, readout.y_range());
        p.with_clip_rect(cell).text(
            cell.center(),
            egui::Align2::CENTER_CENTER,
            readout_text(st.max[ch]),
            FontId::monospace(9.0),
            pal.gray[9],
        );
    }
    let (top, bottom) = (canvas.top() + 6.0, canvas.bottom() - 6.0);
    if bottom - top < 10.0 {
        return;
    }
    let y_of = |db: f64| top + ((0.0 - db.clamp(FLOOR, 0.0)) / -FLOOR) as f32 * (bottom - top);
    for db in TICKS {
        let y = y_of(db).round() + 0.5;
        p.rect_filled(
            Rect::from_x_y_ranges(canvas.left() + scale_w - 3.0..=canvas.left() + scale_w, y - 0.5..=y + 0.5),
            0.0,
            pal.gray[5],
        );
        if db % 12.0 == 0.0 || db == -6.0 {
            p.text(
                Pos2::new(canvas.left() + scale_w - 4.0, y),
                egui::Align2::RIGHT_CENTER,
                format!("{}", db.abs()),
                FontId::monospace(9.0),
                pal.gray[8],
            );
        }
    }
    for (ch, x) in bars.iter().enumerate() {
        let xs = *x..=*x + bar_w;
        p.rect_filled(Rect::from_x_y_ranges(xs.clone(), top..=bottom), 0.0, pal.gray[3]);
        fill(&p, xs.clone(), st.peak[ch], &y_of, 0.45);
        fill(&p, xs.clone(), st.rms[ch], &y_of, 1.0);
        hold_line(&p, xs, st.hold[ch], &y_of, pal);
    }
    let cy = y_of(CEILING).round() + 0.5;
    let (x0, x1) = (bars[0] - 1.0, bars[1] + bar_w + 1.0);
    let mut x = x0;
    while x < x1 {
        p.hline(x..=(x + 2.0).min(x1), cy, Stroke::new(1.0, HIGH));
        x += 4.0;
    }
}

/// A mixer strip's meter: two bars on the -60..0 scale in `r`, the peak and its hold.
pub fn strip(p: &egui::Painter, r: Rect, st: &Ballistics, pal: &Palette) {
    let bw = ((r.width() - 1.0) / 2.0).max(2.0);
    let y_of = |db: f64| r.bottom() - ((db.clamp(FLOOR, 0.0) - FLOOR) / -FLOOR) as f32 * r.height();
    for ch in 0..2 {
        let x = r.left() + ch as f32 * (bw + 1.0);
        let xs = x..=x + bw;
        p.rect_filled(Rect::from_x_y_ranges(xs.clone(), r.y_range()), 0.0, pal.gray[3]);
        fill(p, xs.clone(), st.peak[ch], &y_of, 1.0);
        hold_line(p, xs, st.hold[ch], &y_of, pal);
    }
}
