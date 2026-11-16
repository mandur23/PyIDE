//! The Effects panel (port of `ui-effects.js`): the video and audio effects and the transitions of the registry
//! (`cut_model::effects`) by the JavaScript's groups and categories, a search over their names, favourites and the
//! default transitions. An item is dragged onto a clip (an effect) or an edit point (a transition) in the timeline,
//! or onto Effect Controls; a double click applies it to the selected clips (a transition: at their ends, or at the
//! edit point nearest the playhead).

use std::collections::HashSet;

use cut_model::commands::build as C;
use cut_model::effects::{self as E, Def, Kind};
use cut_model::{Id, Sequence, TrackKind};
use cut_time::Ticks;
use eframe::egui::{self, Color32, Pos2, Rect, RichText, Sense, Stroke, Vec2};
use serde_json::{Value as Json, json};

use super::edit;
use super::widgets::glyph;
use crate::i18n::{tr, trf};
use crate::shell::Shell;
use crate::state::{App, Panel};
use crate::timeline::Timeline;
use crate::timeline::layout::{self, RowKind};

/// The settings key of the favourites (`cut.effectFavorites`).
pub const FAVORITES: &str = "effectFavorites";

/// The settings key of a kind's default transition (`cut.defaultVideoTransition`, `cut.defaultAudioTransition`).
pub fn default_key(kind: Kind) -> &'static str {
    match kind {
        Kind::Video => "defaultVideoTransition",
        Kind::Audio => "defaultAudioTransition",
    }
}

/// An item dragged from the panel.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FxDrag(pub &'static Def);

/// One of the tree's four groups (`catalog`).
pub struct Group {
    pub id: &'static str,
    pub name: &'static str,
    /// Categories in the registry's order, each with its items.
    pub categories: Vec<(&'static str, Vec<&'static Def>)>,
}

/// The tree as the JavaScript's `catalog()` builds it.
pub fn catalog() -> Vec<Group> {
    let group = |id, name, items: Vec<&'static Def>| {
        let mut categories: Vec<(&'static str, Vec<&'static Def>)> = Vec::new();
        for d in items {
            match categories.iter_mut().find(|c| c.0 == d.category) {
                Some(c) => c.1.push(d),
                None => categories.push((d.category, vec![d])),
            }
        }
        Group { id, name, categories }
    };
    vec![
        group("video", "Video Effects", E::list(Some(Kind::Video)).collect()),
        group("audio", "Audio Effects", E::list(Some(Kind::Audio)).collect()),
        group("vtrans", "Video Transitions", E::transitions(Some(Kind::Video)).collect()),
        group("atrans", "Audio Transitions", E::transitions(Some(Kind::Audio)).collect()),
    ]
}

/// Whether an item matches a search (lower case; empty matches all): its name or category in either language, or
/// its type.
pub fn matches(d: &Def, q: &str) -> bool {
    q.is_empty()
        || [tr(d.name).as_ref(), d.name, tr(d.category).as_ref(), d.category, d.id]
            .iter()
            .any(|s| s.to_lowercase().contains(q))
}

/// The panel's state between frames.
pub struct State {
    pub search: String,
    pub open: HashSet<String>,
    pub selected: Option<&'static str>,
}

impl Default for State {
    fn default() -> Self {
        Self { search: String::new(), open: ["video", "vtrans"].map(String::from).into(), selected: None }
    }
}

/// The favourites in the settings.
pub fn favorites(s: &Shell) -> Vec<String> {
    s.doc
        .settings
        .get(FAVORITES)
        .and_then(Json::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn toggle_favorite(s: &mut Shell, id: &str) {
    let mut list = favorites(s);
    if let Some(i) = list.iter().position(|x| x == id) {
        list.remove(i);
    } else {
        list.push(id.to_owned());
        s.features.fx.effects.open.insert("fav".into());
    }
    s.doc.settings.set(FAVORITES, json!(list));
    let _ = s.doc.settings.save();
}

/// The transition a kind gets by default: the one set in the panel, else the registry's.
pub fn default_transition(s: &Shell, kind: Kind) -> &'static str {
    s.doc
        .setting(default_key(kind))
        .and_then(E::get)
        .filter(|d| d.transition)
        .map_or_else(|| E::default_transition(kind), |d| d.id)
}

/// Adds effect `d` to every selected clip of its kind, one step (`apply`).
pub fn apply_effect(app: &mut App, d: &Def) -> bool {
    let Some(seq) = app.sequence() else { return false };
    let want = if d.kind == Kind::Audio { TrackKind::Audio } else { TrackKind::Video };
    let clips: Vec<Id> =
        app.selected().into_iter().filter(|id| seq.clip(*id).is_some_and(|c| edit::kind_of(seq, c) == want)).collect();
    if clips.is_empty() {
        app.toast(tr(if d.kind == Kind::Audio { "Select an audio clip first." } else { "Select a video clip first." }));
        return false;
    }
    let sid = seq.id;
    app.history.begin("Add Effect");
    for c in &clips {
        if app.exec(&C::add_effect(sid.as_str(), c.as_str(), d.id, None, json!({}))).is_none() {
            app.history.cancel();
            return false;
        }
    }
    app.history.commit();
    true
}

/// Effect `d` added to one clip (a drop): refused with the JavaScript's words when the clip is of the other kind.
pub fn apply_to_clip(app: &mut App, clip: Id, d: &Def) -> bool {
    let Some(seq) = app.sequence() else { return false };
    let Some(c) = seq.clip(clip) else { return false };
    let kind = edit::kind_of(seq, c);
    if (d.kind == Kind::Audio) != (kind == TrackKind::Audio) {
        app.toast(tr(if d.kind == Kind::Audio {
            "This effect is for audio clips."
        } else {
            "This effect is for video clips."
        }));
        return false;
    }
    let cmd = C::add_effect(seq.id.as_str(), clip.as_str(), d.id, None, json!({}));
    let ok = app.exec(&cmd).is_some();
    if ok {
        app.select([clip], false, false);
    }
    ok
}

/// Transition `d` at the selection's ends or the edit point nearest the playhead (the timeline's Ctrl+D with `d`).
pub fn apply_transition(app: &mut App, d: &Def) -> bool {
    let kind = if d.kind == Kind::Audio { TrackKind::Audio } else { TrackKind::Video };
    crate::edit::actions::place_transitions(app, &[kind], &|_| d.id.to_owned())
}

/// Applies an item the way a double click does.
pub fn apply(app: &mut App, d: &Def) -> bool {
    if d.transition { apply_transition(app, d) } else { apply_effect(app, d) }
}

/// The edit point a transition dropped at lane `x` goes on (`edgeNear`): a clip edge of the track within 24 points.
pub fn edge_near(seq: &Sequence, track: Id, x: f64, x_of: impl Fn(Ticks) -> f64) -> Option<Ticks> {
    let t = seq.track(track)?;
    t.clips
        .iter()
        .flat_map(|c| [c.start, c.end()])
        .map(|at| (at, (x_of(at) - x).abs()))
        .filter(|(_, d)| *d <= 24.0)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(at, _)| at)
}

/// An item of the panel dropped on the timeline's lanes: an effect on the clip under the pointer, a transition on the
/// edit point near it. Called by the timeline each frame with its lanes' rectangle.
pub fn drop_on_timeline(tl: &Timeline, ui: &mut egui::Ui, lanes: Rect, app: &mut App, seq: &Sequence) {
    let Some(p) = ui.ctx().pointer_latest_pos().filter(|p| lanes.contains(*p)) else { return };
    let Some(drag) = egui::DragAndDrop::payload::<FxDrag>(ui.ctx()) else { return };
    let d = drag.0;
    let h = layout::hit(tl.layout(), &tl.view, f64::from(p.x - lanes.left()), p.y - lanes.top());
    let row = h.row.and_then(|i| tl.layout().rows.get(i));
    let track = row.filter(|r| matches!(r.kind, RowKind::Video | RowKind::Audio)).and_then(|r| r.id);
    let x_of = |t: Ticks| tl.view.x_of(t) + f64::from(lanes.left());
    let edge = if d.transition { track.and_then(|tk| edge_near(seq, tk, f64::from(p.x), x_of)) } else { None };
    let painter = ui.painter_at(lanes);
    let mark = Color32::from_rgb(0x4f, 0xc3, 0xf7);
    if let (Some(at), Some(r)) = (edge, row) {
        let x = x_of(at) as f32;
        let y = lanes.top() + r.y - tl.view.scroll_y;
        painter.rect_stroke(
            Rect::from_x_y_ranges(x - 12.0..=x + 12.0, y..=y + r.h),
            2.0,
            Stroke::new(2.0, mark),
            egui::StrokeKind::Inside,
        );
    } else if !d.transition
        && let (Some(id), Some(r)) = (h.clip, row)
        && let Some(c) = seq.clip(id)
    {
        let (a, b) = (x_of(c.start) as f32, x_of(c.end()) as f32);
        let y = lanes.top() + r.y - tl.view.scroll_y;
        painter.rect_stroke(
            Rect::from_x_y_ranges(a..=b, y..=y + r.h),
            2.0,
            Stroke::new(2.0, mark),
            egui::StrokeKind::Inside,
        );
    }
    if !ui.input(|i| i.pointer.any_released()) {
        return;
    }
    egui::DragAndDrop::clear_payload(ui.ctx());
    if d.transition {
        let (Some(tk), Some(at)) = (track, edge) else { return };
        let cmd = C::add_transition(
            seq.id.as_str(),
            json!({ "track": tk.as_str(), "at": at, "type": d.id, "align": crate::edit::actions::align_at(seq, tk, at) }),
        );
        app.exec(&cmd);
    } else if let Some(id) = h.clip {
        apply_to_clip(app, id, d);
    }
}

fn folder_row(ui: &mut egui::Ui, s: &mut Shell, id: &str, name: &str, depth: usize, count: Option<usize>) {
    let pal = s.palette.clone();
    let open = s.features.fx.effects.open.contains(id);
    let (rect, r) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 22.0), Sense::click());
    if r.hovered() {
        ui.painter().rect_filled(rect, 0.0, pal.gray[3]);
    }
    let mut x = rect.left() + 4.0 + depth as f32 * 14.0;
    let font = egui::FontId::proportional(10.0);
    let tw = if open { glyph::OPEN } else { glyph::CLOSED };
    ui.painter().text(Pos2::new(x + 5.0, rect.center().y), egui::Align2::CENTER_CENTER, tw, font.clone(), pal.gray[9]);
    x += 14.0;
    ui.painter().text(
        Pos2::new(x + 6.0, rect.center().y),
        egui::Align2::CENTER_CENTER,
        glyph::FOLDER,
        egui::FontId::proportional(12.0),
        pal.gray[9],
    );
    x += 16.0;
    ui.painter().text(
        Pos2::new(x, rect.center().y),
        egui::Align2::LEFT_CENTER,
        name,
        egui::FontId::proportional(13.0),
        pal.gray[11],
    );
    if let Some(n) = count {
        ui.painter().text(
            rect.right_center() - Vec2::new(8.0, 0.0),
            egui::Align2::RIGHT_CENTER,
            n.to_string(),
            egui::FontId::proportional(11.0),
            pal.gray[8],
        );
    }
    if r.clicked() {
        let set = &mut s.features.fx.effects.open;
        if !set.remove(id) {
            set.insert(id.to_owned());
        }
    }
}

fn item_row(ui: &mut egui::Ui, s: &mut Shell, d: &'static Def, depth: usize, favs: &[String]) {
    let pal = s.palette.clone();
    let selected = s.features.fx.effects.selected == Some(d.id);
    let id = egui::Id::NULL.with(("fx-item", d.id, depth));
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 22.0), Sense::hover());
    let r = ui.interact(rect, id, Sense::click_and_drag());
    if selected {
        ui.painter().rect_filled(rect, 0.0, pal.selected);
    } else if r.hovered() {
        ui.painter().rect_filled(rect, 0.0, pal.gray[3]);
    }
    let x = rect.left() + 8.0 + depth as f32 * 14.0;
    let icon = if d.transition {
        "\u{E8AB}"
    } else if d.kind == Kind::Audio {
        "\u{E767}"
    } else {
        "\u{E7B5}"
    };
    ui.painter().text(
        Pos2::new(x + 6.0, rect.center().y),
        egui::Align2::CENTER_CENTER,
        icon,
        egui::FontId::proportional(12.0),
        pal.gray[9],
    );
    let name_pos = Pos2::new(x + 18.0, rect.center().y);
    let g = ui.painter().text(
        name_pos,
        egui::Align2::LEFT_CENTER,
        tr(d.name),
        egui::FontId::proportional(13.0),
        pal.gray[12],
    );
    let mut bx = g.right() + 8.0;
    if d.transition && default_transition(s, d.kind) == d.id {
        let t = ui.painter().text(
            Pos2::new(bx, rect.center().y),
            egui::Align2::LEFT_CENTER,
            tr("Default"),
            egui::FontId::proportional(10.5),
            pal.accent,
        );
        bx = t.right() + 6.0;
    }
    if favs.iter().any(|f| f == d.id) {
        ui.painter().text(
            Pos2::new(bx, rect.center().y),
            egui::Align2::LEFT_CENTER,
            glyph::STAR,
            egui::FontId::proportional(11.0),
            Color32::from_rgb(0xe6, 0xc2, 0x29),
        );
    }
    let r = r.on_hover_text(tr(d.name));
    if r.clicked() || r.drag_started() {
        s.features.fx.effects.selected = Some(d.id);
        s.focus(Panel::Effects);
    }
    if r.drag_started() {
        egui::DragAndDrop::set_payload(ui.ctx(), FxDrag(d));
    }
    if r.dragged()
        && let Some(p) = ui.ctx().pointer_latest_pos()
    {
        let layer = egui::LayerId::new(egui::Order::Tooltip, egui::Id::NULL.with("fx-drag"));
        ui.ctx().layer_painter(layer).text(
            p + Vec2::new(12.0, 4.0),
            egui::Align2::LEFT_TOP,
            tr(d.name),
            egui::FontId::proportional(13.0),
            pal.gray[12],
        );
    }
    if r.double_clicked() {
        apply(&mut s.app, d);
    }
    r.context_menu(|ui| {
        if ui.button(tr("Apply to Selected Clips")).clicked() {
            apply(&mut s.app, d);
            ui.close();
        }
        let fav = favs.iter().any(|f| f == d.id);
        if ui.button(tr(if fav { "Remove from Favorites" } else { "Add to Favorites" })).clicked() {
            toggle_favorite(s, d.id);
            ui.close();
        }
        if d.transition {
            let on = default_transition(s, d.kind) == d.id;
            if ui.add(egui::Button::new(tr("Set Selected as Default Transition")).selected(on)).clicked() {
                s.doc.set_setting(default_key(d.kind), d.id);
                ui.close();
            }
        }
    });
}

/// The panel.
pub fn panel(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        let r = ui.add(
            egui::TextEdit::singleline(&mut s.features.fx.effects.search)
                .hint_text(tr("Search effects and transitions"))
                .desired_width(ui.available_width() - 8.0),
        );
        if r.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Escape)) {
            s.features.fx.effects.search.clear();
        }
        if r.gained_focus() {
            s.focus(Panel::Effects);
        }
    });
    let q = s.features.fx.effects.search.trim().to_lowercase();
    let favs = favorites(s);
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        let groups = catalog();
        let all: Vec<&'static Def> =
            groups.iter().flat_map(|g| g.categories.iter().flat_map(|c| c.1.iter().copied())).collect();
        let fav_items: Vec<_> =
            all.iter().copied().filter(|d| favs.iter().any(|f| f == d.id) && matches(d, &q)).collect();
        let mut rows = 0;
        if !fav_items.is_empty() {
            folder_row(ui, s, "fav", &tr("Favorites"), 0, None);
            rows += 1;
            if s.features.fx.effects.open.contains("fav") || !q.is_empty() {
                for d in fav_items {
                    item_row(ui, s, d, 1, &favs);
                }
            }
        }
        for g in &groups {
            let cats: Vec<(&str, Vec<&'static Def>)> = g
                .categories
                .iter()
                .map(|(n, items)| (*n, items.iter().copied().filter(|d| matches(d, &q)).collect::<Vec<_>>()))
                .filter(|c| !c.1.is_empty())
                .collect();
            if !q.is_empty() && cats.is_empty() {
                continue;
            }
            folder_row(ui, s, g.id, &tr(g.name), 0, None);
            rows += 1;
            if !s.features.fx.effects.open.contains(g.id) && q.is_empty() {
                continue;
            }
            for (name, items) in cats {
                let cid = format!("{}/{name}", g.id);
                folder_row(ui, s, &cid, &tr(name), 1, Some(items.len()));
                if s.features.fx.effects.open.contains(&cid) || !q.is_empty() {
                    for d in items {
                        item_row(ui, s, d, 2, &favs);
                    }
                }
            }
        }
        if rows == 0 && !q.is_empty() {
            ui.add_space(12.0);
            ui.vertical_centered(|ui| {
                let shown = s.features.fx.effects.search.trim().to_owned();
                ui.label(RichText::new(trf("Nothing matches “{q}”.", &[("q", &shown)])).color(pal.gray[8]));
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tree_has_every_effect_and_transition_once_under_its_category() {
        let groups = catalog();
        let n: usize = groups.iter().map(|g| g.categories.iter().map(|c| c.1.len()).sum::<usize>()).sum();
        assert_eq!(n, E::ALL.len());
        for g in &groups {
            for (cat, items) in &g.categories {
                assert!(items.iter().all(|d| d.category == *cat));
            }
        }
        assert_eq!(groups.iter().map(|g| g.id).collect::<Vec<_>>(), ["video", "audio", "vtrans", "atrans"]);
    }

    #[test]
    fn search_reads_names_categories_and_types() {
        crate::i18n::set_lang(crate::i18n::Lang::En);
        let gauss = E::get("blur.gaussian").unwrap();
        assert!(matches(gauss, ""));
        assert!(matches(gauss, "blur"));
        assert!(matches(gauss, "gaussian"));
        assert!(!matches(gauss, "dissolve"));
    }
}
