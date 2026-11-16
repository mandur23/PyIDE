//! Faststart (`main/cut/faststart.js`, `cut:faststart`): moves an MP4's moov box in front of its first mdat, so a
//! player or an upload site can start before it has the whole file. Everything else keeps its order. The sample data
//! moves by the size of the moov, so each chunk offset (stco, co64) of every track is shifted; an stco whose shifted
//! offsets no longer fit in 32 bits becomes a co64, which makes the moov larger, so the layout is computed again until
//! its size settles. The new file is written next to the old one and renamed over it.
//!
//! Box sizes: a 32-bit size, 1 for a 64-bit size after the type (the writer writes its mdat that way), or 0 for "to
//! the end of the file".

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::sink::{Failure, Journal, rename_over, temp_name};

const CONTAINERS: [&[u8; 4]; 5] = [b"moov", b"trak", b"mdia", b"minf", b"stbl"];
const MOOV_LIMIT: u64 = 512 * 1024 * 1024;
const COPY_CHUNK: usize = 8 * 1024 * 1024;
const U32: u64 = 0xffff_ffff;
/// Room left on the disk after the copy, so moving the index never fills it.
const SPARE: u64 = 64 * 1024 * 1024;

/// A box header found in a buffer or a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoxAt {
    pub kind: [u8; 4],
    pub start: u64,
    pub size: u64,
    pub header: u64,
}

/// What a faststart did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Moved {
    /// The moov was in front already (or there is no mdat).
    Already {
        bytes: u64,
    },
    Moved {
        bytes: u64,
    },
}

fn damaged(m: &str) -> Failure {
    Failure::new("damaged", m)
}

fn header_of(head: &[u8], pos: u64, end: u64) -> Result<BoxAt, Failure> {
    let short = || damaged("a box is cut short");
    let size32 = u32::from_be_bytes(head.get(..4).ok_or_else(short)?.try_into().map_err(|_| short())?);
    let kind: [u8; 4] = head.get(4..8).ok_or_else(short)?.try_into().map_err(|_| short())?;
    let (size, header) = match size32 {
        1 => {
            let b: [u8; 8] = head.get(8..16).ok_or_else(short)?.try_into().map_err(|_| short())?;
            (u64::from_be_bytes(b), 16)
        }
        0 => (end - pos, 8),
        n => (u64::from(n), 8),
    };
    if size < header || pos.checked_add(size).is_none_or(|e| e > end) {
        return Err(damaged("a box size does not fit"));
    }
    Ok(BoxAt { kind, start: pos, size, header })
}

/// The boxes in `buf[start..end)`.
pub fn boxes_in(buf: &[u8], start: u64, end: u64) -> Result<Vec<BoxAt>, Failure> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos < end {
        if end - pos < 8 {
            return Err(damaged("a box is cut short"));
        }
        let head = &buf[pos as usize..(pos + 16).min(end) as usize];
        let b = header_of(head, pos, end)?;
        pos += b.size;
        out.push(b);
    }
    Ok(out)
}

fn header(kind: &[u8; 4], size: u64) -> Vec<u8> {
    let mut h = Vec::with_capacity(16);
    if size <= U32 {
        h.extend_from_slice(&(size as u32).to_be_bytes());
        h.extend_from_slice(kind);
    } else {
        h.extend_from_slice(&1u32.to_be_bytes());
        h.extend_from_slice(kind);
        h.extend_from_slice(&(size + 8).to_be_bytes());
    }
    h
}

fn chunk_offsets(buf: &[u8], b: &BoxAt, wide: bool) -> Result<Vec<u64>, Failure> {
    let name = String::from_utf8_lossy(&b.kind).into_owned();
    if b.size - b.header < 8 {
        return Err(damaged(&format!("{name} is cut short")));
    }
    let at = (b.start + b.header) as usize;
    let count = u32::from_be_bytes([buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]]) as u64;
    let width = if wide { 8 } else { 4 };
    if b.header + 8 + count * width > b.size {
        return Err(damaged(&format!("{name} lists more chunks than it holds")));
    }
    let table = &buf[at + 8..at + 8 + (count * width) as usize];
    Ok(if wide {
        table.as_chunks::<8>().0.iter().map(|c| u64::from_be_bytes(*c)).collect()
    } else {
        table.as_chunks::<4>().0.iter().map(|c| u64::from(u32::from_be_bytes(*c))).collect()
    })
}

/// A co64 stays a co64; an stco becomes one only when an offset no longer fits.
fn offsets_box(offsets: &[u64], was_wide: bool) -> Vec<u8> {
    let wide = was_wide || offsets.iter().any(|o| *o > U32);
    let size = 16 + offsets.len() * if wide { 8 } else { 4 };
    let mut b = Vec::with_capacity(size);
    b.extend_from_slice(&(size as u32).to_be_bytes());
    b.extend_from_slice(if wide { b"co64" } else { b"stco" });
    b.extend_from_slice(&[0; 4]);
    b.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
    for o in offsets {
        if wide {
            b.extend_from_slice(&o.to_be_bytes());
        } else {
            b.extend_from_slice(&(*o as u32).to_be_bytes());
        }
    }
    b
}

fn rebuild(
    buf: &[u8],
    start: u64,
    end: u64,
    map: &mut dyn FnMut(u64) -> Result<u64, Failure>,
    out: &mut Vec<u8>,
) -> Result<(), Failure> {
    for b in boxes_in(buf, start, end)? {
        if CONTAINERS.contains(&&b.kind) {
            let mut children = Vec::new();
            rebuild(buf, b.start + b.header, b.start + b.size, map, &mut children)?;
            out.extend_from_slice(&header(&b.kind, children.len() as u64 + 8));
            out.extend_from_slice(&children);
        } else if &b.kind == b"stco" || &b.kind == b"co64" {
            let wide = &b.kind == b"co64";
            let offsets = chunk_offsets(buf, &b, wide)?.into_iter().map(&mut *map).collect::<Result<Vec<_>, _>>()?;
            out.extend_from_slice(&offsets_box(&offsets, wide));
        } else {
            out.extend_from_slice(&buf[b.start as usize..(b.start + b.size) as usize]);
        }
    }
    Ok(())
}

/// The moov box (and anything else in `moov`) with every chunk offset passed through `map` (`rewriteMoov`).
pub fn rewrite_moov(moov: &[u8], mut map: impl FnMut(u64) -> Result<u64, Failure>) -> Result<Vec<u8>, Failure> {
    let mut out = Vec::with_capacity(moov.len() + 64);
    rebuild(moov, 0, moov.len() as u64, &mut map, &mut out)?;
    Ok(out)
}

fn read_at(f: &mut File, len: u64, pos: u64) -> Result<Vec<u8>, Failure> {
    let mut buf = vec![0; len as usize];
    f.seek(SeekFrom::Start(pos)).map_err(Failure::io)?;
    f.read_exact(&mut buf).map_err(|e| {
        if e.kind() == io::ErrorKind::UnexpectedEof { damaged("the file ended early") } else { Failure::io(e) }
    })?;
    Ok(buf)
}

fn top_boxes(f: &mut File, size: u64) -> Result<Vec<BoxAt>, Failure> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < size {
        if size - pos < 8 {
            return Err(damaged("the file ends inside a box header"));
        }
        let head = read_at(f, (size - pos).min(16), pos)?;
        if head[..4] == 1u32.to_be_bytes() && head.len() < 16 {
            return Err(damaged("the file ends inside a box header"));
        }
        let b = header_of(&head, pos, size).map_err(|_| damaged("a box size does not fit the file"))?;
        pos += b.size;
        out.push(b);
    }
    Ok(out)
}

fn copy_range(from: &mut File, to: &mut File, start: u64, end: u64, buf: &mut [u8]) -> Result<(), Failure> {
    from.seek(SeekFrom::Start(start)).map_err(Failure::io)?;
    let mut left = end - start;
    while left > 0 {
        let n = (buf.len() as u64).min(left) as usize;
        from.read_exact(&mut buf[..n]).map_err(|_| damaged("the file ended early"))?;
        to.write_all(&buf[..n]).map_err(Failure::io)?;
        left -= n as u64;
    }
    Ok(())
}

/// Writes the moov into the `free` box in front of the sample data and removes it from the end (or, when other
/// boxes follow it, turns it into a `free` box). The moov's header goes last, so until then the file has one index.
fn in_place(path: &Path, free: &BoxAt, moov: &BoxAt, bytes: &[u8], last: bool, size: u64) -> Result<Moved, Failure> {
    let mut f = fs::OpenOptions::new().write(true).open(path).map_err(Failure::io)?;
    let put =
        |f: &mut File, at: u64, b: &[u8]| f.seek(SeekFrom::Start(at)).and_then(|_| f.write_all(b)).map_err(Failure::io);
    let rest = free.size - moov.size;
    if rest > 0 {
        put(&mut f, free.start + moov.size, &header(b"free", rest))?;
    }
    put(&mut f, free.start + 8, &bytes[8..])?;
    f.sync_data().map_err(Failure::io)?;
    put(&mut f, free.start, &bytes[..8])?;
    let total = if last {
        f.set_len(moov.start).map_err(Failure::io)?;
        moov.start
    } else {
        put(&mut f, moov.start + 4, b"free")?;
        size
    };
    f.sync_all().map_err(Failure::io)?;
    Ok(Moved::Moved { bytes: total })
}

/// Moves the moov of the MP4 at `path` to the front. `free(dir)` gives the free bytes of the file's disk when known;
/// a disk without room for the copy (and 64 MB more) leaves the file as it is. `temp` is told about the full-size copy
/// while it exists, so a crash does not leave it behind.
pub fn faststart(
    path: &Path,
    free: impl Fn(&Path) -> Option<u64>,
    temp: Option<&dyn Journal>,
) -> Result<Moved, Failure> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["mp4", "m4a", "m4v", "mov", "3gp"].contains(&ext.as_str()) {
        return Err(Failure::new("extension", "this kind of file is not opened here"));
    }
    let mut src = File::open(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => Failure::new("missing", "no such file"),
        _ => Failure::io(e),
    })?;
    let size = src.metadata().map_err(Failure::io)?.len();
    let top = top_boxes(&mut src, size)?;
    let moovs: Vec<&BoxAt> = top.iter().filter(|b| &b.kind == b"moov").collect();
    let first_mdat = top.iter().position(|b| &b.kind == b"mdat");
    let [moov] = moovs[..] else {
        let m = if moovs.is_empty() { "the file has no moov box" } else { "the file has more than one moov box" };
        return Err(damaged(m));
    };
    let moov = *moov;
    let moov_at = top.iter().position(|b| b.start == moov.start).unwrap_or(0);
    let Some(first_mdat) = first_mdat.filter(|i| moov_at > *i) else { return Ok(Moved::Already { bytes: size }) };
    if top.iter().any(|b| &b.kind == b"moof") {
        return Err(Failure::new("fragmented", "a fragmented MP4 is not rearranged"));
    }
    if moov.size > MOOV_LIMIT {
        return Err(Failure::new("tooLarge", "the moov box is too large"));
    }
    let moov_bytes = read_at(&mut src, moov.size, moov.start)?;
    // Room kept free in front of the sample data (the export's part file keeps it): the index goes there as it is,
    // since no sample moves, and the file is not copied.
    if let Some(free) = first_mdat.checked_sub(1).map(|i| top[i]).filter(|b| &b.kind == b"free")
        && (free.size == moov.size || free.size >= moov.size + 8)
    {
        drop(src);
        return in_place(path, &free, &moov, &moov_bytes, moov_at + 1 == top.len(), size);
    }
    let insert_at = top[first_mdat].start;
    let old = moov.size;
    let map_for = |new: u64| {
        move |off: u64| {
            if off >= moov.start && off < moov.start + old {
                return Err(damaged("a chunk offset points into the moov box"));
            }
            if off >= size {
                return Err(damaged("a chunk offset points past the end of the file"));
            }
            Ok(if off < insert_at {
                off
            } else if off < moov.start {
                off + new
            } else {
                off + new - old
            })
        }
    };
    let mut new = old;
    let mut rewritten = rewrite_moov(&moov_bytes, map_for(new))?;
    let mut i = 0;
    while rewritten.len() as u64 != new {
        if i > 8 {
            return Err(damaged("the moov size does not settle"));
        }
        new = rewritten.len() as u64;
        rewritten = rewrite_moov(&moov_bytes, map_for(new))?;
        i += 1;
    }
    let total = size - old + new;
    let dir = path.parent().unwrap_or(Path::new("."));
    if free(dir).is_some_and(|avail| avail < total + SPARE) {
        return Err(Failure::new("diskFull", "there is not enough free space to move the index to the front"));
    }
    let tmp: PathBuf = temp_name(path, "faststart.tmp");
    if let Some(j) = temp {
        j.add(&tmp);
    }
    let result = (|| {
        let mut out = File::create(&tmp).map_err(Failure::io)?;
        let mut buf = vec![0; COPY_CHUNK.min(size.max(1) as usize)];
        copy_range(&mut src, &mut out, 0, insert_at, &mut buf)?;
        out.write_all(&rewritten).map_err(Failure::io)?;
        copy_range(&mut src, &mut out, insert_at, moov.start, &mut buf)?;
        copy_range(&mut src, &mut out, moov.start + old, size, &mut buf)?;
        out.sync_all().map_err(Failure::io)?;
        let end = out.stream_position().map_err(Failure::io)?;
        if end != total {
            return Err(damaged("the rearranged file has the wrong size"));
        }
        drop(out);
        drop(src);
        rename_over(&tmp, path).map_err(Failure::io)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    if let Some(j) = temp {
        j.remove(&tmp);
    }
    result.map(|()| Moved::Moved { bytes: total })
}
