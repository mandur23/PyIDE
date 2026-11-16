//! The sound of Nano Studio Cut: the native counterpart of `renderer/features/cut/audioengine.js` and `audiofx.js`,
//! and of the audio parts of `analyze.js`, `thumbs.js` and `player.js` (docs/cut-architecture.md section 9).
//!
//! One [`Mixer`] computes a sequence's audio sample by sample for both the preview and the export: every audio clip
//! with its volume, duck and pan keyframes, fade handles, audio transitions, gain effects and processor chains
//! ([`fx`]), speed with the pitch kept ([`stretch`]) or not ([`resample`]), reverse, nests, track volume, pan, mute and
//! solo, and the sequence's master gain. The arithmetic is the JavaScript's (doubles, with the same values rounded to
//! 32-bit floats where it stores them in a `Float32Array`), so a mix matches the JavaScript's sample for sample within
//! float rounding. [`source`] reads files on demand, [`loudness`] measures BS.1770 loudness, [`analysis`] makes
//! waveform peaks and levels, and [`playback`] plays the mix through the default output device and gives the clock
//! the picture follows.

pub mod analysis;
pub mod effects;
pub mod fx;
pub mod loudness;
pub mod mixer;
pub mod offline;
pub mod playback;
pub mod resample;
pub mod source;
pub mod stretch;
pub mod util;

pub use mixer::{Failure, GetAudio, Held, Mixed, Mixer};
pub use source::{Audio, AudioError, AudioRead, Library, TrackReader, decodes};
