//! Disk space for a setup: the room on the drive a download goes to, and how far a download has come.

use std::path::Path;

/// Free bytes on the drive of `dir`, or of the nearest folder above it that exists (`freeBytes`); `None` when no
/// folder up to the root answers (the JavaScript's `Infinity`). `probe` asks the system about one existing folder.
pub fn free_bytes(dir: &Path, probe: impl Fn(&Path) -> Option<u64>) -> Option<u64> {
    let mut d = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    loop {
        if d.exists()
            && let Some(n) = probe(&d)
        {
            return Some(n);
        }
        match d.parent() {
            Some(up) if up != d => d = up.to_path_buf(),
            _ => return None,
        }
    }
}

/// The bytes of every file under `dir` (`dirBytes`: a download's progress is its blobs folder's size).
pub fn dir_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            _ => e.metadata().map_or(0, |m| m.len()),
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_and_sizes() {
        let dir = std::env::temp_dir().join(format!("cut-sidecar-disk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("x"), [0u8; 10]).unwrap();
        std::fs::write(dir.join("a/b/y"), [0u8; 32]).unwrap();
        assert_eq!(dir_bytes(&dir), 42);
        assert_eq!(dir_bytes(&dir.join("missing")), 0);
        let asked = std::cell::RefCell::new(Vec::new());
        let free = free_bytes(&dir.join("not/yet/made"), |p| {
            asked.borrow_mut().push(p.to_path_buf());
            Some(7)
        });
        assert_eq!(free, Some(7));
        assert_eq!(asked.borrow().as_slice(), std::slice::from_ref(&dir), "the nearest folder that exists is asked");
        assert_eq!(free_bytes(&dir, |_| None), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
