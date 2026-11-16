//! Media files in Nano Studio Cut: every container the editor imports read into a [`Source`] (tracks with sample
//! tables in ticks), and the MP4 writer of exports.
//!
//! The port of `renderer/features/cut/{codecs,mp4read,mkvread,audioread,probe,mp4write}.js`, specified in section 5
//! of `docs/cut-architecture.md`. [`probe::open`] never fails: a file that cannot be used comes back with
//! [`Source::error`], with the JavaScript's codes and messages. Bytes come through a [`Reader`] that asks for ranges,
//! so a 10 GB file is never loaded whole; parsing works on the borrowed bytes of each read.

pub mod audio;
pub mod bits;
pub mod bytes;
pub mod codecs;
mod error;
pub mod mkv;
pub mod mp4;
pub mod probe;
mod reader;
mod source;
pub mod table;

pub use error::{ErrorCode, FormatError, Result};
pub use reader::{FileReader, MemReader, Reader, read_range};
pub use source::{
    Audio, ColorSpace, Container, Image, Kind, Matrix, Media, Primaries, SampleTable, Skipped, Source, Track, Transfer,
    Video,
};
