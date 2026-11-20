//! Edit Command (`ui-ai.js`'s `editCommand`, `previewPlan`; Ctrl+J): a request in plain words; Claude answers with a
//! plan of whitelisted operations ([`super::plan`]); the silences a `removeSilence` needs are measured on this PC; the
//! plan is previewed (its cuts shaded on the timeline), checked again against the sequence as it is then, and applied
//! as one undo step.

use cut_audio::analysis::union;
use cut_formats::table::js_round;
use cut_model::Role;
use cut_model::commands::build as C;
use eframe::egui::{self, RichText};

use super::ask::{Question, Why};
use super::captions::{Condensed, SYSTEM, condense, segments_from_captions};
use super::js::T;
use super::plan::{Context, Op, Plan, command_prompt, describe_plan, plan_commands, sequence_summary, validate_plan};
use crate::auto::levels::{self, Read};
use crate::auto::silence::{Overlay, Plan as Silence, Silence as Settings};
use crate::auto::{Job, Outcome, dialog};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;

/// A plan waiting for its preview: the request, the plan and the prompt's words.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    pub request: String,
    pub plan: Plan,
    pub condensed: Option<Condensed>,
}

/// The preview: the plan with the silences measured for its `removeSilence` operations.
#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub planned: Planned,
    pub silence: Vec<Option<Silence>>,
}

/// The dialogs' state.
#[derive(Default)]
pub struct CommandAi {
    /// The request being typed.
    pub form: Option<String>,
    last: String,
    /// Claude's note when it planned nothing.
    pub empty: Option<String>,
    pub preview: Option<Preview>,
    measuring: Option<(Job<levels::Measured>, Planned, Vec<cut_model::Id>)>,
}

/// Edit Command… chosen: its dialog.
pub fn open(s: &mut Shell) {
    if !s.app.sequence().is_some_and(|q| q.clip_count() > 0) {
        s.app.toast(tr("The sequence is empty."));
        return;
    }
    s.features.ai.command.form = Some(s.features.ai.command.last.clone());
}

/// Ask Claude pressed -> whether the dialog closed (an empty request keeps it open).
pub fn ask(s: &mut Shell) -> bool {
    let Some(text) = s.features.ai.command.form.clone() else { return true };
    let request = super::js::trim(&text).to_owned();
    if request.is_empty() {
        return false;
    }
    s.features.ai.command.form = None;
    s.features.ai.command.last.clone_from(&request);
    let Some(seq) = s.app.sequence() else { return true };
    let ctx0 = Context::of(seq, &s.app.selection);
    let shown = crate::captions::shown(s);
    let condensed = seq
        .captions
        .iter()
        .find(|t| Some(t.id) == shown && !t.items.is_empty())
        .map(|t| condense(&segments_from_captions(&t.items), 12000, 200));
    let transcript = condensed.as_ref().map_or(String::new(), |c| c.text.clone());
    let summary = sequence_summary(s.app.project(), seq, &ctx0.selection, 150);
    let prompt = command_prompt(&request, &summary, &transcript);
    super::job(s, "Planning the edit with Claude…", move |ctx| {
        let q = Question { task: "command", system: SYSTEM, prompt, part: (0.0, 1.0), expect: 600.0, label: None };
        let plan = ctx.ask(q, |v| validate_plan(v, &ctx0))?;
        Ok(Box::new(move |s: &mut Shell| planned(s, Planned { request, plan, condensed })))
    });
    true
}

/// The clips whose silences a `removeSilence` measures (`measureSilence` with `speech`): the clips with sound, the
/// speech ones of them when nothing is selected.
fn speech_clips(s: &Shell) -> Vec<cut_model::Id> {
    let all = crate::audio::essential::sound_clips(&s.app, true);
    let Some(seq) = s.app.sequence() else { return Vec::new() };
    let picked = s.app.selection.iter().any(|id| seq.clip(*id).is_some());
    let not_speech = |r: Option<Role>| matches!(r, Some(Role::Music | Role::Effects | Role::Ambience));
    let talk: Vec<cut_model::Id> = if picked {
        all.clone()
    } else {
        all.iter().copied().filter(|id| seq.clip(*id).is_some_and(|c| !not_speech(c.role))).collect()
    };
    if talk.is_empty() { all } else { talk }
}

fn planned(s: &mut Shell, p: Planned) {
    if p.plan.ops.is_empty() {
        s.features.ai.command.empty = Some(p.plan.message);
        return;
    }
    if !p.plan.ops.iter().any(|o| matches!(o, Op::RemoveSilence { .. })) {
        preview(s, p, Vec::new());
        return;
    }
    let clips = speech_clips(s);
    if clips.is_empty() {
        measured(s, p, &clips);
        return;
    }
    let Some(seq) = s.app.sequence() else { return };
    let reads: Vec<Read> = clips
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter_map(|c| Read::of(s.app.project(), c))
        .filter(|r| s.features.auto.levels.get(&r.key).is_none())
        .collect();
    let job =
        Job::start(tr("Analyzing the sound…").into_owned(), false, move |step| levels::measure_all(&reads, step));
    s.features.ai.command.measuring = Some((job, p, clips));
}

fn measured(s: &mut Shell, p: Planned, clips: &[cut_model::Id]) {
    let silence = p
        .plan
        .ops
        .iter()
        .map(|o| match o {
            Op::RemoveSilence { longer_than, threshold } => {
                let o = Settings { threshold: threshold.unwrap_or(-40.0), min_length: *longer_than, margin: 0.1 };
                Some(if clips.is_empty() {
                    Silence::default()
                } else {
                    crate::auto::silence::plan(&s.app, clips, o, &s.features.auto.levels)
                })
            }
            _ => None,
        })
        .collect();
    preview(s, p, silence);
}

/// The preview opens: the plan's cuts and silences shaded on the timeline.
pub fn preview(s: &mut Shell, planned: Planned, silence: Vec<Option<Silence>>) {
    if let Some(seq) = s.app.sequence() {
        let f = cut_model::query::frame(seq.fps) as f64;
        let tk = |x: f64| js_round((x * T) / f) * f;
        let cuts: Vec<(f64, f64)> = planned
            .plan
            .ops
            .iter()
            .filter_map(|o| if let Op::Cut { from, to } = o { Some((tk(*from), tk(*to))) } else { None })
            .collect();
        let quiet: Vec<&Silence> = silence.iter().flatten().collect();
        let mut all = cuts.clone();
        all.extend(quiet.iter().flat_map(|r| r.ranges.iter().copied()));
        let gone = union(&all);
        if !gone.is_empty() {
            let tracks = if cuts.is_empty() {
                let mut t: Vec<cut_model::Id> = Vec::new();
                for r in &quiet {
                    for id in if r.changed.is_empty() { &r.tracks } else { &r.changed } {
                        if !t.contains(id) {
                            t.push(*id);
                        }
                    }
                }
                t
            } else {
                seq.tracks.iter().filter(|t| !t.locked).map(|t| t.id).collect()
            };
            s.timeline.overlay = Some(Overlay { ranges: gone, tracks: Some(tracks) });
        }
    }
    s.features.ai.command.preview = Some(Preview { planned, silence });
}

/// Apply pressed: the plan checked again against the sequence as it is now, then one undo step (Edit Command) ->
/// whether it changed the project.
pub fn apply(s: &mut Shell) -> bool {
    let Some(p) = s.features.ai.command.preview.take() else { return false };
    s.timeline.overlay = None;
    let Some(seq) = s.app.sequence() else { return false };
    let ctx = Context::of(seq, &s.app.selection);
    let again = match validate_plan(&p.planned.plan.to_json(), &ctx) {
        Ok(v) => v,
        Err(e) => {
            super::notice::failed(s, &Why::Invalid(e));
            return false;
        }
    };
    let cmds = plan_commands(&again.ops, seq, &ctx.selection, &p.silence);
    if cmds.is_empty() {
        s.app.toast(tr("The plan changes nothing."));
        return false;
    }
    if s.app.exec(&C::batch("Edit Command", cmds)).is_none() {
        return false;
    }
    s.app.selection.clear();
    s.app.toast(trf("Edit applied: {n} steps.", &[("n", &p.planned.plan.ops.len().to_string())]));
    true
}

fn note(ui: &mut egui::Ui, s: &Shell, text: &str) {
    ui.label(RichText::new(text).color(s.palette.gray[8]).size(12.0));
}

/// The dialogs and the silences measured, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let playing = s.transport.playing();
    if let Some(out) = s.features.ai.command.measuring.as_ref().and_then(|m| m.0.poll(playing))
        && let Some((_, p, clips)) = s.features.ai.command.measuring.take()
    {
        {
            match out {
                Outcome::Done(got) => {
                    for (k, l) in got {
                        s.features.auto.levels.put(k, l);
                    }
                    measured(s, p, &clips);
                }
                other => {
                    crate::auto::ended(s, other);
                }
            }
        }
    }
    if let Some((j, _, _)) = &s.features.ai.command.measuring {
        ctx.request_repaint_after(std::time::Duration::from_millis(50));
        let mut stop = false;
        egui::Window::new(j.title.clone())
            .id(egui::Id::unique("cut-ai-silence"))
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_TOP, egui::Vec2::new(0.0, 60.0))
            .show_titled(ctx, &j.title, None, |ui| {
                ui.add(egui::ProgressBar::new(j.fraction()).desired_width(260.0));
                stop = ui.button(tr("Cancel")).clicked();
            });
        if stop {
            j.cancel();
        }
    }
    if let Some(mut text) = s.features.ai.command.form.clone() {
        let (mut go, mut cancel) = (false, false);
        dialog("Edit Command", "cutAiCommand", 560.0).show_titled(ctx, tr("Edit Command"), None, |ui| {
            let r = ui.add(
                egui::TextEdit::singleline(&mut text)
                    .hint_text(tr("e.g. cut the first 10 seconds"))
                    .desired_width(f32::INFINITY),
            );
            if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                go = true;
            }
            note(ui, s, &tr("Say what to change, for example: remove all silences longer than 1 s · add a chapter marker at every topic · make the music 6 dB quieter · cut the first 10 seconds."));
            note(ui, s, &tr("Claude answers with a plan of simple edits (cut, lift, add edit, markers, volume, silence removal). You see the plan before anything changes."));
            crate::panels::dialogs::actions(ui, |ui| {
                go |= crate::panels::dialogs::primary(ui, tr("Ask Claude")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        s.features.ai.command.form = (!cancel).then_some(text);
        if go {
            ask(s);
        }
    }
    if let Some(message) = s.features.ai.command.empty.clone() {
        let mut close = false;
        dialog("Edit Command", "cutAiPlanEmpty", 500.0).show_titled(ctx, tr("Edit Command"), None, |ui| {
            ui.label(tr("Claude did not plan any edits for this request."));
            if !message.is_empty() {
                note(ui, s, &message);
            }
            close = ui.button(tr("Close")).clicked();
        });
        if close {
            s.features.ai.command.empty = None;
        }
    }
    let Some(p) = s.features.ai.command.preview.clone() else { return };
    let Some(seq) = s.app.sequence() else { return };
    let selection = Context::of(seq, &s.app.selection).selection;
    let lines = describe_plan(&p.planned.plan.ops, seq, &selection, &p.silence);
    let (mut go, mut cancel) = (false, false);
    dialog("Edit Plan", "cutAiPlan", 560.0).show_titled(ctx, tr("Edit Plan"), None, |ui| {
        ui.label(RichText::new(&p.planned.request).strong());
        for (k, (text, params)) in lines.iter().enumerate() {
            let params: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
            ui.label(format!("{}. {}", k + 1, trf(text, &params)));
        }
        if !p.planned.plan.message.is_empty() {
            note(ui, s, &p.planned.plan.message);
        }
        note(ui, s, &tr("Times are those of the timeline before the plan. Apply makes it one undo step."));
        if let Some(c) = &p.planned.condensed {
            let t = super::metadata_ui::trimmed_note(c);
            if !t.is_empty() {
                note(ui, s, &t);
            }
        }
        crate::panels::dialogs::actions(ui, |ui| {
            go = crate::panels::dialogs::primary(ui, tr("Apply")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if go {
        apply(s);
    } else if cancel {
        s.features.ai.command.preview = None;
        s.timeline.overlay = None;
    }
}
