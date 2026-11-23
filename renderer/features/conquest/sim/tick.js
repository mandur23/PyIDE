// tick.step(ctx, hours): the hour loop. Each hour runs SYSTEMS in order, each on hours where hour % every === at;
// a system gets (ctx, w, out), where w is the hour's world (the relation matrix, divisions indexed by the province
// they are in and the one they are entering, the battle in each province, who fought) and out collects what
// changed. The world rebuilds the relations, so a daily system that changed state.rel is seen from that hour on.
// After the systems, every AI layer of LAYERS whose schedule matches runs once per living nation in index order (the player's nation only for a layer with `player: true`); a layer acts only through orders.apply. With no
// layer a nation holds. Then the hour advances. step() answers what changed: provinces (ctrl), divs, battles, sea
// (state.sea.ctrl), and the systems' events.
//
// addSystem({ name, every, at, run }, { after }) and addLayer({ name, every, at, player, run(ctx, nation) }) are the
// seams for events.js, diplomacy.js and ai/: they register themselves when loaded, before the first step. Where each
// one runs is decided here, by ORDER, not by which file was loaded first, so Node (whatever it requires first) and
// the worker (sim/modules.json order) run the same hour. A system or layer ORDER does not name goes after `after`
// (a system) or last, in the order added.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).tick = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const W = NODE ? require('./weather.js') : globalThis.Conquest.weather;
  const S = NODE ? require('./supply.js') : globalThis.Conquest.supply;
  const MV = NODE ? require('./movement.js') : globalThis.Conquest.movement;
  const C = NODE ? require('./combat.js') : globalThis.Conquest.combat;
  const I = NODE ? require('./industry.js') : globalThis.Conquest.industry;
  const N = NODE ? require('./naval.js') : globalThis.Conquest.naval;

  function world(ctx) {
    const { state } = ctx;
    const n = ctx.map.provinces.length;
    const nd = state.divs.length;
    M.touchRelations(state);
    const w = {
      rel: M.relations(state),
      provHead: new Int32Array(n), provNext: new Int32Array(nd), toHead: new Int32Array(n), toNext: new Int32Array(nd),
      battleAt: new Int32Array(n), fought: new Uint8Array(nd),
      index() {
        w.provHead.fill(-1);
        w.toHead.fill(-1);
        for (let i = nd - 1; i >= 0; i--) {
          const d = state.divs[i];
          w.provNext[i] = w.provHead[d.prov];
          w.provHead[d.prov] = i;
          if (d.to !== null) { w.toNext[i] = w.toHead[d.to]; w.toHead[d.to] = i; }
        }
      },
    };
    w.index();
    state.battles.forEach((b, i) => { w.battleAt[b.prov] = i + 1; });
    return w;
  }

  function cleanup(ctx, w, out) {
    const { state } = ctx;
    if (!state.divs.some((d) => d.str <= 0)) return;
    const dead = new Set();
    state.divs = state.divs.filter((d) => { if (d.str > 0) return true; dead.add(d.id); return false; });
    for (const nat of state.nations) for (const a of nat.armies) a.divs = a.divs.filter((id) => !dead.has(id));
    out.divs = true;
  }

  const SYSTEMS = [
    { name: 'weather', every: 24, at: 0, run: (ctx) => W.daily(ctx) },
    { name: 'sea', every: 24, at: 0, run: (ctx, w, out) => N.daily(ctx, out) },
    { name: 'supply', every: 24, at: 0, run: (ctx) => S.recompute(ctx) },
    { name: 'industry', every: 24, at: 0, run: (ctx, w, out) => I.daily(ctx, w, out) },
    { name: 'world', every: 1, at: 0, run: null },
    { name: 'movement', every: 1, at: 0, run: (ctx, w, out) => MV.hour(ctx, w, out) },
    { name: 'combat', every: 1, at: 0, run: (ctx, w, out) => C.hour(ctx, w, out) },
    { name: 'upkeep', every: 1, at: 0, run: (ctx, w, out) => S.upkeep(ctx, w, out) },
    { name: 'entrench', every: 1, at: 0, run: (ctx, w) => MV.entrench(ctx, w) },
    { name: 'cleanup', every: 1, at: 0, run: cleanup },
  ];
  const LAYERS = [];
  const ORDER = {
    systems: ['weather', 'sea', 'supply', 'industry', 'diplomacy', 'events', 'world', 'movement', 'combat', 'upkeep', 'entrench', 'cleanup'],
    layers: ['nation', 'operations', 'general'],
  };
  const rank = (list, name) => { const i = list.indexOf(name); return i < 0 ? list.length : i; };

  function insert(list, names, item, after) {
    const old = list.indexOf(item);
    if (old >= 0) list.splice(old, 1);
    const r = rank(names, item.name);
    let i;
    if (r < names.length) i = list.findIndex((x) => rank(names, x.name) > r);
    else { const a = after ? list.findIndex((x) => x.name === after) : -1; i = a >= 0 ? a + 1 : -1; }
    if (i < 0) list.push(item);
    else list.splice(i, 0, item);
  }
  const addSystem = (sys, { after } = {}) => insert(SYSTEMS, ORDER.systems, sys, after);
  const addLayer = (layer) => insert(LAYERS, ORDER.layers, layer, null);

  function hour(ctx, out) {
    const { state } = ctx;
    let w = null;
    for (const s of SYSTEMS) {
      if (state.hour % s.every !== s.at) continue;
      if (s.run === null) { w = world(ctx); continue; }
      s.run(ctx, w, out);
    }
    M.touchBoard(state);
    for (const layer of LAYERS) {
      if (state.hour % layer.every !== (layer.at || 0)) continue;
      state.nations.forEach((nat, a) => { if (nat.alive && (a !== state.player || layer.player)) layer.run(ctx, a); });
    }
    state.hour += 1;
  }

  function step(ctx, hours = 1) {
    const out = { provinces: [], divs: false, battles: false, sea: false, events: [] };
    for (let h = 0; h < hours; h++) hour(ctx, out);
    out.provinces = [...new Set(out.provinces)].sort((a, b) => a - b);
    return out;
  }

  return { step, world, addSystem, addLayer, SYSTEMS, LAYERS, ORDER };
});
