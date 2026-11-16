//! The data checks of Lumetri Color (port of the data part of `lumetri.js`): the shape of a LUT entry in
//! `project.luts` and the clean-up of a stored curve. Decoding a LUT and drawing it belong to the engine.

use serde_json::Value as Json;

/// The largest LUT size (points per axis) a `.cube` file may have.
pub const MAX_SIZE: i64 = 65;
/// The most points a curve keeps.
pub const MAX_POINTS: usize = 16;
/// The smallest x distance between two points of a curve.
pub const MIN_GAP: f64 = 0.005;

/// Whether a key of `project.luts` has the form `store()` gives it: `lut-` and 16 lower-case hex digits.
pub fn valid_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("lut-")
        && id[4..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether an entry of `project.luts` has the shape `store()` gives (`validEntry`): name and title, a size of 2 to 65,
/// a domain whose minimum is below its maximum on each axis, and base64 data of `size³` RGB float32 values.
pub fn valid_entry(e: &Json) -> bool {
    let num3 = |v: Option<&Json>| -> Option<[f64; 3]> {
        let a = v?.as_array().filter(|a| a.len() == 3)?;
        let mut out = [0.0; 3];
        for (o, x) in out.iter_mut().zip(a) {
            *o = x.as_f64().filter(|x| x.is_finite())?;
        }
        Some(out)
    };
    let Some(o) = e.as_object() else { return false };
    let Some(n) =
        o.get("size").and_then(Json::as_f64).filter(|n| n.fract() == 0.0 && (2.0..=MAX_SIZE as f64).contains(n))
    else {
        return false;
    };
    let (Some(min), Some(max)) = (num3(o.get("min")), num3(o.get("max"))) else { return false };
    let want = ((n * n * n * 12.0) / 3.0).ceil() * 4.0;
    o.get("name").is_some_and(Json::is_string)
        && o.get("title").is_some_and(Json::is_string)
        && min.iter().zip(&max).all(|(a, b)| a < b)
        && o.get("data").and_then(Json::as_str).is_some_and(|d| d.encode_utf16().count() as f64 == want)
}

/// `clamp(x, 0, 1)` as Math.max and Math.min give it: -0 comes out as 0.
fn unit(x: f64) -> f64 {
    x.clamp(0.0, 1.0) + 0.0
}

/// The points `[x, y]` of a stored curve (`points`): numbers kept in 0..1, sorted by x, a point closer than 0.005 to
/// the one before dropped, at most 16; anything unusable (a non-finite number among them) is the straight line.
pub fn points(flat: &[f64]) -> Vec<[f64; 2]> {
    let line = vec![[0.0, 0.0], [1.0, 1.0]];
    if flat.len() < 4 || flat.len() % 2 == 1 || !flat.iter().all(|x| x.is_finite()) {
        return line;
    }
    let mut pts: Vec<[f64; 2]> = flat.chunks(2).map(|p| [unit(p[0]), unit(p[1])]).collect();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut out: Vec<[f64; 2]> = Vec::new();
    for p in pts {
        if out.last().is_none_or(|l| p[0] - l[0] >= MIN_GAP) {
            out.push(p);
        }
    }
    if out.len() < 2 {
        return line;
    }
    out.truncate(MAX_POINTS);
    out
}

/// A stored curve cleaned up, flat again (`sanitize`); a value that is not a number makes it the straight line.
pub fn sanitize(flat: &[Json]) -> Vec<f64> {
    let nums: Vec<f64> = flat.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect();
    points(&nums).into_iter().flatten().collect()
}
