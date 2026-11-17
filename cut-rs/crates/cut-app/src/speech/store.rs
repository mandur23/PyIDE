//! The transcripts (`ui-speech.js`'s `transcripts`, `cached`, `store`): one per media file and recognition setting,
//! in source seconds with the parts of the file recognised so far, kept in memory and in the Cut cache
//! (`cut:cacheGet/Put`, the same entries the JavaScript editor writes), so a file is never recognised twice and edits
//! need no new recognition. Shared by the UI thread and the recognition thread.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use cut_model::Media;
use serde_json::{Value as Json, json};

use super::text::{Word, terms_key};
use crate::files::cache::Cache;

/// What recognition is asked: the model, the language (`auto`, `ko`, `en`), the project's word list, and whether the
/// voice is isolated first.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Opts {
    pub model: String,
    pub language: String,
    pub terms: Vec<String>,
    pub isolate: bool,
}

/// A media file's transcript: the source seconds recognised, the words (seconds), the language heard.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Transcript {
    pub ranges: Vec<(f64, f64)>,
    pub words: Vec<Word>,
    pub language: Option<String>,
}

/// `path|size|mtime`: a file as it is now.
pub fn file_key(m: &Media) -> String {
    file_key_of(&m.path, &m.size, &m.mtime)
}

/// [`file_key`] of a media entry's fields (a file not imported yet).
pub fn file_key_of(path: &str, size: &Json, mtime: &Json) -> String {
    format!("{path}|{}|{}", js_value(size), js_value(mtime))
}

/// A JSON value as the JavaScript's template string writes it.
fn js_value(v: &Json) -> String {
    match v {
        Json::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Json::String(s) => s.clone(),
        Json::Null => "null".into(),
        other => other.to_string(),
    }
}

/// The cache key of a transcript (`keyOf`); v2: transcripts made before the recognition changed are made again.
pub fn key_of(m: &Media, o: &Opts) -> String {
    let terms = if o.terms.is_empty() { String::new() } else { format!("|t{}", terms_key(&o.terms)) };
    format!("speech|v2|{}|{}|{}{terms}{}", file_key(m), o.model, o.language, if o.isolate { "|iv" } else { "" })
}

/// The transcripts of this session and the cache behind them.
#[derive(Default)]
pub struct Store {
    cache: Option<Arc<Cache>>,
    map: HashMap<String, Arc<Transcript>>,
    /// File key -> the key of the transcript made or read last for that file.
    latest: HashMap<String, String>,
    looked: HashSet<String>,
    /// Counts the changes to what is in memory, so the Transcript panel knows when to read the words again.
    generation: u64,
}

impl Store {
    pub fn new(cache: Option<Arc<Cache>>) -> Store {
        Store { cache, ..Store::default() }
    }

    /// The transcript of `key`, read from the cache once.
    pub fn cached(&mut self, key: &str) -> Option<Arc<Transcript>> {
        if let Some(t) = self.map.get(key) {
            return Some(t.clone());
        }
        if !self.looked.insert(key.to_owned()) {
            return None;
        }
        let bytes = self.cache.as_ref()?.get(key)?;
        let t = parse(&bytes)?;
        let t = Arc::new(t);
        self.map.insert(key.to_owned(), t.clone());
        self.generation += 1;
        Some(t)
    }

    /// Keeps a transcript here and in the cache.
    pub fn store(&mut self, key: &str, t: Transcript) {
        if let Some(c) = &self.cache {
            c.put(key, serialize(&t).as_bytes());
        }
        self.looked.insert(key.to_owned());
        self.map.insert(key.to_owned(), Arc::new(t));
        self.generation += 1;
    }

    /// Keeps a transcript in memory only (the empty one recognition starts from).
    pub fn remember(&mut self, key: &str, t: Transcript) {
        self.map.insert(key.to_owned(), Arc::new(t));
        self.generation += 1;
    }

    /// Notes `key` as the last transcript of its file.
    pub fn set_latest(&mut self, file: String, key: String, only_if_none: bool) {
        if !only_if_none || !self.latest.contains_key(&file) {
            self.latest.insert(file, key);
            self.generation += 1;
        }
    }

    /// How many times what is in memory changed.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The vocals of a media file run on its time (`carryTranscripts`): every transcript of `from` in memory (and the
    /// one of these settings on disk) becomes the file `to`'s ([`file_key_of`]) too, unless it has its own, so nothing
    /// is recognised again.
    pub fn carry(&mut self, from: &Media, to: &str, o: &Opts) {
        self.cached(&key_of(from, o));
        let a = format!("speech|v2|{}|", file_key(from));
        let b = format!("speech|v2|{to}|");
        let mut found: Vec<(String, Arc<Transcript>)> = self
            .map
            .iter()
            .filter_map(|(k, t)| k.strip_prefix(&a).map(|rest| (format!("{b}{rest}"), t.clone())))
            .collect();
        found.sort_by(|x, y| x.0.cmp(&y.0));
        for (k, t) in found {
            if !self.map.contains_key(&k) {
                self.store(&k, (*t).clone());
            }
        }
        if let Some(rest) = self.latest.get(&file_key(from)).and_then(|l| l.strip_prefix(&a)).map(str::to_owned) {
            self.set_latest(to.to_owned(), format!("{b}{rest}"), true);
        }
    }

    /// The transcript of a media file for these settings, else the last one made for that file.
    pub fn transcript_of(&self, m: &Media, o: &Opts) -> Option<(String, Arc<Transcript>)> {
        let key = key_of(m, o);
        if let Some(t) = self.map.get(&key) {
            return Some((key, t.clone()));
        }
        let last = self.latest.get(&file_key(m))?;
        self.map.get(last).map(|t| (last.clone(), t.clone()))
    }

    /// Forgets what is in memory (the cache stays).
    pub fn forget(&mut self) {
        self.map.clear();
        self.latest.clear();
        self.looked.clear();
        self.generation += 1;
    }

    /// A word of a media file's transcript corrected or confirmed by the person (`correctWord`): its new text, and
    /// no longer uncertain (p 1). `src` is its index in the transcript of `key`. -> whether it was there.
    pub fn correct(&mut self, key: &str, src: usize, text: &str) -> bool {
        let next: String =
            text.split(cut_model::captionwords::is_space).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
        let Some(t) = self.map.get(key) else { return false };
        if src >= t.words.len() || next.is_empty() {
            return false;
        }
        let mut t = (**t).clone();
        t.words[src].text = next;
        t.words[src].p = Some(1.0);
        self.store(key, t);
        true
    }
}

/// `{v: 1, ranges, language, words: [[t0, t1, text, p?]]}`.
pub fn serialize(t: &Transcript) -> String {
    let words: Vec<Json> = t
        .words
        .iter()
        .map(|w| match w.p {
            Some(p) => json!([w.t0, w.t1, w.text, p]),
            None => json!([w.t0, w.t1, w.text]),
        })
        .collect();
    let ranges: Vec<Json> = t.ranges.iter().map(|(a, b)| json!([a, b])).collect();
    json!({ "v": 1, "ranges": ranges, "language": t.language, "words": words }).to_string()
}

/// A cached transcript, or `None` when it is not one of version 1.
pub fn parse(bytes: &[u8]) -> Option<Transcript> {
    let j: Json = serde_json::from_slice(bytes).ok()?;
    if j.get("v").and_then(Json::as_f64) != Some(1.0) {
        return None;
    }
    let ranges =
        j.get("ranges")?.as_array()?.iter().filter_map(|r| Some((r.get(0)?.as_f64()?, r.get(1)?.as_f64()?))).collect();
    let words = j
        .get("words")?
        .as_array()?
        .iter()
        .filter_map(|w| {
            let a = w.as_array()?;
            let text = a.get(2).map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned)).unwrap_or_default();
            Some(Word::new(a.first()?.as_f64()?, a.get(1)?.as_f64()?, text, a.get(3).and_then(Json::as_f64)))
        })
        .collect();
    let language = j.get("language").and_then(Json::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    Some(Transcript { ranges, words, language })
}
