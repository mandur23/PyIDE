//! WebM and Matroska -> a Source. The EBML header, Info, Tracks and Cues are read whole; then every Cluster is walked
//! for its SimpleBlocks and BlockGroups (Xiph, EBML and fixed lacing), in large windows when the blocks are small and
//! with a read per block when they are big. Clusters of unknown size (MediaRecorder writes them) end at the next
//! level-1 element. After a damaged stretch the walk goes on at the next Cluster (from Cues, or by searching for its
//! ID). Matroska stores presentation times only: decode times are the sorted presentation times.

mod clusters;
mod ebml;
mod tracks;

use std::borrow::Cow;

use cut_time::{TICKS, Ticks};

use crate::codecs::merge_color;
use crate::codecs::vpx::{parse_vp9_frame, vp9_codec_string, vp9_level};
use crate::error::{FormatError, Result, damaged, unsupported};
use crate::reader::{Reader, read_range};
use crate::source::{Audio, Container, Kind, Media, SampleTable, Skipped, Source, Track, Video};
use crate::table::{TableBuilder, dim, finish_track, js_round, rescale, rescale_f, to_i64};
use clusters::{Cursor, Scan, TrackState};
pub use ebml::{El, Header, elements, header, id};
use ebml::{Fields, text, whole};
use tracks::{Info, VideoSettings, parse_cues, parse_info, parse_seek_head, parse_tracks, read_element, read_whole};

// ---- tracks ----------------------------------------------------------------------------------------------------------

/// What `BigInt(x)` and a division by `BigInt(0)` say, for a number the JavaScript cannot rescale.
fn not_integer(v: f64) -> FormatError {
    if v == 0.0 {
        return FormatError::damaged("Division by zero");
    }
    let shown = if v.is_nan() {
        "NaN".to_string()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }
    } else {
        v.to_string()
    };
    FormatError::damaged(format!("The number {shown} cannot be converted to a BigInt because it is not an integer"))
}

fn finish_state<R: Reader + ?Sized>(st: TrackState, scale: u64, reader: &R) -> Result<Track> {
    let TrackState { e, tb, mut times, durations, laced } = st;
    let mut t: SampleTable = tb.t;
    let n = t.count();
    let unit = scale as f64 * TICKS as f64 / 1e9;
    let to_ticks = |v: f64| -> Ticks {
        if unit.fract() == 0.0 { to_i64(js_round(v * unit)) } else { rescale_f(v * scale as f64, 1_000_000_000) }
    };
    let default_units = if e.default_duration != 0 { e.default_duration as f64 / scale as f64 } else { 0.0 };
    // Laced frames share their block's time: spread them by the default duration, or evenly up to the next block.
    for &(first, count) in &laced {
        let base = times[first];
        let mut step = default_units;
        if step == 0.0 {
            let next = if first + count < n { times[first + count] } else { f64::NAN };
            step = if next > base { (next - base) / count as f64 } else { durations[first] };
            if step.is_nan() {
                step = 0.0;
            }
        }
        for k in 1..count.min(n - first) {
            times[first + k] = base + k as f64 * step;
        }
    }
    let delay = if e.codec_delay != 0 { rescale(e.codec_delay.min(i64::MAX as u64) as i64, 1_000_000_000) } else { 0 };
    for (pts, &v) in t.pts.iter_mut().zip(&times) {
        *pts = to_ticks(v).saturating_sub(delay);
    }
    t.dts.copy_from_slice(&t.pts);
    if e.kind == Kind::Video {
        t.dts.sort_unstable();
    }
    let fallback = if default_units != 0.0 { to_ticks(default_units) } else { 0 };
    let mut ord: Vec<usize> = (0..n).collect();
    if e.kind == Kind::Video {
        ord.sort_by_key(|&i| (t.pts[i], i));
    }
    let rate = match e.c.sample_rate {
        Some(r) if r != 0 => r as f64,
        _ => js_round(e.audio.rate),
    };
    if e.c.pcm.is_some() && n > 0 && !(rate.is_finite() && rate > 0.0) {
        return Err(not_integer(rate));
    }
    for k in 0..n {
        let i = ord[k];
        let d = if let Some(bpf) = e.c.pcm {
            rescale(i64::from(t.size[i]) / bpf as i64, rate as u64)
        } else if k + 1 < n {
            t.pts[ord[k + 1]].saturating_sub(t.pts[i])
        } else if !durations[i].is_nan() {
            to_ticks(durations[i])
        } else if fallback != 0 {
            fallback
        } else if k > 0 {
            t.duration[ord[k - 1]]
        } else {
            0
        };
        t.duration[i] = d.max(0);
    }
    let end = (0..n).map(|i| t.pts[i].saturating_add(t.duration[i])).fold(0, Ticks::max);
    let pre_roll = if e.pre_roll != 0 {
        rescale(e.pre_roll.min(i64::MAX as u64) as i64, 1_000_000_000)
    } else if e.c.codec == "opus" {
        cut_time::from_seconds(0.08)
    } else {
        0
    };
    let quantum = to_ticks(1.0) as f64;
    let mut codec = e.c.codec.clone();
    let media = match e.kind {
        Kind::Video => {
            let s = e.video.as_ref();
            let g = |f: fn(&VideoSettings) -> u64| s.map_or(0, f);
            let (sps_w, sps_h, sps_color, sps_bits) = e.c.sps.unwrap_or((0, 0, None, 0));
            let width = if g(|v| v.width) != 0 { g(|v| v.width) as f64 } else { sps_w as f64 };
            let height = if g(|v| v.height) != 0 { g(|v| v.height) as f64 } else { sps_h as f64 };
            let (dw, dh, unit) = (g(|v| v.dw), g(|v| v.dh), g(|v| v.unit));
            let (display_width, display_height) = if dw != 0 && dh != 0 && unit == 3 {
                (js_round(height * dw as f64 / dh as f64), height)
            } else {
                (
                    if unit == 0 && dw != 0 { dw as f64 } else { width },
                    if unit == 0 && dh != 0 { dh as f64 } else { height },
                )
            };
            let bit_depth = [e.c.bit_depth, s.and_then(|v| v.bits), Some(sps_bits)]
                .into_iter()
                .flatten()
                .find(|&b| b != 0)
                .unwrap_or(8);
            let mut v = Video {
                width: dim(width),
                height: dim(height),
                display_width: dim(display_width),
                display_height: dim(display_height),
                rotation: 0,
                bit_depth: bit_depth.min(u32::MAX.into()) as u32,
                color_space: merge_color(s.and_then(|v| v.color), sps_color),
                frame_rate: [30, 1],
                vfr: false,
            };
            if let Some(features) = &e.c.vp9 {
                codec = finish_vp9(&mut v, features.as_deref(), &t, e.prefix.as_deref(), reader);
            }
            finish_track(&mut t, Some(&mut v), quantum);
            Media::Video(v)
        }
        Kind::Audio => {
            finish_track(&mut t, None, quantum);
            let channels = e.c.channels.filter(|&c| c != 0).unwrap_or(e.audio.channels);
            Media::Audio(Audio { sample_rate: dim(rate), channels: channels.min(u32::MAX.into()) as u32 })
        }
    };
    Ok(Track {
        id: e.number,
        media,
        codec,
        description: e.c.description,
        duration: end,
        truncated: false,
        pre_roll,
        sample_prefix: e.prefix,
        samples: t,
    })
}

/// VP9 has no configuration record in Matroska (CodecPrivate, when there, holds a few features): the profile and
/// bit depth come from the first key frame. Returns the codec string.
fn finish_vp9<R: Reader + ?Sized>(
    v: &mut Video,
    features: Option<&[u8]>,
    s: &SampleTable,
    prefix: Option<&[u8]>,
    reader: &R,
) -> String {
    let (mut profile, mut level, mut bit_depth) = (None, None, None);
    if let Some(p) = features {
        let mut i = 0;
        while i + 2 < p.len() {
            let x = u64::from(p[i + 2]);
            match p[i] {
                1 => profile = Some(x),
                2 => level = Some(x),
                3 => bit_depth = Some(x),
                _ => {}
            }
            i += 2 + usize::from(p[i + 1]);
        }
    }
    let n = s.count();
    let mut k = 0;
    while k + 1 < n && !s.key[k] {
        k += 1;
    }
    let frame = if n > 0 {
        read_range(reader, s.offset[k], u64::from(s.size[k]).min(64)).ok().and_then(|bytes| {
            let bytes = match prefix {
                Some(p) => [p, &bytes].concat(),
                None => bytes.into_owned(),
            };
            parse_vp9_frame(&bytes).ok().flatten()
        })
    } else {
        None
    };
    let key = frame.as_ref().and_then(|f| f.key.as_ref());
    let profile = profile.or(frame.as_ref().map(|f| f.profile)).unwrap_or(0);
    let bit_depth = bit_depth.or(key.map(|k| k.bit_depth)).unwrap_or(8);
    if v.width == 0
        && let Some(k) = key
        && k.width != 0
    {
        v.width = dim(k.width as f64);
        v.display_width = v.width;
        v.height = dim(k.height as f64);
        v.display_height = v.height;
    }
    let fps =
        if n > 1 { TICKS as f64 / ((s.pts[n - 1] as f64 - s.pts[0] as f64) / (n - 1) as f64).max(1.0) } else { 30.0 };
    let level = level.unwrap_or_else(|| vp9_level(v.width, v.height, if fps.is_finite() { fps } else { 30.0 }));
    v.bit_depth = bit_depth.min(u32::MAX.into()) as u32;
    if v.color_space.is_none() {
        v.color_space = key.and_then(|k| k.color_space);
    }
    vp9_codec_string(profile, level, bit_depth)
}

/// reader -> Source; a file that cannot be used is an error (probe turns it into `Source::error`).
pub fn open<R: Reader + ?Sized>(reader: &R) -> Result<Source> {
    let size = reader.size().min(i64::MAX as u64) as i64;
    let ebml = match read_element(reader, 0)? {
        Some(e) if e.id == id::EBML && e.size >= 0 => e,
        _ => return damaged("no EBML header"),
    };
    let Some(eb) = read_whole(reader, ebml)? else { return damaged("the EBML header is cut off") };
    let doc_type =
        Fields::of(&eb, whole(&eb)).get(id::DOC_TYPE).map_or_else(|| "matroska".to_string(), |e| text(&eb, e));
    if doc_type != "webm" && doc_type != "matroska" {
        return unsupported(format!("EBML document {doc_type}"));
    }
    let mut pos = ebml.data.saturating_add(ebml.size);
    let mut seg = read_element(reader, pos)?;
    for _ in 0..16 {
        let Some(s) = seg.filter(|s| s.id == id::VOID) else { break };
        pos = s.data.saturating_add(s.size);
        seg = read_element(reader, pos)?;
    }
    let Some(seg) = seg.filter(|s| s.id == id::SEGMENT) else { return damaged("no Segment") };
    let seg_start = seg.data;
    let seg_end = if seg.size < 0 { size } else { size.min(seg_start.saturating_add(seg.size)) };
    let mut info = None;
    let mut tracks_bytes: Option<Cow<[u8]>> = None;
    let mut seek: Vec<(u64, u64)> = Vec::new();
    let mut first_cluster = -1;
    pos = seg_start;
    for _ in 0..10_000 {
        if pos >= seg_end {
            break;
        }
        let Some(el) = read_element(reader, pos)?.filter(|el| el.id >= 0x80) else { break };
        if el.id == id::CLUSTER {
            first_cluster = pos;
            break;
        }
        if el.size < 0 {
            break;
        }
        // Cues ahead of the first Cluster are read the JavaScript's way: through the SeekHead only (its `else` binds
        // to the wrong `if`).
        if matches!(el.id, id::INFO | id::TRACKS | id::SEEK_HEAD | id::CUES)
            && let Some(b) = read_whole(reader, el)?
        {
            match el.id {
                id::INFO => info = Some(parse_info(&b)),
                id::TRACKS => tracks_bytes = tracks_bytes.or(Some(b)),
                id::SEEK_HEAD => parse_seek_head(&b, &mut seek),
                _ => {}
            }
        }
        pos = el.data.saturating_add(el.size);
    }
    let fetch = |want: u64| -> Result<Option<Cow<[u8]>>> {
        let Some(&(_, at)) = seek.iter().find(|x| x.0 == want) else { return Ok(None) };
        match read_element(reader, seg_start.saturating_add(at.min(i64::MAX as u64) as i64))? {
            Some(el) if el.id == want => read_whole(reader, el),
            _ => Ok(None),
        }
    };
    if info.is_none() {
        info = fetch(id::INFO)?.map(|b| parse_info(&b));
    }
    if tracks_bytes.is_none() {
        tracks_bytes = fetch(id::TRACKS)?;
    }
    let cues = fetch(id::CUES)?.map(|b| parse_cues(&b)).unwrap_or_default();
    let Some(tracks_bytes) = tracks_bytes else { return damaged("no Tracks") };
    let info = info.unwrap_or(Info { scale: 1_000_000, duration: None });
    let (entries, mut skipped) = parse_tracks(&tracks_bytes);
    let mut states: Vec<TrackState> = Vec::new();
    for e in entries {
        let st =
            TrackState { e, tb: TableBuilder::new(4096), times: Vec::new(), durations: Vec::new(), laced: Vec::new() };
        match states.iter_mut().find(|s| s.e.number == st.e.number) {
            Some(old) => *old = st,
            None => states.push(st),
        }
    }
    if first_cluster < 0 {
        first_cluster = cues.first().map_or(pos, |&c| seg_start.saturating_add(c));
    }
    let mut damaged_file = false;
    if first_cluster < seg_end && !states.is_empty() {
        let cur = Cursor { reader, end: seg_end, buf: Cow::Borrowed(&[]), at: 0, blocks: 0, block_bytes: 0 };
        let mut scan = Scan {
            cur,
            seg_start,
            seg_end,
            cues: &cues,
            states: &mut states,
            cluster_time: 0,
            damaged: false,
            resyncs: 0,
        };
        scan.run(first_cluster)?;
        damaged_file = scan.damaged;
    }
    let mut tracks = Vec::new();
    for st in states {
        let track = finish_state(st, info.scale, reader)?;
        if track.samples.is_empty() {
            skipped.push(Skipped { id: track.id, kind: track.kind(), codec: track.codec, reason: "empty".into() });
        } else {
            tracks.push(track);
        }
    }
    tracks.sort_by_key(|t| t.kind() != Kind::Video);
    let declared = match info.duration {
        Some(d) if d != 0.0 && !d.is_nan() => {
            if d.is_infinite() {
                return Err(not_integer(d));
            }
            rescale_f(d * info.scale as f64, 1_000_000_000)
        }
        _ => 0,
    };
    let measured = tracks.iter().map(|t| t.duration).max().unwrap_or(0);
    let duration = if declared > 0 && measured > 0 { declared.min(measured) } else { measured };
    Ok(Source {
        container: Some(if doc_type == "webm" { Container::Webm } else { Container::Mkv }),
        duration,
        tracks,
        skipped,
        image: None,
        error: None,
        brands: None,
        damaged: Some(damaged_file),
    })
}
