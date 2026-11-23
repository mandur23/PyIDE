// Movement and entrenchment. A moving division has `to` (the province it is entering), `eta` (hours left) and `path`
// (the provinces after `to`). Entering land q from land p takes
//   km(area) / speed × terrain.move × weather.move × (river or strait crossed ? rules.move.river : 1) / (1 + infra × v)
// with v = rules.move.rail when p and q are held by one camp (the railways behind the line) and rules.move.infra
// otherwise (an advance into land the enemy held)
// hours, rounded up, at least 1, fixed when the step starts. A land province is passable for a nation when its
// controller is the nation, an ally, a nation granting access, or an enemy at war (passable()).
//
// Sea (transport only): a coastal land province's sea zones are in its adj, so a path may run coast, zones, coast.
//   embark into zone z from land p:  (port p ? naval.embarkPort : naval.embarkBeach) + sail(z)
//   zone to zone z:                  sail(z) = ceil(km(z) × 1000 / naval.speed), at least 1
//   disembark onto land q:           port q ? naval.disembarkPort : naval.disembarkBeach
// so port to port over zones z1..zk is embarkPort + Σ sail(zi) + disembarkPort hours. Disembarking onto land an
// enemy holds (a landing) needs naval.landing(). A zone is passable unless
// denied (naval.js: its controller is at war with the nation); a strait is closed while one of its zones is denied.
// A division in a zone is at sea (div.prov is the zone): it is never attacked there, does not dig, keeps its sup,
// and cannot be halted (orders.js 'at-sea'). When its next step is closed it re-plans to its destination over its
// camp's land and open sea only (search's own: it comes ashore at a coast of its camp or at that destination, never
// on another hostile coast it did not set out to land on); failing
// that, and when a landing it attacks with is repelled (org 0), it turns back to the nearest coast of its camp (log
// 'turned-back'); with none it is lost (log 'sunk'). naval.js sinks a division whose zone becomes denied.
//
// search(ctx, rel, div, goal, { open, own }) is the one path search: shortest hours over canStep(), from div.prov to
// the province goal or the first land province for which goal(p) is true (then a plain Dijkstra). Toward a province
// it is A* with landmark bounds: LANDMARKS provinces picked farthest-first, each with its distance to every province
// over lower-bound costs (entering land: trunc(km × terrain.move × min weather.move / (1000 + infra cap ×
// max(move.infra, move.rail))), the cap being build.max.infra or the scenario's highest; entering a zone: sail × the slowest branch
// speed; landing: the faster disembark × that speed; an edge costs the lower of its two directions). The estimate
// trunc(max over landmarks |d(L, goal) - d(L, p)| × 990 / (speed × 1000)) hours never exceeds the true rest, so the
// path is a shortest one; among equal ones the heap order (cost + estimate, then province id) picks, the same on
// every machine. It reuses the map's buffers and settles at most rules.move.searchCap provinces: past that it
// answers { path: null, why: 'cap' }. Otherwise { path: [provinces after div.prov .. goal], why: 'ok' } or
// { path: null, why: 'none' | 'sea' } ('sea' when a denied zone or closed strait was in the way; { open: true }
// ignores denial; { own: true } enters only land of the division's camp, and the goal, besides sea zones; { cap }
// settles at most that many, when under searchCap).
// path(ctx, rel, div, to) is search's path or null. The last answer toward a province is kept (per state, hour,
// relations object, division id and province, template stats, goal, open, own), so legal() then apply() of one move
// searches once; whoever edits state by hand between the two inside one hour gets the kept answer.
//
// Each hour, in division id order: a division whose `to` (land) holds hostile divisions with org left starts the
// battle there (combat.js); when every hostile division there is at org 0 they give way instead, each falling back
// as a beaten defender does (retreat(): to the adjacent land of its camp with no hostile division and the most
// supply, lowest id on a tie) or, with nowhere to go, surrendering (removed, its men casualties, log 'surrendered'),
// and the division walks on; one whose `to` already has a battle waits while it joins the attack (joins(): the camp of the
// battle's side, or not at war with that side and at war with the province's controller); otherwise eta counts down
// and on arrival the division enters the province (with the works there, below) and takes the province if an enemy controls
// it (back to the owner when the owner is of its camp); one that would arrive where a hostile division arrived
// earlier in the same hour waits an hour at the edge instead, so the next hour it attacks. entrench() then adds rules.dig.perHour (+ dig.engineers
// with engineers) to every division on land that is not moving, up to its nation's cap: min(dig.max, dig.base + dig.perWarDay × the days since the oldest war it
// is fighting began), so the armies of 1914 learn to dig over the first months of the war. The province keeps the
// works (prov.works, the most any division of its controller dug there): a division entering a province of its camp,
// or falling back into one, starts with them; taking a province razes them.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).movement = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const F = NODE ? require('./fixed.js') : globalThis.Conquest.fixed;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;
  const N = NODE ? require('./naval.js') : globalThis.Conquest.naval;

  const TRENCH = 300;
  const sail = (m, NV, z) => Math.max(1, Math.trunc((Math.trunc((m.km[z] * 1000000) / NV.speed) + 999) / 1000));

  function hours(ctx, s, from, to) {
    const { rules, state } = ctx;
    const m = M.of(ctx);
    const NV = rules.naval;
    if (m.sea[to]) return (m.sea[from] ? 0 : m.port[from] ? NV.embarkPort : NV.embarkBeach) + sail(m, NV, to);
    if (m.sea[from]) return m.port[to] ? NV.disembarkPort : NV.disembarkBeach;
    let h = Math.trunc((m.km[to] * 1000000) / s.speed);
    h = F.mul(h, rules.terrain[m.terrain[to]].move);
    h = F.mul(h, rules.weather[state.prov.weather[to]].move);
    if (m.river[from].includes(to)) h = F.mul(h, rules.move.river);
    h = Math.trunc((h * 1000) / (1000 + state.prov.infra[to] * (rail(state, from, to) ? rules.move.rail : rules.move.infra)));
    return Math.max(1, Math.trunc((h + 999) / 1000));
  }

  // p and q are held by one camp: whoever moves between them moves behind its own line.
  function rail(state, p, q) {
    const a = state.prov.ctrl[p];
    const b = state.prov.ctrl[q];
    if (a < 0 || b < 0) return false;
    const rel = M.relations(state);
    return rel.ally[a * rel.k + b] === 1;
  }

  function passable(ctx, rel, nation, p) {
    const m = M.of(ctx);
    if (p <= 0 || p >= m.n || m.sea[p]) return false;
    const c = ctx.state.prov.ctrl[p];
    return c >= 0 && (rel.access[nation * rel.k + c] === 1 || rel.war[nation * rel.k + c] === 1);
  }

  const atSea = (ctx, div) => M.of(ctx).sea[div.prov] === 1;

  function canStep(ctx, rel, nation, from, to) {
    const m = M.of(ctx);
    if (to <= 0 || to >= m.n) return false;
    if (m.sea[to]) return !N.denied(ctx.state, rel, nation, to);
    if (!passable(ctx, rel, nation, to)) return false;
    if (m.sea[from] === 1 && rel.war[nation * rel.k + ctx.state.prov.ctrl[to]] === 1) return N.landing(ctx, rel, nation, from);
    return m.sea[from] === 1 || !m.straitZones.size || N.straitOpen(ctx, rel, nation, from, to);
  }

  const LANDMARKS = 8;
  const marks = new WeakMap();
  function landmarks(ctx) {
    const m = M.of(ctx);
    let L = marks.get(m);
    if (L && L.scenario === ctx.scenario) return L;
    const { rules, scenario } = ctx;
    const NV = rules.naval;
    let cap = rules.build.max.infra;
    for (const p of Object.values(scenario.provinces || {})) if (p.infra > cap) cap = p.infra;
    const vmin = Math.min(...rules.branches.map((b) => b.speed));
    const wmin = Math.min(1000, ...rules.weather.map((w) => w.move));
    const dis = Math.min(NV.disembarkPort, NV.disembarkBeach) * vmin;
    const enter = (p, q) => {
      if (m.sea[q]) return sail(m, NV, q) * vmin;
      if (m.sea[p]) return dis;
      return Math.trunc((m.km[q] * rules.terrain[m.terrain[q]].move * wmin) / (1000 + cap * Math.max(rules.move.infra, rules.move.rail)));
    };
    const weight = m.adj.map((list, p) => list.map((q) => Math.min(enter(p, q), enter(q, p))));
    const dists = [];
    const best = new Float64Array(m.n).fill(Infinity);
    let next = 1;
    while (next > 0 && next < m.n && dists.length < LANDMARKS) {
      const d = new Float64Array(m.n).fill(Infinity);
      const h = M.heap();
      d[next] = 0;
      h.push(0, next);
      while (h.size) {
        const p = h.pop();
        if (h.key !== d[p]) continue;
        const w = weight[p];
        m.adj[p].forEach((q, i) => { const c = d[p] + w[i]; if (c < d[q]) { d[q] = c; h.push(c, q); } });
      }
      dists.push(d);
      next = -1;
      for (let p = 1; p < m.n; p++) {
        if (d[p] < best[p]) best[p] = d[p];
        if (best[p] !== Infinity && best[p] > 0 && (next < 0 || best[p] > best[next])) next = p;
      }
    }
    L = { scenario: ctx.scenario, dists };
    marks.set(m, L);
    return L;
  }

  function search(ctx, rel, div, goal, opts = {}) {
    if (typeof goal === 'function') return find(ctx, rel, div, goal, opts);
    const B = M.of(ctx).search;
    const k = B.memo;
    const s = U.statsOf(ctx, div);
    const open = !!opts.open;
    const own = !!opts.own;
    if (!(k && k.state === ctx.state && k.hour === ctx.state.hour && k.rel === rel && k.id === div.id && k.prov === div.prov && k.s === s && k.goal === goal && k.open === open && k.own === own && k.cap === opts.cap)) {
      B.memo = { state: ctx.state, hour: ctx.state.hour, rel, id: div.id, prov: div.prov, s, goal, open, own, cap: opts.cap, r: find(ctx, rel, div, goal, opts) };
    }
    const r = B.memo.r;
    return { path: r.path && r.path.slice(), why: r.why };
  }

  function find(ctx, rel, div, goal, opts) {
    const m = M.of(ctx);
    const { state, rules } = ctx;
    const B = m.search;
    if (!B.est) B.est = new Int32Array(m.n);
    const est = B.est;
    const from = div.prov;
    const fn = typeof goal === 'function' ? goal : null;
    if (!fn && !passable(ctx, rel, div.nation, goal)) return { path: null, why: 'none' };
    const s = U.statsOf(ctx, div);
    const nation = div.nation;
    const open = !!opts.open;
    const own = !!opts.own;
    const cap = opts.cap > 0 ? Math.min(opts.cap, rules.move.searchCap) : rules.move.searchCap;
    const { ally } = rel;
    const straits = m.straitZones.size > 0;
    const { cost, prev, seen } = B;
    const gen = ++B.gen;
    const h = B.heap;
    const dists = fn ? [] : landmarks(ctx).dists;
    const toGoal = dists.map((d) => d[goal]);
    const NV = rules.naval;
    const TR = rules.terrain;
    const WE = rules.weather;
    const { weather, infra, ctrl } = state.prov;
    const zone = state.sea.ctrl;
    const { access, war } = rel;
    const base = nation * rel.k;
    const speed = s.speed;
    const river = rules.move.river;
    const perInfra = rules.move.infra;
    const perRail = rules.move.rail;
    const step = (p, q) => {
      if (m.sea[q]) return (m.sea[p] ? 0 : m.port[p] ? NV.embarkPort : NV.embarkBeach) + sail(m, NV, q);
      if (m.sea[p]) return m.port[q] ? NV.disembarkPort : NV.disembarkBeach;
      let x = Math.trunc((m.km[q] * 1000000) / speed);
      x = F.mul(x, TR[m.terrain[q]].move);
      x = F.mul(x, WE[weather[q]].move);
      if (m.river[p].includes(q)) x = F.mul(x, river);
      x = Math.trunc((x * 1000) / (1000 + infra[q] * (ctrl[p] >= 0 && ctrl[q] >= 0 && ally[ctrl[p] * rel.k + ctrl[q]] === 1 ? perRail : perInfra)));
      return Math.max(1, Math.trunc((x + 999) / 1000));
    };
    const scale = s.speed * 1000;
    const bound = (p) => {
      let b = 0;
      for (let i = 0; i < dists.length; i++) {
        const x = toGoal[i] - dists[i][p];
        const y = x < 0 ? -x : x;
        if (y > b && y !== Infinity) b = y;
      }
      return Math.trunc((b * 990) / scale);
    };
    h.clear();
    seen[from] = gen;
    cost[from] = 0;
    est[from] = 0;
    h.push(0, from);
    let settled = 0;
    let found = -1;
    let blocked = false;
    while (h.size) {
      const p = h.pop();
      if (h.key !== cost[p] + est[p]) continue;
      if (p !== from && (fn ? !m.sea[p] && fn(p) : p === goal)) { found = p; break; }
      if (++settled > cap) return { path: null, why: 'cap' };
      const fromSea = m.sea[p] === 1;
      for (const q of m.adj[p]) {
        if (m.sea[q]) {
          const z = zone[q];
          if (z >= 0 && war[base + z] === 1) { blocked = true; if (!open) continue; }
        } else {
          const c = ctrl[q];
          if (c < 0 || (access[base + c] !== 1 && war[base + c] !== 1)) continue;
          if (own && ally[base + c] !== 1 && q !== goal) continue;
          if (!fromSea && straits && !N.straitOpen(ctx, rel, nation, p, q)) { blocked = true; if (!open) continue; }
        }
        const c = cost[p] + step(p, q);
        if (seen[q] !== gen) { seen[q] = gen; est[q] = bound(q); } else if (c >= cost[q]) continue;
        cost[q] = c;
        prev[q] = p;
        h.push(c + est[q], q);
      }
    }
    if (found < 0) return { path: null, why: blocked ? 'sea' : 'none' };
    const out = [];
    for (let p = found; p !== from; p = prev[p]) out.push(p);
    return { path: out.reverse(), why: 'ok' };
  }

  // The provinces after `from` up to and including `to`, or null.
  const path = (ctx, rel, div, to) => search(ctx, rel, div, to).path;

  function hostileIn(ctx, w, p, nation) {
    const divs = ctx.state.divs;
    for (let i = w.provHead[p]; i >= 0; i = w.provNext[i]) if (divs[i].str > 0 && M.hostile(w.rel, divs[i].nation, nation)) return true;
    return false;
  }

  function retreat(ctx, w, d, kind = 'destroyed') {
    const { state } = ctx;
    const m = M.of(ctx);
    const P = state.prov;
    let best = -1;
    for (const q of m.adj[d.prov]) {
      if (m.sea[q] || !M.camp(w.rel, d.nation, P.ctrl[q]) || w.battleAt[q]) continue;
      if (hostileIn(ctx, w, q, d.nation)) continue;
      if (best < 0 || P.supply[q] > P.supply[best] || (P.supply[q] === P.supply[best] && q < best)) best = q;
    }
    if (best < 0) { U.lose(ctx, d, d.str); log(ctx, { kind, div: d.id, prov: d.prov }); return; }
    d.prov = best;
    d.dig = P.works[best];
    stop(d);
  }

  // Every hostile division in p is at org 0 (and there is one): they give way to an attacker.
  function yields(ctx, w, p, nation) {
    const divs = ctx.state.divs;
    for (let i = w.provHead[p]; i >= 0; i = w.provNext[i]) if (divs[i].str > 0 && divs[i].org > 0 && M.hostile(w.rel, divs[i].nation, nation)) return false;
    return true;
  }

  function giveWay(ctx, w, p, nation) {
    const divs = ctx.state.divs;
    const out = [];
    for (let i = w.provHead[p]; i >= 0; i = w.provNext[i]) if (divs[i].str > 0 && M.hostile(w.rel, divs[i].nation, nation)) out.push(divs[i]);
    for (const d of out) retreat(ctx, w, d, 'surrendered');
    w.index();
  }

  const joins = (rel, a, side, ctrl) => M.camp(rel, a, side) || (!M.hostile(rel, a, side) && M.hostile(rel, a, ctrl));

  function stop(d) { d.to = null; d.eta = 0; d.path = []; }

  function follow(ctx, d, path) {
    d.to = path.shift();
    d.eta = hours(ctx, U.statsOf(ctx, d), d.prov, d.to);
    d.path = path;
  }

  function halt(ctx, rel, d) {
    if (!atSea(ctx, d)) return stop(d);
    const ctrl = ctx.state.prov.ctrl;
    const r = search(ctx, rel, d, (p) => M.camp(rel, d.nation, ctrl[p]));
    if (r.path) {
      follow(ctx, d, r.path);
      M.log(ctx, { kind: 'turned-back', div: d.id, prov: d.prov });
      return undefined;
    }
    U.lose(ctx, d, d.str);
    stop(d);
    M.log(ctx, { kind: 'sunk', div: d.id, prov: d.prov });
    return undefined;
  }

  function blocked(ctx, rel, d) {
    if (!atSea(ctx, d)) return stop(d);
    const dest = d.path.length ? d.path[d.path.length - 1] : d.to;
    const r = M.of(ctx).sea[dest] ? { path: null } : search(ctx, rel, d, dest, { own: true });
    if (r.path) return follow(ctx, d, r.path);
    return halt(ctx, rel, d);
  }

  function arrive(ctx, w, d, out) {
    const { state } = ctx;
    const P = state.prov;
    const to = d.to;
    // A hostile division entered this province earlier in the hour (the world index does not hold it yet): wait at
    // the edge, and the next hour attacks it.
    const m = M.of(ctx);
    if (!w.came || w.came.length !== m.n) w.came = new Int32Array(m.n);
    const stamp = (state.hour + 1) * 1024;
    const c = w.came[to];
    if (c >= stamp && c < stamp + 1024 && M.hostile(w.rel, c - stamp, d.nation)) { d.eta = 1; return; }
    w.came[to] = stamp + d.nation;
    d.prov = to;
    d.dig = P.works[to];
    if (M.hostile(w.rel, P.ctrl[to], d.nation)) {
      P.ctrl[to] = M.camp(w.rel, P.owner[to], d.nation) ? P.owner[to] : d.nation;
      P.works[to] = 0;
      d.dig = 0;
      out.provinces.push(to);
      log(ctx, { kind: 'taken', prov: to, by: P.ctrl[to] });
    }
    if (!d.path.length) return stop(d);
    if (canStep(ctx, w.rel, d.nation, d.prov, d.path[0])) return follow(ctx, d, d.path);
    return blocked(ctx, w.rel, d);
  }

  const log = M.log;

  function hour(ctx, w, out) {
    const { state } = ctx;
    const m = M.of(ctx);
    const divs = state.divs;
    for (let i = 0; i < divs.length; i++) {
      const d = divs[i];
      if (d.to === null || d.str <= 0) continue;
      const to = d.to;
      if (!m.sea[to]) {
        const at = w.battleAt[to];
        if (at) {
          if (joins(w.rel, d.nation, state.battles[at - 1].side, state.prov.ctrl[to])) continue;
        } else if (hostileIn(ctx, w, to, d.nation)) {
          if (d.org <= 0) continue;
          if (yields(ctx, w, to, d.nation)) { giveWay(ctx, w, to, d.nation); out.divs = true; continue; }
          const b = { id: state.next.battle++, prov: to, side: d.nation, from: [d.prov], att: [d.id], def: [], hours: 0, odds: 0 };
          state.battles.push(b);
          w.battleAt[to] = state.battles.length;
          out.battles = true;
          continue;
        }
      }
      if (!canStep(ctx, w.rel, d.nation, d.prov, to)) { blocked(ctx, w.rel, d); out.divs = true; continue; }
      d.eta -= 1;
      if (d.eta <= 0) { arrive(ctx, w, d, out); out.divs = true; }
    }
  }

  // Each nation's trench cap this hour (see the header).
  function digCaps(ctx) {
    const { state, rules } = ctx;
    const D = rules.dig;
    const k = state.nations.length;
    const tags = new Map(state.nations.map((x, i) => [x.tag, i]));
    const since = new Array(k).fill(-1);
    for (const pair in state.rel) {
      const r = state.rel[pair];
      if (!r || !r.war) continue;
      const bar = pair.indexOf('|');
      for (const t of [pair.slice(0, bar), pair.slice(bar + 1)]) { const a = tags.get(t); if (a !== undefined && (since[a] < 0 || (r.since | 0) < since[a])) since[a] = r.since | 0; }
    }
    return since.map((h) => Math.min(D.max, (D.base | 0) + (h < 0 ? 0 : Math.trunc(((state.hour - h) / 24) * (D.perWarDay | 0)))));
  }

  function entrench(ctx) {
    const { state, rules } = ctx;
    const D = rules.dig;
    const m = M.of(ctx);
    const works = state.prov.works;
    const cap = digCaps(ctx);
    for (const d of state.divs) {
      if (d.to !== null || d.str <= 0 || d.dig >= cap[d.nation] || m.sea[d.prov]) continue;
      d.dig = Math.min(cap[d.nation], d.dig + D.perHour + (U.statsOf(ctx, d).dig > 0 ? D.engineers : 0));
      if (d.dig > works[d.prov]) works[d.prov] = d.dig;
    }
  }

  const dugIn = (state, p) => state.prov.works[p] >= TRENCH;

  return { hours, sail, passable, canStep, atSea, search, path, joins, hour, entrench, stop, halt, retreat, log, dugIn, TRENCH };
});
