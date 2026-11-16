//! The export's stages, each on a thread of its own and joined by bounded channels (the JavaScript's writer promises
//! and encoder queue limits): the picture is rendered on the GPU and turned into NV12 there, encoded by a Media
//! Foundation transform, the sound is mixed and AAC-encoded, and one writer puts both into the part file. A full
//! queue holds the stage before it; the first failure anywhere stops every stage at once.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cut_audio::Mixer;
use cut_decode::encode::{EncodedSample, EncoderConfig, EncoderInfo, VideoEncoder};
use cut_engine::{Captions, Engine, RenderOptions};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample, VideoConfig, WriteError};
use cut_formats::{ColorSpace, Matrix, Primaries, Transfer};
use cut_model::{Id, Project, Sequence};
use cut_time::{TICKS, Ticks};

use crate::lost::{Lost, What, lost_media, lost_sound};
use crate::nv12::{Frame, LostSlot, Nv12, gpu_failure};
use crate::plan::FramePlan;
use crate::sink::{Failure, PartFile};
use crate::timing::{Clocks, Step};

/// What the stages share: the first failure, the stop flag, and the counters progress is computed from.
pub(crate) struct Shared<'a> {
    pub cancel: &'a AtomicBool,
    stop: AtomicBool,
    failure: Mutex<Option<Failure>>,
    /// Frames encoded, and the sequence time (from the range start) the video has reached.
    pub frames: AtomicU64,
    pub video_at: AtomicI64,
    /// Samples of sound encoded.
    pub samples: AtomicU64,
    /// Clips of offline media drawn as the red picture or left silent.
    pub slated: Mutex<HashSet<Id>>,
    pub encoder: Mutex<Option<(String, bool)>>,
    pub clocks: &'a Clocks,
}

impl<'a> Shared<'a> {
    pub fn new(cancel: &'a AtomicBool, clocks: &'a Clocks) -> Self {
        Self {
            cancel,
            stop: AtomicBool::new(false),
            failure: Mutex::new(None),
            frames: AtomicU64::new(0),
            video_at: AtomicI64::new(0),
            samples: AtomicU64::new(0),
            slated: Mutex::new(HashSet::new()),
            encoder: Mutex::new(None),
            clocks,
        }
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed) || self.cancel.load(Ordering::Relaxed)
    }

    /// Records the first failure and stops everything.
    pub fn fail(&self, f: Failure) {
        let mut slot = self.failure.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(f);
        }
        self.stop.store(true, Ordering::Relaxed);
    }

    pub fn failure(&self) -> Option<Failure> {
        self.failure.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// What reaches the writer.
pub(crate) enum Out {
    /// The video track's codec string and avcC / hvcC (before the first video sample).
    VideoConfig(Vec<u8>),
    AudioConfig(Vec<u8>),
    Video(Sample),
    Audio(Sample),
}

/// A picture handed from the renderer to the encoder, still on its way back from the GPU.
pub(crate) struct Picture {
    pub index: u64,
    pub frame: Frame,
}

/// What the renderer needs.
pub(crate) struct RenderJob<'a> {
    pub project: &'a Project,
    pub seq: &'a Sequence,
    pub plan: FramePlan,
    pub size: (u32, u32),
    pub burn: Option<Id>,
    pub accepted: &'a HashSet<Id>,
    pub gpu: Option<(wgpu::Device, wgpu::Queue)>,
    pub frame_limit: Duration,
    pub gate: Option<std::sync::Arc<AtomicBool>>,
}

fn codecs_of(project: &Project, seq: &Sequence) -> String {
    let used: HashSet<Id> = seq.clips().filter_map(|c| c.media_id()).collect();
    let mut list: Vec<String> = Vec::new();
    for m in &project.media {
        if used.contains(&m.id)
            && let Some(c) = m.video.as_ref().and_then(|v| v.extra.get("codec")).and_then(|c| c.as_str())
            && !list.iter().any(|x| x == c)
        {
            list.push(c.to_owned());
        }
    }
    if list.is_empty() { "unknown".into() } else { list.join(", ") }
}

/// Renders every frame of the plan, converts it to NV12 on the GPU and hands it to the encoder.
pub(crate) fn render(job: RenderJob, sh: &Shared, tx: SyncSender<Picture>, recycle: Receiver<Frame>) {
    if let Err(f) = render_frames(&job, sh, &tx, &recycle) {
        sh.fail(f);
    }
}

fn render_frames(
    job: &RenderJob,
    sh: &Shared,
    tx: &SyncSender<Picture>,
    recycle: &Receiver<Frame>,
) -> Result<(), Failure> {
    let device_lost: LostSlot = Arc::default();
    let gpu_fail = |e: String| gpu_failure(&device_lost, e);
    let mut engine = match &job.gpu {
        Some((d, q)) => Engine::new(d.clone(), q.clone()),
        None => Engine::headless().map_err(|e| gpu_fail(e.to_string()))?,
    };
    let (w, h) = job.size;
    let mut nv = Nv12::new(engine.device(), engine.queue(), w, h, device_lost.clone());
    let mut spare = nv.frames();
    let device = engine.device().clone();
    let told = device_lost.clone();
    device.set_device_lost_callback(move |reason, message| {
        let why = if message.is_empty() { format!("{reason:?}") } else { message };
        *told.lock().unwrap_or_else(|e| e.into_inner()) = Some(why);
    });
    let opts = RenderOptions {
        quality: 1.0,
        captions: job.burn.map_or(Captions::None, |id| Captions::Tracks(vec![id])),
        wait: Some(job.frame_limit),
        proxy: false,
    };
    let seq_id = job.seq.id;
    let ahead = 2 * TICKS;
    for i in 0..job.plan.count {
        while job.gate.as_ref().is_some_and(|g| g.load(Ordering::Relaxed)) && !sh.stopped() {
            std::thread::sleep(Duration::from_millis(20));
        }
        if sh.stopped() {
            return Ok(());
        }
        let t = job.plan.time_of(i);
        // The window starts at the frame drawn now, every frame: a window left behind keeps the frames already drawn
        // in the source's cache, which then has no room to decode ahead, and each render waits for its frame.
        engine.prefetch(job.project, seq_id, t, t + ahead, false);
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let rendered = sh
            .clocks
            .time(Step::Render, || engine.render(job.project, seq_id, t, (w, h), &opts))
            .map_err(|e| gpu_fail(e.to_string()))?;
        if !rendered.complete {
            let secs = job.frame_limit.as_secs().to_string();
            return Err(Failure::with(
                "decode",
                "No video frame came from the decoder in {seconds} s (codec {codec}): this PC cannot decode the video. Convert it to H.264 and import it again.",
                &[("seconds", secs), ("codec", codecs_of(job.project, job.seq))],
            ));
        }
        let lost: Vec<Lost> = rendered
            .failed
            .iter()
            .map(|f| Lost { clip: Some(f.clip), media: f.media, error: f.error.clone() })
            .collect();
        if let Some(f) = lost_media(job.project, job.seq, t, &lost, job.accepted, What::Picture) {
            return Err(f);
        }
        sh.slated.lock().unwrap_or_else(|e| e.into_inner()).extend(rendered.failed.iter().map(|f| f.clip));
        let mut frame = match spare.pop() {
            Some(f) => f,
            // Every frame is with the encoder: wait for it to give one back.
            None => match sh.clocks.time(Step::RenderBlocked, || recycle.recv()) {
                Ok(f) => f,
                Err(_) => return Ok(()),
            },
        };
        sh.clocks.time(Step::Convert, || nv.submit(&rendered.texture, &mut frame));
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Err(gpu_fail(e.to_string().lines().next().unwrap_or("").to_owned()));
        }
        if device_lost.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return Err(gpu_fail(String::new()));
        }
        if sh.clocks.time(Step::RenderBlocked, || tx.send(Picture { index: i as u64, frame })).is_err() {
            return Ok(());
        }
    }
    Ok(())
}

/// What the encoder needs.
pub(crate) struct EncodeJob<'a> {
    pub config: EncoderConfig,
    pub choices: &'a [EncoderInfo],
    pub plan: FramePlan,
    pub key_interval: u64,
}

/// Encodes the pictures as they come; the first of `choices` that starts is used.
pub(crate) fn encode(
    job: EncodeJob,
    sh: &Shared,
    rx: Receiver<Picture>,
    recycle: SyncSender<Frame>,
    out: SyncSender<Out>,
) {
    if let Err(f) = encode_frames(&job, sh, &rx, &recycle, &out) {
        sh.fail(f);
    }
}

fn encode_frames(
    job: &EncodeJob,
    sh: &Shared,
    rx: &Receiver<Picture>,
    recycle: &SyncSender<Frame>,
    out: &SyncSender<Out>,
) -> Result<(), Failure> {
    let failed = |e: cut_decode::DecodeError| Failure::new("encode", &e.to_string());
    let mut last = Failure::new("noEncoder", "This PC has no H.264 encoder for these settings.");
    let mut enc = None;
    for c in job.choices {
        match VideoEncoder::new(&job.config, c) {
            Ok(e) => {
                enc = Some(e);
                break;
            }
            Err(e) => last = failed(e),
        }
    }
    let Some(mut enc) = enc else { return Err(last) };
    *sh.encoder.lock().unwrap_or_else(|e| e.into_inner()) = Some((enc.name().to_owned(), enc.hardware()));
    let stop = || sh.stopped();
    let mut packets: Vec<EncodedSample> = Vec::new();
    let mut described = false;
    let frame_hns = 1e7 * f64::from(job.plan.fps.den) / f64::from(job.plan.fps.num);
    let mut forward = |enc: &VideoEncoder, packets: &mut Vec<EncodedSample>| -> Result<bool, Failure> {
        for p in packets.drain(..) {
            if !described {
                let (_, desc) = enc.description().map_err(failed)?;
                if out.send(Out::VideoConfig(desc)).is_err() {
                    return Ok(false);
                }
                described = true;
            }
            let i = enc.frame_of(p.pts) as i64;
            let shift = ((p.pts - p.dts) as f64 / frame_hns).round() as i64;
            let pts = job.plan.pts_of(i);
            let sample = Sample {
                data: p.data,
                timestamp: pts,
                duration: job.plan.time_of(i + 1) - job.plan.time_of(i),
                key: p.key,
                composition_offset: pts - job.plan.pts_of(i - shift),
            };
            if out.send(Out::Video(sample)).is_err() {
                return Ok(false);
            }
            sh.frames.fetch_add(1, Ordering::Relaxed);
            sh.video_at.fetch_max(job.plan.pts_of(i + 1), Ordering::Relaxed);
        }
        Ok(true)
    };
    while let Ok(mut pic) = sh.clocks.time(Step::EncodeIdle, || rx.recv()) {
        if sh.stopped() {
            return Ok(());
        }
        let key = pic.index % job.key_interval.max(1) == 0;
        let at = std::time::Instant::now();
        let stride = pic.frame.stride;
        let pushed = pic.frame.read(|nv12| {
            let read = at.elapsed();
            let r = enc.push(pic.index, nv12, stride, key, &mut packets, &stop);
            (read, r)
        });
        let (read, r) = pushed?;
        sh.clocks.add(Step::ReadBack, read);
        sh.clocks.add(Step::EncodeIn, at.elapsed() - read);
        r.map_err(failed)?;
        let _ = recycle.try_send(pic.frame);
        if !sh.clocks.time(Step::EncodeOut, || forward(&enc, &mut packets))? {
            return Ok(());
        }
    }
    if sh.stopped() {
        return Ok(());
    }
    sh.clocks.time(Step::EncodeIn, || enc.finish(&mut packets, &stop)).map_err(failed)?;
    sh.clocks.add(Step::EncoderBusy, enc.input_wait());
    sh.clocks.add(Step::SampleCopy, enc.input_copy());
    sh.clocks.time(Step::EncodeOut, || forward(&enc, &mut packets))?;
    Ok(())
}

/// What the sound needs.
pub(crate) struct AudioJob<'a> {
    pub project: &'a Project,
    pub seq: &'a Sequence,
    pub from: Ticks,
    pub to: Ticks,
    pub rate: u32,
    pub channels: u32,
    pub bitrate: u32,
    pub delay: i64,
    pub master_gain: f64,
    pub accepted: &'a HashSet<Id>,
    /// Keep at most this far ahead of the video (none without a picture).
    pub pace: Option<Ticks>,
}

/// Mixes the range a second at a time and encodes it.
pub(crate) fn audio(job: AudioJob, mixer: &mut Mixer, sh: &Shared, out: SyncSender<Out>) {
    if let Err(f) = audio_blocks(&job, mixer, sh, &out) {
        sh.fail(f);
    }
}

fn audio_blocks(job: &AudioJob, mixer: &mut Mixer, sh: &Shared, out: &SyncSender<Out>) -> Result<(), Failure> {
    let failed = |e: cut_decode::DecodeError| Failure::new("audio", &e.to_string());
    let mut enc = cut_decode::encode::AacEncoder::new(job.rate, job.channels, job.bitrate).map_err(failed)?;
    if out.send(Out::AudioConfig(enc.description().to_vec())).is_err() {
        return Ok(());
    }
    let tps = TICKS / i64::from(job.rate);
    let s0 = (job.from as f64 / tps as f64 + 0.5).floor() as i64;
    let total = ((job.to as f64 / tps as f64 + 0.5).floor() as i64 - s0).max(0);
    let rate = i64::from(job.rate);
    let mut done = 0i64;
    let mut packets: Vec<EncodedSample> = Vec::new();
    let mut sent = 0i64;
    let mut forward = |packets: &mut Vec<EncodedSample>| -> bool {
        for p in packets.drain(..) {
            let sample = Sample {
                data: p.data,
                timestamp: (sent * 1024 - job.delay) * tps,
                duration: 1024 * tps,
                key: true,
                composition_offset: 0,
            };
            sent += 1;
            if out.send(Out::Audio(sample)).is_err() {
                return false;
            }
        }
        true
    };
    while done < total {
        if let Some(ahead) = job.pace {
            sh.clocks.time(Step::SoundPaced, || {
                while !sh.stopped() && (done * tps) > sh.video_at.load(Ordering::Relaxed) + ahead {
                    std::thread::sleep(Duration::from_millis(2));
                }
            });
        }
        if sh.stopped() {
            return Ok(());
        }
        let n = rate.min(total - done) as usize;
        let m = sh.clocks.time(Step::Mix, || mixer.mix_loaded(job.project, job.seq.id, s0 + done, n, job.master_gain));
        let lost = lost_sound(&m.missed, &mixer.failures());
        if let Some(f) = lost_media(job.project, job.seq, (s0 + done) * tps, &lost, job.accepted, What::Sound) {
            return Err(f);
        }
        sh.slated.lock().unwrap_or_else(|e| e.into_inner()).extend(m.missed.iter().map(|x| x.0));
        sh.clocks.time(Step::Aac, || enc.push(&[&m.out[0], &m.out[1]], &mut packets)).map_err(failed)?;
        done += n as i64;
        sh.samples.store(done as u64, Ordering::Relaxed);
        if !forward(&mut packets) {
            return Ok(());
        }
    }
    enc.finish(&mut packets).map_err(failed)?;
    forward(&mut packets);
    Ok(())
}

/// What the writer needs.
pub(crate) struct WriteJob {
    pub video: Option<VideoConfig>,
    pub audio: Option<AudioConfig>,
    pub part: PartFile,
}

fn bt709() -> ColorSpace {
    ColorSpace {
        primaries: Some(Primaries::Bt709),
        transfer: Some(Transfer::Bt709),
        matrix: Some(Matrix::Bt709),
        full_range: Some(false),
    }
}

fn write_failed(e: &WriteError) -> Failure {
    match e {
        WriteError::Sink(io) => Failure::io(std::io::Error::new(io.kind(), io.to_string())),
        other => Failure::new("io", &other.to_string()),
    }
}

/// Writes both tracks into the part file as their samples come -> the part file, complete, for the caller to commit
/// (or drop, which deletes it).
pub(crate) fn write(job: WriteJob, sh: &Shared, rx: Receiver<Out>) -> Option<PartFile> {
    match write_all(job, sh, &rx) {
        Ok(p) => p,
        Err(f) => {
            sh.fail(f);
            None
        }
    }
}

fn write_all(job: WriteJob, sh: &Shared, rx: &Receiver<Out>) -> Result<Option<PartFile>, Failure> {
    let WriteJob { mut video, mut audio, part } = job;
    let (want_video, want_audio) = (video.is_some(), audio.is_some());
    let (mut have_video, mut have_audio) = (false, false);
    let mut early = Vec::new();
    let mut part = Some(part);
    let mut writer: Option<Mp4Writer<PartFile>> = None;
    loop {
        let msg = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(m) => Some(m),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if sh.stopped() {
            return Ok(None);
        }
        let Some(msg) = msg else { continue };
        match msg {
            Out::VideoConfig(d) => {
                if let Some(v) = &mut video {
                    v.description = Some(d);
                    v.color_space = Some(bt709());
                }
                have_video = true;
            }
            Out::AudioConfig(d) => {
                if let Some(a) = &mut audio {
                    a.description = Some(d);
                }
                have_audio = true;
            }
            m => early.push(m),
        }
        if writer.is_none() && (have_video || !want_video) && (have_audio || !want_audio) {
            let p = part.take().ok_or_else(|| Failure::new("io", "the export file is gone"))?;
            writer = Some(Mp4Writer::create(video.take(), audio.take(), p, None).map_err(|e| write_failed(&e))?);
        }
        if let Some(w) = &mut writer {
            let t = std::time::Instant::now();
            for m in early.drain(..) {
                let r = match m {
                    Out::Video(s) => w.add_video(s),
                    Out::Audio(s) => w.add_audio(s),
                    _ => Ok(()),
                };
                r.map_err(|e| write_failed(&e))?;
            }
            sh.clocks.add(Step::Mux, t.elapsed());
        }
    }
    if sh.stopped() {
        return Ok(None);
    }
    let Some(mut w) = writer else {
        return Err(Failure::new("encode", "the encoders gave nothing to write"));
    };
    sh.clocks.time(Step::Mux, || w.finish()).map_err(|e| write_failed(&e))?;
    Ok(Some(w.into_sink()))
}

/// A channel depth: samples to the writer.
pub(crate) const SAMPLES: usize = 256;

/// The level a codec string carries: `avc1.6400LL` (hex level_idc) or `hvc1.1.6.L<n>.B0`.
pub(crate) fn level_of(codec: &str) -> Option<u32> {
    if let Some(rest) = codec.strip_prefix("avc1.") {
        return rest.get(4..6).and_then(|h| u32::from_str_radix(h, 16).ok());
    }
    codec.split('.').find_map(|p| p.strip_prefix('L')).and_then(|l| l.parse().ok())
}
