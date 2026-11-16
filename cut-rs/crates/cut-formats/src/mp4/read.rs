//! MP4 and MOV -> a Source: the top-level boxes are walked with small reads (mdat is never read), moov and every
//! moof are read whole and turned into per-track sample tables: stts, ctts v0/v1, stss, stsz/stz2, stsc,
//! stco/co64, the first edit of elst, the tkhd matrix, colr and pasp, and fragments (mvex/trex,
//! moof/traf/tfhd/tfdt/trun). Uncompressed PCM is indexed in pieces of at most a second, not a frame at a time.

use std::collections::HashMap;

use cut_time::Ticks;

use super::boxes::{Bx, all, boxes, child, dig, no_moov, scan_top};
use super::entry::{Entry, EntryMedia, audio_entry, video_entry};
use crate::bytes::{byte, fourcc, i32, latin1, starts, u16, u32, u64};
use crate::error::{FormatError, Result, damaged};
use crate::reader::Reader;
use crate::source::{Audio, Container, Kind, Media, SampleTable, Skipped, Source, Track, Video};
use crate::table::{Clock, MAX_SAMPLES, TableBuilder, dim, finish_track, js_round, rescale, retain, to_i64};

/// A run-length table (stts, ctts, stsc, stss): its entry count as far as the box holds, and where entries start.
fn runs(b: &[u8], bx: Option<Bx>, entry: usize) -> (usize, usize) {
    let Some(bx) = bx else { return (0, 0) };
    let room = bx.len().saturating_sub(8) / entry;
    if bx.len() < 8 {
        return (0, 0);
    }
    ((u32(b, bx.start + 4) as usize).min(room), bx.start + 8)
}

/// Sample sizes: a fixed size for `n` samples, or one each.
enum Sizes {
    Fixed(u32, u64),
    Each(Vec<u32>),
}

impl Sizes {
    fn count(&self) -> u64 {
        match self {
            Sizes::Fixed(_, n) => *n,
            Sizes::Each(v) => v.len() as u64,
        }
    }
}

fn bad_length(n: i64) -> FormatError {
    FormatError::damaged(format!("Invalid typed array length: {n}"))
}

fn sample_sizes(b: &[u8], stbl: Option<Bx>) -> Result<Sizes> {
    if let Some(stsz) = child(b, stbl, b"stsz") {
        let fixed = u32(b, stsz.start + 4);
        let n = u32(b, stsz.start + 8);
        if fixed != 0 {
            return Ok(Sizes::Fixed(fixed, n.into()));
        }
        let room = (stsz.len() as i64 - 12).div_euclid(4);
        let have = i64::from(n).min(room);
        if have < 0 {
            return Err(bad_length(have));
        }
        return Ok(Sizes::Each((0..have as usize).map(|i| u32(b, stsz.start + 12 + 4 * i)).collect()));
    }
    let Some(stz2) = child(b, stbl, b"stz2") else { return Ok(Sizes::Each(Vec::new())) };
    let field = byte(b, stz2.start + 7);
    let n = u32(b, stz2.start + 8);
    let p0 = stz2.start + 12;
    let room = ((stz2.end as i64 - p0 as i64) * 8).div_euclid(if field == 0 { 8 } else { field.into() });
    let have = i64::from(n).min(room);
    if have < 0 {
        return Err(bad_length(have));
    }
    let sizes = (0..have as usize)
        .map(|i| match field {
            4 => {
                let v = byte(b, p0 + (i >> 1));
                u32::from(if i & 1 == 1 { v & 15 } else { v >> 4 })
            }
            8 => byte(b, p0 + i).into(),
            _ => u16(b, p0 + 2 * i).into(),
        })
        .collect();
    Ok(Sizes::Each(sizes))
}

fn chunk_offsets(b: &[u8], stbl: Option<Bx>) -> Result<Vec<u64>> {
    let co64 = child(b, stbl, b"co64");
    let Some(bx) = co64.or_else(|| child(b, stbl, b"stco")) else { return Ok(Vec::new()) };
    let step = if co64.is_some() { 8 } else { 4 };
    if bx.len() < 8 {
        return Err(bad_length((bx.len() as i64 - 8).div_euclid(step as i64)));
    }
    let (n, base) = runs(b, Some(bx), step);
    Ok((0..n).map(|i| if step == 8 { u64(b, base + 8 * i) } else { u32(b, base + 4 * i).into() }).collect())
}

/// Calls `f(offset, samples_in_chunk)` for every chunk from stsc, until it returns false.
fn each_chunk(b: &[u8], stbl: Option<Bx>, offsets: &[u64], mut f: impl FnMut(u64, u64) -> Result<bool>) -> Result<()> {
    let (n, base) = runs(b, child(b, stbl, b"stsc"), 12);
    for e in 0..n {
        let p = base + e * 12;
        let first = i64::from(u32(b, p)) - 1;
        let per = u32(b, p + 4).into();
        let next = if e + 1 < n { i64::from(u32(b, p + 12)) - 1 } else { offsets.len() as i64 };
        for c in first.max(0)..next.min(offsets.len() as i64) {
            if !f(offsets[c as usize], per)? {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Sample durations in media units, as a cursor over stts.
struct Stts<'a> {
    b: &'a [u8],
    n: usize,
    base: usize,
    e: usize,
    left: u64,
    delta: i64,
}

impl<'a> Stts<'a> {
    fn new(b: &'a [u8], stbl: Option<Bx>) -> Self {
        let (n, base) = runs(b, child(b, stbl, b"stts"), 8);
        Self { b, n, base, e: 0, left: 0, delta: 0 }
    }

    fn next(&mut self) {
        while self.left == 0 && self.e < self.n {
            self.left = u32(self.b, self.base + self.e * 8).into();
            self.delta = u32(self.b, self.base + self.e * 8 + 4).into();
            self.e += 1;
        }
    }

    /// The duration of the next `count` samples (the last delta repeats past the table's end).
    fn take(&mut self, mut count: u64) -> i64 {
        let mut sum: i64 = 0;
        while count > 0 {
            self.next();
            if self.left == 0 {
                return sum.saturating_add((count as i64).saturating_mul(self.delta));
            }
            let k = self.left.min(count);
            sum = sum.saturating_add(k as i64 * self.delta);
            self.left -= k;
            count -= k;
        }
        sum
    }

    fn one(&mut self) -> i64 {
        self.next();
        self.left = self.left.saturating_sub(1);
        self.delta
    }
}

/// A table in media units; `rate` is the PCM frame rate its times count in, when they do.
struct MediaTable {
    tb: TableBuilder,
    rate: Option<u64>,
}

fn stbl_table(b: &[u8], stbl: Option<Bx>, entry: &Entry, timescale: u32) -> Result<MediaTable> {
    let offsets = chunk_offsets(b, stbl)?;
    if let EntryMedia::Audio { pcm: Some(bpf), sample_rate, .. } = entry.media {
        return pcm_table(b, stbl, bpf, sample_rate, timescale, &offsets);
    }
    let sizes = sample_sizes(b, stbl)?;
    let n = sizes.count();
    if n > MAX_SAMPLES as u64 {
        return damaged("too many samples");
    }
    let mut tb = TableBuilder::new(n as usize);
    let mut i: u64 = 0;
    each_chunk(b, stbl, &offsets, |mut offset, per| {
        let mut k = 0;
        while k < per && i < n {
            let size = match &sizes {
                Sizes::Fixed(s, _) => *s,
                Sizes::Each(v) => v[i as usize],
            };
            tb.push(offset, size, 0, 0, 0, true)?;
            offset = offset.saturating_add(size.into());
            k += 1;
            i += 1;
        }
        Ok(i < n)
    })?;
    let t = &mut tb.t;
    let count = t.count();
    let mut stts = Stts::new(b, stbl);
    let mut dts: i64 = 0;
    for k in 0..count {
        let d = stts.one();
        t.dts[k] = dts;
        t.pts[k] = dts;
        t.duration[k] = d;
        dts = dts.saturating_add(d);
    }
    if let Some(ctts) = child(b, stbl, b"ctts") {
        let (n, base) = runs(b, Some(ctts), 8);
        let mut k = 0;
        for e in 0..n {
            if k >= count {
                break;
            }
            let m = u32(b, base + e * 8);
            let off = i64::from(i32(b, base + e * 8 + 4));
            for _ in 0..m {
                if k >= count {
                    break;
                }
                t.pts[k] = t.pts[k].saturating_add(off);
                k += 1;
            }
        }
    }
    if let Some(stss) = child(b, stbl, b"stss") {
        t.key.fill(false);
        let (n, base) = runs(b, Some(stss), 4);
        for e in 0..n {
            let s = i64::from(u32(b, base + e * 4)) - 1;
            if s >= 0 && (s as usize) < count {
                t.key[s as usize] = true;
            }
        }
    }
    Ok(MediaTable { tb, rate: None })
}

/// PCM: one entry per piece of a chunk, at most a second (or 1 MB) of frames.
fn pcm_table(
    b: &[u8],
    stbl: Option<Bx>,
    bpf: u64,
    sample_rate: f64,
    timescale: u32,
    offsets: &[u64],
) -> Result<MediaTable> {
    let rate = match js_round(sample_rate) {
        r if r > 0.0 => r as u64,
        _ => timescale.into(),
    };
    let piece = rate.min((1_u64 << 20).checked_div(bpf).unwrap_or(u64::MAX)).max(1);
    let mut tb = TableBuilder::new(offsets.len() * 2);
    let mut stts = Stts::new(b, stbl);
    let total = sample_sizes(b, stbl)?.count();
    let (mut done, mut frame) = (0_u64, 0_i64);
    each_chunk(b, stbl, offsets, |mut offset, per| {
        let count = if total > 0 { per.min(total.saturating_sub(done)) } else { per };
        if count == 0 {
            return Ok(false);
        }
        done += count;
        let units = stts.take(count);
        let mut frames = if u64::from(timescale) == rate {
            units
        } else {
            to_i64(js_round(units as f64 * rate as f64 / f64::from(timescale)))
        };
        while frames > 0 {
            let k = (piece as i64).min(frames);
            let bytes = (k as u64).saturating_mul(bpf);
            tb.push(offset, bytes as u32, frame, frame, k, true)?;
            offset = offset.saturating_add(bytes);
            frame += k;
            frames -= k;
        }
        Ok(true)
    })?;
    Ok(MediaTable { tb, rate: Some(rate) })
}

/// A track of the movie while its fragments are read.
struct Trak {
    id: u32,
    entry: Entry,
    timescale: u32,
    table: MediaTable,
    trex: [u32; 3],
    next_dts: i64,
    edits: Option<Edits>,
    rotation: u32,
    tkhd_size: [f64; 2],
}

impl Trak {
    fn is_audio(&self) -> bool {
        matches!(self.entry.media, EntryMedia::Audio { .. })
    }
}

/// The first edit: empty time before it (movie units), where it starts in the media, and its length (movie units).
struct Edits {
    empty: i64,
    media: i64,
    segment: i64,
}

fn read_fragments(
    moofs: &[(u64, std::borrow::Cow<[u8]>)],
    traks: &mut [Trak],
    by_id: &HashMap<u32, usize>,
) -> Result<()> {
    for (pos, b) in moofs {
        let (pos, b) = (*pos as i64, &b[..]);
        let moof = Some(Bx { kind: *b"moof", start: 8, end: b.len() });
        let mut prev_end = pos;
        for traf in all(b, moof, b"traf") {
            let Some(tfhd) = child(b, Some(traf), b"tfhd") else { continue };
            let flags = u32(b, tfhd.start) & 0xff_ffff;
            let Some(&ti) = by_id.get(&u32(b, tfhd.start + 4)) else { continue };
            let tr = &mut traks[ti];
            let mut p = tfhd.start + 8;
            let mut base = if flags & 0x20000 != 0 { pos } else { prev_end };
            if flags & 1 != 0 {
                base = u64(b, p) as i64;
                p += 8;
            }
            if flags & 2 != 0 {
                p += 4;
            }
            let mut field = |on: bool, default: u32| {
                if !on {
                    return default;
                }
                p += 4;
                u32(b, p - 4)
            };
            let def_dur = field(flags & 8 != 0, tr.trex[0]);
            let def_size = field(flags & 0x10 != 0, tr.trex[1]);
            let def_flags = field(flags & 0x20 != 0, tr.trex[2]);
            if let Some(tfdt) = child(b, Some(traf), b"tfdt") {
                tr.next_dts = if byte(b, tfdt.start) == 1 {
                    u64(b, tfdt.start + 4) as i64
                } else {
                    u32(b, tfdt.start + 4).into()
                };
            }
            let mut data_at = base;
            let audio = tr.is_audio();
            for trun in all(b, Some(traf), b"trun") {
                let tf = u32(b, trun.start) & 0xff_ffff;
                let count = u64::from(u32(b, trun.start + 4));
                let mut q = trun.start + 8;
                if tf & 1 != 0 {
                    data_at = base.saturating_add(i32(b, q).into());
                    q += 4;
                }
                let mut first_flags = None;
                if tf & 4 != 0 {
                    first_flags = Some(u32(b, q));
                    q += 4;
                }
                let per = u64::from((tf >> 8) & 1)
                    + u64::from((tf >> 9) & 1)
                    + u64::from((tf >> 10) & 1)
                    + u64::from((tf >> 11) & 1);
                if q as u64 + count * per * 4 > trun.end as u64 {
                    break;
                }
                let mut read = |on: bool| {
                    on.then(|| {
                        q += 4;
                        u32(b, q - 4)
                    })
                };
                for i in 0..count {
                    let dur = read(tf & 0x100 != 0).unwrap_or(def_dur);
                    let size = read(tf & 0x200 != 0).unwrap_or(def_size);
                    let mut sflags = read(tf & 0x400 != 0).unwrap_or(def_flags);
                    let cto = read(tf & 0x800 != 0).map_or(0, |v| i64::from(v as i32));
                    if i == 0
                        && let Some(f) = first_flags
                    {
                        sflags = f;
                    }
                    let key = audio || sflags & 0x10000 == 0;
                    // A data offset before the file start cannot be read: the sample goes with those past its end.
                    let offset = u64::try_from(data_at).unwrap_or(u64::MAX);
                    tr.table.tb.push(offset, size, tr.next_dts, tr.next_dts.saturating_add(cto), dur.into(), key)?;
                    tr.next_dts = tr.next_dts.saturating_add(dur.into());
                    data_at = data_at.saturating_add(size.into());
                }
            }
            prev_end = data_at;
        }
    }
    Ok(())
}

fn rotation_of(b: &[u8], tkhd: Bx) -> u32 {
    let m = tkhd.start + if byte(b, tkhd.start) == 1 { 52 } else { 40 };
    if m + 36 > tkhd.end {
        return 0;
    }
    let a = f64::from(i32(b, m)) / 65536.0;
    let c = f64::from(i32(b, m + 4)) / 65536.0;
    if a == 0.0 && c == 0.0 {
        return 0;
    }
    let deg = js_round(c.atan2(a) * 180.0 / std::f64::consts::PI / 90.0) * 90.0;
    (((deg % 360.0) + 360.0) % 360.0) as u32
}

fn edits_of(b: &[u8], trak: Bx) -> Option<Edits> {
    let elst = dig(b, Some(trak), &[b"edts", b"elst"])?;
    let v1 = byte(b, elst.start) == 1;
    let n = u32(b, elst.start + 4);
    let step = if v1 { 20 } else { 12 };
    let mut empty: i64 = 0;
    let mut p = elst.start + 8;
    for _ in 0..n {
        if p + step > elst.end {
            break;
        }
        let dur = if v1 { u64(b, p) as i64 } else { u32(b, p).into() };
        let media = if v1 { u64(b, p + 8) as i64 } else { i32(b, p + 4).into() };
        if media == -1 {
            empty = empty.saturating_add(dur);
            p += step;
            continue;
        }
        return Some(Edits { empty, media, segment: dur });
    }
    (empty != 0).then_some(Edits { empty, media: 0, segment: 0 })
}

struct Movie {
    tracks: Vec<Track>,
    skipped: Vec<Skipped>,
    duration: Ticks,
}

fn parse_movie(b: &[u8], moofs: &[(u64, std::borrow::Cow<[u8]>)], file_size: u64, qt: bool) -> Result<Movie> {
    let root = Some(Bx { kind: *b"moov", start: if u32(b, 0) == 1 { 16 } else { 8 }, end: b.len() });
    let Some(mvhd) = child(b, root, b"mvhd") else { return damaged("no mvhd") };
    let mv1 = byte(b, mvhd.start) == 1;
    let movie_scale = match u32(b, mvhd.start + if mv1 { 20 } else { 12 }) {
        0 => 1000,
        s => s,
    };
    let movie_duration = if mv1 { u64(b, mvhd.start + 24) as i64 } else { u32(b, mvhd.start + 16).into() };
    let mut trex = HashMap::new();
    for bx in all(b, child(b, root, b"mvex"), b"trex") {
        trex.insert(u32(b, bx.start + 4), [u32(b, bx.start + 12), u32(b, bx.start + 16), u32(b, bx.start + 20)]);
    }
    let mut traks = Vec::new();
    let mut skipped = Vec::new();
    let mut by_id = HashMap::new();
    for trak in all(b, root, b"trak") {
        let tkhd = child(b, Some(trak), b"tkhd");
        let mdia = child(b, Some(trak), b"mdia");
        let mdhd = child(b, mdia, b"mdhd");
        let hdlr = child(b, mdia, b"hdlr");
        let stbl = dig(b, mdia, &[b"minf", b"stbl"]);
        let (Some(tkhd), Some(mdhd), Some(hdlr), Some(_)) = (tkhd, mdhd, hdlr, stbl) else { continue };
        let video = starts(b, hdlr.start + 8, b"vide");
        if !video && !starts(b, hdlr.start + 8, b"soun") {
            continue;
        }
        let tk1 = byte(b, tkhd.start) == 1;
        let id = u32(b, tkhd.start + if tk1 { 20 } else { 12 });
        let timescale = u32(b, mdhd.start + if byte(b, mdhd.start) == 1 { 20 } else { 12 });
        if timescale == 0 {
            continue;
        }
        let Some(stsd) = child(b, stbl, b"stsd") else { continue };
        let Some(first) = boxes(b, stsd.start + 8, stsd.end).next() else { continue };
        let kind = if video { Kind::Video } else { Kind::Audio };
        let entry = match if video { video_entry(b, first) } else { audio_entry(b, first, qt) } {
            Ok(Some(e)) => e,
            Ok(None) => {
                let codec = latin1(&first.kind).trim_matches(js_space).to_string();
                skipped.push(Skipped { id: id.into(), kind, codec, reason: "unsupported".into() });
                continue;
            }
            Err(err) => {
                skipped.push(Skipped { id: id.into(), kind, codec: latin1(&first.kind), reason: err.detail.into() });
                continue;
            }
        };
        let table = stbl_table(b, stbl, &entry, timescale)?;
        let next_dts = match table.tb.len() {
            0 => 0,
            n => table.tb.t.dts[n - 1].saturating_add(table.tb.t.duration[n - 1]),
        };
        let p = tkhd.start + if tk1 { 88 } else { 76 };
        let tkhd_size = if p + 8 <= tkhd.end {
            [f64::from(u32(b, p)) / 65536.0, f64::from(u32(b, p + 4)) / 65536.0]
        } else {
            [0.0; 2]
        };
        by_id.insert(id, traks.len());
        traks.push(Trak {
            id,
            timescale,
            table,
            trex: trex.get(&id).copied().unwrap_or([0; 3]),
            next_dts,
            edits: edits_of(b, trak),
            rotation: if video { rotation_of(b, tkhd) } else { 0 },
            tkhd_size,
            entry,
        });
    }
    read_fragments(moofs, &mut traks, &by_id)?;
    let tracks = traks.into_iter().map(|tr| finish(tr, movie_scale.into(), file_size)).collect();
    Ok(Movie { tracks, skipped, duration: rescale(movie_duration, movie_scale.into()) })
}

/// JavaScript's `String.prototype.trim` on one-byte characters.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}')
}

/// Media units -> ticks, the edit list applied, samples past the end of the file dropped.
fn finish(tr: Trak, movie_scale: u64, file_size: u64) -> Track {
    let scale = tr.table.rate.unwrap_or(tr.timescale.into());
    let clock = Clock::new(scale);
    let mut t: SampleTable = tr.table.tb.t;
    let truncated = retain(&mut t, |t, i| t.offset[i].checked_add(t.size[i].into()).is_some_and(|e| e <= file_size));
    let (mut shift, mut limit) = (0, None);
    if let Some(e) = &tr.edits {
        let empty = rescale(e.empty, movie_scale);
        shift = empty - rescale(e.media, tr.timescale.into());
        if e.segment > 0 {
            limit = Some(empty.saturating_add(rescale(e.segment, movie_scale)));
        }
    }
    let mut end: Ticks = 0;
    for i in 0..t.count() {
        t.dts[i] = clock.ticks(t.dts[i]).saturating_add(shift);
        t.pts[i] = clock.ticks(t.pts[i]).saturating_add(shift);
        t.duration[i] = clock.ticks(t.duration[i]);
        end = end.max(t.pts[i].saturating_add(t.duration[i]));
    }
    let quantum = clock.ticks(1) as f64;
    let Entry { codec, description, media } = tr.entry;
    let pre_roll = if codec == "opus" { cut_time::from_seconds(0.08) } else { 0 };
    let media = match media {
        EntryMedia::Video { width, height, sar, color, bit_depth } => {
            let (dw, dh) = if let Some([sx, sy]) = sar {
                (js_round(width as f64 * sx as f64 / sy as f64), height as f64)
            } else if tr.tkhd_size[0] > 0.0 && tr.tkhd_size[1] > 0.0 {
                (js_round(tr.tkhd_size[0]), js_round(tr.tkhd_size[1]))
            } else {
                (width as f64, height as f64)
            };
            let mut v = Video {
                width: dim(width as f64),
                height: dim(height as f64),
                display_width: dim(dw),
                display_height: dim(dh),
                rotation: tr.rotation,
                bit_depth: match bit_depth {
                    Some(d) if d != 0 => d.min(u32::MAX.into()) as u32,
                    _ => 8,
                },
                color_space: color,
                frame_rate: [30, 1],
                vfr: false,
            };
            finish_track(&mut t, Some(&mut v), quantum);
            Media::Video(v)
        }
        EntryMedia::Audio { channels, sample_rate, .. } => {
            finish_track(&mut t, None, quantum);
            Media::Audio(Audio {
                sample_rate: dim(js_round(sample_rate)),
                channels: channels.min(u32::MAX.into()) as u32,
            })
        }
    };
    let duration = limit.map_or(end, |l| l.min(end));
    Track {
        id: tr.id.into(),
        media,
        codec,
        description,
        duration,
        truncated,
        pre_roll,
        sample_prefix: None,
        samples: t,
    }
}

/// reader -> Source; a file that cannot be used is an error (probe turns it into `Source::error`).
pub fn open<R: Reader + ?Sized>(reader: &R) -> Result<Source> {
    let top = scan_top(reader)?;
    let Some(moov) = &top.moov else { return Err(no_moov(&top)) };
    let brands: Vec<String> = match top.ftyp.as_deref() {
        Some(f) if f.len() >= 16 => std::iter::once(8)
            .chain((16..).step_by(4).take_while(|p| p + 4 <= f.len()))
            .map(|p| latin1(&fourcc(f, p)))
            .collect(),
        _ => Vec::new(),
    };
    let qt = brands.first().is_some_and(|m| m == "qt  ") || top.ftyp.is_none();
    let movie = parse_movie(moov, &top.moofs, reader.size(), qt)?;
    let mut skipped = movie.skipped;
    let mut tracks = Vec::new();
    for t in movie.tracks {
        if t.samples.is_empty() {
            skipped.push(Skipped { id: t.id, kind: t.kind(), codec: t.codec, reason: "empty".into() });
        } else {
            tracks.push(t);
        }
    }
    tracks.sort_by_key(|t| t.kind() != Kind::Video);
    let duration = tracks.iter().map(|t| t.duration).max().unwrap_or(movie.duration);
    Ok(Source {
        container: Some(if qt { Container::Mov } else { Container::Mp4 }),
        duration,
        tracks,
        skipped,
        image: None,
        error: None,
        brands: Some(brands),
        damaged: None,
    })
}
