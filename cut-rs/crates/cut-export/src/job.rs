//! What one export is asked to do (`Cut.export.run`'s options), what it reports while it runs, and what it gives back.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use cut_audio::GetAudio;
use cut_model::{Id, Project};
use cut_time::Ticks;

use crate::presets::Settings;
use crate::sink::Journal;
use crate::timing::Timing;
use crate::verify::Verified;

/// Which video encoders to try.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Hardware {
    /// The GPUs' encoders first, then software.
    #[default]
    Auto,
    Hardware,
    Software,
}

/// What happens to the sequence's captions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionMode {
    /// Burned into the picture.
    Burn,
    /// An SRT file beside the video.
    Srt,
    Both,
}

/// One export.
pub struct Job {
    /// A copy of the project as it was when the export started: edits made meanwhile never reach it.
    pub project: Arc<Project>,
    pub seq: Id,
    /// The file; its extension is replaced with the settings' (`mp4` or `m4a`).
    pub path: PathBuf,
    pub settings: Settings,
    /// `[in, out)` in sequence ticks, or the whole sequence.
    pub range: Option<(Ticks, Ticks)>,
    pub captions: Option<CaptionMode>,
    /// The caption track burned in (default the first).
    pub caption_track: Option<Id>,
    pub hardware: Hardware,
    /// The video encoders to try, in order, instead of those `hardware` picks (the benchmark tries each one).
    pub encoders: Option<Vec<cut_decode::encode::EncoderInfo>>,
    /// dB on top of the sequence's master gain.
    pub master_gain: f64,
    /// Open the written file again and check it.
    pub verify: bool,
    /// Where the sound of a media file comes from.
    pub get_audio: GetAudio,
    /// The GPU to render on (the app's device), or `None` for a device of the export's own.
    pub gpu: Option<(wgpu::Device, wgpu::Queue)>,
    /// Told about the part file while it exists.
    pub journal: Option<Arc<dyn Journal>>,
    /// A frame the decoder has not given after this long fails the export (`decode`).
    pub frame_limit: Duration,
    /// The part file refuses writes past this many bytes, as a full disk does (the tests' full disk).
    pub disk_limit: Option<u64>,
    /// While it holds true the render waits before its next frame (the JavaScript's `gate`: a proxy pauses while
    /// playback runs).
    pub gate: Option<Arc<AtomicBool>>,
    /// The name of a speaker without one in the SRT files, `{n}` its place in the list (`tr('Speaker {n}')`).
    pub speaker_label: String,
}

impl Job {
    /// A job with the defaults `run` uses for what `opts` leaves out.
    pub fn new(project: Arc<Project>, seq: Id, path: PathBuf, settings: Settings, get_audio: GetAudio) -> Self {
        Self {
            project,
            seq,
            path,
            settings,
            range: None,
            captions: None,
            caption_track: None,
            hardware: Hardware::Auto,
            encoders: None,
            master_gain: 0.0,
            verify: true,
            get_audio,
            gpu: None,
            journal: None,
            frame_limit: Duration::from_secs(60),
            disk_limit: None,
            gate: None,
            speaker_label: "Speaker {n}".into(),
        }
    }
}

/// The step an export is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Reading and measuring the sound (and, without a picture, encoding it).
    Audio,
    Video,
    /// Writing the index and moving it to the front.
    Finish,
    Verify,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Audio => "audio",
            Phase::Video => "video",
            Phase::Finish => "finish",
            Phase::Verify => "verify",
        }
    }
}

/// A progress report (`onProgress`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    pub phase: Phase,
    /// Frames (or, without a picture, seconds of sound) done and in all.
    pub done: u64,
    pub total: u64,
    pub fraction: f64,
    /// Seconds since the export started, and the seconds still to go.
    pub elapsed: f64,
    pub eta: Option<f64>,
    /// Seconds of the sequence encoded a second.
    pub speed: f64,
}

/// The encoder that wrote the video.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderUsed {
    /// The settings' codec string.
    pub codec: String,
    /// The transform, with its GPU.
    pub name: String,
    pub hardware: bool,
}

/// A finished export.
#[derive(Debug, Clone, PartialEq)]
pub struct Done {
    pub path: PathBuf,
    pub bytes: u64,
    pub seconds: f64,
    /// Seconds of the sequence a second of export.
    pub speed: f64,
    pub frames: u64,
    pub range: (Ticks, Ticks),
    pub verified: Option<Verified>,
    /// Clips whose media was offline: drawn as the red picture and silent.
    pub offline: Vec<Id>,
    pub encoder: Option<EncoderUsed>,
    /// The AAC priming taken out, in samples, and the bitrate used.
    pub audio_delay: Option<i64>,
    pub audio_bitrate: Option<u32>,
    /// dB the loudness target added.
    pub loudness_gain: f64,
    pub sidecars: Vec<PathBuf>,
    pub faststart: bool,
    /// Pixels a second the video took (what the next estimate uses), when there is video.
    pub pixels_per_second: Option<f64>,
    /// Where the time went, by step.
    pub timing: Timing,
}
