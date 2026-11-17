//! Speaker labels (`ui-speakers.js`, `speakers.js`, `main/cut/speakers.js`): who speaks when, on the transcripts of
//! speech recognition. The labels are the project's (`project.speakers`, one undo step per change, saved with it), in
//! source seconds per media file, so trims and moves keep them.
//!
//! The pure half is [`core`]; the model is [`backend`] (WeSpeaker in the Python server, or the fake of the tests);
//! the embeddings of a media file's windows are cached in the workspace's cache ([`embed`]); Label Speakers, the
//! changes by hand and what captions take from the labels are [`label`].
//!
//! Threads: embedding and clustering run on the analysis thread under the automation's progress box (one analysis
//! at a time); the setup on a thread of its own; the project changes on the UI thread.

pub mod backend;
pub mod core;
pub mod embed;
pub mod label;
pub mod row;

use std::sync::Arc;

use eframe::egui;

use self::backend::Backend;
use crate::auto::Job;
use crate::shell::Shell;
use crate::voice::setup::Setup;

/// Speaker labels' state: the model, the embeddings of this session, the setup dialog and the one labelling that may
/// run.
pub struct SpeakersUi {
    pub backend: Arc<Backend>,
    pub memory: embed::Memory,
    pub setup: Option<Setup>,
    pub job: Option<Job<Option<label::Labelled>>>,
    /// The rename dialog: the speaker and the name typed.
    pub rename: Option<(String, String)>,
    /// The count to label with once the setup is done, and the count the running labelling uses.
    want: Option<u32>,
    count: u32,
}

impl Default for SpeakersUi {
    fn default() -> Self {
        SpeakersUi {
            backend: Backend::from_env(),
            memory: embed::Memory::default(),
            setup: None,
            job: None,
            rename: None,
            want: None,
            count: 0,
        }
    }
}

/// `Some(can run now)` for Label Speakers.
pub fn enabled(_s: &Shell, id: &str) -> Option<bool> {
    (id == "auto.speakers").then_some(true)
}

/// Runs Label Speakers from the menus -> whether `id` was it.
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    if id != "auto.speakers" {
        return false;
    }
    label::start(s, None);
    true
}

/// Whether a labelling runs.
pub fn running(s: &Shell) -> bool {
    s.features.speakers.job.is_some()
}

/// The progress box's title, fraction, pause and line while a labelling runs.
pub fn progress_box(s: &Shell) -> Option<(String, f32, bool, Option<String>)> {
    let j = s.features.speakers.job.as_ref()?;
    Some((j.title.clone(), j.fraction(), j.paused(), None))
}

/// The progress box's Cancel.
pub fn cancel(s: &Shell) {
    if let Some(j) = &s.features.speakers.job {
        j.cancel();
    }
}

/// The dialogs and the labelling's result, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    label::windows(s, ctx);
}
