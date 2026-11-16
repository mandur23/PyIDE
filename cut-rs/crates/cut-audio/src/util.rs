//! Small numeric helpers shared by the mixer, the effects and the meters, written as the JavaScript computes them.

pub use cut_formats::table::js_round;

/// dB to a linear gain; -144 dB and below (and NaN) is silence.
pub fn db_to_gain(db: f64) -> f64 {
    if db > -144.0 { 10f64.powf(db / 20.0) } else { 0.0 }
}

/// A linear gain to dB; -inf for 0 and below.
pub fn gain_to_db(g: f64) -> f64 {
    if g > 0.0 { 20.0 * g.log10() } else { f64::NEG_INFINITY }
}

/// The modified Bessel function I0 by its series, stopped once a term is below 1e-14 of the sum (the engine's
/// resampler and true-peak tables).
pub(crate) fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..60 {
        let k = f64::from(k);
        term *= q / (k * k);
        sum += term;
        if term < 1e-14 * sum {
            break;
        }
    }
    sum
}

/// `Math.ceil` and `Math.floor` of a float as an integer index (the JavaScript keeps them as numbers).
pub(crate) fn ceil_i(x: f64) -> i64 {
    x.ceil() as i64
}

pub(crate) fn floor_i(x: f64) -> i64 {
    x.floor() as i64
}

/// `Math.max` and `Math.min` of two numbers: NaN wins.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

pub(crate) fn round_i(x: f64) -> i64 {
    js_round(x) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decibels() {
        assert_eq!(db_to_gain(0.0), 1.0);
        assert_eq!(db_to_gain(-144.0), 0.0);
        assert_eq!(db_to_gain(f64::NAN), 0.0);
        assert_eq!(gain_to_db(0.0), f64::NEG_INFINITY);
        assert!((gain_to_db(0.5) + 6.0206).abs() < 1e-4);
    }
}
