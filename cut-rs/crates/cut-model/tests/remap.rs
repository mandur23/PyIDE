//! `cut_model::remap` against `renderer/features/cut/remap.js` on the same inputs, and the remap cases of
//! `verify/cut-model.mjs` and `verify/cut-remap.mjs`.

use cut_model::remap::{self as rm, Direction, Remap, RemapKey, Segment, Side};
use cut_oracle::{Inputs, ask};
use cut_time::{FRAME_RATES, MAX_TICKS, TICKS, Ticks};
use serde_json::{Value, json};

/// Calls for the oracle next to what the Rust side answered.
#[derive(Default)]
struct Batch {
    calls: Vec<Value>,
    ours: Vec<Value>,
}

impl Batch {
    fn push(&mut self, call: Value, ours: Value) {
        self.calls.push(call);
        self.ours.push(ours);
    }

    /// Compares every call (remap.js, or a function of the scenario); gives how many were compared.
    fn check(self) -> usize {
        let exact: Vec<Value> = self
            .calls
            .iter()
            .map(|c| {
                let mut call = vec![json!("exact")];
                call.extend(c.as_array().expect("a call is a list").iter().cloned());
                Value::Array(call)
            })
            .collect();
        let theirs = ask("scenario/remap-bench", &exact);
        let differ: Vec<String> = self
            .calls
            .iter()
            .zip(self.ours.iter().zip(&theirs))
            .filter(|(_, (a, b))| !same(a, b))
            .take(10)
            .map(|(call, (a, b))| format!("{call}\n  -> rust {a}\n  -> javascript {b}"))
            .collect();
        assert!(
            differ.is_empty(),
            "{} calls compared; the first differences:\n{}",
            self.calls.len(),
            differ.join("\n")
        );
        self.calls.len()
    }
}

/// Our JSON against the scenario's, whose numbers come as their decimal text: numbers compared as `f64`, exactly
/// (`1.0` and `1`, `-0` and `0` are the same Number). NaN and infinities are `null` on both sides.
fn same(ours: &Value, theirs: &Value) -> bool {
    match (ours, theirs) {
        (Value::Number(x), Value::String(y)) => {
            y.parse::<f64>().is_ok_and(|y| x.as_f64() == Some(y) || saturated(x, y))
        }
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(u, v)| same(u, v)),
        (Value::Object(x), Value::Object(y)) => {
            let field = |m: &serde_json::Map<String, Value>, k: &str| m.get(k).cloned().unwrap_or(Value::Null);
            x.keys().chain(y.keys()).all(|k| same(&field(x, k), &field(y, k)))
        }
        _ => ours == theirs,
    }
}

/// A tick count the JavaScript computed past what `i64` holds (a speed of 10000% times a time near the longest one):
/// the Rust side stores it saturated. No such curve is valid; it only shows on the nasty inputs.
fn saturated(ours: &serde_json::Number, theirs: f64) -> bool {
    let limit = i64::MAX as f64;
    match ours.as_i64() {
        Some(i64::MAX) => theirs >= limit,
        Some(i64::MIN) => theirs <= -limit,
        _ => false,
    }
}

fn js(r: &Remap) -> Value {
    serde_json::to_value(r).expect("a curve is JSON")
}

fn opt(r: Option<Remap>) -> Value {
    r.as_ref().map_or(Value::Null, js)
}

fn pair((a, b): (f64, f64)) -> Value {
    json!([a, b])
}

fn side_name(s: Side) -> &'static str {
    match s {
        Side::Left => "left",
        Side::Right => "right",
    }
}

fn dir_num(d: Direction) -> i32 {
    match d {
        Direction::Later => 1,
        Direction::Earlier => -1,
    }
}

const SPEEDS: [f64; 18] = [
    1.0,
    1.0,
    0.5,
    2.0,
    0.0,
    -1.0,
    -0.5,
    -2.0,
    0.25,
    4.0,
    rm::MIN,
    rm::MAX,
    -rm::MAX,
    -rm::MIN,
    0.0033,
    1.37,
    0.75,
    0.1,
];

/// A curve on frames of f ticks: holds, reverse, ramps, keys past the duration; from `base` ticks on.
fn curve(rng: &mut Inputs, f: Ticks, base: Ticks) -> Remap {
    let n = rng.range(0, 9) as usize;
    let mut keys = Vec::with_capacity(n);
    let mut t = base;
    for i in 0..n {
        t += rng.range(i64::from(i == 0 && base == 0), 40) * f;
        let ramp = if rng.range(0, 2) == 0 { rng.range(1, 15) * f } else { 0 };
        keys.push(RemapKey { t, ramp });
        t += ramp;
    }
    let speeds = (0..=n).map(|_| rng.pick(&SPEEDS)).collect();
    let duration = match rng.range(0, 3) {
        0 => keys.get(rng.range(0, n as i64) as usize).map_or(f, |k| k.t.max(f)),
        _ => t + rng.range(1, 60) * f,
    };
    let at = match rng.range(0, 4) {
        0 => 0.0,
        1 => (rng.range(0, 2000) * f) as f64,
        2 => rng.range(0, MAX_TICKS) as f64,
        _ => rng.range(-1000, 100_000) as f64 + 0.375,
    };
    Remap { at, speeds, keys, duration }
}

fn key(t: Ticks, ramp: Ticks) -> RemapKey {
    RemapKey { t, ramp }
}

/// Hand-made curves no editor writes: empty, mismatched, out of order, beyond the speed limits, near the longest time.
fn nasty(f: Ticks) -> Vec<Remap> {
    let r = |at: f64, speeds: &[f64], keys: &[RemapKey], duration: Ticks| Remap {
        at,
        speeds: speeds.to_vec(),
        keys: keys.to_vec(),
        duration,
    };
    let big = MAX_TICKS - 100 * f;
    vec![
        rm::constant(0.0, 1.0, f),
        r(0.0, &[], &[], f),
        r(0.0, &[], &[key(f, f)], 2 * f),
        r(0.0, &[1.0, 2.0], &[key(0, 0)], 3 * f),
        r(0.0, &[1.0, 0.5], &[key(0, 2 * f)], 3 * f),
        r(5.0, &[1.0, -1.0, 1.0], &[key(f, 0), key(f, 0)], 4 * f),
        r(0.0, &[1.0, 2.0, 3.0], &[key(5 * f, 0), key(2 * f, f)], 9 * f),
        r(0.0, &[1.0, 2.0, 3.0, 4.0], &[key(f, 0)], 4 * f),
        r(0.0, &[1.0, 0.0], &[key(f, 3 * f)], 0),
        r(0.0, &[1.0], &[], -f),
        r(0.0, &[0.0, 0.0], &[key(2 * f, 0)], 5 * f),
        r(0.0, &[0.0], &[], 5 * f),
        r(0.0, &[rm::MAX + 1e-9, -(rm::MAX + 1e-9)], &[key(f, f)], 3 * f),
        r(0.0, &[rm::MAX + 1e-8, 150.0], &[key(f, 0)], 3 * f),
        r(0.0, &[1e6, -1e-300, 1e-300], &[key(f, 0), key(2 * f, f)], 5 * f),
        r(0.0, &[rm::MIN / 3.0, rm::MIN, -rm::MIN], &[key(f, 4 * f), key(6 * f, 0)], 8 * f),
        r(-1e6, &[-1.0, 1.0], &[key(3 * f, 0)], 6 * f),
        r(big as f64, &[1.0, -0.5, 2.0], &[key(big, 10 * f), key(big + 20 * f, 0)], MAX_TICKS),
        r(MAX_TICKS as f64, &[100.0, -100.0], &[key(MAX_TICKS - f, 0)], MAX_TICKS),
        r(0.0, &[1.0, 3.0], &[key(MAX_TICKS, MAX_TICKS)], MAX_TICKS),
        r(0.5, &[0.3, 0.7, -0.2], &[key(f, 7), key(3 * f + 1, 0)], 5 * f + 3),
    ]
}

/// Clip times worth asking at: around 0, the keys and ramps, the end, past it, between ticks.
fn times(rng: &mut Inputs, r: &Remap, f: Ticks) -> Vec<f64> {
    let d = r.duration as f64;
    let ff = f as f64;
    let mut out = vec![0.0, -ff, ff, d, d - 1.0, d + ff, 0.5, -1e3 * ff, MAX_TICKS as f64];
    for k in &r.keys {
        let (t, e) = (k.t as f64, k.t as f64 + k.ramp as f64);
        out.extend([t, t - 1.0, t + 1.0, t + (k.ramp / 2) as f64, e, e + 1.0, t + 0.25]);
    }
    for _ in 0..4 {
        out.push(rng.range(-2, r.duration.max(1) / f + 2) as f64 * ff);
    }
    out
}

/// Every query of remap.js on r.
fn queries(b: &mut Batch, rng: &mut Inputs, r: &Remap, f: Ticks) {
    let j = js(r);
    let ts = times(rng, r, f);
    b.push(json!(["pieces", j]), serde_json::to_value(rm::pieces(r)).expect("pieces are JSON"));
    b.push(json!(["range", j]), pair(rm::range(r)));
    b.push(json!(["isConstant", j]), json!(rm::is_constant(r)));
    for g in [f, f / 2, 1, 0, 1001 * f] {
        b.push(json!(["valid", j, g]), json!(rm::valid(r, g)));
    }
    for &t in &ts {
        b.push(json!(["value", j, t]), json!(rm::value(r, t)));
        b.push(json!(["speedAt", j, t]), json!(rm::speed_at(r, t)));
        b.push(json!(["sourceAt", j, t]), json!(rm::source_at(r, t)));
        if t.fract() == 0.0 {
            let seg = rm::segment_at(r, t as Ticks);
            b.push(json!(["segmentAt", j, t]), serde_json::to_value(seg).expect("a segment is JSON"));
        }
    }
    for _ in 0..6 {
        let (x, y) = (rng.pick(&ts), rng.pick(&ts));
        b.push(json!(["bounds", j, x, y]), pair(rm::bounds(r, x, y)));
    }
    b.push(json!(["bounds", j, 0, r.duration]), pair(rm::bounds(r, 0.0, r.duration as f64)));
    let (lo, hi) = rm::range(r);
    let mut sources = vec![r.at, r.at + 1.0, r.at - 1.0, lo, hi, lo - 0.25, hi + 0.25, (lo + hi) / 2.0];
    for _ in 0..4 {
        let t = rng.pick(&ts);
        sources.push(rm::value(r, t));
        sources.push(rm::source_at(r, t));
    }
    for &s in &sources {
        if s.is_finite() {
            b.push(json!(["clipTimeOf", j, s]), json!(rm::clip_time_of(r, s, 0.0, r.duration as f64)));
            let (x, y) = (rng.pick(&ts), rng.pick(&ts));
            b.push(json!(["clipTimeOf", j, s, x, y]), json!(rm::clip_time_of(r, s, x, y)));
        }
    }
    let len = hi - lo;
    let mut stays =
        vec![(0.0, Direction::Earlier, -0.25, len + 0.25), (r.duration as f64, Direction::Later, -0.25, len + 0.25)];
    for _ in 0..6 {
        let dir = rng.pick(&[Direction::Later, Direction::Earlier]);
        stays.push((rng.pick(&ts), dir, rng.pick(&sources), rng.pick(&sources)));
    }
    stays.push((0.0, Direction::Later, lo, hi));
    for (from, dir, lo, hi) in stays {
        if lo.is_finite() && hi.is_finite() {
            b.push(json!(["stay", j, from, dir_num(dir), lo, hi]), json!(rm::stay(r, from, dir, lo, hi)));
        }
    }
    for i in 0..=r.keys.len() + 1 {
        let (a, end) = rm::segment_span(r, i);
        b.push(json!(["segmentSpan", j, i]), json!([a, end]));
    }
}

/// Every edit of remap.js on r (indexes the JavaScript does not throw on).
fn edits(b: &mut Batch, rng: &mut Inputs, r: &Remap, f: Ticks) {
    let j = js(r);
    let n = r.keys.len();
    let mut ds: Vec<Ticks> = vec![0, f, -3 * f, r.duration, rng.range(-5, 60) * f];
    for k in &r.keys {
        ds.extend([k.t, k.t + k.ramp, k.t + (k.ramp / f / 2) * f, k.t - f]);
    }
    for &d in &ds {
        b.push(json!(["shift", j, d]), js(&rm::shift(r, d)));
        b.push(json!(["addKey", j, d]), opt(rm::add_key(r, d)));
    }
    b.push(json!(["withDuration", j, 7 * f]), js(&rm::with_duration(r, 7 * f)));
    for i in 0..=n {
        for _ in 0..3 {
            let v = rng.pick(&[0.5, 2.0, -1.0, 0.0, rm::MIN, rm::MAX, 0.1, 4.0, -0.25, 1.0 / 3.0]);
            b.push(json!(["setSegmentSpeed", j, i, v, f]), js(&rm::set_segment_speed(r, i, v, f)));
        }
        b.push(json!(["removeKey", j, i, f]), js(&rm::remove_key(r, i, f)));
        for len in [f, 10 * f, 0, -f] {
            b.push(json!(["insertReverse", j, i, len]), opt(rm::insert_reverse(r, i, len)));
            b.push(json!(["insertFreeze", j, i, len]), opt(rm::insert_freeze(r, i, len)));
        }
    }
    for i in 0..n {
        for _ in 0..2 {
            let side = rng.pick(&[Side::Left, Side::Right]);
            let x = rng.pick(&[-3, 0, 1, 5, 20, 400]) * f;
            b.push(json!(["splitKey", j, i, side_name(side), x, f]), js(&rm::split_key(r, i, side, x, f)));
            let dt = rng.pick(&[-300, -40, -5, -1, 0, 1, 5, 10, 40, 400]) * f;
            let keep = rng.range(0, 1) == 0;
            b.push(json!(["moveKey", j, i, dt, f, { "keepSpeeds": keep }]), js(&rm::move_key(r, i, dt, f, keep)));
        }
        b.push(json!(["moveKey", j, i, 3 * f, f]), js(&rm::move_key(r, i, 3 * f, f, false)));
        for lo in [0.0, r.at - 1000.0 * f as f64] {
            b.push(json!(["reverseRoom", j, i, f, lo]), json!(rm::reverse_room(r, i, f, lo)));
        }
        b.push(json!(["reverseRoom", j, i, f]), json!(rm::reverse_room(r, i, f, 0.0)));
    }
}

fn curves(seed: u64) -> Vec<(Ticks, Remap)> {
    let mut rng = Inputs::new(seed);
    let mut out = Vec::new();
    for fps in FRAME_RATES {
        let f = fps.frame_ticks().expect("an offered rate");
        for i in 0..14 {
            let base = if i == 13 { MAX_TICKS - 400 * f } else { 0 };
            out.push((f, curve(&mut rng, f, base)));
        }
        out.extend(nasty(f).into_iter().map(|r| (f, r)));
    }
    out
}

#[test]
fn queries_match_the_javascript() {
    let mut rng = Inputs::new(11);
    let mut b = Batch::default();
    for (f, r) in curves(1) {
        queries(&mut b, &mut rng, &r, f);
    }
    println!("queries: {} oracle comparisons", b.check());
}

#[test]
fn edits_match_the_javascript() {
    let mut rng = Inputs::new(12);
    let mut b = Batch::default();
    for (f, r) in curves(2) {
        edits(&mut b, &mut rng, &r, f);
    }
    for (at, v, d) in [(0.0, 1.0, TICKS), (5.5, -2.0, 1), (-1.0, 0.0, 0)] {
        b.push(json!(["constant", at, v, d]), js(&rm::constant(at, v, d)));
    }
    println!("edits: {} oracle comparisons", b.check());
}

/// `x` as the JavaScript's `Math.round` takes it.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

#[test]
fn refit_to_another_grid_matches_the_javascript() {
    let mut rng = Inputs::new(13);
    let mut b = Batch::default();
    for (f, r) in curves(3) {
        for to in FRAME_RATES {
            let g = to.frame_ticks().expect("an offered rate");
            let off = rng.range(0, 3000) * f;
            let base = js_round(off as f64 / g as f64) * g as f64;
            let snap = |t: Ticks| (js_round((off as f64 + t as f64) / g as f64) * g as f64 - base) as Ticks;
            b.push(json!(["refitSnap", js(&r), off, g, base, g]), js(&rm::refit(&r, snap, g)));
        }
    }
    println!("refit: {} oracle comparisons", b.check());
}

/// The edits the timeline's rubber band and Effect Controls make, chained as verify/cut-model.mjs's random commands
/// do: each step's input is the Rust result of the step before, so a difference anywhere shows.
#[test]
fn chained_edits_match_the_javascript() {
    let mut rng = Inputs::new(14);
    let mut b = Batch::default();
    for fps in FRAME_RATES {
        let f = fps.frame_ticks().expect("an offered rate");
        let mut r = rm::constant((rng.range(0, 100) * f) as f64, 1.0, rng.range(30, 300) * f);
        for _ in 0..250 {
            let j = js(&r);
            let n = r.keys.len();
            let i = if n > 0 { rng.range(0, n as i64 - 1) as usize } else { 0 };
            let next = match rng.range(0, 9) {
                k if k <= 2 || n == 0 => {
                    let t = js_round(rng.range(0, 1 << 20) as f64 / (1 << 20) as f64 * r.duration as f64 / f as f64)
                        as Ticks
                        * f;
                    let out = rm::add_key(&r, t);
                    b.push(json!(["addKey", j, t]), opt(out.clone()));
                    out
                }
                3 => {
                    let s = rng.range(0, n as i64) as usize;
                    let sign = if r.speeds[s] < 0.0 { -1.0 } else { 1.0 };
                    let v = sign * rng.pick(&[0.1, 0.25, 0.5, 2.0, 4.0]);
                    let out = rm::set_segment_speed(&r, s, v, f);
                    b.push(json!(["setSegmentSpeed", j, s, v, f]), js(&out));
                    Some(out)
                }
                4 => {
                    let side = rng.pick(&[Side::Left, Side::Right]);
                    let x = (rng.range(0, 24) - 5) * f;
                    let out = rm::split_key(&r, i, side, x, f);
                    b.push(json!(["splitKey", j, i, side_name(side), x, f]), js(&out));
                    Some(out)
                }
                5 => {
                    let dt = (rng.range(0, 20) - 10) * f;
                    let keep = rng.range(0, 1) == 0;
                    let out = rm::move_key(&r, i, dt, f, keep);
                    b.push(json!(["moveKey", j, i, dt, f, { "keepSpeeds": keep }]), js(&out));
                    Some(out)
                }
                6 => {
                    let len = rng.range(1, 10) * f;
                    let out = rm::insert_reverse(&r, i, len);
                    b.push(json!(["insertReverse", j, i, len]), opt(out.clone()));
                    out
                }
                7 => {
                    let len = rng.range(1, 10) * f;
                    let out = rm::insert_freeze(&r, i, len);
                    b.push(json!(["insertFreeze", j, i, len]), opt(out.clone()));
                    out
                }
                8 => {
                    let d = rng.range(-3, 20) * f;
                    let out = rm::shift(&r, d);
                    b.push(json!(["shift", j, d]), js(&out));
                    Some(out).filter(|o| o.duration > 0)
                }
                _ => {
                    let out = rm::remove_key(&r, i, f);
                    b.push(json!(["removeKey", j, i, f]), js(&out));
                    Some(out)
                }
            };
            if let Some(next) = next.filter(|o| o.keys.len() < 40) {
                r = next;
            }
            b.push(json!(["valid", js(&r), f]), json!(rm::valid(&r, f)));
            let t = (rng.range(0, r.duration / f) * f) as f64;
            b.push(json!(["sourceAt", js(&r), t]), json!(rm::source_at(&r, t)));
            b.push(json!(["range", js(&r)]), pair(rm::range(&r)));
        }
    }
    println!("chained: {} oracle comparisons", b.check());
}

/// JSON that is not a well-formed curve: `valid` says no on both sides (on the Rust side it does not parse).
#[test]
fn malformed_json_is_invalid_on_both_sides() {
    let f = TICKS / 30;
    let good = json!({ "at": 0, "speeds": [1, 0.5], "keys": [{ "t": f, "ramp": 0 }], "duration": 3 * f });
    let mut cases = vec![
        Value::Null,
        json!([]),
        json!(5),
        json!("remap"),
        json!({}),
        good.clone(),
        json!({ "at": 0, "speeds": [1, 0.5], "keys": [{ "t": f, "ramp": 0 }], "duration": 3 * f, "extra": true }),
    ];
    let edits: [(&str, Value); 14] = [
        ("at", Value::Null),
        ("at", json!("0")),
        ("speeds", json!([1, null])),
        ("speeds", json!([1, "2"])),
        ("speeds", json!({})),
        ("keys", json!([null])),
        ("keys", json!([{ "t": f }])),
        ("keys", json!([{ "t": f as f64 + 0.5, "ramp": 0 }])),
        ("keys", json!([{ "t": -f, "ramp": 0 }])),
        ("keys", json!([{ "t": f, "ramp": "0" }])),
        ("duration", json!(3.5 * f as f64)),
        ("duration", Value::Null),
        ("duration", json!(-3 * f)),
        ("keys", json!({ "t": f, "ramp": 0 })),
    ];
    for (field, v) in edits {
        let mut c = good.clone();
        c[field] = v;
        cases.push(c);
    }
    let mut no_at = good.clone();
    no_at.as_object_mut().expect("an object").remove("at");
    cases.push(no_at);
    let mut b = Batch::default();
    for c in cases {
        let ours = serde_json::from_value::<Remap>(c.clone()).is_ok_and(|r| rm::valid(&r, f));
        b.push(json!(["valid", c, f]), json!(ours));
    }
    let many: Vec<RemapKey> = (1..=rm::MAX_KEYS as i64 + 1).map(|k| key(k * f, 0)).collect();
    for keys in [many[..rm::MAX_KEYS].to_vec(), many] {
        let r = Remap { at: 0.0, speeds: vec![1.0; keys.len() + 1], duration: f, keys };
        b.push(json!(["valid", js(&r), f]), json!(rm::valid(&r, f)));
    }
    println!("valid: {} oracle comparisons", b.check());
}

// ---- the remap cases of verify/cut-model.mjs and verify/cut-remap.mjs (30 fps) ----

const F: Ticks = TICKS / 30;

fn fr(n: f64) -> f64 {
    n * F as f64
}

/// The source frame a remapped clip at 0 shows at its frame k: the curve clamped to its range, to the tick.
fn frame_of(r: &Remap, k: i64) -> i64 {
    let (lo, hi) = rm::range(r);
    let s = rm::source_at(r, fr(k as f64)).max(lo).min(hi);
    (s.round() as i64).div_euclid(F)
}

fn frames(r: &Remap, ks: impl IntoIterator<Item = i64>) -> Vec<i64> {
    ks.into_iter().map(|k| frame_of(r, k)).collect()
}

fn near(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

/// `verify/cut-model.mjs`: a 90-frame clip from source frame 30, a key at 30 frames and 50% after it.
fn slowed() -> Remap {
    let base = rm::constant(fr(30.0), 1.0, 90 * F);
    rm::set_segment_speed(&rm::add_key(&base, 30 * F).expect("a key fits at 1 s"), 1, 0.5, F)
}

#[test]
fn a_fifty_percent_segment_after_a_key() {
    let r = slowed();
    assert_eq!(r.duration, 150 * F, "the 90-frame clip is 150 frames");
    assert_eq!(frames(&r, 27..35), [57, 58, 59, 60, 60, 61, 61, 62], "frames 57-59, then each frame twice");
    assert_eq!(rm::range(&r), (fr(30.0), fr(120.0)), "in/out are the source range the curve reaches");
    assert_eq!(rm::clip_time_of(&r, fr(60.0), 0.0, r.duration as f64), Some(fr(30.0)));
    assert_eq!(rm::clip_time_of(&r, fr(61.0), 0.0, r.duration as f64), Some(fr(32.0)));
    assert_eq!(rm::clip_time_of(&r, fr(60.5), 0.0, r.duration as f64), Some(fr(31.0)));
    assert!(rm::valid(&r, F));
    let back = rm::remove_key(&r, 0, F);
    assert_eq!(back, rm::constant(fr(30.0), 1.0, 90 * F), "removing the key gives back the constant 90-frame clip");
    assert!(rm::is_constant(&back));
}

#[test]
fn a_speed_transition_is_the_exact_integral() {
    let r = rm::split_key(&slowed(), 0, Side::Right, 10 * F, F);
    assert_eq!(r.keys, [key(30 * F, 10 * F)]);
    assert!(near(rm::source_at(&r, fr(35.0)), fr(60.0) + fr(4.375), 1e-6), "halfway the source moved 4.375 frames");
    assert!(near(rm::value(&r, fr(40.0)), fr(60.0) + fr(7.5), 1e-6), "10 frames from 100% to 50% cover 7.5 frames");
    let speeds = [30.0, 35.0, 40.0].map(|t| rm::speed_at(&r, fr(t)));
    assert_eq!(speeds, [1.0, 0.75, 0.5], "the speed along the transition");
    // a razor at 35 frames: the right part starts at the transition's speed there and finishes its rest
    let right = rm::shift(&r, 35 * F);
    assert_eq!((rm::speed_at(&right, 0.0), right.keys[0]), (0.75, key(0, 5 * F)));
    for (cut, part) in [(35, &right), (40, &rm::shift(&r, 40 * F))] {
        for i in cut..150 {
            let whole = rm::source_at(&r, fr(i as f64));
            let after = rm::source_at(part, fr((i - cut) as f64));
            // The JavaScript's own tolerance: the shifted curve integrates from another origin.
            assert!(near(after, whole, 1e-6), "frame {i} after a cut at {cut}: {after} vs {whole}");
        }
    }
}

#[test]
fn a_reverse_and_a_hold() {
    let r = rm::insert_reverse(&slowed(), 0, 10 * F).expect("a reverse at an unsplit key");
    assert_eq!(r.duration, 170 * F, "a 10-frame reverse makes the clip 20 frames longer");
    let back = [58, 59, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 60];
    assert_eq!(frames(&r, 28..52), back, "backward from the frame before the key, then forward again");
    assert_eq!(rm::range(&r), (fr(30.0), fr(120.0)));
    let d = r.duration as f64;
    assert_eq!(rm::clip_time_of(&r, fr(55.0), 0.0, d), Some(fr(25.0)), "the first time the curve reaches it");
    assert_eq!(rm::clip_time_of(&r, fr(60.0), 0.0, d), Some(fr(30.0)));

    let h = rm::insert_freeze(&slowed(), 0, 6 * F).expect("a hold at an unsplit key");
    assert_eq!(h.duration, 156 * F);
    assert_eq!(frames(&h, 28..40), [58, 59, 60, 60, 60, 60, 60, 60, 60, 60, 61, 61], "the key frame for 6 frames");
    assert!(rm::valid(&h, F));

    let quarter = rm::set_segment_speed(&slowed(), 1, 0.25, F);
    assert_eq!(quarter.duration, 270 * F, "60 source frames at 25% after 30 frames");
    assert_eq!(rm::source_at(&quarter, fr(159.0)), fr(60.0) + fr(129.0) * 0.25, "exact, as the JavaScript asserts");
}

#[test]
fn a_nest_hold_and_a_ramp_out_of_a_hold() {
    let base = rm::constant(0.0, 1.0, 120 * F);
    let r = rm::insert_freeze(&rm::add_key(&base, 20 * F).expect("a key"), 0, 10 * F).expect("a hold");
    assert_eq!(r.duration, 130 * F);
    let src = [19, 20, 25, 30, 31].map(|i| rm::source_at(&r, fr(i as f64)) / F as f64);
    assert_eq!(src, [19.0, 20.0, 20.0, 20.0, 21.0], "frame 20 held for 10 frames");

    let base = rm::constant(fr(30.0), 1.0, 470 * F);
    let r = rm::add_key(&base, 30 * F).expect("a key");
    let r = rm::insert_freeze(&r, 0, 30 * F).expect("a hold");
    let r = rm::split_key(&r, 1, Side::Right, 120 * F, F);
    assert_eq!((r.speeds.clone(), r.keys.clone()), (vec![1.0, 0.0, 1.0], vec![key(30 * F, 0), key(60 * F, 120 * F)]));
    let right = rm::shift(&r, 61 * F);
    assert!(right.speeds[0] > 0.0 && right.speeds[0] < rm::MIN, "1 frame into the ramp starts under 1%");
    assert!(rm::valid(&right, F), "and is a valid stored curve");
}

#[test]
fn dragging_a_key_stays_inside_one_to_ten_thousand_percent() {
    let base = rm::constant(0.0, 1.0, 300 * F);
    let r = rm::add_key(&base, 240 * F).expect("a key");
    for dt in [-237, -238, -239, -300] {
        let m = rm::move_key(&r, 0, dt * F, F, false);
        assert!(rm::valid(&m, F) && m.speeds[0].abs() <= rm::MAX && m.keys[0].t % F == 0, "{dt}: {m:?}");
    }
    let three = rm::set_segment_speed(&rm::add_key(&base, 3 * F).expect("a key"), 0, 1.0, F);
    let slow = rm::move_key(&three, 0, 400 * F, F, false);
    assert!(rm::valid(&slow, F) && slow.speeds[0].abs() >= rm::MIN - 1e-12, "{slow:?}");
}

/// `verify/cut-remap.mjs` through the model: the 0-3 s of a 30 fps clip at 0.
#[test]
fn the_rubber_band_edits_of_the_app_suite() {
    let base = rm::constant(0.0, 1.0, 90 * F);
    let keyed = rm::add_key(&base, 30 * F).expect("Ctrl+click adds a key at 1 s");
    assert_eq!(keyed.keys, [key(30 * F, 0)]);
    let r = rm::set_segment_speed(&keyed, 1, 0.5, F);
    assert_eq!((r.speeds.clone(), r.duration), (vec![1.0, 0.5], 150 * F));
    assert_eq!(frames(&r, [0, 15, 29, 30, 31, 32, 33, 60, 100, 149]), [0, 15, 29, 30, 30, 31, 31, 45, 65, 89]);

    let ramp = rm::split_key(&r, 0, Side::Right, 10 * F, F);
    assert_eq!((ramp.keys.clone(), ramp.duration), (vec![key(30 * F, 10 * F)], 150 * F));
    assert_eq!(frames(&ramp, [30, 32, 35, 38, 40, 42]), [30, 31, 34, 36, 37, 38]);

    let alt = rm::move_key(&r, 0, -5 * F, F, true);
    assert_eq!((alt.keys.clone(), alt.speeds.clone(), alt.duration), (vec![key(25 * F, 0)], vec![1.0, 0.5], 150 * F));
    assert_eq!(frames(&alt, 24..28), [24, 25, 25, 26]);

    let later = rm::move_key(&r, 0, 10 * F, F, false);
    assert!(later.keys[0].t == 40 * F && near(later.speeds[0], 0.75, 1e-9) && later.duration == 160 * F);
    assert_eq!(frames(&later, [40]), [30], "the key keeps frame 30");

    let rev = rm::insert_reverse(&r, 0, 10 * F).expect("Ctrl+drag");
    assert_eq!((rev.speeds.clone(), rev.duration), (vec![1.0, -1.0, 1.0, 0.5], 170 * F));
    assert_eq!(frames(&rev, [29, 30, 31, 35, 39, 40, 45, 50, 51]), [29, 29, 28, 24, 20, 20, 25, 30, 30]);

    let hold = rm::insert_freeze(&r, 0, 6 * F).expect("Ctrl+Alt+drag");
    assert_eq!((hold.speeds.clone(), hold.duration), (vec![1.0, 0.0, 0.5], 156 * F));
    assert_eq!(frames(&hold, [29, 30, 33, 35, 36, 38]), [29, 30, 30, 30, 30, 31]);

    let pen = rm::add_key(&r, 90 * F).expect("a Pen click at 3 s");
    assert_eq!(pen.keys.iter().map(|k| k.t / F).collect::<Vec<_>>(), [30, 90]);
    assert_eq!(pen.speeds, [1.0, 0.5, 0.5]);
    assert_eq!(rm::segment_at(&pen, 90 * F), Segment::Index(2));

    let typed = rm::set_segment_speed(&pen, 2, 2.0, F);
    assert_eq!((typed.speeds.clone(), typed.duration), (vec![1.0, 0.5, 2.0], 105 * F));
    assert_eq!(frames(&typed, [90, 91, 92]), [60, 62, 64]);
}

/// A 2000-key curve: holds, ramps and speeds every few frames.
fn long_curve() -> Remap {
    let mut rng = Inputs::new(99);
    let mut keys = Vec::with_capacity(rm::MAX_KEYS);
    let mut t = 0;
    for _ in 0..rm::MAX_KEYS {
        t += rng.range(1, 4) * F;
        let ramp = if rng.range(0, 1) == 0 { rng.range(1, 3) * F } else { 0 };
        keys.push(key(t, ramp));
        t += ramp;
    }
    let speeds = (0..=rm::MAX_KEYS).map(|_| rng.pick(&[0.5, 1.0, 2.0, 0.25, 4.0, 1.5])).collect();
    Remap { at: 0.0, speeds, keys, duration: t + 30 * F }
}

#[test]
#[ignore = "a benchmark: cargo test --release -p cut-model --test remap -- --ignored --nocapture"]
fn bench_source_at_and_clip_time_of() {
    use std::hint::black_box;
    use std::time::Instant;
    let r = long_curve();
    let mut rng = Inputs::new(5);
    let ts: Vec<f64> = (0..2000).map(|_| rng.range(0, r.duration) as f64).collect();
    let ss: Vec<f64> = ts.iter().map(|&t| rm::value(&r, t)).collect();
    let rounds = 5;
    let time = |f: &dyn Fn(f64) -> f64, xs: &[f64]| {
        (0..=rounds)
            .map(|_| {
                let t0 = Instant::now();
                for &x in xs {
                    black_box(f(black_box(x)));
                }
                t0.elapsed().as_nanos() as f64 / xs.len() as f64
            })
            .skip(1)
            .fold(f64::INFINITY, f64::min)
    };
    let d = r.duration as f64;
    let source_at = time(&|t| rm::source_at(&r, t), &ts);
    let clip_time_of = time(&|s| rm::clip_time_of(&r, s, 0.0, d).unwrap_or(0.0), &ss);
    let ps = rm::pieces(&r);
    let held = time(&|t| rm::piece_at(&ps, t).source(t), &ts);
    let theirs = ask("scenario/remap-bench", &[json!(["bench", js(&r), ts, ss, rounds])]);
    println!("2000 keys, ns per call: sourceAt rust {source_at:.0}, javascript {}", theirs[0]["sourceAt"]);
    println!("2000 keys, ns per call: clipTimeOf rust {clip_time_of:.0}, javascript {}", theirs[0]["clipTimeOf"]);
    println!("2000 keys, ns per call: source from held pieces (piece_at + Piece::source) rust {held:.1}");
}
