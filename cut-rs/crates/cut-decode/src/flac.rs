//! What Microsoft's FLAC decoder is given, made safe: it parses a byte stream and waits for whole metadata blocks and
//! frames (it never returns from `ProcessOutput` while it waits), and a damaged frame breaks its framing for the
//! frames after it, which then land early. So it gets a stream header rebuilt from the STREAMINFO alone, and each
//! frame only when its CRC-16 checks out; a damaged or missing frame becomes a silent frame of the same length, so
//! the frames after it keep their place.

/// `fLaC` and the STREAMINFO block as the last metadata block, from a track's metadata blocks (with or without the
/// marker); `None` when they do not start with a whole STREAMINFO.
pub(crate) fn stream_header(description: &[u8]) -> Option<Vec<u8>> {
    let blocks = description.strip_prefix(b"fLaC").unwrap_or(description);
    let (&kind, rest) = blocks.split_first()?;
    let len = usize::from(rest.get(2).copied()?) | usize::from(*rest.get(1)?) << 8 | usize::from(*rest.first()?) << 16;
    if kind & 0x7f != 0 || len != 34 {
        return None;
    }
    let info = rest.get(3..3 + 34)?;
    let mut h = b"fLaC".to_vec();
    h.extend([0x80, 0, 0, 34]);
    h.extend_from_slice(info);
    Some(h)
}

/// CRC-8 (polynomial 0x07) of a frame header.
fn crc8(b: &[u8]) -> u8 {
    b.iter().fold(0u8, |mut c, &x| {
        c ^= x;
        for _ in 0..8 {
            c = if c & 0x80 != 0 { (c << 1) ^ 0x07 } else { c << 1 };
        }
        c
    })
}

/// CRC-16 (polynomial 0x8005) of a frame.
fn crc16(b: &[u8]) -> u16 {
    b.iter().fold(0u16, |mut c, &x| {
        c ^= u16::from(x) << 8;
        for _ in 0..8 {
            c = if c & 0x8000 != 0 { (c << 1) ^ 0x8005 } else { c << 1 };
        }
        c
    })
}

/// Whether a frame is whole: the sync code, and its CRC-16 over everything before its last two bytes.
pub(crate) fn whole(frame: &[u8]) -> bool {
    frame.len() >= 10
        && frame[0] == 0xff
        && frame[1] & 0xfe == 0xf8
        && crc16(&frame[..frame.len() - 2]).to_be_bytes() == frame[frame.len() - 2..]
}

/// A frame of `samples` (1 to 65536) of silence for `channels` of `bits`: frame number `number` (the stream's
/// blocking strategy `variable` numbers samples instead), sample rate and size from the STREAMINFO.
pub(crate) fn silent(samples: u32, channels: u32, bits: u32, number: u64, variable: bool) -> Vec<u8> {
    let mut f = vec![0xff, 0xf8 | u8::from(variable), 0x70, ((channels.clamp(1, 8) - 1) as u8) << 4];
    let n = number.min((1 << 36) - 1);
    if n < 0x80 {
        f.push(n as u8);
    } else {
        let tail = (1..7).find(|&t| n < 1u64 << (5 * t + 6)).unwrap_or(6);
        let lead = if tail == 6 { 0xfe } else { (0xff00u16 >> (tail + 1)) as u8 | (n >> (6 * tail)) as u8 };
        f.push(lead);
        for k in (0..tail).rev() {
            f.push(0x80 | ((n >> (6 * k)) & 0x3f) as u8);
        }
    }
    f.extend(((samples.clamp(1, 65536) - 1) as u16).to_be_bytes());
    f.push(crc8(&f));
    // Each channel: a CONSTANT subframe header (0x00) and a zero of `bits` bits, packed and padded to a byte.
    let body_bits = u64::from(channels.clamp(1, 8)) * (8 + u64::from(bits));
    f.extend(std::iter::repeat_n(0u8, body_bits.div_ceil(8) as usize));
    let crc = crc16(&f);
    f.extend(crc.to_be_bytes());
    f
}

/// The blocking strategy of a stream's frames: variable (sample numbers) when its first whole frame says so.
pub(crate) fn variable(frame: &[u8]) -> bool {
    frame.get(1).is_some_and(|b| b & 1 == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_frames_are_whole_and_crc_damage_is_seen() {
        for (n, variable) in [(0, false), (5, false), (200, false), (5000, true), (1 << 33, true)] {
            let f = silent(4096, 2, 16, n, variable);
            assert!(whole(&f), "{n}");
            let mut g = f.clone();
            g[6] ^= 4;
            assert!(!whole(&g));
            assert!(!whole(&f[..f.len() - 1]));
        }
        assert!(!whole(&[]));
        let mut info = vec![0u8, 0, 0, 34];
        info.extend([7u8; 34]);
        info.extend([0x84, 0, 0, 1, 9]);
        let h = stream_header(&info).expect("a header");
        assert_eq!((&h[..4], h[4], h.len()), (&b"fLaC"[..], 0x80, 4 + 4 + 34));
        assert_eq!(stream_header(&h), Some(h.clone()), "with the marker as well");
        assert_eq!(stream_header(&info[..20]), None);
        assert_eq!(stream_header(&[4, 0, 0, 34]), None);
    }

    #[test]
    fn frame_numbers_are_utf8_coded() {
        let at = |n: u64| silent(16, 1, 16, n, false)[4..].to_vec();
        assert_eq!(at(0x7f)[0], 0x7f);
        assert_eq!(&at(0x80)[..2], &[0xc2, 0x80]);
        assert_eq!(&at(0x800)[..3], &[0xe0, 0xa0, 0x80]);
        assert_eq!(&at(0x10000)[..4], &[0xf0, 0x90, 0x80, 0x80]);
    }
}
