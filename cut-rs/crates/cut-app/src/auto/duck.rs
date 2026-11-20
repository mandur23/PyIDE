//! Auto Ducking (`ui-auto.js autoDuck`): volume keyframes on the clips marked Music that lower them wherever the
//! clips marked Dialogue speak. The dialogue's levels are measured on the analysis thread; the music gets its `duck`
//! curve (the volume keyframes stay the user's), replacing the last run's, in one undo step.

use cut_audio::analysis::{duck_keyframes, speech_ranges, total, union};
use cut_model::commands::build as C;
use cut_model::{Clip, Id, Role, Sequence, TrackKind};
use cut_time::TICKS;
use eframe::egui;
use serde_json::Value as Json;

use super::levels::{self, Read};
use super::{Job, dialog, number};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::App;

/// The settings and their defaults (`cut.auto.duck`).
const DEFAULTS: [(&str, f64); 4] = [("amount", -12.0), ("fade", 0.3), ("threshold", -40.0), ("hold", 0.5)];

const ROLES_FIRST: &str = "Mark the clips first: right-click a clip in the timeline and choose Audio Role > Dialogue for speech and Music for the music to lower.";

/// Auto Ducking's settings: dB down, the ramps (s), what counts as speech (dBFS), the shortest pause kept up (s).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Duck {
    pub amount: f64,
    pub fade: f64,
    pub threshold: f64,
    pub hold: f64,
}

/// The dialog on screen.
pub enum Open {
    /// No dialogue or no music: what to do first.
    Roles,
    Ask {
        o: Duck,
        dialogue: usize,
        music: usize,
    },
}

/// Auto Ducking's state.
#[derive(Default)]
pub struct DuckUi {
    pub open: Option<Open>,
    /// The measurement, with the settings and the clips it is for.
    pub job: Option<Job<levels::Measured>>,
    plan: Option<(Duck, Vec<Id>, Vec<Id>)>,
}

fn sound(app: &App, seq: &Sequence, c: &Clip) -> bool {
    seq.kind_of(c.track) == Some(TrackKind::Audio)
        && !c.is_freeze()
        && c.media_id().and_then(|m| app.project().media(m)).is_some_and(|m| m.audio.is_some())
}

/// The dialogue clips (enabled, with sound) and the music clips (on unlocked audio tracks).
pub fn clips(app: &App) -> (Vec<Id>, Vec<Id>) {
    let Some(seq) = app.sequence() else { return (Vec::new(), Vec::new()) };
    let dialogue = seq.clips().filter(|c| c.role == Some(Role::Dialogue) && c.enabled && sound(app, seq, c));
    let music = seq.clips().filter(|c| {
        c.role == Some(Role::Music)
            && seq.kind_of(c.track) == Some(TrackKind::Audio)
            && !seq.track(c.track).is_some_and(|t| t.locked)
    });
    (dialogue.map(|c| c.id).collect(), music.map(|c| c.id).collect())
}

/// Auto Ducking… chosen: the question about the roles, or the settings.
pub fn open(s: &mut Shell) {
    let (d, m) = clips(&s.app);
    if d.is_empty() || m.is_empty() {
        s.features.auto.duck.open = Some(Open::Roles);
        return;
    }
    let v = super::settings(s, "duck", &DEFAULTS);
    let o = Duck { amount: v[0], fade: v[1], threshold: v[2], hold: v[3] };
    s.features.auto.duck.open = Some(Open::Ask { o, dialogue: d.len(), music: m.len() });
}

/// Duck pressed: the settings kept and the dialogue measured.
pub fn start(s: &mut Shell, o: Duck) {
    s.features.auto.duck.open = None;
    super::remember(s, "duck", &[("amount", o.amount), ("fade", o.fade), ("threshold", o.threshold), ("hold", o.hold)]);
    let (d, m) = clips(&s.app);
    let Some(seq) = s.app.sequence() else { return };
    let reads: Vec<Read> = d
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter_map(|c| Read::of(s.app.project(), c))
        .filter(|r| s.features.auto.levels.get(&r.key).is_none())
        .collect();
    let job =
        Job::start(tr("Finding the speech…").into_owned(), false, move |step| levels::measure_all(&reads, step));
    let a = &mut s.features.auto.duck;
    a.job = Some(job);
    a.plan = Some((o, d, m));
}

/// The commands that duck the music clips `music` under the dialogue clips' speech: `(commands, clips ducked,
/// speech ticks)`.
pub fn commands(app: &App, o: Duck, dialogue: &[Id], music: &[Id], lv: &levels::Cache) -> (Vec<Json>, usize, f64) {
    let Some(s) = app.sequence() else { return (Vec::new(), 0, 0.0) };
    let f = cut_model::query::frame(s.fps) as f64;
    let t = TICKS as f64;
    let fade = cut_audio::util::js_round(o.fade * t / f) * f;
    let mut speech = Vec::new();
    for c in dialogue.iter().filter_map(|id| s.clip(*id)) {
        let Some(l) = Read::of(app.project(), c).and_then(|r| lv.get(&r.key)) else { continue };
        let loud = levels::loud_on_timeline(c, &l, o.threshold);
        speech.extend(speech_ranges(&[levels::span(c)], &loud, o.hold * t));
    }
    let speech = union(&speech);
    let mut cmds = Vec::new();
    let mut ducked = 0;
    for c in music.iter().filter_map(|id| s.clip(*id)) {
        let start = c.start as f64;
        let shifted: Vec<(f64, f64)> = speech.iter().map(|(a, b)| (a - start, b - start)).collect();
        let keys = duck_keyframes(c.duration() as f64, &shifted, o.amount, fade, f);
        if !keys.is_empty() || c.keyframes.contains_key("duck") {
            ducked += usize::from(!keys.is_empty());
            let list = serde_json::to_value(&keys).unwrap_or(Json::Array(Vec::new()));
            cmds.push(C::set_keyframes(s.id.as_str(), c.id.as_str(), "duck", Some(list)));
        }
    }
    (cmds, ducked, total(&speech))
}

/// Takes in the measurement and writes the keyframes.
pub fn poll(s: &mut Shell, playing: bool) {
    let Some(out) = s.features.auto.duck.job.as_ref().and_then(|j| j.poll(playing)) else { return };
    s.features.auto.duck.job = None;
    let plan = s.features.auto.duck.plan.take();
    let (Some(got), Some((o, d, m))) = (super::ended(s, out), plan) else { return };
    for (k, l) in got {
        s.features.auto.levels.put(k, l);
    }
    let (cmds, ducked, speech) = commands(&s.app, o, &d, &m, &s.features.auto.levels);
    if cmds.is_empty() {
        s.app.toast(tr("The dialogue does not overlap the music."));
        return;
    }
    if s.app.exec(&C::batch("Auto Ducking", cmds)).is_some() {
        s.app.toast(if ducked > 0 {
            trf(
                "Music clips ducked: {n} (under {s} of speech).",
                &[("n", &ducked.to_string()), ("s", &super::seconds(speech))],
            )
        } else {
            tr("The dialogue does not overlap the music.").into_owned()
        });
    }
}

/// The dialogs, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let mut close = false;
    let mut go = None;
    match &mut s.features.auto.duck.open {
        None => return,
        Some(Open::Roles) => {
            dialog("Auto Ducking", "cutAutoDuckRoles", 440.0).show_titled(ctx, tr("Auto Ducking"), None, |ui| {
                ui.label(tr(ROLES_FIRST));
                close = ui.button(tr("OK")).clicked();
            });
        }
        Some(Open::Ask { o, dialogue, music }) => {
            dialog("Auto Ducking", "cutAutoDuck", 440.0).show_titled(ctx, tr("Auto Ducking"), None, |ui| {
                ui.label(trf(
                    "Dialogue clips: {d}, music clips: {m}. The music is lowered wherever the dialogue speaks.",
                    &[("d", &dialogue.to_string()), ("m", &music.to_string())],
                ));
                egui::Grid::new("cut-auto-duck").num_columns(2).show(ui, |ui| {
                    ui.label(tr("Lower by"));
                    number(ui, &mut o.amount, (-40.0, -1.0, 1.0), 0, "dB");
                    ui.end_row();
                    ui.label(tr("Fade"));
                    number(ui, &mut o.fade, (0.0, 2.0, 0.05), 2, "s");
                    ui.end_row();
                    ui.label(tr("Speech louder than"));
                    number(ui, &mut o.threshold, (-90.0, -5.0, 1.0), 0, "dB");
                    ui.end_row();
                });
                crate::panels::dialogs::actions(ui, |ui| {
                    if crate::panels::dialogs::primary(ui, tr("Duck")).clicked() {
                        go = Some(*o);
                    }
                    close = ui.button(tr("Cancel")).clicked();
                });
            });
        }
    }
    if let Some(o) = go {
        start(s, o);
    } else if close {
        s.features.auto.duck.open = None;
    }
}
