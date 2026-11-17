//! Nano Studio's own settings (`%APPDATA%\Nano Studio\settings.json`, named by the launcher's `CUT_STUDIO_SETTINGS`),
//! where the JavaScript Cut kept its `cut.*` settings beside the app-wide `appearance.language` and
//! `appearance.theme` that Code and Craft use.
//!
//! Two ways in, by how the values live on:
//! - The `cut.*` settings are copied once ([`carry_over`]): no installed program writes them any more, so a copy is
//!   all a read-through would give, and after it this app's file stands alone (a setting this app later removes does
//!   not come back from the old file). Each goes to the name [`TABLE`] gives it, only when this app has no value of
//!   its own; the marker [`MARKER`] in this app's settings says it was done.
//! - The language and the theme are read at each start while this app has none of its own ([`language`],
//!   [`theme`]), since Code and Craft still change them; `system` follows Windows. Nothing is written back.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{Map, Value as Json, json};

use crate::files::Settings;
use crate::i18n::Lang;
use crate::theme::ThemeKind;

/// The setting in this app's file that says the JavaScript Cut's settings were carried over (when, from where).
pub const MARKER: &str = "studioCarriedOver";

/// Where a JavaScript setting goes in this app's settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Carry {
    /// Copied under this name; the value's shape is the JavaScript's.
    To(&'static str),
    /// Copied under this name, which this app does not read yet; kept so a later version finds the person's choice.
    Kept(&'static str),
    /// Not copied, and why.
    Not(&'static str),
}

/// Every setting the JavaScript Cut kept in Nano Studio's settings file (`ui-*.js`, `main/features/cut.js`), with
/// where it goes. A name ending in `.` stands for every setting under it (`cut.auto.<job>`, `cut.layout.<workspace>`).
pub const TABLE: &[(&str, Carry)] = &[
    ("cut.keyPreset", Carry::To("keyPreset")),
    ("cut.keys", Carry::To("keys")),
    ("cut.workspace", Carry::To("workspace")),
    ("cut.autosave.minutes", Carry::To("autosaveMinutes")),
    ("cut.autosave.keep", Carry::To("autosaveKeep")),
    ("cut.cacheLimitGB", Carry::To("cacheLimitGB")),
    ("cut.transitionSeconds", Carry::To("transitionSeconds")),
    ("cut.stillSeconds", Carry::To("stillSeconds")),
    // the Settings page's quality; the Program monitor's own (below) wins, as it was what the monitor played at
    ("cut.quality", Carry::To("quality")),
    ("cut.program.quality", Carry::To("quality")),
    ("cut.source.quality", Carry::Kept("source.quality")),
    ("cut.program.safe", Carry::To("program.safe")),
    ("cut.source.safe", Carry::Kept("source.safe")),
    ("cut.program.buttons", Carry::To("program.buttons")),
    ("cut.source.buttons", Carry::To("source.buttons")),
    ("cut.proxy", Carry::To("proxy")),
    ("cut.proxy.offer", Carry::To("proxyOffer")),
    ("cut.proxy.height", Carry::To("proxyHeight")),
    ("cut.proxy.dismissed", Carry::To("proxyDismissed")),
    ("cut.timelineTools", Carry::To("timelineTools")),
    ("cut.speech.model", Carry::To("speech.model")),
    ("cut.speech.language", Carry::To("speech.language")),
    ("cut.speech.lineChars", Carry::To("speech.lineChars")),
    ("cut.speech.markUncertain", Carry::To("speech.markUncertain")),
    ("cut.speech.isolateVoice", Carry::To("speech.isolateVoice")),
    ("cut.speech.highlight", Carry::To("speech.highlight")),
    ("cut.ai.model", Carry::To("ai.model")),
    ("cut.ai.acknowledged", Carry::To("ai.acknowledged")),
    ("cut.ai.highlights", Carry::To("ai.highlights")),
    ("cut.ai.shortsFit", Carry::To("ai.shortsFit")),
    ("cut.auto.", Carry::To("auto.")),
    ("cut.color.collapsed", Carry::To("color.collapsed")),
    ("cut.scopes.show", Carry::To("scopes.show")),
    ("cut.effectFavorites", Carry::To("effectFavorites")),
    ("cut.defaultVideoTransition", Carry::To("defaultVideoTransition")),
    ("cut.defaultAudioTransition", Carry::To("defaultAudioTransition")),
    ("cut.export.preset", Carry::Kept("export.preset")),
    ("cut.project.view", Carry::Kept("project.view")),
    ("cut.speakers.captions", Carry::Kept("speakers.captions")),
    ("cut.toolGroups", Carry::Kept("toolGroups")),
    ("cut.addedPanels", Carry::Kept("addedPanels")),
    ("cut.aiDock", Carry::Kept("aiDock")),
    ("cut.control.external", Carry::To("control.external")),
    ("cut.assistant.acknowledged", Carry::Kept("assistant.acknowledged")),
    // the AI servers' idle time is app-wide (Code's AI page sets it too); copied once like the rest
    ("ai.idleUnloadMinutes", Carry::To("ai.idleUnloadMinutes")),
    (
        "cut.layoutSaved",
        Carry::Not(
            "the JavaScript saved flex shares of its DOM rows and slots, this app saves points per splitter and the tabs",
        ),
    ),
    ("cut.layout.", Carry::Not("the same flex shares, for the layout last used in each workspace")),
    ("cut.exportSpeed", Carry::Not("kept in the page's localStorage, not in the settings file; measured again")),
];

/// The names in the JavaScript sources that look like settings and are not: `Symbol.for('cut.revision')`, the
/// script name `cut.js`.
pub const NOT_SETTINGS: [&str; 2] = ["cut.revision", "cut.js"];

/// The [`TABLE`] row of `key`: its own, or its family's (`cut.auto.duck` is `cut.auto.`'s).
pub fn row_of(key: &str) -> Option<(&'static str, Carry)> {
    TABLE
        .iter()
        .copied()
        .find(|&(js, _)| js == key || (js.ends_with('.') && key.len() > js.len() && key.starts_with(js)))
}

/// The name `key` is copied to (a family's member keeps its own end: `cut.auto.duck` -> `auto.duck`); `None` for a
/// setting that is not copied or not the JavaScript Cut's.
pub fn target_of(key: &str) -> Option<String> {
    let (js, Carry::To(to) | Carry::Kept(to)) = row_of(key)? else { return None };
    Some(if js.ends_with('.') { format!("{to}{}", &key[js.len()..]) } else { to.to_owned() })
}

/// Nano Studio's settings as read at start.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Studio {
    /// The file the launcher named.
    pub file: PathBuf,
    /// Its values; `None` when it is missing or not a JSON object (a new install, before Code first ran).
    pub values: Option<Map<String, Json>>,
}

impl Studio {
    /// Reads `file`.
    pub fn read(file: &Path) -> Studio {
        let values = match std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Json>(&b).ok()) {
            Some(Json::Object(m)) => Some(m),
            _ => None,
        };
        Studio { file: file.to_owned(), values }
    }

    fn get(&self, key: &str) -> Option<&Json> {
        self.values.as_ref()?.get(key)
    }
}

static STUDIO: OnceLock<Option<Studio>> = OnceLock::new();

/// Reads the file `CUT_STUDIO_SETTINGS` names, once for the process (the app's start; tests leave it unset).
pub fn init_from_env() -> Option<&'static Studio> {
    STUDIO
        .get_or_init(|| {
            std::env::var_os("CUT_STUDIO_SETTINGS").filter(|v| !v.is_empty()).map(|f| Studio::read(Path::new(&f)))
        })
        .as_ref()
}

/// Nano Studio's settings when the app was started by it.
pub fn get() -> Option<&'static Studio> {
    STUDIO.get().and_then(Option::as_ref)
}

/// The JavaScript Cut's export journal (`main/features/cut.js`: `<userData>\cut-exports`, beside the settings file).
pub fn js_export_journal() -> Option<PathBuf> {
    Some(get()?.file.parent()?.join("cut-exports"))
}

/// Copies the JavaScript Cut's settings into `settings` once (see the module) -> the names written. Nothing is done
/// when the marker is there or Nano Studio's file could not be read (it is tried again at the next start).
pub fn carry_over(settings: &mut Settings, studio: &Studio, now_ms: i64) -> Vec<String> {
    let Some(values) = &studio.values else { return Vec::new() };
    if settings.get(MARKER).is_some() {
        return Vec::new();
    }
    let mut keys: Vec<&String> = values.keys().collect();
    // `cut.program.quality` after `cut.quality`, so the monitor's own quality is the one kept
    keys.sort_by_key(|k| k.as_str() == "cut.program.quality");
    let mut written = Vec::new();
    for key in keys {
        let Some(to) = target_of(key) else { continue };
        let value = &values[key.as_str()];
        let carried = written.contains(&to);
        // this app's own value stays; one carried a moment ago (`quality`) may be replaced
        if value.is_null() || (settings.get(&to).is_some() && !carried) {
            continue;
        }
        settings.set(&to, value.clone());
        if !carried {
            written.push(to);
        }
    }
    settings.set(MARKER, json!({ "at": now_ms, "from": studio.file.to_string_lossy(), "keys": written.len() }));
    written
}

/// The app's start: reads Nano Studio's settings ([`init_from_env`]) and carries the JavaScript Cut's over into the
/// workspace `home`'s settings, saved, when that was not done yet.
pub fn start(home: &Path, now_ms: i64) {
    let Some(studio) = init_from_env() else { return };
    let mut settings = Settings::load(home);
    if studio.values.is_some() && settings.get(MARKER).is_none() {
        carry_over(&mut settings, studio, now_ms);
        if let Err(e) = settings.save() {
            eprintln!("the JavaScript Cut's settings were not carried over: {e}");
        }
    }
}

/// The language `appearance.language` asks for: `en`, `ko`, else (`system`, unset, a file not there yet) Windows'
/// display language, as `renderer/core/i18n.js` reads `navigator.language`.
pub fn language_of(studio: &Studio, system: impl FnOnce() -> Option<String>) -> Lang {
    match studio.get("appearance.language").and_then(Json::as_str).and_then(Lang::from_code) {
        Some(l) => l,
        None if system().is_some_and(|l| l.to_lowercase().starts_with("ko")) => Lang::Ko,
        None => Lang::En,
    }
}

/// What `appearance.theme` asks for: a theme, or `None` for Windows' (`system`; a new install, whose file is not
/// written yet, starts so, as `i18n.js` makes it). A file without the setting is Dark, as for Code.
pub fn theme_of(studio: &Studio) -> Option<ThemeKind> {
    match (&studio.values, studio.get("appearance.theme").and_then(Json::as_str)) {
        (None, _) | (Some(_), Some("system")) => None,
        (Some(_), Some("light")) => Some(ThemeKind::Light),
        _ => Some(ThemeKind::Dark),
    }
}

/// The language for a start without one of this app's own: Nano Studio's when it started the app, else none.
pub fn language() -> Option<Lang> {
    Some(language_of(get()?, sys_locale::get_locale))
}

/// The theme for a start without one of this app's own: Nano Studio's, `system` read from `system` (the window's,
/// [`eframe::egui::Context::system_theme`]); `None` when Nano Studio did not start the app.
pub fn theme(system: Option<eframe::egui::Theme>) -> Option<ThemeKind> {
    let studio = get()?;
    Some(theme_of(studio).unwrap_or(match system {
        Some(eframe::egui::Theme::Light) => ThemeKind::Light,
        _ => ThemeKind::Dark,
    }))
}
