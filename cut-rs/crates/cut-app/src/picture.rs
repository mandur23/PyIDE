//! The monitors' pictures (ui-monitors.js through player.js and the compositor): one `cut-engine` [`Engine`] per
//! monitor on the window's own wgpu device, its output texture shown through egui-wgpu as a native texture.
//!
//! A monitor asks for a [`Want`] (the sequence at a time, or a media file at a source time) at its pixel size every
//! frame; the engine draws only when that changed or when the last picture was not complete (a frame still decoding:
//! the engine showed the nearest one and its waker repaints the window when the right one arrives). The engine never
//! waits for a decoder, so the UI thread never does either.
//!
//! The engine's texture is `rgba8unorm` holding sRGB-encoded values, which is what egui's shader expects of a texture
//! ("gamma" values, not sRGB-aware) when it draws to its non-sRGB target: the values reach the screen unchanged.

use cut_engine::{Captions, Engine, RenderOptions};
use cut_model::{Id, Project};
use cut_time::Ticks;
use eframe::egui::{self, TextureId};
use eframe::egui_wgpu::{self, wgpu};

use crate::panels::monitor::Picture;

/// What a monitor shows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Want {
    /// The program monitor: a sequence at a sequence time.
    Sequence { seq: Id, t: Ticks },
    /// The source monitor: a media file at a source time.
    Media { media: Id, t: Ticks },
}

/// The request a picture was drawn for: the project's revision, what, the size in pixels, the caption track, and
/// whether proxies played at what quality.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Key {
    revision: u64,
    want: Want,
    size: (u32, u32),
    captions: Option<Id>,
    proxy: bool,
    quality: f64,
}

/// Numbers about a monitor's renders, for the status line, the tests and the report.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RenderStats {
    pub renders: u64,
    /// Renders that showed the nearest frame decoded so far instead of the right one.
    pub incomplete: u64,
    pub last_ms: f64,
    pub max_ms: f64,
    /// Whether the picture on screen is the exact one for what was asked last.
    pub complete: bool,
    /// Items the last render showed as a slate (offline or undecodable media).
    pub failed: usize,
}

/// One monitor: its engine and the egui texture its output is registered as.
pub struct Screen {
    pub engine: Engine,
    texture: Option<(TextureId, wgpu::Texture)>,
    shown: Option<Key>,
    pub stats: RenderStats,
    /// Where the monitor drew the picture last (points).
    pub rect: egui::Rect,
}

impl Screen {
    fn new(rs: &egui_wgpu::RenderState, ctx: &egui::Context) -> Self {
        let mut engine = Engine::new(rs.device.clone(), rs.queue.clone());
        let ctx = ctx.clone();
        engine.set_waker(move || ctx.request_repaint());
        Self { engine, texture: None, shown: None, stats: RenderStats::default(), rect: egui::Rect::NOTHING }
    }

    /// The picture for `want` at `size` pixels, drawn now when it is not on screen yet (or was not complete).
    fn show(
        &mut self,
        rs: &egui_wgpu::RenderState,
        project: &Project,
        revision: u64,
        want: Want,
        size: (u32, u32),
        opts: &RenderOptions,
    ) -> Option<Picture> {
        let size = (size.0.max(1), size.1.max(1));
        let captions = match &opts.captions {
            Captions::Tracks(list) => list.first().copied(),
            _ => None,
        };
        let key = Key { revision, want, size, captions, proxy: opts.proxy, quality: opts.quality };
        if self.shown != Some(key) || !self.stats.complete {
            self.engine.set_speaker_label(&crate::i18n::tr("Speaker {n}"));
            let r = match want {
                Want::Sequence { seq, t } => self.engine.render(project, seq, t, size, opts),
                Want::Media { media, t } => self.engine.render_media(project, media, t, size, opts),
            };
            match r {
                Ok(r) => {
                    let ms = r.cpu.as_secs_f64() * 1000.0;
                    let s = &mut self.stats;
                    s.renders += 1;
                    s.incomplete += u64::from(!r.complete);
                    s.last_ms = ms;
                    s.max_ms = s.max_ms.max(ms);
                    s.complete = r.complete;
                    s.failed = r.failed.len();
                    self.register(rs, &r.texture);
                    self.shown = Some(key);
                }
                Err(_) => {
                    self.shown = None;
                    return None;
                }
            }
        }
        let (id, tex) = self.texture.as_ref()?;
        Some(Picture { texture: *id, size: egui::vec2(tex.width() as f32, tex.height() as f32) })
    }

    /// Registers the engine's output with egui the first time, and again when the engine made a new one (a resize).
    fn register(&mut self, rs: &egui_wgpu::RenderState, out: &wgpu::Texture) {
        if self.texture.as_ref().is_some_and(|(_, t)| t == out) {
            return;
        }
        let view = out.create_view(&wgpu::TextureViewDescriptor::default());
        let mut renderer = rs.renderer.write();
        match &self.texture {
            Some((id, _)) => {
                renderer.update_egui_texture_from_wgpu_texture(&rs.device, &view, wgpu::FilterMode::Linear, *id);
                let id = *id;
                self.texture = Some((id, out.clone()));
            }
            None => {
                let id = renderer.register_native_texture(&rs.device, &view, wgpu::FilterMode::Linear);
                self.texture = Some((id, out.clone()));
            }
        }
    }

    /// The RGBA8 pixels (sRGB values) of the last picture.
    pub fn pixels(&self) -> Option<(u32, u32, Vec<u8>)> {
        let (_, t) = self.texture.as_ref()?;
        Some((t.width(), t.height(), self.engine.read_pixels()))
    }
}

/// Both monitors on the window's device.
pub struct Monitors {
    rs: egui_wgpu::RenderState,
    pub program: Screen,
    pub source: Screen,
    /// The monitors play proxies (the setting `proxy`, the Program monitor's Proxy switch).
    pub proxy: bool,
    /// The playback quality now (the setting `quality` while playing, else 1).
    pub quality: f64,
    /// The Program monitor's trim view: two engines of their own, made the first time it shows.
    pub trim_screens: Option<[Screen; 2]>,
    /// What the source monitor's decode-ahead was last set for, and where.
    source_ahead: Option<(SourceWant, Ticks)>,
}

/// What the source monitor plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceWant {
    Media(Id),
    Sequence(Id),
}

/// The program monitor's prefetch reaches this far ahead of the playhead (player.js: two seconds at the rate).
pub const PREFETCH: Ticks = 2 * cut_time::TICKS;

impl Monitors {
    pub fn new(rs: egui_wgpu::RenderState, ctx: &egui::Context) -> Self {
        let mut program = Screen::new(&rs, ctx);
        let mut source = Screen::new(&rs, ctx);
        program.engine.warm_text();
        source.engine.warm_text();
        // the source monitor plays a file without effects: its few pipelines are made at its first picture
        let _ = program.engine.warm_pipelines();
        Self { rs, program, source, proxy: false, quality: 1.0, trim_screens: None, source_ahead: None }
    }

    /// The trim view's two pictures (`showTrim`): the sequence at `times` (left, right) a quarter of its size, at
    /// quarter quality; `None` where there is no time (before the first frame) or no picture yet.
    pub fn trim(
        &mut self,
        ctx: &egui::Context,
        project: &Project,
        revision: u64,
        seq: &cut_model::Sequence,
        times: [Option<Ticks>; 2],
    ) -> [Option<Picture>; 2] {
        let rs = &self.rs;
        let screens = self.trim_screens.get_or_insert_with(|| [Screen::new(rs, ctx), Screen::new(rs, ctx)]);
        let size = (((seq.w as f64) / 4.0).round().max(2.0) as u32, ((seq.h as f64) / 4.0).round().max(2.0) as u32);
        let opts = RenderOptions { quality: 0.25, proxy: self.proxy, ..RenderOptions::default() };
        let mut out = [None, None];
        for (i, (screen, t)) in screens.iter_mut().zip(times).enumerate() {
            if let Some(t) = t {
                out[i] = screen.show(rs, project, revision, Want::Sequence { seq: seq.id, t }, size, &opts);
            }
        }
        out
    }

    /// The monitors made on a thread of their own (loading the fonts takes a while), handed over when ready.
    pub fn spawn(rs: egui_wgpu::RenderState, ctx: &egui::Context) -> std::sync::mpsc::Receiver<Self> {
        let (tx, rx) = std::sync::mpsc::channel();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Self::new(rs, &ctx));
            ctx.request_repaint();
        });
        rx
    }

    /// The program monitor's picture of `seq` at `t` with the caption track `captions` drawn on top (the one the
    /// Captions panel shows).
    pub fn program(
        &mut self,
        project: &Project,
        revision: u64,
        seq: Id,
        t: Ticks,
        size: (u32, u32),
        captions: Option<Id>,
    ) -> Option<Picture> {
        let captions = captions.map_or(Captions::None, |id| Captions::Tracks(vec![id]));
        let opts = RenderOptions { captions, proxy: self.proxy, quality: self.quality, ..RenderOptions::default() };
        self.program.show(&self.rs, project, revision, Want::Sequence { seq, t }, size, &opts)
    }

    /// `want` drawn whole at `size` on an engine of its own and read back as RGBA rows (the Source monitor's Export
    /// Frame): the monitors' own pictures and caches stay as they are.
    pub fn still(&self, project: &Project, want: Want, size: (u32, u32)) -> Result<Vec<u8>, String> {
        let mut engine = Engine::new(self.rs.device.clone(), self.rs.queue.clone());
        let opts = RenderOptions { wait: Some(std::time::Duration::from_secs(10)), ..RenderOptions::default() };
        let r = match want {
            Want::Sequence { seq, t } => engine.render(project, seq, t, size, &opts),
            Want::Media { media, t } => engine.render_media(project, media, t, size, &opts),
        };
        r.map(|_| engine.read_pixels()).map_err(|e| e.to_string())
    }

    /// As [`Monitors::still`] for a sequence, with the caption track `captions` burned in (the control API's frame).
    pub fn still_captioned(
        &self,
        project: &Project,
        seq: Id,
        t: Ticks,
        size: (u32, u32),
        captions: Option<Id>,
    ) -> Result<Vec<u8>, String> {
        let mut engine = Engine::new(self.rs.device.clone(), self.rs.queue.clone());
        let captions = captions.map_or(Captions::None, |id| Captions::Tracks(vec![id]));
        let opts =
            RenderOptions { captions, wait: Some(std::time::Duration::from_secs(10)), ..RenderOptions::default() };
        engine.render(project, seq, t, size, &opts).map(|_| engine.read_pixels()).map_err(|e| e.to_string())
    }

    /// The source monitor's picture of `media` at source time `t`.
    pub fn source(
        &mut self,
        project: &Project,
        revision: u64,
        media: Id,
        t: Ticks,
        size: (u32, u32),
    ) -> Option<Picture> {
        let opts = RenderOptions { proxy: self.proxy, quality: self.quality, ..RenderOptions::default() };
        self.source.show(&self.rs, project, revision, Want::Media { media, t }, size, &opts)
    }

    /// The source monitor's picture of a sequence opened there, at its own time.
    pub fn source_sequence(
        &mut self,
        project: &Project,
        revision: u64,
        seq: Id,
        t: Ticks,
        size: (u32, u32),
    ) -> Option<Picture> {
        let opts = RenderOptions { proxy: self.proxy, quality: self.quality, ..RenderOptions::default() };
        self.source.show(&self.rs, project, revision, Want::Sequence { seq, t }, size, &opts)
    }

    /// Starts decoding what the source monitor will show from `t` on while it plays a media file or a sequence, in
    /// the direction of `rate`. Asked every frame, it is passed on twice a second of the clip's time, as the program's.
    pub fn prefetch_source(&mut self, project: &Project, item: SourceWant, t: Ticks, rate: f64) {
        if self.source_ahead.is_some_and(|(i, at)| i == item && (t - at).abs() <= cut_time::TICKS / 2) {
            return;
        }
        self.source_ahead = Some((item, t));
        let reach = (PREFETCH as f64 * rate.signum() * rate.abs().max(1.0)) as Ticks;
        match item {
            SourceWant::Media(media) => self.source.engine.prefetch_media(project, media, t, t + reach, self.proxy),
            SourceWant::Sequence(seq) => self.source.engine.prefetch(project, seq, t, t + reach, self.proxy),
        }
    }

    /// Starts decoding what the program monitor will show from `t` on, in the direction of `rate`.
    pub fn prefetch(&mut self, project: &Project, seq: Id, t: Ticks, rate: f64) {
        let reach = (PREFETCH as f64 * rate.signum() * rate.abs().max(1.0)) as Ticks;
        self.program.engine.prefetch(project, seq, t, t + reach, self.proxy);
    }

    /// Waits for the GPU to finish what was submitted (tests reading pixels).
    pub fn settle(&self) {
        let _ = self.rs.device.poll(wgpu::PollType::wait_indefinitely());
    }
}
