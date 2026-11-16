//! The Source monitor's clip and transport (port of `ui-monitors.js`'s `mountSource` and the `run` of its monitor):
//! the media file or sequence it shows with its In/Out in source ticks (`app.source`), its own playhead and clock, the
//! keys it answers (play, J/K/L, frame steps, In and Out), and what Insert, Overwrite and its drag handles place.
//!
//! The clock is the wall's until the window has a GPU device; then a [`Player`] of its own plays the clip's sound and
//! is the clock the picture follows, as the program monitor's does. A media file plays through a one-clip project at
//! the file's size and rate (`sourceHistory`), so its sound is mixed by the same code as a sequence's.

use std::sync::Arc;

use cut_model::commands::build;
use cut_model::{History, Id, Media, MediaKind, Project, Sequence};
use cut_time::{FRAME_RATES, Fps, TICKS, Ticks, frame_start};
use serde_json::{Value as Json, json};

use super::Patch;
use crate::transport::{Player, Transport, WallClock, shuttle};

/// What the Source monitor shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceItem {
    Media(Id),
    /// A sequence opened in the source monitor: Insert and Overwrite place a nest clip of it.
    Sequence(Id),
}

/// `app.source`: the item, its In/Out (source ticks, Out exclusive) and the source monitor's playhead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceClip {
    pub item: SourceItem,
    pub in_: Option<Ticks>,
    pub out: Option<Ticks>,
    pub t: Ticks,
}

impl SourceClip {
    pub fn media(id: Id) -> SourceClip {
        SourceClip { item: SourceItem::Media(id), in_: None, out: None, t: 0 }
    }
}

/// A drag from the source monitor (its picture, or a handle for the video or the sound alone): the JavaScript's
/// `{kind: 'source', mediaId | sequenceId, in, out, video, audio}` payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceDrag {
    pub item: SourceItem,
    pub in_: Ticks,
    pub out: Option<Ticks>,
    pub video: bool,
    pub audio: bool,
}

/// The source monitor: the clip, its clock, and the media opened lately (`recent`).
pub struct SourceMonitor {
    pub clip: Option<SourceClip>,
    transport: Box<dyn Transport>,
    with_sound: bool,
    /// The project revision and item the sound was given last.
    synced: Option<(u64, SourceItem)>,
    /// The media the project panel's selection opened last (a new selection opens the next one).
    pub picked: Option<Id>,
    pub recent: Vec<Id>,
    /// Playback starts over at its end (the bar's Loop).
    pub looping: bool,
    /// Play In to Out ends here.
    stop_at: Option<Ticks>,
    /// Export Frame's file being picked or written.
    pub saving: super::source_frame::Saving,
}

impl Default for SourceMonitor {
    fn default() -> Self {
        SourceMonitor {
            clip: None,
            transport: Box::<WallClock>::default(),
            with_sound: false,
            synced: None,
            picked: None,
            recent: Vec::new(),
            looping: false,
            stop_at: None,
            saving: Default::default(),
        }
    }
}

/// The rate a media file plays at in the source monitor (`rateOf`): its own when the model accepts it, else the
/// nearest offered one, 30 fps without one.
pub fn rate_of(media: &Media) -> Fps {
    let fps = media
        .video
        .as_ref()
        .and_then(|v| v.extra.get("fps")?.as_array().cloned())
        .and_then(|a| Some(Fps { num: a.first()?.as_u64()? as u32, den: a.get(1)?.as_u64()?.max(1) as u32 }));
    let Some(f) = fps.filter(|f| f.num > 0) else { return Fps { num: 30, den: 1 } };
    if cut_model::query::valid_fps(f) {
        return f;
    }
    let v = f.value();
    FRAME_RATES.iter().copied().min_by(|a, b| (a.value() - v).abs().total_cmp(&(b.value() - v).abs())).unwrap_or(f)
}

/// Whether the item has a picture and sound (`has()`).
pub fn kinds(project: &Project, item: SourceItem) -> (bool, bool) {
    match item {
        SourceItem::Media(id) => {
            project.media(id).map_or((false, false), |m| (m.kind != MediaKind::Audio, m.audio.is_some()))
        }
        SourceItem::Sequence(id) => {
            let k = project.nest_kinds(id);
            (k.video, k.audio)
        }
    }
}

/// The frame rate and the length of what the monitor shows (its own sequence's in the JavaScript): a file's length
/// on the frame grid, a still's the project's still duration, a sequence's its duration.
pub fn timing(project: &Project, item: SourceItem) -> Option<(Fps, Ticks)> {
    match item {
        SourceItem::Media(id) => {
            let m = project.media(id)?;
            let fps = rate_of(m);
            let len = if m.kind == MediaKind::Image {
                project.settings.get("stillDuration").and_then(Json::as_i64).unwrap_or(5 * TICKS)
            } else {
                let q = cut_model::query::QUANTUM as f64;
                ((m.duration / q).round() * q) as Ticks
            };
            Some((fps, len))
        }
        SourceItem::Sequence(id) => {
            let s = project.sequence(id)?;
            Some((s.fps, s.duration()))
        }
    }
}

/// A project holding just the media file, on a sequence of its size and rate (`sourceHistory`): what plays its sound.
pub fn media_project(project: &Project, media: &Media) -> Option<(Project, Id)> {
    let mut p = cut_model::defaults::project();
    p.settings = project.settings.clone();
    let even = |n: f64| ((n as i64).max(2) / 2) * 2;
    let seq = &mut p.sequences[0];
    if let Some(v) = &media.video {
        let rotated = matches!(v.extra.get("rotation").and_then(Json::as_f64), Some(r) if r == 90.0 || r == 270.0);
        let (w, h) = if rotated { (v.h, v.w) } else { (v.w, v.h) };
        seq.w = even(w);
        seq.h = even(h);
    }
    seq.fps = rate_of(media);
    seq.name.clone_from(&media.name);
    let (seq_id, video, audio) = {
        let first = |k| seq.tracks.iter().find(|t| t.kind == k).map(|t| t.id.as_str().to_owned());
        (seq.id, first(cut_model::TrackKind::Video), first(cut_model::TrackKind::Audio))
    };
    p.media.push(media.clone());
    let n: i64 = media.id.as_str().trim_start_matches(|c: char| !c.is_ascii_digit()).parse().unwrap_or(0);
    p.next_id = p.next_id.max(n + 1);
    let mut h = History::new(p, 4).ok()?;
    let opts = json!({
        "source": { "media": media.id.as_str() }, "at": 0, "mode": "overwrite",
        "video": if media.kind == MediaKind::Audio { None } else { video },
        "audio": if media.audio.is_some() { audio } else { None },
    });
    h.apply(&build::place(seq_id.as_str(), opts)).ok()?;
    Some((h.project().clone(), seq_id))
}

/// Why Insert or Overwrite cannot run (an English sentence, the key of its translation).
pub type Refusal = &'static str;

/// The command Insert (`insert`) or Overwrite (`overwrite`) runs (`place(mode)`): the source In to Out (all of it
/// without them) at the sequence In/Out as a three-point edit when either is set (`placeRange`), else at the playhead,
/// on the patched tracks.
pub fn place_command(
    project: &Project,
    seq: &Sequence,
    src: &SourceClip,
    patch: &[Patch; 2],
    in_out: (Option<Ticks>, Option<Ticks>),
    t: Ticks,
    mode: &str,
) -> Result<Json, Refusal> {
    let Some((_, total)) = timing(project, src.item) else { return Err("Open a clip in the source monitor first.") };
    let (has_v, has_a) = kinds(project, src.item);
    let (pv, pa) = super::patch_for(seq, patch);
    let video = if has_v { pv } else { None };
    let audio = if has_a { pa } else { None };
    if video.is_none() && audio.is_none() {
        return Err("Choose a target track.");
    }
    let source = match src.item {
        SourceItem::Media(id) => json!({ "media": id.as_str() }),
        SourceItem::Sequence(id) => json!({ "sequence": id.as_str() }),
    };
    let mut opts = json!({
        "source": source, "in": src.in_.unwrap_or(0), "out": src.out.unwrap_or(total),
        "video": video.map(Id::as_str), "audio": audio.map(Id::as_str), "mode": mode,
    });
    let s = seq.id.as_str();
    if in_out.0.is_some() || in_out.1.is_some() {
        opts["range"] = json!({ "in": in_out.0, "out": in_out.1 });
        Ok(build::place_range(s, opts))
    } else {
        opts["at"] = json!(t);
        Ok(build::place(s, opts))
    }
}

/// What a drag from the source monitor carries (`payload(video, audio)`).
pub fn drag_of(project: &Project, src: &SourceClip, video: bool, audio: bool) -> Option<SourceDrag> {
    let (_, total) = timing(project, src.item)?;
    let (has_v, has_a) = kinds(project, src.item);
    let still =
        matches!(src.item, SourceItem::Media(id) if project.media(id).is_some_and(|m| m.kind == MediaKind::Image));
    Some(SourceDrag {
        item: src.item,
        in_: src.in_.unwrap_or(0),
        out: src.out.or((!still).then_some(total)),
        video: video && has_v,
        audio: audio && has_a,
    })
}

impl SourceMonitor {
    /// Shows `clip` (`app.setSource`): a new item starts paused at its own time.
    pub fn open(&mut self, clip: SourceClip) {
        let changed = self.clip.map(|c| c.item) != Some(clip.item);
        if changed {
            self.pause();
            if let SourceItem::Media(id) = clip.item {
                self.recent.retain(|x| *x != id);
                self.recent.insert(0, id);
                self.recent.truncate(10);
            }
        }
        self.clip = Some(clip);
    }

    pub fn close(&mut self) {
        self.pause();
        self.clip = None;
        self.synced = None;
    }

    pub fn playing(&self) -> bool {
        self.transport.playing()
    }

    pub fn rate(&self) -> f64 {
        self.transport.rate()
    }

    /// From now on the sound plays and is the clock (the window has its devices).
    pub fn with_sound(&mut self) {
        if !self.with_sound {
            self.with_sound = true;
            self.pause();
            let (player, _) = Player::new(cut_audio::Library::default());
            self.transport = Box::new(player);
            self.synced = None;
        }
    }

    /// Gives the sound what it plays: the file's one-clip project, or the sequence of the editor's project.
    fn sync(&mut self, project: &Project, revision: u64) {
        let Some(c) = self.clip else { return };
        if !self.with_sound || self.synced == Some((revision, c.item)) {
            return;
        }
        self.synced = Some((revision, c.item));
        match c.item {
            SourceItem::Media(id) => {
                if let Some((p, seq)) = project.media(id).and_then(|m| media_project(project, m)) {
                    self.transport.set_project(Arc::new(p), seq);
                }
            }
            SourceItem::Sequence(id) => self.transport.set_project(Arc::new(project.clone()), id),
        }
    }

    fn seek(&mut self, t: Ticks, end: Ticks) {
        let v = t.clamp(0, end.max(0));
        if let Some(c) = &mut self.clip {
            c.t = v;
        }
        if self.transport.playing() {
            let rate = self.transport.rate();
            self.transport.play(v, rate);
        }
    }

    pub fn pause(&mut self) {
        self.transport.pause();
        self.stop_at = None;
    }

    /// Moves the playhead from the time bar (playback stops, as a press on the bar does).
    pub fn scrub(&mut self, project: &Project, t: Ticks) {
        let Some(c) = self.clip else { return };
        let Some((_, end)) = timing(project, c.item) else { return };
        self.pause();
        self.seek(t, end);
    }

    /// Follows the clock while playing; stops at either end (`onTime`). -> whether it is playing.
    pub fn tick(&mut self, project: &Project, revision: u64) -> bool {
        self.sync(project, revision);
        let Some(c) = self.clip else { return false };
        if !self.transport.playing() {
            return false;
        }
        let Some((fps, end)) = timing(project, c.item) else {
            self.pause();
            return false;
        };
        let f = frame_start(1, fps).max(1);
        let rate = self.transport.rate();
        let t = self.transport.now().unwrap_or(c.t);
        // the end of the run: the clip's, or the Out of Play In to Out; with Loop it starts over there
        let (from, limit) = match self.stop_at {
            Some(stop) => (c.in_.unwrap_or(0), stop.min(end)),
            None => (0, end),
        };
        let last = (limit - f).max(from);
        let over = if rate > 0.0 { t >= limit - f / 2 } else { t <= from };
        let (t, stop) = if over && self.looping && last > from {
            let t = if rate > 0.0 { from } else { last };
            self.transport.play(t, rate);
            (t, false)
        } else if over {
            (if rate > 0.0 { last } else { from }, true)
        } else {
            (t, false)
        };
        if let Some(c) = &mut self.clip {
            c.t = cut_time::snap(t.max(0), fps, false);
        }
        if stop {
            self.pause();
        }
        !stop
    }

    /// One of the monitor's actions (`run(id)`); `false` for an action it does not have.
    pub fn run(&mut self, project: &Project, id: &str) -> bool {
        let Some(c) = self.clip else { return false };
        let Some((fps, end)) = timing(project, c.item) else { return false };
        let f = frame_start(1, fps).max(1);
        let t = c.t;
        let last = (end - f).max(0);
        let set = |m: &mut Self, i: Option<Option<Ticks>>, o: Option<Option<Ticks>>| {
            if let Some(c) = &mut m.clip {
                if let Some(i) = i {
                    c.in_ = i;
                }
                if let Some(o) = o {
                    c.out = o;
                }
            }
        };
        match id {
            "playPause" => {
                if self.transport.playing() {
                    self.pause();
                } else if end > 0 {
                    let from = if t >= last { 0 } else { t };
                    self.seek(from, end);
                    self.transport.play(from, 1.0);
                }
            }
            "playInToOut" if end > 0 => {
                let from = c.in_.unwrap_or(0);
                self.seek(from, end);
                self.transport.play(from, 1.0);
                self.stop_at = Some(c.out.unwrap_or(end));
            }
            "shuttleStop" => self.pause(),
            "shuttleForward" | "shuttleBack" => {
                let fwd = id == "shuttleForward";
                if !fwd && t <= 0 {
                    self.pause();
                } else {
                    let rate = shuttle(self.transport.rate(), fwd);
                    self.transport.play(t, rate);
                }
            }
            "frameBack" | "frameForward" | "frameBack5" | "frameForward5" => {
                let n = if id.ends_with('5') { 5 } else { 1 };
                let d = if id.starts_with("frameBack") { -n * f } else { n * f };
                self.pause();
                self.seek(t + d, end);
            }
            "goStart" | "prevEdit" => {
                self.pause();
                self.seek(0, end);
            }
            "goEnd" | "nextEdit" => {
                self.pause();
                self.seek(if id == "nextEdit" && t >= end { t } else { end }, end);
            }
            "goIn" => {
                if let Some(i) = c.in_ {
                    self.pause();
                    self.seek(i, end);
                }
            }
            "goOut" => {
                if let Some(o) = c.out {
                    self.pause();
                    self.seek(o - f, end);
                }
            }
            "markIn" => set(self, Some(Some(t)), Some(c.out.filter(|o| *o > t))),
            "markOut" => set(self, Some(c.in_.filter(|i| *i <= t)), Some(Some((t + f).min(end)))),
            "markClip" => set(self, Some(Some(0)), Some(Some(end))),
            "clearIn" => set(self, Some(None), None),
            "clearOut" => set(self, None, Some(None)),
            "clearInOut" => set(self, Some(None), Some(None)),
            _ => return false,
        }
        true
    }
}

/// The actions the source monitor answers while it has the keyboard (`mountSource`'s list).
pub const ACTIONS: &[&str] = &[
    "playPause",
    "shuttleBack",
    "shuttleStop",
    "shuttleForward",
    "frameBack",
    "frameForward",
    "frameBack5",
    "frameForward5",
    "goStart",
    "goEnd",
    "goIn",
    "goOut",
    "markIn",
    "markOut",
    "markClip",
    "clearIn",
    "clearOut",
    "clearInOut",
    "prevEdit",
    "nextEdit",
    "playInToOut",
];
