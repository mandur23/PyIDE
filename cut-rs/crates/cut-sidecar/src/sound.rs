//! The temp files of sound a server reads (`cut:speechOpen`, `cut:speechWrite`, `cut:speechClose` of
//! `main/cut/whisper.js`): raw float32 little-endian, 16 kHz mono, written block by block as the editor decodes it.
//!
//! Each file is held open without delete sharing while it exists, so the sweep at start (which deletes every file in
//! the folder) cannot take a file another running editor is writing, and does take those an ended one left behind.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The JavaScript's limits: one write is 16 MB at most, a file 2 GB (about 9 hours of `whisper.js`'s mono), or 4 GB
/// for the stereo the voice model reads (`voice.js`, about 3.4 hours).
pub const WRITE_LIMIT: usize = 16 * 1024 * 1024;
pub const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
pub const VOICE_FILE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;

const FILE_SHARE_READ: u32 = 1;
const FILE_SHARE_WRITE: u32 = 2;

/// Why a sound file call failed, with the JavaScript's code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SoundError {
    /// `notFound`: no such sound file.
    NotFound,
    /// `tooLarge`: the write or the file is over its limit.
    TooLarge(&'static str),
    /// `io`: the disk failed.
    Io(String),
}

impl SoundError {
    pub fn code(&self) -> &'static str {
        match self {
            SoundError::NotFound => "notFound",
            SoundError::TooLarge(_) => "tooLarge",
            SoundError::Io(_) => "io",
        }
    }

    pub fn message(&self) -> String {
        match self {
            SoundError::NotFound => "no such sound file".into(),
            SoundError::TooLarge(m) => (*m).into(),
            SoundError::Io(m) => m.clone(),
        }
    }
}

struct Entry {
    file: PathBuf,
    size: u64,
    fh: File,
}

/// The temp files of one editor.
pub struct SoundFiles {
    dir: PathBuf,
    /// Which `SoundFiles` of this process (tests make several): part of each file's name.
    instance: u64,
    files: Mutex<HashMap<String, Entry>>,
    next: Mutex<u64>,
    /// The most bytes a file holds.
    limit: u64,
}

impl SoundFiles {
    /// The folder `%TEMP%\nano-studio-cut-speech` (its own, not the JavaScript's: the JavaScript's files allow
    /// deletion while open, so this sweep would take a running JavaScript editor's).
    pub fn default_dir() -> PathBuf {
        std::env::temp_dir().join("nano-studio-cut-speech")
    }

    /// The files in `dir`, each at most [`FILE_LIMIT`]; what earlier runs left there is deleted.
    pub fn new(dir: PathBuf) -> SoundFiles {
        SoundFiles::with_limit(dir, FILE_LIMIT)
    }

    /// The files in `dir`, each at most `limit` bytes; what earlier runs left there is deleted.
    pub fn with_limit(dir: PathBuf, limit: u64) -> SoundFiles {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        static INSTANCES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let instance = INSTANCES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        SoundFiles { dir, instance, files: Mutex::new(HashMap::new()), next: Mutex::new(1), limit }
    }

    fn files(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.files.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A new empty file -> its id.
    pub fn open(&self) -> Result<String, SoundError> {
        let n = {
            let mut g = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let n = *g;
            *g += 1;
            n
        };
        let id = format!("s{n}");
        let file = self.dir.join(format!("{}-{}-{id}.f32", std::process::id(), self.instance));
        let _ = std::fs::create_dir_all(&self.dir);
        let fh = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&file)
            .map_err(|e| SoundError::Io(e.to_string()))?;
        self.files().insert(id.clone(), Entry { file, size: 0, fh });
        Ok(id)
    }

    /// Appends samples -> the file's length in samples.
    pub fn write(&self, id: &str, samples: &[f32]) -> Result<u64, SoundError> {
        let mut g = self.files();
        let f = g.get_mut(id).ok_or(SoundError::NotFound)?;
        let bytes = samples.len() * 4;
        if bytes > WRITE_LIMIT {
            return Err(SoundError::TooLarge("one write is 16 MB at most"));
        }
        if f.size + bytes as u64 > self.limit {
            return Err(SoundError::TooLarge("the sound is too long"));
        }
        let mut buf = Vec::with_capacity(bytes);
        for s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        let at = f.size;
        f.size += bytes as u64;
        write_all_at(&f.fh, &buf, at).map_err(|e| SoundError::Io(e.to_string()))?;
        Ok(f.size / 4)
    }

    /// `length` samples from `offset` (fewer at the end of the file).
    pub fn read(&self, id: &str, offset: u64, length: u64) -> Result<Vec<f32>, SoundError> {
        let g = self.files();
        let f = g.get(id).ok_or(SoundError::NotFound)?;
        let n = length.min((f.size / 4).saturating_sub(offset)) as usize;
        let mut buf = vec![0u8; n * 4];
        let mut done = 0;
        while done < buf.len() {
            match f.fh.seek_read(&mut buf[done..], offset * 4 + done as u64) {
                Ok(0) => break,
                Ok(k) => done += k,
                Err(e) => return Err(SoundError::Io(e.to_string())),
            }
        }
        Ok(buf.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect())
    }

    /// The file's path and length in samples (what a server is given).
    pub fn info(&self, id: &str) -> Option<(PathBuf, u64)> {
        self.files().get(id).map(|f| (f.file.clone(), f.size / 4))
    }

    /// Deletes a file (an unknown id is fine).
    pub fn close(&self, id: &str) {
        if let Some(f) = self.files().remove(id) {
            drop(f.fh);
            let _ = std::fs::remove_file(&f.file);
        }
    }

    /// Deletes every file.
    pub fn dispose(&self) {
        let ids: Vec<String> = self.files().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The most bytes a file holds.
    pub fn limit(&self) -> u64 {
        self.limit
    }
}

impl Drop for SoundFiles {
    fn drop(&mut self) {
        self.dispose();
    }
}

fn write_all_at(f: &File, mut buf: &[u8], mut at: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        let n = f.seek_write(buf, at)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        at += n as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_close_and_the_sweep() {
        let dir = std::env::temp_dir().join(format!("cut-sidecar-sound-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("123-s1.f32"), [0u8; 8]).unwrap();
        let files = SoundFiles::new(dir.clone());
        assert!(!dir.join("123-s1.f32").exists(), "a file no one holds is swept");
        let id = files.open().unwrap();
        assert_eq!(files.write(&id, &[0.5, -1.0]).unwrap(), 2);
        assert_eq!(files.write(&id, &[0.25; 3]).unwrap(), 5);
        assert_eq!(files.read(&id, 1, 3).unwrap(), vec![-1.0, 0.25, 0.25]);
        assert_eq!(files.read(&id, 4, 10).unwrap(), vec![0.25]);
        assert!(files.read(&id, 9, 10).unwrap().is_empty());
        let (path, n) = files.info(&id).unwrap();
        assert_eq!((std::fs::metadata(&path).unwrap().len(), n), (20, 5));
        assert!(std::fs::remove_file(&path).is_err(), "another editor's sweep cannot take a file in use");
        let big = vec![0f32; WRITE_LIMIT / 4 + 1];
        assert_eq!(files.write(&id, &big).unwrap_err().code(), "tooLarge");
        assert_eq!(files.write("s99", &[0.0]).unwrap_err(), SoundError::NotFound);
        files.close(&id);
        assert!(!path.exists());
        assert_eq!(files.read(&id, 0, 1).unwrap_err().code(), "notFound");
        drop(files);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_holds_its_limit_and_not_a_byte_more() {
        assert_eq!((FILE_LIMIT, VOICE_FILE_LIMIT), (1 << 31, 1 << 32), "whisper.js's 2 GB, voice.js's 4 GB");
        let dir = std::env::temp_dir().join(format!("cut-sidecar-limit-{}", std::process::id()));
        let files = SoundFiles::with_limit(dir.clone(), 12);
        let id = files.open().unwrap();
        assert_eq!(files.write(&id, &[0.0; 3]).unwrap(), 3);
        assert_eq!(files.write(&id, &[0.0]).unwrap_err(), SoundError::TooLarge("the sound is too long"));
        assert_eq!(files.info(&id).unwrap().1, 3, "a refused write leaves the file as it was");
        drop(files);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
