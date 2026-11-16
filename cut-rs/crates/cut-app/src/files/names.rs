//! Autosave names: `<name>-<hash>-<stamp>[.latest].ncut`, as `project.js` builds and parses them.

use sha1::{Digest, Sha1};

use super::paths::{basename, local_path};

/// The 8 hex digits that tell keys apart: SHA-1 of the key's local path in lower case, or of the key itself when it is
/// not a path (`untitled-<id>`).
pub fn hash_of(key: &str) -> String {
    let id = local_path(key).map_or_else(|_| key.to_owned(), |p| p.to_lowercase());
    let digest = Sha1::digest(id.as_bytes());
    digest[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// JavaScript's `\s` (control characters are already replaced by `_` when this is asked).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `safeName`: a file name part with no character Windows refuses, no leading or trailing dots and spaces, at most 60
/// UTF-16 units (a pair cut in two leaves U+FFFD, as Node writes a lone surrogate), `project` when nothing is left.
fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(
            |c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\x1f') { '_' } else { c },
        )
        .collect();
    let trimmed = cleaned.trim_matches(|c| js_space(c) || c == '.');
    let mut out = String::new();
    let mut units = 0;
    for c in trimmed.chars() {
        let n = c.len_utf16();
        if units + n > 60 {
            if units < 60 {
                out.push('\u{fffd}');
            }
            break;
        }
        units += n;
        out.push(c);
    }
    if out.is_empty() { "project".to_owned() } else { out }
}

/// The readable part of an autosave's name: the project's file name without `.ncut`, or the key when it is not a path.
pub fn name_of(key: &str) -> String {
    if local_path(key).is_err() {
        return safe_name(key);
    }
    let base = basename(key);
    let cut =
        base.len().checked_sub(5).filter(|&i| base.is_char_boundary(i) && base[i..].eq_ignore_ascii_case(".ncut"));
    safe_name(cut.map_or(base, |i| &base[..i]))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1..=12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The UTC stamp of a time in ms, `YYYYMMDD-HHMMSS-mmm`.
pub fn stamp_of(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s, milli) = (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
    format!("{y}{m:02}{d:02}-{h:02}{mi:02}{s:02}-{milli:03}")
}

fn digits(s: &[u8]) -> Option<i64> {
    s.iter().try_fold(0_i64, |n, &c| c.is_ascii_digit().then(|| n * 10 + i64::from(c - b'0')))
}

/// The time in ms of a stamp, as `Date.UTC` reads its fields (a month past 12 rolls into the next year, a year below
/// 100 is 19xx); `None` for text that is not a stamp.
pub fn time_of_stamp(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 19 || b[8] != b'-' || b[15] != b'-' {
        return None;
    }
    let field = |from: usize, to: usize| digits(&b[from..to]);
    let (mut y, m) = (field(0, 4)?, field(4, 6)? - 1);
    if y <= 99 {
        y += 1900;
    }
    let days = days_from_civil(y + m.div_euclid(12), m.rem_euclid(12) + 1, 1) + field(6, 8)? - 1;
    Some(
        days * 86_400_000
            + field(9, 11)? * 3_600_000
            + field(11, 13)? * 60_000
            + field(13, 15)? * 1000
            + field(16, 19)?,
    )
}

/// An autosave's file name for a key at a stamp time.
pub fn autosave_name(key: &str, ms: i64, latest: bool) -> String {
    format!("{}-{}-{}{}.ncut", name_of(key), hash_of(key), stamp_of(ms), if latest { ".latest" } else { "" })
}

/// What an autosave's name says (`-([0-9a-f]{8})-(\d{8}-\d{6}-\d{3})(\.latest)?\.ncut$`): its key hash, time and kind.
pub(crate) fn parse_autosave(name: &str) -> Option<(&str, i64, bool)> {
    let rest = name.strip_suffix(".ncut")?;
    let (rest, latest) = rest.strip_suffix(".latest").map_or((rest, false), |r| (r, true));
    let b = rest.as_bytes();
    let n = b.len();
    if n < 29 || b[n - 20] != b'-' || b[n - 29] != b'-' {
        return None;
    }
    let hash = &rest[n - 28..n - 20];
    if !hash.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let stamp = &rest[n - 19..];
    let s = stamp.as_bytes();
    let shape = s.iter().enumerate().all(|(i, &c)| if i == 8 || i == 15 { c == b'-' } else { c.is_ascii_digit() });
    if !shape {
        return None;
    }
    Some((hash, time_of_stamp(stamp)?, latest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_round_trip() {
        for ms in [0, 1, 86_399_999, 951_782_400_000, 1_700_000_000_123, 4_102_444_800_000, 253_402_300_799_999] {
            assert_eq!(time_of_stamp(&stamp_of(ms)), Some(ms), "{ms}");
        }
        assert_eq!(stamp_of(1_700_000_000_123), "20231114-221320-123");
        assert_eq!(time_of_stamp("20231314-221320-123"), time_of_stamp("20240114-221320-123"));
        assert_eq!(time_of_stamp("00500101-000000-000"), time_of_stamp("19500101-000000-000"));
        assert_eq!(time_of_stamp("2023111-221320-1234"), None);
    }

    #[test]
    fn names() {
        assert_eq!(name_of("C:\\x\\Trip.NCUT"), "Trip");
        assert_eq!(name_of("untitled-7"), "untitled-7");
        assert_eq!(name_of("..\\..\\evil"), "_.._evil");
        assert_eq!(name_of(" . "), "project");
        assert_eq!(name_of(&"😀".repeat(40)), "😀".repeat(30));
        assert_eq!(name_of(&format!("a{}", "😀".repeat(40))), format!("a{}\u{fffd}", "😀".repeat(29)));
        assert_eq!(hash_of("C:\\A\\b.ncut"), hash_of("c:/a/./b.ncut"));
        let name = autosave_name("C:\\x\\Trip.ncut", 1_700_000_000_123, true);
        let (hash, time, latest) = parse_autosave(&name).unwrap();
        assert_eq!((hash, time, latest), (hash_of("C:\\x\\Trip.ncut").as_str(), 1_700_000_000_123, true));
        assert_eq!(parse_autosave("-0123abcd-20231114-221320-123.ncut").map(|p| p.2), Some(false));
        assert_eq!(parse_autosave("x-0123ABCD-20231114-221320-123.ncut"), None);
        assert_eq!(parse_autosave("x-0123abcd-20231114-221320-123.latest.ncut.bak"), None);
    }
}
