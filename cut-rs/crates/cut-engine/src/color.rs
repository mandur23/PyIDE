//! Colour helpers the effects and the compositor share (effects.js "color helpers") and the YUV to RGB conversion the
//! browser does for the JavaScript when it imports a decoded frame.

use cut_formats::{ColorSpace, Matrix};

/// Rec. 709 luminance weights of linear RGB.
pub const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

pub fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

pub fn linear_to_srgb(v: f64) -> f64 {
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// `#rrggbb` or `#rrggbbaa` as linear `[r, g, b, a]`, not premultiplied; `fallback` for anything else.
pub fn hex_to_linear(hex: &str, fallback: [f64; 4]) -> [f64; 4] {
    let b = hex.as_bytes();
    let ok = (b.len() == 7 || b.len() == 9) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit);
    if !ok {
        return fallback;
    }
    let byte = |i: usize| f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)) / 255.0;
    let a = if b.len() == 9 { byte(7) } else { 1.0 };
    [srgb_to_linear(byte(1)), srgb_to_linear(byte(3)), srgb_to_linear(byte(5)), a]
}

pub fn clamp(x: f64, a: f64, b: f64) -> f64 {
    a.max(b.min(x))
}

pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// How the luma and chroma planes of a decoded frame become R'G'B', as uniforms of `decode_yuv.wgsl`: the matrix rows
/// for (Y, Cb, Cr) and the offsets and scales of the code values.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct YuvToRgb {
    /// Rows of R', G', B' from (Y, Cb, Cr) with Y in 0..1 and Cb, Cr in -0.5..0.5.
    pub rows: [[f32; 3]; 3],
    /// Code value of black and of zero chroma, as a fraction of the largest code.
    pub y_offset: f32,
    pub c_offset: f32,
    /// Code range of Y and of Cb/Cr, as a fraction of the largest code.
    pub y_range: f32,
    pub c_range: f32,
}

impl YuvToRgb {
    /// The conversion for a track's colour space and bit depth, as Chromium applies it to a VideoFrame. A track that
    /// names no matrix is taken as BT.709 (Chromium's default for decoded video), no range as limited.
    pub fn of(cs: Option<&ColorSpace>, bit_depth: u32) -> Self {
        let (kr, kb) = match cs.and_then(|c| c.matrix) {
            Some(Matrix::Bt470bg | Matrix::Smpte170m) => (0.299, 0.114),
            Some(Matrix::Bt2020Ncl) => (0.2627, 0.0593),
            _ => (0.2126, 0.0722),
        };
        let kg = 1.0 - kr - kb;
        let rows = [
            [1.0, 0.0, 2.0 * (1.0 - kr)],
            [1.0, -2.0 * (1.0 - kb) * kb / kg, -2.0 * (1.0 - kr) * kr / kg],
            [1.0, 2.0 * (1.0 - kb), 0.0],
        ];
        let full = cs.and_then(|c| c.full_range).unwrap_or(false);
        let max = f64::from((1u32 << bit_depth.clamp(8, 16)) - 1);
        let k = f64::from(1u32 << (bit_depth.clamp(8, 16) - 8));
        let (y_offset, y_range, c_range) = if full { (0.0, max, max) } else { (16.0 * k, 219.0 * k, 224.0 * k) };
        Self {
            rows: rows.map(|r| r.map(|v| v as f32)),
            y_offset: (y_offset / max) as f32,
            c_offset: (128.0 * k / max) as f32,
            y_range: (y_range / max) as f32,
            c_range: (c_range / max) as f32,
        }
    }

    /// R'G'B' (not clamped) of normalized code values, as the shader computes it.
    pub fn rgb(&self, y: f32, cb: f32, cr: f32) -> [f32; 3] {
        let y = (y - self.y_offset) / self.y_range;
        let (u, v) = ((cb - self.c_offset) / self.c_range, (cr - self.c_offset) / self.c_range);
        self.rows.map(|r| r[0] * y + r[1] * u + r[2] * v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limited_range_bt709_black_white_and_colours() {
        let c = YuvToRgb::of(None, 8);
        let at = |y: f32, cb: f32, cr: f32| c.rgb(y / 255.0, cb / 255.0, cr / 255.0);
        let close = |a: [f32; 3], b: [f32; 3]| a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 2e-3);
        assert!(close(at(16.0, 128.0, 128.0), [0.0; 3]));
        assert!(close(at(235.0, 128.0, 128.0), [1.0; 3]));
        // BT.709 red: Y' 63, Cb 102, Cr 240 (ITU-R BT.709 limited range).
        let red = at(63.0, 102.0, 240.0);
        assert!((red[0] - 1.0).abs() < 0.01 && red[1].abs() < 0.01 && red[2].abs() < 0.01, "{red:?}");
    }

    #[test]
    fn full_range_ten_bit_white() {
        let cs = ColorSpace { full_range: Some(true), matrix: Some(Matrix::Smpte170m), ..Default::default() };
        let c = YuvToRgb::of(Some(&cs), 10);
        let w = c.rgb(1.0, 512.0 / 1023.0, 512.0 / 1023.0);
        assert!(w.iter().all(|v| (v - 1.0).abs() < 1e-5), "{w:?}");
    }

    #[test]
    fn hex_colours() {
        assert_eq!(hex_to_linear("#ffffff", [0.0; 4]), [1.0, 1.0, 1.0, 1.0]);
        assert_eq!(hex_to_linear("#00000080", [0.0; 4])[3], 128.0 / 255.0);
        assert_eq!(hex_to_linear("red", [0.5; 4]), [0.5; 4]);
        assert_eq!(hex_to_linear("#ggg000", [0.5; 4]), [0.5; 4]);
    }
}
