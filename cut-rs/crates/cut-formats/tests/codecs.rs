//! `cut_formats::codecs` and the shared helpers against `renderer/features/cut/codecs.js`: every record parsed and
//! built, on the records of the JavaScript tests' files and on mangled and random bytes.

mod common;

use common::{diff, records};
use cut_formats::codecs::audio::*;
use cut_formats::codecs::avc::*;
use cut_formats::codecs::hevc::*;
use cut_formats::codecs::pcm::pcm_to_float;
use cut_formats::codecs::vpx::*;
use cut_formats::codecs::*;
use cut_formats::{ColorSpace, Result, bits, table};
use cut_oracle::{Inputs, ask, bytes};
use serde::Serialize;
use serde_json::{Value, json};

fn res<T: Serialize>(r: Result<T>) -> Value {
    match r {
        Ok(v) => serde_json::to_value(v).expect("serializes"),
        Err(e) => json!({ "$error": e.detail }),
    }
}

fn compare(calls: &[Value], ours: &[Value]) {
    let theirs = ask("codecs", calls);
    let mut wrong = Vec::new();
    for ((call, a), b) in calls.iter().zip(ours).zip(&theirs) {
        if let Some(d) = diff(a, b, "") {
            let mut c = call.to_string();
            c.truncate(300);
            wrong.push(format!("{c}: {d}"));
        }
    }
    println!("{} calls compared", calls.len());
    assert!(
        wrong.is_empty(),
        "{} of {} calls differ:\n{}",
        wrong.len(),
        calls.len(),
        wrong[..wrong.len().min(20)].join("\n")
    );
}

/// Copies of `b`: cut short, with bits flipped, with bytes changed.
fn mangled(b: &[u8], rng: &mut Inputs, n: usize) -> Vec<Vec<u8>> {
    let mut out = vec![b.to_vec()];
    for k in 0..n {
        let mut x = b.to_vec();
        match k % 3 {
            0 => x.truncate(rng.range(0, b.len() as i64) as usize),
            1 if !x.is_empty() => {
                let i = rng.range(0, x.len() as i64 - 1) as usize;
                x[i] ^= 1 << rng.range(0, 7);
            }
            _ if !x.is_empty() => {
                let i = rng.range(0, x.len() as i64 - 1) as usize;
                x[i] = rng.range(0, 255) as u8;
            }
            _ => {}
        }
        out.push(x);
    }
    out
}

fn random(rng: &mut Inputs, max: i64) -> Vec<u8> {
    (0..rng.range(0, max)).map(|_| rng.range(0, 255) as u8).collect()
}

#[test]
fn h264_and_hevc_records_match_the_javascript() {
    let mut rng = Inputs::new(3);
    let (avc, hevc) = records();
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for rec in &avc {
        for b in mangled(rec, &mut rng, 60) {
            calls.push(json!(["parseAvcC", bytes(&b)]));
            ours.push(res(parse_avc_c(&b)));
        }
        let c = parse_avc_c(rec).expect("a good avcC");
        for sps in &c.sps {
            for b in mangled(sps, &mut rng, 120) {
                calls.push(json!(["parseAvcSps", bytes(&b)]));
                ours.push(res(parse_avc_sps(&b)));
                let pps: Vec<&[u8]> = c.pps.iter().map(Vec::as_slice).collect();
                if !b.is_empty() {
                    calls.push(json!(["buildAvcC", { "sps": [bytes(&b)], "pps": pps.iter().map(|p| bytes(p)).collect::<Vec<_>>(), "lengthSize": 4 }]));
                    ours.push(json!(build_avc_c(&[&b], &pps, 4)));
                }
            }
        }
        for entry in ["avc1", "avc3"] {
            calls
                .push(json!(["avcCodecString", { "profile": c.profile, "compat": c.compat, "level": c.level }, entry]));
            ours.push(json!(avc_codec_string(c.profile.into(), c.compat.into(), c.level.into(), entry)));
        }
    }
    for rec in &hevc {
        for b in mangled(rec, &mut rng, 60) {
            calls.push(json!(["parseHvcC", bytes(&b)]));
            ours.push(res(parse_hvc_c(&b)));
        }
        let c = parse_hvc_c(rec).expect("a good hvcC");
        for sps in &c.sps {
            for b in mangled(sps, &mut rng, 200) {
                calls.push(json!(["parseHevcSps", bytes(&b)]));
                ours.push(res(parse_hevc_sps(&b)));
                let (vps, pps): (Vec<&[u8]>, Vec<&[u8]>) =
                    (c.vps.iter().map(Vec::as_slice).collect(), c.pps.iter().map(Vec::as_slice).collect());
                if !b.is_empty() {
                    calls.push(json!(["buildHvcC", { "vps": vps.iter().map(|p| bytes(p)).collect::<Vec<_>>(), "sps": [bytes(&b)], "pps": pps.iter().map(|p| bytes(p)).collect::<Vec<_>>() }]));
                    ours.push(res(build_hvc_c(&vps, &[&b], &pps, 4)));
                }
            }
        }
        for entry in ["hvc1", "hev1"] {
            calls.push(json!(["hevcCodecString", serde_json::to_value(&c.ptl).unwrap(), entry]));
            ours.push(json!(hevc_codec_string(&c.ptl, entry)));
        }
    }
    for _ in 0..300 {
        let b = random(&mut rng, 40);
        calls.push(json!(["parseAvcSps", bytes(&b)]));
        ours.push(res(parse_avc_sps(&b)));
        calls.push(json!(["parseHevcSps", bytes(&b)]));
        ours.push(res(parse_hevc_sps(&b)));
        let ptl = Ptl {
            profile_space: rng.range(0, 3) as u64,
            tier: rng.range(0, 1) as u64,
            profile: rng.range(0, 31) as u64,
            compat: rng.range(0, u32::MAX.into()) as u64,
            constraints: [0; 6].map(|_| rng.pick(&[0, 0, 0x90, 0xb0, 1])),
            level: rng.range(0, 255) as u64,
        };
        calls.push(json!(["hevcCodecString", serde_json::to_value(&ptl).unwrap(), "hvc1"]));
        ours.push(json!(hevc_codec_string(&ptl, "hvc1")));
    }
    calls.push(json!(["unescapeRbsp", bytes(&[0, 0, 3, 1, 5, 0, 0, 3, 0, 0, 3])]));
    ours.push(json!(bits::unescape_rbsp(&[0, 0, 3, 1, 5, 0, 0, 3, 0, 0, 3])));
    compare(&calls, &ours);
}

#[test]
fn vp9_and_av1_records_match_the_javascript() {
    let mut rng = Inputs::new(4);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let good = [vec![0, 40, 0x82, 1, 1, 1, 0, 0], vec![2, 31, 0xa1, 9, 16, 9, 0, 0]];
    for g in &good {
        for b in mangled(g, &mut rng, 40) {
            for version in [0, 1] {
                calls.push(json!(["parseVpcC", bytes(&b), version]));
                ours.push(res(parse_vpc_c(&b, version)));
            }
        }
    }
    let keys: [&[u8]; 3] = [
        &[0x82, 0x49, 0x83, 0x42, 0x00, 0x13, 0xf0, 0x0b, 0x38],
        &[0xa2, 0x49, 0x83, 0x42, 0x20, 0x13, 0xf0, 0x0b, 0x38],
        &[0x86, 0, 0],
    ];
    for k in keys {
        for b in mangled(k, &mut rng, 60) {
            calls.push(json!(["parseVp9Frame", bytes(&b)]));
            ours.push(res(parse_vp9_frame(&b)));
        }
    }
    for _ in 0..300 {
        let b = random(&mut rng, 12);
        calls.push(json!(["parseVp9Frame", bytes(&b)]));
        ours.push(res(parse_vp9_frame(&b)));
        calls.push(json!(["parseAv1C", bytes(&b)]));
        let av1 = parse_av1_c(&b);
        if let Ok(c) = &av1 {
            calls.push(json!(["av1CodecString", serde_json::to_value(c).unwrap()]));
        }
        let s = av1.as_ref().ok().map(av1_codec_string);
        ours.push(res(av1));
        if let Some(s) = s {
            ours.push(json!(s));
        }
        let (p, l, d) = (rng.range(0, 3) as u64, rng.pick(&[0, 10, 31, 62]), rng.pick(&[0, 8, 10, 12]));
        calls.push(json!(["vp9CodecString", { "profile": p, "level": l, "bitDepth": d }]));
        ours.push(json!(vp9_codec_string(p, l, d)));
        let (w, h, fps) =
            (rng.range(16, 8192) as u32, rng.range(16, 4320) as u32, rng.pick(&[24.0, 29.97, 30.0, 60.0, 120.0]));
        calls.push(json!(["vp9Level", w, h, fps]));
        ours.push(json!(vp9_level(w, h, fps)));
    }
    compare(&calls, &ours);
}

#[test]
fn audio_records_match_the_javascript() {
    let mut rng = Inputs::new(5);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    for _ in 0..400 {
        let b = random(&mut rng, 6);
        calls.push(json!(["parseAudioSpecificConfig", bytes(&b)]));
        ours.push(res(parse_audio_specific_config(&b)));
        let ot = rng.pick(&[1, 2, 5, 29, 31, 40]);
        let rate = rng.pick(&[48000.0, 44100.0, 37800.0, 8000.0, 96000.0, 7350.0, 44100.5, 0.0]);
        let ch = rng.pick(&[0.0, 1.0, 2.0, 6.0, 7.0, 8.0, 9.0]);
        calls.push(json!(["buildAudioSpecificConfig", { "objectType": ot, "sampleRate": rate, "channels": ch }]));
        ours.push(json!(build_audio_specific_config(ot, rate, ch)));
    }
    let head: Vec<u8> = [&b"OpusHead"[..], &[1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]].concat();
    let multi: Vec<u8> =
        [&b"OpusHead"[..], &[1, 6, 0x38, 1, 0x80, 0xbb, 0, 0, 0xfe, 0xff, 1, 4, 2, 0, 4, 1, 2, 3, 5]].concat();
    for h in [&head, &multi] {
        for b in mangled(h, &mut rng, 60) {
            calls.push(json!(["parseOpusHead", bytes(&b)]));
            ours.push(res(parse_opus_head(&b)));
            calls.push(json!(["dOpsFromOpusHead", bytes(&b)]));
            ours.push(res(dops_from_opus_head(&b)));
            let d = &b[8.min(b.len())..];
            calls.push(json!(["opusHeadFromDOps", bytes(d)]));
            ours.push(res(opus_head_from_dops(d)));
        }
    }
    let streaminfo: Vec<u8> = [
        &b"fLaC"[..],
        &[0x80, 0, 0, 34, 0x10, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0xac, 0x44, 0x12, 0xf0, 0, 0, 0x10, 0],
        &[0; 16],
    ]
    .concat();
    for b in mangled(&streaminfo, &mut rng, 80) {
        calls.push(json!(["parseFlacStreamInfo", bytes(&b)]));
        ours.push(json!(parse_flac_stream_info(&b)));
    }
    compare(&calls, &ours);
}

#[test]
fn pcm_codec_strings_and_colour_match_the_javascript() {
    let mut rng = Inputs::new(6);
    let (mut calls, mut ours) = (Vec::new(), Vec::new());
    let codecs = [
        "pcm-u8",
        "pcm-s8",
        "pcm-s16",
        "pcm-s16be",
        "pcm-s24",
        "pcm-s24be",
        "pcm-s32",
        "pcm-s32be",
        "pcm-f32",
        "pcm-f32be",
        "pcm-f64",
        "pcm-f64be",
        "pcm-u16",
        "pcm-s64",
        "mp3",
    ];
    for codec in codecs {
        for ch in 1..=3 {
            let b = random(&mut rng, 100);
            calls.push(json!(["pcmToFloat", bytes(&b), codec, ch]));
            ours.push(match pcm_to_float(&b, codec, ch) {
                Ok(v) => {
                    json!(v.iter().map(|c| c.iter().map(|&x| f64::from(x)).collect::<Vec<_>>()).collect::<Vec<_>>())
                }
                Err(e) => json!({ "$error": e.detail }),
            });
        }
    }
    let strings = [
        "avc1.640028",
        "AVC3.64002A",
        "avc1.6400",
        "avc1.64002g",
        "hvc1.1.6.L93.B0",
        "HEV1.2",
        "vp09.00.40.08",
        "vp09.02.10.10.01",
        "vp09.0",
        "av01.0.08M.08",
        "mp4a.40.2",
        "mp4a.40.05",
        "mp4a.40.",
        "mp4a.67",
        "opus",
        "Opus",
        "flac",
        "",
    ];
    for s in strings {
        calls.push(json!(["parseCodecString", s]));
        ours.push(match parse_codec_string(s) {
            None => Value::Null,
            Some(CodecInfo::Avc { entry, profile, compat, level }) => {
                json!({ "family": "avc", "entry": entry, "profile": profile, "compat": compat, "level": level })
            }
            Some(CodecInfo::Hevc { entry }) => json!({ "family": "hevc", "entry": entry }),
            Some(CodecInfo::Vp9 { profile, level, bit_depth }) => {
                json!({ "family": "vp9", "entry": "vp09", "profile": profile, "level": level, "bitDepth": bit_depth })
            }
            Some(CodecInfo::Av1) => json!({ "family": "av1", "entry": "av01" }),
            Some(CodecInfo::Aac { object_type }) => {
                json!({ "family": "aac", "entry": "mp4a", "objectType": object_type })
            }
            Some(CodecInfo::Opus) => json!({ "family": "opus", "entry": "Opus" }),
        });
    }
    let code = |rng: &mut Inputs| rng.pick(&[-1, 0, 1, 2, 5, 6, 8, 9, 12, 13, 14, 15, 16, 18, 22]);
    let mut spaces: Vec<Option<ColorSpace>> = Vec::new();
    for _ in 0..200 {
        let (p, t, m) = (code(&mut rng), code(&mut rng), code(&mut rng));
        let full = rng.pick(&[None, Some(false), Some(true)]);
        calls.push(json!(["colorFromCodes", p, t, m, full.map(u8::from)]));
        let cs = color_from_codes(p, t, m, full);
        ours.push(json!(cs));
        spaces.push(cs);
    }
    for pair in spaces.chunks(2) {
        calls.push(json!(["codesFromColor", pair[0]]));
        ours.push(json!(codes_from_color(pair[0].as_ref())));
        calls.push(json!(["mergeColor", pair[0], pair[1]]));
        ours.push(json!(merge_color(pair[0], pair[1])));
    }
    for _ in 0..300 {
        let ticks = rng.pick(&[0.0, -5.0, 1.0, 1e3]) + rng.range(0, 30_000_000_000) as f64 / rng.pick(&[1.0, 3.0, 7.0]);
        let tol = rng.pick(&[0.002, 0.01, 0.0]);
        calls.push(json!(["fpsFromTicks", ticks, tol]));
        ours.push(json!(table::fps_from_ticks(ticks, tol)));
        let scale = rng.pick(&[1, 3, 1000, 44100, 48000, 90000, 30000, 1_000_000_000]);
        let v = rng.range(-2 * scale as i64, 35_000 * scale as i64);
        calls.push(json!(["rescale", v, scale]));
        ours.push(json!(table::rescale(v, scale)));
        calls.push(json!(["toScale", v * 1000, scale]));
        ours.push(json!(table::to_scale(v * 1000, scale)));
    }
    compare(&calls, &ours);
}
