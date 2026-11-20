//! Detect Beats (`ui-auto.js detectBeats`): the tempo and the beats of the selected audio clip's sound
//! ([`cut_audio::analysis::beats`]), then beat markers on every beat or on the first beat of every bar, replacing an
//! earlier detection's on the clip's stretch, one undo step.
//!
//! Threads: the clip's sound is decoded in ten-second blocks on the analysis thread, made mono (and halved in rate
//! from 44.1 kHz up, which is enough for onsets) and streamed into the flux envelope there; the beat search runs on
//! that thread too.

use cut_audio::analysis::{Flux, beats, mono};
use cut_model::commands::build as C;
use cut_model::{Id, MarkerKind};
use cut_time::TICKS;
use eframe::egui;
use serde_json::{Value as Json, json};

use super::levels::{Read, read_sound};
use super::{Job, Step, Stop, dialog};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::App;

/// Which beats get a marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Every {
    Beat,
    /// The first beat of every four.
    Bar,
}

impl Every {
    fn word(self) -> &'static str {
        match self {
            Every::Beat => "beat",
            Every::Bar => "bar",
        }
    }
}

/// What the analysis found: the tempo, the beats (source ticks) and the index of the first downbeat.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub bpm: f64,
    pub beats: Vec<f64>,
    pub phase: usize,
}

/// Detect Beats' state.
#[derive(Default)]
pub struct BeatsUi {
    /// The dialog on screen, with its choice.
    pub open: Option<Every>,
    pub job: Option<Job<Found>>,
    plan: Option<(Id, Every)>,
    /// The tempo of the last detection that made markers (the control API answers it).
    pub last_bpm: Option<f64>,
}

/// Detect Beats… chosen: the dialog for the first selected clip with sound (`soundClips(app, { all: false })`).
pub fn open(s: &mut Shell) {
    if crate::audio::essential::sound_clips(&s.app, false).is_empty() {
        s.app.toast(tr("Select an audio clip first."));
        return;
    }
    let every = match super::setting_word(s, "beats", "every", &["beat", "bar"]) {
        Some("bar") => Every::Bar,
        _ => Every::Beat,
    };
    s.features.auto.beats.open = Some(every);
}

/// The beats of a clip's sound, read on the analysis thread.
pub fn analyse(read: &Read, step: &Step) -> Result<Found, Stop> {
    let mut flux: Option<(Flux, usize)> = None;
    let (_, start) = read_sound(read, step, (0.0, 0.9), |planes, rate| {
        if flux.is_none() {
            let k = if rate >= 44100.0 { 2 } else { 1 };
            flux = Flux::new(rate / k as f64, 1024, 256).map(|f| (f, k));
        }
        let Some((f, k)) = flux.as_mut() else { return };
        let m = mono(planes);
        if *k == 1 {
            f.push(&m);
        } else {
            let d: Vec<f32> =
                (0..m.len() / 2).map(|i| ((f64::from(m[i * 2]) + f64::from(m[i * 2 + 1])) / 2.0) as f32).collect();
            f.push(&d);
        }
    })?;
    let Some((flux, _)) = flux else { return Ok(Found { bpm: 0.0, beats: Vec::new(), phase: 0 }) };
    step.step().map_err(Err)?;
    let r = beats(&flux, flux.envelope());
    step.progress(1.0);
    let t = TICKS as f64;
    Ok(Found { bpm: r.bpm, beats: r.beats.iter().map(|s| (start + s) * t).collect(), phase: r.phase })
}

/// Detect pressed: the choice kept and the clip's sound analysed.
pub fn start(s: &mut Shell, every: Every) {
    s.features.auto.beats.open = None;
    super::remember_word(s, "beats", "every", every.word());
    let ids = crate::audio::essential::sound_clips(&s.app, false);
    let Some(read) = ids.first().and_then(|id| s.app.sequence()?.clip(*id)).and_then(|c| Read::of(s.app.project(), c))
    else {
        return;
    };
    let job = Job::start(tr("Detecting beats…").into_owned(), false, move |step| analyse(&read, step));
    let a = &mut s.features.auto.beats;
    a.job = Some(job);
    a.plan = Some((ids[0], every));
}

/// The markers for the beats found on `clip` (`detectBeats`' second half): an earlier detection's beat markers on
/// its stretch taken away, then one on each beat's frame inside it (the bars' numbered from 1) -> `(commands,
/// markers)`, or `None` when the clip is gone or no beat was found.
pub fn commands(app: &App, clip: Id, found: &Found, every: Every) -> Option<(Vec<Json>, usize)> {
    let seq = app.sequence()?;
    let now = seq.clip(clip).filter(|_| !found.beats.is_empty())?;
    let f = cut_model::query::frame(seq.fps) as f64;
    let (start, end) = (now.start, now.end());
    let sid = seq.id.as_str();
    let mut cmds: Vec<Json> = seq
        .markers
        .iter()
        .filter(|m| m.kind == MarkerKind::Beat && m.t >= start && m.t < end)
        .map(|m| C::remove_marker(sid, m.id.as_str()))
        .collect();
    let mut seen: Vec<i64> = Vec::new();
    for (i, p) in found.beats.iter().enumerate() {
        if every == Every::Bar && i % 4 != found.phase {
            continue;
        }
        let t = (cut_audio::util::js_round(now.timeline_time(*p).unwrap_or(0.0) / f) * f) as i64;
        if t < start || t >= end || seen.contains(&t) {
            continue;
        }
        seen.push(t);
        let name = if every == Every::Bar { seen.len().to_string() } else { String::new() };
        cmds.push(C::add_marker(sid, json!({ "t": t, "kind": "beat", "color": "cyan", "name": name }), json!({})));
    }
    Some((cmds, seen.len()))
}

/// Takes in the beats and puts the markers.
pub fn poll(s: &mut Shell, playing: bool) {
    let Some(out) = s.features.auto.beats.job.as_ref().and_then(|j| j.poll(playing)) else { return };
    s.features.auto.beats.job = None;
    let plan = s.features.auto.beats.plan.take();
    let (Some(found), Some((clip, every))) = (super::ended(s, out), plan) else { return };
    let Some((cmds, count)) = commands(&s.app, clip, &found, every) else {
        s.app.toast(tr("No beats were found."));
        return;
    };
    if s.app.exec(&C::batch("Add Beat Markers", cmds)).is_some() {
        s.features.auto.beats.last_bpm = Some(found.bpm);
        s.app.toast(trf(
            "{bpm} BPM: {n} beat markers.",
            &[("bpm", &format!("{:.1}", found.bpm)), ("n", &count.to_string())],
        ));
    }
}

/// The dialog, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut every) = s.features.auto.beats.open else { return };
    let (mut go, mut cancel) = (false, false);
    dialog("Detect Beats", "cutAutoBeats", 420.0).show_titled(ctx, tr("Detect Beats"), None, |ui| {
        ui.label(tr("Finds the tempo and the beats of the clip and puts beat markers on them. Edits snap to markers."));
        egui::Grid::new("cut-auto-beats").num_columns(2).show(ui, |ui| {
            ui.label(tr("Markers"));
            let name = |e: Every| match e {
                Every::Beat => tr("Every beat"),
                Every::Bar => tr("Every bar (4 beats)"),
            };
            egui::ComboBox::from_id_salt("cut-auto-beats-every")
                .icon(crate::theme::combo_icon)
                .selected_text(name(every))
                .show_ui(ui, |ui| {
                    for e in [Every::Beat, Every::Bar] {
                        ui.selectable_value(&mut every, e, name(e));
                    }
                });
            ui.end_row();
        });
        crate::panels::dialogs::actions(ui, |ui| {
            go = crate::panels::dialogs::primary(ui, tr("Detect")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    s.features.auto.beats.open = Some(every);
    if go {
        start(s, every);
    } else if cancel {
        s.features.auto.beats.open = None;
    }
}
