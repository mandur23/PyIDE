//! The Type tool and the in-place text editor on the Program monitor (`ui-overlay.js` `editText` and its pointer
//! handlers).
//!
//! The editor is an egui multiline text field over the layer: its glyphs are transparent and only the caret and the
//! selection show, so what the person sees is the engine's own rendering of the layer, redrawn after every change.
//! egui's text field takes the Windows IME's events (`Event::Ime`: the composing syllable as `Preedit`, the finished
//! text as `Commit`) while it has the keyboard, and places the IME's candidate window at its caret through
//! `PlatformOutput::ime`; each change of its text, a composing syllable included, is a `setLayer` command inside the
//! visit's undo group, which closes with the editor (Escape, Ctrl+Enter, a click elsewhere). A text clip made by the
//! Type tool and left empty is taken back whole.
//!
//! The field's font is Malgun Gothic (the layers' default and the engine's fallback) at the layer's size on screen, so
//! the caret sits on the rendered glyphs for that font and drifts a little for others; a rotated clip's text is edited
//! unrotated.

use cut_model::commands::build as C;
use cut_model::{Id, keyframes::Value};
use eframe::egui::{self, Align, Color32, CursorIcon, FontFamily, FontId, Key, Modifiers, Rect};
use serde_json::{Value as Json, json};

use super::{layer_id, layers};
use crate::fx::edit;
use crate::fx::overlay::geom::{self, Frame, P};
use crate::shell::Shell;
use crate::state::{Panel, Tool};

/// The text being edited in place.
pub struct Editor {
    pub clip: Id,
    pub layer: String,
    /// The Type tool made the clip for this visit (an empty one goes again).
    pub created: bool,
    /// The field's text.
    pub text: String,
    /// The frame it was last drawn in.
    pub drawn: u64,
    focus_asked: bool,
}

const FONT: &str = "cut-text";
const FONT_BOLD: &str = "cut-text-bold";

/// Malgun Gothic as egui families of their own, once (the Korean font is otherwise a fallback after egui's own).
fn fonts(ctx: &egui::Context) -> (FontFamily, FontFamily) {
    let have = ctx.fonts(|f| f.families());
    let (regular, bold) = (FontFamily::Name(FONT.into()), FontFamily::Name(FONT_BOLD.into()));
    if !have.contains(&regular) {
        for (name, file) in [(FONT, "C:/Windows/Fonts/malgun.ttf"), (FONT_BOLD, "C:/Windows/Fonts/malgunbd.ttf")] {
            if let Ok(bytes) = std::fs::read(file) {
                ctx.add_font(egui::epaint::text::FontInsert::new(
                    name,
                    egui::FontData::from_owned(bytes),
                    vec![egui::epaint::text::InsertFontFamily {
                        family: FontFamily::Name(name.into()),
                        priority: egui::epaint::text::FontPriority::Highest,
                    }],
                ));
            }
        }
        return (FontFamily::Proportional, FontFamily::Proportional);
    }
    let bold = if have.contains(&bold) { bold } else { regular.clone() };
    (regular, bold)
}

/// Starts editing layer `layer` (the first by default) of the text clip `clip` (`editText`) -> whether it opened.
/// `created`: the Type tool's "Add Graphic" group is open and becomes this visit's step.
pub fn open(s: &mut Shell, clip: Id, created: bool, layer: Option<String>) -> bool {
    if s.features.text.editor.is_some() {
        close(s);
    }
    let found = s.app.sequence().and_then(|q| q.clip(clip)).cloned();
    let Some(c) = found.filter(super::text_clip_kind) else {
        if created {
            s.app.history.cancel();
        }
        return false;
    };
    if !edit::in_clip(&c, s.app.t) {
        s.app.set_time(c.start);
    }
    if !s.app.selection.contains(&clip) {
        s.app.select([clip], false, false);
    }
    let Some(lid) = layer.or_else(|| layers(&c).first().and_then(layer_id).map(str::to_owned)) else {
        if created {
            s.app.history.cancel();
        }
        return false;
    };
    let text = layers(&c)
        .iter()
        .find(|l| layer_id(l) == Some(lid.as_str()))
        .and_then(|l| l.get("text"))
        .and_then(Json::as_str)
        .unwrap_or("")
        .to_owned();
    if !created {
        s.app.history.begin("Edit Text");
    }
    s.focus(Panel::Program);
    s.features.text.editor = Some(Editor { clip, layer: lid, created, text, drawn: u64::MAX / 2, focus_asked: false });
    true
}

/// Ends the visit (`close`): one undo step, or nothing when the Type tool's clip was left empty.
pub fn close(s: &mut Shell) {
    let Some(e) = s.features.text.editor.take() else { return };
    if e.created && e.text.trim().is_empty() {
        s.app.history.cancel();
        s.app.prune_selection();
    } else {
        s.app.history.commit();
    }
    if e.created && s.app.tool == Tool::Text {
        s.app.tool = Tool::Select;
    }
}

/// Whether a point is inside a polygon (`inside`).
fn inside(pt: P, poly: &[P]) -> bool {
    let mut inn = false;
    let mut j = poly.len().wrapping_sub(1);
    for i in 0..poly.len() {
        let ([xi, yi], [xj, yj]) = (poly[i], poly[j]);
        if (yi > pt[1]) != (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi {
            inn = !inn;
        }
        j = i;
    }
    inn
}

/// The shown clip when it is a text clip and `pt` is inside its frame.
fn text_under(s: &Shell, fr: &Frame, pt: P) -> Option<Id> {
    let c = crate::fx::overlay::shown_clip(&s.app).filter(|c| super::text_clip_kind(c))?;
    let seq = s.app.sequence()?;
    let p = geom::placement(s.app.project(), seq, c, s.app.t);
    let [x, y, w, h] = p.content;
    let corners: Vec<P> =
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].iter().map(|q| fr.to_screen(geom::to_seq(&p, *q))).collect();
    inside(pt, &corners).then_some(c.id)
}

/// The Program monitor's text part each frame, after the picture is drawn at `picture`: the Type tool's clicks, a
/// double click on a text clip, and the editor.
pub fn program(s: &mut Shell, ui: &mut egui::Ui, picture: Rect) {
    let Some(seq) = s.app.sequence() else { return };
    let fr = Frame::new(picture, seq.w as f64);
    let (seq_w, seq_h) = (seq.w as f64, seq.h as f64);
    if s.features.text.editor.is_some() {
        field(s, ui, &fr);
        return;
    }
    let (pressed, double, pos) = ui.input(|i| {
        (
            i.pointer.primary_pressed(),
            i.pointer.button_double_clicked(egui::PointerButton::Primary),
            i.pointer.interact_pos(),
        )
    });
    let Some(pos) = pos.filter(|p| picture.contains(*p) && ui.clip_rect().contains(*p)) else { return };
    let pt = [f64::from(pos.x), f64::from(pos.y)];
    if s.app.tool == Tool::Text {
        ui.ctx().set_cursor_icon(CursorIcon::Text);
        if !pressed {
            return;
        }
        s.focus(Panel::Program);
        if let Some(id) = text_under(s, &fr, pt) {
            open(s, id, false, None);
            return;
        }
        let at = fr.to_sequence(pt);
        let position = [(at[0] - seq_w / 2.0).round(), (at[1] - seq_h / 2.0).round()];
        s.app.history.begin("Add Graphic");
        let t = s.app.t;
        match super::add_text(&mut s.app, t, "", position) {
            Some(id) => {
                s.app.select([id], false, false);
                open(s, id, true, None);
            }
            None => s.app.history.cancel(),
        }
    } else if double && let Some(id) = text_under(s, &fr, pt) {
        open(s, id, false, None);
    }
}

/// The field over the layer.
fn field(s: &mut Shell, ui: &mut egui::Ui, fr: &Frame) {
    let ctx = ui.ctx().clone();
    let Some(e) = &s.features.text.editor else { return };
    let (clip_id, lid) = (e.clip, e.layer.clone());
    let found = s.app.sequence().and_then(|q| Some((q.clone(), q.clip(clip_id)?.clone())));
    let Some((seq, c)) = found else {
        close(s);
        return;
    };
    let Some(raw) = layers(&c).iter().find(|l| layer_id(l) == Some(lid.as_str())).cloned() else {
        close(s);
        return;
    };
    let local = edit::clip_time(&seq, &c, s.app.t) as f64;
    let l = cut_engine::text::resolve_layer(&raw, &c, local);
    let p = geom::placement(s.app.project(), &seq, &c, s.app.t);
    let n = |k: &str, d: f64| l.get(k).and_then(Json::as_f64).filter(|v| v.is_finite()).unwrap_or(d);
    let k = fr.k * p.scale[0] / 100.0;
    let size = n("size", 96.0).max(1.0);
    let leading = l.get("leading").and_then(Json::as_f64).filter(|v| *v != 0.0).unwrap_or(1.2);
    let pos = match edit::value_at(&seq, &c, &format!("layers.{lid}.position"), s.app.t) {
        Some(Value::List(v)) if v.len() >= 2 => [v[0], v[1]],
        _ => [0.0, 0.0],
    };
    let center = fr.to_screen(geom::to_seq(&p, pos));
    let (regular, bold) = fonts(&ctx);
    let family = if n("weight", 400.0) >= 600.0 { bold } else { regular };
    let font = FontId::new(((size * k) as f32).max(1.0), family);
    let align = match l.get("align").and_then(Json::as_str) {
        Some("left") => Align::Min,
        Some("right") => Align::Max,
        _ => Align::Center,
    };
    let Some(e) = s.features.text.editor.as_mut() else { return };
    let lines = e.text.split('\n').count().max(1) as f32;
    let measured = ctx.fonts_mut(|f| {
        e.text
            .split('\n')
            .map(|t| f.layout_no_wrap(t.to_owned(), font.clone(), Color32::WHITE).size().x)
            .fold(0.0, f32::max)
    });
    let w = measured.max((size * 0.6 * k) as f32) + 8.0;
    let h = lines * ((size * leading * fr.k * p.scale[1] / 100.0) as f32).max(font.size) + 4.0;
    let top_left = egui::pos2(center[0] as f32 - w / 2.0, center[1] as f32 - h / 2.0);
    let done =
        ui.input_mut(|i| i.consume_key(Modifiers::CTRL, Key::Enter) || i.consume_key(Modifiers::NONE, Key::Escape));
    let before = e.text.clone();
    e.drawn = ctx.cumulative_frame_nr();
    let ask = !e.focus_asked;
    e.focus_asked = true;
    // a child of its own over the picture: the monitor's layout below it does not move
    let mut over = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_size(top_left, egui::vec2(w, h))));
    let r = over.add(
        egui::TextEdit::multiline(&mut e.text)
            .font(font.clone())
            .text_color(Color32::TRANSPARENT)
            .frame(egui::Frame::NONE)
            .margin(egui::Margin::ZERO)
            .desired_width(w)
            .desired_rows(lines as usize)
            .align(egui::Align2([align, Align::Center]))
            .cursor_at_end(true)
            .id_salt("cut-text-field"),
    );
    ui.painter().rect_stroke(
        r.rect.expand(2.0),
        2.0,
        egui::Stroke::new(1.0, s.palette.blue6),
        egui::StrokeKind::Outside,
    );
    if ask {
        r.request_focus();
    }
    let text = s.features.text.editor.as_ref().map(|e| e.text.clone()).unwrap_or_default();
    if text != before {
        s.app.exec(&C::set_layer(seq.id.as_str(), clip_id.as_str(), &lid, json!({ "text": text })));
    }
    if done || r.lost_focus() {
        close(s);
    }
}
