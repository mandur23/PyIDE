//! The Lumetri Scopes' counts (port of scopes.js's counting): a luma waveform, an RGB parade, a vectorscope and RGB
//! and luma histograms of the frame's box in the output, in integer Rec. 709 math, so the GPU's compute pass
//! (`scopes.wgsl`, copied from the JavaScript) and [`analyze`] over the read-back pixels count the same bins.

/// About this many pixels are counted (one in `step` across and down).
pub const BUDGET: u32 = 262_144;
/// Cb or Cr of 1 after `>> 7`.
pub const UNIT: i64 = 130_560;
/// The vectorscope's half width: 0.6 of Cb and Cr.
pub const K: i64 = 78_336;

/// Offsets of each scope in one u32 array.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub cols: u32,
    pub size: u32,
    pub wave: u32,
    pub parade: u32,
    pub vector: u32,
    pub hist: u32,
    pub total: u32,
}

pub fn layout(cols: u32, size: u32) -> Layout {
    let parade = cols * 256;
    let vector = parade + 3 * cols * 256;
    let hist = vector + size * size;
    Layout { cols, size, wave: 0, parade, vector, hist, total: hist + 4 * 256 }
}

/// The pixels `[x0, x1) x [y0, y1)` of a `width` x `height` output that show a `seq_w` x `seq_h` sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

pub fn frame_rect(width: u32, height: u32, seq_w: f64, seq_h: f64) -> Rect {
    let (w, h) = (f64::from(width), f64::from(height));
    let fit = (w / seq_w).min(h / seq_h);
    let (bw, bh) = (seq_w * fit / w, seq_h * fit / h);
    let lo = |b: f64, n: f64| ((1.0 - b) / 2.0 * n - 0.5).ceil().max(0.0) as u32;
    let hi = |b: f64, n: f64| ((((1.0 + b) / 2.0) * n - 0.5).floor() + 1.0).min(n) as u32;
    Rect { x0: lo(bw, w), y0: lo(bh, h), x1: hi(bw, w), y1: hi(bh, h) }
}

pub fn step_for(r: Rect, budget: u32) -> u32 {
    let area = f64::from(r.x1.saturating_sub(r.x0)) * f64::from(r.y1.saturating_sub(r.y0));
    ((area / f64::from(budget)).sqrt().ceil() as u32).max(1)
}

/// The CPU count over RGBA bytes of a `width`-wide picture.
pub fn analyze(rgba: &[u8], width: u32, r: Rect, cols: u32, size: u32, step: u32) -> (Vec<u32>, Layout) {
    let l = layout(cols, size);
    let mut bins = vec![0u32; l.total as usize];
    let rw = r.x1.saturating_sub(r.x0);
    if rw == 0 || r.y1 <= r.y0 {
        return (bins, l);
    }
    let plane = cols * 256;
    let step = step.max(1) as usize;
    for y in (r.y0..r.y1).step_by(step) {
        for x in (r.x0..r.x1).step_by(step) {
            let i = ((y * width + x) * 4) as usize;
            let (rr, g, b) = (i64::from(rgba[i]), i64::from(rgba[i + 1]), i64::from(rgba[i + 2]));
            let col = (x - r.x0) * cols / rw;
            let luma = ((13933 * rr + 46871 * g + 4732 * b + 32768) >> 16) as u32;
            bins[(l.wave + luma * cols + col) as usize] += 1;
            for (c, v) in [rr, g, b].into_iter().enumerate() {
                bins[(l.parade + c as u32 * plane + v as u32 * cols + col) as usize] += 1;
                bins[(l.hist + c as u32 * 256 + v as u32) as usize] += 1;
            }
            bins[(l.hist + 768 + luma) as usize] += 1;
            let cb = (-7509 * rr - 25259 * g + 32768 * b) >> 7;
            let cr = (32768 * rr - 29763 * g - 3005 * b) >> 7;
            let vx = ((cb + K) * i64::from(size)).div_euclid(2 * K);
            let vy = ((K - cr) * i64::from(size)).div_euclid(2 * K);
            if vx >= 0 && vy >= 0 && vx < i64::from(size) && vy < i64::from(size) {
                bins[(l.vector as i64 + vy * i64::from(size) + vx) as usize] += 1;
            }
        }
    }
    (bins, l)
}

/// The uniform block of `scopes.wgsl` (12 u32).
pub fn uniforms(r: Rect, l: Layout, step: u32) -> [u32; 12] {
    [r.x0, r.y0, r.x1, r.y1, l.cols, l.size, step, K as u32, l.wave, l.parade, l.vector, l.hist]
}

/// Workgroups to dispatch.
pub fn dispatch(r: Rect, step: u32) -> (u32, u32) {
    ((r.x1.saturating_sub(r.x0)).div_ceil(step).div_ceil(16), (r.y1.saturating_sub(r.y0)).div_ceil(step).div_ceil(16))
}
