//! What each effect's and transition's WGSL reads from its uniforms (effects.js `gpu.uniforms`): the list of passes
//! for given resolved parameters, each at most 16 floats in the shader's `u.p[0..3]`, `[]` when there is nothing to
//! do. The tables Lumetri Color reads (its LUT and curves) are named by [`textures`].

use std::sync::Arc;

use cut_model::effects::Params;
use serde_json::{Map, Value as Json};

use crate::color::{LUMA, clamp, hex_to_linear, linear_to_srgb};
use crate::lumetri::{self, Lut};

/// What an effect's passes are drawn for (effects.js `info`).
#[derive(Debug, Clone, Default)]
pub struct Info {
    /// The size of the texture the effect reads and writes.
    pub width: f64,
    pub height: f64,
    /// Texels per sequence pixel.
    pub px_scale: f64,
    pub quality: f64,
    /// The clip-local frame number.
    pub frame: f64,
    /// Lumetri Color's LUT (`info.assets.lut`).
    pub lut: Option<Arc<Lut>>,
}

fn frame_of(info: &Info) -> f64 {
    info.frame.trunc()
}

/// Separable Gaussian sampling: the stride between taps and the taps on each side for a sigma.
pub fn blur_plan(sigma: f64) -> (f64, f64) {
    let reach = sigma * 3.0;
    let stride = (reach / 64.0).max(1.0);
    (stride, (reach / stride).ceil())
}

fn blur_passes(sigma: f64, a: f64, b: f64) -> Vec<Vec<f64>> {
    let (stride, n) = blur_plan(sigma);
    vec![vec![1.0, 0.0, sigma, 0.0, stride, n, a, b], vec![0.0, 1.0, sigma, 1.0, stride, n, a, b]]
}

/// The basic correction's gains and settings (effects.js `cpu.basicPlan`).
#[derive(Debug, Clone, PartialEq)]
pub struct BasicPlan {
    pub gain: [f64; 3],
    pub k: f64,
    pub tone: [f64; 4],
    pub vibrance: f64,
    pub saturation: f64,
}

pub fn basic_plan(p: &Map<String, Json>) -> BasicPlan {
    let t = p.num("temperature") / 100.0;
    let m = p.num("tint") / 100.0;
    let g = [(t / 2.0 + m / 4.0).exp2(), (-m / 2.0).exp2(), (-t / 2.0 + m / 4.0).exp2()];
    let n = g[0] * LUMA[0] + g[1] * LUMA[1] + g[2] * LUMA[2];
    let e = p.num("exposure").exp2();
    BasicPlan {
        gain: g.map(|x| (x / n) * e),
        k: 1.0 + p.num("contrast") / 100.0,
        tone: [p.num("shadows") / 100.0, p.num("highlights") / 100.0, p.num("whites") / 100.0, p.num("blacks") / 100.0],
        vibrance: p.num("vibrance") / 100.0,
        saturation: p.num("saturation") / 100.0,
    }
}

fn luma(c: [f64; 3]) -> f64 {
    c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]
}

/// One linear colour through the basic correction (effects.js `cpu.basicPixel`).
pub fn basic_pixel(rgb: [f64; 3], q: &BasicPlan) -> [f64; 3] {
    let mut c: [f64; 3] = std::array::from_fn(|i| rgb[i] * q.gain[i]);
    if q.k != 1.0 {
        c = c.map(|x| if x > 0.0 { 0.18 * (x / 0.18).powf(q.k) } else { x });
    }
    let [s, h, w, b] = q.tone;
    if s != 0.0 || h != 0.0 || w != 0.0 || b != 0.0 {
        let y = luma(c);
        let l = y.max(0.0).powf(1.0 / 2.2);
        let d =
            (s * 6.75 * l * (1.0 - l).powi(2) + h * 6.75 * l * l * (1.0 - l) + w * l.powi(3) + b * (1.0 - l).powi(3))
                / 4.0;
        let y2 = (l + d).max(0.0).powf(2.2);
        c = if y > 1e-6 { c.map(|x| x * y2 / y) } else { c.map(|x| x + y2 - y.max(0.0)) };
    }
    let mut y = luma(c);
    if q.vibrance != 0.0 {
        let mx = c[0].max(c[1]).max(c[2]);
        let mn = c[0].min(c[1]).min(c[2]);
        let sat = if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
        let f = 1.0 + q.vibrance * (1.0 - sat);
        c = c.map(|x| y + (x - y) * f);
        y = luma(c);
    }
    if q.saturation != 1.0 {
        c = c.map(|x| y + (x - y) * q.saturation);
    }
    c.map(|x| x.max(0.0))
}

fn basic_neutral(p: &Map<String, Json>) -> bool {
    ["temperature", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance"]
        .iter()
        .all(|k| p.num(k) == 0.0)
        && p.num("saturation") == 100.0
}

/// One Lumetri Color section that changes something, in Lumetri's order (u.p[3].w names it).
#[derive(Debug, Clone)]
pub enum Stage {
    Basic(BasicPlan),
    Lut(Arc<Lut>, f64),
    Curves(Arc<Vec<f32>>),
    Hsl(lumetri::HslPlan),
}

impl Stage {
    /// The CPU reference of the stage on a linear colour.
    pub fn pixel(&self, rgb: [f64; 3]) -> [f64; 3] {
        match self {
            Stage::Basic(q) => basic_pixel(rgb, q),
            Stage::Lut(l, k) => lumetri::lut_pixel(rgb, l, *k),
            Stage::Curves(t) => lumetri::curves_pixel(rgb, t),
            Stage::Hsl(h) => lumetri::hsl_pixel(rgb, h),
        }
    }

    fn pass(&self) -> Vec<f64> {
        match self {
            Stage::Basic(q) => {
                let mut v = q.gain.to_vec();
                v.push(q.k);
                v.extend(q.tone);
                v.extend([q.vibrance, q.saturation, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                v
            }
            Stage::Lut(l, k) => {
                let mut v = vec![*k, f64::from(l.size), 0.0, 0.0];
                v.extend(l.min);
                v.push(0.0);
                v.extend(l.max);
                v.extend([0.0, 0.0, 0.0, 0.0, 1.0]);
                v
            }
            Stage::Curves(_) => {
                let mut v = vec![0.0; 15];
                v.push(2.0);
                v
            }
            Stage::Hsl(h) => {
                let mut v = vec![h.hue, h.half, h.hue_soft];
                v.extend(h.sat);
                v.extend(h.lum);
                v.extend(h.gain);
                v.extend([h.k, h.saturation, h.shift, if h.mask { 4.0 } else { 3.0 }]);
                v
            }
        }
    }
}

/// Lumetri Color's sections for its parameters.
pub fn lumetri_stages(p: &Map<String, Json>, info: &Info) -> Vec<Stage> {
    let mut out = Vec::new();
    if !basic_neutral(p) {
        out.push(Stage::Basic(basic_plan(p)));
    }
    let k = clamp(p.get("lutIntensity").and_then(Json::as_f64).unwrap_or(100.0) / 100.0, 0.0, 1.0);
    if let Some(l) = &info.lut
        && k > 0.0
    {
        out.push(Stage::Lut(l.clone(), k));
    }
    if !lumetri::curves_identity(p) {
        out.push(Stage::Curves(lumetri::curves_table(p)));
    }
    let h = lumetri::hsl_plan(p);
    if h.active {
        out.push(Stage::Hsl(h));
    }
    out
}

fn hue_off(p: &Map<String, Json>) -> bool {
    ((p.num("hue") % 360.0) + 360.0) % 360.0 == 0.0
}

/// The passes of a video effect, each its `u.p` floats.
pub fn effect(kind: &str, p: &Map<String, Json>, info: &Info) -> Vec<Vec<f64>> {
    let px = info.px_scale;
    match kind {
        "flip.horizontal" | "flip.vertical" | "color.bw" => vec![vec![]],
        "crop" => vec![vec![
            p.num("left") / 100.0,
            p.num("top") / 100.0,
            p.num("right") / 100.0,
            p.num("bottom") / 100.0,
            p.num("feather") * px,
        ]],
        "edge.extend" => vec![],
        "blur.gaussian" => {
            let sigma = p.num("blurriness") * px / 3.0;
            if sigma.is_nan() || sigma <= 0.05 {
                return vec![];
            }
            let (stride, n) = blur_plan(sigma);
            let r = if p.flag("repeat") { 1.0 } else { 0.0 };
            let dims = p.text("dimensions");
            let mut out = Vec::new();
            if dims != "vertical" {
                out.push(vec![1.0, 0.0, sigma, r, stride, n]);
            }
            if dims != "horizontal" {
                out.push(vec![0.0, 1.0, sigma, r, stride, n]);
            }
            out
        }
        "blur.directional" => {
            let len = p.num("length") * px;
            let a = p.num("direction") * std::f64::consts::PI / 180.0;
            let n = clamp(len.ceil() + 1.0, 1.0, 65.0);
            if len > 0.0 { vec![vec![a.sin(), -a.cos(), len, n]] } else { vec![] }
        }
        "sharpen" => {
            if p.num("amount") > 0.0 {
                blur_passes((p.num("radius") * px).max(0.05), p.num("amount") / 100.0, p.num("threshold"))
            } else {
                vec![]
            }
        }
        "mosaic" => vec![vec![p.num("horizontal"), p.num("vertical"), if p.flag("sharp") { 1.0 } else { 0.0 }, 0.0]],
        "color.tint" => {
            let b = hex_to_linear(p.text("black"), [0.0, 0.0, 0.0, 1.0]);
            let w = hex_to_linear(p.text("white"), [0.0, 0.0, 0.0, 1.0]);
            vec![vec![b[0], b[1], b[2], p.num("amount") / 100.0, w[0], w[1], w[2], 0.0]]
        }
        "color.brightnessContrast" => {
            vec![vec![(p.num("brightness") / 50.0).exp2(), 1.0 + p.num("contrast") / 100.0, 0.0, 0.0]]
        }
        "color.basic" => lumetri_stages(p, info).iter().map(Stage::pass).collect(),
        "color.invert" => {
            if p.num("amount") > 0.0 {
                vec![vec![p.num("amount") / 100.0]]
            } else {
                vec![]
            }
        }
        "color.hue" => {
            if hue_off(p) {
                vec![]
            } else {
                vec![lumetri::hue_matrix(p.num("hue")).iter().flat_map(|r| [r[0], r[1], r[2], 0.0]).collect()]
            }
        }
        "vignette" => {
            let c = p.pair("center");
            let amount = p.num("amount") / 100.0;
            if amount == 0.0 {
                return vec![];
            }
            vec![vec![
                0.5 + c[0] * px / info.width,
                0.5 + c[1] * px / info.height,
                info.width / info.height,
                (p.num("roundness") + 100.0) / 200.0,
                p.num("midpoint") / 100.0,
                (p.num("feather") / 100.0).max(1e-3),
                amount,
                0.0,
            ]]
        }
        "glow" => {
            if p.num("intensity").is_nan() || p.num("intensity") <= 0.0 {
                return vec![];
            }
            let (t, i) = (p.num("threshold") / 100.0, p.num("intensity") / 100.0);
            let mut out = vec![vec![0.0, 0.0, 1.0, 2.0, 1.0, 0.0, t, i]];
            out.extend(blur_passes((p.num("radius") * px / 3.0).max(0.05), t, i));
            out
        }
        "posterize" => vec![vec![p.num("levels").round().max(2.0)]],
        "chromatic" => {
            let amount = p.num("amount");
            if amount.is_nan() || amount <= 0.0 {
                return vec![];
            }
            let amt = amount * px;
            if p.text("mode") == "linear" {
                let a = p.num("direction") * std::f64::consts::PI / 180.0;
                vec![vec![0.0, 0.0, a.sin() * amt / info.width, -a.cos() * amt / info.height]]
            } else {
                vec![vec![1.0, amt / (0.5 * info.width.hypot(info.height)), 0.0, 0.0]]
            }
        }
        "glitch" => {
            if !(p.num("amount") > 0.0 && p.num("shift") > 0.0) {
                return vec![];
            }
            let amount = f64::from((p.num("amount") / 100.0) as f32);
            let step = (frame_of(info) / p.num("hold").round().max(1.0)).floor();
            vec![vec![amount, p.num("shift") * px / info.width, (p.num("bandHeight") * px).max(1.0), step]]
        }
        "distort.lens" => {
            let c = p.num("curvature");
            if c != 0.0 { vec![vec![c / 200.0, if p.flag("repeat") { 1.0 } else { 0.0 }]] } else { vec![] }
        }
        "key.chroma" => {
            let k = hex_to_linear(p.text("color"), [0.0, 1.0, 0.0, 1.0]);
            let s = [linear_to_srgb(k[0]), linear_to_srgb(k[1]), linear_to_srgb(k[2])];
            let y = luma(s);
            vec![vec![
                (s[2] - y) / 1.8556,
                (s[0] - y) / 1.5748,
                p.num("similarity") / 100.0,
                (p.num("smoothness") / 100.0).max(1e-4),
                (p.num("spill") / 100.0).max(1e-4),
                if p.text("output") == "matte" { 1.0 } else { 0.0 },
                0.0,
                0.0,
            ]]
        }
        "noise.grain" => {
            let amount = p.num("amount");
            if amount.is_nan() || amount <= 0.0 {
                return vec![];
            }
            vec![vec![
                amount / 100.0 * 0.3,
                (p.num("size") * px).max(0.25),
                if p.flag("color") { 1.0 } else { 0.0 },
                if p.flag("animated") { frame_of(info) } else { 0.0 },
            ]]
        }
        _ => vec![],
    }
}

fn push_dir(direction: &str) -> [f64; 2] {
    match direction {
        "right" => [1.0, 0.0],
        "up" => [0.0, -1.0],
        "down" => [0.0, 1.0],
        _ => [-1.0, 0.0],
    }
}

/// The one uniform list of a transition at `progress` (0..1).
pub fn transition(kind: &str, p: &Map<String, Json>, progress: f64) -> Vec<f64> {
    match kind {
        "dissolve" => vec![progress],
        "dip.black" => vec![progress, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        "dip.white" => vec![progress, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0],
        "push" | "slide" => {
            let d = push_dir(p.text("direction"));
            vec![progress, d[0], d[1], 0.0]
        }
        "wipe" => {
            let w = match p.text("direction") {
                "fromRight" => [-1.0, 0.0, 1.0],
                "fromTop" => [0.0, 1.0, 0.0],
                "fromBottom" => [0.0, -1.0, 1.0],
                _ => [1.0, 0.0, 0.0],
            };
            vec![progress, p.num("feather") / 100.0, 0.0, 0.0, w[0], w[1], w[2], 0.0]
        }
        "iris.round" => {
            vec![progress, p.num("feather") / 100.0, if p.text("direction") == "close" { 1.0 } else { 0.0 }, 0.0]
        }
        "zoom.cross" => vec![progress, p.num("zoom") / 100.0, 0.0, 0.0],
        _ => vec![progress],
    }
}

/// A table texture an effect binds (binding number, its cache key, its size and its rgba16float data).
pub struct Table {
    pub binding: u32,
    pub key: String,
    pub size: [u32; 3],
    pub data: Box<dyn Fn() -> Vec<u16>>,
}

/// The table textures an effect's shader declares (effects.js `gpu.bindings`): binding number and whether it is 3D.
pub fn bindings(kind: &str) -> &'static [(u32, bool)] {
    match kind {
        "color.basic" => &[(4, true), (5, false)],
        _ => &[],
    }
}

/// The tables of an effect for its parameters (effects.js `gpu.textures`); bindings left out get a dummy.
pub fn textures(kind: &str, p: &Map<String, Json>, info: &Info) -> Vec<Table> {
    if kind != "color.basic" {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(lut) = info.lut.clone()
        && p.get("lutIntensity").and_then(Json::as_f64).unwrap_or(100.0) > 0.0
    {
        let n = lut.size;
        out.push(Table {
            binding: 4,
            key: format!("lut:{}", lut.id),
            size: [n, n, n],
            data: Box::new(move || lumetri::half_rgba(&lut.data, 3)),
        });
    }
    if !lumetri::curves_identity(p) {
        let t = lumetri::curves_table(p);
        out.push(Table {
            binding: 5,
            key: lumetri::curve_key(p),
            size: [lumetri::TABLE as u32, 1, 1],
            data: Box::new(move || lumetri::half_rgba(&t, 4)),
        });
    }
    out
}

/// The white balance eyedropper (effects.js `whiteBalance`): the temperature and tint of Lumetri Color that make a
/// picked linear colour neutral, rounded to tenths.
pub fn white_balance(c: [f64; 3]) -> (f64, f64) {
    let l = c.map(|v| v.max(1e-6).log2());
    let t = l[2] - l[0];
    let m = (l[1] - l[0] - t / 2.0) / 0.75;
    // Math.round: halves go up
    let round = |v: f64| ((clamp(v * 100.0, -100.0, 100.0) * 10.0) + 0.5).floor() / 10.0;
    (round(t), round(m))
}
