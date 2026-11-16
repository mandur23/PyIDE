//! "The frame shown at source time t" over one decoder: the engine's `frameAt` (section 8, "Cut.decoder").
//!
//! A run feeds samples in decode order from a sync sample. The frame for `t` is the sample with the last pts at or
//! before it (`probe::sample_at_time`). A request the run can reach by decoding forward continues it; one before what
//! the run has shown, or past a later sync sample than the run has fed, flushes the decoder and starts again at
//! `probe::key_before`. Frame caching beyond the frame shown is the engine's.

use cut_formats::probe::{key_before, read_sample, sample_at_time};
use cut_formats::{Reader, Track};
use cut_time::Ticks;

use crate::error::{DecodeError, Result};
use crate::video::{Accel, Frame, VideoDecoder};

/// How much work a [`FrameSource`] did, for tests and the engine's statistics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    /// Runs started at a sync sample (the first one included).
    pub runs: u32,
    /// Samples sent to the decoder.
    pub fed: u64,
    /// Pictures that came out.
    pub decoded: u64,
}

/// The frames of one video track by presentation time.
pub struct FrameSource<'a, R: Reader + ?Sized> {
    reader: &'a R,
    track: &'a Track,
    accel: Accel,
    decoder: VideoDecoder<'a>,
    /// Presentation rank of each sample.
    rank: Vec<u32>,
    /// The next sample to feed, while a run is on.
    next: Option<usize>,
    drained: bool,
    current: Option<Frame>,
    stats: Stats,
}

impl<'a, R: Reader + ?Sized> FrameSource<'a, R> {
    /// A frame source for `track` of the file `reader` reads.
    pub fn new(reader: &'a R, track: &'a Track, accel: Accel) -> Result<Self> {
        let decoder = VideoDecoder::new(track, accel)?;
        let s = &track.samples;
        let mut rank = vec![0; s.count()];
        for (r, &i) in s.order.iter().enumerate() {
            rank[i as usize] = r as u32;
        }
        Ok(Self {
            reader,
            track,
            accel,
            decoder,
            rank,
            next: None,
            drained: false,
            current: None,
            stats: Stats::default(),
        })
    }

    /// The decoder in use.
    pub fn decoder(&self) -> &VideoDecoder<'a> {
        &self.decoder
    }

    /// The work done so far.
    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// The sample `frame_at(t)` shows (callers skip a frame they already have).
    pub fn sample_at(&self, t: Ticks) -> Option<usize> {
        sample_at_time(self.track, t)
    }

    fn restart(&mut self, goal: usize) -> Result<()> {
        self.decoder.flush()?;
        self.current = None;
        self.drained = false;
        self.next = key_before(self.track, goal as i64);
        self.stats.runs += 1;
        Ok(())
    }

    fn reachable(&self, goal: usize) -> bool {
        let Some(next) = self.next else { return false };
        let g = self.rank[goal];
        let behind = self.current.as_ref().is_some_and(|c| self.rank[c.sample] > g);
        let jump = key_before(self.track, goal as i64).is_some_and(|k| k > next);
        !behind && !jump
    }

    /// The frame shown at source time `t`.
    pub fn frame_at(&mut self, t: Ticks) -> Result<&Frame> {
        self.frame_at_showing(t, |_, _| {})
    }

    /// The frame shown at source time `t`; `early` sees each picture decoded on the way to it as soon as it is out,
    /// with `true` for the first picture of a run started at a sync sample (a caller can show that one meanwhile,
    /// and keep the others for a playhead going backwards).
    pub fn frame_at_showing(&mut self, t: Ticks, mut early: impl FnMut(&Frame, bool)) -> Result<&Frame> {
        match self.seek(t, &mut early) {
            Err(DecodeError::OutOfOrder) => {
                self.decoder = VideoDecoder::with_latency(self.track, self.accel, Some(false))?;
                self.next = None;
                self.current = None;
                self.seek(t, &mut early)?;
            }
            r => r?,
        }
        self.current.as_ref().ok_or_else(|| DecodeError::Damaged(format!("no picture at {t}")))
    }

    /// Leaves the frame for `t` in `current`.
    fn seek(&mut self, t: Ticks, early: &mut dyn FnMut(&Frame, bool)) -> Result<()> {
        let goal =
            sample_at_time(self.track, t).ok_or_else(|| DecodeError::Damaged("the track has no samples".into()))?;
        if self.current.as_ref().is_some_and(|c| c.sample == goal) {
            return Ok(());
        }
        let mut fresh = false;
        if !self.reachable(goal) {
            self.restart(goal)?;
            fresh = true;
        }
        let g = self.rank[goal];
        let count = self.track.samples.count();
        loop {
            while let Some(f) = self.decoder.receive()? {
                self.stats.decoded += 1;
                let r = self.rank[f.sample];
                if r < g {
                    early(&f, std::mem::take(&mut fresh));
                    self.current = Some(f);
                } else if r == g || self.current.is_none() {
                    // A missing picture (an undecodable leading one) shows the next that came.
                    self.current = Some(f);
                    return Ok(());
                } else {
                    self.stats.decoded -= 1;
                    self.decoder.unreceive(f);
                    return Ok(());
                }
            }
            match self.next {
                Some(i) if i < count => {
                    let bytes = read_sample(self.reader, self.track, i)?;
                    self.decoder.send(i, &bytes)?;
                    self.next = Some(i + 1);
                    self.stats.fed += 1;
                }
                _ if !self.drained => {
                    self.decoder.finish()?;
                    self.drained = true;
                }
                _ if self.current.is_some() => return Ok(()),
                _ => return Err(DecodeError::Damaged(format!("the decoder gave no picture for sample {goal}"))),
            }
        }
    }
}
