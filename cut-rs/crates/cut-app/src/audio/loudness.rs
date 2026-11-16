//! The loudness matches (`ui-auto.js`'s Match Loudness and Match Clip Loudness), the native app's normalise: the
//! sequence's master gain, or each selected clip's volume, set so the integrated loudness (BS.1770) meets a target,
//! the master's true peak kept under -1 dBTP. The mix is measured on a thread of its own with a mixer of its own (the
//! same arithmetic as the export's), so the window keeps drawing and playback keeps its mixer; the result is one undo
//! step.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, channel};

use cut_audio::loudness::{Loudness, match_gain};
use cut_model::commands::build as C;
use cut_model::{Id, Project, Props, Sequence};
use cut_time::Ticks;
use eframe::egui::{self, Align2, ProgressBar, Vec2};
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The targets offered, LUFS, with their names.
pub const TARGETS: [(f64, &str); 3] =
    [(-14.0, "YouTube and streaming (-14 LUFS)"), (-16.0, "Podcasts (-16 LUFS)"), (-24.0, "Broadcast (-24 LUFS)")];

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The loudness of `[from, to)` of a sequence's mix, read from the files; `progress(fraction)` returning false stops.
pub fn measure(
    project: &Project,
    seq: Id,
    from: Ticks,
    to: Ticks,
    progress: impl FnMut(f64) -> bool,
) -> Option<Loudness> {
    let mut mixer = cut_audio::Mixer::new(48000, crate::transport::file_audio(cut_audio::Library::default()));
    mixer.load(project, seq, from as f64, to as f64);
    cut_audio::offline::measure(&mut mixer, project, seq, from, to, 0.0, progress)
}

/// A clip alone (`alone`): its sequence with only that clip, no transitions, every audio track level and centred and
/// no master gain, for measuring the clip's own loudness.
pub fn alone(project: &Project, seq: Id, clip: Id) -> Option<Project> {
    let mut json = serde_json::to_value(project).ok()?;
    let list = json.get_mut("sequences")?.as_array_mut()?;
    let s = list.iter_mut().find(|s| s["id"].as_str() == Some(seq.as_str()))?;
    s["masterGain"] = json!(0);
    s["transitions"] = json!([]);
    let clips = s["clips"].as_array()?.iter().filter(|c| c["id"].as_str() == Some(clip.as_str())).cloned().collect();
    s["clips"] = Json::Array(clips);
    for t in s["tracks"].as_array_mut()? {
        if t["kind"] == "audio" {
            t["volume"] = json!(0);
            t["pan"] = json!(0);
            t["mute"] = json!(false);
            t["solo"] = json!(false);
        }
    }
    Project::from_json(json).ok()
}

/// The master gain that meets `target` (`gain()`): the sequence's own plus the match, to 0.01 dB.
fn master_gain_for(seq: &Sequence, measured: &Loudness, target: f64) -> f64 {
    js_round((seq.master_gain + match_gain(measured, target, -1.0)) * 100.0) / 100.0
}

fn round1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}

/// The commands that bring each measured clip to `target` (its volume and volume keyframes moved by the same dB,
/// kept within -60..24), and each clip's new volume. Silent clips are left out.
fn clip_commands(seq: &Sequence, measured: &[(Id, Option<Loudness>)], target: f64) -> (Vec<Json>, Vec<(Id, f64)>) {
    let mut cmds = Vec::new();
    let mut gains = Vec::new();
    for (id, m) in measured {
        let (Some(c), Some(m)) = (seq.clip(*id), m.as_ref().filter(|m| m.integrated.is_finite())) else { continue };
        let d = round1(target - m.integrated);
        let volume = match &c.props {
            Props::Audio(a) => a.volume,
            Props::Video(_) => 0.0,
        };
        let vol = round1(volume + d).clamp(-60.0, 24.0);
        gains.push((*id, vol));
        let (s, cid) = (seq.id.as_str(), c.id.as_str());
        cmds.push(C::set_clip(s, cid, json!({ "props": { "volume": vol } }), json!({ "linked": false })));
        if let Some(keys) = c.keyframes.get("volume").filter(|k| !k.is_empty())
            && let Ok(Json::Array(mut list)) = serde_json::to_value(keys)
        {
            for k in &mut list {
                let v = k["v"].as_f64().unwrap_or(0.0);
                k["v"] = json!(round1(v + d).clamp(-60.0, 24.0));
            }
            cmds.push(C::set_keyframes(s, cid, "volume", Some(Json::Array(list))));
        }
    }
    (cmds, gains)
}

/// Measurements running on a thread: their progress (0..1), a stop, and the results when done.
pub struct Task {
    pub progress: Arc<AtomicU32>,
    cancel: Arc<AtomicBool>,
    rx: Receiver<Vec<(Id, Option<Loudness>)>>,
}

impl Task {
    /// Measures each `(id, project, seq, from, to)` in turn.
    pub fn start(jobs: Vec<(Id, Arc<Project>, Id, Ticks, Ticks)>) -> Task {
        let progress = Arc::new(AtomicU32::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = channel();
        let (p, c) = (progress.clone(), cancel.clone());
        let _ = std::thread::Builder::new().name("cut-app loudness".into()).spawn(move || {
            let n = jobs.len().max(1) as f64;
            let mut out = Vec::new();
            for (i, (id, project, seq, from, to)) in jobs.into_iter().enumerate() {
                let got = measure(&project, seq, from, to, |f| {
                    p.store((((i as f64 + f) / n) as f32).to_bits(), Ordering::Relaxed);
                    !c.load(Ordering::Relaxed)
                });
                if c.load(Ordering::Relaxed) {
                    return;
                }
                out.push((id, got));
            }
            let _ = tx.send(out);
        });
        Task { progress, cancel, rx }
    }

    pub fn fraction(&self) -> f32 {
        f32::from_bits(self.progress.load(Ordering::Relaxed))
    }

    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// The results, once there.
    pub fn done(&self) -> Option<Vec<(Id, Option<Loudness>)>> {
        self.rx.try_recv().ok()
    }
}

/// The dialog on screen, or the clip measurement running.
pub enum Open {
    /// Match Loudness: the sequence measured as the dialog opens.
    Sequence { seq: Id, target: f64, task: Option<Task>, measured: Option<Result<Loudness, ()>> },
    /// Match Clip Loudness: the target asked first, then the clips measured with a progress box.
    Clips { seq: Id, clips: Vec<Id>, target: f64, task: Option<Task> },
}

/// The loudness screens' state.
#[derive(Default)]
pub struct LoudnessUi {
    pub open: Option<Open>,
}

fn target_setting(s: &Shell, key: &str) -> f64 {
    s.doc.setting(key).and_then(|v| v.parse::<f64>().ok()).unwrap_or(-14.0)
}

/// Opens Match Loudness and starts measuring the whole sequence.
pub fn open_sequence(s: &mut Shell) {
    let Some(seq) = s.app.sequence() else { return };
    let length = seq.duration();
    let audio = seq.clips().any(|c| seq.kind_of(c.track) == Some(cut_model::TrackKind::Audio));
    if length <= 0 || !audio {
        s.app.toast(tr("The sequence has no sound."));
        return;
    }
    let id = seq.id;
    let task = Task::start(vec![(id, Arc::new(s.app.project().clone()), id, 0, length)]);
    let target = target_setting(s, "auto.loudness.target");
    s.features.audio.loudness.open = Some(Open::Sequence { seq: id, target, task: Some(task), measured: None });
}

/// Opens Match Clip Loudness for the selected clips with sound.
pub fn open_clips(s: &mut Shell) {
    let clips = super::essential::sound_clips(&s.app, false);
    let Some(seq) = s.app.sequence_id.filter(|_| !clips.is_empty()) else {
        s.app.toast(tr("Select the clips to match first."));
        return;
    };
    let target = target_setting(s, "auto.clipLoudness.target");
    s.features.audio.loudness.open = Some(Open::Clips { seq, clips, target, task: None });
}

/// Match pressed in Match Clip Loudness: each clip measured alone, on the thread.
pub fn start_clips(s: &mut Shell) {
    let project = s.app.project().clone();
    let Some(Open::Clips { seq, clips, target, task }) = &mut s.features.audio.loudness.open else { return };
    let Some(sq) = project.sequence(*seq) else { return };
    let mut jobs = Vec::new();
    for id in clips.iter() {
        if let (Some(c), Some(p)) = (sq.clip(*id), alone(&project, *seq, *id)) {
            jobs.push((*id, Arc::new(p), *seq, c.start, c.end()));
        }
    }
    let t = *target;
    *task = Some(Task::start(jobs));
    s.doc.set_setting("auto.clipLoudness.target", &t.to_string());
}

/// Applies the measured clips' volumes.
fn finish_clips(s: &mut Shell, seq: Id, target: f64, measured: &[(Id, Option<Loudness>)]) {
    let Some(sq) = s.app.project().sequence(seq).cloned() else { return };
    let (cmds, gains) = clip_commands(&sq, measured, target);
    if cmds.is_empty() {
        s.app.toast(tr("The clips are silent."));
        return;
    }
    if s.app.exec(&C::batch("Match Clip Loudness", cmds)).is_some() {
        s.app.toast(trf(
            "Clips set to {lufs} LUFS: {n}.",
            &[("n", &gains.len().to_string()), ("lufs", &format!("{target}"))],
        ));
    }
}

/// Apply pressed in Match Loudness.
pub fn apply_sequence(s: &mut Shell) -> bool {
    let Some(Open::Sequence { seq, target, measured: Some(Ok(m)), .. }) = &s.features.audio.loudness.open else {
        return false;
    };
    let (seq, target, m) = (*seq, *target, *m);
    let Some(sq) = s.app.project().sequence(seq).cloned() else { return false };
    let g = master_gain_for(&sq, &m, target);
    s.doc.set_setting("auto.loudness.target", &target.to_string());
    let ok = s
        .app
        .exec(&C::batch("Match Loudness", vec![C::set_sequence(seq.as_str(), json!({ "masterGain": g }))]))
        .is_some();
    if ok {
        s.app.toast(trf("Master gain set to {gain} dB.", &[("gain", &format!("{g:.2}"))]));
    }
    s.features.audio.loudness.open = None;
    ok
}

/// Takes in finished measurements; the windows ask for frames while one runs.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    let mut clips_done = None;
    match &mut s.features.audio.loudness.open {
        Some(Open::Sequence { task, measured, .. }) => {
            if let Some(got) = task.as_ref().and_then(Task::done) {
                *measured = Some(got.into_iter().next().and_then(|(_, l)| l).ok_or(()));
                *task = None;
            }
            if task.is_some() {
                ctx.request_repaint_after(std::time::Duration::from_millis(50));
            }
        }
        Some(Open::Clips { seq, target, task: Some(t), .. }) => match t.done() {
            Some(got) => clips_done = Some((*seq, *target, got)),
            None => ctx.request_repaint_after(std::time::Duration::from_millis(50)),
        },
        _ => {}
    }
    if let Some((seq, target, got)) = clips_done {
        s.features.audio.loudness.open = None;
        finish_clips(s, seq, target, &got);
    }
}

fn target_combo(ui: &mut egui::Ui, id: &str, target: &mut f64) {
    let name =
        TARGETS.iter().find(|t| t.0 == *target).map_or_else(|| format!("{target} LUFS"), |t| tr(t.1).into_owned());
    egui::ComboBox::from_id_salt(id).selected_text(name).show_ui(ui, |ui| {
        for (v, label) in TARGETS {
            ui.selectable_value(target, v, tr(label));
        }
    });
}

fn num(v: f64) -> String {
    format!("{v:.1}")
}

/// The dialogs and the progress box, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    poll(s, ctx);
    if s.features.audio.loudness.open.is_none() {
        return;
    }
    let now_gain = s.app.sequence().map_or(0.0, |q| q.master_gain);
    let seq_now = s.app.sequence().cloned();
    let mut close = false;
    let mut apply = false;
    let mut start = false;
    match &mut s.features.audio.loudness.open {
        None => return,
        Some(Open::Sequence { target, task, measured, .. }) => {
            egui::Window::new(tr("Match Loudness")).id(egui::Id::unique("cutAutoLoudness")).collapsible(false).resizable(false)
                .anchor(Align2::CENTER_CENTER, Vec2::ZERO).default_width(460.0).show(ctx, |ui| {
                    ui.label(tr("Measures the whole sequence and sets its master gain so the integrated loudness meets the target, with the true peak kept under -1 dBTP."));
                    ui.horizontal(|ui| {
                        ui.label(tr("Target"));
                        target_combo(ui, "cut-auto-loudness-target", target);
                    });
                    let status = match (task.as_ref(), measured.as_ref()) {
                        (Some(t), _) => trf("Measuring… {p}%", &[("p", &format!("{}", js_round(f64::from(t.fraction()) * 100.0)))]),
                        (None, Some(Ok(m))) if m.integrated.is_finite() => trf(
                            "Integrated loudness {lufs} LUFS · true peak {peak} dBTP",
                            &[("lufs", &num(m.integrated)), ("peak", &num(m.true_peak))],
                        ),
                        (None, Some(Ok(_))) => tr("The sequence is silent.").into_owned(),
                        _ => trf("The loudness could not be measured: {error}", &[("error", "")]),
                    };
                    ui.label(status);
                    let ready = matches!(measured, Some(Ok(m)) if m.integrated.is_finite());
                    if let (true, Some(Ok(m)), Some(sq)) = (ready, measured.as_ref(), seq_now.as_ref()) {
                        let g = master_gain_for(sq, m, *target);
                        ui.label(trf("Master gain {gain} dB (now {now} dB)", &[("gain", &format!("{g:.2}")), ("now", &format!("{now_gain:.2}"))]));
                    }
                    ui.horizontal(|ui| {
                        if ui.add_enabled(ready, egui::Button::new(tr("Apply"))).clicked() {
                            apply = true;
                        }
                        if ui.button(tr("Cancel")).clicked() {
                            close = true;
                        }
                    });
                });
            if close && let Some(t) = task {
                t.stop();
            }
        }
        Some(Open::Clips { clips, target, task, .. }) => match task {
            None => {
                egui::Window::new(tr("Match Clip Loudness"))
                    .id(egui::Id::unique("cutAutoClipLoudness"))
                    .collapsible(false)
                    .resizable(false)
                    .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
                    .default_width(440.0)
                    .show(ctx, |ui| {
                        ui.label(trf(
                            "Clips: {n}. Each clip's volume is set so its own loudness meets the target.",
                            &[("n", &clips.len().to_string())],
                        ));
                        ui.horizontal(|ui| {
                            ui.label(tr("Target"));
                            target_combo(ui, "cut-auto-clip-target", target);
                        });
                        ui.horizontal(|ui| {
                            if ui.button(tr("Match")).clicked() {
                                start = true;
                            }
                            if ui.button(tr("Cancel")).clicked() {
                                close = true;
                            }
                        });
                    });
            }
            Some(t) => {
                egui::Window::new(tr("Measuring clip loudness…"))
                    .id(egui::Id::unique("cut-auto-task"))
                    .collapsible(false)
                    .resizable(false)
                    .anchor(Align2::CENTER_TOP, Vec2::new(0.0, 60.0))
                    .show(ctx, |ui| {
                        ui.add(ProgressBar::new(t.fraction()).desired_width(260.0).show_percentage());
                        if ui.button(tr("Cancel")).clicked() {
                            t.stop();
                            close = true;
                        }
                    });
            }
        },
    }
    if apply {
        apply_sequence(s);
    } else if start {
        start_clips(s);
    } else if close {
        s.features.audio.loudness.open = None;
    }
}
