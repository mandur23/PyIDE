//! A small Matroska / WebM writer for test media: tracks numbered from 1, SimpleBlocks (a BlockGroup when a block
//! states its duration) in clusters, times in microseconds.

/// A track to write.
pub struct MkvTrack {
    /// `A_OPUS`, `A_FLAC`, `A_VORBIS`, `V_VP9` ...
    pub codec_id: &'static str,
    pub private: Option<Vec<u8>>,
    pub codec_delay_ns: u64,
    pub seek_pre_roll_ns: u64,
    pub audio: Option<(f64, u64)>,
    pub video: Option<(u32, u32)>,
}

/// One block: its track (from 1), bytes, presentation time in nanoseconds (before the codec delay), whether it is a
/// key frame, and its duration when the file should say it (the last block of a track).
pub struct Block {
    pub track: u8,
    pub data: Vec<u8>,
    pub time_ns: i64,
    pub key: bool,
    pub duration_ns: Option<i64>,
}

fn vint_size(n: u64) -> Vec<u8> {
    let mut b = vec![0x01];
    b.extend_from_slice(&n.to_be_bytes()[1..]);
    b
}

fn el(id: u32, body: &[u8]) -> Vec<u8> {
    let idb = id.to_be_bytes();
    let skip = idb.iter().take_while(|&&b| b == 0).count();
    let mut out = idb[skip..].to_vec();
    out.extend(vint_size(body.len() as u64));
    out.extend_from_slice(body);
    out
}

fn uint(id: u32, v: u64) -> Vec<u8> {
    el(id, &v.to_be_bytes())
}

fn float(id: u32, v: f64) -> Vec<u8> {
    el(id, &v.to_be_bytes())
}

/// The file's bytes, blocks in time order. `webm` picks the DocType.
pub fn write(webm: bool, tracks: &[MkvTrack], blocks: &[Block]) -> Vec<u8> {
    const SCALE: i64 = 1000;
    let mut header = Vec::new();
    for (id, v) in [(0x4286, 1), (0x42F7, 1), (0x42F2, 4), (0x42F3, 8)] {
        header.extend(uint(id, v));
    }
    header.extend(el(0x4282, if webm { b"webm" } else { b"matroska" }));
    header.extend(uint(0x4287, 4));
    header.extend(uint(0x4285, 2));
    let mut out = el(0x1A45_DFA3, &header);

    let end = blocks.iter().map(|b| b.time_ns).max().unwrap_or(0);
    let mut info = uint(0x2A_D7B1, SCALE as u64);
    info.extend(el(0x4D80, b"cut-decode tests"));
    info.extend(el(0x5741, b"cut-decode tests"));
    info.extend(float(0x4489, end as f64 / SCALE as f64));
    let mut entries = Vec::new();
    for (k, t) in tracks.iter().enumerate() {
        let mut entry = uint(0xD7, k as u64 + 1);
        entry.extend(uint(0x73C5, k as u64 + 1));
        entry.extend(uint(0x83, if t.video.is_some() { 1 } else { 2 }));
        entry.extend(el(0x86, t.codec_id.as_bytes()));
        if let Some(p) = &t.private {
            entry.extend(el(0x63A2, p));
        }
        if t.codec_delay_ns != 0 {
            entry.extend(uint(0x56AA, t.codec_delay_ns));
        }
        if t.seek_pre_roll_ns != 0 {
            entry.extend(uint(0x56BB, t.seek_pre_roll_ns));
        }
        if let Some((w, h)) = t.video {
            let mut v = uint(0xB0, w.into());
            v.extend(uint(0xBA, h.into()));
            entry.extend(el(0xE0, &v));
        }
        if let Some((rate, channels)) = t.audio {
            let mut a = float(0xB5, rate);
            a.extend(uint(0x9F, channels));
            entry.extend(el(0xE1, &a));
        }
        entries.extend(el(0xAE, &entry));
    }
    let mut segment = el(0x1549_A966, &info);
    segment.extend(el(0x1654_AE6B, &entries));

    let mut k = 0;
    while k < blocks.len() {
        let base = blocks[k].time_ns.div_euclid(SCALE);
        let mut cluster = uint(0xE7, base.max(0) as u64);
        let base = base.max(0);
        while k < blocks.len() {
            let rel = blocks[k].time_ns.div_euclid(SCALE) - base;
            if !(i16::MIN.into()..=i16::MAX.into()).contains(&rel) {
                break;
            }
            let b = &blocks[k];
            let mut sb = vec![0x80 | b.track];
            sb.extend((rel as i16).to_be_bytes());
            match b.duration_ns {
                None => {
                    sb.push(if b.key { 0x80 } else { 0 });
                    sb.extend_from_slice(&b.data);
                    cluster.extend(el(0xA3, &sb));
                }
                Some(d) => {
                    sb.push(0);
                    sb.extend_from_slice(&b.data);
                    let mut group = el(0xA1, &sb);
                    group.extend(uint(0x9B, (d / SCALE) as u64));
                    cluster.extend(el(0xA0, &group));
                }
            }
            k += 1;
        }
        segment.extend(el(0x1F43_B675, &cluster));
    }
    out.extend(el(0x1853_8067, &segment));
    out
}
