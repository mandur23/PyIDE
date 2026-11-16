//! Media files and their frames (media.js `open`, decoder.js `createFrameSource`): a file probed once per path, its
//! still image decoded once, and per clip on screen a frame source whose decoder lives on a worker thread of its own
//! (decoders are not `Send`). Frames come back as NV12 or P010 bytes in memory, kept in a cache with the JavaScript's
//! limits and eviction order; asking for a frame never waits (the render shows the nearest frame it has and says a
//! better one is coming), except through [`FrameSource::wait`] for export and tests.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use cut_decode::share::{Bridge, SharedFrame};
use cut_decode::{Accel, PixelFormat};
use cut_formats::probe::sample_at_time;
use cut_formats::{FileReader, Kind, Media as TrackMedia, Source, Track, probe};

/// Why a file cannot be shown (media.js `error.code`): `missing`, `unsupported`, `damaged`, `hdr`, `noTracks`, `io`,
/// `decode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaError {
    pub code: &'static str,
    pub detail: String,
}

/// A decoded still (RGBA8, not premultiplied).
#[derive(Debug)]
pub struct Still {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// One opened file (media.js `open`'s result).
pub struct Opened {
    pub path: String,
    pub reader: Option<Arc<FileReader>>,
    pub source: Option<Arc<Source>>,
    /// Index of the video track in `source.tracks`.
    pub video: Option<usize>,
    pub image: Option<Arc<Still>>,
    /// The size the picture is shown at (pixel aspect and rotation applied).
    pub width: u32,
    pub height: u32,
    /// Clockwise degrees the frames need to be upright.
    pub rotation: u32,
    pub error: Option<MediaError>,
}

impl Opened {
    pub fn track(&self) -> Option<&Track> {
        Some(&self.source.as_ref()?.tracks[self.video?])
    }
}

/// The upright size a video track is shown at: the display size turned by its rotation.
pub fn shown_size(v: &cut_formats::Video) -> (u32, u32) {
    let (w, h) = (v.display_width.max(1), v.display_height.max(1));
    if v.rotation == 90 || v.rotation == 270 { (h, w) } else { (w, h) }
}

fn open_path(path: &str) -> Opened {
    let fail = |code: &'static str, detail: String| Opened {
        path: path.to_string(),
        reader: None,
        source: None,
        video: None,
        image: None,
        width: 0,
        height: 0,
        rotation: 0,
        error: Some(MediaError { code, detail }),
    };
    if !Path::new(path).exists() {
        return fail("missing", format!("{path} is not there"));
    }
    let reader = match FileReader::open(path) {
        Ok(r) => Arc::new(r),
        Err(e) => return fail("io", e.to_string()),
    };
    let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let source = probe::open(&*reader, name);
    if let Some(e) = &source.error {
        let code = match e.code {
            cut_formats::ErrorCode::Unsupported => "unsupported",
            cut_formats::ErrorCode::Damaged => "damaged",
            cut_formats::ErrorCode::Hdr => "hdr",
            cut_formats::ErrorCode::NoTracks => "noTracks",
        };
        return fail(code, e.to_string());
    }
    if let Some(img) = &source.image {
        let still = std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| {
            let i = image::load_from_memory(&b).map_err(|e| e.to_string())?.to_rgba8();
            Ok(Still { width: i.width(), height: i.height(), rgba: i.into_raw() })
        });
        return match still {
            Ok(s) => Opened {
                path: path.to_string(),
                reader: Some(reader),
                width: img.width.max(s.width),
                height: img.height.max(s.height),
                image: Some(Arc::new(s)),
                source: Some(Arc::new(source)),
                video: None,
                rotation: 0,
                error: None,
            },
            Err(e) => fail("unsupported", format!("{} cannot be decoded here: {e}", img.mime)),
        };
    }
    let video = source.tracks.iter().position(|t| t.kind() == Kind::Video);
    let (mut width, mut height, mut rotation) = (0, 0, 0);
    if let Some(TrackMedia::Video(v)) = video.map(|i| &source.tracks[i].media) {
        (width, height) = shown_size(v);
        rotation = v.rotation;
    }
    Opened {
        path: path.to_string(),
        reader: Some(reader),
        source: Some(Arc::new(source)),
        video,
        image: None,
        width,
        height,
        rotation,
        error: None,
    }
}

/// The files of the open projects, opened once per path.
#[derive(Default)]
pub struct MediaStore {
    files: HashMap<String, (Arc<Opened>, Instant)>,
}

/// A file that could not be opened is tried again after this long (media.js checks a proxy every 2 s).
const RETRY: Duration = Duration::from_secs(2);

impl MediaStore {
    /// The opened file at `path` (probed the first time; one that failed, again after 2 s).
    pub fn open(&mut self, path: &str) -> Arc<Opened> {
        if let Some((o, at)) = self.files.get(path)
            && (o.error.is_none() || at.elapsed() < RETRY)
        {
            return o.clone();
        }
        let o = Arc::new(open_path(path));
        self.files.insert(path.to_string(), (o.clone(), Instant::now()));
        o
    }

    /// The file a clip of `media` plays: its proxy when `proxy` is asked and the proxy opens, else the original
    /// (media.js `open(project, id, { proxy })`).
    pub fn open_media(&mut self, media: &cut_model::Media, proxy: bool) -> Arc<Opened> {
        if proxy && let Some(p) = &media.proxy {
            let o = self.open(&p.path);
            if o.error.is_none() {
                return o;
            }
        }
        self.open(&media.path)
    }

    /// Forgets a file (after a relink or a replaced file): the next open probes it again.
    pub fn forget(&mut self, path: &str) {
        self.files.remove(path);
    }
}

// ---- frames ----

/// A decoded picture: in system memory, or in a texture of the engine's device the decoder shared.
pub struct Frame {
    /// The sample it shows (decode order index) and its presentation time.
    pub sample: usize,
    pub pts: i64,
    pub width: u32,
    pub height: u32,
    pub format: PixelFormat,
    /// Luma rows of `width * sample_bytes`, then `ceil(height / 2)` chroma rows of the same length; empty for a
    /// shared frame.
    pub bytes: Vec<u8>,
    /// The picture on the GPU, when the decoder copied it into the engine's device.
    pub shared: Option<SharedFrame>,
}

impl Frame {
    /// What the frame takes: bytes of system memory, or of video memory for a shared frame.
    fn cost(&self) -> (u64, bool) {
        match &self.shared {
            Some(s) => (s.bytes(), true),
            None => (self.bytes.len() as u64, false),
        }
    }
}

/// What every frame cache holds together of one kind of memory, and the most it may.
struct Pool {
    budget: AtomicU64,
    cached: AtomicU64,
}

/// Frames in system memory (software decoding, thumbnails): 1.5 GB together (decoder.js `budget`).
static RAM: Pool = Pool { budget: AtomicU64::new(1536 << 20), cached: AtomicU64::new(0) };
/// Frames the decoder shared into the engine's device: 768 MB of video memory together.
static VRAM: Pool = Pool { budget: AtomicU64::new(768 << 20), cached: AtomicU64::new(0) };

fn pool(gpu: bool) -> &'static Pool {
    if gpu { &VRAM } else { &RAM }
}

/// Sets the system memory all frame caches share (decoder.js `setBudget`).
pub fn set_budget(bytes: u64) {
    RAM.budget.store(bytes, Ordering::Relaxed);
}

/// Bytes held by every frame cache now: in system memory, and in video memory.
pub fn cached_bytes() -> (u64, u64) {
    (RAM.cached.load(Ordering::Relaxed), VRAM.cached.load(Ordering::Relaxed))
}

/// What the worker of a frame source and the renders share.
struct State {
    /// sample index -> frame
    cache: HashMap<usize, Arc<Frame>>,
    bytes: u64,
    frame_size: u64,
    /// The frames are shared into the engine's device (their bytes count against video memory).
    gpu: bool,
    /// The cache's frame limit: 48 for a software decoder, 8 for a hardware one whose frames are read back
    /// (decoder.js `cacheFramesFor`), 16 for one whose frames stay on the GPU (copies, not the decoder's textures).
    max_frames: usize,
    max_bytes: u64,
    /// Presentation rank of the frame asked for last, and the direction the playhead moves.
    focus: u32,
    dir: i64,
    /// Presentation rank of the sync sample decoding to `focus` starts from: frames from it to `focus` are what a
    /// seek shows while it decodes on.
    focus_key: u32,
    /// The sample a render waits for.
    want: Option<usize>,
    /// Presentation ranks to decode ahead.
    window: Option<(u32, u32)>,
    error: Option<MediaError>,
    closed: bool,
    stats: SourceStats,
    /// The decoder the worker opened (`cut_decode::Path` as text), while it has one.
    decoder: Option<String>,
    /// The last render drew or prefetched this source. One that is not closes its decoder after [`IDLE_CLOSE`]
    /// without work.
    wanted: bool,
}

/// What a frame source did (decoder.js `stats()`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SourceStats {
    pub hits: u64,
    pub misses: u64,
    pub decoded: u64,
    pub dropped: u64,
    pub restarts: u32,
}

impl State {
    /// Lower is more worth keeping: frames ahead of the playhead by their distance, then those decoded on the way to
    /// it from its sync sample (shown while it decodes), any other behind it after all of those.
    fn keep_score(&self, rank: u32) -> i64 {
        let d = (i64::from(rank) - i64::from(self.focus)) * self.dir;
        if d >= 0 {
            d
        } else if (self.focus_key..self.focus).contains(&rank) {
            self.max_frames as i64 / 2 - d
        } else {
            self.max_frames as i64 - d * 4
        }
    }

    /// The frames the cache holds: the count limit, or fewer when this source's bytes or the shared budget run out.
    fn capacity(&self) -> usize {
        let p = pool(self.gpu);
        let others = p.cached.load(Ordering::Relaxed).saturating_sub(self.bytes);
        let fs = self.frame_size.max(1);
        let by_budget = p.budget.load(Ordering::Relaxed).saturating_sub(others) / fs;
        self.max_frames.min((self.max_bytes / fs) as usize).min(by_budget as usize).max(2)
    }

    fn drop_frame(&mut self, idx: usize) {
        if let Some(f) = self.cache.remove(&idx) {
            let (b, gpu) = f.cost();
            self.bytes -= b;
            pool(gpu).cached.fetch_sub(b, Ordering::Relaxed);
        }
    }

    fn evict_one(&mut self, rank: &[u32]) -> bool {
        let worst =
            self.cache.keys().copied().filter(|i| Some(*i) != self.want).max_by_key(|&i| self.keep_score(rank[i]));
        match worst {
            Some(i) => {
                self.drop_frame(i);
                self.stats.dropped += 1;
                true
            }
            None => false,
        }
    }

    /// Keeps a frame as the picture of sample `idx` (its own, or the one shown for a sample the stream lacks).
    fn insert(&mut self, idx: usize, f: Frame, rank: &[u32]) {
        self.drop_frame(idx);
        let (b, gpu) = f.cost();
        let p = pool(gpu);
        self.frame_size = b;
        self.bytes += b;
        p.cached.fetch_add(b, Ordering::Relaxed);
        self.cache.insert(idx, Arc::new(f));
        self.stats.decoded += 1;
        while self.cache.len() > self.max_frames
            || self.bytes > self.max_bytes
            || (p.cached.load(Ordering::Relaxed) > p.budget.load(Ordering::Relaxed) && self.cache.len() > 1)
        {
            if !self.evict_one(rank) {
                break;
            }
        }
    }

    /// The next sample the worker should decode: the wanted one, else the next of the window the cache can still take
    /// without dropping a nearer one.
    fn goal(&self, order: &[u32], rank: &[u32]) -> Option<usize> {
        if let Some(w) = self.want.filter(|w| !self.cache.contains_key(w)) {
            return Some(w);
        }
        let (ra, rb) = self.window?;
        let ahead =
            self.cache.keys().filter(|&&i| (i64::from(rank[i]) - i64::from(self.focus)) * self.dir >= 0).count();
        if ahead + 1 >= self.capacity() {
            return None;
        }
        (ra..=rb).map(|r| order[r as usize] as usize).find(|i| !self.cache.contains_key(i))
    }
}

struct Shared {
    state: Mutex<State>,
    /// The worker waits on it for work; renders waiting for a frame wait on it too.
    changed: Condvar,
}

/// Called (from a worker thread) when a frame source has a new frame: the app asks for a repaint.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

/// The frames of one video track for one clip on screen, decoded on a thread of their own.
pub struct FrameSource {
    opened: Arc<Opened>,
    shared: Arc<Shared>,
    rank: Arc<Vec<u32>>,
    thread: Option<std::thread::JoinHandle<()>>,
    pub(crate) used: u64,
    pub(crate) at: Instant,
}

/// What [`FrameSource::frame`] found.
pub enum Got {
    /// The frame for the time asked.
    Exact(Arc<Frame>),
    /// The nearest frame there is while the right one is decoded.
    Near(Arc<Frame>),
    /// Nothing decoded yet.
    Nothing,
    Failed(MediaError),
}

impl FrameSource {
    /// A frame source for the video track of `opened` (which has one) drawn by an engine whose device `bridge`
    /// reaches: frames stay on the GPU where the decoder can share them ([`route`](crate::route)), unless `share` is
    /// false (they are then read back to memory).
    pub(crate) fn new(opened: Arc<Opened>, waker: Option<Waker>, bridge: Option<&Bridge>, share: bool) -> Self {
        Self::build(opened, waker, None, bridge, share)
    }

    /// A frame source whose frames are in system memory (in [`Frame::bytes`]), its cache at most `frames` frames
    /// (thumbnails keep 4, as `thumbs.js` asks); `None` keeps the decoder's usual number.
    pub fn with_frames(opened: Arc<Opened>, waker: Option<Waker>, frames: Option<usize>) -> Self {
        Self::build(opened, waker, frames, None, false)
    }

    fn build(
        opened: Arc<Opened>,
        waker: Option<Waker>,
        frames: Option<usize>,
        bridge: Option<&Bridge>,
        share: bool,
    ) -> Self {
        let track = opened.track().expect("a video track");
        let s = &track.samples;
        let mut rank = vec![0u32; s.count()];
        for (r, &i) in s.order.iter().enumerate() {
            rank[i as usize] = r as u32;
        }
        let (cw, ch) = match &track.media {
            TrackMedia::Video(v) => (v.width, v.height),
            TrackMedia::Audio(_) => (1, 1),
        };
        let route = crate::route::choose(track, bridge, share);
        let max_frames = match (&route.bridge, route.accel) {
            (Some(_), _) => 16,
            (None, Accel::Software) => 48,
            (None, _) => 8,
        };
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                cache: HashMap::new(),
                bytes: 0,
                frame_size: (u64::from(cw) * u64::from(ch) * 3).div_ceil(2),
                gpu: route.bridge.is_some(),
                max_frames: frames.unwrap_or(max_frames).max(2),
                max_bytes: 384 << 20,
                focus: 0,
                focus_key: 0,
                dir: 1,
                want: None,
                window: None,
                error: None,
                closed: false,
                stats: SourceStats::default(),
                decoder: None,
                wanted: true,
            }),
            changed: Condvar::new(),
        });
        let rank = Arc::new(rank);
        let thread = {
            let (opened, shared, rank) = (opened.clone(), shared.clone(), rank.clone());
            std::thread::Builder::new()
                .name("cut-engine decoder".into())
                .spawn(move || work(&opened, &shared, &rank, route, waker))
                .ok()
        };
        Self { opened, shared, rank, thread, used: 0, at: Instant::now() }
    }

    fn sample_of(&self, t: f64) -> usize {
        let track = self.opened.track().expect("a video track");
        sample_at_time(track, t.round() as i64).unwrap_or(0)
    }

    /// The frame shown at source time `t` if it is decoded, else the nearest one there is; never waits.
    pub fn frame(&self, t: f64) -> Got {
        let idx = self.sample_of(t);
        let r = self.rank[idx];
        let mut st = self.shared.state.lock().expect("the frame cache");
        if let Some(e) = &st.error {
            return Got::Failed(e.clone());
        }
        let track = self.opened.track().expect("a video track");
        if r != st.focus {
            st.dir = if r > st.focus { 1 } else { -1 };
            st.focus_key = cut_formats::probe::key_before(track, idx as i64).map_or(r, |k| self.rank[k].min(r));
        }
        st.focus = r;
        // A frame outside the decode-ahead window means the playhead went elsewhere: drop the window.
        if st.window.is_some_and(|(a, b)| r < a || r > b) {
            st.window = None;
        }
        if let Some(f) = st.cache.get(&idx).cloned() {
            st.stats.hits += 1;
            if st.want == Some(idx) {
                st.want = None;
            }
            return Got::Exact(f);
        }
        st.stats.misses += 1;
        st.want = Some(idx);
        self.shared.changed.notify_all();
        // A frame decoded on the way from the sync sample a seek starts at (the decoder shows that one first), else
        // the frame before, else the closest after.
        let start = st.focus_key;
        let near = st.cache.values().min_by_key(|f| {
            let fr = self.rank[f.sample];
            let d = i64::from(fr) - i64::from(r);
            let on_the_way = fr >= start && fr <= r;
            (!on_the_way, if d <= 0 { -d * 2 } else { d * 2 + 1 })
        });
        near.map_or(Got::Nothing, |f| Got::Near(f.clone()))
    }

    /// The frame shown at `t`, waiting for the decoder (export, tests); `timeout` bounds the wait.
    pub fn wait(&self, t: f64, timeout: Duration) -> Got {
        let end = Instant::now() + timeout;
        loop {
            match self.frame(t) {
                Got::Near(_) | Got::Nothing => {}
                g => return g,
            }
            let st = self.shared.state.lock().expect("the frame cache");
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Got::Failed(MediaError { code: "decode", detail: "the frame did not come in time".into() });
            }
            let _ = self.shared.changed.wait_timeout(st, left.min(Duration::from_millis(50)));
        }
    }

    /// Decodes ahead what will be asked for between two source times, as far as the cache holds.
    pub fn prefetch(&self, from: f64, to: f64) {
        let a = self.rank[self.sample_of(from.min(to))];
        let b = self.rank[self.sample_of(from.max(to))];
        let mut st = self.shared.state.lock().expect("the frame cache");
        st.window = Some((a, b));
        self.shared.changed.notify_all();
    }

    pub fn stats(&self) -> SourceStats {
        self.shared.state.lock().expect("the frame cache").stats
    }

    pub fn path(&self) -> &str {
        &self.opened.path
    }

    /// The decoder in use (`Software { decoder }` or `Hardware { decoder, adapter }`), while the worker has one open.
    pub fn decoder(&self) -> Option<String> {
        self.shared.state.lock().expect("the frame cache").decoder.clone()
    }

    /// Whether the last render drew or prefetched this source; one that is not closes its decoder once idle.
    pub(crate) fn set_wanted(&self, wanted: bool) {
        let mut st = self.shared.state.lock().expect("the frame cache");
        if st.wanted != wanted {
            st.wanted = wanted;
            self.shared.changed.notify_all();
        }
    }
}

/// A source no render drew or prefetched lately closes its decoder and lets its frames go after this long without
/// work: a paused editor keeps only the decoders of what it shows (a 1080p hardware decoder holds about 90 MB of
/// video memory, its 16 shared frames 48 MB more: `tests/playback.rs memory_by_stage`). Asked again, it opens a new
/// one (`tests/idle.rs`).
pub const IDLE_CLOSE: Duration = Duration::from_secs(3);

/// Whether this PC decodes video of a codec string (`avc1.*`, `hvc1.*` ...): Media Foundation lists a decoder for it.
/// The answer for each codec is asked once.
pub fn decodes_video(codec: &str) -> bool {
    use std::sync::OnceLock;
    static ANSWERS: OnceLock<Mutex<HashMap<cut_decode::Codec, bool>>> = OnceLock::new();
    let Some(c) = cut_decode::Codec::of(codec).filter(|c| *c != cut_decode::Codec::Aac) else { return false };
    let mut answers = ANSWERS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
    *answers.entry(c).or_insert_with(|| !cut_decode::decoders(c).is_empty())
}

impl Drop for FrameSource {
    fn drop(&mut self) {
        {
            let mut st = self.shared.state.lock().expect("the frame cache");
            st.closed = true;
            for idx in st.cache.keys().copied().collect::<Vec<_>>() {
                st.drop_frame(idx);
            }
        }
        self.shared.changed.notify_all();
        // Not joined: a worker in the middle of a frame (tens of ms at 1080p) would hold up the thread that let the
        // source go (the UI's, when a render sweeps it). It sees `closed` after that frame and ends.
        self.thread = None;
    }
}

/// Whether a worker copies its hardware decoder's frames into the engine's device, and the ring it copies into
/// (made at the first frame, on the decoder's device).
enum Share {
    On { bridge: Bridge, ring: Option<cut_decode::share::Ring> },
    Off,
}

/// A frame could not be shared (the ring's textures or fences failed): this source reads its frames back from now on.
fn share_failed(shared: &Shared, why: String) {
    let mut st = shared.state.lock().expect("the frame cache");
    st.gpu = false;
    st.max_frames = st.max_frames.min(8);
    if let Some(d) = &mut st.decoder {
        *d = format!("{} read back: {why}", d.trim_end_matches(" shared"));
    }
}

/// A decoded picture as the cache keeps it: copied into the engine's device when the source shares its frames (and
/// from now on read back if that fails), else in memory. An `urgent` copy (a render waits for it) is finished before
/// this returns.
fn keep(f: &cut_decode::Frame, share: &mut Share, state: &Shared, urgent: bool) -> cut_decode::Result<Frame> {
    let shared = match (&f.pixels, &mut *share) {
        (cut_decode::Pixels::Gpu(g), Share::On { bridge, ring }) => {
            let copied = match ring {
                Some(r) => r.copy(g, f.format),
                None => cut_decode::share::Ring::new(bridge, g).and_then(|r| ring.insert(r).copy(g, f.format)),
            };
            match copied {
                Ok(s) => {
                    if urgent && let Some(r) = ring {
                        r.settle();
                    }
                    Some(s)
                }
                Err(e) => {
                    share_failed(state, e.to_string());
                    *share = Share::Off;
                    None
                }
            }
        }
        _ => None,
    };
    let bytes = if shared.is_some() { Vec::new() } else { f.to_memory()?.into_owned() };
    Ok(Frame { sample: f.sample, pts: f.pts, width: f.width, height: f.height, format: f.format, bytes, shared })
}

type Decoder<'a> = cut_decode::FrameSource<'a, cut_formats::FileReader>;

/// Opens the source's decoder as its route says (a hardware decoder that does not open, for want of a session or by
/// a driver's refusal, gives way to software) and says in the state which one it is.
fn open_decoder<'a>(
    reader: &'a cut_formats::FileReader,
    track: &'a Track,
    route: &crate::route::Route,
    shared: &Shared,
) -> cut_decode::Result<(Decoder<'a>, Share)> {
    let fs = match cut_decode::FrameSource::new(reader, track, route.accel) {
        Ok(f) => f,
        Err(_) if route.accel != Accel::Software => cut_decode::FrameSource::new(reader, track, Accel::Software)?,
        Err(e) => return Err(e),
    };
    let hardware = matches!(fs.decoder().path(), cut_decode::Path::Hardware { .. });
    let share = match &route.bridge {
        Some(bridge) if hardware => Share::On { bridge: bridge.clone(), ring: None },
        _ => Share::Off,
    };
    let mut st = shared.state.lock().expect("the frame cache");
    st.gpu = matches!(share, Share::On { .. });
    if hardware && !st.gpu {
        st.max_frames = st.max_frames.min(8);
    }
    st.decoder = Some(format!("{:?}{}", fs.decoder().path(), if st.gpu { " shared" } else { "" }));
    Ok((fs, share))
}

/// The worker: owns the decoder and decodes what the state asks for until the source closes; closes the decoder
/// while no render wants the source ([`IDLE_CLOSE`]).
fn work(opened: &Opened, shared: &Shared, rank: &[u32], route: crate::route::Route, waker: Option<Waker>) {
    let (Some(reader), Some(track)) = (opened.reader.as_deref(), opened.track()) else { return };
    let order = &track.samples.order;
    let fail = |e: String| {
        let mut st = shared.state.lock().expect("the frame cache");
        st.error = Some(MediaError { code: "decode", detail: e });
        shared.changed.notify_all();
        if let Some(w) = &waker {
            w();
        }
    };
    let mut decoder = match open_decoder(reader, track, &route, shared) {
        Ok(d) => Some(d),
        Err(e) => return fail(e.to_string()),
    };
    loop {
        let (goal, urgent) = {
            let mut st = shared.state.lock().expect("the frame cache");
            let mut settled = false;
            loop {
                if st.closed {
                    return;
                }
                if let Some(g) = st.goal(order, rank) {
                    break (g, st.want == Some(g));
                }
                // Nothing to do: the last copies are finished before the decoder idles (see `Ring::settle`).
                if !settled && let Some((_, Share::On { ring: Some(r), .. })) = &decoder {
                    drop(st);
                    r.settle();
                    settled = true;
                    st = shared.state.lock().expect("the frame cache");
                    continue;
                }
                if decoder.is_none() || st.wanted {
                    st = shared.changed.wait(st).expect("the frame cache");
                    continue;
                }
                let (next, idle) = shared.changed.wait_timeout(st, IDLE_CLOSE).expect("the frame cache");
                st = next;
                if idle.timed_out() && !st.wanted && st.goal(order, rank).is_none() {
                    for idx in st.cache.keys().copied().collect::<Vec<_>>() {
                        st.drop_frame(idx);
                    }
                    st.decoder = None;
                    drop(st);
                    decoder = None;
                    st = shared.state.lock().expect("the frame cache");
                }
            }
        };
        if decoder.is_none() {
            match open_decoder(reader, track, &route, shared) {
                Ok(d) => decoder = Some(d),
                Err(e) => return fail(e.to_string()),
            }
        }
        let Some((fs, share)) = decoder.as_mut() else { continue };
        let before = fs.stats().runs;
        // The sync sample a seek starts from is shown while the decoder goes on to the frame asked for. Going
        // backwards, the frames on the way are kept too: they are the next ones asked for (`tests/scrub.rs`).
        let early = |f: &cut_decode::Frame, first: bool| {
            let backwards = {
                let st = shared.state.lock().expect("the frame cache");
                st.dir < 0 && !st.cache.contains_key(&f.sample)
            };
            if !first && !backwards {
                return;
            }
            if let Ok(k) = keep(f, share, shared, first) {
                let mut st = shared.state.lock().expect("the frame cache");
                if !st.closed && !st.cache.contains_key(&f.sample) {
                    st.insert(f.sample, k, rank);
                    drop(st);
                    shared.changed.notify_all();
                    if let Some(w) = &waker {
                        w();
                    }
                }
            }
        };
        let got = fs.frame_at_showing(track.samples.pts[goal], early);
        let got = got.and_then(|f| keep(f, share, shared, urgent));
        match got {
            Ok(f) => {
                let mut st = shared.state.lock().expect("the frame cache");
                if st.closed {
                    return;
                }
                st.stats.restarts += fs.stats().runs - before;
                // A stream that lacks the sample shows the frame decoded nearest before it, kept under its sample.
                st.insert(goal, f, rank);
                drop(st);
                shared.changed.notify_all();
                if let Some(w) = &waker {
                    w();
                }
            }
            Err(e) => return fail(e.to_string()),
        }
    }
}
