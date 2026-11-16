//! The HSL Secondary eyedropper's qualifier against the JavaScript's `lumetri.qualifierFor` (tools/oracle.mjs).

use cut_app::fx::color::pick::qualifier_for;
use cut_oracle::{Inputs, ask};
use serde_json::{Map, Value as Json, json};

#[test]
fn the_eyedroppers_qualifier_matches_the_javascript() {
    let mut r = Inputs::new(7);
    let mut colors: Vec<[u8; 3]> = vec![
        [0, 0, 0],
        [255, 255, 255],
        [128, 128, 128],
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [191, 0, 0],
        [40, 160, 60],
    ];
    for _ in 0..500 {
        colors.push([r.range(0, 255) as u8, r.range(0, 255) as u8, r.range(0, 255) as u8]);
    }
    let calls: Vec<Json> = colors.iter().map(|c| json!(["qualifierFor", c])).collect();
    let want = ask("lumetri", &calls);
    let mut bad = Vec::new();
    for (c, w) in colors.iter().zip(&want) {
        let got: Map<String, Json> = qualifier_for(*c).iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect();
        let w = w.as_object().expect("an object");
        let same = got.len() == w.len()
            && got
                .iter()
                .all(|(k, v)| w.get(k).and_then(Json::as_f64).is_some_and(|x| (x - v.as_f64().unwrap()).abs() < 1e-9));
        if !same {
            bad.push(format!("{c:?}: {got:?} vs {w:?}"));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), colors.len(), bad[..bad.len().min(5)].join("\n"));
    eprintln!("qualifierFor: {} calls agree", colors.len());
}
