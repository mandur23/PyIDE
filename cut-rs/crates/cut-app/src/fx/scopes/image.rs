//! The scopes' counts turned into pictures (`ui-scopes.js`'s `plane`, `drawVector`, `drawHist`), on a worker thread
//! of their own: the UI thread only uploads the finished images as textures.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, OnceLock};

use cut_engine::scopes::Layout;
use eframe::egui::{self, Color32, ColorImage};

use super::{Kind, RANGE, SIZE};

/// What a picture is made from: one count.
pub struct Job {
    pub bins: Arc<Vec<u32>>,
    pub layout: Layout,
    /// Pixels a full waveform column holds, and a full vectorscope bin.
    pub full_wave: f64,
    pub full_vector: f64,
    pub kinds: Vec<Kind>,
}

/// The pictures of a count: one per scope, three for the parade.
pub type Images = Vec<(Kind, Vec<ColorImage>)>;

/// Brightness of a bin of `n` pixels when `full` pixels make a full bin.
fn glow(n: u32, full: f64) -> f64 {
    if n == 0 { 0.0 } else { (0.18 + f64::from(n).ln_1p() / full.max(2.0).ln_1p()).min(1.0) }
}

/// A waveform plane (`cols` x 256 bins, level 0 at the bottom) in `color`; empty bins transparent.
fn plane(bins: &[u32], cols: usize, color: [f64; 3], full: f64) -> ColorImage {
    let mut img = ColorImage::filled([cols, 256], Color32::TRANSPARENT);
    for l in 0..256 {
        for c in 0..cols {
            let a = glow(bins[l * cols + c], full);
            if a > 0.0 {
                let [r, g, b] = color.map(|v| (v * a) as u8);
                img.pixels[(255 - l) * cols + c] = Color32::from_rgb(r, g, b);
            }
        }
    }
    img
}

/// The display colour of each vectorscope bin: its Cb and Cr at a middle luma (made once).
fn vector_colors() -> &'static [[f64; 3]] {
    static COLORS: OnceLock<Vec<[f64; 3]>> = OnceLock::new();
    COLORS.get_or_init(|| {
        let n = SIZE as usize;
        let mut v = Vec::with_capacity(n * n);
        for y in 0..n {
            for x in 0..n {
                let cb = ((x as f64 + 0.5) * 2.0 * RANGE) / n as f64 - RANGE;
                let cr = RANGE - ((y as f64 + 0.5) * 2.0 * RANGE) / n as f64;
                let luma = 0.62;
                let rgb = [luma + 1.5748 * cr, luma - 0.1873 * cb - 0.4681 * cr, luma + 1.8556 * cb];
                v.push(rgb.map(|c| c.clamp(0.25, 1.0)));
            }
        }
        v
    })
}

/// The vectorscope of a `SIZE` x `SIZE` count, each bin in its own colour.
fn vector(bins: &[u32], full: f64) -> ColorImage {
    let size = SIZE as usize;
    let col = vector_colors();
    let mut img = ColorImage::filled([size, size], Color32::TRANSPARENT);
    for (i, &n) in bins.iter().enumerate().take(size * size) {
        let a = glow(n, full);
        if a > 0.0 {
            let hot = (a - 0.75).max(0.0) * 2.4;
            let [r, g, b] = col[i].map(|c| ((c * a + hot) * 255.0).min(255.0) as u8);
            img.pixels[i] = Color32::from_rgb(r, g, b);
        }
    }
    img
}

/// The RGB histogram: a row per level (255 at the top), each channel's bar as long as its count against the fullest
/// level (the ends left out), the bars added together over the scope's background.
fn histogram(hist: &[u32], bg: Color32) -> ColorImage {
    const W: usize = 256;
    let colors = [[255.0, 70.0, 70.0], [70.0, 235.0, 100.0], [80.0, 140.0, 255.0]];
    let mut reference = 1;
    for k in 0..3 {
        for l in 1..255 {
            reference = reference.max(hist[k * 256 + l]);
        }
    }
    let mut img = ColorImage::filled([W, 256], bg);
    for l in 0..256 {
        let row = &mut img.pixels[(255 - l) * W..][..W];
        let mut sums = vec![[f64::from(bg.r()), f64::from(bg.g()), f64::from(bg.b())]; W];
        for (k, c) in colors.iter().enumerate() {
            let n = hist[k * 256 + l];
            if n == 0 {
                continue;
            }
            let len = ((f64::from(n) / f64::from(reference)).min(1.0) * W as f64).max(1.0) as usize;
            for s in &mut sums[..len] {
                for j in 0..3 {
                    s[j] += c[j] * 0.85;
                }
            }
        }
        for (p, s) in row.iter_mut().zip(&sums) {
            *p = Color32::from_rgb(s[0].min(255.0) as u8, s[1].min(255.0) as u8, s[2].min(255.0) as u8);
        }
    }
    img
}

/// The pictures of one count (`bg`: the scopes' background, baked into the histogram).
pub fn images(job: &Job, bg: Color32) -> Images {
    let l = job.layout;
    let (cols, size) = (l.cols as usize, l.size as usize);
    let plane_len = cols * 256;
    let b = &job.bins[..];
    job.kinds
        .iter()
        .map(|k| {
            let list = match k {
                Kind::Wave => {
                    vec![plane(&b[l.wave as usize..][..plane_len], cols, [170.0, 255.0, 180.0], job.full_wave)]
                }
                Kind::Parade => [[255.0, 80.0, 80.0], [80.0, 235.0, 110.0], [90.0, 150.0, 255.0]]
                    .iter()
                    .enumerate()
                    .map(|(c, color)| {
                        plane(&b[l.parade as usize + c * plane_len..][..plane_len], cols, *color, job.full_wave)
                    })
                    .collect(),
                Kind::Vector => vec![vector(&b[l.vector as usize..][..size * size], job.full_vector)],
                Kind::Hist => vec![histogram(&b[l.hist as usize..][..4 * 256], bg)],
            };
            (*k, list)
        })
        .collect()
}

/// The worker thread: takes the newest count waiting (older ones are skipped), makes its pictures, hands them back
/// and asks the window to draw.
pub fn spawn(ctx: egui::Context, bg: Color32) -> (Sender<Job>, Receiver<Images>) {
    let (jobs, inbox) = channel::<Job>();
    let (outbox, done) = channel();
    std::thread::Builder::new()
        .name("cut-scopes".into())
        .spawn(move || {
            while let Ok(mut job) = inbox.recv() {
                while let Ok(newer) = inbox.try_recv() {
                    job = newer;
                }
                if outbox.send(images(&job, bg)).is_err() {
                    return;
                }
                ctx.request_repaint();
            }
        })
        .expect("the scopes' thread starts");
    (jobs, done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bin_glows_from_its_first_pixel_and_a_full_one_is_white_hot() {
        assert_eq!(glow(0, 100.0), 0.0);
        assert!((glow(1, 100.0) - (0.18 + 2f64.ln() / 101f64.ln())).abs() < 1e-12);
        assert_eq!(glow(1000, 100.0), 1.0);
    }

    #[test]
    fn a_waveform_level_is_drawn_from_the_bottom() {
        let mut bins = vec![0u32; 4 * 256];
        bins[10 * 4 + 2] = 5;
        let img = plane(&bins, 4, [170.0, 255.0, 180.0], 5.0);
        assert_eq!(img.size, [4, 256]);
        assert_ne!(img.pixels[(255 - 10) * 4 + 2], Color32::TRANSPARENT);
        assert_eq!(img.pixels.iter().filter(|p| **p != Color32::TRANSPARENT).count(), 1);
    }

    #[test]
    fn the_histograms_longest_bar_spans_the_scope() {
        let mut hist = vec![0u32; 1024];
        hist[100] = 40;
        hist[256 + 100] = 20;
        let img = histogram(&hist, Color32::BLACK);
        let row = &img.pixels[(255 - 100) * 256..][..256];
        assert_eq!(row[255], Color32::from_rgb(216, 59, 59), "red alone reaches the end");
        assert_eq!(row[200], Color32::from_rgb(216, 59, 59), "green stops half way");
        assert_eq!(row[100], Color32::from_rgb(255, 255, 144), "the bars add up");
    }
}
