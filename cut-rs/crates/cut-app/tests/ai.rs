//! Claude's text features end to end with a stand-in for the Claude Code CLI (`tools/fake-claude.mjs` behind a
//! `claude.cmd`, as the JavaScript's tests do; never the real Claude): Polish and Translate Captions, YouTube
//! chapters as markers, Highlights to Shorts, Edit Command; an answer that does not check asked once more with the
//! reason, a second bad answer changing nothing; every failure code (not-installed, auth, quota, cli, cancelled,
//! timeout, badArgs); the CLI's exact flags, its empty working folder and system prompt file; the notice before the
//! first request; `PYIDE_CLAUDE_PATH` itself. Each applied task is one undo step.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use cut_app::ai::claude::{Cli, Code};
use cut_app::ai::runner::{Request, Runner};
use cut_app::ai::{self, captions_ui, command_ui, metadata_ui, shorts_ui};
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_model::commands::build as C;
use cut_model::{Id, MarkerKind};
use cut_time::TICKS;
use serde_json::{Value as Json, json};

const S: f64 = TICKS as f64;

/// A stand-in CLI: a folder with `claude.cmd`, the scenario, and the log of its runs.
struct Fake {
    dir: PathBuf,
}

impl Fake {
    fn new(name: &str, runs: Json) -> Fake {
        let dir = std::env::temp_dir().join(format!("cut-app-ai-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/fake-claude.mjs").canonicalize().unwrap();
        let script = script.to_string_lossy().trim_start_matches(r"\\?\").to_owned();
        let cmd = format!("@echo off\r\nset FAKE_CLAUDE_DIR={}\r\nnode \"{script}\" %*\r\n", dir.display());
        std::fs::write(dir.join("claude.cmd"), cmd).unwrap();
        std::fs::write(dir.join("scenario.json"), json!({ "runs": runs }).to_string()).unwrap();
        Fake { dir }
    }

    fn cmd(&self) -> String {
        self.dir.join("claude.cmd").to_string_lossy().into_owned()
    }

    fn calls(&self) -> Vec<Json> {
        let text = std::fs::read_to_string(self.dir.join("calls.jsonl")).unwrap_or_default();
        text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A shell on a scratch home whose Claude is `switch`, the notice acknowledged unless `ack` is false.
fn shell(name: &str, switch: Option<String>, ack: bool) -> (Shell, PathBuf) {
    let home = std::env::temp_dir().join(format!("cut-app-ai-home-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut s = Shell::new(Home::at(home.clone()));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    s.features.ai.runner = Arc::new(Runner::new(Cli::with_switch(switch), Duration::from_secs(60)));
    if ack {
        s.doc.settings.set("ai.acknowledged", Json::Bool(true));
    }
    (s, home)
}

fn seq(s: &Shell) -> String {
    s.app.sequence_id.unwrap().as_str().to_owned()
}

/// A 30 s solid clip on V1 and a caption track of `texts` (3 s each).
fn with_captions(s: &mut Shell, texts: &[&str], lang: &str) -> Id {
    let q = seq(s);
    s.app
        .exec(&json!({ "type": "addGenerated", "seqId": q, "opts": {
            "source": { "generator": "solid", "color": "#336699" }, "at": 0, "duration": 30 * TICKS, "track": "V1",
        } }))
        .unwrap();
    let items: Vec<Json> = texts
        .iter()
        .enumerate()
        .map(|(k, t)| json!({ "start": k as i64 * 3 * TICKS, "end": (k as i64 * 3 + 2) * TICKS, "text": t }))
        .collect();
    let r =
        s.app.exec(&C::add_caption_track(&q, json!({ "name": "Subtitles", "lang": lang, "items": items }))).unwrap();
    Id::new(r["id"].as_str().unwrap())
}

fn texts_of(s: &Shell, track: Id) -> Vec<String> {
    let t = s.app.sequence().unwrap().captions.iter().find(|t| t.id == track).unwrap();
    t.items.iter().map(|it| it.text.clone()).collect()
}

fn answer(v: Json) -> Json {
    json!({ "answer": format!("Here it is:\n```json\n{v}\n```") })
}

fn toasts(s: &Shell) -> Vec<String> {
    s.app.notices.iter().map(|n| n.text.clone()).collect()
}

#[test]
fn polish_asks_again_once_with_the_reason_and_applies_as_one_step() {
    let fake = Fake::new(
        "polish",
        json!([
            answer(json!({ "lines": [{ "i": 1, "text": "Hello, world." }] })),
            answer(json!({ "lines": [{ "i": 1, "text": "Hello, world." }, { "i": 2, "text": "it is fine." }] })),
        ]),
    );
    let (mut s, _home) = shell("polish", Some(fake.cmd()), true);
    let track = with_captions(&mut s, &["hello world", "it is fine."], "en");
    let steps = s.app.history.position();
    captions_ui::polish(&mut s);
    assert!(s.features.ai.captions.polish.is_some(), "the dialog");
    captions_ui::polish_go(&mut s);
    ai::settle(&mut s);
    let calls = fake.calls();
    assert_eq!(calls.len(), 2, "asked once more");
    let again = calls[1]["stdin"].as_str().unwrap();
    assert!(again.contains("Your previous answer could not be used: Captions missing from the answer: 2."), "{again}");
    assert!(again.contains("Task: polish captions") && again.contains("Language: English (en)"));
    let r = s.features.ai.captions.review.clone().expect("the review");
    assert_eq!(r.changes.len(), 1, "only the changed caption: {:?}", r.changes);
    assert_eq!(r.changes[0].after, "Hello, world.");
    assert_eq!(texts_of(&s, track), ["hello world", "it is fine."], "nothing before Apply");
    assert_eq!(captions_ui::apply_polish(&mut s), 1);
    assert_eq!(texts_of(&s, track), ["Hello, world.", "it is fine."]);
    assert_eq!(s.app.history.position(), steps + 1, "one undo step");
    assert!(s.app.undo());
    assert_eq!(texts_of(&s, track), ["hello world", "it is fine."]);
}

#[test]
fn a_second_bad_answer_changes_nothing() {
    let fake = Fake::new("bad", json!([{ "answer": "no json" }, answer(json!({ "lines": [] }))]));
    let (mut s, _home) = shell("bad", Some(fake.cmd()), true);
    let track = with_captions(&mut s, &["one", "two"], "en");
    let rev = s.app.history.revision();
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    ai::settle(&mut s);
    assert_eq!(fake.calls().len(), 2);
    assert!(fake.calls()[1]["stdin"].as_str().unwrap().contains("could not be used: The answer has no JSON value."));
    let (code, text) = s.features.ai.notice.error().expect("the error dialog");
    assert_eq!(code, "invalid");
    assert!(text.contains("Captions missing from the answer: 1, 2."), "{text}");
    assert!(s.features.ai.captions.review.is_none());
    assert_eq!(s.app.history.revision(), rev, "nothing changed");
    assert_eq!(texts_of(&s, track), ["one", "two"]);
}

#[test]
fn translate_makes_a_new_track_with_the_same_times() {
    let long = "This translated caption is long enough to need a second line break";
    let fake = Fake::new(
        "translate",
        json!([answer(json!({ "lines": [{ "i": 1, "text": long }, { "i": 2, "text": "Two" }] }))]),
    );
    let (mut s, _home) = shell("translate", Some(fake.cmd()), true);
    let track = with_captions(&mut s, &["안녕하세요 여러분", "둘"], "");
    captions_ui::translate(&mut s);
    assert_eq!(s.features.ai.captions.translate.as_ref().unwrap().to, "en", "Korean goes to English");
    let steps = s.app.history.position();
    captions_ui::translate_go(&mut s);
    ai::settle(&mut s);
    assert!(fake.calls()[0]["stdin"].as_str().unwrap().contains("From: Korean (ko)\nTarget language: English (en)"));
    let q = s.app.sequence().unwrap();
    assert_eq!(q.captions.len(), 2);
    let made = &q.captions[1];
    assert_eq!(made.name, "Subtitles (English)");
    assert_eq!(made.lang, "en");
    let src = q.captions.iter().find(|t| t.id == track).unwrap();
    for (a, b) in made.items.iter().zip(&src.items) {
        assert_eq!((a.start, a.end), (b.start, b.end), "the same times");
    }
    assert_eq!(made.items[0].text, cut_app::ai::lines::line_break(long, Some("en"), 0, 2));
    assert!(made.items[0].text.contains('\n'));
    assert_eq!(s.app.history.position(), steps + 1);
}

#[test]
fn youtube_chapters_follow_the_rules_and_become_markers_in_one_step() {
    let meta = json!({
        "titles": ["A title", "A title", "Another"],
        "description": "Para one.\r\n\r\nPara two.",
        "chapters": [{ "t": 4, "title": "Start" }, { "t": 8, "title": "Too close" }, { "t": 10.7, "title": "Middle" },
                     { "t": 20, "title": "Late" }, { "t": 25, "title": "Short end" }, { "t": 99, "title": "Past" }],
        "tags": ["#one", "two", "Two"],
    });
    let fake = Fake::new("meta", json!([answer(meta)]));
    let (mut s, _home) = shell("meta", Some(fake.cmd()), true);
    with_captions(&mut s, &["one", "two", "three"], "en");
    let q = seq(&s);
    s.app.exec(&C::add_marker(&q, json!({ "t": TICKS, "kind": "chapter", "name": "old" }), json!({}))).unwrap();
    metadata_ui::open(&mut s);
    ai::settle(&mut s);
    let shown = s.features.ai.metadata.shown.clone().expect("the dialog");
    assert_eq!(shown.meta.titles, ["A title", "Another"]);
    let ch: Vec<(f64, &str)> = shown.meta.chapters.iter().map(|c| (c.t, c.title.as_str())).collect();
    assert_eq!(
        ch,
        [(0.0, "Start"), (10.0, "Middle"), (20.0, "Late")],
        "0:00 first, 10 s apart, the last 10 s long, inside"
    );
    assert_eq!(shown.meta.tags, ["one", "two"]);
    let steps = s.app.history.position();
    assert!(metadata_ui::add_chapters(&mut s, &shown.meta.chapters));
    let marks: Vec<(f64, String)> = s
        .app
        .sequence()
        .unwrap()
        .markers
        .iter()
        .filter(|m| m.kind == MarkerKind::Chapter)
        .map(|m| (m.t as f64 / S, m.name.clone()))
        .collect();
    let want: Vec<(f64, String)> = ch.iter().map(|(t, n)| (*t, (*n).to_owned())).collect();
    assert_eq!(marks, want, "the old chapter replaced");
    assert_eq!(s.app.history.position(), steps + 1);
}

#[test]
fn highlights_become_a_shorts_sequence_in_one_step() {
    let fake = Fake::new(
        "shorts",
        json!([
            answer(json!({ "highlights": [{ "start": 2, "end": 3, "title": "Too short" }] })),
            answer(
                json!({ "highlights": [{ "start": 15.0, "end": 25.0, "title": "B" }, { "start": 0.0, "end": 10.0, "title": "A" }] })
            ),
        ]),
    );
    let (mut s, _home) = shell("shorts", Some(fake.cmd()), true);
    with_captions(&mut s, &["a", "b", "c", "d", "e", "f", "g", "h", "i"], "en");
    let src = s.app.sequence_id.unwrap();
    shorts_ui::open(&mut s);
    s.features.ai.shorts.ask.as_mut().unwrap().min = 5.0;
    s.features.ai.shorts.ask.as_mut().unwrap().max = 4.0;
    assert!(!shorts_ui::find(&mut s), "the longest must be longer");
    assert!(toasts(&s).iter().any(|t| t == "The longest must be longer than the shortest."));
    let o = s.features.ai.shorts.ask.as_mut().unwrap();
    (o.min, o.max) = (5.0, 15.0);
    assert!(shorts_ui::find(&mut s));
    ai::settle(&mut s);
    assert!(fake.calls()[1]["stdin"].as_str().unwrap().contains("Highlight 1 is 1.0 s long; each must be 5 to 15 s."));
    let r = s.features.ai.shorts.review.clone().expect("the review");
    let got: Vec<(f64, f64)> = r.ranges.iter().map(|h| (h.start / S, h.end / S)).collect();
    assert_eq!(got, [(0.0, 10.0), (15.0, 25.0)], "by start");
    let steps = s.app.history.position();
    let id = shorts_ui::create(&mut s).expect("the shorts sequence");
    let q = s.app.sequence().unwrap();
    assert_eq!((q.id, q.w, q.h), (id, 1080, 1920));
    assert_eq!(q.duration(), 20 * TICKS, "the two ranges back to back");
    assert_eq!(s.app.history.position(), steps + 1, "one undo step");
    assert!(s.app.undo());
    assert!(s.app.project().sequences.iter().all(|x| x.id != id));
    shorts_ui::follow(&mut s);
    assert_eq!(s.app.sequence_id, Some(src), "back to the sequence it came from");
}

#[test]
fn an_edit_command_is_checked_previewed_and_applied_as_one_step() {
    let plan = json!({ "ops": [
        { "op": "cut", "from": 0, "to": 5 },
        { "op": "marker", "at": 10, "name": "Topic", "kind": "chapter" },
        { "op": "masterGain", "db": -3 },
    ], "message": "Done." });
    let fake = Fake::new(
        "command",
        json!([
            answer(json!({ "ops": [{ "op": "deleteEverything" }] })),
            answer(plan),
            answer(json!({ "ops": [], "message": "I cannot do that." })),
        ]),
    );
    let (mut s, _home) = shell("command", Some(fake.cmd()), true);
    with_captions(&mut s, &["a", "b"], "en");
    command_ui::open(&mut s);
    s.features.ai.command.form = Some("  ".into());
    assert!(!command_ui::ask(&mut s), "an empty request keeps the dialog");
    s.features.ai.command.form = Some("cut the first 5 seconds".into());
    assert!(command_ui::ask(&mut s));
    ai::settle(&mut s);
    let calls = fake.calls();
    assert!(calls[0]["stdin"].as_str().unwrap().contains("Request: cut the first 5 seconds"));
    assert!(
        calls[1]["stdin"].as_str().unwrap().contains("Operation 1: \"deleteEverything\" is not an allowed operation.")
    );
    let p = s.features.ai.command.preview.clone().expect("the preview");
    assert_eq!(p.planned.plan.ops.len(), 3);
    assert!(s.timeline.overlay.is_some(), "the cut shaded on the timeline");
    let steps = s.app.history.position();
    assert!(command_ui::apply(&mut s));
    let q = s.app.sequence().unwrap();
    assert_eq!(q.duration(), 25 * TICKS, "5 s cut");
    assert_eq!(q.master_gain, -3.0);
    assert_eq!(q.markers.iter().filter(|m| m.kind == MarkerKind::Chapter).count(), 1);
    assert_eq!(s.app.history.position(), steps + 1, "one undo step");
    assert!(s.timeline.overlay.is_none());
    assert!(s.app.undo());
    assert_eq!(s.app.sequence().unwrap().duration(), 30 * TICKS);
    s.features.ai.command.form = Some("make it purple".into());
    command_ui::ask(&mut s);
    ai::settle(&mut s);
    assert_eq!(s.features.ai.command.empty.as_deref(), Some("I cannot do that."));
}

#[test]
fn the_cli_gets_exactly_the_javascripts_flags() {
    let fake = Fake::new("flags", json!([answer(json!({ "lines": [{ "i": 1, "text": "X." }] }))]));
    let (mut s, _home) = shell("flags", Some(fake.cmd()), true);
    with_captions(&mut s, &["x"], "en");
    s.doc.settings.set("ai.model", Json::from("haiku"));
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    ai::settle(&mut s);
    let call = &fake.calls()[0];
    let args: Vec<&str> = call["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    let system_file = cut_app::ai::claude::system_prompt_file(cut_app::ai::captions::SYSTEM).unwrap();
    let want = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "haiku",
        "--tools",
        "",
        "--max-turns",
        "1",
        "--safe-mode",
        "--no-session-persistence",
        "--system-prompt-file",
        &system_file.to_string_lossy(),
    ];
    assert_eq!(args, want);
    assert_eq!(call["system"].as_str(), Some(cut_app::ai::captions::SYSTEM));
    let cwd = PathBuf::from(call["cwd"].as_str().unwrap());
    assert_eq!(
        cwd.canonicalize().unwrap(),
        cut_app::ai::claude::work_dir().canonicalize().unwrap(),
        "the empty folder"
    );
}

fn failing(name: &str, run: Json) -> Shell {
    let fake = Fake::new(name, json!([run]));
    let (mut s, _home) = shell(name, Some(fake.cmd()), true);
    with_captions(&mut s, &["one"], "en");
    let rev = s.app.history.revision();
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    ai::settle(&mut s);
    assert_eq!(s.app.history.revision(), rev, "{name}: nothing changed");
    s
}

#[test]
fn each_failure_is_explained_and_changes_nothing() {
    let s = failing("auth", json!({ "error": "Not logged in · Please run /login" }));
    assert_eq!(s.features.ai.notice.explaining(), Some(Code::Auth));
    let s = failing("quota", json!({ "error": "Claude AI usage limit reached|1760000000" }));
    assert_eq!(s.features.ai.notice.explaining(), Some(Code::Quota));
    let s = failing("cli", json!({ "stderr": "something broke\nbadly\n", "exit": 3 }));
    let (code, text) = s.features.ai.notice.error().unwrap();
    assert_eq!((code, text), ("cli", "Claude Code failed: something broke\nbadly"));
    let s = failing("exit", json!({ "stderr": "", "exit": 4 }));
    assert_eq!(s.features.ai.notice.error().unwrap().1, "Claude Code failed: Claude Code exited with code 4");

    let (mut s, _home) = shell("missing", Some("none".into()), true);
    with_captions(&mut s, &["one"], "en");
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    assert!(s.features.ai.job.is_none(), "nothing asked");
    assert_eq!(s.features.ai.notice.explaining(), Some(Code::NotInstalled));
}

#[test]
fn cancel_and_the_time_limit_end_a_request() {
    let fake = Fake::new("slow", json!([{ "sleepMs": 20000, "answer": "late" }]));
    let (mut s, _home) = shell("slow", Some(fake.cmd()), true);
    let track = with_captions(&mut s, &["one"], "en");
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    std::thread::sleep(Duration::from_millis(500));
    let started = std::time::Instant::now();
    s.features.ai.job.as_ref().unwrap().cancel();
    ai::settle(&mut s);
    assert!(started.elapsed() < Duration::from_secs(10), "the CLI was ended");
    assert!(toasts(&s).iter().any(|t| t == "The analysis was cancelled."));
    assert_eq!(texts_of(&s, track), ["one"]);

    let runner = Runner::new(Cli::with_switch(Some(fake.cmd())), Duration::from_secs(1));
    let req =
        Request { request: "ai1".into(), task: "polish".into(), system: "s".into(), prompt: "p".into(), model: None };
    let r = runner.run(&req, &AtomicBool::new(false), &mut |_| {});
    let f = r.unwrap_err();
    assert_eq!((f.code, f.error.as_str()), (Code::Timeout, "Claude Code did not answer in time"));
    let (mut s, _home) = shell("timeout", Some(fake.cmd()), true);
    s.features.ai.runner = Arc::new(runner);
    with_captions(&mut s, &["one"], "en");
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    ai::settle(&mut s);
    assert_eq!(
        s.features.ai.notice.error().unwrap(),
        ("timeout", "Claude did not answer in time. Try again, or ask for less at once.")
    );
}

#[test]
fn bad_requests_are_refused_before_the_cli() {
    let fake = Fake::new("badargs", json!([{ "answer": "x" }]));
    let runner = Runner::new(Cli::with_switch(Some(fake.cmd())), Duration::from_secs(5));
    let ok = Request { request: "ai1".into(), task: "t".into(), system: "s".into(), prompt: "p".into(), model: None };
    let cases = [
        (Request { request: "bad id!".into(), ..ok.clone() }, "a request needs an id"),
        (Request { task: String::new(), ..ok.clone() }, "a task is a short name"),
        (Request { model: Some("gpt".into()), ..ok.clone() }, "unknown model gpt"),
        (Request { system: String::new(), ..ok.clone() }, "the system prompt is missing or too long"),
        (Request { prompt: "x".repeat(200_001), ..ok.clone() }, "the prompt is missing or too long"),
    ];
    for (req, why) in cases {
        let f = runner.run(&req, &AtomicBool::new(false), &mut |_| {}).unwrap_err();
        assert_eq!((f.code, f.error.as_str()), (Code::BadArgs, why));
    }
    assert!(fake.calls().is_empty(), "the CLI never started");
    let a = runner.run(&ok, &AtomicBool::new(false), &mut |_| {}).unwrap();
    assert_eq!(a.text, "x");
}

#[test]
fn the_notice_comes_before_the_first_request() {
    let fake = Fake::new("notice", json!([answer(json!({ "lines": [{ "i": 1, "text": "One." }] }))]));
    let (mut s, _home) = shell("notice", Some(fake.cmd()), false);
    with_captions(&mut s, &["one"], "en");
    captions_ui::polish(&mut s);
    captions_ui::polish_go(&mut s);
    assert!(s.features.ai.notice.asking(), "the notice");
    assert!(s.features.ai.job.is_none() && fake.calls().is_empty(), "nothing sent before it");
}

/// The switch as the process has it: this test runs itself again with `PYIDE_CLAUDE_PATH=none`.
#[test]
fn pyide_claude_path_none_means_no_claude_code() {
    if let Ok(v) = std::env::var("PYIDE_CLAUDE_PATH") {
        assert_eq!(v, "none");
        assert!(Cli::from_env().find().is_none());
        return;
    }
    let me = std::env::current_exe().unwrap();
    let out = std::process::Command::new(me)
        .args(["--exact", "pyide_claude_path_none_means_no_claude_code", "--nocapture"])
        .env("PYIDE_CLAUDE_PATH", "none")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
}

/// The assistant's turns run until they end, the control's calls answered on the shell as each frame does.
fn run_turn(s: &mut Shell, ctx: &eframe::egui::Context) {
    let start = std::time::Instant::now();
    while s.features.ai.assistant.running().is_some() {
        assert!(start.elapsed() < Duration::from_secs(60), "the turn did not end");
        let mut c = std::mem::replace(&mut s.features.control, cut_app::control::Control::new(None));
        c.pump(&mut cut_app::control::ShellHost { s, ctx });
        s.features.control = c;
        cut_app::ai::assistant::poll(s);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn assistant_shell(name: &str, fake: &Fake) -> Shell {
    let (mut s, _home) = shell(name, Some(fake.cmd()), true);
    s.features.control = cut_app::control::Control::new(None);
    s.features.ai.assistant.agent =
        Arc::new(cut_app::ai::agent::Agent::new(Arc::new(Cli::with_switch(Some(fake.cmd()))), Duration::from_secs(60)));
    s.doc.settings.set("assistant.acknowledged", Json::Bool(true));
    with_captions(&mut s, &["one"], "en");
    s
}

/// A POST of a tools/list with `token` to the server at `url` -> the status.
fn post_with(url: &str, token: &str) -> u16 {
    use std::io::{Read, Write};
    let port: u16 = url.trim_start_matches("http://127.0.0.1:").trim_end_matches("/mcp").parse().unwrap();
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    c.write_all(req.as_bytes()).unwrap();
    let mut head = [0u8; 12];
    c.read_exact(&mut head).unwrap();
    String::from_utf8_lossy(&head[9..12]).parse().unwrap()
}

#[test]
fn an_assistant_turn_edits_through_the_control_server_as_one_step() {
    let fake = Fake::new(
        "assistant",
        json!([{ "mcp": [
            { "name": "add_marker", "arguments": { "at": 1, "name": "A" } },
            { "name": "add_marker", "arguments": { "at": 99999, "name": "B" } },
            { "name": "add_marker", "arguments": { "at": 2, "name": "C" } },
        ], "answer": "Added two markers." }]),
    );
    let mut s = assistant_shell("assistant", &fake);
    let ctx = eframe::egui::Context::default();
    let (floor, marks) = (s.app.history.position(), s.app.sequence().unwrap().markers.len());
    assert!(cut_app::ai::assistant::ask(&mut s, &ctx, "add two markers"));
    run_turn(&mut s, &ctx);
    assert_eq!(s.app.sequence().unwrap().markers.len(), marks + 2, "the refused call changed nothing");
    assert_eq!(s.app.history.position(), floor + 1, "the turn's edits are one undo step");
    assert_eq!(s.app.history.step(floor).map(|x| x.0), Some("add two markers"));
    let Some(cut_app::ai::assistant::Bubble::Assistant(r)) = s.features.ai.assistant.log.last() else {
        panic!("the reply")
    };
    use cut_app::ai::assistant::{Item, State};
    let states: Vec<State> =
        r.items.iter().filter_map(|i| if let Item::Step { state, .. } = i { Some(*state) } else { None }).collect();
    assert_eq!(states, [State::Done, State::Refused, State::Done]);
    assert_eq!((r.text.as_str(), r.result.as_deref(), r.edits), ("Added two markers.", Some("ok"), 2));
    assert!(r.usage.is_some());
    let call = &fake.calls()[0];
    let args: Vec<&str> = call["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    let allowed = args[args.iter().position(|a| *a == "--allowedTools").unwrap() + 1];
    assert!(allowed.split(',').all(|t| t.starts_with("mcp__cut__")) && allowed.contains("mcp__cut__add_marker"));
    let config = args[args.iter().position(|a| *a == "--mcp-config").unwrap() + 1];
    assert!(!Path::new(config).exists(), "the config is gone");
    let mcp: Json = serde_json::from_str(call["mcpConfig"].as_str().unwrap()).unwrap();
    let server = &mcp["mcpServers"]["cut"];
    let token = server["headers"]["Authorization"].as_str().unwrap().trim_start_matches("Bearer ");
    assert_eq!(post_with(server["url"].as_str().unwrap(), token), 401, "the turn's token is refused after it");
    assert!(s.app.undo());
    assert_eq!(s.app.sequence().unwrap().markers.len(), marks, "one Ctrl+Z undoes the turn");
}

#[test]
fn stop_ends_an_assistant_turn() {
    let fake = Fake::new("assistant-stop", json!([{ "sleepMs": 20000, "answer": "late" }]));
    let mut s = assistant_shell("assistant-stop", &fake);
    let ctx = eframe::egui::Context::default();
    assert!(cut_app::ai::assistant::ask(&mut s, &ctx, "do something"));
    std::thread::sleep(Duration::from_millis(500));
    assert!(cut_app::ai::assistant::stop(&mut s));
    let started = std::time::Instant::now();
    run_turn(&mut s, &ctx);
    assert!(started.elapsed() < Duration::from_secs(15));
    let Some(cut_app::ai::assistant::Bubble::Assistant(r)) = s.features.ai.assistant.log.last() else { panic!() };
    assert_eq!(r.result.as_deref(), Some("cancelled"));
    assert_eq!(r.text, "Stopped. What was done so far is kept as one undo step.");
}
