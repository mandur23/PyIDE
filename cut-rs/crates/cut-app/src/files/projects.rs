//! `createProjects`: project files, autosaves and the session markers that tell a crash from a clean close.
//!
//! Two kinds of autosave share the folder: copies (`<stamp>.ncut`, the editor's interval copies, the newest `keep` of a
//! key kept) and the latest state (`<stamp>.latest.ncut`, the save after edits stop, only the newest kept), so the
//! quick saves never push the copies out. A session marker is removed when the session ends or the user dismisses
//! its recovery; a marker whose run is gone is a session that never ended, and recovery offers its newest autosave
//! when that is newer than both the session's start and its last save.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

use super::atomic::{mtime_ms, now_ms, write_atomic};
use super::names::{autosave_name, hash_of, parse_autosave};
use super::paths::{dirname, real_dir, real_file, text_of, writable_file};
use super::runs::{Run, num};
use super::{Code, FileError, NCUT_TEXT_LIMIT};

/// Copies kept per key when the editor asks for no other number.
pub const KEEP: usize = 20;
/// The most copies a key may keep.
pub const MAX_KEEP: usize = 100;
const NCUT: &[&str] = &["ncut"];
const MAX_AGE_MS: i64 = 30 * 24 * 3_600_000;
const MAX_KEY: usize = 1024;

/// A project as read: its text (no byte order mark), real path, time, and whether it lies in the Autosave folder
/// (it then opens as an unsaved project: the cleanup deletes files there by name).
#[derive(Clone, Debug, PartialEq)]
pub struct ReadOk {
    pub text: String,
    pub path: PathBuf,
    pub mtime: f64,
    pub autosave: bool,
}

/// A save: where it went, the backup of the file it replaced, the copy kept for a format change, the new time.
#[derive(Clone, Debug, PartialEq)]
pub struct WriteOk {
    pub path: PathBuf,
    pub bak: Option<PathBuf>,
    pub kept: Option<PathBuf>,
    pub mtime: Option<f64>,
}

/// One autosave of a key: `time` from its name (ms), `latest` for the latest state rather than a copy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Autosave {
    pub file: PathBuf,
    pub time: i64,
    pub latest: bool,
}

/// A recovery offer: a session that never ended, with its newest autosave.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub key: String,
    pub file: PathBuf,
    pub time: i64,
}

struct Session {
    key: String,
    file: PathBuf,
    since: i64,
    saved: Option<i64>,
}

/// The marker file's JSON, fields in the JavaScript's order.
#[derive(Serialize)]
struct MarkerOut<'a> {
    pid: u32,
    run: &'a str,
    started: i64,
    key: &'a str,
    since: i64,
    saved: Option<i64>,
    crashed: bool,
}

/// A marker on disk: its file and its JSON object (which has a string `key`).
struct Marker {
    file: PathBuf,
    value: Map<String, Value>,
}

impl Marker {
    fn key(&self) -> &str {
        self.value.get("key").and_then(Value::as_str).unwrap_or_default()
    }
}

/// A format version as `versionOf` sees it: none (not JSON, or not an object) or the value of `version`
/// (`null` when absent).
#[derive(Debug)]
enum Version {
    Undefined,
    Is(Value),
}

impl Version {
    /// JavaScript's `!==` between two parsed versions: objects and arrays are never the same.
    fn differs(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Undefined, Self::Undefined) => false,
            (Self::Is(a), Self::Is(b)) => match (a, b) {
                (Value::Null, Value::Null) => false,
                (Value::Bool(x), Value::Bool(y)) => x != y,
                (Value::Number(x), Value::Number(y)) => x.as_f64() != y.as_f64(),
                (Value::String(x), Value::String(y)) => x != y,
                _ => true,
            },
            _ => true,
        }
    }

    /// `v1` for an integer version, `vunknown` for anything else, as the kept backup is named.
    fn label(&self) -> String {
        match self {
            Self::Is(Value::Number(n)) => match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i128),
                Some(f) if f.fract() == 0.0 => format!("{f:e}").replace('e', "e+"),
                _ => "unknown".to_owned(),
            },
            _ => "unknown".to_owned(),
        }
    }
}

struct VersionVisitor;

impl<'de> Visitor<'de> for VersionVisitor {
    type Value = Version;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JSON")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Version, A::Error> {
        let mut version = Value::Null;
        while let Some(key) = map.next_key::<String>()? {
            if key == "version" {
                version = map.next_value()?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(Version::Is(version))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Version, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Version::Is(Value::Null))
    }

    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Version, E> {
        Ok(Version::Undefined)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Version, E> {
        Ok(Version::Undefined)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Version, E> {
        Ok(Version::Undefined)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Version, E> {
        Ok(Version::Undefined)
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Version, E> {
        Ok(Version::Undefined)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Version, E> {
        Ok(Version::Undefined)
    }
}

/// `versionOf`: parses the whole text (it must be JSON) but keeps only `version`.
fn version_of(text: &str) -> Version {
    let mut de = serde_json::Deserializer::from_str(text);
    match de.deserialize_any(VersionVisitor) {
        Ok(v) if de.end().is_ok() => v,
        _ => Version::Undefined,
    }
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn bad_key(key: &str) -> bool {
    key.is_empty() || (key.len() > MAX_KEY && key.encode_utf16().count() > MAX_KEY)
}

fn bad_text(text: &str) -> bool {
    text.len() > NCUT_TEXT_LIMIT && text.encode_utf16().count() > NCUT_TEXT_LIMIT
}

fn bad_args(message: &str) -> FileError {
    FileError::new(Code::BadArgs, message)
}

/// The entries of a folder (none when it cannot be read), each with its name as text.
fn list(dir: &Path) -> Vec<(OsString, String)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .filter_map(Result::ok)
        .map(|e| {
            let name = e.file_name();
            let text = name.to_string_lossy().into_owned();
            (name, text)
        })
        .collect()
}

/// `^\d+-[0-9a-f]+-[0-9a-f]{8}\.json$`
fn is_marker_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else { return false };
    let mut parts = stem.splitn(3, '-');
    let (Some(pid), Some(run), Some(hash)) = (parts.next(), parts.next(), parts.next()) else { return false };
    let hex = |s: &str| s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    !pid.is_empty()
        && pid.bytes().all(|c| c.is_ascii_digit())
        && !run.is_empty()
        && hex(run)
        && hash.len() == 8
        && hex(hash)
}

/// An autosave named and stamped, to be written ([`Projects::autosave_job`]).
#[derive(Debug, Clone)]
pub struct AutosaveJob {
    dir: PathBuf,
    file: PathBuf,
    hash: String,
    latest: bool,
    keep: usize,
}

impl AutosaveJob {
    /// Writes `text` to its file and removes the autosaves of its key it replaces: the older latest state, or the
    /// copies past the newest `keep`.
    pub fn write(&self, text: &str) -> Result<PathBuf, FileError> {
        if bad_text(text) {
            return Err(bad_args("autosave takes a key and the project text"));
        }
        fs::create_dir_all(&self.dir)
            .and_then(|()| write_atomic(&self.file, text.as_bytes(), false))
            .map_err(|e| FileError::io(&e))?;
        let same: Vec<_> =
            autosaves_in(&self.dir, &self.hash).into_iter().filter(|a| a.latest == self.latest).collect();
        for old in same.iter().skip(if self.latest { 1 } else { self.keep }) {
            let _ = fs::remove_file(&old.file);
        }
        Ok(self.file.clone())
    }
}

/// The autosaves in `dir` of the key hashed `hash`, newest first.
fn autosaves_in(dir: &Path, hash: &str) -> Vec<Autosave> {
    let mut out: Vec<Autosave> = list(dir)
        .into_iter()
        .filter_map(|(name, text)| {
            let (h, time, latest) = parse_autosave(&text)?;
            (h == hash).then(|| Autosave { file: dir.join(name), time, latest })
        })
        .collect();
    out.sort_by_key(|a| Reverse(a.time));
    out
}

/// One app run's project files, autosaves and sessions (`createProjects`).
pub struct Projects {
    autosave_dir: PathBuf,
    sessions_dir: PathBuf,
    run: Run,
    /// This run's sessions by key hash.
    own: HashMap<String, Session>,
    last_stamp: i64,
    real_autosave: Option<String>,
}

impl Projects {
    /// The projects of this run, autosaving in `autosave_dir`; autosaves older than 30 days are deleted at once.
    pub fn new(autosave_dir: impl Into<PathBuf>) -> Self {
        Self::with_run(autosave_dir, Run::new())
    }

    /// As [`Projects::new`], as the given run (tests: another editor's run).
    pub fn with_run(autosave_dir: impl Into<PathBuf>, run: Run) -> Self {
        let autosave_dir = autosave_dir.into();
        let projects = Self {
            sessions_dir: autosave_dir.join(".sessions"),
            autosave_dir,
            run,
            own: HashMap::new(),
            last_stamp: 0,
            real_autosave: None,
        };
        projects.prune();
        projects
    }

    /// The run these sessions belong to.
    pub fn run(&self) -> &Run {
        &self.run
    }

    fn next_stamp(&mut self) -> i64 {
        self.last_stamp = now_ms().max(self.last_stamp + 1);
        self.last_stamp
    }

    /// Whether a real path lies directly in the Autosave folder.
    fn in_autosave(&mut self, file: &str) -> bool {
        if self.real_autosave.is_none() {
            self.real_autosave = real_dir(&self.autosave_dir);
        }
        self.real_autosave.as_ref().is_some_and(|dir| dirname(file).to_lowercase() == dir.to_lowercase())
    }

    /// `projectRead`: a project's text; [`Code::Missing`] for a file that is not there.
    pub fn project_read(&mut self, path: &Path) -> Result<ReadOk, FileError> {
        let file = real_file(text_of(path)?, NCUT)?;
        if file.meta.len() > NCUT_TEXT_LIMIT as u64 {
            return Err(FileError::new(Code::TooLarge, "the project file is too large"));
        }
        let mtime = mtime_ms(&file.meta).unwrap_or(0.0);
        let bytes = match fs::read(&file.real) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(FileError::new(Code::Missing, "no such file"));
            }
            Err(e) => return Err(FileError::io(&e)),
        };
        let text = strip_bom(&String::from_utf8_lossy(&bytes)).to_owned();
        let autosave = self.in_autosave(&file.real);
        Ok(ReadOk { text, path: PathBuf::from(file.real), mtime, autosave })
    }

    /// `projectWrite`: saves a project text (a JSON object or array with any `version`). The file it replaces is kept
    /// as `<name>.ncut.bak`, and also as `<name>.ncut.v<old version>.bak` when the version changes (a migration the
    /// user may want to undo), which later saves leave alone. With `mtime` (the time the file was read or last
    /// written) a file changed since is not overwritten: [`Code::Changed`] with its time now.
    pub fn project_write(&mut self, path: &Path, text: &str, mtime: Option<f64>) -> Result<WriteOk, FileError> {
        let p = text_of(path)?;
        if bad_text(text) {
            return Err(bad_args("not a project text"));
        }
        let version = version_of(text);
        if matches!(version, Version::Undefined) {
            return Err(bad_args("not a project text"));
        }
        let target = writable_file(p, NCUT)?;
        if self.in_autosave(&target) {
            return Err(FileError::new(
                Code::Autosave,
                "projects are not saved in the Autosave folder: the app deletes old files there",
            ));
        }
        if let Some(mtime) = mtime.filter(|m| m.is_finite())
            && let Some(now) = fs::metadata(&target).ok().and_then(|m| mtime_ms(&m))
            && now != mtime
        {
            let mut err = FileError::new(Code::Changed, "the project file was changed on disk since it was opened");
            err.mtime = Some(now);
            return Err(err);
        }
        let (bak, kept) = Self::keep_previous(&target, &version)?;
        let target_path = PathBuf::from(&target);
        write_atomic(&target_path, text.as_bytes(), true).map_err(|e| FileError::io(&e))?;
        let session = [hash_of(&target), hash_of(p)].into_iter().find(|h| self.own.contains_key(h));
        if let Some(hash) = session {
            let now = now_ms();
            if let Some(s) = self.own.get_mut(&hash) {
                s.saved = Some(now);
            }
            if let Some(s) = self.own.get(&hash) {
                let _ = self.write_marker(s);
            }
        }
        let written = fs::metadata(&target_path).ok().and_then(|m| mtime_ms(&m));
        Ok(WriteOk { path: target_path, bak, kept, mtime: written })
    }

    /// Reads the file a save replaces (read, not copied: a copy would carry a read-only attribute over to the backup
    /// and block the next save) and keeps it.
    fn keep_previous(target: &str, version: &Version) -> Result<(Option<PathBuf>, Option<PathBuf>), FileError> {
        let keep = || -> std::io::Result<(Option<PathBuf>, Option<PathBuf>)> {
            let old = fs::read(target)?;
            let bak = PathBuf::from(format!("{target}.bak"));
            write_atomic(&bak, &old, true)?;
            let was = if old.len() > NCUT_TEXT_LIMIT {
                Version::Undefined
            } else {
                version_of(strip_bom(&String::from_utf8_lossy(&old)))
            };
            let mut kept = None;
            if was.differs(version) {
                let file = PathBuf::from(format!("{target}.v{}.bak", was.label()));
                write_atomic(&file, &old, true)?;
                kept = Some(file);
            }
            Ok((Some(bak), kept))
        };
        match keep() {
            Ok(r) => Ok(r),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, None)),
            Err(e) => Err(FileError::new(Code::Io, format!("the previous version could not be kept: {e}"))),
        }
    }

    fn autosaves_of_hash(&self, hash: &str) -> Vec<Autosave> {
        autosaves_in(&self.autosave_dir, hash)
    }

    /// A key's autosaves, newest first (File > Restore Autosave); none for a key that is not one.
    pub fn autosaves_of(&self, key: &str) -> Vec<Autosave> {
        if bad_key(key) { Vec::new() } else { self.autosaves_of_hash(&hash_of(key)) }
    }

    /// `autosave`: writes an autosave of a key (the project path, or `untitled-<id>`). `latest` replaces the previous
    /// latest state; otherwise a copy, of which the newest `keep` (1 to 100) stay.
    pub fn autosave(&mut self, key: &str, text: &str, latest: bool, keep: usize) -> Result<PathBuf, FileError> {
        if bad_text(text) {
            return Err(bad_args("autosave takes a key and the project text"));
        }
        self.autosave_job(key, latest, keep)?.write(text)
    }

    /// [`Projects::autosave`] up to the writing: its file named and stamped now, the writing (and the removal of the
    /// ones it replaces) left to [`AutosaveJob::write`] on any thread.
    pub fn autosave_job(&mut self, key: &str, latest: bool, keep: usize) -> Result<AutosaveJob, FileError> {
        if bad_key(key) {
            return Err(bad_args("autosave takes a key and the project text"));
        }
        let stamp = self.next_stamp();
        Ok(AutosaveJob {
            dir: self.autosave_dir.clone(),
            file: self.autosave_dir.join(autosave_name(key, stamp, latest)),
            hash: hash_of(key),
            latest,
            keep: keep.clamp(1, MAX_KEEP),
        })
    }

    fn marker_file(&self, hash: &str) -> PathBuf {
        self.sessions_dir.join(format!("{}-{}-{hash}.json", self.run.pid, self.run.run))
    }

    fn write_marker(&self, s: &Session) -> std::io::Result<()> {
        fs::create_dir_all(&self.sessions_dir)?;
        let out = MarkerOut {
            pid: self.run.pid,
            run: &self.run.run,
            started: self.run.started,
            key: &s.key,
            since: s.since,
            saved: s.saved,
            crashed: false,
        };
        let json = serde_json::to_vec(&out).map_err(std::io::Error::other)?;
        write_atomic(&s.file, &json, false)
    }

    /// Every marker in the sessions folder, this run's too; a file that is not a marker is removed.
    fn markers(&self) -> Vec<Marker> {
        let mut out = Vec::new();
        for (name, text) in list(&self.sessions_dir) {
            if !is_marker_name(&text) {
                continue;
            }
            let file = self.sessions_dir.join(name);
            let value = fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            match value {
                Some(Value::Object(m)) if m.get("key").is_some_and(Value::is_string) => {
                    out.push(Marker { file, value: m })
                }
                _ => {
                    let _ = fs::remove_file(&file);
                }
            }
        }
        out
    }

    /// The markers of sessions that never ended: their run is gone, or (a JavaScript window whose renderer crashed)
    /// this run marked them crashed.
    fn ended(&self) -> Vec<Marker> {
        let markers = self.markers();
        let refs: Vec<_> = markers.iter().map(|m| &m.value).collect();
        let alive = self.run.alive(&refs);
        markers
            .into_iter()
            .zip(alive)
            .filter(|(m, alive)| {
                let mine = m.value.get("run").and_then(Value::as_str) == Some(self.run.run.as_str());
                !alive || (mine && m.value.get("crashed").is_some_and(truthy))
            })
            .map(|(m, _)| m)
            .collect()
    }

    /// `sessionStart`: this run has the project of `key` open. An older session of it that never ended has nothing
    /// more to offer and goes.
    pub fn session_start(&mut self, key: &str) -> Result<(), FileError> {
        if bad_key(key) {
            return Err(bad_args("a session takes a key"));
        }
        let hash = hash_of(key);
        for m in self.ended() {
            let other = m.value.get("run").and_then(Value::as_str) != Some(self.run.run.as_str());
            if other && hash_of(m.key()) == hash {
                let _ = fs::remove_file(&m.file);
            }
        }
        if !self.own.contains_key(&hash) {
            let session = Session { key: key.to_owned(), file: self.marker_file(&hash), since: now_ms(), saved: None };
            self.own.insert(hash.clone(), session);
        }
        let s = &self.own[&hash];
        self.write_marker(s).map_err(|e| FileError::io(&e))
    }

    /// `sessionEnd`: the project of `key` closed normally; its marker goes.
    pub fn session_end(&mut self, key: &str) -> Result<(), FileError> {
        if bad_key(key) {
            return Err(bad_args("a session takes a key"));
        }
        if let Some(s) = self.own.remove(&hash_of(key)) {
            let _ = fs::remove_file(&s.file);
        }
        Ok(())
    }

    /// `recovery`: sessions that never ended whose newest autosave is newer than the session's start and its last
    /// save, one per key, newest first. Markers with nothing to offer (or older than 30 days) are removed.
    pub fn recovery(&self) -> Vec<Offer> {
        let mut by_key: Vec<(String, Offer)> = Vec::new();
        let now = now_ms() as f64;
        for m in self.ended() {
            let hash = hash_of(m.key());
            let newest = self.autosaves_of_hash(&hash).into_iter().next();
            let or0 = |v: f64| if v.is_nan() { 0.0 } else { v };
            let since = or0(num(m.value.get("since")));
            let stale = now - or0(num(m.value.get("started"))) > MAX_AGE_MS as f64;
            let saved = m.value.get("saved");
            let Some(newest) = newest.filter(|n| {
                let t = n.time as f64;
                !stale && t >= since && !(saved.is_some_and(truthy) && num(saved) >= t)
            }) else {
                let _ = fs::remove_file(&m.file);
                continue;
            };
            let offer = Offer { key: m.key().to_owned(), file: newest.file, time: newest.time };
            match by_key.iter_mut().find(|(h, _)| *h == hash) {
                Some((_, prev)) if prev.time < offer.time => *prev = offer,
                Some(_) => {}
                None => by_key.push((hash, offer)),
            }
        }
        let mut offers: Vec<Offer> = by_key.into_iter().map(|(_, o)| o).collect();
        offers.sort_by_key(|o| Reverse(o.time));
        offers
    }

    /// `recoveryDismiss`: the user declined the recovery of `key`; its markers go.
    pub fn dismiss(&self, key: &str) -> Result<(), FileError> {
        if bad_key(key) {
            return Err(bad_args("dismiss takes a key"));
        }
        let hash = hash_of(key);
        for m in self.ended() {
            if hash_of(m.key()) == hash {
                let _ = fs::remove_file(&m.file);
            }
        }
        Ok(())
    }

    /// Deletes autosaves older than 30 days, whatever their key: untitled projects never reopened would pile up.
    pub fn prune(&self) {
        let cutoff = now_ms() - MAX_AGE_MS;
        for (name, text) in list(&self.autosave_dir) {
            if parse_autosave(&text).is_some_and(|(_, time, _)| time < cutoff) {
                let _ = fs::remove_file(self.autosave_dir.join(name));
            }
        }
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(matches!(version_of("not json"), Version::Undefined));
        assert!(matches!(version_of("5"), Version::Undefined));
        assert!(matches!(version_of("null"), Version::Undefined));
        assert!(matches!(version_of("{} x"), Version::Undefined));
        assert!(matches!(version_of("[1]"), Version::Is(Value::Null)));
        assert!(
            matches!(version_of(r#"{"version":1,"version":2}"#), Version::Is(Value::Number(ref n)) if n.as_u64() == Some(2))
        );
        assert_eq!(version_of(r#"{"version":1.0}"#).label(), "1");
        assert_eq!(version_of(r#"{"version":1.5}"#).label(), "unknown");
        assert_eq!(version_of(r#"{"version":1e21}"#).label(), "1e+21");
        assert_eq!(version_of(r#"{"version":"1"}"#).label(), "unknown");
        assert!(!version_of(r#"{"version":1}"#).differs(&version_of(r#"{"version":1.0}"#)));
        assert!(version_of(r#"{"version":{}}"#).differs(&version_of(r#"{"version":{}}"#)));
        assert!(!version_of("{}").differs(&version_of(r#"{"version":null}"#)));
    }

    #[test]
    fn marker_names() {
        assert!(is_marker_name("123-feedface-0123abcd.json"));
        assert!(!is_marker_name("123-feedface-0123abc.json"));
        assert!(!is_marker_name("x-feedface-0123abcd.json"));
        assert!(!is_marker_name("1-FEED-0123abcd.json"));
        assert!(!is_marker_name("1--0123abcd.json"));
    }
}
