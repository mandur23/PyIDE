//! Playback as the panels see it: play, pause, the shuttle rate and the playhead's clock. The panels call only
//! [`Transport`]. [`Player`] is the real one: the sound through `cut-audio`'s [`Playback`] and its clock, which the
//! picture follows (player.js `startClock` / `clockNow`); [`WallClock`] advances by the wall clock alone.

use std::sync::Arc;
use std::time::{Duration, Instant};

use cut_audio::playback::{Meters, Playback};
use cut_audio::{Audio, GetAudio, Library};
use cut_model::{Id, Project};
use cut_time::{TICKS, Ticks};

/// The playback control the monitors, the keys and the timeline use.
pub trait Transport {
    /// Starts playing from `from` at `rate` (1 normal speed, negative backwards: J/K/L); also a seek while playing.
    fn play(&mut self, from: Ticks, rate: f64);
    /// Stops; the playhead stays where playback was.
    fn pause(&mut self);
    fn playing(&self) -> bool;
    /// The playback rate while playing (0 when paused).
    fn rate(&self) -> f64;
    /// Where playback is now, while playing.
    fn now(&mut self) -> Option<Ticks>;
    /// The project and sequence the sound plays (after every change of either).
    fn set_project(&mut self, _project: Arc<Project>, _seq: Id) {}
    /// The levels being heard now (`None`: there is no sound).
    fn meters(&self) -> Option<Meters> {
        None
    }
    /// Device callbacks so far and those the mix was late for.
    fn underruns(&self) -> (u64, u64) {
        (0, 0)
    }
    /// A last multiplier on what reaches the speakers (tests play at 0).
    fn set_output_gain(&mut self, _gain: f32) {}
    /// What plays the clock: `sound`, `wall` (no device, another rate, or a sound clock that stalled) or `stopped`.
    fn clock(&self) -> &'static str {
        if self.playing() { "wall" } else { "stopped" }
    }
}

/// A transport that advances time by the wall clock, with no picture or sound.
#[derive(Debug, Default)]
pub struct WallClock {
    run: Option<(Instant, Ticks, f64)>,
}

impl WallClock {
    fn at(&self) -> Option<Ticks> {
        let (at, from, rate) = self.run?;
        let moved = at.elapsed().as_secs_f64() * rate * TICKS as f64;
        Some((from as f64 + moved).round().max(0.0) as Ticks)
    }
}

impl Transport for WallClock {
    fn play(&mut self, from: Ticks, rate: f64) {
        self.run = (rate != 0.0).then(|| (Instant::now(), from, rate));
    }

    fn pause(&mut self) {
        self.run = None;
    }

    fn playing(&self) -> bool {
        self.run.is_some()
    }

    fn rate(&self) -> f64 {
        self.run.map_or(0.0, |r| r.2)
    }

    fn now(&mut self) -> Option<Ticks> {
        self.at()
    }
}

/// A sound clock that stands still this long has stopped (no output device, or it never started): the picture goes
/// on by the wall clock from there (player.js `AUDIO_STALL_MS`).
pub const AUDIO_STALL: Duration = Duration::from_millis(2500);

/// What the clock of a run follows.
enum Clock {
    /// The sound's position; the last value that changed and when.
    Sound {
        heard: Ticks,
        at: Instant,
    },
    Wall(WallClock),
}

/// The transport of the editor: the mix played from the playhead, its clock the picture's.
pub struct Player {
    library: Library,
    sound: Option<Playback>,
    run: Option<(f64, Clock)>,
    /// What the sound was last given, for a device opened again.
    project: Option<(Arc<Project>, Id)>,
    gain: Option<f32>,
    /// The sound's clock stood still in the last run: its device no longer calls.
    stalled: bool,
    /// How often the output device was opened again.
    reopened: u32,
}

/// Whether the output device has to be opened again before the sound can play: there is no player (no device when
/// the app started), its stream reported an error (the device was unplugged, disabled or its format changed), its
/// clock stood still, or another device is the default now (headphones plugged in, a Bluetooth device connected).
/// Without this the first of these left every later playback silent until the app was started again.
pub fn must_reopen(opened: Option<&str>, default: Option<&str>, error: bool, stalled: bool) -> bool {
    match (opened, default) {
        (None, d) => d.is_some(),
        (Some(_), None) => error || stalled,
        (Some(o), Some(d)) => error || stalled || o != d,
    }
}

/// The mixer's sources: every file opened through one [`Library`], read on demand.
pub fn file_audio(library: Library) -> GetAudio {
    Box::new(move |_p, m| {
        let reader = library.audio(std::path::Path::new(&m.path))?;
        Ok(reader.map(|r| Audio::Reader(Box::new(r))))
    })
}

impl Player {
    /// The player on the default output device; without one (or when it cannot open) the clock is the wall's.
    /// `CUT_OUTPUT_GAIN` sets the last multiplier (0: silent).
    pub fn new(library: Library) -> (Self, Option<String>) {
        let (sound, error) = match Playback::new(file_audio(library.clone())) {
            Ok(p) => (Some(p), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let gain = std::env::var("CUT_OUTPUT_GAIN").ok().and_then(|v| v.parse::<f32>().ok());
        if let (Some(p), Some(g)) = (&sound, gain) {
            p.set_output_gain(g);
        }
        (Self { library, sound, run: None, project: None, gain, stalled: false, reopened: 0 }, error)
    }

    /// How often the output device was opened again since the start.
    pub fn reopened(&self) -> u32 {
        self.reopened
    }

    /// The device the sound plays to (`None`: there is no sound).
    pub fn device(&self) -> Option<&str> {
        self.sound.as_ref().map(Playback::device)
    }

    /// Tests: as if the sound's clock had stood still in the last run.
    pub fn mark_stalled(&mut self) {
        self.stalled = true;
    }

    /// Opens the output device again when [`must_reopen`] says so, and gives the new player what the old one had:
    /// the project, the sequence and the output gain. Opening takes a few hundred milliseconds, once.
    fn recover(&mut self) {
        let default = cut_audio::playback::default_device();
        let (opened, error) = match &self.sound {
            Some(p) => (Some(p.device().to_owned()), p.error().is_some()),
            None => (None, false),
        };
        if !must_reopen(opened.as_deref(), default.as_deref(), error, self.stalled) {
            return;
        }
        self.stalled = false;
        // the old stream and its mixing thread end before the device is opened again
        self.sound = None;
        if let Ok(p) = Playback::new(file_audio(self.library.clone())) {
            if let Some(g) = self.gain {
                p.set_output_gain(g);
            }
            if let Some((project, seq)) = &self.project {
                p.set_project(project.clone(), *seq);
            }
            self.sound = Some(p);
            self.reopened += 1;
        }
    }

    fn stop_sound(&mut self) {
        if let (Some((_, Clock::Sound { .. })), Some(p)) = (&self.run, &self.sound) {
            p.stop();
        }
    }
}

impl Transport for Player {
    fn play(&mut self, from: Ticks, rate: f64) {
        self.stop_sound();
        if rate == 0.0 {
            self.run = None;
            return;
        }
        // Only normal speed follows the sound, as the JavaScript's preview: other rates are silent on the wall clock.
        if rate == 1.0 {
            self.recover();
        }
        let clock = match &self.sound {
            Some(p) if rate == 1.0 => {
                p.start(from, 1.0);
                Clock::Sound { heard: from, at: Instant::now() }
            }
            _ => {
                let mut w = WallClock::default();
                w.play(from, rate);
                Clock::Wall(w)
            }
        };
        self.run = Some((rate, clock));
    }

    fn pause(&mut self) {
        self.stop_sound();
        self.run = None;
    }

    fn playing(&self) -> bool {
        self.run.is_some()
    }

    fn rate(&self) -> f64 {
        self.run.as_ref().map_or(0.0, |r| r.0)
    }

    fn now(&mut self) -> Option<Ticks> {
        let (rate, clock) = self.run.as_mut()?;
        match clock {
            Clock::Wall(w) => w.at(),
            Clock::Sound { heard, at } => {
                let v = self.sound.as_ref().map_or(*heard, Playback::position);
                if v != *heard {
                    *heard = v;
                    *at = Instant::now();
                    return Some(v);
                }
                if at.elapsed() < AUDIO_STALL {
                    return Some(v);
                }
                if let Some(p) = &self.sound {
                    p.stop();
                }
                // the device stopped calling: it is opened again before the next play
                self.stalled = true;
                let mut w = WallClock::default();
                w.play(v, *rate);
                *clock = Clock::Wall(w);
                Some(v)
            }
        }
    }

    fn set_project(&mut self, project: Arc<Project>, seq: Id) {
        if let Some(p) = &self.sound {
            p.set_project(project.clone(), seq);
        }
        self.project = Some((project, seq));
    }

    fn meters(&self) -> Option<Meters> {
        self.sound.as_ref().map(Playback::meters)
    }

    fn underruns(&self) -> (u64, u64) {
        self.sound.as_ref().map_or((0, 0), Playback::stats)
    }

    fn set_output_gain(&mut self, gain: f32) {
        if let Some(p) = &self.sound {
            p.set_output_gain(gain);
        }
        self.gain = Some(gain);
    }

    fn clock(&self) -> &'static str {
        match &self.run {
            None => "stopped",
            Some((_, Clock::Sound { .. })) => "sound",
            Some((_, Clock::Wall(_))) => "wall",
        }
    }
}

/// The next J/L shuttle rate (ui-monitors.js `SHUTTLE`: 1, 2, 4, 8 in one direction; the other key starts at 1).
pub fn shuttle(rate: f64, forward: bool) -> f64 {
    let dir = if forward { 1.0 } else { -1.0 };
    if rate == 0.0 || rate.signum() != dir { dir } else { (rate * 2.0).clamp(-8.0, 8.0) }
}

/// How many frames a step of the playhead skipped beyond what the rate itself skips (player.js `droppedBetween`).
pub fn dropped_between(prev: Option<i64>, next: i64, rate: f64) -> i64 {
    let Some(prev) = prev else { return 0 };
    let step = (next - prev).abs();
    (step - (rate.abs().ceil() as i64).max(1)).max(0)
}
