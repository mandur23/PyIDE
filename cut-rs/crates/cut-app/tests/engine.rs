//! The window with the picture and sound engines joined, run headless (egui_kittest on wgpu) on the demo project:
//! the Program monitor shows the engine's picture of the right frame (read from the test video's frame-number blocks
//! in the window's own pixels), the colours on screen are the engine's, a still keeps its colours, and playback runs
//! on the sound's clock (at zero output gain) with the picture following it.

#[path = "../examples/demo_project.rs"]
mod demo;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use cut_app::files::{Home, now_ms};
use cut_app::shell::Shell;
use cut_time::TICKS;
use eframe::egui;
use egui_kittest::Harness;

fn ticks(s: f64) -> i64 {
    (s * TICKS as f64).round() as i64
}

/// The demo project written to a folder of its own, opened in a fresh editor at `w` x `h`.
fn open(name: &str, w: f32, h: f32) -> Harness<'static, Shell> {
    open_text(name, &demo::build(0), w, h)
}

fn open_text(name: &str, text: &str, w: f32, h: f32) -> Harness<'static, Shell> {
    let dir = std::env::temp_dir().join(format!("cut-app-engine-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("demo.ncut");
    std::fs::write(&file, text).unwrap();
    let mut s = Shell::new(Home::at(dir.join("home")));
    s.doc.open(&mut s.app, &file, now_ms()).expect("the demo project opens");
    let mut harness =
        Harness::builder().with_size(egui::vec2(w, h)).wgpu_setup(demo::media::gpu_setup()).build_eframe(move |_cc| s);
    let start = Instant::now();
    while harness.state().monitors.is_none() && start.elapsed() < Duration::from_secs(20) {
        harness.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(harness.state().monitors.is_some(), "the window gave the monitors its GPU device");
    harness.state_mut().transport.set_output_gain(0.0);
    harness
}

/// Steps until the Program monitor's picture is the exact frame (the decoders run on their own threads).
fn settle(h: &mut Harness<'_, Shell>) {
    let start = Instant::now();
    loop {
        h.step();
        let done = h.state().monitors.as_ref().is_some_and(|m| m.program.stats.complete);
        if done || start.elapsed() > Duration::from_secs(20) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    h.step();
    assert!(h.state().monitors.as_ref().unwrap().program.stats.complete, "the picture became complete");
}

/// The window's pixels where the Program monitor drew its picture, and that picture's size.
fn monitor_pixels(h: &mut Harness<'_, Shell>) -> (u32, u32, Vec<u8>) {
    let img = h.render().expect("a picture of the window");
    let ppp = h.ctx.pixels_per_point();
    let r = h.state().monitors.as_ref().unwrap().program.rect;
    let (x0, y0) = ((r.left() * ppp).round() as u32, (r.top() * ppp).round() as u32);
    let (w, hh) = ((r.width() * ppp).round() as u32, (r.height() * ppp).round() as u32);
    let mut out = Vec::with_capacity((w * hh * 4) as usize);
    for y in y0..y0 + hh {
        for x in x0..x0 + w {
            out.extend_from_slice(&img.get_pixel(x, y).0);
        }
    }
    (w, hh, out)
}

#[test]
fn the_program_monitor_shows_the_engines_picture_of_the_frame_at_the_playhead() {
    let mut h = open("pictures", 1280.0, 800.0);
    // 720p frames 30 and 60, the 1080p clip's frame 90 (3 s into it, under its Black & White effect and the title)
    for (at, clip_start, number) in
        [(1.0, demo::at::CLIP_720, 30), (2.0, demo::at::CLIP_720, 60), (6.0, demo::at::CLIP_1080, 90)]
    {
        h.state_mut().app.set_time(ticks(at));
        settle(&mut h);
        let (w, hh, px) = monitor_pixels(&mut h);
        let got = media_number(&px, w, hh);
        eprintln!("{at} s: frame {got} on a {w} x {hh} picture ({} s into its clip)", at - clip_start);
        assert_eq!(got, number, "the frame shown at {at} s");
        let (ew, eh, engine) = h.state().monitors.as_ref().unwrap().program.pixels().unwrap();
        assert_eq!((ew, eh), (w, hh), "drawn one texel to a pixel");
        let worst = px.iter().zip(&engine).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0);
        eprintln!("{at} s: the screen differs from the engine's pixels by {worst} at most");
        assert!(worst <= 1, "the screen shows the engine's values unchanged ({worst})");
        if at == 6.0 {
            let grey =
                px.as_chunks::<4>().0.iter().filter(|p| p[0].abs_diff(p[1]) > 3 || p[1].abs_diff(p[2]) > 3).count();
            assert!(grey < px.len() / 4 / 100, "Black & White leaves no colour ({grey} coloured pixels)");
        }
    }
    // the still: its middle keeps the file's colour
    h.state_mut().app.set_time(ticks(demo::at::STILL + 1.0));
    settle(&mut h);
    let (w, hh, px) = monitor_pixels(&mut h);
    let png = image::open(demo_still()).unwrap().to_rgba8();
    let want = png.get_pixel(png.width() / 2, png.height() / 2).0;
    let at = (((hh / 2) * w + w / 2) * 4) as usize;
    let got = &px[at..at + 4];
    eprintln!("the still's middle: {got:?} on screen, {want:?} in the file");
    for c in 0..3 {
        assert!(got[c].abs_diff(want[c]) <= 6, "channel {c}: {} on screen, {} in the file", got[c], want[c]);
    }
}

fn demo_still() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../verify/fixtures/viewers/images/sample.png")
}

fn media_number(px: &[u8], w: u32, h: u32) -> u32 {
    demo::media::number_in(px, w, h)
}

#[test]
fn playback_runs_on_the_sound_clock_and_the_picture_follows_it() {
    let mut h = open("playback", 1280.0, 800.0);
    if let Some(e) = &h.state().sound_error {
        eprintln!("skipped: no output device ({e})");
        return;
    }
    h.state_mut().app.set_time(0);
    settle(&mut h);
    let ctx = h.ctx.clone();
    h.state_mut().run_action("playPause", &ctx);
    assert!(h.state().transport.playing());
    // the clock holds at the start until the first block sounds
    let wait = Instant::now();
    let mut t0 = 0;
    while t0 == 0 && wait.elapsed() < Duration::from_secs(3) {
        h.step();
        t0 = h.state_mut().transport.now().unwrap_or(0);
    }
    let w0 = Instant::now();
    let mut numbers = Vec::new();
    while w0.elapsed() < Duration::from_secs(2) {
        h.step();
        if let Some((w, hh, px)) = h.state().monitors.as_ref().unwrap().program.pixels() {
            numbers.push(media_number(&px, w, hh));
        }
        std::thread::sleep(Duration::from_millis(15));
    }
    let t1 = h.state_mut().transport.now().unwrap_or(0);
    let wall = w0.elapsed().as_secs_f64();
    let moved = (t1 - t0) as f64 / TICKS as f64;
    let clock = h.state().transport.clock();
    let (callbacks, underruns) = h.state().transport.underruns();
    let play = h.state().play;
    eprintln!(
        "{moved:.4} s played in {wall:.4} s of wall time on the {clock} clock; {} frames shown, {} dropped; \
         {callbacks} callbacks, {underruns} underruns; frames seen {numbers:?}",
        play.shown, play.dropped
    );
    assert_eq!(clock, "sound", "the picture follows the sound's clock");
    assert!((moved - wall).abs() <= 1.0 / 30.0, "the playhead moved {moved} s in {wall} s");
    assert_eq!(underruns, 0, "the sound never waited");
    assert!(numbers.windows(2).all(|p| p[1] >= p[0]), "the frame numbers never go back: {numbers:?}");
    assert!(numbers.last() > numbers.first(), "the picture moved: {numbers:?}");
    let ctx = h.ctx.clone();
    h.state_mut().run_action("playPause", &ctx);
    assert!(!h.state().transport.playing());
}

/// The UI thread's frame time while the playhead is dragged fast across the H.264 clips (and back), each frame at a
/// new time: `cargo test -p cut-app --release --test engine -- --ignored --nocapture scrubbing`.
#[test]
#[ignore = "a measurement"]
fn scrubbing_frame_time() {
    let mut h = open("scrub", 1280.0, 800.0);
    settle(&mut h);
    let end = demo::at::STILL;
    let mut shell_ms = Vec::new();
    let mut step_ms = Vec::new();
    let steps = 600;
    for i in 0..steps {
        // 0.13 s a frame, there and back: almost never a frame already decoded
        let k = (i as f64 * 0.13) % (2.0 * end);
        let at = if k < end { k } else { 2.0 * end - k };
        h.state_mut().app.set_time(ticks(at));
        let s0 = Instant::now();
        h.step();
        step_ms.push(s0.elapsed().as_secs_f64() * 1000.0);
        shell_ms.push(f64::from(h.state().frame_ms));
        let st = h.state().monitors.as_ref().unwrap().program.stats;
        if st.last_ms > 15.0 {
            eprintln!(
                "slow {at:.2} s: render {:.1} ms, sources {:?}",
                st.last_ms,
                h.state().monitors.as_ref().unwrap().program.engine.stats()
            );
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    let stats = h.state().monitors.as_ref().unwrap().program.stats;
    let report = |name: &str, v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        eprintln!(
            "{name}: mean {mean:.2} ms, median {:.2}, p95 {:.2}, max {:.2}",
            v[v.len() / 2],
            v[v.len() * 95 / 100],
            v[v.len() - 1]
        );
    };
    report("the shell's frame (panels and the engine's render)", &mut shell_ms);
    report("a whole egui step", &mut step_ms);
    eprintln!(
        "{steps} frames: {} renders, {} of them with a nearer frame standing in, engine render max {:.2} ms",
        stats.renders, stats.incomplete, stats.max_ms
    );
    settle(&mut h);
}

#[test]
fn offline_media_show_the_engines_slate() {
    let mut project: serde_json::Value = serde_json::from_str(&demo::build(0)).unwrap();
    let gone = std::env::temp_dir().join("cut-app-engine-no-such-file.mp4");
    project["media"][0]["path"] = serde_json::json!(gone.to_string_lossy());
    let mut h = open_text("offline", &project.to_string(), 1280.0, 800.0);
    h.step();
    // Relink Media opened for the missing file covers the monitor: closed as Cancel closes it
    h.state_mut().features.prefs.screen = None;
    h.state_mut().app.set_time(ticks(1.0));
    settle(&mut h);
    assert_eq!(h.state().monitors.as_ref().unwrap().program.stats.failed, 1, "the clip of the missing file failed");
    let (_, _, px) = monitor_pixels(&mut h);
    let red = px.as_chunks::<4>().0.iter().filter(|p| p[0] > 120 && p[1] < 80 && p[2] < 80).count();
    assert!(red > px.len() / 4 / 2, "the slate is red ({red} red pixels)");
}

#[test]
fn import_asks_the_picture_and_sound_engines_what_this_pc_decodes() {
    use cut_app::import;
    let video = import::probe_file(&demo::media::h264_720p()).result.expect("H.264 is imported");
    assert_eq!((video["kind"].as_str(), video["video"]["w"].as_f64()), (Some("video"), Some(1280.0)));
    let aac = import::probe_file(&demo::media::tone_aac()).result.expect("AAC is imported");
    assert_eq!(aac["kind"].as_str(), Some("audio"));
    let wav = import::probe_file(&demo::media::fixture("audio/tone.wav")).result.expect("PCM is imported");
    assert_eq!(wav["kind"].as_str(), Some("audio"));
    for codec in ["avc1.640028", "hvc1.1.6.L93.B0", "mp4a.40.2", "mp3", "pcm-s16"] {
        let ok = import::decodable_video(codec) || import::decodable_audio(codec);
        eprintln!("{codec}: {}", if ok { "decoded on this PC" } else { "not decoded" });
        assert!(ok, "{codec} is decoded through Media Foundation or as PCM");
    }
    assert!(import::decodable_audio("vorbis"), "Vorbis through lewton on any PC");
    let webm = import::probe_file(&demo::media::fixture("video/voice.webm")).result.expect("Opus in WebM is imported");
    assert_eq!(webm["audio"]["codec"].as_str(), Some("opus"));
}

/// A copy of `src` whose video track says it is shown turned by 90 degrees clockwise, as a phone held upright writes
/// it: the track header's matrix is (0, 1, -1, 0), the pictures in the file stay as they were encoded.
fn turned_copy(src: &std::path::Path, to: &std::path::Path) {
    let mut b = std::fs::read(src).expect("the test video");
    let mut turned = 0;
    let mut at = 0;
    while let Some(i) = b[at..].windows(4).position(|w| w == b"tkhd") {
        let payload = at + i + 4;
        let matrix = payload + if b[payload] == 1 { 52 } else { 40 };
        at = payload;
        // the track's width (16.16) follows the matrix: a sound track has none
        if matrix + 44 > b.len() || b[matrix + 36..matrix + 40] == [0, 0, 0, 0] {
            continue;
        }
        let m: [i32; 9] = [0, 0x0001_0000, 0, -0x0001_0000, 0, 0, 0, 0, 0x4000_0000];
        for (k, v) in m.iter().enumerate() {
            b[matrix + k * 4..matrix + k * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        turned += 1;
    }
    assert_eq!(turned, 1, "the file has one video track to turn");
    std::fs::write(to, b).unwrap();
}

/// How much of a column range of a picture is black or white (the test video's strip of frame-number blocks; the rest
/// of its picture is coloured).
fn grey_share(px: &[u8], w: u32, h: u32, x0: u32, x1: u32) -> f64 {
    let mut grey = 0usize;
    let mut all = 0usize;
    for y in h / 8..h - h / 8 {
        for x in x0..x1 {
            let p = &px[((y * w + x) * 4) as usize..];
            all += 1;
            grey += usize::from(p[0].abs_diff(p[1]) < 14 && p[1].abs_diff(p[2]) < 14);
        }
    }
    grey as f64 / all.max(1) as f64
}

#[test]
fn a_video_recorded_turned_is_imported_and_shown_upright() {
    use cut_app::import;
    use serde_json::json;
    let dir = std::env::temp_dir().join(format!("cut-app-engine-turned-file-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("phone-upright.mp4");
    turned_copy(&demo::media::h264_720p(), &file);
    let probe = import::probe_file(&file).result.expect("a turned H.264 file is imported");
    assert_eq!(
        (probe["video"]["w"].as_f64(), probe["video"]["h"].as_f64(), probe["video"]["rotation"].as_f64()),
        (Some(720.0), Some(1280.0), Some(90.0)),
        "the size is the picture's as it is shown: 720 wide, 1280 high"
    );
    // on the timeline of a 1920 x 1080 sequence, three seconds from the start
    let mut hist = cut_app::doc::fresh_history();
    let seq = hist.project().sequences[0].id.as_str().to_owned();
    let v1 = hist.project().sequences[0].tracks.iter().find(|t| t.kind == cut_model::TrackKind::Video).unwrap().id;
    let r = hist.apply(&json!({ "type": "importMedia", "media": [probe], "binId": null })).expect("imported");
    let m = r["ids"][0].as_str().unwrap().to_owned();
    hist.apply(
        &json!({ "type": "place", "seqId": seq, "opts": { "source": { "media": m }, "video": v1.as_str(), "at": 0,
        "out": ticks(3.0), "mode": "overwrite" } }),
    )
    .expect("placed");
    let mut h = open_text("turned", &hist.serialize(), 1280.0, 800.0);
    h.state_mut().app.set_time(ticks(1.0));
    settle(&mut h);
    let (w, hh, px) = h.state().monitors.as_ref().unwrap().program.pixels().expect("the engine's picture");
    // the clip fits the sequence's height: a column 720/1280 of the height wide, in the middle
    let cw = (f64::from(hh) * 720.0 / 1280.0).round() as u32;
    let (left, right) = ((w - cw) / 2, (w + cw) / 2);
    // the file's strip of blocks lies a little under its top edge: a sixth of the width holds it
    let strip = cw / 6;
    let (l, r, mid) = (
        grey_share(&px, w, hh, left + 2, left + strip),
        grey_share(&px, w, hh, right - strip, right - 2),
        grey_share(&px, w, hh, w / 2 - strip / 2, w / 2 + strip / 2),
    );
    eprintln!("grey share: left {l:.2}, middle {mid:.2}, right {r:.2} of a {w} x {hh} picture, clip {cw} wide");
    assert!(grey_share(&px, w, hh, 2, left - 2) > 0.98, "beside the upright picture the frame is empty");
    assert!(
        r > 0.35 && l < 0.1 && mid < 0.1,
        "the strip the file has along its top is along the right: the picture is turned clockwise (left {l:.2}, middle {mid:.2}, right {r:.2})"
    );
    drop(h);
    let _ = std::fs::remove_dir_all(&dir);
}
