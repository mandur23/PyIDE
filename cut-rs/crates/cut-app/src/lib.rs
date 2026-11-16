//! Nano Studio Cut's native screen: the port of the JavaScript editor's `state.js`, `ui-*.js` and `main/cut/*.js`
//! (docs/cut-architecture.md sections 4, 7 and 10; docs/cut-app.md for what the person sees and every key).
//!
//! The logic is here, testable without a window: the app state ([`state`]), the project files ([`files`], [`doc`]),
//! importing ([`import`]), the keyboard ([`keys`], [`actions`]), the timeline's geometry and gestures
//! ([`timeline::layout`], [`timeline::gesture`]). The panels draw it with egui; [`shell::Shell`] is the window.
//! Pictures and sound come from `cut-engine` and `cut-audio`: the monitors show the engine's textures ([`picture`]),
//! playback follows the sound's clock ([`transport::Player`]), thumbnails and waveforms are made off the UI thread
//! ([`thumbs`]).

pub mod actions;
pub mod audio;
pub mod auto;
pub mod captions;
pub mod cmd;
pub mod controls;
pub mod doc;
pub mod edit;
pub mod export;
pub mod features;
pub mod files;
pub mod fx;
pub mod i18n;
pub mod icons;
pub mod import;
pub mod keys;
pub mod panels;
pub mod picture;
pub mod prefs;
pub mod shell;
pub mod state;
pub mod text_ui;
pub mod theme;
pub mod thumbs;
pub mod timeline;
pub mod transport;
pub mod view;
pub mod windows;
pub mod workspaces;
