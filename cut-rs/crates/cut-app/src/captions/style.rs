//! The Caption Style dialog (`styleDialog`): the shown track's font (from the system's families, read on a thread
//! as the Text panel reads them), size at 1080p, text colour, background colour
//! and opacity, top or bottom, and the word-by-word highlight (only captions with word timings light up). OK sets them
//! in one undo step.

use cut_model::commands::build as C;
use cut_model::{Id, captionwords};
use eframe::egui::{self, Align2, Color32, DragValue, Vec2};
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::theme::hex;

/// The dialog's fields.
#[derive(Debug, Clone, PartialEq)]
pub struct StyleForm {
    pub track: Id,
    pub font: String,
    pub size: f64,
    pub color: Color32,
    pub background: Color32,
    /// Background opacity, percent.
    pub alpha: f64,
    pub bottom: bool,
    pub highlight: bool,
    pub highlight_color: Color32,
    pub boxed: bool,
    /// Captions with word timings, of all.
    pub timed: (usize, usize),
    /// How the captions show their speakers (`crate::speakers::label::CAPTION_MODES`).
    pub speakers: &'static str,
}

fn text_of(v: Option<&Json>, or: &str) -> String {
    v.and_then(Json::as_str).unwrap_or(or).to_owned()
}

fn rgb(c: Color32) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
}

impl StyleForm {
    /// The form for a track's style over the defaults.
    pub fn of(t: &cut_model::CaptionTrack) -> StyleForm {
        let mut s = cut_model::defaults::default_caption_style();
        for (k, v) in &t.style {
            s.insert(k.clone(), v.clone());
        }
        let color = |k: &str, or: &str| {
            hex(&text_of(s.get(k), or).chars().take(7).collect::<String>()).unwrap_or(Color32::WHITE)
        };
        let bg = text_of(s.get("background"), "#00000000");
        let a = u8::from_str_radix(bg.get(7..9).unwrap_or("ff"), 16).unwrap_or(255);
        let timed = t
            .items
            .iter()
            .filter(|it| captionwords::valid(&serde_json::to_value(&it.words).unwrap_or(Json::Null), &it.text))
            .count();
        StyleForm {
            track: t.id,
            font: text_of(s.get("font"), "Malgun Gothic"),
            size: s.get("size").and_then(Json::as_f64).unwrap_or(54.0),
            color: color("color", "#ffffff"),
            background: hex(bg.get(..7).unwrap_or("#000000")).unwrap_or(Color32::BLACK),
            alpha: (f64::from(a) / 255.0 * 100.0 + 0.5).floor(),
            bottom: text_of(s.get("position"), "bottom") != "top",
            highlight: s.get("highlight").and_then(Json::as_bool).unwrap_or(false),
            highlight_color: color("highlightColor", "#ffd23f"),
            boxed: text_of(s.get("highlightMode"), "color") == "box",
            timed: (timed, t.items.len()),
            speakers: crate::speakers::label::mode_of(&s),
        }
    }

    /// The style patch OK sets.
    pub fn patch(&self) -> Json {
        let a = (self.alpha / 100.0 * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8;
        let mut style = json!({
            "font": self.font, "size": self.size.round() as i64, "color": rgb(self.color),
            "background": format!("{}{a:02x}", rgb(self.background)),
            "position": if self.bottom { "bottom" } else { "top" }, "highlight": self.highlight,
            "highlightColor": rgb(self.highlight_color), "highlightMode": if self.boxed { "box" } else { "color" },
        });
        if let (Some(s), Json::Object(spk)) = (style.as_object_mut(), crate::speakers::label::style_of(self.speakers)) {
            s.extend(spk);
        }
        json!({ "style": style })
    }
}

/// Opens the dialog for the shown track.
pub fn open(s: &mut Shell) {
    match super::track_of(&s.app, &s.features.captions) {
        Some(t) => s.features.captions.style = Some(StyleForm::of(t)),
        None => s.app.toast(tr("Add captions first.")),
    }
}

fn color(ui: &mut egui::Ui, c: &mut Color32) {
    let mut v = [c.r(), c.g(), c.b()];
    if egui::color_picker::color_edit_button_srgb(ui, &mut v).changed() {
        *c = Color32::from_rgb(v[0], v[1], v[2]);
    }
}

/// The dialog, while open.
pub fn window(s: &mut Shell, ctx: &egui::Context) {
    let Some(mut f) = s.features.captions.style.clone() else { return };
    // the system's families, the track's own first when it is not installed
    let mut fonts: Vec<(String, String)> = crate::text_ui::panel::families(s, ctx)
        .unwrap_or_default()
        .iter()
        .map(|x| (x.family.clone(), x.label()))
        .collect();
    if !fonts.iter().any(|(v, _)| *v == f.font) {
        fonts.insert(0, (f.font.clone(), f.font.clone()));
    }
    let mut done = None;
    egui::Window::new(tr("Caption Style")).id(egui::Id::unique("cutCaptionStyle")).collapsible(false).resizable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO).default_width(420.0).show(ctx, |ui| {
            egui::Grid::new("cut-cap-style").num_columns(2).spacing([12.0, 6.0]).show(ui, |ui| {
                ui.label(tr("Font"));
                let shown = fonts.iter().find(|(v, _)| *v == f.font).map_or(f.font.clone(), |(_, l)| l.clone());
                egui::ComboBox::from_id_salt("cut-cap-font").icon(crate::theme::combo_icon).selected_text(shown).height(320.0).show_ui(ui, |ui| {
                    for (v, l) in &fonts {
                        ui.selectable_value(&mut f.font, v.clone(), l);
                    }
                });
                ui.end_row();
                ui.label(tr("Size at 1080p"));
                ui.add(DragValue::new(&mut f.size).range(8.0..=300.0).speed(1.0).max_decimals(0).suffix(" px"));
                ui.end_row();
                ui.label(tr("Text color"));
                color(ui, &mut f.color);
                ui.end_row();
                ui.label(tr("Background"));
                color(ui, &mut f.background);
                ui.end_row();
                ui.label(tr("Background opacity"));
                ui.add(DragValue::new(&mut f.alpha).range(0.0..=100.0).speed(1.0).max_decimals(0).suffix(" %"));
                ui.end_row();
                ui.label(tr("Position"));
                egui::ComboBox::from_id_salt("cut-cap-pos").icon(crate::theme::combo_icon).selected_text(tr(if f.bottom { "Bottom" } else { "Top" })).show_ui(ui, |ui| {
                    ui.selectable_value(&mut f.bottom, true, tr("Bottom"));
                    ui.selectable_value(&mut f.bottom, false, tr("Top"));
                });
                ui.end_row();
                ui.label(tr("Highlight each word as it is spoken"));
                ui.checkbox(&mut f.highlight, "");
                ui.end_row();
                ui.label(tr("Highlight color"));
                color(ui, &mut f.highlight_color);
                ui.end_row();
                ui.label(tr("Highlight style"));
                let mode = |b: bool| tr(if b { "Word color and box" } else { "Word color" });
                egui::ComboBox::from_id_salt("cut-cap-hl-mode").icon(crate::theme::combo_icon).selected_text(mode(f.boxed)).show_ui(ui, |ui| {
                    ui.selectable_value(&mut f.boxed, false, mode(false));
                    ui.selectable_value(&mut f.boxed, true, mode(true));
                });
                ui.end_row();
            });
            ui.label(egui::RichText::new(trf(
                "{n} of {m} captions have word timings. Captions made with Auto Captions have them; imported or typed ones show no highlight.",
                &[("n", &f.timed.0.to_string()), ("m", &f.timed.1.to_string())],
            )).size(11.0));
            crate::speakers::label::style_row(ui, &mut f.speakers);
            ui.horizontal(|ui| {
                if ui.button(tr("OK")).clicked() {
                    done = Some(true);
                }
                if ui.button(tr("Cancel")).clicked() {
                    done = Some(false);
                }
            });
        });
    match done {
        None => s.features.captions.style = Some(f),
        Some(ok) => {
            s.features.captions.style = None;
            if ok && let Some(seq) = s.app.sequence_id {
                s.app.exec(&C::set_caption_track(seq.as_str(), f.track.as_str(), f.patch()));
            }
        }
    }
}
