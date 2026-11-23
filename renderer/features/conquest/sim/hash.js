// hash(state): a stable 32-bit FNV-1a over the whole state as 8 hex digits, the check that two runs agree. Object
// fields are visited in sorted key order, arrays and typed arrays in index order; each value is tagged with its kind
// so [1, 2] and "1,2" differ. A whole number is mixed as its 32 bits; anything else as its decimal text, so a float
// that slipped into the state still changes the hash rather than being rounded away.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).hash = api;
})(() => {
  function hash(value) {
    let h = 0x811c9dc5;
    const byte = (b) => { h = Math.imul(h ^ (b & 255), 16777619); };
    const int = (x) => { byte(x); byte(x >> 8); byte(x >> 16); byte(x >> 24); };
    const str = (s) => { int(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); byte(c); byte(c >> 8); } };
    const walk = (v) => {
      if (v === null || v === undefined) return byte(0);
      switch (typeof v) {
        case 'boolean': return byte(v ? 2 : 1);
        case 'number':
          if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) { byte(3); return int(v); }
          byte(4); return str(String(v));
        case 'string': byte(5); return str(v);
        default: break;
      }
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        byte(6); int(v.length);
        for (let i = 0; i < v.length; i++) walk(v[i]);
        return undefined;
      }
      const keys = Object.keys(v).sort();
      byte(7); int(keys.length);
      for (const k of keys) { str(k); walk(v[k]); }
      return undefined;
    };
    walk(value);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  return { hash };
});
