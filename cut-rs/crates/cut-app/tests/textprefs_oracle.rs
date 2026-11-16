//! The Text panel's and the preferences' pure parts against the JavaScript's own functions
//! (`tools/scenarios/textprefs.cjs`): the motion presets, the font style nearest a weight, the keymap's key check and
//! stored keys, the shortcut kinds, the proxy's size and file name hash, and the folder search of relinking. Random
//! inputs and the edges (empty, negative, huge, malformed, Korean and emoji text).

use cut_app::prefs::{keymap, proxy, relink};
use cut_app::text_ui::{fonts, presets};
use cut_oracle::Inputs;
use cut_time::TICKS;
use serde_json::{Value as Json, json};

fn ask(calls: &[Json]) -> Vec<Json> {
    cut_oracle::ask("scenario/textprefs", calls)
}

const PIECES: [&str; 24] = [
    "Ctrl+",
    "Alt+",
    "Shift+",
    "K",
    "k",
    "F5",
    "Space",
    "ArrowLeft",
    "/",
    "+",
    " ",
    "Ctrl",
    "Alt",
    "Control",
    "Meta",
    "가",
    "Shift Shift",
    "Ctrl Ctrl",
    "Tab",
    "1",
    "Esc",
    "é",
    "Enter",
    "",
];

#[test]
fn key_checks_and_kinds_match() {
    let mut rng = Inputs::new(5);
    let mut keys: Vec<String> = Vec::new();
    for _ in 0..600 {
        let n = rng.range(0, 4) as usize;
        keys.push((0..n).map(|_| rng.pick(&PIECES)).collect());
    }
    keys.extend(
        ["Ctrl+K", "Ctrl+Alt+Shift+K", "Ctrl+K C", "Ctrl+K C D", "Alt+Ctrl+K", "Shift+", "+", "Ctrl++"]
            .map(str::to_owned),
    );
    let mut calls: Vec<Json> = keys.iter().map(|k| json!(["validKey", k])).collect();
    let mut ids: Vec<String> = cut_app::keys::ACTIONS.iter().map(|a| a.id.to_owned()).collect();
    ids.extend(
        ["auto.cut", "window.mixer", "shuttleFast", "snap", "snapX", "tool.", "goInOut", "frameX", "unknown"]
            .map(str::to_owned),
    );
    calls.extend(ids.iter().map(|id| json!(["kindOf", id])));
    let mut maps = Vec::new();
    for _ in 0..80 {
        let mut m = serde_json::Map::new();
        for i in 0..rng.range(0, 5) {
            let v = match rng.range(0, 4) {
                0 => json!([]),
                1 => json!(rng.range(0, 9)),
                2 => Json::Array((0..rng.range(1, 4)).map(|_| json!(keys[rng.range(0, 599) as usize])).collect()),
                _ => json!(["M", "M", "Shift+M", 7]),
            };
            m.insert(format!("Cut.a{i}"), v);
        }
        maps.push(Json::Object(m));
    }
    maps.extend([json!(null), json!([1, 2]), json!("x")]);
    calls.extend(maps.iter().map(|m| json!(["parseKeymap", m])));
    let got = ask(&calls);
    let mut i = 0;
    for k in &keys {
        assert_eq!(json!(keymap::valid_key(k)), got[i], "validKey({k:?})");
        i += 1;
    }
    for id in &ids {
        assert_eq!(json!(keymap::kind_of(id)), got[i], "kindOf({id})");
        i += 1;
    }
    for m in &maps {
        assert_eq!(serde_json::to_value(keymap::parse_stored(Some(m))).unwrap(), got[i], "parseKeymap({m})");
        i += 1;
    }
    eprintln!("{} comparisons", got.len());
}

#[test]
fn proxy_sizes_and_names_match() {
    let mut rng = Inputs::new(9);
    let mut sizes = Vec::new();
    for _ in 0..400 {
        let pick = |rng: &mut Inputs| {
            let r = rng.range(1, 9000) as f64 + 0.5;
            rng.pick(&[0.0, -8.0, 1.0, 719.0, 720.0, 1080.0, 1920.0, 3840.0, 7681.0, r])
        };
        sizes.push((pick(&mut rng), pick(&mut rng), rng.pick(&[540, 720, 1080])));
    }
    let mut texts: Vec<String> =
        vec![String::new(), "c:\\media\\a.mp4|1000|1|720".into(), "가나다|null|undefined|540".into(), "😀🎬".into()];
    for _ in 0..200 {
        let n = rng.range(0, 40);
        texts.push(
            (0..n)
                .map(|_| {
                    char::from_u32(
                        rng.pick(&[0x41, 0x7a, 0x5c, 0xac00, 0xd7a3, 0x1f600, 0xe9]) as u32 + rng.range(0, 3) as u32,
                    )
                    .unwrap_or('x')
                })
                .collect(),
        );
    }
    let mut calls: Vec<Json> = sizes.iter().map(|(w, h, k)| json!(["proxySize", w, h, k])).collect();
    calls.extend(texts.iter().map(|t| json!(["proxyHash", t])));
    let got = ask(&calls);
    for (i, (w, h, k)) in sizes.iter().enumerate() {
        let (pw, ph) = proxy::size_of(*w, *h, *k);
        assert_eq!(json!([pw, ph]), got[i], "sizeOf({w}, {h}, {k})");
    }
    for (i, t) in texts.iter().enumerate() {
        assert_eq!(json!(proxy::hash(t)), got[sizes.len() + i], "hash({t:?})");
    }
}

#[test]
fn the_nearest_font_style_matches() {
    let mut rng = Inputs::new(3);
    let mut cases = Vec::new();
    for _ in 0..300 {
        let n = rng.range(0, 6);
        let styles: Vec<(u16, bool)> =
            (0..n).map(|_| (rng.pick(&[100u16, 300, 400, 500, 600, 700, 900]), rng.range(0, 1) == 1)).collect();
        cases.push((styles, rng.pick(&[0.0, 400.0, 550.0, 650.0, 700.0, 1000.0]), rng.range(0, 1) == 1));
    }
    let calls: Vec<Json> = cases
        .iter()
        .map(|(st, w, it)| {
            let list: Vec<Json> = st.iter().map(|(w, i)| json!({ "weight": w, "italic": i })).collect();
            json!(["nearest", list, w, it])
        })
        .collect();
    let got = ask(&calls);
    for ((st, w, it), g) in cases.iter().zip(&got) {
        let mine = fonts::nearest(st, *w, *it).map(|(w, i)| json!({ "weight": w, "italic": i }));
        assert_eq!(mine.unwrap_or(Json::Null), *g, "nearest({st:?}, {w}, {it})");
    }
}

/// JSON equal with numbers compared as numbers (`0` is `0.0`).
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

/// A text clip of `d` ticks with one layer, and keyframes already on its opacity.
fn text_clip(d: i64, text: &str, size: Json, position: Json, keys: Json) -> cut_model::Clip {
    let mut h = cut_app::doc::fresh_history();
    let seq = h.project().sequences[0].id;
    let layer = json!({ "text": text, "size": size, "position": position });
    let r = h
        .apply(&json!({ "type": "addGenerated", "seqId": seq.as_str(), "opts": {
            "source": { "generator": "text", "layers": [layer] }, "at": 0, "duration": d, "track": "V1",
        } }))
        .expect("a text clip");
    let id = r["id"].as_str().unwrap().to_owned();
    if !keys.is_null() {
        h.apply(&cut_model::commands::build::set_keyframes(seq.as_str(), &id, "layers.l1.opacity", Some(keys)))
            .expect("keyframes");
    }
    h.project().sequences[0].clip(cut_model::Id::new(&id)).unwrap().clone()
}

#[test]
fn motion_presets_match() {
    let mut rng = Inputs::new(21);
    let frame = TICKS / 30;
    let mut cases = Vec::new();
    for _ in 0..120 {
        let d = rng.pick(&[frame, 2 * frame, TICKS / 3, TICKS, 10 * TICKS]);
        let text = rng.pick(&["", "Title", "가나다라", "two\nlines", "a\r\nb", "😀 e\u{301}"]);
        let size = [json!(96), json!(1), json!(2000), json!(31.5)][rng.range(0, 3) as usize].clone();
        let pos = [json!([0, 0]), json!([120, -40.5])][rng.range(0, 1) as usize].clone();
        let keys = if rng.range(0, 2) == 0 {
            json!([{ "t": 0, "v": 50, "ease": "linear" }, { "t": d - frame, "v": 20, "ease": "hold" }])
        } else {
            Json::Null
        };
        let clip = text_clip(d, text, size, pos, keys);
        let id = rng.pick(&["fade", "rise", "typewriter"]);
        cases.push((clip, id, rng.range(0, 1) == 1));
    }
    let calls: Vec<Json> = cases
        .iter()
        .map(|(c, id, out)| json!(["presetApply", serde_json::to_value(c).unwrap(), "l1", id, out, frame]))
        .collect();
    let got = ask(&calls);
    for ((c, id, out), g) in cases.iter().zip(&got) {
        let mine = serde_json::to_value(presets::apply(c, "l1", id, *out, frame).expect("a preset")).unwrap();
        assert!(same(&mine, g), "{id} out {out} on {}: {mine} != {g}", serde_json::to_value(c).unwrap());
    }
}

#[test]
fn the_folder_search_matches_find_js() {
    let dir = std::env::temp_dir().join(format!("cut-app-findmedia-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let files = [
        ("a.mp4", 10),
        ("deep/b.MP4", 20),
        ("deep/er/a.mp4", 30),
        ("x/y/z/c.wav", 5),
        ("x/b.mp4", 21),
        ("한글/가.mov", 7),
        ("1/2/3/4/5/6/7/8/9/far.mp4", 1),
        ("1/2/3/4/5/6/7/8/near.mp4", 1),
    ];
    for (name, n) in files {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![0u8; n]).unwrap();
    }
    let wanted: Vec<Vec<(String, Option<u64>)>> = vec![
        vec![("a.mp4".into(), Some(30)), ("b.mp4".into(), None), ("가.MOV".into(), Some(7))],
        vec![("b.mp4".into(), Some(21)), ("c.wav".into(), Some(4)), ("missing.mp4".into(), None)],
        vec![("far.mp4".into(), None), ("near.mp4".into(), None), (String::new(), None)],
        vec![("A.MP4".into(), None), ("a.mp4".into(), Some(10))],
        vec![],
    ];
    let folder = dir.to_string_lossy().into_owned();
    let mut calls: Vec<Json> = wanted
        .iter()
        .map(|w| {
            let list: Vec<Json> = w.iter().map(|(n, s)| json!({ "name": n, "size": s })).collect();
            json!(["findMedia", folder, list])
        })
        .collect();
    calls.push(json!(["findMedia", dir.join("a.mp4").to_string_lossy(), []]));
    let got = ask(&calls);
    for (w, g) in wanted.iter().zip(&got) {
        let mine = relink::find_media(&dir, w).expect("a folder");
        let mine: serde_json::Map<String, Json> =
            mine.into_iter().map(|(k, v)| (k, json!(v.to_string_lossy().to_lowercase()))).collect();
        let theirs: serde_json::Map<String, Json> = g
            .as_object()
            .expect("found")
            .iter()
            .map(|(k, v)| (k.clone(), json!(v.as_str().unwrap_or("").to_lowercase())))
            .collect();
        assert_eq!(mine, theirs, "findMedia({w:?})");
    }
    assert!(relink::find_media(&dir.join("a.mp4"), &[]).is_err() && got.last().unwrap()["error"].is_string());
    let _ = std::fs::remove_dir_all(&dir);
}
