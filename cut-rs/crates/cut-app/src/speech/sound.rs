//! A media file's sound to a temp file of 16 kHz mono (`writeSound`): read in 10 s blocks, mixed to mono,
//! resampled block by block with the filter's reach read on both sides so the blocks join without a seam, streamed
//! into a [`SoundFiles`] file the servers read. Runs on the analysis thread. Speakers and voice isolation read the same
//! files.

use std::path::Path;

use cut_audio::source::AudioRead;
use cut_sidecar::sound::SoundFiles;

use super::words::RATE;
use crate::auto::{Step, Stop};

/// A sound file written: its id, its length in samples, the source second its first sample is.
#[derive(Debug, Clone, PartialEq)]
pub struct Written {
    pub id: String,
    pub samples: u64,
    pub start: f64,
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Source seconds `[a, b)` of the file at `path` -> a sound file, `None` when the span holds no samples; `on_part`
/// gets the fraction written.
pub fn write_sound(
    files: &SoundFiles,
    path: &Path,
    a: f64,
    b: f64,
    step: &Step,
    mut on_part: impl FnMut(f64),
) -> Result<Option<Written>, Stop> {
    let media = || Ok("The clip's media cannot be read.".to_owned());
    let mut r = match cut_audio::Library::default().audio(path) {
        Ok(Some(r)) => r,
        _ => return Err(media()),
    };
    let rate = r.rate();
    let rate_i = rate.round().max(1.0) as u64;
    let g = gcd(rate_i, RATE as u64);
    let (si, so) = ((rate_i / g) as i64, (RATE as u64 / g) as i64);
    // the resampling filter's reach, so blocks join without a seam
    let margin = si * ((256 + si - 1) / si);
    let s0 = ((a * rate) / si as f64).floor() as i64 * si;
    let s0 = s0.max(0);
    let s1 = r.length().min((b * rate).ceil() as i64);
    if s1 <= s0 {
        return Ok(None);
    }
    let id = files.open().map_err(|e| Ok(e.message()))?;
    let out = (|| {
        let mut samples = 0u64;
        let block = (rate * 10.0) as i64;
        let mut planes = Vec::new();
        let mut x = s0;
        while x < s1 {
            step.step().map_err(Err)?;
            let y = s1.min(x + block);
            let from = (x - margin).max(0);
            r.read_into(from, y + margin, &mut planes).map_err(|_| media())?;
            let len = planes.first().map_or(0, Vec::len);
            let mut mono = vec![0f32; (margin + (y - x) + margin) as usize];
            let lead = if x - from == margin { 0 } else { (margin - (x - from)) as usize };
            let k = planes.len() as f64;
            for p in &planes {
                for i in 0..len.min(mono.len().saturating_sub(lead)) {
                    mono[lead + i] = (f64::from(mono[lead + i]) + f64::from(p[i]) / k) as f32;
                }
            }
            let res = cut_audio::resample::resample(&[mono], rate, RATE as f64).pop().unwrap_or_default();
            let off = (margin * so / si) as usize;
            let n = super::text::js_round((y - x) as f64 * so as f64 / si as f64) as usize;
            let part = &res[off.min(res.len())..(off + n).min(res.len())];
            files.write(&id, part).map_err(|e| Ok(e.message()))?;
            samples += part.len() as u64;
            on_part((y - s0) as f64 / (s1 - s0) as f64);
            x = y;
        }
        Ok(samples)
    })();
    match out {
        Ok(samples) => Ok(Some(Written { id, samples, start: s0 as f64 / rate })),
        Err(e) => {
            files.close(&id);
            Err(e)
        }
    }
}
