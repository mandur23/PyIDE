//! Bits, most significant first: the reader with the Exp-Golomb codes of H.264 and HEVC, the writer, and emulation
//! prevention.

use crate::error::{Result, damaged};

/// Reads bits from a byte slice; running out is a `damaged` error, as a codec header cut short is.
pub struct BitReader<'a> {
    b: &'a [u8],
    pos: u64,
    end: u64,
}

impl<'a> BitReader<'a> {
    /// Starts at byte `start`.
    pub fn new(b: &'a [u8], start: usize) -> Self {
        Self { b, pos: start as u64 * 8, end: b.len() as u64 * 8 }
    }

    /// One bit.
    pub fn bit(&mut self) -> Result<u64> {
        if self.pos >= self.end {
            return damaged("a codec header ends early");
        }
        let v = (self.b[(self.pos >> 3) as usize] >> (7 - (self.pos & 7))) & 1;
        self.pos += 1;
        Ok(v.into())
    }

    /// One bit as a flag.
    pub fn flag(&mut self) -> Result<bool> {
        Ok(self.bit()? == 1)
    }

    /// `n` bits as a number (more than 64 keep the low 64).
    pub fn u(&mut self, n: u64) -> Result<u64> {
        let mut v: u64 = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Ok(v)
    }

    /// Skips `n` bits.
    pub fn skip(&mut self, n: u64) -> Result<()> {
        self.pos = self.pos.saturating_add(n);
        if self.pos > self.end {
            return damaged("a codec header ends early");
        }
        Ok(())
    }

    /// An unsigned Exp-Golomb code.
    pub fn ue(&mut self) -> Result<u64> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return damaged("a codec header has a bad number");
            }
        }
        Ok(if zeros == 0 { 0 } else { (1 << zeros) - 1 + self.u(zeros)? })
    }

    /// A signed Exp-Golomb code.
    pub fn se(&mut self) -> Result<i64> {
        let k = self.ue()? as i64;
        Ok(if k & 1 == 1 { (k + 1) / 2 } else { -k / 2 })
    }

    /// Bits not read yet.
    pub fn left(&self) -> u64 {
        self.end.saturating_sub(self.pos)
    }

    /// The position, in bits from the start of the slice.
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// The next 32 bits without reading them, zeros past the end (for codes decoded from a window of bits).
    pub fn peek32(&self) -> u32 {
        let at = (self.pos >> 3) as usize;
        let mut w = [0u8; 8];
        if let Some(rest) = self.b.get(at..) {
            let n = rest.len().min(8);
            w[..n].copy_from_slice(&rest[..n]);
        }
        ((u64::from_be_bytes(w) << (self.pos & 7)) >> 32) as u32
    }

    /// `n` bits (at most 32) read at once; running out is a `damaged` error.
    pub fn u32(&mut self, n: u32) -> Result<u32> {
        if n == 0 {
            return Ok(0);
        }
        let v = self.peek32() >> (32 - n.min(32));
        self.skip(n.into())?;
        Ok(v)
    }

    /// Moves to the next byte boundary (stays on one).
    pub fn align(&mut self) {
        self.pos = self.pos.div_ceil(8) * 8;
    }
}

/// Writes bits, most significant first; `done` pads the last byte with zeros.
#[derive(Default)]
pub struct BitWriter {
    bytes: Vec<u8>,
    cur: u8,
    n: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    /// The low `bits` bits of `v` (two's complement for negative values, as JavaScript's `Math.floor(v / 2 ** i) & 1`).
    pub fn put(&mut self, v: i64, bits: u32) -> &mut Self {
        for i in (0..bits).rev() {
            let bit = if i >= 64 { u8::from(v < 0) } else { ((v >> i) & 1) as u8 };
            self.cur = (self.cur << 1) | bit;
            self.n += 1;
            if self.n == 8 {
                self.bytes.push(self.cur);
                self.cur = 0;
                self.n = 0;
            }
        }
        self
    }

    /// The bytes written, the last one padded with zeros.
    pub fn done(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.bytes.push(self.cur << (8 - self.n));
        }
        self.bytes
    }
}

/// A NAL unit's payload without its emulation prevention bytes (`00 00 03` -> `00 00`).
pub fn unescape_rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &v in nal {
        if zeros >= 2 && v == 3 {
            zeros = 0;
            continue;
        }
        out.push(v);
        zeros = if v == 0 { zeros + 1 } else { 0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exp_golomb_round_trip() {
        let mut w = BitWriter::new();
        // ue(0) = 1, ue(3) = 00100, se(-2) = ue(4) = 00101, then 3 bits of 5.
        w.put(1, 1).put(0b00100, 5).put(0b00101, 5).put(5, 3);
        let b = w.done();
        let mut r = BitReader::new(&b, 0);
        assert_eq!(r.ue().unwrap(), 0);
        assert_eq!(r.ue().unwrap(), 3);
        assert_eq!(r.se().unwrap(), -2);
        assert_eq!(r.u(3).unwrap(), 5);
        assert_eq!(r.left(), 2);
        assert!(r.u(3).is_err());
    }

    #[test]
    fn emulation_prevention_bytes_are_removed() {
        assert_eq!(unescape_rbsp(&[0, 0, 3, 1, 5, 0, 0, 3, 0, 0, 3]), [0, 0, 1, 5, 0, 0, 0, 0]);
    }
}
