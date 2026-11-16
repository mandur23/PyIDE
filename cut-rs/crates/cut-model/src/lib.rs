//! The project model of Nano Studio Cut: the `.ncut` document as Rust types, the questions every layer asks of it,
//! keyframes, time remapping, masks, captions, the edit commands and their undo history.
//!
//! The port of `renderer/features/cut/model.js` and the modules around it (docs/cut-architecture.md sections 4 and 6).
//! A project file saved by either editor opens in the other: the JSON field names are the JavaScript's, and fields this
//! version does not know are kept.
//!
//! [`Project::load`] reads a file of this version straight into the types and runs `migrate` only on older ones.
//! [`History::apply`] normalizes and validates only what a command touched; [`commands::build`] makes the commands.
//! Also here as data: the effect registry ([`effects`]), graphic layers ([`graphic`]), LUT entries ([`lumetri`]) and
//! caption files in UTF-8, UTF-16 or CP949 ([`srt`]).

pub mod canon;
pub mod captionwords;
pub mod commands;
mod de;
pub mod defaults;
pub mod effects;
pub mod graphic;
pub mod history;
pub mod id;
pub mod keyframes;
pub mod lumetri;
pub mod masks;
pub mod migrate;
mod order;
pub mod project;
pub mod query;
pub mod remap;
pub mod sequence;
pub mod srt;
pub mod validate;

pub use commands::{Code, CommandError};
pub use history::History;
pub use id::Id;
pub use project::*;
pub use validate::{Validation, validate};
