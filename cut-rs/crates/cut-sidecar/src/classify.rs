//! The kind of a failed setup, from its error and the end of its log (`classify` in `main/cut/whisper.js`): what
//! the editor explains in plain words.

/// Why a setup failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupCode {
    Cancelled,
    NoPython,
    NoTorch,
    /// Another Nano Studio window holds the environment.
    Busy,
    Disk,
    Offline,
    Failed,
}

impl SetupCode {
    /// The JavaScript's code.
    pub fn as_str(self) -> &'static str {
        match self {
            SetupCode::Cancelled => "cancelled",
            SetupCode::NoPython => "noPython",
            SetupCode::NoTorch => "noTorch",
            SetupCode::Busy => "busy",
            SetupCode::Disk => "disk",
            SetupCode::Offline => "offline",
            SetupCode::Failed => "failed",
        }
    }

    /// The code of a JavaScript word (`PYIDE_*_FAKE_SETUP`); an unknown word is `failed`.
    pub fn parse(word: &str) -> SetupCode {
        [
            SetupCode::Cancelled,
            SetupCode::NoPython,
            SetupCode::NoTorch,
            SetupCode::Busy,
            SetupCode::Disk,
            SetupCode::Offline,
        ]
        .into_iter()
        .find(|c| c.as_str() == word)
        .unwrap_or(SetupCode::Failed)
    }
}

const DISK: [&str; 5] = ["no space left", "errno 28", "not enough space", "enospc", "disk is full"];
const OFFLINE: [&str; 15] = [
    "getaddrinfo",
    "failed to establish a new connection",
    "max retries exceeded",
    "nameresolution",
    "temporary failure in name resolution",
    "connectionerror",
    "connecttimeout",
    "readtimeout",
    "no matching distribution found",
    "localentrynotfound",
    "offlinemodeisenabled",
    "couldn't connect",
    "enotfound",
    "econnreset",
    "etimedout",
];

/// The code of a failure's text (its error message, a newline, the end of its log).
pub fn classify(text: &str) -> SetupCode {
    if text.contains("Cancelled") {
        return SetupCode::Cancelled;
    }
    if text.contains("No Python interpreter found") {
        return SetupCode::NoPython;
    }
    if text.contains("PyTorch has no build") {
        return SetupCode::NoTorch;
    }
    if text.contains("in use by another Nano Studio window") {
        return SetupCode::Busy;
    }
    let lower = text.to_lowercase();
    if DISK.iter().any(|p| lower.contains(p)) {
        return SetupCode::Disk;
    }
    if OFFLINE.iter().any(|p| lower.contains(p)) {
        return SetupCode::Offline;
    }
    SetupCode::Failed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_of_the_javascript() {
        for (t, c) in [
            ("Error: Cancelled", "cancelled"),
            ("No Python interpreter found", "noPython"),
            ("PyTorch has no build for Python 3.14 (64-bit)", "noTorch"),
            ("The AI environment is in use by another Nano Studio window. Close it and try again.", "busy"),
            ("OSError: [Errno 28] No space left on device", "disk"),
            ("python.exe exited with code 1\nERROR: No matching distribution found for torch>=2.6", "offline"),
            ("huggingface_hub.errors.LocalEntryNotFoundError: ...", "offline"),
            ("requests.exceptions.ConnectionError: HTTPSConnectionPool", "offline"),
            ("Max retries exceeded with url", "offline"),
            ("python.exe exited with code 1", "failed"),
            ("", "failed"),
        ] {
            assert_eq!(classify(t).as_str(), c, "{t}");
        }
        assert_eq!(SetupCode::parse("offline"), SetupCode::Offline);
        assert_eq!(SetupCode::parse("whatever"), SetupCode::Failed);
    }
}
