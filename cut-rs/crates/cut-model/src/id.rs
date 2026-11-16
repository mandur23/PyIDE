//! Ids as small copyable values. Every id of a project file is a string (`c12`, `V1`, `L3`, `m2`); the model holds
//! it as an index into one table of the names seen, so comparing, hashing and copying an id costs what a `u32` does.

use std::collections::HashMap;
use std::fmt;
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// An id of the project: a clip, track, media, sequence, bin, link, group, transition, marker, caption, effect or mask.
///
/// Its order is the order names were first seen, not the order of the text.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Id(u32);

#[derive(Default)]
struct Table {
    names: Vec<&'static str>,
    ids: HashMap<&'static str, u32>,
}

fn table() -> &'static RwLock<Table> {
    static TABLE: OnceLock<RwLock<Table>> = OnceLock::new();
    TABLE.get_or_init(Default::default)
}

impl Id {
    /// The id named `name`. Names live as long as the program (an editor sees a bounded set of them).
    pub fn new(name: &str) -> Self {
        if let Some(&n) = table().read().unwrap_or_else(|e| e.into_inner()).ids.get(name) {
            return Self(n);
        }
        let mut t = table().write().unwrap_or_else(|e| e.into_inner());
        if let Some(&n) = t.ids.get(name) {
            return Self(n);
        }
        let n = u32::try_from(t.names.len()).expect("fewer than 4 billion distinct ids");
        let name: &'static str = Box::leak(name.to_owned().into_boxed_str());
        t.names.push(name);
        t.ids.insert(name, n);
        Self(n)
    }

    /// `prefix` followed by `n`, as `newId` makes them (`c12`).
    pub fn numbered(prefix: &str, n: i64) -> Self {
        Self::new(&format!("{prefix}{n}"))
    }

    pub fn as_str(self) -> &'static str {
        table().read().unwrap_or_else(|e| e.into_inner()).names[self.0 as usize]
    }

    /// The number of an id made of letters and digits (`c12` -> 12), as the JavaScript's `ID_RE` reads it.
    pub fn number(self) -> Option<i64> {
        let s = self.as_str();
        let digits = s.trim_start_matches(|c: char| c.is_ascii_alphabetic());
        let letters = s.len() - digits.len();
        (letters > 0 && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
            .then(|| digits.parse::<f64>().map(|x| x as i64).unwrap_or(i64::MAX))
    }
}

impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<&str> for Id {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = Id;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an id string")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Id, E> {
                Ok(Id::new(v))
            }
        }
        d.deserialize_str(V)
    }
}

/// A hasher for maps keyed by ids (a `u32` each): one multiply instead of SipHash. Ids are no input an attacker
/// picks keys for.
#[derive(Default, Clone, Copy)]
pub(crate) struct IdHasher(u64);

impl std::hash::Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.write_u64(u64::from(*b));
        }
    }
    fn write_u32(&mut self, n: u32) {
        self.write_u64(u64::from(n));
    }
    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_usize(&mut self, n: usize) {
        self.write_u64(n as u64);
    }
}

/// A map keyed by ids (or tuples of them) with [`IdHasher`].
pub(crate) type IdMap<K, V> = HashMap<K, V, std::hash::BuildHasherDefault<IdHasher>>;
/// A set of ids with [`IdHasher`].
pub(crate) type IdSet<K> = std::collections::HashSet<K, std::hash::BuildHasherDefault<IdHasher>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_name_is_the_same_id() {
        assert_eq!(Id::new("c1"), Id::new("c1"));
        assert_ne!(Id::new("c1"), Id::new("c2"));
        assert_eq!(Id::new("V12").as_str(), "V12");
        assert_eq!(Id::new("cap7").number(), Some(7));
        assert_eq!(Id::new("lut-0a").number(), None);
        assert_eq!(Id::new("7").number(), None);
    }
}
