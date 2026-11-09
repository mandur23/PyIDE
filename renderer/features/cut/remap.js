// Time Remapping of a video clip (Premiere's Time Remapping > Speed; docs/cut-architecture.md section 6): a speed
// curve over the clip's own time, from which the source time is the integral. Pure; model.js and commands.js use it.
//
// Remap = { at, speeds: [v0 ... vn], keys: [{ t, ramp }], duration }
// - Times are ticks from the clip's start; `t` and `ramp` are whole frames of the sequence, keys in order.
// - speeds[0] runs until keys[0].t; key i ramps (speed linear in time) from speeds[i] to speeds[i + 1] over [t, t + ramp]
//   (ramp 0: a jump at t); the last speed runs on forever. A speed is a factor: 1 = 100%, 0 a freeze, < 0 reverse.
// - `at` is the source time at clip time 0; source(t) = at + the integral of the speed from 0 to t, exact for constant
//   and ramp pieces (a quadratic), so clip time -> source time, source -> clip time and the duration need no search.
// - `duration` is the clip's length (whole frames). Keys may lie past it: like source frames past a clip's out point,
//   they are the hidden tail a later trim brings back.
// - A frame at clip time t shows source(t), less one tick where the speed is negative (as a reversed clip shows the
//   frame before its out point first).
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).remap = api;
})(() => {
  // |speed| of a moving segment as a person sets it: 1% to 10000%, as Speed/Duration; 0 is a freeze. A stored curve
  // may hold slower speeds where a cut lands inside a ramp (okSpeed).
  const MIN = 0.01;
  const MAX = 100;
  const MAX_KEYS = 2000;

  // The pieces of the curve, in order, covering every time: { t0, t1, tr, sr, vr, a }: from t0 to t1 the source is
  // sr + vr (t - tr) + a (t - tr)^2 / 2 and the speed vr + a (t - tr).
  function pieces(r) {
    const out = [];
    let t0 = -Infinity;
    let tr = 0;
    let sr = r.at;
    let vr = r.speeds[0];
    r.keys.forEach((k, i) => {
      out.push({ t0, t1: k.t, tr, sr, vr, a: 0 });
      const sk = sr + vr * (k.t - tr);
      const v1 = r.speeds[i + 1];
      if (k.ramp > 0) {
        out.push({ t0: k.t, t1: k.t + k.ramp, tr: k.t, sr: sk, vr, a: (v1 - vr) / k.ramp });
        sr = sk + ((vr + v1) * k.ramp) / 2;
      } else sr = sk;
      tr = k.t + k.ramp;
      t0 = tr;
      vr = v1;
    });
    out.push({ t0, t1: Infinity, tr, sr, vr, a: 0 });
    return out;
  }
  // The piece that holds t; at a boundary the later one (a key's time has its new speed).
  function pieceAt(ps, t) {
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t < ps[mid].t1) hi = mid;
      else lo = mid + 1;
    }
    return ps[lo];
  }
  const valueOf = (p, t) => { const x = t - p.tr; return p.sr + p.vr * x + (p.a * x * x) / 2; };
  const speedOf = (p, t) => p.vr + p.a * (t - p.tr);

  // The source time the curve reaches at clip time t (continuous), the speed there, and the source time a frame
  // starting at t shows.
  const value = (r, t) => valueOf(pieceAt(pieces(r), t), t);
  const speedAt = (r, t) => speedOf(pieceAt(pieces(r), t), t);
  function sourceAt(r, t) {
    const p = pieceAt(pieces(r), t);
    return speedOf(p, t) < 0 ? valueOf(p, t) - 1 : valueOf(p, t);
  }

  // The lowest and highest source time the curve reaches over clip times [a, b].
  function bounds(r, a, b) {
    let lo = Infinity;
    let hi = -Infinity;
    const see = (s) => { if (s < lo) lo = s; if (s > hi) hi = s; };
    for (const p of pieces(r)) {
      const x0 = Math.max(a, p.t0);
      const x1 = Math.min(b, p.t1);
      if (x1 < x0) continue;
      see(valueOf(p, x0));
      see(valueOf(p, x1));
      if (p.a) {
        const x = p.tr - p.vr / p.a;
        if (x > x0 && x < x1) see(valueOf(p, x));
      }
    }
    return [lo, hi];
  }
  // The source range a remapped clip spans, which is its in/out: [lowest, highest] over its length; a clip that only
  // holds one frame spans a tick.
  function range(r) {
    const [lo, hi] = bounds(r, 0, r.duration);
    return [lo, hi > lo ? hi : lo + 1];
  }

  // The times x in [x0, x1] of piece p where the source is s, in order.
  function roots(p, s, x0, x1) {
    const c = p.sr - s;
    const b = p.vr;
    const a2 = p.a / 2;
    const out = [];
    if (!a2) {
      if (b) out.push(p.tr - c / b);
      else if (!c) out.push(x0);
    } else {
      const disc = b * b - 4 * a2 * c;
      if (disc >= 0) {
        const q = -(b + Math.sign(b || 1) * Math.sqrt(disc)) / 2;
        if (q) out.push(p.tr + q / a2, p.tr + c / q);
        else out.push(p.tr);
      }
    }
    return out.filter((x) => x >= x0 && x <= x1).sort((u, v) => u - v);
  }
  // The earliest clip time in [a, b] at which the curve reaches source time s, or null (source -> clip time).
  function clipTimeOf(r, s, a = 0, b = r.duration) {
    for (const p of pieces(r)) {
      const x0 = Math.max(a, p.t0);
      const x1 = Math.min(b, p.t1);
      if (x1 < x0) continue;
      const hit = roots(p, s, x0, x1);
      if (hit.length) return hit[0];
    }
    return null;
  }
  // How far from clip time `from`, going later (dir 1) or earlier (dir -1), the curve stays inside [lo, hi]
  // (Infinity when it never leaves): the source a trim can bring in.
  function stay(r, from, dir, lo, hi) {
    const v0 = value(r, from);
    if (!(v0 >= lo && v0 <= hi)) return 0;
    let best = Infinity;
    for (const p of pieces(r)) {
      const x0 = dir > 0 ? Math.max(from, p.t0) : p.t0;
      const x1 = dir > 0 ? p.t1 : Math.min(from, p.t1);
      if (!(x0 <= x1)) continue;
      for (const x of [...roots(p, lo, x0, x1), ...roots(p, hi, x0, x1)]) {
        const d = Math.abs(x - from);
        if (d >= best) continue;
        // a real exit: a tick further the curve is outside (touching a bound and turning back is not)
        const v = value(r, x + dir);
        if (v < lo || v > hi) best = d;
      }
    }
    return best;
  }

  // ---- edits: each returns a new curve (the caller's is never changed) ----

  const copy = (r) => ({ at: r.at, speeds: r.speeds.slice(), keys: r.keys.map((k) => ({ t: k.t, ramp: k.ramp })), duration: r.duration });

  // A constant speed for `duration` from source time `at` (a clip's Speed/Duration as a curve).
  const constant = (at, speed, duration) => ({ at, speeds: [speed], keys: [], duration });

  // The curve seen from clip time d as its new start (a trimmed head, the right part of a cut; d < 0 brings back
  // the time before the start at the first speed). Keys before d go; a ramp across d keeps its rest.
  function shift(r, d) {
    if (!d) return copy(r);
    const at = value(r, d);
    const keys = [];
    let v0 = r.speeds[0];
    const speeds = [];
    r.keys.forEach((k, i) => {
      const e = k.t + k.ramp;
      if (e <= d) { v0 = r.speeds[i + 1]; return; }
      if (k.t < d) {
        v0 = r.speeds[i] + ((r.speeds[i + 1] - r.speeds[i]) * (d - k.t)) / k.ramp;
        keys.push({ t: 0, ramp: e - d });
      } else keys.push({ t: k.t - d, ramp: k.ramp });
      speeds.push(r.speeds[i + 1]);
    });
    return { at, speeds: [v0, ...speeds], keys, duration: r.duration - d };
  }
  const withDuration = (r, duration) => ({ ...copy(r), duration });

  // Where the constant part of segment i runs: [a, b) (the last one never ends).
  function segmentSpan(r, i) {
    const prev = r.keys[i - 1];
    const a = prev ? prev.t + prev.ramp : 0;
    const b = i < r.keys.length ? r.keys[i].t : Infinity;
    return [a, b];
  }
  // The segment (index into speeds) at clip time t: { index } on a constant part, { ramp: key index } inside a ramp.
  function segmentAt(r, t) {
    for (let i = 0; i < r.keys.length; i++) {
      const k = r.keys[i];
      if (t < k.t) return { index: i };
      if (k.ramp > 0 && t < k.t + k.ramp) return { ramp: i };
    }
    return { index: r.keys.length };
  }

  const snapTo = (f) => (x) => Math.round(x / f) * f;

  // Segment i plays at speed v: its constant part keeps its source frames, so its length changes and the later keys
  // move with it (and the end, when it lies after them). A freeze, or a change of direction, is left alone.
  function setSegmentSpeed(r, i, v, f) {
    const old = r.speeds[i];
    if (!old || !v || Math.sign(old) !== Math.sign(v)) return copy(r);
    const sn = snapTo(f);
    const [a, b] = segmentSpan(r, i);
    const ratio = old / v;
    const out = copy(r);
    out.speeds[i] = v;
    const scaled = (x) => a + Math.max(x > a ? f : 0, sn((x - a) * ratio));
    if (b !== Infinity) {
      const L = b - a;
      const delta = (L > 0 ? scaled(b) : b) - b;
      for (let j = i; j < out.keys.length; j++) out.keys[j].t += delta;
      out.duration = r.duration <= a ? r.duration : r.duration < b ? scaled(r.duration) : r.duration + delta;
    } else out.duration = r.duration <= a ? r.duration : scaled(r.duration);
    out.duration = Math.max(f, out.duration);
    return out;
  }

  // A key at clip time t (on a constant part, not on another key); null where there cannot be one.
  function addKey(r, t) {
    if (!(t > 0 && t < r.duration)) return null;
    const j = r.keys.filter((k) => k.t < t).length;
    const prev = r.keys[j - 1];
    const next = r.keys[j];
    if (prev && t < prev.t + prev.ramp) return null;
    if (next && t >= next.t) return null;
    const out = copy(r);
    out.keys.splice(j, 0, { t, ramp: 0 });
    out.speeds.splice(j + 1, 0, r.speeds[j]);
    return out;
  }
  // Removes key i: the segment after it takes the speed before it (keeping its source frames, as a rubber band drag).
  function removeKey(r, i, f) {
    let out = copy(r);
    const left = r.speeds[i];
    if (left && Math.sign(left) === Math.sign(r.speeds[i + 1] || 0)) out = setSegmentSpeed(out, i + 1, left, f);
    out.keys.splice(i, 1);
    out.speeds.splice(i + 1, 1);
    return out;
  }

  // Splits key i into a speed transition: its left half moves `x` earlier ('left') or its right half `x` later
  // ('right'); a negative x narrows it. The other half stays; the transition stays between the neighbours.
  function splitKey(r, i, side, x, f) {
    const k = r.keys[i];
    const prev = r.keys[i - 1];
    const next = r.keys[i + 1];
    const out = copy(r);
    const o = out.keys[i];
    if (side === 'right') {
      const limit = (next ? next.t : r.duration) - k.t;
      o.ramp = Math.max(0, Math.min(limit, k.ramp + x));
    } else {
      const lo = prev ? Math.max(prev.t + prev.ramp, prev.t + (prev.ramp ? 0 : f)) : 0;
      const e = k.t + k.ramp;
      const t = Math.max(lo, Math.min(e, k.t - x));
      o.t = t;
      o.ramp = e - t;
      if (!o.t && !o.ramp) return copy(r);
    }
    return out;
  }

  // Moves key i (with its transition) by dt. keepSpeeds (Alt): the speeds stay and so do the other keys' times, so
  // the source frames after it move. Otherwise the key keeps its source frame: the segment before it plays faster or
  // slower to reach it, the later keys and the end move along (a freeze before it gets longer or shorter).
  function moveKey(r, i, dt, f, { keepSpeeds = false } = {}) {
    const k = r.keys[i];
    const prev = r.keys[i - 1];
    const next = r.keys[i + 1];
    const out = copy(r);
    const lowT = prev ? prev.t + Math.max(prev.ramp, f) : f;
    const left = r.speeds[i];
    const [a] = segmentSpan(r, i);
    const L = k.t - a;
    if (keepSpeeds || (left && L <= 0)) {
      const highT = next ? next.t - Math.max(k.ramp, f) : r.duration - Math.max(k.ramp, f);
      out.keys[i].t = Math.max(lowT, Math.min(highT, k.t + dt));
      return out;
    }
    let delta;
    if (!left) delta = Math.max(lowT, k.t + dt) - k.t;
    else {
      // The length is limited, not the speed: the speed comes from the whole-frame length, so it stays in 1% to
      // 10000% (or where it already was).
      const lo = Math.min(L, Math.max(f, Math.ceil((Math.abs(left) * L) / MAX / f - 1e-9) * f));
      const hi = Math.max(L, Math.floor((Math.abs(left) * L) / MIN / f + 1e-9) * f);
      const L2 = Math.min(hi, Math.max(lo, f, L + dt));
      out.speeds[i] = (left * L) / L2;
      delta = L2 - L;
    }
    for (let j = i; j < out.keys.length; j++) out.keys[j].t += delta;
    if (r.duration > k.t) out.duration = r.duration + delta;
    return out;
  }

  // Ctrl-drag of key i (Premiere's reverse): after it the clip plays backward for `len` at the speed it arrived with,
  // then forward again for `len` back to the key's frame, and goes on as before; 2 len longer. Null on a split key.
  function insertReverse(r, i, len) {
    const k = r.keys[i];
    if (!k || k.ramp || !(len > 0)) return null;
    const w = Math.abs(r.speeds[i]) || Math.abs(r.speeds[i + 1]) || 1;
    const out = copy(r);
    out.speeds.splice(i + 1, 0, -w, w);
    out.keys.splice(i + 1, 0, { t: k.t + len, ramp: 0 }, { t: k.t + 2 * len, ramp: 0 });
    for (let j = i + 3; j < out.keys.length; j++) out.keys[j].t += 2 * len;
    if (r.duration > k.t) out.duration = r.duration + 2 * len;
    return out;
  }
  // The longest reverse insertReverse may make at key i without going before source time lo: whole frames.
  function reverseRoom(r, i, f, lo = 0) {
    const k = r.keys[i];
    const w = Math.abs(r.speeds[i]) || Math.abs(r.speeds[i + 1]) || 1;
    return Math.max(0, Math.floor((value(r, k.t) - lo) / w / f + 1e-9) * f);
  }
  // Ctrl+Alt-drag of key i (a hold): the key's frame stays for `len`, then the clip goes on as before; len longer.
  // Null on a split key.
  function insertFreeze(r, i, len) {
    const k = r.keys[i];
    if (!k || k.ramp || !(len > 0)) return null;
    const out = copy(r);
    out.speeds.splice(i + 1, 0, 0);
    out.keys.splice(i + 1, 0, { t: k.t + len, ramp: 0 });
    for (let j = i + 2; j < out.keys.length; j++) out.keys[j].t += len;
    if (r.duration > k.t) out.duration = r.duration + len;
    return out;
  }

  // Keys and length moved to another frame grid through fn (old clip time -> new clip time on the grid); keys that
  // land on or before the one before go.
  function refit(r, fn, f) {
    const out = { at: r.at, speeds: [r.speeds[0]], keys: [], duration: Math.max(f, fn(r.duration)) };
    let last = null;
    r.keys.forEach((k, i) => {
      const t = Math.max(0, fn(k.t));
      const e = Math.max(t, fn(k.t + k.ramp));
      if (last && (t <= last.t || t < last.t + last.ramp)) { out.speeds[out.speeds.length - 1] = r.speeds[i + 1]; return; }
      if (!t && e === t) { out.speeds[0] = r.speeds[i + 1]; return; }
      last = { t, ramp: e - t };
      out.keys.push(last);
      out.speeds.push(r.speeds[i + 1]);
    });
    return out;
  }

  // A stored speed is anything up to MAX in size: a cut or a head trim inside a ramp next to a hold starts the new
  // curve at the speed there, which may be under MIN (what a person types or drags stays inside MIN..MAX).
  const okSpeed = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX + 1e-9;
  // Whether r is a well-formed curve on frames of f ticks (what model.validate asks).
  function valid(r, f) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    if (!Number.isFinite(r.at) || !Array.isArray(r.speeds) || !Array.isArray(r.keys) || r.keys.length > MAX_KEYS) return false;
    if (r.speeds.length !== r.keys.length + 1 || !r.speeds.every(okSpeed)) return false;
    if (!Number.isInteger(r.duration) || r.duration < f || r.duration % f) return false;
    let prev = null;
    for (const k of r.keys) {
      if (!k || typeof k !== 'object' || !Number.isInteger(k.t) || !Number.isInteger(k.ramp) || k.t < 0 || k.ramp < 0 || k.t % f || k.ramp % f) return false;
      if (!k.t && !k.ramp) return false;
      if (prev && (k.t <= prev.t || k.t < prev.t + prev.ramp)) return false;
      prev = k;
    }
    return true;
  }
  // Whether a curve plays like a constant speed (no keys): it can be one.
  const isConstant = (r) => !r.keys.length && r.speeds[0] !== 0;

  return {
    MIN, MAX, MAX_KEYS, pieces, value, speedAt, sourceAt, bounds, range, clipTimeOf, stay, constant, shift, withDuration,
    segmentSpan, segmentAt, setSegmentSpeed, addKey, removeKey, splitKey, moveKey, insertReverse, reverseRoom, insertFreeze,
    refit, valid, isConstant,
  };
});
