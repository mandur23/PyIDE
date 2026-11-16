//! Thumbnails and waveforms (port of `thumbs.js` and the timeline's and project panel's caches of it): strips of
//! frames of a file and the peaks of its sound, made off the UI thread and kept twice, in memory for the session and
//! in the workspace's cache ([`Cache`], the JavaScript's keys, so either editor reuses what the other made).
//!
//! Two lanes, as the JavaScript runs them, so a long file's peaks never hold back thumbnails: picture workers (each
//! with its own frame sources, closed after 10 s unused; one for every four cores, two to four, since each software
//! decoder threads across cores itself) and sound workers (one for every eight cores, one or two). The newest request
//! goes first (it is for what is on screen now) and at most 200 wait. Both lanes hold while playback runs (`pause`):
//! a picture worker between frames, a sound worker between files.
//!
//! The UI asks every frame for what it draws ([`Thumbs::strip`], [`Thumbs::peaks`]): a ready answer, or `None` while it
//! is made; a result wakes the window.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use cut_engine::color::YuvToRgb;
use cut_engine::media::{FrameSource, Got, MediaStore, Opened};
use cut_formats::probe::{key_before, sample_at_time};
use cut_model::Media;
use eframe::egui::{self, ColorImage, TextureHandle, TextureOptions};

use crate::files::cache::Cache;

/// Strips kept in memory (the timeline's `THUMB_KEEP`).
pub const KEEP: usize = 500;
/// Requests waiting at most; older ones are dropped and asked again when their clip is drawn.
const QUEUE: usize = 200;
/// Samples a peak the timeline asks for (`BASE_SPP`).
pub const SPP: usize = 256;
/// A picture worker closes a file's decoder this long after it last used it.
const IDLE: Duration = Duration::from_secs(10);

/// Peaks of a file's sound: min/max pairs over all channels, `per_sec` pairs a second.
#[derive(Debug, Clone, PartialEq)]
pub struct Peaks {
    pub data: Vec<f32>,
    pub per_sec: f64,
}

enum Slot<T> {
    Pending,
    Ready(T),
    Failed,
}

struct Strip {
    slot: Slot<Arc<[TextureHandle]>>,
    /// The frame it was last asked in.
    frame: u64,
}

/// A strip to make (`strip(project, mediaId, { from, to, count, height })`).
struct StripJob {
    key: String,
    path: String,
    /// `size|mtime` as the JavaScript prints them.
    stamp: String,
    from: f64,
    to: f64,
    count: usize,
    height: u32,
}

struct PeakJob {
    key: String,
    path: String,
    stamp: String,
    rate: f64,
}

enum Done {
    Strip(String, Vec<ColorImage>),
    Peaks(String, Option<Peaks>),
}

/// What the UI and the workers share.
struct Lanes {
    video: Mutex<Vec<StripJob>>,
    audio: Mutex<Vec<PeakJob>>,
    work: Condvar,
    paused: AtomicBool,
    quit: AtomicBool,
    cache: Option<Cache>,
    library: cut_audio::Library,
    tx: Mutex<Sender<Done>>,
    wake: Box<dyn Fn() + Send + Sync>,
}

/// The thumbnail and waveform service of the window.
pub struct Thumbs {
    ctx: egui::Context,
    lanes: Arc<Lanes>,
    rx: Receiver<Done>,
    strips: HashMap<String, Strip>,
    /// A clip's media and range -> the key of a strip of it already made (shown while another count is made).
    ready: HashMap<String, String>,
    peaks: HashMap<String, Slot<Arc<Peaks>>>,
    frame: u64,
    workers: Vec<std::thread::JoinHandle<()>>,
}

/// A JSON number as JavaScript prints it in a template string (`${m.size}`): integers without a fraction.
fn js_number(v: &serde_json::Value) -> String {
    match v.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
        Some(f) => format!("{f}"),
        None => v.to_string(),
    }
}

/// `path|size|mtime` of a media entry, the start of every cache key of its file.
pub fn file_key(m: &Media) -> String {
    format!("{}|{}|{}", m.path, js_number(&m.size), js_number(&m.mtime))
}

impl Thumbs {
    /// The service; `cache` is the workspace's cache folder (`None`: memory only).
    pub fn new(ctx: &egui::Context, cache: Option<Cache>, library: cut_audio::Library) -> Self {
        let (tx, rx) = channel();
        let c = ctx.clone();
        let lanes = Arc::new(Lanes {
            video: Mutex::new(Vec::new()),
            audio: Mutex::new(Vec::new()),
            work: Condvar::new(),
            paused: AtomicBool::new(false),
            quit: AtomicBool::new(false),
            cache,
            library,
            tx: Mutex::new(tx),
            wake: Box::new(move || c.request_repaint()),
        });
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
        let mut workers = Vec::new();
        for i in 0..(cores / 4).clamp(2, 4) {
            let l = lanes.clone();
            if let Ok(h) =
                std::thread::Builder::new().name(format!("cut thumbnails {i}")).spawn(move || video_worker(&l))
            {
                workers.push(h);
            }
        }
        for i in 0..(cores / 8).clamp(1, 2) {
            let l = lanes.clone();
            if let Ok(h) =
                std::thread::Builder::new().name(format!("cut waveforms {i}")).spawn(move || audio_worker(&l))
            {
                workers.push(h);
            }
        }
        Self {
            ctx: ctx.clone(),
            lanes,
            rx,
            strips: HashMap::new(),
            ready: HashMap::new(),
            peaks: HashMap::new(),
            frame: 0,
            workers,
        }
    }

    /// Holds both lanes (playback runs) or lets them go on.
    pub fn pause(&self, on: bool) {
        if self.lanes.paused.swap(on, Ordering::SeqCst) != on {
            self.lanes.work.notify_all();
        }
    }

    /// Requests waiting in both lanes (`queued`).
    pub fn queued(&self) -> usize {
        let v = self.lanes.video.lock().map_or(0, |q| q.len());
        v + self.lanes.audio.lock().map_or(0, |q| q.len())
    }

    /// Takes in what the workers made, and starts a frame: strips not asked for in the frames since the last trim
    /// may go (never one asked for in this frame, else a full screen would ask for its strips without end).
    pub fn begin_frame(&mut self) {
        for d in self.rx.try_iter().collect::<Vec<_>>() {
            match d {
                Done::Strip(key, images) => {
                    let Some(s) = self.strips.get_mut(&key) else { continue };
                    if images.is_empty() {
                        s.slot = Slot::Failed;
                        continue;
                    }
                    let list: Vec<TextureHandle> = images
                        .into_iter()
                        .enumerate()
                        .map(|(i, im)| self.ctx.load_texture(format!("thumb {key} {i}"), im, TextureOptions::LINEAR))
                        .collect();
                    s.slot = Slot::Ready(list.into());
                    if let Some(prefix) = key.rsplit_once("|#").map(|(p, _)| p.to_owned()) {
                        self.ready.insert(prefix, key);
                    }
                }
                Done::Peaks(key, p) => {
                    self.peaks.insert(key, p.map_or(Slot::Failed, |p| Slot::Ready(Arc::new(p))));
                }
            }
        }
        if self.strips.len() > KEEP {
            let frame = self.frame;
            let mut old: Vec<(u64, String)> =
                self.strips.iter().filter(|(_, s)| s.frame < frame).map(|(k, s)| (s.frame, k.clone())).collect();
            old.sort();
            for (_, k) in old.into_iter().take(self.strips.len() - KEEP) {
                self.strips.remove(&k);
            }
            self.ready.retain(|_, k| self.strips.contains_key(k));
        }
        self.frame += 1;
    }

    /// `count` frames of `m` evenly from source `from` to `to`, `height` pixels high (one for a still), made once
    /// per `prefix` (what the caller shows: a clip's range) and count. While it is made, a strip of the same prefix
    /// already made stands in.
    pub fn strip(
        &mut self,
        m: &Media,
        prefix: &str,
        from: f64,
        to: f64,
        count: usize,
        height: u32,
    ) -> Option<Arc<[TextureHandle]>> {
        let key = format!("{prefix}|#{count}|{height}");
        let frame = self.frame;
        match self.strips.get_mut(&key) {
            Some(s) => {
                s.frame = frame;
                if let Slot::Ready(list) = &s.slot {
                    return Some(list.clone());
                }
            }
            None => {
                self.strips.insert(key.clone(), Strip { slot: Slot::Pending, frame });
                let job = StripJob {
                    key,
                    path: m.path.clone(),
                    stamp: format!("{}|{}", js_number(&m.size), js_number(&m.mtime)),
                    from,
                    to,
                    count,
                    height,
                };
                self.queue_strip(job);
            }
        }
        let ready = self.ready.get(prefix)?;
        match &self.strips.get(ready)?.slot {
            Slot::Ready(list) => Some(list.clone()),
            _ => None,
        }
    }

    fn queue_strip(&mut self, job: StripJob) {
        let Ok(mut q) = self.lanes.video.lock() else { return };
        q.push(job);
        if q.len() > QUEUE {
            let over = q.len() - QUEUE;
            let dropped: Vec<StripJob> = q.drain(..over).collect();
            for j in dropped {
                if self.strips.get(&j.key).is_some_and(|s| matches!(s.slot, Slot::Pending)) {
                    self.strips.remove(&j.key);
                }
            }
        }
        drop(q);
        self.lanes.work.notify_all();
    }

    /// The peaks of `m`'s sound at [`SPP`] samples a peak, `None` while they are made (or when it has none).
    pub fn peaks(&mut self, m: &Media) -> Option<Arc<Peaks>> {
        let audio = m.audio.as_ref()?;
        let key = file_key(m);
        match self.peaks.get(&key) {
            Some(Slot::Ready(p)) => return Some(p.clone()),
            Some(_) => return None,
            None => {}
        }
        self.peaks.insert(key.clone(), Slot::Pending);
        let rate = if audio.rate > 0.0 { audio.rate } else { 48000.0 };
        let job = PeakJob {
            key,
            path: m.path.clone(),
            stamp: format!("{}|{}", js_number(&m.size), js_number(&m.mtime)),
            rate,
        };
        if let Ok(mut q) = self.lanes.audio.lock() {
            q.push(job);
        }
        self.lanes.work.notify_all();
        None
    }
}

impl Drop for Thumbs {
    fn drop(&mut self) {
        self.lanes.quit.store(true, Ordering::SeqCst);
        self.lanes.work.notify_all();
        for w in self.workers.drain(..) {
            let _ = w.join();
        }
    }
}

/// Waits for a job of a lane (none while paused); `None` once the service is gone. `idle` runs when the wait times out.
fn next<T>(l: &Lanes, queue: &Mutex<Vec<T>>, mut idle: impl FnMut()) -> Option<T> {
    let mut q = queue.lock().ok()?;
    loop {
        if l.quit.load(Ordering::SeqCst) {
            return None;
        }
        if !l.paused.load(Ordering::SeqCst)
            && let Some(j) = q.pop()
        {
            return Some(j);
        }
        let (g, timeout) = l.work.wait_timeout(q, Duration::from_secs(2)).ok()?;
        q = g;
        if timeout.timed_out() {
            drop(q);
            idle();
            q = queue.lock().ok()?;
        }
    }
}

fn send(l: &Lanes, d: Done) {
    if let Ok(tx) = l.tx.lock() {
        let _ = tx.send(d);
    }
    (l.wake)();
}

/// Holds between frames while playback runs (`held()`).
fn held(l: &Lanes) -> bool {
    while l.paused.load(Ordering::SeqCst) {
        if l.quit.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !l.quit.load(Ordering::SeqCst)
}

fn video_worker(l: &Lanes) {
    let mut store = MediaStore::default();
    let mut sources: HashMap<String, (FrameSource, Instant)> = HashMap::new();
    let close_idle = |s: &mut HashMap<String, (FrameSource, Instant)>| s.retain(|_, (_, at)| at.elapsed() < IDLE);
    loop {
        let Some(job) = next(l, &l.video, || {}) else { return };
        close_idle(&mut sources);
        let images = make_strip(l, &mut store, &mut sources, &job);
        send(l, Done::Strip(job.key, images));
    }
}

/// The strip's pictures (`strip`): from the cache where they are, else decoded in time order; a frame that could not
/// be made shows its neighbour's picture.
fn make_strip(
    l: &Lanes,
    store: &mut MediaStore,
    sources: &mut HashMap<String, (FrameSource, Instant)>,
    job: &StripJob,
) -> Vec<ColorImage> {
    let o = store.open(&job.path);
    if o.error.is_some() || (o.image.is_none() && o.video.is_none()) {
        return Vec::new();
    }
    let h = job.height.max(8);
    let w = ((f64::from(h) * f64::from(o.width.max(16))) / f64::from(o.height.max(9))).round().max(8.0) as u32;
    let base = format!("thumb1|{}|{}|{h}", job.path, job.stamp);
    if let Some(still) = &o.image {
        let key = format!("{base}|img");
        let im = cached(l, &key).unwrap_or_else(|| {
            let im = scale_rgba(&still.rgba, still.width, still.height, w, h);
            store_jpeg(l, &key, &im);
            im
        });
        return vec![im; job.count.max(1)];
    }
    let Some(track) = o.track() else { return Vec::new() };
    let n = job.count;
    let duration = track.duration.max(1) as f64;
    let end = job.to;
    let times: Vec<f64> = (0..n)
        .map(|i| if n == 1 { job.from } else { job.from + (end - job.from) * i as f64 / (n - 1).max(1) as f64 })
        .collect();
    // Thumbnails far apart show the sync sample before their time when it is within half the spacing.
    let spacing = if n > 1 { (end - job.from) / (n - 1) as f64 } else { 0.0 };
    let s = &track.samples;
    let samples: Vec<usize> = times
        .iter()
        .map(|&t| {
            let idx = sample_at_time(track, t.min((duration - 1.0).max(0.0)).round() as i64).unwrap_or(0);
            match key_before(track, idx as i64) {
                Some(k) if (s.pts[idx] - s.pts[k]) as f64 <= spacing / 2.0 => k,
                _ => idx,
            }
        })
        .collect();
    let mut out: Vec<Option<ColorImage>> = samples.iter().map(|i| cached(l, &format!("{base}|{i}"))).collect();
    let mut left: Vec<usize> = (0..n).filter(|&i| out[i].is_none()).collect();
    left.sort_by_key(|&i| s.pts[samples[i]]);
    let conv = match &track.media {
        cut_formats::Media::Video(v) => YuvToRgb::of(v.color_space.as_ref(), v.bit_depth.max(8)),
        cut_formats::Media::Audio(_) => YuvToRgb::of(None, 8),
    };
    for i in left {
        if !held(l) {
            break;
        }
        let src = &mut sources
            .entry(job.path.clone())
            .or_insert_with(|| (FrameSource::with_frames(o.clone(), None, Some(4)), Instant::now()));
        src.1 = Instant::now();
        if let Got::Exact(f) = src.0.wait(s.pts[samples[i]] as f64, Duration::from_secs(10)) {
            let im = frame_image(&f, conv, &o, w, h);
            store_jpeg(l, &format!("{base}|{}", samples[i]), &im);
            out[i] = Some(im);
        }
    }
    let Some(any) = out.iter().flatten().next().cloned() else { return Vec::new() };
    out.into_iter().map(|x| x.unwrap_or_else(|| any.clone())).collect()
}

fn cached(l: &Lanes, key: &str) -> Option<ColorImage> {
    let bytes = l.cache.as_ref()?.get(key)?;
    let im = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).ok()?.to_rgba8();
    Some(ColorImage::from_rgba_unmultiplied([im.width() as usize, im.height() as usize], im.as_raw()))
}

/// Keeps a thumbnail in the cache as a JPEG of quality 82, as the JavaScript encodes them.
fn store_jpeg(l: &Lanes, key: &str, im: &ColorImage) {
    let Some(cache) = &l.cache else { return };
    let rgb: Vec<u8> = im.pixels.iter().flat_map(|c| [c.r(), c.g(), c.b()]).collect();
    let mut bytes = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82);
    let ok = image::ImageEncoder::write_image(
        enc,
        &rgb,
        im.size[0] as u32,
        im.size[1] as u32,
        image::ExtendedColorType::Rgb8,
    );
    if ok.is_ok() {
        cache.put(key, &bytes);
    }
}

/// An RGBA picture scaled to `w` x `h` by averaging the source pixels under each one.
fn scale_rgba(rgba: &[u8], sw: u32, sh: u32, w: u32, h: u32) -> ColorImage {
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    let (kx, ky) = (f64::from(sw) / f64::from(w), f64::from(sh) / f64::from(h));
    for y in 0..h {
        let (y0, y1) = ((f64::from(y) * ky) as u32, ((f64::from(y + 1) * ky).ceil() as u32).clamp(1, sh));
        for x in 0..w {
            let (x0, x1) = ((f64::from(x) * kx) as u32, ((f64::from(x + 1) * kx).ceil() as u32).clamp(1, sw));
            let mut acc = [0u32; 4];
            let mut n = 0;
            for yy in y0.min(sh - 1)..y1.max(y0 + 1).min(sh) {
                for xx in x0.min(sw - 1)..x1.max(x0 + 1).min(sw) {
                    let i = ((yy * sw + xx) * 4) as usize;
                    for (c, a) in acc.iter_mut().enumerate() {
                        *a += u32::from(rgba.get(i + c).copied().unwrap_or(0));
                    }
                    n += 1;
                }
            }
            px.extend(acc.map(|v| (v / n.max(1)) as u8));
        }
    }
    ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &px)
}

/// A decoded frame as an upright `w` x `h` picture: each output pixel the mean of up to 3 x 3 coded pixels under it,
/// converted as the engine converts (`YuvToRgb`), turned by the track's rotation.
fn frame_image(f: &cut_engine::media::Frame, conv: YuvToRgb, o: &Opened, w: u32, h: u32) -> ColorImage {
    let b = f.format.sample_bytes() as usize;
    let (cw, ch) = (f.width.max(1) as usize, f.height.max(1) as usize);
    let row = cw * b;
    let max = if b == 1 { 255.0 } else { 65472.0 };
    let code = |i: usize| -> f32 {
        let v = if b == 1 {
            f32::from(f.bytes.get(i).copied().unwrap_or(0))
        } else {
            f32::from(u16::from_le_bytes([
                f.bytes.get(i).copied().unwrap_or(0),
                f.bytes.get(i + 1).copied().unwrap_or(0),
            ]))
        };
        v / max
    };
    let turned = o.rotation == 90 || o.rotation == 270;
    let (uw, uh) = if turned { (ch, cw) } else { (cw, ch) };
    // the coded pixel an upright pixel shows
    let coded = |ux: usize, uy: usize| -> (usize, usize) {
        match o.rotation {
            90 => (uy, ch - 1 - ux),
            180 => (cw - 1 - ux, ch - 1 - uy),
            270 => (cw - 1 - uy, ux),
            _ => (ux, uy),
        }
    };
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    let (kx, ky) = (uw as f64 / f64::from(w), uh as f64 / f64::from(h));
    for y in 0..h as usize {
        for x in 0..w as usize {
            let mut acc = [0f32; 3];
            for sy in 0..3 {
                for sx in 0..3 {
                    let ux = (((x as f64) + (sx as f64 + 0.5) / 3.0) * kx) as usize;
                    let uy = (((y as f64) + (sy as f64 + 0.5) / 3.0) * ky) as usize;
                    let (cx, cy) = coded(ux.min(uw - 1), uy.min(uh - 1));
                    let luma = code(cy * row + cx * b);
                    let c = ch * row + (cy / 2) * row + (cx / 2) * 2 * b;
                    let rgb = conv.rgb(luma, code(c), code(c + b));
                    for k in 0..3 {
                        acc[k] += rgb[k].clamp(0.0, 1.0);
                    }
                }
            }
            px.extend(acc.map(|v| (v / 9.0 * 255.0).round() as u8));
            px.push(255);
        }
    }
    ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &px)
}

fn audio_worker(l: &Lanes) {
    loop {
        let Some(job) = next(l, &l.audio, || {}) else { return };
        let p = make_peaks(l, &job);
        send(l, Done::Peaks(job.key, p));
    }
}

/// The peaks of a file (`peaks`): from the cache, else read about ten seconds at a time and kept there.
fn make_peaks(l: &Lanes, job: &PeakJob) -> Option<Peaks> {
    let path = Path::new(&job.path);
    let opened = l.library.open(path).ok()?;
    let track = opened.track.as_ref()?;
    let key = format!("peaks1|{}|{}|{}|{SPP}", job.path, job.stamp, track.id);
    let per_sec = job.rate / SPP as f64;
    if let Some(bytes) = l.cache.as_ref().and_then(|c| c.get(&key))
        && bytes.len() % 8 == 0
    {
        let data = bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
        return Some(Peaks { data, per_sec });
    }
    let mut reader = l.library.audio(path).ok()??;
    let data = cut_audio::analysis::peaks(&mut reader, SPP).ok()?;
    if let Some(c) = &l.cache {
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        c.put(&key, &bytes);
    }
    Some(Peaks { data, per_sec })
}
