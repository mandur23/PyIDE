//! Burned-in captions with speaker labels: how a caption shows its speaker (`plan::shown`) against speakers.js's own
//! `shown` (through `tools/scenarios/speakers.cjs`) on random labels, styles and items, nasty ones included (no list,
//! an unknown or empty speaker, empty names and colours, numbers and nulls where strings belong); then the engine's
//! picture: the speaker's name before the first line and the line in the speaker's colour, the lit word still the
//! word spoken (the name never lit), nothing of it on a track that shows no speakers.

mod common;

use std::time::Duration;

use common::*;
use cut_engine::{Engine, RenderOptions, plan};
use cut_model::Id;
use cut_oracle::Inputs;
use serde_json::{Map, Value as Json, json};

#[test]
fn shown_matches_the_javascript() {
    let mut rng = Inputs::new(23);
    let names = [json!("Mina"), json!(""), json!(null), json!(7), json!("민수")];
    let colors = [json!("#4fc3f7"), json!(""), json!(null), json!("#ffb74d")];
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for _ in 0..400 {
        let n = rng.range(0, 4) as usize;
        let list: Vec<Json> = (0..n)
            .map(|k| {
                let mut s = json!({ "id": format!("sp{}", k + 1) });
                if rng.range(0, 4) > 0 {
                    s["name"] = names[rng.range(0, 4) as usize].clone();
                }
                if rng.range(0, 4) > 0 {
                    s["color"] = colors[rng.range(0, 3) as usize].clone();
                }
                s
            })
            .collect();
        let sp = match rng.range(0, 5) {
            0 => Json::Null,
            1 => json!({ "list": [] }),
            _ => json!({ "list": list, "turns": {} }),
        };
        let flag = |r: &mut Inputs| {
            [json!(true), json!(false), json!(1), json!(""), json!(null)][r.range(0, 4) as usize].clone()
        };
        let mut style = Map::new();
        style.insert("speakerName".into(), flag(&mut rng));
        style.insert("speakerColor".into(), flag(&mut rng));
        let speaker = ["sp1", "sp2", "sp3", "sp9", ""][rng.range(0, 4) as usize];
        let item = json!({ "id": "c1", "start": 0, "end": 10, "text": "hi", "speaker": speaker });
        let it: cut_model::Caption = serde_json::from_value(item.clone()).expect("an item");
        let s = plan::shown(sp.as_object().map(|_| &sp), &style, &it, "Speaker {n}");
        ours.push(json!({ "prefix": s.prefix, "color": s.color }));
        calls.push(json!(["shown", sp, style, item]));
    }
    let theirs = cut_oracle::ask("scenario/speakers", &calls);
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        assert_eq!(a, b, "#{i}: {}", calls[i]);
    }
    eprintln!("{} shown cases compared", ours.len());
}

const WAIT: RenderOptions = RenderOptions {
    quality: 1.0,
    captions: cut_engine::Captions::First,
    wait: Some(Duration::from_secs(20)),
    proxy: false,
};

/// The caption area's pixels in the speaker's sky blue, the white ones, and the leftmost and rightmost drawn.
fn census(img: &[u8]) -> (usize, usize, u32, u32) {
    let (mut blue, mut white, mut lo, mut hi) = (0, 0, u32::MAX, 0);
    for y in 250..350 {
        for x in 0..640u32 {
            let i = ((y * 640 + x) * 4) as usize;
            let (r, g, b) = (img[i], img[i + 1], img[i + 2]);
            if r < 140 && g > 160 && b > 200 {
                blue += 1;
            }
            if r > 220 && g > 220 && b > 220 {
                white += 1;
            }
            if r > 120 || g > 120 || b > 160 {
                lo = lo.min(x);
                hi = hi.max(x);
            }
        }
    }
    (blue, white, lo, hi)
}

#[test]
fn burned_in_captions_show_the_speakers_name_and_colour() {
    let shot = |style: Json| {
        let mut p = project(640, 360);
        put(&mut p, "s1", clip("c1", "V1", 0, 0.0, (2 * SEC) as f64, solid("#000000")));
        p.speakers =
            Some(json!({ "list": [{ "id": "sp1", "name": "", "color": "#4fc3f7" }], "turns": {}, "count": 0 }));
        let mut st = cut_model::defaults::default_caption_style();
        st.extend(style.as_object().unwrap().clone());
        st.insert("background".into(), Json::Null);
        let track = json!({ "id": "k1", "lang": "en", "name": "Captions", "style": st, "syncLock": true,
            "items": [{ "id": "i1", "start": 0, "end": 2 * SEC, "text": "hello there", "speaker": "sp1",
                        "words": [{ "t0": 0, "t1": SEC, "text": "hello" }, { "t0": SEC, "t1": 2 * SEC, "text": "there" }] }] });
        p.sequence_mut(Id::new("s1")).unwrap().captions.push(serde_json::from_value(track).unwrap());
        let (p, _) = reload(&p);
        let mut e = Engine::headless().expect("a GPU");
        e.set_speaker_label("화자 {n}");
        e.render(&p, Id::new("s1"), F, (640, 360), &WAIT).expect("a render");
        e.read_pixels()
    };
    let plain = census(&shot(json!({})));
    let coloured = shot(json!({ "speakerColor": true }));
    write_png("speaker-colour.png", &coloured, 640, 360);
    let coloured = census(&coloured);
    let named = shot(json!({ "speakerColor": true, "speakerName": true }));
    write_png("speaker-name.png", &named, 640, 360);
    let named = census(&named);
    assert!(plain.0 == 0 && plain.1 > 100, "no speaker style: white text, no blue: {plain:?}");
    assert!(coloured.0 > 100 && coloured.1 < plain.1 / 10, "the line in the speaker's colour: {coloured:?}");
    assert!(
        named.2 + 20 < coloured.2 && named.3 > coloured.3 + 20,
        "the name widens the line both ways: {named:?} {coloured:?}"
    );
    let lit = shot(json!({ "speakerName": true, "highlight": true }));
    write_png("speaker-lit.png", &lit, 640, 360);
    let yellow: Vec<u32> = (250..350u32)
        .flat_map(|y| (0..640u32).map(move |x| (x, y)))
        .filter(|&(x, y)| {
            let i = ((y * 640 + x) * 4) as usize;
            lit[i] > 200 && lit[i + 1] > 170 && lit[i + 2] < 120
        })
        .map(|(x, _)| x)
        .collect();
    assert!(yellow.len() > 30, "a word is lit");
    let mid = yellow.iter().sum::<u32>() / yellow.len() as u32;
    assert!(mid > 300, "the lit word is \"hello\" after the name, not the name (yellow around x {mid})");
}
