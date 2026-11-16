//! The picture engine of Nano Studio Cut: the frame of a sequence at a time, drawn on the GPU.
//!
//! The native counterpart of `renderer/features/cut/{media,decoder,compositor,effects,lumetri,textrender,player}.js`
//! (section 8 of `docs/cut-architecture.md`). The WebGPU compositor's WGSL runs here unchanged through wgpu: the
//! shaders under `shaders/` are copied from the JavaScript by `tools/engine-wgsl.mjs` (a test fails when they drift),
//! with the uniform layouts the JavaScript packs, which [`uniforms`] packs the same way.
//!
//! [`Engine::render`] plans what is visible ([`plan`]), finds each item's picture (decoded frames from
//! [`media::FrameSource`]s that decode on threads of their own, stills, text from [`text`]), and encodes the passes
//! ([`draw`]). It never waits for a decoder unless asked to: a frame that is not decoded yet is drawn with the nearest
//! one there is and [`Rendered::complete`] is false; the waker set by [`Engine::set_waker`] says when to draw again.

pub mod color;
pub mod draw;
mod engine;
pub mod gpu;
pub mod graphic;
pub mod lumetri;
pub mod media;
pub mod plan;
mod raster;
mod route;
pub mod scopes;
pub mod text;
pub mod uniforms;

pub use engine::{Captions, Engine, EngineError, Failed, Memory, RenderOptions, Rendered, ScopeCounts, media_sequence};
