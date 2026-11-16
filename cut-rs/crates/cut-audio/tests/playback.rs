//! Playback on the real output device, silent: every test sets the output gain to 0, so the mix is computed and fed
//! to the device in full and multiplied by 0 at the very last step. Skipped (with a note) on a PC without an output
//! device.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{Built, MemAudio, built};
use cut_audio::playback::Playback;
use cut_audio::{Audio, GetAudio, Mixer};
use cut_oracle::ask_scenario;
use cut_time::TICKS;
use serde_json::json;

fn get_audio(b: &Built) -> GetAudio {
    let sources = b.sources.clone();
    Box::new(move |_p, m| {
        Ok(sources
            .get(&m.name)
            .map(|(rate, data)| Audio::Reader(Box::new(MemAudio { rate: *rate, data: data.clone() }))))
    })
}

fn silent(b: &Built) -> Option<Playback> {
    match Playback::new(get_audio(b)) {
        Ok(p) => {
            p.set_output_gain(0.0);
            p.set_project(Arc::new(b.project.clone()), b.seq);
            Some(p)
        }
        Err(e) => {
            eprintln!("skipped: {e}");
            None
        }
    }
}

fn project(name: &str) -> Built {
    built(&ask_scenario("audio", &[json!(["build", name])])[0])
}

#[test]
fn plays_ten_seconds_without_underruns_on_the_device_clock() {
    let b = project("bench");
    let Some(p) = silent(&b) else { return };
    let rate = f64::from(p.rate());
    p.start(0, 1.0);
    let wall0 = Instant::now();
    // The clock holds at the start until the first block sounds.
    while p.position() == 0 && wall0.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(1));
    }
    let (t_first, w_first) = (p.position(), Instant::now());
    let mut prev = t_first;
    let mut meters_seen = false;
    while w_first.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
        let t = p.position();
        assert!(t >= prev, "the clock never goes back ({t} after {prev})");
        prev = t;
        meters_seen |= p.meters().master.is_finite();
    }
    let (t_last, w_last) = (p.position(), Instant::now());
    let (callbacks, underruns) = p.stats();
    let heard = (t_last - t_first) as f64 / TICKS as f64;
    let wall = (w_last - w_first).as_secs_f64();
    eprintln!(
        "{rate} Hz: started after {:.0} ms, {heard:.4} s heard in {wall:.4} s of wall time ({:.3} %), {callbacks} callbacks, {underruns} underruns",
        (w_first - wall0).as_secs_f64() * 1000.0,
        (heard / wall - 1.0) * 100.0
    );
    assert!(p.error().is_none(), "{:?}", p.error());
    assert_eq!(underruns, 0, "the callback was always fed");
    assert!((heard / wall - 1.0).abs() < 0.005, "the clock runs at the device's rate");
    assert!(meters_seen, "the meters read the blocks being heard");
    p.stop();
    let at = p.position();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(p.position(), at, "stopped, the clock stays");
}

#[test]
fn a_seek_plays_the_mix_from_that_sample() {
    let b = project("fx");
    let Some(p) = silent(&b) else { return };
    let rate = p.rate();
    let mut reference = Mixer::new(rate, get_audio(&b));
    for (seconds, n) in [(3.3, 30000usize), (0.0, 20000), (7.123, 25000)] {
        let t = cut_time::from_seconds(seconds);
        p.tap(Some(n));
        p.start(t, 1.0);
        assert_eq!(p.position(), t, "until the sound starts, the clock is where it will start");
        std::thread::sleep(Duration::from_millis(2000));
        let got = p.tap(None);
        let s0 = cut_audio::util::js_round(t as f64 * f64::from(rate) / TICKS as f64) as i64;
        let m = reference.mix_loaded(&b.project, b.seq, s0, n, 0.0);
        let l: Vec<f32> = got.iter().step_by(2).copied().collect();
        let r: Vec<f32> = got.iter().skip(1).step_by(2).copied().collect();
        assert_eq!(l.len(), n, "the frames after the seek were played");
        assert_eq!(l, m.out[0], "left from sample {s0}");
        assert_eq!(r, m.out[1], "right from sample {s0}");
    }
    p.stop();
}

#[test]
fn tape_rates_move_the_clock_and_other_rates_are_silent_with_the_clock_running() {
    let b = project("basic");
    let Some(p) = silent(&b) else { return };
    for (rate, t) in [(2.0, TICKS), (0.5, TICKS), (-4.0, 20 * TICKS)] {
        p.start(t, rate);
        std::thread::sleep(Duration::from_millis(600));
        let (a, wa) = (p.position(), Instant::now());
        std::thread::sleep(Duration::from_millis(1000));
        let (z, wz) = (p.position(), Instant::now());
        let speed = (z - a) as f64 / TICKS as f64 / (wz - wa).as_secs_f64();
        eprintln!("rate {rate}: the clock runs at {speed:.3}");
        assert!((speed - rate).abs() < 0.02 * rate.abs(), "rate {rate}: {speed}");
        p.stop();
    }
}
