//! Timings, printed (run with `--ignored --nocapture`, in release for the numbers that matter): the offline mix of a
//! minute of an 8-track project with effects against the JavaScript's on the same project, the DSP hot loops against
//! the JavaScript's, and the waveform peaks of a one-hour 48 kHz stereo file.

mod common;

use std::io::Write;
use std::time::Instant;

use common::{built, mixer};
use cut_audio::analysis::{BASE_SPP, compute_peaks, peaks};
use cut_audio::loudness::loudness;
use cut_audio::{AudioRead, Library};
use cut_oracle::ask_scenario;
use cut_time::TICKS;
use serde_json::json;

fn best(rounds: usize, mut f: impl FnMut()) -> f64 {
    (0..rounds)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1000.0
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
#[ignore]
fn mixing_a_minute_of_eight_tracks_with_effects() {
    let a = ask_scenario("audio", &[json!(["build", "bench"]), json!(["timeMix", "bench", 60, 2])]);
    let b = built(&a[0]);
    let js = a[1].as_f64().unwrap_or(f64::NAN);
    let warm = best(1, || {
        cut_audio::offline::render(&mut mixer(&b, false), &b.project, b.seq, 0, 60 * TICKS, 0.0);
    });
    let ours = best(2, || {
        cut_audio::offline::render(&mut mixer(&b, false), &b.project, b.seq, 0, 60 * TICKS, 0.0);
    });
    println!(
        "offline mix of 60 s, 8 tracks, 24 clips (12 with EQ + compressor, one limiter), sources read on demand: \
         Rust {ours:.0} ms ({:.0}x real time; first run {warm:.0} ms), JavaScript {js:.0} ms ({:.0}x real time): {:.1}x faster",
        60000.0 / ours,
        60000.0 / js,
        js / ours
    );
}

#[test]
#[ignore]
fn dsp_hot_loops_against_the_javascript() {
    let seconds = 10.0;
    let js = &ask_scenario("audio", &[json!(["timeDsp", seconds, 3])])[0];
    let n = (seconds * 48000.0) as usize;
    let x48 = [common::signal(n, 1), common::signal(n, 2)];
    let x44 = vec![common::signal((seconds * 44100.0) as usize, 3), common::signal((seconds * 44100.0) as usize, 4)];
    let peaks_ms = best(3, || {
        for a in (0..n).step_by(480000) {
            let e = (a + 480000).min(n);
            std::hint::black_box(compute_peaks(&[&x48[0][a..e], &x48[1][a..e]], BASE_SPP));
        }
    });
    let resample_ms = best(3, || {
        std::hint::black_box(cut_audio::resample::resample(&x44, 44100.0, 48000.0));
    });
    let loud_ms = best(3, || {
        std::hint::black_box(loudness(&[&x48[0], &x48[1]], 48000.0));
    });
    let x48v = x48.to_vec();
    let stretch_ms = best(3, || {
        std::hint::black_box(cut_audio::stretch::stretch(&x48v, 0.5, 48000.0));
    });
    for (name, ours) in [("peaks", peaks_ms), ("resample", resample_ms), ("loudness", loud_ms), ("stretch", stretch_ms)]
    {
        let j = js[name].as_f64().unwrap_or(f64::NAN);
        println!("{name} of {seconds} s stereo: Rust {ours:.2} ms, JavaScript {j:.2} ms ({:.1}x)", j / ours);
    }
}

#[test]
#[ignore]
fn peaks_of_a_one_hour_file() {
    let dir = std::env::var_os("CUT_AUDIO_OUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cut-audio"));
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("hour.wav");
    let frames: u64 = 3600 * 48000;
    {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&path).expect("a file"));
        let data = frames * 4;
        let mut head = b"RIFF".to_vec();
        head.extend(((36 + data) as u32).to_le_bytes());
        head.extend(b"WAVEfmt ");
        head.extend(16u32.to_le_bytes());
        head.extend(1u16.to_le_bytes());
        head.extend(2u16.to_le_bytes());
        head.extend(48000u32.to_le_bytes());
        head.extend((48000u32 * 4).to_le_bytes());
        head.extend(4u16.to_le_bytes());
        head.extend(16u16.to_le_bytes());
        head.extend(b"data");
        head.extend((data as u32).to_le_bytes());
        f.write_all(&head).expect("written");
        let block: Vec<u8> = common::signal(48000, 9)
            .iter()
            .flat_map(|v| {
                let s = (v * 20000.0) as i16;
                [s, -s]
            })
            .flat_map(i16::to_le_bytes)
            .collect();
        for _ in 0..3600 {
            f.write_all(&block).expect("written");
        }
    }
    let t = Instant::now();
    let mut r = Library::default().audio(&path).expect("opens").expect("sound");
    let opened = t.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(r.length() as u64, frames);
    let t = Instant::now();
    let p = peaks(&mut r, BASE_SPP).expect("peaks");
    let ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "peaks of a one-hour 48 kHz stereo 16-bit WAV ({} peaks of 256 samples): open {opened:.0} ms, read + decode + peaks {ms:.0} ms",
        p.len() / 2
    );
    let _ = std::fs::remove_file(&path);
}
