//! Scene cuts from colour histograms of small frames (`analyze.js` `histogram`, `histDistance`, `detectScenes`):
//! pure, the frames asked for through a function so the analysis thread decodes them and a test can hand them in.

/// A joint RGB histogram of RGBA pixels, `bins` steps a channel, summing to 1 (a `Float32Array` in the JavaScript).
pub fn histogram(rgba: &[u8], w: usize, h: usize, bins: usize) -> Vec<f32> {
    let bins = bins.max(1);
    let mut out = vec![0f32; bins * bins * bins];
    let q = 256.0 / bins as f64;
    // a pixel past the end of the bytes reads as black, as the JavaScript's `undefined / q | 0` is 0
    let ch = |at: usize| rgba.get(at).map_or(0, |&v| ((f64::from(v) / q) as usize).min(bins - 1));
    for i in 0..w * h {
        out[(ch(i * 4) * bins + ch(i * 4 + 1)) * bins + ch(i * 4 + 2)] += 1.0;
    }
    let d = if w * h == 0 { 1.0 } else { (w * h) as f64 };
    for v in &mut out {
        *v = (f64::from(*v) / d) as f32;
    }
    out
}

/// Half the L1 distance: 0 for the same distribution, 1 for ones that share nothing.
pub fn hist_distance(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).fold(0.0, |d, (x, y)| d + (f64::from(*x) - f64::from(*y)).abs()) / 2.0
}

/// Scene cuts among the frames of presentation ranks `r0..=r1`: every `step`-th frame is compared with the one before
/// it; a difference above `threshold` is narrowed to the first frame of the new picture, and dropped when the picture
/// `step` frames later is the old one again (a flash) or still far from this one (a fade or a dissolve, which keeps
/// one cut where it settles). `hist_at(rank)` gives a frame's histogram or stops the search -> the ranks of the first
/// frame of each new scene.
pub fn detect_scenes<E>(
    r0: i64,
    r1: i64,
    mut hist_at: impl FnMut(i64) -> Result<Vec<f32>, E>,
    threshold: f64,
    step: i64,
    mut progress: impl FnMut(f64),
) -> Result<Vec<i64>, E> {
    let mut cuts = Vec::new();
    if r1 <= r0 {
        return Ok(cuts);
    }
    let step = step.max(1);
    let mut prev_rank = r0;
    let mut prev = hist_at(r0)?;
    let mut r = r1.min(r0 + step);
    while r <= r1 {
        let cur = hist_at(r)?;
        if hist_distance(&prev, &cur) > threshold {
            let mut first = r;
            for k in prev_rank + 1..r {
                if hist_distance(&prev, &hist_at(k)?) > threshold {
                    first = k;
                    break;
                }
            }
            let after = r1.min(r + step);
            let next = if after > r { Some(hist_at(after)?) } else { None };
            let flash = next.as_ref().is_some_and(|n| hist_distance(&prev, n) <= threshold / 2.0);
            let changing = next.as_ref().is_some_and(|n| hist_distance(&cur, n) > threshold);
            if !flash && !changing {
                cuts.push(first);
                prev = cur;
            }
        } else {
            prev = cur;
        }
        prev_rank = r;
        progress((r - r0) as f64 / (r1 - r0) as f64);
        r = if r == r1 { r1 + 1 } else { r1.min(r + step) };
    }
    Ok(cuts)
}
