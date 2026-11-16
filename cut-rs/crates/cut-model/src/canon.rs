//! A project's canonical text: what two projects are compared by, here and against the JavaScript editor
//! (`tools/scenarios/model.cjs` writes the same text). Keys sorted, a sequence's clips by track id, start and id,
//! numbers as JavaScript writes them.

use serde_json::Value as Json;

use crate::masks::js_number;
use crate::project::Project;

/// The canonical text of a project.
pub fn canonical(p: &Project) -> String {
    canonical_json(&serde_json::to_value(p).expect("a project serializes"))
}

/// The canonical text of a project's JSON.
pub fn canonical_json(v: &Json) -> String {
    let mut v = v.clone();
    if let Some(seqs) = v.get_mut("sequences").and_then(Json::as_array_mut) {
        for seq in seqs {
            if let Some(clips) = seq.get_mut("clips").and_then(Json::as_array_mut) {
                clips.sort_by(|a, b| {
                    let key =
                        |c: &Json| (c["track"].as_str().unwrap_or("").to_owned(), c["start"].as_f64().unwrap_or(0.0));
                    let (ka, kb) = (key(a), key(b));
                    ka.0.cmp(&kb.0)
                        .then(ka.1.total_cmp(&kb.1))
                        .then_with(|| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")))
                });
            }
        }
    }
    let mut out = String::new();
    write(&v, &mut out);
    out
}

fn write(v: &Json, out: &mut String) {
    match v {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) if i.unsigned_abs() < 1 << 53 => out.push_str(&i.to_string()),
            (_, Some(x)) if x.is_finite() => out.push_str(&js_number(x)),
            _ => out.push_str("null"),
        },
        Json::String(s) => out.push_str(&serde_json::to_string(s).expect("a string serializes")),
        Json::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Json::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("a key serializes"));
                out.push(':');
                write(&m[k], out);
            }
            out.push('}');
        }
    }
}

/// Two 32-bit FNV-1a hashes of the text's UTF-8 bytes as 16 hex digits: a short name for a canonical text.
pub fn fingerprint(text: &str) -> String {
    let (mut a, mut b) = (0x811c_9dc5_u32, 0x0100_0193_u32 ^ 0x5bd1_e995);
    for &byte in text.as_bytes() {
        a = (a ^ u32::from(byte)).wrapping_mul(0x0100_0193);
        b = (b ^ u32::from(byte)).wrapping_mul(0x0100_0193 + 0x1000);
    }
    format!("{a:08x}{b:08x}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn fingerprints_are_the_scenarios() {
        // the values tools/scenarios/model.cjs's hashOf gives
        assert_eq!(super::fingerprint("abc"), "1a47e90b0817cc52");
        assert_eq!(super::fingerprint("한글 {\"a\":1}"), "4b74f603acaad6f4");
        assert_ne!(super::fingerprint("abd"), super::fingerprint("abc"));
    }
}
