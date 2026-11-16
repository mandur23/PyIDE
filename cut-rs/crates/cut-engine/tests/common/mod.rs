//! What the engine's tests share: projects built from the model's defaults, JSON compared number by number, and
//! pictures written as PNG to look at.
#![allow(dead_code)]

use std::path::PathBuf;

use cut_model::defaults::{self, SequenceOpts};
use cut_model::{Clip, Effect, Id, Media, MediaKind, Project, Source, TrackKind};
use cut_time::TICKS;
use serde_json::{Value as Json, json};

pub const SEC: i64 = TICKS;
/// One frame at 30 fps.
pub const F: i64 = TICKS / 30;

/// Where test pictures go: `CUT_ENGINE_OUT` when set, else the system temporary directory.
pub fn out_dir() -> PathBuf {
    let dir = std::env::var_os("CUT_ENGINE_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cut-engine"));
    std::fs::create_dir_all(&dir).expect("an output directory");
    dir
}

pub fn write_png(name: &str, rgba: &[u8], w: u32, h: u32) -> PathBuf {
    let path = out_dir().join(name);
    let file = std::io::BufWriter::new(std::fs::File::create(&path).expect("a png file"));
    let mut enc = png::Encoder::new(file, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().expect("png header").write_image_data(rgba).expect("png data");
    path
}

/// A project with sequence `s1` (`w` x `h`, 30 fps, tracks V1..V4 and A1) and no clips.
pub fn project(w: i64, h: i64) -> Project {
    let mut p = defaults::project();
    p.sequences.clear();
    let o = SequenceOpts { w, h, video_tracks: 4, audio_tracks: 1, ..Default::default() };
    p.sequences.push(defaults::sequence(Id::new("s1"), &o));
    p
}

/// A media entry (`kind` video or image) for a file.
pub fn media(p: &mut Project, id: &str, path: &str, kind: MediaKind, w: f64, h: f64, duration: f64) -> Id {
    let video = json!({ "w": w, "h": h, "fps": if kind == MediaKind::Video { json!([30, 1]) } else { Json::Null },
        "codec": "avc1.640028", "vfr": false, "rotation": 0 });
    let m: Media = serde_json::from_value(json!({
        "id": id, "path": path, "name": id, "kind": kind, "size": 0, "mtime": 0, "duration": duration,
        "video": video, "audio": null, "interpret": null, "proxy": null,
    }))
    .expect("a media entry");
    p.media.push(m);
    Id::new(id)
}

/// A clip on a track of `seq`.
pub fn clip(id: &str, track: &str, start: i64, in_: f64, out: f64, source: Source) -> Clip {
    defaults::clip(TrackKind::Video, Id::new(id), Id::new(track), start, in_, out, source, id.into())
}

pub fn of_media(m: Id) -> Source {
    Source::Media { media: m, freeze: false, extra: Default::default() }
}

pub fn solid(color: &str) -> Source {
    Source::Generator {
        generator: cut_model::Generator::Solid,
        layers: None,
        color: Some(color.into()),
        extra: Default::default(),
    }
}

pub fn effect(id: &str, kind: &str, params: Json) -> Effect {
    serde_json::from_value(json!({ "id": id, "type": kind, "on": true, "params": params })).expect("an effect")
}

pub fn put(p: &mut Project, seq: &str, c: Clip) {
    p.sequence_mut(Id::new(seq)).expect("the sequence").insert_clip(c, None);
}

/// The project as the file holds it, read back as the editor opens it (migrated and validated).
pub fn reload(p: &Project) -> (Project, String) {
    let text = p.to_text();
    (Project::load(&text).unwrap_or_else(|e| panic!("{e:?}: {text}")), text)
}

/// Two JSON values alike, numbers within `eps` relative (null and missing alike).
pub fn same(a: &Json, b: &Json, eps: f64, at: &str) -> Result<(), String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap_or(f64::NAN), y.as_f64().unwrap_or(f64::NAN));
            if (x - y).abs() <= eps * x.abs().max(y.abs()).max(1.0) { Ok(()) } else { Err(format!("{at}: {x} vs {y}")) }
        }
        (Json::Array(x), Json::Array(y)) => {
            if x.len() != y.len() {
                return Err(format!("{at}: length {} vs {}", x.len(), y.len()));
            }
            x.iter().zip(y).enumerate().try_for_each(|(i, (x, y))| same(x, y, eps, &format!("{at}[{i}]")))
        }
        (Json::Object(x), Json::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                same(x.get(k).unwrap_or(&Json::Null), y.get(k).unwrap_or(&Json::Null), eps, &format!("{at}.{k}"))?;
            }
            Ok(())
        }
        _ if a == b => Ok(()),
        _ => Err(format!("{at}: {a} vs {b}")),
    }
}
