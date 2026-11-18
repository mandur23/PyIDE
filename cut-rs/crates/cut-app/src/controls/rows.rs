//! One row of Effect Controls (`paramRow`): the stopwatch (or its space), the label, the control of the row's kind,
//! the keyframe buttons when the property is animated, and its lane. The control writes through [`keys::write`]; a
//! scrub or a slider drag is one undo step ([`Gesture`](crate::fx::edit::Gesture)).

use cut_model::Id;
use cut_model::keyframes::Value;
use cut_time::Ticks;
use eframe::egui::{self, Align, Layout, Rect, RichText, Sense, UiBuilder, Vec2};
use serde_json::Value as Json;

use super::icons::{self, Icon};
use super::keys;
use super::spec::{Ctl, Spec};
use crate::fx::edit;
use crate::fx::widgets::{self, Change, Num};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The share of a row's width the controls take; the lane has the rest (`grid-template-columns: 62% 38%`).
pub const LEFT: f32 = 0.62;
/// A row's height, and the extra line of a row with a slider.
pub const ROW_H: f32 = 24.0;
pub const SLIDER_H: f32 = 16.0;

/// A row's rectangle split into its controls and its lane.
pub fn split(rect: Rect) -> (Rect, Rect) {
    let x = rect.left() + (rect.width() * LEFT).round();
    (Rect::from_x_y_ranges(rect.left()..=x, rect.y_range()), Rect::from_x_y_ranges(x..=rect.right(), rect.y_range()))
}

/// Allocates a row of `h` across the panel, draws its border and lane background -> (controls, lane).
pub fn allocate(s: &Shell, ui: &mut egui::Ui, h: f32) -> (Rect, Rect) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), h), Sense::hover());
    let pal = &s.palette;
    let (left, lane) = split(rect);
    let p = ui.painter();
    p.hline(rect.x_range(), rect.top(), egui::Stroke::new(1.0, pal.gray[3].gamma_multiply(0.55)));
    p.rect_filled(lane, 0.0, pal.gray[1].gamma_multiply(0.7));
    p.vline(lane.left(), lane.y_range(), egui::Stroke::new(1.0, pal.gray[3]));
    (left, lane)
}

/// A child ui inside `rect`, laid out left to right, drawing nothing outside it (a control too wide for a narrow
/// panel is cut at the lane).
pub fn child(ui: &mut egui::Ui, rect: Rect) -> egui::Ui {
    let mut c = ui.new_child(UiBuilder::new().max_rect(rect).layout(Layout::left_to_right(Align::Center)));
    c.set_clip_rect(rect.intersect(ui.clip_rect()));
    c
}

fn as_num(v: &Option<Value>) -> f64 {
    match v {
        Some(Value::Num(x)) => *x,
        _ => 0.0,
    }
}

fn list_at(v: &Option<Value>, i: usize) -> f64 {
    match v {
        Some(Value::List(l)) => l.get(i).copied().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// A row's label: left-aligned in its column (`indent` points in), cut short with an ellipsis.
pub fn label(ui: &mut egui::Ui, text: &str, color: egui::Color32, indent: f32) -> egui::Response {
    let w = 92.0;
    let inner = ui.allocate_ui_with_layout(Vec2::new(w, 18.0), Layout::left_to_right(Align::Center), |ui| {
        ui.set_min_width(w);
        ui.add_space(indent);
        ui.add(egui::Label::new(RichText::new(text).color(color)).truncate())
    });
    inner.inner
}

/// What a row's control asked for this frame.
enum Wrote {
    Value(Value),
    Change(Change, Box<dyn Fn(f64) -> Value>),
}

/// Draws the row of `spec` for `clip`.
pub fn row(s: &mut Shell, ui: &mut egui::Ui, clip: Id, spec: &Spec) {
    let h = ROW_H + if spec.slider.is_some() { SLIDER_H } else { 0.0 };
    let (left, lane) = allocate(s, ui, h);
    let Some(seq) = s.app.sequence() else { return };
    let Some(c) = seq.clip(clip) else { return };
    let t = s.app.t;
    let v = keys::value(seq, c, spec, t);
    let keyed = edit::keyframed(c, &spec.path);
    let here =
        keyed && edit::in_clip(c, t) && c.keyframes[&spec.path].iter().any(|k| k.t == edit::clip_time(seq, c, t));
    let fps = seq.fps;
    let luts = s.app.project().luts.clone();
    let accent = s.palette.accent;
    let key = spec.key();
    let mut wrote: Vec<Wrote> = Vec::new();
    let mut action: Option<(i32, Icon)> = None;
    let top = Rect::from_min_max(left.min + Vec2::new(4.0, 0.0), egui::pos2(left.right() - 4.0, left.top() + ROW_H));
    let mut cu = child(ui, top);
    cu.spacing_mut().item_spacing.x = 4.0;
    let watch = spec.watch();
    if watch {
        let r = icons::button(&mut cu, Icon::Watch, &tr("Toggle Animation"), keyed, accent);
        s.features.controls.note(format!("{key}/watch"), r.rect);
        if r.clicked() {
            action = Some((0, Icon::Watch));
        }
    } else {
        cu.add_space(20.0);
    }
    // a mask's rows sit under its header (`.cut-ec-maskrow .cut-ec-label { padding-left: 12px }`)
    let indent = if spec.path.contains("masks.") { 12.0 } else { 0.0 };
    let name = Some(label(&mut cu, &tr(spec.label), s.palette.gray[10], indent).id);
    let n = {
        let mut n = Num::new(spec.min, spec.max, spec.step, spec.unit);
        if let Some(p) = spec.precision {
            n.decimals = p;
        }
        n
    };
    match &spec.ctl {
        Ctl::Point => {
            for i in 0..2 {
                let (ch, _) = widgets::number_named(&mut cu, list_at(&v, i), Num { unit: "", ..n }, name);
                let other = list_at(&v, 1 - i);
                wrote.push(Wrote::Change(
                    ch,
                    Box::new(move |x| Value::List(if i == 0 { vec![x, other] } else { vec![other, x] })),
                ));
            }
        }
        Ctl::Uniform | Ctl::Number => {
            let x = match (&spec.ctl, spec.index) {
                (Ctl::Uniform, _) => list_at(&v, 0),
                (_, Some(i)) => list_at(&v, i),
                _ => as_num(&v),
            };
            let (ch, r) = widgets::number_named(&mut cu, x, n, name);
            s.features.controls.note(format!("{key}/value"), r.rect);
            wrote.push(Wrote::Change(ch, Box::new(Value::Num)));
            if let Some([lo, hi]) = spec.slider {
                let sr = Rect::from_min_max(
                    egui::pos2(left.left() + 26.0, left.top() + ROW_H - 2.0),
                    egui::pos2(left.right() - 8.0, left.bottom() - 2.0),
                );
                let mut su = child(ui, sr);
                let ch = widgets::slider_named(&mut su, x, [lo, hi], spec.step.unwrap_or(1.0), sr.width() - 4.0, name);
                s.features.controls.note(format!("{key}/slider"), sr);
                wrote.push(Wrote::Change(ch, Box::new(Value::Num)));
            }
        }
        Ctl::Color => {
            let text = match &v {
                Some(Value::Text(t)) => t.clone(),
                _ => "#ffffff".into(),
            };
            let mut rgb = widgets::parse_hex(&text).unwrap_or([255, 255, 255]);
            let r = egui::color_picker::color_edit_button_srgb(&mut cu, &mut rgb);
            let r = match name {
                Some(id) => r.labelled_by(id),
                None => r,
            };
            s.features.controls.note(format!("{key}/value"), r.rect);
            if r.changed() {
                wrote.push(Wrote::Value(Value::Text(widgets::hex(rgb))));
            }
        }
        Ctl::Bool => {
            let mut on = matches!(v, Some(Value::Flag(true)));
            let r = cu.checkbox(&mut on, "");
            let r = match name {
                Some(id) => r.labelled_by(id),
                None => r,
            };
            s.features.controls.note(format!("{key}/value"), r.rect);
            if r.changed() {
                wrote.push(Wrote::Value(Value::Flag(on)));
            }
        }
        Ctl::Choice(choices) => {
            let now = match &v {
                Some(Value::Text(t)) => t.clone(),
                _ => String::new(),
            };
            let shown = choices.iter().find(|(id, _)| *id == now).map_or(now.clone(), |(_, l)| tr(l).into_owned());
            let r = egui::ComboBox::from_id_salt(("ec-choice", clip, &key))
                .icon(crate::theme::combo_icon)
                .selected_text(shown)
                .width(110.0)
                .show_ui(&mut cu, |ui| {
                    for (id, l) in choices {
                        if ui.selectable_label(*id == now, tr(l)).clicked() {
                            wrote.push(Wrote::Value(Value::Text((*id).to_owned())));
                        }
                    }
                });
            if let Some(id) = name {
                let _ = r.response.clone().labelled_by(id);
            }
            s.features.controls.note(format!("{key}/value"), r.response.rect);
        }
        Ctl::Duration => {
            let ticks = as_num(&v) as Ticks;
            let (t, r) = timecode_field(&mut cu, egui::Id::unique(("ec-tc", clip, &key)), ticks, fps, name);
            s.features.controls.note(format!("{key}/value"), r);
            if let Some(t) = t {
                wrote.push(Wrote::Value(Value::Num(t as f64)));
            }
        }
        Ctl::MaskPath | Ctl::Curve => {
            let per = if spec.ctl == Ctl::MaskPath { 6 } else { 2 };
            let n = match &v {
                Some(Value::List(l)) => l.len() / per,
                _ if spec.ctl == Ctl::Curve => 2,
                _ => 0,
            };
            cu.label(RichText::new(trf("{n} points", &[("n", &n.to_string())])).color(s.palette.gray[8]));
        }
        Ctl::Lut => {
            let name = match &v {
                Some(Value::Text(id)) if !id.is_empty() => luts
                    .as_ref()
                    .and_then(|l| l.get(id.as_str()))
                    .and_then(|l| l.get("name"))
                    .and_then(Json::as_str)
                    .map_or_else(|| tr("Missing LUT").into_owned(), str::to_owned),
                _ => tr("None").into_owned(),
            };
            cu.label(RichText::new(name).color(s.palette.gray[8]));
        }
    }
    if watch && keyed {
        cu.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            for (dir, icon, tip) in [
                (1, Icon::Next, "Go to Next Keyframe"),
                (2, if here { Icon::KeyOn } else { Icon::Key }, "Add/Remove Keyframe"),
                (-1, Icon::Prev, "Go to Previous Keyframe"),
            ] {
                let r = icons::button(ui, icon, &tr(tip), dir == 2 && here, accent);
                let name = match dir {
                    1 => "next",
                    2 => "add",
                    _ => "prev",
                };
                s.features.controls.note(format!("{key}/{name}"), r.rect);
                if r.clicked() {
                    action = Some((dir, icon));
                }
            }
        });
    }
    let label = if spec.ctl == Ctl::Duration || spec.field.is_some() { "Clip Settings" } else { "Effect Settings" };
    for w in wrote {
        match w {
            Wrote::Value(x) => keys::write(&mut s.app, clip, spec, x),
            Wrote::Change(ch, to) => {
                if ch.started {
                    s.features.controls.gesture.begin(&mut s.app, label);
                }
                if let Some(x) = ch.value {
                    keys::write(&mut s.app, clip, spec, to(x));
                }
                if ch.stopped {
                    s.features.controls.gesture.end(&mut s.app);
                }
            }
        }
    }
    match action {
        Some((0, _)) => keys::set_keyframing(&mut s.app, clip, &spec.path, !keyed),
        Some((2, _)) => keys::toggle_keyframe(&mut s.app, clip, &spec.path),
        Some((dir, _)) => {
            keys::jump(&mut s.app, clip, &spec.path, dir);
        }
        None => {}
    }
    if watch {
        super::interact::lane(s, ui, clip, &spec.path, lane);
    }
}

/// A timecode that is typed into (Enter or leaving the field sets it) -> the new ticks, and where the field is.
pub fn timecode_field(
    ui: &mut egui::Ui,
    id: egui::Id,
    ticks: Ticks,
    fps: cut_time::Fps,
    name: Option<egui::Id>,
) -> (Option<Ticks>, Rect) {
    let mut text = ui.data(|d| d.get_temp::<String>(id)).unwrap_or_else(|| cut_time::timecode(ticks, fps));
    let r = ui.add(egui::TextEdit::singleline(&mut text).id(id).desired_width(84.0).font(egui::TextStyle::Monospace));
    let r = match name {
        Some(n) => r.labelled_by(n),
        None => r,
    };
    if r.has_focus() {
        ui.data_mut(|d| d.insert_temp(id, text.clone()));
        return (None, r.rect);
    }
    ui.data_mut(|d| d.remove::<String>(id));
    let typed = r.lost_focus().then(|| cut_time::parse_timecode(&text, fps, ticks)).flatten();
    (typed.filter(|t| *t != ticks), r.rect)
}
