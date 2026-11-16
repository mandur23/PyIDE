//! MP4 and MOV (ISO BMFF / QuickTime): the reader and the writer.

mod boxes;
mod entry;
mod read;
pub mod write;

pub use boxes::{Bx, boxes, child};
pub use read::open;
