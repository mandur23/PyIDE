//! The MP4 writer of exports: ftyp, then one mdat streamed to the sink as samples come (its 64-bit size is patched at
//! finish), then moov at the end with stts, ctts when there are composition offsets, stss, stsz, stsc, co64, an edit
//! list when a track does not start at 0 (or has B-frame delay), colr, esds/dOps and btrt. Samples are grouped in
//! chunks of about half a second, written in time order across the tracks so a player reading the file front to back
//! does not seek back and forth. The bytes are the JavaScript writer's for the same samples.

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;

use cut_time::Ticks;

use crate::bytes::ByteWriter;
use crate::codecs::audio::{OpusHead, build_audio_specific_config, build_opus_head, dops_from_opus_head};
use crate::codecs::{CodecInfo, codes_from_color, parse_codec_string};
use crate::error::FormatError;
use crate::source::ColorSpace;
use crate::table::{Clock, js_round};

/// Where the file goes: appends (`position` `None`) and one overwrite of 8 bytes at finish.
pub trait Sink {
    fn write(&mut self, bytes: &[u8], position: Option<u64>) -> io::Result<()>;
}

/// A file in memory.
impl Sink for Vec<u8> {
    fn write(&mut self, bytes: &[u8], position: Option<u64>) -> io::Result<()> {
        let at = position.map_or(self.len(), |p| p as usize);
        if self.len() < at + bytes.len() {
            self.resize(at + bytes.len(), 0);
        }
        self[at..at + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }
}

/// A file on disk.
impl Sink for std::fs::File {
    fn write(&mut self, bytes: &[u8], position: Option<u64>) -> io::Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        match position {
            Some(p) => {
                let back = self.stream_position()?;
                self.seek(SeekFrom::Start(p))?;
                self.write_all(bytes)?;
                self.seek(SeekFrom::Start(back))?;
            }
            None => {
                self.seek(SeekFrom::End(0))?;
                self.write_all(bytes)?;
            }
        }
        Ok(())
    }
}

/// Why the writer stopped or refused.
#[derive(Debug, Clone, thiserror::Error)]
pub enum WriteError {
    /// What `create` was given cannot be written.
    #[error("{0}")]
    Config(String),
    /// The sink refused a write; every later call returns this.
    #[error("{0}")]
    Sink(Arc<io::Error>),
    #[error("mp4write: the file is finished")]
    Finished,
    #[error("mp4write: finish was already called")]
    FinishedTwice,
    #[error("mp4write: no {0} track")]
    NoTrack(&'static str),
    /// The audio description does not read (a bad OpusHead).
    #[error("{0}")]
    Format(#[from] FormatError),
}

/// The video track: an H.264 or HEVC codec string, the coded size, the avcC or hvcC from the encoder.
#[derive(Debug, Clone, Default)]
pub struct VideoConfig {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub description: Option<Vec<u8>>,
    pub frame_rate: Option<[u32; 2]>,
    pub color_space: Option<ColorSpace>,
}

/// The audio track: `mp4a.40.x` or `opus`; without a description one is built.
#[derive(Debug, Clone, Default)]
pub struct AudioConfig {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub description: Option<Vec<u8>>,
}

/// One sample: its bytes, presentation time and length in ticks, and for video the sync flag and pts - dts.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub data: Vec<u8>,
    pub timestamp: Ticks,
    pub duration: Ticks,
    pub key: bool,
    pub composition_offset: Ticks,
}

/// A media timescale in which every frame lasts a whole number of units: 30 -> 30000, 30000/1001 -> 30000.
pub fn video_timescale(fps: Option<[u32; 2]>) -> u32 {
    match fps {
        Some([num, den]) if num > 0 && den > 0 => {
            if den == 1 {
                num.saturating_mul(1000)
            } else {
                num
            }
        }
        _ => 90000,
    }
}

const CHUNK: Ticks = cut_time::TICKS / 2;
const OUT_BYTES: usize = 2 * 1024 * 1024;
/// A track that runs far ahead of the other is written anyway past this much buffered data.
const MAX_PENDING: usize = 64 * 1024 * 1024;
const MATRIX: [i64; 9] = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x4000_0000];
const U32: i64 = 0xffff_ffff;

enum Config {
    Video { cfg: VideoConfig, avc: bool, entry: String },
    Audio { cfg: AudioConfig, opus: bool, object_type: u32 },
}

struct Pending {
    data: Vec<u8>,
    start: Ticks,
    end: Ticks,
}

struct WTrack {
    id: i64,
    config: Config,
    timescale: u32,
    clock: Clock,
    dts: Vec<i64>,
    cto: Vec<i64>,
    dur: Vec<i64>,
    size: Vec<u32>,
    key: Vec<bool>,
    chunk_offset: Vec<u64>,
    chunk_count: Vec<u32>,
    last_dts: Option<i64>,
    first_pts: Option<Ticks>,
    end_pts: Option<Ticks>,
    added_end: Option<Ticks>,
    pending: VecDeque<Pending>,
    pending_end: Ticks,
}

impl WTrack {
    fn new(id: i64, config: Config, timescale: u32) -> Self {
        Self {
            id,
            config,
            timescale,
            clock: Clock::new(timescale.into()),
            dts: Vec::new(),
            cto: Vec::new(),
            dur: Vec::new(),
            size: Vec::new(),
            key: Vec::new(),
            chunk_offset: Vec::new(),
            chunk_count: Vec::new(),
            last_dts: None,
            first_pts: None,
            end_pts: None,
            added_end: None,
            pending: VecDeque::new(),
            pending_end: 0,
        }
    }

    fn is_video(&self) -> bool {
        matches!(self.config, Config::Video { .. })
    }

    fn pending_start(&self) -> Option<Ticks> {
        self.pending.front().map(|p| p.start)
    }
}

/// Writes an MP4 as samples come; see the module documentation for the layout.
pub struct Mp4Writer<S: Sink> {
    sink: S,
    tracks: Vec<WTrack>,
    video: Option<usize>,
    audio: Option<usize>,
    movie_scale: u32,
    pos: u64,
    out: Vec<u8>,
    error: Option<WriteError>,
    pending_bytes: usize,
    finished: bool,
}

const MDAT_AT: u64 = 32;

impl<S: Sink> Mp4Writer<S> {
    /// A writer for a video track, an audio track or both. `timescale` is the video media and movie timescale
    /// (default [`video_timescale`] of the frame rate); the audio media timescale is its sample rate.
    pub fn create(
        video: Option<VideoConfig>,
        audio: Option<AudioConfig>,
        sink: S,
        timescale: Option<u32>,
    ) -> Result<Self, WriteError> {
        let config = |m: &str| Err(WriteError::Config(m.to_string()));
        if video.is_none() && audio.is_none() {
            return config("mp4write.create needs a video or an audio track");
        }
        let mut tracks = Vec::new();
        if let Some(v) = video {
            let (avc, entry) = match parse_codec_string(&v.codec) {
                Some(CodecInfo::Avc { entry, .. }) => (true, entry),
                Some(CodecInfo::Hevc { entry }) => (false, entry),
                _ => return config(&format!("mp4write cannot write video {}", v.codec)),
            };
            if v.description.is_none() {
                return config("mp4write needs the video decoder description (avcC or hvcC)");
            }
            let ts = timescale.filter(|&t| t != 0).unwrap_or_else(|| video_timescale(v.frame_rate));
            tracks.push(WTrack::new(tracks.len() as i64 + 1, Config::Video { cfg: v, avc, entry }, ts));
        }
        if let Some(a) = audio {
            let (opus, object_type) = match parse_codec_string(&a.codec) {
                Some(CodecInfo::Aac { object_type }) => (false, object_type),
                Some(CodecInfo::Opus) => (true, 0),
                _ => return config(&format!("mp4write cannot write audio {}", a.codec)),
            };
            if a.sample_rate == 0 || a.channels == 0 {
                return config("mp4write needs the audio sample rate and channels");
            }
            let ts = a.sample_rate;
            tracks.push(WTrack::new(tracks.len() as i64 + 1, Config::Audio { cfg: a, opus, object_type }, ts));
        }
        let video = tracks.iter().position(WTrack::is_video);
        let audio = tracks.iter().position(|t| !t.is_video());
        let movie_scale = tracks[video.or(audio).unwrap_or(0)].timescale;
        let mut w = Self {
            sink,
            tracks,
            video,
            audio,
            movie_scale,
            pos: 0,
            out: Vec::new(),
            error: None,
            pending_bytes: 0,
            finished: false,
        };
        let mut head = ByteWriter::new();
        head.bx("ftyp", |w| {
            w.str("isom").u32(0x200).str("isom").str("iso2").str("avc1").str("mp41");
        });
        head.u32(1).str("mdat").u64(0);
        w.emit_small(&head.done());
        Ok(w)
    }

    /// Bytes queued so far.
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// The first write the sink refused.
    pub fn error(&self) -> Option<&WriteError> {
        self.error.as_ref()
    }

    /// The sink back, once the file is written.
    pub fn into_sink(self) -> S {
        self.sink
    }

    /// Queues a video sample (in decode order); fails at once after a sink error.
    pub fn add_video(&mut self, sample: Sample) -> Result<(), WriteError> {
        let t = self.video.ok_or(WriteError::NoTrack("video"))?;
        self.add(t, sample)
    }

    /// Queues an audio sample; fails at once after a sink error.
    pub fn add_audio(&mut self, sample: Sample) -> Result<(), WriteError> {
        let t = self.audio.ok_or(WriteError::NoTrack("audio"))?;
        self.add(t, sample)
    }

    fn queue(&mut self, bytes: &[u8], position: Option<u64>) {
        if self.error.is_some() {
            return;
        }
        if let Err(err) = self.sink.write(bytes, position) {
            self.error = Some(WriteError::Sink(Arc::new(err)));
        }
    }

    fn flush_out(&mut self) {
        if self.out.is_empty() {
            return;
        }
        let out = std::mem::take(&mut self.out);
        self.queue(&out, None);
    }

    fn emit_small(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
        if self.out.len() >= OUT_BYTES {
            self.flush_out();
        }
        self.pos += bytes.len() as u64;
    }

    /// Small pieces are gathered into one write; a piece of 2 MB or more goes to the sink as it is.
    fn emit(&mut self, bytes: &[u8]) {
        if bytes.len() >= OUT_BYTES {
            self.flush_out();
            self.queue(bytes, None);
            self.pos += bytes.len() as u64;
        } else {
            self.emit_small(bytes);
        }
    }

    fn stopped(&self) -> Result<(), WriteError> {
        match &self.error {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }

    fn add(&mut self, ti: usize, s: Sample) -> Result<(), WriteError> {
        if self.finished {
            return Err(WriteError::Finished);
        }
        self.stopped()?;
        let t = &mut self.tracks[ti];
        let cto = if t.is_video() { s.composition_offset } else { 0 };
        let pts_u = t.clock.units(s.timestamp);
        let mut dts_u = t.clock.units(s.timestamp - cto);
        if let Some(last) = t.last_dts {
            if dts_u <= last {
                dts_u = last + 1;
            }
            if let Some(d) = t.dur.last_mut() {
                *d = dts_u - last;
            }
        }
        t.dts.push(dts_u);
        t.cto.push(pts_u - dts_u);
        t.dur.push(t.clock.units(s.duration).max(0));
        t.size.push(s.data.len() as u32);
        t.key.push(!t.is_video() || s.key);
        t.last_dts = Some(dts_u);
        t.first_pts = Some(t.first_pts.map_or(s.timestamp, |p| p.min(s.timestamp)));
        let end = s.timestamp + s.duration;
        t.end_pts = Some(t.end_pts.map_or(end, |p| p.max(end)));
        let start = s.timestamp - cto;
        t.pending_end = start + s.duration;
        t.added_end = Some(t.pending_end);
        self.pending_bytes += s.data.len();
        t.pending.push_back(Pending { data: s.data, start, end: start + s.duration });
        self.pump(false);
        self.stopped()
    }

    fn pump(&mut self, last: bool) {
        loop {
            let mut best: Option<(usize, Ticks)> = None;
            for (i, t) in self.tracks.iter().enumerate() {
                if let Some(s) = t.pending_start()
                    && best.is_none_or(|(_, b)| s < b)
                {
                    best = Some((i, s));
                }
            }
            let Some((bi, start)) = best else { return };
            if !last && self.pending_bytes <= MAX_PENDING {
                if self.tracks[bi].pending_end - start < CHUNK {
                    return;
                }
                let waits = self
                    .tracks
                    .iter()
                    .enumerate()
                    .any(|(i, o)| i != bi && o.pending.is_empty() && o.added_end.is_none_or(|e| e < start));
                if waits {
                    return;
                }
            }
            self.write_chunk(bi);
        }
    }

    fn write_chunk(&mut self, ti: usize) {
        let t = &mut self.tracks[ti];
        let first_start = t.pending[0].start;
        let mut n = 0;
        while n < t.pending.len() && (n == 0 || t.pending[n - 1].end - first_start < CHUNK) {
            n += 1;
        }
        t.chunk_offset.push(self.pos);
        t.chunk_count.push(n as u32);
        let bytes: usize = t.pending.iter().take(n).map(|p| p.data.len()).sum();
        let parts = t.pending.drain(..n);
        // Small samples are copied into the output buffer as one piece; big ones go to the sink as they are.
        if bytes < OUT_BYTES {
            for p in parts {
                self.out.extend_from_slice(&p.data);
            }
            if self.out.len() >= OUT_BYTES {
                self.flush_out();
            }
            self.pos += bytes as u64;
        } else {
            let parts: Vec<Pending> = parts.collect();
            for p in &parts {
                self.emit(&p.data);
            }
        }
        self.pending_bytes -= bytes;
    }

    /// Writes what is left, the moov and the mdat size; returns the file size.
    pub fn finish(&mut self) -> Result<u64, WriteError> {
        if self.finished {
            return Err(WriteError::FinishedTwice);
        }
        self.stopped()?;
        self.pump(true);
        self.flush_out();
        let mdat_size = self.pos - MDAT_AT;
        let moov = build_moov(&self.tracks, self.movie_scale)?;
        self.emit(&moov);
        self.flush_out();
        self.queue(&mdat_size.to_be_bytes(), Some(MDAT_AT + 8));
        self.finished = true;
        self.stopped()?;
        Ok(self.pos)
    }
}

// ---- moov ------------------------------------------------------------------------------------------------------------

struct Layout {
    n: usize,
    media_duration: i64,
    empty: i64,
    media_time: i64,
    segment: i64,
    edit: bool,
    duration: i64,
    max_size: i64,
    avg_bitrate: i64,
    max_bitrate: i64,
}

fn track_layout(t: &WTrack, movie_scale: u32) -> Layout {
    let n = t.dts.len();
    let base = t.dts.first().copied().unwrap_or(0);
    let media_duration: i64 = t.dur.iter().sum();
    let to_movie = Clock::new(movie_scale.into());
    let start = if n > 0 { t.first_pts.unwrap_or(0).max(0) } else { 0 };
    let media_time = if n > 0 { t.clock.units(start) - base } else { 0 };
    let segment = if n > 0 { to_movie.units(t.end_pts.unwrap_or(0) - start).max(0) } else { 0 };
    let empty = to_movie.units(start);
    let bytes: i64 = t.size.iter().map(|&s| i64::from(s)).sum();
    let max_size = t.size.iter().copied().max().unwrap_or(0).into();
    // The busiest second, for btrt and esds. Decode times only go up, so each second's samples are together.
    let (mut peak, mut second, mut sum) = (0, None, 0);
    for (d, &s) in t.dts.iter().zip(&t.size) {
        let k = (d - base).div_euclid(t.timescale.into());
        if second != Some(k) {
            (second, sum) = (Some(k), 0);
        }
        sum += i64::from(s);
        peak = peak.max(sum);
    }
    let seconds = media_duration as f64 / f64::from(t.timescale);
    Layout {
        n,
        media_duration,
        empty,
        media_time,
        segment,
        edit: empty > 0 || media_time != 0,
        duration: empty + segment,
        max_size,
        avg_bitrate: if seconds > 0.0 { (js_round(bytes as f64 * 8.0 / seconds) as i64).min(U32) } else { 0 },
        max_bitrate: (peak * 8).min(U32),
    }
}

fn build_moov(tracks: &[WTrack], movie_scale: u32) -> Result<Vec<u8>, FormatError> {
    let layouts: Vec<Layout> = tracks.iter().map(|t| track_layout(t, movie_scale)).collect();
    let movie_duration = layouts.iter().map(|l| l.duration).fold(0, i64::max);
    let mut w = ByteWriter::with_capacity(1 << 16);
    let mut failed = None;
    w.bx("moov", |w| {
        let v = u8::from(movie_duration > U32);
        w.full("mvhd", v, 0, |w| {
            if v == 1 {
                w.u64(0).u64(0).u32(movie_scale.into()).u64(movie_duration);
            } else {
                w.u32(0).u32(0).u32(movie_scale.into()).u32(movie_duration);
            }
            w.u32(0x10000).u16(0x100).zeros(10);
            for m in MATRIX {
                w.u32(m);
            }
            w.zeros(24).u32(tracks.len() as i64 + 1);
        });
        for (t, l) in tracks.iter().zip(&layouts) {
            if let Err(e) = write_trak(w, t, l) {
                failed.get_or_insert(e);
            }
        }
    });
    match failed {
        Some(e) => Err(e),
        None => Ok(w.done()),
    }
}

fn write_trak(w: &mut ByteWriter, t: &WTrack, l: &Layout) -> Result<(), FormatError> {
    let video = t.is_video();
    let mut result = Ok(());
    w.bx("trak", |w| {
        let tv = u8::from(l.duration > U32);
        w.full("tkhd", tv, 3, |w| {
            if tv == 1 {
                w.u64(0).u64(0).u32(t.id).u32(0).u64(l.duration);
            } else {
                w.u32(0).u32(0).u32(t.id).u32(0).u32(l.duration);
            }
            w.zeros(8).u16(0).u16(0).u16(if video { 0 } else { 0x100 }).u16(0);
            for m in MATRIX {
                w.u32(m);
            }
            let (width, height) = match &t.config {
                Config::Video { cfg, .. } => (i64::from(cfg.width), i64::from(cfg.height)),
                Config::Audio { .. } => (0, 0),
            };
            w.u32(width * 65536).u32(height * 65536);
        });
        if l.edit {
            let ev = u8::from(l.segment > U32 || l.empty > U32 || l.media_time > 0x7fff_ffff);
            w.bx("edts", |w| {
                w.full("elst", ev, 0, |w| {
                    w.u32(i64::from(l.empty > 0) + 1);
                    let mut entry = |dur: i64, media: i64| {
                        if ev == 1 {
                            let (hi, lo) = if media < 0 { (U32, U32) } else { (media.div_euclid(1 << 32), media) };
                            w.u64(dur).u32(hi).u32(lo);
                        } else {
                            w.u32(dur).u32(media);
                        }
                        w.u16(1).u16(0);
                    };
                    if l.empty > 0 {
                        entry(l.empty, -1);
                    }
                    entry(l.segment, l.media_time);
                });
            });
        }
        w.bx("mdia", |w| {
            let mv = u8::from(l.media_duration > U32);
            w.full("mdhd", mv, 0, |w| {
                if mv == 1 {
                    w.u64(0).u64(0).u32(t.timescale.into()).u64(l.media_duration);
                } else {
                    w.u32(0).u32(0).u32(t.timescale.into()).u32(l.media_duration);
                }
                w.u16(0x55c4).u16(0);
            });
            w.full("hdlr", 0, 0, |w| {
                w.u32(0).str(if video { "vide" } else { "soun" }).zeros(12);
                w.str(if video { "VideoHandler" } else { "SoundHandler" }).u8(0);
            });
            w.bx("minf", |w| {
                if video {
                    w.full("vmhd", 0, 1, |w| {
                        w.zeros(8);
                    });
                } else {
                    w.full("smhd", 0, 0, |w| {
                        w.zeros(4);
                    });
                }
                w.bx("dinf", |w| {
                    w.full("dref", 0, 0, |w| {
                        w.u32(1).full("url ", 0, 1, |_| {});
                    });
                });
                w.bx("stbl", |w| result = write_stbl(w, t, l));
            });
        });
    });
    result
}

fn sample_entry(w: &mut ByteWriter, t: &WTrack, l: &Layout) -> Result<(), FormatError> {
    let btrt = |w: &mut ByteWriter| {
        w.bx("btrt", |w| {
            w.u32(l.max_size).u32(l.max_bitrate).u32(l.avg_bitrate);
        });
    };
    match &t.config {
        Config::Video { cfg, avc, entry } => {
            w.bx(entry, |w| {
                w.zeros(6).u16(1).zeros(16).u16(cfg.width.into()).u16(cfg.height.into());
                w.u32(0x48_0000).u32(0x48_0000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff);
                w.bx(if *avc { "avcC" } else { "hvcC" }, |w| {
                    w.bytes(cfg.description.as_deref().unwrap_or(&[]));
                });
                if let Some(cs) = &cfg.color_space {
                    let k = codes_from_color(Some(cs));
                    w.bx("colr", |w| {
                        w.str("nclx").u16(k.primaries.into()).u16(k.transfer.into()).u16(k.matrix.into());
                        w.u8(if k.full_range { 0x80 } else { 0 });
                    });
                }
                btrt(w);
            });
        }
        Config::Audio { cfg, opus: true, .. } => {
            let dops = match &cfg.description {
                Some(d) => dops_from_opus_head(d)?,
                None => dops_from_opus_head(&build_opus_head(&OpusHead {
                    channels: cfg.channels as u8,
                    input_rate: cfg.sample_rate,
                    ..OpusHead::default()
                }))?,
            };
            w.bx("Opus", |w| {
                w.zeros(6).u16(1).zeros(8).u16(cfg.channels.into()).u16(16).u32(0).u32(48000 * 65536);
                w.bx("dOps", |w| {
                    w.bytes(&dops);
                });
                btrt(w);
            });
        }
        Config::Audio { cfg, object_type, .. } => {
            let asc = match &cfg.description {
                Some(d) => d.clone(),
                None => build_audio_specific_config((*object_type).into(), cfg.sample_rate.into(), cfg.channels.into()),
            };
            let rate_field = if cfg.sample_rate <= 65535 { i64::from(cfg.sample_rate) * 65536 } else { 0 };
            w.bx("mp4a", |w| {
                w.zeros(6).u16(1).zeros(8).u16(cfg.channels.into()).u16(16).u32(0).u32(rate_field);
                w.full("esds", 0, 0, |w| {
                    descriptor(w, 3, |es| {
                        es.u16(0).u8(0);
                        descriptor(es, 4, |dc| {
                            dc.u8(0x40).u8(0x15).u24(l.max_size.min(0xff_ffff)).u32(l.max_bitrate).u32(l.avg_bitrate);
                            descriptor(dc, 5, |d| {
                                d.bytes(&asc);
                            });
                        });
                        descriptor(es, 6, |sl| {
                            sl.u8(2);
                        });
                    });
                });
                btrt(w);
            });
        }
    }
    Ok(())
}

/// An MPEG-4 descriptor: its tag, its length in 7-bit groups, and what `body` writes.
fn descriptor(w: &mut ByteWriter, tag: i64, body: impl FnOnce(&mut ByteWriter)) {
    let mut inner = ByteWriter::new();
    body(&mut inner);
    let inner = inner.done();
    w.u8(tag);
    let mut groups = Vec::new();
    let mut v = inner.len();
    loop {
        groups.push((v & 127) as i64);
        v /= 128;
        if v == 0 {
            break;
        }
    }
    groups.reverse();
    let last = groups.len() - 1;
    for (i, g) in groups.into_iter().enumerate() {
        w.u8(g | if i < last { 0x80 } else { 0 });
    }
    w.bytes(&inner);
}

/// Runs of equal values: `(count, value)`.
fn runs(values: &[i64]) -> Vec<(i64, i64)> {
    let mut out: Vec<(i64, i64)> = Vec::new();
    for &v in values {
        match out.last_mut() {
            Some(last) if last.1 == v => last.0 += 1,
            _ => out.push((1, v)),
        }
    }
    out
}

fn write_stbl(w: &mut ByteWriter, t: &WTrack, l: &Layout) -> Result<(), FormatError> {
    let n = l.n;
    let mut entry = Ok(());
    w.full("stsd", 0, 0, |w| {
        w.u32(1);
        entry = sample_entry(w, t, l);
    });
    entry?;
    let stts = runs(&t.dur);
    w.full("stts", 0, 0, |w| {
        w.u32(stts.len() as i64);
        for (k, v) in &stts {
            w.u32(*k).u32(*v);
        }
    });
    if t.cto.iter().any(|&c| c != 0) {
        let ctts = runs(&t.cto);
        w.full("ctts", u8::from(t.cto.iter().any(|&c| c < 0)), 0, |w| {
            w.u32(ctts.len() as i64);
            for (k, v) in &ctts {
                w.u32(*k).u32(*v);
            }
        });
    }
    if t.is_video() {
        let keys = t.key.iter().filter(|&&k| k).count();
        if keys < n {
            w.full("stss", 0, 0, |w| {
                w.u32(keys as i64);
                for (i, _) in t.key.iter().enumerate().filter(|(_, k)| **k) {
                    w.u32(i as i64 + 1);
                }
            });
        }
    }
    let uniform = n > 0 && t.size.iter().all(|&s| s == t.size[0]);
    w.full("stsz", 0, 0, |w| {
        w.u32(if uniform { t.size[0].into() } else { 0 }).u32(n as i64);
        if !uniform {
            for &s in &t.size {
                w.u32(s.into());
            }
        }
    });
    let mut stsc: Vec<(i64, u32)> = Vec::new();
    for (c, &k) in t.chunk_count.iter().enumerate() {
        if stsc.last().is_none_or(|last| last.1 != k) {
            stsc.push((c as i64 + 1, k));
        }
    }
    w.full("stsc", 0, 0, |w| {
        w.u32(stsc.len() as i64);
        for (first, k) in &stsc {
            w.u32(*first).u32((*k).into()).u32(1);
        }
    });
    w.full("co64", 0, 0, |w| {
        w.u32(t.chunk_offset.len() as i64);
        for &o in &t.chunk_offset {
            w.u64(o as i64);
        }
    });
    Ok(())
}
