//! Where the vocals go and what they are called (`main/cut/voice.js`, `ui-voice.js keyOf`): a 16-bit WAV named
//! `<media name> voice <key>.wav`, in the Cut workspace's `Media` folder for files the project imports (Isolate
//! Voice) or its `Cache` folder for the sound speech recognition reads; never next to the person's media.

use std::path::{Path, PathBuf};

use cut_model::Media;

use crate::files::{Home, js_space};

/// The model's sample rate.
pub const RATE: u32 = 44100;

/// Where a vocals file is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// `<workspace>\Media`: imported into the project, outside the cache's LRU.
    Media,
    /// `<workspace>\Cache`: made again when needed.
    Cache,
}

impl Place {
    pub fn dir(self, home: &Home) -> PathBuf {
        match self {
            Place::Media => home.home.join("Media"),
            Place::Cache => home.cache.clone(),
        }
    }
}

/// A WAV's name part from the media's (`cleanName`): the extension and the characters Windows refuses dropped, at
/// most 60 UTF-16 units of the rest (a pair cut in two leaves U+FFFD), `sound` when nothing is left.
pub fn clean_name(name: &str) -> String {
    let name = if name.is_empty() { "sound" } else { name };
    let stem = name.rfind('.').map_or(name, |i| &name[..i]);
    let cleaned: String = stem
        .chars()
        .map(
            |c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\x1f') { '_' } else { c },
        )
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim_matches(js_space);
    let units: Vec<u16> = cleaned.encode_utf16().take(60).collect();
    let out = String::from_utf16_lossy(&units);
    if out.is_empty() { "sound".into() } else { out }
}

/// `<name> voice <key>.wav` (`fileName`).
pub fn file_name(name: &str, key: &str) -> String {
    format!("{} voice {key}.wav", clean_name(name))
}

/// `Math.round(s * 1000) / 1000` written as JavaScript writes a number.
fn round3(s: f64) -> String {
    crate::prefs::proxy::js_text(&serde_json::json!(cut_audio::util::js_round(s * 1000.0) / 1000.0))
}

/// The key of the vocals of source seconds `[from, to)` of a media file (`to` `None`: to its end).
pub fn key_of(m: &Media, from: f64, to: Option<f64>) -> String {
    let js = crate::prefs::proxy::js_text;
    let to = to.map_or_else(|| "end".to_owned(), round3);
    crate::prefs::proxy::hash(&format!(
        "{}|{}|{}|{}|{to}|htdemucs",
        m.path.to_lowercase(),
        js(&m.size),
        js(&m.mtime),
        round3(from)
    ))
}

/// A 16-bit PCM WAV header for `frames` frames at 44.1 kHz (`wavHeader`).
pub fn wav_header(frames: u64, channels: u16) -> [u8; 44] {
    let data = (frames * u64::from(channels) * 2) as u32;
    let mut b = [0u8; 44];
    let mut put = |at: usize, bytes: &[u8]| b[at..at + bytes.len()].copy_from_slice(bytes);
    put(0, b"RIFF");
    put(4, &36u32.wrapping_add(data).to_le_bytes());
    put(8, b"WAVE");
    put(12, b"fmt ");
    put(16, &16u32.to_le_bytes());
    put(20, &1u16.to_le_bytes());
    put(22, &channels.to_le_bytes());
    put(24, &RATE.to_le_bytes());
    put(28, &(RATE * u32::from(channels) * 2).to_le_bytes());
    put(32, &(channels * 2).to_le_bytes());
    put(34, &16u16.to_le_bytes());
    put(36, b"data");
    put(40, &data.to_le_bytes());
    b
}

/// A WAV made before for this key, in the media folder first, then the cache (`find`).
pub fn find(home: &Home, name: &str, key: &str) -> Option<(PathBuf, Place)> {
    [Place::Media, Place::Cache].into_iter().find_map(|place| {
        let p = place.dir(home).join(file_name(name, key));
        std::fs::metadata(&p).is_ok_and(|m| m.len() > 44).then_some((p, place))
    })
}

/// The `.part` file a WAV is written as before it is renamed.
pub fn part_of(out: &Path) -> PathBuf {
    let mut s = out.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}
