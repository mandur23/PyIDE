//! The mixer (`audioengine.createMixer`): the sound of a sequence, sample by sample, the same for the preview and the
//! export. Sources are kept in blocks ([`store`]); [`Mixer::load`] reads what a range needs; [`Mixer::mix`] mixes what
//! is in memory and counts a clip whose blocks are not read yet as missing (asking for them: [`Mixer::fetch`]);
//! [`Mixer::mix_loaded`] does both, for loops through a range (export, offline render, measuring).

mod render;
mod store;

use std::collections::{HashMap, HashSet};
use std::hash::Hasher;

use cut_model::{Id, Media, Project, Sequence, Source as ClipSource, TrackKind};
use cut_time::TICKS;

pub use render::transition_range;
use render::{
    Caches, Ctx, FX_SEGMENT, FX_XFADE, Item, chain_of, clip_span, render_clip, source_span, speed_of, speed_reads,
};
use store::{Clock, Origin, Store, stereo};

use crate::source::{Audio, AudioError};
use crate::util::{ceil_i, db_to_gain};

/// The most of a range one load reads ahead (of the source, for a sped-up clip).
const LOAD_SECONDS: f64 = 120.0;
/// Seconds after a range that [`Mixer::mix_loaded`] reads too.
pub const LOOKAHEAD_SECONDS: f64 = 15.0;

/// What gives a media entry's sound: `Ok(None)` for a file without any.
pub type GetAudio = Box<dyn FnMut(&Project, &Media) -> Result<Option<Audio>, AudioError> + Send>;

/// The mix of a range and its levels.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mixed {
    /// Left and right at the mixer's rate.
    pub out: [Vec<f32>; 2],
    /// A track's peaks (linear) after its fader and pan, before the master; every audio track is listed.
    pub tracks: Vec<(Id, [f64; 2])>,
    /// The master's peaks and RMS (linear).
    pub master: [f64; 2],
    pub rms: [f64; 2],
    /// Clips whose sound is not read yet, and the media they need (none for a nest).
    pub missing: usize,
    pub missed: Vec<(Id, Option<Id>)>,
}

/// A source that could not be read (`media` none for a nest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub media: Option<Id>,
    pub error: String,
}

enum State {
    None,
    Failed(String),
    Ready(Store),
}

struct Source {
    state: State,
    media: Option<Id>,
}

/// Bytes of sound held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Held {
    pub blocks: usize,
    pub segments: usize,
}

/// One mixer computes a project's audio at one rate. Not shared between threads: one per thread that mixes.
pub struct Mixer {
    rate: f64,
    tps: f64,
    get_audio: GetAudio,
    sources: HashMap<String, Source>,
    caches: Caches,
    clock: Clock,
    wants: Vec<(String, i64, i64)>,
    /// The nest store keys of a project, by sequence, while it does not change (see [`Mixer::changed`]).
    nests: Option<(usize, HashMap<Id, String>)>,
}

fn media_key(m: &Media) -> String {
    format!("{}|{}", m.id.as_str(), m.path)
}

impl Mixer {
    /// A mixer at `rate` (48000 for the preview and the export) taking sound from `get_audio`.
    pub fn new(rate: u32, get_audio: GetAudio) -> Self {
        let rate = f64::from(rate);
        Self {
            rate,
            tps: TICKS as f64 / rate,
            get_audio,
            sources: HashMap::new(),
            caches: Caches::default(),
            clock: Clock::default(),
            wants: Vec::new(),
            nests: None,
        }
    }

    pub fn rate(&self) -> u32 {
        self.rate as u32
    }

    /// Drops every source and segment held (a project was opened).
    pub fn forget(&mut self) {
        self.sources.clear();
        self.caches = Caches::default();
        self.wants.clear();
        self.nests = None;
    }

    /// The project changed: nests are fingerprinted again on the next mix (an edit inside one is heard at once).
    pub fn changed(&mut self) {
        self.nests = None;
    }

    /// The store key of a nest's sequence: its id and a hash of what it and the sequences under it hold. Stores of
    /// earlier contents of that sequence are dropped.
    fn nest_key(&mut self, project: &Project, seq_id: Id) -> String {
        let addr = std::ptr::from_ref(project) as usize;
        if self.nests.as_ref().is_some_and(|(a, _)| *a != addr) {
            self.nests = None;
        }
        if let Some(k) = self.nests.as_ref().and_then(|(_, m)| m.get(&seq_id)) {
            return k.clone();
        }
        let mut seen = HashSet::new();
        let mut seqs: Vec<&Sequence> = Vec::new();
        let mut stack = vec![seq_id];
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            let Some(seq) = project.sequences.iter().find(|s| s.id == id) else { continue };
            seqs.push(seq);
            let mut next: Vec<Id> = seq.nested_ids().into_iter().collect();
            next.sort_by(|a, b| b.as_str().cmp(a.as_str()));
            stack.extend(next);
        }
        let used: HashSet<Id> = seqs.iter().flat_map(|q| q.clips().filter_map(cut_model::Clip::media_id)).collect();
        let media: Vec<&Media> = project.media.iter().filter(|m| used.contains(&m.id)).collect();
        let mut h = Fnv(0xcbf2_9ce4_8422_2325);
        let text = serde_json::to_string(&(&seqs, &media)).unwrap_or_default();
        h.write(text.as_bytes());
        let key = format!("nest:{}:{:016x}|", seq_id.as_str(), h.finish());
        let prefix = format!("nest:{}:", seq_id.as_str());
        self.sources.retain(|k, _| !k.starts_with(&prefix) || *k == key);
        self.nests.get_or_insert_with(|| (addr, HashMap::new())).1.insert(seq_id, key.clone());
        key
    }

    /// The enabled clips on audio tracks with a source (a file or a nest), in the file's order.
    fn items<'p>(&mut self, project: &'p Project, seq: &'p Sequence) -> Vec<(Item<'p>, Option<&'p Media>, Option<Id>)> {
        let mut out = Vec::new();
        for c in seq.clips_in_order() {
            if !c.enabled || seq.kind_of(c.track) != Some(TrackKind::Audio) {
                continue;
            }
            let (key, media, nest) = match &c.source {
                ClipSource::Media { media, .. } => match project.media.iter().find(|m| m.id == *media) {
                    Some(m) => (media_key(m), Some(m), None),
                    None => continue,
                },
                ClipSource::Nest { sequence, .. } => {
                    if !project.sequences.iter().any(|s| s.id == *sequence) {
                        continue;
                    }
                    (self.nest_key(project, *sequence), None, Some(*sequence))
                }
                ClipSource::Generator { .. } => continue,
            };
            out.push((Item { clip: c, key, nest: nest.is_some(), dur: c.duration() }, media, nest));
        }
        out
    }

    fn open_source(&mut self, project: &Project, key: &str, media: Option<&Media>, nest: Option<Id>) {
        if self.sources.contains_key(key) {
            return;
        }
        let state = match (media, nest) {
            (_, Some(seq_id)) => match project.sequences.iter().find(|s| s.id == seq_id) {
                Some(seq) => {
                    let length = ceil_i(seq.duration() as f64 / self.tps);
                    if length == 0 {
                        State::None
                    } else {
                        State::Ready(Store::reading(Origin::Nest(seq_id), length, self.rate))
                    }
                }
                None => State::None,
            },
            (Some(m), None) => match (self.get_audio)(project, m) {
                Err(e) => State::Failed(e.to_string()),
                Ok(None) => State::None,
                Ok(Some(Audio::Reader(r))) => {
                    let length = crate::util::js_round(r.length() as f64 * self.rate / r.rate()) as i64;
                    if r.length() == 0 {
                        State::None
                    } else {
                        State::Ready(Store::reading(Origin::File(r), length, self.rate))
                    }
                }
                Ok(Some(Audio::Whole { rate, data })) => {
                    if data.is_empty() {
                        State::None
                    } else {
                        let mut data = stereo(data);
                        if rate != self.rate {
                            let r = crate::resample::resample(&data, rate, self.rate);
                            let mut it = r.into_iter();
                            data = [it.next().unwrap_or_default(), it.next().unwrap_or_default()];
                        }
                        State::Ready(Store::whole(data))
                    }
                }
            },
            (None, None) => State::None,
        };
        self.sources.insert(key.to_string(), Source { state, media: media.map(|m| m.id) });
    }

    /// Reads samples `[k0, k1)` of a store (a whole store has them already); a failure marks the source failed.
    fn ensure(&mut self, project: &Project, key: &str, k0: i64, k1: i64) {
        let Some(Source { state: State::Ready(store), .. }) = self.sources.get_mut(key) else { return };
        if !store.reads() {
            return;
        }
        let range = store.block_range(k0, k1);
        store.pin(range, 1);
        let mut failed = None;
        for i in range.0..range.1 {
            let Some(Source { state: State::Ready(store), .. }) = self.sources.get_mut(key) else { return };
            if store.blocks.contains_key(&i) {
                continue;
            }
            let data = match &store.origin {
                Origin::Nest(seq_id) => {
                    let seq_id = *seq_id;
                    let (o0, o1) = (i * store.size, store.length.min(i * store.size + store.size));
                    self.load(project, seq_id, o0 as f64 * self.tps, o1 as f64 * self.tps);
                    Ok(self.mix(project, seq_id, o0, (o1 - o0).max(0) as usize, 0.0).out)
                }
                _ => store.read_file_block(i, self.rate),
            };
            let Some(Source { state: State::Ready(store), .. }) = self.sources.get_mut(key) else { return };
            match data {
                Ok(d) => store.insert(&self.clock, i, d),
                Err(e) => {
                    failed = Some(e.to_string());
                    break;
                }
            }
        }
        if let Some(src) = self.sources.get_mut(key) {
            match failed {
                Some(e) => src.state = State::Failed(e),
                None => {
                    if let State::Ready(store) = &mut src.state {
                        store.pin(range, -1);
                    }
                }
            }
        }
    }

    /// Reads every source the clips heard in `[from, to)` (ticks) need, at most two minutes of each from the start of
    /// its range; returns the sources that failed.
    pub fn load(&mut self, project: &Project, seq_id: Id, from: f64, to: f64) -> Vec<Failure> {
        let Some(seq) = project.sequences.iter().find(|s| s.id == seq_id) else { return Vec::new() };
        let items = self.items(project, seq);
        let mut wanted = Vec::new();
        let mut ranges = Vec::new();
        for (x, media, nest) in &items {
            let span = clip_span(seq, x.clip, x.dur);
            if span.to > from && span.from < to {
                if !wanted.contains(&x.key) {
                    wanted.push(x.key.clone());
                }
                self.open_source(project, &x.key, *media, *nest);
                ranges.push((x, span));
            }
        }
        let (rate, tps) = (self.rate, self.tps);
        let mut reads = Vec::new();
        for (x, span) in ranges {
            let Some(Source { state: State::Ready(store), .. }) = self.sources.get(&x.key) else { continue };
            if !store.reads() {
                continue;
            }
            let t0 = from.max(span.from);
            let chain = chain_of(rate, x, &span);
            if x.clip.speed != 1.0 {
                let t1 = to.min(span.to).min(t0 + LOAD_SECONDS * TICKS as f64 / x.clip.speed.max(1.0));
                let g = speed_of(rate, store, x, &span);
                for r in speed_reads(rate, &self.caches, &g, chain.as_ref(), ceil_i(t0 / tps), ceil_i(t1 / tps)) {
                    reads.push((x.key.clone(), r));
                }
                continue;
            }
            let t1 = to.min(span.to).min(t0 + LOAD_SECONDS * TICKS as f64);
            let (mut k0, mut k1) = source_span(tps, x, &span, t0, t1);
            if let Some(c) = &chain {
                let reach = 2 * FX_SEGMENT + c.warm() + FX_XFADE + c.latency;
                k0 -= reach;
                k1 += reach;
            }
            reads.push((x.key.clone(), (k0, k1)));
        }
        // All of this load's blocks stay until it is done, so a clip's blocks do not push out another's.
        self.pin_reads(&reads, 1);
        for (key, (k0, k1)) in &reads {
            self.ensure(project, key, *k0, *k1);
        }
        self.pin_reads(&reads, -1);
        wanted.iter().filter_map(|k| self.failure_of(k)).collect()
    }

    fn pin_reads(&mut self, reads: &[(String, (i64, i64))], by: i32) {
        for (key, (k0, k1)) in reads {
            if let Some(Source { state: State::Ready(store), .. }) = self.sources.get_mut(key) {
                let r = store.block_range(*k0, *k1);
                store.pin(r, by);
            }
        }
    }

    fn failure_of(&self, key: &str) -> Option<Failure> {
        match self.sources.get(key) {
            Some(Source { state: State::Failed(e), media }) => Some(Failure { media: *media, error: e.clone() }),
            _ => None,
        }
    }

    /// Reads what the mixes since the last call found missing (the preview calls it after a mix that missed).
    pub fn fetch(&mut self, project: &Project) {
        for (key, k0, k1) in std::mem::take(&mut self.wants) {
            self.ensure(project, &key, k0, k1);
        }
    }

    /// The mix of samples `[s0, s0 + n)` at the mixer's rate, of what is in memory. `master_gain` (dB) adds to the
    /// sequence's own.
    pub fn mix(&mut self, project: &Project, seq_id: Id, s0: i64, n: usize, master_gain: f64) -> Mixed {
        let mut m = Mixed { out: [vec![0f32; n], vec![0f32; n]], ..Mixed::default() };
        let Some(seq) = project.sequences.iter().find(|s| s.id == seq_id) else { return m };
        let (t0, t1) = (s0 as f64 * self.tps, (s0 + n as i64) as f64 * self.tps);
        let audio: Vec<&cut_model::Track> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).collect();
        let any_solo = audio.iter().any(|t| t.solo == Some(true));
        let items = self.items(project, seq);
        let mut bus = [vec![0f32; n], vec![0f32; n]];
        let mut cx = Ctx { rate: self.rate, clock: &self.clock, caches: &mut self.caches, wants: &mut self.wants };
        for track in &audio {
            bus[0].fill(0.0);
            bus[1].fill(0.0);
            let mut any = false;
            for (x, media, _) in items.iter().filter(|(x, _, _)| x.clip.track == track.id) {
                let span = clip_span(seq, x.clip, x.dur);
                if span.to <= t0 || span.from >= t1 {
                    continue;
                }
                any = true;
                let done = match self.sources.get(&x.key) {
                    Some(Source { state: State::None, .. }) => true,
                    Some(Source { state: State::Ready(store), .. }) => {
                        render_clip(&mut cx, &mut bus, seq, x, store, s0, n as i64)
                    }
                    _ => false,
                };
                if !done {
                    m.missing += 1;
                    m.missed.push((x.clip.id, if x.nest { None } else { media.map(|m| m.id) }));
                }
            }
            let audible = track.mute != Some(true) && (!any_solo || track.solo == Some(true));
            if !any || !audible {
                m.tracks.push((track.id, [0.0, 0.0]));
                continue;
            }
            let g = db_to_gain(track.volume.unwrap_or(0.0));
            let p = (track.pan.unwrap_or(0.0) / 100.0).clamp(-1.0, 1.0);
            let gl = g * if p > 0.0 { 1.0 - p } else { 1.0 };
            let gr = g * if p < 0.0 { 1.0 + p } else { 1.0 };
            let (mut pl, mut pr) = (0f64, 0f64);
            let [ol, or] = &mut m.out;
            for (((ol, or), bl), br) in ol.iter_mut().zip(or.iter_mut()).zip(&bus[0]).zip(&bus[1]) {
                let l = f64::from(*bl) * gl;
                let r = f64::from(*br) * gr;
                *ol = (f64::from(*ol) + l) as f32;
                *or = (f64::from(*or) + r) as f32;
                pl = pl.max(l.abs());
                pr = pr.max(r.abs());
            }
            m.tracks.push((track.id, [pl, pr]));
        }
        let mg = db_to_gain(master_gain + seq.master_gain);
        let (mut ml, mut mr, mut sl, mut sr) = (0f64, 0f64, 0f64, 0f64);
        for i in 0..n {
            let l = f64::from(m.out[0][i]) * mg;
            let r = f64::from(m.out[1][i]) * mg;
            m.out[0][i] = l as f32;
            m.out[1][i] = r as f32;
            ml = ml.max(l.abs());
            mr = mr.max(r.abs());
            sl += l * l;
            sr += r * r;
        }
        m.master = [ml, mr];
        m.rms = if n > 0 { [(sl / n as f64).sqrt(), (sr / n as f64).sqrt()] } else { [0.0, 0.0] };
        m
    }

    /// [`Mixer::mix`] once the blocks of those samples, and [`LOOKAHEAD_SECONDS`] after them, are read.
    pub fn mix_loaded(&mut self, project: &Project, seq_id: Id, s0: i64, n: usize, master_gain: f64) -> Mixed {
        let tps = self.tps;
        self.load(project, seq_id, s0 as f64 * tps, (s0 + n as i64) as f64 * tps + LOOKAHEAD_SECONDS * TICKS as f64);
        self.mix(project, seq_id, s0, n, master_gain)
    }

    /// The sources that could not be read, those of nests included.
    pub fn failures(&self) -> Vec<Failure> {
        self.sources.keys().filter_map(|k| self.failure_of(k)).collect()
    }

    /// Bytes of sound held: source blocks and stretched segments.
    pub fn held(&self) -> Held {
        let blocks = self
            .sources
            .values()
            .filter_map(|s| if let State::Ready(st) = &s.state { Some(st) } else { None })
            .flat_map(|st| st.blocks.values())
            .map(|b| 4 * (b.data[0].len() + b.data[1].len()))
            .sum();
        let segments = self.caches.speed.values().map(|(d, _)| 4 * (d[0].len() + d[1].len())).sum();
        Held { blocks, segments }
    }
}

/// FNV-1a, 64 bits: the nest fingerprint.
struct Fnv(u64);

impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x100_0000_01b3);
        }
    }
}
