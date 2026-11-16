//! What the JavaScript editor's menus and actions have that the native app still lacks, found by comparing the two
//! sources, not remembered: every menu item of `renderer/features/cut/ui-*.js` (`label: tr('…')`, the menu bar's
//! `action('id')` items by their `ui-keys.js` title, `ui-auto.js`'s `ITEMS`) whose text is no string of
//! `cut-app/src` is *absent*; one the native menus show greyed (`later(ui, "…")`, `add_enabled(false, …)`, a
//! `("…", None)` entry) is *disabled*; and every action of the keymap (`keys::ACTIONS`) that neither the shell's table
//! (`actions::DONE`) nor a feature module (`features::enabled`) takes has *no action*. Any other `tr('…')` text of the
//! JavaScript's screens that the native app never shows (a dialog's message, a tooltip, a toast) is *text*: the hint of
//! a screen, a message or a check not ported, which a menu-item comparison alone misses (an item whose words appear
//! elsewhere in the native app, such as the track menu's Track Volume, passed it).
//!
//! Each gap must carry its reason in [`KNOWN`], and every entry of [`KNOWN`] must still be a gap: building an item
//! fails this test until its line is taken out here and in NEXT.md, so the list stays the truth. `--nocapture`
//! prints the table.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The gaps with the reason each is left: (kind, text, reason).
const KNOWN: &[(&str, &str, &str)] = &[
    // ---- AI and speech recognition: out of scope (NEXT.md) ----
    ("text", "ui-ai.js", AI),
    ("text", "ui-assistant.js", AI),
    ("text", "ui-control.js", "the control API an AI drives the editor through: AI"),
    ("text", "ui-speech.js", SPEECH),
    ("text", "ui-speakers.js", SPEECH),
    ("text", "ui-voice.js", "voice isolation (HTDemucs model): AI"),
    ("absent", "AI Assistant", AI),
    ("absent", "Add as Chapter Markers", AI),
    ("absent", "Ask Claude", AI),
    ("absent", "Claude", AI),
    ("absent", "Continue", AI),
    ("absent", "Create Shorts Sequence", AI),
    ("absent", "Disconnect", AI),
    ("absent", "Edit Command…", AI),
    ("absent", "Every caption of the track", AI),
    ("absent", "Fill the frame (crops the sides)", AI),
    ("absent", "Find Highlights", AI),
    ("absent", "Fit inside the frame (bars above and below)", AI),
    ("absent", "Highlights to Shorts…", AI),
    ("absent", "New Token", AI),
    ("absent", "Polish", AI),
    ("absent", "Polish Captions with Claude…", AI),
    ("absent", "Select None", AI),
    ("absent", "Send", AI),
    ("absent", "Stop", AI),
    ("absent", "The captions from In to Out", AI),
    ("absent", "The selected caption", AI),
    ("absent", "Translate", AI),
    ("absent", "Translate Captions with Claude…", AI),
    ("absent", "YouTube Title, Description and Chapters…", AI),
    ("text", "Polish or translate the captions with Claude", AI),
    ("text", "AI Assistant", AI),
    ("text", "Speakers", SPEECH),
    ("text", "unknown error", "the JavaScript's text for an error without a message; native errors always have one"),
    (
        "text",
        "Starting…",
        "the export's and the AI runtime's first progress line; the native Export shows its phase instead",
    ),
    ("absent", "Change Speaker", SPEECH),
    ("absent", "New Speaker", SPEECH),
    ("absent", "Rename Speaker…", SPEECH),
    ("absent", "Select Words of {name}", SPEECH),
    ("absent", "Create Captions", SPEECH),
    ("absent", "Detect automatically", SPEECH),
    ("absent", "Download", SPEECH),
    ("absent", "Fillers…", SPEECH),
    ("absent", "Korean", SPEECH),
    ("absent", "Next Uncertain Word", SPEECH),
    ("absent", "Previous Uncertain Word", SPEECH),
    ("absent", "Transcribe", SPEECH),
    ("absent", "Use {name}", SPEECH),
    ("absent", "Word List…", SPEECH),
    ("disabled", "Auto Captions…", SPEECH),
    ("disabled", "Label Speakers", SPEECH),
    ("disabled", "Remove Filler Words…", SPEECH),
    ("disabled", "Isolate Voice", "voice isolation (HTDemucs model): AI"),
    ("text", "Create captions from the speech (on this PC)", SPEECH),
    // ---- screens not built ----
    (
        "text",
        "Window: {panel}",
        "the Window menu's group title of the JavaScript's panel list; the native menu lists them flat",
    ),
    (
        "text",
        "Chapter {n}",
        "ui-export.js's chapter list for when export.js failed to load; export.js (ported) names an unnamed chapter \
         \"-\", and no editor writes chapters into the file (mp4write.js ignores them)",
    ),
    // ---- words only: labels for screen readers, tooltips, the IDE around the JavaScript editor, unreachable ----
    ("text", "Clip indicator", LABEL),
    ("text", "Curve Channel", LABEL),
    ("text", "Favorite", LABEL),
    ("text", "Menu Bar", LABEL),
    ("text", "Pan", LABEL),
    ("text", "Playhead Position", LABEL),
    ("text", "Playhead position", LABEL),
    ("text", "Sync Lock", LABEL),
    ("text", "Drag to change the track height", LABEL),
    ("text", "Burns in the caption track shown in the Captions panel: {name}", LABEL),
    ("text", "Creating proxy for {name}", IDE),
    (
        "text",
        "Waiting while the player plays",
        "the IDE task list's line for a paused proxy; the native app shows the Paused badge",
    ),
    ("text", "Export Settings", IDE),
    ("text", "Export of {name}", IDE),
    ("text", "Exporting {name}", IDE),
    ("text", "Exporting {name} (queue)", IDE),
    ("text", "Settings", IDE),
    ("text", "{key} is also {actions} outside the editor; here the editor takes it.", IDE),
    ("text", "Clip Speed/Duration", FALLBACK),
    ("text", "Reverse speed", FALLBACK),
    ("text", "Ripple edit, shifting trailing clips", FALLBACK),
    ("text", "The playhead is not on a video clip.", FALLBACK),
    (
        "text",
        "This clip does not match the sequence settings. Change the sequence to match the clip?",
        "the timeline's own question, unreachable: the Project panel's matchSequence (built) runs instead",
    ),
    ("text", "Measuring loudness…", "Match Loudness without its dialog: the control API's path (AI)"),
    (
        "text",
        "The analysis failed: {error}",
        "a failure without a code; the native analyses' only failure (the media) is reported as it is",
    ),
    ("text", "The effects are not available.", LOAD),
    ("text", "The export engine is not available.", LOAD),
    ("text", "This panel could not start.", LOAD),
    ("text", "Choose a preset.", "the native Export form always has a preset chosen"),
    (
        "text",
        "The folder has too many files; only the first ones were imported.",
        "the native folder import has no file limit",
    ),
];

const AI: &str = "AI (Claude): out of scope";
const SPEECH: &str = "speech recognition and speakers (Whisper, local models): out of scope";
const LABEL: &str = "a screen-reader label or tooltip only";
const IDE: &str = "the Electron IDE around the JavaScript editor (its task list, settings page, keymap)";
const FALLBACK: &str = "ui-keys.js's fallback handler, replaced in the JavaScript by the timeline's own (whose words the \
     native app uses)";
const LOAD: &str = "a JavaScript module that failed to load: no native equivalent";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

/// The quoted text starting at `s` (its first char is the quote), escapes kept as the character -> (text, rest).
fn quoted(s: &str) -> Option<(String, &str)> {
    let mut chars = s.char_indices();
    let (_, q) = chars.next()?;
    if q != '\'' && q != '"' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for (i, c) in chars {
        if escaped {
            out.push(c);
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == q {
            return Some((out, &s[i + 1..]));
        } else {
            out.push(c);
        }
    }
    None
}

/// Every text quoted right after `pat` in `line`.
fn after(line: &str, pat: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(i) = rest.find(pat) {
        // a whole word: `attr(` is not `tr(`
        let word = !rest[..i].chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.');
        rest = &rest[i + pat.len()..];
        if !word {
            continue;
        }
        if let Some((t, r)) = quoted(rest.trim_start()) {
            out.push(t);
            rest = r;
        }
    }
    out
}

/// The string literals of a Rust line (`'"'` is a char, not a string).
fn literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'"'
            && !(i > 0 && b[i - 1] == b'\'' && b.get(i + 1) == Some(&b'\''))
            && let Some((t, rest)) = quoted(&line[i..])
        {
            out.push(t);
            i = line.len() - rest.len();
            continue;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            break;
        }
        i += 1;
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The native app's strings, and those it shows greyed in a menu.
fn native() -> (BTreeSet<String>, BTreeSet<String>) {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let (mut all, mut greyed) = (BTreeSet::new(), BTreeSet::new());
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for (i, l) in lines.iter().enumerate() {
            let lits = literals(l);
            all.extend(lits.iter().cloned());
            if l.contains("add_enabled(false") {
                greyed.extend(lits.iter().cloned());
            }
            greyed.extend(after(l, "later(ui, "));
            let mut rest = *l;
            while let Some(k) = rest.find("\", None)") {
                if let Some(t) = literals(&rest[..k + 1]).last() {
                    greyed.insert(t.clone());
                }
                rest = &rest[k + 7..];
            }
            // `for label in [..] { later(ui, label); }`: the list of the loop just above
            if l.contains("later(ui, label)")
                && let Some(j) = (i.saturating_sub(2)..i).rev().find(|j| lines[*j].contains("for label in ["))
            {
                greyed.extend(literals(lines[j]));
            }
        }
    }
    (all, greyed)
}

/// The JavaScript's menu items `(text, file:line, is a menu item)`; every other `tr('…')` text of the screens too.
fn javascript() -> Vec<(String, String, bool)> {
    let dir = root().join("renderer/features/cut");
    let keys = std::fs::read_to_string(dir.join("ui-keys.js")).unwrap();
    let titles: BTreeMap<String, String> = keys
        .lines()
        .filter_map(|l| {
            let l = l.trim_start().strip_prefix('[')?;
            let (id, rest) = quoted(l)?;
            let (title, _) = quoted(rest.trim_start().strip_prefix(',')?.trim_start())?;
            Some((id, title))
        })
        .collect();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("ui-") && n.ends_with(".js"))
        .collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let text = std::fs::read_to_string(dir.join(&name)).unwrap();
        let mut in_items = false;
        for (i, l) in text.lines().enumerate() {
            let at = format!("{name}:{}", i + 1);
            let mut found: Vec<String> = after(l, "label: tr(").into_iter().chain(after(l, "label:tr(")).collect();
            if name == "ui-menubar.js" && !l.contains("label: tr(") {
                found.extend(after(l, "action(").into_iter().map(|id| titles.get(&id).cloned().unwrap_or(id)));
            }
            if name == "ui-auto.js" {
                in_items |= l.contains("const ITEMS = [");
                if in_items && l.trim() == "];" {
                    in_items = false;
                }
                if in_items
                    && let Some(r) = l.trim_start().strip_prefix('[')
                    && let Some((_, rest)) = quoted(r)
                    && let Some((label, _)) = rest.trim_start().strip_prefix(',').and_then(|x| quoted(x.trim_start()))
                {
                    found.push(label);
                }
            }
            let others: Vec<String> =
                after(l, "tr(").into_iter().filter(|t| !found.contains(t) && !t.is_empty()).collect();
            for t in found {
                out.push((t, at.clone(), true));
            }
            for t in others {
                out.push((t, at.clone(), false));
            }
        }
    }
    out
}

/// The keymap's actions nothing takes, in a shell with a sequence, a clip and a selection.
fn actions_without_code() -> Vec<String> {
    let dir = std::env::temp_dir().join(format!("cut-app-inventory-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = cut_app::shell::Shell::new(cut_app::files::Home::at(dir.clone()));
    s.dialog = None;
    let seq = s.app.sequence_id.unwrap();
    let r = s
        .app
        .exec(&serde_json::json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
            "source": { "generator": "solid", "color": "#ffffff" }, "at": 0, "duration": cut_time::TICKS, "track": "V1",
        } }))
        .unwrap();
    s.app.select([cut_model::Id::new(r["id"].as_str().unwrap())], false, false);
    let out = cut_app::keys::ACTIONS
        .iter()
        .map(|a| a.id)
        .filter(|id| cut_app::features::enabled(&s, id).is_none() && !cut_app::actions::DONE.contains(id))
        .map(str::to_owned)
        .collect();
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
fn every_gap_against_the_javascript_has_its_reason() {
    let (all, greyed) = native();
    let mut gaps: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for (text, at, item) in javascript() {
        let kind = match (item, all.contains(&text), greyed.contains(&text)) {
            (true, false, _) => "absent",
            (true, true, true) => "disabled",
            (false, false, _) => "text",
            _ => continue,
        };
        gaps.entry((kind.to_owned(), text)).or_default().insert(at);
    }
    for id in actions_without_code() {
        gaps.entry(("no action".to_owned(), id.clone())).or_default().insert("ui-keys.js".into());
    }
    // a reason names the text, or (`ui-x.js`) every gap of its kind found only in files named so
    let file_reason = |k: &str, at: &BTreeSet<String>| {
        let of = |x: &String| {
            KNOWN.iter().find(|(kk, tt, _)| *kk == k && tt.ends_with(".js") && x.starts_with(&format!("{tt}:")))
        };
        let first = at.iter().next().and_then(of)?;
        at.iter().all(|x| of(x).is_some()).then_some(first.2)
    };
    let reason = |k: &str, t: &str| {
        KNOWN
            .iter()
            .find(|(kk, tt, _)| *kk == k && *tt == t)
            .map(|x| x.2)
            .or_else(|| gaps.get(&(k.to_owned(), t.to_owned())).and_then(|at| file_reason(k, at)))
    };
    let mut table = String::new();
    for ((kind, text), at) in &gaps {
        let why = reason(kind, text).unwrap_or("?");
        let at: Vec<&str> = at.iter().map(String::as_str).collect();
        table.push_str(&format!("{kind}\t{text}\t{}\t{why}\n", at.join(" ")));
    }
    eprintln!("{} gaps:\n{table}", gaps.len());
    let unexplained: Vec<String> =
        gaps.keys().filter(|(k, t)| reason(k, t).is_none()).map(|(k, t)| format!("{k}: {t}")).collect();
    let stale: Vec<String> = KNOWN
        .iter()
        .filter(|(k, t, _)| {
            let file = t.ends_with(".js")
                && gaps.iter().any(|((kk, _), at)| kk == k && at.iter().any(|x| x.starts_with(&format!("{t}:"))));
            !file && !gaps.contains_key(&((*k).to_owned(), (*t).to_owned()))
        })
        .map(|(k, t, _)| format!("{k}: {t}"))
        .collect();
    assert!(unexplained.is_empty(), "gaps without a reason in KNOWN (and NEXT.md):\n{}", unexplained.join("\n"));
    assert!(stale.is_empty(), "built or gone, take them out of KNOWN and NEXT.md:\n{}", stale.join("\n"));
}
