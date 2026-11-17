//! Where the environment is and what it holds, read from its files (importing torch takes seconds).

use std::path::{Path, PathBuf};

/// transformers 5 turns PyTorch off below 2.6, so pip alone would keep an older torch the models cannot load with.
pub const TORCH: &str = "torch>=2.6";

/// The home folder (`os.homedir()`: `%USERPROFILE%` on Windows).
pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The private AI environment: shared by every Nano Studio app and profile, named after its first user (semantic
/// search), under the home folder because packaged launchers virtualize `%LOCALAPPDATA%`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    /// `~\.pyide\semantic`: the servers' working folder.
    pub dir: PathBuf,
    pub venv: PathBuf,
    pub python: PathBuf,
    pub site_packages: PathBuf,
}

impl Runtime {
    /// The environment the JavaScript editor uses too.
    pub fn shared() -> Runtime {
        Runtime::at(home().join(".pyide").join("semantic"))
    }

    /// An environment in `dir` (tests).
    pub fn at(dir: PathBuf) -> Runtime {
        let venv = dir.join("venv");
        Runtime {
            python: venv.join("Scripts").join("python.exe"),
            site_packages: venv.join("Lib").join("site-packages"),
            venv,
            dir,
        }
    }

    pub fn python_ready(&self) -> bool {
        self.python.exists()
    }

    /// Whether the environment's own site-packages has `name` (a file check, not an import).
    pub fn has_package(&self, name: &str) -> bool {
        self.site_packages.join(name).exists()
    }

    /// The folders the environment imports from: its own site-packages, then the interpreter's when it reuses them.
    pub fn site_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = vec![self.site_packages.clone()];
        if let Ok(cfg) = std::fs::read_to_string(self.venv.join("pyvenv.cfg")) {
            let value = |key: &str| {
                cfg.lines().find_map(|l| {
                    let (k, v) = l.split_once('=')?;
                    (k.trim_end() == key && k.len() == k.trim_start().len()).then(|| v.trim().to_owned())
                })
            };
            let shared = cfg.lines().any(|l| {
                l.split_once('=').is_some_and(|(k, v)| {
                    k.trim_end().eq_ignore_ascii_case("include-system-site-packages")
                        && k.len() == k.trim_start().len()
                        && v.trim_start().get(..4).is_some_and(|t| t.eq_ignore_ascii_case("true"))
                })
            });
            if let Some(h) = value("home").filter(|h| !h.is_empty())
                && shared
            {
                dirs.push(Path::new(&h).join("Lib").join("site-packages"));
            }
        }
        dirs
    }

    /// Like [`Runtime::has_package`], also counting the packages reused from the interpreter it was made from.
    pub fn importable(&self, name: &str) -> bool {
        self.site_dirs().iter().any(|d| d.join(name).exists())
    }

    /// The version of the torch the environment imports, from its dist-info.
    pub fn torch_on_disk(&self) -> Option<String> {
        for d in self.site_dirs() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            if let Some(v) = names.iter().find_map(|n| torch_dist_info(n)) {
                return Some(v);
            }
        }
        None
    }

    /// True only when torch's dist-info shows a version below the floor.
    pub fn torch_too_old(&self) -> bool {
        self.torch_on_disk().is_some_and(|v| !usable(&v))
    }
}

/// `torch-<version>.dist-info` -> the version (`/^torch-(\d[^-]*)\.dist-info$/i`).
fn torch_dist_info(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let v = lower.strip_prefix("torch-")?.strip_suffix(".dist-info")?;
    (v.starts_with(|c: char| c.is_ascii_digit()) && !v.contains('-')).then(|| name[6..6 + v.len()].to_owned())
}

/// Whether a torch version is at least 2.6.
pub fn usable(version: &str) -> bool {
    let num = |s: &str| -> Option<(u64, usize)> {
        let n = s.bytes().take_while(u8::is_ascii_digit).count();
        (n > 0).then(|| (s[..n].parse().unwrap_or(u64::MAX), n))
    };
    let Some((major, n)) = num(version) else { return false };
    let Some(rest) = version[n..].strip_prefix('.') else { return false };
    let Some((minor, _)) = num(rest) else { return false };
    major > 2 || (major == 2 && minor >= 6)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn torch_floor() {
        for (v, ok) in [
            ("2.6.0", true),
            ("2.10.1+cpu", true),
            ("3.0", true),
            ("2.5.1", false),
            ("1.13", false),
            ("2", false),
            ("", false),
            ("x2.6", false),
        ] {
            assert_eq!(usable(v), ok, "{v}");
        }
        assert_eq!(torch_dist_info("torch-2.7.1+cpu.dist-info").as_deref(), Some("2.7.1+cpu"));
        assert_eq!(torch_dist_info("Torch-2.7.1.DIST-INFO").as_deref(), Some("2.7.1"));
        assert_eq!(torch_dist_info("torchvision-0.22.dist-info"), None);
        assert_eq!(torch_dist_info("torch-a.dist-info"), None);
    }

    #[test]
    fn environment_on_disk() {
        let dir = std::env::temp_dir().join(format!("cut-sidecar-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let rt = Runtime::at(dir.clone());
        assert!(!rt.python_ready() && rt.torch_on_disk().is_none() && !rt.torch_too_old());
        let base = dir.join("base");
        std::fs::create_dir_all(base.join("Lib/site-packages/torch-2.4.1.dist-info")).unwrap();
        std::fs::create_dir_all(base.join("Lib/site-packages/numpy")).unwrap();
        std::fs::create_dir_all(&rt.site_packages).unwrap();
        std::fs::write(
            rt.venv.join("pyvenv.cfg"),
            format!("home = {}\ninclude-system-site-packages = True\n", base.display()),
        )
        .unwrap();
        assert!(rt.importable("numpy") && !rt.has_package("numpy"));
        assert_eq!(rt.torch_on_disk().as_deref(), Some("2.4.1"));
        assert!(rt.torch_too_old());
        std::fs::create_dir_all(rt.site_packages.join("torch-2.7.0.dist-info")).unwrap();
        assert_eq!(rt.torch_on_disk().as_deref(), Some("2.7.0"), "the environment's own torch wins");
        std::fs::write(
            rt.venv.join("pyvenv.cfg"),
            format!("home = {}\ninclude-system-site-packages = false\n", base.display()),
        )
        .unwrap();
        assert!(!rt.importable("numpy"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
