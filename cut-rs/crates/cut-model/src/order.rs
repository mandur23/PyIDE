//! The file order of a sequence's clips as a list of chunks: inserting, removing and finding a clip's place cost a
//! walk over the chunks and a move inside one, not a move of the whole list (10,000 clips are some 80 chunks).

use crate::id::Id;

const MAX: usize = 128;

#[derive(Debug, Clone, Default)]
struct Chunk {
    key: u32,
    ids: Vec<Id>,
}

/// Ids in an order, with the place of each found quickly.
#[derive(Debug, Clone, Default)]
pub(crate) struct Order {
    chunks: Vec<Chunk>,
    /// Id -> the key of its chunk.
    at: crate::id::IdMap<Id, u32>,
    next_key: u32,
    len: usize,
}

impl Order {
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn iter(&self) -> impl Iterator<Item = &Id> + Clone {
        self.chunks.iter().flat_map(|c| c.ids.iter())
    }

    fn chunk_of(&self, id: Id) -> Option<usize> {
        let key = *self.at.get(&id)?;
        self.chunks.iter().position(|c| c.key == key)
    }

    /// The place of `id` in the order.
    pub fn position(&self, id: Id) -> Option<usize> {
        let ci = self.chunk_of(id)?;
        let before: usize = self.chunks[..ci].iter().map(|c| c.ids.len()).sum();
        Some(before + self.chunks[ci].ids.iter().position(|x| *x == id)?)
    }

    pub fn get(&self, mut pos: usize) -> Option<Id> {
        for c in &self.chunks {
            if pos < c.ids.len() {
                return Some(c.ids[pos]);
            }
            pos -= c.ids.len();
        }
        None
    }

    /// Puts `id` at `pos` (the end when past it).
    pub fn insert(&mut self, pos: usize, id: Id) {
        let mut rest = pos.min(self.len);
        let mut ci = self.chunks.len();
        for (i, c) in self.chunks.iter().enumerate() {
            if rest <= c.ids.len() {
                ci = i;
                break;
            }
            rest -= c.ids.len();
        }
        if ci == self.chunks.len() {
            if let Some(last) = self.chunks.last().filter(|c| c.ids.len() < MAX) {
                ci = self.chunks.len() - 1;
                rest = last.ids.len();
            } else {
                self.chunks.push(Chunk { key: self.next_key, ids: Vec::with_capacity(MAX) });
                self.next_key += 1;
                rest = 0;
            }
        }
        self.chunks[ci].ids.insert(rest, id);
        self.at.insert(id, self.chunks[ci].key);
        self.len += 1;
        if self.chunks[ci].ids.len() > MAX {
            let tail = self.chunks[ci].ids.split_off(MAX / 2);
            let key = self.next_key;
            self.next_key += 1;
            for x in &tail {
                self.at.insert(*x, key);
            }
            self.chunks.insert(ci + 1, Chunk { key, ids: tail });
        }
    }

    /// Takes `id` out; -> where it was.
    pub fn remove(&mut self, id: Id) -> Option<usize> {
        let pos = self.position(id)?;
        let ci = self.chunk_of(id).expect("a placed id has a chunk");
        let c = &mut self.chunks[ci];
        let i = c.ids.iter().position(|x| *x == id).expect("in its chunk");
        c.ids.remove(i);
        if c.ids.is_empty() {
            self.chunks.remove(ci);
        }
        self.at.remove(&id);
        self.len -= 1;
        Some(pos)
    }

    /// The order as one list.
    pub fn to_vec(&self) -> Vec<Id> {
        self.iter().copied().collect()
    }
}
