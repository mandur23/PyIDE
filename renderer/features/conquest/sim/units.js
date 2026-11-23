// A division's numbers, derived from its template and the branch table of data/units.json (architecture section 6)
// and never stored. A line battalion counts 1000, a support company rules.template.support. Sums are fixed point:
// attack, breakthrough, defence, supply, siege, river and manpower are Σ count × branch value / 1000; org is the
// mean branch org of the line × 1000 (support does not dilute it); speed is the slowest branch; dig is the number
// of engineering units (any count > 0 adds rules.dig.engineers per hour).
//
// attackVs(rules, s, defCounts) is the attack a division brings against defenders of the given mean branch counts:
// for each own branch b, Σ count_b × attack_b × (1 - min(counterCap, Σ_d defCount_d × counters[d][b]) / 1000), plus
// breakthrough. counters[d][b] is the permille a defending battalion of branch d takes off branch b's attack. With
// shellF (default 1000) the attack of every branch that uses shells (branch.shells > 0) is multiplied by shellF.
// shells is Σ count × branch.shells / 1000, the shells a division fires per hour of attack (combat.js).
//
// lose(ctx, div, amount) is the one way strength leaves a division (battle, attrition, destruction, sinking): it
// removes min(amount, str) and adds trunc(template manpower × removed / 1000) men to nation.casualties.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).units = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;

  const tables = new WeakMap();
  function table(rules) {
    let t = tables.get(rules);
    if (t) return t;
    const B = rules.branches;
    const index = new Map(B.map((b, i) => [b.id, i]));
    const nb = B.length;
    const counter = new Int32Array(nb * nb);
    for (const [d, row] of Object.entries(rules.counters || {})) {
      for (const [b, v] of Object.entries(row)) if (index.has(d) && index.has(b)) counter[index.get(d) * nb + index.get(b)] = v | 0;
    }
    const items = rules.items.map((x) => x.id);
    t = { index, nb, counter, items, itemIndex: new Map(items.map((x, i) => [x, i])) };
    tables.set(rules, t);
    return t;
  }

  const cache = new WeakMap();
  function stats(rules, tpl) {
    let s = cache.get(tpl);
    if (s && s.rules === rules) return s;
    const T = table(rules);
    const B = rules.branches;
    const counts = new Int32Array(T.nb);
    for (const b of tpl.line) counts[T.index.get(b)] += 1000;
    for (const b of tpl.support || []) counts[T.index.get(b)] += rules.template.support;
    s = { rules, counts, shells: 0, attack: 0, breakthrough: 0, defence: 0, org: 0, speed: 0, supply: 0, siege: 0, river: 0, dig: 0, manpower: 0, equip: new Int32Array(T.items.length) };
    let speed = Infinity;
    for (let i = 0; i < T.nb; i++) {
      const c = counts[i];
      if (!c) continue;
      const b = B[i];
      s.attack += F.mul(c, b.attack);
      s.breakthrough += F.mul(c, b.breakthrough);
      s.defence += F.mul(c, b.defence);
      s.supply += F.mul(c, b.supply);
      s.siege += F.mul(c, b.siege);
      s.river += F.mul(c, b.river);
      s.dig += b.dig ? c : 0;
      s.manpower += F.mul(c, b.manpower);
      s.shells += F.mul(c, b.shells | 0);
      for (const [item, n] of Object.entries(b.equip || {})) s.equip[T.itemIndex.get(item)] += F.mul(c, n);
      if (b.speed < speed) speed = b.speed;
    }
    let org = 0;
    for (const b of tpl.line) org += B[T.index.get(b)].org;
    s.org = tpl.line.length ? Math.trunc((org * 1000) / tpl.line.length) : 1000;
    s.speed = speed === Infinity ? 1000 : speed;
    cache.set(tpl, s);
    return s;
  }

  function attackVs(rules, s, defCounts, shellF = 1000) {
    const T = table(rules);
    const B = rules.branches;
    const cap = rules.combat.counterCap;
    let a = 0;
    for (let b = 0; b < T.nb; b++) {
      if (!s.counts[b]) continue;
      let red = 0;
      for (let d = 0; d < T.nb; d++) if (defCounts[d]) red += F.mul(defCounts[d], T.counter[d * T.nb + b]);
      if (red > cap) red = cap;
      const x = F.mul(F.mul(s.counts[b], B[b].attack), 1000 - red);
      a += B[b].shells > 0 ? F.mul(x, shellF) : x;
    }
    return a + s.breakthrough;
  }

  const templateOf = (state, div) => state.nations[div.nation].templates.find((t) => t.id === div.tpl) || null;
  const statsOf = (ctx, div) => stats(ctx.rules, templateOf(ctx.state, div));

  function lose(ctx, div, amount) {
    const x = Math.min(div.str, amount);
    if (x <= 0) return 0;
    div.str -= x;
    ctx.state.nations[div.nation].casualties += F.mul(statsOf(ctx, div).manpower, x);
    return x;
  }

  return { table, stats, attackVs, templateOf, statsOf, lose };
});
