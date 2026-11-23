// Derived lookups the systems share and never store: per map (terrain and climate as indexes into the rules,
// adjacency, rivers, the km a division crosses in a province, sea zones, ports, straits, the path search buffers),
// per scenario (nation index by tag, capitals, hubs, cores, resources, general traits), the war, ally and access
// matrix of the current relations, division lookup by id, and the binary heap the path and supply searches use.
// Everything here is rebuilt from map, scenario, rules and state, so a cache can never make two runs differ.
//
// A port is a land province with `port: true` that touches a sea zone. A strait (map.straits) counts as a river for
// movement and combat: its pair is added to m.river. Its sea zones (m.straitZones) are the zones adjacent to both
// ends, or to either end when they share none. A nation's cores are scenario.cores[tag], or the provinces the
// scenario gives it when that is absent.
// relations(state) is cached per state and hour. writeRel(state, tagA, tagB, patch) is the one writer of state.rel:
// it creates the pair's record ({ war, ally, access, truce, since, broke, brokeBy }), merges the patch and drops the
// cache (touchRelations), so a change is seen at once, also inside an hour. ready(state, n) is a nation's readiness.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).mapdata = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;

  const maps = new WeakMap();
  function of(ctx) {
    const { map, rules } = ctx;
    let m = maps.get(map);
    if (m && m.rules === rules) return m;
    const P = map.provinces;
    const n = P.length;
    const tIndex = new Map(rules.terrain.map((t, i) => [t.id, i]));
    const cIndex = new Map(rules.climates.map((c, i) => [c.id, i]));
    const temperate = cIndex.get('temperate') || 0;
    m = {
      rules, n, sea: new Uint8Array(n), port: new Uint8Array(n), terrain: new Uint8Array(n), climate: new Uint8Array(n), km: new Int32Array(n),
      adj: [[]], river: [[]], seaAdj: [[]], zones: [], ports: [], straitZones: new Map(),
      search: { cost: new Int32Array(n), prev: new Int32Array(n), seen: new Int32Array(n), gen: 0, heap: heap() },
    };
    for (let i = 1; i < n; i++) {
      const p = P[i];
      m.sea[i] = p.sea ? 1 : 0;
      m.terrain[i] = tIndex.get(p.terrain) || 0;
      m.climate[i] = cIndex.has(p.climate) ? cIndex.get(p.climate) : temperate;
      m.km[i] = Math.max(10, F.isqrt(p.area | 0));
      m.adj.push(p.adj || []);
      m.river.push((p.river || []).slice());
    }
    for (let i = 1; i < n; i++) {
      m.seaAdj.push(m.sea[i] ? [] : m.adj[i].filter((q) => m.sea[q]));
      if (m.sea[i]) m.zones.push(i);
      else if (P[i].port && m.seaAdj[i].length) { m.port[i] = 1; m.ports.push(i); }
    }
    for (const [a, b] of map.straits || []) {
      if (!(a > 0 && a < n && b > 0 && b < n)) continue;
      if (!m.river[a].includes(b)) m.river[a].push(b);
      if (!m.river[b].includes(a)) m.river[b].push(a);
      let z = m.seaAdj[a].filter((q) => m.seaAdj[b].includes(q));
      if (!z.length) z = [...new Set(m.seaAdj[a].concat(m.seaAdj[b]))].sort((x, y) => x - y);
      m.straitZones.set(a * n + b, z);
      m.straitZones.set(b * n + a, z);
    }
    maps.set(map, m);
    return m;
  }

  const RES = ['coal', 'iron', 'oil'];
  const scenarios = new WeakMap();
  function facts(ctx) {
    const { map, scenario } = ctx;
    let f = scenarios.get(scenario);
    if (f && f.map === map) return f;
    const n = map.provinces.length;
    const index = new Map(scenario.nations.map((s, i) => [s.tag, i]));
    const hub = new Uint8Array(n);
    const res = Object.fromEntries(RES.map((r) => [r, new Uint8Array(n)]));
    for (const [id, p] of Object.entries(scenario.provinces || {})) {
      if (!(+id < n)) continue;
      if (p.hub) hub[+id] = 1;
      for (const r of RES) if (p[r]) res[r][+id] = p[r];
    }
    const cores = scenario.cores || {};
    const core = scenario.nations.map((s) => {
      const c = new Uint8Array(n);
      for (const p of cores[s.tag] || (scenario.owner || {})[s.tag] || []) if (p > 0 && p < n) c[p] = 1;
      return c;
    });
    f = {
      map, index, hub, res, core,
      capital: scenario.nations.map((s) => s.capital | 0),
      traits: scenario.nations.map((s) => new Map((s.generals || []).map((g) => [g.name, g.trait]))),
    };
    scenarios.set(scenario, f);
    return f;
  }

  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // The matrix only sets bits, so walking state.rel's keys cannot change it.
  const relCache = new WeakMap();
  function relations(state) {
    const c = relCache.get(state);
    if (c && c.hour === state.hour && c.k === state.nations.length) return c;
    const k = state.nations.length;
    const war = new Uint8Array(k * k);
    const ally = new Uint8Array(k * k);
    const access = new Uint8Array(k * k);
    const belligerent = new Uint8Array(k);
    const tags = new Map(state.nations.map((x, i) => [x.tag, i]));
    for (let a = 0; a < k; a++) { ally[a * k + a] = 1; access[a * k + a] = 1; }
    for (const pair in state.rel) {
      const r = state.rel[pair];
      const bar = pair.indexOf('|');
      const a = tags.get(pair.slice(0, bar));
      const b = tags.get(pair.slice(bar + 1));
      if (!r || a === undefined || b === undefined || a === b) continue;
      if (r.war) { war[a * k + b] = war[b * k + a] = 1; belligerent[a] = belligerent[b] = 1; }
      if (r.ally) ally[a * k + b] = ally[b * k + a] = 1;
      if (r.access || r.ally) access[a * k + b] = access[b * k + a] = 1;
    }
    const rel = { hour: state.hour, k, war, ally, access, belligerent };
    relCache.set(state, rel);
    return rel;
  }
  const touchRelations = (state) => { relCache.delete(state); };
  function writeRel(state, a, b, patch) {
    const k = key(a, b);
    const r = state.rel[k] || (state.rel[k] = { war: false, ally: false, access: false, truce: 0, since: 0, broke: -1, brokeBy: -1 });
    if (r.since === undefined) r.since = 0;
    if (r.broke === undefined) { r.broke = -1; r.brokeBy = -1; }
    Object.assign(r, patch);
    touchRelations(state);
    return r;
  }
  const hostile = (rel, a, b) => a >= 0 && b >= 0 && rel.war[a * rel.k + b] === 1;
  const camp = (rel, a, b) => a >= 0 && b >= 0 && rel.ally[a * rel.k + b] === 1;

  function divById(state, id) {
    const d = state.divs;
    let lo = 0;
    let hi = d.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (d[mid].id === id) return d[mid];
      if (d[mid].id < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  const armyOf = (state, div) => (div.army === null ? null : state.nations[div.nation].armies.find((a) => a.id === div.army) || null);

  function trait(ctx, div) {
    const army = armyOf(ctx.state, div);
    return army && army.general ? facts(ctx).traits[div.nation].get(army.general) || null : null;
  }

  function log(ctx, entry) {
    const { state, rules } = ctx;
    state.log.push({ hour: state.hour, ...entry });
    if (state.log.length > rules.logCap) state.log.splice(0, state.log.length - rules.logCap);
  }

  // Min-heap on (key, id): equal keys pop in id order, so searches are deterministic.
  function heap() {
    const keys = [];
    const ids = [];
    const less = (i, j) => keys[i] < keys[j] || (keys[i] === keys[j] && ids[i] < ids[j]);
    const swap = (i, j) => {
      const k = keys[i]; keys[i] = keys[j]; keys[j] = k;
      const d = ids[i]; ids[i] = ids[j]; ids[j] = d;
    };
    return {
      key: 0,
      get size() { return keys.length; },
      clear() { keys.length = 0; ids.length = 0; },
      push(k, id) {
        keys.push(k); ids.push(id);
        let i = keys.length - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (!less(i, p)) break; swap(i, p); i = p; }
      },
      pop() {
        const id = ids[0];
        this.key = keys[0];
        const last = keys.length - 1;
        swap(0, last); keys.pop(); ids.pop();
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < keys.length && less(l, m)) m = l;
          if (r < keys.length && less(r, m)) m = r;
          if (m === i) break;
          swap(i, m); i = m;
        }
        return id;
      },
    };
  }

  // A nation's readiness (diplomacy.js, mobilisation): the share of its war establishment its divisions fight with,
  // 1000 for a state saved before readiness existed.
  const ready = (state, n) => { const r = state.nations[n].ready; return r === undefined ? 1000 : r; };

  // A count tick.js raises before each hour's AI layers. A cache of where the divisions stand (ai/mil-common.js's view)
  // holds only while it is unchanged: a query asked between hours builds the view before that hour's movement, and the
  // layers must not reuse it, or what the player asks would change how the game goes. Outside the state, like the caches.
  const boards = new WeakMap();
  const board = (state) => boards.get(state) || 0;
  const touchBoard = (state) => { boards.set(state, board(state) + 1); };

  return { of, facts, key, relations, touchRelations, writeRel, hostile, camp, divById, armyOf, trait, heap, log, ready, board, touchBoard, RES };
});
