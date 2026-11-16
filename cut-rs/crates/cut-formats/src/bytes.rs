//! Byte helpers the readers and the writer share: fixed-width numbers read from a slice, and a growable big-endian
//! writer with ISO BMFF box helpers.
//!
//! A read past the end of the slice gives 0 for the missing bytes, as the JavaScript's `b[i] << 8` does with
//! `undefined`, so a damaged length never panics and reads the same values as the editor it ports.

/// The byte at `i`, 0 past the end.
#[inline]
pub fn byte(b: &[u8], i: usize) -> u8 {
    b.get(i).copied().unwrap_or(0)
}

/// Big-endian numbers at `i`.
#[inline]
pub fn u16(b: &[u8], i: usize) -> u16 {
    u16::from_be_bytes([byte(b, i), byte(b, i.saturating_add(1))])
}

#[inline]
pub fn u24(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([0, byte(b, i), byte(b, i.saturating_add(1)), byte(b, i.saturating_add(2))])
}

#[inline]
pub fn u32(b: &[u8], i: usize) -> u32 {
    if let Some(s) = i.checked_add(4).and_then(|end| b.get(i..end)) {
        return u32::from_be_bytes([s[0], s[1], s[2], s[3]]);
    }
    u32::from_be_bytes([0, 1, 2, 3].map(|k| byte(b, i.saturating_add(k))))
}

#[inline]
pub fn i32(b: &[u8], i: usize) -> i32 {
    u32(b, i) as i32
}

#[inline]
pub fn u64(b: &[u8], i: usize) -> u64 {
    (u64::from(u32(b, i)) << 32) | u64::from(u32(b, i.saturating_add(4)))
}

/// Little-endian numbers at `i`.
#[inline]
pub fn le16(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([byte(b, i), byte(b, i.saturating_add(1))])
}

#[inline]
pub fn le32(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([0, 1, 2, 3].map(|k| byte(b, i.saturating_add(k))))
}

#[inline]
pub fn le64(b: &[u8], i: usize) -> u64 {
    u64::from(le32(b, i)) | (u64::from(le32(b, i.saturating_add(4))) << 32)
}

/// Four bytes at `i` as a box or chunk type (missing bytes are 0).
#[inline]
pub fn fourcc(b: &[u8], i: usize) -> [u8; 4] {
    [0, 1, 2, 3].map(|k| byte(b, i.saturating_add(k)))
}

/// Whether the bytes at `i` are exactly `s` (all of them inside `b`).
#[inline]
pub fn starts(b: &[u8], i: usize, s: &[u8]) -> bool {
    i.checked_add(s.len()).and_then(|end| b.get(i..end)) == Some(s)
}

/// Bytes as text, one character a byte (the JavaScript's `String.fromCharCode` of each).
pub fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| char::from(c)).collect()
}

/// A growable big-endian byte buffer with ISO BMFF box helpers. The number methods take what JavaScript's `>>>`
/// and `&` would: the low bits of the value.
#[derive(Debug, Default, Clone)]
pub struct ByteWriter {
    pub buf: Vec<u8>,
}

impl ByteWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(n: usize) -> Self {
        Self { buf: Vec::with_capacity(n) }
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// The low bits of `v`, big-endian, as JavaScript's `& 255` and `>>>` keep them.
    pub fn u8(&mut self, v: i64) -> &mut Self {
        self.buf.push(v as u8);
        self
    }

    pub fn u16(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&(v as u16).to_be_bytes());
        self
    }

    pub fn u24(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&(v as u32).to_be_bytes()[1..]);
        self
    }

    pub fn u32(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&(v as u32).to_be_bytes());
        self
    }

    pub fn u64(&mut self, v: i64) -> &mut Self {
        self.u32(v.div_euclid(1 << 32)).u32(v)
    }

    /// Raw bytes.
    pub fn bytes(&mut self, a: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(a);
        self
    }

    /// A type or a name, one byte a character.
    pub fn str(&mut self, s: &str) -> &mut Self {
        self.buf.extend_from_slice(s.as_bytes());
        self
    }

    /// `n` zero bytes.
    pub fn zeros(&mut self, n: usize) -> &mut Self {
        self.buf.resize(self.buf.len() + n, 0);
        self
    }

    /// A box: its 32-bit size, the type, and what `body` writes.
    pub fn bx(&mut self, kind: &str, body: impl FnOnce(&mut Self)) -> &mut Self {
        let at = self.buf.len();
        self.u32(0).str(kind);
        body(self);
        let size = (self.buf.len() - at) as u32;
        self.buf[at..at + 4].copy_from_slice(&size.to_be_bytes());
        self
    }

    /// A full box: a box whose body starts with a version byte and 24 bits of flags.
    pub fn full(&mut self, kind: &str, version: u8, flags: u32, body: impl FnOnce(&mut Self)) -> &mut Self {
        self.bx(kind, |w| {
            w.u8(version.into()).u24(flags.into());
            body(w);
        })
    }

    /// The bytes written.
    pub fn done(self) -> Vec<u8> {
        self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_past_the_end_give_zeros() {
        let b = [0x12, 0x34, 0x56];
        assert_eq!(u32(&b, 0), 0x1234_5600);
        assert_eq!(u16(&b, 2), 0x5600);
        assert_eq!(u32(&b, usize::MAX), 0);
        assert_eq!(le32(&b, 1), 0x5634);
        assert_eq!(fourcc(b"ab", 0), [b'a', b'b', 0, 0]);
        assert!(starts(b"ftypisom", 4, b"isom") && !starts(b"ftypiso", 4, b"isom"));
    }

    #[test]
    fn boxes_carry_their_size_and_numbers_wrap() {
        let mut w = ByteWriter::new();
        w.full("tkhd", 1, 3, |w| {
            w.u32(-1).u64(0x1_0000_0002).u16(0x12345);
        });
        assert_eq!(
            w.done(),
            [0, 0, 0, 26, b't', b'k', b'h', b'd', 1, 0, 0, 3, 255, 255, 255, 255, 0, 0, 0, 1, 0, 0, 0, 2, 0x23, 0x45]
        );
    }
}
