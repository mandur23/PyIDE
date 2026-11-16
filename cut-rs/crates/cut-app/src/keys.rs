//! The editor's keyboard (port of `ui-keys.js`): every action with its title, its classic Nano Studio Cut keys and
//! its scope, the "Adobe Premiere Pro" preset (the default for new users) that replaces some of them, and the
//! matching of a key press to an action. A test reads `ui-keys.js` and checks this table against it.

use eframe::egui::{Key, Modifiers};

/// Where an action's key works: only in a panel that handles it, whatever has the keyboard, or even while typing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Panel,
    Global,
    Always,
}

/// One action: id (`Cut.<id>`), English title, classic keys, scope.
pub struct Action {
    pub id: &'static str,
    pub title: &'static str,
    pub keys: &'static [&'static str],
    pub scope: Scope,
}

const fn a(id: &'static str, title: &'static str, keys: &'static [&'static str]) -> Action {
    Action { id, title, keys, scope: Scope::Panel }
}

const fn g(id: &'static str, title: &'static str, keys: &'static [&'static str], scope: Scope) -> Action {
    Action { id, title, keys, scope }
}

use Scope::{Always, Global};

/// `ui-keys.js`'s `ACTIONS`, in its order, then the Window menu's panel actions (`ui-shell.js`).
pub const ACTIONS: &[Action] = &[
    a("playPause", "Play/Stop", &["Space"]),
    a("shuttleBack", "Shuttle Left", &["J"]),
    a("shuttleStop", "Shuttle Stop", &["K"]),
    a("shuttleForward", "Shuttle Right", &["L"]),
    a("playInToOut", "Play In to Out", &[]),
    a("frameBack", "Step Back One Frame", &["ArrowLeft"]),
    a("frameForward", "Step Forward One Frame", &["ArrowRight"]),
    a("frameBack5", "Step Back Five Frames", &["Shift+ArrowLeft"]),
    a("frameForward5", "Step Forward Five Frames", &["Shift+ArrowRight"]),
    a("prevEdit", "Go to Previous Edit Point", &["ArrowUp"]),
    a("nextEdit", "Go to Next Edit Point", &["ArrowDown"]),
    a("prevEditAny", "Go to Previous Edit Point on Any Track", &[]),
    a("nextEditAny", "Go to Next Edit Point on Any Track", &[]),
    a("goStart", "Go to Start", &["Home"]),
    a("goEnd", "Go to End", &["End"]),
    a("goIn", "Go to In", &["Shift+I"]),
    a("goOut", "Go to Out", &["Shift+O"]),
    a("markIn", "Mark In", &["I"]),
    a("markOut", "Mark Out", &["O"]),
    a("markClip", "Mark Clip", &["X"]),
    a("markSelection", "Mark Selection", &[]),
    a("clearIn", "Clear In", &[]),
    a("clearOut", "Clear Out", &[]),
    a("clearInOut", "Clear In and Out", &["Alt+X"]),
    a("addMarker", "Add Marker", &["M"]),
    a("nextMarker", "Go to Next Marker", &[]),
    a("prevMarker", "Go to Previous Marker", &[]),
    a("clearMarker", "Clear Current Marker", &[]),
    a("clearAllMarkers", "Clear All Markers", &[]),
    a("insert", "Insert", &[","]),
    a("overwrite", "Overwrite", &["."]),
    a("lift", "Lift", &[";"]),
    a("extract", "Extract", &["'"]),
    a("split", "Add Edit", &["Ctrl+K"]),
    a("splitAll", "Add Edit to All Tracks", &["Ctrl+Shift+K"]),
    a("rippleStart", "Ripple Trim Previous Edit to Playhead", &["Q"]),
    a("rippleEnd", "Ripple Trim Next Edit to Playhead", &["W"]),
    a("rippleDelete", "Ripple Delete", &["Shift+Delete"]),
    a("delete", "Clear", &["Delete", "Backspace"]),
    a("toggleEnabled", "Enable", &["Shift+E"]),
    a("link", "Link/Unlink", &["Ctrl+L"]),
    a("group", "Group", &["Ctrl+G"]),
    a("ungroup", "Ungroup", &["Ctrl+Shift+G"]),
    a("nest", "Nest…", &[]),
    a("nudgeLeft", "Nudge Clip Selection Left One Frame", &["Alt+ArrowLeft"]),
    a("nudgeRight", "Nudge Clip Selection Right One Frame", &["Alt+ArrowRight"]),
    a("nudgeLeft5", "Nudge Clip Selection Left Five Frames", &["Alt+Shift+ArrowLeft"]),
    a("nudgeRight5", "Nudge Clip Selection Right Five Frames", &["Alt+Shift+ArrowRight"]),
    a("nudgeUp", "Nudge Clip Selection Up", &[]),
    a("nudgeDown", "Nudge Clip Selection Down", &[]),
    a("selectAtPlayhead", "Select Clip at Playhead", &["D"]),
    a("matchFrame", "Match Frame", &["F"]),
    a("extendEdit", "Extend Selected Edit to Playhead", &["E"]),
    a("speed", "Speed/Duration…", &["Ctrl+R"]),
    a("freezeFrame", "Insert Frame Hold Segment", &["Shift+F"]),
    a("transitionVideo", "Apply Video Transition", &["Ctrl+D"]),
    a("transitionAudio", "Apply Audio Transition", &["Ctrl+Shift+D"]),
    a("transitionBoth", "Apply Default Transitions to Selection", &["Shift+D"]),
    a("cut", "Cut", &["Ctrl+X"]),
    a("copy", "Copy", &["Ctrl+C"]),
    a("paste", "Paste", &["Ctrl+V"]),
    a("pasteInsert", "Paste Insert", &["Ctrl+Shift+V"]),
    a("selectAll", "Select All", &["Ctrl+A"]),
    a("deselect", "Deselect All", &["Escape"]),
    a("tool.select", "Selection Tool", &["V"]),
    a("tool.trackForward", "Track Select Forward Tool", &["A"]),
    a("tool.trackBackward", "Track Select Backward Tool", &["Shift+A"]),
    a("tool.ripple", "Ripple Edit Tool", &["B"]),
    a("tool.roll", "Rolling Edit Tool", &["N"]),
    a("tool.rate", "Rate Stretch Tool", &["R"]),
    a("tool.razor", "Razor Tool", &["C"]),
    a("tool.slip", "Slip Tool", &["Y"]),
    a("tool.slide", "Slide Tool", &["U"]),
    a("tool.pen", "Pen Tool", &["P"]),
    a("tool.hand", "Hand Tool", &["H"]),
    a("tool.zoom", "Zoom Tool", &["Z"]),
    a("tool.text", "Type Tool", &["T"]),
    a("snap", "Snap in Timeline", &["S"]),
    a("zoomIn", "Zoom In", &["="]),
    a("zoomOut", "Zoom Out", &["-"]),
    a("zoomFit", "Zoom to Sequence", &["\\"]),
    a("videoTracksTaller", "Increase Video Tracks Height", &[]),
    a("videoTracksShorter", "Decrease Video Tracks Height", &[]),
    a("audioTracksTaller", "Increase Audio Tracks Height", &[]),
    a("audioTracksShorter", "Decrease Audio Tracks Height", &[]),
    a("expandTracks", "Expand All Tracks", &[]),
    a("minimizeTracks", "Minimize All Tracks", &[]),
    g("fullscreen", "Full Screen Playback", &["Ctrl+`"], Global),
    g("maximizePanel", "Maximize or Restore Active Frame", &[], Global),
    g("maximizeUnderCursor", "Maximize or Restore Frame Under Cursor", &[], Global),
    g("undo", "Undo", &["Ctrl+Z"], Global),
    g("redo", "Redo", &["Ctrl+Shift+Z", "Ctrl+Y"], Global),
    g("save", "Save Project", &["Ctrl+S"], Always),
    g("saveAs", "Save Project As…", &["Ctrl+Shift+S"], Always),
    g("saveCopy", "Save a Copy…", &[], Always),
    g("restoreAutosave", "Restore Autosave…", &[], Always),
    g("open", "Open Project…", &["Ctrl+O"], Always),
    g("newProject", "New Project", &["Ctrl+Alt+N"], Always),
    g("newSequence", "New Sequence…", &[], Global),
    g("newBin", "New Bin", &[], Global),
    g("import", "Import Media…", &["Ctrl+I"], Global),
    g("export", "Export Media…", &["Ctrl+M"], Always),
    g("exportFrame", "Export Frame…", &["Ctrl+Shift+E"], Global),
    g("workspace.editing", "Editing Workspace", &["Alt+Shift+1"], Always),
    g("workspace.color", "Color Workspace", &["Alt+Shift+2"], Always),
    g("workspace.effects", "Effects Workspace", &[], Always),
    g("workspace.audio", "Audio Workspace", &[], Always),
    g("workspace.captions", "Captions and Graphics Workspace", &["Alt+Shift+3"], Always),
    g("workspace.export", "Export Workspace", &["Alt+Shift+4"], Always),
    g("workspace.reset", "Reset to Saved Layout", &[], Always),
    g("keyHelp", "Keyboard Shortcut Overview", &["Shift+/"], Global),
    g("keyboardShortcuts", "Keyboard Shortcuts…", &[], Always),
    g("settings", "Video Editor Settings…", &[], Always),
    g("selectUnused", "Select Unused Media", &[], Global),
    g("removeUnused", "Remove Unused Media…", &[], Global),
    g("findMissing", "Find Missing Media…", &[], Global),
    g("createProxy", "Create Proxy", &[], Global),
    g("window.project", "Project", &[], Global),
    g("window.source", "Source", &[], Global),
    g("window.timeline", "Timeline", &[], Global),
    g("window.program", "Program", &[], Global),
    g("window.controls", "Effect Controls", &[], Global),
    g("window.mixer", "Audio Track Mixer", &[], Global),
    g("window.effects", "Effects", &[], Global),
];

/// `ui-keys.js`'s `PREMIERE`: Premiere Pro's default Windows keys where they differ from the classic ones.
pub const PREMIERE: &[(&str, &[&str])] = &[
    ("playInToOut", &["Ctrl+Shift+Space"]),
    ("prevEditAny", &["Shift+ArrowUp"]),
    ("nextEditAny", &["Shift+ArrowDown"]),
    ("markSelection", &["/"]),
    ("clearIn", &["Ctrl+Shift+I"]),
    ("clearOut", &["Ctrl+Shift+O"]),
    ("clearInOut", &["Ctrl+Shift+X"]),
    ("nextMarker", &["Shift+M"]),
    ("prevMarker", &["Ctrl+Shift+M"]),
    ("clearMarker", &["Ctrl+Alt+M"]),
    ("clearAllMarkers", &["Ctrl+Alt+Shift+M"]),
    ("nudgeUp", &["Alt+ArrowUp"]),
    ("nudgeDown", &["Alt+ArrowDown"]),
    ("deselect", &["Ctrl+Shift+A", "Escape"]),
    ("videoTracksTaller", &["Ctrl+="]),
    ("videoTracksShorter", &["Ctrl+-"]),
    ("audioTracksTaller", &["Alt+="]),
    ("audioTracksShorter", &["Alt+-"]),
    ("expandTracks", &["Shift+="]),
    ("minimizeTracks", &["Shift+-"]),
    ("maximizePanel", &["Shift+`"]),
    ("maximizeUnderCursor", &["`"]),
    ("saveCopy", &["Ctrl+Alt+S"]),
    ("newSequence", &["Ctrl+N"]),
    ("newBin", &["Ctrl+B"]),
    ("keyboardShortcuts", &["Ctrl+Alt+K"]),
    ("workspace.editing", &["Alt+Shift+1"]),
    ("workspace.color", &["Alt+Shift+2"]),
    ("workspace.effects", &["Alt+Shift+3"]),
    ("workspace.audio", &["Alt+Shift+4"]),
    ("workspace.captions", &["Alt+Shift+5"]),
    ("workspace.export", &["Alt+Shift+6"]),
    ("workspace.reset", &["Alt+Shift+0"]),
    ("window.project", &["Shift+1"]),
    ("window.source", &["Shift+2"]),
    ("window.timeline", &["Shift+3"]),
    ("window.program", &["Shift+4"]),
    ("window.controls", &["Shift+5"]),
    ("window.mixer", &["Shift+6"]),
    ("window.effects", &["Shift+7"]),
];

/// A keyboard preset (`cut.keyPreset`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Premiere,
    Classic,
}

impl Preset {
    pub fn code(self) -> &'static str {
        match self {
            Preset::Premiere => "premiere",
            Preset::Classic => "classic",
        }
    }

    pub fn from_code(s: &str) -> Option<Preset> {
        match s {
            "premiere" => Some(Preset::Premiere),
            "classic" => Some(Preset::Classic),
            _ => None,
        }
    }

    /// The English title of the preset.
    pub fn title(self) -> &'static str {
        match self {
            Preset::Premiere => "Adobe Premiere Pro",
            Preset::Classic => "Nano Studio Cut (classic)",
        }
    }
}

pub fn action(id: &str) -> Option<&'static Action> {
    ACTIONS.iter().find(|x| x.id == id)
}

/// The keys of an action in a preset (`presetKeys`).
pub fn keys_of(id: &str, preset: Preset) -> &'static [&'static str] {
    if preset == Preset::Premiere
        && let Some((_, k)) = PREMIERE.iter().find(|(x, _)| *x == id)
    {
        return k;
    }
    action(id).map_or(&[], |x| x.keys)
}

// The person's own keys (`cut.keys`, the shortcut editor's) belong to the thread that draws the screen, as the
// language does: each test's shell keeps its own.
thread_local! {
    static CUSTOM: std::cell::RefCell<std::collections::HashMap<String, Vec<String>>> = Default::default();
}

/// Replaces the person's own keys: action id (without `Cut.`) -> its keys, for the actions that differ from the preset.
pub fn set_custom(keys: std::collections::HashMap<String, Vec<String>>) {
    CUSTOM.with(|c| *c.borrow_mut() = keys);
}

/// The keys an action has now: the person's own when they changed it, else the preset's (`current`).
pub fn current(id: &str, preset: Preset) -> Vec<String> {
    CUSTOM
        .with(|c| c.borrow().get(id).cloned())
        .unwrap_or_else(|| keys_of(id, preset).iter().map(|k| (*k).to_owned()).collect())
}

/// A key combination as the keymap writes it (`Ctrl+Shift+K`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: Key,
}

fn key_named(name: &str) -> Option<Key> {
    Some(match name {
        "Space" => Key::Space,
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "ArrowUp" => Key::ArrowUp,
        "ArrowDown" => Key::ArrowDown,
        "Home" => Key::Home,
        "End" => Key::End,
        "Delete" => Key::Delete,
        "Backspace" => Key::Backspace,
        "Escape" => Key::Escape,
        "," => Key::Comma,
        "." => Key::Period,
        ";" => Key::Semicolon,
        "'" => Key::Quote,
        "/" => Key::Slash,
        "\\" => Key::Backslash,
        "`" => Key::Backtick,
        "=" => Key::Equals,
        "-" => Key::Minus,
        _ => Key::from_name(name)?,
    })
}

/// Parses `Ctrl+Alt+Shift+M`; `None` for a key this keyboard map cannot name.
pub fn parse(spec: &str) -> Option<Combo> {
    let mut c = Combo { ctrl: false, alt: false, shift: false, key: Key::Space };
    let (mods, key) = match spec.rsplit_once('+') {
        Some((m, "")) => (m.strip_suffix('+').unwrap_or(m), "+"),
        Some((m, k)) => (m, k),
        None => ("", spec),
    };
    for m in mods.split('+').filter(|m| !m.is_empty()) {
        match m {
            "Ctrl" => c.ctrl = true,
            "Alt" => c.alt = true,
            "Shift" => c.shift = true,
            _ => return None,
        }
    }
    c.key = key_named(key)?;
    Some(c)
}

/// Whether a key press is `combo`. Shifted punctuation arrives as its own key on some layouts (`?` for Shift+/,
/// `+` for Shift+=), so those count too.
pub fn matches(combo: Combo, key: Key, m: Modifiers) -> bool {
    let ctrl = m.ctrl || m.command;
    if combo.ctrl != ctrl || combo.alt != m.alt {
        return false;
    }
    if combo.key == key && combo.shift == m.shift {
        return true;
    }
    combo.shift
        && matches!(
            (combo.key, key),
            (Key::Slash, Key::Questionmark) | (Key::Equals, Key::Plus) | (Key::Num1, Key::Exclamationmark)
        )
}

/// The action a key press runs in a preset, among the actions whose scope allows it right now.
pub fn action_for(key: Key, m: Modifiers, preset: Preset, typing: bool) -> Option<&'static str> {
    ACTIONS.iter().find_map(|x| {
        if typing && x.scope != Scope::Always {
            return None;
        }
        current(x.id, preset).iter().filter_map(|s| parse(s)).any(|c| matches(c, key, m)).then_some(x.id)
    })
}

/// The first key of an action for a menu (`Ctrl+K`), or empty.
pub fn shown(id: &str, preset: Preset) -> String {
    current(id, preset).first().map(|k| k.replace("Arrow", "")).unwrap_or_default()
}
