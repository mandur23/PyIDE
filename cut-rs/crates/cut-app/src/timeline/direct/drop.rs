//! Files dropped from Explorer onto a track (`ui-timeline.js`'s lanes `drop` and `dropFiles`): a file already in the
//! project is used as it is, the others are probed (this module's own importer, off the UI thread) and imported, and
//! everything is placed one after another from the frame under the pointer on that track's row (Ctrl inserts), a still
//! with the project's still length. The JavaScript makes the import and the placing two undo steps; here they are one.
//!
//! Windows hands a dropped file over without the pointer's position (winit's drop target drops it), and moves of the
//! pointer during an Explorer drag do not reach the window. So a drop is placed where the pointer was last seen over
//! the lanes when it is still known, else at the first position seen within a second and a half after it; dropped
//! anywhere else, the files are imported into the Project panel as before.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use cut_model::{Id, TrackKind};
use cut_time::{Ticks, snap};
use eframe::egui::{self, Color32, Pos2, Rect, Stroke};

use super::super::layout::{self, RowKind};
use crate::cmd;
use crate::i18n::tr;
use crate::import::{Importer, Probed};
use crate::shell::{Dialog, Shell};

/// How long a drop waits for the pointer's position.
const WAIT: Duration = Duration::from_millis(1500);

/// Where dropped files go: the sequence, the frame, the row's kind and number, and the mode.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub seq: Id,
    pub at: Ticks,
    pub row: Option<(RowKind, usize)>,
    pub insert: bool,
}

/// A drop being imported.
struct Placing {
    target: Target,
    /// The files in their order, each with its media once known.
    files: Vec<(PathBuf, Option<Id>)>,
    probed: Vec<Probed>,
}

/// The drops on their way.
#[derive(Default)]
pub struct Drops {
    importer: Option<Importer>,
    placing: Option<Placing>,
    /// Dropped while the pointer's place was not known.
    unplaced: Option<(Vec<PathBuf>, bool, Instant)>,
}

/// The drop guide: a line at the pointer while files are dragged over the lanes.
pub fn guide(ui: &egui::Ui, lanes: Rect) {
    let hovering = ui.input(|i| !i.raw.hovered_files.is_empty());
    if let Some(p) = ui.ctx().pointer_latest_pos().filter(|p| hovering && lanes.contains(*p)) {
        ui.painter_at(lanes).vline(p.x, lanes.y_range(), Stroke::new(1.0, Color32::from_rgb(0x4f, 0xc3, 0xf7)));
    }
}

/// Files dropped on the window, before the shell imports them -> whether they land on the timeline (taken here).
pub fn files_dropped(s: &mut Shell, paths: &[PathBuf], ctx: &egui::Context) -> bool {
    if s.app.sequence().is_none() || s.timeline.direct.lanes.is_none() {
        return false;
    }
    let (pos, ctrl) = ctx.input(|i| (i.pointer.latest_pos(), i.modifiers.ctrl));
    match pos {
        Some(p) => match target_at(s, p, ctrl) {
            Some(t) => {
                start(s, paths.to_vec(), t, ctx);
                true
            }
            None => false,
        },
        None => {
            s.timeline.direct.drops.unplaced = Some((paths.to_vec(), ctrl, Instant::now()));
            true
        }
    }
}

/// The drop's place for a pointer at `p` on the lanes, or `None` elsewhere (`dropPlan`'s time: the frame under the
/// pointer, snapped to the edges when snapping is on).
pub fn target_at(s: &Shell, p: Pos2, insert: bool) -> Option<Target> {
    let lanes = s.timeline.direct.lanes.filter(|l| l.contains(p))?;
    let seq = s.app.sequence()?;
    let tl = &s.timeline;
    let h = tl.hit_at(lanes, p);
    let row = h.row.and_then(|i| tl.layout.rows.get(i)).map(|r| (r.kind, r.index));
    let mut at = snap(h.t.max(0.0) as Ticks, seq.fps, true);
    if s.app.snapping {
        let pts = tl.layout.snap_points(seq, s.app.t, [s.app.in_out.in_, s.app.in_out.out], &[]);
        at += layout::snap_delta(&[at], 0, &pts, layout::snap_limit(tl.view.pps)).0;
    }
    Some(Target { seq: seq.id, at: at.max(0), row, insert })
}

/// Starts placing `paths` at `t`: known files at once, the others once probed.
pub fn start(s: &mut Shell, paths: Vec<PathBuf>, t: Target, ctx: &egui::Context) {
    let (dirs, paths): (Vec<PathBuf>, Vec<PathBuf>) = paths.into_iter().partition(|p| p.is_dir());
    if !dirs.is_empty() {
        let bin = s.project.current_bin();
        s.import_paths(dirs, bin);
    }
    let p = s.app.project();
    let known = |path: &Path| {
        p.media
            .iter()
            .find(|m| Path::new(&m.path) == path || m.path.eq_ignore_ascii_case(&path.to_string_lossy()))
            .map(|m| m.id)
    };
    let files: Vec<(PathBuf, Option<Id>)> = paths.iter().map(|x| (x.clone(), known(x))).collect();
    let new: Vec<PathBuf> = files.iter().filter(|f| f.1.is_none()).map(|f| f.0.clone()).collect();
    if files.is_empty() {
        return;
    }
    let d = &mut s.timeline.direct.drops;
    let wake = ctx.clone();
    d.importer.get_or_insert_with(|| Importer::with_wake(move || wake.request_repaint())).start(new);
    d.placing = Some(Placing { target: t, files, probed: Vec::new() });
}

/// Each frame: a drop waiting for the pointer, and the probes of one being placed.
pub fn frame(s: &mut Shell, ctx: &egui::Context) {
    if let Some((paths, ctrl, since)) = s.timeline.direct.drops.unplaced.take() {
        match ctx.pointer_latest_pos() {
            Some(p) => match target_at(s, p, ctrl) {
                Some(t) => start(s, paths, t, ctx),
                None => s.import_paths(paths, s.project.current_bin()),
            },
            None if since.elapsed() > WAIT => s.import_paths(paths, s.project.current_bin()),
            None => {
                s.timeline.direct.drops.unplaced = Some((paths, ctrl, since));
                ctx.request_repaint_after(Duration::from_millis(50));
            }
        }
    }
    let d = &mut s.timeline.direct.drops;
    let Some(placing) = d.placing.as_mut() else { return };
    if let Some(imp) = d.importer.as_mut() {
        placing.probed.extend(imp.poll());
        if imp.pending() > 0 {
            ctx.request_repaint_after(Duration::from_millis(50));
            return;
        }
    }
    if let Some(p) = d.placing.take() {
        place(s, p);
    }
}

/// The video and audio tracks a row takes (`dropTracks`): a video row its own and the audio of its number (the
/// last audio when there are fewer), an audio row the other way round, elsewhere the patched tracks.
fn tracks(s: &Shell, seq: &cut_model::Sequence, row: Option<(RowKind, usize)>) -> (Option<Id>, Option<Id>) {
    let video: Vec<Id> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).map(|t| t.id).collect();
    let audio: Vec<Id> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Audio).map(|t| t.id).collect();
    let near = |list: &[Id], i: usize| list.get(i.min(list.len().saturating_sub(1))).copied();
    match row {
        Some((RowKind::Video, i)) => (video.get(i).copied(), near(&audio, i)),
        Some((RowKind::Audio, i)) => (near(&video, i), audio.get(i).copied()),
        _ => {
            let (v, a) = crate::edit::patch_for(seq, &s.app.edit.patch);
            (v.or(video.first().copied()), a.or(audio.first().copied()))
        }
    }
}

/// Imports what was probed and places every file, one undo step; refused files are listed as an import's are.
fn place(s: &mut Shell, mut p: Placing) {
    if s.app.sequence_id != Some(p.target.seq) {
        return;
    }
    let mut failed = Vec::new();
    let mut entries = Vec::new();
    for got in std::mem::take(&mut p.probed) {
        match got.result {
            Ok(m) => entries.push((got.path, m)),
            Err(r) => failed.push((got.path, crate::import::refusal_text(&r))),
        }
    }
    s.app.history.begin(&tr("Import"));
    if !entries.is_empty() {
        let list = entries.iter().map(|e| e.1.clone()).collect();
        match s.app.history.apply(&cmd::import_media(list, s.project.current_bin())) {
            Ok(r) => {
                let ids = r["ids"].as_array().cloned().unwrap_or_default();
                for ((path, _), id) in entries.iter().zip(ids) {
                    if let Some(f) = p.files.iter_mut().find(|f| &f.0 == path) {
                        f.1 = id.as_str().map(Id::new);
                    }
                }
            }
            Err(e) => s.app.report(tr(&e.message).into_owned()),
        }
    }
    let Some(seq) = s.app.sequence().cloned() else {
        s.app.history.cancel();
        return;
    };
    let (v, a) = tracks(s, &seq, p.target.row);
    let mode = if p.target.insert { "insert" } else { "overwrite" };
    let mut t = p.target.at;
    let mut placed = Vec::new();
    for id in p.files.iter().filter_map(|f| f.1) {
        let Some(m) = s.app.project().media(id) else { continue };
        let has_v = m.kind == cut_model::MediaKind::Image || m.video.is_some();
        let (mv, ma) = (v.filter(|_| has_v), a.filter(|_| m.audio.is_some()));
        match s.app.history.apply(&cmd::place(seq.id, id, mv, ma, t, mode)) {
            Ok(r) => {
                let ids: Vec<Id> =
                    r["ids"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).map(Id::new).collect();
                let now = s.app.sequence();
                t = ids
                    .iter()
                    .filter_map(|c| now.and_then(|q| q.clip(*c)).map(cut_model::Clip::end))
                    .max()
                    .unwrap_or(t);
                placed.extend(ids);
            }
            Err(e) => {
                s.app.history.cancel();
                s.app.report(tr(&e.message).into_owned());
                return;
            }
        }
    }
    s.app.history.commit();
    s.app.select(placed, false, false);
    s.app.set_time(p.target.at);
    if !failed.is_empty() {
        s.dialog = Some(Dialog::ImportErrors(failed));
    }
}
