//! Walking the Clusters: SimpleBlocks and BlockGroups with their lacing, in windows over the file, finding the next
//! Cluster after a damaged stretch.

use std::borrow::Cow;

use super::ebml::{LEVEL1, header, id, uint_of, vlen};
use super::tracks::{Entry, at};
use crate::error::Result;
use crate::reader::{Reader, read_range};
use crate::source::Kind;
use crate::table::TableBuilder;

// ---- clusters --------------------------------------------------------------------------------------------------------

/// Windowed reads up to `end`: large windows while blocks are small, a small read per element when they are big.
pub(super) struct Cursor<'r, R: Reader + ?Sized> {
    pub(super) reader: &'r R,
    pub(super) end: i64,
    pub(super) buf: Cow<'r, [u8]>,
    pub(super) at: i64,
    pub(super) blocks: u64,
    pub(super) block_bytes: u64,
}

impl<'r, R: Reader + ?Sized> Cursor<'r, R> {
    /// The window holding `p..p + n` (or all that is left of the segment), and where `p` is in it.
    fn view(&mut self, p: i64, n: i64) -> Result<(&[u8], usize)> {
        let len = self.buf.len() as i64;
        if (p < self.at || p.saturating_add(n) > self.at + len)
            && !(p >= self.at && self.at + len >= self.end && p < self.end)
        {
            let big = self.blocks > 8 && self.block_bytes / self.blocks > 256 * 1024;
            self.buf = read_range(self.reader, at(p), n.max(if big { 64 * 1024 } else { 1024 * 1024 }) as u64)?;
            self.at = p;
        }
        Ok((&self.buf, (p - self.at) as usize))
    }

    /// Up to `n` bytes at `p`, as many as the window has.
    fn head(&mut self, p: i64, n: i64) -> Result<Vec<u8>> {
        let (b, i) = self.view(p, n)?;
        Ok(b.get(i..b.len().min(i.saturating_add(n as usize))).unwrap_or(&[]).to_vec())
    }
}

/// A track's samples while the clusters are walked: block times in Matroska units (fractions once laced frames are
/// spread), BlockDurations, and where laced blocks start.
pub(super) struct TrackState {
    pub(super) e: Entry,
    pub(super) tb: TableBuilder,
    pub(super) times: Vec<f64>,
    pub(super) durations: Vec<f64>,
    pub(super) laced: Vec<(usize, usize)>,
}

impl TrackState {
    /// Frame `k` of the `count` a block holds.
    fn add(
        &mut self,
        offset: i64,
        size: i64,
        t: i64,
        key: bool,
        block_duration: Option<u64>,
        (k, count): (usize, usize),
    ) -> Result<()> {
        let i = self.tb.push(at(offset), size as u32, 0, 0, 0, self.e.kind == Kind::Audio || key)?;
        self.times.push(t as f64);
        self.durations.push(block_duration.map_or(f64::NAN, |d| d as f64 / count as f64));
        if count > 1 && k == 0 {
            self.laced.push((i, count));
        }
        Ok(())
    }
}

struct Group {
    end: i64,
    block: Option<(i64, i64)>,
    key: bool,
    duration: Option<u64>,
}

pub(super) struct Scan<'r, 's, R: Reader + ?Sized> {
    pub(super) cur: Cursor<'r, R>,
    pub(super) seg_start: i64,
    pub(super) seg_end: i64,
    pub(super) cues: &'s [i64],
    pub(super) states: &'s mut [TrackState],
    pub(super) cluster_time: i64,
    pub(super) damaged: bool,
    pub(super) resyncs: u32,
}

impl<R: Reader + ?Sized> Scan<'_, '_, R> {
    /// The next Cluster ID from `from`, not past the next cue; -1 when there is none.
    fn resync(&mut self, from: i64) -> Result<i64> {
        self.damaged = true;
        self.resyncs += 1;
        if self.resyncs > 100_000 {
            return Ok(-1);
        }
        let cue = self.cues.iter().find(|&&c| self.seg_start + c > from).map(|&c| self.seg_start + c);
        let mut q = from;
        while q + 4 <= self.seg_end {
            let (b, i) = self.cur.view(q, 4)?;
            let i = i as i64;
            let stop = (b.len() as i64 - 3).min(i + cue.map_or(b.len() as i64, |c| c - q));
            let mut k = i;
            while k < stop {
                if b[k as usize..k as usize + 4] == [0x1f, 0x43, 0xb6, 0x75] {
                    return Ok(q + (k - i));
                }
                k += 1;
            }
            let next = q + (stop - i);
            if let Some(c) = cue
                && next >= c
            {
                return Ok(c);
            }
            if next <= q {
                break;
            }
            q = next;
        }
        Ok(-1)
    }

    /// One Block or SimpleBlock body; false when it does not read.
    fn add_block(
        &mut self,
        p: i64,
        size: i64,
        simple: bool,
        group_key: bool,
        group_duration: Option<u64>,
    ) -> Result<bool> {
        let mut b = self.cur.head(p, size.min(64))?;
        let sl = b.first().map_or(9, |&x| vlen(x));
        if sl > 8 || b.len() < sl + 3 {
            return Ok(false);
        }
        let number = b[1..sl]
            .iter()
            .fold(u64::from(b[0] & (0xff_u16 >> sl) as u8), |v, &x| v.saturating_mul(256) + u64::from(x));
        let Some(ti) = self.states.iter().position(|s| s.e.number == number) else { return Ok(true) };
        let rel = i64::from(i16::from_be_bytes([b[sl], b[sl + 1]]));
        let flags = b[sl + 2];
        let key = if simple { flags & 0x80 != 0 } else { group_key };
        let lacing = (flags >> 1) & 3;
        let mut hp = sl + 3;
        let t = self.cluster_time.saturating_add(rel);
        self.cur.blocks += 1;
        self.cur.block_bytes = self.cur.block_bytes.saturating_add(size as u64);
        if lacing == 0 {
            self.states[ti].add(p + hp as i64, size - hp as i64, t, key, group_duration, (0, 1))?;
            return Ok(true);
        }
        if b.len() < hp + 1 {
            return Ok(false);
        }
        let count = usize::from(b[hp]) + 1;
        hp += 1;
        let mut sizes: Vec<i64> = Vec::with_capacity(count);
        let need = |cur: &mut Cursor<R>, b: &mut Vec<u8>, hp: usize, n: usize| -> Result<bool> {
            if hp + n > b.len() && (b.len() as i64) < size {
                *b = cur.head(p, size.min((b.len() * 4).max(hp + n + 64) as i64))?;
            }
            Ok(hp + n <= b.len())
        };
        if lacing == 1 {
            for _ in 0..count - 1 {
                let mut s = 0;
                loop {
                    if !need(&mut self.cur, &mut b, hp, 1)? {
                        return Ok(false);
                    }
                    let v = b[hp];
                    hp += 1;
                    s += i64::from(v);
                    if v != 255 {
                        break;
                    }
                }
                sizes.push(s);
            }
        } else if lacing == 3 {
            if !need(&mut self.cur, &mut b, hp, 8)? {
                return Ok(false);
            }
            let Some((mut s, _)) = ebml_lace(&b, &mut hp) else { return Ok(false) };
            sizes.push(s);
            for _ in 1..count.saturating_sub(1) {
                if !need(&mut self.cur, &mut b, hp, 8)? {
                    return Ok(false);
                }
                let Some((raw, l)) = ebml_lace(&b, &mut hp) else { return Ok(false) };
                s += raw - ((1_i64 << (7 * l - 1)) - 1);
                sizes.push(s);
            }
        }
        let data = size - hp as i64;
        if lacing == 2 {
            for _ in 0..count - 1 {
                sizes.push(data.div_euclid(count as i64));
            }
        }
        let used: i64 = sizes.iter().sum();
        if used > data || sizes.iter().any(|&s| s < 0) {
            return Ok(false);
        }
        sizes.push(data - used);
        let mut off = p + hp as i64;
        for (k, &s) in sizes.iter().enumerate().take(count) {
            self.states[ti].add(off, s, t, key, group_duration, (k, count))?;
            off += s;
        }
        Ok(true)
    }

    fn finish_group(&mut self, g: Group) -> Result<()> {
        if let Some((p, size)) = g.block
            && !self.add_block(p, size, false, g.key, g.duration)?
        {
            self.damaged = true;
        }
        Ok(())
    }

    pub(super) fn run(&mut self, first: i64) -> Result<()> {
        let mut pos = first;
        let mut group: Option<Group> = None;
        let mut steps = 0;
        while pos < self.seg_end && steps < 50_000_000 {
            steps += 1;
            if let Some(g) = group.take_if(|g| pos >= g.end) {
                self.finish_group(g)?;
            }
            let (b, i) = self.cur.view(pos, 12)?;
            let h = header(b, i);
            let bad = match h {
                None => true,
                Some(h) => {
                    h.id < 0x80
                        || h.size.is_some_and(|s| {
                            h.id != id::CLUSTER && (pos as i128 + h.hdr as i128 + s as i128) > self.seg_end as i128
                        })
                }
            };
            let unknown = h.is_some_and(|h| h.size.is_none() && h.id != id::CLUSTER);
            if bad || unknown {
                if !bad && h.is_some_and(|h| LEVEL1.contains(&h.id)) {
                    break;
                }
                if let Some(g) = group.take() {
                    self.finish_group(g)?;
                }
                let next = self.resync(pos + 1)?;
                if next < 0 {
                    break;
                }
                pos = next;
                continue;
            }
            let Some(h) = h else { break };
            let data = pos + h.hdr as i64;
            let size = h.size.map_or(-1, |s| s as i64);
            let end = data.saturating_add(size);
            match h.id {
                id::CLUSTER => {
                    self.cluster_time = 0;
                    pos = data;
                    continue;
                }
                id::TIMESTAMP => {
                    let v = self.cur.head(data, size)?;
                    self.cluster_time = uint_of(&v, 0, size as usize).min(i64::MAX as u64) as i64;
                }
                id::SIMPLE_BLOCK => {
                    if !self.add_block(data, size, true, true, None)? {
                        self.damaged = true;
                    }
                }
                id::BLOCK_GROUP => {
                    group = Some(Group { end, block: None, key: true, duration: None });
                    pos = data;
                    continue;
                }
                id::BLOCK if group.is_some() => {
                    if let Some(g) = &mut group {
                        g.block = Some((data, size));
                    }
                }
                id::REFERENCE_BLOCK => {
                    if let Some(g) = &mut group {
                        g.key = false;
                    }
                }
                id::BLOCK_DURATION if group.is_some() => {
                    let v = self.cur.head(data, size)?;
                    if let Some(g) = &mut group {
                        g.duration = Some(uint_of(&v, 0, size as usize));
                    }
                }
                _ => {}
            }
            pos = end;
        }
        if let Some(g) = group {
            self.finish_group(g)?;
        }
        Ok(())
    }
}

/// An EBML lace size at `hp`: its value and length.
fn ebml_lace(b: &[u8], hp: &mut usize) -> Option<(i64, u32)> {
    let l = vlen(b[*hp]);
    if l > 8 {
        return None;
    }
    let first = i64::from(b[*hp] & (0xff_u16 >> l) as u8);
    let v = b[*hp + 1..*hp + l].iter().fold(first, |v, &x| v * 256 + i64::from(x));
    *hp += l;
    Some((v, l as u32))
}
