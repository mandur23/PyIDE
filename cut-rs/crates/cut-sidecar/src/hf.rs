//! The Hugging Face model cache, where every model the editor downloads lives (shared with the JavaScript editor and
//! anything else on the PC that uses Hugging Face).

use std::path::PathBuf;

fn var(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `%HF_HUB_CACHE%`, else `%HF_HOME%\hub`, else `~\.cache\huggingface\hub`.
pub fn cache_dir() -> PathBuf {
    var("HF_HUB_CACHE").unwrap_or_else(|| {
        var("HF_HOME").unwrap_or_else(|| crate::home().join(".cache").join("huggingface")).join("hub")
    })
}

/// The cache folder of a repo (`models--openai--whisper-small`).
pub fn repo_dir(repo: &str) -> PathBuf {
    cache_dir().join(format!("models--{}", repo.replace('/', "--")))
}

/// The path of `file` in any downloaded snapshot of `repo`.
pub fn cached_file(repo: &str, file: &str) -> Option<PathBuf> {
    let snaps = repo_dir(repo).join("snapshots");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(snaps).ok()?.flatten().map(|e| e.path()).collect();
    dirs.sort();
    dirs.into_iter().map(|d| d.join(file)).find(|p| p.exists())
}
