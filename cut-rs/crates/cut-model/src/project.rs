//! The `.ncut` document as Rust types (docs/cut-architecture.md section 6, `Project` and below).
//!
//! Field names in JSON are the JavaScript's. Every object a newer version may extend keeps the fields this version
//! does not know in `extra`, so saving writes them back. Value-like parts (a keyframe, a mask, a word, a curve) are
//! rebuilt whole by the JavaScript's edits too, and have no `extra`.
//!
//! A sequence holds its clips per track, sorted by start, so finding what is under a time is a binary search. The file
//! lists them in one `clips` array; this writes them track by track, in time order (the JavaScript treats that list
//! as unordered).

use cut_time::{Fps, Ticks};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use serde_json::Value as Json;

use crate::captionwords::{Doubt, Word};
use crate::id::Id;
use crate::keyframes::Keyframe;
use crate::masks::Mask;
use crate::remap::Remap;

/// Fields of an object this version does not know, kept as they were read.
pub type Extra = serde_json::Map<String, Json>;

/// A whole project: what a `.ncut` file holds.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Project {
    pub format: String,
    pub version: i64,
    /// `fit`, `stillDuration`, `transitionDuration`, `freezeDuration`, `textStyles?`, `speechTerms?`, kept as JSON: the
    /// format checks nothing of them but that they are an object.
    pub settings: Extra,
    pub media: Vec<Media>,
    pub bins: Vec<Bin>,
    pub sequences: Vec<Sequence>,
    #[serde(rename = "nextId")]
    pub next_id: i64,
    /// Speaker labels (`Cut.speakers`), checked by validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speakers: Option<Json>,
    /// Lumetri Color's LUTs (`lut-<16 hex>` -> entry).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub luts: Option<Json>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

/// A file of the project.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Media {
    pub id: Id,
    pub path: String,
    pub name: String,
    pub kind: MediaKind,
    #[serde(default)]
    pub size: Json,
    #[serde(default)]
    pub mtime: Json,
    /// Ticks.
    pub duration: f64,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
    /// `null` or `{ fps }`.
    #[serde(default)]
    pub interpret: Json,
    pub proxy: Option<Proxy>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A media file's picture: `{ w, h, fps, codec, vfr, rotation }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VideoInfo {
    pub w: f64,
    pub h: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A media file's sound: `{ rate, channels, codec }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioInfo {
    pub rate: f64,
    pub channels: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The smaller file the editor plays in place of a media file.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Proxy {
    pub path: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A folder of the project panel.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bin {
    pub id: Id,
    pub name: String,
    pub parent: Option<Id>,
    pub items: Vec<Id>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A timeline. Its clips live in their tracks ([`Track::clips`]); `index` finds a clip's track by id.
#[derive(Debug, Clone)]
pub struct Sequence {
    pub id: Id,
    pub name: String,
    pub w: i64,
    pub h: i64,
    pub fps: Fps,
    pub rate: i64,
    pub background: String,
    pub master_gain: f64,
    pub tracks: Vec<Track>,
    pub transitions: Vec<Transition>,
    pub markers: Vec<Marker>,
    pub captions: Vec<CaptionTrack>,
    pub extra: Extra,
    /// Clip id -> its track and start, to find it in the track's sorted list.
    pub(crate) index: crate::id::IdMap<Id, (Id, Ticks)>,
    /// The clips' ids in the order of the file's `clips` list (the JavaScript's array order, which its edits keep).
    pub(crate) order: crate::order::Order,
    /// `order` as one list, made when [`Sequence::clip_order`] asks for it.
    pub(crate) order_list: std::sync::OnceLock<Vec<Id>>,
    /// Clips whose track is not there for a moment (an undo that puts back a track after its clips), boxed as the
    /// tracks hold them so they move back without a copy.
    #[allow(clippy::vec_box)]
    pub(crate) parked: Vec<Box<Clip>>,
    /// Link id -> the clips (on a track) that have it; the same for groups. Finding a link or group of one clip is
    /// then a lookup, not a pass over the sequence.
    pub(crate) links: crate::id::IdMap<Id, Vec<Id>>,
    pub(crate) groups: crate::id::IdMap<Id, Vec<Id>>,
}

impl PartialEq for Sequence {
    fn eq(&self, o: &Self) -> bool {
        self.id == o.id
            && self.name == o.name
            && self.w == o.w
            && self.h == o.h
            && self.fps == o.fps
            && self.rate == o.rate
            && self.background == o.background
            && self.master_gain == o.master_gain
            && self.tracks == o.tracks
            && self.transitions == o.transitions
            && self.markers == o.markers
            && self.captions == o.captions
            && self.extra == o.extra
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
}

/// A video or audio track and its clips, sorted by start.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Track {
    pub id: Id,
    pub kind: TrackKind,
    pub name: String,
    pub locked: bool,
    #[serde(rename = "syncLock")]
    pub sync_lock: bool,
    pub height: f64,
    /// Video tracks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// Audio tracks: mute, solo, volume (dB), pan (-100..100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solo: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pan: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
    #[serde(skip)]
    pub clips: Vec<Box<Clip>>,
}

impl Track {
    /// The track's fields without its clips, for an undo step that changes only them.
    pub fn info(&self) -> Track {
        Track { clips: Vec::new(), ..self.clone_info() }
    }

    fn clone_info(&self) -> Track {
        Track {
            id: self.id,
            kind: self.kind,
            name: self.name.clone(),
            locked: self.locked,
            sync_lock: self.sync_lock,
            height: self.height,
            visible: self.visible,
            mute: self.mute,
            solo: self.solo,
            volume: self.volume,
            pan: self.pan,
            extra: self.extra.clone(),
            clips: Vec::new(),
        }
    }

    /// The index after the last clip that starts at or before `t`.
    pub(crate) fn upper(&self, t: Ticks) -> usize {
        self.clips.partition_point(|c| c.start <= t)
    }

    /// The clip under `t` on this track, if any (clips of a valid track do not overlap).
    pub fn clip_at(&self, t: Ticks) -> Option<&Clip> {
        let i = self.upper(t);
        let c = self.clips.get(i.checked_sub(1)?)?;
        (t < c.end()).then_some(c)
    }

    /// Whether a clip of this track starts or ends at `t` (where a transition may sit).
    pub fn has_edge(&self, t: Ticks) -> bool {
        let i = self.clips.partition_point(|c| c.start < t);
        if self.clips.get(i).is_some_and(|c| c.start == t) || (i > 0 && self.clips[i - 1].end() == t) {
            return true;
        }
        // ends are in order only while clips do not overlap
        self.clips[..i].iter().any(|c| c.end() == t)
    }

    /// The clips that overlap `[a, b)`, in time order.
    pub fn clips_in(&self, a: Ticks, b: Ticks) -> &[Box<Clip>] {
        let mut lo = self.clips.partition_point(|c| c.start < a);
        if lo > 0 && self.clips[lo - 1].end() > a {
            lo -= 1;
        }
        let hi = self.clips.partition_point(|c| c.start < b);
        &self.clips[lo..hi.max(lo)]
    }
}

/// What a clip shows.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// A media file; `freeze`: a still of the frame at the clip's `in`.
    Media { media: Id, freeze: bool, extra: Extra },
    /// Another sequence of the project (a nest clip).
    Nest { sequence: Id, extra: Extra },
    /// Text, a solid color, an adjustment layer or a graphic, drawn from data.
    Generator { generator: Generator, layers: Option<Vec<Json>>, color: Option<String>, extra: Extra },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Generator {
    Text,
    Solid,
    Adjustment,
    Graphic,
}

impl Generator {
    pub fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Solid => "solid",
            Self::Adjustment => "adjustment",
            Self::Graphic => "graphic",
        }
    }
}

impl Serialize for Source {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = Extra::new();
        match self {
            Source::Media { media, freeze, extra } => {
                m.insert("media".into(), Json::from(media.as_str()));
                if *freeze {
                    m.insert("freeze".into(), Json::Bool(true));
                }
                m.extend(extra.clone());
            }
            Source::Nest { sequence, extra } => {
                m.insert("sequence".into(), Json::from(sequence.as_str()));
                m.extend(extra.clone());
            }
            Source::Generator { generator, layers, color, extra } => {
                m.insert("generator".into(), Json::from(generator.name()));
                if let Some(l) = layers {
                    m.insert("layers".into(), Json::Array(l.clone()));
                }
                if let Some(c) = color {
                    m.insert("color".into(), Json::from(c.as_str()));
                }
                m.extend(extra.clone());
            }
        }
        m.serialize(s)
    }
}

impl<'de> Deserialize<'de> for Source {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Source;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a clip's source")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Source, A::Error> {
                let (mut generator, mut layers, mut color, mut sequence, mut media, mut freeze) =
                    (None, None, None, None, None, None);
                let mut m = Extra::new();
                while let Some(key) = map.next_key::<crate::de::Key<'de>>()? {
                    let slot = match &*key.0 {
                        "generator" => &mut generator,
                        "layers" => &mut layers,
                        "color" => &mut color,
                        "sequence" => &mut sequence,
                        "media" => &mut media,
                        "freeze" => &mut freeze,
                        _ => {
                            m.insert(key.0.into_owned(), map.next_value()?);
                            continue;
                        }
                    };
                    *slot = Some(map.next_value::<Json>()?);
                }
                source_of(m, generator, layers, color, sequence, media, freeze).map_err(A::Error::custom)
            }
        }
        d.deserialize_map(V)
    }
}

/// A source from its fields, as the JavaScript tells them apart: a generator, a nest, or media.
fn source_of(
    mut m: Extra,
    generator: Option<Json>,
    layers: Option<Json>,
    color: Option<Json>,
    sequence: Option<Json>,
    media: Option<Json>,
    freeze: Option<Json>,
) -> Result<Source, String> {
    let text = |v: Json, what: &str| match v {
        Json::String(s) => Ok(s),
        _ => Err(format!("source: {what} is not a string")),
    };
    let mut keep = |k: &str, v: Option<Json>| {
        if let Some(v) = v {
            m.insert(k.to_owned(), v);
        }
    };
    if let Some(g) = generator {
        keep("sequence", sequence);
        keep("media", media);
        keep("freeze", freeze);
        let generator = Generator::deserialize(g).map_err(|e| e.to_string())?;
        let layers = match layers {
            None => None,
            Some(Json::Array(a)) => Some(a),
            Some(_) => return Err("source: layers is not a list".into()),
        };
        let color = color.map(|c| text(c, "color")).transpose()?;
        return Ok(Source::Generator { generator, layers, color, extra: m });
    }
    keep("layers", layers);
    keep("color", color);
    if let Some(seq) = sequence {
        if media.is_some() || freeze.is_some() {
            return Err("nest source".into());
        }
        return Ok(Source::Nest { sequence: Id::new(&text(seq, "sequence")?), extra: m });
    }
    let media = media.ok_or_else(|| "source".to_owned())?;
    let freeze = match freeze {
        None | Some(Json::Null) | Some(Json::Bool(false)) => false,
        Some(Json::Bool(true)) => true,
        Some(_) => return Err("source: freeze".into()),
    };
    Ok(Source::Media { media: Id::new(&text(media, "media")?), freeze, extra: m })
}

/// What a clip's sound is, for the automation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Dialogue,
    Music,
    Effects,
    Ambience,
}

/// Premiere's Time Interpolation: the nearest frame, or the two frames around the time mixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sampling {
    #[default]
    Sample,
    Blend,
}

/// Motion and Opacity of a video clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoProps {
    pub position: [f64; 2],
    pub scale: [f64; 2],
    pub rotation: f64,
    pub anchor: [f64; 2],
    pub opacity: f64,
    pub crop: [f64; 4],
}

impl Default for VideoProps {
    fn default() -> Self {
        Self { position: [0.0; 2], scale: [100.0; 2], rotation: 0.0, anchor: [0.0; 2], opacity: 100.0, crop: [0.0; 4] }
    }
}

/// Volume (dB) and pan of an audio clip.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioProps {
    pub volume: f64,
    pub pan: f64,
}

/// A clip's static properties, by the kind of its track.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Props {
    Video(VideoProps),
    Audio(AudioProps),
}

impl Props {
    pub fn of(kind: TrackKind) -> Self {
        match kind {
            TrackKind::Video => Props::Video(VideoProps::default()),
            TrackKind::Audio => Props::Audio(AudioProps::default()),
        }
    }

    pub fn kind(&self) -> TrackKind {
        match self {
            Props::Video(_) => TrackKind::Video,
            Props::Audio(_) => TrackKind::Audio,
        }
    }

    /// The value of one property as a keyframe value, `None` when this kind has no such property.
    pub fn get(&self, name: &str) -> Option<crate::keyframes::Value> {
        use crate::keyframes::Value as V;
        Some(match (self, name) {
            (Props::Video(p), "position") => V::List(p.position.to_vec()),
            (Props::Video(p), "scale") => V::List(p.scale.to_vec()),
            (Props::Video(p), "rotation") => V::Num(p.rotation),
            (Props::Video(p), "anchor") => V::List(p.anchor.to_vec()),
            (Props::Video(p), "opacity") => V::Num(p.opacity),
            (Props::Video(p), "crop") => V::List(p.crop.to_vec()),
            (Props::Audio(p), "volume") => V::Num(p.volume),
            (Props::Audio(p), "pan") => V::Num(p.pan),
            _ => return None,
        })
    }
}

impl<'de> Deserialize<'de> for Props {
    /// Exactly the six video properties or the two audio ones, as the untagged derive with `deny_unknown_fields` read
    /// them, without reading the object twice.
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Props;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a clip's props")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Props, A::Error> {
                let (mut position, mut scale, mut rotation, mut anchor, mut opacity, mut crop) =
                    (None, None, None, None, None, None);
                let (mut volume, mut pan) = (None, None);
                while let Some(key) = map.next_key::<crate::de::Key<'de>>()? {
                    match &*key.0 {
                        "position" => position = Some(map.next_value::<[f64; 2]>()?),
                        "scale" => scale = Some(map.next_value::<[f64; 2]>()?),
                        "rotation" => rotation = Some(map.next_value::<f64>()?),
                        "anchor" => anchor = Some(map.next_value::<[f64; 2]>()?),
                        "opacity" => opacity = Some(map.next_value::<f64>()?),
                        "crop" => crop = Some(map.next_value::<[f64; 4]>()?),
                        "volume" => volume = Some(map.next_value::<f64>()?),
                        "pan" => pan = Some(map.next_value::<f64>()?),
                        k => return Err(A::Error::custom(format!("props: unknown field {k}"))),
                    }
                }
                let audio_keys = volume.is_some() || pan.is_some();
                let neither = || A::Error::custom("props: neither video nor audio properties");
                match (position, scale, rotation, anchor, opacity, crop) {
                    (Some(position), Some(scale), Some(rotation), Some(anchor), Some(opacity), Some(crop))
                        if !audio_keys =>
                    {
                        Ok(Props::Video(VideoProps { position, scale, rotation, anchor, opacity, crop }))
                    }
                    (None, None, None, None, None, None) => match (volume, pan) {
                        (Some(volume), Some(pan)) => Ok(Props::Audio(AudioProps { volume, pan })),
                        _ => Err(neither()),
                    },
                    _ => Err(neither()),
                }
            }
        }
        d.deserialize_map(V)
    }
}

/// The keyframes of a clip, by property path (`opacity`, `effects.<id>.<param>`, `masks.<id>.path` ...).
pub type Keyframes = std::collections::BTreeMap<String, Vec<Keyframe>>;

/// A clip on a track.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Clip {
    pub id: Id,
    pub track: Id,
    pub start: Ticks,
    /// Source in and out (source ticks; not whole ticks at speeds other than 1).
    #[serde(rename = "in")]
    pub in_: f64,
    pub out: f64,
    pub source: Source,
    pub speed: f64,
    pub reverse: bool,
    pub enabled: bool,
    pub link: Option<Id>,
    pub group: Option<Id>,
    pub name: String,
    pub label: Option<String>,
    pub role: Option<Role>,
    pub props: Props,
    pub keyframes: Keyframes,
    pub effects: Vec<Effect>,
    #[serde(rename = "fadeIn")]
    pub fade_in: Ticks,
    #[serde(rename = "fadeOut")]
    pub fade_out: Ticks,
    pub remap: Option<Remap>,
    pub sampling: Sampling,
    /// Clip markers, `t` from the clip's start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markers: Option<Vec<Marker>>,
    /// Opacity's masks; absent when none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masks: Option<Vec<Mask>>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// An effect of a clip; `params` only where they differ from the registry's defaults.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Effect {
    pub id: Id,
    #[serde(rename = "type")]
    pub kind: String,
    pub on: bool,
    pub params: Extra,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masks: Option<Vec<Mask>>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Center,
    Start,
    End,
}

/// A transition at an edit point of a track.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transition {
    pub id: Id,
    pub track: Id,
    pub at: Ticks,
    #[serde(rename = "type")]
    pub kind: String,
    pub duration: Ticks,
    pub align: Align,
    pub params: Extra,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarkerKind {
    Comment,
    Chapter,
    Beat,
}

/// A sequence marker, or a clip marker (`t` from the clip's start).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Marker {
    pub id: Id,
    pub t: Ticks,
    pub duration: Ticks,
    pub name: String,
    pub note: String,
    pub kind: MarkerKind,
    pub color: String,
    #[serde(flatten)]
    pub extra: Extra,
}

/// A track of captions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaptionTrack {
    pub id: Id,
    pub lang: String,
    pub name: String,
    pub style: Extra,
    #[serde(rename = "syncLock")]
    pub sync_lock: bool,
    pub items: Vec<Caption>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// One caption.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Caption {
    pub id: Id,
    pub start: Ticks,
    pub end: Ticks,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doubt: Option<Vec<Doubt>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<Word>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// Why a project file could not be read.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LoadError {
    /// `notProject`.
    #[error("This is not a Nano Studio Cut project.")]
    NotProject,
    /// `newer`, with the detail `format version N, this app reads 5`.
    #[error("This project was saved by a newer version of Nano Studio Cut.")]
    Newer(String),
    /// `damaged`: the file does not hold a project of this shape (the first problems).
    #[error("The project is damaged and cannot be edited.")]
    Damaged(String),
}

impl LoadError {
    /// The JavaScript's `err.code`.
    pub fn code(&self) -> &'static str {
        match self {
            LoadError::NotProject => "notProject",
            LoadError::Newer(_) => "newer",
            LoadError::Damaged(_) => "damaged",
        }
    }
}

impl Project {
    /// Reads a project file as the editor opens one: `migrate` (older versions, missing fields, times off the frame
    /// grid), then the types, then `validate` (`damaged` when it fails, as `createHistory` refuses it). A file of this
    /// version that `migrate` would leave as it is goes straight into the types, without the JSON tree.
    pub fn load(text: &str) -> Result<Project, LoadError> {
        if let Ok(p) = serde_json::from_str::<Project>(text)
            && crate::migrate::is_current(&p)
        {
            return Self::validated(p);
        }
        Self::load_migrating(text)
    }

    /// [`load`](Self::load) always through `migrate` on the JSON tree (what `load` does with an older file).
    pub fn load_migrating(text: &str) -> Result<Project, LoadError> {
        let json: Json = serde_json::from_str(text).map_err(|_| LoadError::NotProject)?;
        Self::from_json(crate::migrate::migrate(json)?)
    }

    fn validated(p: Project) -> Result<Project, LoadError> {
        let v = crate::validate::validate(&p);
        if !v.ok() {
            return Err(LoadError::Damaged(v.errors.iter().take(5).cloned().collect::<Vec<_>>().join("; ")));
        }
        Ok(p)
    }

    /// A migrated project's JSON as Rust types, validated.
    pub fn from_json(json: Json) -> Result<Project, LoadError> {
        let p: Project = serde_json::from_value(json).map_err(|e| LoadError::Damaged(e.to_string()))?;
        Self::validated(p)
    }

    /// The project file's text.
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("a project always serializes")
    }

    pub fn sequence(&self, id: Id) -> Option<&Sequence> {
        self.sequences.iter().find(|s| s.id == id)
    }

    pub fn sequence_mut(&mut self, id: Id) -> Option<&mut Sequence> {
        self.sequences.iter_mut().find(|s| s.id == id)
    }

    pub fn media(&self, id: Id) -> Option<&Media> {
        self.media.iter().find(|m| m.id == id)
    }
}

crate::de::with_extra!(Project, "a project" {
    format: "format", version: "version", settings: "settings", media: "media", bins: "bins",
    sequences: "sequences", next_id: "nextId", speakers: "speakers" default, luts: "luts" default,
});
crate::de::with_extra!(Media, "a media file" {
    id: "id", path: "path", name: "name", kind: "kind", size: "size" default, mtime: "mtime" default,
    duration: "duration", video: "video" default, audio: "audio" default, interpret: "interpret" default,
    proxy: "proxy" default,
});
crate::de::with_extra!(VideoInfo, "a video stream" { w: "w", h: "h" });
crate::de::with_extra!(AudioInfo, "an audio stream" { rate: "rate", channels: "channels" });
crate::de::with_extra!(Proxy, "a proxy" { path: "path" });
crate::de::with_extra!(Bin, "a bin" { id: "id", name: "name", parent: "parent" default, items: "items" });
crate::de::with_extra!(Track, "a track" {
    id: "id", kind: "kind", name: "name", locked: "locked", sync_lock: "syncLock", height: "height",
    visible: "visible" default, mute: "mute" default, solo: "solo" default, volume: "volume" default,
    pan: "pan" default,
} skip [clips]);
crate::de::with_extra!(Clip, "a clip" {
    id: "id", track: "track", start: "start", in_: "in", out: "out", source: "source", speed: "speed",
    reverse: "reverse", enabled: "enabled", link: "link" default, group: "group" default, name: "name",
    label: "label" default, role: "role" default, props: "props", keyframes: "keyframes", effects: "effects",
    fade_in: "fadeIn", fade_out: "fadeOut", remap: "remap" default, sampling: "sampling",
    markers: "markers" default, masks: "masks" default,
});
crate::de::with_extra!(Effect, "an effect" {
    id: "id", kind: "type", on: "on", params: "params", masks: "masks" default,
});
crate::de::with_extra!(Transition, "a transition" {
    id: "id", track: "track", at: "at", kind: "type", duration: "duration", align: "align", params: "params",
});
crate::de::with_extra!(Marker, "a marker" {
    id: "id", t: "t", duration: "duration", name: "name", note: "note", kind: "kind", color: "color",
});
crate::de::with_extra!(CaptionTrack, "a caption track" {
    id: "id", lang: "lang", name: "name", style: "style", sync_lock: "syncLock", items: "items",
});
crate::de::with_extra!(Caption, "a caption" {
    id: "id", start: "start", end: "end", text: "text", doubt: "doubt" default, words: "words" default,
    speaker: "speaker" default,
});
