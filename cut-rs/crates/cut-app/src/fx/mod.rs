//! Effects, keyframes and colour on screen: the Effects panel ([`effects`]), the handles over the Program monitor (the transform box, crop and masks:
//! [`overlay`]), the Lumetri Color panel ([`color`]), the Lumetri Scopes ([`scopes`]). The workspaces
//! (`crate::workspaces`) lay them out with the other panels.
//!
//! The panels change the project only through commands (`cut_model::commands::build`) run by [`App::exec`]
//! (crate::state::App::exec), through the helpers of [`edit`]; their own state (open folders, the mask being
//! edited) lives in [`Fx`], one field of the shell.

pub mod actions;
pub mod color;
pub mod edit;
pub mod effects;
pub mod overlay;
pub mod scopes;
pub mod widgets;

use cut_model::Id;

/// What a click on the Program monitor picks for a control instead of its usual meaning (an eyedropper, a point).
#[derive(Debug, Clone, PartialEq)]
pub struct Pick {
    pub clip: Id,
    /// The property path the picked value goes to.
    pub path: String,
    pub kind: PickKind,
}

/// The kind of value a [`Pick`] writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickKind {
    /// `#rrggbb` of the monitor's pixel under the pointer.
    Color,
    /// `[x, y]` in the clip picture's pixels from its center (what a `point` parameter holds).
    Point,
    /// An eyedropper of the Lumetri panel: the panel reads the colour and makes its own edit.
    Lumetri(color::Dropper),
}

/// The state of these panels, kept by the shell between frames.
#[derive(Default)]
pub struct Fx {
    pub effects: effects::State,
    pub overlay: overlay::State,
    pub color: color::State,
    pub scopes: scopes::State,
    /// The control waiting for a click on the Program monitor.
    pub pick: Option<Pick>,
    /// The colour a Lumetri eyedropper picked, for the panel to use on its next frame.
    pub picked_color: Option<(color::Dropper, [u8; 3])>,
}
