//! A transition selected on the timeline (`buildTransition`): its type among the transitions of its track's kind, its
//! duration, its alignment and its choice parameters, each change one command.

use cut_model::commands::build as C;
use cut_model::effects::{self, ParamKind};
use cut_model::{Align as TAlign, Id, TrackKind};
use eframe::egui;
use serde_json::{Value as Json, json};

use super::rows;
use crate::i18n::tr;
use crate::shell::Shell;

const ALIGNS: [(TAlign, &str, &str); 3] = [
    (TAlign::Center, "center", "Center at Cut"),
    (TAlign::Start, "start", "Start at Cut"),
    (TAlign::End, "end", "End at Cut"),
];

/// A row of a label and the control `add` draws -> where the control is.
fn line(
    s: &Shell,
    ui: &mut egui::Ui,
    label: &str,
    add: impl FnOnce(&mut egui::Ui, egui::Id) -> egui::Rect,
) -> egui::Rect {
    let (left, _) = rows::allocate(s, ui, rows::ROW_H);
    let mut cu = rows::child(ui, left.shrink2(egui::vec2(4.0, 0.0)));
    cu.add_space(20.0);
    let name = rows::label(&mut cu, &tr(label), s.palette.gray[10], 0.0).id;
    add(&mut cu, name)
}

/// The header's title and the rows of transition `id` -> the title.
pub fn show(s: &mut Shell, ui: &mut egui::Ui, id: Id) {
    let Some(seq) = s.app.sequence() else { return };
    let Some(t) = seq.transitions.iter().find(|t| t.id == id).cloned() else { return };
    let kind = match seq.kind_of(t.track) {
        Some(TrackKind::Audio) => effects::Kind::Audio,
        _ => effects::Kind::Video,
    };
    let (sid, fps) = (seq.id, seq.fps);
    let defs: Vec<&effects::Def> = effects::transitions(Some(kind)).collect();
    let def = defs.iter().find(|d| d.id == t.kind).copied();
    let mut patch: Option<Json> = None;
    let r = line(s, ui, "Transition", |ui, name| {
        let shown = def.map_or_else(|| t.kind.clone(), |d| tr(d.name).into_owned());
        egui::ComboBox::from_id_salt(("ec-tr-type", id))
            .icon(crate::theme::combo_icon)
            .selected_text(shown)
            .width(150.0)
            .show_ui(ui, |ui| {
                for d in &defs {
                    if ui.selectable_label(d.id == t.kind, tr(d.name)).clicked() {
                        patch = Some(json!({ "type": d.id }));
                    }
                }
            })
            .response
            .labelled_by(name)
            .rect
    });
    s.features.controls.note("transition/type".into(), r);
    let r = line(s, ui, "Duration", |ui, name| {
        let (d, r) = rows::timecode_field(ui, egui::Id::unique(("ec-tr-dur", id)), t.duration, fps, Some(name));
        if let Some(d) = d {
            patch = Some(json!({ "duration": d }));
        }
        r
    });
    s.features.controls.note("transition/duration".into(), r);
    let r = line(s, ui, "Alignment", |ui, name| {
        let shown = ALIGNS.iter().find(|a| a.0 == t.align).map_or("", |a| a.2);
        egui::ComboBox::from_id_salt(("ec-tr-align", id))
            .icon(crate::theme::combo_icon)
            .selected_text(tr(shown))
            .width(150.0)
            .show_ui(ui, |ui| {
                for (a, value, label) in ALIGNS {
                    if ui.selectable_label(a == t.align, tr(label)).clicked() {
                        patch = Some(json!({ "align": value }));
                    }
                }
            })
            .response
            .labelled_by(name)
            .rect
    });
    s.features.controls.note("transition/align".into(), r);
    for p in def.map_or(&[][..], |d| d.params).iter().filter(|p| p.kind == ParamKind::Choice) {
        let default = p.default.to_json();
        let now = t.params.get(p.id).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| default.clone());
        line(s, ui, p.name, |ui, name| {
            let shown = p.choices.iter().find(|c| Some(c.0) == now.as_str()).map_or("", |c| c.1);
            egui::ComboBox::from_id_salt(("ec-tr-p", id, p.id))
                .icon(crate::theme::combo_icon)
                .selected_text(tr(shown))
                .width(150.0)
                .show_ui(ui, |ui| {
                    for (cid, label) in p.choices {
                        if ui.selectable_label(Some(*cid) == now.as_str(), tr(label)).clicked() {
                            let v = if json!(cid) == default { Json::Null } else { json!(cid) };
                            patch = Some(json!({ "params": { p.id: v } }));
                        }
                    }
                })
                .response
                .labelled_by(name)
                .rect
        });
    }
    if let Some(patch) = patch {
        s.app.exec(&C::set_transition(sid.as_str(), id.as_str(), patch));
    }
}

/// The title of transition `id`: its effect's name.
pub fn title(s: &Shell, id: Id) -> String {
    let kind = s.app.sequence().and_then(|q| q.transitions.iter().find(|t| t.id == id)).map(|t| t.kind.clone());
    kind.map(|k| effects::get(&k).map_or(k.clone(), |d| tr(d.name).into_owned())).unwrap_or_default()
}
