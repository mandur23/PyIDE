//! The dialog before a local model's first download (`ensureReady` of `ui-speakers.js` and `ui-voice.js`): what is
//! downloaded and how large, that it runs on this PC, and nothing before Download is pressed; then its progress, the
//! failure explained by its code with Try Again, or the model ready. Speaker labels and voice isolation share it.
//!
//! Threads: the setup runs on a thread of its own; the dialog takes its progress each frame. Closing the dialog while
//! it runs cancels it.

use std::sync::mpsc::{Receiver, Sender, channel};

use cut_sidecar::{Job, Phase, Progress, SetupCode, SetupFailure};
use eframe::egui::{self, ProgressBar, RichText};

use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;

/// Which model the dialog is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    Speakers,
    Voice,
}

/// What the dialog shows of the model before anything runs.
#[derive(Debug, Clone, PartialEq)]
pub struct Need {
    pub name: &'static str,
    pub bytes: f64,
    pub installed: bool,
    pub runtime: bool,
    pub runtime_bytes: f64,
}

/// A message of the setup's thread.
pub enum Msg {
    Progress(Progress),
    Done(Result<(), SetupFailure>),
}

/// What a frame of the dialog ended with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Open,
    /// The model and its runtime are there: the action goes on.
    Ready,
    /// Closed without them.
    Closed,
}

/// The dialog's state.
pub struct Setup {
    pub model: Model,
    pub need: Need,
    running: Option<(Job, Receiver<Msg>)>,
    started: bool,
    line: String,
    fraction: Option<f64>,
    /// The failure shown, with its code.
    pub error: Option<(SetupCode, String)>,
}

impl Setup {
    pub fn new(model: Model, need: Need) -> Setup {
        Setup { model, need, running: None, started: false, line: String::new(), fraction: None, error: None }
    }

    /// Whether a download runs now.
    pub fn busy(&self) -> bool {
        self.running.is_some()
    }

    /// The id the JavaScript gives the dialog (`cutSpeakersSetup`, `cutVoiceSetup`).
    pub fn id(&self) -> &'static str {
        match self.model {
            Model::Speakers => "cutSpeakersSetup",
            Model::Voice => "cutVoiceSetup",
        }
    }

    fn title(&self) -> String {
        match self.model {
            Model::Speakers => tr("Download Speaker Labels").into_owned(),
            Model::Voice => tr("Download Voice Isolation").into_owned(),
        }
    }

    fn intro(&self) -> String {
        let name = [("name", self.need.name)];
        match self.model {
            Model::Speakers => trf(
                "Speaker labels use the {name} model (WeSpeaker, trained on VoxCeleb). It runs entirely on this PC: the sound is never sent anywhere.",
                &name,
            ),
            Model::Voice => trf(
                "Voice isolation separates speech from music and noise with the {name} model from Meta. It runs entirely on this PC: the sound is never sent anywhere.",
                &name,
            ),
        }
    }

    /// The lines of what is downloaded.
    pub fn items(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.need.installed {
            out.push(trf(
                "{name} model: about {size}",
                &[("name", self.need.name), ("size", &crate::speech::format_bytes(self.need.bytes))],
            ));
        }
        if !self.need.runtime {
            let size = crate::speech::format_bytes(self.need.runtime_bytes);
            out.push(match self.model {
                Model::Speakers => trf(
                    "ONNX Runtime for the AI environment (shared with the other Nano Studio AI features): up to about {size}",
                    &[("size", &size)],
                ),
                Model::Voice => trf(
                    "Python packages for it (Demucs, and PyTorch when Python does not have it yet, shared with the other Nano Studio AI features): up to about {size}",
                    &[("size", &size)],
                ),
            });
        }
        out
    }

    fn nothing(&self) -> String {
        match self.model {
            Model::Speakers => tr(
                "Nothing is downloaded until you press Download. It is downloaded once; after that, speaker labels work offline.",
            ),
            Model::Voice => tr(
                "Nothing is downloaded until you press Download. It is downloaded once; after that, voice isolation works offline.",
            ),
        }
        .into_owned()
    }

    /// A failure explained (`setupError`).
    pub fn error_text(&self, code: SetupCode, error: &str) -> String {
        match code {
            SetupCode::NoPython => match self.model {
                Model::Speakers => tr(
                    "Python was not found on this PC. Speaker labels need Python 3 (64-bit, from python.org). Install Python and try again.",
                ),
                Model::Voice => tr(
                    "Python was not found on this PC. Voice isolation needs Python 3 (64-bit, from python.org) with PyTorch. Install Python and try again.",
                ),
            }
            .into_owned(),
            SetupCode::NoTorch if self.model == Model::Voice => tr(
                "PyTorch cannot be installed for the Python on this PC. Install a 64-bit Python 3.10 to 3.13 from python.org and try again.",
            )
            .into_owned(),
            SetupCode::Disk => {
                trf("There is not enough free disk space. Free up space and try again ({detail}).", &[("detail", error)])
            }
            SetupCode::Offline => tr("The download could not reach the internet. Check the connection and try again.").into_owned(),
            SetupCode::Busy => {
                tr("The AI environment is in use by another Nano Studio window. Close it and try again.").into_owned()
            }
            SetupCode::Cancelled => tr("The download was cancelled.").into_owned(),
            _ => {
                let e = if error.is_empty() { tr("unknown error").into_owned() } else { error.to_owned() };
                trf("The download failed: {error}", &[("error", &e)])
            }
        }
    }

    fn on_progress(&mut self, p: &Progress) {
        let name = self.need.name;
        match p.phase {
            Phase::Runtime => {
                self.line = match &p.text {
                    Some(t) => trf("Setting up the AI runtime… {line}", &[("line", t)]),
                    None => tr("Setting up the AI runtime…").into_owned(),
                };
                self.fraction = None;
            }
            Phase::Download => {
                let size = crate::speech::format_bytes(p.bytes.unwrap_or(self.need.bytes));
                match self.model {
                    Model::Speakers => {
                        self.line = trf("Downloading {name}… {size}", &[("name", name), ("size", &size)]);
                        self.fraction = p.fraction;
                    }
                    Model::Voice => {
                        if let Some(f) = p.fraction {
                            let pct = cut_audio::util::js_round(f * 100.0).to_string();
                            self.line = trf(
                                "Downloading {name}… {p}% of {size}",
                                &[("name", name), ("p", &pct), ("size", &size)],
                            );
                            self.fraction = Some(f);
                        }
                    }
                }
            }
            Phase::Done => {}
        }
    }

    /// The fraction of the download shown, `None` while it runs without one or before it starts.
    pub fn fraction(&self) -> Option<f64> {
        self.fraction
    }

    /// Download pressed: `run` is the setup, on a thread of its own.
    pub fn start(
        &mut self,
        run: impl FnOnce(&Job, &(dyn Fn(Progress) + Sync)) -> Result<(), SetupFailure> + Send + 'static,
        wake: egui::Context,
    ) {
        let (tx, rx): (Sender<Msg>, Receiver<Msg>) = channel();
        let job = Job::new(|_| {});
        let j = job.clone();
        std::thread::spawn(move || {
            let tx = std::sync::Mutex::new(tx);
            let progress = |p: Progress| {
                let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(Msg::Progress(p));
                wake.request_repaint();
            };
            let r = run(&j, &progress);
            let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(Msg::Done(r));
            wake.request_repaint();
        });
        self.running = Some((job, rx));
        self.started = true;
        self.error = None;
        self.line = tr("Starting…").into_owned();
        self.fraction = None;
    }

    /// Takes in the setup's messages -> `Some(result)` once it ended.
    fn poll(&mut self) -> Option<Result<(), SetupFailure>> {
        let mut done = None;
        if let Some((_, rx)) = &self.running {
            let msgs: Vec<Msg> = rx.try_iter().collect();
            for m in msgs {
                match m {
                    Msg::Progress(p) => self.on_progress(&p),
                    Msg::Done(r) => done = Some(r),
                }
            }
        }
        if done.is_some() {
            self.running = None;
        }
        done
    }

    /// Closes the dialog: a download that runs is cancelled.
    pub fn close(&mut self) {
        if let Some((job, _)) = self.running.take() {
            job.cancel();
        }
    }

    /// The dialog, each frame; `start` is called when Download is pressed. A finished download toasts through
    /// `toast`.
    pub fn show(
        &mut self,
        ctx: &egui::Context,
        toast: &mut dyn FnMut(String),
        start: &mut dyn FnMut(&mut Setup),
    ) -> Outcome {
        match self.poll() {
            Some(Ok(())) => {
                toast(trf("{name} is ready.", &[("name", self.need.name)]));
                return Outcome::Ready;
            }
            Some(Err(e)) => {
                self.line.clear();
                self.error = Some((e.code, self.error_text(e.code, &e.error)));
            }
            None => {}
        }
        if self.busy() {
            ctx.request_repaint_after(std::time::Duration::from_millis(50));
        }
        let (mut go, mut cancel, mut open) = (false, false, true);
        egui::Window::new(self.title())
            .id(egui::Id::unique(self.id()))
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, egui::Vec2::ZERO)
            .default_width(480.0)
            .show_titled(ctx, self.title(), Some(&mut open), |ui| {
                ui.set_max_width(480.0);
                ui.label(self.intro());
                for item in self.items() {
                    ui.label(format!("•  {item}"));
                }
                ui.label(self.nothing());
                if self.started {
                    let bar = match self.fraction {
                        Some(f) => ProgressBar::new(f as f32),
                        None => ProgressBar::new(0.0).animate(self.busy()),
                    };
                    ui.add(bar.desired_width(440.0));
                }
                if !self.line.is_empty() {
                    ui.label(&self.line);
                }
                if let Some((_, text)) = &self.error {
                    ui.label(RichText::new(text).color(egui::Color32::from_rgb(0xe5, 0x73, 0x73)));
                }
                ui.horizontal(|ui| {
                    let label = if self.error.is_some() { tr("Try Again") } else { tr("Download") };
                    go = ui.add_enabled(!self.busy(), egui::Button::new(label)).clicked();
                    cancel = ui.button(tr("Cancel")).clicked();
                });
            });
        if go {
            start(self);
        }
        if cancel || !open {
            self.close();
            return Outcome::Closed;
        }
        Outcome::Open
    }
}
