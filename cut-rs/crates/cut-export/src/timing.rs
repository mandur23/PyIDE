//! Where an export's time went: each stage's thread adds the time it spent in each step, so a report shows which
//! stage was busy all along (the limit) and which ones waited for it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// One step of an export, on the thread that does it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// From the start to the first frame: checks, the sound's setup, the part file (`SoundLoad` included).
    Prepare,
    /// Opening and decoding the sound sources before the first frame, and measuring the loudness.
    SoundLoad,
    /// The engine's render call: waiting for the sources' decoded frames, recording and submitting the composite.
    Render,
    /// Recording and submitting the RGB to NV12 pass and its copy to a read-back buffer.
    Convert,
    /// The encoder's thread waiting for the GPU to finish a picture and map its NV12.
    ReadBack,
    /// The renderer waiting for the encoder to take a picture or give a read-back frame back (the encoder is behind).
    RenderBlocked,
    /// The encoder waiting for a picture (the renderer is behind).
    EncodeIdle,
    /// Handing a mapped picture to the encoder: the copy into its input picture and the wait until it asks for one.
    EncodeIn,
    /// Of `EncodeIn`, the wait until a hardware transform asked for a picture (it was busy encoding).
    EncoderBusy,
    /// Of `EncodeIn`, copying the picture into the encoder's input picture.
    SampleCopy,
    /// Encoded packets to the writer (waiting while its queue is full).
    EncodeOut,
    /// Mixing the sound.
    Mix,
    /// AAC-encoding the sound.
    Aac,
    /// The sound waiting for the picture to catch up.
    SoundPaced,
    /// Muxing samples into the part file.
    Mux,
    /// From the first frame to the last packet written: the stages' wall time.
    Stages,
    /// Renaming the part file over the target.
    Commit,
    /// Moving the index to the front.
    Faststart,
    /// Opening the written file again and checking it.
    Verify,
}

impl Step {
    pub const ALL: [Step; 19] = [
        Step::Prepare,
        Step::SoundLoad,
        Step::Render,
        Step::Convert,
        Step::ReadBack,
        Step::RenderBlocked,
        Step::EncodeIdle,
        Step::EncodeIn,
        Step::EncoderBusy,
        Step::SampleCopy,
        Step::EncodeOut,
        Step::Mix,
        Step::Aac,
        Step::SoundPaced,
        Step::Mux,
        Step::Stages,
        Step::Commit,
        Step::Faststart,
        Step::Verify,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Step::Prepare => "prepare",
            Step::SoundLoad => "soundLoad",
            Step::Render => "render",
            Step::Convert => "convert",
            Step::ReadBack => "readBack",
            Step::RenderBlocked => "renderBlocked",
            Step::EncodeIdle => "encodeIdle",
            Step::EncodeIn => "encodeIn",
            Step::EncoderBusy => "encoderBusy",
            Step::SampleCopy => "sampleCopy",
            Step::EncodeOut => "encodeOut",
            Step::Mix => "mix",
            Step::Aac => "aac",
            Step::SoundPaced => "soundPaced",
            Step::Mux => "mux",
            Step::Stages => "stages",
            Step::Commit => "commit",
            Step::Faststart => "faststart",
            Step::Verify => "verify",
        }
    }
}

/// Seconds spent in each [`Step`].
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Timing([f64; Step::ALL.len()]);

impl Timing {
    pub fn get(&self, s: Step) -> f64 {
        self.0[s as usize]
    }
}

/// The counters the stages add to from their threads.
#[derive(Default)]
pub(crate) struct Clocks([AtomicU64; Step::ALL.len()]);

impl Clocks {
    pub fn add(&self, s: Step, d: Duration) {
        self.0[s as usize].fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
    }

    /// Runs `f`, adding its time to `s`.
    pub fn time<T>(&self, s: Step, f: impl FnOnce() -> T) -> T {
        let t = Instant::now();
        let r = f();
        self.add(s, t.elapsed());
        r
    }

    pub fn read(&self) -> Timing {
        Timing(std::array::from_fn(|i| self.0[i].load(Ordering::Relaxed) as f64 / 1e9))
    }
}
