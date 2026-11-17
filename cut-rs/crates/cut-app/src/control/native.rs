//! The Automation menu's native jobs run for the control API without their dialogs (ui-control.js `automation`
//! calling ui-speech.js, ui-speakers.js, ui-voice.js and ui-auto.js with `ask: false`): each started through its
//! module's own entry with the options the dialog would collect, watched each frame until it ends (its progress on
//! the call, Stop cancelling it), then answered as the JavaScript's functions answer: `{count}`, `{cuts, fillers,
//! pauses, seconds}`, `{speakers}`, `{clips, media}`, `{bpm, count}`, the Auto Color values. A setup dialog (a
//! model to download) is the user's question: when it closes without the job starting, the call is declined.
//! Also here: the silences of `remove_silence` and the transcript of `get_transcript`.

use std::collections::HashMap;

use cut_model::{Id, MarkerKind, Role};
use cut_time::TICKS;
use serde_json::{Value as Json, json};

use super::host::{Live, Task};
use crate::i18n::tr;
use crate::shell::Shell;
use crate::speech::text::FillerOpts;

/// Whether one of the analyses, a recognition, a labelling, a separation or a setup runs.
pub fn busy(s: &Shell) -> bool {
    let f = &s.features;
    f.auto.running()
        || f.speech.job.is_some()
        || f.speech.setup.is_some()
        || f.speakers.job.is_some()
        || f.speakers.setup.is_some()
        || f.voice.job.is_some()
        || f.voice.setup.is_some()
}

fn job_running(s: &Shell) -> bool {
    let f = &s.features;
    f.auto.running() || f.speech.job.is_some() || f.speakers.job.is_some() || f.voice.job.is_some()
}

fn setup_open(s: &Shell) -> bool {
    let f = &s.features;
    f.speech.setup.is_some() || f.speakers.setup.is_some() || f.voice.setup.is_some()
}

/// The running job's title and part done.
fn progress(s: &Shell) -> Option<(String, f32)> {
    let f = &s.features;
    let a = &f.auto;
    let of = |t: &str, x: f32| Some((t.to_owned(), x));
    if let Some((j, _)) = &f.speech.job {
        return of(&j.title, j.fraction());
    }
    let found = [
        a.duck.job.as_ref().map(|j| (&j.title, j.fraction())),
        a.color.job.as_ref().map(|j| (&j.title, j.fraction())),
        a.scenes.job.as_ref().map(|j| (&j.title, j.fraction())),
        a.beats.job.as_ref().map(|j| (&j.title, j.fraction())),
        a.silence.job.as_ref().map(|j| (&j.title, j.fraction())),
    ]
    .into_iter()
    .flatten()
    .next();
    if let Some((title, x)) = found {
        return of(title, x);
    }
    crate::voice::progress_box(s).or_else(|| crate::speakers::progress_box(s)).map(|(t, x, _, _)| (t, x))
}

/// Stops whatever runs and closes the setup dialogs.
fn cancel_all(s: &mut Shell) {
    if let Some((j, _)) = &s.features.speech.job {
        j.cancel();
    }
    s.features.speech.setup = None;
    s.features.speakers.setup = None;
    s.features.voice.setup = None;
    crate::auto::cancel(s);
}

/// What the job does once its recognition (if any) is done.
enum Then {
    Nothing,
    Captions {
        ids: Vec<Id>,
        range: Option<(f64, f64)>,
        chars: f64,
        highlight: bool,
    },
    Fillers {
        ids: Vec<Id>,
        range: Option<(f64, f64)>,
        o: FillerOpts,
    },
    /// The answer is read from what changed.
    Changes,
}

/// The project before the job, for the answers made of what changed.
struct Before {
    clips: HashMap<Id, String>,
    media: Vec<Id>,
    markers: usize,
    clip_count: usize,
    speakers: Option<Json>,
}

fn before(s: &Shell) -> Before {
    let seq = s.app.sequence();
    Before {
        clips: seq
            .map(|q| q.clips_in_order().map(|c| (c.id, super::call::cj(c).to_string())).collect())
            .unwrap_or_default(),
        media: s.app.project().media.iter().map(|m| m.id).collect(),
        markers: seq.map_or(0, |q| q.markers.len()),
        clip_count: seq.map_or(0, |q| q.clip_count()),
        speakers: s.app.project().speakers.clone(),
    }
}

/// A native job on its way.
pub struct Native {
    action: String,
    then: Then,
    before: Before,
    notices: usize,
    seen_job: bool,
    seen_setup: bool,
    cancelled: bool,
    /// The clip a beat detection or Auto Color works on.
    clip: Option<Id>,
    /// What to restore once the job started (the language a recognition was asked in).
    language: Option<Json>,
}

const SPEECH: [&str; 3] = ["transcribe", "auto_captions", "remove_fillers"];

/// Starts `action` with the call's arguments `a` -> the job, or the answer at once (`Json::Null` after the toast
/// that says why nothing ran).
pub fn start(s: &mut Shell, action: &str, a: &Json) -> Result<Native, Json> {
    let b = before(s);
    let notices = s.app.notices.len();
    let mut n = Native {
        action: action.to_owned(),
        then: Then::Changes,
        before: b,
        notices,
        seen_job: false,
        seen_setup: false,
        cancelled: false,
        clip: None,
        language: None,
    };
    let str_of = |k: &str| a[k].as_str().map(str::to_owned);
    match action {
        a2 if SPEECH.contains(&a2) => {
            let ids = crate::speech::flow::speech_clips(&s.app);
            if s.app.sequence().is_none() || ids.is_empty() {
                s.app.toast(tr("There are no clips with speech to transcribe."));
                return Err(Json::Null);
            }
            let range = crate::speech::flow::in_out(&s.app);
            let want = str_of("language").filter(|l| !(a2 == "transcribe" && l == "auto"));
            if let Some(l) = want {
                n.language = Some(crate::speech::setting(s, "speech.language"));
                crate::speech::set_setting(s, "speech.language", json!(l));
            }
            n.then = match a2 {
                "auto_captions" => {
                    let shown =
                        s.app.sequence().and_then(|q| q.captions.iter().find(|t| t.name == tr("Auto Captions")));
                    let remembered = crate::speech::setting(s, "speech.highlight").as_bool().unwrap_or(false);
                    let hl =
                        shown.map_or(remembered, |t| t.style.get("highlight").and_then(Json::as_bool).unwrap_or(false));
                    Then::Captions {
                        ids: ids.clone(),
                        range,
                        chars: a["chars_per_line"].as_f64().unwrap_or_else(|| crate::speech::line_chars(s)),
                        highlight: a["highlight"].as_bool().unwrap_or(hl),
                    }
                }
                "remove_fillers" => {
                    let mut o = crate::speech::dialogs::filler_settings(s);
                    if let Some(v) = a["fillers"].as_bool() {
                        o.fillers = v;
                    }
                    if let Some(v) = a["pauses"].as_bool() {
                        o.pauses = v;
                    }
                    if let Some(v) = a["pause_length"].as_f64() {
                        o.pause_length = v;
                    }
                    if let Some(v) = a["keep"].as_f64() {
                        o.keep = v;
                    }
                    Then::Fillers { ids: ids.clone(), range, o }
                }
                _ => Then::Nothing,
            };
            crate::speech::dialogs::ensure_ready(s, None, crate::speech::Goal::Recognize { ids, range });
            if let Some(l) = n.language.take() {
                crate::speech::set_setting(s, "speech.language", l);
            }
        }
        "label_speakers" => crate::speakers::label::start(s, a["speakers"].as_u64().map(|c| c as u32)),
        "isolate_voice" => crate::voice::isolate(s),
        "detect_scenes" => {
            if crate::auto::scenes::picture_clips(&s.app).is_empty() {
                s.app.toast(tr("There are no video clips to analyze."));
                return Err(Json::Null);
            }
            let threshold = a["threshold"]
                .as_f64()
                .unwrap_or_else(|| crate::auto::settings(s, "scenes", &[("threshold", 35.0)])[0]);
            let split = match str_of("mode") {
                Some(m) => m == "split",
                None => crate::auto::setting_word(s, "scenes", "action", &["markers", "split"]) == Some("split"),
            };
            let act = if split { crate::auto::scenes::Action::Split } else { crate::auto::scenes::Action::Markers };
            crate::auto::scenes::start(s, threshold, act);
        }
        "detect_beats" => {
            let clips = crate::audio::essential::sound_clips(&s.app, false);
            let Some(first) = clips.first().copied() else {
                s.app.toast(tr("Select an audio clip first."));
                return Err(Json::Null);
            };
            n.clip = Some(first);
            let bar = match str_of("every") {
                Some(e) => e == "bar",
                None => crate::auto::setting_word(s, "beats", "every", &["beat", "bar"]) == Some("bar"),
            };
            s.features.auto.beats.last_bpm = None;
            crate::auto::beats::start(
                s,
                if bar { crate::auto::beats::Every::Bar } else { crate::auto::beats::Every::Beat },
            );
        }
        "auto_duck" => {
            let (d, m) = crate::auto::duck::clips(&s.app);
            if d.is_empty() || m.is_empty() {
                s.app.toast(tr(
                    "Mark the clips first: right-click a clip in the timeline and choose Audio Role > Dialogue for speech and Music for the music to lower.",
                ));
                return Err(Json::Null);
            }
            let v = crate::auto::settings(
                s,
                "duck",
                &[("amount", -12.0), ("fade", 0.3), ("threshold", -40.0), ("hold", 0.5)],
            );
            let o = crate::auto::duck::Duck {
                amount: a["amount"].as_f64().unwrap_or(v[0]),
                fade: a["fade"].as_f64().unwrap_or(v[1]),
                threshold: a["threshold"].as_f64().unwrap_or(v[2]),
                hold: v[3],
            };
            crate::auto::duck::start(s, o);
        }
        "auto_color" => {
            let Some((clip, _)) = crate::auto::color::target(&s.app) else {
                s.app.toast(tr("Select a video clip first."));
                return Err(Json::Null);
            };
            n.clip = Some(clip);
            crate::auto::color::start(s);
        }
        _ => return Err(json!({ "ok": false, "error": format!("{action} changed nothing.") })),
    }
    Ok(n)
}

impl Native {
    /// One frame: the answer once the job ended.
    pub fn poll(&mut self, s: &mut Shell, live: &Live) -> Option<Json> {
        if live.aborted() && !self.cancelled {
            self.cancelled = true;
            cancel_all(s);
        }
        self.seen_job |= job_running(s);
        self.seen_setup |= setup_open(s);
        if let Some((title, f)) = progress(s) {
            live.progress(Some(f64::from(f)), &title);
        }
        if busy(s) {
            return None;
        }
        let said: Vec<String> = s.app.notices.iter().skip(self.notices).map(|n| n.text.clone()).collect();
        let failed = s.app.notices.iter().skip(self.notices).any(|n| n.error);
        if self.cancelled || said.iter().any(|t| *t == tr("The analysis was cancelled.")) {
            return Some(json!({ "cancelled": true }));
        }
        if !self.seen_job && self.seen_setup {
            return Some(json!({ "declined": true }));
        }
        if failed {
            return Some(Json::Null);
        }
        let heard_none = said.iter().any(|t| *t == tr("No speech was recognized."));
        Some(match std::mem::replace(&mut self.then, Then::Changes) {
            Then::Nothing => json!({}),
            Then::Captions { ids, range, chars, highlight } => {
                match crate::speech::flow::make_captions(s, &ids, range, chars, highlight) {
                    Some(n) => json!({ "count": n }),
                    None if heard_none || s.app.notices.len() > self.notices => json!({ "count": 0 }),
                    None => Json::Null,
                }
            }
            Then::Fillers { ids, range, o } => {
                let (p, now, _) = crate::speech::dialogs::fillers_plan(s, &ids, range, &o);
                if p.ranges.is_empty() {
                    s.app.toast(tr("No filler words or long pauses were found."));
                    json!({ "cuts": 0 })
                } else if crate::speech::flow::ripple(s, &p.ranges, &now, "Remove Filler Words") {
                    s.app.selection.clear();
                    let total: f64 = p.ranges.iter().map(|(a, b)| b - a).sum();
                    json!({
                        "cuts": p.ranges.len(), "fillers": p.fillers.len(), "pauses": p.pauses.len(),
                        "seconds": super::call::num((total / TICKS as f64 * 10.0 + 0.5).floor() / 10.0),
                    })
                } else {
                    Json::Null
                }
            }
            Then::Changes => self.changes(s, &said),
        })
    }

    /// The answer of a job made from what it changed.
    fn changes(&self, s: &Shell, said: &[String]) -> Json {
        let Some(seq) = s.app.sequence() else { return Json::Null };
        let b = &self.before;
        let has = |t: &str| said.iter().any(|x| *x == tr(t));
        match self.action.as_str() {
            "label_speakers" => {
                let now = s.app.project().speakers.clone();
                if now != b.speakers {
                    json!({ "speakers": now.as_ref().and_then(|v| v["list"].as_array()).map_or(0, Vec::len) })
                } else if has("No speech was recognized.") {
                    json!({ "speakers": 0 })
                } else {
                    Json::Null
                }
            }
            "isolate_voice" => {
                let clips: Vec<&str> = seq
                    .clips_in_order()
                    .filter(|c| b.clips.get(&c.id) != Some(&super::call::cj(c).to_string()))
                    .map(|c| c.id.as_str())
                    .collect();
                let media: Vec<&str> =
                    s.app.project().media.iter().filter(|m| !b.media.contains(&m.id)).map(|m| m.id.as_str()).collect();
                if clips.is_empty() && media.is_empty() {
                    Json::Null
                } else {
                    json!({ "clips": clips, "media": media })
                }
            }
            "detect_scenes" => {
                let n = seq.markers.len().saturating_sub(b.markers)
                    + seq
                        .clips_in_order()
                        .filter(|c| {
                            !b.clips.contains_key(&c.id) && seq.kind_of(c.track) == Some(cut_model::TrackKind::Video)
                        })
                        .count();
                if n > 0 {
                    json!({ "count": n })
                } else if has("No scene changes were found.") {
                    json!({ "count": 0 })
                } else {
                    Json::Null
                }
            }
            "detect_beats" => {
                let count = self
                    .clip
                    .and_then(|id| seq.clip(id))
                    .map_or(0, |c| c.markers.iter().flatten().filter(|m| m.kind == MarkerKind::Beat).count());
                match s.features.auto.beats.last_bpm {
                    Some(bpm) => json!({ "bpm": bpm, "count": count }),
                    None if has("No beats were found.") => json!({ "bpm": 0, "count": 0 }),
                    None => Json::Null,
                }
            }
            "auto_duck" => {
                let ducked = seq
                    .clips_in_order()
                    .filter(|c| c.role == Some(Role::Music))
                    .filter(|c| b.clips.get(&c.id) != Some(&super::call::cj(c).to_string()))
                    .count();
                if ducked > 0 {
                    json!({ "count": ducked })
                } else if has("The dialogue does not overlap the music.") {
                    json!({ "count": 0 })
                } else {
                    Json::Null
                }
            }
            "auto_color" => {
                let e = self
                    .clip
                    .and_then(|id| seq.clip(id))
                    .and_then(|c| c.effects.iter().find(|e| e.kind == "color.basic"));
                match e {
                    Some(e) if b.clip_count == seq.clip_count() => {
                        let p = cut_model::effects::resolve(&e.kind, &e.params);
                        json!({ "temperature": p["temperature"], "tint": p["tint"], "exposure": p["exposure"] })
                    }
                    _ => Json::Null,
                }
            }
            _ => Json::Null,
        }
    }
}

/// The clips `remove_silence` measures (`measureSilence` with `speech`): those with sound, the speech ones of them
/// when nothing is selected.
fn silence_clips(s: &Shell) -> Vec<Id> {
    let all = crate::audio::essential::sound_clips(&s.app, true);
    let Some(seq) = s.app.sequence() else { return Vec::new() };
    let picked = s.app.selection.iter().any(|id| seq.clip(*id).is_some());
    let not_speech = |r: Option<Role>| matches!(r, Some(Role::Music | Role::Effects | Role::Ambience));
    let talk: Vec<Id> = if picked {
        all.clone()
    } else {
        all.iter().copied().filter(|id| seq.clip(*id).is_some_and(|c| !not_speech(c.role))).collect()
    };
    if talk.is_empty() { all } else { talk }
}

/// `silencePlan(app, {threshold, minLength, margin: 0.1})`: the clips' sound measured on a thread, then the quiet
/// stretches -> `{ranges, tracks}` (ticks), `{ranges: []}` without clips, or null when stopped.
pub fn silence(s: &mut Shell, seq: Id, threshold: f64, min_length: f64) -> Task<Json> {
    use crate::auto::levels::{self, Read};
    if s.app.sequence_id != Some(seq) {
        s.app.set_sequence(seq);
    }
    let clips = silence_clips(s);
    let plan = move |s: &Shell, clips: &[Id]| -> Json {
        let o = crate::auto::silence::Silence { threshold, min_length, margin: 0.1 };
        let p = crate::auto::silence::plan(&s.app, clips, o, &s.features.auto.levels);
        let ranges: Vec<Json> = p.ranges.iter().map(|(a, b)| json!([*a as i64, *b as i64])).collect();
        json!({ "ranges": ranges, "tracks": p.tracks.iter().map(|t| t.as_str()).collect::<Vec<_>>() })
    };
    let reads: Vec<Read> = match s.app.sequence() {
        Some(q) => clips
            .iter()
            .filter_map(|id| q.clip(*id))
            .filter_map(|c| Read::of(s.app.project(), c))
            .filter(|r| s.features.auto.levels.get(&r.key).is_none())
            .collect(),
        None => Vec::new(),
    };
    if clips.is_empty() {
        return Box::new(|_, _| Some(json!({ "ranges": [], "tracks": [] })));
    }
    let job = crate::auto::Job::start(tr("Analyzing the sound…").into_owned(), false, move |step| {
        levels::measure_all(&reads, step)
    });
    Box::new(move |h, live| {
        let s = h.shell()?;
        if live.aborted() {
            job.cancel();
        }
        live.progress(Some(f64::from(job.fraction())), &tr("Analyzing the sound…"));
        match job.poll(s.transport.playing())? {
            crate::auto::Outcome::Done(got) => {
                for (k, l) in got {
                    s.features.auto.levels.put(k, l);
                }
                Some(plan(s, &clips))
            }
            _ => Some(Json::Null),
        }
    })
}

/// `services.transcript(seq)`: what speech recognition heard in the open sequence, as segments (seconds).
pub fn transcript(s: &mut Shell, seq: Id) -> Vec<(f64, f64, String)> {
    if s.app.sequence_id != Some(seq) {
        return Vec::new();
    }
    crate::speech::flow::load_cached(s);
    let words = crate::speech::flow::sequence_words(s);
    let Some(q) = s.app.sequence() else { return Vec::new() };
    let frame = cut_model::query::frame(q.fps) as f64;
    let t = TICKS as f64;
    crate::ai::metadata_ui::segments_from_words(&words, frame)
        .into_iter()
        .map(|g| (g.start / t, g.end / t, g.text))
        .collect()
}
