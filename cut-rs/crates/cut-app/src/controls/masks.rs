//! The masks at the top of Opacity and of each video effect (`maskBlock`): Create Ellipse Mask, Create 4-point
//! Polygon Mask and Free Draw Bezier, then each mask's header (a click edits it on the Program monitor, the X removes
//! it) above its rows. The masks are made and selected through the Program monitor's overlay ([`crate::fx::overlay`]).

use cut_model::Id;
use cut_model::commands::build as C;
use eframe::egui::{self, Rect, RichText, Sense};

use super::icons::{self, Icon};
use super::rows;
use crate::fx::overlay::{self, MaskSel, Shape};
use crate::i18n::{tr, trf};
use crate::shell::Shell;

/// The key the buttons of a mask list are noted under: `opacity` or the effect's id.
fn holder(effect: Option<Id>) -> String {
    effect.map_or_else(|| "opacity".to_owned(), |e| e.as_str().to_owned())
}

/// The row of the three buttons.
pub fn tools(s: &mut Shell, ui: &mut egui::Ui, clip: Id, effect: Option<Id>) {
    let (left, _) = rows::allocate(s, ui, rows::ROW_H);
    let mut cu = rows::child(ui, left.shrink2(egui::vec2(4.0, 0.0)));
    cu.add_space(20.0);
    let blue = s.palette.blue8;
    let pen_on = s.features.fx.overlay.pen == Some((clip, effect));
    let key = holder(effect);
    let mut chose = None;
    for (icon, tip, name, on) in [
        (Icon::Ellipse, "Create ellipse mask", "ellipse", false),
        (Icon::Polygon, "Create 4-point polygon mask", "polygon", false),
        (Icon::Pen, "Free draw bezier", "pen", pen_on),
    ] {
        let r = icons::button(&mut cu, icon, &tr(tip), on, blue);
        s.features.controls.note(format!("masks:{key}/{name}"), r.rect);
        if r.clicked() {
            chose = Some(icon);
        }
    }
    let st = &mut s.features.fx.overlay;
    match chose {
        Some(Icon::Ellipse) => overlay::create(st, &mut s.app, clip, effect, Shape::Ellipse),
        Some(Icon::Polygon) => overlay::create(st, &mut s.app, clip, effect, Shape::Polygon),
        Some(_) if pen_on => st.pen = None,
        Some(_) => {
            st.pen = Some((clip, effect));
            st.selected = None;
        }
        None => {}
    }
}

/// A mask's header: `Mask (n)`, highlighted while it is edited on the monitor; a click selects it, the X removes it.
pub fn head(s: &mut Shell, ui: &mut egui::Ui, sel: MaskSel, n: usize) {
    let (left, lane) = rows::allocate(s, ui, rows::ROW_H);
    let whole = left.union(lane);
    let selected = s.features.fx.overlay.selected == Some(sel);
    if selected {
        ui.painter().rect_filled(whole, 0.0, s.palette.blue6.gamma_multiply(0.22));
    }
    let r = ui.interact(whole, ui.make_persistent_id(("ec-maskhead", sel.mask)), Sense::click());
    let mut cu = rows::child(ui, left.shrink2(egui::vec2(4.0, 0.0)));
    cu.add_space(20.0);
    cu.label(RichText::new(trf("Mask ({n})", &[("n", &n.to_string())])).strong().color(s.palette.gray[10]));
    let accent = s.palette.accent;
    let remove = cu.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        icons::button(ui, Icon::Remove, &tr("Remove Mask"), false, accent)
    });
    let key = sel.mask.as_str().to_owned();
    s.features.controls.note(format!("mask:{key}/head"), Rect::from_min_max(whole.min, whole.max));
    s.features.controls.note(format!("mask:{key}/remove"), remove.inner.rect);
    if remove.inner.clicked() {
        if let Some(seq) = s.app.sequence_id {
            let cmd =
                C::remove_mask(seq.as_str(), sel.clip.as_str(), sel.mask.as_str(), sel.effect.map(|e| e.as_str()));
            s.app.exec(&cmd);
        }
        let st = &mut s.features.fx.overlay;
        if st.selected.is_some_and(|x| x.mask == sel.mask && x.clip == sel.clip) {
            st.selected = None;
        }
    } else if r.clicked() {
        let st = &mut s.features.fx.overlay;
        st.selected = Some(sel);
        st.pen = None;
    }
}
