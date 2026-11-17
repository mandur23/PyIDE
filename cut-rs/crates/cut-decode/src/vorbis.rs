//! Vorbis through the `lewton` crate (a pure-Rust Vorbis I decoder; this PC's Media Foundation lists only an FFmpeg
//! wrapper for it). The three headers come from the track's CodecPrivate, Xiph-laced as Matroska carries them; each
//! packet's finished samples are a block placed by its sample's time, as WebCodecs places them. The first packet
//! after a start gives no samples (it only fills the overlap), and so does the packet after one lewton refuses: a
//! damaged packet leaves silence, never a wrong overlap.
//!
//! Also the channel order WebCodecs gives Vorbis-order layouts in (Chromium's: L R C LFE, then the surrounds), which
//! Opus's mapping family 1 shares.

use std::panic::{AssertUnwindSafe, catch_unwind};

use lewton::audio::{PreviousWindowRight, read_audio_packet_generic};
use lewton::header::{IdentHeader, SetupHeader, read_header_ident, read_header_setup};

use crate::error::{DecodeError, Result};

/// For 3 to 8 channels in Vorbis order, the Vorbis channel each output channel takes (FFmpeg's
/// `ff_vorbis_channel_layout_offsets`): L C R becomes L R C, 5.1's L C R Ls Rs LFE becomes L R C LFE Ls Rs.
const WAVE_ORDER: [&[usize]; 6] = [
    &[0, 2, 1],
    &[0, 1, 2, 3],
    &[0, 2, 1, 3, 4],
    &[0, 2, 1, 5, 3, 4],
    &[0, 2, 1, 6, 5, 3, 4],
    &[0, 2, 1, 7, 5, 6, 3, 4],
];

/// The Vorbis-order channel each output channel of a `channels` layout takes, or `None` when the order stays.
pub(crate) fn wave_order(channels: usize) -> Option<&'static [usize]> {
    channels.checked_sub(3).and_then(|i| WAVE_ORDER.get(i)).copied()
}

/// Planes in Vorbis order put in WebCodecs' order.
fn to_wave_order(planes: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    let Some(order) = wave_order(planes.len()) else { return planes };
    let mut taken: Vec<Option<Vec<f32>>> = planes.into_iter().map(Some).collect();
    order.iter().map(|&k| taken[k].take().unwrap_or_default()).collect()
}

/// Xiph lacing: the packet count less one, the sizes of all but the last (each a run of 255s ended by a smaller
/// byte), then the packets.
fn xiph_unlace(b: &[u8]) -> Option<Vec<&[u8]>> {
    let (&n, mut rest) = b.split_first()?;
    let mut sizes = Vec::with_capacity(usize::from(n));
    for _ in 0..n {
        let mut size = 0usize;
        loop {
            let (&v, r) = rest.split_first()?;
            rest = r;
            size += usize::from(v);
            if v != 255 {
                break;
            }
        }
        sizes.push(size);
    }
    let mut out = Vec::with_capacity(sizes.len() + 1);
    for size in sizes {
        if size > rest.len() {
            return None;
        }
        let (p, r) = rest.split_at(size);
        out.push(p);
        rest = r;
    }
    out.push(rest);
    Some(out)
}

/// Bits read from the least significant, as Vorbis packs them.
struct Bits<'a> {
    b: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn left(&self) -> u64 {
        (self.b.len() * 8).saturating_sub(self.at) as u64
    }

    fn read(&mut self, n: u32) -> Option<u64> {
        if u64::from(n) > self.left() {
            return None;
        }
        let mut v = 0;
        for k in 0..n {
            v |= u64::from((self.b[self.at / 8] >> (self.at % 8)) & 1) << k;
            self.at += 1;
        }
        Some(v)
    }

    fn skip(&mut self, n: u64) -> Option<()> {
        (n <= self.left()).then(|| self.at += n as usize)
    }
}

/// The largest `r` with `r^dims <= entries` (the specification's `lookup1_values`).
fn lookup1_values(entries: u64, dims: u64) -> u64 {
    let fits = |r: u64| {
        let mut p: u64 = 1;
        for _ in 0..dims {
            p = p.saturating_mul(r);
            if p > entries {
                return false;
            }
        }
        true
    };
    let mut r = (entries as f64).powf(1.0 / dims as f64).floor() as u64;
    while r > 0 && !fits(r) {
        r -= 1;
    }
    while fits(r + 1) {
        r += 1;
    }
    r
}

/// Entries, and vector-quantization values, a codebook may hold: real books hold a few thousand.
const MOST_VALUES: u64 = 1 << 22;

/// The highest sample rate taken: a damaged one would size the decoded track by it.
const MOST_RATE: u32 = 768_000;

/// Whether the setup header's codebooks ask for no more than their bits can hold. lewton reserves each codebook's
/// tables before reading them, so a damaged count (16 million entries of 65535 dimensions) would ask the allocator
/// for terabytes, which aborts the process instead of failing.
fn codebooks_fit(setup: &[u8]) -> bool {
    let mut r = Bits { b: setup, at: 7 * 8 };
    let check = |r: &mut Bits| -> Option<()> {
        let books = r.read(8)? + 1;
        for _ in 0..books {
            (r.read(24)? == 0x56_4342).then_some(())?;
            let dims = r.read(16)?;
            let entries = r.read(24)?;
            (entries <= r.left() && entries <= MOST_VALUES).then_some(())?;
            if r.read(1)? == 1 {
                r.skip(5)?;
                let mut current = 0;
                while current < entries {
                    current += r.read(64 - (entries - current).leading_zeros())?;
                }
            } else if r.read(1)? == 1 {
                for _ in 0..entries {
                    if r.read(1)? == 1 {
                        r.skip(5)?;
                    }
                }
            } else {
                r.skip(5 * entries)?;
            }
            let kind = r.read(4)?;
            if kind == 1 || kind == 2 {
                r.skip(64)?;
                let bits = r.read(4)? + 1;
                r.skip(1)?;
                let values = if kind == 1 { lookup1_values(entries, dims) } else { entries.saturating_mul(dims) };
                (values.saturating_mul(bits) <= r.left() && entries.saturating_mul(dims) <= MOST_VALUES)
                    .then_some(())?;
                r.skip(values * bits)?;
            }
        }
        Some(())
    };
    check(&mut r).is_some()
}

/// A third-party decoder's call, its panic on hostile bytes turned into `None`.
fn guarded<T>(f: impl FnOnce() -> Option<T>) -> Option<T> {
    catch_unwind(AssertUnwindSafe(f)).ok().flatten()
}

/// One Vorbis stream's decoder.
pub(crate) struct VorbisDecoder {
    ident: IdentHeader,
    setup: SetupHeader,
    window: PreviousWindowRight,
    /// The block size of the packet before, when it was decoded.
    before: Option<usize>,
}

impl VorbisDecoder {
    /// A decoder for the headers of a Matroska CodecPrivate.
    pub(crate) fn new(private: &[u8]) -> Result<Self> {
        let damaged = || DecodeError::Damaged("Vorbis headers that do not read".into());
        let packets = xiph_unlace(private).filter(|p| p.len() == 3 && codebooks_fit(p[2])).ok_or_else(damaged)?;
        let (ident, setup) = guarded(|| {
            let ident = read_header_ident(packets[0]).ok().filter(|i| i.audio_sample_rate <= MOST_RATE)?;
            let sizes = (ident.blocksize_0, ident.blocksize_1);
            let setup = read_header_setup(packets[2], ident.audio_channels, sizes).ok()?;
            Some((ident, setup))
        })
        .ok_or_else(damaged)?;
        Ok(Self { ident, setup, window: PreviousWindowRight::new(), before: None })
    }

    pub(crate) fn rate(&self) -> u32 {
        self.ident.audio_sample_rate
    }

    pub(crate) fn channels(&self) -> u32 {
        self.ident.audio_channels.into()
    }

    /// A packet's finished samples a channel, in WebCodecs' order (none for the first packet after a start or a
    /// refused one), and how many samples after the packet's time they start; `None` when lewton refuses the
    /// packet, which starts the overlap again.
    ///
    /// A packet's time is where libvorbis's (and WebCodecs') output of it starts: the centre of the block before.
    /// lewton gives every sample that is finished instead, so after a long block followed by a short one it gives
    /// the long block's flat end with that packet; the next packet's samples then start that much after its time.
    pub(crate) fn decode(&mut self, packet: &[u8]) -> Option<(usize, Vec<Vec<f32>>)> {
        let (ident, setup, window) = (&self.ident, &self.setup, &mut self.window);
        let decoded = guarded(|| {
            let finished = lewton::audio::get_decoded_sample_count(ident, setup, packet).ok()?;
            let planes = read_audio_packet_generic::<Vec<Vec<f32>>>(ident, setup, packet, window).ok()?;
            Some((finished, planes))
        });
        let Some((finished, planes)) = decoded else {
            self.window = PreviousWindowRight::new();
            self.before = None;
            return None;
        };
        let (short, long) = (1usize << ident.blocksize_0, 1usize << ident.blocksize_1);
        // Only a short block finishes half a short block's samples (when the two sizes differ).
        let size = if finished == short / 2 { short } else { long };
        let lead = match self.before.replace(size) {
            Some(b) if b == long && size == short => (long - short) / 4,
            _ => 0,
        };
        Some((lead, to_wave_order(planes)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xiph_lacing_comes_apart() {
        let mut b = vec![2, 255, 1, 3];
        b.extend(vec![7; 256]);
        b.extend([8; 3]);
        b.extend([9; 5]);
        let p = xiph_unlace(&b).expect("three packets");
        assert_eq!(p.iter().map(|x| x.len()).collect::<Vec<_>>(), vec![256, 3, 5]);
        assert_eq!((p[0][0], p[1][0], p[2][0]), (7, 8, 9));
        for bad in [&[][..], &[2][..], &[2, 255][..], &[1, 9, 1][..]] {
            assert!(xiph_unlace(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn surround_layouts_go_to_webcodecs_order() {
        let planes = |n: usize| (0..n).map(|c| vec![c as f32]).collect::<Vec<_>>();
        let firsts = |p: Vec<Vec<f32>>| p.iter().map(|x| x[0] as usize).collect::<Vec<_>>();
        assert_eq!(firsts(to_wave_order(planes(2))), vec![0, 1]);
        assert_eq!(firsts(to_wave_order(planes(3))), vec![0, 2, 1]);
        assert_eq!(firsts(to_wave_order(planes(6))), vec![0, 2, 1, 5, 3, 4]);
        assert_eq!(firsts(to_wave_order(planes(9))), (0..9).collect::<Vec<_>>());
        for n in 3..=8 {
            let mut o = wave_order(n).expect("a layout").to_vec();
            o.sort_unstable();
            assert_eq!(o, (0..n).collect::<Vec<_>>(), "{n} channels: each once");
        }
    }

    #[test]
    fn codebooks_larger_than_their_bits_are_refused_before_lewton_sees_them() {
        assert_eq!([lookup1_values(512, 1), lookup1_values(81, 4), lookup1_values(80, 4)], [512, 3, 2]);
        assert_eq!(lookup1_values(1 << 24, 65535), 1);
        // one codebook of 2 dimensions and 4 entries, all 2 bits long, lookup type 2 with 1-bit values: 8 values
        let book = |dims: u64, entries: u64, values: usize| {
            let mut bits = vec![(0, 8), (0x56_4342, 24), (dims, 16), (entries, 24), (0, 1), (0, 1)];
            bits.extend((0..entries.min(64)).map(|_| (1, 5)));
            bits.extend([(2, 4), (0, 32), (0, 32), (0, 4), (0, 1)]);
            bits.extend((0..values).map(|_| (1, 1)));
            let mut out = b"\x05vorbis".to_vec();
            let mut at = 0;
            for (v, n) in bits {
                for k in 0..n {
                    if at % 8 == 0 {
                        out.push(0);
                    }
                    let last = out.len() - 1;
                    out[last] |= (((v >> k) & 1) as u8) << (at % 8);
                    at += 1;
                }
            }
            out
        };
        assert!(codebooks_fit(&book(2, 4, 8)));
        assert!(!codebooks_fit(&book(2, 4, 0)), "values cut off");
        assert!(!codebooks_fit(&book(65535, 64, 8)), "64 x 65535 values in 8 bits");
        assert!(!codebooks_fit(&book(1, (1 << 24) - 1, 0)), "16 million entries in a few bytes");
    }

    #[test]
    fn headers_that_do_not_read_are_damaged() {
        for bad in [&[][..], &[2, 1, 1, 1, 3, 5][..], b"\x02\x1e\x0f\x01vorbis"] {
            assert!(matches!(VorbisDecoder::new(bad), Err(DecodeError::Damaged(_))));
        }
    }
}
