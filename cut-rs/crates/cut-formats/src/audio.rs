//! Audio-only files -> a Source: MP3 (every frame header indexed, ID3v2 skipped, the Xing/Info/VBRI frame left out
//! and LAME's gapless delay applied), WAV (RIFF, RF64 and BW64 with ds64; integer PCM 8/16/24/32 and float 32/64,
//! WAVE_FORMAT_EXTENSIBLE) and ADTS AAC (the 7 or 9 byte headers stripped, an AudioSpecificConfig built from the first
//! one). MP3 and ADTS are read front to back in large windows; after a damaged stretch the scan finds the next two
//! frames in a row and goes on.

use std::borrow::Cow;

use crate::bytes::{byte, le16, le32, le64, starts, u32};
use crate::codecs::audio::{AAC_RATES, build_audio_specific_config};
use crate::error::{Result, damaged, unsupported};
use crate::reader::{Reader, read_range};
use crate::source::{Audio, Container, Media, Source, Track};
use crate::table::{Clock, TableBuilder, finish_track};

const WINDOW: u64 = 4 * 1024 * 1024;

/// A frame header of a stream of frames (MPEG audio or ADTS).
trait FrameHeader: Copy {
    fn parse(b: &[u8], i: usize) -> Option<Self>;
    /// Another frame of the same stream.
    fn same(&self, other: &Self) -> bool;
    /// The whole frame, header included.
    fn size(&self) -> u64;
}

const MP3_KBPS_V1: [u32; 15] = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/// MPEG audio version: 1, 2 or 2.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MpegVersion {
    V1,
    V2,
    V25,
}

/// An MPEG audio layer III frame header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mp3Header {
    pub version: MpegVersion,
    pub rate: u32,
    pub channels: u32,
    pub size: u64,
    pub samples: u32,
    pub kbps: u32,
}

impl FrameHeader for Mp3Header {
    fn parse(b: &[u8], i: usize) -> Option<Self> {
        mp3_header(b, i)
    }

    fn same(&self, o: &Self) -> bool {
        self.version == o.version && self.rate == o.rate
    }

    fn size(&self) -> u64 {
        self.size
    }
}

/// The MPEG audio layer III frame header at `b[i]`, when there is one.
pub fn mp3_header(b: &[u8], i: usize) -> Option<Mp3Header> {
    if i.checked_add(4)? > b.len() || b[i] != 0xff || b[i + 1] & 0xe0 != 0xe0 {
        return None;
    }
    let ver = (b[i + 1] >> 3) & 3;
    let layer = (b[i + 1] >> 1) & 3;
    if ver == 1 || layer != 1 {
        return None;
    }
    let br = usize::from(b[i + 2] >> 4);
    let sr = usize::from((b[i + 2] >> 2) & 3);
    if br == 0 || br == 15 || sr == 3 {
        return None;
    }
    let pad = u64::from((b[i + 2] >> 1) & 1);
    let mode = b[i + 3] >> 6;
    let version = match ver {
        3 => MpegVersion::V1,
        2 => MpegVersion::V2,
        _ => MpegVersion::V25,
    };
    let rate = [44100, 48000, 32000][sr]
        / match version {
            MpegVersion::V1 => 1,
            MpegVersion::V2 => 2,
            MpegVersion::V25 => 4,
        };
    let kbps = if version == MpegVersion::V1 { MP3_KBPS_V1 } else { MP3_KBPS_V2 }[br];
    let samples = if version == MpegVersion::V1 { 1152 } else { 576 };
    let size = (f64::from(samples) / 8.0 * f64::from(kbps) * 1000.0 / f64::from(rate)).floor() as u64 + pad;
    Some(Mp3Header { version, rate, channels: if mode == 3 { 1 } else { 2 }, size, samples, kbps })
}

/// An ADTS frame header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdtsHeader {
    pub object_type: u32,
    pub rate_index: usize,
    pub rate: u32,
    pub channels: u32,
    /// The whole frame.
    pub size: u64,
    /// The header: 7 bytes, or 9 with a CRC.
    pub header: u64,
    pub samples: u32,
}

impl FrameHeader for AdtsHeader {
    fn parse(b: &[u8], i: usize) -> Option<Self> {
        adts_header(b, i)
    }

    fn same(&self, o: &Self) -> bool {
        self.rate_index == o.rate_index && self.object_type == o.object_type && self.channels == o.channels
    }

    fn size(&self) -> u64 {
        self.size
    }
}

/// The ADTS frame header at `b[i]`, when there is one.
pub fn adts_header(b: &[u8], i: usize) -> Option<AdtsHeader> {
    if i.checked_add(7)? > b.len() || b[i] != 0xff || b[i + 1] & 0xf6 != 0xf0 {
        return None;
    }
    let header = if b[i + 1] & 1 != 0 { 7 } else { 9 };
    let profile = u32::from(b[i + 2] >> 6);
    let rate_index = usize::from((b[i + 2] >> 2) & 15);
    let channels = (u32::from(b[i + 2] & 1) << 2) | u32::from(b[i + 3] >> 6);
    let size = (u64::from(b[i + 3] & 3) << 11) | (u64::from(b[i + 4]) << 3) | u64::from(b[i + 5] >> 5);
    if rate_index >= 13 || size <= header {
        return None;
    }
    Some(AdtsHeader {
        object_type: profile + 1,
        rate_index,
        rate: AAC_RATES[rate_index],
        channels,
        size,
        header,
        samples: (u32::from(b[i + 6] & 3) + 1) * 1024,
    })
}

/// What the first bytes of an audio-only file are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioKind {
    /// An ID3v2 tag: what follows it decides.
    Id3,
    Mp3,
    Aac,
    Wav,
}

/// `Id3`, `Mp3` or `Aac` for the first bytes of a file: two frames in a row (or one that starts the file).
pub fn sniff(b: &[u8]) -> Option<AudioKind> {
    if b.len() >= 10 && starts(b, 0, b"ID3") {
        return Some(AudioKind::Id3);
    }
    let mut i = 0;
    while i + 7 <= b.len().min(4096) {
        if b[i] == 0xff {
            if let Some(a) = adts_header(b, i)
                && (adts_header(b, i + a.size as usize).is_some_and(|n| n.same(&a))
                    || (i == 0 && i as u64 + a.size + 7 > b.len() as u64))
            {
                return Some(AudioKind::Aac);
            }
            if let Some(m) = mp3_header(b, i)
                && (mp3_header(b, i + m.size as usize).is_some_and(|n| n.same(&m))
                    || (i == 0 && i as u64 + m.size + 4 > b.len() as u64))
            {
                return Some(AudioKind::Mp3);
            }
        }
        i += 1;
    }
    None
}

fn skip_id3<R: Reader + ?Sized>(reader: &R, mut pos: u64) -> Result<u64> {
    for _ in 0..16 {
        let h = read_range(reader, pos, 10)?;
        if h.len() < 10 || !starts(&h, 0, b"ID3") {
            return Ok(pos);
        }
        let size = (u64::from(h[6] & 127) << 21)
            | (u64::from(h[7] & 127) << 14)
            | (u64::from(h[8] & 127) << 7)
            | u64::from(h[9] & 127);
        pos += 10 + size + if h[5] & 0x10 != 0 { 10 } else { 0 };
    }
    Ok(pos)
}

/// A window over the file for a front-to-back scan.
struct Window<'r, R: Reader + ?Sized> {
    reader: &'r R,
    size: u64,
    win: Cow<'r, [u8]>,
    at: u64,
}

impl<'r, R: Reader + ?Sized> Window<'r, R> {
    fn ensure(&mut self, p: u64, n: u64) -> Result<()> {
        let end = self.at + self.win.len() as u64;
        if p >= self.at && p + n <= end {
            return Ok(());
        }
        if p >= self.at && end >= self.size && p < self.size {
            return Ok(());
        }
        self.win = read_range(self.reader, p, n.max(WINDOW))?;
        self.at = p;
        Ok(())
    }

    fn header<H: FrameHeader>(&mut self, p: u64) -> Result<Option<H>> {
        self.ensure(p, 16)?;
        Ok(H::parse(&self.win, (p - self.at) as usize))
    }

    fn tag(&mut self, p: u64) -> Result<bool> {
        self.ensure(p, 8)?;
        let i = (p - self.at) as usize;
        Ok([b"TAG", b"APE", b"ID3", b"LYR"].iter().any(|t| starts(&self.win, i, &t[..])))
    }

    /// A frame at `p` (of the stream of `reference`) followed by another, a tag or the file's end.
    fn valid<H: FrameHeader>(&mut self, p: u64, reference: Option<&H>) -> Result<Option<H>> {
        let Some(h) = self.header::<H>(p)? else { return Ok(None) };
        if reference.is_some_and(|r| !h.same(r)) {
            return Ok(None);
        }
        let next = p + h.size();
        if next > self.size {
            return Ok(None);
        }
        if next + 7 > self.size || self.tag(next)? {
            return Ok(Some(h));
        }
        Ok(self.header::<H>(next)?.filter(|n| n.same(&h)).map(|_| h))
    }
}

/// What a scan found besides its frames.
struct Scan {
    damaged: bool,
    truncated: bool,
}

/// Walks frames from `start`: `on_frame(offset, header, window, at)` for each.
fn scan_frames<R: Reader + ?Sized, H: FrameHeader>(
    reader: &R,
    start: u64,
    mut on_frame: impl FnMut(u64, &H, &[u8], usize) -> Result<()>,
) -> Result<Scan> {
    let size = reader.size();
    let mut w = Window { reader, size, win: Cow::Borrowed(&[]), at: 0 };
    let mut p = start;
    let mut reference: Option<H> = None;
    let mut scan = Scan { damaged: false, truncated: false };
    while p + 4 <= size {
        let mut h = w.header::<H>(p)?;
        if let (Some(x), Some(r)) = (&h, &reference)
            && !x.same(r)
        {
            h = None;
        }
        if let Some(x) = &h
            && p + x.size() > size
        {
            scan.truncated = true;
            break;
        }
        if h.is_some() && reference.is_none() {
            h = w.valid::<H>(p, None)?;
        }
        if let Some(x) = h {
            reference.get_or_insert(x);
            w.ensure(p, x.size())?;
            on_frame(p, &x, &w.win, (p - w.at) as usize)?;
            p += x.size();
            continue;
        }
        if reference.is_some() && w.tag(p)? {
            break;
        }
        let mut q = p + 1;
        let mut found = None;
        while q + 4 <= size {
            w.ensure(q, 4)?;
            let end = (w.at + w.win.len() as u64).saturating_sub(3);
            let mut i = (q - w.at) as usize;
            while q < end && !(byte(&w.win, i) == 0xff && byte(&w.win, i + 1) & 0xe0 == 0xe0) {
                i += 1;
                q += 1;
            }
            if q >= end {
                if w.at + w.win.len() as u64 >= size {
                    break;
                }
                continue;
            }
            if w.valid(q, reference.as_ref())?.is_some() {
                found = Some(q);
                break;
            }
            q += 1;
        }
        let Some(f) = found else { break };
        if reference.is_some() {
            scan.damaged = true;
        }
        p = f;
    }
    Ok(scan)
}

/// The Xing/Info or VBRI header in an MP3's first frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Xing {
    pub frames: Option<u32>,
    /// Encoder delay and padding in samples (LAME's tag).
    pub delay: u32,
    pub padding: u32,
}

/// The Xing/Info or VBRI header of a first frame that starts at `b[at]`.
pub fn xing_of(b: &[u8], at: usize, h: &Mp3Header) -> Option<Xing> {
    let side = match (h.version == MpegVersion::V1, h.channels == 1) {
        (true, true) => 17,
        (true, false) => 32,
        (false, true) => 9,
        (false, false) => 17,
    };
    let x = at + 4 + side;
    if starts(b, x, b"Xing") || starts(b, x, b"Info") {
        let flags = u32(b, x + 4);
        let mut p = x + 8;
        let frames = (flags & 1 != 0).then(|| u32(b, p));
        for (bit, len) in [(1, 4), (2, 4), (4, 100), (8, 4)] {
            if flags & bit != 0 {
                p += len;
            }
        }
        let (mut delay, mut padding) = (0, 0);
        if p + 24 <= b.len() && [b"LAME", b"Lavc", b"Lavf", b"GOGO"].iter().any(|t| starts(b, p, &t[..])) {
            delay = (u32::from(b[p + 21]) << 4) | (u32::from(b[p + 22]) >> 4);
            padding = (u32::from(b[p + 22] & 15) << 8) | u32::from(b[p + 23]);
        }
        return Some(Xing { frames, delay, padding });
    }
    starts(b, at + 36, b"VBRI").then(|| Xing { frames: Some(u32(b, at + 36 + 14)), delay: 0, padding: 0 })
}

/// The track of an audio-only file.
struct Stream {
    codec: String,
    description: Option<Vec<u8>>,
    channels: u32,
    /// Samples of encoder delay off the front (gapless MP3), and of padding off the end.
    skip: i64,
    padding: i64,
    truncated: bool,
}

/// Sample-count times -> ticks.
fn audio_source(container: Container, tb: TableBuilder, rate: u32, s: Stream) -> Source {
    let mut t = tb.t;
    let clock = Clock::new(rate.into());
    let mut end = 0;
    for i in 0..t.count() {
        t.dts[i] = clock.ticks(t.dts[i] - s.skip);
        t.pts[i] = t.dts[i];
        t.duration[i] = clock.ticks(t.duration[i]);
        end = t.pts[i] + t.duration[i];
    }
    let duration = (end - clock.ticks(s.padding)).max(0);
    finish_track(&mut t, None, 0.0);
    let tracks = if t.is_empty() {
        Vec::new()
    } else {
        vec![Track {
            id: 1,
            media: Media::Audio(Audio { sample_rate: rate, channels: s.channels }),
            codec: s.codec,
            description: s.description,
            duration,
            truncated: s.truncated,
            pre_roll: 0,
            sample_prefix: None,
            samples: t,
        }]
    };
    Source { duration, tracks, ..Source::empty(Some(container), None) }
}

fn open_mp3<R: Reader + ?Sized>(reader: &R, start: u64) -> Result<Source> {
    let mut tb = TableBuilder::new(8192);
    let mut first: Option<Mp3Header> = None;
    let mut xing = None;
    let mut frames: i64 = 0;
    let scan = scan_frames(reader, start, |p, h: &Mp3Header, b, at| {
        if first.is_none() {
            first = Some(*h);
            xing = xing_of(b, at, h);
            if xing.is_some() {
                return Ok(());
            }
        }
        let t = frames * i64::from(h.samples);
        tb.push(p, h.size as u32, t, t, h.samples.into(), true)?;
        frames += 1;
        Ok(())
    })?;
    let Some(first) = first else { return damaged("no MPEG audio frames") };
    let gapless = xing.is_some_and(|x| x.delay != 0 || x.padding != 0);
    let stream = Stream {
        codec: "mp3".into(),
        description: None,
        channels: first.channels,
        skip: if gapless { xing.map_or(0, |x| i64::from(x.delay) + 529) } else { 0 },
        padding: xing.map_or(0, |x| x.padding.into()),
        truncated: scan.truncated || xing.and_then(|x| x.frames).is_some_and(|f| i64::from(f) > frames + 1),
    };
    Ok(audio_source(Container::Mp3, tb, first.rate, stream))
}

fn open_adts<R: Reader + ?Sized>(reader: &R, start: u64) -> Result<Source> {
    let mut tb = TableBuilder::new(8192);
    let mut first: Option<AdtsHeader> = None;
    let mut at: i64 = 0;
    let scan = scan_frames(reader, start, |p, h: &AdtsHeader, _, _| {
        first.get_or_insert(*h);
        tb.push(p + h.header, (h.size - h.header) as u32, at, at, h.samples.into(), true)?;
        at += i64::from(h.samples);
        Ok(())
    })?;
    let Some(first) = first else { return damaged("no ADTS frames") };
    if first.channels == 0 {
        return unsupported("ADTS with a program config element");
    }
    let description = build_audio_specific_config(first.object_type.into(), first.rate.into(), first.channels.into());
    let stream = Stream {
        codec: format!("mp4a.40.{}", first.object_type),
        description: Some(description),
        channels: first.channels,
        skip: 0,
        padding: 0,
        truncated: scan.truncated,
    };
    Ok(audio_source(Container::Aac, tb, first.rate, stream))
}

/// A number as JavaScript prints it in a message.
fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 { format!("{}", v as i64) } else { v.to_string() }
}

fn open_wav<R: Reader + ?Sized>(reader: &R) -> Result<Source> {
    let size = reader.size();
    let head = read_range(reader, 0, 12)?;
    let riff = starts(&head, 0, b"RIFF");
    let mut pos: u64 = 12;
    let mut fmt: Option<Vec<u8>> = None;
    let mut data: Option<(u64, u64, bool)> = None;
    let mut ds64: Option<u64> = None;
    for _ in 0..100_000 {
        if pos.saturating_add(8) > size {
            break;
        }
        let c = read_range(reader, pos, 8)?;
        let id = crate::bytes::fourcc(&c, 0);
        if c.len() < 4 || !id.iter().all(|x| (0x20..=0x7e).contains(x)) {
            break;
        }
        let mut len = u64::from(le32(&c, 4));
        match &id {
            b"ds64" => {
                let d = read_range(reader, pos + 8, len.min(28))?;
                if d.len() >= 24 {
                    ds64 = Some(le64(&d, 8));
                }
            }
            b"fmt " => fmt = Some(read_range(reader, pos + 8, len.min(64))?.into_owned()),
            b"data" => {
                let room = size - pos - 8;
                if len == 0xffff_ffff {
                    len = match ds64 {
                        Some(d) if !riff => d,
                        _ => room,
                    };
                } else if len == 0 && pos + 8 < size {
                    len = room;
                }
                data = Some((pos + 8, len.min(room), len > room));
                if fmt.is_some() {
                    break;
                }
            }
            _ => {}
        }
        pos = pos.saturating_add(8).saturating_add(len).saturating_add(len & 1);
    }
    let fmt = match fmt {
        Some(f) if f.len() >= 16 => f,
        _ => return damaged("no fmt chunk"),
    };
    let Some((data_at, data_len, cut)) = data else { return damaged("no data chunk") };
    let mut tag = le16(&fmt, 0);
    let channels = le16(&fmt, 2);
    let rate = le32(&fmt, 4);
    let align = le16(&fmt, 12);
    let mut bits = f64::from(le16(&fmt, 14));
    if tag == 0xfffe && fmt.len() >= 26 {
        tag = le16(&fmt, 24);
    }
    if channels == 0 || rate == 0 || align == 0 {
        return damaged("bad fmt chunk");
    }
    if f64::from(align) != f64::from(channels) * (bits / 8.0) {
        bits = f64::from(align) / f64::from(channels) * 8.0;
    }
    let codec = match (tag, bits as u32) {
        _ if bits.fract() != 0.0 => None,
        (1, 8) => Some("pcm-u8"),
        (1, 16) => Some("pcm-s16"),
        (1, 24) => Some("pcm-s24"),
        (1, 32) => Some("pcm-s32"),
        (3, 32) => Some("pcm-f32"),
        (3, 64) => Some("pcm-f64"),
        _ => None,
    };
    let Some(codec) = codec else { return unsupported(format!("WAV format {tag} with {} bits", js_number(bits))) };
    let align = u64::from(align);
    let frames = data_len / align;
    let piece = u64::from(rate).min((1 << 20) / align).max(1);
    let mut tb = TableBuilder::new((frames.div_ceil(piece) + 1).try_into().unwrap_or(usize::MAX));
    let mut f = 0;
    while f < frames {
        let k = piece.min(frames - f);
        tb.push(data_at + f * align, (k * align) as u32, f as i64, f as i64, k as i64, true)?;
        f += piece;
    }
    let stream = Stream {
        codec: codec.into(),
        description: None,
        channels: channels.into(),
        skip: 0,
        padding: 0,
        truncated: cut,
    };
    Ok(audio_source(Container::Wav, tb, rate, stream))
}

/// reader -> Source for an audio-only file `kind` (what [`sniff`] or the RIFF header said).
pub fn open<R: Reader + ?Sized>(reader: &R, kind: AudioKind) -> Result<Source> {
    let (start, kind) = match kind {
        AudioKind::Wav => return open_wav(reader),
        AudioKind::Id3 => {
            let start = skip_id3(reader, 0)?;
            match sniff(&read_range(reader, start, 4096)?) {
                Some(k @ (AudioKind::Mp3 | AudioKind::Aac)) => (start, k),
                _ => return unsupported("an ID3 tag without MPEG audio after it"),
            }
        }
        k => (0, k),
    };
    if kind == AudioKind::Aac { open_adts(reader, start) } else { open_mp3(reader, start) }
}
