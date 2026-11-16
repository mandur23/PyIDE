//! The person's own keyboard shortcuts (the model of `ui-shortcuts.js`, with `ide.js`'s `comboOf` and `validKey`):
//! the stored keys, the kinds the editor and the cheat sheet group actions by (`ui-keys.js` `KINDS`), and the
//! editor's draft with its conflicts, recording, Reset and Reset All.
//!
//! The keys are stored as the JavaScript stores its setting `cut.keys`: `{ "Cut.<action>": [keys] }`, only the
//! actions whose keys differ from the preset's, under the key [`SETTING`] of this app's settings file (the
//! JavaScript's settings live in Electron's folder, so the two never share the file).

use std::collections::{BTreeMap, HashMap};

use eframe::egui::{Key, Modifiers};
use serde_json::{Map, Value as Json};

use crate::i18n::tr;
use crate::keys::{self, ACTIONS, Preset};

/// The settings key of the person's own keys.
pub const SETTING: &str = "keys";

/// The kinds, in the editor's order: id and English title (`KINDS`).
pub const KINDS: [(&str, &str); 9] = [
    ("playback", "Playback and Navigation"),
    ("marks", "Marking"),
    ("tools", "Tools"),
    ("view", "View"),
    ("project", "Project"),
    ("media", "Media"),
    ("workspaces", "Workspaces and Panels"),
    ("automation", "Automation"),
    ("editing", "Editing"),
];

const PLAYBACK: [&str; 11] = [
    "playPause",
    "shuttle",
    "frame",
    "prevEdit",
    "nextEdit",
    "goStart",
    "goEnd",
    "goIn",
    "goOut",
    "fullscreen",
    "playInToOut",
];
const MARKS: [&str; 12] = [
    "markIn",
    "markOut",
    "markClip",
    "markSelection",
    "clearIn",
    "clearOut",
    "clearInOut",
    "addMarker",
    "nextMarker",
    "prevMarker",
    "clearMarker",
    "clearAllMarkers",
];
const VIEW: [&str; 12] = [
    "zoomIn",
    "zoomOut",
    "zoomFit",
    "keyHelp",
    "maximizePanel",
    "maximizeUnderCursor",
    "expandTracks",
    "minimizeTracks",
    "videoTracksTaller",
    "videoTracksShorter",
    "audioTracksTaller",
    "audioTracksShorter",
];
const PROJECT: [&str; 15] = [
    "undo",
    "redo",
    "save",
    "saveAs",
    "saveCopy",
    "restoreAutosave",
    "open",
    "newProject",
    "newSequence",
    "newBin",
    "import",
    "export",
    "exportFrame",
    "keyboardShortcuts",
    "settings",
];
const MEDIA: [&str; 4] = ["selectUnused", "removeUnused", "findMissing", "createProxy"];

/// The kind of an action (`kindOf`: the first kind whose pattern matches its id).
pub fn kind_of(id: &str) -> &'static str {
    if PLAYBACK.iter().any(|p| id.starts_with(p)) {
        "playback"
    } else if MARKS.contains(&id) {
        "marks"
    } else if id.starts_with("tool.") || id == "snap" {
        "tools"
    } else if VIEW.contains(&id) {
        "view"
    } else if PROJECT.contains(&id) {
        "project"
    } else if MEDIA.contains(&id) {
        "media"
    } else if id.starts_with("workspace.") || id.starts_with("window.") {
        "workspaces"
    } else if id.starts_with("auto.") {
        "automation"
    } else {
        "editing"
    }
}

const MODIFIER_NAMES: [&str; 4] = ["Control", "Alt", "Shift", "Meta"];

/// One stroke as `comboOf` writes it (`Ctrl+Alt+Shift+K`): `STROKE` and `validStroke`.
fn valid_stroke(s: &str) -> bool {
    let mut rest = s;
    for m in ["Ctrl+", "Alt+", "Shift+"] {
        rest = rest.strip_prefix(m).unwrap_or(rest);
    }
    let mut chars = rest.chars();
    let ok = match (chars.next(), chars.as_str()) {
        (Some(c), "") => !c.is_whitespace(),
        (Some(c), tail) => c.is_ascii_uppercase() && tail.chars().all(|c| c.is_ascii_alphanumeric()),
        (None, _) => false,
    };
    ok && !MODIFIER_NAMES.contains(&rest)
}

/// A key the keymap can store (`validKey`): one or two strokes, or `Shift Shift` / `Ctrl Ctrl`.
pub fn valid_key(k: &str) -> bool {
    k == "Shift Shift" || k == "Ctrl Ctrl" || (k.split(' ').count() <= 2 && k.split(' ').all(valid_stroke))
}

/// The stored keys as the keymap reads them (`parseKeymap`): lists of valid keys, each once; an action whose list
/// had only invalid keys is left out, an empty list (every key removed) is kept.
pub fn parse_stored(raw: Option<&Json>) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(Json::Object(m)) = raw else { return out };
    for (id, keys) in m {
        let Json::Array(list) = keys else { continue };
        let mut ok: Vec<String> = Vec::new();
        for k in list.iter().filter_map(Json::as_str).filter(|k| valid_key(k)) {
            if !ok.iter().any(|x| x == k) {
                ok.push(k.to_owned());
            }
        }
        if !ok.is_empty() || list.is_empty() {
            out.insert(id.clone(), ok);
        }
    }
    out
}

/// The custom keys of this editor's actions from the stored map (`Cut.` taken off the ids).
pub fn custom_of(stored: &BTreeMap<String, Vec<String>>) -> HashMap<String, Vec<String>> {
    stored.iter().filter_map(|(id, keys)| Some((id.strip_prefix("Cut.")?.to_owned(), keys.clone()))).collect()
}

/// The key name of `comboOf` (`keyName`: the code's letter or digit, the punctuation's character).
fn key_name(key: Key) -> Option<&'static str> {
    Some(match key {
        Key::Space => "Space",
        Key::ArrowLeft => "ArrowLeft",
        Key::ArrowRight => "ArrowRight",
        Key::ArrowUp => "ArrowUp",
        Key::ArrowDown => "ArrowDown",
        Key::Comma => ",",
        Key::Period => ".",
        Key::Semicolon => ";",
        Key::Quote => "'",
        Key::Slash | Key::Questionmark => "/",
        Key::Backslash => "\\",
        Key::Backtick => "`",
        Key::Equals | Key::Plus => "=",
        Key::Minus => "-",
        Key::OpenBracket => "[",
        Key::CloseBracket => "]",
        Key::Exclamationmark => "1",
        Key::Escape => "Escape",
        Key::Enter => "Enter",
        Key::Tab => "Tab",
        Key::Backspace => "Backspace",
        Key::Delete => "Delete",
        Key::Insert => "Insert",
        Key::Home => "Home",
        Key::End => "End",
        Key::PageUp => "PageUp",
        Key::PageDown => "PageDown",
        k => {
            let n = k.name();
            if n.len() == 1 || (n.starts_with('F') && n[1..].chars().all(|c| c.is_ascii_digit())) {
                n
            } else {
                return None;
            }
        }
    })
}

/// A key press as the keymap writes it (`comboOf`), or `None` for a key it cannot name.
pub fn combo_of(key: Key, m: Modifiers) -> Option<String> {
    let name = key_name(key)?;
    let shift = m.shift || matches!(key, Key::Questionmark | Key::Plus | Key::Exclamationmark);
    let ctrl = m.ctrl || m.command;
    Some(format!(
        "{}{}{}{name}",
        if ctrl { "Ctrl+" } else { "" },
        if m.alt { "Alt+" } else { "" },
        if shift { "Shift+" } else { "" }
    ))
}

/// A key as menus show it (`keymap.format`): arrows as arrows, Esc.
pub fn format(k: &str) -> String {
    match k {
        "Shift Shift" => tr("Double Shift").into_owned(),
        "Ctrl Ctrl" => tr("Double Ctrl").into_owned(),
        _ => k
            .split(' ')
            .collect::<Vec<_>>()
            .join(", ")
            .replace("ArrowUp", "↑")
            .replace("ArrowDown", "↓")
            .replace("ArrowLeft", "←")
            .replace("ArrowRight", "→")
            .replace("Escape", "Esc"),
    }
}

/// The shortcut editor's working copy (`open`'s `draft`, `preset`, `recording`).
#[derive(Debug, Clone)]
pub struct Draft {
    pub preset: Preset,
    /// Every action in the editor's order (by kind, then title) with its keys.
    pub keys: Vec<(&'static str, Vec<String>)>,
    pub recording: Option<&'static str>,
    pub query: String,
}

fn kind_index(id: &str) -> usize {
    let k = kind_of(id);
    KINDS.iter().position(|(x, _)| *x == k).unwrap_or(KINDS.len())
}

impl Draft {
    /// The draft of the keys as they are now.
    pub fn new(preset: Preset) -> Draft {
        let mut ids: Vec<&'static str> = ACTIONS.iter().map(|a| a.id).collect();
        ids.sort_by_cached_key(|id| (kind_index(id), tr(keys::action(id).map_or(*id, |a| a.title)).to_lowercase()));
        Draft {
            preset,
            keys: ids.into_iter().map(|id| (id, keys::current(id, preset))).collect(),
            recording: None,
            query: String::new(),
        }
    }

    /// An action's built-in keys in the draft's preset.
    pub fn builtin(&self, id: &str) -> Vec<String> {
        keys::keys_of(id, self.preset).iter().map(|k| (*k).to_owned()).collect()
    }

    pub fn keys_of(&self, id: &str) -> &[String] {
        self.keys.iter().find(|(x, _)| *x == id).map_or(&[], |(_, k)| k)
    }

    fn slot(&mut self, id: &str) -> Option<&mut Vec<String>> {
        self.keys.iter_mut().find(|(x, _)| *x == id).map(|(_, k)| k)
    }

    /// Another preset: every key starts from it (the person's own keys go).
    pub fn set_preset(&mut self, p: Preset) {
        self.preset = p;
        self.recording = None;
        self.reset_all();
    }

    /// Keys two actions or more have: key -> the actions.
    pub fn conflicts(&self) -> BTreeMap<String, Vec<&'static str>> {
        let mut by: BTreeMap<String, Vec<&'static str>> = BTreeMap::new();
        for (id, keys) in &self.keys {
            for k in keys {
                by.entry(k.clone()).or_default().push(id);
            }
        }
        by.retain(|_, ids| ids.len() > 1);
        by
    }

    /// The recorded key joins the action being recorded (once); recording stops.
    pub fn record(&mut self, combo: &str) {
        let Some(id) = self.recording.take() else { return };
        if valid_key(combo)
            && let Some(list) = self.slot(id)
            && !list.iter().any(|k| k == combo)
        {
            list.push(combo.to_owned());
        }
    }

    pub fn remove(&mut self, id: &str, key: &str) {
        if let Some(list) = self.slot(id) {
            list.retain(|k| k != key);
        }
    }

    pub fn reset(&mut self, id: &str) {
        let b = self.builtin(id);
        if let Some(list) = self.slot(id) {
            *list = b;
        }
    }

    pub fn reset_all(&mut self) {
        for i in 0..self.keys.len() {
            self.keys[i].1 = self.builtin(self.keys[i].0);
        }
        self.recording = None;
    }

    pub fn modified(&self, id: &str) -> bool {
        self.keys_of(id) != self.builtin(id).as_slice()
    }

    pub fn any_modified(&self) -> bool {
        self.keys.iter().any(|(id, _)| self.modified(id))
    }

    /// The actions the search shows, by kind (`render`'s filter: the title or one of the keys contains it).
    pub fn rows(&self) -> Vec<(&'static str, Vec<&'static str>)> {
        let q = self.query.trim().to_lowercase();
        let mut out: Vec<(&'static str, Vec<&'static str>)> = Vec::new();
        for (id, keys) in &self.keys {
            let title = keys::action(id).map_or(*id, |a| a.title);
            let hit = q.is_empty()
                || title.to_lowercase().contains(&q)
                || tr(title).to_lowercase().contains(&q)
                || keys.iter().any(|k| k.to_lowercase().contains(&q) || format(k).to_lowercase().contains(&q));
            if !hit {
                continue;
            }
            let kind = kind_of(id);
            match out.last_mut() {
                Some((k, list)) if *k == kind => list.push(id),
                _ => out.push((kind, vec![id])),
            }
        }
        out
    }

    /// What Save stores (`cut.keys`): the stored keys of actions this editor does not list, then every action whose
    /// keys differ from the preset's.
    pub fn stored(&self, old: &BTreeMap<String, Vec<String>>) -> Json {
        let mut out = Map::new();
        for (id, keys) in old {
            if !self.keys.iter().any(|(x, _)| format!("Cut.{x}") == *id) {
                out.insert(id.clone(), Json::from(keys.clone()));
            }
        }
        for (id, keys) in &self.keys {
            if self.modified(id) {
                out.insert(format!("Cut.{id}"), Json::from(keys.clone()));
            }
        }
        Json::Object(out)
    }
}
