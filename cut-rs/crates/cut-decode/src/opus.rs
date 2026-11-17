//! Opus of more than two channels (mapping families 1 and 255) through Microsoft's Opus decoder, which takes one or
//! two channels: each packet carries one Opus stream per coupled pair or single channel (RFC 7845 section 5.1.1),
//! all but the last in the self-delimiting framing of RFC 6716 appendix B. Each stream is split out as a plain
//! packet for a decoder of its own; the mapping table puts the streams' channels in the track's order, 255 a silent
//! channel (family 1's Vorbis order is then put in WebCodecs' order by `audio_part`).

use crate::error::{DecodeError, Result};

/// The streams of a track and where each output channel comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Layout {
    pub streams: usize,
    pub coupled: usize,
    /// For each output channel: `(stream, channel of it)`, or `None` for silence.
    pub sources: Vec<Option<(usize, usize)>>,
}

impl Layout {
    /// The layout of an OpusHead's channel mapping (`mapping`: stream count, coupled count, then the table).
    pub(crate) fn of(channels: usize, mapping: &[u8]) -> Result<Self> {
        let bad = || DecodeError::Damaged("an Opus channel mapping that does not read".into());
        let (&streams, rest) = mapping.split_first().ok_or_else(bad)?;
        let (&coupled, table) = rest.split_first().ok_or_else(bad)?;
        let (streams, coupled) = (usize::from(streams), usize::from(coupled));
        if streams == 0 || coupled > streams || table.len() < channels || streams + coupled > 255 {
            return Err(bad());
        }
        let sources = table[..channels]
            .iter()
            .map(|&m| match usize::from(m) {
                255 => Ok(None),
                m if m < 2 * coupled => Ok(Some((m / 2, m % 2))),
                m if m < streams + coupled => Ok(Some((m - coupled, 0))),
                _ => Err(bad()),
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { streams, coupled, sources })
    }

    /// The channels of stream `s`.
    pub(crate) fn channels_of(&self, s: usize) -> u32 {
        if s < self.coupled { 2 } else { 1 }
    }
}

/// A frame length as packets code it, and the bytes the code took.
fn size(b: &[u8], at: usize) -> Option<(usize, usize)> {
    let first = usize::from(*b.get(at)?);
    if first < 252 { Some((first, 1)) } else { Some((first + 4 * usize::from(*b.get(at + 1)?), 2)) }
}

/// The first self-delimited packet of `b` as a plain packet, and the bytes it took.
fn self_delimited(b: &[u8]) -> Option<(Vec<u8>, usize)> {
    let toc = *b.first()?;
    let (header, frames, tail_padding) = match toc & 3 {
        0 => {
            let (n, l) = size(b, 1)?;
            ((1, 1 + l), n, 0)
        }
        1 => {
            let (n, l) = size(b, 1)?;
            ((1, 1 + l), 2 * n, 0)
        }
        2 => {
            let (n1, l1) = size(b, 1)?;
            let (n2, l2) = size(b, 1 + l1)?;
            ((1 + l1, 1 + l1 + l2), n1 + n2, 0)
        }
        _ => {
            let count = *b.get(1)?;
            let (vbr, padded, m) = (count & 0x80 != 0, count & 0x40 != 0, usize::from(count & 0x3f));
            if m == 0 {
                return None;
            }
            let mut at = 2;
            let mut padding = 0;
            if padded {
                loop {
                    let p = usize::from(*b.get(at)?);
                    at += 1;
                    padding += if p == 255 { 254 } else { p };
                    if p != 255 {
                        break;
                    }
                }
            }
            let mut sum = 0;
            if vbr {
                for _ in 0..m - 1 {
                    let (n, l) = size(b, at)?;
                    sum += n;
                    at += l;
                }
            }
            let (last, l) = size(b, at)?;
            let total = if vbr { sum + last } else { m * last };
            ((at, at + l), total, padding)
        }
    };
    // The plain packet is the self-delimited one without its extra length field, `b[header.0..header.1]`.
    let end = header.1 + frames + tail_padding;
    if end > b.len() {
        return None;
    }
    let mut plain = b[..header.0].to_vec();
    plain.extend_from_slice(&b[header.1..end]);
    Some((plain, end))
}

/// A multistream packet's streams as plain packets, one a stream.
pub(crate) fn split(packet: &[u8], streams: usize) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::with_capacity(streams);
    let mut rest = packet;
    for _ in 1..streams {
        let (p, used) =
            self_delimited(rest).ok_or_else(|| DecodeError::Damaged("an Opus multistream packet cut short".into()))?;
        out.push(p);
        rest = &rest[used..];
    }
    out.push(rest.to_vec());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_of_mapping_tables() {
        let l = Layout::of(6, &[4, 2, 0, 4, 1, 2, 3, 5]).expect("5.1");
        assert_eq!((l.streams, l.coupled), (4, 2));
        assert_eq!(l.sources, vec![Some((0, 0)), Some((2, 0)), Some((0, 1)), Some((1, 0)), Some((1, 1)), Some((3, 0))]);
        assert_eq!((l.channels_of(1), l.channels_of(2)), (2, 1));
        assert_eq!(Layout::of(3, &[1, 0, 255, 0, 255]).expect("routed").sources, vec![None, Some((0, 0)), None]);
        for bad in [&[][..], &[0, 0, 0][..], &[1, 2, 0][..], &[2, 0, 0, 1][..], &[1, 0, 0, 9, 0][..]] {
            assert!(Layout::of(3, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn self_delimited_streams_come_apart() {
        // code 0 (3 bytes), code 1 (2 x 2), code 2 (1 + 3), code 3 CBR with padding, then a plain last stream
        let mut p = vec![0x00, 3, 1, 2, 3];
        p.extend([0x01, 2, 4, 5, 6, 7]);
        p.extend([0x02, 1, 3, 8, 9, 10, 11]);
        p.extend([0x03, 0x42, 1, 2, 12, 13, 14, 15, 0]);
        p.extend([0x00, 99, 98]);
        let s = split(&p, 5).expect("split");
        assert_eq!(s[0], vec![0x00, 1, 2, 3]);
        assert_eq!(s[1], vec![0x01, 4, 5, 6, 7]);
        assert_eq!(s[2], vec![0x02, 1, 8, 9, 10, 11]);
        assert_eq!(s[3], vec![0x03, 0x42, 1, 12, 13, 14, 15, 0]);
        assert_eq!(s[4], vec![0x00, 99, 98]);
        // code 3 VBR: lengths 1 and (extra) 2
        assert_eq!(split(&[0x03, 0x82, 1, 2, 7, 8, 9, 5], 2).expect("vbr")[0], vec![0x03, 0x82, 1, 7, 8, 9]);
        assert!(split(&[0x00, 9, 1], 2).is_err());
        assert!(split(&[0x03, 0x00, 1], 2).is_err());
        assert!(split(&[], 2).is_err());
    }
}
