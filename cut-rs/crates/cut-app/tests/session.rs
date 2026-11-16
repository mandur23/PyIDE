//! A few minutes with the editor, run headless as a person would use it: import the generated media, build a small
//! sequence from the Source monitor, add Black & White and a cross dissolve, play, export through the Export Media
//! dialog, and open the written file with `cut-formats` and `cut-decode` to check what is in it.

#[path = "media/mod.rs"]
mod media;

use std::time::{Duration, Instant};

use cut_app::edit::source::{SourceClip, SourceItem};
use cut_app::export::Outcome;
use cut_app::files::Home;
use cut_app::shell::Shell;
use cut_app::state::Panel;
use cut_decode::{Accel, VideoDecoder};
use cut_formats::probe::{self, read_samples};
use cut_formats::{FileReader, Kind};
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;

const S: i64 = TICKS;

fn until(h: &mut Harness<'_, Shell>, secs: u64, done: impl Fn(&Shell) -> bool) -> bool {
    let start = Instant::now();
    while !done(h.state()) {
        if start.elapsed() > Duration::from_secs(secs) {
            return false;
        }
        h.step();
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

/// The clips of the active sequence as `track:start-end[in]` in seconds, sorted.
fn lay(s: &Shell) -> String {
    let seq = s.app.sequence().unwrap();
    let f = |t: f64| format!("{}", (t / S as f64 * 100.0).round() / 100.0);
    let mut v: Vec<String> = seq
        .clips()
        .map(|c| format!("{}:{}-{}[{}]", c.track.as_str(), f(c.start as f64), f(c.end() as f64), f(c.in_)))
        .collect();
    v.sort();
    v.join(" ")
}

/// Mean distance of the chroma bytes from grey, and the frame number the blocks show, of each decoded frame.
fn frames(reader: &FileReader, t: &cut_formats::Track) -> Vec<(f64, u32)> {
    let mut dec = VideoDecoder::new(t, Accel::Software).expect("a decoder");
    let mut out = Vec::new();
    let take = |f: cut_decode::Frame, out: &mut Vec<(f64, u32)>| {
        let bytes = f.to_memory().expect("pixels").into_owned();
        let (w, h) = (f.width, f.height);
        let chroma = &bytes[(w * h) as usize..];
        let grey = chroma.iter().map(|v| (f64::from(*v) - 128.0).abs()).sum::<f64>() / chroma.len() as f64;
        let n = media::make::read_number(&media::Got { width: w, height: h, format: f.format, bytes });
        out.push((grey, n));
    };
    let mut samples = Vec::new();
    read_samples(reader, t, 0, t.samples.count(), |i, b| samples.push((i, b.to_vec()))).expect("samples");
    for (i, b) in samples {
        dec.send(i, &b).expect("sent");
        while let Ok(Some(f)) = dec.receive() {
            take(f, &mut out);
        }
    }
    dec.finish().expect("drained");
    while let Ok(Some(f)) = dec.receive() {
        take(f, &mut out);
    }
    out
}

#[test]
fn import_edit_play_and_export_a_small_sequence() {
    let dir = std::env::temp_dir().join(format!("cut-app-session-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    cut_app::i18n::set_lang(cut_app::i18n::Lang::En);
    s.dialog = None;
    let mut h = Harness::builder()
        .with_size(egui::vec2(1280.0, 800.0))
        .wgpu_setup(media::gpu_setup())
        .build_eframe(move |_cc| s);
    assert!(until(&mut h, 20, |s| s.monitors.is_some()), "the monitors start");
    h.state_mut().transport.set_output_gain(0.0);
    let ctx = h.ctx.clone();

    // import: two videos with frame numbers and a tone
    let files = [media::h264_720p(), media::h264_1080p(), media::tone_aac()];
    h.state_mut().import_paths(files.to_vec(), None);
    assert!(until(&mut h, 60, |s| s.app.project().media.len() == 3), "the three files are imported");
    let id = |s: &Shell, name: &str| s.app.project().media.iter().find(|m| m.name == name).unwrap().id;
    let (v720, v1080, tone) =
        (id(h.state(), "h264-720p.mp4"), id(h.state(), "bench-h264-1080p.mp4"), id(h.state(), "cut-app-tone.m4a"));

    // the sequence, from the Source monitor: 720p 0-3 s, then 1080p 2-5 s, then the tone under both
    let place = |h: &mut Harness<'_, Shell>, item, a: f64, b: f64, at: f64| {
        let s = h.state_mut();
        s.app.edit.source.open(SourceClip {
            item: SourceItem::Media(item),
            in_: Some((a * S as f64) as i64),
            out: Some((b * S as f64) as i64),
            t: 0,
        });
        s.app.set_time((at * S as f64) as i64);
        s.app.focus = Some(Panel::Timeline);
        s.run_action("overwrite", &ctx);
        // the 1080p clip in the sequence the 720p clip set: Clip Mismatch, the settings kept
        if s.app.edit.mismatch.open.is_some() {
            cut_app::edit::mismatch::answer(&mut s.app, false);
        }
        h.step();
    };
    place(&mut h, v720, 0.0, 3.0, 0.0);
    let sq = h.state().app.sequence().unwrap();
    assert_eq!((sq.w, sq.h), (1280, 720), "the empty sequence takes its first clip's size");
    place(&mut h, v1080, 2.0, 5.0, 3.0);
    place(&mut h, tone, 0.0, 6.0, 0.0);
    assert_eq!(lay(h.state()), "A1:0-6[0] V1:0-3[0] V1:3-6[2]", "{:?}", h.state().app.notices);

    // Black & White on the 1080p clip, as a double click in the Effects panel applies it to the selection
    {
        let s = h.state_mut();
        let c = s.app.sequence().unwrap().clips().find(|c| c.start == 3 * S && c.track.as_str() == "V1").unwrap().id;
        s.app.select([c], false, false);
        let bw = cut_model::effects::get("color.bw").expect("Black & White");
        assert!(cut_app::fx::effects::apply(&mut s.app, bw), "{:?}", s.app.notices);
        s.app.selection.clear();
    }
    // the default video transition at the cut nearest the playhead (Ctrl+D)
    h.state_mut().app.set_time(3 * S + S / 10);
    h.state_mut().run_action("transitionVideo", &ctx);
    let t = h.state().app.sequence().unwrap().transitions.clone();
    assert_eq!(t.len(), 1, "{:?}", h.state().app.notices);
    assert_eq!((t[0].track.as_str(), t[0].at, t[0].kind.as_str()), ("V1", 3 * S, "dissolve"));

    // play a second from the start: the playhead runs and the Program monitor shows the frames it passes
    h.state_mut().app.set_time(0);
    assert!(until(&mut h, 20, |s| s.monitors.as_ref().is_some_and(|m| m.program.stats.complete)));
    h.state_mut().run_action("playPause", &ctx);
    let start = Instant::now();
    let mut shown = Vec::new();
    while start.elapsed() < Duration::from_millis(1500) {
        h.step();
        if let Some((w, hh, px)) = h.state().monitors.as_ref().unwrap().program.pixels() {
            shown.push(media::number_in(&px, w, hh));
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    h.state_mut().run_action("playPause", &ctx);
    let played = h.state().app.t as f64 / S as f64;
    eprintln!("played to {played:.2} s; frame numbers seen {shown:?}");
    assert!(!h.state().transport.playing());
    assert!(played > 0.5, "the playhead ran ({played} s)");
    assert!(shown.last() > shown.first(), "the picture moved: {shown:?}");

    // export through the Export Media dialog, opened by a click on the top bar's Export button
    {
        use egui_kittest::kittest::Queryable;
        h.get_by_label(&format!("{}  Export", cut_app::icons::EXPORT)).click();
    }
    h.run_steps(2);
    assert!(h.state().features.export.open, "Export Media opens");
    let out = dir.join("session.mp4");
    {
        let f = &mut h.state_mut().features.export.form;
        f.path = out.to_string_lossy().into_owned();
        f.path_touched = true;
    }
    h.step();
    cut_app::export::start_export(h.state_mut(), false, &ctx);
    assert!(until(&mut h, 180, |s| s.features.export.outcome.is_some()), "the export ends");
    match &h.state().features.export.outcome {
        Some(Outcome::Done(d)) => {
            eprintln!("exported {} ({} frames, {:?}) in {:.1} s", d.path.display(), d.frames, d.encoder, d.seconds);
            assert!(d.verified.as_ref().is_some_and(|v| v.ok), "the file checks itself: {:?}", d.verified);
        }
        Some(Outcome::Failed(f)) => panic!("the export failed: {} {}", f.code, f),
        _ => panic!("no result"),
    }
    drop(h);

    // the file, read back by this workspace's own parser and decoders
    let reader = FileReader::open(&out).expect("the exported file");
    let source = probe::open(&reader, "session.mp4");
    assert!(source.error.is_none(), "{:?}", source.error);
    let vt = source.tracks.iter().find(|t| t.kind() == Kind::Video).expect("a video track");
    let at = source.tracks.iter().find(|t| t.kind() == Kind::Audio).expect("a sound track");
    assert_eq!(vt.samples.count(), 180, "six seconds at 30 fps");
    let got = frames(&reader, vt);
    assert_eq!(got.len(), 180, "every frame decodes");
    let at_frame = |i: usize| got[i];
    // 720p clip in colour before the dissolve (frame 30 shows source frame 30)
    assert_eq!(at_frame(30).1, 30, "1 s: the 720p clip's frame 30");
    assert!(at_frame(30).0 > 5.0, "1 s: in colour ({:.1})", at_frame(30).0);
    // after the dissolve, the 1080p clip from its 2 s, grey under Black & White
    for i in [120, 150, 179] {
        let want = 60 + (i as u32 - 90);
        assert_eq!(at_frame(i).1, want, "frame {i}: the 1080p clip's frame {want}");
        assert!(at_frame(i).0 < 1.5, "frame {i}: grey under Black & White ({:.1})", at_frame(i).0);
    }
    let pcm = cut_decode::decode_audio(&reader, at).expect("the sound decodes");
    let secs = pcm.data[0].len() as f64 / f64::from(pcm.rate);
    let peak = pcm.data[0][48000..96000].iter().fold(0f32, |m, v| m.max(v.abs()));
    eprintln!("sound: {secs:.3} s, peak {peak:.3} in the second second");
    assert!((secs - 6.0).abs() < 0.05, "six seconds of sound ({secs})");
    assert!(peak > 0.1, "the tone is in it ({peak})");
    let _ = std::fs::remove_dir_all(&dir);
}
