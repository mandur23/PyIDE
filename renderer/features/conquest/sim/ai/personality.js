// A nation's character (plan 5.4): four numbers 0..100 (boldness, caution, loyalty, revanchism) and how they bend
// every threshold and weight of the nation AI and of the answers diplomacy.js gives. A scenario nation carries its
// own; one whose scenario gives none (or an empty object) gets one of the four generic personalities, picked from
// the seed and its index, so a generated map is the same on every machine.
//
// bend(p, base, coef) is base + Σ coef[trait] × (p[trait] - 50): a coefficient says how many permille one point of
// a trait above the middle moves the number. The bend tables of the callers live in THRESHOLDS so the screens can
// show the same numbers the AI uses.
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).personality = api; }
})(() => {
  const TRAITS = ['boldness', 'caution', 'loyalty', 'revanchism'];
  const GENERIC = [
    { id: 'aggressive', boldness: 80, caution: 25, loyalty: 50, revanchism: 60 },
    { id: 'defensive', boldness: 25, caution: 80, loyalty: 65, revanchism: 50 },
    { id: 'opportunist', boldness: 65, caution: 45, loyalty: 25, revanchism: 40 },
    { id: 'balanced', boldness: 50, caution: 50, loyalty: 50, revanchism: 50 },
  ];

  // Permille per trait point above 50.
  const THRESHOLDS = {
    war: { base: 620, coef: { boldness: -4, caution: 3 } },
    peace: { base: 500, coef: { boldness: 2, caution: -2 } },
    wantPeace: { base: 450, coef: { boldness: 4, caution: -3 } },
    call: { base: 500, coef: {} },
    alliance: { base: 500, coef: { caution: 1 } },
    access: { base: 520, coef: { caution: 2 } },
    attack: { base: 1100, coef: { caution: 6, boldness: -4 } },
  };

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  function mix(a, b) {
    let h = Math.imul(a ^ 0x5bd1e995, 0x2c1b3c6d) ^ Math.imul(b + 0x6d2b79f5, 0x297a2d39);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return (h ^ (h >>> 13)) >>> 0;
  }

  const cache = new WeakMap();
  function all(ctx) {
    let list = cache.get(ctx.scenario);
    if (list && list.seed === ctx.state.seed) return list;
    list = ctx.scenario.nations.map((s, i) => {
      const p = s.personality || {};
      if (TRAITS.some((t) => Number.isInteger(p[t]))) {
        const out = { id: 'scenario' };
        for (const t of TRAITS) out[t] = clamp(Number.isInteger(p[t]) ? p[t] : 50, 0, 100);
        return out;
      }
      return { ...GENERIC[mix(ctx.state.seed | 0, i) % GENERIC.length] };
    });
    list.seed = ctx.state.seed;
    cache.set(ctx.scenario, list);
    return list;
  }

  const of = (ctx, nation) => all(ctx)[nation];

  function bend(p, base, coef) {
    let v = base;
    for (const t of TRAITS) if (coef[t]) v += coef[t] * (p[t] - 50);
    return v;
  }

  const threshold = (ctx, nation, name) => bend(of(ctx, nation), THRESHOLDS[name].base, THRESHOLDS[name].coef);

  // 500..1500: how strongly an old loss pulls (revanchism) or a promise binds (loyalty).
  const factor = (ctx, nation, trait) => 500 + of(ctx, nation)[trait] * 10;

  return { of, bend, threshold, factor, GENERIC, TRAITS, THRESHOLDS };
});
