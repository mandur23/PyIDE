//! `paths.js`: which paths are opened, checked on the real path, network paths refused before anything touches them.
//!
//! Opening `\\host\share` (or `\\?\UNC\host\share`, or a link whose target is one) makes Windows sign in to that host
//! with the user's NTLM credentials, so a network path is refused from its text alone. `\\?\C:\...` is a local long
//! path and is read as `C:\...`; `\\.\` device paths are refused. The path functions below are Node's `path.win32`.

use std::fs::{self, Metadata};
use std::io;
use std::path::Path;

use super::{Code, FileError};

const MAX_LINK_HOPS: usize = 32;

fn fail(code: Code, message: &str) -> FileError {
    FileError::new(code, message)
}

fn is_sep(c: u8) -> bool {
    c == b'\\' || c == b'/'
}

/// `^[a-z]:[\\/]`, case-insensitive.
fn has_drive_root(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && is_sep(b[2])
}

/// What a JavaScript `.` refuses to match: the line terminators.
fn has_line_break(s: &str) -> bool {
    s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// `\\host\share`, `//host/share`, `\??\UNC\...` and a bare `UNC\host\share` as some link targets read.
pub(crate) fn is_network(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() >= 2 && is_sep(b[0]) && is_sep(b[1]))
        || starts_with_ignore_case(s, "\\??\\unc\\")
        || starts_with_ignore_case(s, "unc\\")
}

/// The local absolute form of a path (`localPath`), or why it is not one. Touches nothing.
pub fn local_path(p: &str) -> Result<String, FileError> {
    if p.is_empty() || p.contains('\0') || (p.len() > 32767 && p.encode_utf16().count() > 32767) {
        return Err(fail(Code::BadArgs, "not a path"));
    }
    let mut s = p;
    let b = p.as_bytes();
    if b.len() >= 4 && is_sep(b[0]) && is_sep(b[1]) && (b[2] == b'?' || b[2] == b'.') && is_sep(b[3]) {
        let rest = &p[4..];
        if b[2] != b'?' || !has_drive_root(rest) || has_line_break(rest) {
            return Err(fail(Code::Network, "network and device paths are not opened"));
        }
        s = rest;
    }
    if is_network(s) {
        return Err(fail(Code::Network, "network paths are not opened"));
    }
    // C:foo is relative to that drive's current folder; a colon past the drive names an NTFS stream.
    if !has_drive_root(s) {
        return Err(fail(Code::BadArgs, "not an absolute path"));
    }
    if s[2..].contains(':') {
        return Err(fail(Code::BadArgs, "not a file path"));
    }
    Ok(normalize(s))
}

/// `path.win32.resolve` of a path that starts with `X:\`: `.` and `..` resolved (never above the root), separators as
/// one backslash, no trailing separator past the root.
fn normalize(s: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in s[3..].split(['\\', '/']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let mut out = String::with_capacity(s.len());
    out.push_str(&s[..2]);
    out.push('\\');
    out.push_str(&parts.join("\\"));
    out
}

/// `path.win32.resolve(dir, target, ...rest)` for an absolute `dir` (`X:\...`).
fn resolve_from(dir: &str, target: &str, rest: &[&str]) -> String {
    let t = target.as_bytes();
    let mut joined = if has_drive_root(target) {
        target.to_owned()
    } else if t.first().is_some_and(|&c| is_sep(c)) {
        format!("{}{target}", &dir[..2])
    } else if t.len() >= 2 && t[0].is_ascii_alphabetic() && t[1] == b':' {
        if t[0].eq_ignore_ascii_case(&dir.as_bytes()[0]) {
            format!("{dir}\\{}", &target[2..])
        } else {
            format!("{}\\{}", &target[..2], &target[2..])
        }
    } else {
        format!("{dir}\\{target}")
    };
    for part in rest {
        joined.push('\\');
        joined.push_str(part);
    }
    normalize(&joined)
}

/// `path.win32.basename`: the last part, trailing separators ignored, a leading drive skipped.
pub(crate) fn basename(p: &str) -> &str {
    let b = p.as_bytes();
    let start = if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' { 2 } else { 0 };
    let t = p[start..].trim_end_matches(['\\', '/']);
    t.rfind(['\\', '/']).map_or(t, |i| &t[i + 1..])
}

/// `path.win32.dirname` of a normalized `X:\...` path.
pub(crate) fn dirname(p: &str) -> &str {
    match p.rfind('\\') {
        Some(i) if i > 2 => &p[..i],
        _ => p.get(..3).unwrap_or(p),
    }
}

/// `extOf`: the extension without its dot, in lower case (`path.extname`: none for `.ncut` or `..`).
pub fn ext_of(p: &str) -> String {
    let name = basename(p);
    match name.rfind('.') {
        Some(0) | None => String::new(),
        Some(_) if name == ".." => String::new(),
        Some(i) => name[i + 1..].to_lowercase(),
    }
}

/// `\\?\C:\x` as `C:\x` and `\\?\UNC\host\x` as `\\host\x`, as Node's `realpath` reports them.
fn plain(real: &Path) -> Result<String, FileError> {
    let s = real.to_str().ok_or_else(|| fail(Code::Io, "a path that is not Unicode"))?;
    Ok(if starts_with_ignore_case(s, "\\\\?\\unc\\") {
        format!("\\\\{}", &s[8..])
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        s.to_owned()
    })
}

/// Whether an error is what libuv reports as `ENOENT` or `ENOTDIR`.
fn is_missing(err: &io::Error) -> bool {
    // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_INVALID_DRIVE, ERROR_INVALID_NAME, ERROR_BAD_PATHNAME,
    // ERROR_DIRECTORY, ERROR_BAD_NETPATH (an unknown \\?\ volume).
    matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
        || matches!(err.raw_os_error(), Some(2 | 3 | 15 | 53 | 123 | 161 | 267))
}

fn link_target(path: &str) -> Option<String> {
    fs::read_link(path).ok().map(|t| t.to_string_lossy().into_owned())
}

/// Follows every link on the way to `p` without opening the final file, refusing one whose target is a network path
/// before `canonicalize` would open it.
fn link_to_network(p: &str) -> Result<(), FileError> {
    let mut rest = p.to_owned();
    let mut hops = 0;
    while hops <= MAX_LINK_HOPS {
        let root = &rest[..3];
        let parts: Vec<&str> = rest[3..].split(['\\', '/']).filter(|s| !s.is_empty()).collect();
        let mut cur = root.to_owned();
        let mut next = None;
        for (i, part) in parts.iter().enumerate() {
            if !cur.ends_with('\\') {
                cur.push('\\');
            }
            cur.push_str(part);
            let Ok(meta) = fs::symlink_metadata(&cur) else { return Ok(()) };
            if !meta.file_type().is_symlink() {
                continue;
            }
            let Some(mut target) = link_target(&cur) else { return Ok(()) };
            let t = target.as_bytes();
            let long = (t.len() >= 3 && is_sep(t[0]) && is_sep(t[1]) && t[2] == b'?') || target.starts_with("\\??");
            if long && t.len() > 4 && is_sep(t[3]) && has_drive_root(&target[4..]) && !has_line_break(&target[4..]) {
                target = target[4..].to_owned();
            } else if is_network(&target) {
                return Err(fail(Code::Network, "a link here leads to a network path"));
            }
            next = Some(resolve_from(dirname(&cur), &target, &parts[i + 1..]));
            break;
        }
        match next {
            Some(n) => rest = n,
            None => return Ok(()),
        }
        hops += 1;
    }
    Err(fail(Code::Io, "too many links"))
}

/// An existing local entry: the path as given (normalized), its real path, and what it is.
pub(crate) struct Entry {
    pub path: String,
    pub real: String,
    pub meta: Metadata,
}

/// `realEntry`: the real path of an existing local entry.
pub(crate) fn real_entry(p: &str) -> Result<Entry, FileError> {
    let local = local_path(p)?;
    link_to_network(&local)?;
    let real = match fs::canonicalize(&local) {
        Ok(r) => plain(&r)?,
        Err(e) if is_missing(&e) => return Err(fail(Code::Missing, "no such file")),
        Err(e) => return Err(FileError::io(&e)),
    };
    if is_network(&real) {
        return Err(fail(Code::Network, "network paths are not opened"));
    }
    let meta = match fs::metadata(&real) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(fail(Code::Missing, "no such file")),
        Err(e) => return Err(FileError::io(&e)),
    };
    Ok(Entry { path: local, real, meta })
}

/// `realFile`: an existing regular file whose name, as given and as it really is, has one of `exts`.
pub(crate) fn real_file(p: &str, exts: &[&str]) -> Result<Entry, FileError> {
    let entry = real_entry(p)?;
    if !entry.meta.is_file() {
        return Err(fail(Code::NotFile, "not a file"));
    }
    if !exts.contains(&ext_of(&entry.path).as_str()) || !exts.contains(&ext_of(&entry.real).as_str()) {
        return Err(fail(Code::Extension, "this kind of file is not opened here"));
    }
    Ok(entry)
}

/// `writableFile`: a local path with one of `exts` in an existing folder not reached through a network link; the file
/// itself may not exist yet. The path returned is in the folder's real path.
pub(crate) fn writable_file(p: &str, exts: &[&str]) -> Result<String, FileError> {
    let local = local_path(p)?;
    if !exts.contains(&ext_of(&local).as_str()) {
        return Err(fail(Code::Extension, "this kind of file is not written here"));
    }
    let dir = match real_entry(dirname(&local)) {
        Ok(d) => d,
        Err(e) if e.code == Code::Missing => return Err(fail(Code::Missing, "the folder does not exist")),
        Err(e) => return Err(e),
    };
    if !dir.meta.is_dir() {
        return Err(fail(Code::NotFile, "not a folder"));
    }
    let mut target = dir.real;
    if !target.ends_with('\\') {
        target.push('\\');
    }
    target.push_str(basename(&local));
    if let Ok(meta) = fs::symlink_metadata(&target)
        && (meta.is_dir() || meta.file_type().is_symlink())
    {
        return Err(fail(Code::NotFile, "not a file"));
    }
    Ok(target)
}

/// A path as the text `paths.js` checks: not Unicode is not a path.
pub(crate) fn text_of(p: &Path) -> Result<&str, FileError> {
    p.to_str().ok_or_else(|| fail(Code::BadArgs, "not a path"))
}

/// Node's `realpath` of a folder, as `inAutosave` compares it.
pub(crate) fn real_dir(p: &Path) -> Option<String> {
    fs::canonicalize(p).ok().and_then(|r| plain(&r).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_paths() {
        assert_eq!(local_path("c:\\a\\..\\..\\b//c\\.\\d\\").unwrap(), "c:\\b\\c\\d");
        assert_eq!(local_path("C:/").unwrap(), "C:\\");
        assert_eq!(local_path("\\\\?\\c:\\x\\y.ncut").unwrap(), "c:\\x\\y.ncut");
        for (p, code) in [
            ("", Code::BadArgs),
            ("C:x", Code::BadArgs),
            ("x\\y", Code::BadArgs),
            ("C:\\a:b", Code::BadArgs),
            ("C:\\a\0", Code::BadArgs),
            ("\\\\host\\share\\x.ncut", Code::Network),
            ("//host/share", Code::Network),
            ("\\\\?\\UNC\\host\\x", Code::Network),
            ("\\\\.\\C:\\x", Code::Network),
            ("\\??\\UNC\\host", Code::Network),
            ("UNC\\host", Code::Network),
            ("\\\\?\\C:\\a\nb", Code::Network),
        ] {
            assert_eq!(local_path(p).unwrap_err().code, code, "{p:?}");
        }
    }

    #[test]
    fn names_of_paths() {
        assert_eq!(basename("C:\\"), "");
        assert_eq!(basename("C:\\a\\Trip.ncut\\"), "Trip.ncut");
        assert_eq!(dirname("C:\\a.ncut"), "C:\\");
        assert_eq!(dirname("C:\\x\\a.ncut"), "C:\\x");
        assert_eq!(ext_of("a.NCUT"), "ncut");
        assert_eq!(ext_of(".ncut"), "");
        assert_eq!(ext_of("..ncut"), "ncut");
        assert_eq!(ext_of(".."), "");
        assert_eq!(ext_of("a.ncut\\"), "ncut");
        assert_eq!(ext_of("a.ncut."), "");
        assert_eq!(resolve_from("C:\\a", "..\\b", &["c"]), "C:\\b\\c");
        assert_eq!(resolve_from("C:\\a", "\\b", &[]), "C:\\b");
        assert_eq!(resolve_from("C:\\a", "D:\\b", &[]), "D:\\b");
    }
}
