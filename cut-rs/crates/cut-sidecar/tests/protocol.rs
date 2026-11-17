//! The line protocol against a server that is this test binary itself (`CUT_SIDECAR_TEST_SERVER=1`): requests and
//! replies by id, events, stderr as log, lines that are not JSON skipped, a cancel by notify, the idle stop, a crash
//! answering what was in flight, a program that cannot start.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cut_sidecar::{Sidecar, Spec};
use serde_json::{Value as Json, json};

/// The pretend server: `echo` answers at once, `slow` after its ms unless cancelled, `crash` exits with 3; it writes
/// an event and a line of noise first, and ends at the end of its input.
#[test]
fn server() {
    if std::env::var_os("CUT_SIDECAR_TEST_SERVER").is_none() {
        return;
    }
    let out = std::io::stdout();
    let say = |v: Json| {
        let mut o = out.lock();
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };
    // the test harness has written "test server ... " without its line's end
    println!();
    say(json!({ "event": "loading" }));
    println!("not json at all");
    eprintln!("a line of log");
    let (tx, rx) = std::sync::mpsc::channel::<Json>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Json>(&line) {
                let _ = tx.send(v);
            }
        }
    });
    let mut cancelled = std::collections::HashSet::new();
    let mut queue: std::collections::VecDeque<Json> = Default::default();
    loop {
        let msg = match queue.pop_front() {
            Some(m) => m,
            None => match rx.recv() {
                Ok(m) => m,
                Err(_) => std::process::exit(0),
            },
        };
        let id = msg["id"].clone();
        match msg["op"].as_str() {
            Some("echo") => say(json!({ "id": id, "text": msg["text"] })),
            Some("cancel") => {
                cancelled.insert(msg["target"].as_u64().unwrap_or(0));
            }
            Some("slow") => {
                let until = Instant::now() + Duration::from_millis(msg["ms"].as_u64().unwrap_or(0));
                let me = id.as_u64().unwrap_or(0);
                while Instant::now() < until && !cancelled.contains(&me) {
                    while let Ok(m) = rx.try_recv() {
                        if m["op"] == "cancel" {
                            cancelled.insert(m["target"].as_u64().unwrap_or(0));
                        } else if m["op"] == "crash" {
                            std::process::exit(3);
                        } else {
                            queue.push_back(m);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                if cancelled.contains(&me) {
                    say(json!({ "id": id, "cancelled": true }));
                } else {
                    say(json!({ "id": id, "done": true }));
                }
            }
            Some("crash") => std::process::exit(3),
            _ => {}
        }
    }
}

type Seen = (Arc<Mutex<Vec<Json>>>, Arc<Mutex<String>>, Arc<Mutex<Vec<Option<i32>>>>);

fn spec(idle_ms: u64) -> (Spec, Seen) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::new(Mutex::new(String::new()));
    let exits = Arc::new(Mutex::new(Vec::new()));
    let (e, l, x) = (events.clone(), log.clone(), exits.clone());
    let spec = Spec {
        program: std::env::current_exe().unwrap(),
        args: vec!["--exact".into(), "server".into(), "--nocapture".into(), "--test-threads=1".into()],
        cwd: std::env::temp_dir(),
        env: vec![("CUT_SIDECAR_TEST_SERVER".into(), "1".into())],
        idle_ms: Arc::new(AtomicU64::new(idle_ms)),
        on_event: Box::new(move |v| e.lock().unwrap().push(v)),
        on_log: Box::new(move |t| l.lock().unwrap().push_str(t)),
        on_exit: Box::new(move |c| x.lock().unwrap().push(c)),
    };
    (spec, (events, log, exits))
}

fn until(what: &str, f: impl Fn() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn requests_events_cancel_and_crash() {
    let (spec, (events, log, exits)) = spec(0);
    let sc = Sidecar::start(spec);
    let a = sc.send(json!({ "op": "echo", "text": "한글 ok" }));
    let b = sc.send(json!({ "op": "echo", "text": "two" }));
    assert_eq!((a.id, b.id), (1, 2));
    assert_eq!(a.wait()["text"], "한글 ok");
    assert_eq!(b.wait()["text"], "two");
    until("the event", || events.lock().unwrap().iter().any(|e| e["event"] == "loading"));
    until("the log", || log.lock().unwrap().contains("a line of log"));
    let slow = sc.send(json!({ "op": "slow", "ms": 20000 }));
    std::thread::sleep(Duration::from_millis(100));
    sc.notify(&json!({ "op": "cancel", "target": slow.id }));
    assert_eq!(slow.wait()["cancelled"], true);
    let lost = sc.send(json!({ "op": "slow", "ms": 20000 }));
    let _ = sc.send(json!({ "op": "crash" }));
    let r = lost.wait();
    assert!(r["error"].as_str().unwrap().starts_with("server exited ("), "{r}");
    until("the end", || !sc.alive());
    assert_eq!(exits.lock().unwrap().len(), 1, "on_exit once");
    assert_eq!(sc.send(json!({ "op": "echo" })).wait()["error"], "server is not running");
}

#[test]
fn the_idle_timeout_closes_the_input() {
    let (s, (_, _, exits)) = spec(200);
    let sc = Sidecar::start(s);
    assert_eq!(sc.send(json!({ "op": "echo", "text": "x" })).wait()["text"], "x");
    until("the idle stop", || !sc.alive());
    until("the exit", || !exits.lock().unwrap().is_empty());
    assert_eq!(exits.lock().unwrap()[0], Some(0), "a clean end on end-of-input, not a crash");
    // 0 keeps it running, and `idle` after a change re-reads it
    let (s, _) = spec(0);
    let keep = s.idle_ms.clone();
    let sc = Sidecar::start(s);
    assert_eq!(sc.send(json!({ "op": "echo", "text": "y" })).wait()["text"], "y");
    std::thread::sleep(Duration::from_millis(400));
    assert!(sc.alive());
    keep.store(100, Ordering::Relaxed);
    sc.idle();
    until("the stop after the change", || !sc.alive());
}

#[test]
fn kill_and_a_program_that_cannot_start() {
    let (s, _) = spec(0);
    let sc = Sidecar::start(s);
    let slow = sc.send(json!({ "op": "slow", "ms": 20000 }));
    sc.kill();
    assert!(!sc.alive());
    assert!(slow.wait()["error"].as_str().unwrap().starts_with("server exited"));
    let (mut s, (_, log, exits)) = spec(0);
    s.program = PathBuf::from("C:\\no\\such\\python.exe");
    let sc = Sidecar::start(s);
    assert!(!sc.alive());
    assert_eq!(*exits.lock().unwrap(), vec![Some(-1)]);
    assert!(!log.lock().unwrap().is_empty());
    assert_eq!(sc.send(json!({ "op": "echo" })).wait()["error"], "server is not running");
}
