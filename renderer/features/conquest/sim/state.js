// create(map, scenario, rules, { seed, player }): the state at hour 0 (architecture section 5) from a map and a
// scenario. Nations are indexed in scenario order; provinces by id, with -1 for nobody (sea). Each scenario army
// becomes an army of `divisions` divisions of its template, dealt round-robin over its `at` provinces. Weather and
// sea control, supply are computed once so the first snapshot already has them. PROV lists the typed per-province
// arrays in the order save.js and hash.js see them; state.sea.ctrl (naval.js) is the one typed array outside prov.
// A nation's navy is scenario nation.navy (default rules.naval.defaultMajor / defaultMinor) and its stock
// scenario nation.stock (default rules.start.stock), item by item; its readiness `ready` is scenario nation.mob.peace
// (1000 without `mob`; diplomacy.js raises it as the nation mobilises). complete(state) adds the tables of diplomacy.js
// and events.js (offers, diplo, settings, firedAt, nation.dip and nation.ai) where they are missing; create() calls
// it, so every field exists from hour 0, and save.read() calls it for a save written before they existed.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).state = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const R = NODE ? require('./rng.js') : globalThis.Conquest.rng;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const W = NODE ? require('./weather.js') : globalThis.Conquest.weather;
  const S = NODE ? require('./supply.js') : globalThis.Conquest.supply;
  const I = NODE ? require('./industry.js') : globalThis.Conquest.industry;
  const N = NODE ? require('./naval.js') : globalThis.Conquest.naval;

  const VERSION = 1;
  const PROV = { owner: Int16Array, ctrl: Int16Array, mil: Uint8Array, civ: Uint8Array, infra: Uint8Array, supply: Int16Array, weather: Uint8Array, works: Int16Array };
  const parseDate = W.parse;
  const RES = { coal: 1000, iron: 1000, oil: 1000 };

  function complete(state) {
    if (!state.offers) state.offers = [];
    if (!state.diplo) state.diplo = { nextOffer: 1, lastWar: -1, warSeen: false, outcome: null };
    if (!state.settings) state.settings = { difficulty: 'normal', aiBonus: false };
    if (!state.firedAt) state.firedAt = state.fired.map(() => 0);
    const k = state.nations.length;
    for (const nat of state.nations) {
      if (!nat.dip) nat.dip = { weak: 0, collapsed: 0, mobTarget: 0, fcarry: 0, dcarry: 0, cas: -1, men: -1, cores: new Array(k).fill(0), land: new Array(k).fill(0) };
      if (!nat.ai) nat.ai = {};
    }
    return state;
  }

  function create(map, scenario, rules, opts = {}) {
    const n = map.provinces.length;
    const date = parseDate(scenario.start);
    const index = new Map(scenario.nations.map((s, i) => [s.tag, i]));
    const prov = {};
    for (const [k, T] of Object.entries(PROV)) prov[k] = new T(n);
    prov.owner.fill(-1);
    for (let p = 1; p < n; p++) prov.infra[p] = map.provinces[p].sea ? 0 : 2;
    for (const s of scenario.nations) for (const p of scenario.owner[s.tag] || []) prov.owner[p] = index.get(s.tag);
    prov.ctrl.set(prov.owner);
    for (const [id, p] of Object.entries(scenario.provinces || {})) {
      if (p.mil !== undefined) prov.mil[+id] = p.mil;
      if (p.civ !== undefined) prov.civ[+id] = p.civ;
      if (p.infra !== undefined) prov.infra[+id] = p.infra;
    }
    const stock = (s) => Object.fromEntries(rules.items.map((x) => [x.id, ((s.stock && s.stock[x.id] !== undefined ? s.stock : rules.start.stock) || {})[x.id] | 0]));
    const state = {
      v: VERSION, seed: opts.seed | 0, rng: R.seed(opts.seed | 0), hour: 0, player: opts.player | 0, doy0: date.doy, year0: date.year,
      next: { div: 1, army: 1, battle: 1, plan: 1, batch: 1 },
      prov,
      nations: scenario.nations.map((s) => ({
        tag: s.tag, alive: true, bloc: s.bloc || null, manpower: s.manpower | 0, fatigue: 0, mobilisation: 0, ready: s.mob ? Math.max(0, Math.min(1000, s.mob.peace | 0)) : 1000, stock: stock(s),
        navy: N.navyOf(rules, s), casualties: 0, blockade: 0, suff: { ...RES }, unlocked: [],
        lines: (s.lines || []).map((l) => ({ item: l.item, factories: l.factories | 0, eff: rules.industry.effStart, prog: 0 })),
        templates: (s.templates || []).map((t) => ({ id: t.id, name: t.name, line: t.line.slice(), support: (t.support || []).slice() })),
        armies: [], training: [], builds: [], ai: {},
      })),
      sea: { ctrl: new Int16Array(n).fill(-1) },
      divs: [], battles: [], rel: {}, memory: scenario.nations.map(() => []), fired: [], log: [],
    };
    for (const a of scenario.armies || []) {
      const nation = index.get(a.nation);
      const nat = state.nations[nation];
      const army = { id: state.next.army++, name: a.name, general: a.general || null, divs: [], front: null, offensives: [] };
      nat.armies.push(army);
      for (let i = 0; i < (a.divisions | 0); i++) {
        const d = I.newDivision(state, nation, a.template, a.at[i % a.at.length]);
        d.army = army.id;
        army.divs.push(d.id);
      }
    }
    for (const [a, b] of scenario.alliances || []) M.writeRel(state, a, b, { ally: true, access: true });
    for (const [a, b] of scenario.wars || []) M.writeRel(state, a, b, { war: true });
    complete(state);
    const ctx = { map, scenario, rules, state };
    W.daily(ctx);
    N.daily(ctx, null);
    S.recompute(ctx);
    return state;
  }

  return { create, complete, VERSION, PROV, parseDate, RES };
});
