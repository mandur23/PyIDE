//! Time Remapping of a video clip (port of `remap.js`): a speed curve over the clip's own time, whose integral is the
//! source time (docs/cut-architecture.md section 6).
//!
//! - Times are ticks from the clip's start; a key's `t` and `ramp` are whole frames of the sequence, keys in order.
//! - `speeds[0]` runs until `keys[0].t`; key i ramps (speed linear in time) from `speeds[i]` to `speeds[i + 1]` over
//!   `[t, t + ramp]` (ramp 0: a jump at t); the last speed runs on forever. 1 = 100%, 0 a freeze, < 0 reverse.
//! - `at` is the source time at clip time 0; the source is exact for constant and ramp pieces (a quadratic), so clip
//!   time -> source time, source -> clip time and the duration need no search.
//! - Keys may lie past `duration`: the hidden tail a later trim brings back.
//!
//! The arithmetic is the JavaScript's, in `f64` and in its order, so both editors compute the same numbers to the bit
//! (`tests/remap.rs` compares them). Key times are integers in the file; they are read as `f64` for the arithmetic and
//! stored back from the `f64` result, as the JavaScript's Numbers are.

use std::ops::ControlFlow;

use cut_time::Ticks;
use serde::{Deserialize, Serialize};

/// A key of the curve: at clip time `t` the speed ramps over `ramp` ticks to the next speed (whole frames).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RemapKey {
    pub t: Ticks,
    pub ramp: Ticks,
}

/// `{ at, speeds: [v0 ... vn], keys: [{ t, ramp }], duration }` (docs/cut-architecture.md section 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Remap {
    /// Source ticks at clip time 0.
    pub at: f64,
    pub speeds: Vec<f64>,
    pub keys: Vec<RemapKey>,
    /// The clip's length, whole frames.
    pub duration: Ticks,
}

/// The slowest moving speed a person sets (1%); 0 is a freeze. A stored curve may hold slower ones (see [`valid`]).
pub const MIN: f64 = 0.01;
/// The fastest speed, set or stored (10000%).
pub const MAX: f64 = 100.0;
/// The most keys a curve holds.
pub const MAX_KEYS: usize = 2000;

/// A piece of the curve: from `t0` to `t1` the source is `sr + vr (t - tr) + a (t - tr)^2 / 2` and the speed
/// `vr + a (t - tr)`. The first piece starts at -infinity, the last ends at +infinity.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Piece {
    pub t0: f64,
    pub t1: f64,
    pub tr: f64,
    pub sr: f64,
    pub vr: f64,
    pub a: f64,
}

impl Piece {
    /// The source time at clip time t.
    pub fn value(&self, t: f64) -> f64 {
        let x = t - self.tr;
        self.sr + self.vr * x + (self.a * x * x) / 2.0
    }

    /// The speed at clip time t.
    pub fn speed(&self, t: f64) -> f64 {
        self.vr + self.a * (t - self.tr)
    }

    /// The source time a frame starting at t shows: one tick less where the speed is negative, as a reversed clip
    /// shows the frame before its out point first.
    pub fn source(&self, t: f64) -> f64 {
        if self.speed(t) < 0.0 { self.value(t) - 1.0 } else { self.value(t) }
    }
}

/// Where clip time t lies, as [`segment_at`] answers: on the constant part of `speeds[i]`, or inside key i's ramp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Segment {
    Index(usize),
    Ramp(usize),
}

/// Which half of a key [`split_key`] drags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

/// Which way [`stay`] looks from its start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Later,
    Earlier,
}

impl Direction {
    fn step(self) -> f64 {
        match self {
            Self::Later => 1.0,
            Self::Earlier => -1.0,
        }
    }
}

// ---- JavaScript's Number semantics where they differ from Rust's ----

/// `Math.max(a, b)`: NaN wins, +0 is above -0 (`f64::max` drops NaN).
fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`.
fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.round`: halves go up (`f64::round` takes -2.5 to -3).
fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// A Number's truthiness: neither 0 nor NaN.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// `r.speeds[i]`, NaN where the JavaScript reads `undefined`.
fn speed(r: &Remap, i: usize) -> f64 {
    r.speeds.get(i).copied().unwrap_or(f64::NAN)
}

/// A time computed in `f64` stored as ticks (always an integer here, from integer inputs).
fn ticks(x: f64) -> Ticks {
    x as Ticks
}

fn end(k: &RemapKey) -> f64 {
    k.t as f64 + k.ramp as f64
}

/// `Array.prototype.splice(i, 0, v)`: past the end it appends.
fn insert<T>(v: &mut Vec<T>, i: usize, x: T) {
    v.insert(i.min(v.len()), x);
}

fn remove<T>(v: &mut Vec<T>, i: usize) {
    if i < v.len() {
        v.remove(i);
    }
}

// ---- reading the curve ----

/// The pieces of the curve, in order, covering every time.
pub fn pieces(r: &Remap) -> Vec<Piece> {
    let mut out = Vec::with_capacity(2 * r.keys.len() + 1);
    walk(r, |p| {
        out.push(p);
        ControlFlow::<()>::Continue(())
    });
    out
}

/// Visits the pieces in order without collecting them, for the questions that walk them once and may stop early.
fn walk<B>(r: &Remap, mut visit: impl FnMut(Piece) -> ControlFlow<B>) -> Option<B> {
    let mut t0 = f64::NEG_INFINITY;
    let mut tr = 0.0;
    let mut sr = r.at;
    let mut vr = speed(r, 0);
    for (i, k) in r.keys.iter().enumerate() {
        let (kt, ramp) = (k.t as f64, k.ramp as f64);
        if let ControlFlow::Break(b) = visit(Piece { t0, t1: kt, tr, sr, vr, a: 0.0 }) {
            return Some(b);
        }
        let sk = sr + vr * (kt - tr);
        let v1 = speed(r, i + 1);
        if ramp > 0.0 {
            if let ControlFlow::Break(b) =
                visit(Piece { t0: kt, t1: kt + ramp, tr: kt, sr: sk, vr, a: (v1 - vr) / ramp })
            {
                return Some(b);
            }
            sr = sk + ((vr + v1) * ramp) / 2.0;
        } else {
            sr = sk;
        }
        tr = kt + ramp;
        t0 = tr;
        vr = v1;
    }
    visit(Piece { t0, t1: f64::INFINITY, tr, sr, vr, a: 0.0 }).break_value()
}

/// The piece of `ps` (from [`pieces`]) that holds t; at a boundary the later one (a key's time has its new speed).
/// Hold the pieces to ask many times of one curve without rebuilding them.
pub fn piece_at(ps: &[Piece], t: f64) -> &Piece {
    let (mut lo, mut hi) = (0, ps.len() - 1);
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if t < ps[mid].t1 {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    &ps[lo]
}

/// The source time the curve reaches at clip time t (continuous).
pub fn value(r: &Remap, t: f64) -> f64 {
    piece_at(&pieces(r), t).value(t)
}

/// The speed at clip time t.
pub fn speed_at(r: &Remap, t: f64) -> f64 {
    piece_at(&pieces(r), t).speed(t)
}

/// The source time a frame starting at clip time t shows (one tick less where the speed is negative).
pub fn source_at(r: &Remap, t: f64) -> f64 {
    piece_at(&pieces(r), t).source(t)
}

/// The lowest and highest source time the curve reaches over clip times `[a, b]` (infinities when it is empty).
pub fn bounds(r: &Remap, a: f64, b: f64) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut see = |s: f64| {
        if s < lo {
            lo = s;
        }
        if s > hi {
            hi = s;
        }
    };
    walk(r, |p| {
        let x0 = max(a, p.t0);
        let x1 = min(b, p.t1);
        if x1 < x0 {
            return ControlFlow::<()>::Continue(());
        }
        see(p.value(x0));
        see(p.value(x1));
        if truthy(p.a) {
            let x = p.tr - p.vr / p.a;
            if x > x0 && x < x1 {
                see(p.value(x));
            }
        }
        ControlFlow::Continue(())
    });
    (lo, hi)
}

/// The source range a remapped clip spans, which is its in/out: `[lowest, highest]` over its length; a clip that only
/// holds one frame spans a tick.
pub fn range(r: &Remap) -> (f64, f64) {
    let (lo, hi) = bounds(r, 0.0, r.duration as f64);
    (lo, if hi > lo { hi } else { lo + 1.0 })
}

/// The times x in `[x0, x1]` of piece p where the source is s, in order (at most two).
fn roots(p: &Piece, s: f64, x0: f64, x1: f64) -> impl Iterator<Item = f64> {
    let c = p.sr - s;
    let b = p.vr;
    let a2 = p.a / 2.0;
    let mut xs = [f64::NAN; 2];
    if !truthy(a2) {
        if truthy(b) {
            xs[0] = p.tr - c / b;
        } else if !truthy(c) {
            xs[0] = x0;
        }
    } else {
        let disc = b * b - 4.0 * a2 * c;
        if disc >= 0.0 {
            let sign = if truthy(b) { b.signum() } else { 1.0 };
            let q = -(b + sign * disc.sqrt()) / 2.0;
            if truthy(q) {
                xs = [p.tr + q / a2, p.tr + c / q];
            } else {
                xs[0] = p.tr;
            }
        }
    }
    let inside = move |x: f64| x >= x0 && x <= x1;
    // Sorted like the JavaScript's stable sort: equal values keep their order.
    if inside(xs[0]) && inside(xs[1]) && xs[1] < xs[0] {
        xs.swap(0, 1);
    }
    xs.into_iter().filter(move |&x| inside(x))
}

/// The earliest clip time in `[a, b]` at which the curve reaches source time s (source -> clip time). The
/// JavaScript's defaults are `a = 0`, `b = r.duration`.
pub fn clip_time_of(r: &Remap, s: f64, a: f64, b: f64) -> Option<f64> {
    walk(r, |p| {
        let x0 = max(a, p.t0);
        let x1 = min(b, p.t1);
        // An empty [x0, x1] holds no root, so it needs no test of its own.
        roots(&p, s, x0, x1).next().map_or(ControlFlow::Continue(()), ControlFlow::Break)
    })
}

/// How far from clip time `from`, going `dir`, the curve stays inside `[lo, hi]` (infinity when it never leaves): the
/// source a trim can bring in.
pub fn stay(r: &Remap, from: f64, dir: Direction, lo: f64, hi: f64) -> f64 {
    let ps = pieces(r);
    let value = |t: f64| piece_at(&ps, t).value(t);
    let v0 = value(from);
    if !(v0 >= lo && v0 <= hi) {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    for p in &ps {
        let (x0, x1) = match dir {
            Direction::Later => (max(from, p.t0), p.t1),
            Direction::Earlier => (p.t0, min(from, p.t1)),
        };
        // An empty [x0, x1] holds no root, as in clip_time_of.
        for x in roots(p, lo, x0, x1).chain(roots(p, hi, x0, x1)) {
            let d = (x - from).abs();
            if d >= best {
                continue;
            }
            // A real exit: a tick further the curve is outside (touching a bound and turning back is not).
            let v = value(x + dir.step());
            if v < lo || v > hi {
                best = d;
            }
        }
    }
    best
}

/// Where the constant part of segment i runs: `[a, b)`, `b` none for the last one, which never ends.
pub fn segment_span(r: &Remap, i: usize) -> (Ticks, Option<Ticks>) {
    let (a, b) = span(r, i);
    (ticks(a), b.is_finite().then(|| ticks(b)))
}

fn span(r: &Remap, i: usize) -> (f64, f64) {
    let a = i.checked_sub(1).and_then(|j| r.keys.get(j)).map_or(0.0, end);
    let b = r.keys.get(i).map_or(f64::INFINITY, |k| k.t as f64);
    (a, b)
}

/// The segment at clip time t: an index into `speeds` on a constant part, a key index inside a ramp.
pub fn segment_at(r: &Remap, t: Ticks) -> Segment {
    let t = t as f64;
    for (i, k) in r.keys.iter().enumerate() {
        if t < k.t as f64 {
            return Segment::Index(i);
        }
        if k.ramp > 0 && t < end(k) {
            return Segment::Ramp(i);
        }
    }
    Segment::Index(r.keys.len())
}

// A stored speed is anything up to MAX in size: a cut or a head trim inside a ramp next to a hold starts the new curve
// at the speed there, which may be under MIN (what a person types or drags stays inside MIN..MAX).
fn ok_speed(v: f64) -> bool {
    v.is_finite() && v.abs() <= MAX + 1e-9
}

/// Whether r is a well-formed curve on frames of f ticks (what `model.validate` asks). A JSON value that does not
/// parse as a [`Remap`] is not one either.
pub fn valid(r: &Remap, f: Ticks) -> bool {
    let f = f as f64;
    // `x % f` as the JavaScript tests it: NaN (f = 0) is falsy, so it passes.
    let on_grid = |x: f64| !truthy(x % f);
    if !r.at.is_finite() || r.keys.len() > MAX_KEYS {
        return false;
    }
    if r.speeds.len() != r.keys.len() + 1 || !r.speeds.iter().all(|&v| ok_speed(v)) {
        return false;
    }
    let duration = r.duration as f64;
    if duration < f || !on_grid(duration) {
        return false;
    }
    let mut prev: Option<&RemapKey> = None;
    for k in &r.keys {
        let (t, ramp) = (k.t as f64, k.ramp as f64);
        if t < 0.0 || ramp < 0.0 || !on_grid(t) || !on_grid(ramp) {
            return false;
        }
        if t == 0.0 && ramp == 0.0 {
            return false;
        }
        if prev.is_some_and(|p| t <= p.t as f64 || t < end(p)) {
            return false;
        }
        prev = Some(k);
    }
    true
}

/// Whether a curve plays like a constant speed (no keys): it can be one.
pub fn is_constant(r: &Remap) -> bool {
    r.keys.is_empty() && r.speeds.first() != Some(&0.0)
}

// ---- edits: each returns a new curve (the caller's is never changed) ----

/// A constant speed for `duration` from source time `at` (a clip's Speed/Duration as a curve).
pub fn constant(at: f64, speed: f64, duration: Ticks) -> Remap {
    Remap { at, speeds: vec![speed], keys: Vec::new(), duration }
}

/// The curve seen from clip time d as its new start (a trimmed head, the right part of a cut; d < 0 brings back the
/// time before the start at the first speed). Keys before d go; a ramp across d keeps its rest.
pub fn shift(r: &Remap, d: Ticks) -> Remap {
    if d == 0 {
        return r.clone();
    }
    let df = d as f64;
    let at = value(r, df);
    let mut keys = Vec::with_capacity(r.keys.len());
    let mut v0 = speed(r, 0);
    let mut speeds = vec![0.0];
    for (i, k) in r.keys.iter().enumerate() {
        let (kt, ramp) = (k.t as f64, k.ramp as f64);
        let e = kt + ramp;
        if e <= df {
            v0 = speed(r, i + 1);
            continue;
        }
        if kt < df {
            v0 = speed(r, i) + ((speed(r, i + 1) - speed(r, i)) * (df - kt)) / ramp;
            keys.push(RemapKey { t: 0, ramp: ticks(e - df) });
        } else {
            keys.push(RemapKey { t: ticks(kt - df), ramp: k.ramp });
        }
        speeds.push(speed(r, i + 1));
    }
    speeds[0] = v0;
    Remap { at, speeds, keys, duration: ticks(r.duration as f64 - df) }
}

/// The curve with another length.
pub fn with_duration(r: &Remap, duration: Ticks) -> Remap {
    Remap { duration, ..r.clone() }
}

/// Segment i plays at speed v: its constant part keeps its source frames, so its length changes and the later keys
/// move with it (and the end, when it lies after them). A freeze, or a change of direction, is left alone.
pub fn set_segment_speed(r: &Remap, i: usize, v: f64, f: Ticks) -> Remap {
    let old = speed(r, i);
    if !truthy(old) || !truthy(v) || old.signum() != v.signum() {
        return r.clone();
    }
    let f = f as f64;
    let (a, b) = span(r, i);
    let ratio = old / v;
    let mut out = r.clone();
    out.speeds[i] = v;
    let scaled = |x: f64| a + max(if x > a { f } else { 0.0 }, round(((x - a) * ratio) / f) * f);
    let duration = r.duration as f64;
    let mut nd = if b != f64::INFINITY {
        let delta = (if b - a > 0.0 { scaled(b) } else { b }) - b;
        for k in &mut out.keys[i..] {
            k.t = ticks(k.t as f64 + delta);
        }
        if duration <= a {
            duration
        } else if duration < b {
            scaled(duration)
        } else {
            duration + delta
        }
    } else if duration <= a {
        duration
    } else {
        scaled(duration)
    };
    nd = max(f, nd);
    out.duration = ticks(nd);
    out
}

/// A key at clip time t (on a constant part, not on another key); none where there cannot be one.
pub fn add_key(r: &Remap, t: Ticks) -> Option<Remap> {
    let tf = t as f64;
    if !(tf > 0.0 && tf < r.duration as f64) {
        return None;
    }
    let j = r.keys.iter().filter(|k| (k.t as f64) < tf).count();
    if j > 0 && tf < end(&r.keys[j - 1]) {
        return None;
    }
    if r.keys.get(j).is_some_and(|next| tf >= next.t as f64) {
        return None;
    }
    let mut out = r.clone();
    out.keys.insert(j, RemapKey { t, ramp: 0 });
    insert(&mut out.speeds, j + 1, speed(r, j));
    Some(out)
}

/// Removes key i: the segment after it takes the speed before it (keeping its source frames, as a rubber band drag).
pub fn remove_key(r: &Remap, i: usize, f: Ticks) -> Remap {
    let left = speed(r, i);
    let right = speed(r, i + 1);
    let mut out = if truthy(left) && truthy(right) && left.signum() == right.signum() {
        set_segment_speed(r, i + 1, left, f)
    } else {
        r.clone()
    };
    remove(&mut out.keys, i);
    remove(&mut out.speeds, i + 1);
    out
}

/// Splits key i into a speed transition: its left half moves `x` earlier ([`Side::Left`]) or its right half `x` later
/// ([`Side::Right`]); a negative x narrows it. The other half stays; the transition stays between the neighbours.
/// `i` must be a key's index (the JavaScript throws otherwise; this gives the curve back unchanged).
pub fn split_key(r: &Remap, i: usize, side: Side, x: Ticks, f: Ticks) -> Remap {
    let Some(k) = r.keys.get(i) else { return r.clone() };
    let (kt, kramp, x, f) = (k.t as f64, k.ramp as f64, x as f64, f as f64);
    let mut out = r.clone();
    match side {
        Side::Right => {
            let limit = r.keys.get(i + 1).map_or(r.duration as f64, |n| n.t as f64) - kt;
            out.keys[i].ramp = ticks(max(0.0, min(limit, kramp + x)));
        }
        Side::Left => {
            let lo = i.checked_sub(1).map_or(0.0, |j| {
                let p = &r.keys[j];
                max(end(p), p.t as f64 + if p.ramp != 0 { 0.0 } else { f })
            });
            let e = kt + kramp;
            let t = max(lo, min(e, kt - x));
            if t == 0.0 && e - t == 0.0 {
                return r.clone();
            }
            out.keys[i] = RemapKey { t: ticks(t), ramp: ticks(e - t) };
        }
    }
    out
}

/// Moves key i (with its transition) by dt. `keep_speeds` (Alt): the speeds stay and so do the other keys' times, so
/// the source frames after it move. Otherwise the key keeps its source frame: the segment before it plays faster or
/// slower to reach it, the later keys and the end move along (a freeze before it gets longer or shorter). `i` must be a
/// key's index (the JavaScript throws otherwise; this gives the curve back unchanged).
pub fn move_key(r: &Remap, i: usize, dt: Ticks, f: Ticks, keep_speeds: bool) -> Remap {
    let Some(k) = r.keys.get(i) else { return r.clone() };
    let (kt, kramp, dt, f) = (k.t as f64, k.ramp as f64, dt as f64, f as f64);
    let prev = i.checked_sub(1).map(|j| &r.keys[j]);
    let mut out = r.clone();
    let low_t = prev.map_or(f, |p| p.t as f64 + max(p.ramp as f64, f));
    let left = speed(r, i);
    let (a, _) = span(r, i);
    let l = kt - a;
    if keep_speeds || (truthy(left) && l <= 0.0) {
        let high_t = r.keys.get(i + 1).map_or(r.duration as f64, |n| n.t as f64) - max(kramp, f);
        out.keys[i].t = ticks(max(low_t, min(high_t, kt + dt)));
        return out;
    }
    let delta = if !truthy(left) {
        max(low_t, kt + dt) - kt
    } else {
        // The length is limited, not the speed: the speed comes from the whole-frame length, so it stays in 1% to
        // 10000% (or where it already was).
        let lo = min(l, max(f, ((left.abs() * l) / MAX / f - 1e-9).ceil() * f));
        let hi = max(l, ((left.abs() * l) / MIN / f + 1e-9).floor() * f);
        let l2 = min(hi, max(max(lo, f), l + dt));
        out.speeds[i] = (left * l) / l2;
        l2 - l
    };
    for k in &mut out.keys[i..] {
        k.t = ticks(k.t as f64 + delta);
    }
    if r.duration as f64 > kt {
        out.duration = ticks(r.duration as f64 + delta);
    }
    out
}

/// The speed a reverse at key i plays at: the one it arrived with, else the one after, else 100%.
fn reverse_speed(r: &Remap, i: usize) -> f64 {
    [speed(r, i).abs(), speed(r, i + 1).abs()].into_iter().find(|&w| truthy(w)).unwrap_or(1.0)
}

/// Ctrl-drag of key i (Premiere's reverse): after it the clip plays backward for `len` at the speed it arrived with,
/// then forward again for `len` back to the key's frame, and goes on as before; 2 len longer. None on a split key.
pub fn insert_reverse(r: &Remap, i: usize, len: Ticks) -> Option<Remap> {
    let k = r.keys.get(i)?;
    if k.ramp != 0 || len <= 0 {
        return None;
    }
    let (kt, len) = (k.t as f64, len as f64);
    let w = reverse_speed(r, i);
    let mut out = r.clone();
    let at = (i + 1).min(out.speeds.len());
    out.speeds.splice(at..at, [-w, w]);
    out.keys.insert(i + 1, RemapKey { t: ticks(kt + 2.0 * len), ramp: 0 });
    out.keys.insert(i + 1, RemapKey { t: ticks(kt + len), ramp: 0 });
    for k in &mut out.keys[i + 3..] {
        k.t = ticks(k.t as f64 + 2.0 * len);
    }
    if r.duration as f64 > kt {
        out.duration = ticks(r.duration as f64 + 2.0 * len);
    }
    Some(out)
}

/// The longest reverse [`insert_reverse`] may make at key i without going before source time `lo` (0 in the
/// JavaScript's default): whole frames, as `f64` ticks. 0 when i is not a key's index (the JavaScript throws).
pub fn reverse_room(r: &Remap, i: usize, f: Ticks, lo: f64) -> f64 {
    let Some(k) = r.keys.get(i) else { return 0.0 };
    let f = f as f64;
    let w = reverse_speed(r, i);
    max(0.0, ((value(r, k.t as f64) - lo) / w / f + 1e-9).floor() * f)
}

/// Ctrl+Alt-drag of key i (a hold): the key's frame stays for `len`, then the clip goes on as before; len longer. None
/// on a split key.
pub fn insert_freeze(r: &Remap, i: usize, len: Ticks) -> Option<Remap> {
    let k = r.keys.get(i)?;
    if k.ramp != 0 || len <= 0 {
        return None;
    }
    let (kt, len) = (k.t as f64, len as f64);
    let mut out = r.clone();
    insert(&mut out.speeds, i + 1, 0.0);
    out.keys.insert(i + 1, RemapKey { t: ticks(kt + len), ramp: 0 });
    for k in &mut out.keys[i + 2..] {
        k.t = ticks(k.t as f64 + len);
    }
    if r.duration as f64 > kt {
        out.duration = ticks(r.duration as f64 + len);
    }
    Some(out)
}

/// Keys and length moved to another frame grid through `to` (old clip time -> new clip time on the grid); keys that
/// land on or before the one before go.
pub fn refit(r: &Remap, mut to: impl FnMut(Ticks) -> Ticks, f: Ticks) -> Remap {
    let mut out = Remap {
        at: r.at,
        speeds: vec![speed(r, 0)],
        keys: Vec::with_capacity(r.keys.len()),
        duration: ticks(max(f as f64, to(r.duration) as f64)),
    };
    for (i, k) in r.keys.iter().enumerate() {
        let t = max(0.0, to(k.t) as f64);
        let e = max(t, to(ticks(end(k))) as f64);
        if out.keys.last().is_some_and(|l: &RemapKey| t <= l.t as f64 || t < end(l)) {
            *out.speeds.last_mut().expect("one speed more than keys") = speed(r, i + 1);
            continue;
        }
        if t == 0.0 && e == t {
            out.speeds[0] = speed(r, i + 1);
            continue;
        }
        out.keys.push(RemapKey { t: ticks(t), ramp: ticks(e - t) });
        out.speeds.push(speed(r, i + 1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_number_helpers() {
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert!(max(1.0, f64::NAN).is_nan() && min(f64::NAN, 1.0).is_nan());
        assert!(max(-0.0, 0.0).is_sign_positive() && min(0.0, -0.0).is_sign_negative());
    }

    #[test]
    fn a_curve_without_speeds_does_not_panic() {
        let r = Remap { at: 0.0, speeds: vec![], keys: vec![RemapKey { t: 10, ramp: 5 }], duration: 0 };
        assert!(value(&r, 3.0).is_nan());
        let _ = (bounds(&r, 0.0, 20.0), clip_time_of(&r, 1.0, 0.0, 20.0), stay(&r, 0.0, Direction::Later, 0.0, 1.0));
        let _ = (shift(&r, 12), set_segment_speed(&r, 0, 1.0, 1), add_key(&r, 3), remove_key(&r, 0, 1));
        let _ = (split_key(&r, 0, Side::Left, 3, 1), move_key(&r, 0, 3, 1, false), insert_reverse(&r, 0, 1));
        let _ = (insert_freeze(&r, 0, 2), reverse_room(&r, 5, 1, 0.0), refit(&r, |t| t * 2, 1), valid(&r, 0));
    }
}
