//! The Lumetri Color panel (port of `ui-color.js`), laid out as Premiere's: collapsible sections that all edit one
//! effect of the selected video clip, its Lumetri Color (`color.basic`, added at the end of the effect list in the
//! same undo step as the first control that moves), plus the vignette (the `vignette` effect).
//! - Basic Correction: white balance with its eyedropper ([`pick::white_balance`]), tone, saturation and vibrance.
//! - Creative: the Look, a .cube LUT loaded through the file dialog and kept in the project ([`look`]), its intensity.
//! - Curves: the RGB curves, master and one per channel, on a square ([`curves`]).
//! - HSL Secondary: the qualifier (an eyedropper sets it around a picked colour), Show Mask, the correction inside.
//! - Vignette.
//!
//! A slider or curve drag is one undo step; the values shown are those at the playhead when a parameter has
//! keyframes. The parameters' ranges and defaults are the registry's (`cut_model::effects`); the rows' labels and
//! order are the JavaScript panel's.

mod curves;
mod look;
pub mod pick;

use std::collections::HashSet;

use cut_model::commands::build as C;
use cut_model::effects;
use cut_model::keyframes::Value;
use cut_model::{Clip, Id, Project};
use eframe::egui::{self, Align, Layout, RichText, Sense};
use serde_json::{Map, Value as Json, json};

use super::edit::{self, Gesture};
use super::widgets::{self, Num, glyph};
use super::{Pick, PickKind};
use crate::i18n::tr;
use crate::shell::Shell;
use crate::state::App;
use crate::theme::Palette;

/// The effect the panel edits.
pub const LUMETRI: &str = "color.basic";
/// The vignette's own effect.
pub const VIGNETTE: &str = "vignette";

/// The settings key of the folded sections (`cut.color.collapsed`).
const COLLAPSED: &str = "color.collapsed";

/// The Lumetri panel's eyedroppers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dropper {
    /// Basic Correction's white balance selector: the picked colour becomes neutral.
    WhiteBalance,
    /// HSL Secondary's: the qualifier is set around the picked colour.
    HslKey,
}

/// The sections in Premiere's order: id, name.
const SECTIONS: [(&str, &str); 5] = [
    ("basic", "Basic Correction"),
    ("creative", "Creative"),
    ("curves", "Curves"),
    ("hsl", "HSL Secondary"),
    ("vignette", "Vignette"),
];

/// A group of rows: its name ('' for none) and each row's parameter and label.
type Group = (&'static str, &'static [(&'static str, &'static str)]);

const BASIC: [Group; 3] = [
    ("White Balance", &[("temperature", "Temperature"), ("tint", "Tint")]),
    (
        "Tone",
        &[
            ("exposure", "Exposure"),
            ("contrast", "Contrast"),
            ("highlights", "Highlights"),
            ("shadows", "Shadows"),
            ("whites", "Whites"),
            ("blacks", "Blacks"),
        ],
    ),
    ("", &[("saturation", "Saturation"), ("vibrance", "Vibrance")]),
];
const HSL_KEY: Group =
    ("Key", &[("hslHue", "Hue Center"), ("hslHueRange", "Hue Range"), ("hslHueSoft", "Hue Softness")]);
const HSL_RANGE: Group = (
    "",
    &[
        ("hslSatLow", "Saturation Low"),
        ("hslSatHigh", "Saturation High"),
        ("hslSatSoft", "Saturation Softness"),
        ("hslLumLow", "Luma Low"),
        ("hslLumHigh", "Luma High"),
        ("hslLumSoft", "Luma Softness"),
    ],
);
const HSL_FIX: Group = (
    "Correction",
    &[
        ("hslTemperature", "Temperature"),
        ("hslTint", "Tint"),
        ("hslContrast", "Contrast"),
        ("hslSaturation", "Saturation"),
        ("hslHueShift", "Hue Shift"),
    ],
);
const INTENSITY: Group = ("", &[("lutIntensity", "Intensity")]);
const VIGNETTE_ROWS: Group =
    ("", &[("amount", "Amount"), ("midpoint", "Midpoint"), ("roundness", "Roundness"), ("feather", "Feather")]);
/// The HSL Secondary's parameters (`lumetri.HSL_PARAMS`), reset by its section's Reset.
const HSL_PARAMS: [&str; 15] = [
    "hslHue",
    "hslHueRange",
    "hslHueSoft",
    "hslSatLow",
    "hslSatHigh",
    "hslSatSoft",
    "hslLumLow",
    "hslLumHigh",
    "hslLumSoft",
    "hslMask",
    "hslTemperature",
    "hslTint",
    "hslContrast",
    "hslSaturation",
    "hslHueShift",
];

/// The panel's state between frames.
#[derive(Debug, Default)]
pub struct State {
    /// The folded sections (the setting, read at the first frame).
    pub collapsed: Option<HashSet<String>>,
    /// The clip edited last frame (a new clip hides the last LUT refusal).
    clip: Option<Id>,
    /// A slider's or number field's drag.
    gesture: Gesture,
    pub curves: curves::Curves,
    pub look: look::Look,
}

/// The selected clip the panel edits: a video clip, else none.
fn target(app: &App) -> Option<Id> {
    let seq = app.sequence()?;
    edit::primary_clip(app).filter(|c| edit::kind_of(seq, c) == cut_model::TrackKind::Video).map(|c| c.id)
}

fn clip_of(app: &App, clip: Id) -> Option<&Clip> {
    app.sequence()?.clip(clip)
}

/// The clip's first effect of `kind`.
fn effect_id(app: &App, clip: Id, kind: &str) -> Option<Id> {
    clip_of(app, clip)?.effects.iter().find(|e| e.kind == kind).map(|e| e.id)
}

/// Every parameter of the clip's effect of `kind` at the playhead (`paramsOf`): the registry's defaults when the
/// clip has no such effect.
fn params_at(app: &App, clip: Id, kind: &str) -> Map<String, Json> {
    let mut out = effects::defaults(kind);
    let (Some(seq), Some(e)) = (app.sequence(), effect_id(app, clip, kind)) else { return out };
    let Some(c) = seq.clip(clip) else { return out };
    for (k, v) in out.iter_mut() {
        if let Some(x) = edit::value_at(seq, c, &format!("effects.{e}.{k}"), app.t) {
            *v = edit::to_json(&x);
        }
    }
    out
}

/// The clip's effect of `kind`, added at the end of its list when it has none (inside the caller's undo step).
fn ensure(app: &mut App, clip: Id, kind: &str) -> Option<Id> {
    if let Some(e) = effect_id(app, clip, kind) {
        return Some(e);
    }
    let seq = app.sequence_id?;
    let r = app.exec(&C::add_effect(seq.as_str(), clip.as_str(), kind, None, json!({})))?;
    r.get("id").and_then(Json::as_str).map(Id::new)
}

/// Sets parameters of the clip's effect of `kind` at the playhead (`set`), the effect made first when missing: one
/// undo step, or part of the one already open (a drag).
pub fn set(app: &mut App, clip: Id, kind: &str, values: &[(&str, Value)], label: &str) -> bool {
    if clip_of(app, clip).is_none() {
        return false;
    }
    let grouped = app.history.grouping();
    if !grouped {
        app.history.begin(label);
    }
    let ok = ensure(app, clip, kind)
        .is_some_and(|e| values.iter().all(|(k, v)| edit::write(app, clip, &format!("effects.{e}.{k}"), v).is_some()));
    if !grouped {
        if ok {
            app.history.commit();
        } else {
            app.history.cancel();
        }
    }
    ok
}

/// Runs `cmds` as one undo step, all or none.
fn steps(app: &mut App, label: &str, cmds: Vec<Json>) {
    app.history.begin(label);
    if cmds.iter().all(|c| app.exec(c).is_some()) {
        app.history.commit();
    } else {
        app.history.cancel();
    }
}

/// Puts parameters of an effect back to their defaults, their keyframes too, in one step (`resetParams`).
fn reset_params(app: &mut App, clip: Id, kind: &str, ids: &[&str]) {
    let (Some(seq), Some(e)) = (app.sequence_id, effect_id(app, clip, kind)) else { return };
    let Some(c) = clip_of(app, clip) else { return };
    let (s, cl, ef) = (seq.as_str(), clip.as_str(), e.as_str());
    let mut cmds: Vec<Json> = ids
        .iter()
        .map(|k| format!("effects.{e}.{k}"))
        .filter(|p| c.keyframes.contains_key(p))
        .map(|p| C::set_keyframes(s, cl, &p, None))
        .collect();
    let nulls: Map<String, Json> = ids.iter().map(|k| ((*k).to_owned(), Json::Null)).collect();
    cmds.push(C::set_effect(s, cl, ef, json!({ "params": nulls })));
    steps(app, "Reset", cmds);
}

/// The header's Reset: every parameter and keyframe of the Lumetri Color and the vignette, one step.
fn reset_all(app: &mut App, clip: Id) {
    let Some(seq) = app.sequence_id else { return };
    let Some(c) = clip_of(app, clip) else { return };
    let (s, cl) = (seq.as_str(), clip.as_str());
    let mut cmds = Vec::new();
    for e in c.effects.iter().filter(|e| e.kind == LUMETRI || e.kind == VIGNETTE) {
        let prefix = format!("effects.{}.", e.id);
        cmds.extend(c.keyframes.keys().filter(|k| k.starts_with(&prefix)).map(|k| C::set_keyframes(s, cl, k, None)));
        let nulls: Map<String, Json> = e.params.keys().map(|k| (k.clone(), Json::Null)).collect();
        cmds.push(C::set_effect(s, cl, e.id.as_str(), json!({ "params": nulls })));
    }
    steps(app, "Color", cmds);
}

/// The clip's name for the header: its own, its media's, or "Clip".
fn title(project: &Project, c: &Clip) -> String {
    if !c.name.is_empty() {
        return c.name.clone();
    }
    let media = match &c.source {
        cut_model::Source::Media { media, .. } => project.media(*media).map(|m| m.name.clone()),
        _ => None,
    };
    media.filter(|n| !n.is_empty()).unwrap_or_else(|| tr("Clip").into_owned())
}

/// What one frame of the panel works on: the clip, and its two effects' values at the playhead.
struct Frame {
    clip: Option<Id>,
    lumetri: Map<String, Json>,
    vignette: Map<String, Json>,
}

impl Frame {
    fn values(&self, kind: &str) -> &Map<String, Json> {
        if kind == LUMETRI { &self.lumetri } else { &self.vignette }
    }

    fn num(&self, kind: &str, id: &str) -> f64 {
        self.values(kind).get(id).and_then(Json::as_f64).unwrap_or(0.0)
    }
}

/// The panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    if s.features.fx.color.collapsed.is_none() {
        let list = s.doc.settings.get(COLLAPSED).and_then(Json::as_array).map_or_else(
            || vec!["vignette".to_owned()],
            |a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        );
        s.features.fx.color.collapsed = Some(list.into_iter().collect());
    }
    let clip = target(&s.app);
    let fx = &mut s.features.fx;
    let st = &mut fx.color;
    if st.clip != clip {
        st.look.error = None;
        st.clip = clip;
    }
    if let Some((d, rgb)) = fx.picked_color.take() {
        if matches!(fx.pick, Some(Pick { kind: PickKind::Lumetri(_), .. })) {
            fx.pick = None;
        }
        if let Some(c) = clip {
            picked(&mut s.app, c, d, rgb);
        }
    }
    s.features.fx.color.look.poll(&mut s.app, clip, ui.ctx());
    let f = Frame {
        clip,
        lumetri: clip.map_or_else(|| effects::defaults(LUMETRI), |c| params_at(&s.app, c, LUMETRI)),
        vignette: clip.map_or_else(|| effects::defaults(VIGNETTE), |c| params_at(&s.app, c, VIGNETTE)),
    };
    header(s, ui, &pal, &f);
    let Some(c) = clip else {
        ui.add_space(8.0);
        ui.label(RichText::new(tr("Select a video clip in the timeline to correct its color.")).color(pal.gray[8]));
        return;
    };
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        for (id, name) in SECTIONS {
            if section_head(s, ui, &pal, id, name, c) {
                ui.indent(id, |ui| match id {
                    "basic" => basic(s, ui, &pal, &f, c),
                    "creative" => {
                        look::section(s, ui, &pal, &f.lumetri, c);
                        group(s, ui, &pal, &f, c, LUMETRI, INTENSITY);
                    }
                    "curves" => curves::section(s, ui, &pal, &f.lumetri, c),
                    "hsl" => hsl(s, ui, &pal, &f, c),
                    _ => group(s, ui, &pal, &f, c, VIGNETTE, VIGNETTE_ROWS),
                });
            }
        }
    });
    let st = &mut s.features.fx.color;
    // a drag whose control went away (its section folded, the clip changed) ends with the button
    if st.gesture.is_open() && !ui.input(|i| i.pointer.any_down()) {
        st.gesture.end(&mut s.app);
    }
}

/// An eyedropper's colour, turned into its edit.
fn picked(app: &mut App, clip: Id, d: Dropper, rgb: [u8; 3]) {
    match d {
        Dropper::WhiteBalance => {
            let (t, m) = pick::white_balance(rgb, &params_at(app, clip, LUMETRI));
            set(app, clip, LUMETRI, &[("temperature", Value::Num(t)), ("tint", Value::Num(m))], "Color");
        }
        Dropper::HslKey => {
            let values: Vec<(&str, Value)> =
                pick::qualifier_for(rgb).into_iter().map(|(k, v)| (k, Value::Num(v))).collect();
            set(app, clip, LUMETRI, &values, "HSL Secondary");
        }
    }
}

fn header(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, f: &Frame) {
    let lm = f.clip.and_then(|c| {
        let e = clip_of(&s.app, c)?.effects.iter().find(|e| e.kind == LUMETRI)?;
        Some((e.id, e.on))
    });
    let name = f.clip.and_then(|c| clip_of(&s.app, c).map(|cl| title(s.app.project(), cl))).unwrap_or_default();
    ui.horizontal(|ui| {
        // the buttons first, at the right; the clip's name takes what is left and is cut short there
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_space(6.0);
            let ok = f.clip.is_some();
            let reset = ui.add_enabled(ok, egui::Button::new(tr("Reset"))).on_hover_text(tr("Reset every section"));
            if reset.clicked()
                && let Some(c) = f.clip
            {
                reset_all(&mut s.app, c);
            }
            let mut on = lm.is_some_and(|(_, on)| on);
            if ui.add_enabled(ok, egui::Checkbox::new(&mut on, tr("Lumetri Color"))).changed()
                && let Some(c) = f.clip
            {
                match (lm, s.app.sequence_id) {
                    (Some((e, _)), Some(seq)) => {
                        s.app.exec(&C::set_effect(seq.as_str(), c.as_str(), e.as_str(), json!({ "on": on })));
                    }
                    _ if on => {
                        set(&mut s.app, c, LUMETRI, &[], "Color");
                    }
                    _ => {}
                }
            }
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                ui.add_space(6.0);
                ui.add(egui::Label::new(RichText::new(name).color(pal.gray[11]).strong()).truncate());
            });
        });
    });
    ui.separator();
}

/// A section's head: the twisty and name (a click folds or opens it, kept in the settings) and its Reset ->
/// whether it is open.
fn section_head(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, id: &str, name: &str, clip: Id) -> bool {
    let open = !s.features.fx.color.collapsed.as_ref().is_some_and(|c| c.contains(id));
    let mut toggle = false;
    ui.horizontal(|ui| {
        let twisty = if open { glyph::OPEN } else { glyph::CLOSED };
        toggle |= widgets::icon(ui, twisty, &tr(name), false, pal.accent).clicked();
        toggle |= ui.add(egui::Label::new(RichText::new(tr(name)).strong()).sense(Sense::click())).clicked();
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_space(6.0);
            let tip = crate::i18n::trf("Reset {name}", &[("name", &tr(name))]);
            if ui.small_button(tr("Reset")).on_hover_text(tip).clicked() {
                let app = &mut s.app;
                match id {
                    "basic" => {
                        let ids: Vec<&str> = BASIC.iter().flat_map(|g| g.1.iter().map(|r| r.0)).collect();
                        reset_params(app, clip, LUMETRI, &ids);
                    }
                    "creative" => reset_params(app, clip, LUMETRI, &["lut", "lutIntensity"]),
                    "curves" => reset_params(app, clip, LUMETRI, &cut_engine::lumetri::CURVE_PARAMS),
                    "hsl" => reset_params(app, clip, LUMETRI, &HSL_PARAMS),
                    _ => {
                        let ids: Vec<&str> = VIGNETTE_ROWS.1.iter().map(|r| r.0).collect();
                        reset_params(app, clip, VIGNETTE, &ids);
                    }
                }
            }
        });
    });
    if toggle {
        let set = s.features.fx.color.collapsed.get_or_insert_with(HashSet::new);
        if !set.remove(id) {
            set.insert(id.to_owned());
        }
        let mut list: Vec<&String> = set.iter().collect();
        list.sort();
        s.doc.settings.set(COLLAPSED, json!(list));
        let _ = s.doc.settings.save();
    }
    open != toggle
}

fn basic(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, f: &Frame, clip: Id) {
    let picking = |s: &Shell, d| s.features.fx.pick.as_ref().is_some_and(|p| p.kind == PickKind::Lumetri(d));
    ui.horizontal(|ui| {
        ui.label(RichText::new(tr(BASIC[0].0)).color(pal.gray[9]));
        let on = picking(s, Dropper::WhiteBalance);
        let tip = tr("White Balance Selector: click something white or gray in the program monitor");
        if widgets::icon(ui, glyph::DROPPER, &tip, on, pal.accent).clicked() {
            start_pick(s, clip, Dropper::WhiteBalance);
        }
        let tip = tr("Auto Color: neutral white balance and mid-grey exposure from the picture at the playhead");
        if ui.small_button(tr("Auto")).on_hover_text(tip).clicked() {
            let ctx = ui.ctx().clone();
            s.run_action("auto.color", &ctx);
        }
    });
    rows(s, ui, pal, f, clip, LUMETRI, BASIC[0].1);
    for g in &BASIC[1..] {
        group(s, ui, pal, f, clip, LUMETRI, *g);
    }
}

fn hsl(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, f: &Frame, clip: Id) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(tr(HSL_KEY.0)).color(pal.gray[9]));
        let on = s.features.fx.pick.as_ref().is_some_and(|p| p.kind == PickKind::Lumetri(Dropper::HslKey));
        let tip = tr("Set the qualifier from a color: click it in the program monitor");
        if widgets::icon(ui, glyph::DROPPER, &tip, on, pal.accent).clicked() {
            start_pick(s, clip, Dropper::HslKey);
        }
    });
    pick::hue_bar(ui, &f.lumetri);
    rows(s, ui, pal, f, clip, LUMETRI, HSL_KEY.1);
    group(s, ui, pal, f, clip, LUMETRI, HSL_RANGE);
    let mut mask = f.lumetri.get("hslMask").and_then(Json::as_bool).unwrap_or(false);
    if ui.checkbox(&mut mask, tr("Show Mask")).changed() {
        set(&mut s.app, clip, LUMETRI, &[("hslMask", Value::Flag(mask))], "Color");
    }
    group(s, ui, pal, f, clip, LUMETRI, HSL_FIX);
}

/// The eyedropper waits for a click on the Program monitor (another click on it gives up).
fn start_pick(s: &mut Shell, clip: Id, d: Dropper) {
    let fx = &mut s.features.fx;
    if fx.pick.as_ref().is_some_and(|p| p.kind == PickKind::Lumetri(d)) {
        fx.pick = None;
        return;
    }
    if s.monitors.is_none() {
        s.app.toast(tr("The program monitor is not open."));
        return;
    }
    fx.pick = Some(Pick { clip, path: String::new(), kind: PickKind::Lumetri(d) });
}

fn group(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, f: &Frame, clip: Id, kind: &str, g: Group) {
    if !g.0.is_empty() {
        ui.label(RichText::new(tr(g.0)).color(pal.gray[9]));
    }
    rows(s, ui, pal, f, clip, kind, g.1);
}

/// A label (a double click puts the default back), a slider and a number field per parameter.
fn rows(s: &mut Shell, ui: &mut egui::Ui, pal: &Palette, f: &Frame, clip: Id, kind: &str, list: &[(&str, &str)]) {
    let Some(def) = effects::get(kind) else { return };
    let e = effect_id(&s.app, clip, kind);
    for (id, label) in list {
        let Some(p) = def.params.iter().find(|p| p.id == *id) else { continue };
        let n = Num::new(p.min, p.max, p.step, "");
        let v = f.num(kind, id);
        let keyed =
            e.is_some_and(|e| clip_of(&s.app, clip).is_some_and(|c| edit::keyframed(c, &format!("effects.{e}.{id}"))));
        let mut changes = Vec::new();
        ui.horizontal(|ui| {
            let text = RichText::new(tr(label)).color(if keyed { pal.accent } else { pal.gray[11] });
            let l = ui.add_sized([118.0, 18.0], egui::Label::new(text).sense(Sense::click()).truncate());
            if l.on_hover_text(tr("Double-click to reset")).double_clicked() {
                changes.push(widgets::Change {
                    value: Some(p.default.to_json().as_f64().unwrap_or(0.0)),
                    ..Default::default()
                });
            }
            let w = (ui.available_width() - 64.0).max(40.0);
            changes.push(widgets::slider(ui, v, n.min, n.max, n.step, w));
            changes.push(widgets::number(ui, v, n));
        });
        for c in changes {
            let st = &mut s.features.fx.color;
            if c.started {
                st.gesture.begin(&mut s.app, "Color");
            }
            if let Some(x) = c.value {
                set(&mut s.app, clip, kind, &[(id, Value::Num(x))], "Color");
            }
            if c.stopped {
                s.features.fx.color.gesture.end(&mut s.app);
            }
        }
    }
}
