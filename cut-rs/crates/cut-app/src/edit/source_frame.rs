//! The Source monitor's Export Frame (`ui-export.js` `exportFrame` on the source monitor's own app): the frame it
//! shows, at the file's (or the opened sequence's) own size, saved as a PNG under the name the person picks. The
//! picker and the encoding run on threads of their own; the frame is drawn on an engine of its own.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};

use cut_time::{Fps, Ticks};
use eframe::egui;

use super::source::{SourceItem, rate_of, timing};
use crate::i18n::{tr, trf};
use crate::picture::Want;
use crate::shell::Shell;

/// A frame on its way: the file being picked for `(item, t)`, then the PNG being written.
#[derive(Default)]
pub enum Saving {
    #[default]
    Idle,
    Picking(SourceItem, Ticks, Receiver<Option<PathBuf>>),
    Writing(Receiver<Result<PathBuf, String>>),
}

/// What the frame is called and its size: the media's or the sequence's name, its picture size and rate.
fn about(s: &Shell, item: SourceItem) -> Option<(String, (u32, u32), Fps)> {
    let p = s.app.project();
    match item {
        SourceItem::Media(id) => {
            let m = p.media(id)?;
            let v = m.video.as_ref()?;
            Some((m.name.clone(), (v.w.max(2.0) as u32, v.h.max(2.0) as u32), rate_of(m)))
        }
        SourceItem::Sequence(id) => {
            let q = p.sequence(id)?;
            Some((q.name.clone(), (q.w.max(2) as u32, q.h.max(2) as u32), q.fps))
        }
    }
}

/// Whether the Source monitor shows a picture to export.
pub fn can(s: &Shell) -> bool {
    s.app.edit.source.clip.is_some_and(|c| about(s, c.item).is_some())
}

/// Export Frame from the Source monitor's bar: asks where to save its frame.
pub fn ask(s: &mut Shell) {
    let Some(c) = s.app.edit.source.clip else { return };
    let Some((name, _, fps)) = about(s, c.item) else { return };
    if !matches!(s.app.edit.source.saving, Saving::Idle) {
        return;
    }
    let dir = s.app.path.as_ref().and_then(|p| p.parent()).map_or_else(|| s.doc.home.projects.clone(), Path::to_owned);
    let stem = Path::new(&name).file_stem().map_or_else(|| name.clone(), |n| n.to_string_lossy().into_owned());
    let safe: String = stem.chars().map(|ch| if r#"\/:*?"<>|"#.contains(ch) { '_' } else { ch }).collect();
    let file = format!(
        "{} {}.png",
        if safe.is_empty() { "Frame".into() } else { safe },
        cut_time::timecode(c.t, fps).replace(':', "-")
    );
    let (tx, rx) = channel();
    if let Some(answer) = Shell::dialog_override("saveAs") {
        let _ = tx.send(answer.and_then(|v| v.into_iter().next()));
    } else {
        let (title, filter) = (tr("Export Frame").into_owned(), tr("PNG image").into_owned());
        std::thread::spawn(move || {
            let p = rfd::FileDialog::new()
                .set_title(&title)
                .add_filter(&filter, &["png"])
                .set_directory(&dir)
                .set_file_name(file)
                .save_file();
            let _ = tx.send(p);
        });
    }
    s.app.edit.source.saving = Saving::Picking(c.item, c.t, rx);
}

/// Once a frame: the picked file gets the frame, a written one its message.
pub fn poll(s: &mut Shell, ctx: &egui::Context) {
    match std::mem::take(&mut s.app.edit.source.saving) {
        Saving::Idle => {}
        Saving::Picking(item, t, rx) => match rx.try_recv() {
            Ok(Some(path)) => write(s, item, t, path),
            Ok(None) => {}
            Err(_) => {
                s.app.edit.source.saving = Saving::Picking(item, t, rx);
                ctx.request_repaint_after(std::time::Duration::from_millis(100));
            }
        },
        Saving::Writing(rx) => match rx.try_recv() {
            Ok(Ok(path)) => {
                let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                s.app.toast(trf("Saved {name}", &[("name", &name)]));
            }
            Ok(Err(e)) => s.app.report(trf("The frame could not be saved: {error}", &[("error", &e)])),
            Err(_) => {
                s.app.edit.source.saving = Saving::Writing(rx);
                ctx.request_repaint_after(std::time::Duration::from_millis(100));
            }
        },
    }
}

fn write(s: &mut Shell, item: SourceItem, t: Ticks, path: PathBuf) {
    let Some((_, (w, h), fps)) = about(s, item) else { return };
    let Some(m) = &s.monitors else { return };
    let p = s.app.history.project();
    if timing(p, item).is_none() {
        return;
    }
    let t = cut_time::snap(t, fps, false);
    let want = match item {
        SourceItem::Media(media) => Want::Media { media, t },
        SourceItem::Sequence(seq) => Want::Sequence { seq, t },
    };
    let pixels = match m.still(p, want, (w, h)) {
        Ok(px) => px,
        Err(e) => {
            s.app.report(trf("The frame could not be saved: {error}", &[("error", &e)]));
            return;
        }
    };
    let path = PathBuf::from(cut_export::plan::with_ext(&path.to_string_lossy(), "png"));
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut png = Vec::new();
        let enc = image::codecs::png::PngEncoder::new(&mut png);
        let r = image::ImageEncoder::write_image(enc, &pixels, w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())
            .and_then(|()| cut_export::sink::save_bytes(&path, &png, None).map_err(|f| f.to_string()))
            .map(|_| path);
        let _ = tx.send(r);
    });
    s.app.edit.source.saving = Saving::Writing(rx);
}
