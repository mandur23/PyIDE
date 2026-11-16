// masks.js for the Rust port's tests: its functions with typed arrays given and returned as plain arrays, the calls
// that take a JavaScript value (a prepared list, an edit function) built here, and the coverage benchmark.
const path = require('node:path');

const M = require(path.join(__dirname, '..', '..', '..', 'renderer', 'features', 'cut', 'masks.js'));

const image = (img) => ({ ...img, data: Float32Array.from(img.data) });
const plain = (img) => ({ ...img, data: Array.from(img.data) });
const EDITS = {
  insert: (p, e, t) => M.insertVertex(p, e, t),
  remove: (p, i) => M.removeVertex(p, i),
  translate: (p, du, dv) => M.translate(p, du, dv),
};

// Every number of an answer as { $n: String(x) }: the Rust side parses that text exactly, which serde_json's default
// float parser does not always do (it can land an ulp off), so the comparison can stay bit for bit.
const exact = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? { $n: String(v) } : null;
  if (Array.isArray(v)) return v.map(exact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, exact(x)]));
  return v;
};

const api = {
  ...M,
  constants: () => ({ MODES: M.MODES, FIELDS: M.FIELDS, DEFAULTS: M.DEFAULTS, RANGES: M.RANGES, MAX_MASKS: M.MAX_MASKS, MAX_POINTS: M.MAX_POINTS, MIN_POINTS: M.MIN_POINTS, FLATTEN: M.FLATTEN, KAPPA: M.KAPPA, SIGMA: M.SIGMA, WGSL: M.WGSL }),
  // full, kept only when the mask it makes is well formed (what the Rust `full` returns); null when it throws.
  full: (m) => {
    try {
      const f = M.full(m);
      return M.problem(f) === null ? f : null;
    } catch {
      return null;
    }
  },
  coverage: (...a) => Array.from(M.coverage(...a)),
  coverageAt: (masks, w, h, pxScale, points) => {
    const q = M.prepare(masks, w, h, pxScale);
    return points.map(([x, y]) => M.coverageAt(q, x, y));
  },
  gpuData: (...a) => Array.from(M.gpuData(...a)),
  cutCpu: (img, masks, pxScale) => plain(M.cutCpu(image(img), masks, pxScale)),
  mixCpu: (base, fx, masks, pxScale) => plain(M.mixCpu(image(base), image(fx), masks, pxScale)),
  mapKeyframes: (list, edit, ...args) => M.mapKeyframes(list, (p) => EDITS[edit](p, ...args)),
  // The best of `reps` runs of coverage, nanoseconds a pixel, with a position-weighted checksum of the coverage to
  // compare (two pictures that differ anywhere almost surely differ in it).
  benchCoverage: (masks, w, h, reps) => {
    let best = Infinity;
    let sum = 0;
    for (let r = 0; r < reps; r++) {
      const t0 = process.hrtime.bigint();
      const cov = M.coverage(masks, w, h);
      const ns = Number(process.hrtime.bigint() - t0);
      best = Math.min(best, ns);
      sum = 0;
      for (let i = 0; i < cov.length; i++) sum += cov[i] * ((i % 1009) + 1);
    }
    return { nsPerPixel: best / (w * h), sum };
  },
};

module.exports = Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, typeof fn === 'function' ? (...a) => exact(fn(...a)) : fn]));
