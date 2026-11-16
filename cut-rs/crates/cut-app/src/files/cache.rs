//! The app-wide cache both editors share (`main/cut/cache.js`): thumbnails, waveforms, proxies and render files in one
//! folder for every project. An entry of `cut:cacheGet/Put` is `<dir>/entries/<2 hex>/<sha1 of the key>.bin`; other
//! files under the folder (a proxy an export wrote there) count too. Above the size limit the least recently used
//! files go first; use is kept in memory and in each file's mtime, so the order survives a restart and is the same
//! one the JavaScript keeps.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha1::{Digest, Sha1};

/// The largest entry (`CACHE_ENTRY_LIMIT`, 512 MB).
pub const ENTRY_LIMIT: usize = 512 * 1024 * 1024;
/// A key longer than this is refused (`MAX_KEY`).
const MAX_KEY: usize = 4096;

struct Item {
    file: PathBuf,
    size: u64,
    used: f64,
}

#[derive(Default)]
struct Index {
    /// Lower-case path -> the file.
    items: HashMap<String, Item>,
    total: u64,
    loaded: bool,
    last_use: f64,
}

/// The cache of a workspace (`createCache`), safe to share between threads.
pub struct Cache {
    dir: PathBuf,
    limit: u64,
    index: Mutex<Index>,
}

fn ms_of(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

impl Cache {
    /// The cache in `dir`, keeping `limit` bytes (the setting `cut.cacheLimitGB`, 10 GB by default).
    pub fn new(dir: PathBuf, limit: u64) -> Self {
        Self { dir, limit, index: Mutex::new(Index::default()) }
    }

    /// The file an entry of `key` is kept in.
    pub fn file_of(&self, key: &str) -> PathBuf {
        let h: String = Sha1::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        self.dir.join("entries").join(&h[..2]).join(format!("{h}.bin"))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Index> {
        let mut ix = self.index.lock().unwrap_or_else(|p| p.into_inner());
        if !ix.loaded {
            ix.loaded = true;
            let _ = std::fs::create_dir_all(&self.dir);
            walk(&self.dir, 0, &mut ix);
        }
        ix
    }

    fn now(ix: &mut Index) -> f64 {
        ix.last_use = ms_of(SystemTime::now()).max(ix.last_use + 1.0);
        ix.last_use
    }

    /// The bytes kept for `key`, counted as a use.
    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        if key.is_empty() || key.len() > MAX_KEY {
            return None;
        }
        let file = self.file_of(key);
        let k = file.to_string_lossy().to_lowercase();
        let mut ix = self.lock();
        ix.items.get(&k)?;
        let Ok(data) = std::fs::read(&file) else {
            forget(&mut ix, &k);
            return None;
        };
        let used = Self::now(&mut ix);
        if let Some(e) = ix.items.get_mut(&k) {
            e.used = used;
        }
        touch(&file, used);
        Some(data)
    }

    /// Keeps `bytes` for `key` (written whole or not at all), then removes the least recently used files above the
    /// limit. -> whether it was kept.
    pub fn put(&self, key: &str, bytes: &[u8]) -> bool {
        if key.is_empty() || key.len() > MAX_KEY || bytes.len() > ENTRY_LIMIT || bytes.len() as u64 > self.limit {
            return false;
        }
        let file = self.file_of(key);
        let mut ix = self.lock();
        let written = file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| super::write_atomic(&file, bytes, false));
        if written.is_err() {
            return false;
        }
        let used = Self::now(&mut ix);
        remember(&mut ix, &file, bytes.len() as u64, used);
        touch(&file, used);
        self.evict(&mut ix, &file);
        true
    }

    /// Oldest use first until the cache fits; `keep` (the file just added) stays.
    fn evict(&self, ix: &mut Index, keep: &Path) {
        if ix.total <= self.limit {
            return;
        }
        let keep = keep.to_string_lossy().to_lowercase();
        let mut order: Vec<(String, f64)> = ix.items.iter().map(|(k, e)| (k.clone(), e.used)).collect();
        order.sort_by(|a, b| a.1.total_cmp(&b.1));
        for (k, _) in order {
            if ix.total <= self.limit {
                break;
            }
            if k == keep {
                continue;
            }
            let file = ix.items[&k].file.clone();
            if std::fs::remove_file(&file).is_ok() || !file.exists() {
                forget(ix, &k);
            }
        }
    }

    /// The bytes and files the cache holds (`cacheInfo`).
    pub fn info(&self) -> (u64, usize) {
        let ix = self.lock();
        (ix.total, ix.items.len())
    }

    /// Clear Cache (`clear`): every file it holds goes; one that cannot be removed (in use) stays counted. `Err` when
    /// its folder cannot be read, as the JavaScript's fails when its index cannot be loaded.
    pub fn clear(&self) -> Result<(), String> {
        if self.dir.exists() {
            std::fs::read_dir(&self.dir).map_err(|e| e.to_string())?;
        }
        let mut ix = self.lock();
        let keys: Vec<String> = ix.items.keys().cloned().collect();
        for k in keys {
            let file = ix.items[&k].file.clone();
            if std::fs::remove_file(&file).is_ok() || !file.exists() {
                forget(&mut ix, &k);
            }
        }
        Ok(())
    }
}

fn forget(ix: &mut Index, k: &str) {
    if let Some(e) = ix.items.remove(k) {
        ix.total -= e.size;
    }
}

fn remember(ix: &mut Index, file: &Path, size: u64, used: f64) {
    let k = file.to_string_lossy().to_lowercase();
    forget(ix, &k);
    ix.items.insert(k, Item { file: file.to_owned(), size, used });
    ix.total += size;
}

fn touch(file: &Path, used: f64) {
    let t = UNIX_EPOCH + Duration::from_secs_f64(used.max(0.0) / 1000.0);
    if let Ok(f) = std::fs::File::options().write(true).open(file) {
        let _ = f.set_modified(t);
    }
}

/// Every file under the folder, four levels deep, part and temp files left out.
fn walk(dir: &Path, depth: u32, ix: &mut Index) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() && depth < 4 {
            walk(&p, depth + 1, ix);
        } else if ft.is_file() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.ends_with(".part") || name.ends_with(".tmp") {
                continue;
            }
            if let Ok(m) = e.metadata() {
                let used = m.modified().map_or(0.0, ms_of);
                remember(ix, &p, m.len(), used);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_entries_and_drops_the_least_recently_used_above_the_limit() {
        let dir = std::env::temp_dir().join(format!("cut-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let c = Cache::new(dir.clone(), 250);
        assert!(c.put("a", &[1; 100]));
        assert!(c.put("b", &[2; 100]));
        assert_eq!(c.get("a").as_deref(), Some(&[1u8; 100][..]), "read back, and now the most recent");
        assert!(c.put("c", &[3; 100]));
        assert!(c.get("b").is_none(), "the least recently used went");
        assert!(c.get("a").is_some() && c.get("c").is_some());
        assert_eq!(c.info(), (200, 2));
        assert!(!c.put("big", &[0; 300]), "an entry larger than the limit is refused");
        let again = Cache::new(dir.clone(), 250);
        assert_eq!(again.info(), (200, 2), "the index is rebuilt from the folder");
        assert!(c.file_of("a").starts_with(dir.join("entries")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
