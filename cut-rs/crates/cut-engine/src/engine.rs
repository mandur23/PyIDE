//! The engine the app and the export drive (compositor.js `create` and `render`, player.js's frame logic).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use cut_model::{Id, Project, Sequence, Source, TrackKind};
use cut_time::Ticks;

use crate::color::{YuvToRgb, hex_to_linear};
use crate::draw::{Frame, Picture, Planes, Resolved};
use crate::gpu::{Gpu, OUT};
use crate::media::{self, FrameSource, Got, MediaStore, Opened, Waker};
use crate::plan::{self, Item, ItemKind, Layer, Which, fit_scale};
use crate::raster::{Job, Raster};
use cut_decode::PixelFormat;
use cut_decode::share::{Bridge, SharedFrame};

/// How a render is drawn.
#[derive(Debug, Clone)]
pub struct RenderOptions {
    /// Playback quality: 1, 0.5 or 0.25 of the sequence's size (anything else is 1).
    pub quality: f64,
    /// Caption tracks burned in: none, the first, or those named.
    pub captions: Captions,
    /// Wait up to this long for every frame (export, tests); `None` returns at once with the best frames there are.
    pub wait: Option<Duration>,
    /// Play media through their proxy files where there are any.
    pub proxy: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self { quality: 1.0, captions: Captions::None, wait: None, proxy: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Captions {
    None,
    First,
    Tracks(Vec<Id>),
}

/// An item drawn as a red slate instead (compositor.js `failed`).
#[derive(Debug, Clone, PartialEq)]
pub struct Failed {
    pub clip: Id,
    pub name: String,
    pub media: Option<Id>,
    /// The file is not there.
    pub missing: bool,
    pub error: String,
}

/// What a render drew.
#[derive(Debug, Clone)]
pub struct Rendered {
    /// The picture, `rgba8unorm` holding sRGB values (Rec. 709 primaries), letterboxed to the size asked.
    pub texture: wgpu::Texture,
    /// Every video item showed the frame for its time. `false`: some showed the nearest frame decoded so far (or
    /// nothing yet), and the app should render again when the engine's waker calls.
    pub complete: bool,
    pub failed: Vec<Failed>,
    /// Time spent in this call.
    pub cpu: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("no sequence {0}")]
    NoSequence(Id),
    #[error("{0}")]
    Gpu(String),
}

/// What finding the pictures of a render takes and gives.
struct Fetch {
    q: f64,
    wait: Option<Duration>,
    proxy: bool,
    pictures: HashMap<String, Resolved>,
    failed: Vec<Failed>,
    complete: bool,
    /// Frames the decoders shared that this render samples (the queue waits for their copies).
    shared: Vec<SharedFrame>,
}

/// The uploaded planes of the frame a source showed last, reused while it shows the same sample; their textures are
/// written again for the next frame of the same size.
struct Upload {
    sample: usize,
    planes: Planes,
    textures: (wgpu::Texture, wgpu::Texture),
}

/// The picture engine: one per monitor or export, sharing the app's GPU device or with one of its own.
pub struct Engine {
    gpu: Gpu,
    /// The device seen by the decoders, when they can hand it their frames; else why not.
    bridge: Result<Bridge, String>,
    /// Hardware frames are shared rather than read back (false only to compare the two routes).
    share: bool,
    media: MediaStore,
    sources: HashMap<String, FrameSource>,
    uploads: HashMap<(String, usize), Upload>,
    stills: HashMap<String, wgpu::Texture>,
    /// Text clip pictures by item key, with the signature of what they show.
    texts: HashMap<String, (String, wgpu::Texture)>,
    /// Text, graphics, captions and slates are drawn on this thread; `texts` keeps the last of each.
    raster: Raster,
    out: Option<wgpu::Texture>,
    tick: u64,
    waker: Option<Waker>,
    /// The waker as the raster thread sees it (set later than the thread starts).
    raster_waker: Arc<std::sync::Mutex<Option<Waker>>>,
    /// The size of the sequence the last render showed (the scopes count its box).
    shown: Option<(f64, f64)>,
    counts: Counts,
    /// "Speaker {n}" in the screen's language: the name burned-in captions give an unnamed speaker.
    speaker_label: String,
}

/// What an engine holds, in bytes ([`Engine::memory`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Memory {
    /// Decoded frames in system memory (all engines' caches together), and in video memory (shared frames).
    pub frames_ram: u64,
    pub frames_vram: u64,
    /// The compositor's intermediate pictures kept for reuse.
    pub pooled: u64,
    /// Planes uploaded from memory frames.
    pub uploads: u64,
    /// Text, graphics, captions, slates and stills on the GPU.
    pub drawn: u64,
}

/// What [`Engine::scopes`] gives: the bins, their layout, the frame's box in the output and the step.
pub type ScopeCounts = (Vec<u32>, crate::scopes::Layout, crate::scopes::Rect, u32);

/// A render and the scope parameters it was counted with.
type CountKey = (u64, (u32, u32, u32));

/// A count submitted to the GPU and not read yet.
struct PendingCount {
    key: CountKey,
    read: wgpu::Buffer,
    ready: Arc<AtomicBool>,
    layout: crate::scopes::Layout,
    rect: crate::scopes::Rect,
    step: u32,
}

/// The scopes' counts in flight and the newest one read.
#[derive(Default)]
struct Counts {
    /// The parameters asked for last, and when.
    asked: Option<((u32, u32, u32), Instant)>,
    pending: Vec<PendingCount>,
    last: Option<(CountKey, ScopeCounts)>,
}

impl Counts {
    /// Reads the counts the GPU finished (the newest is kept).
    fn collect(&mut self) {
        let (done, wait): (Vec<PendingCount>, Vec<PendingCount>) =
            std::mem::take(&mut self.pending).into_iter().partition(|p| p.ready.load(Ordering::Acquire));
        self.pending = wait;
        for p in done {
            let Ok(data) = p.read.slice(..).get_mapped_range() else { continue };
            let bins: Vec<u32> = bytemuck::cast_slice(&data).to_vec();
            drop(data);
            p.read.unmap();
            if self.last.as_ref().is_none_or(|(k, _)| k.0 <= p.key.0) {
                self.last = Some((p.key, (bins, p.layout, p.rect, p.step)));
            }
        }
    }

    /// Whether renders should be counted as they are submitted: the scopes asked within the last second.
    fn wanted(&self) -> bool {
        self.asked.is_some_and(|(_, at)| at.elapsed() < Duration::from_secs(1))
    }
}

/// The key the burned-in captions are kept under among the drawn pictures (item keys are clip ids).
const CAPTIONS: &str = "#captions";

/// Frame sources not used by the last 120 renders, and the oldest beyond 12, close; so does any not used for 3 s
/// (compositor.js `sourcePool`).
const IDLE_RENDERS: u64 = 120;
const MAX_SOURCES: usize = 12;
const IDLE: Duration = Duration::from_secs(3);

impl Engine {
    /// An engine on the app's device (eframe's `wgpu_render_state().device/queue`).
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let bridge = Bridge::new(&device);
        let raster_waker = Arc::new(std::sync::Mutex::new(None::<Waker>));
        if let Ok(b) = &bridge {
            cut_decode::prefer_adapter(b.adapter());
        }
        Self {
            gpu: Gpu::new(device, queue),
            bridge,
            share: true,
            media: MediaStore::default(),
            sources: HashMap::new(),
            uploads: HashMap::new(),
            stills: HashMap::new(),
            texts: HashMap::new(),
            raster: Raster::new({
                let w = raster_waker.clone();
                move || {
                    if let Some(w) = w.lock().ok().and_then(|w| w.clone()) {
                        w();
                    }
                }
            }),
            raster_waker,
            out: None,
            tick: 0,
            waker: None,
            shown: None,
            counts: Counts::default(),
            speaker_label: "Speaker {n}".into(),
        }
    }

    /// The name burned-in captions give an unnamed speaker, `{n}` its place in the list ("Speaker {n}" until set).
    pub fn set_speaker_label(&mut self, unnamed: &str) {
        unnamed.clone_into(&mut self.speaker_label);
    }

    /// Loads the fonts text and captions need now (on a thread of the caller's choosing) instead of at the first
    /// text drawn.
    pub fn warm_text(&mut self) {
        self.raster.warm();
    }

    /// Makes every pipeline the renders draw with on a thread of its own ([`Gpu::warm`]).
    pub fn warm_pipelines(&self) -> std::thread::JoinHandle<()> {
        self.gpu.warm()
    }

    /// The pipelines renders had to make themselves, waiting for the compiler ([`Gpu::compiled`]).
    pub fn pipelines_compiled(&self) -> u64 {
        self.gpu.compiled()
    }

    /// An engine with a device of its own (export, tests).
    pub fn headless() -> Result<Self, EngineError> {
        let (device, queue) = Gpu::headless().map_err(EngineError::Gpu)?;
        Ok(Self::new(device, queue))
    }

    /// The GPU decoders hand their frames to on the GPU, or why they cannot (another backend, a missing feature).
    pub fn frame_sharing(&self) -> Result<&str, &str> {
        match &self.bridge {
            Ok(b) => Ok(b.adapter_name()),
            Err(e) => Err(e),
        }
    }

    /// Whether frames of hardware decoders are shared with the engine's device (the default) or read back to memory
    /// and uploaded: sources opened from now on take the new route.
    pub fn set_frame_sharing(&mut self, on: bool) {
        self.share = on;
        self.sources.clear();
        self.uploads.clear();
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.gpu.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.gpu.queue
    }

    /// Called from a decoder thread whenever a frame arrives: the app requests a repaint (`ctx.request_repaint()`).
    pub fn set_waker(&mut self, waker: impl Fn() + Send + Sync + 'static) {
        let w: Waker = Arc::new(waker);
        if let Ok(mut r) = self.raster_waker.lock() {
            *r = Some(w.clone());
        }
        self.waker = Some(w);
    }

    /// Forgets a file (after a relink or a replaced file): its sources close and the next render opens it again.
    pub fn forget(&mut self, path: &str) {
        self.media.forget(path);
        self.stills.remove(path);
        self.sources.retain(|k, _| !k.ends_with(&format!("|{path}")));
    }

    /// Draws the sequence frame at `t` into a texture of `size` (letterboxed).
    pub fn render(
        &mut self,
        project: &Project,
        seq: Id,
        t: Ticks,
        size: (u32, u32),
        opts: &RenderOptions,
    ) -> Result<Rendered, EngineError> {
        let s = project.sequence(seq).ok_or(EngineError::NoSequence(seq))?;
        self.render_sequence(project, s, t as f64, size, opts)
    }

    /// Draws one media file at its own size, `t` in source time (the source monitor).
    pub fn render_media(
        &mut self,
        project: &Project,
        media: Id,
        t: Ticks,
        size: (u32, u32),
        opts: &RenderOptions,
    ) -> Result<Rendered, EngineError> {
        let mut p = project.clone();
        let seq = media_sequence(&p, media);
        let id = seq.id;
        p.sequences.push(seq);
        let s = p.sequence(id).ok_or(EngineError::NoSequence(id))?;
        self.render_sequence(&p, s, t.max(0) as f64, size, opts)
    }

    /// Draws a sequence object (one not in the project's list too).
    pub fn render_sequence(
        &mut self,
        project: &Project,
        seq: &Sequence,
        t: f64,
        size: (u32, u32),
        opts: &RenderOptions,
    ) -> Result<Rendered, EngineError> {
        let t0 = Instant::now();
        let q = if [1.0, 0.5, 0.25].contains(&opts.quality) { opts.quality } else { 1.0 };
        let layers = plan::plan(project, seq, t, "");
        self.tick += 1;
        let mut f = Fetch {
            q,
            wait: opts.wait,
            proxy: opts.proxy,
            pictures: HashMap::new(),
            failed: Vec::new(),
            complete: true,
            shared: Vec::new(),
        };
        self.fetch(project, &layers, &mut f);
        let Fetch { pictures, failed, mut complete, shared, .. } = f;
        let which = match &opts.captions {
            Captions::None => Which::None,
            Captions::First => Which::First,
            Captions::Tracks(ids) => Which::Ids(ids),
        };
        let caps = plan::captions_at(seq, t, which, project.speakers.as_ref(), &self.speaker_label);
        let (sw, sh) = (seq.w as f64, seq.h as f64);
        let overlay = if caps.is_empty() {
            None
        } else {
            let (w, h) = (((sw * q).round().max(1.0)) as u32, ((sh * q).round().max(1.0)) as u32);
            // Kept while the same captions show the same way: drawing them is a full-size picture on the CPU. Only
            // a highlighted word changes with the time.
            let mut sig = format!("{w}x{h}|{sw}x{sh}");
            for c in &caps {
                let lit = c.style.get("highlight").and_then(serde_json::Value::as_bool) == Some(true);
                sig.push_str(&format!("|{:?}|{:?}|{:?}|{}", c.style, c.items, c.shown, if lit { c.t } else { -1.0 }));
            }
            let owned: Vec<_> = caps
                .iter()
                .map(|c| {
                    (c.style.clone(), c.t, c.items.iter().map(|&i| i.clone()).collect::<Vec<_>>(), c.shown.clone())
                })
                .collect();
            self.drawn(CAPTIONS, &sig, (w, h), opts.wait, &mut complete, move || {
                Box::new(move |text| {
                    let caps: Vec<plan::Captions<'_>> = owned
                        .iter()
                        .map(|(style, t, items, shown)| plan::Captions {
                            style,
                            t: *t,
                            items: items.iter().collect(),
                            shown: shown.clone(),
                        })
                        .collect();
                    text.captions(&caps, sw, sh, w, h)
                })
            })
        };
        let out = self.output(size.0.max(1), size.1.max(1));
        if let Ok(b) = &self.bridge {
            b.before_reads(&shared);
        }
        Frame::new(&mut self.gpu, &pictures, project.luts.as_ref(), q).encode(
            &layers,
            sw,
            sh,
            &seq.background,
            overlay,
            &out,
        );
        if let Ok(b) = &self.bridge {
            b.after_submit(&shared);
        }
        self.sweep();
        self.shown = Some((sw, sh));
        if self.counts.wanted() {
            self.count_scopes();
        }
        Ok(Rendered { texture: out, complete, failed, cpu: t0.elapsed() })
    }

    /// The picture of `key` drawn on the raster thread with signature `sig`: the one there is when it is drawn,
    /// else (asked for now) the last one drawn for `key` and the render is not complete, or with `wait` the new one
    /// once drawn.
    fn drawn(
        &mut self,
        key: &str,
        sig: &str,
        (w, h): (u32, u32),
        wait: Option<Duration>,
        complete: &mut bool,
        job: impl FnOnce() -> Job,
    ) -> Option<wgpu::Texture> {
        self.collect(None);
        if let Some((s, t)) = self.texts.get(key)
            && s == sig
        {
            return Some(t.clone());
        }
        self.raster.ask(key, sig, w, h, job);
        if let Some(d) = wait {
            self.collect(Some((key, d)));
            if let Some((s, t)) = self.texts.get(key)
                && s == sig
            {
                return Some(t.clone());
            }
        }
        *complete = false;
        self.texts.get(key).map(|(_, t)| t.clone())
    }

    /// Uploads what the raster thread finished (waiting up to a time for one key's picture).
    fn collect(&mut self, wait: Option<(&str, Duration)>) {
        for (key, sig, w, h, rgba) in self.raster.finished(wait) {
            if self.texts.len() >= 64 && !self.texts.contains_key(&key) {
                self.texts.clear();
            }
            let tex = self.upload_rgba(&rgba, w, h);
            self.texts.insert(key, (sig, tex));
        }
    }

    fn output(&mut self, w: u32, h: u32) -> wgpu::Texture {
        if let Some(o) = &self.out
            && o.width() == w
            && o.height() == h
        {
            return o.clone();
        }
        let t = self.gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cut-engine output"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OUT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        self.out = Some(t.clone());
        t
    }

    /// The RGBA8 pixels of the last render (sRGB values).
    pub fn read_pixels(&self) -> Vec<u8> {
        self.out.as_ref().map(|o| self.gpu.read_pixels(o)).unwrap_or_default()
    }

    /// The Lumetri Scopes' counts of what the last render shows (compositor.js `scopes`), counted on the GPU by the
    /// JavaScript's compute shader: the bins, their layout, the frame's box and the step. Never waits for the GPU:
    /// `None` while the last render's counts are not back yet (the waker calls when they are). Once asked, each
    /// render is counted as it is submitted for a second after the last ask, so the counts are usually back by the
    /// next call.
    pub fn scopes(&mut self, cols: u32, size: u32, budget: u32) -> Option<ScopeCounts> {
        let ask = (cols, size, budget);
        self.counts.asked = Some((ask, Instant::now()));
        let _ = self.gpu.device.poll(wgpu::PollType::Poll);
        self.counts.collect();
        let current = (self.tick, ask);
        if let Some((key, c)) = &self.counts.last
            && *key == current
        {
            return Some(c.clone());
        }
        if !self.counts.pending.iter().any(|p| p.key == current) {
            self.count_scopes();
        }
        None
    }

    /// Submits the count of the last render with the parameters asked last.
    fn count_scopes(&mut self) {
        use crate::scopes;
        use wgpu::util::DeviceExt;
        let (Some(out), Some((sw, sh)), Some(((cols, size, budget), _))) =
            (self.out.clone(), self.shown, self.counts.asked)
        else {
            return;
        };
        let l = scopes::layout(cols, size);
        let rect = scopes::frame_rect(out.width(), out.height(), sw, sh);
        let step = scopes::step_for(rect, budget);
        let bytes = u64::from(l.total) * 4;
        let dev = &self.gpu.device;
        let bins = dev.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cut-engine scopes"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let read = dev.create_buffer(&wgpu::BufferDescriptor {
            label: Some("cut-engine scopes read"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let u = dev.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("cut-engine scopes uniforms"),
            contents: bytemuck::cast_slice(&scopes::uniforms(rect, l, step)),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let pipe = self.gpu.compute_pipeline("scopes").clone();
        let dev = &self.gpu.device;
        let view = out.create_view(&Default::default());
        let bind = dev.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipe.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: bins.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: u.as_entire_binding() },
            ],
        });
        let mut enc = dev.create_command_encoder(&Default::default());
        enc.clear_buffer(&bins, 0, None);
        let (gx, gy) = scopes::dispatch(rect, step);
        if gx > 0 && gy > 0 {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipe);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(gx, gy, 1);
        }
        enc.copy_buffer_to_buffer(&bins, 0, &read, 0, bytes);
        self.gpu.queue.submit([enc.finish()]);
        let ready = Arc::new(AtomicBool::new(false));
        let (flag, waker) = (ready.clone(), self.waker.clone());
        read.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            flag.store(r.is_ok(), Ordering::Release);
            if let Some(w) = waker {
                w();
            }
        });
        let key = (self.tick, (cols, size, budget));
        self.counts.pending.push(PendingCount { key, read, ready, layout: l, rect, step });
        // a count nobody collects (the GPU fell behind) is dropped after a few
        if self.counts.pending.len() > 3 {
            self.counts.pending.remove(0);
        }
    }

    /// Starts decoding what the sequence shows between two times (the player calls it ahead of the playhead).
    pub fn prefetch(&mut self, project: &Project, seq: Id, from: Ticks, to: Ticks, proxy: bool) {
        let Some(s) = project.sequence(seq) else { return };
        let mut wants = Vec::new();
        walk(project, s, from.min(to) as f64, from.max(to) as f64, "", &mut wants);
        for (key, media, a, b) in wants {
            let Some(m) = project.media(media) else { continue };
            let o = self.media.open_media(m, proxy);
            if o.error.is_some() || o.video.is_none() {
                continue;
            }
            self.source(&key, &o).prefetch(a, b);
        }
    }

    /// How many frame sources are open, and the bytes their caches hold together.
    pub fn stats(&self) -> (usize, u64) {
        (self.sources.len(), media::cached_bytes().0)
    }

    /// What the engine holds, in bytes, by kind (for the memory budgets and the benchmarks).
    pub fn memory(&self) -> Memory {
        let (frames_ram, frames_vram) = media::cached_bytes();
        let tex = |t: &wgpu::Texture| {
            u64::from(t.width()) * u64::from(t.height()) * u64::from(t.format().block_copy_size(None).unwrap_or(4))
        };
        Memory {
            frames_ram,
            frames_vram,
            pooled: self.gpu.pooled_bytes(),
            uploads: self.uploads.values().map(|u| tex(&u.textures.0) + tex(&u.textures.1)).sum(),
            drawn: self.texts.values().map(|(_, t)| tex(t)).sum::<u64>() + self.stills.values().map(tex).sum::<u64>(),
        }
    }

    /// The open frame sources: each one's file and the decoder it took (`None` until its worker opened one).
    pub fn decoders(&self) -> Vec<(String, Option<String>)> {
        self.sources.values().map(|s| (s.path().to_string(), s.decoder())).collect()
    }

    fn source(&mut self, item_key: &str, o: &Arc<Opened>) -> &mut FrameSource {
        let key = format!("{item_key}|{}", o.path);
        let waker = self.waker.clone();
        let (bridge, share) = (self.bridge.as_ref().ok(), self.share);
        let s = self.sources.entry(key).or_insert_with(|| FrameSource::new(o.clone(), waker, bridge, share));
        s.used = self.tick;
        s.at = Instant::now();
        s
    }

    fn sweep(&mut self) {
        let now = Instant::now();
        let tick = self.tick;
        self.sources.retain(|_, s| tick - s.used <= IDLE_RENDERS && !(s.used + 1 < tick && now - s.at > IDLE));
        while self.sources.len() > MAX_SOURCES {
            let Some(k) = self.sources.iter().min_by_key(|(_, s)| s.used).map(|(k, _)| k.clone()) else { break };
            self.sources.remove(&k);
        }
        for s in self.sources.values() {
            s.set_wanted(s.used + 1 >= tick);
        }
        let live: Vec<String> = self.sources.keys().cloned().collect();
        self.uploads.retain(|(k, _), _| live.contains(k));
    }

    fn upload_rgba(&self, rgba: &[u8], w: u32, h: u32) -> wgpu::Texture {
        use wgpu::util::DeviceExt;
        self.gpu.device.create_texture_with_data(
            &self.gpu.queue,
            &wgpu::TextureDescriptor {
                label: Some("cut-engine image"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            rgba,
        )
    }

    /// The frame's planes on the GPU, written into `reuse`'s textures when they have its size (the frame before it,
    /// drawn by a submitted frame: queue order keeps that one's reads first).
    fn upload_frame(&self, f: &media::Frame, conv: YuvToRgb, reuse: Option<&Upload>) -> Upload {
        let b = f.format.sample_bytes();
        let (w, h) = (f.width.max(1), f.height.max(1));
        let (cw, ch) = ((w / 2).max(1), h.div_ceil(2));
        let (lf, cf) = if b == 1 {
            (wgpu::TextureFormat::R8Uint, wgpu::TextureFormat::Rg8Uint)
        } else {
            (wgpu::TextureFormat::R16Uint, wgpu::TextureFormat::Rg16Uint)
        };
        let make = |fw, fh, format| {
            self.gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("cut-engine plane"),
                size: wgpu::Extent3d { width: fw, height: fh, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        let (luma, chroma) = match reuse.map(|u| &u.textures) {
            Some((l, c)) if l.width() == w && l.height() == h && l.format() == lf => (l.clone(), c.clone()),
            _ => (make(w, h, lf), make(cw, ch, cf)),
        };
        let row = w * b;
        let luma_bytes = (row * h) as usize;
        let write = |tex: &wgpu::Texture, data: &[u8], tw: u32, th: u32| {
            self.gpu.queue.write_texture(
                tex.as_image_copy(),
                data,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(th) },
                wgpu::Extent3d { width: tw, height: th, depth_or_array_layers: 1 },
            );
        };
        if f.bytes.len() >= luma_bytes + (row * ch) as usize {
            write(&luma, &f.bytes[..luma_bytes], w, h);
            write(&chroma, &f.bytes[luma_bytes..luma_bytes + (row * ch) as usize], cw, ch);
        }
        let planes = Planes {
            luma: luma.create_view(&Default::default()),
            chroma: chroma.create_view(&Default::default()),
            luma_size: (w, h),
            chroma_size: (cw, ch),
            normalized: false,
            conv,
            max_code: if b == 1 { 255.0 } else { 65472.0 },
        };
        Upload { sample: f.sample, planes, textures: (luma, chroma) }
    }

    /// Finds what every item shows (compositor.js `fetchSources`): frames, stills, text, colours, error slates.
    #[allow(clippy::too_many_arguments)]
    fn fetch(&mut self, project: &Project, layers: &[Layer<'_>], f: &mut Fetch) {
        for l in layers {
            let items: Vec<&Item<'_>> = match l {
                Layer::Clip(it) => vec![it],
                Layer::Transition { a, b, .. } => a.iter().chain(b.iter()).collect(),
            };
            for it in items {
                let r = self.fetch_item(project, it, f);
                if it.kind == ItemKind::Nest {
                    self.fetch(project, &it.layers, f);
                }
                f.pictures.insert(it.key.clone(), r);
            }
        }
    }

    fn fetch_item(&mut self, project: &Project, it: &Item<'_>, f: &mut Fetch) -> Resolved {
        let (q, wait, proxy) = (f.q, f.wait, f.proxy);
        let (failed, complete, shared) = (&mut f.failed, &mut f.complete, &mut f.shared);
        let (w, h) = (it.seq_w, it.seq_h);
        let fit_mode = project.settings.get("fit").and_then(|v| v.as_str());
        let full = |picture| Resolved { picture, w, h, rotation0: 0 };
        match it.kind {
            ItemKind::Solid => {
                let color = match &it.clip.source {
                    Source::Generator { color: Some(c), .. } => c.as_str(),
                    _ => "#ffffff",
                };
                return full(Picture::Color(hex_to_linear(color, [0.0, 0.0, 0.0, 1.0])));
            }
            ItemKind::Text => {
                let (tw, th) = (((w * q).round().max(1.0)) as u32, ((h * q).round().max(1.0)) as u32);
                // kept while the clip's layers and their values at t stay the same (compositor.js `textCache`)
                let sig = format!("{tw}x{th}|{}", crate::text::signature(it));
                let (clip, local) = (it.clip.clone(), it.local);
                let tex = self.drawn(&it.key, &sig, (tw, th), wait, complete, move || {
                    Box::new(move |text| text.text_clip(&clip, local, w, h, tw, th))
                });
                return full(tex.map_or(Picture::Empty, Picture::Rgba));
            }
            ItemKind::Graphic => {
                let (tw, th) = (((w * q).round().max(1.0)) as u32, ((h * q).round().max(1.0)) as u32);
                // kept while the resolved layers stay the same (compositor.js `graphicCache`)
                let g = crate::graphic::Graphic::at(it);
                let sig = format!("{tw}x{th}|{}", g.signature());
                let tex = self
                    .drawn(&it.key, &sig, (tw, th), wait, complete, move || Box::new(move |text| g.draw(text, tw, th)));
                return full(tex.map_or(Picture::Empty, Picture::Rgba));
            }
            ItemKind::Adjustment | ItemKind::Empty => return full(Picture::Empty),
            ItemKind::Nest => {
                let n = it.sequence.expect("a nest item has its sequence");
                let fit = fit_scale(n.w as f64, n.h as f64, w, h, fit_mode);
                return Resolved { picture: Picture::Nest, w: n.w as f64 * fit, h: n.h as f64 * fit, rotation0: 0 };
            }
            ItemKind::Video | ItemKind::Image => {}
        }
        let media = it.media.expect("a media item has its media");
        let o = self.media.open_media(media, proxy);
        let fail = |engine: &mut Self,
                    failed: &mut Vec<Failed>,
                    complete: &mut bool,
                    message: &'static str,
                    missing: bool,
                    error: String| {
            failed.push(Failed { clip: it.clip.id, name: it.clip.name.clone(), media: Some(media.id), missing, error });
            let (tw, th) = (((w * q).round().max(1.0)) as u32, ((h * q).round().max(1.0)) as u32);
            let tex = engine.drawn(
                &format!("{}#slate", it.key),
                &format!("{tw}x{th}|{message}"),
                (tw, th),
                wait,
                complete,
                || Box::new(move |text| text.slate(message, tw, th)),
            );
            Resolved { picture: tex.map_or(Picture::Empty, Picture::Rgba), w, h, rotation0: 0 }
        };
        let unusable =
            (it.kind == ItemKind::Video && o.video.is_none()) || (it.kind == ItemKind::Image && o.image.is_none());
        if o.error.is_some() || unusable {
            let missing = o.error.as_ref().is_some_and(|e| e.code == "missing");
            let error = o.error.as_ref().map_or_else(|| "the file has no picture".to_string(), |e| e.detail.clone());
            let message = if missing { "Media Offline" } else { "Media Cannot Be Shown" };
            return fail(self, failed, complete, message, missing, error);
        }
        let fit = fit_scale(f64::from(o.width), f64::from(o.height), w, h, fit_mode);
        let placed = |picture| Resolved {
            picture,
            w: f64::from(o.width) * fit,
            h: f64::from(o.height) * fit,
            rotation0: o.rotation,
        };
        if let Some(still) = &o.image {
            let tex = match self.stills.get(&o.path) {
                Some(t) => t.clone(),
                None => {
                    let t = self.upload_rgba(&still.rgba, still.width, still.height);
                    self.stills.insert(o.path.clone(), t.clone());
                    t
                }
            };
            return placed(Picture::Rgba(tex));
        }
        let track = o.track().expect("checked above");
        let (cs, depth) = match &track.media {
            cut_formats::Media::Video(v) => (v.color_space, v.bit_depth),
            cut_formats::Media::Audio(_) => (None, 8),
        };
        let conv = YuvToRgb::of(cs.as_ref(), depth.max(8));
        let mut get = |engine: &mut Self, t: f64, slot: usize| -> Result<Option<(Planes, bool)>, media::MediaError> {
            let src = engine.source(&it.key, &o);
            let g = match wait {
                Some(d) => src.wait(t, d),
                None => src.frame(t),
            };
            let (f, exact) = match g {
                Got::Exact(f) => (f, true),
                Got::Near(f) => (f, false),
                Got::Nothing => return Ok(None),
                Got::Failed(e) => return Err(e),
            };
            if let Some(s) = &f.shared {
                shared.push(s.clone());
                return Ok(Some((shared_planes(s, f.width, f.height, conv), exact)));
            }
            let key = (format!("{}|{}", it.key, o.path), slot);
            if let Some(u) = engine.uploads.get(&key)
                && u.sample == f.sample
            {
                return Ok(Some((u.planes.clone(), exact)));
            }
            let up = engine.upload_frame(&f, conv, engine.uploads.get(&key));
            let planes = up.planes.clone();
            engine.uploads.insert(key, up);
            Ok(Some((planes, exact)))
        };
        let first = match get(self, it.src_t, 0) {
            Ok(Some(p)) => p,
            Ok(None) => {
                *complete = false;
                return placed(Picture::Empty);
            }
            Err(e) => return fail(self, failed, complete, "Media Cannot Be Shown", false, e.detail),
        };
        if !first.1 {
            *complete = false;
        }
        let second = match it.blend {
            Some(b) => match get(self, b.src_t, 1) {
                Ok(Some((p, exact))) => {
                    if !exact {
                        *complete = false;
                    }
                    Some((p, b.w))
                }
                _ => None,
            },
            None => None,
        };
        placed(Picture::Frame { planes: first.0, second })
    }
}

/// The planes of a frame the decoder shared: views of its NV12 or P010 texture, read as normalized values.
fn shared_planes(s: &SharedFrame, w: u32, h: u32, conv: YuvToRgb) -> Planes {
    let (lf, cf, max_code) = match s.format() {
        PixelFormat::Nv12 => (wgpu::TextureFormat::R8Unorm, wgpu::TextureFormat::Rg8Unorm, 255.0),
        PixelFormat::P010 => (wgpu::TextureFormat::R16Unorm, wgpu::TextureFormat::Rg16Unorm, 65472.0),
    };
    let view = |format, aspect| {
        s.texture().create_view(&wgpu::TextureViewDescriptor {
            label: Some("cut-engine shared plane"),
            format: Some(format),
            aspect,
            ..Default::default()
        })
    };
    let (w, h) = (w.max(1), h.max(1));
    Planes {
        luma: view(lf, wgpu::TextureAspect::Plane0),
        chroma: view(cf, wgpu::TextureAspect::Plane1),
        luma_size: (w, h),
        chroma_size: ((w / 2).max(1), h.div_ceil(2)),
        normalized: true,
        conv,
        max_code,
    }
}

/// The clips a sequence shows over `[a, b]` with the source span each needs, nests followed (compositor.js
/// `prefetch`): `(item key, media, from, to)`.
fn walk(project: &Project, s: &Sequence, a: f64, b: f64, scope: &str, out: &mut Vec<(String, Id, f64, f64)>) {
    for track in s.tracks.iter().filter(|t| t.kind == TrackKind::Video && t.visible != Some(false)) {
        for c in track.clips.iter().filter(|c| c.enabled && !c.is_freeze()) {
            let end = c.end() as f64;
            if end <= a || c.start as f64 > b {
                continue;
            }
            let (s0, s1) = c.source_span(a.max(c.start as f64), (b + 1.0).min(end));
            if let Some(inner) = project.nest_of(c) {
                walk(project, inner, s0, s1, &format!("{scope}{}/", c.id), out);
                continue;
            }
            if let Some(m) = c.media_id() {
                out.push((format!("{scope}{}", c.id), m, s0, s1));
            }
        }
    }
}

/// A sequence that shows one media file at its own size, for the source monitor (compositor.js `mediaSequence`).
pub fn media_sequence(project: &Project, media: Id) -> Sequence {
    use cut_model::defaults;
    let m = project.media(media);
    let w = m.and_then(|m| m.video.as_ref()).map_or(1920.0, |v| v.w) as i64;
    let h = m.and_then(|m| m.video.as_ref()).map_or(1080.0, |v| v.h) as i64;
    let fps = m
        .and_then(|m| m.video.as_ref())
        .and_then(|v| v.extra.get("fps")?.as_array().cloned())
        .and_then(|a| Some(cut_time::Fps::new(a.first()?.as_u64()? as u32, a.get(1)?.as_u64()? as u32)))
        .unwrap_or(cut_time::Fps::new(30, 1));
    let id = Id::new("__source");
    let v1 = Id::new("V1");
    let tracks = vec![defaults::track(TrackKind::Video, v1, Some("V1"))];
    let mut seq = Sequence::new(id, "Source".into(), w, h, fps, "#000000".into(), tracks);
    if let Some(m) = m
        && (m.video.is_some() || m.kind == cut_model::MediaKind::Image)
    {
        let out = m.duration.max((cut_time::TICKS * 3600) as f64);
        let clip = defaults::clip(
            TrackKind::Video,
            Id::new(&format!("__source:{media}")),
            v1,
            0,
            0.0,
            out,
            Source::Media { media, freeze: false, extra: Default::default() },
            m.name.clone(),
        );
        seq.insert_clip(clip, None);
    }
    seq
}
