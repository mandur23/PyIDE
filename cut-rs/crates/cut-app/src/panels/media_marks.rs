//! What the Project panel shows of offline media and proxies (`ui-project.js`'s `offline` marks, `proxyBadge`,
//! `contextItems` and footer, `ui-proxy.js`'s `needs`, `offer` and `offerBanner`):
//!
//! - an offline item has the warning glyph, "Offline" for its duration, Relink Media… in its menu, and a double click
//!   opens the relink dialog; the footer counts the offline items;
//! - a video's proxy shows as a badge after its name (`P`, `P 40%` while made), its state in the hover text;
//! - the menu has Create Proxy (Create Proxy Again), Cancel Proxy, Remove Proxy and Reveal in Explorer;
//! - after an import, video that is 4K or larger, HEVC, or has keyframes more than two seconds apart is offered proxies
//!   in a bar above the list (`proxyOffer` turns it off; Don't Ask for This Project remembers the project's key in
//!   `proxyDismissed`). The keyframes are read from the files' sample tables on a thread of its own.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, channel};

use cut_model::{Id, Media, MediaKind};
use cut_time::TICKS;
use eframe::egui::{self, Button, RichText};
use serde_json::{Value as Json, json};

use crate::i18n::{tr, trf};
use crate::prefs::proxy;
use crate::shell::Shell;
use crate::timeline::direct::badges::{self, ProxyMark};

/// The glyph of an offline item (Segoe MDL2 Assets' warning).
pub const OFFLINE: &str = "\u{E7BA}";

/// Keyframes further apart than this make a video slow to seek (`LONG_GOP_SECONDS`).
const LONG_GOP: i64 = 2 * TICKS;

/// The setting that remembers the projects whose offer was dismissed (`cut.proxy.dismissed`).
const DISMISSED: &str = "proxyDismissed";

/// Why a video would play better from a proxy (`needs`): `4k`, `hevc`, `gop`.
pub fn needs(m: &Media) -> Vec<&'static str> {
    let mut why = Vec::new();
    let Some(v) = m.video.as_ref().filter(|_| m.kind == MediaKind::Video) else { return why };
    if v.w * v.h >= 3840.0 * 2160.0 * 0.9 {
        why.push("4k");
    }
    let codec = v.extra.get("codec").and_then(Json::as_str).unwrap_or("");
    if codec.starts_with("hvc1") || codec.starts_with("hev1") {
        why.push("hevc");
    }
    if longest_gop(&m.path).is_some_and(|g| g > LONG_GOP) {
        why.push("gop");
    }
    why
}

/// The longest stretch between keyframes of a file's video, to its end (the loop of `needs`).
pub fn longest_gop(path: &str) -> Option<i64> {
    let reader = cut_formats::FileReader::open(std::path::Path::new(path)).ok()?;
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let src = cut_formats::probe::open(&reader, name);
    let t = src.tracks.iter().find(|t| t.kind() == cut_formats::Kind::Video)?;
    let s = &t.samples;
    let n = s.count();
    let (mut last, mut gap) = (None::<usize>, 0);
    for i in (0..n).filter(|i| s.key[*i]) {
        if let Some(l) = last {
            gap = gap.max(s.pts[i] - s.pts[l]);
        }
        last = Some(i);
    }
    let l = last?;
    Some(gap.max(s.pts[n - 1] + s.duration.get(n - 1).copied().unwrap_or(0) - s.pts[l]))
}

/// What the thread that reads new media says: each one that needs a proxy, and why.
type Needs = Vec<(Id, Vec<&'static str>)>;

/// The offer on import (`offered`), and what it knows of the open project's media.
#[derive(Debug, Default)]
pub struct Offer {
    /// The project (its autosave key) the media below belong to.
    key: Option<String>,
    known: HashSet<Id>,
    working: Option<Receiver<Needs>>,
    /// The media offered proxies, and why.
    pub offered: Vec<Id>,
    pub reasons: Vec<&'static str>,
}

fn dismissed(s: &Shell) -> Vec<String> {
    let list = s.doc.settings.get(DISMISSED).and_then(Json::as_array).cloned().unwrap_or_default();
    list.iter().filter_map(Json::as_str).map(str::to_owned).collect()
}

fn is_dismissed(s: &Shell) -> bool {
    dismissed(s).contains(&s.doc.key.to_lowercase())
}

/// Each frame: media that an import just added are checked for the offer (off the UI thread).
pub fn frame(s: &mut Shell, ctx: &egui::Context) {
    let key = s.doc.key.clone();
    let ids: HashSet<Id> = s.app.project().media.iter().map(|m| m.id).collect();
    let o = &mut s.project.offer;
    if o.key.as_deref() != Some(key.as_str()) {
        *o = Offer { key: Some(key), known: ids, ..Offer::default() };
        return;
    }
    if let Some(rx) = &o.working
        && let Ok(found) = rx.try_recv()
    {
        o.working = None;
        for (id, why) in found {
            if !o.offered.contains(&id) {
                o.offered.push(id);
            }
            for r in why {
                if !o.reasons.contains(&r) {
                    o.reasons.push(r);
                }
            }
        }
    }
    let new: Vec<Id> = ids.difference(&o.known).copied().collect();
    if new.is_empty() {
        o.known = ids;
        return;
    }
    o.known = ids;
    let imported = s.app.history.list().iter().rev().find(|e| e.done).is_some_and(|e| e.label == tr("Import"));
    if !imported || !crate::prefs::flag(&s.doc.settings, "proxyOffer") || is_dismissed(s) {
        return;
    }
    let list: Vec<Media> = s
        .app
        .project()
        .media
        .iter()
        .filter(|m| new.contains(&m.id) && m.proxy.is_none() && m.kind == MediaKind::Video)
        .cloned()
        .collect();
    if list.is_empty() {
        return;
    }
    let (tx, rx) = channel();
    let wake = ctx.clone();
    std::thread::spawn(move || {
        let found = list.iter().map(|m| (m.id, needs(m))).filter(|(_, w)| !w.is_empty()).collect();
        let _ = tx.send(found);
        wake.request_repaint();
    });
    s.project.offer.working = Some(rx);
}

fn reason_text(r: &str) -> String {
    match r {
        "4k" => "4K".to_owned(),
        "hevc" => "HEVC".to_owned(),
        _ => tr("keyframes far apart").into_owned(),
    }
}

/// The offer's bar above the list (`offerBanner`): the media still without a proxy or a job.
pub fn offer_bar(s: &mut Shell, ui: &mut egui::Ui) {
    let ids: Vec<Id> = s
        .project
        .offer
        .offered
        .iter()
        .copied()
        .filter(|id| s.app.project().media(*id).is_some_and(|m| m.proxy.is_none()) && !proxy::queued(s, *id))
        .collect();
    if ids.is_empty() {
        return;
    }
    let why = s.project.offer.reasons.iter().map(|r| reason_text(r)).collect::<Vec<_>>().join(", ");
    let pal = s.palette.clone();
    egui::Frame::new().fill(pal.blue2).inner_margin(egui::Margin::symmetric(8, 4)).show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new(trf(
                "{n} imported clips may play slowly ({why}). Make proxies for smooth playback?",
                &[("n", &ids.len().to_string()), ("why", &why)],
            )));
            if ui.button(tr("Create Proxies")).clicked() {
                s.project.offer.offered.clear();
                proxy::create(s, &ids);
            }
            if ui.button(tr("Don't Ask for This Project")).clicked() {
                let mut list = dismissed(s);
                list.push(s.doc.key.to_lowercase());
                let keep = list.len().saturating_sub(200);
                crate::prefs::set(s, DISMISSED, json!(list[keep..]));
                s.project.offer.offered.clear();
            }
        });
    });
}

/// Whether a Project panel entry is offline media.
pub fn offline(s: &Shell, id: Id) -> bool {
    s.features.prefs.relink.offline.contains(&id)
}

/// A media item's proxy as the panel shows it.
pub fn mark(s: &Shell, id: Id) -> Option<ProxyMark> {
    s.timeline.direct.marks.proxies.get(&id).cloned()
}

/// Draws the proxy badge ending at `right` on the line `y`, its state as the hover text -> the width it took.
pub fn badge(s: &Shell, ui: &mut egui::Ui, id: Id, right: f32, y: f32) -> f32 {
    let Some(m) = mark(s, id) else { return 0.0 };
    let r = badges::item(ui.painter(), &m, right, y);
    ui.interact(r, ui.scope_id().with(("proxy-badge", id)), egui::Sense::hover()).on_hover_text(m.text());
    r.width() + 4.0
}

/// The media items of a menu: the selected ones when `id` is among them, else `id`.
fn chosen(s: &Shell, id: Id) -> Vec<Id> {
    let sel = s.project.selected();
    if sel.contains(&id) {
        s.app.project().media.iter().filter(|m| sel.contains(&m.id)).map(|m| m.id).collect()
    } else {
        vec![id]
    }
}

/// The media items' part of the panel's menu (`contextItems`) after Open in Source Monitor.
pub fn context_items(s: &mut Shell, ui: &mut egui::Ui, id: Id) {
    let Some(m) = s.app.project().media(id).cloned() else { return };
    if offline(s, id) && ui.button(tr("Relink Media…")).clicked() {
        crate::prefs::relink::find_missing(s);
        ui.close();
    }
    if m.kind == MediaKind::Video {
        let ids: Vec<Id> = chosen(s, id);
        let busy = matches!(mark(s, id), Some(ProxyMark::Waiting | ProxyMark::Running(_) | ProxyMark::Paused));
        if busy {
            if ui.button(tr("Cancel Proxy")).clicked() {
                for i in &ids {
                    proxy::cancel(s, *i);
                }
                ui.close();
            }
        } else if ui.button(tr(if m.proxy.is_some() { "Create Proxy Again" } else { "Create Proxy" })).clicked() {
            if m.proxy.is_some() {
                proxy::remove(s, &ids);
            }
            proxy::create(s, &ids);
            ui.close();
        }
        if m.proxy.is_some() && ui.button(tr("Remove Proxy")).clicked() {
            proxy::remove(s, &ids);
            ui.close();
        }
    }
    if ui.add(Button::new(tr("Reveal in Explorer"))).clicked() {
        reveal_in_explorer(&m.path);
        ui.close();
    }
}

/// Shows a file in Explorer, selected (`cut:reveal`).
fn reveal_in_explorer(path: &str) {
    let p = PathBuf::from(path);
    let arg = if p.is_file() {
        format!("/select,{}", p.display())
    } else {
        p.parent().map_or_else(String::new, |d| d.display().to_string())
    };
    let _ = std::process::Command::new("explorer.exe").arg(arg).spawn();
}
