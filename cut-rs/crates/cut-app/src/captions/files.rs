//! Caption files (`ui-captions.js`'s `importFile`, `exportFile` and their dialogs): an SRT or WebVTT file's captions
//! replace those of the shown track in one undo step (a track of its own is made when the sequence has none), and the
//! shown track is written as SubRip with a byte-order mark, the whole file or nothing. The file dialogs run on a thread
//! of their own; `CUT_DIALOG` answers them in tests (keys `openCaptions` and `saveAs`).

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};

use cut_model::commands::build as C;
use cut_model::{Id, srt};
use eframe::egui;
use serde_json::json;

use crate::i18n::{self, Lang, tr, trf};
use crate::shell::Shell;

/// The largest file read as captions.
const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// A file dialog open on its thread: an import or an export.
#[derive(Default)]
pub struct Asking(Option<(bool, Receiver<Option<PathBuf>>)>);

fn base_name(p: &Path) -> String {
    p.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

/// The language a new caption track gets: the screen's.
fn lang() -> &'static str {
    if i18n::lang() == Lang::Ko { "ko" } else { "en" }
}

/// The text of a caption file (`readText`).
fn read_text(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|_| tr("The file is gone.").into_owned())?;
    if meta.len() > MAX_BYTES {
        return Err(tr("The file is too large for a caption file.").into_owned());
    }
    let bytes = std::fs::read(path).map_err(|_| tr("The file could not be read.").into_owned())?;
    srt::decode(&bytes).map_err(|e| e.to_string())
}

/// Imports a caption file into the shown track (`new_track`: a track of its own) -> the captions imported.
pub fn import_file(s: &mut Shell, path: &Path, new_track: bool) -> usize {
    let Some(seq) = s.app.sequence_id else {
        s.app.toast(tr("Open a sequence to import captions into."));
        return 0;
    };
    let name = base_name(path);
    let items = match read_text(path) {
        Ok(text) => srt::parse_any(&text, &name),
        Err(e) => {
            s.app.report(trf("The captions could not be imported: {error}", &[("error", &e)]));
            return 0;
        }
    };
    if items.is_empty() {
        s.app.toast(tr("The file has no captions."));
        return 0;
    }
    let existing = if new_track { None } else { super::shown(s) };
    let list: Vec<_> = items.iter().map(|c| json!({ "start": c.start, "end": c.end, "text": c.text })).collect();
    s.app.history.begin(&tr("Import Captions"));
    let id = match existing {
        Some(id) => Ok(id),
        None => {
            let stem = Path::new(&name).file_stem().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            s.app
                .history
                .apply(&C::add_caption_track(seq.as_str(), json!({ "name": stem, "lang": lang() })))
                .map(|r| Id::new(r["id"].as_str().unwrap_or_default()))
        }
    };
    let done =
        id.and_then(|id| s.app.history.apply(&C::set_captions(seq.as_str(), id.as_str(), json!(list))).map(|_| id));
    match done {
        Ok(id) => {
            super::choose(s, id);
            s.app.history.commit();
        }
        Err(e) => {
            s.app.history.cancel();
            s.app.report(tr(&e.message).into_owned());
            return 0;
        }
    }
    s.app.toast(trf("{n} captions imported", &[("n", &items.len().to_string())]));
    items.len()
}

/// The shown track's captions as a SubRip file with a byte-order mark.
fn srt_bytes(s: &Shell) -> Option<Vec<u8>> {
    let t = super::track_of(&s.app, &s.features.captions).filter(|t| !t.items.is_empty())?;
    let cues: Vec<srt::Cue> =
        t.items.iter().map(|c| srt::Cue { start: c.start, end: c.end, text: c.text.clone() }).collect();
    Some(format!("\u{feff}{}", srt::write(&cues)).into_bytes())
}

/// Writes the shown track to `path` -> whether it was written.
pub fn export_file(s: &mut Shell, path: &Path) -> bool {
    let Some(bytes) = srt_bytes(s) else {
        s.app.toast(tr("There are no captions to export."));
        return false;
    };
    match crate::files::write_atomic(path, &bytes, true) {
        Ok(()) => {
            s.app.toast(trf("Saved {name}", &[("name", &base_name(path))]));
            true
        }
        Err(e) => {
            // the JavaScript's sentence, with the system's reason after it
            let why = format!("{} ({e})", tr("The file could not be written."));
            s.app.report(trf("The captions could not be exported: {error}", &[("error", &why)]));
            false
        }
    }
}

/// The path Export Captions offers: the sequence's name beside the project (or in the projects folder).
fn default_path(s: &Shell) -> PathBuf {
    let dir = s.app.path.as_ref().and_then(|p| p.parent()).map_or_else(|| s.doc.home.projects.clone(), Path::to_owned);
    let raw = s.app.sequence().map(|q| q.name.as_str()).filter(|n| !n.is_empty()).unwrap_or("Captions");
    let mut name = String::new();
    let mut run = false;
    for ch in raw.chars() {
        let bad = "\\/:*?\"<>|".contains(ch);
        if !bad {
            name.push(ch);
        } else if !run {
            name.push('_');
        }
        run = bad;
    }
    dir.join(format!("{name}.srt"))
}

fn ask(s: &mut Shell, export: bool) {
    if s.features.captions.files.0.is_some() {
        return;
    }
    let (tx, rx) = channel();
    let key = if export { "saveAs" } else { "openCaptions" };
    if let Some(answer) = Shell::dialog_override(key) {
        let _ = tx.send(answer.and_then(|v| v.into_iter().next()));
        s.features.captions.files.0 = Some((export, rx));
        return;
    }
    let (title, filter) = if export {
        (tr("Export Captions").into_owned(), tr("SubRip captions").into_owned())
    } else {
        (tr("Import Captions").into_owned(), tr("Captions").into_owned())
    };
    let path = default_path(s);
    std::thread::spawn(move || {
        let d = rfd::FileDialog::new().set_title(&title);
        let r = if export {
            let dir = path.parent().map(Path::to_owned).unwrap_or_default();
            d.add_filter(&filter, &["srt"]).set_directory(dir).set_file_name(base_name(&path)).save_file()
        } else {
            d.add_filter(&filter, &["srt", "vtt"]).pick_file()
        };
        let _ = tx.send(r);
    });
    s.features.captions.files.0 = Some((export, rx));
}

/// Import Captions… (`importDialog`).
pub fn ask_import(s: &mut Shell) {
    ask(s, false);
}

/// Export Captions… (`exportDialog`).
pub fn ask_export(s: &mut Shell) {
    ask(s, true);
}

/// Takes the dialog's answer once it is there.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    let Some((export, rx)) = &s.features.captions.files.0 else { return };
    let export = *export;
    let Ok(answer) = rx.try_recv() else {
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
        return;
    };
    s.features.captions.files.0 = None;
    let Some(mut path) = answer else { return };
    if export {
        if path.extension().is_none() {
            path.set_extension("srt");
        }
        export_file(s, &path);
    } else {
        import_file(s, &path, false);
    }
}
