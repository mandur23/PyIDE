//! Detect Scene Changes (`ui-auto.js detectScenes`): the selected video clips (else every video clip) looked at frame
//! by frame for hard cuts ([`super::pictures`]), then sequence markers at the cuts or the clips split there, one undo
//! step.
//!
//! Threads: the frames are drawn 64 pixels wide and read back on the analysis thread by an engine of its own on the
//! window's GPU (as Auto Color's), waiting while the player plays; the histograms and the search run on that thread
//! too, and the window only takes the cut times when they come.

use std::collections::VecDeque;
use std::path::Path;

use cut_engine::{Engine, RenderOptions};
use cut_formats::{FileReader, Kind, probe};
use cut_model::commands::build as C;
use cut_model::{Id, MediaKind, Project, TrackKind};
use eframe::egui;
use serde_json::{Value as Json, json};

use super::pictures::{detect_scenes, histogram};
use super::{Job, Step, Stop, dialog, number};
use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::state::App;

/// The pictures' width (`detectScenes`' 64-pixel canvas).
const WIDTH: u32 = 64;
/// Frames between two compared.
const STEP: i64 = 2;
/// Histograms kept while searching (the JavaScript's `memo`).
const MEMO: usize = 16;

/// What is done at each change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Markers,
    Split,
}

impl Action {
    fn word(self) -> &'static str {
        match self {
            Action::Markers => "markers",
            Action::Split => "split",
        }
    }
}

/// The dialog's settings: the threshold (percent) and the action.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ask {
    pub threshold: f64,
    pub action: Action,
    /// Video clips it will look at.
    pub clips: usize,
}

/// The cuts found in a clip: the source times (ticks) of the first frame of each new scene.
pub type Found = Vec<(Id, Vec<i64>)>;

/// Detect Scene Changes' state.
#[derive(Default)]
pub struct ScenesUi {
    pub open: Option<Ask>,
    pub job: Option<Job<Found>>,
    plan: Option<(Vec<Id>, Action)>,
}

/// The video clips to look at (`pictureClips`): the selected ones showing a video file, else every such clip, by
/// start.
pub fn picture_clips(app: &App) -> Vec<Id> {
    let Some(seq) = app.sequence() else { return Vec::new() };
    let p = app.project();
    let picture = |c: &&cut_model::Clip| {
        seq.kind_of(c.track) == Some(TrackKind::Video)
            && !c.is_freeze()
            && c.media_id().and_then(|m| p.media(m)).is_some_and(|m| m.kind == MediaKind::Video)
    };
    let picked: Vec<&cut_model::Clip> = seq.clips().filter(|c| app.selection.contains(&c.id)).filter(picture).collect();
    let mut out = if picked.is_empty() { seq.clips().filter(picture).collect() } else { picked };
    out.sort_by_key(|c| c.start);
    out.into_iter().map(|c| c.id).collect()
}

/// Detect Scene Changes… chosen: the dialog with the last settings.
pub fn open(s: &mut Shell) {
    let clips = picture_clips(&s.app);
    if clips.is_empty() {
        s.app.toast(tr("There are no video clips to analyze."));
        return;
    }
    let threshold = super::settings(s, "scenes", &[("threshold", 35.0)])[0];
    let action = match super::setting_word(s, "scenes", "action", &["markers", "split"]) {
        Some("split") => Action::Split,
        _ => Action::Markers,
    };
    s.features.auto.scenes.open = Some(Ask { threshold, action, clips: clips.len() });
}

/// One clip to look at: its id, its file, and the source span it shows.
struct Look {
    clip: Id,
    media: Id,
    path: String,
    lo: f64,
    hi: f64,
    size: (u32, u32),
}

/// Detect pressed: the settings kept and the clips looked at on the analysis thread.
pub fn start(s: &mut Shell, threshold: f64, action: Action) {
    s.features.auto.scenes.open = None;
    super::remember(s, "scenes", &[("threshold", threshold)]);
    super::remember_word(s, "scenes", "action", action.word());
    let ids = picture_clips(&s.app);
    let Some(seq) = s.app.sequence() else { return };
    let p = s.app.project();
    let looks: Vec<Look> = ids
        .iter()
        .filter_map(|id| {
            let c = seq.clip(*id)?;
            let m = p.media(c.media_id()?)?;
            let (mw, mh) = m.video.as_ref().map_or((16.0, 9.0), |v| (v.w, v.h));
            let (mw, mh) = (if mw > 0.0 { mw } else { 16.0 }, if mh > 0.0 { mh } else { 9.0 });
            let h = cut_audio::util::js_round(f64::from(WIDTH) * mh / mw).max(8.0) as u32;
            let (lo, hi) = (c.in_.min(c.out), c.in_.max(c.out));
            Some(Look { clip: c.id, media: m.id, path: m.path.clone(), lo, hi, size: (WIDTH, h) })
        })
        .collect();
    let project = p.clone();
    let gpu = s.monitors.as_ref().map(|m| (m.program.engine.device().clone(), m.program.engine.queue().clone()));
    let job = Job::start(tr("Detecting scene changes…").into_owned(), true, move |step| {
        let mut engine = match gpu {
            Some((d, q)) => Engine::new(d, q),
            None => Engine::headless().map_err(|e| Ok(e.to_string()))?,
        };
        let n = looks.len().max(1) as f64;
        let mut out = Vec::new();
        for (i, look) in looks.iter().enumerate() {
            let part = |f: f64| (i as f64 + f) / n;
            if let Some(times) = look_at(&mut engine, &project, look, threshold / 100.0, step, part)? {
                out.push((look.clip, times));
            }
        }
        Ok(out)
    });
    let a = &mut s.features.auto.scenes;
    a.job = Some(job);
    a.plan = Some((ids, action));
}

/// The cuts of one clip -> their source times, or `None` when its file has no video to read (skipped, as the
/// JavaScript does).
fn look_at(
    engine: &mut Engine,
    project: &Project,
    look: &Look,
    threshold: f64,
    step: &Step,
    part: impl Fn(f64) -> f64,
) -> Result<Option<Vec<i64>>, Stop> {
    let Ok(reader) = FileReader::open(Path::new(&look.path)) else { return Ok(None) };
    let name = look.path.rsplit(['/', '\\']).next().unwrap_or(&look.path);
    let src = probe::open(&reader, name);
    let Some(track) = src.tracks.iter().find(|t| t.kind() == Kind::Video).filter(|_| src.error.is_none()) else {
        return Ok(None);
    };
    let s = &track.samples;
    if s.is_empty() {
        return Ok(None);
    }
    let mut rank_of = vec![0u32; s.count()];
    for (r, &i) in s.order.iter().enumerate() {
        rank_of[i as usize] = r as u32;
    }
    let pts_of = |r: i64| s.pts[s.order[r as usize] as usize];
    let rank_at = |t: f64| i64::from(rank_of[probe::sample_at_time(track, t.floor() as i64).unwrap_or(0)]);
    let (r0, r1) = (rank_at(look.lo), rank_at(look.lo.max(look.hi - 1.0)));
    let unreadable = || Ok("The clip's media cannot be read.".to_owned());
    let opts = RenderOptions { wait: Some(std::time::Duration::from_secs(20)), ..RenderOptions::default() };
    let mut memo: VecDeque<(i64, Vec<f32>)> = VecDeque::new();
    let hist_at = |r: i64| -> Result<Vec<f32>, Stop> {
        if let Some((_, h)) = memo.iter().find(|(k, _)| *k == r) {
            return Ok(h.clone());
        }
        step.step().map_err(Err)?;
        let got = engine.render_media(project, look.media, pts_of(r), look.size, &opts).map_err(|_| unreadable())?;
        if !got.failed.is_empty() {
            return Err(unreadable());
        }
        let (w, h) = look.size;
        let hist = histogram(&engine.read_pixels(), w as usize, h as usize, 8);
        memo.push_back((r, hist.clone()));
        if memo.len() > MEMO {
            memo.pop_front();
        }
        Ok(hist)
    };
    let cuts = detect_scenes(r0, r1, hist_at, threshold, STEP, |p| step.progress(part(p)))?;
    Ok(Some(cuts.into_iter().map(pts_of).collect()))
}

/// The commands for the cuts found (`detectScenes`' second half): for each clip still there, its cut times on the
/// timeline on whole frames inside it, then markers named "Scene 2", "Scene 3"… or splits from the last back ->
/// `(commands, changes)`.
pub fn commands(app: &App, found: &Found, ids: &[Id], action: Action) -> (Vec<Json>, usize) {
    let Some(seq) = app.sequence() else { return (Vec::new(), 0) };
    let f = cut_model::query::frame(seq.fps) as f64;
    let sid = seq.id.as_str();
    let mut cmds = Vec::new();
    let mut n = 0;
    for (id, times) in found {
        let Some(c) = seq.clip(*id).filter(|_| ids.contains(id)) else { continue };
        let (start, end) = (c.start as f64, c.end() as f64);
        let mut at: Vec<f64> = Vec::new();
        for p in times {
            let t = cut_audio::util::js_round(c.timeline_time(*p as f64).unwrap_or(0.0) / f) * f;
            if !at.contains(&t) {
                at.push(t);
            }
        }
        at.retain(|t| *t > start && *t < end);
        at.sort_by(f64::total_cmp);
        n += at.len();
        match action {
            Action::Split => {
                for t in at.iter().rev() {
                    cmds.push(C::split(sid, *t as i64, json!({ "clipIds": [c.id.as_str()] })));
                }
            }
            Action::Markers => {
                for t in &at {
                    let name = trf("Scene {n}", &[("n", &(cmds.len() + 2).to_string())]);
                    let marker = json!({ "t": *t as i64, "kind": "comment", "color": "orange", "name": name });
                    cmds.push(C::add_marker(sid, marker, json!({})));
                }
            }
        }
    }
    (cmds, n)
}

/// Takes in the cuts and adds the markers or splits.
pub fn poll(s: &mut Shell, playing: bool) {
    let Some(out) = s.features.auto.scenes.job.as_ref().and_then(|j| j.poll(playing)) else { return };
    s.features.auto.scenes.job = None;
    let plan = s.features.auto.scenes.plan.take();
    let (Some(found), Some((ids, action))) = (super::ended(s, out), plan) else { return };
    let (cmds, n) = commands(&s.app, &found, &ids, action);
    if cmds.is_empty() {
        s.app.toast(tr("No scene changes were found."));
        return;
    }
    let label = if action == Action::Split { "Split at Scene Changes" } else { "Add Scene Markers" };
    if s.app.exec(&C::batch(label, cmds)).is_some() {
        s.app.toast(trf("Scene changes found: {n}.", &[("n", &n.to_string())]));
    }
}

/// The dialog, each frame.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut o) = s.features.auto.scenes.open else { return };
    let (mut go, mut cancel) = (false, false);
    dialog("Detect Scene Changes", "cutAutoScenes", 440.0).show_titled(ctx, tr("Detect Scene Changes"), None, |ui| {
        ui.label(trf(
            "Video clips: {n}. A scene change is where the colours of one frame differ from the frame before by more than the threshold.",
            &[("n", &o.clips.to_string())],
        ));
        egui::Grid::new("cut-auto-scenes").num_columns(2).show(ui, |ui| {
            ui.label(tr("Threshold"));
            number(ui, &mut o.threshold, (5.0, 95.0, 1.0), 0, "%");
            ui.end_row();
            ui.label(tr("At each change"));
            let name = |a: Action| match a {
                Action::Markers => tr("Add sequence markers"),
                Action::Split => tr("Split the clips"),
            };
            egui::ComboBox::from_id_salt("cut-auto-scene-action").icon(crate::theme::combo_icon).selected_text(name(o.action)).show_ui(ui, |ui| {
                for a in [Action::Markers, Action::Split] {
                    ui.selectable_value(&mut o.action, a, name(a));
                }
            });
            ui.end_row();
        });
        crate::panels::dialogs::actions(ui, |ui| {
            go = crate::panels::dialogs::primary(ui, tr("Detect")).clicked();
            cancel = ui.button(tr("Cancel")).clicked();
        });
    });
    s.features.auto.scenes.open = Some(o);
    if go {
        start(s, o.threshold, o.action);
    } else if cancel {
        s.features.auto.scenes.open = None;
    }
}
