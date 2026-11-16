//! The Markers panel (port of `ui-markers.js`'s panel): the active sequence's markers and its clips' markers in time
//! order with their colour, time, length, name and type; filtered by type, colour and a search of the name and the
//! comment. A click moves the playhead to the marker, a double click (or Enter) opens the marker dialog, Delete
//! removes it, M adds one at the playhead, Up and Down walk the list. Only the rows in view are laid out.

use cut_model::commands::build as C;
use cut_time::timecode;
use eframe::egui::{self, Align2, Color32, FontId, Rect, RichText, Sense, Vec2};

use crate::edit::dialogs::EditDialog;
use crate::edit::markers::{COLORS, KINDS, Row, color, kind_name, markers_of};
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::Panel;

const ROW: f32 = 24.0;

fn rows(s: &Shell) -> (Vec<Row>, usize) {
    let all = s.app.sequence().map(markers_of).unwrap_or_default();
    let total = all.len();
    let v = &s.app.edit.markers;
    (all.into_iter().filter(|r| v.shows(&r.marker)).collect(), total)
}

fn select(s: &mut Shell, r: &Row, go: bool) {
    s.app.edit.markers.selected = Some(r.marker.id);
    if go {
        s.app.set_time(r.t);
    }
}

/// Delete, M and the arrows while the panel has the keyboard.
pub fn action(s: &mut Shell, id: &str) {
    let (list, _) = rows(s);
    let at = list.iter().position(|r| Some(r.marker.id) == s.app.edit.markers.selected);
    match id {
        "delete" => {
            let (Some(i), Some(seq)) = (at, s.app.sequence_id) else { return };
            if s.app.exec(&C::remove_marker(seq.as_str(), list[i].marker.id.as_str())).is_some() {
                let (now, _) = rows(s);
                s.app.edit.markers.selected = now.get(i.min(now.len().saturating_sub(1))).map(|r| r.marker.id);
            }
        }
        "addMarker" => {
            let Some(seq) = s.app.sequence_id else { return };
            let t = s.app.t;
            if let Some(r) =
                s.app.exec(&C::add_marker(seq.as_str(), serde_json::json!({ "t": t }), serde_json::json!({})))
                && let Some(id) = r["id"].as_str()
            {
                s.app.edit.markers.selected = Some(cut_model::Id::new(id));
            }
        }
        "prevEdit" | "nextEdit" => {
            if list.is_empty() {
                return;
            }
            let j = match at {
                None if id == "nextEdit" => 0,
                None => 0,
                Some(i) if id == "nextEdit" => (i + 1).min(list.len() - 1),
                Some(i) => i.saturating_sub(1),
            };
            select(s, &list[j], true);
        }
        _ => {}
    }
}

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    let fps = s.app.sequence().map_or(cut_time::Fps { num: 30, den: 1 }, |q| q.fps);
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        let v = &mut s.app.edit.markers;
        ui.add(egui::TextEdit::singleline(&mut v.search).hint_text(tr("Search")).desired_width(120.0));
        let kind = v.kind.map_or_else(|| tr("All Types").into_owned(), |k| tr(kind_name(k)).into_owned());
        egui::ComboBox::from_id_salt("markers-kind").selected_text(kind).show_ui(ui, |ui| {
            ui.selectable_value(&mut v.kind, None, tr("All Types"));
            for (k, label) in KINDS {
                ui.selectable_value(&mut v.kind, Some(k), tr(label));
            }
        });
        let shown = v
            .color
            .and_then(|c| COLORS.iter().find(|x| x.0 == c))
            .map_or_else(|| tr("All Colors").into_owned(), |c| tr(c.1).into_owned());
        egui::ComboBox::from_id_salt("markers-color").selected_text(shown).show_ui(ui, |ui| {
            ui.selectable_value(&mut v.color, None, tr("All Colors"));
            for (k, label, _) in COLORS {
                ui.selectable_value(&mut v.color, Some(k), tr(label));
            }
        });
        if ui.button(crate::icons::MARKER).on_hover_text(tr("Add Marker")).clicked() {
            s.focus(Panel::Markers);
            action(s, "addMarker");
        }
    });
    let (list, total) = rows(s);
    let cols = [24.0, 96.0, 96.0];
    let head = |ui: &mut egui::Ui| {
        let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 20.0), Sense::hover());
        let p = ui.painter_at(r);
        let mut x = r.left() + 6.0 + cols[0];
        for (i, t) in ["Time", "Duration", "Name"].into_iter().enumerate() {
            p.text(egui::pos2(x, r.center().y), Align2::LEFT_CENTER, tr(t), FontId::proportional(12.0), pal.gray[9]);
            x += cols.get(i + 1).copied().unwrap_or(0.0);
        }
        p.text(
            egui::pos2(r.right() - 90.0, r.center().y),
            Align2::LEFT_CENTER,
            tr("Type"),
            FontId::proportional(12.0),
            pal.gray[9],
        );
    };
    head(ui);
    let foot_h = 22.0;
    let avail = ui.available_height() - foot_h;
    if list.is_empty() {
        let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), avail.max(20.0)), Sense::hover());
        let text = if total > 0 {
            tr("No marker matches the filter.")
        } else {
            tr("No markers. Press M to add one at the playhead.")
        };
        ui.painter().text(
            r.center_top() + Vec2::new(0.0, 24.0),
            Align2::CENTER_CENTER,
            text,
            FontId::proportional(12.5),
            pal.gray[8],
        );
    } else {
        let keys = s.app.focus == Some(Panel::Markers) && !ui.ctx().egui_wants_keyboard_input();
        if keys
            && ui.input(|i| i.key_pressed(egui::Key::Enter))
            && let Some(id) = s.app.edit.markers.selected
        {
            s.app.edit.dialog = EditDialog::marker(&s.app, id);
        }
        egui::ScrollArea::vertical().max_height(avail).auto_shrink([false, false]).show_rows(
            ui,
            ROW,
            list.len(),
            |ui, range| {
                for r in &list[range] {
                    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW), Sense::click());
                    let sel = s.app.edit.markers.selected == Some(r.marker.id);
                    let p = ui.painter_at(rect);
                    if sel {
                        p.rect_filled(rect, 2.0, pal.selected.gamma_multiply(0.35));
                    } else if resp.hovered() {
                        p.rect_filled(rect, 2.0, pal.gray[3]);
                    }
                    draw_row(&p, rect, r, fps, &pal, cols);
                    let resp = resp.on_hover_text(
                        [r.marker.name.as_str(), r.marker.note.as_str()]
                            .iter()
                            .filter(|x| !x.is_empty())
                            .copied()
                            .collect::<Vec<_>>()
                            .join("\n"),
                    );
                    if resp.clicked() {
                        s.focus(Panel::Markers);
                        select(s, r, true);
                    }
                    if resp.double_clicked() {
                        s.app.edit.dialog = EditDialog::marker(&s.app, r.marker.id);
                    }
                    resp.context_menu(|ui| {
                        select(s, r, true);
                        if ui.button(tr("Edit Marker…")).clicked() {
                            s.app.edit.dialog = EditDialog::marker(&s.app, r.marker.id);
                            ui.close();
                        }
                        ui.menu_button(tr("Color"), |ui| {
                            for (k, label, c) in COLORS {
                                let on = r.marker.color == k;
                                let text = RichText::new(format!(
                                    "{} {}",
                                    if on { crate::icons::CHECK } else { "  " },
                                    tr(label)
                                ))
                                .color(c);
                                if ui.button(text).clicked()
                                    && let Some(seq) = s.app.sequence_id
                                {
                                    s.app.exec(&C::set_marker(
                                        seq.as_str(),
                                        r.marker.id.as_str(),
                                        serde_json::json!({ "color": k }),
                                    ));
                                    ui.close();
                                }
                            }
                        });
                        ui.separator();
                        if ui.add(egui::Button::new(tr("Remove Marker")).shortcut_text("Delete")).clicked() {
                            s.focus(Panel::Markers);
                            action(s, "delete");
                            ui.close();
                        }
                    });
                }
            },
        );
    }
    let foot = if list.len() == total {
        trf("{n} markers", &[("n", &total.to_string())])
    } else {
        trf("{n} of {total} markers", &[("n", &list.len().to_string()), ("total", &total.to_string())])
    };
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        ui.label(RichText::new(foot).size(11.5).color(pal.gray[8]));
    });
}

fn draw_row(p: &egui::Painter, rect: Rect, r: &Row, fps: cut_time::Fps, pal: &crate::theme::Palette, cols: [f32; 3]) {
    let y = rect.center().y;
    let mut x = rect.left() + 6.0;
    p.circle_filled(egui::pos2(x + 7.0, y), 5.0, color(&r.marker.color));
    x += cols[0];
    let font = FontId::monospace(12.0);
    p.text(egui::pos2(x, y), Align2::LEFT_CENTER, timecode(r.t, fps), font.clone(), pal.gray[11]);
    x += cols[1];
    if r.marker.duration > 0 {
        p.text(egui::pos2(x, y), Align2::LEFT_CENTER, timecode(r.marker.duration, fps), font, pal.gray[10]);
    }
    x += cols[2];
    let name_color = if r.clip.is_some() { pal.gray[10] } else { pal.gray[12] };
    crate::timeline::fit_text(
        p,
        egui::pos2(x, y - 8.0),
        &r.name,
        rect.right() - 96.0 - x,
        FontId::proportional(12.5),
        name_color,
    );
    let kind = if r.clip.is_some() {
        trf("{kind} (clip)", &[("kind", &tr(kind_name(r.marker.kind)))])
    } else {
        tr(kind_name(r.marker.kind)).into_owned()
    };
    p.text(
        egui::pos2(rect.right() - 90.0, y),
        Align2::LEFT_CENTER,
        kind,
        FontId::proportional(12.0),
        Color32::from_gray(160).lerp_to_gamma(pal.gray[10], 0.5),
    );
}
