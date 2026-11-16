//! Pictures the engine draws, read back and checked pixel by pixel: the right frame at the right time (test videos
//! whose frames show their number as blocks, made by cut-decode's test generator), opacity, motion, transitions,
//! masks, nests, text, offline media and colour effects against the JavaScript's CPU reference.

mod common;
#[path = "../../cut-decode/tests/common/mod.rs"]
#[allow(unused_imports)]
mod decode_common;

use std::time::Duration;

use common::*;
use cut_decode::Codec;
use cut_engine::{Engine, RenderOptions};
use cut_model::{Id, MediaKind, Project, Props, Source};
use serde_json::{Value as Json, json};

const WAIT: RenderOptions = RenderOptions {
    quality: 1.0,
    captions: cut_engine::Captions::None,
    wait: Some(Duration::from_secs(20)),
    proxy: false,
};

fn engine() -> Engine {
    Engine::headless().expect("a GPU")
}

/// Renders `s1` at `t` at the sequence's size and returns the RGBA pixels.
fn shot(e: &mut Engine, p: &Project, t: i64, size: (u32, u32)) -> Vec<u8> {
    let r = e.render(p, Id::new("s1"), t, size, &WAIT).expect("a render");
    assert!(r.complete, "every frame came");
    e.read_pixels()
}

fn px(img: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [img[i], img[i + 1], img[i + 2], img[i + 3]]
}

fn near(a: [u8; 4], b: [u8; 4], tol: i32, what: &str) {
    assert!(a.iter().zip(&b).all(|(x, y)| (i32::from(*x) - i32::from(*y)).abs() <= tol), "{what}: {a:?} vs {b:?}");
}

/// The frame number the test picture's blocks show in a rendered `w` x `h` picture of it.
fn number(img: &[u8], w: u32, h: u32) -> u32 {
    let (top, height, block) = (h / 20, h / 10, w / 16);
    (0..16).fold(0, |n, k| {
        let p = px(img, w, k * block + block / 2, top + height / 2);
        (n << 1) | u32::from(p[1] > 128)
    })
}

fn test_video() -> std::path::PathBuf {
    decode_common::make::video(
        "engine-h264-320x180.mp4",
        &decode_common::make::settings(Codec::H264, 320, 180),
        90,
        decode_common::make::Timing::Constant,
    )
}

fn video_project() -> (Project, Id) {
    let path = test_video();
    let mut p = project(320, 180);
    let m = media(&mut p, "m1", path.to_str().expect("a path"), MediaKind::Video, 320.0, 180.0, (3 * SEC) as f64);
    (p, m)
}

#[test]
fn the_right_frame_at_the_right_time() {
    let (mut p, m) = video_project();
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, (3 * SEC) as f64, of_media(m)));
    let mut fast = clip("c2", "V1", 3 * SEC, 0.0, (3 * SEC) as f64, of_media(m));
    fast.speed = 2.0;
    put(&mut p, "s1", fast);
    let mut back = clip("c3", "V1", 5 * SEC, 0.0, (3 * SEC) as f64, of_media(m));
    back.reverse = true;
    put(&mut p, "s1", back);
    let (p, _) = reload(&p);
    let mut e = engine();
    for n in [0, 45, 10, 89, 30, 31, 32, 0] {
        let img = shot(&mut e, &p, n * F, (320, 180));
        assert_eq!(number(&img, 320, 180), n as u32, "frame {n}");
    }
    for n in [0, 10, 44] {
        let img = shot(&mut e, &p, 3 * SEC + n * F, (320, 180));
        assert_eq!(number(&img, 320, 180), (2 * n) as u32, "double speed, frame {n}");
    }
    for n in [0, 30, 89] {
        let img = shot(&mut e, &p, 5 * SEC + n * F, (320, 180));
        assert_eq!(number(&img, 320, 180), (89 - n) as u32, "reversed, frame {n}");
    }
    let img = shot(&mut e, &p, 45 * F, (640, 480));
    write_png("frame-45-letterboxed.png", &img, 640, 480);
    near(px(&img, 640, 320, 10), [0, 0, 0, 255], 0, "letterbox bar");
}

#[test]
fn a_frame_not_decoded_yet_does_not_block() {
    let (mut p, m) = video_project();
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, (3 * SEC) as f64, of_media(m)));
    let (p, _) = reload(&p);
    let mut e = engine();
    let woke = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let w2 = woke.clone();
    e.set_waker(move || {
        w2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    });
    let opts = RenderOptions::default();
    let first = e.render(&p, Id::new("s1"), 60 * F, (320, 180), &opts).expect("a render");
    // Not complete is the proof it did not wait: its time also holds the first file open and pipeline builds, which
    // a busy machine stretches past any bound (790 ms seen with builds running).
    assert!(!first.complete, "the first render does not wait for the decoder (returned in {:?})", first.cpu);
    let start = std::time::Instant::now();
    loop {
        let r = e.render(&p, Id::new("s1"), 60 * F, (320, 180), &opts).expect("a render");
        if r.complete {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(20), "the frame came");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(woke.load(std::sync::atomic::Ordering::Relaxed) > 0, "the waker was called");
    assert_eq!(number(&e.read_pixels(), 320, 180), 60);
    // a seek: the frame shown meanwhile is the nearest decoded one, then the right one
    let r = e.render(&p, Id::new("s1"), 20 * F, (320, 180), &opts).expect("a render");
    if !r.complete {
        assert_eq!(number(&e.read_pixels(), 320, 180), 60, "the nearest frame there is, while decoding");
    }
    assert_eq!(number(&shot(&mut e, &p, 20 * F, (320, 180)), 320, 180), 20);
}

#[test]
fn opacity_mixes_two_colours_in_linear_light() {
    let mut p = project(64, 36);
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, SEC as f64, solid("#ff0000")));
    let mut top = clip("c2", "V2", 0, 0.0, SEC as f64, solid("#0000ff"));
    if let Props::Video(v) = &mut top.props {
        v.opacity = 50.0;
    }
    put(&mut p, "s1", top);
    let (p, _) = reload(&p);
    let img = shot(&mut engine(), &p, 0, (64, 36));
    // 0.5 linear red + 0.5 linear blue, encoded to sRGB: 0.7354 x 255
    near(px(&img, 64, 32, 18), [188, 0, 188, 255], 1, "50% blue over red");
}

/// A 64 x 64 PNG: red, green / blue, white quarters.
fn quarters() -> std::path::PathBuf {
    let mut rgba = Vec::new();
    for y in 0..64 {
        for x in 0..64 {
            rgba.extend(match (x < 32, y < 32) {
                (true, true) => [255, 0, 0, 255],
                (false, true) => [0, 255, 0, 255],
                (true, false) => [0, 0, 255, 255],
                (false, false) => [255, 255, 255, 255],
            });
        }
    }
    write_png("quarters.png", &rgba, 64, 64)
}

#[test]
fn rotation_scale_position_and_crop_place_the_picture() {
    let path = quarters();
    let mut p = project(64, 64);
    let m = media(&mut p, "m1", path.to_str().expect("a path"), MediaKind::Image, 64.0, 64.0, 0.0);
    let mut c = clip("c1", "V1", 0, 0.0, SEC as f64, of_media(m));
    if let Props::Video(v) = &mut c.props {
        v.rotation = 90.0;
    }
    put(&mut p, "s1", c);
    let mut q = clip("c2", "V1", SEC, 0.0, SEC as f64, of_media(m));
    if let Props::Video(v) = &mut q.props {
        v.rotation = 90.0;
        v.scale = [50.0, 50.0];
        v.position = [16.0, -16.0];
    }
    put(&mut p, "s1", q);
    let mut cropped = clip("c3", "V1", 2 * SEC, 0.0, SEC as f64, of_media(m));
    if let Props::Video(v) = &mut cropped.props {
        v.crop = [0.0, 50.0, 0.0, 0.0];
    }
    put(&mut p, "s1", cropped);
    let (p, _) = reload(&p);
    let mut e = engine();
    let img = shot(&mut e, &p, 0, (64, 64));
    write_png("quarters-rotated.png", &img, 64, 64);
    near(px(&img, 64, 48, 16), [255, 0, 0, 255], 0, "red, top left, turned to the top right");
    near(px(&img, 64, 48, 48), [0, 255, 0, 255], 0, "green, top right, turned to the bottom right");
    near(px(&img, 64, 16, 48), [255, 255, 255, 255], 0, "white, bottom right, turned to the bottom left");
    near(px(&img, 64, 16, 16), [0, 0, 255, 255], 0, "blue, bottom left, turned to the top left");
    let img = shot(&mut e, &p, SEC, (64, 64));
    write_png("quarters-rotated-quarter.png", &img, 64, 64);
    near(px(&img, 64, 40, 8), [0, 0, 255, 255], 0, "the quarter in the top right corner: blue at its top left");
    near(px(&img, 64, 56, 8), [255, 0, 0, 255], 0, "red at its top right");
    near(px(&img, 64, 56, 24), [0, 255, 0, 255], 0, "green at its bottom right");
    near(px(&img, 64, 16, 48), [0, 0, 0, 255], 0, "the rest is the background");
    let img = shot(&mut e, &p, 2 * SEC, (64, 64));
    near(px(&img, 64, 16, 16), [255, 0, 0, 255], 0, "crop right 50%: the left half stays");
    near(px(&img, 64, 48, 16), [0, 0, 0, 255], 0, "crop right 50%: the right half goes");
}

#[test]
fn a_dissolve_half_way() {
    let mut p = project(64, 36);
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, SEC as f64, solid("#ff0000")));
    put(&mut p, "s1", clip("c2", "V1", SEC, 0.0, SEC as f64, solid("#0000ff")));
    p.sequence_mut(Id::new("s1")).expect("s1").transitions.push(
        serde_json::from_value(json!({ "id": "t1", "track": "V1", "at": SEC, "type": "dissolve", "duration": 10 * F, "align": "center", "params": {} }))
            .expect("a transition"),
    );
    let (p, _) = reload(&p);
    let mut e = engine();
    near(px(&shot(&mut e, &p, SEC, (64, 36)), 64, 32, 18), [188, 0, 188, 255], 1, "half way");
    near(px(&shot(&mut e, &p, SEC - 5 * F, (64, 36)), 64, 32, 18), [255, 0, 0, 255], 1, "at its start");
}

#[test]
fn masks_nests_text_and_offline_media() {
    let mut p = project(320, 180);
    let mut c = clip("c1", "V1", 0, 0.0, SEC as f64, solid("#ffffff"));
    let path = cut_model::masks::ellipse(320.0, 180.0, cut_model::masks::Place { cx: 0.5, cy: 0.5, size: Some(50.0) });
    c.masks = Some(vec![serde_json::from_value(json!({ "id": "m1", "mode": "add", "inverted": false, "path": path, "feather": 0, "opacity": 100, "expansion": 0 })).expect("a mask")]);
    put(&mut p, "s1", c);
    let mut s2 = cut_model::defaults::sequence(
        Id::new("s2"),
        &cut_model::defaults::SequenceOpts { w: 160, h: 90, video_tracks: 1, audio_tracks: 0, ..Default::default() },
    );
    s2.insert_clip(clip("n1", "V1", 0, 0.0, SEC as f64, solid("#00ff00")), None);
    p.sequences.push(s2);
    let mut nest =
        clip("c2", "V2", SEC, 0.0, SEC as f64, Source::Nest { sequence: Id::new("s2"), extra: Default::default() });
    if let Props::Video(v) = &mut nest.props {
        v.scale = [50.0, 50.0];
    }
    put(&mut p, "s1", nest);
    let mut layer = cut_model::defaults::text_layer(&Default::default());
    layer["text"] = json!("Cut 한국어");
    layer["size"] = json!(48);
    let text = Source::Generator {
        generator: cut_model::Generator::Text,
        layers: Some(vec![layer]),
        color: None,
        extra: Default::default(),
    };
    put(&mut p, "s1", clip("c3", "V1", 2 * SEC, 0.0, SEC as f64, text));
    let missing = media(&mut p, "m9", "Z:/nowhere/gone.mp4", MediaKind::Video, 320.0, 180.0, (3 * SEC) as f64);
    put(&mut p, "s1", clip("c4", "V1", 3 * SEC, 0.0, SEC as f64, of_media(missing)));
    let (p, _) = reload(&p);
    let mut e = engine();

    let img = shot(&mut e, &p, 0, (320, 180));
    write_png("mask-ellipse.png", &img, 320, 180);
    near(px(&img, 320, 160, 90), [255, 255, 255, 255], 0, "inside the mask");
    near(px(&img, 320, 160, 90 - 45), [255, 255, 255, 255], 0, "inside the mask, near its edge (radius 50)");
    near(px(&img, 320, 160, 90 - 55), [0, 0, 0, 255], 0, "outside the mask");
    near(px(&img, 320, 10, 10), [0, 0, 0, 255], 0, "far outside the mask");

    let img = shot(&mut e, &p, SEC, (320, 180));
    write_png("nest.png", &img, 320, 180);
    near(px(&img, 320, 160, 90), [0, 255, 0, 255], 0, "the nested sequence, fitted and at 50%");
    near(px(&img, 320, 10, 10), [0, 0, 0, 255], 0, "around the nest");
    // 160 x 90 fitted to 320 x 180 is 320 x 180, at 50% 160 x 90 in the middle
    near(px(&img, 320, 81, 46), [0, 255, 0, 255], 0, "the nest's corner inside");
    near(px(&img, 320, 78, 43), [0, 0, 0, 255], 0, "the nest's corner outside");

    let img = shot(&mut e, &p, 2 * SEC, (320, 180));
    write_png("text.png", &img, 320, 180);
    let lit = (0..180)
        .flat_map(|y| (0..320).map(move |x| (x, y)))
        .filter(|&(x, y)| px(&img, 320, x, y)[0] > 200)
        .collect::<Vec<_>>();
    assert!(lit.len() > 400, "the text is drawn ({} white pixels)", lit.len());
    let (x0, x1) = (lit.iter().map(|p| p.0).min().unwrap_or(0), lit.iter().map(|p| p.0).max().unwrap_or(0));
    let (y0, y1) = (lit.iter().map(|p| p.1).min().unwrap_or(0), lit.iter().map(|p| p.1).max().unwrap_or(0));
    eprintln!("text box: x {x0}..{x1}, y {y0}..{y1}");
    assert!((i64::from(x0 + x1) - 320).abs() <= 8 && (i64::from(y0 + y1) - 180).abs() <= 16, "the block is centred");

    let r = e.render(&p, Id::new("s1"), 3 * SEC, (320, 180), &WAIT).expect("a render");
    assert_eq!(r.failed.len(), 1, "one item failed");
    assert!(r.failed[0].missing && r.failed[0].clip == Id::new("c4"));
    let img = e.read_pixels();
    write_png("offline.png", &img, 320, 180);
    near(px(&img, 320, 5, 5), [0xc6, 0x28, 0x28, 255], 1, "the red slate");
}

/// A flat colour through an effect: the GPU's pixel against the JavaScript's CPU reference, encoded to 8 bits.
#[test]
fn colour_effects_match_the_javascript_reference() {
    let (w, h) = (64, 36);
    let cases: Vec<(&str, Json)> = vec![
        ("color.basic", json!({ "exposure": 0.5, "contrast": 20, "saturation": 130, "temperature": 30, "tint": -10 })),
        ("color.basic", json!({ "highlights": -40, "shadows": 35, "whites": 10, "blacks": -20, "vibrance": 50 })),
        ("color.basic", json!({ "curveMaster": [0, 0, 0.4, 0.6, 1, 1], "curveRed": [0, 0.1, 1, 0.9] })),
        (
            "color.basic",
            json!({ "hslHue": 30, "hslHueRange": 60, "hslSaturation": 150, "hslHueShift": 20, "hslTemperature": 30 }),
        ),
        ("color.basic", json!({ "lut": "LUT", "lutIntensity": 80 })),
        ("color.brightnessContrast", json!({ "brightness": 30, "contrast": -40 })),
        ("color.invert", json!({ "amount": 70 })),
        ("color.hue", json!({ "hue": 120 })),
        ("color.tint", json!({ "black": "#102030", "white": "#ffeecc", "amount": 80 })),
        ("color.bw", json!({})),
        ("posterize", json!({ "levels": 4 })),
        ("key.chroma", json!({ "color": "#996633", "similarity": 10, "smoothness": 20 })),
        ("vignette", json!({ "amount": 0 })),
    ];
    let cube = {
        let mut s = String::from("LUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    s += &format!(
                        "{} {} {}\n",
                        0.1 + 0.8 * f64::from(g),
                        0.2 + 0.6 * f64::from(b),
                        0.9 - 0.7 * f64::from(r)
                    );
                }
            }
        }
        s
    };
    let lut = cut_engine::lumetri::parse_cube(&cube).expect("a cube");
    let (lut_id, entry) = cut_engine::lumetri::store(&lut, "test");
    let colours = ["#996633", "#2080c0", "#e0e0e0", "#101010"];
    let mut calls = Vec::new();
    let mut p = project(w, h);
    p.luts = Some(json!({ lut_id.clone(): entry }));
    for (i, (kind, params)) in cases.iter().enumerate() {
        for (k, c) in colours.iter().enumerate() {
            let n = (i * colours.len() + k) as i64;
            let mut clip = clip(&format!("c{n}"), "V1", n * F, 0.0, F as f64, solid(c));
            let mut params = params.clone();
            if params.get("lut").is_some() {
                params["lut"] = json!(lut_id);
            }
            clip.effects.push(effect("e1", kind, params.clone()));
            put(&mut p, "s1", clip);
            let lin = cut_engine::color::hex_to_linear(c, [0.0; 4]);
            calls.push(
                json!(["effectCpu", kind, params, [lin[0], lin[1], lin[2], 1.0], 1, 1, { "assets": { "lut": null } }]),
            );
            if kind == &"color.basic" {
                let last = calls.len() - 1;
                calls[last] = json!([
                    "lumetriPixel",
                    params,
                    [lin[0], lin[1], lin[2]],
                    if params.get("lut").is_some() { cube.clone() } else { String::new() }
                ]);
            }
        }
    }
    let (p, _) = reload(&p);
    let want = cut_oracle::ask("scenario/engine", &calls);
    let mut e = engine();
    let mut worst = 0;
    for (n, want) in want.iter().enumerate() {
        let img = shot(&mut e, &p, n as i64 * F, (w as u32, h as u32));
        let got = px(&img, w as u32, 32, 18);
        let v: Vec<f64> = want.as_array().expect("pixels").iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
        // premultiplied linear over the black background, then sRGB as the final pass encodes it
        let enc = |c: f64| (cut_engine::color::linear_to_srgb(c.clamp(0.0, 1.0)) * 255.0).round() as u8;
        let exp = [enc(v[0]), enc(v[1]), enc(v[2]), 255];
        for k in 0..3 {
            worst = worst.max((i32::from(got[k]) - i32::from(exp[k])).abs());
        }
        near(got, exp, 1, &format!("{}", calls[n]));
    }
    eprintln!("{} colour cases, worst difference {worst} of 255", want.len());
}

#[test]
fn captions_are_burned_in_near_the_bottom() {
    let mut p = project(640, 360);
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, (2 * SEC) as f64, solid("#204060")));
    let track = json!({ "id": "k1", "lang": "ko", "name": "Captions", "style": cut_model::defaults::default_caption_style(), "syncLock": true,
        "items": [{ "id": "i1", "start": 0, "end": SEC, "text": "자막 둘째 줄\nsecond line" },
                  { "id": "i2", "start": SEC, "end": 2 * SEC, "text": "lit words here",
                    "words": [{ "t0": 0, "t1": 10 * F, "text": "lit" }, { "t0": 10 * F, "t1": 20 * F, "text": "words" }, { "t0": 20 * F, "t1": SEC, "text": "here" }] }] });
    p.sequence_mut(Id::new("s1")).expect("s1").captions.push(serde_json::from_value(track).expect("a caption track"));
    if let Some(s) = p.sequence_mut(Id::new("s1")) {
        s.captions[0].style.insert("highlight".into(), json!(true));
    }
    let (p, _) = reload(&p);
    let mut e = engine();
    let opts = RenderOptions { captions: cut_engine::Captions::First, ..WAIT };
    e.render(&p, Id::new("s1"), F, (640, 360), &opts).expect("a render");
    let img = e.read_pixels();
    write_png("captions.png", &img, 640, 360);
    let white = |y0: u32, y1: u32| {
        (y0..y1).flat_map(|y| (0..640).map(move |x| (x, y))).filter(|&(x, y)| px(&img, 640, x, y)[0] > 220).count()
    };
    assert!(white(260, 345) > 200, "two lines of white text above the bottom margin");
    assert_eq!(white(0, 200), 0, "nothing at the top");
    let none = e.render(&p, Id::new("s1"), F, (640, 360), &WAIT).expect("a render");
    assert!(none.complete);
    let plain = e.read_pixels();
    assert_eq!(
        (0..360).flat_map(|y| (0..640).map(move |x| (x, y))).filter(|&(x, y)| px(&plain, 640, x, y)[0] > 220).count(),
        0,
        "no captions unless asked"
    );
    e.render(&p, Id::new("s1"), SEC + 12 * F, (640, 360), &opts).expect("a render");
    let img = e.read_pixels();
    write_png("captions-lit.png", &img, 640, 360);
    let yellow = (0..360).flat_map(|y| (0..640).map(move |x| (x, y))).filter(|&(x, y)| {
        let p = px(&img, 640, x, y);
        p[0] > 200 && p[1] > 170 && p[2] < 120
    });
    let xs: Vec<u32> = yellow.map(|(x, _)| x).collect();
    assert!(xs.len() > 50, "the lit word is yellow");
    let mid = xs.iter().sum::<u32>() / xs.len() as u32;
    assert!((280..360).contains(&mid), "the middle word is lit (yellow around x {mid})");
}

#[test]
fn the_gpus_scopes_count_what_the_cpu_counts() {
    let path = quarters();
    let mut p = project(64, 36);
    let m = media(&mut p, "m1", path.to_str().expect("a path"), MediaKind::Image, 64.0, 64.0, 0.0);
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, SEC as f64, of_media(m)));
    let (p, _) = reload(&p);
    let mut e = engine();
    for (size, budget) in [((200, 150), 262_144), ((640, 360), 1000)] {
        shot(&mut e, &p, 0, size);
        let img = e.read_pixels();
        assert!(e.scopes(256, 256, budget).is_none(), "the counts are not back the moment they are asked for");
        let _ = e.device().poll(wgpu::PollType::wait_indefinitely());
        let (gpu, layout, rect, step) = e.scopes(256, 256, budget).expect("counts");
        let (cpu, _) = cut_engine::scopes::analyze(&img, size.0, rect, 256, 256, step);
        assert_eq!(gpu.len(), layout.total as usize);
        assert!(gpu == cpu, "GPU and CPU bins differ at {size:?}");
        assert!(gpu[layout.hist as usize..].iter().sum::<u32>() > 0, "something was counted");
    }
}

#[test]
fn a_proxy_plays_in_place_of_its_file() {
    let path = test_video();
    let mut p = project(320, 180);
    let m = media(&mut p, "m1", "Z:/original/gone.mp4", MediaKind::Video, 320.0, 180.0, (3 * SEC) as f64);
    p.media[0].proxy =
        Some(serde_json::from_value(json!({ "path": path.to_str().expect("a path") })).expect("a proxy"));
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, (3 * SEC) as f64, of_media(m)));
    let (p, _) = reload(&p);
    let mut e = engine();
    let with = RenderOptions { proxy: true, ..WAIT };
    let r = e.render(&p, Id::new("s1"), 12 * F, (320, 180), &with).expect("a render");
    assert!(r.failed.is_empty() && r.complete);
    assert_eq!(number(&e.read_pixels(), 320, 180), 12, "the proxy's frame");
    let r = e.render(&p, Id::new("s1"), 12 * F, (320, 180), &WAIT).expect("a render");
    assert!(r.failed.first().is_some_and(|f| f.missing), "without proxies the original is offline");
}

#[test]
fn captions_are_drawn_off_the_render_thread() {
    let mut p = project(1920, 1080);
    put(&mut p, "s1", clip("c1", "V1", 0, 0.0, (4 * SEC) as f64, solid("#204060")));
    let track = json!({ "id": "k1", "lang": "ko", "name": "Captions", "style": cut_model::defaults::default_caption_style(), "syncLock": true,
        "items": [{ "id": "i1", "start": 0, "end": SEC, "text": "자막 첫째 줄\nfirst line" },
                  { "id": "i2", "start": SEC, "end": 4 * SEC, "text": "another caption" }] });
    p.sequence_mut(Id::new("s1")).expect("s1").captions.push(serde_json::from_value(track).expect("a caption track"));
    let (p, _) = reload(&p);
    let mut e = engine();
    e.warm_text();
    let opts = RenderOptions { captions: cut_engine::Captions::First, ..Default::default() };
    // pipelines and the first frame's textures made outside what is timed
    e.render(&p, Id::new("s1"), 0, (1920, 1080), &RenderOptions { captions: cut_engine::Captions::None, ..WAIT })
        .expect("a render");
    let mut worst = Duration::ZERO;
    for t in [0, SEC + F] {
        let first = e.render(&p, Id::new("s1"), t, (1920, 1080), &opts).expect("a render");
        worst = worst.max(first.cpu);
        assert!(!first.complete, "a new caption is not waited for");
        let start = std::time::Instant::now();
        loop {
            let r = e.render(&p, Id::new("s1"), t, (1920, 1080), &opts).expect("a render");
            worst = worst.max(r.cpu);
            if r.complete {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(20), "the caption came");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let img = e.read_pixels();
    let white =
        (900..1040).flat_map(|y| (0..1920).map(move |x| (x, y))).filter(|&(x, y)| px(&img, 1920, x, y)[0] > 220);
    assert!(white.count() > 200, "the second caption shows");
    eprintln!("slowest render with a 1080p caption on the way: {worst:?}");
}
