// Keyframes of Nano Studio Cut: a property's value at a time. A keyframe list is sorted by t (ticks from the clip's
// start); each keyframe's `ease` shapes the segment that leaves it, with the CSS meaning of the names: 'easeIn' starts
// slowly, 'easeOut' arrives slowly, 'easeInOut' both, 'bezier' is a cubic-bezier timing curve through handles
// h = [x1, y1, x2, y2] (x in 0..1, y may overshoot), 'hold' keeps the value until the next keyframe. Numbers and arrays
// of numbers interpolate (arrays element by element), #rrggbb colors by channel; other values hold.
// The list functions (insert, remove) return new lists and never change the one given: commands store them.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Cut = globalThis.Cut || {}).keyframes = api;
})(() => {
  const PRESETS = { easeIn: [0.42, 0, 1, 1], easeOut: [0, 0, 0.58, 1], easeInOut: [0.42, 0, 0.58, 1] };

  // y of the cubic-bezier timing curve (0,0) (x1,y1) (x2,y2) (1,1) at x: solve x(s) = x by Newton steps, bisection when
  // the slope is flat.
  function bezier(x1, y1, x2, y2, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (s) => ((ax * s + bx) * s + cx) * s;
    const dx = (s) => (3 * ax * s + 2 * bx) * s + cx;
    let s = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(s) - x;
      if (Math.abs(e) < 1e-7) return ((ay * s + by) * s + cy) * s;
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const v = sx(s);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return ((ay * s + by) * s + cy) * s;
  }

  // The eased fraction of a segment leaving keyframe k at linear fraction u (0..1).
  function eased(k, u) {
    const ease = k.ease || 'linear';
    if (ease === 'linear') return u;
    if (ease === 'hold') return 0;
    const h = ease === 'bezier' ? k.h || [0.25, 0.1, 0.25, 1] : PRESETS[ease];
    return h ? bezier(h[0], h[1], h[2], h[3], u) : u;
  }

  const HEX = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;
  function mixColor(a, b, p) {
    const ma = HEX.exec(a);
    const mb = HEX.exec(b);
    if (!ma || !mb || !!ma[2] !== !!mb[2]) return null;
    const ca = (ma[1] + (ma[2] || '')).match(/../g).map((x) => parseInt(x, 16));
    const cb = (mb[1] + (mb[2] || '')).match(/../g).map((x) => parseInt(x, 16));
    return `#${ca.map((x, i) => Math.max(0, Math.min(255, Math.round(x + (cb[i] - x) * p))).toString(16).padStart(2, '0')).join('')}`;
  }

  function mix(a, b, p) {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * p;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((x, i) => (typeof x === 'number' && typeof b[i] === 'number' ? x + (b[i] - x) * p : x));
    if (typeof a === 'string' && typeof b === 'string') return mixColor(a, b, p) ?? a;
    return a;
  }

  const copy = (v) => (Array.isArray(v) ? v.slice() : v);

  function valueAt(keyframes, t, fallback) {
    if (!keyframes || !keyframes.length) return fallback;
    const first = keyframes[0];
    if (t <= first.t) return copy(first.v);
    const last = keyframes[keyframes.length - 1];
    if (t >= last.t) return copy(last.v);
    let lo = 0, hi = keyframes.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keyframes[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = keyframes[lo];
    const b = keyframes[hi];
    if (a.ease === 'hold') return copy(a.v);
    return mix(a.v, b.v, eased(a, (t - a.t) / (b.t - a.t)));
  }

  // The static value of a prop path on a clip: 'opacity' (clip.props), 'effects.<id>.<param>' (the effect's params),
  // 'layers.<id>.<field>' (a text layer).
  function staticValue(clip, prop) {
    const parts = prop.split('.');
    if (parts.length === 1) return clip.props?.[prop];
    if (parts[0] === 'effects') return (clip.effects || []).find((e) => e.id === parts[1])?.params?.[parts[2]];
    if (parts[0] === 'layers') return (clip.source?.layers || []).find((l) => l.id === parts[1])?.[parts[2]];
    return undefined;
  }

  function propValue(clip, prop, t, fallback) {
    const list = clip.keyframes?.[prop];
    if (list && list.length) return valueAt(list, t, fallback);
    const v = staticValue(clip, prop);
    return v === undefined ? fallback : copy(v);
  }

  function insert(keyframes, kf) {
    const list = (keyframes || []).filter((k) => k.t !== kf.t);
    const k = { t: kf.t, v: copy(kf.v), ease: kf.ease || 'linear' };
    if (k.ease === 'bezier') k.h = (kf.h || [0.25, 0.1, 0.25, 1]).slice();
    let i = list.length;
    while (i > 0 && list[i - 1].t > k.t) i--;
    list.splice(i, 0, k);
    return list;
  }

  const remove = (keyframes, t) => (keyframes || []).filter((k) => k.t !== t);
  const next = (keyframes, t) => (keyframes || []).find((k) => k.t > t) || null;
  function prev(keyframes, t) {
    const list = keyframes || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].t < t) return list[i];
    return null;
  }

  return { valueAt, propValue, staticValue, insert, remove, next, prev, bezier, eased, mix };
});
