//! One clip's sound added into a track's bus (`renderClip`): its source at speed 1 (forward or reversed), or a stream
//! made at another speed (WSOLA stretch or resampler, in segments), through its effect chain when it has a processor
//! (in fixed segments with a warm-up and a cross-fade, so a sample does not depend on the block it is mixed in), then
//! its volume and duck keyframes, gain effects, fade handles, transitions and pan on a 32-sample grid.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use cut_model::keyframes::{Keyframe, Value, value_at};
use cut_model::{Align, Clip, Props, Sequence, Transition};
use cut_time::TICKS;

use super::store::{Clock, Stereo, Store};
use crate::effects::{self, AudioEffect, ParamKind};
use crate::fx::{CONTROL, Chain, MAX_MEMORY, Stage};
use crate::resample::{RS_HALF, resample_part};
use crate::stretch::{stretch_hop, stretch_part, stretch_window};
use crate::util::{ceil_i, db_to_gain, floor_i, js_max, js_min, round_i};

const KF_STEP: i64 = 32;
pub(crate) const FX_SEGMENT: i64 = 32768;
pub(crate) const FX_XFADE: i64 = 512;
const FX_KEEP: usize = 96;
const SPEED_INPUT_SECONDS: f64 = 40.0;
const SPEED_KEEP: usize = 32;

/// A clip of a mix: the clip, its source's store key and its duration.
pub(crate) struct Item<'a> {
    pub(crate) clip: &'a Clip,
    pub(crate) key: String,
    /// Whether the source is a nest (it lists no media when missing).
    pub(crate) nest: bool,
    pub(crate) dur: i64,
}

/// The range a clip is heard over (ticks; transition handles included) and its transitions' ranges.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Span {
    pub(crate) from: f64,
    pub(crate) to: f64,
    fade_in: Option<(f64, f64)>,
    fade_out: Option<(f64, f64)>,
}

/// The range a transition covers: `[from, to)` in sequence ticks.
pub fn transition_range(tr: &Transition) -> (f64, f64) {
    let (at, d) = (tr.at as f64, tr.duration as f64);
    match tr.align {
        Align::Start => (at, at + d),
        Align::End => (at - d, at),
        Align::Center => {
            let half = crate::util::js_round(d / 2.0);
            (at - half, at - half + d)
        }
    }
}

pub(crate) fn clip_span(seq: &Sequence, clip: &Clip, dur: i64) -> Span {
    let end = clip.start + dur;
    let mut s = Span { from: clip.start as f64, to: end as f64, fade_in: None, fade_out: None };
    for tr in seq.transitions.iter().filter(|t| t.track == clip.track) {
        if tr.at == clip.start {
            let r = transition_range(tr);
            s.from = s.from.min(r.0);
            s.fade_in = Some(r);
        }
        if tr.at == end {
            let r = transition_range(tr);
            s.to = s.to.max(r.1);
            s.fade_out = Some(r);
        }
    }
    s
}

fn transition_kind(seq: &Sequence, track: cut_model::Id, at: i64) -> &str {
    seq.transitions.iter().find(|x| x.at == at && x.track == track).map_or("", |t| t.kind.as_str())
}

/// The segments a mixer keeps: stretched speed segments and effect chain segments, least recently used dropped.
#[derive(Default)]
pub(crate) struct Caches {
    pub(crate) speed: HashMap<String, (Arc<Stereo>, u64)>,
    pub(crate) fx: HashMap<String, (Arc<FxSeg>, u64)>,
}

fn evict<T>(map: &mut HashMap<String, (T, u64)>, keep: usize) {
    while map.len() > keep {
        let Some(k) = map.iter().min_by_key(|(_, (_, u))| *u).map(|(k, _)| k.clone()) else { break };
        map.remove(&k);
    }
}

// ---- speed ----------------------------------------------------------------------------------------------------------

/// A clip at another speed: its source range `[src_from, src_to)` (reversed when it plays backwards), stretched (or
/// resampled with the pitch not kept) as one stream of `out_len` samples, made in segments of `seg` samples.
pub(crate) struct Speed {
    src_from: i64,
    src_to: i64,
    in_len: i64,
    out_len: i64,
    factor: f64,
    keep_pitch: bool,
    reverse: bool,
    seg: i64,
    /// Ticks from clip.start of stream sample 0.
    origin: f64,
    /// Sequence sample i reads stream sample i - shift.
    shift: f64,
    /// The resampler's output rate with the pitch not kept.
    to: f64,
    key: String,
}

fn keep_pitch(clip: &Clip) -> bool {
    clip.extra.get("keepPitch") != Some(&serde_json::Value::Bool(false))
}

pub(crate) fn speed_of(rate: f64, store: &Store, x: &Item, span: &Span) -> Speed {
    let tps = TICKS as f64 / rate;
    let c = x.clip;
    let pre = c.start as f64 - span.from;
    let post = span.to - (c.start + x.dur) as f64;
    let kp = keep_pitch(c);
    let src_from = round_i((c.in_ - pre * c.speed) / tps).max(0);
    let src_to = src_from.max(store.length.min(round_i((c.out + post * c.speed) / tps)));
    let factor = 1.0 / c.speed;
    let hop = stretch_hop(rate);
    let origin =
        if c.reverse { -(src_to as f64 * tps - c.out) / c.speed } else { -(c.in_ - src_from as f64 * tps) / c.speed };
    let seg_s = (super::store::BLOCK_SECONDS as f64).min(SPEED_INPUT_SECONDS * factor);
    Speed {
        src_from,
        src_to,
        in_len: src_to - src_from,
        out_len: round_i((src_to - src_from) as f64 * factor),
        factor,
        keep_pitch: kp,
        reverse: c.reverse,
        seg: hop * round_i(seg_s * rate / hop as f64).max(1),
        origin,
        shift: (c.start as f64 + origin) / tps,
        to: rate / c.speed,
        key: format!("{}|{}|{}|{}|{}|{}|{}|{}", x.key, c.in_, c.out, c.speed, c.reverse, pre, post, kp),
    }
}

struct Window {
    o0: i64,
    o1: i64,
    x0: i64,
    x1: i64,
    c0: i64,
    src: (i64, i64),
}

fn speed_window(rate: f64, g: &Speed, j: i64) -> Window {
    let o0 = j * g.seg;
    let o1 = g.out_len.min(o0 + g.seg);
    let (x0, x1) = if g.keep_pitch {
        stretch_window(g.factor, rate, o0, o1)
    } else {
        (floor_i(o0 as f64 / g.factor) - RS_HALF - 2, ceil_i(o1 as f64 / g.factor) + RS_HALF + 2)
    };
    let c0 = x0.min(g.in_len).max(0);
    let c1 = c0.max(x1.min(g.in_len).max(0));
    let src = if g.reverse { (g.src_to - c1, g.src_to - c0) } else { (g.src_from + c0, g.src_from + c1) };
    Window { o0, o1, x0, x1, c0, src }
}

/// The source ranges to read before sequence samples `[a, b)` of a clip at another speed can be mixed: those of the
/// segments they hear (with a chain, over its runs' warm-up and tail too) not made yet.
pub(crate) fn speed_reads(
    rate: f64,
    caches: &Caches,
    g: &Speed,
    chain: Option<&ChainSpec>,
    a: i64,
    b: i64,
) -> Vec<(i64, i64)> {
    let (a, b) = chain.map_or((a, b), |c| chain_span(c, a, b));
    let k0 = round_i(a as f64 - g.shift).max(0);
    let k1 = (g.out_len - 1).min(round_i((b - 1) as f64 - g.shift));
    if k1 < k0 {
        return Vec::new();
    }
    (k0.div_euclid(g.seg)..=k1.div_euclid(g.seg))
        .filter(|j| !caches.speed.contains_key(&format!("{}|{j}", g.key)))
        .map(|j| speed_window(rate, g, j).src)
        .collect()
}

fn speed_segment(
    rate: f64,
    store: &Store,
    clock: &Clock,
    caches: &mut Caches,
    g: &Speed,
    j: i64,
) -> Option<Arc<Stereo>> {
    let k = format!("{}|{j}", g.key);
    if let Some((hit, used)) = caches.speed.get_mut(&k) {
        *used = clock.tick();
        return Some(hit.clone());
    }
    let w = speed_window(rate, g, j);
    if !store.has(clock, w.src.0, w.src.1) {
        return None;
    }
    let input: Vec<Vec<f32>> = store
        .copy_range(w.src.0, w.src.1)
        .into_iter()
        .map(|mut c| {
            let mut x = vec![0f32; (w.x1 - w.x0) as usize];
            if g.reverse {
                c.reverse();
            }
            let at = (w.c0 - w.x0) as usize;
            x[at..at + c.len()].copy_from_slice(&c);
            x
        })
        .collect();
    let data = if g.keep_pitch {
        stretch_part(&input, w.x0, g.in_len, g.factor, rate, w.o0, w.o1, Some(g.seg))
    } else {
        resample_part(&input, w.x0, g.in_len, rate, g.to, w.o0, w.o1)
    };
    let mut it = data.into_iter();
    let e = Arc::new([it.next().unwrap_or_default(), it.next().unwrap_or_default()]);
    caches.speed.insert(k, (e.clone(), clock.tick()));
    evict(&mut caches.speed, SPEED_KEEP);
    Some(e)
}

// ---- effect chains --------------------------------------------------------------------------------------------------

struct StageSpec<'a> {
    stage: Stage,
    effect: &'static AudioEffect,
    base: Vec<f64>,
    keyed: Vec<(usize, &'a [Keyframe])>,
}

/// A clip's effects as one chain, when one of them processes the sound.
pub(crate) struct ChainSpec<'a> {
    stages: Vec<StageSpec<'a>>,
    warm: i64,
    pub(crate) latency: i64,
    key: String,
    anchor: i64,
    end: i64,
    clip_start: f64,
    tps: f64,
}

/// The clip's enabled audio effects with their registry entries.
fn audio_effects(clip: &Clip) -> impl Iterator<Item = (&cut_model::Effect, &'static AudioEffect)> {
    clip.effects.iter().filter(|e| e.on).filter_map(|e| effects::get(&e.kind).map(|d| (e, d)))
}

pub(crate) fn chain_of<'a>(rate: f64, x: &Item<'a>, span: &Span) -> Option<ChainSpec<'a>> {
    let clip = x.clip;
    if !audio_effects(clip).any(|(_, d)| matches!(d.action, effects::Action::Dsp(_))) {
        return None;
    }
    let tps = TICKS as f64 / rate;
    let dur_s = x.dur as f64 / TICKS as f64;
    let (mut memory, mut latency) = (0.0, 0);
    let mut kfs = Vec::new();
    let mut list = Vec::new();
    let stages: Vec<StageSpec> = audio_effects(clip)
        .map(|(e, def)| {
            let base = def.resolve(&e.params);
            let keyed: Vec<(usize, &[Keyframe])> = def
                .params
                .iter()
                .enumerate()
                .filter_map(|(i, p)| {
                    let l = clip.keyframes.get(&format!("effects.{}.{}", e.id.as_str(), p.id))?;
                    (!l.is_empty()).then_some((i, l.as_slice()))
                })
                .collect();
            for (i, l) in &keyed {
                kfs.push((
                    format!("{}.{}", e.id.as_str(), def.params[*i].id),
                    serde_json::to_string(l).unwrap_or_default(),
                ));
            }
            list.push(format!("{}|{}|{}", e.id.as_str(), e.kind, serde_json::Value::Object(e.params.clone())));
            let stage = Stage::of(def, dur_s);
            if let Stage::Proc(d) = stage {
                memory += d.memory(&base, rate);
                latency += d.latency(rate) as i64;
            }
            StageSpec { stage, effect: def, base, keyed }
        })
        .collect();
    let c = CONTROL as i64;
    let warm = c.max(ceil_i(memory.min(MAX_MEMORY) * rate / c as f64) * c);
    let key = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}|{:?}",
        x.key,
        clip.in_,
        clip.out,
        clip.speed,
        clip.reverse,
        keep_pitch(clip),
        clip.start,
        span.from,
        span.to,
        x.dur,
        list,
        kfs
    );
    Some(ChainSpec {
        stages,
        warm,
        latency,
        key,
        anchor: ceil_i(span.from / tps),
        end: ceil_i(span.to / tps),
        clip_start: clip.start as f64,
        tps,
    })
}

/// A keyframe value as a parameter number.
fn param_value(kind: ParamKind, v: &Value, fallback: f64) -> f64 {
    match (v, kind) {
        (Value::Num(x), _) => *x,
        (Value::Flag(b), _) => f64::from(u8::from(*b)),
        (Value::Text(s), ParamKind::Choice(list)) => list.iter().find(|(id, _)| id == s).map_or(fallback, |c| c.1),
        _ => fallback,
    }
}

impl ChainSpec<'_> {
    /// Samples of warm-up before a segment.
    pub(crate) fn warm(&self) -> i64 {
        self.warm
    }

    /// Stage k's parameters at sequence sample i: the stored ones, keyframes evaluated at that sample.
    fn params_at(&self, k: usize, i: i64) -> Cow<'_, [f64]> {
        let s = &self.stages[k];
        if s.keyed.is_empty() {
            return Cow::Borrowed(&s.base);
        }
        let tau = i as f64 * self.tps - self.clip_start;
        let mut p = s.base.clone();
        for (id, l) in &s.keyed {
            if let Some(v) = value_at(l, tau) {
                p[*id] = param_value(s.effect.params[*id].kind, &v, p[*id]);
            }
        }
        Cow::Owned(p)
    }
}

/// Sequence samples of segment j (`[s0, s1)`) and of its run (`[r0, r1)`: the warm-up, the segment, its tail).
fn segment_run(c: &ChainSpec, j: i64) -> (i64, i64, i64, i64) {
    let s0 = c.anchor + j * FX_SEGMENT;
    let s1 = c.end.min(s0 + FX_SEGMENT);
    (s0, s1, c.anchor.max(s0 - c.warm), c.end.min(s1 + FX_XFADE))
}

fn first_segment(c: &ChainSpec, a: i64) -> (i64, i64) {
    let ja = (a - c.anchor).div_euclid(FX_SEGMENT);
    let first = if ja > 0 && a - (c.anchor + ja * FX_SEGMENT) < FX_XFADE { ja - 1 } else { ja };
    (ja, first)
}

/// The sequence samples the chain's runs read to give samples `[a, b)`.
pub(crate) fn chain_span(c: &ChainSpec, a: i64, b: i64) -> (i64, i64) {
    let jb = (b - 1 - c.anchor).div_euclid(FX_SEGMENT);
    let (_, first) = first_segment(c, a);
    (segment_run(c, first).2, c.end.min(segment_run(c, jb).3 + c.latency))
}

/// A chain segment's output: the segment and the tail that cross-fades into the next one.
pub(crate) struct FxSeg {
    body: Stereo,
    tail: Stereo,
}

fn fx_segment(
    rate: f64,
    c: &ChainSpec,
    clock: &Clock,
    caches: &mut Caches,
    src_at: &dyn Fn(i64) -> [f32; 2],
    j: i64,
) -> Arc<FxSeg> {
    let k = format!("{}|{j}", c.key);
    if let Some((hit, used)) = caches.fx.get_mut(&k) {
        *used = clock.tick();
        return hit.clone();
    }
    let (s0, s1, r0, r1) = segment_run(c, j);
    let lat = c.latency;
    let n = (r1 - r0 + lat).max(0) as usize;
    let mut l = vec![0f64; n];
    let mut r = vec![0f64; n];
    for i in r0..c.end.min(r0 + n as i64) {
        let v = src_at(i);
        l[(i - r0) as usize] = f64::from(v[0]);
        r[(i - r0) as usize] = f64::from(v[1]);
    }
    let mut chain = Chain::new(c.stages.iter().map(|s| s.stage).collect(), rate);
    chain.process(
        &mut l,
        &mut r,
        n,
        |k2, i| c.params_at(k2, r0 + i),
        |i| ((r0 + i) as f64 * c.tps - c.clip_start) / TICKS as f64,
    );
    let cut = |a: i64, b: i64| -> Stereo {
        let (x, y) = ((a - r0 + lat) as usize, (b - r0 + lat) as usize);
        [l[x..y].iter().map(|&v| v as f32).collect(), r[x..y].iter().map(|&v| v as f32).collect()]
    };
    let e = Arc::new(FxSeg { body: cut(s0, s1), tail: cut(s1, r1) });
    caches.fx.insert(k, (e.clone(), clock.tick()));
    evict(&mut caches.fx, FX_KEEP);
    e
}

/// The chain's output for sequence samples `[a, b)`.
fn chain_range(
    rate: f64,
    c: &ChainSpec,
    clock: &Clock,
    caches: &mut Caches,
    src_at: &dyn Fn(i64) -> [f32; 2],
    a: i64,
    b: i64,
) -> Stereo {
    let (ja, _) = first_segment(c, a);
    let jb = (b - 1 - c.anchor).div_euclid(FX_SEGMENT);
    let n = (b - a) as usize;
    let mut out = [vec![0f32; n], vec![0f32; n]];
    for j in ja..=jb {
        let seg = fx_segment(rate, c, clock, caches, src_at, j);
        let s0 = c.anchor + j * FX_SEGMENT;
        let from = a.max(s0);
        let to = b.min(s0 + seg.body[0].len() as i64);
        let prev = (j > 0 && from - s0 < FX_XFADE).then(|| fx_segment(rate, c, clock, caches, src_at, j - 1));
        for (ch, o) in out.iter_mut().enumerate() {
            let body = &seg.body[ch];
            let tail = prev.as_ref().map(|p| &p.tail[ch]);
            for i in from..to {
                let at = (i - s0) as usize;
                let mut v = f64::from(body[at]);
                if let Some(t) = tail.filter(|t| at < t.len()) {
                    let w = (at as f64 + 0.5) / FX_XFADE as f64;
                    v = f64::from(t[at]) * (1.0 - w) + v * w;
                }
                o[(i - a) as usize] = v as f32;
            }
        }
    }
    out
}

/// The source samples that sequence samples `[i0, i1)` of a clip at speed 1 (forward or reversed) read.
fn source_of(tps: f64, clip: &Clip, i0: i64, i1: i64) -> (i64, i64) {
    let start_s = clip.start as f64 / tps;
    if clip.reverse {
        (floor_i(clip.out / tps - (i1 as f64 - start_s)) - 2, ceil_i(clip.out / tps - (i0 as f64 - start_s)) + 1)
    } else {
        (floor_i(clip.in_ / tps + (i0 as f64 - start_s)) - 1, ceil_i(clip.in_ / tps + (i1 as f64 - start_s)) + 1)
    }
}

/// The source samples a clip at speed 1 plays over the timeline range `[t0, t1)` (ticks).
pub(crate) fn source_span(tps: f64, x: &Item, span: &Span, t0: f64, t1: f64) -> (i64, i64) {
    let c = x.clip;
    let a = t0.max(span.from) - c.start as f64;
    let b = t1.min(span.to) - c.start as f64;
    if c.reverse {
        (floor_i((c.out - b) / tps) - 1, ceil_i((c.out - a) / tps) + 1)
    } else {
        (floor_i((c.in_ + a) / tps) - 1, ceil_i((c.in_ + b) / tps) + 1)
    }
}

// ---- the clip -------------------------------------------------------------------------------------------------------

/// A gain effect of a clip without a chain: its entry, resolved parameters and keyframed ones.
type GainFx<'a> = (&'static AudioEffect, Vec<f64>, Vec<(usize, &'a Vec<Keyframe>)>);

/// What a render needs of the mixer.
pub(crate) struct Ctx<'m> {
    pub(crate) rate: f64,
    pub(crate) clock: &'m Clock,
    pub(crate) caches: &'m mut Caches,
    /// Source ranges a mix found missing, to read later: (store key, from, to).
    pub(crate) wants: &'m mut Vec<(String, i64, i64)>,
}

/// Adds one clip's sound for samples `[s0, s0 + n)` into `bus`; `false` when a block of its source is not read yet
/// (it is asked for).
pub(crate) fn render_clip(
    cx: &mut Ctx,
    bus: &mut Stereo,
    seq: &Sequence,
    x: &Item,
    store: &Store,
    s0: i64,
    n: i64,
) -> bool {
    let rate = cx.rate;
    let tps = TICKS as f64 / rate;
    let clip = x.clip;
    let dur = x.dur;
    let span = clip_span(seq, clip, dur);
    let a = s0.max(ceil_i(span.from / tps));
    let b = (s0 + n).min(ceil_i(span.to / tps));
    if b <= a {
        return true;
    }
    let speed1 = clip.speed == 1.0;
    let chain = chain_of(rate, x, &span);
    let g = (!speed1).then(|| speed_of(rate, store, x, &span));
    if let Some(g) = &g {
        let mut ready = true;
        for (k0, k1) in speed_reads(rate, cx.caches, g, chain.as_ref(), a, b) {
            if !store.has(cx.clock, k0, k1) {
                cx.wants.push((x.key.clone(), k0, k1));
                ready = false;
            }
        }
        if !ready {
            return false;
        }
    } else if chain.is_none() {
        let need = source_span(tps, x, &span, a as f64 * tps, b as f64 * tps);
        if store.reads() && !store.has(cx.clock, need.0, need.1) {
            cx.wants.push((x.key.clone(), need.0, need.1));
            return false;
        }
    }
    let mut segs: HashMap<i64, Option<Arc<Stereo>>> = HashMap::new();
    if let Some(g) = &g {
        let (ra, rb) = chain.as_ref().map_or((a, b), |c| chain_span(c, a, b));
        let k0 = round_i(ra as f64 - g.shift).max(0);
        let k1 = (g.out_len - 1).min(round_i((rb - 1) as f64 - g.shift));
        if k1 >= k0 {
            for j in k0.div_euclid(g.seg)..=k1.div_euclid(g.seg) {
                segs.insert(j, speed_segment(rate, store, cx.clock, cx.caches, g, j));
            }
        }
    }
    let in_s = clip.in_ / tps;
    let out_s = clip.out / tps;
    let start_t = clip.start as f64;
    let start_s = start_t / tps;
    // The block the last sample came from, so a run of samples looks its block up once.
    let current: std::cell::Cell<(i64, i64, Option<&Stereo>)> = std::cell::Cell::new((0, 0, None));
    let src_at = |i: i64| -> [f32; 2] {
        let along = i as f64 - start_s;
        match &g {
            None => {
                let k = if clip.reverse { round_i(out_s - along) - 1 } else { round_i(in_s + along) };
                if k < 0 || k >= store.length {
                    return [0.0; 2];
                }
                let (mut b0, mut b1, mut data) = current.get();
                if k < b0 || k >= b1 {
                    let j = k.div_euclid(store.size);
                    (b0, b1, data) =
                        (j * store.size, j * store.size + store.size, store.blocks.get(&j).map(|e| &e.data));
                    current.set((b0, b1, data));
                }
                match data {
                    Some(d) => {
                        let at = (k - b0) as usize;
                        [d[0].get(at).copied().unwrap_or(0.0), d[1].get(at).copied().unwrap_or(0.0)]
                    }
                    None => [0.0; 2],
                }
            }
            Some(g) => {
                let k = round_i(along - g.origin / tps);
                if k < 0 || k >= g.out_len {
                    return [0.0; 2];
                }
                let j = k.div_euclid(g.seg);
                match segs.get(&j) {
                    Some(Some(e)) => {
                        let at = (k - j * g.seg) as usize;
                        [e[0][at], e[1][at]]
                    }
                    _ => [0.0; 2],
                }
            }
        }
    };
    let fx_out = match &chain {
        Some(c) => {
            if g.is_none() && store.reads() {
                let (_, first) = first_segment(c, a);
                let jb = (b - 1 - c.anchor).div_euclid(FX_SEGMENT);
                for j in first..=jb {
                    if cx.caches.fx.contains_key(&format!("{}|{j}", c.key)) {
                        continue;
                    }
                    let (_, _, r0, r1) = segment_run(c, j);
                    let (k0, k1) = source_of(tps, clip, r0, c.end.min(r1 + c.latency));
                    if !store.has(cx.clock, k0, k1) {
                        cx.wants.push((x.key.clone(), k0, k1));
                        return false;
                    }
                }
            }
            Some(chain_range(rate, c, cx.clock, cx.caches, &src_at, a, b))
        }
        None => None,
    };
    let kf = |name: &str| clip.keyframes.get(name).filter(|l| !l.is_empty());
    let (vol_list, duck_list, pan_list) = (kf("volume"), kf("duck"), kf("pan"));
    let (base_vol, base_pan) = match &clip.props {
        Props::Audio(p) => (p.volume, p.pan),
        Props::Video(_) => (0.0, 0.0),
    };
    let num = |l: Option<&Vec<Keyframe>>, tau: f64, base: f64| match l.and_then(|l| value_at(l, tau)) {
        Some(Value::Num(v)) => v,
        Some(_) => f64::NAN,
        None => base,
    };
    // Gain effects on a clip without a chain; with a chain they are stages of it.
    let dur_s = dur as f64 / TICKS as f64;
    let gain_fx: Vec<GainFx> = if chain.is_some() {
        Vec::new()
    } else {
        audio_effects(clip)
            .filter(|(_, d)| !matches!(d.action, effects::Action::Dsp(_)))
            .map(|(e, d)| {
                let keyed = d
                    .params
                    .iter()
                    .enumerate()
                    .filter_map(|(i, p)| kf(&format!("effects.{}.{}", e.id.as_str(), p.id)).map(|l| (i, l)))
                    .collect();
                (d, d.resolve(&e.params), keyed)
            })
            .collect()
    };
    let effect_gain = |tau: f64| {
        let mut gain = 1.0;
        for (d, base, keyed) in &gain_fx {
            let mut p = Cow::Borrowed(base.as_slice());
            for (i, l) in keyed {
                if let Some(v) = value_at(l, tau) {
                    p.to_mut()[*i] = param_value(d.params[*i].kind, &v, base[*i]);
                }
            }
            gain *= d.gain(&p, tau / TICKS as f64, dur_s);
        }
        gain
    };
    let tin = transition_kind(seq, clip.track, clip.start);
    let tout = transition_kind(seq, clip.track, clip.start + dur);
    let (fade_in, fade_out) = (clip.fade_in as f64, clip.fade_out as f64);
    let durf = dur as f64;
    let gains_at = |tau: f64| -> (f64, f64) {
        let mut gain = db_to_gain(num(vol_list, tau, base_vol) + num(duck_list, tau, 0.0));
        if !gain_fx.is_empty() {
            gain *= effect_gain(tau);
        }
        if tau >= 0.0 && tau < durf {
            if fade_in > 0.0 && tau < fade_in {
                gain *= tau / fade_in;
            }
            if fade_out > 0.0 && tau > durf - fade_out {
                gain *= (durf - tau) / fade_out;
            }
        }
        let t = start_t + tau;
        if let Some((f0, f1)) = span.fade_in.filter(|r| t < r.1) {
            gain *= effects::transition_gains(tin, js_max(0.0, (t - f0) / (f1 - f0)))[1];
        }
        if let Some((f0, f1)) = span.fade_out.filter(|r| t >= r.0) {
            gain *= effects::transition_gains(tout, js_min(1.0, (t - f0) / (f1 - f0)))[0];
        }
        let p = js_max(-1.0, js_min(1.0, num(pan_list, tau, base_pan) / 100.0));
        (gain * if p > 0.0 { 1.0 - p } else { 1.0 }, gain * if p < 0.0 { 1.0 + p } else { 1.0 })
    };
    // Gains every KF_STEP samples on a grid from the clip's first audible sample, linear between.
    let anchor = ceil_i(span.from / tps);
    let mut seg = anchor + (a - anchor).div_euclid(KF_STEP) * KF_STEP;
    let [bl, br] = bus;
    while seg < b {
        let seg_end = seg + KF_STEP;
        let (gl0, gr0) = gains_at(seg as f64 * tps - start_t);
        let (gl1, gr1) = gains_at(seg_end as f64 * tps - start_t);
        for i in a.max(seg)..b.min(seg_end) {
            let f = (i - seg) as f64 / KF_STEP as f64;
            let [l, r] = match &fx_out {
                Some(o) => [o[0][(i - a) as usize], o[1][(i - a) as usize]],
                None => src_at(i),
            };
            let o = (i - s0) as usize;
            bl[o] = (f64::from(bl[o]) + f64::from(l) * (gl0 + (gl1 - gl0) * f)) as f32;
            br[o] = (f64::from(br[o]) + f64::from(r) * (gr0 + (gr1 - gr0) * f)) as f32;
        }
        seg = seg_end;
    }
    true
}
