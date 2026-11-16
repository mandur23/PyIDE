//! The display list into pixels with tiny-skia, as a Canvas 2D context draws it: each call composited with its
//! layer's composite operation; a call with a blur filter or a shadow drawn alone first, blurred, its shadow (the
//! picture's alpha in the shadow colour, blurred, offset) composited before it. Blurs are Gaussians made of three box
//! blurs (the Filter Effects spec's approximation).
//!
//! Threads: the calls with a blur or a shadow are drawn alone first, spread over the cores; then the picture is drawn
//! in horizontal bands, one thread each, every band compositing all calls in order (so blend modes see what lies
//! under them), and each band turned into straight alpha in place.

use std::thread;

use tiny_skia::{BlendMode, FillRule, FilterQuality, Paint, Pixmap, PixmapPaint, Transform};

use super::paint::Op;

/// How far a blur of standard deviation `sigma` reaches, in whole pixels.
fn reach(sigma: f32) -> i32 {
    if sigma > 0.0 { (sigma * 3.0).ceil() as i32 + 1 } else { 0 }
}

/// A call with a blur or a shadow, drawn alone: the picture and its shadow, each with where its top left goes.
struct Alone {
    picture: Pixmap,
    at: (i32, i32),
    shadow: Option<(Pixmap, (i32, i32))>,
}

fn cores() -> usize {
    thread::available_parallelism().map_or(1, |n| n.get()).min(8)
}

/// The ops drawn into a `w` x `h` picture: non-premultiplied RGBA8.
pub(super) fn rasterize(ops: &[Op], w: u32, h: u32) -> Vec<u8> {
    let (w, h) = (w.max(1), h.max(1));
    let alone = prepare(ops, w, h);
    let mut out = vec![0u8; w as usize * h as usize * 4];
    // a band per core when the picture is large enough for a thread to pay
    let n = if u64::from(w) * u64::from(h) < 400_000 { 1 } else { (cores() as u32).min(h / 64).max(1) };
    let rows = h.div_ceil(n);
    if n == 1 {
        band(ops, &alone, w, 0, &mut out);
    } else {
        thread::scope(|s| {
            for (i, part) in out.chunks_mut(rows as usize * w as usize * 4).enumerate() {
                let alone = &alone;
                s.spawn(move || band(ops, alone, w, i as u32 * rows, part));
            }
        });
    }
    out
}

/// Every call with a blur or a shadow drawn alone, the calls shared out over the cores.
fn prepare(ops: &[Op], w: u32, h: u32) -> Vec<Option<Alone>> {
    let wanted: Vec<usize> = (0..ops.len()).filter(|&i| ops[i].blur > 0.0 || ops[i].shadow.is_some()).collect();
    let mut out: Vec<Option<Alone>> = (0..ops.len()).map(|_| None).collect();
    if wanted.is_empty() {
        return out;
    }
    let n = cores().min(wanted.len());
    let done: Vec<(usize, Option<Alone>)> = if n == 1 {
        wanted.iter().map(|&i| (i, alone(&ops[i], w, h))).collect()
    } else {
        thread::scope(|s| {
            let jobs: Vec<_> = wanted
                .chunks(wanted.len().div_ceil(n))
                .map(|part| s.spawn(move || part.iter().map(|&i| (i, alone(&ops[i], w, h))).collect::<Vec<_>>()))
                .collect();
            jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
        })
    };
    for (i, a) in done {
        out[i] = a;
    }
    out
}

/// Rows `y0..` of the picture into `out` (whole rows of `w` pixels).
fn band(ops: &[Op], alone: &[Option<Alone>], w: u32, y0: u32, out: &mut [u8]) {
    let bh = (out.len() / (w as usize * 4)) as u32;
    let Some(mut pm) = Pixmap::new(w, bh) else { return };
    let wy = y0 as i32;
    for (op, a) in ops.iter().zip(alone) {
        match a {
            Some(a) => {
                if let Some((sh, (x, y))) = &a.shadow {
                    put(&mut pm, sh, *x, y - wy, op.blend);
                }
                put(&mut pm, &a.picture, a.at.0, a.at.1 - wy, op.blend);
            }
            None if op.blur > 0.0 || op.shadow.is_some() => {}
            None => {
                let b = op.path.bounds();
                if b.bottom() < y0 as f32 || b.top() > (y0 + bh) as f32 {
                    continue;
                }
                let hq = op.blend != BlendMode::SourceOver;
                // tiny-skia's 16-bit pipeline overflows in its overlay (a panic in debug builds); its float pipeline
                // blends every mode by the formulas exactly
                let paint =
                    Paint { shader: op.shader.clone(), blend_mode: op.blend, anti_alias: true, force_hq_pipeline: hq };
                pm.fill_path(&op.path, &paint, FillRule::Winding, Transform::from_translate(0.0, -(wy as f32)), None);
            }
        }
    }
    for (o, p) in out.as_chunks_mut::<4>().0.iter_mut().zip(pm.data().as_chunks::<4>().0) {
        *o = match p[3] {
            0 => [0; 4],
            255 => *p,
            a => {
                let un = |v: u8| ((u32::from(v) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8;
                [un(p[0]), un(p[1]), un(p[2]), a]
            }
        };
    }
}

/// `src` composited with its top left at `(x, y)` of `pm`.
fn put(pm: &mut Pixmap, src: &Pixmap, x: i32, y: i32, blend: BlendMode) {
    let (pw, ph) = (pm.width() as i32, pm.height() as i32);
    let (sw, sh) = (src.width() as i32, src.height() as i32);
    let (cx0, cx1, cy0, cy1) = (x.max(0), (x + sw).min(pw), y.max(0), (y + sh).min(ph));
    if cx0 >= cx1 || cy0 >= cy1 {
        return;
    }
    if blend != BlendMode::SourceOver {
        let p = PixmapPaint { opacity: 1.0, blend_mode: blend, quality: FilterQuality::Nearest };
        pm.draw_pixmap(x, y, src.as_ref(), &p, Transform::identity(), None);
        return;
    }
    // source-over by hand: tiny-skia draws a pixmap through its float pipeline, several times slower
    let dst = pm.data_mut();
    let from = src.data();
    for py in cy0..cy1 {
        let d = &mut dst[((py * pw + cx0) * 4) as usize..((py * pw + cx1) * 4) as usize];
        let sy = py - y;
        let s = &from[((sy * sw + cx0 - x) * 4) as usize..((sy * sw + cx1 - x) * 4) as usize];
        for (d, s) in d.as_chunks_mut::<4>().0.iter_mut().zip(s.as_chunks::<4>().0) {
            let keep = 255 - u32::from(s[3]);
            if keep == 255 {
                continue;
            }
            for k in 0..4 {
                d[k] = (u32::from(s[k]) + (u32::from(d[k]) * keep + 127) / 255) as u8;
            }
        }
    }
}

/// A call drawn alone in the part of a `w` x `h` picture it can reach: its bounds grown by its blur, within the
/// picture grown by how far its shadow carries; blurred, and its shadow made (offset rounded to the pixel).
fn alone(op: &Op, w: u32, h: u32) -> Option<Alone> {
    let b = op.path.bounds();
    let mb = reach(op.blur);
    let (ms, dx, dy) = op.shadow.map_or((0, 0, 0), |s| (reach(s.sigma), s.dx.round() as i32, s.dy.round() as i32));
    let gx = mb + ms + dx.abs();
    let gy = mb + ms + dy.abs();
    let x0 = (b.left().floor() as i32 - mb).max(-gx);
    let x1 = (b.right().ceil() as i32 + mb).min(w as i32 + gx);
    let y0 = (b.top().floor() as i32 - mb).max(-gy);
    let y1 = (b.bottom().ceil() as i32 + mb).min(h as i32 + gy);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (rw, rh) = ((x1 - x0) as u32, (y1 - y0) as u32);
    let mut picture = Pixmap::new(rw, rh)?;
    let paint = Paint {
        shader: op.shader.clone(),
        blend_mode: BlendMode::SourceOver,
        anti_alias: true,
        force_hq_pipeline: false,
    };
    picture.fill_path(&op.path, &paint, FillRule::Winding, Transform::from_translate(-x0 as f32, -y0 as f32), None);
    gaussian::<4>(picture.data_mut(), rw as usize, op.blur);
    // a shadow is one colour: its alpha is blurred alone, then coloured
    let shadow = op.shadow.and_then(|s| {
        let (sw, sh) = (rw as usize + 2 * ms as usize, rh as usize + 2 * ms as usize);
        let mut alpha = vec![0u8; sw * sh];
        for (y, row) in picture.data().chunks_exact(rw as usize * 4).enumerate() {
            let dst = &mut alpha[(y + ms as usize) * sw + ms as usize..][..rw as usize];
            dst.iter_mut().zip(row.as_chunks::<4>().0).for_each(|(d, p)| *d = p[3]);
        }
        gaussian::<1>(&mut alpha, sw, s.sigma);
        let mut out = Pixmap::new(sw as u32, sh as u32)?;
        let c = s.color;
        let rgba = [c.red(), c.green(), c.blue(), 1.0].map(|v| v * c.alpha());
        for (d, a) in out.data_mut().as_chunks_mut::<4>().0.iter_mut().zip(&alpha) {
            if *a > 0 {
                *d = rgba.map(|v| (v * f32::from(*a)).round() as u8);
            }
        }
        Some((out, (x0 - ms + dx, y0 - ms + dy)))
    });
    Some(Alone { picture, at: (x0, y0), shadow })
}

/// A Gaussian blur of standard deviation `sigma` over a picture `w` pixels wide of `C` channels a pixel, as three
/// box blurs (Filter Effects, `feGaussianBlur`: boxes of d = floor(sigma * 3 * sqrt(2 pi) / 4 + 0.5); an even d as two
/// boxes of d either side of the pixel and one of d + 1).
fn gaussian<const C: usize>(data: &mut [u8], w: usize, sigma: f32) {
    let d = (f64::from(sigma) * 3.0 * (2.0 * std::f64::consts::PI).sqrt() / 4.0 + 0.5).floor() as usize;
    if d <= 1 || w == 0 {
        return;
    }
    let boxes = if d % 2 == 1 { [(d / 2, d / 2); 3] } else { [(d / 2, d / 2 - 1), (d / 2 - 1, d / 2), (d / 2, d / 2)] };
    let mut tmp = vec![0u8; data.len()];
    for (lo, hi) in boxes {
        for (src, dst) in data.chunks_exact(w * C).zip(tmp.chunks_exact_mut(w * C)) {
            box_row::<C>(src, dst, lo, hi);
        }
        data.copy_from_slice(&tmp);
    }
    for (lo, hi) in boxes {
        box_columns(data, &mut tmp, w * C, lo, hi);
        data.copy_from_slice(&tmp);
    }
}

/// `(sum * inv + 2^15) >> 16` is the rounded mean of `lo + hi + 1` values: a division per channel does not vectorise.
fn inverse(lo: usize, hi: usize) -> u32 {
    let n = (lo + hi + 1) as u32;
    (65536 + n / 2) / n
}

/// One box blur along a row of pixels: each the mean of the pixels from `lo` before it to `hi` after it (beyond the
/// row: transparent).
fn box_row<const C: usize>(src: &[u8], dst: &mut [u8], lo: usize, hi: usize) {
    let src = src.as_chunks::<C>().0;
    let dst = dst.as_chunks_mut::<C>().0;
    let inv = inverse(lo, hi);
    let mut sum = [0u32; C];
    for p in &src[..hi.min(src.len())] {
        (0..C).for_each(|k| sum[k] += u32::from(p[k]));
    }
    for i in 0..src.len() {
        if let Some(p) = src.get(i + hi) {
            (0..C).for_each(|k| sum[k] += u32::from(p[k]));
        }
        dst[i] = sum.map(|s| ((s * inv + 32768) >> 16) as u8);
        if i >= lo {
            let p = src[i - lo];
            (0..C).for_each(|k| sum[k] -= u32::from(p[k]));
        }
    }
}

/// The same box blur down every column at once, a row (`row` bytes) at a time, so the rows stay in cache.
fn box_columns(src: &[u8], dst: &mut [u8], row: usize, lo: usize, hi: usize) {
    let h = src.len() / row;
    let inv = inverse(lo, hi);
    let mut sum = vec![0u32; row];
    let line = |y: usize| &src[y * row..][..row];
    for y in 0..hi.min(h) {
        sum.iter_mut().zip(line(y)).for_each(|(s, v)| *s += u32::from(*v));
    }
    for y in 0..h {
        if y + hi < h {
            sum.iter_mut().zip(line(y + hi)).for_each(|(s, v)| *s += u32::from(*v));
        }
        dst[y * row..][..row].iter_mut().zip(&sum).for_each(|(d, s)| *d = ((s * inv + 32768) >> 16) as u8);
        if y >= lo {
            sum.iter_mut().zip(line(y - lo)).for_each(|(s, v)| *s -= u32::from(*v));
        }
    }
}
