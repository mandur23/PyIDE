//! Making and filling the environment: finding a Python, the venv, pip, torch and torchvision, Hugging Face
//! downloads. Every step runs on the caller's thread and may take minutes; errors are the JavaScript's messages, which
//! [`crate::classify`] reads.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value as Json;

use crate::job::NO_WINDOW;
use crate::{Job, Runtime, TORCH, usable};

const PIP: [&str; 4] = ["-m", "pip", "install", "--disable-pip-version-check"];

/// Runs a command for its stdout, ended after `timeout` (`execFile`).
fn exec(cmd: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(cmd)
        .args(args)
        .creation_flags(NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = std::io::Read::read_to_end(&mut out, &mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let text = String::from_utf8_lossy(&reader.join().ok()?).into_owned();
    status.filter(|s| s.success()).map(|_| text)
}

/// The version of torch `cmd` imports.
pub fn torch_version(cmd: &str) -> Option<String> {
    exec(cmd, &["-c", "import torch; print(torch.__version__)"], Duration::from_secs(60)).map(|o| o.trim().to_owned())
}

/// Whether the environment's torch is new enough (an import: seconds).
pub fn torch_usable(rt: &Runtime) -> bool {
    torch_version(&rt.python.display().to_string()).is_some_and(|v| usable(&v))
}

/// The newest version pip's index lists of `pkg` (`""` when it lists none), `None` when pip could not ask.
fn listed(cmd: &str, pkg: &str) -> Option<String> {
    let out = exec(
        cmd,
        &["-m", "pip", "index", "versions", pkg, "--disable-pip-version-check", "--retries", "1"],
        Duration::from_secs(60),
    )?;
    Some(out.split_once('(').and_then(|(_, r)| r.split_once(')')).map(|(v, _)| v.to_owned()).unwrap_or_default())
}

/// Whether torch has a build (from the floor up) for `cmd`'s interpreter. pip answers "no matching distribution"
/// offline too, so a refusal counts only when the same index lists pip itself.
pub fn torch_has_build(cmd: &str) -> bool {
    match listed(cmd, "torch") {
        Some(latest) => usable(&latest),
        None => listed(cmd, "pip").is_none(),
    }
}

/// An interpreter found on this PC.
#[derive(Debug, Clone, PartialEq)]
pub struct Python {
    pub cmd: String,
    /// `Python 3.12.4 (64-bit)`.
    pub label: String,
    /// It has a usable torch already (its packages are reused).
    pub torch: bool,
}

const DESCRIBE: &str = "import json,platform,struct,sysconfig;print(json.dumps([platform.python_version(),struct.calcsize(\"P\")*8,platform.machine(),bool(sysconfig.get_config_var(\"Py_GIL_DISABLED\"))]))";

/// What `cmd` is, or `None` when it is no working Python.
pub fn describe(cmd: &str) -> Option<Python> {
    let out = exec(cmd, &["-c", DESCRIBE], Duration::from_secs(15))?;
    let v: Json = serde_json::from_str(out.trim()).ok()?;
    let version = v.get(0)?.as_str()?;
    let bits = v.get(1)?.as_f64()?;
    let machine = v.get(2)?.as_str()?;
    let free = v.get(3)?.as_bool().unwrap_or(false);
    let arch = if machine.to_ascii_lowercase().contains("arm") { machine.to_owned() } else { format!("{bits}-bit") };
    let free = if free { " free-threaded" } else { "" };
    Some(Python { cmd: cmd.to_owned(), label: format!("Python {version}{free} ({arch})"), torch: false })
}

/// The interpreters to try, in order: `preferred`, `known`, every one the Python launcher lists (newest first), and
/// PATH's `python`; each once (case ignored), those that answer.
pub fn pythons(preferred: Option<&str>, known: &[String]) -> Vec<Python> {
    let launcher: Vec<String> = exec("py", &["-0p"], Duration::from_secs(15))
        .map(|o| o.lines().filter_map(exe_path).collect())
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let cmds: Vec<String> = preferred
        .map(str::to_owned)
        .into_iter()
        .chain(known.iter().cloned())
        .chain(launcher)
        .chain(["python".to_owned()])
        .filter(|c| !c.is_empty() && seen.insert(c.to_lowercase()))
        .collect();
    std::thread::scope(|s| {
        let hs: Vec<_> = cmds.iter().map(|c| s.spawn(move || describe(c))).collect();
        hs.into_iter().filter_map(|h| h.join().ok().flatten()).collect()
    })
}

/// `C:\...\python.exe` in a line of `py -0p` (`/[A-Za-z]:\\.*\.exe/i`, greedy).
fn exe_path(line: &str) -> Option<String> {
    let b = line.as_bytes();
    let start = (0..b.len().saturating_sub(2))
        .find(|&i| b[i].is_ascii_alphabetic() && b[i + 1] == b':' && b[i + 2] == b'\\')?;
    let lower = line.to_ascii_lowercase();
    let end = lower.rfind(".exe")?;
    (end >= start + 3).then(|| line[start..end + 4].to_owned())
}

/// Picks the interpreter to make the environment from: one with a usable torch first (its packages are reused, saving
/// a download of hundreds of MB), then one torch has a build for; `torch` callers need one of those.
pub fn pick_python(preferred: Option<&str>, known: &[String], torch: bool) -> Result<Python, String> {
    let found = pythons(preferred, known);
    if found.is_empty() {
        return Err("No Python interpreter found".into());
    }
    for py in &found {
        if torch_version(&py.cmd).is_some_and(|v| usable(&v)) {
            return Ok(Python { torch: true, ..py.clone() });
        }
    }
    for py in &found {
        if torch_has_build(&py.cmd) {
            return Ok(py.clone());
        }
    }
    if torch {
        let mut labels: Vec<&str> = Vec::new();
        for p in &found {
            if !labels.contains(&p.label.as_str()) {
                labels.push(&p.label);
            }
        }
        return Err(format!("PyTorch has no build for {}", labels.join(", ")));
    }
    Ok(found[0].clone())
}

/// Makes sure the environment exists (`ensureVenv`); `torch` also makes sure torch can be installed in it: one made
/// from an interpreter torch has no build for is set aside and made again from one it has. Earlier environments set
/// aside are deleted once nothing holds their files.
pub fn ensure_venv(
    job: &Job,
    rt: &Runtime,
    interpreter: Option<&str>,
    torch: bool,
    interpreters: &[String],
) -> Result<(), String> {
    std::fs::create_dir_all(&rt.dir).map_err(|e| e.to_string())?;
    if let Ok(rd) = std::fs::read_dir(&rt.dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.strip_prefix("venv.old-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
                let p = e.path();
                std::thread::spawn(move || std::fs::remove_dir_all(p));
            }
        }
    }
    let python = rt.python.display().to_string();
    if rt.python_ready() && (!torch || torch_version(&python).is_some_and(|v| usable(&v)) || torch_has_build(&python)) {
        return Ok(());
    }
    let py = pick_python(interpreter, interpreters, torch)?;
    if rt.python_ready() {
        let now = describe(&python).map_or_else(|| "This Python".to_owned(), |p| p.label);
        job.log(&format!(
            "{now} has no PyTorch build; recreating the AI environment with {}. AI code completion sets up its packages again the next time it is used.\n",
            py.label
        ));
        crate::kill_all();
        // Renamed first: a file another process holds makes the rename fail with the environment whole, where a delete
        // would stop halfway and leave that process a broken environment.
        let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let old = PathBuf::from(format!("{}.old-{millis}", rt.venv.display()));
        if let Err(e) = std::fs::rename(&rt.venv, &old) {
            return Err(if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) {
                "The AI environment is in use by another Nano Studio window. Close it and try again.".into()
            } else {
                format!("The AI environment could not be replaced: {e}")
            });
        }
        std::thread::spawn(move || std::fs::remove_dir_all(old));
    }
    let mut args = vec!["-m".to_owned(), "venv".to_owned()];
    if py.torch {
        args.push("--system-site-packages".into());
    }
    args.push(rt.venv.display().to_string());
    job.run(Path::new(&py.cmd), &args, &[])
}

/// `python -m pip install --disable-pip-version-check <args>` in the environment.
pub fn pip_install(job: &Job, rt: &Runtime, args: &[&str]) -> Result<(), String> {
    let all: Vec<String> = PIP.iter().chain(args).map(|s| (*s).to_owned()).collect();
    job.run(&rt.python, &all, &[])
}

/// torchvision paired with the installed torch (2.X.Y pairs with 0.(X+15).Y) from PyTorch's index for the same
/// variant, `--no-deps` so a reused torch stays; when that build is missing for this Python, torch and torchvision
/// resolved together.
pub fn install_torchvision(job: &Job, rt: &Runtime) -> Result<(), String> {
    let index = std::env::var("PYIDE_TORCH_INDEX")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://download.pytorch.org/whl".into());
    if let Some((minor, patch, variant)) = torch_version(&rt.python.display().to_string()).as_deref().and_then(pair) {
        let tv = format!(
            "torchvision==0.{}.{patch}{}",
            minor + 15,
            variant.as_ref().map_or(String::new(), |v| format!("+{v}"))
        );
        let url = format!("{index}/{}", variant.as_deref().unwrap_or("cpu"));
        match pip_install(job, rt, &["--no-deps", "pillow", &tv, "--extra-index-url", &url]) {
            Ok(()) => return Ok(()),
            Err(e) if e.contains("Cancelled") => return Err(e),
            Err(_) => job.log("The torchvision build paired with this torch is not available for this Python; installing a matching torch and torchvision.\n"),
        }
    }
    pip_install(job, rt, &[TORCH, "torchvision"])
}

/// `2.X.Y[+variant]` -> (X, Y, variant).
fn pair(v: &str) -> Option<(u64, String, Option<String>)> {
    let rest = v.strip_prefix("2.")?;
    let (minor, rest) = rest.split_once('.')?;
    let minor: u64 = minor.parse().ok().filter(|_| minor.bytes().all(|b| b.is_ascii_digit()))?;
    let n = rest.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 {
        return None;
    }
    let patch = rest[..n].to_owned();
    let variant = rest[n..]
        .strip_prefix('+')
        .map(|s| s.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect::<String>())
        .filter(|s| !s.is_empty());
    Some((minor, patch, variant))
}

/// Downloads a Hugging Face repo (or only `files` of it) into the cache.
pub fn hf_download(job: &Job, rt: &Runtime, repo: &str, files: Option<&[&str]>) -> Result<(), String> {
    let repo_js = Json::from(repo).to_string();
    let code = match files {
        Some(f) => format!(
            "from huggingface_hub import hf_hub_download\nfor f in {}: hf_hub_download({repo_js}, f)",
            Json::from(f.to_vec())
        ),
        None => format!("from huggingface_hub import snapshot_download; snapshot_download({repo_js})"),
    };
    job.run(&rt.python, &["-c".into(), code], &[])
}

/// Downloads the files of a repo that match `patterns` (`snapshot_download(repo, allow_patterns=…)`).
pub fn snapshot_download(job: &Job, rt: &Runtime, repo: &str, patterns: &[&str]) -> Result<(), String> {
    let code = format!(
        "from huggingface_hub import snapshot_download\nsnapshot_download({}, allow_patterns={})",
        Json::from(repo),
        Json::from(patterns.to_vec())
    );
    job.run(&rt.python, &["-c".into(), code], &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_lines_and_torch_pairs() {
        assert_eq!(
            exe_path(" -V:3.12 *        C:\\Python312\\python.exe").as_deref(),
            Some("C:\\Python312\\python.exe")
        );
        assert_eq!(exe_path(" -V:3.11          D:\\x y\\Python.EXE").as_deref(), Some("D:\\x y\\Python.EXE"));
        assert_eq!(exe_path("No installed Pythons found!"), None);
        assert_eq!(pair("2.7.1+cu128"), Some((7, "1".into(), Some("cu128".into()))));
        assert_eq!(pair("2.6.0"), Some((6, "0".into(), None)));
        assert_eq!(pair("1.13.1"), None);
        assert_eq!(pair("2.x.1"), None);
    }

    #[test]
    fn the_code_given_to_python() {
        assert_eq!(Json::from(vec!["*.json", "model.safetensors"]).to_string(), "[\"*.json\",\"model.safetensors\"]");
    }
}
