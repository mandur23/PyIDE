// Supply (plan 3.6). recompute() runs on rules.supply.every hours, not every hour: for each nation, supply flows from
// its capital (rules.supply.capital) and the hub provinces it controls (rules.supply.hub) into the land it and its
// allies control, losing hop[infra] / weather.supply at each province entered (a max-first search, so a province
// gets the best of its sources). Overseas: from a port of its camp it flows into the sea zones not denied to the
// nation (naval.js), losing rules.naval.seaHop per zone, and from a zone into a port of its camp, arriving with at
// most rules.naval.portCap; so an island or a colony is supplied while a lane of open zones joins its port to a
// supplied one, and cut off when the lane is denied. state.prov.supply[p] is what reached p's controller there (land
// only); 0 is cut off. A division's `sup` (0..1000) is that capacity over the summed supply use of every division
// in the province (logistics generals use 0.8 of theirs), capped at 1000, and 0 when its province is not held by
// its camp. A division at sea keeps the sup it had.
//
// upkeep() runs every hour after combat: a division that did not fight regains org (regen × sup) while sup is at
// least rules.supply.low and loses it (drain × the missing share) below; a cut-off one also loses 1 strength every
// attritionEvery hours. In battle, factor(sup) scales attack and defence from outOfSupply at 0 to 1.0 at 1000.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).supply = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;
  const N = NODE ? require('./naval.js') : globalThis.Conquest.naval;

  const factor = (rules, sup) => rules.supply.outOfSupply + F.mul(1000 - rules.supply.outOfSupply, sup);

  function use(ctx, div) {
    const s = U.statsOf(ctx, div).supply;
    const t = M.trait(ctx, div);
    return t && ctx.rules.generals[t].supply ? F.mul(s, ctx.rules.generals[t].supply) : s;
  }

  function recompute(ctx) {
    const { state, rules } = ctx;
    const S = rules.supply;
    const m = M.of(ctx);
    const f = M.facts(ctx);
    const rel = M.relations(state);
    const P = state.prov;
    const n = m.n;
    const k = state.nations.length;
    const loss = new Int32Array(n);
    for (let p = 1; p < n; p++) {
      if (m.sea[p]) { loss[p] = rules.naval.seaHop; continue; }
      const hop = S.hop[Math.min(P.infra[p], S.hop.length - 1)];
      loss[p] = Math.trunc((hop * 1000) / rules.weather[P.weather[p]].supply);
    }
    P.supply.fill(0);
    const val = new Int32Array(n);
    for (let a = 0; a < k; a++) {
      val.fill(-1);
      const h = M.heap();
      for (let p = 1; p < n; p++) {
        if (P.ctrl[p] !== a) continue;
        const v = p === f.capital[a] ? S.capital : f.hub[p] ? S.hub : -1;
        if (v > val[p]) { val[p] = v; h.push(-v, p); }
      }
      while (h.size) {
        const p = h.pop();
        if (-h.key !== val[p]) continue;
        const fromSea = m.sea[p] === 1;
        for (const q of m.adj[p]) {
          let v = val[p] - loss[q];
          if (m.sea[q]) {
            if (!(fromSea || m.port[p]) || N.denied(state, rel, a, q)) continue;
          } else {
            if (!M.camp(rel, a, P.ctrl[q])) continue;
            if (fromSea) { if (!m.port[q]) continue; v = Math.min(v, rules.naval.portCap); }
          }
          if (v > val[q]) { val[q] = v; h.push(-v, q); }
        }
      }
      for (let p = 1; p < n; p++) if (P.ctrl[p] === a && val[p] > 0) P.supply[p] = Math.min(32767, val[p]);
    }
    const demand = new Int32Array(n);
    const uses = new Int32Array(state.divs.length);
    state.divs.forEach((d, i) => { uses[i] = use(ctx, d); demand[d.prov] += uses[i]; });
    state.divs.forEach((d) => {
      if (m.sea[d.prov]) return;
      const ok = M.camp(rel, d.nation, P.ctrl[d.prov]) && P.supply[d.prov] > 0;
      d.sup = !ok ? 0 : demand[d.prov] <= 0 ? 1000 : Math.min(1000, Math.trunc((P.supply[d.prov] * 1000) / demand[d.prov]));
    });
  }

  function upkeep(ctx, w, out) {
    const { state, rules } = ctx;
    const S = rules.supply;
    const divs = state.divs;
    for (let i = 0; i < divs.length; i++) {
      const d = divs[i];
      if (d.str <= 0 || w.fought[i]) continue;
      const before = d.org;
      if (d.sup >= S.low) d.org = Math.min(1000, d.org + F.mul(S.regen, d.sup));
      else d.org = Math.max(0, d.org - F.mul(S.drain, 1000 - d.sup));
      if (d.sup === 0 && state.hour % S.attritionEvery === 0) U.lose(ctx, d, 1);
      if (d.org !== before || d.sup === 0) out.divs = true;
    }
  }

  return { recompute, upkeep, factor, use };
});
