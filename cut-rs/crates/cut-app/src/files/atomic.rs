//! `writeAtomic`: a file is replaced whole or not at all (the rename is cut-export's `renameOver`).

use std::fs;
use std::hash::{BuildHasher, RandomState};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cut_export::sink::rename_over;

/// Random bits for names that must not collide (temp files, run ids); not for secrets.
pub(crate) fn random_u64() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    RandomState::new().hash_one((COUNTER.fetch_add(1, Ordering::Relaxed), SystemTime::now(), std::process::id()))
}

/// Milliseconds since 1970 (`Date.now()`).
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A file's modification time as Node's `mtimeMs` computes it from seconds and nanoseconds.
pub fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    let t = meta.modified().ok()?;
    Some(match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => -(e.duration().as_secs_f64() * 1e3),
    })
}

/// Writes `data` to `<file>.<8 hex>.tmp` and renames it over `file`; the temp file is removed when anything fails.
/// With `sync` the data reaches the disk before the rename, so a power cut right after a save leaves the old file or
/// the new one, never an empty one (NTFS journals the rename, not the data).
pub fn write_atomic(file: &Path, data: &[u8], sync: bool) -> io::Result<()> {
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{:08x}.tmp", random_u64() as u32));
    let tmp = PathBuf::from(name);
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        if sync {
            f.sync_all()?;
        }
        drop(f);
        rename_over(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
