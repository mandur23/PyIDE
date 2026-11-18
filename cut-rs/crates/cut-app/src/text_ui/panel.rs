//! The Text panel (`ui-text.js`): the layers of the selected text clip and the look of the chosen one: the text,
//! the font with its Korean name, the style, size, tracking, leading, alignment, fill, stroke, shadow, background box
//! and position; the saved text styles (project settings `textStyles`) and the motion presets.
//!
//! A field keyframed in Effect Controls is written at the playhead ([`edit::write`]); typing is one undo step per
//! visit to the text field, and a drag of a number or a colour picker's session is one step too.

use std::sync::mpsc::Receiver;

use cut_model::commands::build as C;
use cut_model::keyframes::Value;
use cut_model::{Clip, Id};
use eframe::egui::{self, RichText};
use serde_json::{Map, Value as Json, json};

use super::fonts::{self, Family};
use super::{layer_id, layers, presets};
use crate::fx::edit::{self, Gesture};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The fields a text style keeps (`STYLE_FIELDS`).
pub const STYLE_FIELDS: [&str; 11] =
    ["font", "size", "weight", "italic", "tracking", "leading", "align", "fill", "stroke", "shadow", "box"];

/// The panel's state between frames.
#[derive(Default)]
pub struct PanelState {
    /// The layer shown, of the clip it belongs to.
    pub layer: Option<(Id, String)>,
    /// What the text field holds while it has the keyboard.
    text: String,
    text_gesture: Gesture,
    gesture: Gesture,
    pub fonts: Option<Vec<Family>>,
    fonts_rx: Option<Receiver<Vec<Family>>>,
    style: Option<String>,
    /// The name being typed for Save… (`ide.ui.prompt`).
    naming: Option<String>,
}

fn path(layer: &str, field: &str) -> String {
    format!("layers.{layer}.{field}")
}

/// `valueOf`: the field at the playhead when keyframed, else the layer's value.
fn value_of(s: &Shell, c: &Clip, layer: &Json, lid: &str, field: &str) -> Json {
    let p = path(lid, field);
    if edit::keyframed(c, &p)
        && let Some(seq) = s.app.sequence()
        && let Some(v) = edit::value_at(seq, c, &p, s.app.t)
    {
        return edit::to_json(&v);
    }
    layer.get(field).cloned().unwrap_or(Json::Null)
}

/// `#rrggbb[aa]` -> the colour's RGB.
fn rgb_of(v: &Json) -> [u8; 3] {
    let s = v.as_str().unwrap_or("#000000");
    let byte = |i: usize| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).unwrap_or(0);
    [byte(1), byte(3), byte(5)]
}

fn hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// Every change of the panel's controls goes through here: one command, joined to the drag's step while one runs.
fn exec(s: &mut Shell, cmd: &Json) {
    s.features.text.panel.gesture.begin(&mut s.app, "Edit Text");
    s.app.exec(cmd);
}

fn set_layer(s: &mut Shell, c: Id, lid: &str, patch: Json) {
    let Some(seq) = s.app.sequence_id else { return };
    exec(s, &C::set_layer(seq.as_str(), c.as_str(), lid, patch));
}

/// `setField`: at the playhead (a keyframe when the field is keyframed), else the layer's value.
fn set_field(s: &mut Shell, c: Id, lid: &str, field: &str, v: Value) {
    s.features.text.panel.gesture.begin(&mut s.app, "Edit Text");
    edit::write(&mut s.app, c, &path(lid, field), &v);
}

fn number(ui: &mut egui::Ui, v: f64, lo: f64, hi: f64, speed: f64, decimals: usize, hint: &str) -> Option<f64> {
    let mut x = v;
    let r = ui.add(egui::DragValue::new(&mut x).range(lo..=hi).speed(speed).max_decimals(decimals));
    let r = if hint.is_empty() { r } else { r.on_hover_text(hint) };
    r.changed().then_some(x)
}

fn label(ui: &mut egui::Ui, text: &str) {
    ui.add_sized([86.0, 18.0], egui::Label::new(tr(text)));
}

fn section(ui: &mut egui::Ui, s: &Shell, name: &str) {
    ui.add_space(6.0);
    ui.label(RichText::new(tr(name)).strong().color(s.palette.gray[10]));
}

/// The installed families (`cut:fonts`), read on a thread the first time they are asked for; `None` until then.
pub fn families<'a>(s: &'a mut Shell, ctx: &egui::Context) -> Option<&'a [Family]> {
    if s.features.text.panel.fonts.is_none() && s.features.text.panel.fonts_rx.is_none() {
        s.features.text.panel.fonts_rx = Some(fonts::load());
    }
    if let Some(rx) = &s.features.text.panel.fonts_rx
        && let Ok(list) = rx.try_recv()
    {
        s.features.text.panel.fonts = Some(list);
        s.features.text.panel.fonts_rx = None;
    }
    if s.features.text.panel.fonts_rx.is_some() {
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
    s.features.text.panel.fonts.as_deref()
}

/// The panel.
pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    families(s, ui.ctx());
    egui::Frame::new().inner_margin(egui::Margin::symmetric(8, 4)).show(ui, |ui| {
        egui::ScrollArea::vertical().id_salt("cut-text-panel").show(ui, |ui| body(s, ui));
    });
    let ctx = ui.ctx().clone();
    if !ctx.input(|i| i.pointer.any_down()) && !egui::Popup::is_any_open(&ctx) {
        s.features.text.panel.gesture.end(&mut s.app);
    }
}

fn body(s: &mut Shell, ui: &mut egui::Ui) {
    let clip = super::text_clip(&s.app).cloned();
    ui.horizontal(|ui| {
        let title = clip.as_ref().map_or_else(
            || tr("Text").into_owned(),
            |c| if c.name.is_empty() { tr("Text").into_owned() } else { c.name.clone() },
        );
        ui.label(RichText::new(title).strong());
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let b = ui.add_enabled(s.app.sequence().is_some(), egui::Button::new(tr("New Text")));
            if b.on_hover_text(tr("Add a text clip at the playhead")).clicked() {
                add_new(s);
            }
        });
    });
    let Some(c) = clip else {
        s.features.text.panel.layer = None;
        ui.label(
            RichText::new(tr("Select a text clip, or click the program monitor with the Type tool (T)."))
                .color(s.palette.gray[8]),
        );
        return;
    };
    let list = layers(&c).to_vec();
    let keep = s
        .features
        .text
        .panel
        .layer
        .as_ref()
        .filter(|(id, l)| *id == c.id && list.iter().any(|x| layer_id(x) == Some(l)));
    let lid = match keep {
        Some((_, l)) => l.clone(),
        None => match list.first().and_then(layer_id) {
            Some(l) => l.to_owned(),
            None => return,
        },
    };
    s.features.text.panel.layer = Some((c.id, lid.clone()));
    if list.len() >= 2 {
        ui.add_space(4.0);
        for l in &list {
            let Some(id) = layer_id(l) else { continue };
            let first = l.get("text").and_then(Json::as_str).unwrap_or("").split('\n').next().unwrap_or("").to_owned();
            let shown = if first.is_empty() { tr("(empty)").into_owned() } else { first };
            if ui.selectable_label(id == lid, shown).clicked() {
                s.features.text.panel.layer = Some((c.id, id.to_owned()));
            }
        }
    }
    let Some(layer) = list.iter().find(|l| layer_id(l) == Some(lid.as_str())).cloned() else { return };
    text_field(s, ui, &c, &layer, &lid);
    font_section(s, ui, &c, &layer, &lid);
    appearance(s, ui, &c, &layer, &lid);
    styles(s, ui, &c, &layer, &lid);
    motion(s, ui, &c, &lid);
}

fn text_field(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, layer: &Json, lid: &str) {
    let now = layer.get("text").and_then(Json::as_str).unwrap_or("").to_owned();
    let id = egui::Id::unique(("cut-text-area", c.id.as_str(), lid));
    let focused = ui.memory(|m| m.has_focus(id));
    let p = &mut s.features.text.panel;
    if !focused {
        p.text = now.clone();
    }
    let r = ui.add(
        egui::TextEdit::multiline(&mut p.text)
            .id(id)
            .desired_rows(3)
            .desired_width(f32::INFINITY)
            .hint_text(tr("Type the text here")),
    );
    if r.gained_focus() {
        p.text_gesture.begin(&mut s.app, "Edit Text");
    }
    if r.changed() && s.features.text.panel.text != now {
        s.features.text.panel.text_gesture.begin(&mut s.app, "Edit Text");
        let text = s.features.text.panel.text.clone();
        if let Some(seq) = s.app.sequence_id {
            s.app.exec(&C::set_layer(seq.as_str(), c.id.as_str(), lid, json!({ "text": text })));
        }
    }
    if r.lost_focus() || (!r.has_focus() && s.features.text.panel.text_gesture.is_open()) {
        s.features.text.panel.text_gesture.end(&mut s.app);
    }
}

fn font_section(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, layer: &Json, lid: &str) {
    section(ui, s, "Font");
    let font = layer.get("font").and_then(Json::as_str).unwrap_or("").to_owned();
    let weight = layer.get("weight").and_then(Json::as_f64).unwrap_or(400.0);
    let italic = layer.get("italic").and_then(Json::as_bool).unwrap_or(false);
    let list = s.features.text.panel.fonts.clone().unwrap_or_default();
    let fam = list.iter().find(|f| f.family == font);
    ui.horizontal(|ui| {
        label(ui, "Family");
        let shown = fam.map_or_else(|| trf("{name} (not installed)", &[("name", &font)]), Family::label);
        let mut pick = None;
        egui::ComboBox::from_id_salt("cut-text-family")
            .icon(crate::theme::combo_icon)
            .selected_text(shown)
            .width(200.0)
            .show_ui(ui, |ui| {
                if fam.is_none() {
                    let _ = ui.selectable_label(true, trf("{name} (not installed)", &[("name", &font)]));
                }
                for f in &list {
                    if ui.selectable_label(f.family == font, f.label()).clicked() {
                        pick = Some(f.clone());
                    }
                }
            });
        if let Some(f) = pick {
            let mut patch = json!({ "font": f.family });
            if let Some((w, it)) = fonts::nearest(&f.styles, weight, italic) {
                patch["weight"] = json!(w);
                patch["italic"] = json!(it);
            }
            set_layer(s, c.id, lid, patch);
        }
    });
    ui.horizontal(|ui| {
        label(ui, "Style");
        let name = |w: u16, it: bool| format!("{w}{}", if it { format!(" {}", tr("Italic")) } else { String::new() });
        let mut styles: Vec<(u16, bool)> = fam.map(|f| f.styles.clone()).unwrap_or_default();
        let cur = (weight.round().clamp(1.0, 1000.0) as u16, italic);
        if !styles.contains(&cur) {
            styles.insert(0, cur);
        }
        let mut pick = None;
        egui::ComboBox::from_id_salt("cut-text-style")
            .icon(crate::theme::combo_icon)
            .selected_text(name(cur.0, cur.1))
            .show_ui(ui, |ui| {
                for (w, it) in styles {
                    if ui.selectable_label((w, it) == cur, name(w, it)).clicked() {
                        pick = Some((w, it));
                    }
                }
            });
        if let Some((w, it)) = pick {
            set_layer(s, c.id, lid, json!({ "weight": w, "italic": it }));
        }
    });
    let fields: [(&str, &str, f64, f64, f64, usize); 3] = [
        ("Size", "size", 1.0, 2000.0, 1.0, 0),
        ("Tracking", "tracking", -500.0, 2000.0, 1.0, 0),
        ("Leading", "leading", 0.5, 4.0, 0.01, 2),
    ];
    for (title, field, lo, hi, speed, dec) in fields {
        ui.horizontal(|ui| {
            label(ui, title);
            let v = value_of(s, c, layer, lid, field).as_f64().unwrap_or(0.0);
            if let Some(x) = number(ui, v, lo, hi, speed, dec, "") {
                set_field(s, c.id, lid, field, Value::Num(x));
            }
            if field == "size" {
                ui.label("px");
            }
        });
    }
    ui.horizontal(|ui| {
        label(ui, "Align");
        let now = layer.get("align").and_then(Json::as_str).unwrap_or("center");
        for (a, t) in [("left", "Left"), ("center", "Center"), ("right", "Right")] {
            if ui.selectable_label(now == a, tr(t)).clicked() && now != a {
                set_layer(s, c.id, lid, json!({ "align": a }));
            }
        }
    });
}

/// A number of an object field: its key, hint, lowest and highest value.
type Num = (&'static str, &'static str, f64, f64);

/// The object fields with a switch, a colour and numbers: field, title, the object a switch turns on, the numbers.
const PARTS: [(&str, &str, &str, &[Num]); 3] = [
    ("stroke", "Stroke", r##"{"color":"#000000","width":4}"##, &[("width", "", 0.0, 100.0)]),
    (
        "shadow",
        "Shadow",
        r##"{"color":"#000000b3","blur":8,"x":3,"y":3}"##,
        &[("blur", "Blur", 0.0, 200.0), ("x", "X", -500.0, 500.0), ("y", "Y", -500.0, 500.0)],
    ),
    (
        "box",
        "Background",
        r##"{"color":"#000000aa","padding":16,"radius":8}"##,
        &[("padding", "Padding", 0.0, 500.0), ("radius", "Corner Radius", 0.0, 500.0)],
    ),
];

fn appearance(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, layer: &Json, lid: &str) {
    section(ui, s, "Appearance");
    ui.horizontal(|ui| {
        label(ui, "Fill");
        let mut rgb = rgb_of(&value_of(s, c, layer, lid, "fill"));
        if ui.color_edit_button_srgb(&mut rgb).changed() {
            set_field(s, c.id, lid, "fill", Value::Text(hex(rgb)));
        }
    });
    for (field, title, on_value, nums) in PARTS {
        let fallback: Json = serde_json::from_str(on_value).unwrap_or(Json::Null);
        ui.horizontal(|ui| {
            let obj = layer.get(field).filter(|x| x.is_object()).cloned();
            // a part of the object (`sub`): the whole object with that key changed
            let sub = |s: &mut Shell, key: &str, v: Json| {
                let mut o = obj.clone().unwrap_or_else(|| fallback.clone());
                o[key] = v;
                set_layer(s, c.id, lid, json!({ field: o }));
            };
            let mut on = obj.is_some();
            if ui.add_sized([86.0, 18.0], egui::Checkbox::new(&mut on, tr(title))).changed() {
                set_layer(s, c.id, lid, json!({ field: if on { fallback.clone() } else { Json::Null } }));
            }
            let mut rgb = rgb_of(obj.as_ref().map_or(&Json::Null, |o| &o["color"]));
            if ui.color_edit_button_srgb(&mut rgb).changed() {
                sub(s, "color", json!(hex(rgb)));
            }
            for &(key, hint, lo, hi) in nums {
                let v = obj.as_ref().and_then(|o| o[key].as_f64()).unwrap_or(0.0);
                if let Some(x) = number(ui, v, lo, hi, 1.0, 0, &tr(hint)) {
                    sub(s, key, json!(x));
                }
            }
        });
    }
    ui.horizontal(|ui| {
        label(ui, "Position");
        let p = value_of(s, c, layer, lid, "position");
        let (x, y) = (p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0));
        if let Some(nx) = number(ui, x, -100_000.0, 100_000.0, 1.0, 1, "") {
            set_field(s, c.id, lid, "position", Value::List(vec![nx, y]));
        }
        if let Some(ny) = number(ui, y, -100_000.0, 100_000.0, 1.0, 1, "") {
            set_field(s, c.id, lid, "position", Value::List(vec![x, ny]));
        }
    });
}

fn styles(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, layer: &Json, lid: &str) {
    section(ui, s, "Text Styles");
    let list: Vec<Json> =
        s.app.project().settings.get("textStyles").and_then(Json::as_array).cloned().unwrap_or_default();
    let id_of = |x: &Json| x["id"].as_str().unwrap_or("").to_owned();
    let p = &mut s.features.text.panel;
    if !p.style.as_ref().is_some_and(|k| list.iter().any(|x| id_of(x) == *k)) {
        p.style = list.first().map(id_of);
    }
    let chosen = p.style.clone();
    ui.horizontal(|ui| {
        label(ui, "Style");
        let shown =
            list.iter().find(|x| Some(id_of(x)) == chosen).and_then(|x| x["name"].as_str()).unwrap_or("").to_owned();
        let mut pick = None;
        egui::ComboBox::from_id_salt("cut-text-styles")
            .icon(crate::theme::combo_icon)
            .selected_text(shown)
            .width(120.0)
            .show_ui(ui, |ui| {
                for x in &list {
                    if ui.selectable_label(Some(id_of(x)) == chosen, x["name"].as_str().unwrap_or("")).clicked() {
                        pick = Some(id_of(x));
                    }
                }
            });
        if pick.is_some() {
            s.features.text.panel.style = pick;
        }
        let some = !list.is_empty();
        if ui.add_enabled(some, egui::Button::new(tr("Apply"))).clicked()
            && let Some(st) = list.iter().find(|x| Some(id_of(x)) == chosen)
        {
            set_layer(s, c.id, lid, st["style"].clone());
        }
        if ui.button(tr("Save…")).clicked() {
            s.features.text.panel.naming = Some(trf("Style {n}", &[("n", &(list.len() + 1).to_string())]));
        }
        if ui.add_enabled(some, egui::Button::new(tr("Delete"))).clicked() {
            let rest: Vec<Json> = list.iter().filter(|x| Some(id_of(x)) != chosen).cloned().collect();
            exec(s, &C::set_settings(json!({ "textStyles": rest })));
        }
    });
    let Some(mut name) = s.features.text.panel.naming.clone() else { return };
    let mut done = None;
    ui.horizontal(|ui| {
        label(ui, "Style name");
        let r = ui.text_edit_singleline(&mut name);
        if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
            done = Some(true);
        }
        if ui.button(tr("Save")).clicked() {
            done = Some(true);
        }
        if ui.button(tr("Cancel")).clicked() {
            done = Some(false);
        }
    });
    s.features.text.panel.naming = Some(name.clone());
    match done {
        Some(true) if !name.trim().is_empty() => {
            s.features.text.panel.naming = None;
            let mut n = list.len() + 1;
            while list.iter().any(|x| id_of(x) == format!("ts{n}")) {
                n += 1;
            }
            let style: Map<String, Json> =
                STYLE_FIELDS.iter().map(|k| ((*k).to_owned(), layer.get(*k).cloned().unwrap_or(Json::Null))).collect();
            let mut next = list.clone();
            next.push(json!({ "id": format!("ts{n}"), "name": name.trim(), "style": style }));
            exec(s, &C::set_settings(json!({ "textStyles": next })));
            s.features.text.panel.style = Some(format!("ts{n}"));
        }
        Some(_) => s.features.text.panel.naming = None,
        None => {}
    }
}

fn motion(s: &mut Shell, ui: &mut egui::Ui, c: &Clip, lid: &str) {
    section(ui, s, "Motion Presets");
    for (title, out) in [("In", false), ("Out", true)] {
        ui.horizontal(|ui| {
            label(ui, title);
            for (id, name) in presets::PRESETS {
                if ui.button(tr(name)).clicked() {
                    apply_preset(s, c, lid, id, out);
                }
            }
        });
    }
}

/// A motion preset as one undo step of keyframe lists (`applyPreset`).
fn apply_preset(s: &mut Shell, c: &Clip, lid: &str, id: &str, out: bool) {
    let Some(seq) = s.app.sequence() else { return };
    let frame = edit::frame(seq);
    let seq_id = seq.id;
    let Some(lists) = presets::apply(c, lid, id, out, frame) else { return };
    let cmds = lists.iter().map(|(prop, list)| edit::keys_cmd(seq_id, c.id, prop, list)).collect();
    s.app.exec(&C::batch("Motion Preset", cmds));
}

/// New Text (`addNew`): a "Title" text clip at the playhead, selected, its text field given the keyboard.
fn add_new(s: &mut Shell) {
    s.app.history.begin("Add Graphic");
    let t = s.app.t;
    match super::add_text(&mut s.app, t, &tr("Title"), [0.0, 0.0]) {
        Some(id) => {
            s.app.history.commit();
            s.app.select([id], false, false);
        }
        None => s.app.history.cancel(),
    }
}
