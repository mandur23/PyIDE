//! Text (`ui-text.js`, the in-place text of `ui-overlay.js`, `edit.addText`): the Type tool on the Program monitor
//! and the Text panel of the Captions and Graphics workspace.
//!
//! With the Type tool a click on the picture makes a text clip there and edits it in place; a click on a text clip
//! (or a double click with any tool) edits it. The editor is an egui text field over the layer whose own glyphs are
//! transparent, so what shows is the engine's rendering of the layer, redrawn on every change, the IME's composing
//! syllable included; the whole visit is one undo step that closes with the editor, so nothing is recorded while a
//! syllable composes ([`editor`]). The Text panel edits the selected text clip's layers ([`panel`]). Everything
//! runs on the UI thread except the font list ([`fonts`]); the text is drawn by the engine's rasteriser thread.

pub mod editor;
pub mod fonts;
pub mod graphic;
pub mod panel;
pub mod presets;

use cut_model::commands::build as C;
use cut_model::{Id, TrackKind};
use cut_time::{Ticks, frame_start, snap};
use eframe::egui;
use serde_json::{Value as Json, json};

use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::{App, Tool};

/// The state of these screens.
#[derive(Default)]
pub struct TextUi {
    pub editor: Option<editor::Editor>,
    pub panel: panel::PanelState,
}

/// Whether the Program monitor's clicks are the text's now (the Type tool, or the editor open): the transform box
/// then steps aside, as the JavaScript hides it while editing.
pub fn owns_monitor(s: &Shell) -> bool {
    s.app.tool == Tool::Text || s.features.text.editor.is_some()
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "tool.text" => Some(true),
        "text.newLayer" => Some(s.app.sequence().is_some()),
        "text.edit" => Some(text_clip(&s.app).is_some()),
        _ => None,
    }
}

/// Runs one of this feature's actions -> whether it was one. `text.edit` edits the selected text clip in place, as a
/// double click on it does (`CUT_ACTIONS` drives it for pictures).
pub fn run(s: &mut Shell, id: &str, _ctx: &egui::Context) -> bool {
    match id {
        "tool.text" => s.app.tool = Tool::Text,
        "text.newLayer" => new_layer(s),
        "text.edit" => {
            if let Some(id) = text_clip(&s.app).map(|c| c.id) {
                editor::open(s, id, false, None);
            }
        }
        _ => return false,
    }
    true
}

/// This feature's windows, each frame: an editor whose monitor is no longer drawn closes.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    if s.features.text.editor.as_ref().is_some_and(|e| e.drawn + 1 < ctx.cumulative_frame_nr()) {
        editor::close(s);
    }
}

/// A text clip at `at` with one layer of `text` at `position` (`edit.addText`): on the lowest video track above
/// every clip under its span, or a new track at the top. -> its id. The caller groups it with what follows.
pub fn add_text(app: &mut App, at: Ticks, text: &str, position: [f64; 2]) -> Option<Id> {
    let seq = app.sequence()?;
    let d = app.project().settings.get("stillDuration").and_then(Json::as_i64).unwrap_or(5 * cut_time::TICKS);
    let f = frame_start(1, seq.fps).max(1);
    let a = snap(at.max(0), seq.fps, false);
    let vids: Vec<&cut_model::Track> = seq.tracks.iter().filter(|t| t.kind == TrackKind::Video).collect();
    let busy = |t: &cut_model::Track| t.clips.iter().any(|c| c.start < a + d && c.end() > a);
    let top = vids.iter().rposition(|t| busy(t));
    let free = vids.iter().skip(top.map_or(0, |i| i + 1)).find(|t| !t.locked).map(|t| t.id);
    let seq_id = seq.id;
    let track = match free {
        Some(t) => t,
        None => {
            let r = app.exec(&C::add_track(seq_id.as_str(), "video", None, json!({})))?;
            Id::new(r["id"].as_str()?)
        }
    };
    let r = app.exec(&C::add_generated(
        seq_id.as_str(),
        json!({
            "track": track.as_str(), "at": a, "duration": f.max(d), "name": tr("Text"),
            "source": { "generator": "text", "layers": [{ "text": text, "position": position }] },
        }),
    ))?;
    Some(Id::new(r["id"].as_str()?))
}

/// Graphics and Titles > New Layer > Text (`newGenerated`): a text clip with a "Title" layer at the playhead on the
/// patched video track, selected, the Text panel shown.
fn new_layer(s: &mut Shell) {
    let Some(seq) = s.app.sequence() else { return };
    let (Some(track), _) = crate::edit::patch_for(seq, &s.app.edit.patch) else {
        s.app.toast(tr("There is no video track."));
        return;
    };
    let layer = cut_model::defaults::text_layer(&[("text".to_owned(), json!(tr("Title")))].into_iter().collect());
    let cmd = C::add_generated(
        seq.id.as_str(),
        json!({
            "track": track.as_str(), "at": s.app.t, "name": tr("Text"), "mode": "overwrite",
            "source": { "generator": "text", "layers": [layer] },
        }),
    );
    if let Some(id) = s.app.exec(&cmd).and_then(|r| r["id"].as_str().map(Id::new)) {
        s.app.select([id], false, false);
        s.features.workspace.open_panel("text");
    }
}

/// The text clip a panel edits: the primary selected clip when it is one (`generator === 'text'`).
pub fn text_clip(app: &App) -> Option<&cut_model::Clip> {
    crate::fx::edit::primary_clip(app).filter(|c| text_clip_kind(c))
}

/// Whether a clip is a text clip.
pub fn text_clip_kind(c: &cut_model::Clip) -> bool {
    matches!(c.source, cut_model::Source::Generator { generator: cut_model::Generator::Text, .. })
}

/// The id of a layer.
pub fn layer_id(l: &Json) -> Option<&str> {
    l.get("id").and_then(Json::as_str)
}

/// A text clip's layers.
pub fn layers(c: &cut_model::Clip) -> &[Json] {
    match &c.source {
        cut_model::Source::Generator { layers: Some(l), .. } => l,
        _ => &[],
    }
}
