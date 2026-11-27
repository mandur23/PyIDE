//! The Caption Style dialog (`styleDialog`): the shown track's font (from the system's families, read on a thread
//! as the Text panel reads them), size at 1080p, weight and italic, text colour, background colour and opacity, an
//! outline and a shadow (the native editor's own), top, middle or bottom with its distance from the edge, and the
//! word-by-word highlight (only captions with word timings light up). Presets set every field at once: the built-in
//! ones and the person's own (`captionPresets`). OK sets them in one undo step; the Program monitor and an export's
//! burn-in draw them.

use cut_model::commands::build as C;
use cut_model::{Extra, Id, captionwords};
use eframe::egui::{self, Align2, Color32, DragValue, Vec2};
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::panels::dialogs::Titled as _;
use crate::shell::Shell;
use crate::theme::hex;

/// The setting the person's presets are kept in: `[{ name, style }]`.
pub const PRESETS: &str = "captionPresets";

/// The dialog's fields.
#[derive(Debug, Clone, PartialEq)]
pub struct StyleForm {
    pub track: Id,
    pub font: String,
    pub size: f64,
    pub weight: u16,
    pub italic: bool,
    pub color: Color32,
    pub background: Color32,
    /// Background opacity, percent.
    pub alpha: f64,
    /// `bottom`, `middle` or `top`.
    pub position: &'static str,
    /// Distance from the top or bottom edge, percent of the height.
    pub margin: f64,
    pub outline: bool,
    pub outline_color: Color32,
    /// Pixels at 1080p.
    pub outline_width: f64,
    pub shadow: bool,
    pub shadow_color: Color32,
    /// Shadow opacity, percent.
    pub shadow_alpha: f64,
    /// Pixels at 1080p.
    pub shadow_blur: f64,
    pub shadow_distance: f64,
    pub highlight: bool,
    pub highlight_color: Color32,
    pub boxed: bool,
    /// Captions with word timings, of all.
    pub timed: (usize, usize),
    /// How the captions show their speakers (`crate::speakers::label::CAPTION_MODES`).
    pub speakers: &'static str,
    /// The name a new preset is being given, while it is typed.
    pub naming: Option<String>,
}

fn text_of(v: Option<&Json>, or: &str) -> String {
    v.and_then(Json::as_str).unwrap_or(or).to_owned()
}

fn rgb(c: Color32) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
}

/// `#rrggbb` and the opacity (percent, unrounded so that it gives the same byte back) of `#rrggbb` or `#rrggbbaa`.
fn color_alpha(v: &str, or: Color32) -> (Color32, f64) {
    let c = hex(v.get(..7).unwrap_or("")).unwrap_or(or);
    let a = v.get(7..9).and_then(|x| u8::from_str_radix(x, 16).ok()).unwrap_or(255);
    (c, f64::from(a) / 255.0 * 100.0)
}

fn with_alpha(c: Color32, percent: f64) -> String {
    let a = (percent / 100.0 * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8;
    format!("{}{a:02x}", rgb(c))
}

/// The built-in presets: `(name, style)`, each over the defaults.
pub fn builtin() -> Vec<(&'static str, Json)> {
    vec![
        ("Default", json!({})),
        (
            "White with Outline",
            json!({ "weight": 800, "background": "#00000000", "outline": "#000000", "outlineWidth": 4 }),
        ),
        (
            "Yellow Bold",
            json!({ "weight": 800, "color": "#ffe14d", "background": "#00000000", "outline": "#000000",
                    "outlineWidth": 3, "shadow": "#000000aa", "shadowBlur": 6, "shadowX": 3, "shadowY": 3 }),
        ),
        ("Boxed", json!({ "weight": 600, "background": "#000000cc" })),
        (
            "Soft Shadow",
            json!({ "weight": 700, "background": "#00000000", "shadow": "#000000cc", "shadowBlur": 10, "shadowX": 0,
                    "shadowY": 3 }),
        ),
        (
            "Karaoke",
            json!({ "weight": 800, "background": "#00000000", "outline": "#000000", "outlineWidth": 4,
                    "highlight": true, "highlightColor": "#ffd23f", "highlightMode": "color" }),
        ),
        (
            "Big Center",
            json!({ "size": 84, "weight": 900, "position": "middle", "background": "#00000000", "outline": "#000000",
                    "outlineWidth": 6 }),
        ),
        ("Top Title", json!({ "size": 60, "weight": 800, "position": "top", "margin": 6, "background": "#1e3a8acc" })),
    ]
}

impl StyleForm {
    /// The form for a track's style over the defaults.
    pub fn of(t: &cut_model::CaptionTrack) -> StyleForm {
        let timed = t
            .items
            .iter()
            .filter(|it| captionwords::valid(&serde_json::to_value(&it.words).unwrap_or(Json::Null), &it.text))
            .count();
        StyleForm::from_style(t.id, &t.style, (timed, t.items.len()))
    }

    /// The form of `style` over the defaults.
    pub fn from_style(track: Id, style: &Extra, timed: (usize, usize)) -> StyleForm {
        let mut s = cut_model::defaults::default_caption_style();
        for (k, v) in style {
            s.insert(k.clone(), v.clone());
        }
        let num = |k: &str, or: f64| s.get(k).and_then(Json::as_f64).filter(|v| v.is_finite()).unwrap_or(or);
        let color = |k: &str, or: &str| color_alpha(&text_of(s.get(k), or), Color32::WHITE).0;
        let (background, alpha) = color_alpha(&text_of(s.get("background"), "#00000000"), Color32::BLACK);
        // the background's opacity is shown in whole percent, as the JavaScript's dialog shows it
        let alpha = (alpha + 0.5).floor();
        let outline = s.get("outline").and_then(Json::as_str).filter(|_| num("outlineWidth", 0.0) > 0.0);
        let shadow = s.get("shadow").and_then(Json::as_str);
        let (shadow_color, shadow_alpha) = color_alpha(shadow.unwrap_or("#000000aa"), Color32::BLACK);
        let position = match text_of(s.get("position"), "bottom").as_str() {
            "top" => "top",
            "middle" => "middle",
            _ => "bottom",
        };
        StyleForm {
            track,
            font: text_of(s.get("font"), "Malgun Gothic"),
            size: num("size", 54.0),
            weight: num("weight", 600.0).round().clamp(100.0, 900.0) as u16,
            italic: s.get("italic").and_then(Json::as_bool).unwrap_or(false),
            color: color("color", "#ffffff"),
            background,
            alpha,
            position,
            margin: num("margin", 8.0),
            outline: outline.is_some(),
            outline_color: color_alpha(outline.unwrap_or("#000000"), Color32::BLACK).0,
            outline_width: num("outlineWidth", 0.0).max(if outline.is_some() { 0.0 } else { 3.0 }),
            shadow: shadow.is_some(),
            shadow_color,
            shadow_alpha,
            shadow_blur: num("shadowBlur", 6.0),
            shadow_distance: num("shadowY", 3.0),
            highlight: s.get("highlight").and_then(Json::as_bool).unwrap_or(false),
            highlight_color: color("highlightColor", "#ffd23f"),
            boxed: text_of(s.get("highlightMode"), "color") == "box",
            timed,
            speakers: crate::speakers::label::mode_of(&s),
            naming: None,
        }
    }

    /// The style these fields make (without the speakers' keys).
    pub fn style(&self) -> Json {
        json!({
            "font": self.font, "size": self.size.round() as i64, "weight": self.weight, "italic": self.italic,
            "color": rgb(self.color), "background": with_alpha(self.background, self.alpha),
            "position": self.position, "margin": self.margin,
            "outline": if self.outline { json!(rgb(self.outline_color)) } else { Json::Null },
            "outlineWidth": if self.outline { json!(self.outline_width) } else { Json::Null },
            "shadow": if self.shadow { json!(with_alpha(self.shadow_color, self.shadow_alpha)) } else { Json::Null },
            "shadowBlur": if self.shadow { json!(self.shadow_blur) } else { Json::Null },
            "shadowX": if self.shadow { json!(self.shadow_distance * 0.7) } else { Json::Null },
            "shadowY": if self.shadow { json!(self.shadow_distance) } else { Json::Null },
            "highlight": self.highlight, "highlightColor": rgb(self.highlight_color),
            "highlightMode": if self.boxed { "box" } else { "color" },
        })
    }

    /// The style patch OK sets (a `null` key is removed from the track's style).
    pub fn patch(&self) -> Json {
        let mut style = self.style();
        if let (Some(s), Json::Object(spk)) = (style.as_object_mut(), crate::speakers::label::style_of(self.speakers)) {
            s.extend(spk);
        }
        json!({ "style": style })
    }

    /// The form with a preset's style over the defaults; the track, its counts and the speakers' choice stay.
    pub fn with_preset(&self, style: &Json) -> StyleForm {
        let mut m = Extra::new();
        for (k, v) in style.as_object().into_iter().flatten().filter(|(_, v)| !v.is_null()) {
            m.insert(k.clone(), v.clone());
        }
        // a preset without its own font keeps the one chosen
        m.entry("font".to_owned()).or_insert_with(|| json!(self.font));
        StyleForm { speakers: self.speakers, ..StyleForm::from_style(self.track, &m, self.timed) }
    }
}

/// The person's presets: `(name, style)`.
pub fn own_presets(s: &Shell) -> Vec<(String, Json)> {
    s.doc
        .settings
        .get(PRESETS)
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p.get("name")?.as_str()?.to_owned(), p.get("style")?.clone())))
        .collect()
}

fn set_own_presets(s: &mut Shell, list: &[(String, Json)]) {
    let v: Vec<Json> = list.iter().map(|(n, st)| json!({ "name": n, "style": st })).collect();
    s.doc.settings.set(PRESETS, Json::Array(v));
    let _ = s.doc.settings.save();
}

/// Keeps the form's style as the preset `name` (replacing one of that name).
pub fn save_preset(s: &mut Shell, name: &str, f: &StyleForm) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let mut list = own_presets(s);
    match list.iter_mut().find(|(n, _)| n == name) {
        Some(p) => p.1 = f.style(),
        None => list.push((name.to_owned(), f.style())),
    }
    set_own_presets(s, &list);
    true
}

pub fn delete_preset(s: &mut Shell, name: &str) {
    let mut list = own_presets(s);
    list.retain(|(n, _)| n != name);
    set_own_presets(s, &list);
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

fn px(ui: &mut egui::Ui, v: &mut f64, max: f64) {
    ui.add(DragValue::new(v).range(0.0..=max).speed(0.5).max_decimals(1).suffix(" px"));
}

/// What the dialog's preset row asks for.
enum PresetAsk {
    Apply(Json),
    Delete(String),
    Save(String),
}

fn preset_row(ui: &mut egui::Ui, f: &mut StyleForm, own: &[(String, Json)]) -> Option<PresetAsk> {
    let mut ask = None;
    ui.horizontal(|ui| {
        ui.label(tr("Preset"));
        egui::ComboBox::from_id_salt("cut-cap-preset")
            .icon(crate::theme::combo_icon)
            .selected_text(tr("Choose a preset…"))
            .height(320.0)
            .show_ui(ui, |ui| {
                for (name, style) in builtin() {
                    if ui.selectable_label(false, tr(name)).clicked() {
                        ask = Some(PresetAsk::Apply(style));
                    }
                }
                if !own.is_empty() {
                    ui.separator();
                }
                for (name, style) in own {
                    if ui.selectable_label(false, name).clicked() {
                        ask = Some(PresetAsk::Apply(style.clone()));
                    }
                }
            });
        match &mut f.naming {
            None => {
                if ui.button(tr("Save as Preset…")).clicked() {
                    f.naming = Some(String::new());
                }
                if !own.is_empty() {
                    ui.menu_button(tr("Delete Preset"), |ui| {
                        for (name, _) in own {
                            if ui.button(name).clicked() {
                                ask = Some(PresetAsk::Delete(name.clone()));
                                ui.close();
                            }
                        }
                    });
                }
            }
            Some(name) => {
                let r = ui.add(egui::TextEdit::singleline(name).hint_text(tr("Preset name")).desired_width(150.0));
                if !r.has_focus() && name.is_empty() {
                    r.request_focus();
                }
                let enter = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if (ui.add_enabled(!name.trim().is_empty(), egui::Button::new(tr("Save"))).clicked() || enter)
                    && !name.trim().is_empty()
                {
                    ask = Some(PresetAsk::Save(name.trim().to_owned()));
                }
            }
        }
    });
    ask
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
    let own = own_presets(s);
    let mut done = None;
    let mut ask = None;
    egui::Window::new(tr("Caption Style")).id(egui::Id::unique("cutCaptionStyle")).collapsible(false).resizable(false)
        .anchor(Align2::CENTER_CENTER, Vec2::ZERO).default_width(460.0).show_titled(ctx, tr("Caption Style"), None, |ui| {
            ask = preset_row(ui, &mut f, &own);
            ui.separator();
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
                ui.label(tr("Weight"));
                ui.horizontal(|ui| {
                    let name = |w: u16| tr(match w { ..=450 => "Regular", 451..=650 => "Semibold", 651..=850 => "Bold", _ => "Black" });
                    egui::ComboBox::from_id_salt("cut-cap-weight").icon(crate::theme::combo_icon).selected_text(name(f.weight)).show_ui(ui, |ui| {
                        for w in [400, 600, 800, 900] {
                            ui.selectable_value(&mut f.weight, w, name(w));
                        }
                    });
                    ui.checkbox(&mut f.italic, tr("Italic"));
                });
                ui.end_row();
                ui.label(tr("Text color"));
                color(ui, &mut f.color);
                ui.end_row();
                ui.label(tr("Background"));
                ui.horizontal(|ui| {
                    color(ui, &mut f.background);
                    ui.add(DragValue::new(&mut f.alpha).range(0.0..=100.0).speed(1.0).max_decimals(0).suffix(" %"))
                        .on_hover_text(tr("Background opacity"));
                });
                ui.end_row();
                ui.label(tr("Outline"));
                ui.horizontal(|ui| {
                    ui.checkbox(&mut f.outline, "");
                    ui.add_enabled_ui(f.outline, |ui| {
                        color(ui, &mut f.outline_color);
                        px(ui, &mut f.outline_width, 30.0);
                    });
                });
                ui.end_row();
                ui.label(tr("Shadow"));
                ui.horizontal(|ui| {
                    ui.checkbox(&mut f.shadow, "");
                    ui.add_enabled_ui(f.shadow, |ui| {
                        color(ui, &mut f.shadow_color);
                        ui.add(DragValue::new(&mut f.shadow_alpha).range(0.0..=100.0).speed(1.0).max_decimals(0).suffix(" %"));
                        ui.label(tr("Blur"));
                        px(ui, &mut f.shadow_blur, 60.0);
                        ui.label(tr("Distance"));
                        px(ui, &mut f.shadow_distance, 60.0);
                    });
                });
                ui.end_row();
                ui.label(tr("Position"));
                ui.horizontal(|ui| {
                    let name = |p: &str| tr(match p { "top" => "Top", "middle" => "Middle", _ => "Bottom" });
                    egui::ComboBox::from_id_salt("cut-cap-pos").icon(crate::theme::combo_icon).selected_text(name(f.position)).show_ui(ui, |ui| {
                        for p in ["bottom", "middle", "top"] {
                            ui.selectable_value(&mut f.position, p, name(p));
                        }
                    });
                    ui.add_enabled(f.position != "middle", DragValue::new(&mut f.margin).range(0.0..=45.0).speed(0.5).max_decimals(1).suffix(" %"))
                        .on_hover_text(tr("Distance from the edge"));
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
            crate::panels::dialogs::actions(ui, |ui| {
                if crate::panels::dialogs::primary(ui, tr("OK")).clicked() {
                    done = Some(true);
                }
                if ui.button(tr("Cancel")).clicked() {
                    done = Some(false);
                }
            });
        });
    match ask {
        Some(PresetAsk::Apply(style)) => f = f.with_preset(&style),
        Some(PresetAsk::Delete(name)) => delete_preset(s, &name),
        Some(PresetAsk::Save(name)) => {
            if save_preset(s, &name, &f) {
                s.app.toast(trf("Saved the caption preset {name}", &[("name", &name)]));
            }
            f.naming = None;
        }
        None => {}
    }
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

/// Korean of the dialog's texts the JavaScript editor does not have.
pub const KO: [(&str, &str); 28] = [
    ("Preset", "사전 설정"),
    ("Choose a preset…", "사전 설정 고르기…"),
    ("Save as Preset…", "사전 설정으로 저장…"),
    ("Delete Preset", "사전 설정 삭제"),
    ("Preset name", "사전 설정 이름"),
    ("Saved the caption preset {name}", "{name} 자막 사전 설정을 저장했습니다"),
    ("Weight", "굵기"),
    ("Regular", "보통"),
    ("Semibold", "약간 굵게"),
    ("Bold", "굵게"),
    ("Black", "아주 굵게"),
    ("Italic", "기울임"),
    ("Outline", "외곽선"),
    ("Shadow", "그림자"),
    ("Blur", "흐림"),
    ("Distance", "거리"),
    ("Middle", "가운데"),
    ("Distance from the edge", "가장자리에서의 거리"),
    ("Default", "기본"),
    ("White with Outline", "흰 글자와 외곽선"),
    ("Yellow Bold", "굵은 노랑"),
    ("Boxed", "상자"),
    ("Soft Shadow", "부드러운 그림자"),
    ("Karaoke", "노래방"),
    ("Big Center", "가운데 큰 글자"),
    ("Top Title", "위쪽 제목"),
    ("Background opacity", "배경 불투명도"),
    ("Save", "저장"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_style_goes_through_the_form_unchanged_and_presets_set_their_fields() {
        let track = Id::new("k1");
        let f = StyleForm::from_style(track, &Extra::new(), (0, 0));
        assert_eq!((f.position, f.outline, f.shadow, f.weight), ("bottom", false, false, 600));
        assert_eq!(f.style()["background"], "#00000099");
        assert!(f.style()["outline"].is_null(), "no outline: the key is removed");
        let yellow = &builtin().into_iter().find(|p| p.0 == "Yellow Bold").unwrap().1;
        let y = f.with_preset(yellow);
        assert_eq!((y.weight, y.outline, y.outline_width, y.shadow), (800, true, 3.0, true));
        assert_eq!(y.style()["color"], "#ffe14d");
        assert_eq!(y.style()["shadow"], "#000000aa");
        assert_eq!(y.font, f.font, "a preset without a font keeps the one chosen");
        // what OK sets comes back as the same form
        let Json::Object(m) = y.style() else { unreachable!() };
        let back = StyleForm::from_style(track, &m.into_iter().filter(|(_, v)| !v.is_null()).collect(), (0, 0));
        assert_eq!(back.style(), y.style());
        let big = f.with_preset(&builtin().into_iter().find(|p| p.0 == "Big Center").unwrap().1);
        assert_eq!((big.position, big.size), ("middle", 84.0));
    }
}
