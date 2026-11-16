//! The export queue (`ui-queue.js`): exports added from the export settings (Add to Queue) run one at a time in the
//! background while editing goes on, each with a copy of the project made when it was added. Each row shows the
//! preset, range, file, progress and state, and can be cancelled, removed, retried, moved up or down and, once
//! written, shown in Explorer.

use cut_export::{Done, Failure};
use cut_time::Fps;
use eframe::egui::{self, RichText};

use super::{Spec, format_bytes, format_seconds, said, start};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// Where a queued export is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Waiting,
    Running,
    Done,
    Failed,
    Cancelled,
}

/// One queued export.
pub struct QueueJob {
    pub id: u64,
    pub spec: Spec,
    pub seq_name: String,
    pub fps: Fps,
    pub preset: String,
    pub state: JobState,
    pub error: Option<String>,
    /// Bytes, seconds and what the check found.
    pub result: Option<(u64, f64, Vec<String>)>,
}

impl QueueJob {
    pub fn live(&self) -> bool {
        matches!(self.state, JobState::Waiting | JobState::Running)
    }

    fn name(&self) -> String {
        self.spec.path.file_name().unwrap_or_default().to_string_lossy().into_owned()
    }
}

/// Adds a job; it starts when nothing else exports.
pub fn add(s: &mut Shell, spec: Spec, seq_name: String, fps: Fps, preset: String) -> u64 {
    let ex = &mut s.features.export;
    ex.next_id += 1;
    let id = ex.next_id;
    ex.queue.push(QueueJob { id, spec, seq_name, fps, preset, state: JobState::Waiting, error: None, result: None });
    id
}

/// Starts the next waiting job when nothing exports.
pub fn kick(s: &mut Shell, ctx: &egui::Context) {
    if s.features.export.busy() {
        return;
    }
    let Some(j) = s.features.export.queue.iter_mut().find(|j| j.state == JobState::Waiting) else { return };
    j.state = JobState::Running;
    j.error = None;
    j.result = None;
    let (spec, id) = (j.spec.clone(), j.id);
    start(s, spec, Some(id), ctx);
}

/// A job's export ended.
pub fn finished(s: &mut Shell, id: u64, r: Result<Done, Failure>, cancelled: bool) {
    let Some(j) = s.features.export.queue.iter_mut().find(|j| j.id == id) else { return };
    let name = j.name();
    match r {
        _ if cancelled => j.state = JobState::Cancelled,
        Ok(d) => {
            j.state = JobState::Done;
            let problems = d
                .verified
                .map(|v| {
                    v.problems
                        .iter()
                        .map(|p| {
                            let params: Vec<(&str, &str)> = p.params.iter().map(|(k, v)| (*k, v.as_str())).collect();
                            trf(p.message, &params)
                        })
                        .collect()
                })
                .unwrap_or_default();
            j.spec.path = d.path;
            j.result = Some((d.bytes, d.seconds, problems));
            s.app.toast(trf("Exported {name}", &[("name", &name)]));
        }
        Err(f) => {
            j.state = JobState::Failed;
            let e = said(&f);
            j.error = Some(e.clone());
            s.app.report(trf("The export of {name} failed: {error}", &[("name", &name), ("error", &e)]));
        }
    }
}

fn range_text(j: &QueueJob) -> String {
    match j.spec.range {
        Some((a, b)) => trf(
            "In to Out ({from} – {to})",
            &[("from", &cut_time::timecode(a, j.fps)), ("to", &cut_time::timecode(b, j.fps))],
        ),
        None => tr("Entire sequence").into_owned(),
    }
}

/// The Export Queue panel.
pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    ui.label(
        RichText::new(tr(
            "Queued exports run one at a time while you keep editing. Playback may be slower while one runs.",
        ))
        .weak(),
    );
    ui.add_space(4.0);
    let progress = s.features.export.progress();
    let n = s.features.export.queue.len();
    let mut act: Option<(u64, &str)> = None;
    if n == 0 {
        ui.label(RichText::new(tr("No exports are queued. Choose Add to Queue in the export settings.")).weak());
    }
    for (i, j) in s.features.export.queue.iter().enumerate() {
        egui::Frame::group(ui.style()).show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new(j.name()).strong()).on_hover_text(j.spec.path.to_string_lossy());
            ui.label(format!("{} · {} · {}", j.preset, j.seq_name, range_text(j)));
            let fraction = match j.state {
                JobState::Running => progress.filter(|p| p.2 == Some(j.id)).map_or(0.0, |p| p.0),
                JobState::Done => 1.0,
                _ => 0.0,
            };
            let state = match j.state {
                JobState::Waiting => tr("Waiting").into_owned(),
                JobState::Running => {
                    trf("Exporting {pct}%", &[("pct", &((fraction * 100.0).floor() as u64).to_string())])
                }
                JobState::Done => match &j.result {
                    Some((b, secs, _)) => {
                        trf("Done: {size} in {time}", &[("size", &format_bytes(*b)), ("time", &format_seconds(*secs))])
                    }
                    None => tr("Done").into_owned(),
                },
                JobState::Failed => trf("Failed: {error}", &[("error", j.error.as_deref().unwrap_or(""))]),
                JobState::Cancelled => tr("Cancelled").into_owned(),
            };
            ui.add(egui::ProgressBar::new(fraction as f32).text(state));
            if let Some((_, _, p)) = &j.result
                && !p.is_empty()
            {
                ui.colored_label(
                    egui::Color32::from_rgb(0xe6, 0xc2, 0x29),
                    trf("The check found problems: {list}", &[("list", &p.join("; "))]),
                );
            }
            ui.horizontal(|ui| {
                let running = j.state == JobState::Running;
                if ui.add_enabled(i > 0 && !running, egui::Button::new("↑")).on_hover_text(tr("Move Up")).clicked() {
                    act = Some((j.id, "up"));
                }
                if ui
                    .add_enabled(i + 1 < n && !running, egui::Button::new("↓"))
                    .on_hover_text(tr("Move Down"))
                    .clicked()
                {
                    act = Some((j.id, "down"));
                }
                if j.live() && ui.button(tr("Cancel")).clicked() {
                    act = Some((j.id, "cancel"));
                }
                if matches!(j.state, JobState::Failed | JobState::Cancelled) && ui.button(tr("Retry")).clicked() {
                    act = Some((j.id, "retry"));
                }
                if j.state == JobState::Done && ui.button(tr("Open Folder")).clicked() {
                    act = Some((j.id, "open"));
                }
                if !running && ui.button(tr("Remove")).clicked() {
                    act = Some((j.id, "remove"));
                }
            });
        });
    }
    let finished = s.features.export.queue.iter().any(|j| !j.live());
    if ui.add_enabled(finished, egui::Button::new(tr("Clear Finished"))).clicked() {
        s.features.export.queue.retain(QueueJob::live);
    }
    if let Some((id, what)) = act {
        apply(s, id, what);
    }
}

fn apply(s: &mut Shell, id: u64, what: &str) {
    let q = &mut s.features.export.queue;
    let Some(i) = q.iter().position(|j| j.id == id) else { return };
    match what {
        "up" if i > 0 => q.swap(i, i - 1),
        "down" if i + 1 < q.len() => q.swap(i, i + 1),
        "cancel" => match q[i].state {
            JobState::Running => super::cancel(s, Some(id)),
            JobState::Waiting => q[i].state = JobState::Cancelled,
            _ => {}
        },
        "retry" => {
            q[i].state = JobState::Waiting;
            q[i].error = None;
        }
        "open" => super::reveal(&q[i].spec.path),
        "remove" if q[i].state != JobState::Running => {
            q.remove(i);
        }
        _ => {}
    }
}
