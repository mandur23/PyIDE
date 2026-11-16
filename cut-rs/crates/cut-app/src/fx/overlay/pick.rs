//! A click on the Program monitor that picks a value for a control (`ui-overlay.js` `pickColor`, `sample`,
//! `average`): a colour from the monitor's pixels, or a point of the clip's picture.

use super::geom::{Frame, P, Placement, from_seq, round1};

/// The average colour of the 5 x 5 block of `rgba` (`w` x `h`, the picture drawn into `fr`'s frame of a
/// `seq` sized sequence) around screen point `pt`; `None` outside the picture.
pub fn color_at(rgba: &[u8], w: u32, h: u32, fr: &Frame, seq: P, pt: P) -> Option<[u8; 3]> {
    let s = fr.to_sequence(pt);
    let (u, v) = (s[0] / seq[0], s[1] / seq[1]);
    if !(0.0..=1.0).contains(&u) || !(0.0..=1.0).contains(&v) {
        return None;
    }
    let (cx, cy) = ((u * f64::from(w)).round() as i64, (v * f64::from(h)).round() as i64);
    let (mut sum, mut n) = ([0u32; 3], 0u32);
    for y in cy - 2..=cy + 2 {
        for x in cx - 2..=cx + 2 {
            if x < 0 || y < 0 || x >= i64::from(w) || y >= i64::from(h) {
                continue;
            }
            let i = ((y * i64::from(w) + x) * 4) as usize;
            let Some(px) = rgba.get(i..i + 3) else { continue };
            for c in 0..3 {
                sum[c] += u32::from(px[c]);
            }
            n += 1;
        }
    }
    (n > 0).then(|| sum.map(|s| ((f64::from(s) / f64::from(n)).round()) as u8))
}

/// `#rrggbb`.
pub fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// The point of the clip's picture under screen point `pt`, in its pixels from its center (what an effect's `point`
/// parameter holds: `effects.js` reads `center` as `0.5 + center * pxScale / w`).
pub fn point_at(fr: &Frame, p: &Placement, pt: P) -> [f64; 2] {
    from_seq(p, fr.to_sequence(pt)).map(round1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_colour_is_the_average_of_the_block_under_the_pointer() {
        // a 10 x 10 picture: left half red, right half blue, drawn 20 points to a sequence of 100 x 100
        let mut px = vec![0u8; 400];
        for (i, p) in px.chunks_mut(4).enumerate() {
            p.copy_from_slice(if i % 10 < 5 { &[255, 0, 0, 255] } else { &[0, 0, 255, 255] });
        }
        let fr = Frame { origin: [0.0, 0.0], k: 0.2 };
        assert_eq!(color_at(&px, 10, 10, &fr, [100.0, 100.0], [2.0, 10.0]), Some([255, 0, 0]));
        assert_eq!(color_at(&px, 10, 10, &fr, [100.0, 100.0], [18.0, 10.0]), Some([0, 0, 255]));
        // across the border: 3 of 5 columns red
        assert_eq!(color_at(&px, 10, 10, &fr, [100.0, 100.0], [8.0, 10.0]), Some([153, 0, 102]));
        assert_eq!(color_at(&px, 10, 10, &fr, [100.0, 100.0], [25.0, 10.0]), None);
        assert_eq!(hex([255, 8, 170]), "#ff08aa");
    }

    #[test]
    fn a_point_is_in_the_pictures_pixels_from_its_center() {
        let p = Placement {
            seq: [1920.0, 1080.0],
            size: [1920.0, 1080.0],
            content: [-960.0, -540.0, 1920.0, 1080.0],
            position: [100.0, 0.0],
            scale: [50.0, 50.0],
            rotation: 0.0,
            anchor: [0.0, 0.0],
            crop: [0.0; 4],
        };
        let fr = Frame { origin: [0.0, 0.0], k: 0.5 };
        // the sequence's (1110, 540) is 50 sequence pixels right of the picture's center: 100 of its pixels
        assert_eq!(point_at(&fr, &p, [555.0, 270.0]), [100.0, 0.0]);
    }
}
