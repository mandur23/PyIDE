//! From clips to words and back (`ui-speech.js`): which clips speak, what of their media is not transcribed yet, the
//! recognition on its thread, the clips' words on the timeline, and the edits made of them (Auto Captions, Remove
//! Filler Words, the uncertain words).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cut_audio::analysis::{subtract, total, union};
use cut_model::commands::build as C;
use cut_model::{Clip, Id, Role, Sequence, TrackKind};
use cut_time::TICKS;
use eframe::egui::{self, Align2, ProgressBar, Vec2};
use serde_json::{Value as Json, json};

use super::engine::{EngineState, Request, Speech};
use super::store::{Opts, Store, Transcript, file_key, key_of};
use super::text::{self, CaptionOpts, UNCERTAIN, WindowWords, Word};
use super::words::RATE;
use super::{Goal, backend, opts, store};
use crate::auto::{Job, Outcome, Step, Stop};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::App;

/// A clip whose speech counts: on an audio track, enabled, not a freeze frame, its media has sound, and its role is
/// not music, effects or ambience.
pub fn speaks(app: &App, seq: &Sequence, c: &Clip) -> bool {
    seq.kind_of(c.track) == Some(TrackKind::Audio)
        && c.enabled
        && !c.is_freeze()
        && c.media_id().and_then(|m| app.project().media(m)).is_some_and(|m| m.audio.is_some())
        && !matches!(c.role, Some(Role::Music | Role::Effects | Role::Ambience))
}

/// The In-Out range when both are marked and out is after in.
pub fn in_out(app: &App) -> Option<(f64, f64)> {
    match (app.in_out.in_, app.in_out.out) {
        (Some(a), Some(b)) if b > a => Some((a as f64, b as f64)),
        _ => None,
    }
}

/// The clips whose speech counts (`speechClips`): the selected ones (a video clip brings its linked audio), else
/// every one; with an In-Out range only those it touches; in time order.
pub fn speech_clips(app: &App) -> Vec<Id> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let range = in_out(app);
    let mut set: Vec<&Clip> = Vec::new();
    for c in seq.clips().filter(|c| app.selection.contains(&c.id)) {
        for x in std::iter::once(c).chain(seq.linked_clips(c)) {
            if speaks(app, seq, x) && !set.iter().any(|k| k.id == x.id) {
                set.push(x);
            }
        }
    }
    if set.is_empty() {
        set = seq.clips().filter(|c| speaks(app, seq, c)).collect();
    }
    set.retain(|c| range.is_none_or(|(a, b)| (c.start as f64) < b && (c.end() as f64) > a));
    set.sort_by_key(|c| c.start);
    set.into_iter().map(|c| c.id).collect()
}

/// The source seconds of each media the clips need (the part of each clip inside `range`, a second around it).
fn needed(app: &App, clips: &[Id], range: Option<(f64, f64)>) -> Vec<(Id, Vec<(f64, f64)>)> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let t = TICKS as f64;
    let mut out: Vec<(Id, Vec<(f64, f64)>)> = Vec::new();
    for c in clips.iter().filter_map(|id| seq.clip(*id)) {
        let (start, end) = (c.start as f64, c.end() as f64);
        let (a, b) = match range {
            Some((r0, r1)) => (start.max(r0), end.min(r1)),
            None => (start, end),
        };
        let Some(m) = c.media_id().filter(|_| b > a) else { continue };
        let s0 = c.source_time(a);
        let s1 = c.source_time(a.max(b - 1.0));
        let span = ((s0.min(s1) / t - 1.0).max(0.0), s0.max(s1) / t + 1.0);
        match out.iter_mut().find(|(id, _)| *id == m) {
            Some((_, list)) => list.push(span),
            None => out.push((m, vec![span])),
        }
    }
    out
}

/// One stretch of a media file to recognise.
struct Work {
    media: cut_model::Media,
    key: String,
    a: f64,
    b: f64,
}

/// The clips' words on the timeline (ticks), in time order (`timelineWords`); clips not transcribed yet have none.
pub fn timeline_words(app: &App, store: &Store, o: &Opts, clips: &[Id], range: Option<(f64, f64)>) -> Vec<Word> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let lists = clips
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter_map(|c| {
            let m = app.project().media(c.media_id()?)?;
            let (_, t) = store.transcript_of(m, o)?;
            Some(text::clip_words(c, &t.words))
        })
        .collect();
    let all = text::join_clips(lists);
    match range {
        Some((a, b)) => all.into_iter().filter(|w| (w.t0 + w.t1) / 2.0 >= a && (w.t0 + w.t1) / 2.0 < b).collect(),
        None => all,
    }
}

/// Every speaking clip's words.
pub fn sequence_words(s: &mut Shell) -> Vec<Word> {
    let st = store(s);
    let o = opts(s);
    let Some(seq) = s.app.sequence() else { return Vec::new() };
    let ids: Vec<Id> = seq.clips().filter(|c| speaks(&s.app, seq, c)).map(|c| c.id).collect();
    let g = st.lock().unwrap_or_else(|e| e.into_inner());
    timeline_words(&s.app, &g, &o, &ids, None)
}

/// Reads the cached transcripts of the sequence's media (`loadCachedFor`) -> whether one was found.
pub fn load_cached(s: &mut Shell) -> bool {
    let st = store(s);
    let o = opts(s);
    let Some(seq) = s.app.sequence() else { return false };
    let mut g = st.lock().unwrap_or_else(|e| e.into_inner());
    let mut found = false;
    for c in seq.clips() {
        let Some(m) = c.media_id().and_then(|m| s.app.project().media(m)).filter(|m| m.audio.is_some()) else {
            continue;
        };
        let key = key_of(m, &o);
        if g.cached(&key).is_some() {
            g.set_latest(file_key(m), key, true);
            found = true;
        }
    }
    found
}

/// Starts recognising what the clips need (only what is not transcribed yet) under the progress box; `goal` runs
/// when it is done.
pub fn start(s: &mut Shell, clips: Vec<Id>, range: Option<(f64, f64)>, goal: Goal) {
    let st = store(s);
    let o = opts(s);
    let speech = backend(s);
    let mut work = Vec::new();
    {
        let mut g = st.lock().unwrap_or_else(|e| e.into_inner());
        for (mid, spans) in needed(&s.app, &clips, range) {
            let Some(m) = s.app.project().media(mid) else { continue };
            let key = key_of(m, &o);
            let t = g.cached(&key).map(|t| (*t).clone()).unwrap_or_default();
            let ranges = t.ranges.clone();
            g.remember(&key, t);
            g.set_latest(file_key(m), key.clone(), false);
            for (a, b) in subtract(&union(&spans), &ranges) {
                if b - a >= 0.3 {
                    work.push(Work { media: m.clone(), key: key.clone(), a, b });
                }
            }
        }
    }
    let voice = o.isolate.then(|| (s.doc.home.clone(), s.features.voice.backend.clone()));
    let job = Job::start(tr("Recognizing speech…").into_owned(), false, move |step| {
        let voice = voice.as_ref().map(|(home, backend)| (home, &**backend));
        transcribe(&speech, &st, &o, &work, voice, step)
    });
    s.features.speech.job = Some((job, goal));
}

/// The recognition thread: each stretch written to a sound file (from the vocals of that stretch when `voice` is
/// given, made in the Cut cache first, as `ui.voice.forSpeech`) and recognised window by window, the words joined
/// into the media's transcript and stored. `Ok(Err(text))`: recognition itself failed.
fn transcribe(
    speech: &Speech,
    st: &Arc<Mutex<Store>>,
    o: &Opts,
    work: &[Work],
    voice: Option<(&crate::files::Home, &crate::voice::backend::Backend)>,
    step: &Step,
) -> Result<Result<(), String>, Stop> {
    let all: f64 = work.iter().map(|w| w.b - w.a).sum::<f64>();
    let all = if all > 0.0 { all } else { 1.0 };
    let mut done = 0.0;
    for w in work {
        let share = (w.b - w.a) / all;
        let at = |f: f64| step.progress(done + share * f);
        // the isolated voice takes about a sixth of the time recognition does
        let vocals = match voice {
            Some((home, backend)) => {
                let files = crate::voice::isolate::temp_files();
                let tools = crate::voice::isolate::Tools { home, backend, files: &files };
                let part = (done, done + share * 0.2);
                let place = crate::voice::files::Place::Cache;
                let made = crate::voice::isolate::render(tools, &w.media, (w.a, Some(w.b)), place, step, part);
                Some(made.map_err(|e| e.map(|m| crate::voice::isolate::failure_text(&m)))?)
            }
            None => None,
        };
        let lead = if vocals.is_some() { 0.2 } else { 0.0 };
        let (path, from) = vocals.unwrap_or_else(|| (std::path::PathBuf::from(&w.media.path), 0.0));
        let Some(mut file) =
            super::sound::write_sound(speech.files(), &path, w.a - from, w.b - from, step, |f| at(lead + 0.1 * f))?
        else {
            done += share;
            continue;
        };
        file.start += from;
        let res = recognise(speech, &file.id, file.samples, o, step, |f| at(0.1 + 0.9 * f));
        speech.files().close(&file.id);
        let (words, language) = match res? {
            Ok(v) => v,
            Err(e) => return Ok(Err(e)),
        };
        let mut g = st.lock().unwrap_or_else(|e| e.into_inner());
        let t = g.cached(&w.key).map(|t| (*t).clone()).unwrap_or_default();
        let mut ranges = t.ranges.clone();
        ranges.push((file.start, file.start + file.samples as f64 / RATE as f64));
        let mut all_words = t.words.clone();
        all_words.extend(words.into_iter().map(|x| Word { t0: file.start + x.t0, t1: file.start + x.t1, ..x }));
        all_words.sort_by(|x, y| x.t0.partial_cmp(&y.t0).unwrap_or(std::cmp::Ordering::Equal));
        let next =
            Transcript { ranges: union(&ranges), words: text::dedupe(all_words), language: t.language.or(language) };
        g.store(&w.key, next);
        drop(g);
        done += share;
    }
    step.progress(1.0);
    Ok(Ok(()))
}

/// A sound file's words (seconds from its start) and the language heard most.
type Heard = (Vec<Word>, Option<String>);

/// The words of a sound file, window by window (`recognise`) -> (words in seconds from the file's start, the language
/// heard most).
fn recognise(
    speech: &Speech,
    id: &str,
    samples: u64,
    o: &Opts,
    step: &Step,
    on_part: impl Fn(f64),
) -> Result<Result<Heard, String>, Stop> {
    let total = samples as i64;
    let mut results = Vec::new();
    let mut heard: Vec<(String, usize)> = Vec::new();
    let mut again = true;
    let mut from = Some(0i64);
    while let Some(f) = from {
        step.step().map_err(Err)?;
        let to = total.min(f + text::WINDOW * RATE as i64);
        let req = Request {
            file: id,
            offset: f as u64,
            length: (to - f) as u64,
            language: &o.language,
            model: &o.model,
            terms: &o.terms,
        };
        let r = match speech.transcribe(&req, &|| step.step().is_err()) {
            Ok(Some(r)) => r,
            Ok(None) => return Err(Err(crate::auto::Cancelled)),
            Err(e) => return Ok(Err(e.error)),
        };
        step.step().map_err(Err)?;
        if let Some(l) = r.language {
            match heard.iter_mut().find(|(k, _)| *k == l) {
                Some(h) => h.1 += 1,
                None => heard.push((l, 1)),
            }
        }
        let words = text::drop_echo(r.words, &o.terms);
        let next = text::next_window(f, to, text::text_stop(&words, r.end), total, again);
        results.push(WindowWords { from: f, to, until: next.until, words });
        on_part(to as f64 / total.max(1) as f64);
        from = next.next;
        again = next.until.is_none();
    }
    let most = heard.iter().map(|h| h.1).max();
    let language = heard.into_iter().find(|h| Some(h.1) == most).map(|h| h.0);
    Ok(Ok((text::merge_windows(&results), language)))
}

/// Takes in a finished recognition and does what it was for; draws the progress box while one runs.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    let playing = s.transport.playing();
    let Some(out) = s.features.speech.job.as_ref().and_then(|(j, _)| j.poll(playing)) else {
        progress_box(s, ctx);
        return;
    };
    let Some((_, goal)) = s.features.speech.job.take() else { return };
    let ok = match out {
        Outcome::Done(Ok(())) => true,
        Outcome::Done(Err(e)) => {
            s.app.report(trf("Speech recognition failed: {error}", &[("error", &e)]));
            false
        }
        other => crate::auto::ended(s, other).is_some(),
    };
    if !ok {
        super::dialogs::declined(s, &goal);
        return;
    }
    match goal {
        Goal::Captions { ids, range, chars, highlight } => {
            make_captions(s, &ids, range, chars, highlight);
        }
        Goal::Fillers { ids, range } => super::dialogs::open_fillers(s, ids, range),
        Goal::Download | Goal::Recognize { .. } | Goal::Panel { .. } => {}
        Goal::Speakers { count, .. } => crate::speakers::label::run_labels(s, count),
        Goal::Claude { .. } => crate::ai::notice::resume(s),
    }
}

fn progress_box(s: &mut Shell, ctx: &egui::Context) {
    let Some((job, _)) = &s.features.speech.job else { return };
    let (title, f) = (job.title.clone(), job.fraction());
    let loading = s.features.speech.backend.as_ref().is_some_and(|b| b.engine() == EngineState::Loading);
    ctx.request_repaint_after(Duration::from_millis(50));
    let mut stop = false;
    egui::Window::new(title.clone())
        .id(egui::Id::unique("cut-speech-task"))
        .collapsible(false)
        .resizable(false)
        .anchor(Align2::CENTER_TOP, Vec2::new(0.0, 60.0))
        .show_titled(ctx, &title, None, |ui| {
            ui.add(ProgressBar::new(f).desired_width(260.0));
            ui.label(if loading {
                tr("Loading the speech model…").into_owned()
            } else {
                format!("{}%", text::js_round(f64::from(f) * 100.0))
            });
            stop = ui.button(tr("Cancel")).clicked();
        });
    if stop && let Some((j, _)) = &s.features.speech.job {
        j.cancel();
    }
}

/// The caption item a command takes, with its speaker when it has one.
fn item_json((c, speaker): &(text::Caption, Option<String>)) -> Json {
    let mut o = json!({
        "start": c.start as i64,
        "end": c.end as i64,
        "text": c.text,
        "words": c.words.iter().map(|(a, b, t)| json!({ "t0": *a as i64, "t1": *b as i64, "text": t })).collect::<Vec<_>>(),
    });
    if !c.doubt.is_empty() {
        o["doubt"] = c.doubt.iter().map(|(at, t, p)| json!({ "at": *at as i64, "text": t, "p": p })).collect();
    }
    if let Some(sp) = speaker {
        o["speaker"] = json!(sp);
    }
    o
}

/// The captions of the clips' words (`autoCaptions` after recognition): into the track named Auto Captions (only
/// its captions in the range replaced), else a new one; one undo step -> how many.
pub fn make_captions(
    s: &mut Shell,
    ids: &[Id],
    range: Option<(f64, f64)>,
    chars: f64,
    highlight: bool,
) -> Option<usize> {
    let st = store(s);
    let o = opts(s);
    let seq = s.app.sequence()?;
    let now: Vec<Id> = ids.iter().copied().filter(|id| seq.clip(*id).is_some()).collect();
    let (words, langs) = {
        let g = st.lock().unwrap_or_else(|e| e.into_inner());
        let words = timeline_words(&s.app, &g, &o, &now, range);
        let mut langs: Vec<String> = Vec::new();
        for c in now.iter().filter_map(|id| seq.clip(*id)) {
            let l = c
                .media_id()
                .and_then(|m| s.app.project().media(m))
                .and_then(|m| g.transcript_of(m, &o))
                .and_then(|(_, t)| t.language.clone());
            if let Some(l) = l.filter(|l| !langs.contains(l)) {
                langs.push(l);
            }
        }
        (words, langs)
    };
    if words.is_empty() {
        s.app.toast(tr("No speech was recognized."));
        return Some(0);
    }
    let frame = cut_model::query::frame(seq.fps) as f64;
    let co = CaptionOpts { frame, max_chars: chars.max(0.0) as usize, uncertain: UNCERTAIN, ..CaptionOpts::default() };
    // with speaker labels, a caption never holds two speakers and knows its own
    let items = crate::speakers::label::captions(&s.app, &words, |w| text::captions(w, &co), frame);
    let spk = crate::speakers::label::caption_mode(s).map(crate::speakers::label::style_of);
    let name = tr("Auto Captions").into_owned();
    let lang = if o.language != "auto" {
        o.language.clone()
    } else if langs.len() == 1 {
        langs[0].clone()
    } else if text::is_korean(&words.iter().map(|w| w.text.as_str()).collect::<String>()) {
        "ko".into()
    } else {
        "en".into()
    };
    let sid = seq.id;
    let track = seq.captions.iter().find(|t| t.name == name);
    let (r0, r1) = range.unwrap_or((0.0, f64::INFINITY));
    let made: Vec<Json> = items.iter().map(item_json).collect();
    let mut cmds = Vec::new();
    match track {
        Some(t) => {
            let mut list: Vec<Json> = t
                .items
                .iter()
                .filter(|it| it.end as f64 <= r0 || it.start as f64 >= r1)
                .map(|it| {
                    let mut o = json!({ "start": it.start, "end": it.end, "text": it.text });
                    if let Some(d) = &it.doubt {
                        o["doubt"] = json!(d);
                    }
                    if let Some(w) = &it.words {
                        o["words"] = json!(w);
                    }
                    if let Some(sp) = &it.speaker {
                        o["speaker"] = json!(sp);
                    }
                    o
                })
                .collect();
            list.extend(made);
            cmds.push(C::set_captions(sid.as_str(), t.id.as_str(), Json::Array(list)));
            let mut style = spk.unwrap_or_else(|| json!({}));
            let shown = t.style.get("highlight").and_then(Json::as_bool).unwrap_or(false);
            if shown != highlight {
                style["highlight"] = json!(highlight);
            }
            if style.as_object().is_some_and(|o| !o.is_empty()) {
                cmds.push(C::set_caption_track(sid.as_str(), t.id.as_str(), json!({ "style": style })));
            }
        }
        None => {
            let mut style = spk.unwrap_or_else(|| json!({}));
            style["highlight"] = json!(highlight);
            cmds.push(C::add_caption_track(
                sid.as_str(),
                json!({ "name": name, "lang": lang, "items": made, "style": style }),
            ))
        }
    }
    let n = items.len();
    s.app.exec(&C::batch("Auto Captions", cmds))?;
    s.app.toast(trf("Captions created: {n}.", &[("n", &n.to_string())]));
    Some(n)
}

/// Remove Filler Words… chosen: the clips' speech recognised (after the setup when it is needed), then the dialog.
pub fn remove_fillers(s: &mut Shell) {
    let ids = speech_clips(&s.app);
    if s.app.sequence().is_none() || ids.is_empty() {
        s.app.toast(tr("There are no clips with speech to transcribe."));
        return;
    }
    let range = in_out(&s.app);
    super::dialogs::ensure_ready(s, None, Goal::Fillers { ids, range });
}

/// The command of a ripple delete of `ranges` (sorted) from these clips' tracks and the tracks linked to them, one
/// step named `label` (`rippleTracks(seq, clips).tracks`, then `rippleRanges`): the last range first, so the earlier
/// ones stay where they are. `None` for no ranges.
pub fn ripple_command(seq: &Sequence, ranges: &[(f64, f64)], clips: &[Id], label: &str) -> Option<Json> {
    if ranges.is_empty() {
        return None;
    }
    let (tracks, _) = crate::auto::silence::ripple_tracks(seq, clips);
    let tracks: Vec<&str> = tracks.iter().map(|t| t.as_str()).collect();
    let sid = seq.id.as_str();
    let cmds = ranges.iter().rev().map(|(a, b)| C::extract(sid, *a as i64, *b as i64, Some(&tracks))).collect();
    Some(C::batch(label, cmds))
}

/// A ripple delete of `ranges` from these clips' tracks, as one step named `label` -> whether it was made.
pub fn ripple(s: &mut Shell, ranges: &[(f64, f64)], clips: &[Id], label: &str) -> bool {
    let Some(cmd) = s.app.sequence().and_then(|seq| ripple_command(seq, ranges, clips, label)) else { return false };
    s.app.exec(&cmd).is_some()
}

/// Isolate Voice made the vocals of the media `from` as the file `to` ([`super::store::file_key_of`]): its
/// transcripts become the vocals' too (`carryTranscripts`), so the Transcript panel keeps its words when the clips
/// switch over.
pub fn carry_transcripts(s: &mut Shell, from: Id, to: &str) {
    let st = store(s);
    let o = opts(s);
    let Some(m) = s.app.project().media(from) else { return };
    st.lock().unwrap_or_else(|e| e.into_inner()).carry(m, to, &o);
}

/// A timeline word corrected or confirmed by the person (`correctWord`): the media file's transcript holds the new
/// text, no longer uncertain, so every clip of that file shows it. -> whether it was there.
pub fn correct_word(s: &mut Shell, w: &Word, text: &str) -> bool {
    let st = store(s);
    let o = opts(s);
    let Some(m) = w.clip.and_then(|id| s.app.sequence()?.clip(id)?.media_id()).and_then(|m| s.app.project().media(m))
    else {
        return false;
    };
    let mut g = st.lock().unwrap_or_else(|e| e.into_inner());
    let Some((key, _)) = g.transcript_of(m, &o) else { return false };
    g.correct(&key, w.src, text)
}

/// "{n} s" of ticks.
pub fn seconds(ticks: f64) -> String {
    crate::auto::seconds(ticks)
}

/// The total of ranges, as [`seconds`].
pub fn removed(ranges: &[(f64, f64)]) -> String {
    seconds(total(ranges))
}

/// The uncertain words' frames on the timeline, in order (`uncertainFrames`): the shown caption track's doubts, or
/// the transcript's words when the Transcript panel has the keyboard or no caption holds one.
pub fn uncertain_frames(s: &mut Shell) -> Vec<i64> {
    if !super::marking(s) {
        return Vec::new();
    }
    let Some(seq) = s.app.sequence() else { return Vec::new() };
    let fps = seq.fps;
    let mut list: Vec<f64> = crate::captions::track_of(&s.app, &s.features.captions)
        .map(|t| {
            t.items
                .iter()
                .flat_map(|it| it.doubt.iter().flatten().map(move |d| ((it.start + d.at).min(it.end - 1)) as f64))
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() || s.app.focus == Some(crate::state::Panel::Transcript) {
        list = sequence_words(s).into_iter().filter(|w| text::is_uncertain(w.p, UNCERTAIN)).map(|w| w.t0).collect();
    }
    let mut out: Vec<i64> = list.into_iter().map(|t| cut_time::snap(t as i64, fps, false)).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Next (1) or Previous (-1) Uncertain Word: the playhead goes to it -> the time.
pub fn next_uncertain(s: &mut Shell, dir: i32) -> Option<i64> {
    s.app.sequence()?;
    if !super::marking(s) {
        s.app.toast(tr(
            "Uncertain words are not marked. Turn the marks on in the settings (Video Editor, Speech Recognition).",
        ));
        return None;
    }
    load_cached(s);
    let list = uncertain_frames(s);
    let now = s.app.t;
    let t = if dir > 0 { list.iter().copied().find(|x| *x > now) } else { list.iter().copied().rfind(|x| *x < now) };
    let Some(t) = t else {
        s.app.toast(tr(if list.is_empty() {
            "There are no uncertain words."
        } else if dir > 0 {
            "No uncertain words after the playhead."
        } else {
            "No uncertain words before the playhead."
        }));
        return None;
    };
    s.app.set_time(t);
    super::panel::reveal(s, t);
    Some(t)
}
