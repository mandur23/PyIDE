//! Help › Check for Updates… and About. Updates are Nano Studio's (`main/features/updater.js`): the item starts Nano
//! Studio with `--check-updates`, which opens its start chooser and checks at once whatever the settings say; the
//! chooser's update icon downloads and installs. The command is the launcher's `CUT_STUDIO_APP` (a JSON array: the
//! exe, and the app folder in a source run), else `Nano Studio.exe` two folders above this program in an installed
//! copy (`resources\cut\nano-studio-cut.exe`). About shows `CUT_STUDIO_VERSION`, the installed Nano Studio's version.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use eframe::egui;

use crate::i18n::{tr, trf};

/// The texts only these items show, Korean beside English (the dictionary, `i18n.rs`).
pub const KO: [(&str, &str); 5] = [
    ("About Nano Studio Cut", "Nano Studio Cut 정보"),
    ("Nano Studio {version}", "Nano Studio {version}"),
    ("Video editor {version}", "동영상 편집기 {version}"),
    (
        "Nano Studio opens and checks for updates. Install one there; save your work here first.",
        "Nano Studio 창이 열려 업데이트를 확인합니다. 설치는 그 창에서 하고, 그 전에 여기서 작업을 저장하세요.",
    ),
    (
        "Nano Studio could not be started to check for updates: {error}",
        "업데이트를 확인하려고 Nano Studio를 시작하지 못했습니다: {error}",
    ),
];

/// The argument Nano Studio's main.js reads.
pub const ARG: &str = "--check-updates";

/// The command that starts Nano Studio: from `CUT_STUDIO_APP` (`studio_app`), else the installed layout around
/// `exe` (this program).
pub fn command_of(studio_app: Option<&str>, exe: &Path) -> Option<(PathBuf, Vec<String>)> {
    if let Some(list) = studio_app.and_then(|t| serde_json::from_str::<Vec<String>>(t).ok()) {
        let (first, rest) = list.split_first()?;
        return Some((PathBuf::from(first), rest.to_vec()));
    }
    let app = exe.parent()?.parent()?.parent()?.join("Nano Studio.exe");
    app.is_file().then(|| (app, Vec::new()))
}

/// This run's command, if there is one.
pub fn command() -> Option<(PathBuf, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    command_of(std::env::var("CUT_STUDIO_APP").ok().as_deref(), &exe)
}

/// The installed Nano Studio's version (`CUT_STUDIO_VERSION`), when Nano Studio started this program.
pub fn studio_version() -> Option<String> {
    std::env::var("CUT_STUDIO_VERSION").ok().filter(|v| !v.is_empty())
}

/// Starts Nano Studio's update check, on its own (it outlives nothing here) -> what to tell the person.
pub fn check(cmd: &(PathBuf, Vec<String>)) -> Result<(), String> {
    Command::new(&cmd.0)
        .args(&cmd.1)
        .arg(ARG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

fn about_id() -> egui::Id {
    egui::Id::unique("cut-about")
}

/// `Some(can run now)` for the actions `checkForUpdates` (when there is a Nano Studio to start) and `about`.
pub fn enabled(_s: &crate::shell::Shell, id: &str) -> Option<bool> {
    match id {
        "checkForUpdates" => Some(command().is_some()),
        "about" => Some(true),
        _ => None,
    }
}

/// Runs one of these actions -> whether it was one.
pub fn run(s: &mut crate::shell::Shell, id: &str, ctx: &egui::Context) -> bool {
    match id {
        "checkForUpdates" => match command().map(|c| check(&c)) {
            Some(Ok(())) => {
                s.app.toast(tr(KO[3].0));
            }
            Some(Err(e)) => {
                s.app.report(trf(KO[4].0, &[("error", &e)]));
            }
            None => {}
        },
        "about" => {
            ctx.data_mut(|d| d.insert_temp(about_id(), true));
        }
        _ => return false,
    }
    true
}

/// The About box, while it is open.
pub fn about(ctx: &egui::Context) {
    about_with(ctx, studio_version());
}

/// [`about`] with Nano Studio's version given.
pub fn about_with(ctx: &egui::Context, studio_version: Option<String>) {
    if !ctx.data(|d| d.get_temp::<bool>(about_id())).unwrap_or(false) {
        return;
    }
    let mut close = false;
    let modal = egui::Modal::new(about_id().with("modal")).show(ctx, |ui| {
        ui.set_width(340.0);
        ui.heading("Nano Studio Cut");
        ui.add_space(6.0);
        if let Some(v) = &studio_version {
            ui.label(trf(KO[1].0, &[("version", v)]));
        }
        ui.label(trf(KO[2].0, &[("version", env!("CARGO_PKG_VERSION"))]));
        ui.add_space(8.0);
        if ui.button(tr("Close")).clicked() {
            close = true;
        }
    });
    if close || modal.should_close() {
        ctx.data_mut(|d| d.remove::<bool>(about_id()));
    }
}
