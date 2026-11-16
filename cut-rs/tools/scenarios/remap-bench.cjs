// remap.js driven the way tests/remap.rs needs it: answers with exact numbers, refit with a grid-snapping function (a
// function cannot travel as JSON), and the timing of sourceAt / clipTimeOf for the benchmark next to the Rust one.
const path = require('node:path');

const R = require(path.join(__dirname, '..', '..', '..', 'renderer', 'features', 'cut', 'remap.js'));

// The fn commands.js passes: an old clip time moved by `off`, snapped to the nearest frame of `g`, less `base`.
const refitSnap = (r, off, g, base, f) => R.refit(r, (t) => Math.round((off + t) / g) * g - base, f);

// R[name](...args) (or a function of this file) with every finite number as its shortest decimal text, so the Rust
// side parses it with the standard library: serde_json's default parser can land one ulp off.
const digits = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (Array.isArray(v)) return v.map(digits);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, digits(x)]));
  return v === undefined ? null : v;
};
const exact = (name, ...args) => digits((module.exports[name] || R[name])(...args));

// Nanoseconds per call of each function over the given inputs, best of `rounds`, after a warm-up round.
function bench(r, times, sources, rounds) {
  let sink = 0;
  const time = (fn, xs) => {
    let best = Infinity;
    for (let k = 0; k <= rounds; k++) {
      const t0 = process.hrtime.bigint();
      for (const x of xs) sink += fn(x) ?? 0;
      const ns = Number(process.hrtime.bigint() - t0) / xs.length;
      if (k > 0 && ns < best) best = ns;
    }
    return best;
  };
  const sourceAt = time((t) => R.sourceAt(r, t), times);
  const clipTimeOf = time((s) => R.clipTimeOf(r, s), sources);
  return { sourceAt, clipTimeOf, sink: Number.isFinite(sink) };
}

module.exports = { refitSnap, bench, exact };
