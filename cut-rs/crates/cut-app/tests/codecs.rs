//! Importing the codecs beyond H.264, HEVC and AAC: what this PC decodes is imported, what it does not is refused
//! (or, for a video's sound, left out) with the sentence that says why.

mod media;

use cut_app::import;
use media::more;

#[test]
fn opus_vp9_vp8_flac_and_mp3_import() {
    let voice = import::probe_file(&media::fixture("video/voice.webm"));
    let entry = voice.result.expect("Opus in WebM is imported");
    assert_eq!((entry["kind"].as_str(), entry["audio"]["codec"].as_str()), (Some("audio"), Some("opus")));
    assert_eq!(voice.note, None);
    for (name, codec) in [("vp9-320.webm", cut_decode::Codec::Vp9), ("vp8-320.webm", cut_decode::Codec::Vp8)] {
        let p = import::probe_file(&more::vpx_webm(name, codec, 320, 240, 45));
        let e = p.result.expect("VP8 and VP9 are imported");
        assert_eq!((e["kind"].as_str(), e["video"]["w"].as_f64()), (Some("video"), Some(320.0)), "{name}");
    }
    let pcm: Vec<i16> = (0..48000).map(|n| ((n as f64 * 0.06).sin() * 9000.0) as i16).collect();
    let flac = import::probe_file(&more::flac_mkv("flac-mono-import.mkv", &pcm, 1)).result.expect("FLAC");
    assert_eq!(flac["audio"]["codec"].as_str(), Some("flac"));
    let mp3 = import::probe_file(&more::mp3("mp3-mono-import.mp3", &pcm, 1, None)).result.expect("MP3");
    assert_eq!(mp3["audio"]["codec"].as_str(), Some("mp3"));
    for codec in ["vp09.00.10.08", "vp8", "opus", "flac", "mp3"] {
        assert!(import::decodable_video(codec) || import::decodable_audio(codec), "{codec}");
    }
    eprintln!("AV1 decoded here: {}", import::decodable_video("av01.0.04M.08"));
}

/// The RMS of each channel of the offline mix (as the export mixes) of `[from, to)` seconds of a project holding
/// only `file`, placed on A1 at 0.
fn heard(name: &str, file: &std::path::Path, from: f64, to: f64) -> [f64; 2] {
    use cut_model::Id;
    let home = std::env::temp_dir().join(format!("cut-app-codecs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("a home");
    let mut s = cut_app::shell::Shell::new(cut_app::files::Home::at(home));
    s.dialog = None;
    let entry = import::probe_file(file).result.expect("imported");
    let r = s.app.exec(&cut_app::cmd::import_media(vec![entry], None)).expect("into the project");
    let media = Id::new(r["ids"][0].as_str().expect("an id"));
    let seq = s.app.sequence_id.expect("a sequence");
    s.app.exec(&cut_app::cmd::place(seq, media, None, Some(Id::new("A1")), 0, "overwrite")).expect("placed");
    let mut m = cut_audio::Mixer::new(48000, cut_app::transport::file_audio(cut_audio::Library::default()));
    let ticks = |t: f64| (t * cut_time::TICKS as f64) as i64;
    let out = cut_audio::offline::render(&mut m, s.app.project(), seq, ticks(from), ticks(to), 0.0);
    out.map(|c| (c.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / c.len().max(1) as f64).sqrt())
}

#[test]
fn vorbis_imports_alone_and_under_video_and_plays() {
    let file = more::vorbis_webm("vorbis-tone-2ch-a.webm", 2, 120, false);
    let alone = import::probe_file(&file);
    let e = alone.result.expect("Vorbis in WebM is imported");
    assert_eq!((e["kind"].as_str(), e["audio"]["codec"].as_str()), (Some("audio"), Some("vorbis")));
    assert_eq!((e["audio"]["rate"].as_u64(), e["audio"]["channels"].as_u64()), (Some(48000), Some(2)));
    assert_eq!(alone.note, None);

    let both = import::probe_file(&more::vorbis_webm("vorbis-tone-vp9-a.webm", 2, 120, true));
    let e = both.result.expect("the file is imported");
    assert_eq!(e["kind"].as_str(), Some("video"));
    assert!(e["video"]["codec"].as_str().is_some_and(|c| c.starts_with("vp09.")), "{}", e["video"]["codec"]);
    assert_eq!(e["audio"]["codec"].as_str(), Some("vorbis"), "with its sound");
    assert_eq!(both.note, None);

    // 440 Hz at a quarter of full scale on the left, 660 Hz at an eighth on the right.
    let [l, r] = heard("vorbis", &file, 0.25, 1.25);
    eprintln!("Vorbis mixed: {l:.4} {r:.4}");
    assert!((l - 0.25 / 2f64.sqrt()).abs() < 0.01 && (r - 0.125 / 2f64.sqrt()).abs() < 0.01, "{l} {r}");
}

#[test]
fn opus_of_more_than_two_channels_imports_and_plays_its_left_and_right() {
    for (to, side) in [(0u8, Some(0)), (2, Some(1)), (1, None)] {
        let file = more::opus_routed_webm(&format!("opus-51-to{to}.webm"), 6, to);
        let p = import::probe_file(&file);
        let e = p.result.expect("5.1 Opus is imported");
        assert_eq!((e["kind"].as_str(), e["audio"]["channels"].as_u64()), (Some("audio"), Some(6)));
        assert_eq!(p.note, None);
        // The fixture's 330 Hz at an eighth of full scale, routed to Vorbis channel `to` of L C R Ls Rs LFE. The mix
        // keeps the first two channels of what the decoder gives, as the JavaScript keeps WebCodecs' first two
        // (left and right): the centre is not heard.
        let rms = heard(&format!("opus{to}"), &file, 0.2, 0.8);
        eprintln!("Opus to {to}: {rms:?}");
        for (c, v) in rms.iter().enumerate() {
            let want = if side == Some(c) { 0.125 / 2f64.sqrt() } else { 0.0 };
            assert!((v - want).abs() < 0.01, "Vorbis channel {to}: mix channel {c} {v}");
        }
    }
}

#[test]
fn a_missing_video_decoder_names_its_extension() {
    let r = import::Refusal {
        code: "unsupported",
        detail: String::new(),
        sentence: Some(cut_decode::Codec::Av1.missing_decoder()),
    };
    assert_eq!(
        import::refusal_text(&r),
        "This PC has no AV1 decoder. Install the AV1 Video Extension from the Microsoft Store."
    );
    assert!(cut_app::i18n::has_korean(import::refusal_text(&r)));
    for f in cut_decode::Format::ALL {
        assert!(cut_app::i18n::has_korean(f.refusal()), "{}", f.refusal());
    }
}
