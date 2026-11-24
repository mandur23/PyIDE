//! A motion graphic clip in the Text panel: its layers, and every field of the chosen one.
//!
//! A graphic clip (`add_graphic`, `Generator::Graphic`) is a list of layers: shapes, paths, text, groups, particles.
//! Until this panel only the AI's tools could read or change them; Effect Controls showed the clip's Motion,
//! Opacity and Crop and nothing of what it draws. The fields are not listed here by hand: the panel walks the model's
//! own table ([`cut_model::graphic::FIELDS`], [`fields_of`](cut_model::graphic::fields_of)), so a field added to the
//! model shows here with a control of its type and its bounds.
//!
//! A field with keyframes shows its value at the playhead and a change is the keyframe there (as in Effect
//! Controls); any other change is the layer's value (`setLayer`). A drag is one undo step, a visit to a text field
//! too.

use cut_model::commands::build as C;
use cut_model::graphic::{self as G, FieldType as T};
use cut_model::keyframes::Value;
use cut_model::{Clip, Generator, Id, Source};
use eframe::egui::{self, RichText};
use serde_json::{Value as Json, json};

use super::layer_id;
use crate::fx::edit::{self, Gesture};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The panel's state for graphic clips.
#[derive(Default)]
pub struct State {
    /// The layer shown, of the clip it belongs to.
    layer: Option<(Id, String)>,
    /// The text field that has the keyboard and what it holds.
    typing: Option<(egui::Id, String)>,
    typing_step: Gesture,
    step: Gesture,
}

impl State {
    /// A drag of a number or a colour picker's visit ended: its changes are one undo step.
    pub fn end(&mut self, app: &mut crate::state::App) {
        self.step.end(app);
    }
}

/// The sections of a layer's fields, in the panel's order. A field shows when the layer's kind has it.
const SECTIONS: [(&str, &[&str]); 6] = [
    ("Layer", &["name", "visible", "parent"]),
    (
        "Content",
        &[
            "text",
            "font",
            "fontSize",
            "weight",
            "italic",
            "align",
            "lineHeight",
            "letterSpacing",
            "value",
            "decimals",
            "reveal",
            "size",
            "radius",
            "innerRadius",
            "points",
            "from",
            "to",
            "d",
            "count",
            "seed",
            "emit",
            "emitter",
            "direction",
            "spread",
            "speed",
            "speedVariation",
            "gravity",
            "life",
            "particleSize",
            "particleSizeEnd",
            "fillEnd",
            "opacityEnd",
            "particleShape",
            "spin",
        ],
    ),
    (
        "Appearance",
        &["fill", "gradient", "stroke", "strokeWidth", "cap", "join", "dash", "trimStart", "trimEnd", "trimOffset"],
    ),
    ("Transform", &["position", "anchor", "scale", "rotation", "opacity"]),
    ("Effects", &["blend", "blur", "shadowColor", "shadowBlur", "shadowOffset"]),
    ("Repeat", &["repeatCount", "repeatOffset", "repeatRotation", "repeatScale", "repeatOpacity"]),
];

/// A field's name on the screen (English, the key of its translation).
fn title(field: &str) -> &'static str {
    match field {
        "name" => "Name",
        "visible" => "Visible",
        "parent" => "Parent",
        "text" => "Text",
        "font" => "Font",
        "fontSize" | "size" => "Size",
        "weight" => "Weight",
        "italic" => "Italic",
        "align" => "Alignment",
        "lineHeight" => "Leading",
        "letterSpacing" => "Tracking",
        "value" => "Number",
        "decimals" => "Decimals",
        "reveal" => "Reveal",
        "radius" => "Radius",
        "innerRadius" => "Inner Radius",
        "points" => "Points",
        "from" => "Start Point",
        "to" => "End Point",
        "d" => "Path",
        "count" => "Count",
        "seed" => "Seed",
        "emit" => "Emission",
        "emitter" => "Emitter Size",
        "direction" => "Direction",
        "spread" => "Spread",
        "speed" => "Speed",
        "speedVariation" => "Speed Variation",
        "gravity" => "Gravity",
        "life" => "Lifetime",
        "particleSize" => "Particle Size",
        "particleSizeEnd" => "End Size",
        "fillEnd" => "End Color",
        "opacityEnd" => "End Opacity",
        "particleShape" => "Particle Shape",
        "spin" => "Spin",
        "fill" => "Fill",
        "gradient" => "Gradient",
        "stroke" => "Stroke",
        "strokeWidth" => "Stroke Width",
        "cap" => "Line Cap",
        "join" => "Line Join",
        "dash" => "Dashes",
        "trimStart" => "Trim Start",
        "trimEnd" => "Trim End",
        "trimOffset" => "Trim Offset",
        "position" => "Position",
        "anchor" => "Anchor Point",
        "scale" => "Scale",
        "rotation" => "Rotation",
        "opacity" => "Opacity",
        "blend" => "Blend Mode",
        "blur" => "Blur",
        "shadowColor" => "Shadow",
        "shadowBlur" => "Shadow Blur",
        "shadowOffset" => "Shadow Offset",
        "repeatCount" => "Copies",
        "repeatOffset" => "Copy Offset",
        "repeatRotation" => "Copy Rotation",
        "repeatScale" => "Copy Scale",
        "repeatOpacity" => "Last Copy Opacity",
        _ => "Value",
    }
}

/// A kind of layer on the screen.
fn kind_title(kind: &str) -> &'static str {
    match kind {
        "rect" => "Rectangle",
        "ellipse" => "Ellipse",
        "polygon" => "Polygon",
        "star" => "Star",
        "line" => "Line",
        "path" => "Path",
        "text" => "Text",
        "group" => "Group",
        "particles" => "Particles",
        _ => "Layer",
    }
}

/// The Korean of this panel's own words. The dictionaries' words stay as they are where they have one (Position,
/// Scale, Opacity...): `i18n` adds these only for keys it does not have.
pub const KO: [(&str, &str); 62] = [
    (
        "Select a text or graphic clip, or click the program monitor with the Type tool (T).",
        "텍스트나 그래픽 클립을 고르거나, 문자 도구(T)로 프로그램 모니터를 누르세요.",
    ),
    ("Edit Graphic", "그래픽 편집"),
    ("{n} layers", "레이어 {n}개"),
    ("Keyframed: a change is the keyframe at the playhead", "키프레임 있음: 바꾸면 재생 위치의 키프레임이 됩니다"),
    ("Show or hide this layer", "이 레이어 표시/숨기기"),
    ("None", "없음"),
    ("Set", "설정됨"),
    ("Remove", "제거"),
    ("Layer", "레이어"),
    ("Content", "내용"),
    ("Appearance", "모양"),
    ("Transform", "변형"),
    ("Effects", "효과"),
    ("Repeat", "반복"),
    ("Rectangle", "사각형"),
    ("Ellipse", "타원"),
    ("Polygon", "다각형"),
    ("Star", "별"),
    ("Line", "선"),
    ("Path", "패스"),
    ("Group", "그룹"),
    ("Particles", "입자"),
    ("Name", "이름"),
    ("Visible", "표시"),
    ("Parent", "상위 레이어"),
    ("Weight", "굵기"),
    ("Italic", "기울임꼴"),
    ("Alignment", "정렬"),
    ("Leading", "행간"),
    ("Tracking", "자간"),
    ("Number", "숫자"),
    ("Decimals", "소수 자릿수"),
    ("Reveal", "나타내기"),
    ("Radius", "반지름"),
    ("Inner Radius", "안쪽 반지름"),
    ("Points", "꼭짓점"),
    ("Start Point", "시작점"),
    ("End Point", "끝점"),
    ("Count", "개수"),
    ("Seed", "시드"),
    ("Emission", "방출"),
    ("Emitter Size", "방출 영역"),
    ("Direction", "방향"),
    ("Spread", "퍼짐"),
    ("Speed Variation", "속도 변화"),
    ("Gravity", "중력"),
    ("Lifetime", "수명"),
    ("Particle Size", "입자 크기"),
    ("End Size", "끝 크기"),
    ("End Color", "끝 색"),
    ("End Opacity", "끝 불투명도"),
    ("Particle Shape", "입자 모양"),
    ("Spin", "회전 속도"),
    ("Gradient", "그라디언트"),
    ("Stroke Width", "선 두께"),
    ("Line Cap", "선 끝 모양"),
    ("Line Join", "선 연결 모양"),
    ("Dashes", "점선"),
    ("Trim Start", "시작 자르기"),
    ("Trim End", "끝 자르기"),
    ("Trim Offset", "자르기 오프셋"),
    ("Blend Mode", "혼합 모드"),
];

/// More of the same (a second table keeps each under the line length the first one's formatting allows).
pub const KO_MORE: [(&str, &str); 9] = [
    ("Shadow Blur", "그림자 흐림"),
    ("Shadow Offset", "그림자 오프셋"),
    ("Copies", "복사본 수"),
    ("Copy Offset", "복사본 간격"),
    ("Copy Rotation", "복사본 회전"),
    ("Copy Scale", "복사본 비율"),
    ("Last Copy Opacity", "마지막 복사본 불투명도"),
    ("Anchor Point", "기준점"),
    ("Value", "값"),
];

/// The graphic clip the panel edits: the primary selected clip when it is one.
pub fn graphic_clip(app: &crate::state::App) -> Option<&Clip> {
    edit::primary_clip(app).filter(|c| matches!(c.source, Source::Generator { generator: Generator::Graphic, .. }))
}

fn kind_of(layer: &Json) -> &str {
    layer.get("kind").and_then(Json::as_str).unwrap_or("")
}

/// What a row of the layer list says after the kind: the name, a text layer's first line, else the id.
fn caption(layer: &Json) -> String {
    let of = |k: &str| layer.get(k).and_then(Json::as_str).filter(|x| !x.trim().is_empty());
    let text = of("text").map(|t| t.lines().next().unwrap_or("").to_owned());
    of("name").map(str::to_owned).or(text).or_else(|| layer_id(layer).map(str::to_owned)).unwrap_or_default()
}

/// The field's value on the screen: at the playhead when keyframed, else the layer's, else the kind's default.
fn value(s: &Shell, c: &Clip, layer: &Json, lid: &str, field: &str) -> Json {
    let path = format!("layers.{lid}.{field}");
    if edit::keyframed(c, &path)
        && let Some(seq) = s.app.sequence()
        && let Some(v) = edit::value_at(seq, c, &path, s.app.t)
    {
        return edit::to_json(&v);
    }
    match layer.get(field) {
        Some(v) => v.clone(),
        None => G::default_of(kind_of(layer), field).map_or(Json::Null, G::FieldDefault::to_json),
    }
}

fn as_value(v: &Json) -> Option<Value> {
    match v {
        Json::Number(n) => n.as_f64().map(Value::Num),
        Json::Array(a) => a.iter().map(Json::as_f64).collect::<Option<Vec<f64>>>().map(Value::List),
        Json::String(t) => Some(Value::Text(t.clone())),
        Json::Bool(b) => Some(Value::Flag(*b)),
        _ => None,
    }
}

/// Sets a field: the keyframe at the playhead when the field has keyframes, else the layer's own value.
fn put(s: &mut Shell, c: &Clip, lid: &str, field: &str, v: Json) {
    s.features.text.panel.graphic.step.begin(&mut s.app, "Edit Graphic");
    let path = format!("layers.{lid}.{field}");
    if edit::keyframed(c, &path)
        && let Some(val) = as_value(&v)
    {
        edit::write(&mut s.app, c.id, &path, &val);
        return;
    }
    if let Some(seq) = s.app.sequence_id {
        s.app.exec(&C::set_layer(seq.as_str(), c.id.as_str(), lid, json!({ field: v })));
    }
}

/// `#rrggbb[aa]` -> the colour and what follows it (the alpha digits, kept as they are).
fn color_of(v: &Json) -> ([u8; 3], String) {
    let t = v.as_str().unwrap_or("#ffffff");
    let byte = |i: usize| t.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).unwrap_or(255);
    ([byte(1), byte(3), byte(5)], t.get(7..).unwrap_or("").to_owned())
}

fn hex(c: [u8; 3], alpha: &str) -> String {
    format!("#{:02x}{:02x}{:02x}{alpha}", c[0], c[1], c[2])
}

/// How finely a number is dragged and shown, from its bounds.
fn step_of(lo: f64, hi: f64, whole: bool) -> (f64, usize) {
    if whole {
        (0.2, 0)
    } else if hi - lo <= 4.0 {
        (0.01, 2)
    } else {
        (1.0, 1)
    }
}

fn drag(ui: &mut egui::Ui, v: f64, lo: f64, hi: f64, whole: bool) -> Option<f64> {
    let (speed, decimals) = step_of(lo, hi, whole);
    let mut x = v;
    let r = ui.add(egui::DragValue::new(&mut x).range(lo..=hi).speed(speed).max_decimals(decimals));
    r.changed().then(|| if whole { x.round() } else { x })
}

/// A text field of a layer: what is typed is the layer's at once, and the visit is one undo step.
fn typed(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, lid: &str, field: &str, now: &str, rows: usize) {
    let id = egui::Id::unique(("cut-graphic-field", c.id.as_str(), lid, field));
    let focused = ui.memory(|m| m.has_focus(id));
    let g = &mut s.features.text.panel.graphic;
    if !focused || g.typing.as_ref().is_none_or(|t| t.0 != id) {
        g.typing = Some((id, now.to_owned()));
    }
    let Some((_, text)) = g.typing.as_mut() else { return };
    let edit =
        if rows > 1 { egui::TextEdit::multiline(text).desired_rows(rows) } else { egui::TextEdit::singleline(text) };
    let r = ui.add(edit.id(id).desired_width(f32::INFINITY));
    let text = text.clone();
    if r.changed() && text != now {
        g.typing_step.begin(&mut s.app, "Edit Graphic");
        if let Some(seq) = s.app.sequence_id {
            s.app.exec(&C::set_layer(seq.as_str(), c.id.as_str(), lid, json!({ field: text })));
        }
    }
    let g = &mut s.features.text.panel.graphic;
    if r.lost_focus() || (!r.has_focus() && g.typing_step.is_open()) {
        g.typing_step.end(&mut s.app);
    }
}

/// One field of the layer, by its type.
fn field_row(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, list: &[Json], layer: &Json, lid: &str, field: &str) {
    let Some(&(_, ty, _)) = G::field(field) else { return };
    let now = value(s, c, layer, lid, field);
    let keyed = edit::keyframed(c, &format!("layers.{lid}.{field}"));
    let wide = matches!(ty, T::Str(_)) && matches!(field, "text" | "d");
    let accent = s.palette.accent;
    let name = move |ui: &mut egui::Ui| {
        ui.add_sized([118.0, 18.0], egui::Label::new(tr(title(field))).truncate());
        if keyed {
            ui.label(RichText::new("◆").size(10.0).color(accent))
                .on_hover_text(tr("Keyframed: a change is the keyframe at the playhead"));
        }
    };
    if wide {
        ui.horizontal(name);
        typed(s, ui, c, lid, field, now.as_str().unwrap_or(""), if field == "text" { 3 } else { 2 });
        return;
    }
    ui.horizontal(|ui| {
        name(ui);
        match ty {
            T::Num(lo, hi) | T::Int(lo, hi) => {
                let whole = matches!(ty, T::Int(..));
                if let Some(x) = drag(ui, now.as_f64().unwrap_or(0.0), lo, hi, whole) {
                    put(s, c, lid, field, json!(x));
                }
            }
            T::Pair(lo, hi) => {
                let (x, y) = (now[0].as_f64().unwrap_or(0.0), now[1].as_f64().unwrap_or(0.0));
                if let Some(nx) = drag(ui, x, lo, hi, false) {
                    put(s, c, lid, field, json!([nx, y]));
                }
                if let Some(ny) = drag(ui, y, lo, hi, false) {
                    put(s, c, lid, field, json!([x, ny]));
                }
            }
            T::ColorOrNull => {
                let mut on = !now.is_null();
                let (mut rgb, alpha) = color_of(&now);
                if ui.checkbox(&mut on, "").changed() {
                    put(s, c, lid, field, if on { json!(hex(rgb, &alpha)) } else { Json::Null });
                }
                if on && ui.color_edit_button_srgb(&mut rgb).changed() {
                    put(s, c, lid, field, json!(hex(rgb, &alpha)));
                }
            }
            T::Enum(options) => {
                let cur = now.as_str().unwrap_or("").to_owned();
                egui::ComboBox::from_id_salt(("cut-graphic-enum", lid, field)).selected_text(cur.clone()).show_ui(
                    ui,
                    |ui| {
                        for o in options {
                            if ui.selectable_label(cur == *o, *o).clicked() && cur != *o {
                                put(s, c, lid, field, json!(o));
                            }
                        }
                    },
                );
            }
            T::Bool => {
                let mut on = now.as_bool().unwrap_or(false);
                if ui.checkbox(&mut on, "").changed() {
                    put(s, c, lid, field, json!(on));
                }
            }
            T::Str(_) => typed(s, ui, c, lid, field, now.as_str().unwrap_or(""), 1),
            T::IdOrNull => {
                // a layer's parent is a group earlier in the list
                let at = list.iter().position(|l| layer_id(l) == Some(lid)).unwrap_or(0);
                let groups: Vec<&str> =
                    list[..at].iter().filter(|l| kind_of(l) == "group").filter_map(layer_id).collect();
                let cur = now.as_str().map(str::to_owned);
                let shown = cur.clone().unwrap_or_else(|| tr("None").into_owned());
                egui::ComboBox::from_id_salt(("cut-graphic-parent", lid)).selected_text(shown).show_ui(ui, |ui| {
                    if ui.selectable_label(cur.is_none(), tr("None")).clicked() && cur.is_some() {
                        put(s, c, lid, field, Json::Null);
                    }
                    for g in groups {
                        if ui.selectable_label(cur.as_deref() == Some(g), g).clicked() && cur.as_deref() != Some(g) {
                            put(s, c, lid, field, json!(g));
                        }
                    }
                });
            }
            // a gradient and a dash pattern are shown as set or not, and can be taken off
            T::GradientOrNull | T::DashOrNull => {
                if now.is_null() {
                    ui.label(RichText::new(tr("None")).color(s.palette.gray[8]));
                } else {
                    ui.label(tr("Set"));
                    if ui.small_button(tr("Remove")).clicked() {
                        put(s, c, lid, field, Json::Null);
                    }
                }
            }
        }
    });
}

/// The panel's body for a graphic clip.
pub fn body(s: &mut Shell, ui: &mut egui::Ui, c: &Clip) {
    let list: Vec<Json> = super::layers(c).to_vec();
    // the list's heading is its count: a second "Layers" above the "Layer" section read as the same thing twice
    ui.label(RichText::new(trf("{n} layers", &[("n", &list.len().to_string())])).strong().color(s.palette.gray[10]));
    let keep = s
        .features
        .text
        .panel
        .graphic
        .layer
        .as_ref()
        .filter(|(id, l)| *id == c.id && list.iter().any(|x| layer_id(x) == Some(l.as_str())))
        .map(|x| x.1.clone());
    // the top layer first, as it is seen
    let Some(lid) = keep.or_else(|| list.last().and_then(layer_id).map(str::to_owned)) else { return };
    s.features.text.panel.graphic.layer = Some((c.id, lid.clone()));
    egui::ScrollArea::vertical().id_salt("cut-graphic-layers").max_height(190.0).show(ui, |ui| {
        for l in list.iter().rev() {
            let Some(id) = layer_id(l) else { continue };
            ui.horizontal(|ui| {
                let mut on = l.get("visible").and_then(Json::as_bool).unwrap_or(true);
                if ui.checkbox(&mut on, "").on_hover_text(tr("Show or hide this layer")).changed() {
                    put(s, c, id, "visible", json!(on));
                }
                if l.get("parent").is_some_and(|p| !p.is_null()) {
                    ui.add_space(12.0);
                }
                let text = format!("{}  {}", tr(kind_title(kind_of(l))), caption(l));
                if ui.add(egui::Button::selectable(id == lid, text).truncate()).clicked() {
                    s.features.text.panel.graphic.layer = Some((c.id, id.to_owned()));
                }
            });
        }
    });
    let Some(layer) = list.iter().find(|l| layer_id(l) == Some(lid.as_str())).cloned() else { return };
    let has = G::fields_of(kind_of(&layer));
    for (name, fields) in SECTIONS {
        let shown: Vec<&str> = fields.iter().copied().filter(|f| has.contains(f) && *f != "visible").collect();
        if shown.is_empty() {
            continue;
        }
        ui.add_space(6.0);
        ui.label(RichText::new(tr(name)).strong().color(s.palette.gray[10]));
        for f in shown {
            field_row(s, ui, c, &list, &layer, &lid, f);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A field the model gains shows in the panel only when a section lists it.
    #[test]
    fn every_layer_field_has_a_section_and_a_title() {
        let listed: Vec<&str> = SECTIONS.iter().flat_map(|(_, f)| f.iter().copied()).collect();
        for (name, ..) in G::FIELDS {
            assert_eq!(listed.iter().filter(|f| *f == name).count(), 1, "{name} is in one section");
            assert_ne!(title(name), "Value", "{name} has a title of its own");
        }
        assert_eq!(listed.len(), G::FIELDS.len(), "and no section lists a field the model has not");
    }
}
