//! What is on screen at a time (port of compositor.js's pure part): the layers of a sequence bottom first, each clip
//! as an [`Item`] with every value at that time (effects, motion, opacity, masks, Frame Blending), transitions with
//! their two clips. The GPU back end draws exactly this.

use cut_model::effects::{self as fx, Def, Kind};
use cut_model::keyframes::{self, Value};
use cut_model::masks::{Mask, MaskMode, valid_path};
use cut_model::{Clip, Generator, Media, MediaKind, Project, Sequence, Source, TrackKind, Transition};
use cut_time::Fps;
use serde_json::{Map, Value as Json};

/// What an item shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Video,
    Image,
    Text,
    Solid,
    Graphic,
    Adjustment,
    Nest,
    /// A nest clip whose sequence is gone.
    Empty,
}

/// An effect of an item, its parameters resolved at the item's time.
#[derive(Debug, Clone)]
pub struct ItemEffect {
    pub id: String,
    pub def: &'static Def,
    pub params: Map<String, Json>,
    /// The LUT id the effect reads from `project.luts` (Lumetri Color's Look), if any.
    pub lut: Option<String>,
    pub masks: Option<Vec<Mask>>,
}

/// Frame Blending: the next source frame and how far past the frame before the time is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Blend {
    pub src_t: f64,
    pub w: f64,
}

/// Everything the back end needs to draw a clip at a time.
#[derive(Debug, Clone)]
pub struct Item<'p> {
    pub clip: &'p Clip,
    pub media: Option<&'p Media>,
    pub kind: ItemKind,
    /// Time from the clip's start.
    pub local: f64,
    /// The source time shown (a nest: the time in its sequence).
    pub src_t: f64,
    pub blend: Option<Blend>,
    pub effects: Vec<ItemEffect>,
    pub sequence: Option<&'p Sequence>,
    pub layers: Vec<Layer<'p>>,
    /// The ids of the nest clips above it and its own (`c12/c4`): one frame source per key.
    pub key: String,
    /// The size of the sequence it is placed in.
    pub seq_w: f64,
    pub seq_h: f64,
    pub position: [f64; 2],
    pub scale: [f64; 2],
    pub rotation: f64,
    pub anchor: [f64; 2],
    pub opacity: f64,
    /// `[top, right, bottom, left]` percent.
    pub crop: [f64; 4],
    pub extend: bool,
    /// Opacity's masks at the item's time.
    pub masks: Option<Vec<Mask>>,
    /// The clip-local frame (grain and glitch change with it).
    pub frame_index: i64,
}

/// One layer of a sequence at a time.
// A plan lives for one render; boxing its items would only add allocations.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum Layer<'p> {
    Clip(Item<'p>),
    Transition {
        transition: &'p Transition,
        def: &'static Def,
        params: Map<String, Json>,
        progress: f64,
        a: Option<Item<'p>>,
        b: Option<Item<'p>>,
    },
}

/// The scale that fits a `sw` x `sh` picture into `w` x `h` (`settings.fit`: `fill`, `original`, else fit).
pub fn fit_scale(sw: f64, sh: f64, w: f64, h: f64, mode: Option<&str>) -> f64 {
    if !(sw > 0.0 && sh > 0.0) || mode == Some("original") {
        return 1.0;
    }
    if mode == Some("fill") { (w / sw).max(h / sh) } else { (w / sw).min(h / sh) }
}

/// `[start, end)` of a transition on the timeline.
pub fn transition_range(x: &Transition) -> (f64, f64) {
    let (at, d) = (x.at as f64, x.duration as f64);
    match x.align {
        cut_model::Align::Start => (at, at + d),
        cut_model::Align::End => (at - d, at),
        cut_model::Align::Center => (at - d / 2.0, at + d / 2.0),
    }
}

/// The source time of a clip at timeline time t past its ends too (a transition shows the handles beyond in/out, or
/// holds the last frame there is).
pub fn extended_source_time(clip: &Clip, t: f64, duration: f64) -> f64 {
    if clip.is_freeze() {
        return clip.in_;
    }
    let hi = (duration - 1.0).max(0.0);
    if let Some(r) = &clip.remap {
        return cut_model::remap::source_at(r, t - clip.start as f64).min(hi).max(0.0);
    }
    let along = (t - clip.start as f64) * clip.speed;
    let v = if clip.reverse { clip.out - along - 1.0 } else { clip.in_ + along };
    v.min(hi).max(0.0)
}

/// How much source a transition needs beyond what its clips have (timeline ticks): `(outgoing, incoming)`.
pub fn missing_handles(project: &Project, seq: &Sequence, tn: &Transition) -> (f64, f64) {
    let (ts, te) = transition_range(tn);
    let track = seq.track(tn.track);
    let clips = track.map(|t| t.clips.as_slice()).unwrap_or_default();
    let a = clips.iter().find(|c| c.end() == tn.at);
    let b = clips.iter().find(|c| c.start == tn.at);
    let short = |clip: &Clip, t: f64| {
        let Some(m) = media_of(project, clip) else { return 0.0 };
        if m.kind == MediaKind::Image || clip.is_freeze() {
            return 0.0;
        }
        let start = clip.start as f64;
        if let Some(r) = &clip.remap {
            let v = cut_model::remap::value(r, t - start);
            let s = cut_model::remap::speed_at(r, t - start).abs();
            return (v - m.duration).max(-v).max(0.0) / if s == 0.0 || s.is_nan() { 1.0 } else { s };
        }
        let along = (t - start) * clip.speed;
        let v = if clip.reverse { clip.out - along } else { clip.in_ + along };
        (v - m.duration).max(-v).max(0.0) / clip.speed
    };
    (a.map_or(0.0, |c| short(c, te)), b.map_or(0.0, |c| short(c, ts)))
}

fn media_of<'p>(project: &'p Project, clip: &Clip) -> Option<&'p Media> {
    project.media(clip.media_id()?)
}

fn num(v: Option<Value>, d: f64) -> f64 {
    match v {
        Some(Value::Num(x)) => x,
        _ => d,
    }
}

fn list<const N: usize>(v: Option<Value>, d: [f64; N]) -> [f64; N] {
    match v {
        Some(Value::List(l)) => std::array::from_fn(|i| l.get(i).copied().unwrap_or(f64::NAN)),
        _ => d,
    }
}

fn to_json(v: Value) -> Json {
    serde_json::to_value(v).unwrap_or(Json::Null)
}

/// The masks of a list with their values at clip time `local` (masks.js `at`): those of mode None left out, `None`
/// when none is left.
pub fn masks_at(clip: &Clip, prefix: &str, list: &[Mask], local: f64) -> Option<Vec<Mask>> {
    let mut out = Vec::new();
    for m in list.iter().filter(|m| m.mode != MaskMode::None) {
        let kf =
            |f: &str| clip.keyframes.get(&format!("{prefix}.{}.{f}", m.id)).and_then(|l| keyframes::value_at(l, local));
        let path = match kf("path") {
            Some(Value::List(p)) if valid_path(&p) => p,
            _ => m.path.clone(),
        };
        let n = |f: &str, d: f64| match kf(f) {
            Some(Value::Num(x)) => x,
            Some(_) => f64::NAN,
            None => d,
        };
        out.push(Mask {
            id: m.id,
            mode: m.mode,
            inverted: m.inverted,
            path,
            feather: n("feather", m.feather),
            opacity: n("opacity", m.opacity),
            expansion: n("expansion", m.expansion),
        });
    }
    (!out.is_empty()).then_some(out)
}

/// Frame Blending: the frame after the one at `src_t` and its weight; `None` on a frame, for Frame Sampling and for a
/// file of no constant rate.
fn blend_of(clip: &Clip, media: &Media, src_t: f64) -> Option<Blend> {
    if clip.sampling != cut_model::Sampling::Blend {
        return None;
    }
    let v = media.video.as_ref()?;
    if v.extra.get("vfr").is_some_and(|x| x.as_bool() == Some(true)) {
        return None;
    }
    let fps = v.extra.get("fps")?.as_array()?;
    let fps = Fps::new(fps.first()?.as_u64()? as u32, fps.get(1)?.as_u64()? as u32);
    let fd = fps.frame_ticks()? as f64;
    let k = (src_t / fd + 1e-9).floor();
    let w = src_t / fd - k;
    if w < 1e-3 || w > 1.0 - 1e-3 || (k + 1.0) * fd >= media.duration {
        return None;
    }
    Some(Blend { src_t: (k + 1.0) * fd, w })
}

/// Everything the back end needs to draw `clip` at timeline time `t` (`extended`: past its ends, in a transition).
pub fn plan_item<'p>(
    project: &'p Project,
    seq: &'p Sequence,
    clip: &'p Clip,
    t: f64,
    extended: bool,
    scope: &str,
) -> Item<'p> {
    let local = t - clip.start as f64;
    let media = media_of(project, clip);
    let mut effects = Vec::new();
    for e in clip.effects.iter().filter(|e| e.on) {
        let Some(def) = fx::get(&e.kind).filter(|d| !d.transition && d.kind == Kind::Video) else {
            continue;
        };
        let mut params = Map::new();
        for pd in def.params {
            let v = keyframes::prop_value(clip, &format!("effects.{}.{}", e.id, pd.id), local).map(to_json);
            params.insert(pd.id.to_owned(), v.unwrap_or_else(|| pd.default.to_json()));
        }
        let params = fx::resolve(&e.kind, &params);
        let lut = (e.kind == "color.basic").then(|| params.get("lut").and_then(Json::as_str).unwrap_or("").to_string());
        let masks = match &e.masks {
            Some(l) if !l.is_empty() && def.masks => masks_at(clip, &format!("effects.{}.masks", e.id), l, local),
            _ => None,
        };
        effects.push(ItemEffect { id: e.id.as_str().to_string(), def, params, lut, masks });
    }
    let (mut src_t, mut sequence, mut layers, mut blend) = (0.0, None, Vec::new(), None);
    let nest = project.nest_of(clip);
    let kind = if let Some(m) = media {
        let k = if m.kind == MediaKind::Image { ItemKind::Image } else { ItemKind::Video };
        src_t = if extended { extended_source_time(clip, t, m.duration) } else { clip.source_time(t) };
        if k == ItemKind::Video {
            blend = blend_of(clip, m, src_t);
        }
        k
    } else if let Some(n) = nest {
        src_t = if extended { extended_source_time(clip, t, n.duration() as f64) } else { clip.source_time(t) };
        sequence = Some(n);
        layers = plan(project, n, src_t, &format!("{scope}{}/", clip.id));
        ItemKind::Nest
    } else {
        match &clip.source {
            Source::Nest { .. } => ItemKind::Empty,
            Source::Generator { generator, .. } => match generator {
                Generator::Text => ItemKind::Text,
                Generator::Solid => ItemKind::Solid,
                Generator::Adjustment => ItemKind::Adjustment,
                Generator::Graphic => ItemKind::Graphic,
            },
            Source::Media { .. } => ItemKind::Solid,
        }
    };
    let prop = |name: &str| keyframes::prop_value(clip, name, local);
    let fps = seq.fps;
    Item {
        clip,
        media,
        kind,
        local,
        src_t,
        blend,
        extend: effects.iter().any(|e| e.def.extend),
        effects,
        sequence,
        layers,
        key: format!("{scope}{}", clip.id),
        seq_w: seq.w as f64,
        seq_h: seq.h as f64,
        position: list(prop("position"), [0.0, 0.0]),
        scale: list(prop("scale"), [100.0, 100.0]),
        rotation: num(prop("rotation"), 0.0),
        anchor: list(prop("anchor"), [0.0, 0.0]),
        opacity: num(prop("opacity"), 100.0),
        crop: list(prop("crop"), [0.0; 4]),
        masks: clip.masks.as_deref().filter(|m| !m.is_empty()).and_then(|m| masks_at(clip, "masks", m, local)),
        frame_index: if fps.num > 0 { cut_time::frame_at(local.round() as i64, fps) } else { 0 },
    }
}

/// The layers of a sequence at t, bottom first (adjustment layers and empty nests left out, as the JavaScript does).
pub fn plan<'p>(project: &'p Project, seq: &'p Sequence, t: f64, scope: &str) -> Vec<Layer<'p>> {
    let mut layers = Vec::new();
    for track in &seq.tracks {
        if track.kind != TrackKind::Video || track.visible == Some(false) {
            continue;
        }
        let tn = seq.transitions.iter().find(|x| {
            let (a, b) = transition_range(x);
            x.track == track.id && t >= a && t < b
        });
        if let Some(tn) = tn
            && let Some(def) = fx::get(&tn.kind).filter(|d| d.transition && d.kind == Kind::Video)
        {
            let a = track.clips.iter().find(|c| c.enabled && c.end() == tn.at);
            let b = track.clips.iter().find(|c| c.enabled && c.start == tn.at);
            if a.is_some() || b.is_some() {
                let (ra, rb) = transition_range(tn);
                layers.push(Layer::Transition {
                    transition: tn,
                    def,
                    params: fx::resolve(&tn.kind, &tn.params),
                    progress: ((t - ra) / (rb - ra)).clamp(0.0, 1.0),
                    a: a.map(|c| plan_item(project, seq, c, t, true, scope)),
                    b: b.map(|c| plan_item(project, seq, c, t, true, scope)),
                });
                continue;
            }
        }
        let i = track.clips.partition_point(|c| c.start as f64 <= t);
        if let Some(c) = i.checked_sub(1).map(|i| &track.clips[i])
            && c.enabled
            && t < c.end() as f64
        {
            let item = plan_item(project, seq, c, t, false, scope);
            if !matches!(item.kind, ItemKind::Adjustment | ItemKind::Empty) {
                layers.push(Layer::Clip(item));
            }
        }
    }
    layers
}

/// The caption tracks to burn in: `Which::First` the first track, else those named. `t` is at the start of its
/// frame, so a playing monitor and the export light the same word.
pub enum Which<'a> {
    None,
    First,
    Ids(&'a [cut_model::Id]),
}

/// One caption track's items under t, each with how its speaker shows ([`shown`]).
pub struct Captions<'p> {
    pub style: &'p Map<String, Json>,
    pub t: f64,
    pub items: Vec<&'p cut_model::Caption>,
    pub shown: Vec<Shown>,
}

/// A caption as shown (speakers.js `shown`): its speaker's name before the text (`style.speakerName`, as `Name: `)
/// and its colour (`style.speakerColor`), for a speaker of the project's labels.
#[derive(Debug, Clone, PartialEq, Eq, Default, Hash)]
pub struct Shown {
    pub prefix: String,
    pub color: Option<String>,
}

/// JavaScript's truthiness, for fields another editor wrote.
fn truthy(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Json::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// How `item` of a track of `style` shows its speaker under the project's labels `speakers` (speakers.js `shown` as
/// `decorate` applies it: nothing without labels or when the style shows no speakers); `unnamed` is "Speaker {n}"
/// in the screen's language.
pub fn shown(speakers: Option<&Json>, style: &Map<String, Json>, item: &cut_model::Caption, unnamed: &str) -> Shown {
    let list = speakers.and_then(|s| s.get("list")).and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
    let (name, color) = (truthy(style.get("speakerName")), truthy(style.get("speakerColor")));
    let at = item
        .speaker
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| list.iter().position(|s| s.get("id").and_then(Json::as_str) == Some(id)));
    let Some(i) = at.filter(|_| name || color) else { return Shown::default() };
    let text = |v: Option<&Json>| match v {
        Some(Json::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => String::new(),
    };
    let own = list[i].get("name");
    let label = if truthy(own) { text(own) } else { unnamed.replacen("{n}", &(i + 1).to_string(), 1) };
    Shown {
        prefix: if name { format!("{label}: ") } else { String::new() },
        color: (color && truthy(list[i].get("color"))).then(|| text(list[i].get("color"))),
    }
}

/// The caption tracks `which` names, with the items under t and how their speakers show under `speakers` (the
/// project's labels; `unnamed` as [`shown`] takes it).
pub fn captions_at<'p>(
    seq: &'p Sequence,
    t: f64,
    which: Which<'_>,
    speakers: Option<&Json>,
    unnamed: &str,
) -> Vec<Captions<'p>> {
    let chosen: Vec<&cut_model::CaptionTrack> = match which {
        Which::None => return Vec::new(),
        Which::First => seq.captions.iter().take(1).collect(),
        Which::Ids(ids) => seq.captions.iter().filter(|c| ids.contains(&c.id)).collect(),
    };
    let ft = if seq.fps.num > 0 { cut_time::snap(t.round() as i64, seq.fps, false) as f64 } else { t };
    chosen
        .into_iter()
        .map(|c| {
            let items: Vec<&cut_model::Caption> =
                c.items.iter().filter(|it| it.start as f64 <= t && t < it.end as f64).collect();
            let shown = items.iter().map(|it| shown(speakers, &c.style, it, unnamed)).collect();
            Captions { style: &c.style, t: ft, items, shown }
        })
        .filter(|c| !c.items.is_empty())
        .collect()
}
