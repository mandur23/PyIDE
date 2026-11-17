//! What a crash leaves for the person: the panic is written to `<home>\.cut-rs\crash.log` and a message box (title
//! "Nano Studio Cut", in the app's language) says what happened and that the autosave is offered at the next start
//! (the session marker of the run that crashed stays, `files::Projects::recovery`). The release profile aborts on a
//! panic, and the hook runs before the abort. A debug build unwinds: there only a panic of the main thread ends the
//! app, so only that one gets the box; every panic is logged.
//!
//! `CUT_TEST_PANIC=1` panics on purpose in the first frame (`tests/installed.rs` checks the log and the box).

use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};

use crate::i18n::{last_lang, text_in};

/// The box's sentences, Korean beside English (the dictionary, `i18n.rs`).
pub const KO: [(&str, &str); 3] = [
    ("Nano Studio Cut stopped because of an error.", "오류가 나서 Nano Studio Cut 프로그램을 끝냅니다."),
    (
        "Your latest changes are in the autosave, which Nano Studio Cut offers to open when you start it again.",
        "마지막 변경은 자동 저장본에 있습니다. 다음에 시작하면 자동 저장본을 열지 묻습니다.",
    ),
    ("Details: {file}", "자세한 내용: {file}"),
];

/// The log file of a workspace.
pub fn log_file(home: &Path) -> PathBuf {
    home.join(".cut-rs").join("crash.log")
}

/// What happened, in one line: the panic's message and where.
pub fn what(info: &PanicHookInfo) -> String {
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_owned());
    match info.location() {
        Some(l) => format!("{message} ({}:{})", l.file(), l.line()),
        None => message,
    }
}

/// The box's text in `lang` order: what happened, the autosave, where the details are.
pub fn message(lang: crate::i18n::Lang, what: &str, log: &Path) -> String {
    let t = |k: &str| text_in(lang, k);
    format!("{}\n\n{what}\n\n{}\n\n{}", t(KO[0].0), t(KO[1].0), t(KO[2].0).replace("{file}", &log.to_string_lossy()))
}

/// Puts the hook in place for the workspace `home` (the app's start).
pub fn install(home: &Path) {
    let log = log_file(home);
    let earlier = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let what = what(info);
        let thread = std::thread::current().name().unwrap_or("?").to_owned();
        let trace = std::backtrace::Backtrace::force_capture();
        if let Some(dir) = log.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log) {
            let _ =
                writeln!(f, "{} pid {} thread {thread}: {what}\n{trace}\n", crate::files::now_ms(), std::process::id());
        }
        if cfg!(panic = "abort") || thread == "main" {
            rfd::MessageDialog::new()
                .set_title("Nano Studio Cut")
                .set_description(message(last_lang(), &what, &log))
                .set_level(rfd::MessageLevel::Error)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        }
        earlier(info);
    }));
}

/// The test switch: panics when `CUT_TEST_PANIC` is set (called in the first frame).
pub fn test_switch() {
    if std::env::var_os("CUT_TEST_PANIC").is_some_and(|v| !v.is_empty()) {
        panic!("CUT_TEST_PANIC asked for a crash");
    }
}
