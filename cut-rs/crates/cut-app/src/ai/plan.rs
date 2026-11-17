//! Edit commands in plain words (`ai.js`'s edit commands): Claude answers with a plan of operations from a fixed
//! whitelist ([`OPS`]); the plan is checked strictly ([`validate_plan`]), described for the preview
//! ([`describe_plan`]) and turned into the editor's commands for one batch ([`plan_commands`]). Nothing outside the
//! whitelist is ever run.

use cut_formats::table::js_round;
use cut_model::commands::build as C;
use cut_model::{Clip, MarkerKind, Project, Role, Sequence, TrackKind};
use serde_json::{Map, Value as Json, json};

use super::js::{T, clock, clock_fine, cut, fin, num, one_line, quote, sec1, to_fixed};
use crate::auto::silence::Plan as Silence;

/// The kinds of a field of an operation; [`OPS`] gives each operation's fields with these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Time,
    Db,
    Name,
    MarkerKind,
    RemoveKind,
    Clips,
    AudioTrack,
    SilenceLength,
    Threshold,
}

use Field as F;

/// An operation's fields: name, kind, optional.
type Fields = &'static [(&'static str, Field, bool)];

/// The whitelist: op -> its fields (`true`: optional). Nothing else is ever run.
const OPS: &[(&str, Fields)] = &[
    ("cut", &[("from", F::Time, false), ("to", F::Time, false)]),
    ("lift", &[("from", F::Time, false), ("to", F::Time, false)]),
    ("split", &[("at", F::Time, false)]),
    ("marker", &[("at", F::Time, false), ("name", F::Name, true), ("kind", F::MarkerKind, true)]),
    ("removeMarkers", &[("kind", F::RemoveKind, false)]),
    ("clipVolume", &[("clips", F::Clips, false), ("db", F::Db, false)]),
    ("trackVolume", &[("track", F::AudioTrack, false), ("db", F::Db, false)]),
    ("masterGain", &[("db", F::Db, false)]),
    ("removeSilence", &[("longerThan", F::SilenceLength, false), ("threshold", F::Threshold, true)]),
];
const CLIP_SETS: [&str; 6] = ["all", "selected", "dialogue", "music", "effects", "ambience"];
const MAX_OPS: usize = 200;
const DOCS: [&str; 9] = [
    "{\"op\": \"cut\", \"from\": s, \"to\": s}  ripple delete a time range from every track (later material moves up)",
    "{\"op\": \"lift\", \"from\": s, \"to\": s}  clear a time range on every track and leave a gap",
    "{\"op\": \"split\", \"at\": s}  add an edit (cut point) on every track",
    "{\"op\": \"marker\", \"at\": s, \"name\": \"...\", \"kind\": \"comment\" | \"chapter\"}  add a sequence marker",
    "{\"op\": \"removeMarkers\", \"kind\": \"comment\" | \"chapter\" | \"beat\" | \"all\"}  remove the sequence markers of that kind",
    "{\"op\": \"clipVolume\", \"clips\": \"all\" | \"selected\" | \"dialogue\" | \"music\" | \"effects\" | \"ambience\" | [\"clip id\", ...], \"db\": n}  change audio clips' volume by n dB (negative is quieter); the words are clip roles",
    "{\"op\": \"trackVolume\", \"track\": \"A1\", \"db\": n}  change an audio track's volume by n dB",
    "{\"op\": \"masterGain\", \"db\": n}  change the sequence's master gain by n dB",
    "{\"op\": \"removeSilence\", \"longerThan\": s, \"threshold\": dB}  ripple delete stretches quieter than threshold (default -40 dB) lasting longer than longerThan seconds",
];

/// Which audio clips a `clipVolume` changes.
#[derive(Debug, Clone, PartialEq)]
pub enum Clips {
    All,
    Selected,
    Role(Role),
    List(Vec<String>),
}

/// The kind of marker a `removeMarkers` removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remove {
    Kind(MarkerKind),
    All,
}

/// A checked operation (times in seconds of the timeline before the plan).
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Cut { from: f64, to: f64 },
    Lift { from: f64, to: f64 },
    Split { at: f64 },
    Marker { at: f64, name: Option<String>, chapter: Option<bool> },
    RemoveMarkers(Remove),
    ClipVolume { clips: Clips, db: f64 },
    TrackVolume { track: String, db: f64 },
    MasterGain { db: f64 },
    RemoveSilence { longer_than: f64, threshold: Option<f64> },
}

/// A checked plan and Claude's note.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub ops: Vec<Op>,
    pub message: String,
}

/// What a plan is checked against: the sequence now (`planContext`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Context {
    pub duration: f64,
    pub tracks: Vec<(String, TrackKind)>,
    pub clips: Vec<String>,
    pub selection: Vec<String>,
}

impl Context {
    /// `planContext`: the sequence's length, tracks and clips, and the selected clips of it.
    pub fn of(seq: &Sequence, selection: &std::collections::HashSet<cut_model::Id>) -> Context {
        Context {
            duration: seq.duration() as f64,
            tracks: seq.tracks.iter().map(|t| (t.id.as_str().to_owned(), t.kind)).collect(),
            clips: seq.clips_in_order().map(|c| c.id.as_str().to_owned()).collect(),
            selection: seq
                .clips_in_order()
                .filter(|c| selection.contains(&c.id))
                .map(|c| c.id.as_str().to_owned())
                .collect(),
        }
    }
}

/// A track kind's word.
pub fn kind_word(k: TrackKind) -> &'static str {
    match k {
        TrackKind::Video => "video",
        TrackKind::Audio => "audio",
    }
}

/// A marker kind's word.
pub fn marker_word(k: MarkerKind) -> &'static str {
    match k {
        MarkerKind::Comment => "comment",
        MarkerKind::Chapter => "chapter",
        MarkerKind::Beat => "beat",
    }
}

fn role_word(r: Role) -> &'static str {
    match r {
        Role::Dialogue => "dialogue",
        Role::Music => "music",
        Role::Effects => "effects",
        Role::Ambience => "ambience",
    }
}

fn role_of(w: &str) -> Option<Role> {
    [Role::Dialogue, Role::Music, Role::Effects, Role::Ambience].into_iter().find(|r| role_word(*r) == w)
}

/// A JSON value as a JavaScript template string prints it (`${x}`).
pub fn js_string(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(_) => num(v.as_f64().unwrap_or(f64::NAN)),
        Json::Bool(b) => b.to_string(),
        Json::Null => "null".into(),
        Json::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(",")
        }
        Json::Object(_) => "[object Object]".into(),
    }
}

/// `sequenceSummary`: the sequence for the prompt: tracks, clips (at most `max_clips`), markers, the selection.
pub fn sequence_summary(project: &Project, seq: &Sequence, selection: &[String], max_clips: usize) -> String {
    let d = seq.duration() as f64;
    let fps = seq.fps.value();
    let mut lines = vec![format!(
        "Sequence: {}, {} long ({} s), {} fps, master gain {} dB",
        quote(&one_line(&seq.name)),
        clock(d / T),
        sec1(d),
        num(js_round(fps * 100.0) / 100.0),
        num(seq.master_gain)
    )];
    let tracks: Vec<String> = seq
        .tracks
        .iter()
        .map(|t| {
            let mut s = format!("{} {}", t.id.as_str(), kind_word(t.kind));
            if !t.name.is_empty() && t.name != t.id.as_str() {
                s.push_str(&format!(" {}", quote(&one_line(&t.name))));
            }
            if t.kind == TrackKind::Audio {
                s.push_str(&format!(" volume {} dB", num(t.volume.unwrap_or(0.0))));
            }
            if t.locked {
                s.push_str(" locked");
            }
            s
        })
        .collect();
    lines.push(format!("Tracks: {}", tracks.join("; ")));
    let mut clips: Vec<&Clip> = seq.clips_in_order().collect();
    clips.sort_by_key(|c| c.start);
    let more =
        if clips.len() > max_clips { format!("; the first {max_clips} of {}", clips.len()) } else { String::new() };
    lines.push(format!("Clips (id track start-end seconds name role{more}):"));
    for c in clips.iter().take(max_clips) {
        let name = if !c.name.is_empty() {
            c.name.clone()
        } else if let Some(m) = c.media_id().and_then(|m| project.media(m)).filter(|m| !m.name.is_empty()) {
            m.name.clone()
        } else if let cut_model::Source::Generator { generator, .. } = &c.source {
            generator.name().to_owned()
        } else {
            String::new()
        };
        let mut s = format!(
            "{} {} {}-{} {}",
            c.id.as_str(),
            c.track.as_str(),
            sec1(c.start as f64),
            sec1(c.end() as f64),
            quote(&cut(&one_line(&name), 60))
        );
        if let Some(r) = c.role {
            s.push_str(&format!(" {}", role_word(r)));
        }
        if seq.kind_of(c.track) == Some(TrackKind::Audio) {
            s.push_str(&format!(" {} dB", num(volume(c))));
        }
        lines.push(s);
    }
    let sel: Vec<&str> =
        clips.iter().filter(|c| selection.iter().any(|s| s == c.id.as_str())).map(|c| c.id.as_str()).collect();
    lines.push(format!("Selected clips: {}", if sel.is_empty() { "none".to_owned() } else { sel.join(", ") }));
    lines.push(if seq.markers.is_empty() {
        "Markers: none".into()
    } else {
        let list: Vec<String> = seq
            .markers
            .iter()
            .take(200)
            .map(|m| format!("{} {} {}", sec1(m.t as f64), marker_word(m.kind), quote(&cut(&one_line(&m.name), 60))))
            .collect();
        format!("Markers (seconds kind name):\n{}", list.join("\n"))
    });
    lines.join("\n")
}

fn volume(c: &Clip) -> f64 {
    match &c.props {
        cut_model::Props::Audio(p) => p.volume,
        cut_model::Props::Video(_) => 0.0,
    }
}

/// `commandPrompt`.
pub fn command_prompt(request: &str, summary: &str, transcript: &str) -> String {
    let mut lines = vec![
        "Task: edit command".to_owned(),
        format!("Request: {}", one_line(request)),
        summary.to_owned(),
        "Transcript ([start-end] seconds, text):".into(),
        if transcript.is_empty() { "(no transcript)".into() } else { transcript.to_owned() },
        String::new(),
        "Turn the request into a plan of operations. Only these operations exist:".into(),
    ];
    lines.extend(DOCS.iter().map(|d| (*d).to_owned()));
    lines.extend([
        "All times are seconds on the timeline as it is now, before any operation of the plan runs; the editor keeps them right.".to_owned(),
        "Use only these operations and fields. When the request needs anything else, or is unclear, answer with no operations and".into(),
        "say why in \"message\", in the language of the request.".into(),
        "Answer: {\"ops\": [ ... ], \"message\": \"optional short note\"}".into(),
    ]);
    lines.join("\n")
}

/// One field of an operation checked: its value as the plan keeps it, or the reason.
fn check(n: &str, f: &str, kind: Field, x: &Json, end: f64, ctx: &Context) -> Result<Json, String> {
    let s = x.as_str();
    Ok(match kind {
        F::Time => {
            let Some(v) = fin(x) else { return Err(format!("{n}: \"{f}\" must be a number of seconds.")) };
            if v < -0.05 || v > end + 0.5 {
                return Err(format!("{n}: {f} {} s is outside the sequence (0-{} s).", num(v), to_fixed(end, 1)));
            }
            json!(v.max(0.0).min(end))
        }
        F::Db => match fin(x).filter(|v| v.abs() <= 40.0) {
            Some(v) => json!(v),
            None => return Err(format!("{n}: \"db\" must be a number from -40 to 40.")),
        },
        F::Name => match s {
            Some(v) => json!(cut(&one_line(v), 100)),
            None => return Err(format!("{n}: \"name\" must be a string.")),
        },
        F::MarkerKind => match s {
            Some(v @ ("comment" | "chapter")) => json!(v),
            _ => return Err(format!("{n}: a marker kind is \"comment\" or \"chapter\".")),
        },
        F::RemoveKind => match s {
            Some(v @ ("comment" | "chapter" | "beat" | "all")) => json!(v),
            _ => return Err(format!("{n}: \"kind\" is \"comment\", \"chapter\", \"beat\" or \"all\".")),
        },
        F::Clips => match x {
            Json::String(w) => {
                if !CLIP_SETS.contains(&w.as_str()) {
                    return Err(format!("{n}: \"clips\" is one of {} or a list of clip ids.", CLIP_SETS.join(", ")));
                }
                if w == "selected" && ctx.selection.is_empty() {
                    return Err(format!("{n}: no clips are selected."));
                }
                x.clone()
            }
            Json::Array(a) => {
                let known = |id: &Json| id.as_str().is_some_and(|id| ctx.clips.iter().any(|c| c == id));
                if a.is_empty() || a.len() > 500 || !a.iter().all(known) {
                    return Err(format!("{n}: \"clips\" lists clip ids that do not exist."));
                }
                let mut seen: Vec<Json> = Vec::new();
                for id in a {
                    if !seen.contains(id) {
                        seen.push(id.clone());
                    }
                }
                Json::Array(seen)
            }
            _ => return Err(format!("{n}: \"clips\" must be a word or a list of clip ids.")),
        },
        F::AudioTrack => match s.filter(|t| ctx.tracks.iter().any(|(id, k)| id == t && *k == TrackKind::Audio)) {
            Some(t) => json!(t),
            None => return Err(format!("{n}: \"{}\" is not an audio track of the sequence.", js_string(x))),
        },
        F::SilenceLength => match fin(x).filter(|v| (0.1..=60.0).contains(v)) {
            Some(v) => json!(v),
            None => return Err(format!("{n}: \"longerThan\" must be 0.1 to 60 seconds.")),
        },
        F::Threshold => match fin(x).filter(|v| (-90.0..=-5.0).contains(v)) {
            Some(v) => json!(v),
            None => return Err(format!("{n}: \"threshold\" must be -90 to -5 dB.")),
        },
    })
}

fn op_of(name: &str, v: &Map<String, Json>) -> Op {
    let n = |k: &str| v.get(k).and_then(Json::as_f64).unwrap_or(0.0);
    let s = |k: &str| v.get(k).and_then(Json::as_str).map(str::to_owned);
    match name {
        "cut" => Op::Cut { from: n("from"), to: n("to") },
        "lift" => Op::Lift { from: n("from"), to: n("to") },
        "split" => Op::Split { at: n("at") },
        "marker" => Op::Marker { at: n("at"), name: s("name"), chapter: s("kind").map(|k| k == "chapter") },
        "removeMarkers" => Op::RemoveMarkers(match s("kind").as_deref() {
            Some("comment") => Remove::Kind(MarkerKind::Comment),
            Some("chapter") => Remove::Kind(MarkerKind::Chapter),
            Some("beat") => Remove::Kind(MarkerKind::Beat),
            _ => Remove::All,
        }),
        "clipVolume" => Op::ClipVolume {
            clips: match v.get("clips") {
                Some(Json::Array(a)) => Clips::List(a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
                Some(Json::String(w)) if w == "all" => Clips::All,
                Some(Json::String(w)) if w == "selected" => Clips::Selected,
                Some(Json::String(w)) => role_of(w).map_or(Clips::All, Clips::Role),
                _ => Clips::All,
            },
            db: n("db"),
        },
        "trackVolume" => Op::TrackVolume { track: s("track").unwrap_or_default(), db: n("db") },
        "masterGain" => Op::MasterGain { db: n("db") },
        _ => Op::RemoveSilence { longer_than: n("longerThan"), threshold: v.get("threshold").and_then(Json::as_f64) },
    }
}

impl Op {
    /// The operation as the JavaScript's checked plan holds it (`{op, ...fields}`).
    pub fn to_json(&self) -> Json {
        match self {
            Op::Cut { from, to } => json!({ "op": "cut", "from": from, "to": to }),
            Op::Lift { from, to } => json!({ "op": "lift", "from": from, "to": to }),
            Op::Split { at } => json!({ "op": "split", "at": at }),
            Op::Marker { at, name, chapter } => {
                let mut o = json!({ "op": "marker", "at": at });
                if let Some(n) = name {
                    o["name"] = json!(n);
                }
                if let Some(c) = chapter {
                    o["kind"] = json!(if *c { "chapter" } else { "comment" });
                }
                o
            }
            Op::RemoveMarkers(r) => json!({ "op": "removeMarkers", "kind": match r {
                Remove::Kind(k) => marker_word(*k),
                Remove::All => "all",
            } }),
            Op::ClipVolume { clips, db } => json!({ "op": "clipVolume", "clips": match clips {
                Clips::All => json!("all"),
                Clips::Selected => json!("selected"),
                Clips::Role(r) => json!(role_word(*r)),
                Clips::List(l) => json!(l),
            }, "db": db }),
            Op::TrackVolume { track, db } => json!({ "op": "trackVolume", "track": track, "db": db }),
            Op::MasterGain { db } => json!({ "op": "masterGain", "db": db }),
            Op::RemoveSilence { longer_than, threshold } => {
                let mut o = json!({ "op": "removeSilence", "longerThan": longer_than });
                if let Some(t) = threshold {
                    o["threshold"] = json!(t);
                }
                o
            }
        }
    }
}

impl Plan {
    /// The plan as the JavaScript's checked plan (`{ops, message}`), to be checked again on Apply.
    pub fn to_json(&self) -> Json {
        json!({ "ops": self.ops.iter().map(Op::to_json).collect::<Vec<_>>(), "message": self.message })
    }
}

/// `validatePlan`. -> the plan, or the reason (English).
pub fn validate_plan(value: &Json, ctx: &Context) -> Result<Plan, String> {
    let Some((obj, list)) = value.as_object().and_then(|o| Some((o, o.get("ops")?.as_array()?))) else {
        return Err("The answer must be an object with an \"ops\" list.".into());
    };
    if obj.get("message").is_some_and(|m| !m.is_string()) {
        return Err("\"message\" must be a string.".into());
    }
    if let Some(k) = obj.keys().find(|k| *k != "ops" && *k != "message") {
        return Err(format!("Unknown field \"{k}\"."));
    }
    if list.len() > MAX_OPS {
        return Err(format!("A plan has at most {MAX_OPS} operations."));
    }
    let end = ctx.duration / T;
    let mut ops = Vec::new();
    for (k, o) in list.iter().enumerate() {
        let n = format!("Operation {}", k + 1);
        let (Some(o), Some(name)) = (o.as_object(), o.get("op").and_then(Json::as_str)) else {
            return Err(format!("{n} must be an object with an \"op\"."));
        };
        let Some((_, spec)) = OPS.iter().find(|(op, _)| *op == name) else {
            return Err(format!("{n}: \"{name}\" is not an allowed operation."));
        };
        if let Some(f) = o.keys().find(|f| *f != "op" && !spec.iter().any(|(s, _, _)| s == f)) {
            return Err(format!("{n} ({name}) has an unknown field \"{f}\"."));
        }
        let mut v = Map::new();
        for &(f, kind, optional) in *spec {
            match o.get(f).filter(|x| !x.is_null()) {
                None if optional => continue,
                None => return Err(format!("{n} ({name}) needs \"{f}\".")),
                Some(x) => {
                    v.insert(f.to_owned(), check(&n, f, kind, x, end, ctx)?);
                }
            }
        }
        let op = op_of(name, &v);
        if let Op::Cut { from, to } | Op::Lift { from, to } = op
            && (to - from).partial_cmp(&0.01).is_none_or(|o| o == std::cmp::Ordering::Less)
        {
            return Err(format!("{n} ({name}): \"to\" must be after \"from\"."));
        }
        ops.push(op);
    }
    let message = obj.get("message").and_then(Json::as_str).map(|m| cut(&one_line(m), 500)).unwrap_or_default();
    Ok(Plan { ops, message })
}

/// `volumeClips`: the audio clips a `clipVolume` names (a video clip in a list or the selection brings its linked
/// audio); never on a locked track; by start.
pub fn volume_clips<'s>(seq: &'s Sequence, which: &Clips, selection: &[String]) -> Vec<&'s Clip> {
    let ok = |c: &Clip| seq.track(c.track).is_some_and(|t| t.kind == TrackKind::Audio && !t.locked);
    let mut picked: Vec<&Clip> = match which {
        Clips::All => seq.clips_in_order().filter(|c| ok(c)).collect(),
        Clips::Role(r) => seq.clips_in_order().filter(|c| ok(c) && c.role == Some(*r)).collect(),
        Clips::Selected | Clips::List(_) => {
            let ids = if let Clips::List(l) = which { l.as_slice() } else { selection };
            let mut set: Vec<&Clip> = Vec::new();
            let mut add = |c: &'s Clip| {
                if ok(c) && !set.iter().any(|x| x.id == c.id) {
                    set.push(c);
                }
            };
            for c in seq.clips_in_order().filter(|c| ids.iter().any(|i| i == c.id.as_str())) {
                add(c);
                if let Some(l) = c.link {
                    for x in seq.clips_in_order().filter(|x| x.id != c.id && x.link == Some(l)) {
                        add(x);
                    }
                }
            }
            set
        }
    };
    picked.sort_by_key(|c| c.start);
    picked
}

fn clamp_db(v: f64) -> f64 {
    (js_round(v * 10.0) / 10.0).clamp(-60.0, 24.0)
}

/// `planCommands`: the plan as edit commands for one batch. `silence[k]`: the silences measured for `ops[k]` (a
/// `removeSilence`). Gains first, then markers, edits and lifts, then every ripple delete from the latest back, so all
/// the plan's times stay those of the timeline before it.
pub fn plan_commands(ops: &[Op], seq: &Sequence, selection: &[String], silence: &[Option<Silence>]) -> Vec<Json> {
    let id = seq.id.as_str();
    let f = cut_model::query::frame(seq.fps) as f64;
    let tk = |s: f64| (js_round((s * T) / f) * f) as i64;
    let mut out = Vec::new();
    let mut master: Option<f64> = None;
    let mut track_vol: Vec<(String, f64)> = Vec::new();
    let mut clip_vol: Vec<(cut_model::Id, f64)> = Vec::new();
    for o in ops {
        match o {
            Op::MasterGain { db } => master = Some(master.unwrap_or(seq.master_gain) + db),
            Op::TrackVolume { track, db } => match track_vol.iter_mut().find(|(t, _)| t == track) {
                Some(e) => e.1 += db,
                None => {
                    let now = seq.tracks.iter().find(|t| t.id.as_str() == track).and_then(|t| t.volume).unwrap_or(0.0);
                    track_vol.push((track.clone(), now + db));
                }
            },
            Op::ClipVolume { clips, db } => {
                for c in volume_clips(seq, clips, selection) {
                    match clip_vol.iter_mut().find(|(i, _)| *i == c.id) {
                        Some(e) => e.1 += db,
                        None => clip_vol.push((c.id, *db)),
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(m) = master {
        out.push(C::set_sequence(id, json!({ "masterGain": clamp_db(m) })));
    }
    for (t, v) in &track_vol {
        out.push(C::set_track(id, t, json!({ "volume": clamp_db(*v) })));
    }
    for (cid, d) in &clip_vol {
        let Some(c) = seq.clip(*cid) else { continue };
        out.push(C::set_clip(
            id,
            cid.as_str(),
            json!({ "props": { "volume": clamp_db(volume(c) + d) } }),
            json!({ "linked": false }),
        ));
        if let Some(list) = c.keyframes.get("volume").filter(|l| !l.is_empty()) {
            let list: Vec<Json> = list
                .iter()
                .map(|kf| {
                    let mut x = serde_json::to_value(kf).unwrap_or(Json::Null);
                    let v = x.get("v").and_then(Json::as_f64).unwrap_or(f64::NAN);
                    x["v"] = json!(clamp_db(v + d));
                    x
                })
                .collect();
            out.push(C::set_keyframes(id, cid.as_str(), "volume", Some(Json::Array(list))));
        }
    }
    let mut gone = Vec::new();
    for o in ops {
        let Op::RemoveMarkers(r) = o else { continue };
        for m in &seq.markers {
            if (*r == Remove::All || *r == Remove::Kind(m.kind)) && !gone.contains(&m.id) {
                gone.push(m.id);
                out.push(C::remove_marker(id, m.id.as_str()));
            }
        }
    }
    for o in ops {
        if let Op::Marker { at, name, chapter } = o {
            let chapter = *chapter == Some(true);
            out.push(C::add_marker(
                id,
                json!({ "t": tk(*at), "name": name.clone().unwrap_or_default(),
                    "kind": if chapter { "chapter" } else { "comment" }, "color": if chapter { "blue" } else { "green" } }),
                json!({}),
            ));
        }
    }
    for o in ops {
        if let Op::Split { at } = o {
            out.push(C::split(id, tk(*at), json!({})));
        }
    }
    for o in ops {
        if let Op::Lift { from, to } = o
            && tk(*to) > tk(*from)
        {
            out.push(C::lift(id, tk(*from), tk(*to), None));
        }
    }
    let mut ripples: Vec<(f64, f64, Option<Vec<String>>)> = Vec::new();
    for (k, o) in ops.iter().enumerate() {
        match o {
            Op::Cut { from, to } => ripples.push((tk(*from) as f64, tk(*to) as f64, None)),
            Op::RemoveSilence { .. } => {
                if let Some(Some(s)) = silence.get(k) {
                    let tracks: Vec<String> = s.tracks.iter().map(|t| t.as_str().to_owned()).collect();
                    ripples.extend(s.ranges.iter().map(|&(a, b)| (a, b, Some(tracks.clone()))));
                }
            }
            _ => {}
        }
    }
    // whole-track cuts that overlap join; the rest go latest first
    ripples.sort_by(|x, y| y.0.total_cmp(&x.0).then(y.1.total_cmp(&x.1)));
    for (a, b, tracks) in ripples {
        if b > a {
            let list: Option<Vec<&str>> = tracks.as_ref().map(|t| t.iter().map(String::as_str).collect());
            out.push(C::extract(id, a as i64, b as i64, list.as_deref()));
        }
    }
    out
}

/// `describePlan`: the plan in plain sentences for the preview, each an English text for `tr` and its values.
pub fn describe_plan(
    ops: &[Op],
    seq: &Sequence,
    selection: &[String],
    silence: &[Option<Silence>],
) -> Vec<(&'static str, Vec<(&'static str, String)>)> {
    let db = |v: f64| format!("{}{}", if v > 0.0 { "+" } else { "" }, num(js_round(v * 10.0) / 10.0));
    let count = |r: Remove| seq.markers.iter().filter(|m| r == Remove::All || r == Remove::Kind(m.kind)).count();
    ops.iter()
        .enumerate()
        .map(|(k, o)| match o {
            Op::Cut { from, to } => (
                "Cut {from} – {to} ({len} s) from every track",
                vec![("from", clock_fine(*from)), ("to", clock_fine(*to)), ("len", to_fixed(to - from, 1))],
            ),
            Op::Lift { from, to } => (
                "Lift {from} – {to} from every track, leaving a gap",
                vec![("from", clock_fine(*from)), ("to", clock_fine(*to))],
            ),
            Op::Split { at } => ("Add an edit at {at} on every track", vec![("at", clock_fine(*at))]),
            Op::Marker { at, name, chapter } => (
                if *chapter == Some(true) {
                    "Add a chapter marker at {at}: {name}"
                } else {
                    "Add a marker at {at}: {name}"
                },
                vec![
                    ("at", clock_fine(*at)),
                    ("name", name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| "-".into())),
                ],
            ),
            Op::RemoveMarkers(r) => (
                match r {
                    Remove::Kind(MarkerKind::Comment) => "Remove the comment markers ({n})",
                    Remove::Kind(MarkerKind::Chapter) => "Remove the chapter markers ({n})",
                    Remove::Kind(MarkerKind::Beat) => "Remove the beat markers ({n})",
                    Remove::All => "Remove every sequence marker ({n})",
                },
                vec![("n", count(*r).to_string())],
            ),
            Op::ClipVolume { clips, db: d } => (
                match clips {
                    Clips::All => "Change the volume of every audio clip by {db} dB ({n} clips)",
                    Clips::Selected => "Change the volume of the selected clips by {db} dB ({n} clips)",
                    Clips::Role(Role::Dialogue) => "Change the volume of the dialogue clips by {db} dB ({n} clips)",
                    Clips::Role(Role::Music) => "Change the volume of the music clips by {db} dB ({n} clips)",
                    Clips::Role(Role::Effects) => "Change the volume of the sound effect clips by {db} dB ({n} clips)",
                    Clips::Role(Role::Ambience) => "Change the volume of the ambience clips by {db} dB ({n} clips)",
                    Clips::List(_) => "Change the volume of {n} clips by {db} dB",
                },
                vec![("db", db(*d)), ("n", volume_clips(seq, clips, selection).len().to_string())],
            ),
            Op::TrackVolume { track, db: d } => {
                ("Change the volume of track {track} by {db} dB", vec![("track", track.clone()), ("db", db(*d))])
            }
            Op::MasterGain { db: d } => ("Change the master gain by {db} dB", vec![("db", db(*d))]),
            Op::RemoveSilence { longer_than, threshold } => {
                let r: &[(f64, f64)] = silence.get(k).and_then(Option::as_ref).map_or(&[], |s| s.ranges.as_slice());
                let time: f64 = r.iter().map(|(a, b)| b - a).sum();
                (
                    "Remove silences longer than {s} s quieter than {threshold} dB ({n} cuts, {time} s)",
                    vec![
                        ("s", num(*longer_than)),
                        ("threshold", num(threshold.unwrap_or(-40.0))),
                        ("n", r.len().to_string()),
                        ("time", to_fixed(time / T, 1)),
                    ],
                )
            }
        })
        .collect()
}
