//! Walking boxes: the children of a box in memory, and the top level of a file read a header at a time.

use std::borrow::Cow;

use crate::bytes::{fourcc, u32, u64};
use crate::error::{FormatError, Result, unsupported};
use crate::reader::{Reader, read_range};

/// A box inside a byte slice: its type and its payload `start..end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bx {
    pub kind: [u8; 4],
    pub start: usize,
    pub end: usize,
}

impl Bx {
    pub fn len(self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(self) -> bool {
        self.len() == 0
    }
}

/// The child boxes of `b[start..end]`; a child that runs past its parent ends the list.
pub fn boxes(b: &[u8], start: usize, end: usize) -> impl Iterator<Item = Bx> + '_ {
    let mut p = start;
    std::iter::from_fn(move || {
        if p.checked_add(8)? > end {
            return None;
        }
        let mut size = u64::from(u32(b, p));
        let mut hdr = 8;
        if size == 1 {
            if p + 16 > end {
                return None;
            }
            size = u64(b, p + 8);
            hdr = 16;
        } else if size == 0 {
            size = (end - p) as u64;
        }
        if size < hdr as u64 || size > (end - p) as u64 {
            return None;
        }
        let size = size as usize;
        let bx = Bx { kind: fourcc(b, p + 4), start: p + hdr, end: p + size };
        p += size;
        Some(bx)
    })
}

/// The first child of type `kind`.
pub fn child(b: &[u8], parent: Option<Bx>, kind: &[u8; 4]) -> Option<Bx> {
    let parent = parent?;
    boxes(b, parent.start, parent.end).find(|x| &x.kind == kind)
}

pub(crate) fn all<'a>(b: &'a [u8], parent: Option<Bx>, kind: &'a [u8; 4]) -> impl Iterator<Item = Bx> + 'a {
    parent.into_iter().flat_map(move |p| boxes(b, p.start, p.end)).filter(move |x| &x.kind == kind)
}

pub(crate) fn dig(b: &[u8], parent: Option<Bx>, path: &[&[u8; 4]]) -> Option<Bx> {
    path.iter().try_fold(parent?, |cur, kind| child(b, Some(cur), kind))
}

const MAX_MOOV: u64 = 512 * 1024 * 1024;
const MAX_MOOF: u64 = 64 * 1024 * 1024;

/// What the top level of a file holds: the boxes read whole (mdat is never read).
pub(crate) struct Top<'r> {
    pub ftyp: Option<Cow<'r, [u8]>>,
    pub moov: Option<Cow<'r, [u8]>>,
    /// Each moof with its position in the file.
    pub moofs: Vec<(u64, Cow<'r, [u8]>)>,
    pub damaged: Option<String>,
    pub mdat: bool,
}

fn printable(t: [u8; 4]) -> bool {
    t.iter().all(|c| (0x20..=0x7e).contains(c))
}

pub(crate) fn scan_top<R: Reader + ?Sized>(reader: &R) -> Result<Top<'_>> {
    let size = reader.size();
    let mut top = Top { ftyp: None, moov: None, moofs: Vec::new(), damaged: None, mdat: false };
    let mut pos: u64 = 0;
    // The 16 bytes after a moof come with it: fragmented files are a moof and an mdat after another.
    let mut ahead: Option<(u64, Vec<u8>)> = None;
    let mut count = 0;
    while pos.saturating_add(8) <= size && count < 4_000_000 {
        count += 1;
        let h: Cow<[u8]> = match ahead.take() {
            Some((at, bytes)) if at == pos && bytes.len() >= 16 => Cow::Owned(bytes),
            _ => read_range(reader, pos, 16)?,
        };
        if h.len() < 8 {
            break;
        }
        let mut box_size = u64::from(u32(&h, 0));
        let kind = fourcc(&h, 4);
        let mut hdr = 8;
        if box_size == 1 {
            if h.len() < 16 {
                break;
            }
            box_size = u64(&h, 8);
            hdr = 16;
        } else if box_size == 0 {
            box_size = size - pos;
        }
        if !printable(kind) || box_size < hdr {
            if top.moov.is_none() && top.moofs.is_empty() {
                top.damaged = Some(format!("no box at byte {pos}"));
            }
            break;
        }
        let end = pos.saturating_add(box_size);
        match &kind {
            b"moov" => {
                if end > size {
                    top.damaged = Some("the moov box is cut off".into());
                    break;
                }
                if box_size > MAX_MOOV {
                    return unsupported("the moov box is too big");
                }
                if top.moov.is_none() {
                    top.moov = Some(read_range(reader, pos, box_size)?);
                }
            }
            b"moof" => {
                if end > size {
                    break;
                }
                if box_size > MAX_MOOF {
                    top.damaged = Some("a moof box is too big".into());
                    break;
                }
                let bytes = read_range(reader, pos, box_size + 16)?;
                let n = box_size as usize;
                ahead = bytes.get(n..).map(|tail| (end, tail.to_vec()));
                let moof = match bytes {
                    Cow::Borrowed(b) => Cow::Borrowed(&b[..n.min(b.len())]),
                    Cow::Owned(mut v) => {
                        v.truncate(n);
                        Cow::Owned(v)
                    }
                };
                top.moofs.push((pos, moof));
            }
            b"ftyp" if top.ftyp.is_none() => top.ftyp = Some(read_range(reader, pos, box_size.min(4096))?),
            b"mdat" => top.mdat = true,
            _ => {}
        }
        pos = end;
    }
    Ok(top)
}

pub(crate) fn no_moov(top: &Top) -> FormatError {
    FormatError::damaged(match &top.damaged {
        Some(d) => d.clone(),
        None if top.mdat => "no moov box (the recording did not finish)".into(),
        None => "no moov box".into(),
    })
}
