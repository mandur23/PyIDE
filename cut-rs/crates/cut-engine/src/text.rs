//! Text clips, burned-in captions and the error slate (port of textrender.js `draw` and `drawCaptions`), drawn with
//! cosmic-text into an RGBA picture the compositor uploads as the JavaScript uploads its canvas.
//!
//! The layout follows the JavaScript's rules: a layer's position is the centre of its block of lines, `align` places
//! each line inside it, lines sit like CSS line boxes (the font's ascent and descent centred in the line height, which
//! is also how cosmic-text places a line), tracking is `tracking / 1000` em. Glyph shapes and advances come from the
//! same font files (Malgun Gothic when a family is missing), so widths match the browser's within shaping and
//! hinting differences; strokes are drawn as the fill repeated around a circle of the stroke's width and shadows as
//! a box-blurred copy, approximations of Canvas 2D's round-joined stroke and Gaussian shadow.

use cosmic_text::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Style, SwashCache, SwashContent, Weight};
use cut_model::keyframes::{self, Value};
use serde_json::{Map, Value as Json};

use crate::plan::{Captions, Item};

const FALLBACK: &str = "Malgun Gothic";

/// An sRGB colour with alpha, 0..1.
type Rgba = [f32; 4];

/// `#rrggbb` / `#rrggbbaa` (anything else: `None`).
fn css_color(s: &str) -> Option<Rgba> {
    let b = s.as_bytes();
    if !((b.len() == 7 || b.len() == 9) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)) {
        return None;
    }
    let byte = |i: usize| f32::from(u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0)) / 255.0;
    Some([byte(1), byte(3), byte(5), if b.len() == 9 { byte(7) } else { 1.0 }])
}

/// A picture being drawn: premultiplied sRGB values, as a canvas blends.
struct Canvas {
    w: usize,
    h: usize,
    px: Vec<f32>,
}

impl Canvas {
    fn new(w: u32, h: u32) -> Self {
        Self { w: w as usize, h: h as usize, px: vec![0.0; w as usize * h as usize * 4] }
    }

    fn blend(&mut self, x: i64, y: i64, c: Rgba, cover: f32) {
        if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h || cover <= 0.0 {
            return;
        }
        let a = c[3] * cover.min(1.0);
        let i = (y as usize * self.w + x as usize) * 4;
        for (d, s) in self.px[i..i + 3].iter_mut().zip(&c[..3]) {
            *d = s * a + *d * (1.0 - a);
        }
        self.px[i + 3] = a + self.px[i + 3] * (1.0 - a);
    }

    /// A rectangle (rounded by `r`), antialiased, in canvas pixels.
    fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64, c: Rgba) {
        let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
        let (x0, y0, x1, y1) = (x.floor() as i64, y.floor() as i64, (x + w).ceil() as i64, (y + h).ceil() as i64);
        for py in y0..y1 {
            for px in x0..x1 {
                let (cx, cy) = (px as f64 + 0.5, py as f64 + 0.5);
                // signed distance to the rounded box, negative inside
                let qx = (cx - (x + w / 2.0)).abs() - (w / 2.0 - r);
                let qy = (cy - (y + h / 2.0)).abs() - (h / 2.0 - r);
                let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
                self.blend(px, py, c, (0.5 - d).clamp(0.0, 1.0) as f32);
            }
        }
    }

    /// Non-premultiplied RGBA8, what the compositor's decodeImage reads.
    fn into_rgba8(self) -> Vec<u8> {
        self.px
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| {
                let a = p[3];
                let un = |v: f32| if a > 0.0 { (v / a * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 };
                [un(p[0]), un(p[1]), un(p[2]), (a * 255.0).round().clamp(0.0, 255.0) as u8]
            })
            .collect()
    }
}

/// How a run of text is set.
struct Font<'a> {
    family: &'a str,
    weight: u16,
    italic: bool,
    /// Canvas pixels.
    size: f32,
    /// Em.
    tracking: f32,
}

/// One shaped line: its width and its glyphs' coverage, in canvas pixels from the line's left and top.
struct Shaped {
    width: f64,
    /// (x, y, coverage) of every covered pixel, the glyph masks placed.
    spots: Vec<(i32, i32, f32)>,
    /// The byte offset each glyph starts at and its x, for clipping to a word.
    glyph_x: Vec<(usize, f32)>,
}

/// Draws text with the system's fonts (loaded the first time text is drawn).
pub struct TextRenderer {
    fonts: Option<FontSystem>,
    cache: SwashCache,
}

impl Default for TextRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl TextRenderer {
    pub fn new() -> Self {
        Self { fonts: None, cache: SwashCache::new() }
    }

    /// Loads the system's fonts, and the faces text and captions use by default, now rather than at the first text
    /// drawn (about a hundred milliseconds).
    pub fn warm(&mut self) {
        for (family, weight) in [("Malgun Gothic", 600), ("Malgun Gothic", 700), (FALLBACK, 600)] {
            let f = Font { family, weight, italic: false, size: 24.0, tracking: 0.0 };
            self.shape("Aa 가", &f, 30.0);
        }
    }

    fn fonts(&mut self) -> &mut FontSystem {
        self.fonts.get_or_insert_with(FontSystem::new)
    }

    /// The loaded fonts and the glyph cache, for graphic clips' text layers (drawn from glyph outlines).
    pub(crate) fn font_parts(&mut self) -> (&mut FontSystem, &mut SwashCache) {
        (self.fonts.get_or_insert_with(FontSystem::new), &mut self.cache)
    }

    fn shape(&mut self, text: &str, f: &Font<'_>, line_height: f32) -> Shaped {
        let family = {
            let fs = self.fonts();
            let known = fs.db().faces().any(|x| x.families.iter().any(|(n, _)| n.eq_ignore_ascii_case(f.family)));
            if known { f.family.to_string() } else { FALLBACK.to_string() }
        };
        let fs = self.fonts.as_mut().expect("loaded above");
        let mut buf = Buffer::new(fs, Metrics::new(f.size.max(1.0), line_height.max(1.0)));
        let attrs = Attrs::new()
            .family(Family::Name(&family))
            .weight(Weight(f.weight))
            .style(if f.italic { Style::Italic } else { Style::Normal })
            .letter_spacing(f.tracking);
        buf.set_size(None, None);
        buf.set_text(text, &attrs, Shaping::Advanced, None);
        buf.shape_until_scroll(fs, false);
        let mut spots = Vec::new();
        let mut glyph_x = Vec::new();
        let mut width = 0.0f64;
        for run in buf.layout_runs() {
            let last = run.glyphs.last();
            // letter spacing is added after the last character too: the JavaScript measures without it
            width = width.max(
                f64::from(last.map_or(0.0, |g| g.x + g.w))
                    - if last.is_some() { f64::from(f.tracking * f.size) } else { 0.0 },
            );
            for g in run.glyphs {
                glyph_x.push((g.start, g.x));
                let p = g.physical((0.0, run.line_y), 1.0);
                let Some(img) = self.cache.get_image(fs, p.cache_key) else { continue };
                let (l, t) = (img.placement.left, img.placement.top);
                let (iw, ih) = (img.placement.width as i32, img.placement.height as i32);
                for yy in 0..ih {
                    for xx in 0..iw {
                        let i = (yy * iw + xx) as usize;
                        let a = match img.content {
                            SwashContent::Mask => img.data[i],
                            SwashContent::Color => img.data[i * 4 + 3],
                            SwashContent::SubpixelMask => img.data[i * 4],
                        };
                        if a > 0 {
                            spots.push((p.x + l + xx, p.y - t + yy, f32::from(a) / 255.0));
                        }
                    }
                }
            }
        }
        Shaped { width: width.max(0.0), spots, glyph_x }
    }

    /// The x (canvas pixels from the line's left) of byte offset `at` of a shaped line.
    fn x_at(s: &Shaped, at: usize, text_len: usize) -> f64 {
        if at >= text_len {
            return s.width;
        }
        s.glyph_x.iter().find(|(start, _)| *start >= at).map_or(s.width, |(_, x)| f64::from(*x))
    }

    fn paint(c: &mut Canvas, s: &Shaped, x: f64, y: f64, color: Rgba, clip: Option<(f64, f64)>) {
        for &(px, py, a) in &s.spots {
            let gx = x + f64::from(px);
            if let Some((lo, hi)) = clip
                && (gx + 0.5 < lo || gx + 0.5 >= hi)
            {
                continue;
            }
            c.blend(gx.round() as i64, (y + f64::from(py)).round() as i64, color, a);
        }
    }

    /// A text clip's layers at clip-local time `local` (textrender.js `draw`), `tw` x `th` canvas pixels for a `w` x `h`
    /// sequence.
    pub fn text_clip(&mut self, clip: &cut_model::Clip, local: f64, w: f64, h: f64, tw: u32, th: u32) -> Vec<u8> {
        let mut c = Canvas::new(tw, th);
        let k = f64::from(tw) / w;
        if let cut_model::Source::Generator { layers: Some(layers), .. } = &clip.source {
            for raw in layers {
                let l = resolve_layer(raw, clip, local);
                self.layer(&mut c, &l, w, h, k);
            }
        }
        c.into_rgba8()
    }

    fn layer(&mut self, c: &mut Canvas, l: &Map<String, Json>, w: f64, h: f64, k: f64) {
        let n = |key: &str, d: f64| l.get(key).and_then(Json::as_f64).filter(|v| v.is_finite()).unwrap_or(d);
        let alpha = (n("opacity", 100.0) / 100.0).clamp(0.0, 1.0) as f32;
        if alpha <= 0.0 {
            return;
        }
        let size = n("size", 1.0).max(1.0);
        let lh = size * l.get("leading").and_then(Json::as_f64).filter(|v| *v != 0.0).unwrap_or(1.2);
        let text = l.get("text").map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_string)).unwrap_or_default();
        let lines: Vec<&str> = text.split('\n').map(|s| s.strip_suffix('\r').unwrap_or(s)).collect();
        let font = Font {
            family: l.get("font").and_then(Json::as_str).unwrap_or(FALLBACK),
            weight: n("weight", 400.0).round().clamp(1.0, 1000.0) as u16,
            italic: l.get("italic").and_then(Json::as_bool).unwrap_or(false),
            size: (size * k) as f32,
            tracking: (n("tracking", 0.0) / 1000.0) as f32,
        };
        let shaped: Vec<Shaped> = lines.iter().map(|t| self.shape(t, &font, (lh * k) as f32)).collect();
        let width = shaped.iter().map(|s| s.width / k).fold(0.0, f64::max);
        let height = lines.len() as f64 * lh;
        let pos = l
            .get("position")
            .and_then(Json::as_array)
            .map(|a| [a[0].as_f64().unwrap_or(0.0), a.get(1).and_then(Json::as_f64).unwrap_or(0.0)])
            .unwrap_or([0.0, 0.0]);
        let to_canvas = |x: f64, y: f64| ((x + w / 2.0) * k, (y + h / 2.0) * k);
        let with_alpha = |mut col: Rgba| {
            col[3] *= alpha;
            col
        };
        if let Some(b) = l.get("box").and_then(Json::as_object)
            && let Some(col) = b.get("color").and_then(Json::as_str).and_then(css_color)
        {
            let pad = b.get("padding").and_then(Json::as_f64).unwrap_or(0.0).max(0.0);
            let (x, y) = to_canvas(pos[0] - width / 2.0 - pad, pos[1] - height / 2.0 - pad);
            let r = b.get("radius").and_then(Json::as_f64).unwrap_or(0.0) * k;
            c.fill_rect(x, y, (width + 2.0 * pad) * k, (height + 2.0 * pad) * k, r, with_alpha(col));
        }
        let total: usize = lines.iter().map(|t| t.chars().count()).sum();
        let mut left = (n("reveal", 1.0).clamp(0.0, 1.0) * total as f64).round() as usize;
        let fill = with_alpha(l.get("fill").and_then(Json::as_str).and_then(css_color).unwrap_or([1.0; 4]));
        let stroke = l.get("stroke").and_then(Json::as_object).and_then(|s| {
            let col = s.get("color").and_then(Json::as_str).and_then(css_color)?;
            let wd = s.get("width").and_then(Json::as_f64).filter(|v| *v > 0.0)?;
            Some((with_alpha(col), wd))
        });
        let shadow = l.get("shadow").and_then(Json::as_object).and_then(|s| {
            let col = s.get("color").and_then(Json::as_str).and_then(css_color)?;
            let f = |k: &str| s.get(k).and_then(Json::as_f64).unwrap_or(0.0);
            Some((with_alpha(col), f("blur"), f("x"), f("y")))
        });
        let top = pos[1] - height / 2.0;
        let align = l.get("align").and_then(Json::as_str).unwrap_or("center");
        for (i, (line, s)) in lines.iter().zip(&shaped).enumerate() {
            if left == 0 {
                break;
            }
            let count = line.chars().count();
            let s = if count > left {
                let cut: String = line.chars().take(left).collect();
                &self.shape(&cut, &font, (lh * k) as f32)
            } else {
                s
            };
            left = left.saturating_sub(count);
            let lw = s.width / k;
            let x = match align {
                "left" => pos[0] - width / 2.0,
                "right" => pos[0] + width / 2.0 - lw,
                _ => pos[0] - lw / 2.0,
            };
            let (cx, cy) = to_canvas(x, top + i as f64 * lh);
            if let Some((col, blur, sx, sy)) = shadow {
                let mut layer = Canvas::new(c.w as u32, c.h as u32);
                Self::paint(&mut layer, s, cx + sx * k, cy + sy * k, col, None);
                if let Some((_, wd)) = stroke {
                    stroke_paint(&mut layer, s, cx + sx * k, cy + sy * k, col, wd * k);
                }
                blur_box(&mut layer, (blur * k / 2.0).round() as usize);
                over(c, &layer);
            }
            if let Some((col, wd)) = stroke {
                stroke_paint(c, s, cx, cy, col, wd * k);
            }
            Self::paint(c, s, cx, cy, fill, None);
        }
    }

    /// Burned-in captions (textrender.js `drawCaptions`) over a `tw` x `th` canvas of a `w` x `h` sequence.
    pub fn captions(&mut self, tracks: &[Captions<'_>], w: f64, h: f64, tw: u32, th: u32) -> Vec<u8> {
        let mut c = Canvas::new(tw, th);
        let k = f64::from(tw) / w;
        for cap in tracks {
            self.caption_track(&mut c, cap, w, h, k);
        }
        c.into_rgba8()
    }

    fn caption_track(&mut self, c: &mut Canvas, cap: &Captions<'_>, w: f64, h: f64, k: f64) {
        let mut s = cut_model::defaults::default_caption_style();
        s.extend(cap.style.clone());
        let n = |key: &str, d: f64| s.get(key).and_then(Json::as_f64).filter(|v| *v != 0.0).unwrap_or(d);
        let text = |key: &str| s.get(key).and_then(Json::as_str);
        let highlight = s.get("highlight").and_then(Json::as_bool).unwrap_or(false);
        struct Line {
            text: String,
            spans: Vec<std::ops::Range<usize>>,
            lit: Option<usize>,
        }
        let mut lines = Vec::new();
        for it in &cap.items {
            let mut lit = if highlight {
                it.words.as_deref().and_then(|wd| cut_model::captionwords::lit_at(wd, &it.text, it.start, cap.t as i64))
            } else {
                None
            };
            for line in it.text.split('\n').map(|x| x.strip_suffix('\r').unwrap_or(x)) {
                let spans = cut_model::captionwords::spans(line);
                let here = lit.filter(|&n| n < spans.len());
                lit = lit.map(|n| n.wrapping_sub(spans.len())).filter(|n| *n < usize::MAX / 2);
                lines.push(Line { text: line.to_string(), spans, lit: here });
            }
        }
        if lines.is_empty() {
            return;
        }
        let size = (n("size", 54.0) * w.min(h) / n("ref", 1080.0)).max(1.0);
        let lh = size * 1.3;
        let pad = size * 0.25;
        let margin = s.get("margin").and_then(Json::as_f64).unwrap_or(0.0) / 100.0 * h;
        let block = lines.len() as f64 * lh;
        let top = if text("position") == Some("top") { -h / 2.0 + margin } else { h / 2.0 - margin - block };
        let font = Font {
            family: text("font").unwrap_or(FALLBACK),
            weight: n("weight", 600.0).round().clamp(1.0, 1000.0) as u16,
            italic: s.get("italic").and_then(Json::as_bool).unwrap_or(false),
            size: (size * k) as f32,
            tracking: 0.0,
        };
        let color = text("color").and_then(css_color).unwrap_or([1.0; 4]);
        let hl_hex = text("highlightColor").filter(|x| css_color(x).is_some()).unwrap_or("#ffd23f");
        let hl = css_color(hl_hex).unwrap_or([1.0, 0.82, 0.25, 1.0]);
        let boxed_mode = text("highlightMode") == Some("box");
        let bg = text("background").and_then(css_color);
        for (i, line) in lines.iter().enumerate() {
            let y = top + i as f64 * lh;
            let sh = self.shape(&line.text, &font, (lh * k) as f32);
            let width = sh.width / k;
            let (lx, ly) = ((-width / 2.0 + w / 2.0) * k, (y + h / 2.0) * k);
            if let Some(b) = bg {
                c.fill_rect((-width / 2.0 - pad + w / 2.0) * k, ly, (width + 2.0 * pad) * k, lh * k, 0.0, b);
            }
            let Some(lit) = line.lit else {
                Self::paint(c, &sh, lx, ly, color, None);
                continue;
            };
            let len = line.text.len();
            let x_at = |b: usize| lx + Self::x_at(&sh, b, len);
            let r = &line.spans[lit];
            let (x0, x1) = (x_at(r.start), x_at(r.end));
            let c0 = if lit > 0 { (x_at(line.spans[lit - 1].end) + x0) / 2.0 } else { f64::NEG_INFINITY };
            let c1 = line.spans.get(lit + 1).map_or(f64::INFINITY, |n| (x1 + x_at(n.start)) / 2.0);
            let boxed = boxed_mode || text("color").is_some_and(|lc| color_distance(lc, hl_hex) < 150.0);
            if boxed {
                let (bx, by) = (pad * 0.6 * k, lh * 0.08 * k);
                c.fill_rect(x0 - bx, ly + by, x1 - x0 + 2.0 * bx, lh * k - 2.0 * by, size * 0.18 * k, hl);
            }
            for (lo, hi, col) in [(f64::NEG_INFINITY, c0, color), (c1, f64::INFINITY, color)] {
                Self::paint(c, &sh, lx, ly, col, Some((lo, hi)));
            }
            let lit_color = if boxed { contrast_on(hl) } else { hl };
            Self::paint(c, &sh, lx, ly, lit_color, Some((c0, c1)));
        }
    }

    /// The red "Media Offline" / "Media Cannot Be Shown" slate.
    pub fn slate(&mut self, message: &str, tw: u32, th: u32) -> Vec<u8> {
        let mut c = Canvas::new(tw, th);
        c.fill_rect(
            0.0,
            0.0,
            f64::from(tw),
            f64::from(th),
            0.0,
            [0xc6 as f32 / 255.0, 0x28 as f32 / 255.0, 0x28 as f32 / 255.0, 1.0],
        );
        let size = (f64::from(th) * 0.06).round().max(10.0) as f32;
        let font = Font { family: FALLBACK, weight: 600, italic: false, size, tracking: 0.0 };
        let s = self.shape(message, &font, size * 1.2);
        Self::paint(
            &mut c,
            &s,
            (f64::from(tw) - s.width) / 2.0,
            (f64::from(th) - f64::from(size) * 1.2) / 2.0,
            [1.0; 4],
            None,
        );
        c.into_rgba8()
    }
}

/// What a text clip shows at its item's time: its layers with their values then, as text.
pub fn signature(it: &Item<'_>) -> String {
    match &it.clip.source {
        cut_model::Source::Generator { layers: Some(layers), .. } => {
            Json::from(layers.iter().map(|l| Json::Object(resolve_layer(l, it.clip, it.local))).collect::<Vec<_>>())
                .to_string()
        }
        _ => String::new(),
    }
}

/// The layer as it is at clip time t: keyframed fields (`layers.<id>.<field>`) replace the static ones.
pub fn resolve_layer(layer: &Json, clip: &cut_model::Clip, t: f64) -> Map<String, Json> {
    let mut out = Map::new();
    out.insert("opacity".into(), Json::from(100));
    out.insert("reveal".into(), Json::from(1));
    if let Some(o) = layer.as_object() {
        out.extend(o.clone());
    }
    let prefix = format!("layers.{}.", layer.get("id").and_then(Json::as_str).unwrap_or(""));
    for (prop, list) in &clip.keyframes {
        if let Some(field) = prop.strip_prefix(&prefix)
            && let Some(v) = keyframes::value_at(list, t)
        {
            out.insert(
                field.to_string(),
                match v {
                    Value::Num(x) => Json::from(x),
                    v => serde_json::to_value(v).unwrap_or(Json::Null),
                },
            );
        }
    }
    out
}

fn stroke_paint(c: &mut Canvas, s: &Shaped, x: f64, y: f64, col: Rgba, width: f64) {
    let steps = ((width * 4.0).ceil() as usize).clamp(8, 32);
    for i in 0..steps {
        let a = i as f64 / steps as f64 * std::f64::consts::TAU;
        for r in [width, width * 0.5] {
            TextRenderer::paint(c, s, x + a.cos() * r, y + a.sin() * r, col, None);
        }
    }
}

/// Three box blurs of radius r (about a Gaussian of sigma r).
fn blur_box(c: &mut Canvas, r: usize) {
    if r == 0 {
        return;
    }
    let (w, h) = (c.w, c.h);
    let mut tmp = vec![0.0f32; c.px.len()];
    for _ in 0..3 {
        for horizontal in [true, false] {
            let (n, m) = if horizontal { (h, w) } else { (w, h) };
            for line in 0..n {
                let at = |i: usize| if horizontal { (line * w + i) * 4 } else { (i * w + line) * 4 };
                let px = |i: usize| -> [f32; 4] { std::array::from_fn(|k| c.px[at(i) + k]) };
                let mut acc = [0.0f32; 4];
                let add = |acc: &mut [f32; 4], v: [f32; 4], sign: f32| {
                    acc.iter_mut().zip(v).for_each(|(a, v)| *a += sign * v)
                };
                for i in 0..=r.min(m - 1) {
                    add(&mut acc, px(i), 1.0);
                }
                let d = (2 * r + 1) as f32;
                for i in 0..m {
                    tmp[at(i)..at(i) + 4].iter_mut().zip(acc).for_each(|(t, a)| *t = a / d);
                    if i + r + 1 < m {
                        add(&mut acc, px(i + r + 1), 1.0);
                    }
                    if i >= r {
                        add(&mut acc, px(i - r), -1.0);
                    }
                }
            }
            std::mem::swap(&mut c.px, &mut tmp);
        }
    }
}

fn over(c: &mut Canvas, top: &Canvas) {
    for (d, s) in c.px.as_chunks_mut::<4>().0.iter_mut().zip(top.px.as_chunks::<4>().0) {
        let a = s[3];
        d.iter_mut().zip(s).for_each(|(d, s)| *d = s + *d * (1.0 - a));
    }
}

fn contrast_on(c: Rgba) -> Rgba {
    if 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.55 { [0.0, 0.0, 0.0, 1.0] } else { [1.0; 4] }
}

/// "Redmean" RGB distance of two `#rrggbb` colours.
fn color_distance(a: &str, b: &str) -> f64 {
    let (Some(x), Some(y)) = (css_color(a), css_color(b)) else { return f64::INFINITY };
    let v = |c: Rgba| c.map(|v| f64::from(v) * 255.0);
    let ([r1, g1, b1, _], [r2, g2, b2, _]) = (v(x), v(y));
    let r = (r1 + r2) / 2.0;
    ((2.0 + r / 256.0) * (r1 - r2).powi(2) + 4.0 * (g1 - g2).powi(2) + (2.0 + (255.0 - r) / 256.0) * (b1 - b2).powi(2))
        .sqrt()
}
