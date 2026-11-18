//! The dialogs of speech recognition (`ui-speech.js`): Download Speech Recognition before the first use
//! (`ensureReady`), Auto Captions and Remove Filler Words with its preview on the timeline.

use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cut_model::Id;
use cut_sidecar::{Phase, Progress, SetupCode, SetupFailure};
use eframe::egui::{self, ProgressBar, RichText};
use serde_json::{Value as Json, json};

use super::engine::{Model, Report};
use super::flow::{self, in_out, speech_clips};
use super::text::{FillerOpts, filler_plan, parse_terms};
use super::{Goal, backend, format_bytes, opts, project_terms, set_setting, setting};
use crate::auto::silence::Overlay;
use crate::auto::{dialog, number};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// What went wrong with a setup, in plain words (`setupError`).
pub fn setup_error(f: &SetupFailure) -> String {
    match f.code {
        SetupCode::NoPython => tr("Python was not found on this PC. Speech recognition needs Python 3 (64-bit, from python.org) with PyTorch. Install Python and try again.").into_owned(),
        SetupCode::NoTorch => tr("PyTorch cannot be installed for the Python on this PC. Install a 64-bit Python 3.10 to 3.13 from python.org and try again.").into_owned(),
        SetupCode::Disk => trf("There is not enough free disk space. Free up space and try again ({detail}).", &[("detail", &f.error)]),
        SetupCode::Offline => tr("The download could not reach the internet. Check the connection and try again.").into_owned(),
        SetupCode::Busy => tr("The AI environment is in use by another Nano Studio window. Close it and try again.").into_owned(),
        SetupCode::Cancelled => tr("The download was cancelled.").into_owned(),
        SetupCode::Failed => trf("The download failed: {error}", &[("error", &f.error)]),
    }
}

/// A setup on its thread.
struct Running {
    rx: Receiver<Result<(), SetupFailure>>,
    last: Arc<Mutex<Option<Progress>>>,
}

/// The Download Speech Recognition dialog.
pub struct Setup {
    pub model: Model,
    pub model_missing: bool,
    pub runtime_missing: bool,
    /// A model already on this PC offered in the chosen one's place.
    pub other: Option<Model>,
    pub goal: Goal,
    running: Option<Running>,
    started: bool,
    /// The failure shown, with its code.
    pub error: Option<(SetupCode, String)>,
    tried: bool,
}

impl Setup {
    /// Whether a download runs.
    pub fn busy(&self) -> bool {
        self.running.is_some()
    }
}

/// Continues with `goal` once the model and the runtime are there: at once when they are, else after the Download
/// dialog (`ensureReady`). `model` given: that model (the Preferences' Download…); else the chosen one, and a model
/// already on this PC is offered in its place.
pub fn ensure_ready(s: &mut Shell, model: Option<&str>, goal: Goal) {
    let recognizing = model.is_none();
    let st = backend(s).status();
    let id = model.map_or_else(|| opts(s).model, str::to_owned);
    let (m, installed) = st.model(&id);
    if st.runtime && installed {
        go_on(s, goal);
        return;
    }
    let other = (recognizing && st.runtime)
        .then(|| st.models.iter().find(|(x, i)| x.id != m.id && *i).map(|(x, _)| *x))
        .flatten();
    s.features.speech.setup = Some(Setup {
        model: m,
        model_missing: !installed,
        runtime_missing: !st.runtime,
        other,
        goal,
        running: None,
        started: false,
        error: None,
        tried: false,
    });
}

/// Whisper is there: the voice model next when the voice is isolated first (`readyToRecognise`; a download from the
/// Preferences asks for Whisper alone), then [`recognise`].
pub fn go_on(s: &mut Shell, goal: Goal) {
    if goal == Goal::Download || (opts(s).isolate && !crate::voice::ready_for_speech(s, &goal)) {
        return;
    }
    recognise(s, goal);
}

/// Every model recognition needs is there: Label Speakers asks for its own model after them (as `label` does), then
/// the recognition runs.
pub fn recognise(s: &mut Shell, goal: Goal) {
    if let Goal::Speakers { count, .. } = goal
        && !crate::speakers::label::ready(s, count)
    {
        return;
    }
    if let Some((ids, range)) = goal.clips() {
        let ids = ids.to_vec();
        flow::start(s, ids, range, goal);
    }
}

/// A setup dialog before recognition was closed without its model: what waited for the words is dropped.
pub fn declined(s: &mut Shell, goal: &Goal) {
    if matches!(goal, Goal::Claude { .. }) {
        s.features.ai.notice.forget_after();
    }
}

fn start_setup(s: &mut Shell) {
    let speech = backend(s);
    let Some(d) = s.features.speech.setup.as_mut() else { return };
    let last: Arc<Mutex<Option<Progress>>> = Arc::default();
    let l = last.clone();
    let report: Report = Arc::new(move |p: Progress| {
        if p.phase == Phase::Runtime || (p.phase == Phase::Download && p.fraction.is_some()) || p.phase == Phase::Done {
            *l.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
        }
    });
    let (tx, rx) = channel();
    let model = d.model.id;
    std::thread::spawn(move || {
        let _ = tx.send(speech.setup(model, &report, &cut_decode::disk::free_space));
    });
    d.running = Some(Running { rx, last });
    d.started = true;
    d.error = None;
}

fn setup_window(s: &mut Shell, ctx: &egui::Context) {
    let Some(d) = s.features.speech.setup.as_mut() else { return };
    if let Some(r) = &d.running
        && let Ok(out) = r.rx.try_recv()
    {
        d.running = None;
        match out {
            Ok(()) => {
                let Some(d) = s.features.speech.setup.take() else { return };
                s.app.toast(trf("{name} is ready.", &[("name", d.model.name)]));
                go_on(s, d.goal);
                return;
            }
            Err(f) => {
                d.error = Some((f.code, setup_error(&f)));
                d.tried = true;
            }
        }
    }
    let Some(d) = s.features.speech.setup.as_ref() else { return };
    if d.busy() {
        ctx.request_repaint_after(Duration::from_millis(100));
    }
    let (m, busy) = (d.model, d.busy());
    let last = d.running.as_ref().and_then(|r| r.last.lock().unwrap_or_else(|e| e.into_inner()).clone());
    let (mut go, mut use_other, mut cancel) = (false, false, false);
    // a modal: the Preferences (a modal too) opens it with Download…
    egui::Modal::new(egui::Id::unique("cutSpeechSetup")).show(ctx, |ui| {
        ui.set_width(480.0);
        ui.heading(tr("Download Speech Recognition"));
        ui.label(trf(
            "Speech recognition uses the {name} model from OpenAI. It runs entirely on this PC: the sound is never sent anywhere.",
            &[("name", m.name)],
        ));
        if d.model_missing {
            ui.label(format!("• {}", trf("{name} model: about {size}", &[("name", m.name), ("size", &format_bytes(m.bytes))])));
        }
        if d.runtime_missing {
            ui.label(format!(
                "• {}",
                trf(
                    "The AI runtime (Python packages PyTorch and Transformers, shared with the other Nano Studio AI features): up to about {size}, less when Python already has PyTorch",
                    &[("size", &format_bytes(super::engine::RUNTIME_BYTES))],
                )
            ));
        }
        ui.label(tr("Nothing is downloaded until you press Download. It is downloaded once; after that, recognition works offline."));
        if let Some(o) = d.other {
            ui.label(trf("{name} is already on this PC: use it to recognize speech now, with nothing to download.", &[("name", o.name)]));
        }
        if d.started {
            let (fraction, line) = match &last {
                None if busy => (None, tr("Starting…").into_owned()),
                Some(p) if p.phase == Phase::Runtime => (
                    None,
                    match &p.text {
                        Some(t) => trf("Setting up the AI runtime… {line}", &[("line", t)]),
                        None => tr("Setting up the AI runtime…").into_owned(),
                    },
                ),
                Some(p) => {
                    let f = p.fraction.unwrap_or(1.0);
                    let line = trf(
                        "Downloading {name}… {p}% of {size}",
                        &[
                            ("name", m.name),
                            ("p", &super::text::js_round(f * 100.0).to_string()),
                            ("size", &format_bytes(p.bytes.unwrap_or(m.bytes))),
                        ],
                    );
                    (Some(f), line)
                }
                None => (Some(0.0), String::new()),
            };
            let bar = match fraction {
                Some(f) => ProgressBar::new(f as f32),
                None => ProgressBar::new(0.0).animate(true),
            };
            ui.add(bar.desired_width(440.0));
            if busy {
                ui.label(line);
            }
        }
        if let Some((_, e)) = &d.error {
            ui.label(RichText::new(e).color(egui::Color32::from_rgb(0xe5, 0x48, 0x4d)));
        }
        ui.horizontal(|ui| {
            let label = if d.tried { tr("Try Again") } else { tr("Download") };
            go = ui.add_enabled(!busy, egui::Button::new(label)).clicked();
            if let Some(o) = d.other {
                use_other = ui.button(trf("Use {name}", &[("name", o.name)])).clicked() && !busy;
            }
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if go {
        start_setup(s);
    } else if use_other {
        if let Some(d) = s.features.speech.setup.take()
            && let Some(o) = d.other
        {
            set_setting(s, "speech.model", json!(o.id));
            go_on(s, d.goal);
        }
    } else if cancel && let Some(d) = s.features.speech.setup.take() {
        if d.busy() {
            backend(s).cancel_setup();
        }
        declined(s, &d.goal);
    }
}

/// The Auto Captions dialog's choices.
pub struct CaptionsForm {
    pub ids: Vec<Id>,
    pub range: Option<(f64, f64)>,
    pub scope: &'static str,
    pub language: String,
    pub chars: f64,
    pub terms: String,
    pub highlight: bool,
    /// Isolate the voice first.
    pub isolate: bool,
    /// How the captions show speakers, when the project has speaker labels (`captionField`).
    pub speakers: Option<&'static str>,
}

/// Auto Captions… chosen: the dialog, unless no clip speaks.
pub fn open_captions(s: &mut Shell) {
    let ids = speech_clips(&s.app);
    let Some(seq) = s.app.sequence().filter(|_| !ids.is_empty()) else {
        s.app.toast(tr("There are no clips with speech to transcribe."));
        return;
    };
    let range = in_out(&s.app);
    let picked = seq.clips().any(|c| s.app.selection.contains(&c.id));
    let scope = if range.is_some() {
        "From In to Out"
    } else if picked {
        "The selected clips"
    } else {
        "The whole sequence"
    };
    let name = tr("Auto Captions");
    let shown = seq.captions.iter().find(|t| t.name == name);
    let highlight = match shown {
        Some(t) => t.style.get("highlight").and_then(Json::as_bool).unwrap_or(false),
        None => setting(s, "speech.highlight").as_bool().unwrap_or(false),
    };
    s.features.speech.captions = Some(CaptionsForm {
        ids,
        range,
        scope,
        language: super::language(s),
        chars: super::line_chars(s),
        terms: project_terms(s).join("\n"),
        highlight,
        isolate: opts(s).isolate,
        speakers: crate::speakers::label::caption_mode(s),
    });
}

/// The language choices (`languageOptions`).
pub const LANGUAGES: [(&str, &str); 3] = [("auto", "Detect automatically"), ("ko", "Korean"), ("en", "English")];

/// A language field.
pub fn language_box(ui: &mut egui::Ui, id: &str, value: &mut String) -> bool {
    let shown = LANGUAGES.iter().find(|(v, _)| *v == value).map_or(LANGUAGES[0].1, |l| l.1);
    let mut changed = false;
    egui::ComboBox::from_id_salt(id).icon(crate::theme::combo_icon).selected_text(tr(shown)).show_ui(ui, |ui| {
        for (v, label) in LANGUAGES {
            if ui.selectable_label(value == v, tr(label)).clicked() && value != v {
                *value = v.to_owned();
                changed = true;
            }
        }
    });
    changed
}

/// The project's word list set to `terms`, one undo step when it changed -> false when that failed.
pub fn set_terms(s: &mut Shell, terms: &[String]) -> bool {
    if project_terms(s) == terms {
        return true;
    }
    s.app.exec(&cut_model::commands::build::set_settings(json!({ "speechTerms": terms }))).is_some()
}

fn captions_window(s: &mut Shell, ctx: &egui::Context) {
    let model = {
        let st = backend(s).status();
        st.model(&opts(s).model).0.name
    };
    let Some(f) = s.features.speech.captions.as_mut() else { return };
    let (mut go, mut cancel, mut speakers_mode) = (false, false, None);
    dialog("Auto Captions", "cutSpeechCaptions", 460.0).show(ctx, |ui| {
        ui.set_max_width(460.0);
        ui.label(trf(
            "{scope}: {n} clips with speech. Captions of up to two lines, at most 6 seconds each, split at pauses and sentence ends.",
            &[("scope", &tr(f.scope)), ("n", &f.ids.len().to_string())],
        ));
        egui::Grid::new("cut-speech-captions").num_columns(2).show(ui, |ui| {
            ui.label(tr("Language"));
            language_box(ui, "cut-speech-language", &mut f.language);
            ui.end_row();
            ui.label(tr("Characters per line"));
            ui.horizontal(|ui| {
                ui.add(egui::DragValue::new(&mut f.chars).range(0.0..=80.0).speed(1.0).fixed_decimals(0));
                ui.label(RichText::new(tr("0: 18 for Korean, 42 otherwise")).weak());
            });
            ui.end_row();
            ui.label(tr("Word list"));
            ui.add(egui::TextEdit::multiline(&mut f.terms).desired_rows(3).hint_text(tr("One per line or separated by commas")));
            ui.end_row();
        });
        ui.label(RichText::new(tr("Names, products and terms that are spoken. Whisper is told of them, so it writes them the way you spell them here. Saved with the project.")).weak());
        ui.checkbox(&mut f.isolate, tr("Isolate the voice first (HTDemucs): for speech over music; it makes steady noise worse, and takes about a sixth longer"));
        ui.checkbox(&mut f.highlight, tr("Highlight each word as it is spoken"));
        if let Some(mode) = f.speakers.as_mut() {
            let was = *mode;
            crate::speakers::label::style_row(ui, mode);
            if *mode != was {
                speakers_mode = Some(*mode);
            }
        }
        ui.label(trf("Model: {name}. It runs on this PC.", &[("name", model)]));
        ui.horizontal(|ui| {
            go = ui.button(tr("Create Captions")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if let Some(mode) = speakers_mode {
        set_setting(s, "speakers.captions", json!(mode));
    }
    if cancel {
        s.features.speech.captions = None;
    } else if go && let Some(f) = s.features.speech.captions.take() {
        create_captions(s, f);
    }
}

/// Create Captions pressed: the choices kept, the word list set, then recognition and the captions.
pub fn create_captions(s: &mut Shell, f: CaptionsForm) {
    let chars = f.chars.round().clamp(0.0, 80.0);
    if f.isolate != opts(s).isolate {
        set_setting(s, "speech.isolateVoice", json!(f.isolate));
    }
    if f.highlight != setting(s, "speech.highlight").as_bool().unwrap_or(false) {
        set_setting(s, "speech.highlight", json!(f.highlight));
    }
    if f.language != super::language(s) {
        set_setting(s, "speech.language", json!(f.language));
    }
    if chars != super::line_chars(s) {
        set_setting(s, "speech.lineChars", json!(chars as i64));
    }
    if !set_terms(s, &parse_terms(&f.terms)) {
        return;
    }
    ensure_ready(s, None, Goal::Captions { ids: f.ids, range: f.range, chars, highlight: f.highlight });
}

/// The Remove Filler Words dialog's state.
pub struct FillersForm {
    pub ids: Vec<Id>,
    pub range: Option<(f64, f64)>,
    pub o: FillerOpts,
}

/// The remembered settings of Remove Filler Words (`cut.auto.fillers`) over the defaults.
pub fn filler_settings(s: &Shell) -> FillerOpts {
    let d = FillerOpts::default();
    let saved = s.doc.settings.get("auto.fillers");
    let num =
        |k: &str, v: f64| saved.and_then(|m| m.get(k)).and_then(Json::as_f64).filter(|x| x.is_finite()).unwrap_or(v);
    let flag = |k: &str, v: bool| saved.and_then(|m| m.get(k)).and_then(Json::as_bool).unwrap_or(v);
    FillerOpts {
        fillers: flag("fillers", d.fillers),
        pauses: flag("pauses", d.pauses),
        pause_length: num("pauseLength", d.pause_length),
        keep: num("keep", d.keep),
    }
}

/// After recognition: the dialog with its preview.
pub fn open_fillers(s: &mut Shell, ids: Vec<Id>, range: Option<(f64, f64)>) {
    let o = filler_settings(s);
    s.features.speech.fillers = Some(FillersForm { ids, range, o });
}

/// The plan of the dialog's settings now, and the tracks it changes.
pub fn fillers_plan(
    s: &mut Shell,
    f_ids: &[Id],
    range: Option<(f64, f64)>,
    o: &FillerOpts,
) -> (super::text::FillerPlan, Vec<Id>, Vec<Id>) {
    let st = super::store(s);
    let so = opts(s);
    let Some(seq) = s.app.sequence() else { return Default::default() };
    let now: Vec<Id> = f_ids.iter().copied().filter(|id| seq.clip(*id).is_some()).collect();
    let words = {
        let g = st.lock().unwrap_or_else(|e| e.into_inner());
        flow::timeline_words(&s.app, &g, &so, &now, range)
    };
    let frame = cut_model::query::frame(seq.fps) as f64;
    let (_, changed) = crate::auto::silence::ripple_tracks(seq, &now);
    (filler_plan(&words, o, frame), now, changed)
}

/// Remove pressed: the settings kept and the ranges ripple-deleted in one step.
pub fn remove_fillers(s: &mut Shell) -> bool {
    let Some(f) = s.features.speech.fillers.take() else { return false };
    s.timeline.overlay = None;
    let o = f.o;
    set_setting(
        s,
        "auto.fillers",
        json!({ "fillers": o.fillers, "pauses": o.pauses, "pauseLength": o.pause_length, "keep": o.keep }),
    );
    let (p, now, _) = fillers_plan(s, &f.ids, f.range, &o);
    if p.ranges.is_empty() {
        s.app.toast(tr("No filler words or long pauses were found."));
        return false;
    }
    let ok = flow::ripple(s, &p.ranges, &now, "Remove Filler Words");
    if ok {
        s.app.selection.clear();
        s.app.toast(trf(
            "Removed {n} cuts ({time}).",
            &[("n", &p.ranges.len().to_string()), ("time", &flow::removed(&p.ranges))],
        ));
    }
    ok
}

fn fillers_window(s: &mut Shell, ctx: &egui::Context) {
    let Some(f) = s.features.speech.fillers.as_ref() else { return };
    let (ids, range, mut o) = (f.ids.clone(), f.range, f.o);
    let (p, _, changed) = fillers_plan(s, &ids, range, &o);
    s.timeline.overlay = Some(Overlay { ranges: p.ranges.clone(), tracks: Some(changed) });
    let (mut go, mut cancel) = (false, false);
    dialog("Remove Filler Words", "cutSpeechFillers", 460.0).show(ctx, |ui| {
        ui.set_max_width(460.0);
        ui.label(tr("Hesitations (Korean 음, 어, 으음; 그, 저, 뭐 when a pause follows; English um, uh, er, ah, hmm) and long pauses between words are ripple-deleted from their tracks and the tracks linked to them."));
        ui.checkbox(&mut o.fillers, tr("Filler words"));
        ui.checkbox(&mut o.pauses, tr("Pauses between words"));
        egui::Grid::new("cut-speech-fillers").num_columns(2).show(ui, |ui| {
            ui.label(tr("Pauses longer than"));
            number(ui, &mut o.pause_length, (0.3, 10.0, 0.1), 1, "s");
            ui.end_row();
            ui.label(tr("Keep on each side"));
            number(ui, &mut o.keep, (0.0, 1.0, 0.05), 2, "s");
            ui.end_row();
        });
        ui.label(if p.ranges.is_empty() {
            tr("No filler words or long pauses were found.").into_owned()
        } else {
            trf(
                "Fillers: {f} · long pauses: {p} · {time} removed",
                &[("f", &p.fillers.len().to_string()), ("p", &p.pauses.len().to_string()), ("time", &flow::removed(&p.ranges))],
            )
        });
        ui.horizontal(|ui| {
            go = ui.button(tr("Remove")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if let Some(f) = s.features.speech.fillers.as_mut() {
        f.o = o;
    }
    if go {
        remove_fillers(s);
    } else if cancel {
        s.features.speech.fillers = None;
        s.timeline.overlay = None;
    }
}

/// Word List… (the Transcript panel, `editTerms`): the project's list alone, for the next recognition.
pub fn open_terms(s: &mut Shell) {
    s.features.speech.terms = Some(project_terms(s).join("\n"));
}

fn terms_window(s: &mut Shell, ctx: &egui::Context) {
    let Some(text) = s.features.speech.terms.as_mut() else { return };
    let (mut ok, mut cancel) = (false, false);
    dialog("Word List", "cutSpeechTerms", 460.0).show(ctx, |ui| {
        ui.set_max_width(460.0);
        ui.horizontal(|ui| {
            ui.label(tr("Word list"));
            ui.add(egui::TextEdit::multiline(text).desired_rows(3).hint_text(tr("One per line or separated by commas")));
        });
        ui.label(RichText::new(tr("Names, products and terms that are spoken. Whisper is told of them, so it writes them the way you spell them here. Saved with the project.")).weak());
        ui.label(RichText::new(tr("Speech already recognized is recognized again with the new list the next time you transcribe or create captions.")).weak());
        ui.horizontal(|ui| {
            ok = ui.button(tr("OK")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if ok && let Some(text) = s.features.speech.terms.take() {
        set_terms(s, &parse_terms(&text));
    } else if cancel {
        s.features.speech.terms = None;
    }
}

/// The dialogs, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    setup_window(s, ctx);
    captions_window(s, ctx);
    fillers_window(s, ctx);
    terms_window(s, ctx);
}
