//! A source's sound at the mixer's rate, kept in blocks of [`BLOCK_SECONDS`]: one block of all of it when the source
//! gives the whole track, else read on demand with at most [`MAX_BLOCKS`] kept and the least recently used dropped,
//! except the blocks a load in progress reads (pinned).

use std::cell::Cell;
use std::collections::HashMap;

use cut_model::Id;

use crate::resample::{RS_HALF, resample};
use crate::source::{AudioError, AudioRead};
use crate::util::{ceil_i, floor_i};

pub(crate) const BLOCK_SECONDS: i64 = 10;
pub(crate) const MAX_BLOCKS: usize = 48;

/// Stereo samples.
pub(crate) type Stereo = [Vec<f32>; 2];

/// Mono is copied to both channels; more than two channels keep the first two.
pub(crate) fn stereo(mut data: Vec<Vec<f32>>) -> Stereo {
    match data.len() {
        0 => [Vec::new(), Vec::new()],
        1 => {
            let l = data.pop().unwrap_or_default();
            [l.clone(), l]
        }
        _ => {
            data.truncate(2);
            let r = data.pop().unwrap_or_default();
            [data.pop().unwrap_or_default(), r]
        }
    }
}

pub(crate) struct Block {
    pub(crate) data: Stereo,
    pub(crate) used: Cell<u64>,
}

/// Where a store's blocks come from.
pub(crate) enum Origin {
    /// All of it is block 0.
    Whole,
    File(Box<dyn AudioRead + Send>),
    /// The mix of a nested sequence at the mixer's rate.
    Nest(Id),
}

pub(crate) struct Store {
    pub(crate) origin: Origin,
    /// Samples at the mixer's rate.
    pub(crate) length: i64,
    /// Samples a block.
    pub(crate) size: i64,
    pub(crate) blocks: HashMap<i64, Block>,
    pub(crate) pins: HashMap<i64, u32>,
}

/// The use counter blocks and segments are stamped with (least recently used goes first).
#[derive(Default)]
pub(crate) struct Clock(Cell<u64>);

impl Clock {
    pub(crate) fn tick(&self) -> u64 {
        self.0.set(self.0.get() + 1);
        self.0.get()
    }
}

impl Store {
    pub(crate) fn whole(data: Stereo) -> Self {
        let length = data[0].len() as i64;
        let blocks = HashMap::from([(0, Block { data, used: Cell::new(0) })]);
        Self { origin: Origin::Whole, length, size: length.max(1), blocks, pins: HashMap::new() }
    }

    pub(crate) fn reading(origin: Origin, length: i64, rate: f64) -> Self {
        Self { origin, length, size: rate as i64 * BLOCK_SECONDS, blocks: HashMap::new(), pins: HashMap::new() }
    }

    /// Whether its blocks are read on demand.
    pub(crate) fn reads(&self) -> bool {
        !matches!(self.origin, Origin::Whole)
    }

    /// Block indexes `[a, b)` covering samples `[k0, k1)`, inside the store's length.
    pub(crate) fn block_range(&self, k0: i64, k1: i64) -> (i64, i64) {
        let a = k0.max(0).div_euclid(self.size).max(0);
        let b =
            ceil_i(self.length as f64 / self.size as f64).min(ceil_i(self.length.min(k1) as f64 / self.size as f64));
        (a, b)
    }

    /// Whether samples `[k0, k1)` are all in memory; marks their blocks used.
    pub(crate) fn has(&self, clock: &Clock, k0: i64, k1: i64) -> bool {
        let (a, b) = self.block_range(k0, k1);
        let t = clock.tick();
        for i in a..b {
            match self.blocks.get(&i) {
                Some(e) => e.used.set(t),
                None => return false,
            }
        }
        true
    }

    /// Counts a reader of blocks `[a, b)` in (`by` 1) or out (-1); a block with a reader is not dropped.
    pub(crate) fn pin(&mut self, (a, b): (i64, i64), by: i32) {
        for i in a..b {
            let n = i64::from(*self.pins.get(&i).unwrap_or(&0)) + i64::from(by);
            if n > 0 {
                self.pins.insert(i, n as u32);
            } else {
                self.pins.remove(&i);
            }
        }
    }

    /// Samples `[k0, k1)` as one buffer a channel (zeros where no block is held).
    pub(crate) fn copy_range(&self, k0: i64, k1: i64) -> Stereo {
        let n = (k1 - k0).max(0) as usize;
        let mut out = [vec![0f32; n], vec![0f32; n]];
        let (a, b) = self.block_range(k0, k1);
        for i in a..b {
            let Some(e) = self.blocks.get(&i) else { continue };
            let s0 = i * self.size;
            let (from, to) = (k0.max(s0), k1.min(s0 + e.data[0].len() as i64));
            if to > from {
                for (o, d) in out.iter_mut().zip(&e.data) {
                    o[(from - k0) as usize..(to - k0) as usize]
                        .copy_from_slice(&d[(from - s0) as usize..(to - s0) as usize]);
                }
            }
        }
        out
    }

    /// Puts a block in and drops the least recently used unpinned ones over [`MAX_BLOCKS`].
    pub(crate) fn insert(&mut self, clock: &Clock, i: i64, data: Stereo) {
        self.blocks.insert(i, Block { data, used: Cell::new(clock.tick()) });
        while self.blocks.len() > MAX_BLOCKS {
            let worst = self
                .blocks
                .iter()
                .filter(|(k, _)| !self.pins.contains_key(k))
                .min_by_key(|(_, e)| e.used.get())
                .map(|(k, _)| *k);
            match worst {
                Some(k) => {
                    self.blocks.remove(&k);
                }
                None => break,
            }
        }
    }

    /// Reads block `i` from a file source at `rate` (the mixer's), resampled from a window aligned to an output sample
    /// with the filter's reach on both sides, so blocks join without a seam.
    pub(crate) fn read_file_block(&mut self, i: i64, rate: f64) -> Result<Stereo, AudioError> {
        let Origin::File(r) = &mut self.origin else { return Ok([Vec::new(), Vec::new()]) };
        let o0 = i * self.size;
        let o1 = self.length.min(o0 + self.size);
        let from = r.rate();
        if from == rate {
            return Ok(stereo(r.read(o0, o1)?));
        }
        let g = gcd(from as i64, rate as i64);
        let (si, so) = (from as i64 / g, rate as i64 / g);
        let w0 = floor_i(((o0 as f64 * from) / rate - RS_HALF as f64 - 2.0) / si as f64).max(0) * si;
        let w1 = ceil_i(o1 as f64 * from / rate) + RS_HALF + 2;
        let res = resample(&stereo(r.read(w0, w1)?), from, rate);
        let off = (o0 - (w0 / si) * so) as usize;
        let len = (o1 - o0) as usize;
        let cut = |c: &Vec<f32>| {
            let mut out = vec![0f32; len];
            let part = &c[off.min(c.len())..(off + len).min(c.len())];
            out[..part.len()].copy_from_slice(part);
            out
        };
        Ok([cut(&res[0]), cut(&res[1])])
    }
}

fn gcd(a: i64, b: i64) -> i64 {
    if b == 0 { a.max(1) } else { gcd(b, a % b) }
}
