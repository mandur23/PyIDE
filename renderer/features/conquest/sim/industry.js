// Industry (plan 3.7), once a day, per living nation in index order: unlocks, production, construction, training,
// reinforcement, recruits.
//
// Holdings: a controlled province that is one of the nation's cores (mapdata cores) yields its full mil and civ
// factories and rules.recruit.perProvince men a day; any other controlled province yields occupied.factories and
// occupied.manpower permille of them. output(ctx, nation, kind) is the effective whole number of mil or civ
// factories, trunc(Σ level × yield / 1000); factories(state, nation, kind) stays the raw sum of levels.
// Resources: domestic r = Σ controlled provinces' scenario level of r × resources.perLevel (coal, iron, oil, full
// yield). A line's factories need items[].needs[r] of r each a day; demand r = Σ over lines of the factories running
// × need. Imports cover the shortfall in proportion to open sea lanes: import r = trunc(max(0, demand - domestic) ×
// (1000 - nation.blockade) / 1000) (naval.js). nation.suff[r] = min(1000, (domestic + import) × 1000 / demand),
// 1000 with no demand.
// Production: the lines run in order, each on at most what is left of the military factories, adding
// trunc(factories × eff × industry.perFactory / 1000) × R / 1000 points to `prog`, R being the lowest suff of the
// resources its item needs (1000 when none), and turning every items[].cost points into one unit of stock. eff
// grows by industry.effGrowth a day up to 1000; factories added to a line start at industry.effStart.
// Construction: the civilian factories it has give build.perCiv points a day to the first queued build; a finished
// build adds one level of mil, civ or infra to its province (lost if the province changed hands).
// Training: a batch (orders.js 'train', paid when ordered) becomes divisions on its `done` hour at its province, or
// at the capital when that province is no longer the nation's, and is dropped when the nation holds neither.
// Reinforcement: a division on land under 1000 strength with sup ≥ reinforce.minSupply and not in a battle regains
// up to reinforce.perDay, paying the template's manpower and equipment pro rata, as far as the stock allows.
// Unlocks: rules.unlocks [{ branch, from: 'YYYY-MM-DD', mil }] adds the branch to nation.unlocked (log 'unlocked') on
// the first daily run on or after `from` when output(mil) ≥ mil. A branch with `locked: true` is usable in a
// template only once unlocked, and an item with `unlock: branch` producible only then (orders.js).
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).industry = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;
  const W = NODE ? require('./weather.js') : globalThis.Conquest.weather;

  function factories(state, nation, kind) {
    const ctrl = state.prov.ctrl;
    const f = state.prov[kind];
    let total = 0;
    for (let p = 1; p < ctrl.length; p++) if (ctrl[p] === nation) total += f[p];
    return total;
  }

  function output(ctx, nation, kind) {
    const { state, rules } = ctx;
    const ctrl = state.prov.ctrl;
    const f = state.prov[kind];
    const core = M.facts(ctx).core[nation];
    const occ = rules.occupied.factories;
    let total = 0;
    for (let p = 1; p < ctrl.length; p++) if (ctrl[p] === nation && f[p]) total += f[p] * (core[p] ? 1000 : occ);
    return Math.trunc(total / 1000);
  }

  function tally(ctx) {
    const { state, rules } = ctx;
    const k = state.nations.length;
    const fa = M.facts(ctx);
    const P = state.prov;
    const t = { mil: new Float64Array(k), civ: new Float64Array(k), men: new Float64Array(k), res: {} };
    for (const r of M.RES) t.res[r] = new Float64Array(k);
    const occF = rules.occupied.factories;
    const occM = rules.occupied.manpower;
    const per = rules.recruit.perProvince;
    for (let p = 1; p < P.ctrl.length; p++) {
      const a = P.ctrl[p];
      if (a < 0) continue;
      const core = fa.core[a][p] === 1;
      t.mil[a] += P.mil[p] * (core ? 1000 : occF);
      t.civ[a] += P.civ[p] * (core ? 1000 : occF);
      t.men[a] += per * (core ? 1000 : occM);
      for (const r of M.RES) t.res[r][a] += fa.res[r][p];
    }
    return t;
  }

  function newDivision(state, nation, tpl, prov) {
    const d = { id: state.next.div++, nation, tpl, army: null, prov, str: 1000, org: 1000, dig: 0, to: null, eta: 0, path: [], manual: false, sup: 1000 };
    state.divs.push(d);
    return d;
  }

  function unlock(ctx, a, nat, t) {
    const { state, rules } = ctx;
    const today = W.date(state);
    for (const u of rules.unlocks || []) {
      if (nat.unlocked.includes(u.branch)) continue;
      const from = W.parse(u.from);
      if (today.year < from.year || (today.year === from.year && today.doy < from.doy)) continue;
      if (Math.trunc(t.mil[a] / 1000) < (u.mil | 0)) continue;
      nat.unlocked.push(u.branch);
      M.log(ctx, { kind: 'unlocked', nation: a, branch: u.branch });
    }
  }

  function produce(ctx, a, nat, t) {
    const { rules } = ctx;
    const I = rules.industry;
    let left = Math.trunc(t.mil[a] / 1000);
    const items = nat.lines.map((l) => rules.items.find((x) => x.id === l.item));
    const used = nat.lines.map((l) => { const u = Math.min(l.factories, left); left -= u; return u; });
    const suff = {};
    for (const r of M.RES) {
      let demand = 0;
      nat.lines.forEach((l, i) => { demand += used[i] * ((items[i].needs || {})[r] | 0); });
      const domestic = t.res[r][a] * rules.resources.perLevel;
      const imports = Math.trunc((Math.max(0, demand - domestic) * (1000 - nat.blockade)) / 1000);
      suff[r] = demand <= 0 ? 1000 : Math.min(1000, Math.trunc(((domestic + imports) * 1000) / demand));
    }
    nat.suff = suff;
    nat.lines.forEach((line, i) => {
      let R = 1000;
      for (const r of Object.keys(items[i].needs || {})) if (items[i].needs[r] > 0 && suff[r] < R) R = suff[r];
      line.prog += F.mul(Math.trunc((used[i] * line.eff * I.perFactory) / 1000), R);
      const units = Math.floor(line.prog / items[i].cost);
      line.prog -= units * items[i].cost;
      nat.stock[line.item] += units;
      if (used[i] > 0) line.eff = Math.min(1000, line.eff + I.effGrowth);
    });
  }

  function construct(ctx, a, nat, t) {
    const { rules, state } = ctx;
    let points = Math.trunc(t.civ[a] / 1000) * rules.build.perCiv;
    while (points > 0 && nat.builds.length) {
      const b = nat.builds[0];
      const cost = rules.build.cost[b.what];
      const add = Math.min(points, cost - b.prog);
      b.prog += add;
      points -= add;
      if (b.prog < cost) break;
      nat.builds.shift();
      if (state.prov.ctrl[b.prov] === a && state.prov.owner[b.prov] === a) state.prov[b.what][b.prov] = Math.min(rules.build.max[b.what], state.prov[b.what][b.prov] + 1);
    }
  }

  function train(ctx, a, nat, out) {
    const { state } = ctx;
    const capital = M.facts(ctx).capital[a];
    const keep = [];
    for (const t of nat.training) {
      if (t.done > state.hour) { keep.push(t); continue; }
      const at = state.prov.ctrl[t.at] === a ? t.at : state.prov.ctrl[capital] === a ? capital : -1;
      if (at < 0) continue;
      for (let i = 0; i < t.count; i++) newDivision(state, a, t.tpl, at);
      out.divs = true;
    }
    nat.training = keep;
  }

  function reinforce(ctx, a, nat, out) {
    const { rules, state } = ctx;
    const items = U.table(rules).items;
    const m = M.of(ctx);
    const busy = new Set(state.battles.map((b) => b.prov));
    for (const d of state.divs) {
      if (d.nation !== a || d.str >= 1000 || d.str <= 0 || m.sea[d.prov] || d.sup < rules.reinforce.minSupply || busy.has(d.prov) || (d.to !== null && busy.has(d.to))) continue;
      const s = U.statsOf(ctx, d);
      let add = Math.min(1000 - d.str, rules.reinforce.perDay);
      if (s.manpower > 0) add = Math.min(add, F.div(nat.manpower, s.manpower));
      for (let k = 0; k < items.length; k++) if (s.equip[k] > 0) add = Math.min(add, F.div(nat.stock[items[k]], s.equip[k]));
      if (add <= 0) continue;
      nat.manpower -= F.mul(s.manpower, add);
      for (let k = 0; k < items.length; k++) nat.stock[items[k]] -= F.mul(s.equip[k], add);
      d.str += add;
      out.divs = true;
    }
  }

  function daily(ctx, w, out) {
    const { state } = ctx;
    const t = tally(ctx);
    state.nations.forEach((nat, a) => {
      if (!nat.alive) return;
      unlock(ctx, a, nat, t);
      produce(ctx, a, nat, t);
      construct(ctx, a, nat, t);
      train(ctx, a, nat, out);
      reinforce(ctx, a, nat, out);
      nat.manpower += Math.trunc(t.men[a] / 1000);
    });
  }

  return { daily, factories, output, newDivision };
});
