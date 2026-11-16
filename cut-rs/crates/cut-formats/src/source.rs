use cut_time::Ticks;
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::error::FormatError;

/// An opened media file (docs/cut-architecture.md section 5); serializes to the JavaScript's `Source`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub container: Option<Container>,
    /// Ticks. Matroska: the shorter of Info's Duration and the measured end, when both exist.
    pub duration: Ticks,
    /// Video first, then audio; images have none.
    pub tracks: Vec<Track>,
    /// Tracks left out: an unsupported codec, encryption, no samples.
    pub skipped: Vec<Skipped>,
    pub image: Option<Image>,
    pub error: Option<FormatError>,
    /// MP4 only: the ftyp brands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brands: Option<Vec<String>>,
    /// Matroska only: a stretch of the file could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damaged: Option<bool>,
}

impl Source {
    /// A source without tracks: an error, or the start of an image.
    pub fn empty(container: Option<Container>, error: Option<FormatError>) -> Self {
        Self {
            container,
            duration: 0,
            tracks: Vec::new(),
            skipped: Vec::new(),
            image: None,
            error,
            brands: None,
            damaged: None,
        }
    }
}

/// The kind of file a source is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Mov,
    Webm,
    Mkv,
    Mp3,
    Wav,
    Aac,
    Image,
}

/// Video or audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Audio,
}

/// A still the engine decodes itself (PNG, JPEG, WebP, GIF, BMP, AVIF).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Image {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// A track left out of a source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub id: u64,
    pub kind: Kind,
    pub codec: String,
    pub reason: String,
}

/// One video or audio track with its sample table.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: u64,
    #[serde(flatten)]
    pub media: Media,
    /// A WebCodecs codec string (`avc1.640028`, `opus`, `pcm-s16` ...).
    pub codec: String,
    /// The decoder configuration record, or none (VP8, VP9, MP3, PCM).
    pub description: Option<Vec<u8>>,
    pub duration: Ticks,
    /// The file ends before its tables say.
    pub truncated: bool,
    /// Decoding starts this much before a sample (Opus 80 ms, or the WebM SeekPreRoll).
    pub pre_roll: Ticks,
    /// Matroska header stripping: bytes put in front of each sample read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_prefix: Option<Vec<u8>>,
    pub samples: SampleTable,
}

impl Track {
    /// Whether the track is video or audio.
    pub fn kind(&self) -> Kind {
        match self.media {
            Media::Video(_) => Kind::Video,
            Media::Audio(_) => Kind::Audio,
        }
    }
}

/// What a track is, with the fields of its kind.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Media {
    Video(Video),
    Audio(Audio),
}

/// What a video track says of its pictures.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    /// The coded size.
    pub width: u32,
    pub height: u32,
    /// The size with the pixel aspect applied, before rotation.
    pub display_width: u32,
    pub display_height: u32,
    /// Clockwise degrees (0, 90, 180, 270) to show it upright.
    pub rotation: u32,
    pub bit_depth: u32,
    pub color_space: Option<ColorSpace>,
    /// The nominal rate `[num, den]`: the most common frame duration, also for variable rates.
    pub frame_rate: [u64; 2],
    /// Frame durations vary by more than 1 %.
    pub vfr: bool,
}

/// What an audio track says of its sound.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    pub sample_rate: u32,
    pub channels: u32,
}

/// Colour as WebCodecs' `VideoColorSpace` names it; a field the file does not give is `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorSpace {
    pub primaries: Option<Primaries>,
    pub transfer: Option<Transfer>,
    pub matrix: Option<Matrix>,
    pub full_range: Option<bool>,
}

/// Colour primaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Primaries {
    Bt709,
    Bt470bg,
    Smpte170m,
    Bt2020,
    Smpte432,
}

/// Transfer characteristics (the curve from light to code values).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Transfer {
    #[serde(rename = "bt709")]
    Bt709,
    #[serde(rename = "smpte170m")]
    Smpte170m,
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "iec61966-2-1")]
    Srgb,
    #[serde(rename = "pq")]
    Pq,
    #[serde(rename = "hlg")]
    Hlg,
}

/// Matrix coefficients (RGB to YUV).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Matrix {
    #[serde(rename = "rgb")]
    Rgb,
    #[serde(rename = "bt709")]
    Bt709,
    #[serde(rename = "bt470bg")]
    Bt470bg,
    #[serde(rename = "smpte170m")]
    Smpte170m,
    #[serde(rename = "bt2020-ncl")]
    Bt2020Ncl,
}

/// A track's samples as columns, in decode order. Times are ticks from the track start after edit lists.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SampleTable {
    /// Byte offset in the file.
    pub offset: Vec<u64>,
    pub size: Vec<u32>,
    pub dts: Vec<Ticks>,
    pub pts: Vec<Ticks>,
    pub duration: Vec<Ticks>,
    /// Sync samples.
    pub key: Vec<bool>,
    /// Sample indexes sorted by pts.
    pub order: Vec<u32>,
    /// The sync sample indexes.
    pub keys: Vec<u32>,
}

impl SampleTable {
    /// Samples in the table.
    pub fn count(&self) -> usize {
        self.offset.len()
    }

    pub fn is_empty(&self) -> bool {
        self.offset.is_empty()
    }
}

impl Serialize for SampleTable {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("SampleTable", 9)?;
        st.serialize_field("count", &self.count())?;
        st.serialize_field("offset", &self.offset)?;
        st.serialize_field("size", &self.size)?;
        st.serialize_field("dts", &self.dts)?;
        st.serialize_field("pts", &self.pts)?;
        st.serialize_field("duration", &self.duration)?;
        let key: Vec<u8> = self.key.iter().map(|&k| u8::from(k)).collect();
        st.serialize_field("key", &key)?;
        st.serialize_field("order", &self.order)?;
        st.serialize_field("keys", &self.keys)?;
        st.end()
    }
}
