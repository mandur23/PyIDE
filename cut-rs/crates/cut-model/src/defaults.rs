//! The model's names and factories (port of model.js's constants and `create*` functions).

use cut_time::{Fps, TICKS};
use serde_json::{Value as Json, json};

use crate::id::Id;
use crate::project::{Clip, Extra, Project, Props, Sampling, Sequence, Source, Track, TrackKind};
use crate::query::VERSION;

pub const SAMPLINGS: [&str; 2] = ["sample", "blend"];
pub const EASES: [&str; 6] = ["linear", "hold", "easeIn", "easeOut", "easeInOut", "bezier"];
pub const GENERATORS: [&str; 4] = ["text", "solid", "adjustment", "graphic"];
pub const VIDEO_PROPS: [&str; 6] = ["position", "scale", "rotation", "anchor", "opacity", "crop"];
pub const AUDIO_PROPS: [&str; 2] = ["volume", "pan"];
pub const MARKER_KINDS: [&str; 3] = ["comment", "chapter", "beat"];
pub const ROLES: [&str; 4] = ["dialogue", "music", "effects", "ambience"];
pub const ALIGNS: [&str; 3] = ["center", "start", "end"];

/// A new project's settings.
pub fn default_settings() -> Extra {
    let Json::Object(m) = json!({
        "fit": "fit",
        "stillDuration": 5 * TICKS,
        "transitionDuration": TICKS,
        "freezeDuration": 2 * TICKS,
    }) else {
        unreachable!()
    };
    m
}

/// A new caption track's style; `size` is pixels of a picture whose shorter side is `ref` lines.
pub fn default_caption_style() -> Extra {
    let Json::Object(m) = json!({
        "font": "Malgun Gothic", "size": 54, "weight": 600, "color": "#ffffff", "background": "#00000099",
        "position": "bottom", "margin": 8, "ref": 1080, "highlight": false, "highlightColor": "#ffd23f",
        "highlightMode": "color",
    }) else {
        unreachable!()
    };
    m
}

/// A text layer with every field, `opts` over the defaults.
pub fn text_layer(opts: &Extra) -> Json {
    let Json::Object(mut m) = json!({
        "id": "l1", "text": "Text", "font": "Malgun Gothic", "size": 96, "weight": 700, "italic": false,
        "tracking": 0, "leading": 1.2, "align": "center", "fill": "#ffffff", "stroke": null, "shadow": null,
        "box": null, "position": [0, 0],
    }) else {
        unreachable!()
    };
    for (k, v) in opts {
        m.insert(k.clone(), v.clone());
    }
    Json::Object(m)
}

/// A track with every field of its kind.
pub fn track(kind: TrackKind, id: Id, name: Option<&str>) -> Track {
    let video = kind == TrackKind::Video;
    Track {
        id,
        kind,
        name: name.map_or_else(|| id.as_str().to_owned(), str::to_owned),
        locked: false,
        sync_lock: true,
        height: if video { 56.0 } else { 48.0 },
        visible: video.then_some(true),
        mute: (!video).then_some(false),
        solo: (!video).then_some(false),
        volume: (!video).then_some(0.0),
        pan: (!video).then_some(0.0),
        extra: Extra::new(),
        clips: Vec::new(),
    }
}

/// What `createSequence` takes.
#[derive(Debug, Clone)]
pub struct SequenceOpts {
    pub name: String,
    pub w: i64,
    pub h: i64,
    pub fps: Fps,
    pub background: String,
    pub master_gain: f64,
    pub video_tracks: usize,
    pub audio_tracks: usize,
}

impl Default for SequenceOpts {
    fn default() -> Self {
        Self {
            name: "Sequence 1".into(),
            w: 1920,
            h: 1080,
            fps: Fps::new(30, 1),
            background: "#000000".into(),
            master_gain: 0.0,
            video_tracks: 2,
            audio_tracks: 2,
        }
    }
}

/// A sequence with tracks V1.. and A1.. and nothing on them.
pub fn sequence(id: Id, o: &SequenceOpts) -> Sequence {
    let mut tracks = Vec::new();
    for i in 1..=o.video_tracks {
        tracks.push(track(TrackKind::Video, Id::new(&format!("V{i}")), None));
    }
    for i in 1..=o.audio_tracks {
        tracks.push(track(TrackKind::Audio, Id::new(&format!("A{i}")), None));
    }
    let mut s = Sequence::new(id, o.name.clone(), o.w, o.h, o.fps, o.background.clone(), tracks);
    s.master_gain = o.master_gain;
    s
}

/// A project with one empty sequence (`s1`), as `createProject()` makes it.
pub fn project() -> Project {
    let mut p = Project {
        format: "ncut".into(),
        version: VERSION,
        settings: default_settings(),
        media: Vec::new(),
        bins: Vec::new(),
        sequences: Vec::new(),
        next_id: 1,
        speakers: None,
        luts: None,
        extra: Extra::new(),
    };
    let id = p.new_id("s");
    p.sequences.push(sequence(id, &SequenceOpts::default()));
    p
}

impl Project {
    /// `prefix` + nextId, and nextId moves on.
    pub fn new_id(&mut self, prefix: &str) -> Id {
        let id = Id::numbered(prefix, self.next_id);
        self.next_id += 1;
        id
    }
}

/// A clip with every field, for a track of `kind`.
#[allow(clippy::too_many_arguments)]
pub fn clip(kind: TrackKind, id: Id, track: Id, start: i64, in_: f64, out: f64, source: Source, name: String) -> Clip {
    Clip {
        id,
        track,
        start,
        in_,
        out,
        source,
        speed: 1.0,
        reverse: false,
        enabled: true,
        link: None,
        group: None,
        name,
        label: None,
        role: None,
        props: Props::of(kind),
        keyframes: Default::default(),
        effects: Vec::new(),
        fade_in: 0,
        fade_out: 0,
        remap: None,
        sampling: Sampling::Sample,
        markers: None,
        masks: None,
        extra: Extra::new(),
    }
}
