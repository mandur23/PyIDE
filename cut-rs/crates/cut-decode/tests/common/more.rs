//! Test media in the codecs beyond H.264, HEVC and AAC: FLAC and MP3 from Media Foundation's encoders, VP8 and VP9
//! from the VP9 Video Extensions' encoder, Opus remuxed from the `voice.webm` fixture (this PC has no Opus encoder),
//! written as WebM / Matroska ([`super::mkv`]), MP4 (cut-formats' writer, its sample entry swapped for FLAC) or bare
//! MP3. Files are cached by name in the output directory, like [`super::make`]'s.

use std::path::PathBuf;

use cut_decode::Codec;
use cut_decode::Format;
use cut_decode::encode_formats::{Encoded, encode_audio, encode_vpx};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample};
use cut_formats::probe::read_samples;
use cut_formats::{FileReader, Track, probe};
use cut_time::{TICKS, rescale};

use super::mkv::{Block, MkvTrack, write};
use super::{make, out_dir};

pub const RATE: u32 = 48000;

fn cached(name: &str, make: impl FnOnce() -> Vec<u8>) -> PathBuf {
    let path = out_dir().join(name);
    if !path.exists() {
        let bytes = make();
        let part = path.with_extension(format!("part-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::write(&part, bytes).expect("written");
        std::fs::rename(&part, &path).expect("renamed");
    }
    path
}

/// FLAC of interleaved 16-bit `pcm` at 48 kHz: the `fLaC` metadata (STREAMINFO first) and one frame a block of 4096.
pub fn flac(pcm: &[i16], channels: u32) -> (Vec<u8>, Vec<Vec<u8>>) {
    let e: Encoded = encode_audio(Format::Flac, pcm, RATE, channels, 0).expect("FLAC encoded");
    let mut head = Vec::new();
    let mut frames = Vec::new();
    for s in e.samples {
        if s.data.first() == Some(&0xff) {
            frames.push(s.data);
        } else {
            head.extend_from_slice(&s.data);
        }
    }
    assert!(head.starts_with(b"fLaC"), "the encoder writes the stream header first");
    let blocks = (pcm.len() / channels as usize).div_ceil(4096);
    assert_eq!(frames.len(), blocks, "one FLAC frame a block of 4096");
    (head, frames)
}

/// FLAC in Matroska (`A_FLAC`, the `fLaC` metadata as CodecPrivate).
pub fn flac_mkv(name: &str, pcm: &[i16], channels: u32) -> PathBuf {
    cached(name, || {
        let (head, frames) = flac(pcm, channels);
        flac_mkv_of(head, frames, channels, pcm.len() as i64 / i64::from(channels))
    })
}

/// The Matroska file of FLAC frames of 4096 samples (`n` in all) and their metadata, as given (damaged ones too).
pub fn flac_mkv_of(head: Vec<u8>, frames: Vec<Vec<u8>>, channels: u32, n: i64) -> Vec<u8> {
    let count = frames.len();
    let ns = |samples: i64| samples * 1_000_000_000 / i64::from(RATE);
    let blocks = frames
        .into_iter()
        .enumerate()
        .map(|(k, data)| Block {
            track: 1,
            data,
            time_ns: ns(k as i64 * 4096),
            key: true,
            duration_ns: (k + 1 == count).then(|| ns(n - k as i64 * 4096)),
        })
        .collect::<Vec<_>>();
    let track = MkvTrack {
        codec_id: "A_FLAC",
        private: Some(head),
        codec_delay_ns: 0,
        seek_pre_roll_ns: 0,
        audio: Some((f64::from(RATE), channels.into())),
        video: None,
    };
    write(false, &[track], &blocks)
}

/// FLAC in MP4: cut-formats' writer makes the file around an Opus entry, then the entry becomes `fLaC` with a
/// `dfLa` of the STREAMINFO (the writer keeps moov after mdat, so no chunk offset moves).
pub fn flac_mp4(name: &str, pcm: &[i16], channels: u32) -> PathBuf {
    cached(name, || {
        let (head, frames) = flac(pcm, channels);
        let n = pcm.len() as i64 / i64::from(channels);
        let config = AudioConfig { codec: "opus".into(), sample_rate: RATE, channels, description: None };
        let mut w = Mp4Writer::create(None, Some(config), Vec::new(), None).expect("a writer");
        for (k, data) in frames.into_iter().enumerate() {
            let at = k as i64 * 4096;
            let len = 4096.min(n - at);
            let sample = Sample {
                data,
                timestamp: rescale(at, RATE.into()),
                duration: rescale(len, RATE.into()),
                key: true,
                composition_offset: 0,
            };
            w.add_audio(sample).expect("a sample");
        }
        w.finish().expect("finished");
        let file = w.into_sink();
        let si = &head[4..4 + 38];
        let mut dfla = vec![0, 0, 0, 0];
        dfla.push(0x80);
        dfla.extend_from_slice(&si[1..]);
        let mut entry = Vec::new();
        entry.extend([0u8; 6]);
        entry.extend(1u16.to_be_bytes());
        entry.extend([0u8; 8]);
        entry.extend((channels as u16).to_be_bytes());
        entry.extend(16u16.to_be_bytes());
        entry.extend([0u8; 4]);
        entry.extend((RATE << 16).to_be_bytes());
        entry.extend(boxed(b"dfLa", &dfla));
        replace_entry(file, b"Opus", &boxed(b"fLaC", &entry))
    })
}

/// ALAC in MP4 from Media Foundation's ALAC encoder (one frame a block of 4096): the writer makes the file around an
/// Opus entry, then the entry becomes `alac` with an ALACSpecificConfig in its `alac` box.
pub fn alac_mp4(name: &str, pcm: &[i16], channels: u32) -> PathBuf {
    cached(name, || {
        let e = encode_audio(Format::Alac, pcm, RATE, channels, 0).expect("ALAC encoded");
        // The encoder's output type carries no magic cookie: its frames are those of Apple's defaults.
        assert!(e.user_data.is_empty(), "a cookie came: use it");
        let mut config = 4096u32.to_be_bytes().to_vec();
        config.extend([0, 16, 40, 10, 14, channels as u8]);
        config.extend(255u16.to_be_bytes());
        config.extend([0u8; 8]);
        config.extend(RATE.to_be_bytes());
        let n = pcm.len() as i64 / i64::from(channels);
        let audio = AudioConfig { codec: "opus".into(), sample_rate: RATE, channels, description: None };
        let mut w = Mp4Writer::create(None, Some(audio), Vec::new(), None).expect("a writer");
        for (k, s) in e.samples.into_iter().enumerate() {
            let at = k as i64 * 4096;
            let sample = Sample {
                data: s.data,
                timestamp: rescale(at, RATE.into()),
                duration: rescale(4096.min(n - at), RATE.into()),
                key: true,
                composition_offset: 0,
            };
            w.add_audio(sample).expect("a sample");
        }
        w.finish().expect("finished");
        let mut body = vec![0, 0, 0, 0];
        body.extend_from_slice(&config);
        let mut entry = Vec::new();
        entry.extend([0u8; 6]);
        entry.extend(1u16.to_be_bytes());
        entry.extend([0u8; 8]);
        entry.extend((channels as u16).to_be_bytes());
        entry.extend(16u16.to_be_bytes());
        entry.extend([0u8; 4]);
        entry.extend((RATE << 16).to_be_bytes());
        entry.extend(boxed(b"alac", &body));
        replace_entry(w.into_sink(), b"Opus", &boxed(b"alac", &entry))
    })
}

fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    b.extend_from_slice(kind);
    b.extend_from_slice(body);
    b
}

/// The file with the sample entry `kind` in moov replaced by `entry`, every box around it resized.
fn replace_entry(file: Vec<u8>, kind: &[u8; 4], entry: &[u8]) -> Vec<u8> {
    let moov = find(&file, 0, file.len(), b"moov").expect("a moov");
    let at = (moov..file.len() - 4).find(|&p| &file[p + 4..p + 8] == kind).expect("the sample entry");
    let old = u32::from_be_bytes(file[at..at + 4].try_into().expect("4 bytes")) as usize;
    let delta = entry.len() as i64 - old as i64;
    let mut out = file;
    let end = out.len();
    grow_inside(&mut out, 0, end, at, delta, &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd"]);
    out.splice(at..at + old, entry.iter().copied());
    out
}

/// A box's size, its 64-bit largesize when the 32-bit one is 1.
fn size_at(b: &[u8], p: usize) -> usize {
    match u32::from_be_bytes(b[p..p + 4].try_into().expect("4 bytes")) {
        1 => u64::from_be_bytes(b[p + 8..p + 16].try_into().expect("8 bytes")) as usize,
        n => n as usize,
    }
}

fn find(b: &[u8], mut p: usize, end: usize, kind: &[u8; 4]) -> Option<usize> {
    while p + 8 <= end {
        let size = size_at(b, p);
        if &b[p + 4..p + 8] == kind {
            return Some(p);
        }
        p += size.max(8);
    }
    None
}

/// Adds `delta` to the size of each box in `[p, end)` on the path down to `at`, looking inside the container kinds.
fn grow_inside(b: &mut [u8], mut p: usize, end: usize, at: usize, delta: i64, containers: &[&[u8; 4]]) {
    while p + 8 <= end {
        let size = size_at(b, p);
        if p < at && at < p + size {
            let kind: [u8; 4] = b[p + 4..p + 8].try_into().expect("4 bytes");
            b[p..p + 4].copy_from_slice(&((size as i64 + delta) as u32).to_be_bytes());
            if containers.contains(&&kind) {
                let inner = if &kind == b"stsd" { 16 } else { 8 };
                grow_inside(b, p + inner, p + size, at, delta, containers);
            }
            return;
        }
        p += size.max(8);
    }
}

/// An MP3 file of interleaved 16-bit `pcm` at 48 kHz, 128 kbit/s. With `gapless`, an Info frame with a LAME tag
/// saying the encoder's delay is `gapless` samples goes in front, and its padding is what fills the last frame.
pub fn mp3(name: &str, pcm: &[i16], channels: u32, gapless: Option<u32>) -> PathBuf {
    cached(name, || {
        let e = encode_audio(Format::Mp3, pcm, RATE, channels, 16000).expect("MP3 encoded");
        let stream: Vec<u8> = e.samples.iter().flat_map(|s| s.data.iter().copied()).collect();
        let Some(delay) = gapless else { return stream };
        let frames = count_frames(&stream);
        let n = pcm.len() as u32 / channels;
        let padding = frames * 1152 - delay - n;
        let mut out = info_frame(&stream[..4], channels, frames, delay, padding);
        out.extend(stream);
        out
    })
}

fn count_frames(stream: &[u8]) -> u32 {
    let mut p = 0;
    let mut n = 0;
    while p + 4 <= stream.len() && stream[p] == 0xff && stream[p + 1] & 0xe0 == 0xe0 {
        let bitrate =
            [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][usize::from(stream[p + 2] >> 4)];
        let rate = [44100, 48000, 32000, 0][usize::from((stream[p + 2] >> 2) & 3)];
        let pad = usize::from((stream[p + 2] >> 1) & 1);
        p += 144_000 * bitrate / rate + pad;
        n += 1;
    }
    assert_eq!(p, stream.len(), "MPEG-1 Layer III frames end to end");
    n
}

/// A silent first frame with the stream's header (padding bit cleared) carrying `Info` and a LAME tag.
fn info_frame(header: &[u8], channels: u32, frames: u32, delay: u32, padding: u32) -> Vec<u8> {
    let mut h = header.to_vec();
    h[2] &= !0x02;
    let bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][usize::from(h[2] >> 4)];
    let rate = [44100, 48000, 32000, 0][usize::from((h[2] >> 2) & 3)];
    let size = 144_000 * bitrate / rate;
    let mut f = vec![0u8; size];
    f[..4].copy_from_slice(&h);
    let x = 4 + if channels == 1 { 17 } else { 32 };
    f[x..x + 4].copy_from_slice(b"Info");
    f[x + 4..x + 8].copy_from_slice(&1u32.to_be_bytes());
    f[x + 8..x + 12].copy_from_slice(&frames.to_be_bytes());
    let p = x + 12;
    f[p..p + 9].copy_from_slice(b"LAME3.100");
    f[p + 21] = (delay >> 4) as u8;
    f[p + 22] = (((delay & 15) << 4) | (padding >> 8)) as u8;
    f[p + 23] = padding as u8;
    f
}

/// The Opus packets of the `voice.webm` fixture (mono, 20 ms each) with their pts (ticks, the pre-skip before 0)
/// and the fixture's OpusHead.
/// A packet's bytes, pts and duration in ticks.
pub type Packet = (Vec<u8>, i64, i64);

pub fn voice_packets() -> (Vec<Packet>, Vec<u8>, Track) {
    let reader = FileReader::open(super::fixture("video/voice.webm")).expect("the fixture");
    let source = probe::open(&reader, "voice.webm");
    let track = source.tracks.into_iter().next().expect("a track");
    let mut out = Vec::new();
    read_samples(&reader, &track, 0, track.samples.count(), |i, b| {
        out.push((b.to_vec(), track.samples.pts[i], track.samples.duration[i]));
    })
    .expect("packets");
    let head = track.description.clone().expect("an OpusHead");
    (out, head, track)
}

/// The fixture's Opus packets in MP4 (cut-formats' writer; the pre-skip becomes an edit list).
pub fn opus_mp4(name: &str) -> PathBuf {
    cached(name, || {
        let (packets, head, _) = voice_packets();
        let config = AudioConfig { codec: "opus".into(), sample_rate: RATE, channels: 1, description: Some(head) };
        let mut w = Mp4Writer::create(None, Some(config), Vec::new(), None).expect("a writer");
        for (data, pts, duration) in packets {
            let sample = Sample { data, timestamp: pts, duration, key: true, composition_offset: 0 };
            w.add_audio(sample).expect("a sample");
        }
        w.finish().expect("finished");
        w.into_sink()
    })
}

/// The fixture's mono Opus packets as one stream of a mapping family 1 track of `channels`, the stream routed to
/// Vorbis-order channel `to` and every other channel silent (mapping 255), in WebM with the fixture's pre-skip and
/// 80 ms pre-roll.
pub fn opus_routed_webm(name: &str, channels: u8, to: u8) -> PathBuf {
    cached(name, || {
        let (packets, head, _) = voice_packets();
        let pre_skip = u16::from_le_bytes([head[10], head[11]]);
        let mut h = b"OpusHead".to_vec();
        h.extend([1, channels]);
        h.extend(pre_skip.to_le_bytes());
        h.extend(48000u32.to_le_bytes());
        h.extend(0i16.to_le_bytes());
        h.push(1);
        h.extend([1, 0]);
        h.extend((0..channels).map(|c| if c == to { 0 } else { 255 }));
        let delay_ns = i64::from(pre_skip) * 1_000_000_000 / 48000;
        let blocks = packets
            .into_iter()
            .map(|(data, pts, _)| Block {
                track: 1,
                data,
                time_ns: (i128::from(pts) * 1_000_000_000 / i128::from(TICKS)) as i64 + delay_ns,
                key: true,
                duration_ns: None,
            })
            .collect::<Vec<_>>();
        let track = MkvTrack {
            codec_id: "A_OPUS",
            private: Some(h),
            codec_delay_ns: delay_ns as u64,
            seek_pre_roll_ns: 80_000_000,
            audio: Some((48000.0, channels.into())),
            video: None,
        };
        write(true, &[track], &blocks)
    })
}

/// An Opus frame length as packets code it.
fn opus_size(n: usize) -> Vec<u8> {
    if n < 252 { vec![n as u8] } else { vec![(252 + n % 4) as u8, ((n - 252) / 4) as u8] }
}

/// A plain Opus packet in the self-delimiting framing of RFC 6716 appendix B (its last frame's length added after
/// the length fields it has).
pub fn self_delimited(p: &[u8]) -> Vec<u8> {
    let read = |at: usize| {
        if p[at] < 252 { (usize::from(p[at]), 1) } else { (usize::from(p[at]) + 4 * usize::from(p[at + 1]), 2) }
    };
    let (header, last) = match p[0] & 3 {
        0 => (1, p.len() - 1),
        1 => (1, (p.len() - 1) / 2),
        2 => {
            let (n1, l1) = read(1);
            (1 + l1, p.len() - 1 - l1 - n1)
        }
        _ => {
            let (vbr, padded, m) = (p[1] & 0x80 != 0, p[1] & 0x40 != 0, usize::from(p[1] & 0x3f));
            let (mut at, mut padding) = (2, 0);
            if padded {
                loop {
                    let v = usize::from(p[at]);
                    at += 1;
                    padding += if v == 255 { 254 } else { v };
                    if v != 255 {
                        break;
                    }
                }
            }
            let mut sum = 0;
            if vbr {
                for _ in 0..m - 1 {
                    let (n, l) = read(at);
                    sum += n;
                    at += l;
                }
            }
            let frames = p.len() - at - padding;
            (at, if vbr { frames - sum } else { frames / m })
        }
    };
    let mut out = p[..header].to_vec();
    out.extend(opus_size(last));
    out.extend_from_slice(&p[header..]);
    out
}

/// The fixture's mono Opus packets as every stream of a mapping family 1 track: `streams` uncoupled streams (all
/// the same packet), output channel `c` from stream `table[c]` (255 silent), in WebM with the fixture's pre-skip.
pub fn opus_streams_webm(name: &str, streams: u8, table: &[u8]) -> PathBuf {
    cached(name, || {
        let (packets, head, _) = voice_packets();
        let pre_skip = u16::from_le_bytes([head[10], head[11]]);
        let mut h = b"OpusHead".to_vec();
        h.extend([1, table.len() as u8]);
        h.extend(pre_skip.to_le_bytes());
        h.extend(48000u32.to_le_bytes());
        h.extend(0i16.to_le_bytes());
        h.push(1);
        h.extend([streams, 0]);
        h.extend(table);
        let delay_ns = i64::from(pre_skip) * 1_000_000_000 / 48000;
        let blocks = packets
            .into_iter()
            .map(|(data, pts, _)| {
                let mut joined = Vec::new();
                for _ in 1..streams {
                    joined.extend(self_delimited(&data));
                }
                joined.extend(&data);
                Block {
                    track: 1,
                    data: joined,
                    time_ns: (i128::from(pts) * 1_000_000_000 / i128::from(TICKS)) as i64 + delay_ns,
                    key: true,
                    duration_ns: None,
                }
            })
            .collect::<Vec<_>>();
        let track = MkvTrack {
            codec_id: "A_OPUS",
            private: Some(h),
            codec_delay_ns: delay_ns as u64,
            seek_pre_roll_ns: 80_000_000,
            audio: Some((48000.0, table.len() as u64)),
            video: None,
        };
        write(true, &[track], &blocks)
    })
}

/// VP8 or VP9 in WebM: `frames` frames of the frame-number picture at 30 fps.
pub fn vpx_webm(name: &str, codec: Codec, width: u32, height: u32, frames: u32) -> PathBuf {
    cached(name, || {
        let e = encode_vpx(codec, width, height, [30, 1], frames, |i, px| make::draw(i, px, width, height, false))
            .expect("encoded");
        assert_eq!(e.samples.len(), frames as usize, "one sample a frame");
        let blocks = e
            .samples
            .into_iter()
            .enumerate()
            .map(|(k, s)| Block {
                track: 1,
                data: s.data,
                time_ns: k as i64 * 1_000_000_000 / 30,
                key: s.key,
                duration_ns: None,
            })
            .collect::<Vec<_>>();
        let track = MkvTrack {
            codec_id: if codec == Codec::Vp8 { "V_VP8" } else { "V_VP9" },
            private: None,
            codec_delay_ns: 0,
            seek_pre_roll_ns: 0,
            audio: None,
            video: Some((width, height)),
        };
        write(true, &[track], &blocks)
    })
}

/// A WebM with VP9 video (the frame-number picture, 30 frames) and, when `with_video` or alone, a Vorbis track
/// whose packets are never decoded (this PC has no Vorbis decoder it may use): its headers in CodecPrivate as
/// Matroska carries them (Xiph-laced), its blocks placeholders.
pub fn vorbis_webm(name: &str, with_video: bool) -> PathBuf {
    cached(name, || {
        let mut id = vec![1];
        id.extend(b"vorbis");
        id.extend(0u32.to_le_bytes());
        id.push(2);
        id.extend(48000u32.to_le_bytes());
        id.extend([0u8; 12]);
        id.extend([0xb8, 1]);
        let comment = b"\x03vorbis\0\0\0\0\0\0\0\0\x01".to_vec();
        let setup = b"\x05vorbis\0".to_vec();
        let mut private = vec![2, id.len() as u8, comment.len() as u8];
        private.extend(id);
        private.extend(comment);
        private.extend(setup);
        let audio = MkvTrack {
            codec_id: "A_VORBIS",
            private: Some(private),
            codec_delay_ns: 0,
            seek_pre_roll_ns: 0,
            audio: Some((48000.0, 2)),
            video: None,
        };
        let mut tracks = vec![audio];
        let mut blocks = Vec::new();
        if with_video {
            let e = encode_vpx(Codec::Vp9, 320, 240, [30, 1], 30, |i, px| make::draw(i, px, 320, 240, false))
                .expect("encoded");
            for (k, f) in e.samples.into_iter().enumerate() {
                let time_ns = k as i64 * 1_000_000_000 / 30;
                blocks.push(Block { track: 1, data: f.data, time_ns, key: f.key, duration_ns: None });
            }
            let video = MkvTrack {
                codec_id: "V_VP9",
                private: None,
                codec_delay_ns: 0,
                seek_pre_roll_ns: 0,
                audio: None,
                video: Some((320, 240)),
            };
            tracks.insert(0, video);
        }
        let track = tracks.len() as u8;
        for k in 0..50 {
            blocks.push(Block { track, data: vec![0; 40], time_ns: k * 20_000_000, key: true, duration_ns: None });
        }
        blocks.sort_by_key(|b| b.time_ns);
        write(true, &tracks, &blocks)
    })
}
