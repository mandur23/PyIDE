//! The preview's sound (`audioengine.create`): the mix played from the playhead through the default output device
//! (WASAPI by `cpal`), and the clock the picture follows.
//!
//! Three actors share one [`Shared`] block and nothing else: the caller's thread (the app's UI) sends commands and
//! reads the clock and meters; a mixing thread owns the [`Mixer`] and the project, mixes [`BLOCK`] frames at a time
//! ahead of the device and pushes them into a lock-free ring; the device's callback takes frames from the ring and
//! counts them. [`Playback::position`] is the sequence time of the frame sounding now: the frames the callback has
//! taken, plus the time since the device said the last callback's first frame would sound.
//!
//! Rates 0.25 to 4 play forward like tape (the mix of `rate` times as many samples, stretched linearly to a block);
//! other rates (the shuttle's -8..8) are silent while the clock runs, as the JavaScript's preview is.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cut_model::{Id, Project};
use cut_time::TICKS;

use crate::mixer::{GetAudio, LOOKAHEAD_SECONDS, Mixed, Mixer};
use crate::util::{db_to_gain, gain_to_db, js_round};

/// Frames mixed at a time.
pub const BLOCK: usize = 2048;
/// Seconds of sound kept ahead of the device (the JavaScript schedules 0.3 s ahead).
pub const AHEAD: f64 = 0.3;
const RING: usize = 1 << 15;

/// Why playback could not start.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlaybackError {
    #[error("no output device")]
    NoDevice,
    #[error("the output device: {0}")]
    Device(String),
}

/// Levels of the block sounding now, dBFS (-inf when silent): peaks and RMS of the master, a track's peaks after its
/// fader and pan.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Meters {
    pub master: f64,
    pub master_channels: [f64; 2],
    pub master_rms: [f64; 2],
    pub tracks: Vec<(Id, f64)>,
    pub track_channels: Vec<(Id, [f64; 2])>,
}

impl Meters {
    fn quiet() -> Self {
        let q = f64::NEG_INFINITY;
        Self { master: q, master_channels: [q; 2], master_rms: [q; 2], tracks: Vec::new(), track_channels: Vec::new() }
    }
}

/// A single-producer single-consumer ring of stereo frames: the mixing thread writes, the device callback reads.
struct Ring {
    data: Vec<AtomicU32>,
    write: AtomicUsize,
    read: AtomicUsize,
}

impl Ring {
    fn new() -> Self {
        Self {
            data: (0..2 * RING).map(|_| AtomicU32::new(0)).collect(),
            write: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
        }
    }

    fn free(&self) -> usize {
        RING - (self.write.load(Ordering::Acquire) - self.read.load(Ordering::Acquire))
    }

    /// Frames written and not read yet, of those after `from` (what an earlier start left is not counted).
    fn ahead(&self, from: usize) -> usize {
        let w = self.write.load(Ordering::Acquire);
        w - self.read.load(Ordering::Acquire).max(from).min(w)
    }

    fn push(&self, l: &[f32], r: &[f32]) {
        let w = self.write.load(Ordering::Relaxed);
        for (k, (a, b)) in l.iter().zip(r).enumerate() {
            let i = (w + k) % RING;
            self.data[2 * i].store(a.to_bits(), Ordering::Relaxed);
            self.data[2 * i + 1].store(b.to_bits(), Ordering::Relaxed);
        }
        self.write.store(w + l.len(), Ordering::Release);
    }
}

/// A block in the ring: the frames of its generation it starts at and its levels.
struct Heard {
    from: u64,
    to: u64,
    master: [f64; 2],
    rms: [f64; 2],
    tracks: Vec<(Id, [f64; 2])>,
}

struct Shared {
    ring: Ring,
    epoch: Instant,
    playing: AtomicBool,
    /// Bumped by every start and stop; the mixing thread answers with `ready` once frames of it are in the ring.
    want: AtomicU64,
    ready: AtomicU64,
    /// Ring frames before this belong to an earlier start: the callback drops them.
    flush_to: AtomicUsize,
    /// The sequence sample frame 0 of this start plays, and the rate (f64 bits).
    t0: AtomicI64,
    rate: AtomicU64,
    /// Frames of this start the callback has taken, and at its last call: that count, the frames it took, and when
    /// (nanoseconds from `epoch`) the device said the first of them would sound.
    consumed: AtomicU64,
    cb_frames: AtomicU64,
    cb_len: AtomicU64,
    cb_at: AtomicU64,
    /// The start the callback values are of.
    cb_gen: AtomicU64,
    callbacks: AtomicU64,
    underruns: AtomicU64,
    /// Linear gains: the preview's master (`setMasterGain`) and a last multiplier for tests (0: silent).
    master: AtomicU32,
    output: AtomicU32,
    heard: Mutex<VecDeque<Heard>>,
    last: AtomicI64,
    error: Mutex<Option<String>>,
    /// Tests: the frames the callback plays (before the gains), up to the capacity reserved.
    tap: Mutex<Vec<f32>>,
}

enum Command {
    Start { t: i64, rate: f64, start: u64 },
    Stop,
    Project(Arc<Project>, Id),
    Quit,
}

/// The preview's player. Lives on the thread that made it (the stream may not move between threads).
pub struct Playback {
    shared: Arc<Shared>,
    tx: Sender<Command>,
    worker: Option<JoinHandle<()>>,
    _stream: cpal::Stream,
    rate: u32,
}

impl Playback {
    /// Opens the default output device (stereo float at 48 kHz when it takes it, else its own rate) and starts the
    /// mixing thread with a mixer at the device's rate over `get_audio`.
    pub fn new(get_audio: GetAudio) -> Result<Self, PlaybackError> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(PlaybackError::NoDevice)?;
        let config = pick_config(&device)?;
        let rate = config.sample_rate.0;
        let channels = usize::from(config.channels);
        let shared = Arc::new(Shared {
            ring: Ring::new(),
            epoch: Instant::now(),
            playing: AtomicBool::new(false),
            want: AtomicU64::new(0),
            ready: AtomicU64::new(0),
            flush_to: AtomicUsize::new(0),
            t0: AtomicI64::new(0),
            rate: AtomicU64::new(1f64.to_bits()),
            consumed: AtomicU64::new(0),
            cb_frames: AtomicU64::new(0),
            cb_len: AtomicU64::new(0),
            cb_at: AtomicU64::new(0),
            cb_gen: AtomicU64::new(0),
            callbacks: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            master: AtomicU32::new(1f32.to_bits()),
            output: AtomicU32::new(1f32.to_bits()),
            heard: Mutex::new(VecDeque::new()),
            last: AtomicI64::new(0),
            error: Mutex::new(None),
            tap: Mutex::new(Vec::new()),
        });
        let (sh, she) = (shared.clone(), shared.clone());
        let mut local_start = 0u64;
        let stream = device
            .build_output_stream(
                &config,
                move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    callback(&sh, &mut local_start, data, channels, info);
                },
                move |e| {
                    *she.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.to_string());
                },
                None,
            )
            .map_err(|e| PlaybackError::Device(e.to_string()))?;
        stream.play().map_err(|e| PlaybackError::Device(e.to_string()))?;
        let (tx, rx) = mpsc::channel();
        let ws = shared.clone();
        let worker = std::thread::Builder::new()
            .name("cut-audio mixer".into())
            .spawn(move || work(&ws, rx, Mixer::new(rate, get_audio)))
            .map_err(|e| PlaybackError::Device(e.to_string()))?;
        Ok(Self { shared, tx, worker: Some(worker), _stream: stream, rate })
    }

    /// The device's (and the mixer's) sample rate.
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// The project the mixing thread mixes from now on (send it again after every change: an edit is heard within
    /// [`AHEAD`] seconds).
    pub fn set_project(&self, project: Arc<Project>, seq: Id) {
        let _ = self.tx.send(Command::Project(project, seq));
    }

    /// Plays from sequence time `t` (ticks) at `rate`; also a seek while playing.
    pub fn start(&self, t: i64, rate: f64) {
        let s = &self.shared;
        let t = t.max(0);
        s.playing.store(false, Ordering::SeqCst);
        let start = s.want.fetch_add(1, Ordering::SeqCst) + 1;
        s.t0.store(js_round(t as f64 * f64::from(self.rate) / TICKS as f64) as i64, Ordering::SeqCst);
        s.rate.store(rate.to_bits(), Ordering::SeqCst);
        s.last.store(t, Ordering::SeqCst);
        s.playing.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Command::Start { t, rate, start });
    }

    /// Stops; the clock stays where the sound was.
    pub fn stop(&self) {
        let now = self.position();
        let s = &self.shared;
        s.playing.store(false, Ordering::SeqCst);
        s.want.fetch_add(1, Ordering::SeqCst);
        s.last.store(now, Ordering::SeqCst);
        let _ = self.tx.send(Command::Stop);
    }

    pub fn playing(&self) -> bool {
        self.shared.playing.load(Ordering::SeqCst)
    }

    /// The sequence time (ticks) of the sound heard now: exact to the frame at rate 1, never going back while
    /// playing forward; where it will start until the sound starts, and where it stopped after a stop.
    pub fn position(&self) -> i64 {
        let s = &self.shared;
        let last = s.last.load(Ordering::SeqCst);
        if !s.playing.load(Ordering::SeqCst) {
            return last;
        }
        let rate = f64::from_bits(s.rate.load(Ordering::SeqCst));
        let tps = TICKS as f64 / f64::from(self.rate);
        let frames = self.sounding_frames();
        let v = ((s.t0.load(Ordering::SeqCst) as f64 + frames * rate) * tps).max(0.0) as i64;
        let v = if rate >= 0.0 { v.max(last) } else { v.min(last) };
        s.last.store(v, Ordering::SeqCst);
        v
    }

    /// Frames of this start sounding now (fractional between device frames).
    fn sounding_frames(&self) -> f64 {
        let s = &self.shared;
        let want = s.want.load(Ordering::SeqCst);
        if s.ready.load(Ordering::SeqCst) != want || s.cb_gen.load(Ordering::SeqCst) != want {
            return 0.0;
        }
        let base = s.cb_frames.load(Ordering::SeqCst) as f64;
        let len = s.cb_len.load(Ordering::SeqCst) as f64;
        let at = s.cb_at.load(Ordering::SeqCst) as f64;
        let now = s.epoch.elapsed().as_nanos() as f64;
        let since = ((now - at) / 1e9 * f64::from(self.rate)).max(0.0).min(len);
        base + since
    }

    /// The levels of the block sounding now.
    pub fn meters(&self) -> Meters {
        let s = &self.shared;
        if !s.playing.load(Ordering::SeqCst) {
            return Meters::quiet();
        }
        let f = self.sounding_frames() as u64;
        let g = f64::from(f32::from_bits(s.master.load(Ordering::SeqCst)));
        let heard = s.heard.lock().unwrap_or_else(|p| p.into_inner());
        let Some(h) = heard.iter().find(|h| h.from <= f && f < h.to) else { return Meters::quiet() };
        Meters {
            master: gain_to_db(h.master[0].max(h.master[1]) * g),
            master_channels: h.master.map(|v| gain_to_db(v * g)),
            master_rms: h.rms.map(|v| gain_to_db(v * g)),
            tracks: h.tracks.iter().map(|(id, [l, r])| (*id, gain_to_db(l.max(*r)))).collect(),
            track_channels: h.tracks.iter().map(|(id, [l, r])| (*id, [gain_to_db(*l), gain_to_db(*r)])).collect(),
        }
    }

    /// The preview's master gain (dB) on top of the mix.
    pub fn set_master_gain(&self, db: f64) {
        self.shared.master.store((db_to_gain(db) as f32).to_bits(), Ordering::SeqCst);
    }

    /// A last multiplier of what goes to the device, after everything (tests play at 0: silent, all else computed).
    pub fn set_output_gain(&self, g: f32) {
        self.shared.output.store(g.to_bits(), Ordering::SeqCst);
    }

    /// Callbacks so far, and those that found the ring short while playing (an underrun).
    pub fn stats(&self) -> (u64, u64) {
        (self.shared.callbacks.load(Ordering::SeqCst), self.shared.underruns.load(Ordering::SeqCst))
    }

    /// Tests: keeps the next `frames` frames the device plays (interleaved, before the gains); `None` gives what was
    /// kept and stops keeping.
    pub fn tap(&self, frames: Option<usize>) -> Vec<f32> {
        let mut tap = self.shared.tap.lock().unwrap_or_else(|p| p.into_inner());
        match frames {
            Some(n) => {
                *tap = Vec::with_capacity(2 * n);
                Vec::new()
            }
            None => std::mem::take(&mut *tap),
        }
    }

    /// The device's last error, if any.
    pub fn error(&self) -> Option<String> {
        self.shared.error.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        self.shared.playing.store(false, Ordering::SeqCst);
        let _ = self.tx.send(Command::Quit);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

fn pick_config(device: &cpal::Device) -> Result<cpal::StreamConfig, PlaybackError> {
    let err = |e: &dyn std::fmt::Display| PlaybackError::Device(e.to_string());
    let def = device.default_output_config().map_err(|e| err(&e))?;
    let f32_ok = |c: &cpal::SupportedStreamConfigRange| c.sample_format() == cpal::SampleFormat::F32;
    let configs: Vec<_> = device.supported_output_configs().map_err(|e| err(&e))?.filter(f32_ok).collect();
    let want = cpal::SampleRate(48000);
    let chosen = configs
        .iter()
        .find(|c| c.channels() == 2 && c.min_sample_rate() <= want && want <= c.max_sample_rate())
        .map(|c| c.with_sample_rate(want))
        .or_else(|| {
            configs
                .iter()
                .find(|c| c.channels() >= 2)
                .map(|c| c.with_sample_rate(def.sample_rate().clamp(c.min_sample_rate(), c.max_sample_rate())))
        })
        .ok_or_else(|| PlaybackError::Device("no stereo float output".into()))?;
    Ok(cpal::StreamConfig {
        channels: chosen.channels(),
        sample_rate: chosen.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    })
}

/// The device callback: frames from the ring while playing, silence otherwise.
fn callback(s: &Shared, local: &mut u64, data: &mut [f32], channels: usize, info: &cpal::OutputCallbackInfo) {
    let frames = data.len() / channels.max(1);
    let ts = info.timestamp();
    let latency = ts.playback.duration_since(&ts.callback).unwrap_or(Duration::ZERO);
    let at = s.epoch.elapsed() + latency;
    s.callbacks.fetch_add(1, Ordering::Relaxed);
    let want = s.want.load(Ordering::Acquire);
    let live = s.playing.load(Ordering::Acquire) && s.ready.load(Ordering::Acquire) == want;
    if live && *local != want {
        let to = s.flush_to.load(Ordering::Acquire);
        if s.ring.read.load(Ordering::Relaxed) < to {
            s.ring.read.store(to, Ordering::Release);
        }
        s.consumed.store(0, Ordering::SeqCst);
        *local = want;
    }
    let (master, output) =
        (f32::from_bits(s.master.load(Ordering::Relaxed)), f32::from_bits(s.output.load(Ordering::Relaxed)));
    let mut taken = 0;
    if live {
        let r = s.ring.read.load(Ordering::Relaxed);
        let avail = s.ring.write.load(Ordering::Acquire) - r;
        taken = frames.min(avail);
        for (k, frame) in data.chunks_exact_mut(channels).take(taken).enumerate() {
            let i = (r + k) % RING;
            let l = f32::from_bits(s.ring.data[2 * i].load(Ordering::Relaxed));
            let rr = f32::from_bits(s.ring.data[2 * i + 1].load(Ordering::Relaxed));
            for (c, v) in frame.iter_mut().enumerate() {
                *v = if c % 2 == 0 { l } else { rr } * master * output;
            }
        }
        if let Ok(mut tap) = s.tap.try_lock()
            && tap.capacity() > tap.len()
        {
            for k in 0..taken.min((tap.capacity() - tap.len()) / 2) {
                let i = (r + k) % RING;
                tap.push(f32::from_bits(s.ring.data[2 * i].load(Ordering::Relaxed)));
                tap.push(f32::from_bits(s.ring.data[2 * i + 1].load(Ordering::Relaxed)));
            }
        }
        s.ring.read.store(r + taken, Ordering::Release);
        if taken < frames {
            s.underruns.fetch_add(1, Ordering::Relaxed);
        }
        let before = s.consumed.fetch_add(taken as u64, Ordering::SeqCst);
        s.cb_frames.store(before, Ordering::SeqCst);
        s.cb_len.store(taken as u64, Ordering::SeqCst);
        s.cb_at.store(at.as_nanos() as u64, Ordering::SeqCst);
        s.cb_gen.store(want, Ordering::SeqCst);
    }
    for v in &mut data[taken * channels..] {
        *v = 0.0;
    }
}

/// The mixing thread: owns the mixer and the project, keeps [`AHEAD`] seconds of sound in the ring while playing.
fn work(s: &Shared, rx: Receiver<Command>, mut mixer: Mixer) {
    let rate = f64::from(mixer.rate());
    let tps = TICKS as f64 / rate;
    let mut project: Option<(Arc<Project>, Id)> = None;
    let mut playing = false;
    let mut start = 0;
    let mut play_rate = 1.0;
    let mut next = 0i64;
    let mut frames = 0u64;
    let mut ahead_from = f64::NEG_INFINITY;
    loop {
        let cmd = if playing {
            rx.recv_timeout(Duration::from_millis(4))
        } else {
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };
        match cmd {
            Ok(Command::Quit) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Command::Project(p, seq)) => {
                mixer.changed();
                project = Some((p, seq));
            }
            Ok(Command::Stop) => {
                playing = false;
                s.heard.lock().unwrap_or_else(|p| p.into_inner()).clear();
            }
            Ok(Command::Start { t, rate: r, start: g }) => {
                start = g;
                play_rate = r;
                if let Some((p, seq)) = &project {
                    mixer.load(p, *seq, t as f64 - TICKS as f64, t as f64 + 3.0 * TICKS as f64);
                }
                next = js_round(t as f64 / tps) as i64;
                frames = 0;
                ahead_from = f64::NEG_INFINITY;
                s.heard.lock().unwrap_or_else(|p| p.into_inner()).clear();
                s.flush_to.store(s.ring.write.load(Ordering::SeqCst), Ordering::SeqCst);
                playing = true;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if !playing || s.want.load(Ordering::SeqCst) != start {
            continue;
        }
        let target = (AHEAD * rate) as usize;
        while s.ring.ahead(s.flush_to.load(Ordering::SeqCst)) < target && s.ring.free() >= BLOCK {
            let audible = (0.25..=4.0).contains(&play_rate);
            let span = js_round(BLOCK as f64 * play_rate) as i64;
            let (l, r, m) = match &project {
                Some((p, seq)) if audible => {
                    let m = mixer.mix(p, *seq, next, span as usize, 0.0);
                    if m.missing > 0 {
                        mixer.fetch(p);
                    }
                    let (l, r) = tape(&m.out, BLOCK);
                    (l, r, Some(m))
                }
                _ => (vec![0.0; BLOCK], vec![0.0; BLOCK], None),
            };
            s.ring.push(&l, &r);
            if let Some(m) = m {
                remember(s, frames, &m);
            }
            frames += BLOCK as u64;
            next += span;
            // The first block of this start is in: the callback may play it.
            s.ready.store(start, Ordering::SeqCst);
        }
        if let Some((p, seq)) = &project
            && next as f64 * tps - ahead_from > TICKS as f64
        {
            ahead_from = next as f64 * tps;
            mixer.load(p, *seq, ahead_from, ahead_from + LOOKAHEAD_SECONDS * TICKS as f64 * play_rate.max(1.0));
        }
    }
}

/// `src` stretched linearly to `n` frames (a tape rate); at rate 1 it is `src` itself.
fn tape(src: &[Vec<f32>; 2], n: usize) -> (Vec<f32>, Vec<f32>) {
    if src[0].len() == n {
        return (src[0].clone(), src[1].clone());
    }
    let step = src[0].len() as f64 / n as f64;
    let at = |c: &[f32], i: usize| {
        let x = i as f64 * step;
        let k = x.floor() as usize;
        let f = (x - k as f64) as f32;
        let a = c.get(k).copied().unwrap_or(0.0);
        let b = c.get(k + 1).copied().unwrap_or(a);
        a + (b - a) * f
    };
    ((0..n).map(|i| at(&src[0], i)).collect(), (0..n).map(|i| at(&src[1], i)).collect())
}

fn remember(s: &Shared, from: u64, m: &Mixed) {
    let mut heard = s.heard.lock().unwrap_or_else(|p| p.into_inner());
    heard.push_back(Heard { from, to: from + BLOCK as u64, master: m.master, rms: m.rms, tracks: m.tracks.clone() });
    while heard.len() > 2 * RING / BLOCK {
        heard.pop_front();
    }
}
