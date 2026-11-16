//! Opens any media file Cut imports: sniffs the first bytes, hands the file to its container reader or recognizes an
//! image, and returns a [`Source`]. Also the sample lookups every reader's tables share.

use std::borrow::Cow;

use crate::audio::{self, AudioKind};
use crate::bytes::{le16, le32, starts, u16, u32};
use crate::error::{ErrorCode, FormatError, Result, damaged};
use crate::reader::{Reader, read_range};
use crate::source::{Container, Image, Source, Track};
use crate::{mkv, mp4};

/// What the first bytes of a file are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sniffed {
    Mp4,
    Mkv,
    /// HEIF/HEIC stills: recognized, not read.
    Heif,
    Audio(AudioKind),
    /// An image, by its mime type.
    Image(&'static str),
}

impl Sniffed {
    /// The JavaScript's name for it: `mp4`, `mkv`, `wav`, `mp3`, `aac`, `id3`, `heif` or the image mime.
    pub fn as_str(self) -> &'static str {
        match self {
            Sniffed::Mp4 => "mp4",
            Sniffed::Mkv => "mkv",
            Sniffed::Heif => "heif",
            Sniffed::Audio(AudioKind::Wav) => "wav",
            Sniffed::Audio(AudioKind::Mp3) => "mp3",
            Sniffed::Audio(AudioKind::Aac) => "aac",
            Sniffed::Audio(AudioKind::Id3) => "id3",
            Sniffed::Image(mime) => mime,
        }
    }
}

/// What the first bytes of a file say it is (`None`: nothing Cut opens).
pub fn sniff(b: &[u8]) -> Option<Sniffed> {
    let at = |i: usize, s: &[u8]| starts(b, i, s);
    if b.len() >= 12 && at(4, b"ftyp") {
        if at(8, b"avif") || at(8, b"avis") {
            return Some(Sniffed::Image("image/avif"));
        }
        if [b"heic", b"heix", b"heim", b"heis", b"mif1", b"msf1"].iter().any(|m| at(8, &m[..])) {
            return Some(Sniffed::Heif);
        }
        return Some(Sniffed::Mp4);
    }
    if b.len() >= 8 && [b"moov", b"mdat", b"free", b"wide", b"skip", b"pnot"].iter().any(|m| at(4, &m[..])) {
        return Some(Sniffed::Mp4);
    }
    if b.len() >= 4 && u32(b, 0) == 0x1a45_dfa3 {
        return Some(Sniffed::Mkv);
    }
    if b.len() >= 12 && (at(0, b"RIFF") || at(0, b"RF64") || at(0, b"BW64")) && at(8, b"WAVE") {
        return Some(Sniffed::Audio(AudioKind::Wav));
    }
    if b.len() >= 12 && at(0, b"RIFF") && at(8, b"WEBP") {
        return Some(Sniffed::Image("image/webp"));
    }
    if b.len() >= 8 && u32(b, 0) == 0x8950_4e47 && u32(b, 4) == 0x0d0a_1a0a {
        return Some(Sniffed::Image("image/png"));
    }
    if b.len() >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff {
        return Some(Sniffed::Image("image/jpeg"));
    }
    if b.len() >= 6 && (at(0, b"GIF87a") || at(0, b"GIF89a")) {
        return Some(Sniffed::Image("image/gif"));
    }
    if b.len() >= 26 && at(0, b"BM") && le32(b, 14) >= 12 {
        return Some(Sniffed::Image("image/bmp"));
    }
    audio::sniff(b).map(Sniffed::Audio)
}

/// An image's size from its header, when it says (the engine decodes the image anyway).
fn image_size<R: Reader + ?Sized>(reader: &R, mime: &str, b: &[u8]) -> Option<[u32; 2]> {
    match mime {
        "image/png" if b.len() >= 24 => Some([u32(b, 16), u32(b, 20)]),
        "image/gif" if b.len() >= 10 => Some([le16(b, 6).into(), le16(b, 8).into()]),
        "image/bmp" => Some([(le32(b, 18) as i32).unsigned_abs(), (le32(b, 22) as i32).unsigned_abs()]),
        "image/webp" if b.len() >= 30 => {
            if starts(b, 12, b"VP8 ") {
                Some([u32::from(le16(b, 26) & 0x3fff), u32::from(le16(b, 28) & 0x3fff)])
            } else if starts(b, 12, b"VP8L") {
                let v = le32(b, 21);
                Some([(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1])
            } else if starts(b, 12, b"VP8X") {
                let le24 = |i: usize| u32::from(b[i]) | (u32::from(b[i + 1]) << 8) | (u32::from(b[i + 2]) << 16);
                Some([le24(24) + 1, le24(27) + 1])
            } else {
                None
            }
        }
        "image/jpeg" => {
            let mut p: u64 = 2;
            for _ in 0..512 {
                if p + 4 > reader.size() {
                    break;
                }
                let h = read_range(reader, p, 10).ok()?;
                if h.len() < 4 || h[0] != 0xff {
                    return None;
                }
                let marker = h[1];
                if marker == 0xff {
                    p += 1;
                    continue;
                }
                if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) && h.len() >= 9 {
                    return Some([u16(&h, 7).into(), u16(&h, 5).into()]);
                }
                if marker == 0xd8 || (0xd0..=0xd7).contains(&marker) || marker == 0x01 {
                    p += 2;
                    continue;
                }
                p += 2 + u64::from(u16(&h, 2));
            }
            None
        }
        _ => None,
    }
}

/// Opens a media file. Never fails: a file that cannot be used comes back with [`Source::error`]. `name` is the
/// file's name (not used to decide the format: the bytes do).
pub fn open<R: Reader + ?Sized>(reader: &R, name: &str) -> Source {
    let _ = name;
    if reader.size() < 4 {
        return Source::empty(None, Some(FormatError::damaged("the file is empty")));
    }
    let head = match read_range(reader, 0, 4096) {
        Ok(h) => h,
        Err(err) => return Source::empty(None, Some(err)),
    };
    let Some(kind) = sniff(&head) else {
        return Source::empty(None, Some(FormatError::unsupported("not a media file Cut can open")));
    };
    let (container, result) = match kind {
        Sniffed::Heif => {
            return Source::empty(Some(Container::Image), Some(FormatError::unsupported("HEIF/HEIC images")));
        }
        Sniffed::Image(mime) => {
            let [width, height] = image_size(reader, mime, &head).unwrap_or([0, 0]);
            return Source {
                image: Some(Image { mime, width, height }),
                ..Source::empty(Some(Container::Image), None)
            };
        }
        Sniffed::Mp4 => (Container::Mp4, mp4::open(reader)),
        Sniffed::Mkv => (Container::Mkv, mkv::open(reader)),
        Sniffed::Audio(k) => {
            let container = match k {
                AudioKind::Wav => Container::Wav,
                AudioKind::Aac => Container::Aac,
                AudioKind::Mp3 | AudioKind::Id3 => Container::Mp3,
            };
            (container, audio::open(reader, k))
        }
    };
    let mut source = match result {
        Ok(s) => s,
        Err(err) => return Source::empty(Some(container), Some(err)),
    };
    if source.tracks.is_empty() && source.error.is_none() {
        let mut codecs: Vec<&str> = Vec::new();
        for s in source.skipped.iter().filter(|s| s.reason != "empty") {
            if !codecs.contains(&s.codec.as_str()) {
                codecs.push(&s.codec);
            }
        }
        source.error = Some(if codecs.is_empty() {
            FormatError::new(ErrorCode::NoTracks, "no video or audio track")
        } else {
            FormatError::unsupported(format!("unsupported codec: {}", codecs.join(", ")))
        });
    }
    source
}

/// The sample on screen at presentation time `t`: the last pts at or before it (the earliest sample before the first
/// pts), or `None` for an empty table.
pub fn sample_at_time(track: &Track, t: i64) -> Option<usize> {
    let s = &track.samples;
    let (order, pts) = (&s.order, &s.pts);
    let first = *order.first()? as usize;
    if pts[first] > t {
        return Some(first);
    }
    let k = order.partition_point(|&i| pts[i as usize] <= t);
    Some(order[k - 1] as usize)
}

/// The position in `keys` of the last sync sample at or before sample `k`.
fn key_at_or_before(keys: &[u32], k: usize) -> Option<usize> {
    keys.partition_point(|&x| x as usize <= k).checked_sub(1)
}

/// The sync sample to start decoding from to reach sample `index`, or `None` for an empty table. A picture shown
/// before its GOP's key frame (the leading pictures of an open GOP) needs the GOP before; audio with pre-roll (Opus)
/// starts that much earlier.
pub fn key_before(track: &Track, index: i64) -> Option<usize> {
    let s = &track.samples;
    let n = s.count();
    if n == 0 {
        return None;
    }
    let i = index.clamp(0, n as i64 - 1) as usize;
    let keys = &s.keys;
    let Some(mut k) = key_at_or_before(keys, i) else { return Some(0) };
    while k > 0 && s.pts[i] < s.pts[keys[k] as usize] {
        k -= 1;
    }
    let mut start = keys[k] as usize;
    if track.pre_roll > 0 {
        let target = s.dts[start].saturating_sub(track.pre_roll);
        while start > 0 && s.dts[start] > target {
            start -= 1;
        }
        if let Some(kk) = key_at_or_before(keys, start) {
            start = keys[kk] as usize;
        }
    }
    Some(start)
}

fn with_prefix<'a>(prefix: Option<&[u8]>, bytes: Cow<'a, [u8]>) -> Cow<'a, [u8]> {
    match prefix {
        Some(p) => Cow::Owned([p, &bytes].concat()),
        None => bytes,
    }
}

/// Sample `index`'s bytes, the track's sample prefix in front.
pub fn read_sample<'r, R: Reader + ?Sized>(reader: &'r R, track: &Track, index: usize) -> Result<Cow<'r, [u8]>> {
    let s = &track.samples;
    if index >= s.count() {
        return damaged(format!("no sample {index}"));
    }
    let bytes = read_range(reader, s.offset[index], s.size[index].into())?;
    if bytes.len() != s.size[index] as usize {
        return damaged(format!("sample {index} is cut off"));
    }
    Ok(with_prefix(track.sample_prefix.as_deref(), bytes))
}

const GAP: u64 = 256 * 1024;
const SPAN: u64 = 16 * 1024 * 1024;

/// Samples `from..to` (decode order, clamped to the table) handed to `f(index, bytes)` in order, read with as few
/// reads as possible: neighbouring samples come in one read. Each slice has the sample prefix in front.
pub fn read_samples<R: Reader + ?Sized>(
    reader: &R,
    track: &Track,
    from: usize,
    to: usize,
    mut f: impl FnMut(usize, &[u8]),
) -> Result<()> {
    let s = &track.samples;
    let end_index = to.min(s.count());
    let prefix = track.sample_prefix.as_deref();
    let mut joined = Vec::new();
    let mut i = from;
    while i < end_index {
        let start = s.offset[i];
        let mut end = start + u64::from(s.size[i]);
        let mut j = i + 1;
        while j < end_index {
            let o = s.offset[j];
            let stop = end.max(o + u64::from(s.size[j]));
            if o < start || o > end + GAP || stop - start > SPAN {
                break;
            }
            end = stop;
            j += 1;
        }
        let bytes = read_range(reader, start, end - start)?;
        for k in i..j {
            let at = (s.offset[k] - start) as usize;
            let Some(piece) = bytes.get(at..at + s.size[k] as usize) else {
                return damaged(format!("sample {k} is cut off"));
            };
            match prefix {
                Some(p) => {
                    joined.clear();
                    joined.extend_from_slice(p);
                    joined.extend_from_slice(piece);
                    f(k, &joined);
                }
                None => f(k, piece),
            }
        }
        i = j;
    }
    Ok(())
}
