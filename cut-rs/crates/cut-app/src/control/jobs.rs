//! The Automation menu's jobs without their dialogs (ui-control.js `automation`): the clips and range a job works
//! on set as the menu sees them (the selection and In/Out, put back after), Stop and progress from the call, and
//! what changed. Match Loudness and Match Clip Loudness run here (`applyLoudness`, `matchClipLoudness` with
//! `ask: false`): measured on a thread, then one undo step.

use std::sync::Arc;

use cut_model::Id;
use cut_model::commands::build as C;
use serde_json::{Value as Json, json};

use super::host::Task;
use crate::audio::loudness::{self as L, Task as Measure};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// What the job is waiting on.
enum Step {
    Sequence {
        seq: Id,
        target: f64,
        task: Measure,
    },
    Clips {
        seq: Id,
        target: f64,
        task: Measure,
    },
    Answer(Json),
    /// A native job of the Automation menu, started without its dialog and watched until it ends.
    Native(Box<super::native::Native>),
}

/// The selection and In/Out a job changed (`scope`), to put back.
struct Scope {
    selection: Vec<Id>,
    in_out: crate::state::InOut,
    clips: bool,
    range: bool,
}

fn scope(s: &mut Shell, a: &Json) -> Scope {
    let back = Scope {
        selection: s.app.selection.iter().copied().collect(),
        in_out: s.app.in_out,
        clips: a["clipIds"].is_array(),
        range: a["range"].is_array(),
    };
    if let Some(ids) = a["clipIds"].as_array() {
        s.app.select(ids.iter().filter_map(Json::as_str).map(Id::new), false, false);
    }
    if let Some(r) = a["range"].as_array() {
        s.app.set_in_out(Some(r[0].as_i64()), Some(r[1].as_i64()));
    }
    back
}

fn restore(s: &mut Shell, b: &Scope) {
    if b.clips {
        let keep: Vec<Id> =
            b.selection.iter().copied().filter(|id| s.app.sequence().is_some_and(|q| q.clip(*id).is_some())).collect();
        s.app.select(keep, false, false);
    }
    if b.range {
        s.app.in_out = b.in_out;
    }
}

/// Starts job `action` on sequence `seq` -> the task the call polls.
pub fn start(s: &mut Shell, action: &str, a: &Json, seq: Id) -> Task<Json> {
    let answer = |v: Json| -> Task<Json> { Box::new(move |_, _| Some(v.clone())) };
    if s.app.sequence_id != Some(seq) {
        s.app.set_sequence(seq);
    }
    if super::native::busy(s) || s.features.audio.loudness.open.is_some() {
        return answer(
            json!({ "ok": false, "error": "Another analysis is running in Cut; wait for it, or ask the user to cancel it." }),
        );
    }
    let steps = s.app.history.list().into_iter().filter(|x| x.done).count();
    let pos = s.app.history.position();
    let notices = s.app.notices.len();
    let back = scope(s, a);
    let target = a["target"].as_f64();
    let step = match action {
        "match_loudness" => match_sequence(s, seq, target),
        "match_clip_loudness" => match_clips(s, seq, target),
        _ => match super::native::start(s, action, a) {
            Ok(n) => Step::Native(Box::new(n)),
            Err(v) => Step::Answer(v),
        },
    };
    let action = action.to_owned();
    let mut step = Some(step);
    let mut back = Some(back);
    Box::new(move |h, live| {
        let s = h.shell()?;
        let value = match step.take()? {
            Step::Answer(v) => Some(v),
            Step::Native(mut n) => match n.poll(s, live) {
                Some(v) => Some(v),
                None => {
                    step = Some(Step::Native(n));
                    None
                }
            },
            Step::Sequence { seq, target, task } => {
                live.progress(Some(f64::from(task.fraction())), &tr("Measuring loudness…"));
                if live.aborted() {
                    task.stop();
                    Some(json!({ "cancelled": true }))
                } else {
                    match task.done() {
                        None => {
                            step = Some(Step::Sequence { seq, target, task });
                            None
                        }
                        Some(got) => Some(apply_sequence(s, seq, target, got.into_iter().next().and_then(|x| x.1))),
                    }
                }
            }
            Step::Clips { seq, target, task } => {
                live.progress(Some(f64::from(task.fraction())), &tr("Measuring clip loudness…"));
                if live.aborted() {
                    task.stop();
                    Some(json!({ "cancelled": true }))
                } else {
                    match task.done() {
                        None => {
                            step = Some(Step::Clips { seq, target, task });
                            None
                        }
                        Some(got) => Some(apply_clips(s, seq, target, &got)),
                    }
                }
            }
        };
        let r = value?;
        if let Some(b) = back.take() {
            restore(s, &b);
        }
        if r["cancelled"] == true || r["declined"] == true || r["ok"] == false {
            return Some(r);
        }
        let mut said: Vec<String> = Vec::new();
        for n in s.app.notices.iter().skip(notices) {
            if n.error || said.len() < 4 {
                said.push(n.text.clone());
            }
        }
        let changed =
            s.app.history.list().into_iter().filter(|x| x.done).count() != steps || s.app.history.position() != pos;
        if r.is_null() && !changed {
            let e = if said.is_empty() { format!("{action} changed nothing.") } else { said.join(" ") };
            return Some(json!({ "ok": false, "error": e }));
        }
        let mut value = json!({ "job": action });
        if let Some(o) = r.as_object() {
            for (k, v) in o {
                value[k] = v.clone();
            }
        }
        if !said.is_empty() {
            value["said"] = json!(said);
        }
        if action == "transcribe" {
            value["note"] = json!("Recognized: get_transcript reads it.");
        }
        Some(
            json!({ "ok": true, "changed": changed, "value": value, "at": s.app.t, "seqId": s.app.sequence_id.map(|i| i.as_str()) }),
        )
    })
}

fn target_of(s: &Shell, key: &str, given: Option<f64>) -> f64 {
    given.unwrap_or_else(|| s.doc.setting(key).and_then(|v| v.parse().ok()).unwrap_or(-14.0))
}

/// `matchLoudness(app, {ask: false, target})`: the whole sequence measured, then its master gain.
fn match_sequence(s: &mut Shell, seq: Id, target: Option<f64>) -> Step {
    let Some(q) = s.app.project().sequence(seq) else { return Step::Answer(Json::Null) };
    let length = q.duration();
    let audio = q.clips().any(|c| q.kind_of(c.track) == Some(cut_model::TrackKind::Audio));
    if length <= 0 || !audio {
        s.app.toast(tr("The sequence has no sound."));
        return Step::Answer(Json::Null);
    }
    let target = target_of(s, "auto.loudness.target", target);
    let task = Measure::start(vec![(seq, Arc::new(s.app.project().clone()), seq, 0, length)]);
    Step::Sequence { seq, target, task }
}

fn apply_sequence(s: &mut Shell, seq: Id, target: f64, m: Option<cut_audio::loudness::Loudness>) -> Json {
    let Some(m) = m.filter(|m| m.integrated.is_finite()) else {
        s.app.toast(tr("The sequence is silent."));
        return Json::Null;
    };
    let Some(q) = s.app.project().sequence(seq).cloned() else { return Json::Null };
    let g = L::master_gain_for(&q, &m, target);
    if s.app
        .exec(&C::batch("Match Loudness", vec![C::set_sequence(seq.as_str(), json!({ "masterGain": g }))]))
        .is_none()
    {
        return Json::Null;
    }
    s.app.toast(trf("Master gain set to {gain} dB.", &[("gain", &format!("{g:.2}"))]));
    let r1 = |x: f64| (x * 10.0 + 0.5).floor() / 10.0;
    json!({ "gain": g, "lufs": r1(m.integrated), "truePeak": r1(m.true_peak) })
}

/// `matchClipLoudness(app, {ask: false, target})`: each selected clip with sound measured alone, then its volume.
fn match_clips(s: &mut Shell, seq: Id, target: Option<f64>) -> Step {
    let clips = crate::audio::essential::sound_clips(&s.app, false);
    if clips.is_empty() {
        s.app.toast(tr("Select the clips to match first."));
        return Step::Answer(Json::Null);
    }
    let target = target_of(s, "auto.clipLoudness.target", target);
    let project = s.app.project().clone();
    let Some(q) = project.sequence(seq) else { return Step::Answer(Json::Null) };
    let jobs = clips
        .iter()
        .filter_map(|id| {
            Some((*id, Arc::new(L::alone(&project, seq, *id)?), seq, q.clip(*id)?.start, q.clip(*id)?.end()))
        })
        .collect();
    Step::Clips { seq, target, task: Measure::start(jobs) }
}

fn apply_clips(s: &mut Shell, seq: Id, target: f64, measured: &[(Id, Option<cut_audio::loudness::Loudness>)]) -> Json {
    let Some(q) = s.app.project().sequence(seq).cloned() else { return Json::Null };
    let (cmds, gains) = L::clip_commands(&q, measured, target);
    if cmds.is_empty() {
        s.app.toast(tr("The clips are silent."));
        return Json::Null;
    }
    if s.app.exec(&C::batch("Match Clip Loudness", cmds)).is_none() {
        return Json::Null;
    }
    s.app.toast(trf(
        "Clips set to {lufs} LUFS: {n}.",
        &[("n", &gains.len().to_string()), ("lufs", &crate::control::schema::js_num(target))],
    ));
    let g: serde_json::Map<String, Json> =
        gains.into_iter().map(|(id, v)| (id.as_str().to_owned(), json!(v))).collect();
    json!({ "gains": g })
}
