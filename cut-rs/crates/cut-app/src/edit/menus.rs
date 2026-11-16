//! The menu bar's items of the editing features that are not keyboard actions (`ui-menubar.js`): Sequence Settings…,
//! Clip > Video Options > Time Interpolation, Markers > Edit Marker….

use cut_model::commands::build as C;
use cut_model::{Id, TrackKind};
use eframe::egui::{self, Button};
use serde_json::{Value as Json, json};

use super::dialogs::EditDialog;
use super::source::{SourceClip, SourceItem};
use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::Panel;

/// Sequence > Sequence Settings… of the active sequence.
pub fn sequence_settings(s: &mut Shell, ui: &mut egui::Ui) {
    let seq = s.app.sequence_id;
    if ui.add_enabled(seq.is_some(), Button::new(tr("Sequence Settings…"))).clicked() {
        if let Some(id) = seq {
            s.app.edit.dialog = EditDialog::sequence(&s.app, id);
        }
        ui.close();
    }
}

/// The project panel's Sequence Settings… of a sequence.
pub fn settings_of(s: &mut Shell, ui: &mut egui::Ui, id: Id) {
    if ui.button(tr("Sequence Settings…")).clicked() {
        s.app.edit.dialog = EditDialog::sequence(&s.app, id);
        ui.close();
    }
}

/// The project panel's Open in Source Monitor of a media item or a sequence.
pub fn open_in_source(s: &mut Shell, ui: &mut egui::Ui, item: SourceItem) {
    if ui.button(tr("Open in Source Monitor")).clicked() {
        s.app.edit.source.open(SourceClip { item, in_: None, out: None, t: 0 });
        s.focus(Panel::Source);
        ui.close();
    }
}

/// The project panel's New Sequence from Clip (`sequenceFromClip`): a sequence of the clip's size and rate holding
/// it, opened; one step.
pub fn sequence_from_clip(s: &mut Shell, ui: &mut egui::Ui, media: Id) {
    if ui.button(tr("New Sequence from Clip")).clicked() {
        if let Some(c) = sequence_from_clip_command(s.app.project(), media)
            && let Some(r) = s.app.exec(&c)
            && let Some(id) = r["results"][0]["id"].as_str()
        {
            s.app.set_sequence(Id::new(id));
        }
        ui.close();
    }
}

/// The commands of New Sequence from Clip: the sequence, then the clip on its first tracks. The new sequence's id is
/// the project's next one (`s<nextId>`), as `addSequence` names it.
pub fn sequence_from_clip_command(p: &cut_model::Project, media: Id) -> Option<Json> {
    let m = p.media(media)?;
    let name = m.name.rsplit_once('.').map_or(m.name.as_str(), |(a, _)| a).to_owned();
    let mut opts = json!({ "name": name });
    if let Some(v) = &m.video {
        let even = |n: f64| (n as i64) - (n as i64) % 2;
        opts["w"] = json!(even(v.w));
        opts["h"] = json!(even(v.h));
        let f = super::source::rate_of(m);
        opts["fps"] = json!([f.num, f.den]);
    }
    let seq = format!("s{}", p.next_id);
    let defaults = cut_model::defaults::project();
    let first = |k| defaults.sequences[0].tracks.iter().find(|t| t.kind == k).map(|t| t.id.as_str().to_owned());
    let place = C::place(
        &seq,
        json!({
            "source": { "media": media.as_str() }, "at": 0, "mode": "overwrite",
            "video": m.video.as_ref().and(first(TrackKind::Video)), "audio": m.audio.as_ref().and(first(TrackKind::Audio)),
        }),
    );
    Some(C::batch("New Sequence", vec![C::add_sequence(opts), place]))
}

/// Clip > Video Options > Time Interpolation: Frame Sampling or Frame Blending for the selected video clips.
pub fn time_interpolation(s: &mut Shell, ui: &mut egui::Ui) {
    ui.add_enabled_ui(!s.app.selection.is_empty(), |ui| {
        ui.menu_button(tr("Time Interpolation"), |ui| {
            for (id, name) in [("sample", "Frame Sampling"), ("blend", "Frame Blending")] {
                if ui.button(tr(name)).clicked() {
                    if let Some(seq) = s.app.sequence().cloned() {
                        crate::timeline::editing::set_sampling(&mut s.app, &seq, id);
                    }
                    ui.close();
                }
            }
        });
    });
}

/// Markers > Edit Marker…: the sequence marker at the playhead.
pub fn edit_marker(s: &mut Shell, ui: &mut egui::Ui) {
    let here = s.app.sequence().and_then(|q| q.markers.iter().find(|m| m.t == s.app.t)).map(|m| m.id);
    if ui.add_enabled(here.is_some(), Button::new(tr("Edit Marker…"))).clicked() {
        if let Some(id) = here {
            s.app.edit.dialog = EditDialog::marker(&s.app, id);
        }
        ui.close();
    }
}
