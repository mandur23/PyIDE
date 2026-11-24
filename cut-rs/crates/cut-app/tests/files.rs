//! The project file I/O on real folders: the cases `verify/cut-main.mjs` checks for projectRead, projectWrite,
//! autosave, sessions and recovery, plus the native app's settings. Folders go under `CUT_TEST_TMP` (else the system
//! temp folder), never the real workspace.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cut_app::files::{
    Code, Home, KEEP, Projects, Recent, Run, Settings, autosave_name, hash_of, stamp_of, write_atomic,
};
use serde_json::{Value, json};

fn work(name: &str) -> PathBuf {
    let base = std::env::var_os("CUT_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!("cut-files-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn read(p: &Path) -> String {
    fs::read_to_string(p).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> =
        fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn s(v: Value) -> String {
    v.to_string()
}

/// A process that runs until killed, to stand for another editor that is alive.
fn live_process() -> Child {
    Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap()
}

/// A run that is gone: Windows pids are multiples of 4, so 999999 is never a process.
fn dead_run(run: &str) -> Run {
    Run { pid: 999_999, run: run.to_owned(), started: now() }
}

#[test]
fn files_home_folders() {
    let root = work("home");
    let h = Home::at(root.join("Nano Studio Cut"));
    h.ensure().unwrap();
    h.ensure().unwrap();
    for d in [&h.projects, &h.autosave, &h.cache] {
        assert!(d.is_dir() && d.starts_with(&h.home));
    }
    assert_eq!(h.autosave, h.home.join("Autosave"));
    assert!(Home::resolve().home.is_absolute());
}

#[test]
fn files_projects_read_and_write() {
    let w = work("projects");
    let h = Home::at(&w);
    h.ensure().unwrap();
    let mut p = Projects::new(&h.autosave);
    let proj = h.projects.join("Trip.ncut");
    let v1 = s(json!({ "format": "ncut", "version": 1, "name": "first" }));
    assert_eq!(p.project_read(&proj).unwrap_err().code, Code::Missing, "a project not written yet is missing");
    let w1 = p.project_write(&proj, &v1, None).unwrap();
    assert!(
        read(&proj) == v1 && w1.bak.is_none() && !PathBuf::from(format!("{}.bak", proj.display())).exists(),
        "nothing kept the first time"
    );
    let r1 = p.project_read(&proj).unwrap();
    assert!(r1.text == v1 && !r1.autosave && r1.path == proj);
    fs::write(&proj, format!("\u{feff}{v1}")).unwrap();
    assert_eq!(p.project_read(&proj).unwrap().text, v1, "a byte order mark is dropped on read");

    let bak = PathBuf::from(format!("{}.bak", proj.display()));
    let v1b = s(json!({ "format": "ncut", "version": 1, "name": "second" }));
    let wb = p.project_write(&proj, &v1b, None).unwrap();
    assert!(
        read(&proj) == v1b
            && wb.bak.as_ref() == Some(&bak)
            && read(&bak) == format!("\u{feff}{v1}")
            && wb.kept.is_none(),
        "{wb:?}"
    );
    let v2 = s(json!({ "format": "ncut", "version": 2, "name": "migrated" }));
    let w2 = p.project_write(&proj, &v2, None).unwrap();
    let kept = PathBuf::from(format!("{}.v1.bak", proj.display()));
    assert!(w2.kept.as_ref() == Some(&kept) && read(&kept) == v1b && read(&bak) == v1b && read(&proj) == v2, "{w2:?}");
    p.project_write(&proj, &s(json!({ "format": "ncut", "version": 2, "name": "again" })), None).unwrap();
    assert!(read(&kept) == v1b && read(&bak) == v2, "the next save in the new version keeps the migration backup");
    p.project_write(&proj, &v2, None).unwrap();
    assert!(!names(&h.projects).iter().any(|n| n.ends_with(".tmp")), "no temporary files are left");

    let r = p.project_read(&proj).unwrap();
    let mine =
        p.project_write(&proj, &s(json!({ "format": "ncut", "version": 2, "name": "mine" })), Some(r.mtime)).unwrap();
    let disk = p.project_read(&proj).unwrap().mtime;
    assert_eq!(mine.mtime, Some(disk), "a save with the time it was read writes and returns the new time");
    let theirs = s(json!({ "format": "ncut", "version": 2, "name": "theirs" }));
    fs::write(&proj, &theirs).unwrap();
    fs::File::options()
        .write(true)
        .open(&proj)
        .unwrap()
        .set_modified(SystemTime::now() + Duration::from_secs(5))
        .unwrap();
    let stale =
        p.project_write(&proj, &s(json!({ "format": "ncut", "version": 2, "name": "stale" })), mine.mtime).unwrap_err();
    assert!(
        stale.code == Code::Changed
            && stale.mtime == Some(p.project_read(&proj).unwrap().mtime)
            && read(&proj) == theirs,
        "{stale:?}"
    );
    assert!(p.project_write(&proj, &v2, None).is_ok() && read(&proj) == v2, "without a time it writes");
    let fresh = h.projects.join("new-one.ncut");
    assert!(
        p.project_write(&fresh, &v2, Some(123.0)).is_ok(),
        "a time for a file not there yet does not stop the save"
    );
    fs::remove_file(&fresh).unwrap();

    fn code<T: std::fmt::Debug>(r: Result<T, cut_app::files::FileError>) -> Code {
        r.unwrap_err().code
    }
    assert_eq!(code(p.project_write(&h.projects.join("evil.bat"), &v1, None)), Code::Extension);
    assert!(!h.projects.join("evil.bat").exists());
    assert_eq!(code(p.project_write(&h.projects.join("x.ncut"), "not json", None)), Code::BadArgs);
    assert_eq!(code(p.project_write(&h.projects.join("x.ncut"), "5", None)), Code::BadArgs);
    assert_eq!(code(p.project_write(&w.join("no-such-folder").join("x.ncut"), &v1, None)), Code::Missing);
    assert_eq!(code(p.project_write(Path::new("\\\\127.0.0.1\\share$\\x.ncut"), &v1, None)), Code::Network);
    assert_eq!(code(p.project_write(Path::new("relative\\x.ncut"), &v1, None)), Code::BadArgs);
    let secret = w.join("secret.txt");
    fs::write(&secret, "x").unwrap();
    assert_eq!(code(p.project_read(&secret)), Code::Extension);
    fs::create_dir(h.projects.join("folder.ncut")).unwrap();
    assert_eq!(code(p.project_read(&h.projects.join("folder.ncut"))), Code::NotFile);
    assert_eq!(code(p.project_write(&h.projects.join("folder.ncut"), &v1, None)), Code::NotFile);

    let mut perms = fs::metadata(&proj).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&proj, perms.clone()).unwrap();
    let locked = p.project_write(&proj, &s(json!({ "format": "ncut", "version": 2, "name": "lost" })), None);
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(&proj, perms).unwrap();
    assert_eq!(code(locked), Code::Io, "a read-only project cannot be replaced");
    assert!(
        read(&proj) == v2 && !names(&h.projects).iter().any(|n| n.ends_with(".tmp")),
        "the old project stays whole"
    );
}

#[test]
fn files_autosave_rotation() {
    let w = work("autosave");
    let h = Home::at(&w);
    h.ensure().unwrap();
    let mut p = Projects::new(&h.autosave);
    let key_a = h.projects.join("Trip.ncut").to_string_lossy().into_owned();
    for i in 1..=25 {
        p.autosave(&key_a, &s(json!({ "format": "ncut", "version": 1, "n": i })), false, KEEP).unwrap();
    }
    for i in 1..=3 {
        p.autosave("untitled-7", &s(json!({ "format": "ncut", "version": 1, "n": i })), false, KEEP).unwrap();
    }
    let all = names(&h.autosave);
    let of_a: Vec<_> = all.iter().filter(|n| n.starts_with("Trip-")).collect();
    let nums: Vec<i64> = of_a
        .iter()
        .map(|n| serde_json::from_str::<Value>(&read(&h.autosave.join(n))).unwrap()["n"].as_i64().unwrap())
        .collect();
    assert_eq!(nums, (6..=25).collect::<Vec<_>>(), "the 20 newest autosaves of a project are kept, in order");
    assert_eq!(all.iter().filter(|n| n.starts_with("untitled-7-")).count(), 3, "another key's autosaves are its own");
    let same_name = w.join("elsewhere").join("Trip.ncut").to_string_lossy().into_owned();
    p.autosave(&same_name, "{\"n\":\"other\"}", false, KEEP).unwrap();
    assert_eq!(
        names(&h.autosave).iter().filter(|n| n.starts_with("Trip-")).count(),
        21,
        "a namesake elsewhere keeps its own"
    );
    let evil = p.autosave("..\\..\\..\\evil", "{}", false, KEEP).unwrap();
    assert!(
        evil.parent() == Some(h.autosave.as_path()) && !w.join("evil.ncut").exists(),
        "a key with ..\\ stays in the Autosave folder"
    );
    assert_eq!(p.autosave("", "x", false, KEEP).unwrap_err().code, Code::BadArgs, "an empty key is refused");
    assert_eq!(
        p.autosave(&"k".repeat(1025), "x", false, KEEP).unwrap_err().code,
        Code::BadArgs,
        "a key too long is refused"
    );

    let key_l = w.join("latest").join("Lat.ncut").to_string_lossy().into_owned();
    for i in 1..=4 {
        p.autosave(&key_l, &s(json!({ "n": format!("c{i}") })), false, 3).unwrap();
    }
    for i in 1..=6 {
        p.autosave(&key_l, &s(json!({ "n": format!("l{i}") })), true, KEEP).unwrap();
    }
    let n_of = |f: &Path| serde_json::from_str::<Value>(&read(f)).unwrap()["n"].as_str().unwrap().to_owned();
    let of_l: Vec<_> = names(&h.autosave).into_iter().filter(|n| n.starts_with("Lat-")).collect();
    let lnums: Vec<_> = of_l.iter().map(|n| n_of(&h.autosave.join(n))).collect();
    assert_eq!(lnums, ["c2", "c3", "c4", "l6"], "copies keep the newest keep, the latest state only its newest");
    assert_eq!(of_l.iter().filter(|n| n.ends_with(".latest.ncut")).count(), 1);
    let saves = p.autosaves_of(&key_l);
    assert_eq!(saves.iter().map(|a| n_of(&a.file)).collect::<Vec<_>>(), ["l6", "c4", "c3", "c2"], "newest first");
    assert_eq!(saves.iter().map(|a| a.latest).collect::<Vec<_>>(), [true, false, false, false]);
    assert!(saves.windows(2).all(|w| w[0].time > w[1].time), "stamps increase within a run");
    assert!(p.autosaves_of("").is_empty());

    let opened = p.project_read(&saves[1].file).unwrap();
    assert!(opened.autosave && n_of(&saves[1].file) == "c4", "a file in the Autosave folder reads as an autosave");
    let in_place = p.project_write(&saves[1].file, "{\"version\":1,\"n\":\"mine\"}", None).unwrap_err();
    let as_new = p.project_write(&h.autosave.join("Keep.ncut"), "{\"version\":1}", None).unwrap_err();
    assert!(
        in_place.code == Code::Autosave && as_new.code == Code::Autosave,
        "nothing is saved into the Autosave folder"
    );
    assert!(n_of(&saves[1].file) == "c4" && !h.autosave.join("Keep.ncut").exists());
    assert_eq!(p.autosave(&key_l, "{}", false, 0).map(|_| ()), Ok(()), "keep 0 counts as 1");
    assert_eq!(p.autosaves_of(&key_l).iter().filter(|a| !a.latest).count(), 1);
}

#[test]
fn files_sessions_and_recovery() {
    let w = work("sessions");
    let h = Home::at(&w);
    h.ensure().unwrap();
    let k = |n: u32| h.projects.join(format!("Session {n}.ncut")).to_string_lossy().into_owned();
    fs::write(k(4), "{\"format\":\"ncut\",\"version\":1}").unwrap();
    let mut a = Projects::with_run(&h.autosave, dead_run("a0a0a0a0a0a0"));
    a.session_start(&k(1)).unwrap();
    a.autosave(&k(1), "{\"n\":1}", false, KEEP).unwrap();
    a.session_start(&k(2)).unwrap();
    a.autosave(&k(2), "{\"n\":2}", false, KEEP).unwrap();
    a.session_end(&k(2)).unwrap();
    a.session_start(&k(3)).unwrap();
    a.session_start(&k(4)).unwrap();
    a.autosave(&k(4), "{\"n\":4}", false, KEEP).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    a.project_write(Path::new(&k(4)), "{\"version\":1,\"saved\":true}", None).unwrap();
    a.session_start(&k(5)).unwrap();
    a.autosave(&k(5), "{\"n\":5}", false, KEEP).unwrap();
    a.session_start("untitled-6").unwrap();
    a.autosave("untitled-6", "{\"n\":6}", false, KEEP).unwrap();
    a.autosave("untitled-6", "{\"n\":6.1}", true, KEEP).unwrap();

    let mut other = live_process();
    let marker =
        json!({ "pid": other.id(), "run": "feedface", "started": now() - 1000, "key": k(7), "since": now() - 1000 });
    fs::write(
        h.autosave.join(".sessions").join(format!("{}-feedface-{}.json", other.id(), "0".repeat(8))),
        marker.to_string(),
    )
    .unwrap();
    a.autosave(&k(7), "{\"n\":7}", false, KEEP).unwrap();
    fs::write(h.autosave.join(".sessions").join("1-ab-00000000.json"), "not json").unwrap();
    assert!(a.recovery().is_empty(), "while a run lives, its sessions are not offered");

    let marker_name = format!("999999-a0a0a0a0a0a0-{}.json", hash_of(&k(1)));
    let on_disk: Value = serde_json::from_str(&read(&h.autosave.join(".sessions").join(&marker_name))).unwrap();
    let keys: Vec<&str> = on_disk.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys.len(), 7);
    assert!(on_disk["pid"] == 999_999 && on_disk["run"] == "a0a0a0a0a0a0" && on_disk["key"] == k(1).as_str());
    assert!(
        on_disk["saved"].is_null()
            && on_disk["crashed"] == false
            && on_disk["since"].is_i64()
            && on_disk["started"].is_i64()
    );

    let mut b = Projects::new(&h.autosave);
    let rec = b.recovery();
    let mut keys: Vec<&str> = rec.iter().map(|r| r.key.as_str()).collect();
    keys.sort_unstable();
    let mut want = vec![k(1), k(5), "untitled-6".to_owned()];
    want.sort();
    assert_eq!(keys, want, "after a run that never ended, its unfinished sessions only");
    assert!(rec.windows(2).all(|w| w[0].time >= w[1].time), "newest first");
    let r1 = rec.iter().find(|r| r.key == k(1)).unwrap();
    assert_eq!(read(&r1.file), "{\"n\":1}");
    let modified =
        fs::metadata(&r1.file).unwrap().modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    assert!((r1.time - modified).abs() < 2000, "with its newest autosave and its time");
    let r6 = rec.iter().find(|r| r.key == "untitled-6").unwrap();
    assert_eq!(read(&r6.file), "{\"n\":6.1}", "the newest of either kind");
    assert!(!h.autosave.join(".sessions").join("1-ab-00000000.json").exists(), "a marker that is not JSON goes");
    assert!(
        names(&h.autosave.join(".sessions")).iter().any(|n| n.starts_with(&format!("{}-feedface-", other.id()))),
        "a live run's marker stays"
    );

    b.dismiss(&k(1)).unwrap();
    assert!(!b.recovery().iter().any(|r| r.key == k(1)), "dismiss removes a recovery offer");
    b.session_start("untitled-6").unwrap();
    assert!(
        !b.recovery().iter().any(|r| r.key == "untitled-6"),
        "starting a session of that key again ends the old offer"
    );
    b.session_end("untitled-6").unwrap();
    assert_eq!(b.dismiss("").unwrap_err().code, Code::BadArgs);
    let _ = other.kill();
    let _ = other.wait();
    let gone: Vec<_> = b.recovery().into_iter().map(|r| r.key).collect();
    assert_eq!(gone, [k(7), k(5)], "once that process ends its session is offered too, newest first");
}

#[test]
fn files_prune_and_stale_markers() {
    let w = work("prune");
    let h = Home::at(&w);
    h.ensure().unwrap();
    let day = 24 * 3_600_000;
    let old = autosave_name("untitled-1", now() - 31 * day, false);
    let young = autosave_name("untitled-1", now() - 29 * day, true);
    let other = format!("notes-{}.ncut", stamp_of(now() - 40 * day));
    for n in [&old, &young, &other] {
        fs::write(h.autosave.join(n), "{}").unwrap();
    }
    let mut p = Projects::with_run(&h.autosave, dead_run("0123456789ab"));
    assert_eq!(names(&h.autosave), {
        let mut v = vec![young.clone(), other.clone()];
        v.sort();
        v
    });
    p.session_start("untitled-2").unwrap();
    p.autosave("untitled-2", "{}", false, KEEP).unwrap();
    let marker = h.autosave.join(".sessions").join(format!("999999-0123456789ab-{}.json", hash_of("untitled-2")));
    let mut m: Value = serde_json::from_str(&read(&marker)).unwrap();
    m["started"] = json!(now() - 31 * day);
    m["since"] = json!(0);
    fs::write(&marker, m.to_string()).unwrap();
    let b = Projects::new(&h.autosave);
    assert!(
        b.recovery().is_empty() && !marker.exists(),
        "a session older than 30 days is not offered and its marker goes"
    );
    p.prune();
}

#[test]
fn files_bad_input_never_panics() {
    let w = work("fuzz");
    let mut p = Projects::new(w.join("Autosave"));
    let pieces = [
        "C:", "c:", "\\", "/", "?", ".", "..", ":", "a", "é", "😀", "\0", "\n", "UNC", "ncut", ".ncut", "-", "0", "f",
        " ",
    ];
    let mut inputs = cut_oracle::Inputs::new(11);
    for _ in 0..3000 {
        let n = inputs.range(0, 12);
        let s: String = (0..n).map(|_| inputs.pick(&pieces)).collect();
        let _ = (cut_app::files::local_path(&s), cut_app::files::ext_of(&s), cut_app::files::name_of(&s), hash_of(&s));
        let _ = cut_app::files::time_of_stamp(&s);
        let _ = p.project_read(&w.join(&s));
        let _ = p.project_write(Path::new(&s), &s, Some(f64::NAN));
        let _ = p.autosaves_of(&s);
    }
    for s in ["", "{", "[", "{\"version\":", "{\"version\":1e999}", "\"\\ud800\"", "{\"version\":[1,{\"a\":null}]}"] {
        let _ = p.project_write(&w.join("f.ncut"), s, None);
    }
}

#[test]
fn files_write_atomic() {
    let w = work("atomic");
    let f = w.join("a.json");
    write_atomic(&f, b"one", false).unwrap();
    write_atomic(&f, b"two", true).unwrap();
    assert_eq!(read(&f), "two");
    assert!(write_atomic(&w.join("missing").join("a.json"), b"x", true).is_err());
    assert_eq!(names(&w), ["a.json"], "no temp file is left");
}

#[test]
fn files_settings_and_recent() {
    let w = work("settings");
    let mut st = Settings::load(&w);
    assert!(st.get("recent").is_none());
    st.set("language", json!("ko"));
    let mut recent = Recent::of(&st);
    for i in 0..12 {
        recent.add(Path::new(&format!("C:\\p\\{i}.ncut")));
    }
    recent.add(Path::new("c:\\P\\5.NCUT"));
    let list: Vec<_> = recent.paths().iter().map(|p| p.to_string_lossy().into_owned()).collect();
    assert_eq!(list.len(), 10);
    assert_eq!(list[0], "c:\\P\\5.NCUT", "the newest first, a path only once whatever its case");
    assert_eq!(list[1], "C:\\p\\11.ncut");
    assert!(!list.iter().any(|p| p == "C:\\p\\5.ncut" || p == "C:\\p\\1.ncut"));
    recent.remove(Path::new("C:\\P\\11.NCUT"));
    assert_eq!(recent.paths().len(), 9);
    recent.store(&mut st);
    st.save().unwrap();
    assert!(st.file().ends_with(".cut-rs\\settings.json") || st.file().ends_with(".cut-rs/settings.json"));
    let back = Settings::load(&w);
    assert_eq!(back.get("language"), Some(&json!("ko")), "other keys stay");
    assert_eq!(Recent::of(&back), recent);
    fs::write(back.file(), "{\"recent\":[\"C:\\\\a.ncut\",5,\"c:\\\\A.ncut\",\"\"],\"theme\":\"dark\"}").unwrap();
    let mut odd = Settings::load(&w);
    assert_eq!(Recent::of(&odd).paths(), [PathBuf::from("C:\\a.ncut")]);
    Recent::of(&odd).store(&mut odd);
    assert_eq!(odd.get("theme"), Some(&json!("dark")));
    fs::write(back.file(), "\u{feff}{\"theme\":\"light\"}").unwrap();
    assert_eq!(Settings::load(&w).get("theme"), Some(&json!("light")), "a byte order mark is skipped");
    fs::write(back.file(), "[broken").unwrap();
    assert!(Settings::load(&w).get("theme").is_none(), "a broken file reads as empty");
}
