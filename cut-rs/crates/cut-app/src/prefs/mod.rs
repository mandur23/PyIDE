//! Preferences (`ui-settings.js`), the keyboard shortcut editor and the cheat sheet (`ui-shortcuts.js`), proxies
//! (`ui-proxy.js`) and relinking offline media (`ui-project.js`'s relink dialog, `main/cut/find.js`).
//!
//! The settings are this app's settings file (`<home>\.cut-rs\settings.json`, [`crate::files::Settings`]) under the
//! JavaScript's names without `cut.`; [`get`] gives a setting or its default as `DEFAULTS` does. The windows are egui
//! modals drawn on the UI thread; proxies are made by `cut_export::run` on a thread of their own and relinking probes
//! and searches folders on threads too, so the window keeps drawing.

pub mod keymap;
pub mod page;
pub mod proxy;
pub mod relink;
pub mod shortcuts;

use eframe::egui;
use serde_json::{Value as Json, json};

use crate::shell::Shell;

/// A setting's default (`DEFAULTS`), by this app's key.
pub fn default_of(key: &str) -> Json {
    match key {
        "autosaveMinutes" => json!(5),
        "autosaveKeep" => json!(20),
        "cacheLimitGB" => json!(10),
        "transitionSeconds" => json!(1),
        "stillSeconds" => json!(5),
        "quality" => json!(1),
        "proxy" => json!(false),
        "proxyOffer" => json!(true),
        "proxyHeight" => json!(720),
        "speech.markUncertain" => json!(true),
        _ => Json::Null,
    }
}

/// A setting as a number, or its default (a number written as text counts, as `cacheLimitGB` once was).
pub fn number(s: &crate::files::Settings, key: &str) -> f64 {
    let v = s.get(key);
    v.and_then(Json::as_f64)
        .or_else(|| v.and_then(Json::as_str).and_then(|t| t.parse().ok()))
        .unwrap_or_else(|| default_of(key).as_f64().unwrap_or(0.0))
}

/// A setting as a flag, or its default.
pub fn flag(s: &crate::files::Settings, key: &str) -> bool {
    s.get(key).and_then(Json::as_bool).unwrap_or_else(|| default_of(key).as_bool().unwrap_or(false))
}

/// `seconds(k, lo, hi)`: the setting when it is in range, else its default.
pub fn seconds(s: &crate::files::Settings, key: &str, lo: f64, hi: f64) -> f64 {
    let v = number(s, key);
    if v.is_finite() && (lo..=hi).contains(&v) { v } else { default_of(key).as_f64().unwrap_or(lo) }
}

/// Sets and saves a setting.
pub fn set(s: &mut Shell, key: &str, value: Json) {
    s.doc.settings.set(key, value);
    let _ = s.doc.settings.save();
}

/// The project settings a new project takes (`projectDefaults`): whole ticks, one at least.
pub fn project_defaults(s: &crate::files::Settings) -> (i64, i64) {
    let ticks = |v: f64| ((v * cut_time::TICKS as f64).round() as i64).max(1);
    (ticks(seconds(s, "transitionSeconds", 0.04, 60.0)), ticks(seconds(s, "stillSeconds", 0.04, 3600.0)))
}

/// The open project follows a changed default duration as one undo step (`applyDurations`).
pub fn apply_durations(s: &mut Shell) {
    if s.app.history.grouping() {
        return;
    }
    let (transition, still) = project_defaults(&s.doc.settings);
    let have = &s.app.project().settings;
    let mut patch = serde_json::Map::new();
    for (k, want) in [("transitionDuration", transition), ("stillDuration", still)] {
        if have.get(k).and_then(Json::as_i64) != Some(want) {
            patch.insert(k.into(), json!(want));
        }
    }
    if !patch.is_empty() {
        s.app.exec(&cut_model::commands::build::set_settings(Json::Object(patch)));
    }
}

/// The modal on screen.
pub enum Screen {
    Settings(page::Page),
    Shortcuts(keymap::Draft),
    Relink,
}

/// The state of these screens.
#[derive(Default)]
pub struct Prefs {
    pub screen: Option<Screen>,
    /// The cheat sheet (`?`) is open: since this frame.
    pub sheet: Option<u64>,
    pub page: page::PageState,
    pub proxy: proxy::Proxies,
    pub relink: relink::Relink,
}

/// The person's own keys from the settings, put on the keyboard (`apply`).
pub fn start(doc: &crate::doc::Doc) {
    let stored = keymap::parse_stored(doc.settings.get(keymap::SETTING));
    crate::keys::set_custom(keymap::custom_of(&stored));
}

/// Whether these screens take every key press now (the shell's keys wait): a modal, the cheat sheet.
pub fn takes_keys(s: &Shell) -> bool {
    s.features.prefs.screen.is_some() || s.features.prefs.sheet.is_some()
}

/// `Some(can run now)` for this feature's actions.
pub fn enabled(s: &Shell, id: &str) -> Option<bool> {
    match id {
        "settings" | "keyboardShortcuts" | "keyHelp" | "findMissing" | "proxy.toggle" => Some(true),
        // as the JavaScript's: always there, it says what to choose (`ui-proxy.js` `createProxy`, `create`)
        "createProxy" => Some(true),
        "proxy.cancel" => Some(proxy::chosen(s).iter().any(|id| proxy::queued(s, *id))),
        "proxy.remove" => {
            Some(proxy::chosen(s).iter().any(|id| s.app.project().media(*id).is_some_and(|m| m.proxy.is_some())))
        }
        _ if page::Page::from_id(id).is_some() => Some(true),
        _ => None,
    }
}

/// Runs one of this feature's actions -> whether it was one.
pub fn run(s: &mut Shell, id: &str, ctx: &egui::Context) -> bool {
    match id {
        "settings" => s.features.prefs.screen = Some(Screen::Settings(page::Page::Autosave)),
        "keyboardShortcuts" => {
            s.features.prefs.sheet = None;
            s.features.prefs.screen = Some(Screen::Shortcuts(keymap::Draft::new(s.preset)));
        }
        "keyHelp" => {
            let p = &mut s.features.prefs;
            p.sheet = if p.sheet.is_some() { None } else { Some(ctx.cumulative_frame_nr()) };
        }
        "findMissing" => relink::find_missing(s),
        "createProxy" => {
            let ids: Vec<cut_model::Id> = s.project.selected().iter().copied().collect();
            if ids.is_empty() {
                s.app.toast(crate::i18n::tr("Select video media in the Project panel first."));
            } else {
                proxy::create(s, &ids);
            }
        }
        "proxy.cancel" => {
            for id in proxy::chosen(s) {
                proxy::cancel(s, id);
            }
        }
        "proxy.remove" => {
            let ids = proxy::chosen(s);
            proxy::remove(s, &ids);
        }
        "proxy.toggle" => {
            let on = !flag(&s.doc.settings, "proxy");
            set(s, "proxy", json!(on));
        }
        _ => match page::Page::from_id(id) {
            Some(p) => s.features.prefs.screen = Some(Screen::Settings(p)),
            None => return false,
        },
    }
    true
}

/// This feature's windows, each frame, and the monitors' settings.
pub fn windows(s: &mut Shell, ctx: &egui::Context) {
    let playing = s.transport.playing();
    let q = number(&s.doc.settings, "quality");
    let quality = if playing && [0.5, 0.25].contains(&q) { q } else { 1.0 };
    let proxy_on = flag(&s.doc.settings, "proxy");
    if let Some(m) = &mut s.monitors {
        m.proxy = proxy_on;
        m.quality = quality;
    }
    proxy::poll(s, ctx);
    relink::poll(s, ctx);
    match &s.features.prefs.screen {
        Some(Screen::Settings(_)) => page::show(s, ctx),
        Some(Screen::Shortcuts(_)) => shortcuts::editor(s, ctx),
        Some(Screen::Relink) => relink::dialog(s, ctx),
        None => {}
    }
    if s.features.prefs.sheet.is_some() {
        shortcuts::sheet(s, ctx);
    }
}

/// A label `w` points wide, left aligned, cut with an ellipsis when it is longer (the dialogs' table cells).
pub fn cell(ui: &mut egui::Ui, w: f32, text: impl Into<egui::WidgetText>) -> egui::Response {
    let layout = egui::Layout::left_to_right(egui::Align::Center);
    ui.allocate_ui_with_layout(egui::vec2(w, 20.0), layout, |ui| {
        ui.set_width(w);
        ui.add(egui::Label::new(text).truncate())
    })
    .inner
}

/// The Program monitor's Proxy switch (`cut-tr-proxy`): the setting `proxy`.
pub fn proxy_switch(s: &mut Shell, ui: &mut egui::Ui) {
    let on = flag(&s.doc.settings, "proxy");
    let pal = s.palette.clone();
    let text =
        egui::RichText::new(crate::i18n::tr("Proxy")).size(12.0).color(if on { pal.accent } else { pal.gray[9] });
    if ui
        .add(egui::Button::new(text).selected(on).frame(false))
        .on_hover_text(crate::i18n::tr("Play Proxies"))
        .clicked()
    {
        set(s, "proxy", json!(!on));
    }
}
