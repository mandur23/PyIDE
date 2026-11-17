//! A small Vorbis I encoder for test media (this PC has no Vorbis encoder, and none may be downloaded): the three
//! headers and audio packets of a stream built by the specification. One floor 1 with only its two end posts (a flat
//! floor), one residue type 1 coding bins 0..128 in partitions of 16 with a scalar codebook of 512 values, a short
//! mode (256) and a long mode (2048). Each block is windowed and transformed by the MDCT the specification's
//! decoder inverts, its first 128 bins quantized; so a long block keeps up to 3 kHz at 48 kHz, a short one all.

use std::f64::consts::PI;

/// Bits packed from the least significant, as Vorbis packs them.
#[derive(Default)]
struct Bits {
    bytes: Vec<u8>,
    used: u32,
}

impl Bits {
    fn put(&mut self, v: u64, n: u32) {
        for k in 0..n {
            if self.used == 0 {
                self.bytes.push(0);
            }
            let last = self.bytes.len() - 1;
            self.bytes[last] |= (((v >> k) & 1) as u8) << self.used;
            self.used = (self.used + 1) % 8;
        }
    }

    /// A codeword of an equal-length codebook: entry `i`'s `len` bits, the first one read its highest.
    fn word(&mut self, i: u64, len: u32) {
        for k in (0..len).rev() {
            self.put((i >> k) & 1, 1);
        }
    }
}

/// Vorbis' float32: 21-bit mantissa, exponent biased by 788, sign.
fn float32(v: f64) -> u64 {
    let (sign, m) = (u64::from(v < 0.0), v.abs());
    let e = m.log2().floor() as i64;
    let mantissa = (m * 2f64.powi((20 - e) as i32)).round() as u64;
    (sign << 31) | (((e - 20 + 788) as u64) << 21) | mantissa
}

const SHORT: usize = 256;
const LONG: usize = 2048;
const BINS: usize = 128;
/// The floor's post value for every block: `FLOOR1_INVERSE_DB_TABLE[149]`, the step of one residue unit.
const POST: u64 = 149;
const STEP: f64 = 0.0012634633;
const VALUES: i64 = 512;

fn header(kind: u8) -> Vec<u8> {
    let mut h = vec![kind];
    h.extend(b"vorbis");
    h
}

fn ident(channels: u8, rate: u32) -> Vec<u8> {
    let mut h = header(1);
    h.extend(0u32.to_le_bytes());
    h.push(channels);
    h.extend(rate.to_le_bytes());
    h.extend([0u8; 12]);
    h.push(8 | (11 << 4));
    h.push(1);
    h
}

fn comment() -> Vec<u8> {
    let mut h = header(3);
    h.extend(0u32.to_le_bytes());
    h.extend(0u32.to_le_bytes());
    h.push(1);
    h
}

fn setup() -> Vec<u8> {
    let mut b = Bits { bytes: header(5), used: 0 };
    b.put(1, 8);
    // codebook 0: the residue's classes (one class, dimension 1, two entries of one bit)
    b.put(0x56_4342, 24);
    b.put(1, 16);
    b.put(2, 24);
    b.put(0, 2);
    b.put(0, 5);
    b.put(0, 5);
    b.put(0, 4);
    // codebook 1: 512 entries of 9 bits, values entry - 256
    b.put(0x56_4342, 24);
    b.put(1, 16);
    b.put(VALUES as u64, 24);
    b.put(0, 2);
    for _ in 0..VALUES {
        b.put(8, 5);
    }
    b.put(1, 4);
    b.put(float32(-(VALUES as f64) / 2.0), 32);
    b.put(float32(1.0), 32);
    b.put(8, 4);
    b.put(0, 1);
    for v in 0..VALUES {
        b.put(v as u64, 9);
    }
    // time domain transforms: one placeholder
    b.put(0, 6);
    b.put(0, 16);
    // floor 1: no partitions, multiplier 1, posts at 0 and 128
    b.put(0, 6);
    b.put(1, 16);
    b.put(0, 5);
    b.put(0, 2);
    b.put(7, 4);
    // residue type 1: bins 0..128, partitions of 16, one class with book 1 in pass 0, classbook 0
    b.put(0, 6);
    b.put(1, 16);
    b.put(0, 24);
    b.put(BINS as u64, 24);
    b.put(15, 24);
    b.put(0, 6);
    b.put(0, 8);
    b.put(1, 3);
    b.put(0, 1);
    b.put(1, 8);
    // mapping 0: one submap, no coupling
    b.put(0, 6);
    b.put(0, 16);
    b.put(0, 1);
    b.put(0, 1);
    b.put(0, 2);
    b.put(0, 8);
    b.put(0, 8);
    b.put(0, 8);
    // modes: short, long
    b.put(1, 6);
    for long in [0, 1] {
        b.put(long, 1);
        b.put(0, 16);
        b.put(0, 16);
        b.put(0, 8);
    }
    b.put(1, 1);
    b.bytes
}

/// The three headers Xiph-laced, as Matroska's CodecPrivate carries them.
pub fn private(channels: u8, rate: u32) -> Vec<u8> {
    let (id, c, s) = (ident(channels, rate), comment(), setup());
    let mut out = vec![2];
    for len in [id.len(), c.len()] {
        out.extend(std::iter::repeat_n(255, len / 255));
        out.push((len % 255) as u8);
    }
    out.extend(id);
    out.extend(c);
    out.extend(s);
    out
}

/// The window of a block of `n` between neighbours of `prev` and `next` size (specification 1.3.2).
fn window(n: usize, prev: usize, next: usize) -> Vec<f64> {
    let side = |neighbour: usize| if n == LONG && neighbour == SHORT { SHORT } else { n };
    let (lw, rw) = (side(prev), side(next));
    let (ls, rs) = (n / 4 - lw / 4, 3 * n / 4 - rw / 4);
    let slope = |i: usize, w: usize| ((((i as f64 + 0.5) / (w / 2) as f64) * PI / 2.0).sin().powi(2) * PI / 2.0).sin();
    (0..n)
        .map(|i| {
            if i < ls {
                0.0
            } else if i < ls + lw / 2 {
                slope(i - ls, lw)
            } else if i < rs {
                1.0
            } else if i < rs + rw / 2 {
                slope(rs + rw / 2 - 1 - i, rw)
            } else {
                0.0
            }
        })
        .collect()
}

/// An encoded stream: its packets, each with the sample its finished output starts at (`None` for the first, which
/// gives none), and the samples coded.
pub struct Stream {
    pub packets: Vec<(Vec<u8>, Option<i64>)>,
    pub length: i64,
}

/// `channels(c, t)` (sample `t` of channel `c`, 0 outside the signal) coded in blocks of the given sizes, in Vorbis'
/// channel order. Packet `m` gives samples `[c[m-1], c[m])`, where each block's centre is `c[m-1] + prev/4 + n/4`.
pub fn encode(channels: u8, sizes: &[usize], signal: impl Fn(usize, i64) -> f64) -> Stream {
    let mut centre = 0i64;
    let mut centres = Vec::with_capacity(sizes.len());
    for (m, &n) in sizes.iter().enumerate() {
        if m > 0 {
            centre += (sizes[m - 1] / 4 + n / 4) as i64;
        }
        centres.push(centre);
    }
    let length = *centres.last().unwrap_or(&0);
    let packets = sizes
        .iter()
        .enumerate()
        .map(|(m, &n)| {
            let prev = if m > 0 { sizes[m - 1] } else { n };
            let next = sizes.get(m + 1).copied().unwrap_or(n);
            let w = window(n, prev, next);
            let start = centres[m] - (n / 2) as i64;
            let mut b = Bits::default();
            b.put(0, 1);
            b.put(u64::from(n == LONG), 1);
            if n == LONG {
                b.put(u64::from(prev == LONG), 1);
                b.put(u64::from(next == LONG), 1);
            }
            let x = |c: usize, i: usize| {
                let t = start + i as i64;
                if (0..length).contains(&t) { signal(c, t) * w[i] } else { 0.0 }
            };
            let mut bins = vec![[0i64; BINS]; usize::from(channels)];
            for (c, q) in bins.iter_mut().enumerate() {
                let samples: Vec<f64> = (0..n).map(|i| x(c, i)).collect();
                for (k, v) in q.iter_mut().enumerate() {
                    let sum: f64 = samples
                        .iter()
                        .enumerate()
                        .map(|(i, s)| {
                            s * (2.0 * PI / n as f64 * (i as f64 + 0.5 + n as f64 / 4.0) * (k as f64 + 0.5)).cos()
                        })
                        .sum();
                    let coef = sum * 4.0 / n as f64;
                    *v = ((coef / STEP).round() as i64).clamp(-VALUES / 2, VALUES / 2 - 1);
                }
                b.put(1, 1);
                b.put(POST, 8);
                b.put(POST, 8);
            }
            for p in 0..BINS / 16 {
                for _ in 0..channels {
                    b.word(0, 1);
                }
                for q in &bins {
                    for v in &q[p * 16..p * 16 + 16] {
                        b.word((v + VALUES / 2) as u64, 9);
                    }
                }
            }
            (b.bytes, (m > 0).then(|| centres[m - 1]))
        })
        .collect();
    Stream { packets, length }
}

/// Block sizes long, long, then shorts and longs mixed, `blocks` in all.
pub fn sizes(blocks: usize) -> Vec<usize> {
    (0..blocks).map(|m| if (m / 6) % 3 == 1 && m % 6 != 0 { SHORT } else { LONG }).collect()
}
