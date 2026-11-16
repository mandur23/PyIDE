//! Drags between the app's windows (Project to a Timeline in its own window, Effects onto a clip in the main window).
//!
//! What Windows and winit 0.30 deliver while a button is held: the window where it was pressed calls `SetCapture`
//! (winit, on the button's down), so that window alone gets the mouse until the button comes up. Its `WM_MOUSEMOVE`s
//! carry client coordinates past its edges (winit sends `CursorLeft` once, then `CursorMoved` with those points; egui
//! keeps the drag and the pointer outside its rectangle), the release comes to it too, and every other window of the
//! app sees nothing. Releasing the capture would need `unsafe` Win32 calls, which this crate may not make.
//!
//! So the window a drag started in hands it over: each of its frames with the drag's payload and the pointer past its
//! edges over another of the app's windows stores the point (that window's points), the release and the payload for
//! that window's next input, and asks it to repaint. An egui plugin ([`Plugin`]) puts them into that input: egui runs
//! a plugin's input hook for every viewport's pass, the immediate ones included, which eframe's own input hook skips.
//! The window then sees the pointer, its drop targets light up as for a drag of its own, and on the release the
//! payload is dropped there (the window the drag started in dropped it at the end of its frame). The first pass after
//! the relay ends, the pointer leaves that window.

use std::sync::{Arc, Mutex};

use eframe::egui::{self, Event, Modifiers, PointerButton, Pos2, ViewportId};

use super::view::w;
use crate::shell::Shell;
use crate::state::MediaDrag;

/// The drags handed from one window to another, shared with the [`Plugin`].
#[derive(Clone, Default)]
pub struct Relays(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    relay: Option<Relay>,
    /// The window that got a relayed pointer last, which the pointer leaves when the relay ends.
    shown: Option<ViewportId>,
}

/// A drag over another window than the one it started in: which window, where (its points), and the payload.
struct Relay {
    to: ViewportId,
    pos: Pos2,
    released: bool,
    modifiers: Modifiers,
    payload: Payload,
}

/// The drags the panels make that other panels take.
#[derive(Clone)]
enum Payload {
    Media(MediaDrag),
    Source(crate::edit::source::SourceDrag),
    Fx(crate::fx::effects::FxDrag),
}

impl Payload {
    fn of(ctx: &egui::Context) -> Option<Payload> {
        use egui::DragAndDrop as D;
        D::payload::<MediaDrag>(ctx)
            .map(|p| Payload::Media((*p).clone()))
            .or_else(|| D::payload::<crate::edit::source::SourceDrag>(ctx).map(|p| Payload::Source(*p)))
            .or_else(|| D::payload::<crate::fx::effects::FxDrag>(ctx).map(|p| Payload::Fx(*p)))
    }

    fn set(self, ctx: &egui::Context) {
        use egui::DragAndDrop as D;
        match self {
            Payload::Media(p) => D::set_payload(ctx, p),
            Payload::Source(p) => D::set_payload(ctx, p),
            Payload::Fx(p) => D::set_payload(ctx, p),
        }
    }
}

impl Relays {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A window's input before its pass (`raw.viewport_id`): the pointer of a drag relayed to it, its release with
    /// the payload, or, the first pass after, the pointer leaving.
    pub fn hook(&self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        let me = raw.viewport_id;
        let mut st = self.state();
        match st.relay.take_if(|r| r.to == me) {
            Some(r) => {
                raw.events.push(Event::PointerMoved(r.pos));
                if r.released {
                    r.payload.set(ctx);
                    // Ctrl held at the drop inserts (this window has not seen the key: it is not focused)
                    raw.events.push(Event::ModifiersChanged(r.modifiers));
                    raw.events.push(Event::PointerButton {
                        pos: r.pos,
                        button: PointerButton::Primary,
                        pressed: false,
                        modifiers: r.modifiers,
                    });
                }
                st.shown = Some(me);
            }
            None if st.shown == Some(me) => {
                raw.events.push(Event::PointerGone);
                raw.events.push(Event::ModifiersChanged(Modifiers::NONE));
                st.shown = None;
            }
            None => {}
        }
    }
}

/// Gives every pass of every window its relayed drag ([`Relays::hook`]).
pub struct Plugin(pub Relays);

impl egui::plugin::Plugin for Plugin {
    fn debug_name(&self) -> &'static str {
        "cut-app drags between windows"
    }

    fn input_hook(&mut self, ctx: &egui::Context, input: &mut egui::RawInput) {
        self.0.hook(ctx, input);
    }
}

/// In the pass of the window a drag is held in: when the pointer is past its edges over another of the app's
/// windows (a panel's window before the main one, as they are usually in front), hands the drag to that window.
pub fn from(s: &mut Shell, ctx: &egui::Context) {
    if Payload::of(ctx).is_none() {
        return;
    }
    let here = ctx.viewport_id();
    let zoom = ctx.zoom_factor();
    let (pos, held, released, modifiers, inner, ppp, mut others) = ctx.input(|i| {
        let others: Vec<(ViewportId, egui::Rect, f32)> = i
            .raw
            .viewports
            .iter()
            .filter(|(id, _)| **id != here)
            .filter_map(|(id, v)| Some((*id, v.inner_rect?, v.native_pixels_per_point? * zoom)))
            .collect();
        let released = i.pointer.primary_released();
        let held = i.pointer.primary_down() || released;
        (i.pointer.latest_pos(), held, released, i.modifiers, i.viewport().inner_rect, i.pixels_per_point, others)
    });
    let (Some(pos), Some(inner), true) = (pos, inner, held) else { return };
    if ctx.content_rect().contains(pos) {
        return;
    }
    others.sort_by_key(|(id, _, _)| *id == ViewportId::ROOT);
    for (id, rect, vppp) in others {
        let target = super::view::px_rect(rect.min, rect.size(), vppp);
        if let Some(at) = super::to_window(inner.min, pos, ppp, target, vppp) {
            relay_drop(s, ctx, id, at, released, modifiers);
            return;
        }
    }
}

/// Hands the drag going on (its payload) to window `to`'s next input at `at` (its points), released or not.
pub fn relay_drop(s: &mut Shell, ctx: &egui::Context, to: ViewportId, at: Pos2, released: bool, modifiers: Modifiers) {
    let Some(payload) = Payload::of(ctx) else { return };
    w(s).relays.state().relay = Some(Relay { to, pos: at, released, modifiers, payload });
    ctx.request_repaint_of(to);
}
