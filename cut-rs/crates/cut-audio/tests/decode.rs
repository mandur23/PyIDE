//! Decoded sound of the sources the editor reads: raw PCM of every flavour, AAC (part reads against the whole-track
//! decode), the repository's audio fixtures, and a mixer fed from files.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::signal;
use cut_audio::source::{Bytes, TrackReader};
use cut_audio::{Audio, AudioRead, Library, Mixer};
use cut_formats::mp4::write::{AudioConfig, Mp4Writer, Sample};
use cut_formats::{Kind, MemReader, Track, probe};
use cut_oracle::Inputs;
use cut_time::rescale;

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures/viewers").join(rel)
}

/// Where made media go: `CUT_AUDIO_OUT` when set, else the system temporary directory.
fn out_dir() -> PathBuf {
    let dir =
        std::env::var_os("CUT_AUDIO_OUT").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("cut-audio"));
    std::fs::create_dir_all(&dir).expect("an output directory");
    dir
}

fn track_of(bytes: Vec<u8>) -> (Bytes, Arc<Track>, i64) {
    let reader = MemReader(bytes);
    let source = probe::open(&reader, "");
    assert!(source.error.is_none(), "{:?}", source.error);
    let track = source.tracks.into_iter().find(|t| t.kind() == Kind::Audio).expect("an audio track");
    (Arc::new(reader), Arc::new(track), source.duration)
}

/// A WAV file: `tag` 1 (integer) or 3 (float), `bits` a sample, interleaved channels.
fn wav(tag: u16, bits: u16, rate: u32, chans: &[Vec<f32>], extensible: bool) -> Vec<u8> {
    let ch = chans.len() as u16;
    let n = chans[0].len();
    let mut data = Vec::new();
    for i in 0..n {
        for c in chans {
            let v = f64::from(c[i]);
            match (tag, bits) {
                (1, 8) => data.push(((v * 127.0).round() + 128.0) as u8),
                (1, 16) => data.extend(((v * 32767.0).round() as i16).to_le_bytes()),
                (1, 24) => data.extend(&((v * 8_388_607.0).round() as i32).to_le_bytes()[..3]),
                (1, 32) => data.extend(((v * 2_147_483_647.0).round() as i32).to_le_bytes()),
                (3, 32) => data.extend((v as f32).to_le_bytes()),
                _ => data.extend(v.to_le_bytes()),
            }
        }
    }
    let align = ch * bits / 8;
    let mut fmt = Vec::new();
    fmt.extend((if extensible { 0xfffe } else { tag }).to_le_bytes());
    fmt.extend(ch.to_le_bytes());
    fmt.extend(rate.to_le_bytes());
    fmt.extend((rate * u32::from(align)).to_le_bytes());
    fmt.extend(align.to_le_bytes());
    fmt.extend(bits.to_le_bytes());
    if extensible {
        fmt.extend(22u16.to_le_bytes());
        fmt.extend(bits.to_le_bytes());
        fmt.extend(3u32.to_le_bytes());
        fmt.extend(tag.to_le_bytes());
        fmt.extend([0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]);
    }
    let mut out = b"RIFF".to_vec();
    out.extend(((4 + 8 + fmt.len() + 8 + data.len()) as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend((fmt.len() as u32).to_le_bytes());
    out.extend(fmt);
    out.extend(b"data");
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(data);
    out
}

#[test]
fn media_foundation_lists_its_audio_decoders() {
    let list = cut_decode::audio_decoder_names();
    for (name, d) in &list {
        eprintln!("{name}: {d:?}");
    }
    assert!(list.iter().any(|(n, d)| *n == "aac" && !d.is_empty()), "an AAC decoder");
}

#[test]
fn raw_pcm_of_every_flavour_reads_in_any_range() {
    let n = 44100 + 1234;
    let chans = vec![signal(n, 1), signal(n, 2), signal(n, 3)];
    let mut rng = Inputs::new(4);
    for (tag, bits, ext, eps) in [
        (1, 8, false, 1.0 / 60.0),
        (1, 16, false, 1e-4),
        (1, 24, true, 1e-6),
        (1, 32, false, 1e-6),
        (3, 32, false, 0.0),
        (3, 64, true, 0.0),
    ] {
        let (bytes, track, duration) = track_of(wav(tag, bits, 44100, &chans, ext));
        assert!(track.codec.starts_with("pcm-"), "{}", track.codec);
        let mut r = TrackReader::new(bytes, track.clone(), duration).expect("a reader");
        assert_eq!((r.rate(), r.channels(), r.length()), (44100.0, 3, n as i64), "{}", track.codec);
        let whole = r.read(0, n as i64).expect("all of it");
        for (c, (w, x)) in whole.iter().zip(&chans).enumerate() {
            let worst = w.iter().zip(x).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            assert!(f64::from(worst) <= eps + 1e-7, "{} channel {c}: worst {worst}", track.codec);
        }
        for _ in 0..40 {
            let a = rng.range(-5000, n as i64 + 3000);
            let b = a + rng.range(0, 30000);
            let part = r.read(a, b).expect("a range");
            for (p, w) in part.iter().zip(&whole) {
                for (k, v) in p.iter().enumerate() {
                    let i = a + k as i64;
                    let want = if i >= 0 && i < n as i64 { w[i as usize] } else { 0.0 };
                    assert_eq!(*v, want, "{} sample {i} of [{a}, {b})", track.codec);
                }
            }
        }
    }
}

/// An AAC track of `seconds` of stereo sound at 48 kHz, its priming hidden by the edit list.
fn aac(seconds: usize) -> (Vec<u8>, Vec<Vec<f32>>) {
    let n = seconds * 48000;
    let chans = vec![signal(n, 5), signal(n, 6)];
    let pcm: Vec<i16> = (0..n).flat_map(|i| [(chans[0][i] * 20000.0) as i16, (chans[1][i] * 20000.0) as i16]).collect();
    let enc = cut_decode::encode::encode_aac(&pcm, 48000, 2, 24000).expect("encoded");
    let config = AudioConfig {
        codec: enc.codec.clone(),
        sample_rate: 48000,
        channels: 2,
        description: Some(enc.description.clone()),
    };
    let mut w = Mp4Writer::create(None, Some(config), Vec::new(), None).expect("a writer");
    for (k, x) in enc.samples.iter().enumerate() {
        let at = k as i64 * 1024 - 1024;
        w.add_audio(Sample {
            data: x.data.clone(),
            timestamp: rescale(at, 48000),
            duration: rescale(1024, 48000),
            key: true,
            composition_offset: 0,
        })
        .expect("a sample");
    }
    w.finish().expect("finished");
    (w.into_sink(), chans)
}

#[test]
fn aac_reads_parts_as_the_whole_track_decodes() {
    let (bytes, _) = aac(30);
    let (reader, track, duration) = track_of(bytes);
    let whole = cut_decode::decode_audio(&*reader, &track).expect("the whole track");
    let mut r = TrackReader::new(reader, track, duration).expect("a reader");
    assert_eq!((r.rate(), r.length()), (f64::from(whole.rate), whole.data[0].len() as i64));
    let mut rng = Inputs::new(6);
    let len = r.length();
    let mut ranges =
        vec![(0, 4800), (-100, 100), (len - 1000, len + 1000), (len + 5, len + 10), (1_000_000, 1_480_000)];
    ranges.extend((0..20).map(|_| {
        let a = rng.range(0, len);
        (a, a + rng.range(1, 200_000))
    }));
    let mut worst = 0f32;
    for (a, b) in ranges {
        let part = r.read(a, b).expect("a part");
        for (p, w) in part.iter().zip(&whole.data) {
            assert_eq!(p.len(), (b - a) as usize);
            for (k, v) in p.iter().enumerate() {
                let i = a + k as i64;
                let want = if i >= 0 && i < len { w[i as usize] } else { 0.0 };
                // Before 0 a read gives the encoder's priming, as the JavaScript's does (the mixer never reads there).
                if i >= 0 {
                    worst = worst.max((v - want).abs());
                }
            }
        }
    }
    // The decoder starts each read 12 packets early: its state has forgotten the start by the range.
    assert!(worst < 1e-6, "a part read differs from the whole decode by {worst}");
}

#[test]
fn fixtures_open_or_say_why_not() {
    let lib = Library::default();
    let mut tone = lib.audio(&fixture("audio/tone.wav")).expect("readable").expect("sound");
    let all = tone.read(0, tone.length()).expect("read");
    let peak = all.iter().flatten().fold(0f32, |m, v| m.max(v.abs()));
    eprintln!("tone.wav: {} Hz, {} samples, peak {peak}", tone.rate(), tone.length());
    assert!(peak > 0.01 && tone.length() > 0);
    for f in ["video/clip.mp4", "video/voice.webm"] {
        match lib.audio(&fixture(f)) {
            Ok(Some(mut r)) => {
                let x = r.read(0, r.length().min(48000)).expect("read");
                eprintln!(
                    "{f}: {} Hz, {} channels, {} samples, peak {}",
                    r.rate(),
                    r.channels(),
                    r.length(),
                    x.iter().flatten().fold(0f32, |m, v| m.max(v.abs()))
                );
            }
            Ok(None) => eprintln!("{f}: no audio track"),
            Err(e) => eprintln!("{f}: {} ({})", e, e.code()),
        }
    }
}

#[test]
fn a_mixer_plays_a_file_through_the_library() {
    let (bytes, _) = aac(12);
    let path = out_dir().join(format!("mix-{}.m4a", std::process::id()));
    std::fs::write(&path, &bytes).expect("written");
    let (reader, track, _) = track_of(bytes);
    let whole = cut_decode::decode_audio(&*reader, &track).expect("decoded");
    let text = format!(
        r##"{{"format":"ncut","version":5,"settings":{{}},"media":[{{"id":"m1","path":{p},"name":"a.m4a","kind":"audio","size":1,"mtime":1,"duration":{d},"video":null,"audio":{{"rate":48000,"channels":2}}}}],"bins":[],"sequences":[{{"id":"s1","name":"S","w":1280,"h":720,"fps":[30,1],"rate":48000,"background":"#000000","masterGain":0,"tracks":[{{"id":"A1","kind":"audio","name":"A1","locked":false,"syncLock":true,"height":40,"mute":false,"solo":false,"volume":0,"pan":0}}],"clips":[{{"id":"c1","track":"A1","start":{s},"in":{i},"out":{o},"source":{{"media":"m1"}},"speed":1,"reverse":false,"enabled":true,"link":null,"group":null,"name":"a","label":null,"role":null,"props":{{"volume":0,"pan":0}},"keyframes":{{}},"effects":[],"fadeIn":0,"fadeOut":0,"remap":null,"sampling":"sample"}}],"transitions":[],"markers":[],"captions":[]}}],"nextId":9}}"##,
        p = serde_json::Value::from(path.to_string_lossy().into_owned()),
        d = 12 * cut_time::TICKS,
        s = cut_time::TICKS,
        i = 2 * cut_time::TICKS,
        o = 8 * cut_time::TICKS,
    );
    let project = cut_model::Project::load(&text).expect("a project");
    let lib = Library::default();
    let mut mixer = Mixer::new(
        48000,
        Box::new(move |_p, m| Ok(lib.audio(std::path::Path::new(&m.path))?.map(|r| Audio::Reader(Box::new(r))))),
    );
    let seq = cut_model::Id::new("s1");
    let m = mixer.mix_loaded(&project, seq, 48000, 6 * 48000, 0.0);
    assert_eq!(m.missing, 0);
    assert!(mixer.failures().is_empty(), "{:?}", mixer.failures());
    for c in 0..2 {
        assert_eq!(
            m.out[c][..],
            whole.data[c][2 * 48000..8 * 48000],
            "channel {c}: the clip plays its file from its in point"
        );
    }
    let _ = std::fs::remove_file(&path);
}
