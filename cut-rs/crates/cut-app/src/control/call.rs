//! One tool call (control.js `call`): the schema check, the sequence it works on, the tool, and what the page is told
//! of an edit (`edit: {seqId, at, clips}`, the clips whose JSON changed). And what the tools build with (control.js
//! `lib`): times in seconds on the timeline, refusals the model can act on, commands run through the history so a
//! refused edit changes nothing.

use std::collections::HashMap;

use cut_model::{Clip, Id, Media, Project, Sequence, Track, TrackKind};
use cut_time::{Fps, TICKS, Ticks};
use serde_json::{Map, Value as Json, json};

use super::host::{Host, Live, Task};
use super::schema::{check, js_num};
use super::table::{self, Kind};

/// A refused call: one sentence for the model.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal(pub String);

pub type R<T> = Result<T, Refusal>;

pub fn refuse<T>(message: impl Into<String>) -> R<T> {
    Err(Refusal(message.into()))
}

/// What a tool gives: its answer now, or a task the page polls until it answers (a dialog, a job).
pub enum Out {
    Value(Json),
    Later(Task<R<Json>>),
}

impl From<Json> for Out {
    fn from(v: Json) -> Self {
        Out::Value(v)
    }
}

/// A tool's run.
pub type Run = fn(&mut Cx, &Json) -> R<Out>;

/// The answer of a call: the value (without `$image` and `edit`), a picture, where an edit landed; or the refusal.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Done { value: Json, image: Option<(String, String)>, edit: Option<Edit> },
    Refused(String),
}

/// Where an edit happened, for the page (not sent to the AI).
#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    pub seq: Option<Id>,
    pub at: Option<Ticks>,
    pub clips: Vec<Id>,
}

impl Answer {
    /// The answer as MCP's tools/call result: `{content, isError}`.
    pub fn content(&self) -> Json {
        match self {
            Answer::Done { value, image, .. } => {
                let mut c = vec![json!({ "type": "text", "text": value.to_string() })];
                if let Some((data, mime)) = image {
                    c.push(json!({ "type": "image", "data": data, "mimeType": mime }));
                }
                json!({ "content": c, "isError": false })
            }
            Answer::Refused(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
        }
    }

    /// The JavaScript's `{ok, value | error, edit}` (the oracle compares it).
    pub fn plain(&self) -> Json {
        match self {
            Answer::Done { value, edit, .. } => json!({
                "ok": true, "value": value,
                "edit": edit.as_ref().map(|e| json!({ "seqId": e.seq.map(Id::as_str), "at": e.at, "clips": e.clips.iter().map(|c| c.as_str()).collect::<Vec<_>>() })),
            }),
            Answer::Refused(e) => json!({ "ok": false, "error": e }),
        }
    }
}

/// A call that runs: either answered, or waiting on its task.
pub struct Pending {
    task: Task<R<Json>>,
    finish: Finish,
}

/// What `call` keeps to finish a call after its task: its sequence and, for an edit, the clips before.
struct Finish {
    seq: Option<Id>,
    before: Option<HashMap<Id, String>>,
}

pub enum Started {
    Done(Answer),
    Waiting(Pending),
}

impl Pending {
    /// Polls the task once (each frame): the answer when it has one.
    pub fn poll(&mut self, host: &mut dyn Host, live: &Live) -> Option<Answer> {
        let r = (self.task)(host, live)?;
        Some(self.finish.answer(host, r))
    }
}

/// `call(name, args, env)`: never panics on its arguments, never leaves half an edit.
pub fn call(name: &str, args: &Json, host: &mut dyn Host, live: &Live, undo_floor: Option<usize>) -> Started {
    let Some(def) = table::tool(name) else {
        return Started::Done(Answer::Refused(format!("There is no tool {name}.")));
    };
    let Some(run) = super::tools::run_of(name) else {
        return Started::Done(Answer::Refused(format!("There is no tool {name}.")));
    };
    let empty = Json::Object(Map::new());
    let a = if args.is_null() { &empty } else { args };
    let bad = if a.is_object() { check(&def.input, a, "arguments") } else { "The arguments must be an object.".into() };
    if !bad.is_empty() {
        return Started::Done(Answer::Refused(bad));
    }
    let mut c = Cx { host, seq: None, undo_floor, live };
    if def.input.property("sequence_id").is_some()
        && let Err(e) = c.context(a.get("sequence_id"))
    {
        return Started::Done(Answer::Refused(e.0));
    }
    let seq = c.seq.or(c.host.app().sequence_id);
    let before = (def.kind == Kind::Edit).then(|| snapshot(c.host.app().project(), seq));
    let finish = Finish { seq, before };
    let r = run(&mut c, a);
    let host = c.host;
    match r {
        Ok(Out::Value(v)) => Started::Done(finish.answer(host, Ok(v))),
        Err(e) => Started::Done(finish.answer(host, Err(e))),
        Ok(Out::Later(task)) => Started::Waiting(Pending { task, finish }),
    }
}

impl Finish {
    fn answer(&self, host: &mut dyn Host, r: R<Json>) -> Answer {
        let mut value = match r {
            Ok(v) => v,
            Err(e) => return Answer::Refused(e.0),
        };
        let mut image = None;
        let mut edit = None;
        if let Some(o) = value.as_object_mut() {
            if let Some(img) = o.remove("$image") {
                image = Some((
                    img["data"].as_str().unwrap_or_default().to_owned(),
                    img["mimeType"].as_str().unwrap_or("image/png").to_owned(),
                ));
            }
            if let Some(e) = o.remove("edit") {
                let app = host.app();
                let p = app.project();
                let named = e.get("seqId").and_then(Json::as_str).map(Id::new).filter(|id| p.sequence(*id).is_some());
                let s = named.or(self.seq.filter(|id| p.sequence(*id).is_some())).or(app.sequence_id);
                let at = e.get("at").and_then(Json::as_f64).filter(|x| x.is_finite()).map(|x| x as Ticks);
                let clips = match (&self.before, named) {
                    (Some(before), None) => changed_since(p, s, before),
                    _ => Vec::new(),
                };
                edit = Some(Edit { seq: s, at, clips });
            }
        }
        Answer::Done { value, image, edit }
    }
}

/// The clips of a sequence as JSON text by id (`snapshot`).
fn snapshot(p: &Project, seq: Option<Id>) -> HashMap<Id, String> {
    let Some(s) = seq.and_then(|id| p.sequence(id)) else { return HashMap::new() };
    s.clips_in_order().map(|c| (c.id, cj(c).to_string())).collect()
}

/// The clips whose JSON changed or that are new since `before` (`changedSince`).
fn changed_since(p: &Project, seq: Option<Id>, before: &HashMap<Id, String>) -> Vec<Id> {
    let Some(s) = seq.and_then(|id| p.sequence(id)) else { return Vec::new() };
    s.clips_in_order().filter(|c| before.get(&c.id) != Some(&cj(c).to_string())).map(|c| c.id).collect()
}

/// The selection, in the sequence's clip order (the native selection is a set; the JavaScript's keeps the order it
/// was made in).
pub fn selection(app: &crate::state::App) -> Vec<&'static str> {
    let mut ids: Vec<&'static str> = app.selected().into_iter().map(|i| i.as_str()).collect();
    let rest: Vec<&'static str> = app.selection.iter().map(|i| i.as_str()).filter(|i| !ids.contains(i)).collect();
    ids.extend(rest);
    ids
}

/// A clip as the project file has it.
pub fn cj(c: &Clip) -> Json {
    serde_json::to_value(c).unwrap_or(Json::Null)
}

/// A number for an answer: whole numbers without a fraction, as JavaScript writes them.
pub fn num(x: f64) -> Json {
    if x.fract() == 0.0 && x.abs() < 9e15 { json!(x as i64) } else { json!(x) }
}

/// `r3`: rounded to a thousandth (Math.round's halves up).
pub fn r3(x: f64) -> f64 {
    (x * 1000.0 + 0.5).floor() / 1000.0
}

/// `Math.round`.
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The arguments as the tools read them: `a.k` when given and not null.
pub fn arg<'a>(a: &'a Json, k: &str) -> Option<&'a Json> {
    a.get(k).filter(|v| !v.is_null())
}

pub fn f(a: &Json, k: &str) -> Option<f64> {
    arg(a, k).and_then(Json::as_f64)
}

pub fn s<'a>(a: &'a Json, k: &str) -> Option<&'a str> {
    arg(a, k).and_then(Json::as_str)
}

pub fn b(a: &Json, k: &str) -> Option<bool> {
    arg(a, k).and_then(Json::as_bool)
}

/// `a.k !== undefined`: given, null included.
pub fn given(a: &Json, k: &str) -> bool {
    a.get(k).is_some()
}

pub fn strs(a: &Json, k: &str) -> Option<Vec<String>> {
    arg(a, k).and_then(Json::as_array).map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
}

/// The call's context (control.js `context` and the env around it).
pub struct Cx<'a> {
    pub host: &'a mut dyn Host,
    /// The sequence the call works on, once [`Cx::context`] found it.
    pub seq: Option<Id>,
    pub undo_floor: Option<usize>,
    pub live: &'a Live,
}

impl Cx<'_> {
    /// Finds the sequence: `sequence_id`, else the active one (`context`).
    pub fn context(&mut self, sequence_id: Option<&Json>) -> R<()> {
        let app = self.host.app();
        let mut id = app.sequence_id.filter(|id| app.project().sequence(*id).is_some());
        if let Some(want) = sequence_id.filter(|v| !v.is_null()) {
            let w = want.as_str().unwrap_or_default();
            id = app.project().sequences.iter().find(|s| s.id.as_str() == w).map(|s| s.id);
            if id.is_none() {
                return refuse(format!("There is no sequence {w}. get_project lists the sequences."));
            }
        }
        if id.is_none() {
            return refuse("There is no active sequence.");
        }
        self.seq = id;
        Ok(())
    }

    pub fn project(&self) -> &Project {
        self.host.app().project()
    }

    /// The call's sequence (after [`Cx::context`]).
    pub fn seq(&self) -> &Sequence {
        let p = self.project();
        self.seq.and_then(|id| p.sequence(id)).or_else(|| p.sequences.first()).expect("a project has a sequence")
    }

    pub fn seq_id(&self) -> Id {
        self.seq().id
    }

    pub fn fps(&self) -> Fps {
        self.seq().fps
    }

    /// One frame of the sequence (`c.f`).
    pub fn f(&self) -> Ticks {
        cut_model::query::frame(self.fps())
    }

    pub fn duration(&self) -> Ticks {
        self.seq().duration()
    }

    pub fn sec(&self, t: f64) -> Json {
        num(r3(t / TICKS as f64))
    }

    pub fn frame(&self, t: f64) -> Json {
        num(round(t / self.f() as f64))
    }

    pub fn ticks(&self, s: f64) -> Ticks {
        round(s * TICKS as f64) as Ticks
    }

    /// A time on the timeline (`timeIn`): inside the sequence, its end included and a little past it forgiven.
    pub fn time_in(&self, s: f64, what: &str, past_end: bool) -> R<Ticks> {
        let end = self.duration() as f64 / TICKS as f64;
        if s < 0.0 || (!past_end && s > end + 0.05) {
            return refuse(format!("{what} {} s is outside the sequence (0 to {} s).", js_num(s), js_num(r3(end))));
        }
        let t = self.ticks(s);
        Ok(if past_end { t } else { t.min(self.duration()) })
    }

    pub fn clip(&self, id: &str) -> R<&Clip> {
        let s = self.seq();
        match s.clips_in_order().find(|c| c.id.as_str() == id) {
            Some(c) => Ok(c),
            None => refuse(format!("There is no clip {id} in sequence \"{}\". get_sequence lists the clips.", s.name)),
        }
    }

    /// `clipOf(c, id)`: the clip, refused when its track is locked (`unlocked`).
    pub fn clip_of(&self, id: &str, unlocked: bool) -> R<Clip> {
        let c = self.clip(id)?.clone();
        if unlocked {
            self.track_of(c.track.as_str(), None, true)?;
        }
        Ok(c)
    }

    /// `trackOf(c, id, {kind, unlocked})`.
    pub fn track_of(&self, id: &str, kind: Option<TrackKind>, unlocked: bool) -> R<Track> {
        let s = self.seq();
        let Some(t) = s.tracks.iter().find(|t| t.id.as_str() == id) else {
            let ids: Vec<&str> = s.tracks.iter().map(|t| t.id.as_str()).collect();
            return refuse(format!("There is no track {id}. The tracks are {}.", ids.join(", ")));
        };
        if let Some(k) = kind
            && t.kind != k
        {
            return refuse(format!("Track {id} is {} track; this needs {} track.", an(t.kind), an(k)));
        }
        if unlocked && t.locked {
            return refuse(format!(
                "Track {id} is locked. Locked tracks are the user's; edit other tracks, or ask the user to unlock it."
            ));
        }
        Ok(t.info())
    }

    pub fn kind_of(&self, clip: &Clip) -> Option<TrackKind> {
        self.seq().kind_of(clip.track)
    }

    /// `mediaOf`: media by id, never by a path.
    pub fn media_of(&self, id: &str) -> R<Media> {
        if looks_like_path(id) {
            return refuse(
                "Media are named by their ids (get_media), never by a file path. Importing files is the user's: ask them to import it first.",
            );
        }
        match self.project().media.iter().find(|m| m.id.as_str() == id) {
            Some(m) => Ok(m.clone()),
            None => refuse(format!("There is no media {id} in the project. get_media lists them.")),
        }
    }

    /// `needKind`: a property that belongs to clips of the other kind is refused, naming the linked clip of that kind.
    pub fn need_kind(&self, clip: &Clip, kind: TrackKind, what: &str) -> R<()> {
        let k = self.kind_of(clip);
        if k == Some(kind) {
            return Ok(());
        }
        let s = self.seq();
        let partner = s.linked_clips(clip).into_iter().find(|l| s.kind_of(l.track) == Some(kind));
        let kind_name = if kind == TrackKind::Audio { "audio" } else { "video" };
        let is = if k == Some(TrackKind::Audio) { "an audio" } else { "a video" };
        refuse(format!(
            "{what} belongs to {kind_name} clips; {} is {is} clip.{}",
            clip.id.as_str(),
            partner.map(|p| format!(" Its linked {kind_name} clip is {}.", p.id.as_str())).unwrap_or_default()
        ))
    }

    /// `run`: one command through the history; a command a person could not do either comes back as a refusal.
    pub fn run(&mut self, cmd: &Json) -> R<Json> {
        let app = self.host.app_mut();
        match app.history.apply(cmd) {
            Ok(r) => {
                app.prune_selection();
                Ok(r)
            }
            Err(e) => refuse(format!("The editor refused: {}", e.message)),
        }
    }

    /// `atomic`: several commands as one step, taken back whole when one fails.
    pub fn atomic<T>(&mut self, label: &str, f: impl FnOnce(&mut Self) -> R<T>) -> R<T> {
        self.host.app_mut().history.begin(label);
        match f(self) {
            Ok(v) => {
                self.host.app_mut().history.commit();
                Ok(v)
            }
            Err(e) => {
                let app = self.host.app_mut();
                app.history.cancel();
                app.prune_selection();
                Err(e)
            }
        }
    }
}

fn an(k: TrackKind) -> &'static str {
    if k == TrackKind::Audio { "an audio" } else { "a video" }
}

/// `/[\\/:]|\.[a-z0-9]{2,4}$/i`: what looks like a file path where an id goes.
fn looks_like_path(id: &str) -> bool {
    if id.contains(['\\', '/', ':']) {
        return true;
    }
    let Some((_, ext)) = id.rsplit_once('.') else { return false };
    (2..=4).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A plain file name, without folders (`plainName`). As in the JavaScript, whose class `[\/:*?"<>|]` has no
/// backslash, a backslash passes here (the writer turns it into `_`, `freePath`), and its refusal lost the
/// backslash to the template string's escape.
pub fn plain_name(v: Option<&str>) -> R<Option<String>> {
    let Some(v) = v else { return Ok(None) };
    let t = v.trim();
    if v.contains(['/', ':', '*', '?', '"', '<', '>', '|']) || t.is_empty() || t.chars().all(|c| c == '.') {
        return refuse("file_name is a plain name, without folders or any of  / : * ? \" < > |.");
    }
    Ok(Some(t.to_owned()))
}

/// The chat's step line of a call: the English text (for `tr`) and its parameters (`describe`).
pub fn describe(name: &str, args: &Json) -> (String, Vec<(String, String)>) {
    let Some(def) = table::tool(name) else { return (name.to_owned(), Vec::new()) };
    if args.is_object()
        && let Some(line) = super::tools::say(name, args)
    {
        return line;
    }
    (def.title.clone(), Vec::new())
}
