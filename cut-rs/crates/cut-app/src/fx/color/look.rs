//! The Creative section's Look: a .cube LUT picked in the file dialog (`cut:pickLut`; the `CUT_DIALOG` file answers
//! it in tests), read, parsed (`cut_engine::lumetri::parse_cube`) and kept in the project (`addLut`), so the project
//! opens on any PC; a file that is not a usable LUT is refused with the parser's reason. The dialog and the reading
//! run on a thread of their own; the edit is made on the UI thread when they are done.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};

use cut_engine::lumetri;
use cut_model::Id;
use cut_model::commands::build as C;
use cut_model::keyframes::Value;
use eframe::egui::{self, RichText};
use serde_json::{Map, Value as Json};

use super::{LUMETRI, set};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::App;
use crate::theme::Palette;

/// The largest .cube file read (`LUT_LIMIT`).
const LUT_LIMIT: u64 = 64 * 1024 * 1024;

/// What the dialog's thread brings back.
#[derive(Debug)]
enum Loaded {
    Cancelled,
    /// `project.luts`' id and entry of the file.
    Lut(String, Json),
    /// The file's name and why it cannot be used.
    Refused(String, String),
}

/// The Look's state between frames.
#[derive(Debug, Default)]
pub struct Look {
    /// The last refusal shown under the Look ("name: reason").
    pub error: Option<String>,
    pending: Option<Receiver<Loaded>>,
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

/// A .cube file -> its `(id, entry)` for `addLut` (`readLut`), or the refusal's text in the screen's language.
fn read_lut(path: &Path) -> Result<(String, Json), String> {
    let unreadable = || tr("The LUT file cannot be read.").into_owned();
    let meta = std::fs::metadata(path).map_err(|_| unreadable())?;
    if meta.len() > LUT_LIMIT {
        return Err(tr("The LUT file is too large (at most 64 MB).").into_owned());
    }
    let bytes = std::fs::read(path).map_err(|_| unreadable())?;
    let lut = lumetri::parse_cube(&String::from_utf8_lossy(&bytes)).map_err(|e| {
        let params: Vec<(&str, String)> =
            e.params.iter().map(|(k, v)| (*k, v.as_str().map_or_else(|| v.to_string(), str::to_owned))).collect();
        let refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
        trf(e.message, &refs)
    })?;
    Ok(lumetri::store(&lut, &file_name(path)))
}

impl Look {
    /// Browse…: the dialog (or the `CUT_DIALOG` answer) and the reading, on a thread.
    fn browse(&mut self, ctx: &egui::Context) {
        if self.pending.is_some() {
            return;
        }
        let answer = Shell::dialog_override("pickLut");
        let (title, filter, all) =
            (tr("Load LUT").into_owned(), tr("Cube LUT").into_owned(), tr("All files").into_owned());
        let (tx, rx) = channel();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let path: Option<PathBuf> = match answer {
                Some(a) => a.and_then(|v| v.into_iter().next()),
                None => rfd::FileDialog::new()
                    .set_title(&title)
                    .add_filter(&filter, &["cube"])
                    .add_filter(&all, &["*"])
                    .pick_file(),
            };
            let got = match path {
                None => Loaded::Cancelled,
                Some(p) => match read_lut(&p) {
                    Ok((id, entry)) => Loaded::Lut(id, entry),
                    Err(text) => Loaded::Refused(file_name(&p), text),
                },
            };
            let _ = tx.send(got);
            ctx.request_repaint();
        });
        self.pending = Some(rx);
    }

    /// Takes what the thread brought: the LUT into the project and onto the clip in one step, or the refusal.
    pub fn poll(&mut self, app: &mut App, clip: Option<Id>, ctx: &egui::Context) {
        let Some(rx) = &self.pending else { return };
        let Ok(got) = rx.try_recv() else {
            ctx.request_repaint_after(std::time::Duration::from_millis(100));
            return;
        };
        self.pending = None;
        let Some(clip) = clip else { return };
        match got {
            Loaded::Cancelled => {}
            Loaded::Refused(name, text) => {
                self.error = Some(format!("{name}: {text}"));
                app.toast(text);
            }
            Loaded::Lut(id, entry) => {
                self.error = None;
                app.history.begin("Load LUT");
                if app.exec(&C::add_lut(&id, entry)).is_some()
                    && set(app, clip, LUMETRI, &[("lut", Value::Text(id))], "Load LUT")
                {
                    app.history.commit();
                } else {
                    app.history.cancel();
                }
            }
        }
    }
}

/// The Look's row (the project's LUTs and Browse…), what the chosen one is, and the last refusal.
pub fn section(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, p: &Map<String, Json>, clip: Id) {
    let current = p.get("lut").and_then(Json::as_str).unwrap_or("").to_owned();
    let luts: Vec<(String, Json)> = s
        .app
        .project()
        .luts
        .as_ref()
        .and_then(Json::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let label_of = |id: &str, e: &Json| {
        ["name", "title"]
            .iter()
            .find_map(|k| e.get(*k).and_then(Json::as_str).filter(|n| !n.is_empty()))
            .unwrap_or(id)
            .to_owned()
    };
    let mut options: Vec<(String, String)> = vec![(String::new(), tr("None").into_owned())];
    options.extend(luts.iter().map(|(id, e)| (id.clone(), label_of(id, e))));
    let entry = luts.iter().find(|(id, _)| *id == current).map(|(_, e)| e);
    if !current.is_empty() && entry.is_none() {
        options.push((current.clone(), tr("Missing LUT").into_owned()));
    }
    let mut chosen = current.clone();
    ui.horizontal(|ui| {
        ui.add_sized([118.0, 18.0], egui::Label::new(tr("Look")));
        let shown = options.iter().find(|o| o.0 == chosen).map_or_else(String::new, |o| o.1.clone());
        egui::ComboBox::from_id_salt("lumetri-look").selected_text(shown).width(140.0).show_ui(ui, |ui| {
            for (id, name) in &options {
                ui.selectable_value(&mut chosen, id.clone(), name);
            }
        });
        if ui.button(tr("Browse…")).on_hover_text(tr("Load a .cube LUT")).clicked() {
            s.features.fx.color.look.browse(ui.ctx());
        }
    });
    if chosen != current {
        s.features.fx.color.look.error = None;
        set(&mut s.app, clip, LUMETRI, &[("lut", Value::Text(chosen))], "Color");
    }
    if !current.is_empty() {
        let (text, color) = match entry {
            Some(e) => {
                let title = ["title", "name"]
                    .iter()
                    .find_map(|k| e.get(*k).and_then(Json::as_str).filter(|n| !n.is_empty()))
                    .unwrap_or("");
                let size = e.get("size").map(Json::to_string).unwrap_or_default();
                (trf("{title} · {size} points a side", &[("title", title), ("size", &size)]), pal.gray[9])
            }
            None => (tr("This LUT is not in the project; the clip is drawn without it.").into_owned(), pal.red),
        };
        ui.label(RichText::new(text).color(color).small());
    }
    if let Some(e) = &s.features.fx.color.look.error {
        ui.label(RichText::new(e).color(pal.red));
    }
}
