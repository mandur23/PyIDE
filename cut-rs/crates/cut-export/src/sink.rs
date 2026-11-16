//! The export file (`main/cut/sink.js`): the writer streams into `<path>.part`, which is renamed over the final name
//! when the file is complete and deleted on cancel or failure. A write the disk refuses fails at once with `diskFull`
//! or `io`, and every later write fails the same way. A part file that is dropped without [`PartFile::commit`] is
//! deleted, so an export that stops anywhere leaves nothing behind.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// An export failure: the JavaScript's string code and an English message for `tr(message, params)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: String,
    /// English, with `{name}` places the params fill.
    pub message: String,
    pub params: Vec<(String, String)>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut text = self.message.clone();
        for (k, v) in &self.params {
            text = text.replace(&format!("{{{k}}}"), v);
        }
        f.write_str(&text)
    }
}

impl std::error::Error for Failure {}

impl Failure {
    pub fn new(code: &str, message: &str) -> Self {
        Self { code: code.into(), message: message.into(), params: Vec::new() }
    }

    /// A failure whose message has `{name}` places.
    pub fn with(code: &str, message: &str, params: &[(&str, String)]) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            params: params.iter().map(|(k, v)| ((*k).into(), v.clone())).collect(),
        }
    }

    /// A refused read or write: `diskFull` when the disk has no room, else `io`.
    pub fn io(e: io::Error) -> Self {
        if is_full(&e) { Self::new("diskFull", "the disk is full") } else { Self::new("io", &e.to_string()) }
    }
}

/// ERROR_HANDLE_DISK_FULL (39) and ERROR_DISK_FULL (112).
fn is_full(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::StorageFull || matches!(e.raw_os_error(), Some(39 | 112))
}

/// The extensions an export writes (paths.js `OUTPUT`).
pub const OUTPUT: [&str; 11] = ["mp4", "m4a", "mov", "webm", "wav", "png", "jpg", "jpeg", "srt", "vtt", "txt"];

/// Windows refuses a rename for a moment while another program (a virus scanner, the search indexer) has the target
/// open: access denied, sharing or lock violation.
fn is_busy(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// `renameOver`: renames `from` over `to`, retrying up to 8 times (50 ms, 100 ms ... apart) while Windows says busy.
pub fn rename_over(from: &Path, to: &Path) -> io::Result<()> {
    let mut i = 0;
    loop {
        match fs::rename(from, to) {
            Err(e) if is_busy(&e) && i < 8 => {
                i += 1;
                std::thread::sleep(Duration::from_millis(50 * i));
            }
            r => return r,
        }
    }
}

/// `<path>.<8 hex>.<suffix>`: a temporary file beside `path` that no other run picks.
pub fn temp_name(path: &Path, suffix: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let bits = (stamp as u64 ^ (u64::from(std::process::id()) << 32) ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15)) as u32;
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{bits:08x}.{suffix}"));
    PathBuf::from(name)
}

/// Told about every part file while it exists, so the parts a crashed run left can be removed at the next start
/// (sink.js's journal).
pub trait Journal: Send + Sync {
    fn add(&self, part: &Path);
    fn remove(&self, part: &Path);
}

/// The part files this process writes now (sink.js refuses a second sink on the same file).
fn open_parts() -> &'static Mutex<HashSet<String>> {
    static OPEN: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    OPEN.get_or_init(Default::default)
}

/// Checks that `path` can be written (`writableFile`): an absolute path with an export extension in a folder that
/// exists, not a folder itself.
pub fn writable(path: &Path) -> Result<(), Failure> {
    if !path.is_absolute() {
        return Err(Failure::new("badArgs", "not an absolute path"));
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !OUTPUT.contains(&ext.as_str()) {
        return Err(Failure::new("extension", "this kind of file is not written here"));
    }
    match path.parent().map(fs::metadata) {
        Some(Ok(m)) if m.is_dir() => {}
        Some(Ok(_)) => return Err(Failure::new("notFile", "not a folder")),
        _ => return Err(Failure::new("missing", "the folder does not exist")),
    }
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() || m.file_type().is_symlink() => Err(Failure::new("notFile", "not a file")),
        _ => Ok(()),
    }
}

/// How a committed part file ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Committed {
    /// Renamed to the final name.
    Done { path: PathBuf, bytes: u64 },
    /// The final name is open in another program: the finished file kept its part name.
    Kept { part: PathBuf, bytes: u64 },
}

/// `<path>.part` being written.
pub struct PartFile {
    file: Option<File>,
    final_path: PathBuf,
    part: PathBuf,
    end: u64,
    failed: Option<Failure>,
    journal: Option<Arc<dyn Journal>>,
    /// Writes past this many bytes fail as on a full disk (tests).
    pub limit: Option<u64>,
    /// Bytes kept free after the file's first box (the ftyp) for the index, as a `free` box: the writer's bytes from
    /// its second box on land this much further on ([`PartFile::keep_room`]).
    room: u64,
    /// The end of the first box in the writer's bytes, once it wrote it.
    head: Option<u64>,
}

impl PartFile {
    /// Opens `<path>.part` for an export to `path`.
    pub fn open(path: &Path, journal: Option<Arc<dyn Journal>>) -> Result<Self, Failure> {
        writable(path)?;
        let mut part = path.as_os_str().to_owned();
        part.push(".part");
        let part = PathBuf::from(part);
        let key = part.to_string_lossy().to_lowercase();
        if !open_parts().lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone()) {
            return Err(Failure::new("busy", "this file is being written"));
        }
        let file = match File::create(&part) {
            Ok(f) => f,
            Err(e) => {
                open_parts().lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                return Err(Failure::io(e));
            }
        };
        if let Some(j) = &journal {
            j.add(&part);
        }
        Ok(Self {
            file: Some(file),
            final_path: path.to_owned(),
            part,
            end: 0,
            failed: None,
            journal,
            limit: None,
            room: 0,
            head: None,
        })
    }

    /// Keeps `bytes` free after the first box for the MP4 index, so [`crate::faststart`] can put it there in place
    /// instead of copying the whole file. Called before the first write; less than a box header keeps nothing.
    pub fn keep_room(&mut self, bytes: u64) {
        if self.end == 0 && bytes >= 8 && bytes <= u64::from(u32::MAX) {
            self.room = bytes;
        }
    }

    /// Where a byte the writer puts at `at` goes in the file.
    fn physical(&self, at: u64) -> u64 {
        match self.head {
            Some(h) if at >= h => at + self.room,
            _ => at,
        }
    }

    pub fn part(&self) -> &Path {
        &self.part
    }

    /// Bytes in the file so far.
    pub fn bytes(&self) -> u64 {
        self.end
    }

    /// The first write that failed.
    pub fn failed(&self) -> Option<&Failure> {
        self.failed.as_ref()
    }

    /// Writes the file to disk and renames it over the final name.
    pub fn commit(mut self) -> Result<Committed, Failure> {
        if let Some(f) = self.failed.clone() {
            return Err(f);
        }
        let file = self.file.take();
        let synced = file.as_ref().map_or(Ok(()), File::sync_all);
        drop(file);
        synced.map_err(Failure::io)?;
        let bytes = self.end;
        match rename_over(&self.part, &self.final_path) {
            Ok(()) => {
                self.forget();
                Ok(Committed::Done { path: self.final_path.clone(), bytes })
            }
            // A finished file that cannot take the target's place (a player has it open) is kept: deleting it threw
            // away the whole render.
            Err(e) if is_busy(&e) => {
                let part = self.part.clone();
                self.forget();
                Ok(Committed::Kept { part, bytes })
            }
            Err(e) => Err(Failure::io(e)),
        }
    }

    /// The part file is no longer this sink's to delete.
    fn forget(&mut self) {
        open_parts().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.part.to_string_lossy().to_lowercase());
        if let Some(j) = &self.journal {
            j.remove(&self.part);
        }
        self.part = PathBuf::new();
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if self.part.as_os_str().is_empty() {
            return;
        }
        drop(self.file.take());
        let _ = fs::remove_file(&self.part);
        self.forget();
    }
}

impl cut_formats::mp4::write::Sink for PartFile {
    fn write(&mut self, bytes: &[u8], position: Option<u64>) -> io::Result<()> {
        use std::io::{Seek, SeekFrom};
        if let Some(f) = &self.failed {
            return Err(io::Error::other(f.to_string()));
        }
        if self.file.is_none() {
            return Err(io::Error::other("the export file is closed"));
        }
        let at = position.map_or(self.end, |p| self.physical(p));
        // The first box's size comes with the first write: the room (a `free` box) goes right after it, and the
        // rest of that write after the room.
        let mut free = [0u8; 8];
        free[..4].copy_from_slice(&(self.room as u32).to_be_bytes());
        free[4..].copy_from_slice(b"free");
        // The writer's index (one write, at the end) counts chunk offsets in its own bytes: past the room they are
        // `room` further on in the file.
        let moved;
        let mut bytes = bytes;
        if let Some(h) = self.head
            && position.is_none()
            && bytes.len() >= 8
            && &bytes[4..8] == b"moov"
            && u64::from(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])) == bytes.len() as u64
        {
            let room = self.room;
            moved = crate::faststart::rewrite_moov(bytes, |off| Ok(if off >= h { off + room } else { off }))
                .map_err(|f| io::Error::other(f.to_string()))?;
            bytes = &moved;
        }
        let mut parts: Vec<(u64, &[u8])> = vec![(at, bytes)];
        if self.room > 0 && self.head.is_none() && at == 0 && bytes.len() >= 8 {
            let h = u64::from(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
            if h >= 8 && h <= bytes.len() as u64 {
                self.head = Some(h);
                let (first, rest) = bytes.split_at(h as usize);
                parts = vec![(0, first), (h, &free[..]), (h + self.room, rest)];
            }
        }
        let Some(file) = self.file.as_mut() else { return Err(io::Error::other("the export file is closed")) };
        let mut r = Ok(());
        let mut end = self.end;
        for (at, b) in parts {
            r = if self.limit.is_some_and(|l| at + b.len() as u64 > l) {
                Err(io::Error::from(io::ErrorKind::StorageFull))
            } else {
                file.seek(SeekFrom::Start(at)).and_then(|_| file.write_all(b))
            };
            if r.is_err() {
                break;
            }
            end = end.max(at + b.len() as u64);
        }
        if let Err(e) = r {
            self.failed = Some(Failure::io(io::Error::new(e.kind(), e.to_string())));
            return Err(e);
        }
        self.end = end;
        Ok(())
    }
}

/// Writes a whole small file through a part file (`saveBytes`): the SRT sidecars.
pub fn save_bytes(path: &Path, bytes: &[u8], journal: Option<Arc<dyn Journal>>) -> Result<Committed, Failure> {
    use cut_formats::mp4::write::Sink;
    let mut f = PartFile::open(path, journal)?;
    for c in bytes.chunks(16 * 1024 * 1024) {
        if f.write(c, None).is_err() {
            return Err(f.failed().cloned().unwrap_or_else(|| Failure::new("io", "write failed")));
        }
    }
    f.commit()
}
