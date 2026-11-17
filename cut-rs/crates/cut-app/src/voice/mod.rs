//! Voice isolation (`ui-voice.js`, `main/cut/voice.js`): the speech of a recording without its music and noise, from
//! the vocals stem of HTDemucs ([`backend`]), which runs on this PC.
//!
//! - Isolate Voice (the Automation menu, the clip menu, Essential Sound): the selected audio clips (a video clip
//!   brings its linked audio) play the vocals of their media file instead, one undo step: the vocals are a new WAV in
//!   the Cut workspace's Media folder ([`files`]), imported next to the source in its bin, each clip keeping its
//!   place, in, out, speed, keyframes, effects and links ([`isolate`]).
//! - Isolate Voice (the Project panel's item menu): the vocals of the chosen media, imported into their bin.
//! - Nothing is downloaded until the person presses Download in the setup dialog ([`setup`]).
//!
//! Threads: one analysis at a time on the analysis thread (`crate::auto::Job`), under the automation's progress box
//! with its Cancel; the setup on a thread of its own.

pub mod backend;
pub mod files;
pub mod isolate;
pub mod setup;

use std::sync::Arc;

use cut_model::Id;
use eframe::egui;

use self::backend::{Backend, Engine};
use self::isolate::{Made, Source, Tools};
use self::setup::{Model, Need, Outcome, Setup};
use crate::auto::{Job, Outcome as Ended};
use crate::i18n::tr;
use crate::shell::Shell;

/// What runs once the model is there.
#[derive(Debug, Clone, PartialEq)]
pub enum Want {
    /// The menus' Isolate Voice: in sequence `seq`, each media's clips.
    Clips { seq: Id, by_media: Vec<(Id, Vec<Id>)> },
    /// The Project panel's: the media only.
    Media(Vec<Id>),
    /// Speech recognition with the voice isolated first: it goes on once the model is there.
    Speech(crate::speech::Goal),
}

/// Voice isolation's state: the model, its setup dialog and the one separation that may run.
pub struct VoiceUi {
    pub backend: Arc<Backend>,
    pub setup: Option<Setup>,
    want: Option<Want>,
    pub job: Option<Job<Vec<Made>>>,
    plan: Option<Want>,
}

impl Default for VoiceUi {
    fn default() -> Self {
        VoiceUi { backend: Backend::from_env(), setup: None, want: None, job: None, plan: None }
    }
}

/// Whether a separation runs.
pub fn running(s: &Shell) -> bool {
    s.features.voice.job.is_some()
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(_s: &Shell, id: &str) -> Option<bool> {
    (id == "auto.isolateVoice").then_some(true)
}

/// Runs Isolate Voice from the menus -> whether `id` was it.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    if id != "auto.isolateVoice" {
        return false;
    }
    isolate(s);
    true
}

/// Isolate Voice of the selected clips (`isolate`).
pub fn isolate(s: &mut Shell) {
    let clips = isolate::sound_clips(&s.app);
    let (Some(seq), false) = (s.app.sequence_id, clips.is_empty()) else {
        s.app.toast(tr("Select a clip with sound to isolate its voice."));
        return;
    };
    let mut by_media: Vec<(Id, Vec<Id>)> = Vec::new();
    for id in clips {
        let Some(m) = s.app.sequence().and_then(|q| q.clip(id)).and_then(|c| c.media_id()) else { continue };
        match by_media.iter_mut().find(|(x, _)| *x == m) {
            Some((_, ids)) => ids.push(id),
            None => by_media.push((m, vec![id])),
        }
    }
    ensure_ready(s, Want::Clips { seq, by_media });
}

/// Isolate Voice of media items (the Project panel's, `isolateMedia`).
pub fn isolate_media(s: &mut Shell, ids: &[Id]) {
    let ids: Vec<Id> =
        ids.iter().copied().filter(|id| s.app.project().media(*id).is_some_and(|m| m.audio.is_some())).collect();
    if ids.is_empty() {
        s.app.toast(tr("The media has no sound."));
        return;
    }
    ensure_ready(s, Want::Media(ids));
}

/// The Project panel's Isolate Voice for a media item with sound: the selected media when the item is one of them,
/// else the item.
pub fn media_menu_item(s: &mut Shell, ui: &mut egui::Ui, item: Id) {
    if !s.app.project().media(item).is_some_and(|m| m.audio.is_some()) {
        return;
    }
    if ui.button(tr("Isolate Voice")).clicked() {
        let picked = s.project.selected();
        let ids: Vec<Id> = if picked.contains(&item) {
            s.app.project().media.iter().map(|m| m.id).filter(|id| picked.contains(id)).collect()
        } else {
            vec![item]
        };
        isolate_media(s, &ids);
        ui.close();
    }
}

/// The Voice Isolation section of the Preferences' speech page (`settingsSection`): whether the model is here, its
/// Download…, and what Isolate Voice does; rows of the page's two-column grid.
pub fn settings_rows(s: &mut Shell, ui: &mut egui::Ui) {
    let n = need(&s.features.voice.backend);
    let ready = n.installed && n.runtime;
    ui.label(egui::RichText::new(tr("Voice Isolation")).strong());
    ui.end_row();
    ui.label("");
    ui.horizontal(|ui| {
        let name = [("name", backend::NAME)];
        ui.label(if ready {
            crate::i18n::trf("{name}: downloaded", &name)
        } else {
            crate::i18n::trf("{name}: not downloaded; it is downloaded when you first use it, after you agree", &name)
        });
        if !ready && s.features.voice.setup.is_none() && ui.button(tr("Download…")).clicked() {
            s.features.voice.setup = Some(Setup::new(Model::Voice, n.clone()));
        }
    });
    ui.end_row();
    ui.label("");
    ui.label(egui::RichText::new(tr("Isolate Voice (Automation menu, clip menu, project panel) keeps the speech of a clip and drops its music and noise. The new sound is a WAV in the Media folder of the Cut workspace; your files are never changed. It takes about 25 seconds per minute of sound on an 8-core CPU.")).weak());
    ui.end_row();
}

/// What the setup dialog lists, from the model's status.
fn need(b: &Backend) -> Need {
    let st = b.status();
    Need {
        name: backend::NAME,
        bytes: backend::BYTES,
        installed: st.installed,
        runtime: st.runtime,
        runtime_bytes: st.runtime_bytes,
    }
}

/// Runs `want` at once when the model is there, else after the setup dialog (`ensureReady`).
fn ensure_ready(s: &mut Shell, want: Want) {
    if s.features.auto.running() || running(s) || crate::speakers::running(s) {
        s.app.toast(tr("Another analysis is running."));
        return;
    }
    s.features.voice.backend.configure(s.doc.settings.get("ai.idleUnloadMinutes"));
    let n = need(&s.features.voice.backend);
    if n.installed && n.runtime {
        start(s, want);
        return;
    }
    s.features.voice.setup = Some(Setup::new(Model::Voice, n));
    s.features.voice.want = Some(want);
}

/// Whether the model is there for speech recognition with the voice isolated first (`readyToRecognise`); else the
/// setup dialog opens, and `goal` goes on from it once the model is downloaded.
pub fn ready_for_speech(s: &mut Shell, goal: &crate::speech::Goal) -> bool {
    s.features.voice.backend.configure(s.doc.settings.get("ai.idleUnloadMinutes"));
    let n = need(&s.features.voice.backend);
    if n.installed && n.runtime {
        return true;
    }
    s.features.voice.setup = Some(Setup::new(Model::Voice, n));
    s.features.voice.want = Some(Want::Speech(goal.clone()));
    false
}

/// The separation of `want`'s media on the analysis thread.
fn start(s: &mut Shell, want: Want) {
    let ids: Vec<Id> = match &want {
        Want::Clips { by_media, .. } => by_media.iter().map(|(m, _)| *m).collect(),
        Want::Media(ids) => ids.clone(),
        Want::Speech(goal) => {
            crate::speech::dialogs::recognise(s, goal.clone());
            return;
        }
    };
    let list: Vec<Source> = ids
        .iter()
        .filter_map(|id| {
            s.app.project().media(*id).filter(|m| m.audio.is_some()).map(|m| Source { id: *id, media: m.clone() })
        })
        .collect();
    let (home, backend, files) = (s.doc.home.clone(), s.features.voice.backend.clone(), isolate::temp_files());
    let job = Job::start(tr("Isolating voice…").into_owned(), false, move |step| {
        isolate::render_all(Tools { home: &home, backend: &backend, files: &files }, &list, step)
    });
    s.features.voice.job = Some(job);
    s.features.voice.plan = Some(want);
}

/// The progress box's title, fraction, pause and line while a separation runs.
pub fn progress_box(s: &Shell) -> Option<(String, f32, bool, Option<String>)> {
    let j = s.features.voice.job.as_ref()?;
    let line = (s.features.voice.backend.engine() == Engine::Loading)
        .then(|| tr("Loading the voice isolation model…").into_owned());
    Some((j.title.clone(), j.fraction(), j.paused(), line))
}

/// The progress box's Cancel.
pub fn cancel(s: &Shell) {
    if let Some(j) = &s.features.voice.job {
        j.cancel();
    }
}

/// The setup dialog and the separation's result, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    if let Some(out) = s.features.voice.job.as_ref().and_then(|j| j.poll(false)) {
        s.features.voice.job = None;
        let plan = s.features.voice.plan.take();
        match (out, plan) {
            (Ended::Done(made), Some(want)) => {
                let clips = match &want {
                    Want::Clips { seq, by_media } => Some((*seq, by_media.as_slice())),
                    Want::Media(_) | Want::Speech(_) => None,
                };
                let gone = clips.is_some_and(|(seq, _)| !s.app.project().sequences.iter().any(|q| q.id == seq));
                if !gone {
                    for x in &made {
                        if let Ok(e) = &x.probed.result {
                            let path = e["path"].as_str().unwrap_or_default();
                            let to = crate::speech::store::file_key_of(path, &e["size"], &e["mtime"]);
                            crate::speech::flow::carry_transcripts(s, x.media, &to);
                        }
                    }
                }
                if !gone && let Some(toast) = isolate::apply(&mut s.app, &made, clips) {
                    s.app.toast(toast);
                }
            }
            (Ended::Failed(e), _) => s.app.report(isolate::failure_text(&e)),
            (Ended::Cancelled, _) => s.app.toast(tr("The analysis was cancelled.")),
            (Ended::Done(_), None) => {}
        }
    }
    let Some(mut dialog) = s.features.voice.setup.take() else { return };
    let backend = s.features.voice.backend.clone();
    let wake = ctx.clone();
    let mut toasts = Vec::new();
    let outcome = dialog.show(ctx, &mut |t| toasts.push(t), &mut |d: &mut Setup| {
        let b = backend.clone();
        d.start(move |job, progress| b.setup(job, progress), wake.clone());
    });
    for t in toasts {
        s.app.toast(t);
    }
    match outcome {
        Outcome::Open => s.features.voice.setup = Some(dialog),
        Outcome::Ready => {
            if let Some(want) = s.features.voice.want.take() {
                start(s, want);
            }
        }
        Outcome::Closed => {
            if let Some(Want::Speech(goal)) = s.features.voice.want.take() {
                crate::speech::dialogs::declined(s, &goal);
            }
        }
    }
}
