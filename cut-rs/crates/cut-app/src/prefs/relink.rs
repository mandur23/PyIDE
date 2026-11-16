//! Offline media and relinking (`ui-project.js` `checkOffline`, `relinkCheck`, `relinkTo`, `findInFolder`,
//! `relinkDialog`, `findMissing`; `main/cut/find.js` `findMedia`).
//!
//! Find Missing Media checks every media file; the offline ones are listed in the Relink Media dialog. Find in
//! Folder searches a folder for each by file name and size, else by name and a duration within a frame, and relinks
//! what it found as one undo step; Locate picks one file. A file is read like an import first: another kind of media,
//! or a file without the picture or the sound the media had, is refused with the reason; a shorter one is asked
//! about, since the clips past its end are shortened or removed. Searching and probing run on a thread.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};

use cut_model::commands::build as C;
use cut_model::{Id, Media, MediaKind};
use cut_time::TICKS;
use eframe::egui::{self, RichText};
use serde_json::{Value as Json, json};

use super::Screen;
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// What a thread brings back.
enum Found {
    /// Find in Folder: the media found and the files read, or why the folder could not be searched.
    Folder(Result<Vec<(Id, Json)>, String>),
    /// Locate: the media and the file read (or the refusal's text).
    Located(Id, Result<Json, String>),
}

/// The answer of a file or folder dialog running on its own thread.
type Picked = Receiver<Option<Vec<PathBuf>>>;

/// A shorter file waiting for the person's answer (`shorterOk`).
pub struct Shorter {
    pub media: Id,
    pub file: Json,
    pub text: String,
}

/// The relink state.
#[derive(Default)]
pub struct Relink {
    /// Media whose file was not there at the last check (`ui.offline`).
    pub offline: HashSet<Id>,
    /// The media the dialog lists (offline when it opened).
    pub listed: Vec<Id>,
    pub status: String,
    pub shorter: Option<Shorter>,
    picking: Option<(Option<Id>, Picked)>,
    working: Option<Receiver<Found>>,
}

/// The file name of a media path (`ui.basename`).
fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

/// One frame of a media item, for "the same length" (`frameOf`).
fn frame_of(m: &Media) -> f64 {
    let has_fps = m.video.as_ref().is_some_and(|v| v.extra.get("fps").is_some_and(|f| !f.is_null()));
    if has_fps { cut_time::frame_start(1, crate::edit::source::rate_of(m)) as f64 } else { TICKS as f64 / 100.0 }
}

/// Checks every media file (`checkOffline`) -> the offline ones.
pub fn check_offline(s: &mut Shell) -> Vec<Id> {
    let files: Vec<(Id, String)> = s.app.project().media.iter().map(|m| (m.id, m.path.clone())).collect();
    let list = offline_of(&files);
    s.features.prefs.relink.offline = list.iter().copied().collect();
    list
}

/// Of media `(id, path)`, the ones whose file is not there.
pub fn offline_of(files: &[(Id, String)]) -> Vec<Id> {
    files.iter().filter(|(_, p)| !Path::new(p).is_file()).map(|(id, _)| *id).collect()
}

/// Find Missing Media (`findMissing`): every file checked again, the offline ones in the dialog.
pub fn find_missing(s: &mut Shell) {
    let ids = check_offline(s);
    if ids.is_empty() {
        s.app.toast(tr("No media is missing."));
        return;
    }
    list(s, ids);
}

/// A project opened with offline media: the Relink Media dialog at once (`checkOffline` asking). `CUT_DIALOG`
/// answers it in tests and scripted runs: without a `relink` key (or with `null`) the dialog is closed as Cancel
/// closes it.
pub fn offer(s: &mut Shell, ids: Vec<Id>) {
    if ids.is_empty() || Shell::dialog_override("relink").is_some_and(|answer| answer.is_none()) {
        return;
    }
    list(s, ids);
}

/// The Relink Media dialog listing `ids`.
fn list(s: &mut Shell, ids: Vec<Id>) {
    let r = &mut s.features.prefs.relink;
    r.listed = ids;
    r.status.clear();
    s.features.prefs.screen = Some(Screen::Relink);
}

/// Files of the given names under `folder` (`findMedia`): `wanted` is (name, size); a file of that name in any case
/// and, when a size is given, that size. -> name as given -> path; `Err` when the folder is not a local folder.
pub fn find_media(folder: &Path, wanted: &[(String, Option<u64>)]) -> Result<HashMap<String, PathBuf>, String> {
    let real = crate::files::local_path(&folder.to_string_lossy()).map_err(|e| e.message)?;
    let root = PathBuf::from(real);
    if !root.is_dir() {
        return Err(if root.exists() { "not a folder".into() } else { "no such folder".into() });
    }
    let mut by_name: HashMap<String, Vec<(String, Option<u64>)>> = HashMap::new();
    for (name, size) in wanted.iter().take(100_000).filter(|(n, _)| !n.is_empty()) {
        by_name.entry(name.to_lowercase()).or_default().push((name.clone(), *size));
    }
    let mut found: HashMap<String, PathBuf> = HashMap::new();
    let mut left = by_name.len();
    if left == 0 {
        return Ok(found);
    }
    crate::import::walk(&root, |p, _| {
        let name = p.file_name().map_or_else(String::new, |n| n.to_string_lossy().to_lowercase());
        let Some(list) = by_name.get(&name) else { return true };
        let mut size = None;
        for (w, want) in list {
            if found.contains_key(w) {
                continue;
            }
            if let Some(want) = want {
                if size.is_none() {
                    match std::fs::metadata(&p) {
                        Ok(m) => size = Some(m.len()),
                        Err(_) => return true,
                    }
                }
                if size != Some(*want) {
                    continue;
                }
            }
            found.insert(w.clone(), p.clone());
        }
        if list.iter().all(|(w, _)| found.contains_key(w)) {
            by_name.remove(&name);
            left -= 1;
        }
        left > 0
    });
    Ok(found)
}

/// What a file is, for the refusal (`what`).
fn what(kind: &str, video: bool, audio: bool) -> String {
    tr(if kind == "image" {
        "a picture"
    } else if video && audio {
        "video with sound"
    } else if video {
        "video without sound"
    } else {
        "sound only"
    })
    .into_owned()
}

/// A file found for media `m`, read like an import (`relinkCheck`) -> the fields `relinkMedia` takes, or the
/// sentence why it does not fit.
pub fn relink_check(m: &Media, path: &Path) -> Result<Json, String> {
    let f = crate::import::probe_file(path).result.map_err(|r| crate::import::refusal_text(&r).to_owned())?;
    let kind = match m.kind {
        MediaKind::Video => "video",
        MediaKind::Audio => "audio",
        MediaKind::Image => "image",
    };
    let (fv, fa) = (!f["video"].is_null(), !f["audio"].is_null());
    if f["kind"] != kind || fv != m.video.is_some() || fa != m.audio.is_some() {
        let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        return Err(trf(
            "{name} is {found}, but the media was {was}.",
            &[
                ("name", &name),
                ("found", &what(f["kind"].as_str().unwrap_or(""), fv, fa)),
                ("was", &what(kind, m.video.is_some(), m.audio.is_some())),
            ],
        ));
    }
    let d = f["duration"].as_f64().unwrap_or(0.0);
    let same = (d - m.duration).abs() <= frame_of(m);
    Ok(json!({
        "path": f["path"], "size": f["size"], "mtime": f["mtime"],
        "duration": if same { m.duration } else { d }, "video": f["video"], "audio": f["audio"],
    }))
}

/// Offline media -> (media, file read) found under `folder` (`findInFolder`).
fn find_in_folder(folder: &Path, list: &[Media]) -> Result<Vec<(Id, Json)>, String> {
    let named = |m: &Media| basename(&m.path).to_owned();
    let exact = find_media(
        folder,
        &list
            .iter()
            .map(|m| (named(m), m.size.as_f64().filter(|v| v.is_finite() && *v >= 0.0).map(|v| v as u64)))
            .collect::<Vec<_>>(),
    )?;
    let mut paths: Vec<(Id, PathBuf)> =
        list.iter().filter_map(|m| exact.get(&named(m)).map(|p| (m.id, p.clone()))).collect();
    let rest: Vec<&Media> =
        list.iter().filter(|m| !paths.iter().any(|(id, _)| *id == m.id) && m.kind != MediaKind::Image).collect();
    if !rest.is_empty()
        && let Ok(loose) = find_media(folder, &rest.iter().map(|m| (named(m), None)).collect::<Vec<_>>())
    {
        for m in rest {
            let Some(p) = loose.get(&named(m)) else { continue };
            let d = crate::import::probe_file(p).result.ok().and_then(|e| e["duration"].as_f64());
            if d.is_some_and(|d| (d - m.duration).abs() <= frame_of(m)) {
                paths.push((m.id, p.clone()));
            }
        }
    }
    let mut out = Vec::new();
    for (id, p) in paths {
        if let Some(m) = list.iter().find(|m| m.id == id)
            && let Ok(file) = relink_check(m, &p)
        {
            out.push((id, file));
        }
    }
    Ok(out)
}

/// Fills the media entry of a file found again (`relinkTo`'s end) -> whether it was relinked.
fn relink_now(s: &mut Shell, id: Id, file: &Json) -> bool {
    let name = s.app.project().media(id).map(|m| m.name.clone()).unwrap_or_default();
    let Some(r) = s.app.exec(&C::relink_media(id.as_str(), file.clone())) else { return false };
    s.features.prefs.relink.offline.remove(&id);
    let removed = r["removed"].as_array().map_or(0, Vec::len);
    if removed > 0 {
        s.app.report(trf(
            "{n} clips past the end of {name} were removed.",
            &[("n", &removed.to_string()), ("name", &name)],
        ));
    }
    true
}

/// A file for media `id` read: refused, asked about when shorter, or relinked.
fn located(s: &mut Shell, id: Id, file: Result<Json, String>) {
    let Some(m) = s.app.project().media(id).cloned() else { return };
    let file = match file {
        Ok(f) => f,
        Err(e) => {
            s.app.report(trf("{name} was not relinked: {error}", &[("name", &m.name), ("error", &e)]));
            return;
        }
    };
    let d = file["duration"].as_f64().unwrap_or(0.0);
    if m.kind != MediaKind::Image && d < m.duration {
        let n = s
            .app
            .project()
            .sequences
            .iter()
            .flat_map(|q| q.clips())
            .filter(|c| c.media_id() == Some(id) && if c.is_freeze() { c.in_ > d } else { c.out > d + 0.5 })
            .count();
        let secs = |t: f64| format!("{:.1}", t / TICKS as f64);
        let name = basename(file["path"].as_str().unwrap_or("")).to_owned();
        let mut text = trf(
            "{name} is shorter than the file it replaces ({now} s instead of {was} s).",
            &[("name", &name), ("now", &secs(d)), ("was", &secs(m.duration))],
        );
        if n > 0 {
            text.push(' ');
            text.push_str(&trf(
                "{n} clips use the part after its end: they are shortened to it, or removed when nothing of them is left.",
                &[("n", &n.to_string())],
            ));
        }
        s.features.prefs.relink.shorter = Some(Shorter { media: id, file, text });
        return;
    }
    relink_now(s, id, &file);
}

/// Picks a folder or a file on a thread (`CUT_DIALOG`'s `pickFolder` / `pickMedia` answer it in tests).
fn pick(s: &mut Shell, media: Option<Id>) {
    let key = if media.is_some() { "pickMedia" } else { "pickFolder" };
    let (tx, rx) = channel();
    if let Some(answer) = Shell::dialog_override(key) {
        let _ = tx.send(answer);
    } else {
        let title = match media.and_then(|id| s.app.project().media(id)) {
            Some(m) => trf("Locate {name}", &[("name", &m.name)]),
            None => tr("Find Media in Folder").into_owned(),
        };
        let (filter, all) = (tr("Media files").into_owned(), tr("All files").into_owned());
        let file = media.is_some();
        std::thread::spawn(move || {
            let d = rfd::FileDialog::new().set_title(&title);
            let r = if file {
                d.add_filter(&filter, &crate::import::media_extensions()).add_filter(&all, &["*"]).pick_file()
            } else {
                d.pick_folder()
            };
            let _ = tx.send(r.map(|p| vec![p]));
        });
    }
    s.features.prefs.relink.picking = Some((media, rx));
}

/// The picks and the searches each frame.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    let r = &mut s.features.prefs.relink;
    if r.picking.is_some() || r.working.is_some() {
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
    if let Some((media, rx)) = &r.picking
        && let Ok(answer) = rx.try_recv()
    {
        let media = *media;
        r.picking = None;
        if let Some(path) = answer.and_then(|p| p.into_iter().next()) {
            picked(s, media, path);
        }
        return;
    }
    let Some(rx) = &r.working else { return };
    let Ok(found) = rx.try_recv() else { return };
    r.working = None;
    match found {
        Found::Located(id, file) => located(s, id, file),
        Found::Folder(Err(e)) => {
            s.features.prefs.relink.status = trf("The folder could not be searched: {error}", &[("error", &e)]);
        }
        Found::Folder(Ok(list)) => {
            let mut n = 0;
            s.app.history.begin(&tr("Relink Media"));
            for (id, file) in list {
                let shorter = s.app.project().media(id).is_some_and(|m| {
                    m.kind != MediaKind::Image && file["duration"].as_f64().unwrap_or(0.0) < m.duration
                });
                if s.features.prefs.relink.offline.contains(&id) && !shorter && relink_now(s, id, &file) {
                    n += 1;
                }
            }
            s.app.history.commit();
            let r = &mut s.features.prefs.relink;
            let left = r.listed.iter().filter(|id| r.offline.contains(id)).count();
            r.status =
                trf("{n} files relinked, {left} still offline.", &[("n", &n.to_string()), ("left", &left.to_string())]);
            if r.offline.is_empty() {
                s.features.prefs.screen = None;
            }
        }
    }
}

/// The Relink Media dialog.
pub fn dialog(s: &mut Shell, ctx: &egui::Context) {
    let mut close = false;
    let mut locate = None;
    let mut folder = false;
    let busy = busy(s);
    let modal = egui::Modal::new(egui::Id::unique("cutRelinkDialog")).show(ctx, |ui| {
        ui.set_width(620.0);
        ui.heading(tr("Relink Media"));
        ui.label(tr("These media files are offline: they were moved, renamed or deleted. Choose a folder to find them by name and size, or locate each one."));
        ui.add_space(6.0);
        egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
            egui::Grid::new("cut-relink").num_columns(4).spacing([12.0, 6.0]).striped(true).show(ui, |ui| {
                let r = &s.features.prefs.relink;
                for id in &r.listed {
                    let Some(m) = s.app.project().media(*id) else { continue };
                    let off = r.offline.contains(id);
                    super::cell(ui, 140.0, RichText::new(&m.name).strong());
                    super::cell(ui, 270.0, RichText::new(&m.path).size(11.0).color(s.palette.gray[8])).on_hover_text(&m.path);
                    ui.label(if off { tr("Offline") } else { tr("Found") });
                    if ui.add_enabled(!busy, egui::Button::new(tr("Locate…"))).clicked() {
                        locate = Some(*id);
                    }
                    ui.end_row();
                }
            });
        });
        ui.label(&s.features.prefs.relink.status);
        ui.separator();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button(tr("Close")).clicked() {
                close = true;
            }
            if ui.add_enabled(!busy, egui::Button::new(tr("Find in Folder…"))).clicked() {
                folder = true;
            }
        });
    });
    if let Some(id) = locate {
        pick(s, Some(id));
    }
    if folder {
        pick(s, None);
    }
    if s.features.prefs.relink.shorter.is_some() {
        shorter(s, ctx);
    } else if close || modal.should_close() {
        s.features.prefs.screen = None;
    }
}

/// The question about a shorter file (`shorterOk`).
fn shorter(s: &mut Shell, ctx: &egui::Context) {
    let mut answer = None;
    egui::Modal::new(egui::Id::unique("cut-relink-shorter")).show(ctx, |ui| {
        ui.set_width(420.0);
        ui.heading(tr("Relink Media"));
        if let Some(q) = &s.features.prefs.relink.shorter {
            ui.label(&q.text);
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if ui.button(tr("Relink")).clicked() {
                answer = Some(true);
            }
            if ui.button(tr("Cancel")).clicked() {
                answer = Some(false);
            }
        });
    });
    let Some(yes) = answer else { return };
    let Some(q) = s.features.prefs.relink.shorter.take() else { return };
    if yes {
        relink_now(s, q.media, &q.file);
    }
}

/// A file picked for media `media` (Locate), or a folder to search (`media` `None`): read on a thread.
pub fn picked(s: &mut Shell, media: Option<Id>, path: PathBuf) {
    let (tx, rx) = channel();
    match media {
        Some(id) => {
            let Some(m) = s.app.project().media(id).cloned() else { return };
            std::thread::spawn(move || {
                let _ = tx.send(Found::Located(id, relink_check(&m, &path)));
            });
        }
        None => {
            let offline = &s.features.prefs.relink.offline;
            let list: Vec<Media> = s.app.project().media.iter().filter(|m| offline.contains(&m.id)).cloned().collect();
            s.features.prefs.relink.status = tr("Searching…").into_owned();
            std::thread::spawn(move || {
                let _ = tx.send(Found::Folder(find_in_folder(&path, &list)));
            });
        }
    }
    s.features.prefs.relink.working = Some(rx);
}

/// Whether a pick or a search is still going.
pub fn busy(s: &Shell) -> bool {
    s.features.prefs.relink.picking.is_some() || s.features.prefs.relink.working.is_some()
}
