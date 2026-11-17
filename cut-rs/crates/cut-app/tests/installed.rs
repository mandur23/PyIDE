//! What a person who used the installed JavaScript Cut keeps in this one: the `cut.*` settings carried over from
//! Nano Studio's settings file, its language and theme, the old export journal's leftovers cleaned, the Claude Code
//! lookup Nano Studio's launcher hands over, the crash message, the autosave an update's close request writes, and
//! Help › Check for Updates… starting Nano Studio's updater.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use cut_app::ai::claude::{Cli, switch_of};
use cut_app::files::{Home, Settings};
use cut_app::i18n::Lang;
use cut_app::keys::Preset;
use cut_app::shell::Shell;
use cut_app::studio::{self, Carry, MARKER, Studio, TABLE};
use cut_app::theme::ThemeKind;
use serde_json::{Map, Value as Json, json};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn scratch(name: &str) -> PathBuf {
    let base = std::env::var_os("CUT_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!("cut-installed-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn studio_of(values: Json) -> Studio {
    Studio { file: PathBuf::from("C:\\x\\settings.json"), values: values.as_object().cloned() }
}

/// A JavaScript-shaped value for every row of the table (a family: one member), each different from the defaults.
fn js_values() -> Map<String, Json> {
    let mut m = Map::new();
    for (i, (js, _)) in TABLE.iter().enumerate() {
        let key = if js.ends_with('.') { format!("{js}duck") } else { (*js).to_owned() };
        m.insert(key, json!({ "row": i }));
    }
    m.insert("cut.keyPreset".into(), json!("classic"));
    m.insert("cut.workspace".into(), json!("color"));
    m.insert("cut.autosave.minutes".into(), json!(7));
    m.insert("cut.autosave.keep".into(), json!(33));
    m.insert("cut.cacheLimitGB".into(), json!(25));
    m.insert("cut.quality".into(), json!(0.5));
    m.insert("cut.program.quality".into(), json!(0.25));
    m.insert("cut.proxy".into(), json!(true));
    m.insert("cut.proxy.offer".into(), json!(false));
    m.insert("cut.proxy.height".into(), json!(540));
    m.insert("cut.timelineTools".into(), json!(true));
    m.insert("cut.program.safe".into(), json!(true));
    m.insert("cut.speech.markUncertain".into(), json!(false));
    m
}

#[test]
fn every_javascript_setting_is_carried_once_to_its_name() {
    let dir = scratch("carry");
    let mut own = Settings::load(&dir);
    own.set("autosaveKeep", json!(3));
    let values = js_values();
    let written = studio::carry_over(&mut own, &studio_of(Json::Object(values.clone())), 42);
    for (key, value) in &values {
        let (js, carry) = studio::row_of(key).unwrap();
        match carry {
            Carry::To(_) | Carry::Kept(_) => {
                let to = studio::target_of(key).unwrap();
                let expect = match to.as_str() {
                    "autosaveKeep" => json!(3),
                    "quality" => json!(0.25),
                    _ => value.clone(),
                };
                assert_eq!(own.get(&to), Some(&expect), "{key} ({js}) is at {to}");
            }
            Carry::Not(why) => {
                assert!(!why.is_empty());
                assert!(!written.iter().any(|w| key.ends_with(w.as_str())), "{key} is not carried: {why}");
            }
        }
    }
    assert_eq!(studio::target_of("cut.auto.silence").as_deref(), Some("auto.silence"), "a family member keeps its end");
    assert_eq!(studio::target_of("cut.layout.editing"), None);
    assert_eq!(studio::target_of("appearance.theme"), None, "the appearance is read, never copied");
    assert!(!written.contains(&"autosaveKeep".to_owned()), "this app's own value stays");
    assert_eq!(own.get(MARKER).and_then(|m| m.get("keys")), Some(&json!(written.len())));
    let again = studio::carry_over(&mut own, &studio_of(json!({ "cut.proxy.height": 1080 })), 43);
    assert!(
        again.is_empty() && own.get("proxyHeight") == Some(&json!(540)),
        "once only: the marker stops a second copy"
    );
    let mut fresh = Settings::load(&scratch("carry-null"));
    studio::carry_over(&mut fresh, &studio_of(json!({ "cut.proxy": null })), 1);
    assert!(fresh.get("proxy").is_none(), "a null is no value");
    let mut unread = Settings::load(&scratch("carry-none"));
    assert!(
        studio::carry_over(&mut unread, &Studio::default(), 1).is_empty() && unread.get(MARKER).is_none(),
        "no file: tried again next start"
    );
}

#[test]
fn the_carried_settings_are_what_the_app_reads() {
    let dir = scratch("reads");
    let mut own = Settings::load(&dir);
    studio::carry_over(&mut own, &studio_of(Json::Object(js_values())), 42);
    own.save().unwrap();
    let s = Shell::new(Home::at(&dir));
    assert_eq!(s.preset, Preset::Classic, "cut.keyPreset");
    let st = &s.doc.settings;
    assert_eq!(cut_app::prefs::number(st, "autosaveMinutes"), 7.0, "cut.autosave.minutes");
    assert_eq!(cut_app::prefs::number(st, "cacheLimitGB"), 25.0, "cut.cacheLimitGB");
    assert_eq!(cut_app::prefs::number(st, "quality"), 0.25, "cut.program.quality: what the monitor played at");
    assert_eq!(cut_app::prefs::number(st, "proxyHeight"), 540.0, "cut.proxy.height");
    assert!(cut_app::prefs::flag(st, "proxy") && !cut_app::prefs::flag(st, "proxyOffer"), "cut.proxy, cut.proxy.offer");
    assert!(cut_app::prefs::flag(st, "timelineTools") && cut_app::prefs::flag(st, "program.safe"));
    assert!(!cut_app::prefs::flag(st, "speech.markUncertain"), "cut.speech.markUncertain");
    assert_eq!(s.doc.setting("workspace"), Some("color"), "cut.workspace");
}

/// `'cut.<name>'` literals in the JavaScript Cut's sources.
fn javascript_keys() -> Vec<String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(repo().join("renderer/features/cut"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "js"))
        .collect();
    files.push(repo().join("main/features/cut.js"));
    let mut keys = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        let b = text.as_bytes();
        for (i, _) in text.match_indices("cut.") {
            let Some(&q) = i.checked_sub(1).and_then(|j| b.get(j)) else { continue };
            if !matches!(q, b'\'' | b'"' | b'`') {
                continue;
            }
            let end = text[i..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_')).map(|n| i + n);
            if let Some(end) = end.filter(|&e| b[e] == q && !text[i..e].ends_with('.')) {
                keys.push(text[i..end].to_owned());
            }
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

#[test]
fn the_table_lists_every_setting_of_the_javascript_and_the_guide_lists_the_table() {
    let keys = javascript_keys();
    assert!(keys.len() > 30, "the sources were read ({keys:?})");
    for k in &keys {
        assert!(
            studio::row_of(k).is_some() || studio::NOT_SETTINGS.contains(&k.as_str()),
            "{k} has a row in studio::TABLE"
        );
    }
    let guide = std::fs::read_to_string(repo().join("docs/cut-app.md")).unwrap();
    for (js, _) in TABLE {
        assert!(guide.contains(&format!("| `{js}")), "docs/cut-app.md lists {js}");
    }
}

#[test]
fn language_and_theme_follow_nano_studio_and_windows() {
    let ko = || Some("ko-KR".to_owned());
    let en = || Some("en-US".to_owned());
    assert_eq!(studio::language_of(&studio_of(json!({ "appearance.language": "en" })), ko), Lang::En);
    assert_eq!(studio::language_of(&studio_of(json!({ "appearance.language": "ko" })), en), Lang::Ko);
    assert_eq!(studio::language_of(&studio_of(json!({ "appearance.language": "system" })), ko), Lang::Ko);
    assert_eq!(studio::language_of(&studio_of(json!({ "appearance.language": "system" })), en), Lang::En);
    assert_eq!(studio::language_of(&studio_of(json!({})), || None), Lang::En, "no system language: English");
    assert_eq!(studio::language_of(&Studio::default(), ko), Lang::Ko, "a new install follows Windows");
    assert_eq!(studio::theme_of(&studio_of(json!({ "appearance.theme": "light" }))), Some(ThemeKind::Light));
    assert_eq!(studio::theme_of(&studio_of(json!({ "appearance.theme": "dark" }))), Some(ThemeKind::Dark));
    assert_eq!(studio::theme_of(&studio_of(json!({ "appearance.theme": "system" }))), None, "system: Windows'");
    assert_eq!(studio::theme_of(&studio_of(json!({}))), Some(ThemeKind::Dark), "settings without it: Dark, as Code");
    assert_eq!(studio::theme_of(&Studio::default()), None, "a new install: Windows'");
    assert!(
        studio::language().is_none() && studio::theme(None).is_none(),
        "not started by Nano Studio: the app's own defaults"
    );
}

#[test]
fn claude_is_looked_up_as_nano_studio_says() {
    let s = |v: &str| Some(v.to_owned());
    assert_eq!(switch_of(s("C:\\c\\claude.exe"), s("other")), s("C:\\c\\claude.exe"), "CUT_CLAUDE_PATH first");
    assert_eq!(switch_of(None, s("none")), s("none"), "else the test switch");
    assert_eq!(switch_of(s(""), None), None, "unset: look again (~/.local/bin, then PATH)");
    assert_eq!(Cli::with_switch(s("none")).find(), None, "none: not installed");
    let dir = scratch("claude");
    let exe = dir.join("claude.exe");
    std::fs::write(&exe, b"").unwrap();
    assert_eq!(Cli::with_switch(Some(exe.to_string_lossy().into_owned())).find(), Some(exe.clone()));
    assert_eq!(Cli::with_switch(Some(dir.join("gone.exe").to_string_lossy().into_owned())).find(), None);
}

#[test]
fn a_close_request_writes_the_autosave_at_once() {
    let home = Home::at(scratch("close"));
    let (mut doc, mut app) = cut_app::doc::Doc::start(home.clone(), 0);
    assert!(!doc.autosave_now(&app), "nothing unsaved: nothing written");
    app.exec(&cut_model::commands::build::set_settings(json!({ "stillDuration": 7 })));
    assert!(doc.autosave_now(&app), "unsaved changes are written without the 2 s wait");
    let latest = std::fs::read_dir(&home.autosave)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().ends_with(".latest.ncut"));
    assert!(latest, "the latest autosave is on disk");
    assert!(!doc.autosave_now(&app), "once per change");
}

#[test]
fn check_for_updates_starts_nano_studio_with_its_argument() {
    use cut_app::update::{ARG, check, command_of};
    let exe = Path::new("C:\\NS\\resources\\cut\\nano-studio-cut.exe");
    let given = command_of(Some(r#"["C:\\e\\electron.exe","C:\\app","--pyide-test-env"]"#), exe).unwrap();
    assert_eq!(
        given,
        (PathBuf::from("C:\\e\\electron.exe"), vec!["C:\\app".to_owned(), "--pyide-test-env".to_owned()])
    );
    let dir = scratch("update");
    let cut = dir.join("resources").join("cut").join("nano-studio-cut.exe");
    assert_eq!(command_of(None, &cut), None, "no Nano Studio.exe: no item to run");
    std::fs::write(dir.join("Nano Studio.exe"), b"").unwrap();
    assert_eq!(command_of(None, &cut), Some((dir.join("Nano Studio.exe"), Vec::new())), "an installed copy's");
    let out = dir.join("started.txt");
    let cmd = (
        PathBuf::from("C:\\Windows\\System32\\cmd.exe"),
        vec!["/d".into(), "/c".into(), format!("echo started>{}", out.display())],
    );
    check(&cmd).unwrap();
    let t = Instant::now();
    while !std::fs::read_to_string(&out).is_ok_and(|s| s.contains(ARG)) && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        std::fs::read_to_string(&out).unwrap_or_default().contains(&format!("started {ARG}")),
        "the program ran with {ARG}"
    );
}

#[test]
fn about_shows_the_versions() {
    use egui_kittest::kittest::Queryable;
    let mut s = Shell::new(Home::at(scratch("about")));
    cut_app::i18n::set_lang(Lang::En);
    let mut asked = false;
    let mut harness =
        egui_kittest::Harness::builder().with_size(eframe::egui::Vec2::new(1280.0, 800.0)).build_ui(move |ui| {
            if !asked {
                asked = true;
                s.run_action("about", ui.ctx());
            }
            s.frame(ui);
        });
    harness.run_steps(3);
    let cut = format!("Video editor {}", env!("CARGO_PKG_VERSION"));
    assert!(harness.query_by_label(&cut).is_some(), "Help › About opens the box with this program's version ({cut})");
    let mut box_only = egui_kittest::Harness::builder().build_ui(|ui| {
        ui.ctx().data_mut(|d| d.insert_temp(eframe::egui::Id::unique("cut-about"), true));
        cut_app::update::about_with(ui.ctx(), Some("0.4.2-beta.1".to_owned()));
    });
    box_only.run_steps(2);
    assert!(
        box_only.query_by_label("Nano Studio 0.4.2-beta.1").is_some(),
        "and the installed Nano Studio's (CUT_STUDIO_VERSION)"
    );
}

/// The visible windows of `pid` of class `#32770` (a message box): title, then the texts of its children.
fn message_boxes(pid: u32) -> Vec<String> {
    let script = r##"Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public static class W { public delegate bool P(IntPtr h, IntPtr l); [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l); [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w, P p, IntPtr l); [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n); [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n); static string T(IntPtr h) { var s = new StringBuilder(4096); GetWindowText(h, s, 4096); return s.ToString().Replace("\r", " ").Replace("\n", " "); } public static string[] Of(int id) { var r = new List<string>(); EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); var c = new StringBuilder(64); GetClassName(h, c, 64); if (p == id && IsWindowVisible(h) && c.ToString() == "#32770") { var t = new StringBuilder(T(h)); EnumChildWindows(h, (k, m) => { t.Append("|" + T(k)); return true; }, IntPtr.Zero); r.Add(t.ToString()); } return true; }, IntPtr.Zero); return r.ToArray(); } }'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [W]::Of(PID) -join "`n""##;
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script.replace("PID", &pid.to_string())])
        .output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn crash_in(lang: &str, sentence: &str) {
    let dir = scratch(&format!("crash-{lang}"));
    let mut child = Command::new(env!("CARGO_BIN_EXE_nano-studio-cut"))
        .env("CUT_HOME", &dir)
        .env("CUT_TEST_PANIC", "1")
        .env("CUT_LANG", lang)
        .env("CUT_OUTPUT_GAIN", "0")
        .env_remove("CUT_STUDIO_SETTINGS")
        .spawn()
        .unwrap();
    let log = cut_app::crash::log_file(&dir);
    let t = Instant::now();
    let mut boxes = Vec::new();
    while t.elapsed() < Duration::from_secs(60) {
        boxes = message_boxes(child.id());
        if !boxes.is_empty() && log.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).output();
    let _ = child.wait();
    let text = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(
        text.contains("CUT_TEST_PANIC asked for a crash (")
            && text.contains("thread main")
            && text.contains("backtrace"),
        "the log names the panic, where, the thread and the stack ({text})"
    );
    let b = boxes.iter().find(|b| b.starts_with("Nano Studio Cut|"));
    assert!(
        b.is_some_and(|b| b.contains(sentence) && b.contains("CUT_TEST_PANIC")),
        "a box titled Nano Studio Cut says it ({boxes:?})"
    );
    let shown = log.to_string_lossy().replace('/', "\\");
    assert!(b.is_some_and(|b| b.contains(&shown)), "and where the details are ({shown})");
}

#[test]
fn a_crash_shows_a_message_in_the_apps_language_and_logs_the_panic() {
    crash_in("en", "Your latest changes are in the autosave");
    crash_in("ko", "자동 저장본에 있습니다");
}
