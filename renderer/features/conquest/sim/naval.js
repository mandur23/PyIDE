// Sea control and blockade (plan 3.2, 3.6), once a day after the weather, and the sea questions the other systems
// ask. There are no fleets on the map: each nation has `navy`, a whole number of strength (scenario nation.navy, or
// rules.naval.defaultMajor / defaultMinor).
//
// Projection: a nation at war with someone projects navy × falloff[d] / 1000 into a sea zone, d being the zone hops
// from the nearest zone adjacent to a port it controls (falloff = rules.naval.falloff, nothing beyond its end). A
// nation at war with nobody projects nothing. A nation's side in a zone is the sum over its friends: itself, its
// allies, and nations of its bloc it is not at war with. The zone's controller is the nation whose side is
// strongest (ties: its own projection, then the lower index) when side × 1000 ≥ enemies × rules.naval.margin, the
// enemies being the summed projection of the nations at war with it; below that the zone is contested (-2); with no
// projection it is -1. state.sea.ctrl[zone] holds it (land provinces stay -1).
//
// landing(ctx, rel, nation, zone): a division may land from the zone on land an enemy holds only when its camp
// controls the zone and its side projects there at least naval.landMargin times what the nations at war with it
// project (movement.js canStep), so a fleet in being keeps landings off its coast.
//
// denied(state, rel, nation, zone): the zone's controller is at war with the nation. Only that closes a zone; a
// contested or uncontrolled zone is open to everybody. A strait is closed to a nation while any of its zones
// (mapdata straitZones) is denied to it.
//
// After the control update a division in a sea zone denied to it is lost (log 'sunk'; its men count as casualties).
//
// Blockade: a nation's lanes are the ports it controls among its cores (its homeland; colonial ports do not feed
// its industry), or every port it controls when it controls none of those. A lane is open when one of the port's zones is not denied to
// the nation and reaches, through zones not denied to it, a zone of a port controlled by another living nation it
// is not at war with. nation.blockade = 1000 - open × 1000 / lanes, truncated; 0 for a nation at peace or without a
// port. industry.js turns it into imports.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).naval = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;

  const NONE = -1;
  const CONTESTED = -2;

  const graphs = new WeakMap();
  function graph(ctx) {
    const m = M.of(ctx);
    let g = graphs.get(m);
    if (g) return g;
    const zi = new Int32Array(m.n).fill(-1);
    m.zones.forEach((z, i) => { zi[z] = i; });
    const nb = m.zones.map((z) => m.adj[z].filter((q) => m.sea[q]).map((q) => zi[q]));
    const portZones = new Map(m.ports.map((p) => [p, m.seaAdj[p].map((z) => zi[z])]));
    g = { zi, nb, portZones, nz: m.zones.length };
    graphs.set(m, g);
    return g;
  }

  const navyOf = (rules, s) => (Number.isInteger(s.navy) ? s.navy : s.major ? rules.naval.defaultMajor : rules.naval.defaultMinor);

  function denied(state, rel, nation, z) {
    const c = state.sea.ctrl[z];
    return c >= 0 && rel.war[nation * rel.k + c] === 1;
  }

  function straitOpen(ctx, rel, nation, a, b) {
    const m = M.of(ctx);
    const zones = m.straitZones.get(a * m.n + b);
    if (!zones) return true;
    for (const z of zones) if (denied(ctx.state, rel, nation, z)) return false;
    return true;
  }

  function friend(rel, nations, a, b) {
    if (a === b || rel.ally[a * rel.k + b] === 1) return true;
    return nations[a].bloc !== null && nations[a].bloc === nations[b].bloc && rel.war[a * rel.k + b] !== 1;
  }

  // What each belligerent with a navy projects into every zone (B: their indexes; proj[i × nz + zone index]).
  function project(ctx, rel, g) {
    const { state, rules } = ctx;
    const NV = rules.naval;
    const m = M.of(ctx);
    const nations = state.nations;
    const ctrl = state.prov.ctrl;
    const B = [];
    for (let a = 0; a < nations.length; a++) if (nations[a].alive && rel.belligerent[a] && nations[a].navy > 0) B.push(a);
    const nz = g.nz;
    const proj = new Int32Array(B.length * nz);
    const dist = new Int32Array(nz);
    const queue = [];
    B.forEach((a, bi) => {
      dist.fill(-1);
      queue.length = 0;
      for (const p of m.ports) if (ctrl[p] === a) for (const z of g.portZones.get(p)) if (dist[z] < 0) { dist[z] = 0; queue.push(z); }
      for (let i = 0; i < queue.length; i++) {
        const z = queue[i];
        proj[bi * nz + z] = F.mul(nations[a].navy, NV.falloff[dist[z]]);
        if (dist[z] + 1 >= NV.falloff.length) continue;
        for (const q of g.nb[z]) if (dist[q] < 0) { dist[q] = dist[z] + 1; queue.push(q); }
      }
    });
    return { B, proj };
  }

  function control(ctx, rel, g) {
    const { state, rules } = ctx;
    const NV = rules.naval;
    const m = M.of(ctx);
    const nations = state.nations;
    const nz = g.nz;
    const { B, proj } = project(ctx, rel, g);
    const sea = state.sea.ctrl;
    let changed = false;
    for (let zi = 0; zi < nz; zi++) {
      let best = -1;
      let bestSide = 0;
      let bestOwn = 0;
      for (let i = 0; i < B.length; i++) {
        const own = proj[i * nz + zi];
        if (own <= 0) continue;
        let side = 0;
        for (let j = 0; j < B.length; j++) if (friend(rel, nations, B[i], B[j])) side += proj[j * nz + zi];
        if (side > bestSide || (side === bestSide && own > bestOwn)) { best = i; bestSide = side; bestOwn = own; }
      }
      let c = NONE;
      if (best >= 0) {
        let enemies = 0;
        for (let j = 0; j < B.length; j++) if (rel.war[B[best] * rel.k + B[j]] === 1) enemies += proj[j * nz + zi];
        c = bestSide * 1000 >= enemies * NV.margin ? B[best] : CONTESTED;
      }
      const z = m.zones[zi];
      if (sea[z] !== c) { sea[z] = c; changed = true; }
    }
    return changed;
  }

  function blockade(ctx, rel, g, a) {
    const { state } = ctx;
    const m = M.of(ctx);
    const ctrl = state.prov.ctrl;
    if (!rel.belligerent[a]) return 0;
    const core = M.facts(ctx).core[a];
    let home = false;
    for (const p of m.ports) if (ctrl[p] === a && core[p]) { home = true; break; }
    const lane = (p) => ctrl[p] === a && (!home || core[p] === 1);
    let lanes = 0;
    for (const p of m.ports) if (lane(p)) lanes++;
    if (!lanes) return 0;
    const nz = g.nz;
    const comp = new Int32Array(nz).fill(-1);
    const open = (zi) => !denied(state, rel, a, m.zones[zi]);
    const queue = [];
    let nc = 0;
    for (let s = 0; s < nz; s++) {
      if (comp[s] >= 0 || !open(s)) continue;
      comp[s] = nc;
      queue.length = 0;
      queue.push(s);
      for (let i = 0; i < queue.length; i++) for (const q of g.nb[queue[i]]) if (comp[q] < 0 && open(q)) { comp[q] = nc; queue.push(q); }
      nc++;
    }
    const trade = new Uint8Array(nc);
    for (const p of m.ports) {
      const c = ctrl[p];
      if (c < 0 || c === a || !state.nations[c].alive || rel.war[a * rel.k + c] === 1) continue;
      for (const zi of g.portZones.get(p)) if (comp[zi] >= 0) trade[comp[zi]] = 1;
    }
    let ok = 0;
    for (const p of m.ports) {
      if (!lane(p)) continue;
      if (g.portZones.get(p).some((zi) => comp[zi] >= 0 && trade[comp[zi]])) ok++;
    }
    return 1000 - Math.trunc((ok * 1000) / lanes);
  }

  function daily(ctx, out) {
    const { state } = ctx;
    const m = M.of(ctx);
    const g = graph(ctx);
    const rel = M.relations(state);
    if (control(ctx, rel, g) && out) out.sea = true;
    for (const d of state.divs) {
      if (d.str <= 0 || !m.sea[d.prov] || !denied(state, rel, d.nation, d.prov)) continue;
      U.lose(ctx, d, d.str);
      M.log(ctx, { kind: 'sunk', div: d.id, prov: d.prov });
      if (out) out.divs = true;
    }
    state.nations.forEach((nat, a) => { nat.blockade = nat.alive ? blockade(ctx, rel, g, a) : 0; });
  }

  // Whether a nation may land from zone z on land an enemy holds: its camp controls z and its side (itself, allies, bloc
  // friends) projects there at least naval.landMargin times what the nations at war with it project, so a fleet in
  // being keeps the enemy off its coast. Projections are kept per state and hour (derived, not state).
  const kept = new WeakMap();
  function landing(ctx, rel, nation, z) {
    const { state } = ctx;
    const c = state.sea.ctrl[z];
    if (c < 0 || !M.camp(rel, nation, c)) return false;
    const g = graph(ctx);
    let k = kept.get(state);
    if (!k || k.hour !== state.hour || k.rel !== rel) { k = { hour: state.hour, rel, ...project(ctx, rel, g) }; kept.set(state, k); }
    const zi = g.zi[z];
    let side = 0;
    let enemies = 0;
    for (let i = 0; i < k.B.length; i++) {
      const b = k.B[i];
      const x = k.proj[i * g.nz + zi];
      if (friend(rel, state.nations, nation, b)) side += x;
      else if (rel.war[nation * rel.k + b] === 1) enemies += x;
    }
    return side * 1000 >= enemies * ctx.rules.naval.landMargin;
  }

  return { daily, denied, straitOpen, navyOf, landing, NONE, CONTESTED };
});
