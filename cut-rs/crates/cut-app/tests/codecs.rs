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

#[test]
fn vorbis_is_refused_with_its_sentence_and_its_video_still_plays() {
    let alone = import::probe_file(&more::vorbis_webm("vorbis-alone.webm", false));
    let r = alone.result.expect_err("Vorbis alone is refused");
    assert_eq!(r.code, "unsupported");
    assert_eq!(import::refusal_text(&r), "Vorbis audio is not supported yet.");

    let both = import::probe_file(&more::vorbis_webm("vorbis-vp9.webm", true));
    let e = both.result.expect("the VP9 video of the file is imported");
    assert_eq!(e["kind"].as_str(), Some("video"));
    assert!(e["video"]["codec"].as_str().is_some_and(|c| c.starts_with("vp09.")), "{}", e["video"]["codec"]);
    assert!(e["audio"].is_null(), "without its sound");
    assert_eq!(both.note, Some("Vorbis audio is not supported yet."));
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
