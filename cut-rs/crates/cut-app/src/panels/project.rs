//! The Project panel (port of `ui-project.js`, without thumbnails yet): the media, bins and sequences of the project
//! in a list (name, duration, video size, frame rate) or as icons; bins with a path of crumbs; search across every
//! bin; sort by a column; rename (F2, double click on a selected name); delete, asking first when a nested sequence
//! takes its nest clips with it; drag media onto the timeline; import from the bar or by dropping files.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;

use cut_model::{Id, Media, MediaKind, Project, Source};
use cut_time::{FRAME_RATES, Fps, timecode};
use eframe::egui::{self, Align, Button, Color32, Key, Layout, RichText, Sense, Stroke, Vec2};

use crate::cmd;
use crate::i18n::{tr, trf};
use crate::icons;
use crate::shell::{Dialog, Shell};
use crate::state::{App, MediaDrag, Panel};

/// What a row of the panel is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Bin,
    Media,
    Sequence,
}

/// One row: a bin, a media item or a sequence.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub kind: EntryKind,
    pub id: Id,
    pub name: String,
    pub duration: String,
    pub size: String,
    pub fps: String,
    pub codec: String,
    /// For sorting by duration.
    pub ticks: i64,
    /// Clips of the media in every sequence (`usesOf`).
    pub uses: usize,
    /// A media item's kind (its glyph).
    pub media: Option<MediaKind>,
}

/// The columns the list sorts by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Column {
    Name,
    Duration,
    Video,
    Fps,
    Uses,
}

/// The frame rate the duration of media with an odd rate is counted in (`nearestRate`).
pub fn nearest_rate(fps: Option<Fps>) -> Fps {
    let v = fps.map_or(30.0, Fps::value);
    FRAME_RATES
        .into_iter()
        .min_by(|a, b| (a.value() - v).abs().total_cmp(&(b.value() - v).abs()))
        .unwrap_or(FRAME_RATES[4])
}

/// A media's frame rate as probed (`video.fps`).
pub fn fps_of(m: &Media) -> Option<Fps> {
    let f = m.video.as_ref()?.extra.get("fps")?.as_array()?;
    let num = f.first()?.as_i64()?;
    let den = f.get(1).and_then(serde_json::Value::as_i64).unwrap_or(1);
    Some(Fps { num: u32::try_from(num).ok().filter(|n| *n > 0)?, den: u32::try_from(den).ok().filter(|d| *d > 0)? })
}

/// `fpsLabel`: `30 fps`, `29.97 fps`.
fn fps_label(f: Fps) -> String {
    let v = f.value();
    let s = format!("{:.2}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} fps")
}

/// The list's texts for a media item (`describe`).
pub fn describe(m: &Media) -> Entry {
    let fps = fps_of(m);
    let rate = fps.filter(|f| FRAME_RATES.contains(f)).unwrap_or_else(|| nearest_rate(fps));
    let codec = m
        .video
        .as_ref()
        .and_then(|v| v.extra.get("codec"))
        .and_then(|c| c.as_str())
        .map(|c| c.split('.').next().unwrap_or(c).to_owned());
    let khz = m.audio.as_ref().map(|a| format!("{} kHz", (a.rate / 100.0).round() / 10.0));
    Entry {
        kind: EntryKind::Media,
        id: m.id,
        name: m.name.clone(),
        duration: if m.kind == MediaKind::Image { String::new() } else { timecode(m.duration as i64, rate) },
        size: m.video.as_ref().map_or_else(String::new, |v| format!("{}x{}", v.w, v.h)),
        fps: if m.kind == MediaKind::Video { fps.map_or_else(String::new, fps_label) } else { String::new() },
        codec: [codec, khz].into_iter().flatten().collect::<Vec<_>>().join(", "),
        ticks: m.duration as i64,
        uses: 0,
        media: Some(m.kind),
    }
}

/// The entries of a bin (`entries`): its sub-bins, then the media and sequences in it; with a query, every item of
/// the project whose name, size, codec, rate or path holds it.
pub fn entries(p: &Project, bin: Option<Id>, query: &str) -> Vec<Entry> {
    let bin_entry = |b: &cut_model::Bin| Entry {
        kind: EntryKind::Bin,
        id: b.id,
        name: b.name.clone(),
        duration: String::new(),
        size: String::new(),
        fps: String::new(),
        codec: String::new(),
        ticks: 0,
        uses: 0,
        media: None,
    };
    let seq_entry = |s: &cut_model::Sequence| Entry {
        kind: EntryKind::Sequence,
        id: s.id,
        name: s.name.clone(),
        duration: timecode(s.duration(), s.fps),
        size: format!("{}x{}", s.w, s.h),
        fps: fps_label(s.fps),
        codec: String::new(),
        ticks: s.duration(),
        uses: 0,
        media: None,
    };
    let uses = uses_all(p);
    let describe = |m: &Media| Entry { uses: uses.get(&m.id).copied().unwrap_or(0), ..describe(m) };
    let q = query.trim().to_lowercase();
    if !q.is_empty() {
        let mut out: Vec<Entry> = p.bins.iter().map(bin_entry).filter(|e| e.name.to_lowercase().contains(&q)).collect();
        for m in &p.media {
            let d = describe(m);
            if [&d.name, &d.size, &d.codec, &d.fps, &m.path].iter().any(|x| x.to_lowercase().contains(&q)) {
                out.push(d);
            }
        }
        out.extend(p.sequences.iter().map(seq_entry).filter(|e| e.name.to_lowercase().contains(&q)));
        return out;
    }
    let holder = bin.and_then(|b| p.bins.iter().find(|x| x.id == b));
    let held: HashSet<Id> = holder.map(|b| b.items.iter().copied().collect()).unwrap_or_default();
    let in_some: HashSet<Id> = p.bins.iter().flat_map(|b| b.items.iter().copied()).collect();
    let shown = |id: Id| if holder.is_some() { held.contains(&id) } else { !in_some.contains(&id) };
    let mut out: Vec<Entry> = p.bins.iter().filter(|b| b.parent == bin).map(bin_entry).collect();
    out.extend(p.media.iter().filter(|m| shown(m.id)).map(describe));
    out.extend(p.sequences.iter().filter(|s| shown(s.id)).map(seq_entry));
    out
}

/// Sorts entries by a column; bins stay first.
pub fn sort(list: &mut [Entry], by: Column, ascending: bool) {
    list.sort_by(|a, b| {
        let bins = (b.kind == EntryKind::Bin).cmp(&(a.kind == EntryKind::Bin));
        let o = match by {
            Column::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            Column::Duration => a.ticks.cmp(&b.ticks),
            Column::Video => a.size.cmp(&b.size),
            Column::Fps => a.fps.cmp(&b.fps),
            Column::Uses => a.uses.cmp(&b.uses),
        };
        bins.then(if ascending { o } else { o.reverse() })
    });
}

/// Clips of each media item in every sequence; a linked video and audio pair counts once (`usesOf`, for every item
/// in one pass over the clips).
pub fn uses_all(p: &Project) -> HashMap<Id, usize> {
    let mut n: HashMap<Id, usize> = HashMap::new();
    for s in &p.sequences {
        let mut links = HashSet::new();
        for c in s.clips() {
            let Some(m) = c.media_id() else { continue };
            if c.link.is_none_or(|l| links.insert((m, l))) {
                *n.entry(m).or_default() += 1;
            }
        }
    }
    n
}

/// The unused media of the whole project as entries (the More menu's Select Unused Media).
pub fn unused_entries(p: &Project) -> Vec<Entry> {
    let ids = unused(p);
    p.media.iter().filter(|m| ids.contains(&m.id)).map(describe).collect()
}

/// The media no sequence uses (`unusedIds`).
pub fn unused(p: &Project) -> Vec<Id> {
    let used: HashSet<Id> = p.sequences.iter().flat_map(|s| s.clips().filter_map(|c| c.media_id())).collect();
    p.media.iter().filter(|m| !used.contains(&m.id)).map(|m| m.id).collect()
}

/// Where a sequence is nested in another one that stays: `(sequence name, nest clips)` (`nestUses`).
pub fn nest_uses(p: &Project, id: Id, going: &[Id]) -> Vec<(String, usize)> {
    p.sequences
        .iter()
        .filter(|s| !going.contains(&s.id))
        .filter_map(|s| {
            let n = s.clips().filter(|c| matches!(c.source, Source::Nest { sequence, .. } if sequence == id)).count();
            (n > 0).then(|| (s.name.clone(), n))
        })
        .collect()
}

/// The panel's own state.
#[derive(Debug, Default)]
pub struct ProjectPanel {
    bin: Option<Id>,
    selected: HashSet<Id>,
    anchor: Option<Id>,
    query: String,
    /// Only the unused media of the whole project (`filter === 'unused'`), until Show All or a search.
    unused_only: bool,
    icons: bool,
    sort: Option<(Column, bool)>,
    renaming: Option<(Id, String, bool)>,
    /// Files of a dropped folder waiting for their probe, and the bin each goes into.
    pub pending_bins: HashMap<PathBuf, Option<Id>>,
    /// The proxies offered after an import.
    pub offer: crate::panels::media_marks::Offer,
    /// The New Item menu's dialogs (Color Matte, Remove Unused Media) and Import Folder's picking.
    pub new_item: crate::panels::new_item::NewItem,
    /// The list as made last, and what it was made of: made again only when one of those changes.
    listed: Option<(ListKey, Rc<[Entry]>)>,
}

/// What the list shows: the project's revision, the bin, the search, the unused view and the sort.
type ListKey = (u64, Option<Id>, String, bool, Option<(Column, bool)>);

impl ProjectPanel {
    /// The bin imports go into.
    pub fn current_bin(&self) -> Option<Id> {
        self.bin
    }

    /// Shows an item where it is, selected alone (the timeline's Reveal in Project).
    pub fn reveal(&mut self, p: &Project, id: Id) {
        self.bin = p.bins.iter().find(|b| b.items.contains(&id)).map(|b| b.id);
        self.query.clear();
        self.unused_only = false;
        self.selected = [id].into_iter().collect();
        self.anchor = Some(id);
    }

    pub fn start_rename(&mut self, id: Id, name: &str) {
        self.renaming = Some((id, name.to_owned(), true));
    }

    pub fn select_unused(&mut self, app: &App) {
        self.unused_only = true;
        self.query.clear();
        self.selected = unused(app.project()).into_iter().collect();
        self.anchor = self.selected.iter().next().copied();
    }

    pub fn selected(&self) -> &HashSet<Id> {
        &self.selected
    }

    /// Selects these items alone (a click on one).
    pub fn select(&mut self, ids: impl IntoIterator<Item = Id>) {
        self.selected = ids.into_iter().collect();
    }

    /// The entries shown, made again only when the project, the bin, the search, the view or the sort changed.
    pub fn list(&mut self, p: &Project, revision: u64) -> Rc<[Entry]> {
        let key = (revision, self.bin, self.query.clone(), self.unused_only, self.sort);
        if let Some((k, list)) = &self.listed
            && *k == key
        {
            return list.clone();
        }
        let mut list = if self.unused_only { unused_entries(p) } else { entries(p, self.bin, &self.query) };
        if let Some((by, asc)) = self.sort {
            sort(&mut list, by, asc);
        }
        let list: Rc<[Entry]> = list.into();
        self.listed = Some((key, list.clone()));
        list
    }

    /// Shows the items as thumbnails (`true`) or as a list.
    pub fn set_icons(&mut self, on: bool) {
        self.icons = on;
    }

    /// Delete (`removeSelectedItems`): a nested sequence asks first; the last sequence stays.
    pub fn remove_selected(&mut self, app: &mut App) -> Option<Dialog> {
        let p = app.project();
        let ids: Vec<Id> = self.selected.iter().copied().collect();
        if ids.is_empty() {
            return None;
        }
        let seqs: Vec<Id> = ids.iter().copied().filter(|id| p.sequence(*id).is_some()).collect();
        if !seqs.is_empty() && seqs.len() >= p.sequences.len() {
            app.toast(tr("A project keeps at least one sequence."));
            return None;
        }
        let mut used = Vec::new();
        for id in &seqs {
            let name = p.sequence(*id).map_or_else(String::new, |s| s.name.clone());
            for (place, n) in nest_uses(p, *id, &seqs) {
                used.push(trf(
                    "\"{name}\" is nested in \"{where}\" ({n} clips).",
                    &[("name", &name), ("where", &place), ("n", &n.to_string())],
                ));
            }
        }
        if used.is_empty() {
            self.remove_now(app, &ids);
            None
        } else {
            Some(Dialog::RemoveMedia { ids, used })
        }
    }

    pub fn remove_now(&mut self, app: &mut App, ids: &[Id]) {
        let p = app.project();
        let media: Vec<Id> = ids.iter().copied().filter(|id| p.media(*id).is_some()).collect();
        let seqs: Vec<Id> = ids.iter().copied().filter(|id| p.sequence(*id).is_some()).collect();
        let bins: Vec<Id> = ids.iter().copied().filter(|id| p.bins.iter().any(|b| b.id == *id)).collect();
        let mut list = Vec::new();
        if !media.is_empty() {
            list.push(cmd::remove_media(&media));
        }
        list.extend(seqs.iter().map(|id| cmd::remove_sequence(*id)));
        list.extend(bins.iter().map(|id| cmd::remove_bin(*id)));
        app.exec(&cmd::batch("Clear", list));
        if self.bin.is_some_and(|b| bins.contains(&b)) {
            self.bin = None;
        }
        self.selected.clear();
    }
}

fn kind_glyph(e: &Entry) -> &'static str {
    match e.kind {
        EntryKind::Bin => icons::FOLDER,
        EntryKind::Sequence => icons::SEQUENCE,
        EntryKind::Media => match e.media {
            Some(MediaKind::Audio) => icons::AUDIO,
            Some(MediaKind::Image) => icons::IMAGE,
            _ => icons::VIDEO,
        },
    }
}

pub fn show(s: &mut Shell, ui: &mut egui::Ui) {
    let pal = s.palette.clone();
    // the bar: import, new bin, search, list or icons
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        if ui.add(Button::new(icons::IMPORT).frame(false)).on_hover_text(tr("Import Media")).clicked() {
            s.ask(crate::shell::Ask::Import);
        }
        if ui.add(Button::new(icons::NEW_FOLDER).frame(false)).on_hover_text(tr("New Bin")).clicked() {
            let ctx = ui.ctx().clone();
            s.run_action("newBin", &ctx);
        }
        ui.menu_button(icons::ADD, |ui| crate::panels::new_item::menu(s, ui)).response.on_hover_text(tr("New Item"));
        ui.menu_button(icons::MORE, |ui| more_menu(s, ui)).response.on_hover_text(tr("More"));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if ui
                .add(Button::new(icons::GRID).selected(s.project.icons).frame(false))
                .on_hover_text(tr("Icon View"))
                .clicked()
            {
                s.project.icons = true;
            }
            if ui
                .add(Button::new(icons::LIST).selected(!s.project.icons).frame(false))
                .on_hover_text(tr("List View"))
                .clicked()
            {
                s.project.icons = false;
            }
            let search = ui.add(
                egui::TextEdit::singleline(&mut s.project.query)
                    .hint_text(tr("Search"))
                    .desired_width(ui.available_width() - 6.0),
            );
            if search.changed() {
                s.project.unused_only = false;
            }
        });
    });
    crumbs(s, ui, &pal);
    crate::panels::media_marks::offer_bar(s, ui);
    let list = s.project.list(s.app.history.project(), s.app.history.revision());
    let footer = 34.0;
    let body_h = (ui.available_height() - footer).max(40.0);
    let mut open = None;
    egui::ScrollArea::both().max_height(body_h).auto_shrink([false, false]).show(ui, |ui| {
        if list.is_empty() {
            ui.add_space(20.0);
            ui.vertical_centered(|ui| {
                ui.label(
                    RichText::new(if s.project.unused_only {
                        tr("Every media item is used.")
                    } else if s.project.query.is_empty() {
                        tr("Import media to start: drop files here or use Import.")
                    } else {
                        tr("Nothing matches.")
                    })
                    .color(pal.gray[8]),
                );
            });
        } else if s.project.icons {
            open = icons(s, ui, &list);
        } else {
            open = rows(s, ui, &list);
        }
    });
    if let Some(e) = open {
        match e.kind {
            EntryKind::Bin => {
                s.project.bin = Some(e.id);
                s.project.selected.clear();
                s.project.query.clear();
            }
            EntryKind::Sequence => {
                s.app.set_sequence(e.id);
                s.focus(Panel::Timeline);
            }
            EntryKind::Media if crate::panels::media_marks::offline(s, e.id) => crate::prefs::relink::find_missing(s),
            EntryKind::Media => s.focus(Panel::Source),
        }
    }
    ui.separator();
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        let mut count = trf("{n} items", &[("n", &list.len().to_string())]);
        let offline = s.features.prefs.relink.offline.len();
        if offline > 0 {
            count = format!("{count} · {}", trf("{n} offline", &[("n", &offline.to_string())]));
        }
        ui.label(RichText::new(count).size(12.0).color(pal.gray[8]));
        if s.importer.pending() > 0 {
            ui.spinner();
            ui.label(RichText::new(tr("Importing media")).size(12.0).color(pal.gray[8]));
        }
    });
    // keys of the panel: F2 renames, Delete removes, Ctrl+A selects all
    if s.app.focus == Some(Panel::Project) && s.dialog.is_none() && !ui.ctx().egui_wants_keyboard_input() {
        let (f2, del, all) = ui.input(|i| {
            (
                i.key_pressed(Key::F2),
                i.key_pressed(Key::Delete) || i.key_pressed(Key::Backspace),
                i.modifiers.ctrl && i.key_pressed(Key::A),
            )
        });
        if f2 && let Some(e) = list.iter().find(|e| s.project.selected.contains(&e.id)) {
            s.project.start_rename(e.id, &e.name);
        }
        if del && let Some(d) = s.project.remove_selected(&mut s.app) {
            s.dialog = Some(d);
        }
        if all {
            s.project.selected = list.iter().map(|e| e.id).collect();
        }
    }
}

/// The More menu (`moreItems`): the unused and missing media of the project, the proxies of the selected media.
fn more_menu(s: &mut Shell, ui: &mut egui::Ui) {
    let ctx = ui.ctx().clone();
    let items = [
        ("selectUnused", "Select Unused Media"),
        ("removeUnused", "Remove Unused Media…"),
        ("findMissing", "Find Missing Media…"),
        ("", ""),
        ("createProxy", "Create Proxy"),
        ("proxy.remove", "Remove Proxy"),
    ];
    for (id, label) in items {
        if id.is_empty() {
            ui.separator();
        } else if ui
            .add_enabled(s.action_enabled(id), Button::new(tr(label)).shortcut_text(crate::keys::shown(id, s.preset)))
            .clicked()
        {
            s.run_action(id, &ctx);
            ui.close();
        }
    }
}

fn crumbs(s: &mut Shell, ui: &mut egui::Ui, pal: &crate::theme::Palette) {
    // a search and the unused media are of the whole project, whatever bin is open
    if s.project.unused_only || !s.project.query.trim().is_empty() {
        ui.horizontal(|ui| {
            ui.add_space(8.0);
            let text = if s.project.unused_only {
                tr("Unused media in the whole project")
            } else {
                tr("Results in the whole project")
            };
            ui.label(RichText::new(text).size(12.0).color(pal.gray[9]));
            if s.project.unused_only
                && ui.add(Button::new(RichText::new(tr("Show All")).color(pal.blue8)).frame(false)).clicked()
            {
                s.project.unused_only = false;
            }
        });
        return;
    }
    let p = s.app.project();
    let mut chain = Vec::new();
    let mut b = s.project.bin.and_then(|id| p.bins.iter().find(|x| x.id == id));
    while let Some(bin) = b {
        chain.insert(0, (bin.id, bin.name.clone()));
        b = bin.parent.and_then(|id| p.bins.iter().find(|x| x.id == id));
    }
    if chain.is_empty() {
        return;
    }
    ui.horizontal(|ui| {
        ui.add_space(8.0);
        if ui.add(Button::new(RichText::new(tr("Project")).color(pal.blue8)).frame(false)).clicked() {
            s.project.bin = None;
        }
        for (id, name) in chain {
            ui.label("›");
            if ui.add(Button::new(name).frame(false)).clicked() {
                s.project.bin = Some(id);
            }
        }
    });
}

/// A click on an entry (`Ctrl` toggles, `Shift` extends from the last one). -> whether to open it (double click).
fn click(s: &mut Shell, list: &[Entry], e: &Entry, r: &egui::Response) -> bool {
    if r.clicked() || r.secondary_clicked() {
        s.focus(Panel::Project);
        let m = r.ctx.input(|i| i.modifiers);
        let sel = &mut s.project.selected;
        if m.ctrl {
            if !sel.remove(&e.id) {
                sel.insert(e.id);
            }
        } else if m.shift
            && let Some(a) = s.project.anchor
            && let (Some(i), Some(j)) = (list.iter().position(|x| x.id == a), list.iter().position(|x| x.id == e.id))
        {
            sel.clear();
            sel.extend(list[i.min(j)..=i.max(j)].iter().map(|x| x.id));
        } else if !(r.secondary_clicked() && sel.contains(&e.id)) {
            sel.clear();
            sel.insert(e.id);
        }
        if !m.shift {
            s.project.anchor = Some(e.id);
        }
    }
    r.double_clicked()
}

fn drag_source(s: &Shell, ui: &mut egui::Ui, e: &Entry, r: &egui::Response) {
    if e.kind == EntryKind::Media && r.drag_started() {
        let ids: Vec<Id> = if s.project.selected.contains(&e.id) {
            let p = s.app.project();
            p.media.iter().filter(|m| s.project.selected.contains(&m.id)).map(|m| m.id).collect()
        } else {
            vec![e.id]
        };
        egui::DragAndDrop::set_payload(ui.ctx(), MediaDrag(ids));
    }
    if egui::DragAndDrop::has_payload_of_type::<MediaDrag>(ui.ctx())
        && r.dragged()
        && let Some(p) = ui.ctx().pointer_latest_pos()
    {
        egui::Area::new(egui::Id::unique("media-drag"))
            .fixed_pos(p + Vec2::new(12.0, 8.0))
            .order(egui::Order::Tooltip)
            .show(ui.ctx(), |ui| {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    ui.label(&e.name);
                });
            });
    }
}

fn context_menu(s: &mut Shell, e: &Entry, r: &egui::Response) {
    r.context_menu(|ui| {
        match e.kind {
            EntryKind::Media => {
                crate::edit::menus::open_in_source(s, ui, crate::edit::source::SourceItem::Media(e.id));
                crate::panels::media_marks::context_items(s, ui, e.id);
                crate::voice::media_menu_item(s, ui, e.id);
                crate::edit::menus::sequence_from_clip(s, ui, e.id);
            }
            EntryKind::Sequence => {
                if ui.button(tr("Open in Timeline")).clicked() {
                    s.app.set_sequence(e.id);
                    ui.close();
                }
                crate::edit::menus::open_in_source(s, ui, crate::edit::source::SourceItem::Sequence(e.id));
                crate::edit::menus::settings_of(s, ui, e.id);
                if ui.button(tr("Duplicate")).clicked() {
                    let name = crate::i18n::trf("{name} Copy", &[("name", &e.name)]);
                    let made =
                        s.app.exec(&cmd::add_sequence(serde_json::json!({ "from": e.id.as_str(), "name": name })));
                    if let Some(id) = made.as_ref().and_then(|r| r.get("id")).and_then(|v| v.as_str()) {
                        s.app.set_sequence(Id::new(id));
                    }
                    ui.close();
                }
            }
            EntryKind::Bin => {
                if ui.button(tr("Open Bin")).clicked() {
                    s.project.bin = Some(e.id);
                    ui.close();
                }
            }
        }
        if ui.add(Button::new(tr("Rename")).shortcut_text("F2")).clicked() {
            s.project.start_rename(e.id, &e.name);
            ui.close();
        }
        let bins: Vec<(Id, String)> = s
            .app
            .project()
            .bins
            .iter()
            .filter(|b| !s.project.selected.contains(&b.id))
            .map(|b| (b.id, b.name.clone()))
            .collect();
        ui.menu_button(tr("Move to Bin"), |ui| {
            let ids: Vec<Id> = s.project.selected.iter().copied().collect();
            if ui.button(tr("Project")).clicked() {
                s.app.exec(&cmd::move_to_bin(&ids, None));
                ui.close();
            }
            for (id, name) in bins {
                if ui.button(name).clicked() {
                    s.app.exec(&cmd::move_to_bin(&ids, Some(id)));
                    ui.close();
                }
            }
        });
        ui.separator();
        if ui.add(Button::new(tr("Clear")).shortcut_text("Delete")).clicked() {
            if let Some(d) = s.project.remove_selected(&mut s.app) {
                s.dialog = Some(d);
            }
            ui.close();
        }
    });
}

/// The name, or the rename field while renaming it.
fn name_cell(s: &mut Shell, ui: &mut egui::Ui, e: &Entry, text: RichText) {
    let editing = s.project.renaming.as_ref().is_some_and(|r| r.0 == e.id);
    if !editing {
        ui.add(egui::Label::new(text).truncate().selectable(false));
        return;
    }
    let Some((id, buf, first)) = s.project.renaming.as_mut() else { return };
    let r = ui.add(egui::TextEdit::singleline(buf).desired_width(ui.available_width().min(220.0)));
    if *first {
        r.request_focus();
        *first = false;
    }
    let (enter, esc) = ui.input(|i| (i.key_pressed(Key::Enter), i.key_pressed(Key::Escape)));
    if esc {
        s.project.renaming = None;
    } else if r.lost_focus() || enter {
        let (id, name) = (*id, buf.trim().to_owned());
        s.project.renaming = None;
        if !name.is_empty() && name != e.name {
            s.app.exec(&cmd::rename_item(id, &name));
        }
    }
}

fn rows(s: &mut Shell, ui: &mut egui::Ui, list: &[Entry]) -> Option<Entry> {
    use crate::timeline::fit_text;
    let pal = s.palette.clone();
    let mut open = None;
    let w = ui.available_width().max(360.0);
    let cols = [
        (Column::Name, "Name", w * 0.40),
        (Column::Duration, "Duration", w * 0.20),
        (Column::Video, "Video", w * 0.15),
        (Column::Fps, "Frame Rate", w * 0.15),
        (Column::Uses, "Uses", w * 0.10),
    ];
    let starts: Vec<f32> = cols
        .iter()
        .scan(0.0, |x, c| {
            let at = *x;
            *x += c.2;
            Some(at)
        })
        .collect();
    let (head, _) = ui.allocate_exact_size(Vec2::new(w, 24.0), Sense::hover());
    for (i, (col, title, cw)) in cols.iter().enumerate() {
        let mark = match s.project.sort {
            Some((c, true)) if c == *col => " ▲",
            Some((c, false)) if c == *col => " ▼",
            _ => "",
        };
        let r = egui::Rect::from_min_size(head.min + Vec2::new(starts[i], 0.0), Vec2::new(*cw, 24.0));
        let resp = ui.interact(r, ui.scope_id().with(("sort", i)), Sense::click());
        resp.widget_info(|| egui::WidgetInfo::labeled(egui::Role::ColumnHeader, true, tr(title)));
        if resp.hovered() {
            ui.painter().rect_filled(r, 0.0, pal.gray[3]);
        }
        let pad = if i == 0 { 30.0 } else { 6.0 };
        fit_text(
            ui.painter(),
            r.min + Vec2::new(pad, 5.0),
            &format!("{}{mark}", tr(title)),
            cw - pad - 4.0,
            egui::FontId::proportional(12.5),
            pal.gray[9],
        );
        if resp.clicked() {
            s.project.sort = match s.project.sort {
                Some((c, asc)) if c == *col => Some((*col, !asc)),
                _ => Some((*col, true)),
            };
        }
    }
    ui.painter().hline(head.x_range(), head.bottom(), Stroke::new(1.0, pal.gray[3]));
    let row_h = 28.0;
    let font = egui::FontId::proportional(13.0);
    // only the rows in view are made; the space of the others is kept
    let (shown, before, after) = in_view(ui, list.len(), row_h + ui.spacing().item_spacing.y);
    ui.add_space(before);
    for e in &list[shown] {
        let selected = s.project.selected.contains(&e.id);
        // ids of the entries, not of the places: the rows made change as the list scrolls
        let rect = ui.allocate_exact_size(Vec2::new(w, row_h), Sense::hover()).0;
        let r = ui.interact(rect, egui::Id::unique(("cut-project-entry", e.id)), Sense::click_and_drag());
        r.widget_info(|| egui::WidgetInfo::labeled(entry_role(e), true, &e.name));
        if selected {
            ui.painter().rect_filled(rect, 0.0, pal.blue2);
        } else if r.hovered() {
            ui.painter().rect_filled(rect, 0.0, pal.gray[3]);
        }
        let name_color =
            if e.kind == EntryKind::Sequence && s.app.sequence_id == Some(e.id) { pal.accent } else { pal.gray[11] };
        let y = rect.top() + 6.0;
        let offline = crate::panels::media_marks::offline(s, e.id);
        ui.painter().text(
            egui::pos2(rect.left() + 10.0, rect.center().y),
            egui::Align2::LEFT_CENTER,
            if offline { crate::panels::media_marks::OFFLINE } else { kind_glyph(e) },
            font.clone(),
            if offline { pal.red } else { pal.gray[9] },
        );
        let badge = crate::panels::media_marks::badge(s, ui, e.id, rect.left() + cols[0].2 - 4.0, rect.center().y);
        let name_rect = egui::Rect::from_min_size(
            egui::pos2(rect.left() + 30.0, rect.top() + 2.0),
            Vec2::new(cols[0].2 - 34.0 - badge, row_h - 4.0),
        );
        if s.project.renaming.as_ref().is_some_and(|x| x.0 == e.id) {
            let mut child =
                ui.new_child(egui::UiBuilder::new().max_rect(name_rect).layout(Layout::left_to_right(Align::Center)));
            name_cell(s, &mut child, e, RichText::new(&e.name));
        } else {
            fit_text(
                ui.painter(),
                egui::pos2(name_rect.left(), y),
                &e.name,
                name_rect.width(),
                font.clone(),
                name_color,
            );
        }
        let duration = if offline { tr("Offline").into_owned() } else { e.duration.clone() };
        let uses = if e.uses > 0 { e.uses.to_string() } else { String::new() };
        for (i, text) in [&duration, &e.size, &e.fps, &uses].into_iter().enumerate() {
            let x = rect.left() + starts[i + 1] + 6.0;
            fit_text(ui.painter(), egui::pos2(x, y), text, cols[i + 1].2 - 10.0, font.clone(), pal.gray[9]);
        }
        if click(s, list, e, &r) {
            open = Some(e.clone());
        }
        drag_source(s, ui, e, &r);
        context_menu(s, e, &r);
    }
    ui.add_space(after);
    open
}

/// How an entry is named to screen readers (and tests): a media item as a button, a bin or sequence as a list item.
fn entry_role(e: &Entry) -> egui::Role {
    if e.kind == EntryKind::Media { egui::Role::Button } else { egui::Role::ListItem }
}

/// Of `n` rows `pitch` apart from the cursor down, the ones in view (one more each side) and the space before and
/// after them.
fn in_view(ui: &egui::Ui, n: usize, pitch: f32) -> (std::ops::Range<usize>, f32, f32) {
    let top = ui.cursor().top();
    let clip = ui.clip_rect();
    let first = (((clip.top() - top) / pitch).floor().max(0.0) as usize).saturating_sub(1).min(n);
    let last = ((((clip.bottom() - top) / pitch).ceil().max(0.0) as usize) + 1).clamp(first, n);
    (first..last, first as f32 * pitch, (n - last) as f32 * pitch)
}

/// Frames a media tile shows (ui-project.js `THUMB_H`, `SCRUB_FRAMES`): twelve across the file, one for a still.
const THUMB_H: u32 = 90;
const SCRUB_FRAMES: usize = 12;

fn poster(s: &mut Shell, e: &Entry) -> Option<std::sync::Arc<[egui::TextureHandle]>> {
    if e.kind != EntryKind::Media {
        return None;
    }
    let m = s.app.project().media(e.id)?.clone();
    let m = &m;
    if m.kind == MediaKind::Audio {
        return None;
    }
    let count = if m.kind == MediaKind::Image { 1 } else { SCRUB_FRAMES };
    let prefix = format!("panel|{}", crate::thumbs::file_key(m));
    s.thumbs.as_mut()?.strip(m, &prefix, 0.0, m.duration, count, THUMB_H)
}

fn icons(s: &mut Shell, ui: &mut egui::Ui, list: &[Entry]) -> Option<Entry> {
    let pal = s.palette.clone();
    let mut open = None;
    let tile = Vec2::new(150.0, 112.0);
    let gap = 8.0;
    ui.spacing_mut().item_spacing = Vec2::new(gap, gap);
    // rows of tiles as many across as fit; only the rows in view are made
    let across = (((ui.available_width() + gap) / (tile.x + gap)).floor() as usize).max(1);
    let (shown, before, after) = in_view(ui, list.len().div_ceil(across), tile.y + gap);
    ui.add_space(before);
    for row in shown {
        let cells = &list[row * across..((row + 1) * across).min(list.len())];
        ui.horizontal(|ui| {
            for e in cells {
                let selected = s.project.selected.contains(&e.id);
                let rect = ui.allocate_exact_size(tile, Sense::hover()).0;
                let r = ui.interact(rect, egui::Id::unique(("cut-project-entry", e.id)), Sense::click_and_drag());
                let painter = ui.painter_at(rect);
                let pic = egui::Rect::from_min_size(rect.min, Vec2::new(tile.x, 84.0));
                painter.rect_filled(pic, 4.0, Color32::from_rgb(0x0f, 0x10, 0x12));
                let offline = crate::panels::media_marks::offline(s, e.id);
                let frames = if ui.is_rect_visible(rect) && !offline { poster(s, e) } else { None };
                match frames {
                    // the frame under the pointer (`hoverScrub`), else the first
                    Some(list) => {
                        let i = r.hover_pos().map_or(0, |at| {
                            let f = ((at.x - pic.left()) / pic.width()).clamp(0.0, 0.999);
                            (f * list.len() as f32) as usize
                        });
                        let tex = &list[i.min(list.len() - 1)];
                        let size = tex.size_vec2();
                        let k = (pic.width() / size.x).min(pic.height() / size.y);
                        let at = egui::Rect::from_center_size(pic.center(), size * k);
                        let uv = egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0));
                        painter.image(tex.id(), at, uv, Color32::WHITE);
                    }
                    None => {
                        painter.text(
                            pic.center(),
                            egui::Align2::CENTER_CENTER,
                            if offline { crate::panels::media_marks::OFFLINE } else { kind_glyph(e) },
                            egui::FontId::proportional(28.0),
                            if offline { pal.red } else { pal.gray[8] },
                        );
                    }
                }
                crate::panels::media_marks::badge(s, ui, e.id, pic.right() - 4.0, pic.top() + 10.0);
                let duration =
                    if offline && !e.duration.is_empty() { tr("Offline").into_owned() } else { e.duration.clone() };
                if !duration.is_empty() {
                    painter.text(
                        pic.right_bottom() - Vec2::new(4.0, 4.0),
                        egui::Align2::RIGHT_BOTTOM,
                        &duration,
                        egui::FontId::monospace(10.0),
                        Color32::WHITE,
                    );
                }
                if selected {
                    painter.rect_stroke(rect.expand(2.0), 5.0, Stroke::new(2.0, pal.blue8), egui::StrokeKind::Outside);
                }
                let name_rect =
                    egui::Rect::from_min_max(egui::pos2(rect.left() + 4.0, pic.bottom() + 4.0), rect.right_bottom());
                let mut child =
                    ui.new_child(egui::UiBuilder::new().max_rect(name_rect).layout(Layout::left_to_right(Align::Min)));
                name_cell(s, &mut child, e, RichText::new(&e.name).color(pal.gray[11]).size(12.5));
                if click(s, list, e, &r) {
                    open = Some(e.clone());
                }
                drag_source(s, ui, e, &r);
                context_menu(s, e, &r);
            }
        });
    }
    ui.add_space(after);
    open
}
