// Saves: write(state) is JSON text { format, v, state } with the typed province arrays written as plain arrays;
// read(text) gives { ok: true, state } with them typed again, or { ok: false, reason } for a file it cannot use:
// 'not-json', 'not-a-save', 'newer-version' (a later app wrote it), 'bad-state' (a field is missing or of the wrong
// shape). A state read back continues exactly as the one written (same hash, same rng sequence).
// A save written before sea control and casualties existed reads with their defaults: state.sea.ctrl all -1 (the
// next daily run fills it), and per nation navy 0, casualties 0, blockade 0, suff 1000 each, unlocked []; the
// diplomacy tables state.create makes up front (state.complete) are added when missing.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).save = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const ST = NODE ? require('./state.js') : globalThis.Conquest.state;

  const FORMAT = 'nano-conquest-save';

  const write = (state) => JSON.stringify({ format: FORMAT, v: ST.VERSION, state }, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));

  const isInt = (x) => Number.isInteger(x);

  function problem(s) {
    if (!s || typeof s !== 'object') return 'state';
    if (s.v !== ST.VERSION) return 'v';
    if (!Array.isArray(s.rng) || s.rng.length !== 4 || !s.rng.every(isInt)) return 'rng';
    if (!isInt(s.hour) || s.hour < 0 || !isInt(s.player) || !isInt(s.doy0) || !s.next || typeof s.next !== 'object') return 'hour';
    if (!s.prov || typeof s.prov !== 'object') return 'prov';
    let n = -1;
    for (const k of Object.keys(ST.PROV)) {
      if (k === 'works' && s.prov[k] === undefined) continue;
      const a = s.prov[k];
      if (!Array.isArray(a) || !a.every(isInt) || (n >= 0 && a.length !== n)) return `prov.${k}`;
      n = a.length;
    }
    if (!Array.isArray(s.nations) || !s.nations.every((x) => x && typeof x.tag === 'string' && Array.isArray(x.lines) && Array.isArray(x.templates) && Array.isArray(x.armies) && Array.isArray(x.training) && Array.isArray(x.builds) && x.stock)) return 'nations';
    if (!Array.isArray(s.divs) || !s.divs.every((d, i) => d && isInt(d.id) && (i === 0 || d.id > s.divs[i - 1].id) && isInt(d.nation) && d.nation >= 0 && d.nation < s.nations.length && isInt(d.prov) && d.prov > 0 && d.prov < n && Array.isArray(d.path))) return 'divs';
    if (!Array.isArray(s.battles) || !s.rel || typeof s.rel !== 'object' || !Array.isArray(s.memory) || !Array.isArray(s.fired) || !Array.isArray(s.log)) return 'tables';
    return null;
  }

  function read(text) {
    let file;
    try { file = JSON.parse(text); } catch { return { ok: false, reason: 'not-json' }; }
    if (!file || typeof file !== 'object' || file.format !== FORMAT || !isInt(file.v)) return { ok: false, reason: 'not-a-save' };
    if (file.v > ST.VERSION) return { ok: false, reason: 'newer-version' };
    const s = file.state;
    const bad = problem(s);
    if (bad) return { ok: false, reason: 'bad-state', field: bad };
    const n = s.prov.owner.length;
    for (const [k, T] of Object.entries(ST.PROV)) s.prov[k] = s.prov[k] === undefined ? new T(n) : T.from(s.prov[k]);
    if (!s.sea || !Array.isArray(s.sea.ctrl) || s.sea.ctrl.length !== n || !s.sea.ctrl.every(isInt)) s.sea = { ctrl: new Int16Array(n).fill(-1) };
    else s.sea.ctrl = Int16Array.from(s.sea.ctrl);
    for (const nat of s.nations) {
      for (const k of ['navy', 'casualties', 'blockade']) if (!isInt(nat[k])) nat[k] = 0;
      if (!nat.suff || typeof nat.suff !== 'object') nat.suff = { ...ST.RES };
      if (!Array.isArray(nat.unlocked)) nat.unlocked = [];
    }
    ST.complete(s);
    return { ok: true, state: s };
  }

  return { write, read, FORMAT };
});
