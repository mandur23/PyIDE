// What the operations AI (operations.js) and the general AI (general.js) share: the hour's view of the board
// (divisions by province, provinces by controller, who is fighting), whom a nation faces (strategy targets or, with
// none, everyone at war with it), its contact line, the odds of an attack in the engine's own power numbers, the
// nearest divisions to a province, the nearest port of the camp, and send(): the one way either layer moves a
// division (with the waypoint legs general.js keeps in nation.ai.legs); a route may cross open sea zones.
//
// Rules: everything here is derived and cached in WeakMaps or scratch arrays, never in state; searches visit
// provinces in id order and break ties by id; every search spends from a work budget (a count, not a clock) and
// stops when it is spent, so a huge front cannot stall the tick and results stay deterministic. send() goes through
// orders.apply only, as a move or halt with by: 'general' (which leaves the division's manual flag alone), and it
// never lets a redeployment's path cross a province its camp does not hold, or water its camp does not control, nor
// sends a division by sea between two provinces one stretch of its camp's land joins. When no waypoint of the inside
// route is safe to reach by the shortest path (India to France: the shortest lands at a hostile port), it moves the
// division along that inside route itself (move with own: true), when the route is safe. power() and odds() count the
// shells the attackers' stock can feed (shellF: a day of fire for a SHELL_SHARE-th of the nation's divisions, else
// down toward combat.noShells) and the mean siege of the attackers, as combat.js does.
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).mil = api; }
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const G = NODE ? null : globalThis.Conquest;
  const M = NODE ? require('../mapdata.js') : G.mapdata;
  const U = NODE ? require('../units.js') : G.units;
  const MV = NODE ? require('../movement.js') : G.movement;
  const CB = NODE ? require('../combat.js') : G.combat;
  const O = NODE ? require('../orders.js') : G.orders;

  const PATH_WORK = 150;
  const OWN_CAP = 1500;
  const SHELL_DAY = 24;
  const SHELL_SHARE = 4;

  const views = new WeakMap();
  function view(ctx) {
    const { state } = ctx;
    const old = views.get(state);
    if (old && old.hour === state.hour && old.board === M.board(state) && old.divs === state.divs && old.len === state.divs.length) return old;
    const m = M.of(ctx);
    const n = m.n;
    const divs = state.divs;
    const nd = divs.length;
    const k = state.nations.length;
    const head = new Int32Array(n).fill(-1);
    const next = new Int32Array(nd);
    const count = new Int32Array(state.nations.length);
    for (let i = nd - 1; i >= 0; i--) { const p = divs[i].prov; next[i] = head[p]; head[p] = i; count[divs[i].nation]++; }
    const ctrl = state.prov.ctrl;
    const start = new Int32Array(k + 1);
    for (let p = 1; p < n; p++) if (!m.sea[p] && ctrl[p] >= 0) start[ctrl[p] + 1]++;
    for (let a = 0; a < k; a++) start[a + 1] += start[a];
    const fill = start.slice(0, k);
    const owned = new Int32Array(start[k]);
    for (let p = 1; p < n; p++) if (!m.sea[p] && ctrl[p] >= 0) owned[fill[ctrl[p]]++] = p;
    const attacking = new Set();
    const defending = new Set();
    const battleAt = new Int32Array(n);
    state.battles.forEach((b, i) => {
      battleAt[b.prov] = i + 1;
      for (const id of b.att) attacking.add(id);
      for (const id of b.def) defending.add(id);
    });
    const ready = new Int32Array(k);
    for (let a = 0; a < k; a++) ready[a] = M.ready(state, a);
    const v = { hour: state.hour, board: M.board(state), divs, len: nd, head, next, count, start, owned, attacking, defending, battleAt, ready };
    views.set(state, v);
    return v;
  }

  const scratch = new WeakMap();
  // Slot-numbered scratch arrays per map; fresh() starts a new generation so stale marks never count.
  function marks(ctx, slot) {
    const m = M.of(ctx);
    let list = scratch.get(m);
    if (!list) { list = []; scratch.set(m, list); }
    if (!list[slot]) list[slot] = { gen: 0, mark: new Int32Array(m.n), val: new Int32Array(m.n), par: new Int32Array(m.n), queue: new Int32Array(m.n) };
    return list[slot];
  }
  function fresh(s) {
    s.gen += 1;
    if (s.gen > 2000000000) { s.mark.fill(0); s.gen = 1; }
    return s.gen;
  }

  // An army's divisions the layers may move: alive, not the player's own (manual), not at sea.
  function usable(ctx, army) {
    const m = M.of(ctx);
    const out = [];
    for (const id of army.divs) {
      const d = M.divById(ctx.state, id);
      if (d && !d.manual && d.str > 0 && !m.sea[d.prov]) out.push(d);
    }
    return out;
  }

  const personality = (ctx, n) => ((ctx.scenario.nations[n] || {}).personality) || {};
  const trait = (ctx, n, army) => (army && army.general ? M.facts(ctx).traits[n].get(army.general) || null : null);
  const dest = (d) => (d.to === null ? d.prov : d.path.length ? d.path[d.path.length - 1] : d.to);
  const worn = (d) => d.org < 300 || d.str < 400;
  const ready = (d) => !worn(d) && d.org >= 650;

  // face[b]: b is a nation n stands against (at war, or a strategy target); weight[b] 0..1000; attack[b]: at war and
  // its posture is attack. Without nation.ai.strategy every enemy weighs the same and the posture is boldness >= 50.
  function targets(ctx, n, rel) {
    const { state } = ctx;
    const k = state.nations.length;
    const face = new Uint8Array(k);
    const weight = new Int32Array(k);
    const attack = new Uint8Array(k);
    const st = state.nations[n].ai && state.nations[n].ai.strategy;
    const listed = new Uint8Array(k);
    if (st && Array.isArray(st.targets)) {
      for (const t of st.targets) {
        if (!t || !Number.isInteger(t.nation) || t.nation < 0 || t.nation >= k || t.nation === n || !state.nations[t.nation].alive) continue;
        listed[t.nation] = 1;
        weight[t.nation] = Math.max(0, Math.min(1000, t.weight | 0));
        face[t.nation] = weight[t.nation] > 0 || M.hostile(rel, n, t.nation) ? 1 : 0;
        attack[t.nation] = t.posture === 'attack' && M.hostile(rel, n, t.nation) ? 1 : 0;
      }
    }
    const bold = personality(ctx, n).boldness;
    for (let b = 0; b < k; b++) {
      if (b === n || listed[b] || !state.nations[b].alive || !M.hostile(rel, n, b)) continue;
      face[b] = 1;
      weight[b] = st && Array.isArray(st.targets) ? 500 : 1000;
      attack[b] = !(st && Array.isArray(st.targets)) && (bold === undefined ? 50 : bold) >= 50 ? 1 : 0;
    }
    return { face, weight, attack };
  }

  const faced = (T, rel, n, c) => c >= 0 && c !== n && T.face[c] === 1 && !M.camp(rel, n, c);

  // The provinces n controls next to land of a nation it faces, ascending.
  function contact(ctx, v, rel, n, T) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const out = [];
    for (let i = v.start[n]; i < v.start[n + 1]; i++) {
      const p = v.owned[i];
      for (const q of m.adj[p]) if (!m.sea[q] && faced(T, rel, n, ctrl[q])) { out.push(p); break; }
    }
    return out;
  }

  // The strength of the divisions hostile to n in q, each at its nation's readiness: a neighbour still mobilising
  // threatens less than its numbers.
  function hostileStr(ctx, v, rel, n, q) {
    const divs = ctx.state.divs;
    let s = 0;
    for (let i = v.head[q]; i >= 0; i = v.next[i]) if (M.hostile(rel, divs[i].nation, n)) { const r = v.ready[divs[i].nation]; s += r === 1000 ? divs[i].str : Math.trunc((divs[i].str * r) / 1000); }
    return s;
  }

  function touchesHostile(ctx, rel, n, p) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    for (const q of m.adj[p]) if (!m.sea[q] && M.hostile(rel, n, ctrl[q])) return true;
    return false;
  }

  // The defence a hostile garrison of t puts up against attackers bringing `siege` from `dirs` directions: D with
// and without trenches, of the divisions combat.js would engage (its width).
  function defence(ctx, v, rel, n, t, siege, dirs = 1) {
    const divs = ctx.state.divs;
    const list = [];
    for (let i = v.head[t]; i >= 0; i = v.next[i]) if (divs[i].str > 0 && divs[i].org > 0 && M.hostile(rel, divs[i].nation, n)) list.push(i);
    const take = new Set(CB.engaged(divs, list, CB.width(ctx.rules, dirs)));
    const nb = U.table(ctx.rules).nb;
    const counts = new Int32Array(nb);
    let D = 0;
    let flat = 0;
    let count = 0;
    for (let i = v.head[t]; i >= 0; i = v.next[i]) {
      const d = divs[i];
      if (!take.has(i)) continue;
      count++;
      const c = U.statsOf(ctx, d).counts;
      for (let b = 0; b < nb; b++) counts[b] += c[b];
      D += CB.defencePower(ctx, d, t, siege);
      flat += CB.defencePower(ctx, d, t, 1000000);
    }
    if (count) for (let b = 0; b < nb; b++) counts[b] = Math.trunc(counts[b] / count);
    return { D, flat, count, counts };
  }

  const at = (d, from) => (d.prov === from ? d : Object.assign({}, d, { prov: from }));
  // The shells an attack can count on: a division's fire for SHELL_DAY hours while the stock holds that much for a
  // SHELL_SHARE-th of the nation's divisions, falling to combat.noShells as the stock runs out (combat.js fires them).
  function shellF(ctx, d) {
    const need = U.statsOf(ctx, d).shells;
    if (need <= 0) return 1000;
    const nat = ctx.state.nations[d.nation];
    const full = need * SHELL_DAY * Math.max(1, Math.trunc(view(ctx).count[d.nation] / SHELL_SHARE));
    const stock = Math.max(0, nat.stock.shells | 0);
    const no = ctx.rules.combat.noShells;
    return stock >= full ? 1000 : no + Math.trunc(((1000 - no) * stock) / full);
  }
  const power = (ctx, d, from, t, counts) => CB.attackPower(ctx, at(d, from), t, counts, shellF(ctx, d));

  // The hourly win threshold (0..1000) of these divisions attacking t from where they stand, as combat.js rolls it.
  function odds(ctx, v, rel, n, all, t) {
    const dirs = new Set(all.map((d) => d.prov)).size;
    const w = CB.width(ctx.rules, dirs);
    const attackers = all.length <= w ? all : all.slice().sort((a, b) => b.org - a.org || a.id - b.id).slice(0, w);
    let siege = 0;
    for (const d of attackers) siege += U.statsOf(ctx, d).siege;
    siege = Math.trunc(siege / Math.max(1, attackers.length));
    const def = defence(ctx, v, rel, n, t, siege, dirs);
    if (!def.count) return { p: 1000, A: 0, D: 0, count: 0 };
    const from = [];
    let A = 0;
    for (const d of attackers) {
      if (!from.includes(d.prov)) from.push(d.prov);
      A += power(ctx, d, d.prov, t, def.counts);
    }
    A = Math.trunc((A * (1000 + ctx.rules.combat.flank * Math.max(0, from.length - 1))) / 1000);
    return { p: A + def.D > 0 ? Math.trunc((A * 1000) / (A + def.D)) : 0, A, D: def.D, count: def.count };
  }

  // Breadth-first from `from` over land n's camp controls (from itself may be anything), nearest first; visit(p,
  // hops) returns true to stop. Spends one work unit per province.
  function spread(ctx, rel, n, from, maxHops, budget, visit, slot = 0) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const s = marks(ctx, slot);
    const g = fresh(s);
    let qh = 0;
    let qt = 0;
    s.mark[from] = g; s.val[from] = 0; s.par[from] = 0; s.queue[qt++] = from;
    while (qh < qt) {
      if (budget.left <= 0) return s;
      budget.left--;
      const p = s.queue[qh++];
      if (visit(p, s.val[p])) return s;
      if (s.val[p] >= maxHops) continue;
      for (const q of m.adj[p]) {
        if (s.mark[q] === g || m.sea[q] || !M.camp(rel, n, ctrl[q])) continue;
        s.mark[q] = g; s.val[q] = s.val[p] + 1; s.par[q] = p; s.queue[qt++] = q;
      }
    }
    return s;
  }

  // Up to k divisions nearest to province t (by hops over the camp's land) for which pick(d) holds.
  function nearest(ctx, v, rel, n, t, k, pick, budget, maxHops = 40) {
    const divs = ctx.state.divs;
    const out = [];
    if (k <= 0) return out;
    spread(ctx, rel, n, t, maxHops, budget, (p) => {
      for (let i = v.head[p]; i >= 0; i = v.next[i]) {
        if (pick(divs[i])) { out.push(divs[i]); if (out.length >= k) return true; }
      }
      return false;
    });
    return out;
  }

  const order = (ctx, n, o) => O.apply(ctx, n, o);

  // Land on the route is safe when the camp holds it, a sea zone when the camp controls it or nobody does (naval.js):
  // a division is never sent through contested water or water another navy holds.
  function safe(ctx, rel, n, route, upTo) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const sea = ctx.state.sea.ctrl;
    for (let i = 0; i < upTo; i++) {
      const p = route[i];
      if (m.sea[p] ? !(sea[p] === -1 || (sea[p] >= 0 && M.camp(rel, n, sea[p]))) : !M.camp(rel, n, ctrl[p])) return i;
    }
    return upTo;
  }

  // The port n's camp controls nearest to t (map distance, lowest id on a tie), 0 when there is none.
  function nearPort(ctx, rel, n, t) {
    const m = M.of(ctx);
    const P = ctx.map.provinces;
    const ctrl = ctx.state.prov.ctrl;
    let best = 0;
    let bestD = 0;
    for (const p of m.ports) {
      if (p === t || !M.camp(rel, n, ctrl[p])) continue;
      const dx = Math.trunc(P[p].x) - Math.trunc(P[t].x);
      const dy = Math.trunc(P[p].y) - Math.trunc(P[t].y);
      const dd = dx * dx + dy * dy;
      if (!best || dd < bestD) { best = p; bestD = dd; }
    }
    return best;
  }

  // Moves d toward `to`. A redeployment (attack false) only follows a path through provinces its camp holds (and
  // open sea zones): when the shortest path leaves them, d goes to a waypoint on a path inside them (over the camp's
  // land, or when there is none, by sea: movement.search with own), the farthest of (its last province
  // before `to`, the one halfway, a quarter of the way, ..., the first) whose own shortest path stays inside. An
  // attack may end in a hostile province but not cross one on the way. Returns true when d is now on its way (an
  // order was given, or it already was). A waypoint leg is kept in budget.legs (div id -> to) when the caller passes
  // one: general.js saves it as nation.ai.legs.
  function send(ctx, rel, n, d, to, budget, attack = false) {
    const legs = budget.legs || null;
    const drop = () => { if (legs) legs.delete(d.id); return false; };
    if (dest(d) === to) { if (legs) legs.delete(d.id); return true; }
    if (legs && legs.get(d.id) === to && d.to !== null) return true;
    if (d.prov === to) {
      if (!order(ctx, n, { type: 'halt', div: d.id, by: 'general' }).ok) return drop();
      if (legs) legs.delete(d.id);
      return true;
    }
    budget.left -= PATH_WORK;
    let goal = to;
    const route = MV.path(ctx, rel, d, to);
    if (!route) return drop();
    const upTo = route.length - (attack ? 1 : 0);
    let bad = safe(ctx, rel, n, route, upTo);
    // Within one stretch of the camp's land a division goes by land, never by a sea lane an enemy fleet can close.
    let landOnly = false;
    const sea0 = route.findIndex((p) => M.of(ctx).sea[p]);
    if (bad === upTo && sea0 >= 0 && sea0 < upTo) {
      const s0 = spread(ctx, rel, n, to, 60, budget, (p) => p === d.prov, 1);
      if (s0.mark[d.prov] === s0.gen) { bad = sea0; landOnly = true; }
    }
    if (bad < upTo) {
      let last = bad - 1;
      while (last >= 0 && M.of(ctx).sea[route[last]]) last--;
      goal = last >= 0 ? route[last] : 0;
      const s = spread(ctx, rel, n, to, 60, budget, (p) => p === d.prov, 1);
      let way = null;
      let inside = null;
      if (s.mark[d.prov] === s.gen) {
        way = [];
        for (let w = d.prov; w !== to;) {
          if (attack && s.par[w] === to) break;
          w = s.par[w];
          way.push(w);
        }
      } else {
        budget.left -= PATH_WORK;
        const r = MV.search(ctx, rel, d, to, { own: true, cap: OWN_CAP }).path;
        inside = r;
        if (r) way = r.filter((p, i) => !M.of(ctx).sea[p] && !(attack && i === r.length - 1));
      }
      let found = false;
      if (way) {
        const tries = [];
        for (let h = way.length - 1; h >= 1; h = Math.trunc(h / 2)) tries.push(h);
        tries.push(0);
        for (const h of tries) {
          if (way[h] === to || h >= way.length) continue;
          budget.left -= PATH_WORK;
          const r2 = MV.path(ctx, rel, d, way[h]);
          if (r2 && safe(ctx, rel, n, r2, r2.length) === r2.length && !(landOnly && r2.some((p) => M.of(ctx).sea[p]))) { goal = way[h]; found = true; break; }
        }
      }
      if (!found && !attack && inside && safe(ctx, rel, n, inside, inside.length) === inside.length) {
        if (legs) legs.delete(d.id);
        if (dest(d) === to) return true;
        return order(ctx, n, { type: 'move', div: d.id, to, by: 'general', own: true }).ok || drop();
      }
      if (!goal) return drop();
    }
    if (goal === d.prov) return drop();
    if (legs) { if (goal === to) legs.delete(d.id); else legs.set(d.id, to); }
    if (dest(d) === goal) return true;
    if (!order(ctx, n, { type: 'move', div: d.id, to: goal, by: 'general' }).ok) return drop();
    return true;
  }

  function halt(ctx, n, d, budget) {
    if (budget && budget.legs) budget.legs.delete(d.id);
    if (d.to === null) return false;
    return order(ctx, n, { type: 'halt', div: d.id, by: 'general' }).ok;
  }

  // Where d is headed: the target of its waypoint leg when it is on one, else the end of its path.
  const goalOf = (budget, d) => (budget.legs && budget.legs.has(d.id) ? budget.legs.get(d.id) : dest(d));

  // The province an offensive attacks next: the first of its path the camp does not hold, or, when that one does
  // not border the camp's land, the first such province on the way there from the army. null when it is done.
  function frontier(ctx, rel, n, off, rep, budget) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    let t = 0;
    for (const p of off.path) if (!m.sea[p] && !M.camp(rel, n, ctrl[p])) { t = p; break; }
    if (!t) return null;
    for (const q of m.adj[t]) if (!m.sea[q] && M.camp(rel, n, ctrl[q])) return t;
    if (!rep) return null;
    budget.left -= PATH_WORK;
    const route = MV.path(ctx, rel, rep, t);
    if (!route) return null;
    for (const p of route) if (!m.sea[p] && !M.camp(rel, n, ctrl[p])) return p;
    return null;
  }

  // The land next to t that n's camp holds, most supply first.
  function staging(ctx, rel, n, t) {
    const m = M.of(ctx);
    const P = ctx.state.prov;
    const out = [];
    for (const q of m.adj[t]) if (!m.sea[q] && M.camp(rel, n, P.ctrl[q])) out.push(q);
    return out.sort((a, b) => P.supply[b] - P.supply[a] || a - b);
  }

  // What holding a front takes: its contact provinces, how many of them have a hostile division next to them, and
  // those hostile divisions (each counted once).
  function menace(ctx, v, rel, n, provs) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const divs = ctx.state.divs;
    const s = marks(ctx, 4);
    const g = fresh(s);
    let contact = 0;
    let threatened = 0;
    let hostile = 0;
    for (const p of provs) {
      if (!M.camp(rel, n, ctrl[p])) continue;
      let touches = false;
      let faced = false;
      for (const q of m.adj[p]) {
        if (m.sea[q]) continue;
        let here = 0;
        for (let i = v.head[q]; i >= 0; i = v.next[i]) if (divs[i].str > 0 && M.hostile(rel, divs[i].nation, n)) here++;
        if (here) faced = true;
        if (!M.hostile(rel, n, ctrl[q])) continue;
        touches = true;
        if (s.mark[q] === g) continue;
        s.mark[q] = g;
        hostile += here;
      }
      if (touches) contact++;
      if (faced) threatened++;
    }
    return { contact, threatened, hostile };
  }

  // How many of an army's usable divisions go to its offensive: the trait's share, leaving a holder for every contact
  // province of its front with a hostile division next to it and, up to one per contact province, for every hostile
  // division facing it. Only quiet contact provinces may be left open for an offensive.
  function strikeSize(usable, threat, share) {
    const hold = Math.max(threat.threatened, Math.min(threat.contact, threat.hostile));
    return Math.max(0, Math.min(Math.trunc((usable * share + 500) / 1000), usable - hold));
  }

  const SHARE = { offence: 700, defence: 450 };
  const shareOf = (tr) => SHARE[tr] || 600;
  // The hourly odds (0..1000) at which an army's general attacks: earlier under an offence general, later under a
  // defence one or a cautious nation.
  function goOdds(ctx, n, tr) {
    const base = tr === 'offence' ? 520 : tr === 'defence' ? 620 : 570;
    const c = personality(ctx, n).caution;
    return base + Math.trunc(((c === undefined ? 50 : c) - 50) / 2);
  }

  return {
    view, marks, fresh, usable, goalOf, personality, trait, worn, ready, targets, faced, contact, hostileStr, menace,
    touchesHostile, defence, power, odds, spread, nearest, order, send, halt, nearPort, frontier, staging, strikeSize, shareOf, goOdds,
  };
});
