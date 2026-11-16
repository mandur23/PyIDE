//! Pictures drawn on the CPU (text clips, graphics, burned-in captions, error slates) drawn on a thread of their
//! own, so a render never waits for one: until a new picture is ready the engine shows the one it had for that item
//! (compositor.js draws its canvases on the main thread; 31 to 38 ms a caption here before this).

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use crate::text::TextRenderer;

/// A drawing: what it shows into RGBA8 pixels (not premultiplied) with the thread's fonts.
pub(crate) type Job = Box<dyn FnOnce(&mut TextRenderer) -> Vec<u8> + Send>;

/// A finished drawing: the item key and signature it was asked for, its size and pixels.
struct Done {
    key: String,
    sig: String,
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}

enum Ask {
    Draw { key: String, sig: String, w: u32, h: u32, job: Job },
    Warm,
}

/// The drawing thread of one engine and the drawings it was asked for.
pub(crate) struct Raster {
    asks: Sender<Ask>,
    done: Receiver<Done>,
    /// Signatures asked for and not back yet, by item key.
    pending: HashMap<String, String>,
}

impl Raster {
    pub(crate) fn new(waker: impl Fn() + Send + 'static) -> Self {
        let (asks, inbox) = channel::<Ask>();
        let (outbox, done) = channel();
        let _ = std::thread::Builder::new().name("cut-engine raster".into()).spawn(move || {
            let mut text = TextRenderer::new();
            while let Ok(a) = inbox.recv() {
                match a {
                    Ask::Warm => text.warm(),
                    Ask::Draw { key, sig, w, h, job } => {
                        let rgba = job(&mut text);
                        if outbox.send(Done { key, sig, w, h, rgba }).is_err() {
                            return;
                        }
                        waker();
                    }
                }
            }
        });
        Self { asks, done, pending: HashMap::new() }
    }

    /// Loads the fonts on the thread now, rather than at the first text drawn.
    pub(crate) fn warm(&self) {
        let _ = self.asks.send(Ask::Warm);
    }

    /// Asks for the picture of `key` with signature `sig`, unless it is being drawn already.
    pub(crate) fn ask(&mut self, key: &str, sig: &str, w: u32, h: u32, job: impl FnOnce() -> Job) {
        if self.pending.get(key).is_some_and(|s| s == sig) {
            return;
        }
        if self.asks.send(Ask::Draw { key: key.into(), sig: sig.into(), w, h, job: job() }).is_ok() {
            self.pending.insert(key.into(), sig.into());
        }
    }

    /// The drawings finished since the last call, `(key, sig, w, h, rgba)`; with `wait`, first waits up to that long
    /// for the one of `key` to finish.
    pub(crate) fn finished(&mut self, wait: Option<(&str, Duration)>) -> Vec<(String, String, u32, u32, Vec<u8>)> {
        let mut out = Vec::new();
        let mut take = |d: Done, pending: &mut HashMap<String, String>| {
            if pending.get(&d.key) == Some(&d.sig) {
                pending.remove(&d.key);
            }
            out.push((d.key, d.sig, d.w, d.h, d.rgba));
        };
        if let Some((key, timeout)) = wait {
            let end = std::time::Instant::now() + timeout;
            while self.pending.contains_key(key) {
                let left = end.saturating_duration_since(std::time::Instant::now());
                match self.done.recv_timeout(left) {
                    Ok(d) => take(d, &mut self.pending),
                    Err(_) => break,
                }
            }
        }
        while let Ok(d) = self.done.try_recv() {
            take(d, &mut self.pending);
        }
        out
    }
}
