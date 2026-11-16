//! Export speed by stage (ignored; run with `--ignored --nocapture`). One export a run, chosen by environment:
//! `CUT_BENCH_CASE` `1080p1` (one 1080p layer, the default), `1080p3` (three layers with Lumetri, blur, black and
//! white, and a title), `4k1` (one 2160p layer); `CUT_BENCH_SOUND` `0` for no sound track; `CUT_BENCH_CODEC` `h264`
//! or `hevc`; `CUT_BENCH_ENCODER` the index in this PC's list (`list` prints the list); `CUT_BENCH_SECONDS` the
//! length (20); `CUT_BENCH_PSNR` `1` decodes the result and compares each frame's luma with the picture the source
//! was made from. Prints one line `BENCH {json}`: the wall time, the time of each step ([`cut_export::timing`]), CPU
//! and GPU engine use, the encoder, the verification and the quality.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use common::{Got, make, out_dir};
use cut_decode::encode::video_encoders;
use cut_decode::metrics::{GpuUse, process_cpu};
use cut_decode::{Accel, Codec, VideoDecoder};
use cut_export::presets::{self, Family, Overrides};
use cut_export::timing::Step;
use cut_export::{Job, run};
use cut_formats::probe::{self, read_samples};
use cut_formats::{FileReader, Kind};
use cut_model::commands::build as cmd;
use cut_model::{History, Id};
use cut_time::{Fps, TICKS};
use serde_json::{Value, json};

fn sec(s: f64) -> i64 {
    (s * TICKS as f64).round() as i64
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn media(path: &Path, w: u32, h: u32, seconds: f64) -> Value {
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    json!({ "path": path.to_string_lossy(), "name": name, "kind": "video", "size": 1, "mtime": 1, "duration": sec(seconds),
        "video": { "w": w, "h": h, "fps": [30, 1], "codec": "avc1.640028", "vfr": false, "rotation": 0 }, "audio": null })
}

fn tone(path: &Path, seconds: usize) -> Value {
    if !path.exists() {
        let n = seconds * 48000;
        let mut data = Vec::with_capacity(n * 4);
        for i in 0..n {
            let v = ((i as f64 * std::f64::consts::TAU * 440.0 / 48000.0).sin() * 0.2 * 32767.0) as i16;
            data.extend_from_slice(&v.to_le_bytes());
            data.extend_from_slice(&v.to_le_bytes());
        }
        let mut f = b"RIFF".to_vec();
        f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        f.extend_from_slice(b"WAVEfmt ");
        f.extend_from_slice(&16u32.to_le_bytes());
        f.extend_from_slice(&[1, 0, 2, 0]);
        f.extend_from_slice(&48000u32.to_le_bytes());
        f.extend_from_slice(&(48000u32 * 4).to_le_bytes());
        f.extend_from_slice(&[4, 0, 16, 0]);
        f.extend_from_slice(b"data");
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(&data);
        std::fs::write(path, f).expect("a wav");
    }
    json!({ "path": path.to_string_lossy(), "name": "bench-tone.wav", "kind": "audio", "size": 1, "mtime": 1, "duration": sec(seconds as f64),
        "video": null, "audio": { "rate": 48000, "channels": 2, "codec": "pcm-s16" } })
}

/// The case's project: `seconds` long, the source clip repeated on V1, for `1080p3` the 720p clip at half size with
/// Gaussian Blur on V2, again at a third with Black & White on V3, Lumetri on V1 and a title on V4; the tone on A1.
fn project(case: &str, seconds: f64, sound: bool) -> (cut_model::Project, Id, (u32, u32)) {
    let (w, h, frames) = if case == "4k1" { (3840, 2160, 150) } else { (1920, 1080, 300) };
    let clip = f64::from(frames) / 30.0;
    let big =
        cut_decode::encode::VideoSettings { bitrate: w * h * 5, b_frames: 0, ..make::settings(Codec::H264, w, h) };
    let v1 = make::video(&format!("bench-export-{h}p.mp4"), &big, frames, make::Timing::Constant);
    let small = cut_decode::encode::VideoSettings { b_frames: 0, ..make::settings(Codec::H264, 1280, 720) };
    let v2 = make::video("export-720p.mp4", &small, 90, make::Timing::Constant);
    let wav = out_dir().join("bench-tone.wav");
    let mut p = cut_model::defaults::project();
    p.sequences[0].w = i64::from(w);
    p.sequences[0].h = i64::from(h);
    let mut hist = History::new(p, 10).expect("history");
    let s = hist.project().sequences[0].id.as_str().to_owned();
    let layered = case == "1080p3";
    if layered {
        hist.apply(&cmd::add_track(&s, "video", None, json!({}))).ok();
        hist.apply(&cmd::add_track(&s, "video", None, json!({}))).ok();
    }
    let list = json!([media(&v1, w, h, clip), media(&v2, 1280, 720, 3.0), tone(&wav, 120)]);
    let ids: Vec<String> = hist.apply(&cmd::import_media(list, None)).expect("imported")["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let place = |h: &mut History, m: &str, out: f64, at: f64, v: Option<&str>, a: Option<&str>| {
        h.apply(&cmd::place(&s, json!({ "source": { "media": m }, "in": 0, "out": sec(out), "at": sec(at), "video": v, "audio": a, "mode": "overwrite" })))
            .expect("placed")["ids"][0].as_str().unwrap().to_owned()
    };
    let mut at = 0.0;
    while at < seconds {
        let c = place(&mut hist, &ids[0], clip.min(seconds - at), at, Some("V1"), None);
        if layered {
            let fx = json!({ "exposure": 0.3, "contrast": 15, "saturation": 120 });
            hist.apply(&cmd::add_effect(&s, &c, "color.basic", None, fx)).expect("lumetri");
        }
        at += clip;
    }
    if layered {
        let mut at = 0.0;
        while at < seconds {
            for (track, scale, fx) in [("V2", 50, "blur.gaussian"), ("V3", 33, "color.bw")] {
                let c = place(&mut hist, &ids[1], 3.0f64.min(seconds - at), at, Some(track), None);
                let x = if track == "V2" { 400 } else { -500 };
                hist.apply(&cmd::set_clip(&s, &c, json!({ "props": { "scale": scale, "x": x, "y": 200 } }), json!({})))
                    .ok();
                hist.apply(&cmd::add_effect(&s, &c, fx, None, json!({}))).expect("an effect");
            }
            at += 3.0;
        }
        hist.apply(&cmd::add_track(&s, "video", None, json!({}))).ok();
        hist.apply(&cmd::add_generated(
            &s,
            json!({ "source": { "generator": "graphic", "layers": [
                { "id": "bg", "kind": "rect", "size": [900, 200], "radius": 24, "fill": "#102040cc", "position": [0, 300] },
                { "id": "t", "kind": "text", "text": "타이틀 Title", "fontSize": 80, "position": [0, 300] } ] },
              "at": 0, "duration": sec(seconds), "track": "V4", "name": "Title" }),
        ))
        .expect("a title");
    }
    if sound {
        place(&mut hist, &ids[2], seconds, 0.0, None, Some("A1"));
    }
    (hist.project().clone(), Id::new(&s), (w, h))
}

fn gpu_use(span: Vec<cut_decode::metrics::EngineUse>) -> Value {
    let mut out = serde_json::Map::new();
    for e in span.iter().filter(|e| e.percent >= 0.5) {
        let name = e.adapter.split_whitespace().take(3).collect::<Vec<_>>().join(" ");
        out.insert(format!("{name} {}", e.engine), json!((e.percent * 10.0).round() / 10.0));
    }
    Value::Object(out)
}

/// Luma PSNR of every exported frame against the picture its source frame was drawn from: (mean, worst, frames).
fn psnr(path: &Path, w: u32, h: u32) -> (f64, f64, usize) {
    let reader = FileReader::open(path).expect("the export opens");
    let src = probe::open(&reader, "export.mp4");
    let t = src.tracks.iter().find(|t| t.kind() == Kind::Video).expect("a video track");
    let mut dec = VideoDecoder::new(t, Accel::Software).expect("a decoder");
    let mut ideal = vec![0u8; (w * h * 3 / 2) as usize];
    let luma = (w * h) as usize;
    let (mut sum, mut worst, mut n) = (0.0, f64::INFINITY, 0usize);
    let mut take = |f: cut_decode::Frame| {
        let bytes = f.to_memory().expect("pixels").into_owned();
        let g = Got { width: f.width, height: f.height, format: f.format, bytes };
        make::draw(make::read_number(&g), &mut ideal, w, h, false);
        let se: f64 =
            g.bytes[..luma].iter().zip(&ideal[..luma]).map(|(a, b)| (f64::from(*a) - f64::from(*b)).powi(2)).sum();
        let db = 10.0 * (255.0f64 * 255.0 / (se / luma as f64).max(1e-9)).log10();
        sum += db;
        worst = worst.min(db);
        n += 1;
    };
    let mut datas = Vec::new();
    read_samples(&reader, t, 0, t.samples.count(), |i, b| datas.push((i, b.to_vec()))).expect("samples");
    for (i, b) in datas {
        dec.send(i, &b).expect("sent");
        while let Ok(Some(f)) = dec.receive() {
            take(f);
        }
    }
    dec.finish().expect("drained");
    while let Ok(Some(f)) = dec.receive() {
        take(f);
    }
    (sum / n.max(1) as f64, worst, n)
}

#[test]
#[ignore = "a benchmark: prints export speed by stage"]
fn export_by_stage() {
    let codec = if env("CUT_BENCH_CODEC", "h264") == "hevc" { Codec::Hevc } else { Codec::H264 };
    let encoders = video_encoders(codec);
    let which = env("CUT_BENCH_ENCODER", "0");
    if which == "list" {
        for (i, e) in encoders.iter().enumerate() {
            eprintln!("{i}: {}", e.label());
        }
        return;
    }
    let encoder = encoders.get(which.parse::<usize>().expect("an encoder index")).expect("an encoder").clone();
    let case = env("CUT_BENCH_CASE", "1080p1");
    let seconds: f64 = env("CUT_BENCH_SECONDS", "20").parse().expect("seconds");
    let sound = env("CUT_BENCH_SOUND", "1") != "0";
    let (p, seq, (w, h)) = project(&case, seconds, sound);
    let library = cut_audio::Library::default();
    let get = Box::new(move |_p: &cut_model::Project, m: &cut_model::Media| {
        Ok(library.audio(Path::new(&m.path))?.map(|r| cut_audio::Audio::Reader(Box::new(r))))
    });
    let preset = if case == "4k1" { "youtube-4k" } else { "youtube-1080p" };
    let family = (codec == Codec::Hevc).then_some(Family::Hevc);
    let mut st = presets::resolve(
        presets::get(preset).expect("a preset"),
        Fps::new(30, 1),
        Some((f64::from(w), f64::from(h))),
        &Overrides { loudness: Some(None), codec: family, ..Overrides::default() },
    );
    if !sound {
        st.audio = None;
    }
    let path = out_dir().join(format!("bench-export-{}.mp4", std::process::id()));
    let mut j = Job::new(Arc::new(p), seq, path, st, get);
    j.encoders = Some(vec![encoder.clone()]);
    let gpu = GpuUse::start();
    let (cpu0, t0) = (process_cpu(), Instant::now());
    let r = run(j, &AtomicBool::new(false), &mut |_| {});
    let wall = t0.elapsed().as_secs_f64();
    let cpu = (process_cpu() - cpu0).as_secs_f64();
    let gpus = gpu.map(|g| gpu_use(g.finish())).unwrap_or(Value::Null);
    let d = match r {
        Ok(d) => d,
        Err(f) => {
            println!(
                "BENCH {}",
                json!({ "case": case, "encoder": encoder.label(), "error": format!("{} {f}", f.code) })
            );
            return;
        }
    };
    let steps: serde_json::Map<String, Value> = Step::ALL
        .iter()
        .map(|s| (s.as_str().to_owned(), json!((d.timing.get(*s) * 1000.0).round() / 1000.0)))
        .collect();
    let quality = (env("CUT_BENCH_PSNR", "0") == "1" && case != "1080p3").then(|| {
        let (mean, worst, n) = psnr(&d.path, w, h);
        json!({ "mean": (mean * 100.0).round() / 100.0, "worst": (worst * 100.0).round() / 100.0, "frames": n })
    });
    let v = d.verified.as_ref();
    println!(
        "BENCH {}",
        json!({
            "case": case, "codec": format!("{codec:?}"), "sound": sound, "seconds": seconds, "encoder": encoder.label(),
            "used": d.encoder.as_ref().map(|e| e.name.clone()), "wall": wall, "speed": seconds / wall, "cpu": cpu / wall,
            "steps": steps, "gpu": gpus, "bytes": d.bytes, "frames": d.frames, "faststart": d.faststart,
            "verified": v.map(|v| v.ok), "problems": v.map(|v| v.problems.iter().map(|p| p.code).collect::<Vec<_>>()),
            "psnr": quality,
        })
    );
    let _ = std::fs::remove_file(&d.path);
}
