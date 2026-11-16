//! The sound levels of clips (`clipLevels`, `loudOnTimeline`): each clip's source span read in ten-second blocks
//! into RMS levels of 10 ms windows, kept for the session, and turned into the loud parts of the clip on the
//! timeline. Reading runs on an analysis thread; the cache is the UI thread's.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use cut_audio::analysis::{LevelMeter, loud_ranges, union};
use cut_audio::source::AudioRead;
use cut_model::{Clip, Project};
use cut_time::TICKS;

use super::{Step, Stop};

/// RMS levels of a clip's source span: one a `step` seconds from `start` seconds of the source.
#[derive(Debug, Clone, PartialEq)]
pub struct Levels {
    pub levels: Vec<f32>,
    pub step: f64,
    pub start: f64,
}

/// Levels read, by their cache key.
pub type Measured = Vec<(String, Arc<Levels>)>;

/// A clip's sound to read: the file and the source ticks `[lo, hi)` it shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub key: String,
    pub path: String,
    pub lo: f64,
    pub hi: f64,
}

impl Read {
    /// What `clip` shows of its media (`sourceSpan`), or `None` without media.
    pub fn of(project: &Project, clip: &Clip) -> Option<Read> {
        let m = project.media(clip.media_id()?)?;
        let (lo, hi) = (clip.in_.min(clip.out), clip.in_.max(clip.out));
        let key = format!(
            "{}|{}|{}|{}|{}",
            m.path,
            m.size,
            m.mtime,
            cut_audio::util::js_round(lo),
            cut_audio::util::js_round(hi)
        );
        Some(Read { key, path: m.path.clone(), lo, hi })
    }
}

/// The levels measured this session, by file and span (at most 64, the oldest forgotten first).
#[derive(Default)]
pub struct Cache {
    map: HashMap<String, Arc<Levels>>,
    order: Vec<String>,
}

impl Cache {
    pub fn get(&self, key: &str) -> Option<Arc<Levels>> {
        self.map.get(key).cloned()
    }

    pub fn put(&mut self, key: String, lv: Arc<Levels>) {
        if self.map.insert(key.clone(), lv).is_none() {
            self.order.push(key);
        }
        while self.order.len() > 64 {
            let old = self.order.remove(0);
            self.map.remove(&old);
        }
    }
}

/// Reads a clip's source span in ten-second blocks (`readSound`): `on_block(planes, rate)` for each; `part` is the
/// share of the task's progress it covers -> `(rate, seconds of the first sample)`.
pub fn read_sound(
    read: &Read,
    step: &Step,
    part: (f64, f64),
    mut on_block: impl FnMut(&[&[f32]], f64),
) -> Result<(f64, f64), Stop> {
    // translated on the UI thread: the screen's language belongs to that thread
    let media = || Ok("The clip's media cannot be read.".to_owned());
    let mut r = match cut_audio::Library::default().audio(Path::new(&read.path)) {
        Ok(Some(r)) => r,
        _ => return Err(media()),
    };
    let rate = r.rate();
    let t = TICKS as f64;
    let s0 = ((read.lo / t) * rate).floor().max(0.0) as i64;
    let s1 = (((read.hi / t) * rate).ceil() as i64).min(r.length());
    let block = (rate * 10.0) as i64;
    let mut planes = Vec::new();
    let mut a = s0;
    while a < s1 {
        step.step().map_err(Err)?;
        let e = s1.min(a + block);
        r.read_into(a, e, &mut planes).map_err(|_| media())?;
        let refs: Vec<&[f32]> = planes.iter().map(Vec::as_slice).collect();
        on_block(&refs, rate);
        step.progress(part.0 + (part.1 - part.0) * ((e - s0) as f64 / (s1 - s0).max(1) as f64));
        a = e;
    }
    Ok((rate, s0 as f64 / rate))
}

/// Reads one clip's span into levels; `part` is the share of the task's progress it covers.
pub fn measure(read: &Read, step: &Step, part: (f64, f64)) -> Result<Levels, Stop> {
    let mut meter: Option<LevelMeter> = None;
    let (_, start) = read_sound(read, step, part, |planes, rate| {
        meter.get_or_insert_with(|| LevelMeter::new(rate, 0.01)).push(planes);
    })?;
    Ok(match meter {
        Some(m) => Levels { levels: m.levels(), step: m.step, start },
        None => Levels { levels: Vec::new(), step: 0.01, start },
    })
}

/// The clips' levels: from the cache, else read in turn on the analysis thread -> `(key, levels)` of each.
pub fn measure_all(reads: &[Read], step: &Step) -> Result<Measured, Stop> {
    let n = reads.len().max(1) as f64;
    let mut out = Vec::new();
    for (i, r) in reads.iter().enumerate() {
        let lv = measure(r, step, (i as f64 / n, (i + 1) as f64 / n))?;
        out.push((r.key.clone(), Arc::new(lv)));
    }
    Ok(out)
}

/// The loud parts of `clip` as timeline ranges (ticks), louder than `threshold` dBFS (`loudOnTimeline`).
pub fn loud_on_timeline(clip: &Clip, lv: &Levels, threshold: f64) -> Vec<(f64, f64)> {
    let t = TICKS as f64;
    let list: Vec<(f64, f64)> = loud_ranges(&lv.levels, lv.step, threshold)
        .into_iter()
        .map(|(a, b)| {
            let (x, y) = (clip.timeline_time((lv.start + a) * t), clip.timeline_time((lv.start + b) * t));
            match (x, y) {
                (Some(x), Some(y)) => (x.min(y), x.max(y)),
                _ => (0.0, 0.0),
            }
        })
        .collect();
    union(&list)
}

/// A clip's place on the timeline as a range.
pub fn span(c: &Clip) -> (f64, f64) {
    (c.start as f64, c.end() as f64)
}
