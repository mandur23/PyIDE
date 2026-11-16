//! The files module against `main/cut/project.js` and `paths.js` (`tools/scenarios/project.mjs`): the same paths,
//! names and folders give the same answers, and each editor recovers the sessions the other left behind.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use cut_app::files::{Code, FileError, KEEP, Projects, ReadOk, Run, WriteOk, autosave_name, ext_of, local_path};
use cut_oracle::{Inputs, ask_scenario};
use serde_json::{Value, json};

fn work(name: &str) -> PathBuf {
    let base = std::env::var_os("CUT_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!("cut-files-oracle-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A JavaScript `{ error, code }` without its message, which is free text on both sides.
fn without_message(mut v: Value) -> Value {
    if let Some(m) = v.as_object_mut() {
        m.remove("error");
    }
    v
}

fn error_json(e: &FileError) -> Value {
    if e.code == Code::Missing {
        return json!({ "missing": true });
    }
    let mut v = json!({ "code": e.code.as_str() });
    if let Some(t) = e.mtime {
        v["mtime"] = json!(t);
    }
    v
}

fn read_json(r: &Result<ReadOk, FileError>) -> Value {
    match r {
        Ok(ok) => {
            let mut v = json!({ "text": ok.text, "path": text(&ok.path), "mtime": ok.mtime });
            if ok.autosave {
                v["autosave"] = json!(true);
            }
            v
        }
        Err(e) => error_json(e),
    }
}

fn write_json(r: &Result<WriteOk, FileError>, dir: &Path) -> Value {
    let rel = |p: &Option<PathBuf>| p.as_ref().map(|p| text(p.strip_prefix(dir).unwrap_or(p)));
    match r {
        Ok(ok) => {
            json!({ "ok": true, "path": rel(&Some(ok.path.clone())), "bak": rel(&ok.bak), "kept": rel(&ok.kept) })
        }
        Err(e) => json!({ "code": e.code.as_str() }),
    }
}

#[test]
fn files_oracle_local_paths() {
    let cases = [
        "C:\\a\\b.ncut",
        "c:/a/./b/../c.NCUT",
        "C:\\",
        "C:/",
        "C:\\a\\\\b\\",
        "C:\\..\\..\\x",
        "C:x.ncut",
        "C:\\a:b",
        "C:\\a\\b.ncut:stream",
        "\\\\?\\C:\\long\\x.ncut",
        "//?/c:/long",
        "\\\\?\\UNC\\host\\share",
        "\\\\.\\PhysicalDrive0",
        "\\\\.\\C:\\x",
        "\\\\?\\C:\\a\nb",
        "\\\\?\\Volume{x}\\a",
        "\\\\host\\share\\x.ncut",
        "//host/share",
        "\\??\\UNC\\host\\x",
        "UNC\\host\\x",
        "unc\\x",
        "relative\\x.ncut",
        "\\rooted\\x.ncut",
        "",
        "C:\\a\0b",
        "C:\\ünï\\çødé\\😀.ncut",
        "C:\\a.b.c\\.ncut",
        "C:\\a\\..ncut",
        "C:\\a\\x.ncut.",
        "C:\\a\\x.ncut ",
        "C:\\a\\x.",
        "C:\\a\\..",
        "Z:\\trailing\\dots...\\",
    ];
    let long = format!("C:\\{}", "a".repeat(32767));
    let mut all: Vec<String> = cases.iter().map(|s| (*s).to_owned()).collect();
    all.push(long);
    all.push(format!("C:\\{}", "a".repeat(32760)));
    let calls: Vec<Value> = all.iter().flat_map(|p| [json!(["localPath", p]), json!(["extOf", p])]).collect();
    let answers = ask_scenario("project", &calls);
    for (i, p) in all.iter().enumerate() {
        let js = without_message(answers[2 * i].clone());
        let rust = match local_path(p) {
            Ok(path) => json!({ "path": path }),
            Err(e) => json!({ "code": e.code.as_str() }),
        };
        assert_eq!(rust, js, "localPath {p:?}");
        assert_eq!(json!(ext_of(p)), answers[2 * i + 1], "extOf {p:?}");
    }
}

#[test]
fn files_oracle_autosave_names() {
    let w = work("names");
    let mut keys: Vec<String> = [
        "C:\\Users\\me\\Projects\\Trip.ncut",
        "c:\\users\\ME\\projects\\TRIP.NCUT",
        "C:/Users/me/./Projects/../Projects/Trip.ncut",
        "\\\\?\\C:\\Users\\me\\Trip.ncut",
        "C:\\",
        "C:\\a\\Trip.ncut\\",
        "C:\\a\\.ncut",
        "C:\\a\\ ..Trip.. ",
        "C:\\a\\Ünïcödé ΣΑΣ İ.ncut",
        "C:\\a\\na<m>e|\"q\"?*.ncut",
        "untitled-7",
        "untitled-1700000000000",
        "..\\..\\..\\evil",
        "\\\\host\\share\\x.ncut",
        "key:with:colons",
        " . ",
        "\u{feff}\u{a0}name\u{3000}",
        "tab\there\nnewline",
        "C:x.ncut",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    keys.push(format!("C:\\a\\{}.ncut", "😀".repeat(40)));
    keys.push(format!("C:\\a\\b{}.ncut", "😀".repeat(40)));
    keys.push("x".repeat(1024));
    keys.push(format!("untitled-{}", "y".repeat(100)));
    let mut inputs = Inputs::new(7);
    let mut cases = Vec::new();
    for (i, key) in keys.iter().enumerate() {
        // Not 0: the JavaScript's first stamp of a run is at least 1.
        for &t in &[1, 951_782_400_000, 1_709_208_000_999, 4_107_542_399_999, 253_402_300_799_999] {
            cases.push((key.clone(), t, i % 2 == 0));
        }
        for _ in 0..3 {
            cases.push((key.clone(), inputs.range(0, 4_102_444_800_000), inputs.range(0, 1) == 1));
        }
    }
    let calls: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(i, (key, t, latest))| json!(["autosaveName", text(&w.join(i.to_string())), key, t, latest]))
        .collect();
    let answers = ask_scenario("project", &calls);
    for ((key, t, latest), js) in cases.iter().zip(&answers) {
        assert_eq!(json!(autosave_name(key, *t, *latest)), *js, "{key:?} at {t}");
    }
}

#[test]
fn files_oracle_read_and_write() {
    let base = work("rw");
    let js_dir = base.join("js");
    let rs_dir = base.join("rs");
    let setup = |d: &Path| {
        fs::create_dir_all(d.join("Autosave")).unwrap();
        fs::write(d.join("plain.ncut"), "{\"version\":1}").unwrap();
        fs::write(d.join("bom.ncut"), "\u{feff}{\"version\":1}").unwrap();
        fs::write(d.join("bad-utf8.ncut"), b"{\"v\":\"\xff\xfe\xc3\"}").unwrap();
        fs::write(d.join("text.txt"), "x").unwrap();
        fs::create_dir(d.join("folder.ncut")).unwrap();
        fs::write(d.join("Autosave").join("copy.ncut"), "{}").unwrap();
    };
    setup(&js_dir);
    setup(&rs_dir);
    let mut rs = Projects::new(rs_dir.join("Autosave"));
    let reads = [
        "plain.ncut",
        "bom.ncut",
        "bad-utf8.ncut",
        "text.txt",
        "folder.ncut",
        "gone.ncut",
        "Autosave\\copy.ncut",
        "PLAIN.NCUT",
    ];
    let calls: Vec<Value> =
        reads.iter().map(|n| json!(["projectRead", text(&js_dir.join("Autosave")), text(&js_dir.join(n))])).collect();
    let answers = ask_scenario("project", &calls);
    for (n, js) in reads.iter().zip(answers) {
        let mut js = without_message(js);
        if let Some(p) = js.get("path").and_then(Value::as_str) {
            js["path"] = json!(p.replace(&text(&js_dir), &text(&rs_dir)));
        }
        let rust = read_json(&rs.project_read(&rs_dir.join(n)));
        if let (Some(a), Some(b)) = (rust.get("mtime"), js.get("mtime")) {
            assert!(
                a.as_f64().unwrap().fract() != 0.0 || b.as_f64().unwrap().fract() == 0.0,
                "mtimes keep their fraction"
            );
        }
        let strip = |mut v: Value| {
            v.as_object_mut().map(|m| m.remove("mtime"));
            v
        };
        assert_eq!(strip(rust), strip(js), "projectRead {n}");
    }

    let mtime_calls: Vec<Value> =
        ["plain.ncut", "bom.ncut"].iter().map(|n| json!(["mtimeOf", text(&rs_dir.join(n))])).collect();
    let js_mtimes = ask_scenario("project", &mtime_calls);
    for (n, js) in ["plain.ncut", "bom.ncut"].iter().zip(js_mtimes) {
        assert_eq!(json!(rs.project_read(&rs_dir.join(n)).unwrap().mtime), js, "mtimeMs of {n} as Node computes it");
    }

    let writes = [
        ("p.ncut", "{\"version\":1,\"a\":1}"),
        ("p.ncut", "{\"version\":1,\"a\":2}"),
        ("p.ncut", "{\"version\":2}"),
        ("p.ncut", "{\"version\":2.0,\"b\":1}"),
        ("p.ncut", "[]"),
        ("p.ncut", "{}"),
        ("p.ncut", "{\"version\":\"x\"}"),
        ("p.ncut", "{\"version\":\"x\"}"),
        ("p.ncut", "{\"version\":{}}"),
        ("p.ncut", "{\"version\":1.5}"),
        ("p.ncut", "{\"version\":3}"),
        ("p.ncut", "not json"),
        ("p.ncut", "5"),
        ("p.ncut", "null"),
        ("p.ncut", "\"str\""),
        ("p.ncut", "{\"version\":1} trailing"),
        ("p.ncut", " {\"version\":4} "),
        ("bom.ncut", "{\"version\":1}"),
        ("bad-utf8.ncut", "{\"version\":1}"),
        ("p.txt", "{\"version\":1}"),
        ("folder.ncut", "{\"version\":1}"),
        ("Autosave\\new.ncut", "{\"version\":1}"),
        ("missing\\x.ncut", "{\"version\":1}"),
    ];
    for (n, body) in writes {
        let js = ask_scenario(
            "project",
            &[json!(["projectWrite", text(&js_dir.join("Autosave")), text(&js_dir.join(n)), body, null])],
        );
        let mut js = without_message(js[0].clone());
        for k in ["path", "bak", "kept"] {
            if let Some(p) = js.get(k).and_then(Value::as_str) {
                js[k] = json!(p.strip_prefix(&format!("{}\\", text(&js_dir))).unwrap_or(p));
            }
        }
        js.as_object_mut().map(|m| m.remove("mtime"));
        let rust = write_json(&rs.project_write(&rs_dir.join(n), body, None), &rs_dir);
        let rust = match rust.get("path").and_then(Value::as_str) {
            Some(p) => {
                let mut r = rust.clone();
                r["path"] = json!(p.trim_start_matches('\\'));
                for k in ["bak", "kept"] {
                    if let Some(q) = r[k].as_str() {
                        r[k] = json!(q.trim_start_matches('\\'));
                    }
                }
                r
            }
            None => rust,
        };
        assert_eq!(rust, js, "projectWrite {n} {body}");
    }
    let listing = |d: &Path| {
        let mut v: Vec<(String, Vec<u8>)> = fs::read_dir(d)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().is_file())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), fs::read(e.path()).unwrap()))
            .collect();
        v.sort();
        v
    };
    assert_eq!(listing(&rs_dir), listing(&js_dir), "the same files with the same bytes are left behind");

    let r = rs.project_read(&rs_dir.join("p.ncut")).unwrap();
    let changed = rs.project_write(&rs_dir.join("p.ncut"), "{\"version\":4}", Some(r.mtime - 1.0)).unwrap_err();
    let js = ask_scenario("project", &[json!(["mtimeOf", text(&rs_dir.join("p.ncut"))])]);
    assert_eq!((changed.code, changed.mtime.map(|m| json!(m))), (Code::Changed, Some(js[0].clone())));
}

#[test]
fn files_oracle_sessions_cross_editors() {
    let w = work("cross");
    let auto = w.join("Autosave");
    fs::create_dir_all(&auto).unwrap();
    let js_key = text(&w.join("Projects").join("From JS.ncut"));
    let started = now();
    ask_scenario(
        "project",
        &[json!(["abandon", text(&auto), 999_999, "a1b2c3d4e5f6", started, js_key, ["{\"n\":1}", "{\"n\":2}"]])],
    );
    let rs = Projects::new(&auto);
    let offers = rs.recovery();
    assert_eq!(offers.len(), 1, "the Rust editor recovers a session the JavaScript one left");
    assert_eq!(offers[0].key, js_key);
    assert_eq!(fs::read_to_string(&offers[0].file).unwrap(), "{\"n\":2}");
    let js_list = ask_scenario("project", &[json!(["autosavesOf", text(&auto), js_key])]);
    let rs_list: Vec<Value> = rs
        .autosaves_of(&js_key)
        .iter()
        .map(|a| json!({ "file": text(&a.file), "time": a.time, "latest": a.latest }))
        .collect();
    assert_eq!(json!(rs_list), js_list[0], "both list a key's autosaves alike");
    rs.dismiss(&js_key).unwrap();

    let rs_key = "untitled-42";
    let mut gone = Projects::with_run(&auto, Run { pid: 999_999, run: "0f0f0f0f0f0f".into(), started: now() });
    gone.session_start(rs_key).unwrap();
    gone.autosave(rs_key, "{\"n\":3}", false, KEEP).unwrap();
    let newest = gone.autosave(rs_key, "{\"n\":4}", true, KEEP).unwrap();
    let mut child = Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
    let mut live = Projects::with_run(&auto, Run { pid: child.id(), run: "abcabcabcabc".into(), started: now() });
    live.session_start("untitled-43").unwrap();
    live.autosave("untitled-43", "{\"n\":5}", false, KEEP).unwrap();

    let js = ask_scenario("project", &[json!(["recovery", text(&auto)])]);
    let rs_offers: Vec<Value> = Projects::new(&auto)
        .recovery()
        .iter()
        .map(|o| json!({ "key": o.key, "file": text(&o.file), "time": o.time }))
        .collect();
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(
        js[0],
        json!([{ "key": rs_key, "file": text(&newest), "time": gone.autosaves_of(rs_key)[0].time }]),
        "the JavaScript editor recovers a Rust session, not a live one"
    );
    assert_eq!(json!(rs_offers), js[0], "both offer the same");
}
