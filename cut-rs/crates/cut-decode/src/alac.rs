//! Apple Lossless (ALAC) in Rust: the frames of an `alac` track into samples, after Apple's reference decoder
//! (`ALACDecoder.cpp`, `ag_dec.c`, `dp_dec.c`, `matrix_dec.c`, Apache 2.0). Windows lists Microsoft's ALAC decoder
//! too; this one keeps the sound of such a file independent of what the PC has installed.
//!
//! A frame is a run of elements (a mono SCE or LFE, a stereo CPE, data and fill elements skipped) up to END. Each
//! channel is adaptive-Golomb coded prediction residue run through an adaptive FIR predictor; a pair may be mixed
//! (mid/side-like, `mixBits`/`mixRes`), and samples deeper than 16 bits carry their low bytes uncompressed.

use cut_formats::bits::BitReader;

use crate::error::{DecodeError, Result};

/// The decoder's setup (`ALACSpecificConfig`, the track's magic cookie).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlacConfig {
    pub frame_length: u32,
    pub bit_depth: u8,
    pb: u8,
    mb: u8,
    kb: u8,
    pub channels: u8,
    pub sample_rate: u32,
}

fn damaged(what: &str) -> DecodeError {
    DecodeError::Damaged(format!("ALAC: {what}"))
}

impl AlacConfig {
    /// Reads the 24-byte config from a magic cookie: bare, inside an `alac` atom, or after a `frma` atom as well.
    pub fn parse(cookie: &[u8]) -> Result<Self> {
        let mut b = cookie;
        if b.len() >= 12 && &b[4..8] == b"frma" {
            b = &b[12..];
        }
        if b.len() >= 12 && &b[4..8] == b"alac" {
            b = &b[12..];
        }
        if b.len() < 24 {
            return Err(damaged("the config is cut short"));
        }
        let u32_at = |p: usize| u32::from_be_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]);
        let c = Self {
            frame_length: u32_at(0),
            bit_depth: b[5],
            pb: b[6],
            mb: b[7],
            kb: b[8],
            channels: b[9],
            sample_rate: u32_at(20),
        };
        if !matches!(c.bit_depth, 16 | 20 | 24 | 32) || c.channels == 0 || c.channels > 8 {
            return Err(damaged("an unknown bit depth or channel count"));
        }
        if c.frame_length == 0 || c.frame_length > 1 << 16 || c.kb > 23 {
            return Err(damaged("a frame length or Golomb setting out of range"));
        }
        Ok(c)
    }
}

const QBSHIFT: u32 = 9;
const QB: u32 = 1 << QBSHIFT;
const MMULSHIFT: u32 = 2;
const MDENSHIFT: u32 = QBSHIFT - MMULSHIFT - 1;
const MOFF: u32 = 1 << (MDENSHIFT - 2);
const BITOFF: u32 = 24;
const MAX_PREFIX: u32 = 9;
const MEAN_CLAMP: u32 = 0xffff;

/// One adaptive-Golomb code: a unary prefix of ones, then `k` bits; `escape` bits verbatim after 9 ones.
fn golomb(r: &mut BitReader<'_>, m: u32, k: u32, escape: u32) -> Result<u32> {
    let w = r.peek32();
    let pre = (!w).leading_zeros();
    if pre >= MAX_PREFIX {
        r.skip(MAX_PREFIX.into())?;
        return Ok(r.u32(escape)?);
    }
    let v = (w << (pre + 1)).checked_shr(32 - k).unwrap_or(0);
    let mut n = pre * m;
    if v >= 2 {
        n += v - 1;
        r.skip(u64::from(pre + 1 + k))?;
    } else {
        r.skip(u64::from(pre + k))?;
    }
    Ok(n)
}

/// `ag_dec.c` `dyn_decomp`: `out.len()` residues of a channel of `bits` bits.
fn residues(r: &mut BitReader<'_>, out: &mut [i32], pb: u32, mb0: u32, kb: u32, bits: u32) -> Result<()> {
    let wb = (1u32 << kb).wrapping_sub(1);
    let n_all = out.len();
    let (mut mb, mut zmode, mut c) = (mb0, 0u32, 0usize);
    while c < n_all {
        if r.left() == 0 {
            return Err(damaged("the residues run past the frame"));
        }
        let m = mb >> QBSHIFT;
        let k = (31 - (m + 3).leading_zeros()).min(kb);
        let n = golomb(r, (1 << k) - 1, k, bits)?;
        let nd = n.wrapping_add(zmode);
        let del = (nd.wrapping_add(1) >> 1) as i32;
        out[c] = if nd & 1 == 1 { del.wrapping_neg() } else { del };
        c += 1;
        mb = pb.wrapping_mul(nd).wrapping_add(mb).wrapping_sub(pb.wrapping_mul(mb) >> QBSHIFT);
        if n > MEAN_CLAMP {
            mb = MEAN_CLAMP;
        }
        zmode = 0;
        if (mb << MMULSHIFT) < QB && c < n_all {
            zmode = 1;
            let k = mb.leading_zeros() - BITOFF + ((mb + MOFF) >> MDENSHIFT);
            let mz = ((1u32 << k) - 1) & wb;
            let run = golomb(r, mz, k, 16)? as usize;
            if c + run > n_all {
                return Err(damaged("a run of zeros past the frame"));
            }
            out[c..c + run].fill(0);
            c += run;
            if run >= 65535 {
                zmode = 0;
            }
            mb = 0;
        }
    }
    Ok(())
}

fn sign(v: i32) -> i32 {
    v.signum()
}

/// `dp_dec.c` `unpc_block`: the predictor run over residues `pc` into `out`, `coefs` adapting as it goes.
fn predict(pc: &[i32], out: &mut [i32], coefs: &mut [i16], active: usize, chan_bits: u32, den_shift: u32) {
    let num = pc.len();
    if num == 0 {
        return;
    }
    let shift = 32 - chan_bits;
    let wrap = |v: i32| v.wrapping_shl(shift).wrapping_shr(shift);
    out[0] = pc[0];
    if active == 0 {
        out[1..num].copy_from_slice(&pc[1..num]);
        return;
    }
    if active == 31 {
        for j in 1..num {
            out[j] = wrap(pc[j].wrapping_add(out[j - 1]));
        }
        return;
    }
    let lim = (active + 1).min(num);
    for j in 1..lim {
        out[j] = wrap(pc[j].wrapping_add(out[j - 1]));
    }
    let den_half = if den_shift == 0 { 0 } else { 1i32 << (den_shift - 1) };
    let den = den_shift.min(31);
    for j in lim..num {
        let top = out[j - active - 1];
        let mut sum = 0i32;
        for (k, &c) in coefs.iter().enumerate().take(active) {
            sum = sum.wrapping_add(i32::from(c).wrapping_mul(out[j - 1 - k].wrapping_sub(top)));
        }
        let mut del0 = pc[j];
        let sg = sign(del0);
        out[j] = wrap(del0.wrapping_add(top).wrapping_add(sum.wrapping_add(den_half) >> den));
        if sg != 0 {
            for k in (0..active).rev() {
                let dd = top.wrapping_sub(out[j - 1 - k]);
                let sgn = sign(dd) * sg;
                coefs[k] = coefs[k].wrapping_sub(sgn as i16);
                del0 = del0.wrapping_sub(((active - k) as i32).wrapping_mul(sgn.wrapping_mul(dd) >> den));
                if (sg > 0 && del0 <= 0) || (sg < 0 && del0 >= 0) {
                    break;
                }
            }
        }
    }
}

/// One channel's compressed header and coefficients.
struct Channel {
    mode: u32,
    den_shift: u32,
    pb_factor: u32,
    coefs: [i16; 32],
    active: usize,
}

fn channel_header(r: &mut BitReader<'_>) -> Result<Channel> {
    let h = r.u32(8)?;
    let (mode, den_shift) = (h >> 4, h & 15);
    let h = r.u32(8)?;
    let (pb_factor, active) = (h >> 5, (h & 31) as usize);
    let mut coefs = [0i16; 32];
    for c in coefs.iter_mut().take(active) {
        *c = r.u32(16)? as u16 as i16;
    }
    Ok(Channel { mode, den_shift, pb_factor, coefs, active })
}

/// Decodes an `alac` track's frames, keeping the buffers between frames.
pub struct AlacDecoder {
    config: AlacConfig,
    residue: Vec<i32>,
    mixed: [Vec<i32>; 2],
    low: Vec<u32>,
}

impl AlacDecoder {
    pub fn new(config: AlacConfig) -> Self {
        let n = config.frame_length as usize;
        Self { config, residue: vec![0; n], mixed: [vec![0; n], vec![0; n]], low: vec![0; n * 2] }
    }

    pub fn config(&self) -> &AlacConfig {
        &self.config
    }

    /// One frame (one sample of the track) as float planes, one a channel, full scale at 1.0.
    pub fn decode(&mut self, frame: &[u8]) -> Result<Vec<Vec<f32>>> {
        let cfg = self.config;
        let channels = usize::from(cfg.channels);
        let mut planes: Vec<Vec<f32>> = Vec::with_capacity(channels);
        let mut r = BitReader::new(frame, 0);
        let scale = 1.0 / (1u64 << (cfg.bit_depth - 1)) as f32;
        let mut frame_samples: Option<usize> = None;
        while planes.len() < channels {
            let tag = r.u32(3)?;
            match tag {
                0 | 3 | 1 => {
                    let pair = tag == 1;
                    if planes.len() + 1 + usize::from(pair) > channels {
                        return Err(damaged("more channels than the config says"));
                    }
                    let n = self.element(frame, &mut r, pair)?;
                    if frame_samples.is_some_and(|f| f != n) {
                        return Err(damaged("elements of different lengths"));
                    }
                    frame_samples = Some(n);
                    for c in 0..1 + usize::from(pair) {
                        planes.push(self.mixed[c][..n].iter().map(|&v| v as f32 * scale).collect());
                    }
                }
                4 => {
                    r.skip(4)?;
                    let aligned = r.u32(1)? == 1;
                    let mut count = r.u32(8)?;
                    if count == 255 {
                        count += r.u32(8)?;
                    }
                    if aligned {
                        r.align();
                    }
                    r.skip(u64::from(count) * 8)?;
                }
                6 => {
                    let mut count = r.u32(4)?;
                    if count == 15 {
                        count = count + r.u32(8)? - 1;
                    }
                    r.skip(u64::from(count) * 8)?;
                }
                7 => break,
                _ => return Err(damaged("an element this decoder does not know")),
            }
        }
        if planes.len() < channels {
            return Err(damaged("the frame ends before every channel"));
        }
        Ok(planes)
    }

    /// One SCE/LFE (`pair` false) or CPE into `mixed[0]` (and `[1]`), as samples of the config's bit depth; the
    /// number of samples.
    fn element(&mut self, frame: &[u8], r: &mut BitReader<'_>, pair: bool) -> Result<usize> {
        let cfg = self.config;
        r.skip(4)?;
        if r.u32(12)? != 0 {
            return Err(damaged("a header's unused bits are set"));
        }
        let h = r.u32(4)?;
        let (partial, shifted, escape) = (h >> 3 == 1, (h >> 1) & 3, h & 1 == 1);
        if shifted == 3 {
            return Err(damaged("a bad byte shift"));
        }
        let mut n = cfg.frame_length as usize;
        if partial {
            n = ((r.u32(16)? << 16) | r.u32(16)?) as usize;
            if n == 0 || n > cfg.frame_length as usize {
                return Err(damaged("a frame longer than the config's"));
            }
        }
        let depth = u32::from(cfg.bit_depth);
        let chan_bits = depth - shifted * 8 + u32::from(pair);
        let lanes = 1 + usize::from(pair);
        let (mut mix_bits, mut mix_res) = (0u32, 0i32);
        let mut shift_bytes = shifted;
        if !escape {
            mix_bits = r.u32(8)?;
            mix_res = i32::from(r.u32(8)? as u8 as i8);
            let mut heads = vec![channel_header(r)?];
            if pair {
                heads.push(channel_header(r)?);
            }
            let low_at = r.position();
            r.skip(u64::from(shifted * 8) * (n * lanes) as u64)?;
            for (c, head) in heads.iter_mut().enumerate() {
                let pb = u32::from(cfg.pb) * head.pb_factor / 4;
                residues(r, &mut self.residue[..n], pb, cfg.mb.into(), cfg.kb.into(), chan_bits)?;
                let out = &mut self.mixed[c][..n];
                if head.mode == 0 {
                    predict(&self.residue[..n], out, &mut head.coefs, head.active, chan_bits, head.den_shift);
                } else {
                    let mut once = vec![0; n];
                    predict(&self.residue[..n], &mut once, &mut [], 31, chan_bits, 0);
                    predict(&once, out, &mut head.coefs, head.active, chan_bits, head.den_shift);
                }
            }
            if shifted != 0 {
                let mut low = BitReader::new(frame, 0);
                low.skip(low_at)?;
                for v in self.low[..n * lanes].iter_mut() {
                    *v = low.u32(shifted * 8)?;
                }
            }
        } else {
            let bits = depth;
            for i in 0..n {
                for c in 0..lanes {
                    let v = r.u32(bits)? as i32;
                    let s = 32 - bits;
                    self.mixed[c][i] = v.wrapping_shl(s).wrapping_shr(s);
                }
            }
            shift_bytes = 0;
        }
        let shift = shift_bytes * 8;
        if pair {
            let [u, v] = &mut self.mixed;
            for i in 0..n {
                let (a, b) = (u[i], v[i]);
                let (mut l, mut rr) = if mix_res != 0 {
                    let l = a.wrapping_add(b).wrapping_sub(mix_res.wrapping_mul(b) >> mix_bits.min(31));
                    (l, l.wrapping_sub(b))
                } else {
                    (a, b)
                };
                if shift != 0 {
                    l = (l << shift) | self.low[i * 2] as i32;
                    rr = (rr << shift) | self.low[i * 2 + 1] as i32;
                }
                u[i] = l;
                v[i] = rr;
            }
        } else if shift != 0 {
            for (i, s) in self.mixed[0][..n].iter_mut().enumerate() {
                *s = (*s << shift) | self.low[i] as i32;
            }
        }
        Ok(n)
    }
}
