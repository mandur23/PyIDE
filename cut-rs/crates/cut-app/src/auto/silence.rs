//! Remove Silence (`ui-auto.js removeSilence`): the quiet stretches of the selected clips with sound (or of every
//! clip with sound), measured once on the analysis thread, previewed on the timeline while the dialog's settings
//! change, then ripple-deleted from their tracks and the tracks linked to them in one undo step.

use cut_audio::analysis::{silence_ranges, total};
use cut_model::commands::build as C;
use cut_model::{Id, Sequence};
use cut_time::TICKS;
use eframe::egui::{self, Color32, Rect};

use super::levels::{self, Read};
use super::{Job, dialog, number};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::App;
use crate::timeline::layout::Row;

const DEFAULTS: [(&str, f64); 3] = [("threshold", -40.0), ("minLength", 0.5), ("margin", 0.1)];

/// The settings: quieter than (dBFS), at least (s), kept on each side (s).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Silence {
    pub threshold: f64,
    pub min_length: f64,
    pub margin: f64,
}

/// Time ranges an automation previews on the timeline, over the tracks named (all when `None`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Overlay {
    pub ranges: Vec<(f64, f64)>,
    pub tracks: Option<Vec<Id>>,
}

/// What a removal cuts: the ranges (ticks), the tracks they are cut from, and the tracks the cut changes.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Plan {
    pub ranges: Vec<(f64, f64)>,
    pub tracks: Vec<Id>,
    pub changed: Vec<Id>,
}

/// Remove Silence's state.
#[derive(Default)]
pub struct SilenceUi {
    pub job: Option<Job<levels::Measured>>,
    /// The clips measured and the settings in the dialog, once measured.
    pub open: Option<(Vec<Id>, Silence)>,
    measuring: Vec<Id>,
}

/// The tracks a ripple delete of these clips' ranges cuts (theirs and the linked clips') and those it changes:
/// those and every sync-locked one, never a locked one (`rippleTracks`).
pub fn ripple_tracks(seq: &Sequence, clips: &[Id]) -> (Vec<Id>, Vec<Id>) {
    let mut tracks: Vec<Id> = Vec::new();
    for c in clips.iter().filter_map(|id| seq.clip(*id)) {
        for t in std::iter::once(c.track).chain(seq.linked_clips(c).iter().map(|l| l.track)) {
            if !tracks.contains(&t) {
                tracks.push(t);
            }
        }
    }
    let changed = seq.tracks.iter().filter(|t| !t.locked && (tracks.contains(&t.id) || t.sync_lock)).map(|t| t.id);
    let changed = changed.collect();
    (tracks, changed)
}

/// The quiet stretches of the measured clips for `o` (`silenceOf`).
pub fn plan(app: &App, clips: &[Id], o: Silence, lv: &levels::Cache) -> Plan {
    let Some(seq) = app.sequence() else { return Plan::default() };
    let t = TICKS as f64;
    let now: Vec<Id> = clips.iter().copied().filter(|id| seq.clip(*id).is_some()).collect();
    let mut spans = Vec::new();
    let mut loud = Vec::new();
    for c in now.iter().filter_map(|id| seq.clip(*id)) {
        spans.push(levels::span(c));
        if let Some(l) = Read::of(app.project(), c).and_then(|r| lv.get(&r.key)) {
            loud.extend(levels::loud_on_timeline(c, &l, o.threshold));
        }
    }
    let frame = cut_model::query::frame(seq.fps) as f64;
    let ranges = silence_ranges(&spans, &loud, o.min_length * t, o.margin * t, frame);
    let (tracks, changed) = ripple_tracks(seq, &now);
    Plan { ranges, tracks, changed }
}

/// Remove Silence… chosen: the clips with sound measured.
pub fn open(s: &mut Shell) {
    let clips = crate::audio::essential::sound_clips(&s.app, true);
    let Some(seq) = s.app.sequence().filter(|_| !clips.is_empty()) else {
        s.app.toast(tr("There are no clips with sound to analyze."));
        return;
    };
    let reads: Vec<Read> = clips
        .iter()
        .filter_map(|id| seq.clip(*id))
        .filter_map(|c| Read::of(s.app.project(), c))
        .filter(|r| s.features.auto.levels.get(&r.key).is_none())
        .collect();
    let job =
        Job::start(tr("Analyzing the sound…").into_owned(), false, move |step| levels::measure_all(&reads, step));
    s.features.auto.silence.job = Some(job);
    s.features.auto.silence.measuring = clips;
}

/// Takes in the measurement and opens the dialog with its preview.
pub fn poll(s: &mut Shell, playing: bool) {
    let Some(out) = s.features.auto.silence.job.as_ref().and_then(|j| j.poll(playing)) else { return };
    s.features.auto.silence.job = None;
    let clips = std::mem::take(&mut s.features.auto.silence.measuring);
    let Some(got) = super::ended(s, out) else { return };
    for (k, l) in got {
        s.features.auto.levels.put(k, l);
    }
    let v = super::settings(s, "silence", &DEFAULTS);
    s.features.auto.silence.open = Some((clips, Silence { threshold: v[0], min_length: v[1], margin: v[2] }));
}

/// Remove pressed: the dialog closes and the ranges are ripple-deleted, one step named Remove Silence.
pub fn remove(s: &mut Shell) -> bool {
    let Some((clips, o)) = s.features.auto.silence.open.clone() else { return false };
    super::remember(s, "silence", &[("threshold", o.threshold), ("minLength", o.min_length), ("margin", o.margin)]);
    let p = plan(&s.app, &clips, o, &s.features.auto.levels);
    close(s);
    if p.ranges.is_empty() {
        s.app.toast(tr("No silence was found with these settings."));
        return false;
    }
    let Some(seq) = s.app.sequence_id else { return false };
    let tracks: Vec<&str> = p.tracks.iter().map(|t| t.as_str()).collect();
    let cmds =
        p.ranges.iter().rev().map(|(a, b)| C::extract(seq.as_str(), *a as i64, *b as i64, Some(&tracks))).collect();
    let ok = s.app.exec(&C::batch("Remove Silence", cmds)).is_some();
    if ok {
        s.app.selection.clear();
        s.app.toast(trf(
            "Silences removed: {n} ({time}).",
            &[("n", &p.ranges.len().to_string()), ("time", &super::seconds(total(&p.ranges)))],
        ));
    }
    ok
}

/// The dialog closed: the preview goes.
pub fn close(s: &mut Shell) {
    s.features.auto.silence.open = None;
    s.timeline.overlay = None;
}

/// The dialog and the preview, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let Some((clips, mut o)) = s.features.auto.silence.open.clone() else { return };
    let p = plan(&s.app, &clips, o, &s.features.auto.levels);
    s.timeline.overlay = Some(Overlay { ranges: p.ranges.clone(), tracks: Some(p.changed.clone()) });
    let (mut go, mut cancel) = (false, false);
    dialog("Remove Silence", "cutAutoSilence", 440.0).show_titled(ctx, tr("Remove Silence"), None, |ui| {
        ui.label(trf(
            "Clips with sound: {n}. Quiet stretches are ripple-deleted from their tracks and the tracks linked to them.",
            &[("n", &clips.len().to_string())],
        ));
        egui::Grid::new("cut-auto-silence").num_columns(2).show(ui, |ui| {
            ui.label(tr("Quieter than"));
            number(ui, &mut o.threshold, (-90.0, -5.0, 1.0), 0, "dB");
            ui.end_row();
            ui.label(tr("At least"));
            number(ui, &mut o.min_length, (0.1, 10.0, 0.05), 2, "s");
            ui.end_row();
            ui.label(tr("Keep on each side"));
            number(ui, &mut o.margin, (0.0, 2.0, 0.05), 2, "s");
            ui.end_row();
        });
        ui.label(if p.ranges.is_empty() {
            tr("No silence was found with these settings.").into_owned()
        } else {
            trf(
                "Cuts: {n} · {time} removed",
                &[("n", &p.ranges.len().to_string()), ("time", &super::seconds(total(&p.ranges)))],
            )
        });
        crate::panels::dialogs::actions(ui, |ui| {
            go = crate::panels::dialogs::primary(ui, tr("Remove")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    if let Some(open) = &mut s.features.auto.silence.open {
        open.1 = o;
    }
    if go {
        remove(s);
    } else if cancel {
        close(s);
    }
}

/// Draws an overlay over the lanes (`v.overlay`): each range shaded over the tracks it names, edged top to bottom.
pub fn paint(
    painter: &egui::Painter,
    lanes: Rect,
    rows: &[Row],
    scroll_y: f32,
    x_of: impl Fn(f64) -> f32,
    o: &Overlay,
    color: Color32,
) {
    for &(a, b) in &o.ranges {
        let (x1, x2) = (x_of(a), x_of(b));
        if x2 < lanes.left() || x1 > lanes.right() {
            continue;
        }
        let bw = (x2 - x1).max(1.0);
        let fill = color.gamma_multiply(0.28);
        match &o.tracks {
            Some(list) => {
                for r in rows.iter().filter(|r| r.id.is_some_and(|id| list.contains(&id))) {
                    let top = lanes.top() + r.y - scroll_y;
                    painter.rect_filled(Rect::from_min_size(egui::pos2(x1, top), egui::vec2(bw, r.h)), 0.0, fill);
                }
            }
            None => {
                painter.rect_filled(Rect::from_x_y_ranges(x1..=x1 + bw, lanes.y_range()), 0.0, fill);
            }
        }
        let edge = egui::Stroke::new(1.0, color.gamma_multiply(0.9));
        painter.vline(x1.round() - 0.5, lanes.y_range(), edge);
        painter.vline(x2.round() - 0.5, lanes.y_range(), edge);
    }
}
