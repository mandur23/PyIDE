// The effect registry of effects.js as data (what crates/cut-model/src/effects compares), and LUTs lumetri.js stores.
const path = require('node:path');

const CUT = path.resolve(__dirname, '..', '..', '..', 'renderer', 'features', 'cut');
const E = require(path.join(CUT, 'effects.js'));
const L = require(path.join(CUT, 'lumetri.js'));

const PARAM_KEYS = ['id', 'name', 'type', 'min', 'max', 'step', 'default', 'keyframable', 'group', 'unit', 'choices'];
const strip = (d, transition) => ({
  id: d.type, name: d.name, category: d.category, kind: d.kind, transition, masks: d.masks !== false, extend: !!d.layer?.extend,
  params: d.params.map((p) => Object.fromEntries(PARAM_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]))),
});

module.exports = {
  effects: () => [...E.list().map((d) => strip(d, false)), ...E.transitions().map((d) => strip(d, true))],
  defaults: (type) => E.defaults(type),
  resolve: (type, params) => E.resolve(type, params),
  // A LUT of size n as store() keeps it: an identity cube, or one with every value scaled by k.
  lut: (n, k = 1, name = 'look') => {
    const lut = L.parseCube(L.identityCube(n));
    if (k !== 1) lut.data = lut.data.map((v) => v * k);
    return L.store(lut, name);
  },
};
