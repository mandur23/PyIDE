//! The Lumetri Scopes panel (port of `ui-scopes.js`): the luma waveform, the RGB parade, the YUV vectorscope (75%
//! and 100% colour bar targets, the skin tone line) and the RGB histogram of what the Program monitor shows.
//!
//! The counts are the program engine's (`Engine::scopes`: the JavaScript's compute shader over the engine's output
//! texture, read back). The panel counts again after the monitor drew a new picture, at most every 40 ms while
//! stopped and every 150 ms while playing (a quarter of the pixels then), and only while it is on screen (the
//! workspace draws only the tab shown). The pictures are made from the counts on a worker thread ([`image`]); the
//! UI thread uploads them and draws the graticules ([`view`]). The scopes shown are kept in the setting
//! `scopes.show`.

mod image;
mod view;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use cut_engine::scopes::{self as S, BUDGET, Layout, Rect};
use cut_time::Ticks;
use eframe::egui::{self, Color32, TextureHandle, TextureOptions};
use serde_json::{Value as Json, json};

use crate::i18n::tr;
use crate::shell::Shell;

/// Columns of the waveform and the parade, and the vectorscope's side, in bins.
const COLS: u32 = 256;
const SIZE: u32 = 256;
/// The vectorscope's half width in Cb and Cr (`scopes.js`'s RANGE: `K / UNIT`).
pub const RANGE: f64 = S::K as f64 / S::UNIT as f64;
/// The skin tone line, degrees counterclockwise from +Cb.
const SKIN_DEGREES: f64 = 123.0;
/// The scopes' background.
const BG: Color32 = Color32::from_rgb(0x0b, 0x0c, 0x0e);
/// The setting of the scopes shown (`cut.scopes.show`).
const SHOW: &str = "scopes.show";

/// One of the scopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Wave,
    Parade,
    Vector,
    Hist,
}

impl Kind {
    /// The toolbar's order, Premiere's menu order.
    pub const ALL: [Kind; 4] = [Kind::Wave, Kind::Parade, Kind::Vector, Kind::Hist];

    pub fn id(self) -> &'static str {
        match self {
            Kind::Wave => "wave",
            Kind::Parade => "parade",
            Kind::Vector => "vector",
            Kind::Hist => "hist",
        }
    }

    /// The English name (the key of its translation).
    pub fn name(self) -> &'static str {
        match self {
            Kind::Wave => "Waveform (Luma)",
            Kind::Parade => "RGB Parade",
            Kind::Vector => "Vectorscope YUV",
            Kind::Hist => "Histogram",
        }
    }
}

/// One count of the program monitor's picture.
#[derive(Debug, Clone)]
pub struct Counted {
    /// The bins of every scope (`cut_engine::scopes::layout`).
    pub bins: Arc<Vec<u32>>,
    pub layout: Layout,
    /// The frame's box in the monitor's output and the step between counted pixels.
    pub rect: Rect,
    pub step: u32,
    /// The playhead of the picture counted.
    pub t: Ticks,
    /// Whether it was counted while playing (a quarter of the pixels).
    pub playing: bool,
    /// What the count cost the UI thread (the compute pass and the read-back's wait).
    pub cost: Duration,
}

/// The pictures' worker and the textures of its last pictures.
struct Painter {
    jobs: Sender<image::Job>,
    done: Receiver<image::Images>,
    textures: HashMap<Kind, Vec<TextureHandle>>,
}

/// The panel's state between frames.
#[derive(Default)]
pub struct State {
    show: Option<Vec<Kind>>,
    /// The last count.
    pub last: Option<Counted>,
    /// How many counts were made.
    pub count: u64,
    /// The program monitor's render count at the last count.
    renders: Option<u64>,
    last_at: Option<Instant>,
    /// The playhead and the project revision the last frame saw.
    seen: Option<(Ticks, u64)>,
    /// Count now whatever the gap (a scope was turned on).
    now: bool,
    painter: Option<Painter>,
}

impl State {
    /// The scopes shown, in the toolbar's order.
    fn shown(&self) -> Vec<Kind> {
        self.show.clone().unwrap_or_default()
    }
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("State").field("show", &self.show).field("count", &self.count).finish_non_exhaustive()
    }
}

fn read_show(s: &Shell) -> Vec<Kind> {
    let ids: Vec<String> = s.doc.settings.get(SHOW).and_then(Json::as_array).map_or_else(
        || vec!["wave".into(), "vector".into()],
        |a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
    );
    Kind::ALL.into_iter().filter(|k| ids.iter().any(|i| i == k.id())).collect()
}

/// Counts the program monitor's last picture when it is new and the gap since the last count has passed.
fn count(s: &mut Shell, ctx: &egui::Context) {
    let playing = s.transport.playing();
    let t = s.app.t;
    let revision = s.app.history.revision();
    let st = &mut s.features.fx.scopes;
    let seen = st.seen.replace((t, revision));
    let Some(m) = s.monitors.as_mut() else { return };
    // the monitor draws after this panel: a new time or edit is counted on the frame after it was drawn
    if seen != Some((t, revision)) {
        ctx.request_repaint();
    }
    let renders = m.program.stats.renders;
    let paused_after_play = !playing && st.last.as_ref().is_some_and(|c| c.playing);
    if renders == 0 || (st.renders == Some(renders) && !paused_after_play && !st.now) {
        return;
    }
    let gap = Duration::from_millis(if playing { 150 } else { 40 });
    if let Some(at) = st.last_at
        && !st.now
        && at.elapsed() < gap
    {
        ctx.request_repaint_after(gap - at.elapsed());
        return;
    }
    let picture_t = seen.map_or(t, |x| x.0);
    let started = Instant::now();
    let Some((bins, layout, rect, step)) =
        m.program.engine.scopes(COLS, SIZE, if playing { BUDGET / 4 } else { BUDGET })
    else {
        return;
    };
    let cost = started.elapsed();
    st.now = false;
    st.renders = Some(renders);
    st.last_at = Some(started);
    st.count += 1;
    let counted = Counted { bins: Arc::new(bins), layout, rect, step, t: picture_t, playing, cost };
    let painter = st.painter.get_or_insert_with(|| {
        let (jobs, done) = image::spawn(ctx.clone(), BG);
        Painter { jobs, done, textures: HashMap::new() }
    });
    let full_wave = (f64::from(rect.y1.saturating_sub(rect.y0)) / f64::from(step)).ceil().max(1.0);
    let area = f64::from(rect.x1.saturating_sub(rect.x0)) * f64::from(rect.y1.saturating_sub(rect.y0));
    let _ = painter.jobs.send(image::Job {
        bins: counted.bins.clone(),
        layout,
        full_wave,
        full_vector: (area / f64::from(step * step) / 64.0).max(4.0),
        kinds: st.show.clone().unwrap_or_default(),
    });
    st.last = Some(counted);
}

/// Uploads the worker's newest pictures.
fn upload(st: &mut State, ctx: &egui::Context) {
    let Some(p) = &mut st.painter else { return };
    let Some(images) = p.done.try_iter().last() else { return };
    for (kind, list) in images {
        let handles = p.textures.entry(kind).or_default();
        for (i, img) in list.into_iter().enumerate() {
            match handles.get_mut(i) {
                Some(h) => h.set(img, TextureOptions::LINEAR),
                None => handles.push(ctx.load_texture(format!("scope-{}-{i}", kind.id()), img, TextureOptions::LINEAR)),
            }
        }
    }
}

/// The panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    if s.features.fx.scopes.show.is_none() {
        s.features.fx.scopes.show = Some(read_show(s));
    }
    let pal = s.palette.clone();
    let mut toggled = None;
    ui.horizontal_wrapped(|ui| {
        let show = s.features.fx.scopes.shown();
        for k in Kind::ALL {
            if ui.selectable_label(show.contains(&k), tr(k.name())).clicked() {
                toggled = Some(k);
            }
        }
    });
    if let Some(k) = toggled {
        let show = s.features.fx.scopes.shown();
        let next: Vec<Kind> = Kind::ALL.into_iter().filter(|x| (*x == k) != show.contains(x)).collect();
        let ids: Vec<&str> = next.iter().map(|k| k.id()).collect();
        s.doc.settings.set(SHOW, json!(ids));
        let _ = s.doc.settings.save();
        let st = &mut s.features.fx.scopes;
        st.show = Some(next);
        st.now = true;
    }
    let ctx = ui.ctx().clone();
    if !s.features.fx.scopes.shown().is_empty() {
        count(s, &ctx);
    }
    let st = &mut s.features.fx.scopes;
    upload(st, &ctx);
    let area = ui.available_rect_before_wrap();
    ui.allocate_rect(area, egui::Sense::hover());
    let shown = st.shown();
    let textures = st.painter.as_ref().map(|p| &p.textures);
    match (&st.last, textures) {
        (Some(_), Some(tex)) => view::grid(ui, area, &shown, tex),
        _ => {
            ui.painter().text(
                area.center(),
                egui::Align2::CENTER_CENTER,
                tr("The scopes show the program monitor’s picture."),
                egui::FontId::proportional(12.0),
                pal.gray[8],
            );
        }
    }
}
