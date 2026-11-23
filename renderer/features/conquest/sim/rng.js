// The one random generator of the simulation: xoshiro128** over four int32 kept in the state (state.rng), seeded by
// splitmix32. Every draw advances the array it is given, so a saved state continues the same sequence.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).rng = api;
})(() => {
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));

  function seed(n) {
    let s = n | 0;
    const out = [];
    for (let i = 0; i < 4; i++) {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      out.push((z ^ (z >>> 16)) | 0);
    }
    if (!(out[0] | out[1] | out[2] | out[3])) out[0] = 1;
    return out;
  }

  function next(s) {
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  // 0..n-1. The product stays exact below 2^53 for n up to 2^21.
  const int = (s, n) => Math.floor((next(s) * n) / 4294967296);

  return { seed, next, int };
});
