//! Isolate Voice (`ui-voice.js isolate`, `isolateMedia`, `render`): the vocals of the chosen media, made on the
//! analysis thread, imported next to their source in its bin, and (from the Automation or clip menu) played by the
//! selected audio clips instead of their own sound, one undo step.
//!
//! Threads: the sound is decoded in ten-second blocks, resampled to 44.1 kHz and streamed into the temp file on the
//! analysis thread, which then waits for the model; the WAV is probed there too. The project changes on the UI
//! thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cut_audio::source::AudioRead;
use cut_model::commands::build as C;
use cut_model::{Clip, Id, Media, TrackKind};
use cut_sidecar::sound::SoundFiles;
use cut_time::TICKS;
use serde_json::{Value as Json, json};

use super::backend::{Backend, Sound};
use super::files::{Place, RATE, file_name, find, key_of};
use crate::auto::{Step, Stop};
use crate::files::Home;
use crate::i18n::{tr, trf};
use crate::import::Probed;
use crate::state::App;

/// A media file to isolate the voice of, as the analysis thread needs it.
#[derive(Debug, Clone)]
pub struct Source {
    pub id: Id,
    pub media: Media,
}

/// What the analysis thread works with: the workspace, the model and the temp files.
#[derive(Clone, Copy)]
pub struct Tools<'a> {
    pub home: &'a Home,
    pub backend: &'a Backend,
    pub files: &'a SoundFiles,
}

/// The vocals made for a media file: the WAV, read as the import reads it.
pub struct Made {
    pub media: Id,
    pub path: PathBuf,
    pub probed: Probed,
}

/// The selected audio clips with sound (a selected video clip brings its linked audio), in selection order; clips on
/// locked tracks left out (`soundClips`).
pub fn sound_clips(app: &App) -> Vec<Id> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let p = app.project();
    let has = |c: &Clip| {
        seq.kind_of(c.track) == Some(TrackKind::Audio)
            && c.media_id().and_then(|m| p.media(m)).is_some_and(|m| m.audio.is_some())
    };
    let mut out: Vec<&Clip> = Vec::new();
    for c in seq.clips().filter(|c| app.selection.contains(&c.id)) {
        for x in std::iter::once(c).chain(seq.linked_clips(c)) {
            if has(x) && !out.iter().any(|o| o.id == x.id) {
                out.push(x);
            }
        }
    }
    out.retain(|c| !seq.track(c.track).is_some_and(|t| t.locked));
    out.into_iter().map(|c| c.id).collect()
}

/// The vocals of source seconds `[from, to)` of a media file (`to` `None`: to its end, padded to the media's length)
/// in `place` (`render`) -> the WAV's path and the second it starts at. `part` is the share of the task's progress
/// it covers.
pub fn render(
    tools: Tools<'_>,
    m: &Media,
    (from, to): (f64, Option<f64>),
    place: Place,
    step: &Step,
    part: (f64, f64),
) -> Result<(PathBuf, f64), Stop> {
    let Tools { home, backend, files } = tools;
    let at = |f: f64| step.progress(part.0 + (part.1 - part.0) * f);
    if m.audio.is_none() {
        return Err(Ok("The media has no sound.".into()));
    }
    let key = key_of(m, from, to);
    if let Some((path, _)) = find(home, &m.name, &key) {
        at(1.0);
        return Ok((path, from));
    }
    let media = || Ok("The clip's media cannot be read.".to_owned());
    let mut r = match cut_audio::Library::default().audio(Path::new(&m.path)) {
        Ok(Some(r)) => r,
        _ => return Err(media()),
    };
    let rate = r.rate();
    let length = r.length();
    let mut planes: Vec<Vec<f32>> = Vec::new();
    r.read_into(0, 0, &mut planes).map_err(|_| media())?;
    let channels = planes.len().clamp(1, 2);
    let g = gcd(rate as i64, i64::from(RATE));
    // a block starting on a multiple of `si` input samples starts on an output sample
    let (si, so) = (rate as i64 / g, i64::from(RATE) / g);
    let margin = si * ((256 + si - 1) / si);
    let s0 = ((from * rate) / si as f64).floor() as i64 * si;
    let s1 = length.min(to.map_or(length, |t| (t * rate).ceil() as i64));
    let frames = match to {
        None => (((m.duration / TICKS as f64) - s0 as f64 / rate) * f64::from(RATE)).ceil().max(0.0) as u64,
        Some(_) => 0,
    };
    let id = files.open().map_err(|e| Ok(e.message()))?;
    let out = (|| {
        let block = (rate * 10.0) as i64;
        let mut x = s0;
        while x < s1 {
            step.step().map_err(Err)?;
            let y = s1.min(x + block);
            let lo = (x - margin).max(0);
            r.read_into(lo, y + margin, &mut planes).map_err(|_| media())?;
            let n = ((y - x) as f64 * so as f64 / si as f64).round() as i64;
            let o0 = x * so / si;
            let mut outs = Vec::with_capacity(channels);
            for c in 0..channels {
                // a mono file read as stereo, or more than two channels folded into two
                let mine: Vec<&Vec<f32>> =
                    planes.iter().enumerate().filter(|(k, _)| channels == 1 || k % 2 == c).map(|(_, p)| p).collect();
                let len = mine.first().map_or(0, |p| p.len());
                let mut src = vec![0f32; len];
                for p in &mine {
                    for (i, v) in p.iter().enumerate() {
                        src[i] += v / mine.len() as f32;
                    }
                }
                outs.push(if rate == f64::from(RATE) {
                    let a = ((x - lo) as usize).min(src.len());
                    src[a..(a + n.max(0) as usize).min(src.len())].to_vec()
                } else {
                    cut_audio::resample::resample_part(&[src], lo, length, rate, f64::from(RATE), o0, o0 + n).remove(0)
                });
            }
            let mut inter = vec![0f32; n.max(0) as usize * channels];
            for (c, o) in outs.iter().enumerate() {
                for (i, v) in o.iter().enumerate() {
                    inter[i * channels + c] = *v;
                }
            }
            files.write(&id, &inter).map_err(|e| Ok(e.message()))?;
            at(0.15 * ((y - s0) as f64 / (s1 - s0).max(1) as f64));
            x = y;
        }
        step.step().map_err(Err)?;
        let path = place.dir(home).join(file_name(&m.name, &key));
        let sound = Sound { files, id: &id, channels: channels as u16 };
        backend.separate(sound, frames, &path, &|f| at(0.15 + 0.85 * f), step.cancel_flag()).map_err(|e| {
            if e.code == "cancelled" { Err(crate::auto::Cancelled) } else { Ok(format!("voice:{}", e.error)) }
        })?;
        at(1.0);
        Ok((path, s0 as f64 / rate))
    })();
    files.close(&id);
    out
}

fn gcd(a: i64, b: i64) -> i64 {
    if b == 0 { a.max(1) } else { gcd(b, a % b) }
}

/// The vocals of each media file, one after the other, on the analysis thread (`renderAll`).
pub fn render_all(tools: Tools<'_>, list: &[Source], step: &Step) -> Result<Vec<Made>, Stop> {
    let total: f64 = list.iter().map(|s| (s.media.duration / TICKS as f64).max(1.0)).sum::<f64>().max(1.0);
    let mut done = 0.0;
    let mut out = Vec::new();
    for s in list {
        let share = (s.media.duration / TICKS as f64).max(1.0) / total;
        let (path, _) = render(tools, &s.media, (0.0, None), Place::Media, step, (done, done + share))?;
        out.push(Made { media: s.id, probed: crate::import::probe_file(&path), path });
        done += share;
    }
    step.progress(1.0);
    Ok(out)
}

/// A failure of the analysis thread as the screen shows it: the model's own message inside "Voice isolation failed".
pub fn failure_text(e: &str) -> String {
    match e.strip_prefix("voice:") {
        Some(m) => trf("Voice isolation failed: {error}", &[("error", m)]),
        None => tr(e).into_owned(),
    }
}

/// The vocals as media of the project, inside the open undo step (`importVocals`): one already there for that file,
/// else imported into the source's bin as "<name> (Voice)", with the source's speaker turns -> source -> vocals.
pub fn import_vocals(app: &mut App, made: &[Made]) -> Result<Vec<(Id, Id)>, String> {
    let mut out: Vec<(Id, Id)> = Vec::new();
    for x in made {
        let entry = match &x.probed.result {
            Ok(e) => e.clone(),
            Err(r) => {
                let why = crate::import::refusal_text(r);
                return Err(trf("The isolated voice cannot be read: {error}", &[("error", &tr(why))]));
            }
        };
        let p = app.project();
        let Some(src) = p.media(x.media) else {
            return Err(trf("The isolated voice cannot be read: {error}", &[("error", "")]));
        };
        let path = x.path.to_string_lossy();
        if let Some(there) = p.media.iter().find(|m| m.path.to_lowercase() == path.to_lowercase()) {
            out.push((src.id, there.id));
            continue;
        }
        let bin = p.bins.iter().find(|b| b.items.contains(&src.id)).map(|b| b.id);
        let source = src.id;
        let mut entry = entry;
        entry["name"] = json!(trf("{name} (Voice)", &[("name", &src.name)]));
        let r =
            app.history.apply(&crate::cmd::import_media(vec![entry], bin)).map_err(|e| tr(&e.message).into_owned())?;
        let Some(id) = r["ids"][0].as_str().map(Id::new) else {
            return Err(tr("The file could not be read.").into_owned());
        };
        out.push((source, id));
    }
    let turns = app.project().speakers.as_ref().and_then(|s| s.get("turns")).and_then(Json::as_object).cloned();
    if let Some(have) = turns {
        let mut add = serde_json::Map::new();
        for (from, to) in &out {
            if let Some(t) = have.get(from.as_str()).filter(|_| !have.contains_key(to.as_str())) {
                add.insert(to.as_str().to_owned(), t.clone());
            }
        }
        if !add.is_empty() {
            app.history
                .apply(&C::set_speakers(Some(json!({ "turns": add }))))
                .map_err(|e| tr(&e.message).into_owned())?;
        }
    }
    Ok(out)
}

/// A media file and the clips that play it.
pub type MediaClips = (Id, Vec<Id>);

/// What Isolate Voice changes once the vocals are made: from the menus, `clips` (media -> its clips) of sequence
/// `seq` play them; from the Project panel only the media are imported. One undo step -> the toast.
pub fn apply(app: &mut App, made: &[Made], clips: Option<(Id, &[MediaClips])>) -> Option<String> {
    app.history.begin("Isolate Voice");
    let r = (|| -> Result<String, String> {
        let vocals = import_vocals(app, made)?;
        let Some((seq, by_media)) = clips else {
            return Ok(trf("The isolated voice is in the project: {n} files.", &[("n", &vocals.len().to_string())]));
        };
        let mut changed = 0;
        for (media, ids) in by_media {
            let Some(s) = app.project().sequences.iter().find(|s| s.id == seq) else { break };
            // clips removed or given another sound while the voice was being isolated are left alone
            let still: Vec<&str> = ids
                .iter()
                .filter(|id| s.clip(**id).is_some_and(|c| c.media_id() == Some(*media)))
                .map(|id| id.as_str())
                .collect();
            let Some((_, to)) = vocals.iter().find(|(from, _)| from == media) else { continue };
            if still.is_empty() {
                continue;
            }
            let r = app
                .history
                .apply(&C::replace_audio(seq.as_str(), &still, to.as_str()))
                .map_err(|e| tr(&e.message).into_owned())?;
            changed += r["ids"].as_array().map_or(0, Vec::len);
        }
        Ok(trf(
            "The voice was isolated in {n} clips. Undo brings the original sound back.",
            &[("n", &changed.to_string())],
        ))
    })();
    match r {
        Ok(toast) => {
            app.history.commit();
            Some(toast)
        }
        Err(e) => {
            app.history.cancel();
            app.report(e);
            None
        }
    }
}

/// The temp files of sound this process streams to the voice model (`%TEMP%\nano-studio-cut-voice`), 4 GB each as
/// `voice.js` allows.
pub fn temp_files() -> Arc<SoundFiles> {
    static FILES: std::sync::OnceLock<Arc<SoundFiles>> = std::sync::OnceLock::new();
    FILES
        .get_or_init(|| {
            let dir = std::env::temp_dir().join("nano-studio-cut-voice");
            Arc::new(SoundFiles::with_limit(dir, cut_sidecar::sound::VOICE_FILE_LIMIT))
        })
        .clone()
}
