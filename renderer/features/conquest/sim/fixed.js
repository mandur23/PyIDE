// Fixed-point arithmetic for the state path (docs/conquest-architecture.md section 2): 1000 = 1.0, products and
// quotients are whole numbers rounded toward zero, so every machine computes the same state.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).fixed = api;
})(() => {
  const ONE = 1000;
  const mul = (a, b) => Math.trunc((a * b) / ONE);
  const div = (a, b) => Math.trunc((a * ONE) / b);
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  // Newton's method on integers: Math.sqrt is not used on the state path.
  function isqrt(n) {
    if (n < 2) return n < 0 ? 0 : n;
    let x = n;
    let y = Math.floor((x + 1) / 2);
    while (y < x) { x = y; y = Math.floor((x + Math.floor(n / x)) / 2); }
    return x;
  }
  return { ONE, mul, div, clamp, isqrt };
});
