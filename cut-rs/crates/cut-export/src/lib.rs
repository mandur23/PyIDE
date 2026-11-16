//! Export in Nano Studio Cut: the native counterpart of `renderer/features/cut/presets.js` and `export.js` and of
//! main's file sink and `cut:faststart` (section 9 of `docs/cut-architecture.md`, `Cut.presets` and `Cut.export`).
//!
//! [`presets`] resolves a preset to the settings of one export and estimates its size and time; [`plan`] holds the
//! pure parts (the frames of a range, chapters, captions in a range, file names); [`sink`] is the `.part` file renamed
//! over the target when it is complete; [`faststart`] moves the index to the front; [`verify`] opens the result
//! again.
//!
//! [`run`] is the export itself. Its stages run on threads of their own with bounded queues between them: the
//! picture is rendered by `cut_engine` on the GPU and turned into NV12 there by a compute pass (only 1.5 bytes a
//! pixel cross to memory), encoded by a GPU's hardware encoder or in software (`cut_decode::encode`), the sound is
//! mixed by `cut_audio` and AAC-encoded on another thread, and one writer muxes both into the `.part` file with
//! `cut_formats::mp4::write`.

mod aac;
pub mod faststart;
pub mod job;
pub mod lost;
mod nv12;
pub mod plan;
pub mod presets;
mod run;
pub mod sink;
mod stages;
pub mod timing;
pub mod verify;

pub use aac::{aac_delay, aac_setup};
pub use job::{CaptionMode, Done, EncoderUsed, Hardware, Job, Phase, Progress};
pub use run::{encoder_choices, run};
pub use sink::Failure;
