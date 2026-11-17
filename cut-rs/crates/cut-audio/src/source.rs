//! Where the mixer's sound comes from: a source gives all of it at once ([`Audio::Whole`]) or a reader of sample
//! ranges ([`AudioRead`], the default for files), as the JavaScript's `getAudio` gives `{rate, data}` or
//! `{rate, length, read}`.
//!
//! [`open_track`] reads a file's first audio track on demand the way `decoder.audioReader` does: raw PCM of every
//! flavour through `cut_formats`' `pcm_to_float`, AAC, MP3, FLAC and Opus through Media Foundation (`cut_decode`),
//! each read decoding [`PREROLL`] packets (and at least the track's own pre-roll, Opus's 80 ms) before the range and
//! dropping them, so an AAC frame's overlap, an MP3 frame's bit reservoir and an Opus decoder's state are whole at
//! the window's edge. Opened files are kept ([`Library`]), so the mixer, the peaks and the
//! meters probe a file once.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use cut_formats::probe::{read_samples, sample_at_time};
use cut_formats::{FileReader, Kind, Media, Reader, Track};

/// The bytes of a file a track reader reads from (a file on disk, or bytes in memory).
pub type Bytes = Arc<dyn Reader + Send + Sync>;
use cut_time::{TICKS, from_seconds};

use crate::util::js_round;

/// Why a source could not be read; the message is what the mixer's `failures()` reports.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AudioError {
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Damaged(String),
    #[error("{0}")]
    Missing(String),
    #[error("{0}")]
    Io(String),
}

impl AudioError {
    /// The JavaScript's error code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported(_) => "unsupported",
            Self::Damaged(_) => "damaged",
            Self::Missing(_) => "missing",
            Self::Io(_) => "io",
        }
    }
}

impl From<cut_formats::FormatError> for AudioError {
    fn from(e: cut_formats::FormatError) -> Self {
        Self::Damaged(e.to_string())
    }
}

impl From<cut_decode::DecodeError> for AudioError {
    fn from(e: cut_decode::DecodeError) -> Self {
        match e {
            cut_decode::DecodeError::Unsupported(m) => Self::Unsupported(m),
            other => Self::Damaged(other.to_string()),
        }
    }
}

/// A source's sound read on demand.
pub trait AudioRead {
    /// Samples a second of what `read` returns.
    fn rate(&self) -> f64;
    /// Samples of the whole source at `rate`.
    fn length(&self) -> i64;
    /// Samples `[from, to)`, a buffer a channel of exactly `to - from` samples, zeros where the source has none.
    fn read(&mut self, from: i64, to: i64) -> Result<Vec<Vec<f32>>, AudioError>;

    /// [`Self::read`] into `out`, whose buffers are reused (a loop over a long file allocates them once).
    fn read_into(&mut self, from: i64, to: i64, out: &mut Vec<Vec<f32>>) -> Result<(), AudioError> {
        *out = self.read(from, to)?;
        Ok(())
    }
}

/// What a source gives the mixer.
pub enum Audio {
    /// All of it in memory: a buffer a channel at `rate`.
    Whole { rate: f64, data: Vec<Vec<f32>> },
    /// Read on demand.
    Reader(Box<dyn AudioRead + Send>),
}

/// Packets decoded before a read's first one and dropped.
pub const PREROLL: usize = 12;

/// Whether this PC plays sound of a codec string: raw PCM, ALAC and Vorbis always; AAC, MP3, FLAC and Opus when
/// Media Foundation lists a decoder for them (asked once a codec).
pub fn decodes(codec: &str) -> bool {
    codec.starts_with("pcm-") || cut_decode::decodes_audio(codec)
}

/// A file's audio track read on demand.
pub struct TrackReader {
    reader: Bytes,
    track: Arc<Track>,
    rate: f64,
    channels: usize,
    length: i64,
}

/// Decoded blocks of samples `[i0, i1)`: each block's start in seconds and its samples a channel.
type Pieces = Vec<(f64, Vec<Vec<f32>>)>;

fn decode(
    reader: &(dyn Reader + Send + Sync),
    track: &Track,
    i0: usize,
    i1: usize,
) -> Result<(f64, usize, Pieces), AudioError> {
    let Media::Audio(a) = &track.media else { return Err(AudioError::Unsupported("not an audio track".into())) };
    if track.codec.starts_with("pcm-") {
        let mut pieces = Vec::new();
        let mut failed = None;
        read_samples(reader, track, i0, i1, |i, bytes| {
            match cut_formats::codecs::pcm::pcm_to_float(bytes, &track.codec, a.channels as usize) {
                Ok(p) => pieces.push((track.samples.pts[i] as f64 / TICKS as f64, p)),
                Err(e) => failed = Some(e),
            }
        })?;
        if let Some(e) = failed {
            return Err(e.into());
        }
        return Ok((f64::from(a.sample_rate), a.channels as usize, pieces));
    }
    if !cut_decode::decodes_audio(&track.codec) {
        return Err(AudioError::Unsupported(cut_decode::audio_refusal(&track.codec).into()));
    }
    let b = cut_decode::decode_audio_samples(reader, track, i0, i1)?;
    Ok((f64::from(b.rate), b.channels as usize, b.pieces))
}

impl TrackReader {
    /// A reader of `track` of a file; its rate and channels are what the decoder gives for the first packets (HE-AAC
    /// doubles the track's rate).
    pub fn new(reader: Bytes, track: Arc<Track>, duration: i64) -> Result<Self, AudioError> {
        let Media::Audio(a) = &track.media else { return Err(AudioError::Unsupported("not an audio track".into())) };
        let n = track.samples.count();
        let (rate, channels) = if n > 0 && !track.codec.starts_with("pcm-") {
            let (r, c, _) = decode(&*reader, &track, 0, n.min(2))?;
            (r, c)
        } else {
            (f64::from(a.sample_rate), a.channels as usize)
        };
        let seconds = (if track.duration > 0 { track.duration } else { duration }) as f64 / TICKS as f64;
        let length = js_round(seconds * rate) as i64;
        Ok(Self { reader, track, rate, channels: channels.max(1), length })
    }

    pub fn channels(&self) -> usize {
        self.channels
    }
}

impl AudioRead for TrackReader {
    fn rate(&self) -> f64 {
        self.rate
    }

    fn length(&self) -> i64 {
        self.length
    }

    fn read(&mut self, from: i64, to: i64) -> Result<Vec<Vec<f32>>, AudioError> {
        let mut out = Vec::new();
        self.read_into(from, to, &mut out)?;
        Ok(out)
    }

    fn read_into(&mut self, from: i64, to: i64, out: &mut Vec<Vec<f32>>) -> Result<(), AudioError> {
        let len = (to - from).max(0) as usize;
        out.resize_with(self.channels, Vec::new);
        for o in out.iter_mut() {
            o.clear();
            o.resize(len, 0.0);
        }
        let count = self.track.samples.count();
        if count == 0 || to <= from || to <= 0 || from >= self.length {
            return Ok(());
        }
        let at = |t: i64| sample_at_time(&self.track, from_seconds(t as f64 / self.rate)).unwrap_or(0);
        // PCM needs no packets before the first one read (each is whole on its own) nor more than the one holding
        // `to`: decoding a 10 s window of a WAV read 12 s of pre-roll and 2 s past it before.
        let pcm = self.track.codec.starts_with("pcm-");
        let (ia, ib) = if pcm {
            (at(from.max(0)), count.min(at(to) + 1))
        } else {
            let pre_roll =
                sample_at_time(&self.track, from_seconds(from.max(0) as f64 / self.rate) - self.track.pre_roll);
            (at(from.max(0)).saturating_sub(PREROLL).min(pre_roll.unwrap_or(0)), count.min(at(to) + 2))
        };
        let (_, _, pieces) = decode(&*self.reader, &self.track, ia, ib)?;
        for (t, planes) in pieces {
            let at = js_round(t * self.rate) as i64 - from;
            for (c, o) in out.iter_mut().enumerate() {
                let Some(src) = planes.get(c.min(planes.len().saturating_sub(1))) else { continue };
                let skip = (-at).max(0);
                let n = (src.len() as i64 - skip).min(o.len() as i64 - at.max(0));
                if n > 0 {
                    let (s, d) = (skip as usize, at.max(0) as usize);
                    o[d..d + n as usize].copy_from_slice(&src[s..s + n as usize]);
                }
            }
        }
        Ok(())
    }
}

/// An opened file: its reader and first audio track (or none).
#[derive(Clone)]
pub struct Opened {
    pub reader: Bytes,
    pub track: Option<Arc<Track>>,
    pub duration: i64,
}

/// Opened files kept by path, size and modification time, so a file is probed once (an MP3's frame scan reads all of
/// it). Shared by threads.
#[derive(Default, Clone)]
pub struct Library {
    files: Arc<Mutex<HashMap<String, Opened>>>,
}

fn stamp(path: &Path) -> Result<String, AudioError> {
    let meta = std::fs::metadata(path).map_err(|e| AudioError::Missing(format!("{}: {e}", path.display())))?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    Ok(format!("{}|{}|{}", path.display(), meta.len(), mtime.map_or(0, |d| d.as_nanos())))
}

impl Library {
    /// The file opened (probed once while it does not change).
    pub fn open(&self, path: &Path) -> Result<Opened, AudioError> {
        let key = stamp(path)?;
        if let Some(o) = self.files.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return Ok(o.clone());
        }
        let reader = FileReader::open(path).map_err(|e| AudioError::Missing(format!("{}: {e}", path.display())))?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let source = cut_formats::probe::open(&reader, &name);
        if let Some(e) = source.error {
            return Err(AudioError::Damaged(e.to_string()));
        }
        let track = source.tracks.into_iter().find(|t| t.kind() == Kind::Audio).map(Arc::new);
        let o = Opened { reader: Arc::new(reader) as Bytes, track, duration: source.duration };
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        if files.len() >= 256 {
            files.clear();
        }
        files.insert(key, o.clone());
        Ok(o)
    }

    /// The first audio track of a file as a reader, `None` for a file without sound.
    pub fn audio(&self, path: &Path) -> Result<Option<TrackReader>, AudioError> {
        let o = self.open(path)?;
        o.track.map(|t| TrackReader::new(o.reader, t, o.duration)).transpose()
    }
}
