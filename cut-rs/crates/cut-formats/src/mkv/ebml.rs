//! EBML: element IDs, headers, children, and the values of simple elements.

use crate::bytes::{byte, latin1};

/// The element IDs Cut reads, by their Matroska names.
pub mod id {
    pub const EBML: u64 = 0x1a45dfa3;
    pub const DOC_TYPE: u64 = 0x4282;
    pub const SEGMENT: u64 = 0x18538067;
    pub const SEEK_HEAD: u64 = 0x114d9b74;
    pub const SEEK: u64 = 0x4dbb;
    pub const SEEK_ID: u64 = 0x53ab;
    pub const SEEK_POSITION: u64 = 0x53ac;
    pub const INFO: u64 = 0x1549a966;
    pub const TIMESTAMP_SCALE: u64 = 0x2ad7b1;
    pub const DURATION: u64 = 0x4489;
    pub const TRACKS: u64 = 0x1654ae6b;
    pub const TRACK_ENTRY: u64 = 0xae;
    pub const TRACK_NUMBER: u64 = 0xd7;
    pub const TRACK_TYPE: u64 = 0x83;
    pub const CODEC_ID: u64 = 0x86;
    pub const CODEC_PRIVATE: u64 = 0x63a2;
    pub const DEFAULT_DURATION: u64 = 0x23e383;
    pub const CODEC_DELAY: u64 = 0x56aa;
    pub const SEEK_PRE_ROLL: u64 = 0x56bb;
    pub const VIDEO: u64 = 0xe0;
    pub const PIXEL_WIDTH: u64 = 0xb0;
    pub const PIXEL_HEIGHT: u64 = 0xba;
    pub const DISPLAY_WIDTH: u64 = 0x54b0;
    pub const DISPLAY_HEIGHT: u64 = 0x54ba;
    pub const DISPLAY_UNIT: u64 = 0x54b2;
    pub const COLOUR: u64 = 0x55b0;
    pub const MATRIX_COEFFICIENTS: u64 = 0x55b1;
    pub const BITS_PER_CHANNEL: u64 = 0x55b2;
    pub const RANGE: u64 = 0x55b9;
    pub const TRANSFER_CHARACTERISTICS: u64 = 0x55ba;
    pub const PRIMARIES: u64 = 0x55bb;
    pub const AUDIO: u64 = 0xe1;
    pub const SAMPLING_FREQUENCY: u64 = 0xb5;
    pub const CHANNELS: u64 = 0x9f;
    pub const BIT_DEPTH: u64 = 0x6264;
    pub const CONTENT_ENCODINGS: u64 = 0x6d80;
    pub const CONTENT_ENCODING_TYPE: u64 = 0x5033;
    pub const CONTENT_COMPRESSION: u64 = 0x5034;
    pub const CONTENT_COMP_ALGO: u64 = 0x4254;
    pub const CONTENT_COMP_SETTINGS: u64 = 0x4255;
    pub const CUES: u64 = 0x1c53bb6b;
    pub const CUE_POINT: u64 = 0xbb;
    pub const CUE_TRACK_POSITIONS: u64 = 0xb7;
    pub const CUE_CLUSTER_POSITION: u64 = 0xf1;
    pub const CLUSTER: u64 = 0x1f43b675;
    pub const TIMESTAMP: u64 = 0xe7;
    pub const SIMPLE_BLOCK: u64 = 0xa3;
    pub const BLOCK_GROUP: u64 = 0xa0;
    pub const BLOCK: u64 = 0xa1;
    pub const BLOCK_DURATION: u64 = 0x9b;
    pub const REFERENCE_BLOCK: u64 = 0xfb;
    pub const TAGS: u64 = 0x1254c367;
    pub const CHAPTERS: u64 = 0x1043a770;
    pub const ATTACHMENTS: u64 = 0x1941a469;
    pub const VOID: u64 = 0xec;
}

pub(super) const LEVEL1: [u64; 8] =
    [id::SEEK_HEAD, id::INFO, id::TRACKS, id::CUES, id::CLUSTER, id::TAGS, id::CHAPTERS, id::ATTACHMENTS];
pub(super) const MAX_META: i64 = 64 * 1024 * 1024;

// ---- EBML ------------------------------------------------------------------------------------------------------------

/// The length of a variable-size number from its first byte (9 for 0: no number).
pub(super) fn vlen(first: u8) -> usize {
    first.leading_zeros() as usize + 1
}

/// An element header: its ID, its data size (`None`: unknown, to the end of the parent), and the header length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub id: u64,
    pub size: Option<u64>,
    pub hdr: usize,
}

/// The element header at `b[i]`, when one fits in `b`.
pub fn header(b: &[u8], i: usize) -> Option<Header> {
    if i >= b.len() {
        return None;
    }
    let il = vlen(b[i]);
    if il > 4 || i + il >= b.len() {
        return None;
    }
    let id = b[i..i + il].iter().fold(0, |v, &x| v * 256 + u64::from(x));
    let s = i + il;
    let sl = vlen(b[s]);
    if sl > 8 || s + sl > b.len() {
        return None;
    }
    let first = b[s] & (0xff_u16 >> sl) as u8;
    let mut size = u64::from(first);
    let mut ones = u16::from(first) == 0xff >> sl;
    for &x in &b[s + 1..s + sl] {
        size = size * 256 + u64::from(x);
        ones = ones && x == 255;
    }
    Some(Header { id, size: (!ones).then_some(size), hdr: il + sl })
}

/// A child element: its ID and its data `start..end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct El {
    pub id: u64,
    pub start: usize,
    pub end: usize,
}

/// The children of `b[start..end]` (an element of unknown size ends the list).
pub fn elements(b: &[u8], start: usize, end: usize) -> impl Iterator<Item = El> + '_ {
    let mut p = start;
    std::iter::from_fn(move || {
        if p >= end {
            return None;
        }
        let h = header(b, p)?;
        let size = usize::try_from(h.size?).ok()?;
        let stop = p.checked_add(h.hdr)?.checked_add(size)?;
        if stop > end {
            return None;
        }
        let el = El { id: h.id, start: p + h.hdr, end: stop };
        p = stop;
        Some(el)
    })
}

pub(super) fn uint_of(b: &[u8], start: usize, end: usize) -> u64 {
    (start..end).fold(0_u64, |v, i| v.saturating_mul(256).saturating_add(byte(b, i).into()))
}

pub(super) fn uint(b: &[u8], e: El) -> u64 {
    uint_of(b, e.start, e.end)
}

pub(super) fn float(b: &[u8], e: El) -> f64 {
    let d = &b[e.start..e.end];
    match d.len() {
        4 => f32::from_be_bytes([d[0], d[1], d[2], d[3]]).into(),
        8 => f64::from_be_bytes([d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]]),
        _ => 0.0,
    }
}

pub(super) fn text(b: &[u8], e: El) -> String {
    let d = &b[e.start..e.end];
    let n = d.iter().rposition(|&c| c != 0).map_or(0, |i| i + 1);
    latin1(&d[..n])
}

/// The first child of each ID.
pub(super) struct Fields<'a> {
    b: &'a [u8],
    list: Vec<El>,
}

impl<'a> Fields<'a> {
    pub(super) fn of(b: &'a [u8], e: El) -> Self {
        let mut list: Vec<El> = Vec::new();
        for c in elements(b, e.start, e.end) {
            if !list.iter().any(|x| x.id == c.id) {
                list.push(c);
            }
        }
        Self { b, list }
    }

    pub(super) fn get(&self, id: u64) -> Option<El> {
        self.list.iter().find(|x| x.id == id).copied()
    }

    pub(super) fn uint(&self, id: u64) -> Option<u64> {
        self.get(id).map(|e| uint(self.b, e))
    }

    pub(super) fn bytes(&self, id: u64) -> Option<Vec<u8>> {
        self.get(id).map(|e| self.b[e.start..e.end].to_vec())
    }
}

pub(super) fn whole(b: &[u8]) -> El {
    El { id: 0, start: 0, end: b.len() }
}
