//! The embeddings of a media file's windows (`ui-speakers.js embedMedia`), cached in memory and in the workspace's
//! cache under the JavaScript's key, so either editor reuses what the other computed: `[dim u32 LE, n u32 LE,
//! n * dim f32 LE]`.
//!
//! Threads: everything here runs on the analysis thread; the in-memory map is shared with the UI thread's state.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use cut_model::Media;
use cut_sidecar::sound::SoundFiles;

use super::backend::{Backend, Embeddings, RATE};
use super::core::Window;
use crate::auto::{Cancelled, Step, Stop};
use crate::files::cache::Cache;

/// Windows a request: progress and Cancel between them.
const CHUNK: usize = 64;

/// `x.toFixed(3)`: like Rust's `{:.3}` except that an exact tie goes to the larger magnitude.
pub fn fixed3(x: f64) -> String {
    let y = x * 16.0;
    // only multiples of 1/16 with an odd numerator are exact ties at three decimals
    if y.fract() == 0.0 && y.abs() < 9e15 && (y as i64) % 2 != 0 {
        let n = (x.abs() * 1000.0 + 0.5).floor();
        let s = format!("{}.{:03}", (n / 1000.0).trunc(), n % 1000.0);
        return if x < 0.0 { format!("-{s}") } else { s };
    }
    format!("{x:.3}")
}

/// FNV-1a of a text's UTF-16 code units (`fnv`), 8 hex digits.
fn fnv(text: &str) -> String {
    let mut h = 0x811c_9dc5_u32;
    for c in text.encode_utf16() {
        h ^= u32::from(c);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// The cache key of a media file's windows (`keyOf`).
pub fn key_of(m: &Media, windows: &[Window]) -> String {
    let js = crate::prefs::proxy::js_text;
    let list: Vec<String> = windows.iter().map(|w| format!("{},{}", fixed3(w.t0), fixed3(w.t1))).collect();
    format!("speakers|v1|{}|{}|{}|{}|{}", m.path, js(&m.size), js(&m.mtime), windows.len(), fnv(&list.join(";")))
}

/// Embeddings as the cache keeps them.
pub fn to_bytes(e: &Embeddings) -> Vec<u8> {
    let n = e.data.len().checked_div(e.dim).unwrap_or(0);
    let mut out = Vec::with_capacity(8 + e.data.len() * 4);
    out.extend_from_slice(&(e.dim as u32).to_le_bytes());
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for v in &e.data {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// What the cache kept, when it is whole.
pub fn from_bytes(b: &[u8]) -> Option<Embeddings> {
    let head = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
    if b.len() < 8 {
        return None;
    }
    let (dim, n) = (head(0), head(4));
    if dim == 0 || b.len() != 8 + n.checked_mul(dim)?.checked_mul(4)? {
        return None;
    }
    Some(Embeddings { dim, data: b[8..].as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect() })
}

/// Embeddings computed this session, by key.
pub type Memory = Arc<Mutex<HashMap<String, Arc<Embeddings>>>>;

/// What embedding a media file needs: the model, the caches, and the temp sound files speech recognition writes.
pub struct Embedder<'a> {
    pub backend: &'a Backend,
    pub memory: &'a Memory,
    pub cache: &'a Cache,
    pub files: &'a SoundFiles,
}
/// The embeddings of a media file's windows (source seconds): from memory, the cache, else the model. `None`: the
/// span holds no sound. `on_part` follows the sound's writing (0..0.4) and the model (0.4..1).
pub fn embed_media(
    e: &Embedder<'_>,
    m: &Media,
    windows: &[Window],
    step: &Step,
    on_part: &dyn Fn(f64),
) -> Result<Option<Arc<Embeddings>>, Stop> {
    let key = key_of(m, windows);
    if let Some(hit) = e.memory.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        return Ok(Some(hit.clone()));
    }
    if let Some(hit) = e.cache.get(&key).and_then(|b| from_bytes(&b)) {
        let hit = Arc::new(hit);
        e.memory.lock().unwrap_or_else(|p| p.into_inner()).insert(key, hit.clone());
        return Ok(Some(hit));
    }
    let a = (windows.iter().map(|w| w.t0).fold(f64::INFINITY, f64::min) - 0.1).max(0.0);
    let b = windows.iter().map(|w| w.t1).fold(f64::NEG_INFINITY, f64::max) + 0.1;
    // the sound recognition reads, written the way it writes it (`ui.speech.writeSound`)
    let Some(file) =
        crate::speech::sound::write_sound(e.files, std::path::Path::new(&m.path), a, b, step, |f| on_part(0.4 * f))?
    else {
        return Ok(None);
    };
    let r = (|| -> Result<Embeddings, Stop> {
        let mut data = Vec::with_capacity(windows.len() * 256);
        let mut dim = 0;
        for (k, chunk) in windows.chunks(CHUNK).enumerate() {
            step.step().map_err(Err)?;
            let list: Vec<(u64, u64)> = chunk
                .iter()
                .map(|w| {
                    let last = file.samples.saturating_sub(1) as f64;
                    let offset = cut_audio::util::js_round((w.t0 - file.start) * RATE as f64).clamp(0.0, last) as u64;
                    let len = cut_audio::util::js_round((w.t1 - w.t0) * RATE as f64)
                        .min((file.samples - offset.min(file.samples)) as f64)
                        .min((30 * RATE) as f64)
                        .max(1.0);
                    (offset, len as u64)
                })
                .collect();
            let got = e.backend.embed(e.files, &file.id, &list, step.cancel_flag()).map_err(|f| match f.code {
                "cancelled" => Err(Cancelled),
                _ => Ok(format!("speakers:{}", f.error)),
            })?;
            dim = got.dim;
            data.extend(got.data);
            on_part(0.4 + 0.6 * (((k + 1) * CHUNK) as f64 / windows.len() as f64).min(1.0));
        }
        Ok(Embeddings { dim, data })
    })();
    e.files.close(&file.id);
    let emb = Arc::new(r?);
    e.cache.put(&key, &to_bytes(&emb));
    e.memory.lock().unwrap_or_else(|p| p.into_inner()).insert(key, emb.clone());
    Ok(Some(emb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_ties_go_up_and_bytes_round_trip() {
        assert_eq!(
            [fixed3(0.0625), fixed3(1.0625), fixed3(-0.0625), fixed3(2.0), fixed3(0.1234), fixed3(0.0004)],
            ["0.063", "1.063", "-0.063", "2.000", "0.123", "0.000"]
        );
        let e = Embeddings { dim: 2, data: vec![1.0, -2.5, 0.25, 3.0] };
        assert_eq!(from_bytes(&to_bytes(&e)), Some(e));
        assert_eq!(from_bytes(&[2, 0, 0, 0, 9, 0, 0, 0]), None, "a cut file is not used");
    }
}
