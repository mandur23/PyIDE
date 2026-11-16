//! `Cut.export.run`: checks the job, starts the stages ([`crate::stages`]) on threads of their own, reports progress
//! from the calling thread, commits the part file, writes the SRT sidecars, moves the index to the front and checks
//! the written file. A hardware encoder that fails on the way gets one more try with the next encoder; cancel, or any
//! failure, leaves no file behind.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

use cut_audio::Mixer;
use cut_decode::Codec;
use cut_decode::encode::{EncoderConfig, EncoderInfo, RateControl, VideoSettings as EncoderSettings, video_encoders};
use cut_formats::mp4::write::{AudioConfig, VideoConfig};
use cut_model::{Id, Project, Sequence};
use cut_time::{TICKS, Ticks, snap};

use crate::aac::aac_setup;
use crate::faststart::faststart;
use crate::job::{CaptionMode, Done, EncoderUsed, Hardware, Job, Phase, Progress};
use crate::lost::{Lost, What, lost_media, lost_sound, preflight};
use crate::plan::{FramePlan, captions_in_range, sidecar_path, with_ext, with_speakers};
use crate::presets::{Family, RateMode, Settings, validate};
use crate::sink::{Committed, Failure, PartFile, save_bytes};
use crate::stages::{self, AudioJob, EncodeJob, Out, Picture, RenderJob, Shared, WriteJob, level_of};
use crate::timing::{Clocks, Step};
use crate::verify::{Problem, verify_file};

fn cancelled() -> Failure {
    Failure::new("cancelled", "The export was cancelled.")
}

/// The encoders to try for pictures of `pixels`, in order, each one that does not start giving way to the next. `Auto`
/// follows their measured speed on a laptop with an integrated and a discrete GPU and 16 threads (`tests/bench.rs`,
/// NEXT.md): up to 1080p the GPU makers' own encoders, then software, then Windows' Direct3D 12 encoders; above it
/// the Direct3D 12 ones first (there the integrated GPU's encoder spends most of each frame on the copy of the picture
/// into its memory). `Hardware` takes only the GPUs' encoders in the same order, `Software` only software. HEVC only on a GPU.
pub fn encoder_choices(family: Family, hardware: Hardware, pixels: u64) -> Vec<EncoderInfo> {
    let codec = if family == Family::Hevc { Codec::Hevc } else { Codec::H264 };
    let list = video_encoders(codec);
    let own = list.iter().filter(|e| e.hardware && !e.direct3d12()).cloned();
    let d3d12 = list.iter().filter(|e| e.direct3d12()).cloned();
    let sw: Vec<EncoderInfo> = match (family, hardware) {
        (Family::Hevc, _) | (_, Hardware::Hardware) => Vec::new(),
        _ => list.iter().filter(|e| !e.hardware).cloned().collect(),
    };
    if hardware == Hardware::Software && family != Family::Hevc {
        return sw;
    }
    if pixels > 1920 * 1080 { d3d12.chain(own).chain(sw).collect() } else { own.chain(sw).chain(d3d12).collect() }
}

/// The sound's settings once its encoder is set up: bitrate, priming delay and the loudness target's gain.
struct Sound {
    bitrate: u32,
    delay: i64,
    gain: f64,
}

struct Once<'a> {
    project: &'a Project,
    seq: &'a Sequence,
    settings: &'a Settings,
    from: Ticks,
    to: Ticks,
    path: &'a Path,
    burn: Option<Id>,
    accepted: &'a HashSet<Id>,
    sound: Option<&'a Sound>,
    master_gain: f64,
    clocks: &'a Clocks,
}

/// What one try gave: the committed file, the frames, the encoder, the encode time and the offline clips.
struct Attempt {
    committed: Committed,
    frames: u64,
    encoder: Option<(String, bool)>,
    encode_seconds: f64,
    slated: Vec<Id>,
}

/// Runs an export to its end, calling `progress` from this thread about ten times a second. `cancel` stops it.
pub fn run(mut job: Job, cancel: &AtomicBool, progress: &mut dyn FnMut(&Progress)) -> Result<Done, Failure> {
    let started = Instant::now();
    let clocks = Clocks::default();
    let project = job.project.clone();
    let seq = project.sequence(job.seq).ok_or_else(|| Failure::new("noSequence", "There is no such sequence."))?;
    let settings = job.settings.clone();
    if let Some(p) = validate(&settings).first() {
        return Err(Failure::new("settings", p));
    }
    let from = snap(job.range.map_or(0, |r| r.0).max(0), seq.fps, false);
    let to = snap(job.range.map_or(seq.duration(), |r| r.1), seq.fps, true);
    if to <= from {
        return Err(Failure::new("empty", "There is nothing to export in this range."));
    }
    let path = PathBuf::from(with_ext(&job.path.to_string_lossy(), &settings.ext));
    let caption_mode = job.captions;
    let burn = matches!(caption_mode, Some(CaptionMode::Burn | CaptionMode::Both))
        .then(|| job.caption_track.or_else(|| seq.captions.first().map(|c| c.id)))
        .flatten();
    let accepted: HashSet<Id> = preflight(&project, seq, from, to).into_iter().map(|m| m.id).collect();
    let report = |p: &mut dyn FnMut(&Progress), phase: Phase, fraction: f64| {
        p(&Progress {
            phase,
            done: 0,
            total: 0,
            fraction,
            elapsed: started.elapsed().as_secs_f64(),
            eta: None,
            speed: 0.0,
        });
    };
    report(progress, Phase::Audio, 0.0);
    let choices = match &settings.video {
        Some(v) => {
            let c = job.encoders.clone().unwrap_or_else(|| {
                encoder_choices(v.family, job.hardware, u64::from(settings.width) * u64::from(settings.height))
            });
            if c.is_empty() {
                let m = if v.family == Family::Hevc {
                    "This PC has no HEVC encoder."
                } else {
                    "This PC has no H.264 encoder for these settings."
                };
                return Err(Failure::new("noEncoder", m));
            }
            c
        }
        None => Vec::new(),
    };
    // Sound: the sources first (decoding may take a while), the AAC encoder's priming, the loudness target.
    let mut mixer = settings.audio.as_ref().map(|a| {
        let get = std::mem::replace(&mut job.get_audio, Box::new(|_, _| Ok(None)));
        Mixer::new(a.rate, get)
    });
    let master = job.master_gain;
    let sound = match (&mut mixer, &settings.audio) {
        (Some(m), Some(a)) => {
            let loading = Instant::now();
            let failures = m.load(&project, seq.id, from as f64, to as f64);
            let lost: Vec<Lost> = lost_sound(&[], &failures);
            if let Some(f) = lost_media(&project, seq, from, &lost, &accepted, What::Sound) {
                return Err(f);
            }
            let (bitrate, delay) = aac_setup(a.rate, a.channels, a.bitrate)?;
            let gain = match settings.loudness {
                Some(target) if target.is_finite() => {
                    let measured = cut_audio::offline::measure(m, &project, seq.id, from, to, master, |f| {
                        report(progress, Phase::Audio, f);
                        !cancel.load(Ordering::Relaxed)
                    })
                    .ok_or_else(cancelled)?;
                    cut_audio::loudness::match_gain(&measured, target, -1.0)
                }
                _ => 0.0,
            };
            clocks.add(Step::SoundLoad, loading.elapsed());
            Some(Sound { bitrate, delay, gain })
        }
        _ => None,
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let once = Once {
        project: &project,
        seq,
        settings: &settings,
        from,
        to,
        path: &path,
        burn,
        accepted: &accepted,
        sound: sound.as_ref(),
        master_gain: master + sound.as_ref().map_or(0.0, |s| s.gain),
        clocks: &clocks,
    };
    let mut rest: &[EncoderInfo] = &choices;
    let attempt = loop {
        match encode_once(&once, &mut job, mixer.as_mut(), rest, cancel, started, progress) {
            Ok(a) => break a,
            // A hardware encoder that fails on the way gets one more try with the next encoder.
            Err((f, Some(used))) if f.code == "encode" && rest.len() > 1 && !cancel.load(Ordering::Relaxed) => {
                let i = rest.iter().position(|e| e.label() == used).map_or(1, |i| i + 1);
                rest = &rest[i.min(rest.len() - 1)..];
                if let Some(m) = &mut mixer {
                    m.forget();
                }
            }
            Err((f, _)) => return Err(f),
        }
    };
    let final_path = match &attempt.committed {
        Committed::Done { path, .. } => path.clone(),
        Committed::Kept { part, .. } => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(Failure::with(
                "busy",
                "{name} is open in another program, so it was not replaced. The finished export is kept as {part}: close that program and rename it, or export again.",
                &[("name", name), ("part", part.to_string_lossy().into_owned())],
            ));
        }
    };

    let sidecars = write_sidecars(&job, seq, &final_path, caption_mode, (from, to))?;
    report(progress, Phase::Finish, 1.0);
    // The file is whole without it: a failed faststart (no room for its copy) is a problem of the result.
    let fast =
        clocks.time(Step::Faststart, || faststart(&final_path, cut_decode::disk::free_space, job.journal.as_deref()));
    let fast_problem = fast.as_ref().err().map(|e| Problem {
        code: "faststart",
        message: "The index could not be moved to the front of the file ({error}): it plays, but players and upload sites read all of it before they start.",
        params: vec![("error", e.to_string())],
    });
    let mut verified = None;
    if job.verify {
        report(progress, Phase::Verify, 1.0);
        let mut v = clocks.time(Step::Verify, || {
            verify_file(
                &final_path,
                settings.video.as_ref().map(|_| seq.fps),
                attempt.frames as usize,
                to - from,
                settings.audio.is_some(),
            )
        });
        if !attempt.slated.is_empty() {
            let names: Vec<String> = attempt
                .slated
                .iter()
                .map(|id| {
                    project
                        .sequences
                        .iter()
                        .find_map(|q| q.clip(*id))
                        .map_or_else(|| id.as_str().to_owned(), |c| c.name.clone())
                })
                .collect();
            v.problems.push(Problem {
                code: "offline",
                message: "{n} clips use offline media: they show the red \"media offline\" picture and are silent ({names}).",
                params: vec![("n", names.len().to_string()), ("names", names.join(", "))],
            });
            v.ok = false;
        }
        if let Some(p) = fast_problem.clone() {
            v.problems.push(p);
        }
        verified = Some(v);
    }
    let seconds = started.elapsed().as_secs_f64();
    let media = (to - from) as f64 / TICKS as f64;
    let pixels_per_second = (settings.video.is_some() && attempt.encode_seconds > 0.0).then(|| {
        f64::from(settings.width) * f64::from(settings.height) * seq.fps.value() * media / attempt.encode_seconds
    });
    let bytes = std::fs::metadata(&final_path).map_or(0, |m| m.len());
    Ok(Done {
        path: final_path,
        bytes,
        seconds,
        speed: media / seconds.max(1e-6),
        frames: attempt.frames,
        range: (from, to),
        verified,
        offline: attempt.slated,
        encoder: settings.video.as_ref().zip(attempt.encoder).map(|(v, (name, hardware))| EncoderUsed {
            codec: v.codec.clone(),
            name,
            hardware,
        }),
        audio_delay: sound.as_ref().map(|s| s.delay),
        audio_bitrate: sound.as_ref().map(|s| s.bitrate),
        loudness_gain: sound.as_ref().map_or(0.0, |s| s.gain),
        sidecars,
        faststart: fast_problem.is_none(),
        pixels_per_second,
        timing: clocks.read(),
    })
}

/// The SRT files beside the export: one a caption track with items, a number added to a second one of a language.
fn write_sidecars(
    job: &Job,
    seq: &Sequence,
    path: &Path,
    mode: Option<CaptionMode>,
    range: (Ticks, Ticks),
) -> Result<Vec<PathBuf>, Failure> {
    if !matches!(mode, Some(CaptionMode::Srt | CaptionMode::Both)) {
        return Ok(Vec::new());
    }
    let tracks: Vec<_> = seq.captions.iter().filter(|c| !c.items.is_empty()).collect();
    let p = path.to_string_lossy();
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for ct in &tracks {
        let mut file = sidecar_path(&p, Some(&ct.lang), tracks.len());
        let mut n = 2;
        while taken.contains(&file.to_lowercase()) {
            let lang = if ct.lang.is_empty() { "captions" } else { &ct.lang };
            file = sidecar_path(&p, Some(&format!("{lang}-{n}")), 2);
            n += 1;
        }
        taken.insert(file.to_lowercase());
        let items = captions_in_range(&ct.items, Some(range));
        let items = with_speakers(job.project.speakers.as_ref(), &ct.style, items, &job.speaker_label);
        let cues: Vec<cut_model::srt::Cue> =
            items.iter().map(|c| cut_model::srt::Cue { start: c.start, end: c.end, text: c.text.clone() }).collect();
        match save_bytes(Path::new(&file), cut_model::srt::write(&cues).as_bytes(), job.journal.clone())? {
            Committed::Done { path, .. } => out.push(path),
            Committed::Kept { part, .. } => out.push(part),
        }
    }
    Ok(out)
}

/// Bytes the MP4 index of `frames` pictures and `blocks` AAC blocks can take at most: per sample its size, time,
/// composition offset, sync flag and a chunk of its own (offset and sample-to-chunk entry), 44 bytes, plus 64 KB for
/// the rest. Kept free at the front, it takes the index in place ([`faststart`]).
fn index_room(frames: u64, blocks: u64) -> u64 {
    65_536 + 48 * (frames + blocks)
}

fn encode_once(
    o: &Once,
    job: &mut Job,
    mixer: Option<&mut Mixer>,
    choices: &[EncoderInfo],
    cancel: &AtomicBool,
    started: Instant,
    progress: &mut dyn FnMut(&Progress),
) -> Result<Attempt, (Failure, Option<String>)> {
    let s = o.settings;
    let mut part = PartFile::open(o.path, job.journal.clone()).map_err(|f| (f, None))?;
    part.limit = job.disk_limit;
    let plan = FramePlan::new(o.seq.fps, o.from, o.to);
    let frames = if s.video.is_some() { plan.count.max(0) as u64 } else { 0 };
    let sh = Shared::new(cancel, o.clocks);
    let video_cfg = s.video.as_ref().map(|v| VideoConfig {
        codec: v.codec.clone(),
        width: s.width,
        height: s.height,
        description: None,
        frame_rate: Some([o.seq.fps.num, o.seq.fps.den]),
        color_space: None,
    });
    let audio_cfg = s.audio.as_ref().zip(o.sound).map(|(a, _)| AudioConfig {
        codec: a.codec.clone(),
        sample_rate: a.rate,
        channels: a.channels,
        description: None,
    });
    let encoder_cfg = s.video.as_ref().map(|v| EncoderConfig {
        video: EncoderSettings {
            codec: if v.family == Family::Hevc { Codec::Hevc } else { Codec::H264 },
            width: s.width,
            height: s.height,
            fps: [o.seq.fps.num, o.seq.fps.den],
            bitrate: v.bitrate,
            key_every: v.key_interval,
            b_frames: 0,
            ten_bit: false,
        },
        rate: match v.mode {
            RateMode::Constant => RateControl::Constant,
            RateMode::Variable => RateControl::Variable { peak: v.bitrate.saturating_mul(3) / 2 },
        },
        level: level_of(&v.codec),
        bt709: true,
    });
    let total_samples =
        s.audio.as_ref().map_or(0, |a| ((o.to - o.from) as f64 * f64::from(a.rate) / TICKS as f64).round() as u64);
    part.keep_room(index_room(frames, total_samples.div_ceil(1024) + 4 * u64::from(s.audio.is_some())));
    let mut encode_start = Instant::now();
    let gpu = job.gpu.clone();
    let frame_limit = job.frame_limit;
    let gate = job.gate.clone();
    let result = std::thread::scope(|scope| {
        let (out_tx, out_rx) = sync_channel::<Out>(stages::SAMPLES);
        let writer = {
            let sh = &sh;
            let wj = WriteJob { video: video_cfg, audio: audio_cfg, part };
            std::thread::Builder::new()
                .name("export writer".into())
                .spawn_scoped(scope, move || stages::write(wj, sh, out_rx))
        };
        let writer = writer.map_err(|e| Failure::new("io", &e.to_string()))?;
        let mut workers = Vec::new();
        if let (Some(cfg), Some(v)) = (encoder_cfg, &s.video) {
            let (pic_tx, pic_rx) = sync_channel::<Picture>(crate::nv12::FRAMES);
            let (bin_tx, bin_rx) = sync_channel::<crate::nv12::Frame>(crate::nv12::FRAMES);
            let rj = RenderJob {
                project: o.project,
                seq: o.seq,
                plan,
                size: (s.width, s.height),
                burn: o.burn,
                accepted: o.accepted,
                gpu,
                frame_limit,
                gate,
            };
            let ej = EncodeJob { config: cfg, choices, plan, key_interval: u64::from(v.key_interval) };
            let (sh1, sh2) = (&sh, &sh);
            let tx = out_tx.clone();
            encode_start = Instant::now();
            o.clocks.add(Step::Prepare, started.elapsed());
            workers.push(
                std::thread::Builder::new()
                    .name("export render".into())
                    .spawn_scoped(scope, move || stages::render(rj, sh1, pic_tx, bin_rx)),
            );
            workers.push(
                std::thread::Builder::new()
                    .name("export encode".into())
                    .spawn_scoped(scope, move || stages::encode(ej, sh2, pic_rx, bin_tx, tx)),
            );
        }
        if let (Some(m), Some(a), Some(snd)) = (mixer, &s.audio, o.sound) {
            let aj = AudioJob {
                project: o.project,
                seq: o.seq,
                from: o.from,
                to: o.to,
                rate: a.rate,
                channels: a.channels,
                bitrate: snd.bitrate,
                delay: snd.delay,
                master_gain: o.master_gain,
                accepted: o.accepted,
                pace: s.video.as_ref().map(|_| TICKS),
            };
            let (sh3, tx) = (&sh, out_tx.clone());
            workers.push(
                std::thread::Builder::new()
                    .name("export audio".into())
                    .spawn_scoped(scope, move || stages::audio(aj, m, sh3, tx)),
            );
        }
        drop(out_tx);
        let mut workers: Vec<_> =
            workers.into_iter().collect::<Result<_, _>>().map_err(|e| Failure::new("io", &e.to_string()))?;
        // Progress from this thread while the stages run.
        let mut last = Instant::now() - Duration::from_secs(1);
        while !writer.is_finished() || workers.iter().any(|w| !w.is_finished()) {
            std::thread::sleep(Duration::from_millis(20));
            if last.elapsed() < Duration::from_millis(100) {
                continue;
            }
            last = Instant::now();
            let elapsed = started.elapsed().as_secs_f64();
            let p = if frames > 0 {
                let done = sh.frames.load(Ordering::Relaxed);
                let fraction = done as f64 / frames as f64;
                let speed = sh.video_at.load(Ordering::Relaxed) as f64
                    / TICKS as f64
                    / encode_start.elapsed().as_secs_f64().max(1e-6);
                Progress {
                    phase: Phase::Video,
                    done,
                    total: frames,
                    fraction,
                    elapsed,
                    eta: (fraction > 0.0).then(|| elapsed / fraction * (1.0 - fraction)),
                    speed,
                }
            } else {
                let done = sh.samples.load(Ordering::Relaxed);
                let fraction = if total_samples > 0 { done as f64 / total_samples as f64 } else { 0.0 };
                let speed = done as f64 / 48000.0 / encode_start.elapsed().as_secs_f64().max(1e-6);
                Progress {
                    phase: Phase::Audio,
                    done,
                    total: total_samples,
                    fraction,
                    elapsed,
                    eta: (fraction > 0.0).then(|| elapsed / fraction * (1.0 - fraction)),
                    speed,
                }
            };
            progress(&p);
        }
        for w in workers.drain(..) {
            let _ = w.join();
        }
        Ok(writer.join().ok().flatten())
    });
    let encoder = sh.encoder.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let used = encoder.as_ref().map(|e| e.0.clone());
    let part = result.map_err(|f| (f, used.clone()))?;
    if cancel.load(Ordering::Relaxed) {
        return Err((cancelled(), None));
    }
    if let Some(f) = sh.failure() {
        return Err((f, used));
    }
    let part = part.ok_or_else(|| (Failure::new("io", "cannot write the file"), used.clone()))?;
    let encode_seconds = encode_start.elapsed().as_secs_f64();
    o.clocks.add(Step::Stages, encode_start.elapsed());
    if frames > 0 {
        let done = sh.frames.load(Ordering::Relaxed);
        progress(&Progress {
            phase: Phase::Video,
            done,
            total: frames,
            fraction: done as f64 / frames as f64,
            elapsed: started.elapsed().as_secs_f64(),
            eta: Some(0.0),
            speed: (o.to - o.from) as f64 / TICKS as f64 / encode_seconds.max(1e-6),
        });
    }
    let committed = o.clocks.time(Step::Commit, || part.commit()).map_err(|f| (f, used.clone()))?;
    let mut slated: Vec<Id> = sh.slated.lock().unwrap_or_else(|e| e.into_inner()).iter().copied().collect();
    slated.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    Ok(Attempt { committed, frames, encoder, encode_seconds, slated })
}
