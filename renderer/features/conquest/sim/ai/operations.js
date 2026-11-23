// The operations AI (plan 5.3): once a day, for each living AI nation (never the player's), it draws the fronts and
// plans the offensives that general.js carries out. Its memory is nation.ai.ops:
//   { plans: [{ army, offensive, target, objective, since, bad }], rest: [{ army, until }], exp }   (ascending army id)
// a plan is an offensive of that army this layer launched; rest holds an army back from planning after a call-off;
// exp is the army sent to an ally's front (0 for none).
//
// Fronts. The contact line is every province the nation controls next to land of a nation it faces, less its
// connected parts that are quiet colonial border: land it owns that is not a core of it, with no hostile division
// next to it and no land next to it that a hostile nation holds as its own core or holds of the nation's own
// (facesHome(): a colony against the enemy's home, or around its own lost land, is a front while that land stands
// empty) (mil.targets: nation.ai.strategy's targets, or everyone at war with it), plus the shared line (shared():
// provinces of its bloc partners next to hostile divisions where the pressure exceeds what the partner's camp holds
// there by SHARE_GAP, with that excess as need). While the nation is at war the line also takes its home provinces
// next to land of a watched nation (watched(): not at war with it and not of its camp, but allied to a nation it is
// at war with, so the next to join: France while Germany fights only Russia; or one a scenario event that has not
// fired has it declare war on: Belgium for Germany), so a border about to be a front keeps
// its armies. Need of a province = 1000 + the hostile strength next to it × the
// target's weight, and half that of hostile divisions one province further back (QUIET instead of 1000 for quiet
// colonial border); on home land the divisions of watched nations count as well, in full and at weight 1000 (they
// will have mobilised by the time they join). Armies go to the connected parts within the region of camp land they stand in (regions(); an
// army's region is that of the part its front overlaps most, else where most of its divisions stand), by largest
// remainder on need; an army keeps its part while that part has no more than one army over its share, an army with
// no part takes the nearest part of its region that is short of armies (the closest pair of army and part first, so
// the armies standing at a border are the ones that hold it), and an army of
// a region with no part goes where the need per army is highest. A part with several armies is cut, as a chain from
// one end, into sections of equal length (so the sections stay still while only the threat moves), each to the army
// whose front overlaps it most (the nearest on a tie); a part with no army joins the nearest section of its region,
// or, when its region has none, a section of the army with the most divisions standing in that region, or, with
// none there and a core of the nation in it (or a colony of it that facesHome()), the nearest section anywhere (the
// general ships divisions there); any other part with no army and no division in its region is left to nobody. With no contact line every army holds where its divisions stand
// (its own land; the capital for an army with none there), and no division passes between armies; a capital off the line joins the nearest army's front once hostile divisions come within GUARD provinces.
// A `front` order is given only when an army's list changes.
//
// Expedition. A nation with at least two armies whose own borders are quiet (contact provinces with a hostile
// division next to them under a QUIET_SHARE-th of its divisions, hostile divisions next to the line under a
// QUIET_PRESS-th) and whose own contact line needs fewer divisions than it has (one per such province, one per four
// other ones and one per 1000 of hostile strength next to it, half again, and RESERVE more) by EXP_MIN or more sends one army, the one nearest that front (the same one while it lasts), to an ally's front: the provinces its allies
// control next to hostile divisions on land of a nation it faces, from the one nearest its own capital outwards, about half as many as
// the spare divisions, among the fronts within EXP_RANGE map pixels of its capital (about 90 degrees of longitude
// on the world map), when the army can get there over its camp's land and open sea (a search of at most EXP_CAP
// provinces). general.js carries it there, by sea when it must. The other armies share the own line.
//
// Divisions follow the need. An army's share is one division per 1000 of its front's need (so one per threatened
// province and one per four quiet ones) and the rest in proportion to need (in proportion to that when there are too
// few). Every army takes part, also one whose divisions are all at sea or gone, so an emptied army is refilled. A division standing on, or bound for, a province
// that is now another army's front joins that army while it is not over its share; then up to MOVES a day pass from
// the army furthest above its share to the one furthest below it; divisions in no army join the one furthest below.
//
// Offensives. For each army without a plan whose front faces a nation with posture attack, every hostile province
// next to its section is scored: 2 × (odds - 500), the odds being combat.js's hourly threshold for the strike group
// general.js would send (mil.strikeSize, massed on up to three provinces next to the target) against the garrison
// and a third of the hostile divisions next to it; plus the value field there × the target's weight (enemy
// capitals, hubs, factories, the nation's 'take' goals, provinces whose loss cuts hostile divisions off from supply,
// and the nation's own land and capital held by the enemy, each worth VALUE less DECAY per province of distance);
// plus supply at the staging province and the enemy's shortage at the target. Landings are scored with them: the
// LAND_CANDS enemy coastal provinces nearest the army with no land of the camp next to them, each attacked from its
// best sea zone its camp controls (the engine's landing factor: naval.landPort or landBeach; +SEA_HELD), +PORT for a port
// (-PORT for a beach), less LANDING; never a home province of a great power with a hostile division in it
// (defendedHome). The best with odds >= PLAN_ODDS and a
// score over the nation's threshold (higher when cautious) becomes an `offensive` whose path runs from that province
// to the objective its value came from, and is launched; an army whose mean supply is under SUP_OFF plans nothing.
// A plan is called off (launch on: false) when the strike group's supply drops under SUP_OFF, its odds stay under
// OFF_ODDS two days running, the target is blocked or no longer one to attack, the army's front has moved more than
// FRONT_HOPS provinces from the province it attacks next over land (a landing is exempt; shown as 'posture'), or the
// path is taken; after a call-off other than a finished path the army rests REST hours. A called-off offensive is removed ('offensive' with path
// null), so an army's list holds only what is planned. Each plan and call-off is recorded with explain.record.
//
// Set pieces (the war of position, setPiece()): when no such offensive is found and the best province with odds of
// PUSH_ODDS or more (dug in or not: movement.dugIn), an army whose strike group has PUSH_K divisions or more,
// while fewer than PUSH_MAX of the nation's armies run one and the nation holds shells for twice PUSH_HOURS hours of
// the engaged width's fire, attacks it anyway: plan.push is the shell reserve at which it stops (PUSH_HOURS of
// that fire). general.js attacks a set piece from its PUSH_GO instead of its usual odds. It ends after PUSH_DAYS, when
// the stock falls to the reserve ('supply'), or when its odds stay under PUSH_ODDS - PUSH_GAP two days ('odds'),
// and the army rests PUSH_REST hours to bring up shells and men, OPEN_REST after one against a line not dug in (a
// capture razes the works, so a short rest there would chain set pieces all war). With hourly odds p near 0.3 an engaged attacking
// division loses (1 - p) × strLoser + p × strWinner ≈ 3.8 strength an hour against the defender's 2.2, so a set
// piece of three weeks costs the attacker about twice what it costs the defender and takes a province only where
// its depth outlasts the defender's by more than (1 - p) / p.
//
// Armies. A nation with divisions but no army forms one ('army' order, named for its count, under the first of its
// generals without a command) and puts its divisions in it, so a nation that starts without armies is commanded too;
// later divisions in no army join the army furthest below its share (above).
//
// Rules: integer math, id order, work capped at WORK units per nation per day (the best plan found so far stands).
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).operations = api; }
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const G = NODE ? null : globalThis.Conquest;
  const M = NODE ? require('../mapdata.js') : G.mapdata;
  const U = NODE ? require('../units.js') : G.units;
  const MV = NODE ? require('../movement.js') : G.movement;
  const CB = NODE ? require('../combat.js') : G.combat;
  const T = NODE ? require('../tick.js') : G.tick;
  const B = NODE ? require('./mil-common.js') : G.ai.mil;
  const X = NODE ? require('./explain.js') : G.ai.explain;

  const WORK = 120000;
  const MOVES = 6;
  const PLAN_ODDS = 470;
  const OFF_ODDS = 400;
  const SUP_OFF = 350;
  const REST = 72;
  const DECAY = 80;
  const GUARD = 3;
  const QUIET = 250;
  const RESERVE = 2;
  const QUIET_SHARE = 10;
  const QUIET_PRESS = 8;
  const EXP_MIN = 3;
  const EXP_CAP = 2000;
  const EXP_RANGE = 2000;
  const LAND_CANDS = 6;
  const SEA_HELD = 300;
  const SEA_CONTESTED = 600;
  const PORT = 200;
  const LANDING = 900;
  const SHARE_GAP = 1000;
  const SHARE_HOPS = 5;
  const FRONT_HOPS = 3;
  const PUSH_K = 6;
  const PUSH_MAX = 2;
  const PUSH_ODDS = 220;
  const PUSH_GAP = 70;
  const PUSH_HOURS = 240;
  const PUSH_DAYS = 21;
  const PUSH_REST = 24 * 75;
  const OPEN_REST = 24 * 21;
  const VALUE = { ownCapital: 2000, ownLand: 200, capital: 1000, allyCapital: 500, hub: 400, mil: 120, milCap: 600, cut: 300, cutCap: 1500 };

  function run(ctx, n) {
    const { state } = ctx;
    const nat = state.nations[n];
    const ops = nat.ai.ops || (nat.ai.ops = { plans: [], rest: [] });
    const rel = M.relations(state);
    const v = B.view(ctx);
    const budget = { left: WORK, legs: new Map(nat.ai.legs || []) };
    const tg = B.targets(ctx, n, rel);
    if (!nat.armies.length && state.divs.some((d) => d.nation === n && !d.manual)) form(ctx, n);
    const armies = nat.armies.map((a) => ({ army: a, divs: B.usable(ctx, a) }));
    if (!armies.some((a) => a.divs.length)) return;
    const { plan, moving } = fronts(ctx, v, rel, n, tg, armies, ops, budget);
    for (const a of armies) {
      const provs = plan.get(a.army.id).provs;
      if (!same(a.army.front, provs)) B.order(ctx, n, { type: 'front', army: a.army.id, provinces: provs.length ? provs : null });
    }
    rebalance(ctx, v, rel, n, armies, plan, budget, moving);
    offensives(ctx, v, rel, n, armies, tg, ops, budget);
  }

  // The fronts of n's `armies` ([{ army, divs }]): army id -> { provs (ascending), need }, and whether there is a line
  // to move to. It changes nothing but ops.exp (the expedition's army), so the staff's query (queries.suggestFronts)
  // runs it on a copy of that memory and gives the player what this layer gives an AI nation.
  function fronts(ctx, v, rel, n, tg, armies, ops, budget) {
    const { state } = ctx;
    const core = M.facts(ctx).core[n];
    const colony = (p) => state.prov.owner[p] === n && core[p] !== 1;
    const W = watched(ctx, rel, n);
    const needOf = (p) => {
      if (!colony(p)) return 1000 + pressure(ctx, v, rel, n, tg, p, W);
      const x = pressure(ctx, v, rel, n, tg, p);
      return (x > 0 || facesHome(ctx, rel, n, p) ? 1000 : QUIET) + x;
    };
    const C0 = W ? watchLine(ctx, v, rel, n, tg, W) : B.contact(ctx, v, rel, n, tg);
    const need0 = C0.map(needOf);
    const region = regions(ctx, rel, n, budget);
    shared(ctx, v, rel, n, tg, C0, need0, budget);
    const keep = new Uint8Array(C0.length);
    for (const comp of parts(ctx, C0, budget)) if (comp.some((i) => need0[i] >= 1000)) for (const i of comp) keep[i] = 1;
    const C = C0.filter((p, i) => keep[i]);
    const need = need0.filter((x, i) => keep[i]);
    const exp = expedition(ctx, v, rel, n, tg, armies, C, need, ops);
    const own = exp ? armies.filter((a) => a !== exp.a) : armies;
    const plan = allocate(ctx, n, own, C, need, budget, region);
    guardCapital(ctx, v, rel, n, own, plan, budget);
    if (exp) plan.set(exp.a.army.id, { provs: exp.provs, need: exp.provs.reduce((s, p) => s + needOf(p), 0) });
    return { plan, moving: C.length > 0 || !!exp };
  }

  function expedition(ctx, v, rel, n, tg, armies, C, need, ops) {
    const { state } = ctx;
    const m = M.of(ctx);
    const ctrl = state.prov.ctrl;
    let total = 0;
    for (const a of armies) total += a.army.divs.length;
    let press = 0;
    let hot = 0;
    C.forEach((p, i) => { if (need[i] > 1000) { hot++; press += need[i] - 1000; } });
    const spare = total - Math.trunc(((C.length - hot) / 4 + hot + Math.trunc(press / 1000)) * 3 / 2) - RESERVE;
    if (armies.length < 2 || spare < EXP_MIN || hot * QUIET_SHARE > total || Math.trunc(press / 1000) * QUIET_PRESS > total) { ops.exp = 0; return null; }
    const list = [];
    for (let b = 0; b < state.nations.length; b++) {
      if (b === n || !state.nations[b].alive || !M.camp(rel, n, b)) continue;
      for (let i = v.start[b]; i < v.start[b + 1]; i++) {
        const p = v.owned[i];
        for (const q of m.adj[p]) if (!m.sea[q] && B.faced(tg, rel, n, ctrl[q]) && B.hostileStr(ctx, v, rel, n, q) > 0) { list.push(p); break; }
      }
    }
    const cap = centroid(ctx, [ctx.scenario.nations[n].capital]);
    const P = ctx.map.provinces;
    const at = (p) => ({ x: Math.trunc(P[p].x), y: Math.trunc(P[p].y) });
    const near = list.filter((p) => dist2(at(p), cap) <= EXP_RANGE * EXP_RANGE);
    if (!near.length) { ops.exp = 0; return null; }
    list.length = 0;
    list.push(...near);
    let anchor = list[0];
    for (const p of list) if (dist2(at(p), cap) < dist2(at(anchor), cap)) anchor = p;
    const A = at(anchor);
    const provs = list.sort((x, y) => dist2(at(x), A) - dist2(at(y), A) || x - y).slice(0, Math.max(2, Math.trunc((spare + 1) / 2))).sort((x, y) => x - y);
    let a = armies.find((x) => x.army.id === ops.exp);
    if (!a) for (const x of armies) if (x.divs.length && (!a || dist2(centroid(ctx, x.divs.map((d) => d.prov)), A) < dist2(centroid(ctx, a.divs.map((d) => d.prov)), A))) a = x;
    if (!a || !a.divs.length) { ops.exp = 0; return null; }
    if (!MV.search(ctx, rel, a.divs[0], anchor, { own: true, cap: EXP_CAP }).path) { ops.exp = 0; return null; }
    ops.exp = a.army.id;
    return { a, provs };
  }

  // The shared line: provinces of n's bloc partners within SHARE_HOPS provinces of n's own land over camp land, next
  // to hostile divisions of a nation n faces, where the pressure
  // there (pressure()) exceeds what the partner's camp, n's divisions apart, holds there by more than SHARE_GAP; each
  // joins n's contact line with that excess as its need, so a strong ally props up a weak one along a common front.
  function shared(ctx, v, rel, n, tg, C, need, budget) {
    const { state } = ctx;
    const m = M.of(ctx);
    const ctrl = state.prov.ctrl;
    const bloc = state.nations[n].bloc;
    if (!bloc) return;
    // Camp land within SHARE_HOPS provinces of land n holds.
    const s = B.marks(ctx, 8);
    const g = B.fresh(s);
    let qt = 0;
    for (let i = v.start[n]; i < v.start[n + 1]; i++) { const p = v.owned[i]; s.mark[p] = g; s.val[p] = 0; s.queue[qt++] = p; }
    for (let qh = 0; qh < qt; qh++) {
      const p = s.queue[qh];
      budget.left--;
      if (s.val[p] >= SHARE_HOPS) continue;
      for (const q of m.adj[p]) if (s.mark[q] !== g && !m.sea[q] && M.camp(rel, n, ctrl[q])) { s.mark[q] = g; s.val[q] = s.val[p] + 1; s.queue[qt++] = q; }
    }
    const add = [];
    for (let b = 0; b < state.nations.length; b++) {
      if (b === n || !state.nations[b].alive || state.nations[b].bloc !== bloc || !M.camp(rel, n, b)) continue;
      for (let i = v.start[b]; i < v.start[b + 1]; i++) {
        const p = v.owned[i];
        if (s.mark[p] !== g || !m.adj[p].some((q) => !m.sea[q] && B.faced(tg, rel, n, ctrl[q]) && B.hostileStr(ctx, v, rel, n, q) > 0)) continue;
        let held = 0;
        for (let j = v.head[p]; j >= 0; j = v.next[j]) { const d = state.divs[j]; if (d.nation !== n && M.camp(rel, n, d.nation)) held += d.str; }
        const x = 1000 + pressure(ctx, v, rel, n, tg, p) - held;
        if (x > SHARE_GAP) add.push([p, x]);
      }
    }
    if (!add.length) return;
    const all = C.map((p, i) => [p, need[i]]).concat(add).sort((a, b) => a[0] - b[0]);
    C.length = 0;
    need.length = 0;
    for (const [p, x] of all) { C.push(p); need.push(x); }
  }

  function form(ctx, n) {
    const nat = ctx.state.nations[n];
    const free = (ctx.scenario.nations[n].generals || []).find((g) => !nat.armies.some((a) => a.general === g.name));
    const r = B.order(ctx, n, { type: 'army', name: `Army ${nat.armies.length + 1}`, general: free ? free.name : null });
    if (!r.ok) return;
    for (const d of ctx.state.divs) if (d.nation === n && !d.manual && d.army === null) B.order(ctx, n, { type: 'assign', div: d.id, army: r.id });
  }

  // Land next to land a hostile nation holds that is a core of that nation or n's own: a colony there is a front even
  // while no division stands across it, and is held like a core when no army stands in its region.
  function facesHome(ctx, rel, n, p) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const core = M.facts(ctx).core;
    return m.adj[p].some((q) => !m.sea[q] && ctrl[q] >= 0 && M.hostile(rel, n, ctrl[q]) && (core[ctrl[q]][q] === 1 || ctx.state.prov.owner[q] === n));
  }

  // The nations n watches while it is at war: not at war with n and not of its camp, but allied to a nation n is at
  // war with, so the next to join that war (France while Germany fights only Russia), or the one a scenario event
  // that has not fired has n declare war on (Belgium for Germany: the armies massed for the march stay at that
  // border instead of leaving it open for the day before the declaration). null when there is none.
  function watched(ctx, rel, n) {
    const nations = ctx.state.nations;
    const k = rel.k;
    let W = null;
    for (let e = 0; e < k; e++) {
      if (!M.hostile(rel, n, e) || !nations[e].alive) continue;
      for (let w = 0; w < k; w++) {
        if (w === n || w === e || !nations[w].alive || !M.camp(rel, e, w) || M.hostile(rel, n, w) || M.camp(rel, n, w)) continue;
        (W || (W = new Uint8Array(k)))[w] = 1;
      }
    }
    if (!rel.belligerent[n]) return W;
    const tag = nations[n].tag;
    const fired = ctx.state.fired || [];
    for (const ev of ctx.scenario.events || []) {
      if (!ev || fired.includes(ev.id)) continue;
      for (const e of ev.effects || []) {
        if (!e || !Array.isArray(e.declareWar) || e.declareWar[0] !== tag) continue;
        const w = nations.findIndex((x) => x.tag === e.declareWar[1]);
        if (w < 0 || w === n || !nations[w].alive || M.hostile(rel, n, w) || M.camp(rel, n, w)) continue;
        (W || (W = new Uint8Array(k)))[w] = 1;
      }
    }
    return W;
  }

  // The contact line with the home provinces of n next to land a watched nation holds, ascending: a border that is
  // about to be a front keeps its armies instead of losing them all to the war that has already begun.
  function watchLine(ctx, v, rel, n, tg, W) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const core = M.facts(ctx).core[n];
    const out = [];
    for (let i = v.start[n]; i < v.start[n + 1]; i++) {
      const p = v.owned[i];
      for (const q of m.adj[p]) {
        if (m.sea[q]) continue;
        const c = ctrl[q];
        if (B.faced(tg, rel, n, c) || (c >= 0 && W[c] === 1 && core[p] === 1)) { out.push(p); break; }
      }
    }
    return out;
  }

  // The strength of the divisions of watched nations in q, in full: by the time they join they have mobilised.
  function watchStr(ctx, v, W, q) {
    const divs = ctx.state.divs;
    let s = 0;
    for (let i = v.head[q]; i >= 0; i = v.next[i]) if (W[divs[i].nation] === 1) s += divs[i].str;
    return s;
  }

  // What stands against p. With W (the watched nations) their divisions count as well, at full weight.
  function pressure(ctx, v, rel, n, tg, p, W = null) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const against = (c) => M.hostile(rel, n, c) || (W !== null && c >= 0 && W[c] === 1);
    const str = (q) => B.hostileStr(ctx, v, rel, n, q) + (W === null ? 0 : watchStr(ctx, v, W, q));
    let s = 0;
    for (const q of m.adj[p]) {
      if (m.sea[q]) continue;
      const c = ctrl[q];
      const w = B.faced(tg, rel, n, c) ? tg.weight[c] : W !== null && c >= 0 && W[c] === 1 ? 1000 : 500;
      s += Math.trunc((str(q) * w) / 1000);
      if (!against(c)) continue;
      // Hostile divisions one province further back count at half: what is coming, not only what is there.
      for (const r of m.adj[q]) {
        if (r === p || m.sea[r] || !against(ctrl[r]) || m.adj[p].includes(r)) continue;
        s += Math.trunc((str(r) * w) / 2000);
      }
    }
    return s;
  }

  const same = (a, b) => (a === null ? b.length === 0 : a.length === b.length && a.every((x, i) => x === b[i]));

  function centroid(ctx, provs) {
    const P = ctx.map.provinces;
    let x = 0;
    let y = 0;
    for (const p of provs) { x += Math.trunc(P[p].x); y += Math.trunc(P[p].y); }
    return provs.length ? { x: Math.trunc(x / provs.length), y: Math.trunc(y / provs.length) } : { x: 0, y: 0 };
  }
  const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

  // The connected parts of the contact line, each as indexes into C in chain order from an end.
  function parts(ctx, C, budget) {
    const m = M.of(ctx);
    const s = B.marks(ctx, 3);
    const g = B.fresh(s);
    C.forEach((p, i) => { s.mark[p] = g; s.val[p] = i; });
    const idx = (p) => (s.mark[p] === g ? s.val[p] : -1);
    const seen = new Uint8Array(C.length);
    const out = [];
    const walk = (start, mark) => {
      const list = [start];
      mark[start] = 1;
      for (let h = 0; h < list.length; h++) {
        budget.left--;
        for (const q of m.adj[C[list[h]]]) { const j = idx(q); if (j >= 0 && !mark[j]) { mark[j] = 1; list.push(j); } }
      }
      return list;
    };
    for (let i = 0; i < C.length; i++) {
      if (seen[i]) continue;
      const members = walk(i, seen);
      let end = members[0];
      let endDeg = Infinity;
      for (const j of members) {
        let deg = 0;
        for (const q of m.adj[C[j]]) if (idx(q) >= 0) deg++;
        if (deg < endDeg || (deg === endDeg && C[j] < C[end])) { end = j; endDeg = deg; }
      }
      const mark = new Uint8Array(C.length);
      out.push(walk(end, mark));
    }
    return out;
  }

  // Labels each land province n's camp controls with its connected region of camp land (1-based, numbered from the
  // lowest province id); 0 elsewhere. Spends one work unit per province labelled.
  function regions(ctx, rel, n, budget) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const s = B.marks(ctx, 6);
    const g = B.fresh(s);
    let label = 0;
    for (let p0 = 1; p0 < m.n; p0++) {
      if (s.mark[p0] === g || m.sea[p0] || !M.camp(rel, n, ctrl[p0])) continue;
      label++;
      let qt = 0;
      s.mark[p0] = g; s.val[p0] = label; s.queue[qt++] = p0;
      for (let qh = 0; qh < qt; qh++) {
        budget.left--;
        for (const q of m.adj[s.queue[qh]]) {
          if (s.mark[q] === g || m.sea[q] || !M.camp(rel, n, ctrl[q])) continue;
          s.mark[q] = g; s.val[q] = label; s.queue[qt++] = q;
        }
      }
    }
    return (p) => (s.mark[p] === g ? s.val[p] : 0);
  }

  // army id -> { provs (ascending), need }: the sections of the contact line each army holds.
  function allocate(ctx, n, armies, C, need, budget, region = null) {
    const core = M.facts(ctx).core[n];
    const out = new Map(armies.map((a) => [a.army.id, { provs: [], need: 0 }]));
    if (!C.length) {
      const cap = ctx.scenario.nations[n].capital;
      const ctrl = ctx.state.prov.ctrl;
      for (const a of armies) {
        const provs = [...new Set(a.divs.map((d) => d.prov).filter((p) => ctrl[p] === n))].sort((x, y) => x - y);
        if (!provs.length && cap && ctrl[cap] === n) provs.push(cap);
        out.set(a.army.id, { provs, need: 1000 * provs.length });
      }
      return out;
    }
    const rel = M.relations(ctx.state);
    if (!region) region = regions(ctx, rel, n, budget);
    const comps = parts(ctx, C, budget);
    const A = armies.length;
    const J = comps.length;
    const compNeed = comps.map((c) => c.reduce((x, i) => x + need[i], 0));
    const compRegion = comps.map((c) => region(C[c[0]]));
    const compOf = new Map();
    comps.forEach((c, j) => { for (const i of c) compOf.set(C[i], j); });
    // Where each army is now: the part its front overlaps most, else the region most of its divisions stand in.
    const cur = new Int32Array(A).fill(-1);
    const home = new Int32Array(A);
    armies.forEach((a, ai) => {
      const ov = new Int32Array(J);
      for (const p of a.army.front || []) { const j = compOf.get(p); if (j !== undefined) ov[j]++; }
      for (let j = 0; j < J; j++) if (ov[j] > 0 && (cur[ai] < 0 || ov[j] > ov[cur[ai]])) cur[ai] = j;
      if (cur[ai] >= 0) { home[ai] = compRegion[cur[ai]]; return; }
      const count = new Map();
      for (const d of a.divs) { const r = region(d.prov); if (r) count.set(r, (count.get(r) || 0) + 1); }
      let r0 = 0;
      for (const [r, x] of count) if (!r0 || x > count.get(r0) || (x === count.get(r0) && r < r0)) r0 = r;
      home[ai] = r0;
    });
    // Armies per part: within a region, its armies by largest remainder on need. An army keeps its part while that
    // part has no more than one army over its share, so a shift of need does not send armies across the map every
    // day; an army of a region with no part of the line goes where the need per army is highest.
    const byRegion = new Map();
    comps.forEach((c, j) => { if (!byRegion.has(compRegion[j])) byRegion.set(compRegion[j], []); byRegion.get(compRegion[j]).push(j); });
    const target = new Int32Array(J);
    const owners = comps.map(() => []);
    const free = [];
    const idle = [];
    const pos = armies.map((a) => centroid(ctx, a.divs.length ? a.divs.map((d) => d.prov) : a.army.front || []));
    const at = comps.map((c) => centroid(ctx, c.map((i) => C[i])));
    for (let ai = 0; ai < A; ai++) {
      if (!byRegion.has(home[ai])) idle.push(ai);
      else if (cur[ai] >= 0) owners[cur[ai]].push(ai);
      else free.push(ai);
    }
    for (const [r, js] of byRegion) {
      let k = 0;
      for (let ai = 0; ai < A; ai++) if (home[ai] === r) k++;
      const sum = js.reduce((x, j) => x + compNeed[j], 0);
      if (!k || !sum) continue;
      const rem = [];
      let given = 0;
      for (const j of js) { const q = Math.trunc((k * compNeed[j]) / sum); target[j] += q; given += q; rem.push([(k * compNeed[j]) % sum, j]); }
      rem.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
      for (let i = 0; given < k; i++, given++) target[rem[i % rem.length][1]]++;
    }
    for (let j = 0; j < J; j++) {
      if (owners[j].length <= target[j] + 1) continue;
      owners[j].sort((x, y) => dist2(pos[x], at[j]) - dist2(pos[y], at[j]) || x - y);
      while (owners[j].length > target[j]) free.push(owners[j].pop());
    }
    const short = (j) => target[j] - owners[j].length;
    free.sort((x, y) => x - y);
    // A free army takes the nearest part of its region that is short of armies, the closest pair first, so the
    // armies that stand at a border are the ones that hold it; what is left when no part is short goes as before.
    for (;;) {
      let bx = -1;
      let bj = -1;
      let bd = 0;
      for (let x = 0; x < free.length; x++) {
        for (const j of byRegion.get(home[free[x]])) {
          if (short(j) <= 0) continue;
          const d = dist2(pos[free[x]], at[j]);
          if (bx < 0 || d < bd) { bx = x; bj = j; bd = d; }
        }
      }
      if (bx < 0) break;
      owners[bj].push(free.splice(bx, 1)[0]);
    }
    for (const ai of free) {
      let best = -1;
      for (const j of byRegion.get(home[ai])) if (best < 0 || short(j) > short(best) || (short(j) === short(best) && dist2(pos[ai], at[j]) < dist2(pos[ai], at[best]))) best = j;
      owners[best].push(ai);
    }
    for (const ai of idle) {
      let best = 0;
      for (let j = 1; j < J; j++) if (compNeed[j] * (owners[best].length + 1) > compNeed[best] * (owners[j].length + 1)) best = j;
      owners[best].push(ai);
    }
    // A part with several armies is cut, as a chain from one end, into sections of equal length, each to the army
    // whose front overlaps it most (the nearest on a tie); a part with no army joins the nearest section of its
    // region, and is left to nobody when its region has no army.
    const info = [];
    comps.forEach((c, j) => {
      if (!owners[j].length) return;
      const cuts = Math.min(owners[j].length, c.length);
      const pieces = [];
      let piece = [];
      for (let i = 0; i < c.length; i++) {
        piece.push(c[i]);
        if (pieces.length < cuts - 1 && (i + 1) * cuts >= c.length * (pieces.length + 1)) { pieces.push(piece); piece = []; }
      }
      if (piece.length) pieces.push(piece);
      const left = owners[j].slice();
      const mine = [];
      for (const pc of pieces) {
        const provs = pc.map((i) => C[i]).sort((a, b) => a - b);
        const sec = { j, provs, need: pc.reduce((s, i) => s + need[i], 0), at: centroid(ctx, provs), owners: [] };
        let bi = -1;
        let bov = -1;
        for (let x = 0; x < left.length; x++) {
          const front = new Set(armies[left[x]].army.front || []);
          let ov = 0;
          for (const p of provs) if (front.has(p)) ov++;
          if (bi < 0 || ov > bov || (ov === bov && dist2(pos[left[x]], sec.at) < dist2(pos[left[bi]], sec.at))) { bi = x; bov = ov; }
        }
        if (bi >= 0) sec.owners.push(left.splice(bi, 1)[0]);
        mine.push(sec);
      }
      for (const ai of left) {
        let best = mine[0];
        for (const sec of mine) if (sec.need * (best.owners.length + 1) > best.need * (sec.owners.length + 1)) best = sec;
        best.owners.push(ai);
      }
      info.push(...mine);
    });
    comps.forEach((c, j) => {
      if (owners[j].length) return;
      let best = null;
      for (const sec of info) if (compRegion[sec.j] === compRegion[j] && (!best || dist2(sec.at, at[j]) < dist2(best.at, at[j]))) best = sec;
      if (!best) {
        // The army with the most divisions standing in that region takes it; with none there, a part holding a
        // core of the nation goes to the nearest section anywhere (the general ships divisions to it).
        let ai0 = -1;
        let most = 0;
        armies.forEach((a, ai) => { let x = 0; for (const d of a.divs) if (region(d.prov) === compRegion[j]) x++; if (x > most) { most = x; ai0 = ai; } });
        if (ai0 >= 0) for (const sec of info) if (sec.owners.includes(ai0) && (!best || dist2(sec.at, at[j]) < dist2(best.at, at[j]))) best = sec;
        if (!best && c.some((i) => core[C[i]] === 1 || (ctx.state.prov.owner[C[i]] === n && facesHome(ctx, rel, n, C[i])))) for (const sec of info) if (!best || dist2(sec.at, at[j]) < dist2(best.at, at[j])) best = sec;
      }
      if (!best) return;
      best.provs = best.provs.concat(c.map((i) => C[i])).sort((x, y) => x - y);
      best.need += compNeed[j];
    });
    for (const sec of info) {
      for (const ai of sec.owners) {
        const o = out.get(armies[ai].army.id);
        o.provs.push(...sec.provs);
        o.need += Math.trunc(sec.need / sec.owners.length);
      }
    }
    for (const o of out.values()) o.provs.sort((a, b) => a - b);
    return out;
  }

  // A capital off the contact line joins the front of the nearest army once hostile divisions come within GUARD
  // provinces of it.
  function guardCapital(ctx, v, rel, n, armies, plan, budget) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const cap = ctx.scenario.nations[n].capital;
    if (!cap || ctrl[cap] !== n || [...plan.values()].some((o) => o.provs.includes(cap))) return;
    let near = false;
    B.spread(ctx, rel, n, cap, GUARD, budget, (p) => {
      if (B.hostileStr(ctx, v, rel, n, p) > 0) near = true;
      for (const q of m.adj[p]) if (!m.sea[q] && M.hostile(rel, n, ctrl[q]) && B.hostileStr(ctx, v, rel, n, q) > 0) near = true;
      return near;
    });
    if (!near) return;
    const at = centroid(ctx, [cap]);
    let best = armies[0];
    let bestD = -1;
    for (const a of armies) {
      const d = dist2(centroid(ctx, a.divs.map((x) => x.prov)), at);
      if (bestD < 0 || d < bestD) { best = a; bestD = d; }
    }
    const o = plan.get(best.army.id);
    o.provs = o.provs.concat([cap]).sort((x, y) => x - y);
    o.need += 3000;
  }

  function rebalance(ctx, v, rel, n, armies, plan, budget, moving) {
    const { state } = ctx;
    const loose = state.divs.filter((d) => d.nation === n && d.army === null && !d.manual && d.str > 0);
    const count = armies.map((a) => a.army.divs.length);
    const needs = armies.map((a) => plan.get(a.army.id).need);
    const total = count.reduce((s, x) => s + x, 0) + loose.length;
    const sum = needs.reduce((s, x) => s + x, 0);
    const lens = needs.map((x) => Math.trunc((x + 999) / 1000));
    const L = lens.reduce((s, x) => s + x, 0);
    const want = total >= L
      ? needs.map((x, i) => lens[i] + (sum ? Math.trunc(((total - L) * x) / sum) : 0))
      : lens.map((x) => Math.trunc((total * x) / L));
    const gap = (i) => want[i] - count[i];
    const holder = new Map();
    armies.forEach((a, i) => { for (const p of plan.get(a.army.id).provs) if (!holder.has(p)) holder.set(p, i); });
    armies.forEach((a, i) => {
      const own = new Set(plan.get(a.army.id).provs);
      for (const d of a.divs) {
        const at = B.goalOf(budget, d);
        const j = holder.has(at) ? holder.get(at) : -1;
        if (j < 0 || j === i || own.has(at) || gap(j) <= -1 || v.defending.has(d.id)) continue;
        if (!B.order(ctx, n, { type: 'assign', div: d.id, army: armies[j].army.id }).ok) continue;
        count[i]--;
        count[j]++;
      }
    });
    for (const d of loose) {
      let best = 0;
      for (let i = 1; i < armies.length; i++) if (gap(i) > gap(best)) best = i;
      if (B.order(ctx, n, { type: 'assign', div: d.id, army: armies[best].army.id }).ok) count[best]++;
    }
    if (armies.length < 2 || !sum || !moving) return;
    for (let k = 0; k < MOVES; k++) {
      let give = 0;
      let take = 0;
      for (let i = 1; i < armies.length; i++) {
        if (gap(i) < gap(give)) give = i;
        if (gap(i) > gap(take)) take = i;
      }
      if (gap(give) > -1 || gap(take) < 1) break;
      const to = centroid(ctx, plan.get(armies[take].army.id).provs);
      const P = ctx.map.provinces;
      let pick = null;
      let pickD = 0;
      for (const d of armies[give].divs) {
        if (!B.ready(d) || d.to !== null || v.defending.has(d.id) || d.army !== armies[give].army.id) continue;
        if (B.touchesHostile(ctx, rel, n, d.prov) && alone(state, v, d)) continue;
        const dd = dist2({ x: Math.trunc(P[d.prov].x), y: Math.trunc(P[d.prov].y) }, to);
        if (!pick || dd < pickD) { pick = d; pickD = dd; }
      }
      if (!pick || !B.order(ctx, n, { type: 'assign', div: pick.id, army: armies[take].army.id }).ok) break;
      count[give]--;
      count[take]++;
    }
  }

  function alone(state, v, d) {
    for (let i = v.head[d.prov]; i >= 0; i = v.next[i]) { const o = state.divs[i]; if (o !== d && o.nation === d.nation && o.to === null) return false; }
    return true;
  }

  // Hostile land of tgt's camp whose loss would cut divisions of that camp off from tgt's capital and hubs: the
  // articulation points of that land with a virtual root joined to the sources, valued by the strength beyond them.
  function cuts(ctx, v, rel, tgt, budget) {
    const m = M.of(ctx);
    const { state } = ctx;
    const ctrl = state.prov.ctrl;
    const n = m.n;
    const f = M.facts(ctx);
    const inside = (p) => p > 0 && !m.sea[p] && M.camp(rel, tgt, ctrl[p]);
    const src = new Uint8Array(n);
    const roots = [];
    const cap = f.capital[tgt];
    if (cap && ctrl[cap] === tgt) { src[cap] = 1; roots.push(cap); }
    for (let i = v.start[tgt]; i < v.start[tgt + 1]; i++) { const p = v.owned[i]; if (f.hub[p] && !src[p]) { src[p] = 1; roots.push(p); } }
    roots.sort((a, b) => a - b);
    const cut = new Int32Array(n);
    if (!roots.length) return cut;
    const disc = new Int32Array(n);
    const low = new Int32Array(n);
    const par = new Int32Array(n);
    const it = new Int32Array(n);
    const sub = new Int32Array(n);
    const stack = [0];
    let time = 1;
    let rootIt = 0;
    while (stack.length) {
      if (budget.left <= 0) return cut;
      const u = stack[stack.length - 1];
      const list = u === 0 ? roots : m.adj[u];
      const i = u === 0 ? rootIt : it[u];
      if (i < list.length) {
        if (u === 0) rootIt++; else it[u]++;
        const w = list[i];
        if (!inside(w)) continue;
        if (!disc[w]) {
          budget.left--;
          disc[w] = low[w] = ++time;
          par[w] = u;
          if (src[w] && u !== 0) low[w] = 1;
          for (let j = v.head[w]; j >= 0; j = v.next[j]) if (M.camp(rel, tgt, state.divs[j].nation)) sub[w] += state.divs[j].str;
          stack.push(w);
        } else if (w !== par[u] && disc[w] < low[u]) low[u] = disc[w];
      } else {
        stack.pop();
        if (u === 0) continue;
        const p = par[u];
        if (p === 0) continue;
        if (low[u] < low[p]) low[p] = low[u];
        sub[p] += sub[u];
        if (low[u] >= disc[p]) cut[p] += sub[u];
      }
    }
    return cut;
  }

  const goalsOf = new WeakMap();
  function goalValue(ctx, n) {
    let byNation = goalsOf.get(ctx.scenario);
    if (!byNation) { byNation = []; goalsOf.set(ctx.scenario, byNation); }
    if (!byNation[n]) {
      const g = new Map();
      for (const goal of ctx.scenario.nations[n].goals || []) {
        if (goal.kind !== 'take' || !Array.isArray(goal.provinces)) continue;
        for (const p of goal.provinces) g.set(p, (g.get(p) || 0) + Math.max(0, Math.min(1000, goal.weight | 0)));
      }
      byNation[n] = g;
    }
    return byNation[n];
  }

  // For hostile land of tgt's camp: val[p] = the best VALUE of a province there less DECAY per province between, the
  // province it comes from (src) and how much of that value is the cut-off strength behind it (cutv).
  function field(ctx, v, rel, n, tgt, budget) {
    const m = M.of(ctx);
    const { state } = ctx;
    const P = state.prov;
    const f = M.facts(ctx);
    const N = m.n;
    const region = (p) => p > 0 && !m.sea[p] && M.camp(rel, tgt, P.ctrl[p]) && M.hostile(rel, n, P.ctrl[p]);
    const cut = cuts(ctx, v, rel, tgt, budget);
    const goals = goalValue(ctx, n);
    const val = new Int32Array(N).fill(-1);
    const src = new Int32Array(N);
    const cutv = new Int32Array(N);
    const h = M.heap();
    const k = state.nations.length;
    const caps = new Int32Array(N);
    for (let a = 0; a < k; a++) {
      const c = f.capital[a];
      if (c && M.camp(rel, tgt, a) && region(c)) caps[c] = Math.max(caps[c], a === tgt ? VALUE.capital : VALUE.allyCapital);
    }
    for (let a = 0; a < k; a++) {
      if (!M.camp(rel, tgt, a) || !M.hostile(rel, n, a)) continue;
      for (let i = v.start[a]; i < v.start[a + 1]; i++) {
        const p = v.owned[i];
        const cv = Math.min(VALUE.cutCap, Math.trunc((cut[p] * VALUE.cut) / 1000));
        const own = P.owner[p] === n ? (p === f.capital[n] ? VALUE.ownCapital : VALUE.ownLand) : 0;
        const V = own + caps[p] + (f.hub[p] ? VALUE.hub : 0) + Math.min(VALUE.milCap, P.mil[p] * VALUE.mil) + (goals.get(p) || 0) + cv;
        if (V <= 0) continue;
        val[p] = V; src[p] = p; cutv[p] = cv;
        h.push(-V, p);
      }
    }
    while (h.size) {
      if (budget.left <= 0) break;
      budget.left--;
      const p = h.pop();
      if (-h.key !== val[p]) continue;
      const nv = val[p] - DECAY;
      if (nv <= 0) continue;
      for (const q of m.adj[p]) {
        if (!region(q) || nv <= val[q]) continue;
        val[q] = nv; src[q] = src[p]; cutv[q] = Math.min(cutv[src[p]], nv);
        h.push(-nv, q);
      }
    }
    return { val, src, cutv };
  }

  // What general.js's strike group of k divisions like rep would face attacking e: the odds with every modifier and
  // with each of terrain, river and trenches taken out, for the explanation.
  function estimate(ctx, v, rel, n, rep, e, k) {
    const m = M.of(ctx);
    const { rules, state } = ctx;
    const stage = B.staging(ctx, rel, n, e);
    if (!stage.length) return fromSea(ctx, v, rel, n, rep, e, k);
    const from = stage[0];
    const s = U.statsOf(ctx, rep);
    const dirs = Math.min(3, stage.length);
    k = Math.min(k, CB.width(rules, dirs));
    const siege = s.siege;
    const def = B.defence(ctx, v, rel, n, e, siege, dirs);
    let reinf = 0;
    let reinfFlat = 0;
    for (const q of m.adj[e]) {
      if (m.sea[q] || !M.hostile(rel, n, state.prov.ctrl[q])) continue;
      for (let i = v.head[q]; i >= 0; i = v.next[i]) {
        const d = state.divs[i];
        if (d.str <= 0 || !M.hostile(rel, d.nation, n)) continue;
        reinf += Math.trunc(CB.defencePower(ctx, d, e, siege) / 3);
        reinfFlat += Math.trunc(CB.defencePower(ctx, d, e, 1000000) / 3);
      }
    }
    const A = Math.trunc((B.power(ctx, rep, from, e, def.counts) * k * (1000 + rules.combat.flank * (Math.min(3, stage.length) - 1))) / 1000);
    const terr = rules.terrain[m.terrain[e]];
    const riverF = m.river[from].includes(e) ? Math.min(1000, rules.combat.river + Math.min(rules.combat.riverCap, s.river)) : 1000;
    const odds = (a, d) => (a + d > 0 ? Math.trunc((a * 1000) / (a + d)) : 1000);
    const D = def.D + reinf;
    const flat = def.flat + reinfFlat;
    const unT = (x, f) => Math.trunc((x * 1000) / f);
    return {
      from, stage: stage.length, count: def.count,
      p: def.count || reinf ? odds(A, D) : 1000,
      pT: odds(unT(A, terr.attack), unT(D, terr.defence)),
      pR: odds(unT(A, riverF), D),
      pDig: odds(A, flat),
      pClean: odds(unT(unT(A, terr.attack), riverF), unT(flat, terr.defence)),
    };
  }

  // estimate() for a landing on e from its best open sea zone; null when every zone of e is denied to n.
  function fromSea(ctx, v, rel, n, rep, e, k) {
    const m = M.of(ctx);
    const { state } = ctx;
    let zone = 0;
    let sea = 0;
    for (const z of m.seaAdj[e]) {
      const c = state.sea.ctrl[z];
      if (c < 0 || !M.camp(rel, n, c)) continue;
      const s = SEA_HELD;
      if (!zone || s > sea) { zone = z; sea = s; }
    }
    if (!zone || !B.nearPort(ctx, rel, n, e)) return null;
    k = Math.min(k, CB.width(ctx.rules, 1));
    const siege = U.statsOf(ctx, rep).siege;
    const def = B.defence(ctx, v, rel, n, e, siege);
    let reinf = 0;
    for (const q of m.adj[e]) {
      if (m.sea[q] || !M.hostile(rel, n, state.prov.ctrl[q])) continue;
      for (let i = v.head[q]; i >= 0; i = v.next[i]) { const d = state.divs[i]; if (d.str > 0 && M.hostile(rel, d.nation, n)) reinf += Math.trunc(CB.defencePower(ctx, d, e, siege) / 3); }
    }
    const A = B.power(ctx, rep, zone, e, def.counts) * k;
    const D = def.D + reinf;
    const p = def.count || reinf ? (A + D > 0 ? Math.trunc((A * 1000) / (A + D)) : 1000) : 1000;
    const flat = def.flat + reinf;
    const pDig = def.count || reinf ? Math.trunc((A * 1000) / Math.max(1, A + flat)) : 1000;
    return { from: zone, stage: 0, count: def.count, p, pT: p, pR: p, pDig, pClean: pDig, landing: true, sea, port: m.port[e] ? PORT : -PORT };
  }

  // A home province of a great power (a core it owns) with a hostile division in it: no landing goes against that
  // coast, which the fleet cannot clear and the defender reinforces by land faster than ships can.
  function defendedHome(ctx, v, rel, n, e) {
    const o = ctx.state.prov.owner[e];
    if (o < 0 || !ctx.scenario.nations[o].major || M.facts(ctx).core[o][e] !== 1) return false;
    return B.hostileStr(ctx, v, rel, n, e) > 0;
  }

  // The enemy coastal provinces with no camp land next to them, the LAND_CANDS nearest the army.
  function shores(ctx, v, rel, n, divs, tg) {
    const m = M.of(ctx);
    const ctrl = ctx.state.prov.ctrl;
    const P = ctx.map.provinces;
    const c0 = centroid(ctx, divs.map((d) => d.prov));
    const out = [];
    for (let c = 0; c < ctx.state.nations.length; c++) {
      if (!tg.attack[c] || !M.hostile(rel, n, c)) continue;
      for (let i = v.start[c]; i < v.start[c + 1]; i++) {
        const p = v.owned[i];
        if (!m.seaAdj[p].length || m.adj[p].some((q) => !m.sea[q] && M.camp(rel, n, ctrl[q]))) continue;
        out.push([dist2({ x: Math.trunc(P[p].x), y: Math.trunc(P[p].y) }, c0), p]);
      }
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, LAND_CANDS).map((x) => x[1]);
  }

  function supplyOf(group) {
    if (!group.length) return 0;
    let s = 0;
    for (const d of group) s += d.sup;
    return Math.trunc(s / group.length);
  }

  function offensives(ctx, v, rel, n, armies, tg, ops, budget) {
    const { state } = ctx;
    const fields = new Map();
    const fieldOf = (t) => { if (!fields.has(t)) fields.set(t, field(ctx, v, rel, n, t, budget)); return fields.get(t); };
    ops.rest = ops.rest.filter((r) => r.until > state.hour);
    for (const { army, divs } of armies) {
      if (budget.left <= 0) break;
      const tr = B.trait(ctx, n, army);
      const front = army.front || [];
      const onFront = new Set(front);
      const usable = divs.filter((d) => !v.defending.has(d.id) && (B.ready(d) || (!B.worn(d) && onFront.has(B.goalOf(budget, d)))));
      const k = B.strikeSize(usable.length, B.menace(ctx, v, rel, n, front), B.shareOf(tr));
      const pi = ops.plans.findIndex((p) => p.army === army.id);
      if (pi >= 0) {
        const pl = ops.plans[pi];
        const off = army.offensives.find((o) => o.id === pl.offensive);
        if (off && off.on) {
          const why = review(ctx, v, rel, n, army, divs, off, pl, tg, k, budget);
          if (!why) continue;
          B.order(ctx, n, { type: 'launch', army: army.id, offensive: off.id, on: false });
          B.order(ctx, n, { type: 'offensive', army: army.id, offensive: off.id, path: null });
          X.record(ctx, n, {
            layer: 'operations',
            chosen: { label: 'offensive-called-off', args: { army: army.id, offensive: off.id, reason: why === 'front' ? 'posture' : why, province: pl.objective } },
            options: [], factors: [{ label: `stop-${why === 'front' ? 'posture' : why}`, args: {}, delta: -1000 }],
          });
          if (why !== 'done' || pl.push) ops.rest.push({ army: army.id, until: state.hour + (pl.push ? (pl.dug !== 0 ? PUSH_REST : OPEN_REST) : REST) });
        } else if (off) B.order(ctx, n, { type: 'offensive', army: army.id, offensive: off.id, path: null });
        ops.plans.splice(pi, 1);
      }
      if (ops.rest.some((r) => r.army === army.id) || k < 2) continue;
      propose(ctx, v, rel, n, army, divs, tg, ops, k, fieldOf, budget);
    }
    ops.plans.sort((a, b) => a.army - b.army);
    ops.rest.sort((a, b) => a.army - b.army);
  }

  function review(ctx, v, rel, n, army, divs, off, pl, tg, k, budget) {
    const ctrl = ctx.state.prov.ctrl;
    const t = B.frontier(ctx, rel, n, off, divs[0], budget);
    if (!t) return 'done';
    if (B.staging(ctx, rel, n, t).length && !nearFront(ctx, army.front, t)) return 'front';
    if (pl.push) {
      // A set piece runs for PUSH_DAYS, or until the shells for it are gone or the defence has stiffened past PUSH_ODDS.
      if (ctx.state.hour - pl.since >= PUSH_DAYS * 24 || !M.hostile(rel, n, ctrl[t])) return 'done';
      if ((ctx.state.nations[n].stock.shells | 0) < pl.push) return 'supply';
      const g = divs.filter((d) => !B.worn(d));
      const e = g.length ? estimate(ctx, v, rel, n, g[0], t, Math.max(1, k)) : null;
      if (!e || e.p < PUSH_ODDS - PUSH_GAP) { pl.bad++; return pl.bad >= 2 ? 'odds' : null; }
      pl.bad = 0;
      return null;
    }
    if (!M.hostile(rel, n, ctrl[t])) return 'blocked';
    if (!tg.attack[ctrl[t]]) return 'posture';
    const mine = new Set(divs.map((d) => d.id));
    const group = B.staging(ctx, rel, n, t).length ? B.nearest(ctx, v, rel, n, t, Math.max(1, k), (d) => mine.has(d.id) && !B.worn(d), budget) : divs.filter((d) => !B.worn(d)).slice(0, Math.max(1, k));
    if (supplyOf(group) < SUP_OFF) return 'supply';
    if (!B.staging(ctx, rel, n, t).length && defendedHome(ctx, v, rel, n, t)) return 'odds';
    const est = k > 0 && group.length ? estimate(ctx, v, rel, n, group[0], t, Math.max(1, k)) : null;
    if (!est || est.p < OFF_ODDS) { pl.bad++; return pl.bad >= 2 ? 'odds' : null; }
    pl.bad = 0;
    return null;
  }

  // The offensive's next province lies within FRONT_HOPS land provinces of the army's front (an army sent to another
  // front leaves the offensive it planned on the old one instead of marching its strike group across the map).
  function nearFront(ctx, front, t) {
    if (!front || !front.length) return true;
    const m = M.of(ctx);
    const goal = new Set(front);
    let ring = [t];
    const seen = new Set(ring);
    for (let h = 0; h <= FRONT_HOPS; h++) {
      const next = [];
      for (const p of ring) {
        if (goal.has(p)) return true;
        for (const q of m.adj[p]) if (!m.sea[q] && !seen.has(q)) { seen.add(q); next.push(q); }
      }
      ring = next;
    }
    return false;
  }

  // The set piece of the header, from the provinces propose() scored (best first).
  function setPiece(ctx, n, army, divs, ops, k, scored) {
    const { state } = ctx;
    if (k < PUSH_K || ops.plans.filter((p) => p.push).length >= PUSH_MAX) return;
    const rep = divs.find((d) => B.ready(d)) || divs[0];
    const fire = U.statsOf(ctx, rep).shells * Math.min(k, CB.width(ctx.rules, 3));
    const reserve = Math.max(1, fire * PUSH_HOURS);
    if ((state.nations[n].stock.shells | 0) < 2 * reserve) return;
    const best = scored.find((x) => !x.est.landing && x.est.p >= PUSH_ODDS);
    if (!best) return;
    const path = [best.e];
    const old = army.offensives.find((o) => o.path.length === 1 && o.path[0] === best.e);
    let id = old ? old.id : 0;
    if (!old) {
      const r = B.order(ctx, n, { type: 'offensive', army: army.id, path });
      if (!r.ok) return;
      id = r.id;
    }
    if (!B.order(ctx, n, { type: 'launch', army: army.id, offensive: id, on: true }).ok) return;
    ops.plans.push({ army: army.id, offensive: id, target: best.tgt, objective: best.e, since: state.hour, bad: 0, push: reserve, dug: MV.dugIn(state, best.e) ? 1 : 0 });
    X.record(ctx, n, {
      layer: 'operations',
      chosen: { label: 'offensive-toward', args: { army: army.id, offensive: id, province: best.e, from: best.est.from, to: best.e, nation: best.tgt } },
      options: scored.slice(0, 3).map((x) => ({ label: 'offensive-section', args: { from: x.est.from, to: x.e, province: x.objective }, score: x.score })),
      factors: [
        { label: 'strength-ratio', args: { odds: best.est.pClean }, delta: 2 * (best.est.pClean - 500) },
        { label: 'entrenchment', args: { province: best.e }, delta: 2 * (best.est.p - best.est.pDig) },
        { label: 'supply', args: {}, delta: best.supply },
      ],
    });
  }

  function propose(ctx, v, rel, n, army, divs, tg, ops, k, fieldOf, budget) {
    const m = M.of(ctx);
    const { state } = ctx;
    const P = state.prov;
    const front = army.front || [];
    const rep = divs.find((d) => B.ready(d)) || divs[0];
    if (supplyOf(divs) < SUP_OFF) return;
    const seen = new Set();
    const cands = [];
    for (const s of front) {
      for (const e of m.adj[s]) {
        if (m.sea[e] || seen.has(e)) continue;
        const c = P.ctrl[e];
        if (!M.hostile(rel, n, c) || !tg.attack[c]) continue;
        seen.add(e);
        cands.push(e);
      }
    }
    cands.sort((a, b) => a - b);
    if (k >= 2) for (const e of shores(ctx, v, rel, n, divs, tg)) if (!seen.has(e)) { seen.add(e); cands.push(e); }
    const caution = B.personality(ctx, n).caution;
    const floor = 100 + ((caution === undefined ? 50 : caution) - 50) * 4;
    const scored = [];
    for (const e of cands) {
      if (budget.left <= 0) break;
      budget.left -= 50;
      const est = estimate(ctx, v, rel, n, rep, e, k);
      if (!est || (est.landing && defendedHome(ctx, v, rel, n, e))) continue;
      const tgt = P.ctrl[e];
      const F = fieldOf(tgt);
      const value = Math.trunc((Math.max(0, F.val[e]) * tg.weight[tgt]) / 1000);
      const cutPart = Math.trunc((F.cutv[e] * tg.weight[tgt]) / 1000);
      const shortage = Math.trunc((1000 - Math.min(1000, P.supply[e])) / 4);
      const supply = est.landing ? shortage + est.sea + est.port - LANDING : Math.trunc((Math.min(P.supply[est.from], 2000) - 1000) / 4) + shortage;
      const score = 2 * (est.p - 500) + value + supply;
      scored.push({ e, est, tgt, value, cutPart, supply, score, objective: F.val[e] > 0 ? F.src[e] : e });
    }
    if (!scored.length) return;
    scored.sort((a, b) => b.score - a.score || a.e - b.e);
    const best = scored.find((x) => x.est.p >= PLAN_ODDS);
    if (!best || best.score < floor) { setPiece(ctx, n, army, divs, ops, k, scored); return; }
    let path = [best.e];
    if (best.objective !== best.e) {
      budget.left -= 150;
      const r = MV.path(ctx, rel, { nation: n, tpl: rep.tpl, prov: best.e, army: army.id }, best.objective);
      if (r) for (const p of r) { if (m.sea[p]) break; path.push(p); }
    }
    const old = army.offensives.find((o) => o.path.length === path.length && o.path.every((p, i) => p === path[i]));
    let id = old ? old.id : 0;
    if (!old) {
      const r = B.order(ctx, n, { type: 'offensive', army: army.id, path });
      if (!r.ok) return;
      id = r.id;
    }
    if (!B.order(ctx, n, { type: 'launch', army: army.id, offensive: id, on: true }).ok) return;
    ops.plans.push({ army: army.id, offensive: id, target: best.tgt, objective: best.objective, since: state.hour, bad: 0 });
    const est = best.est;
    X.record(ctx, n, {
      layer: 'operations',
      chosen: { label: 'offensive-toward', args: { army: army.id, offensive: id, province: best.objective, from: est.from, to: best.e, nation: best.tgt } },
      options: scored.slice(0, 3).map((x) => ({ label: 'offensive-section', args: { from: x.est.from, to: x.e, province: x.objective }, score: x.score })),
      factors: [
        { label: 'strength-ratio', args: { odds: est.pClean }, delta: 2 * (est.pClean - 500) },
        { label: 'terrain', args: { province: best.e }, delta: 2 * (est.p - est.pT) },
        { label: 'river', args: { province: best.e }, delta: 2 * (est.p - est.pR) },
        { label: 'entrenchment', args: { province: best.e }, delta: 2 * (est.p - est.pDig) },
        { label: 'objective-value', args: { province: best.objective }, delta: best.value - best.cutPart },
        { label: 'encirclement', args: { province: best.objective }, delta: best.cutPart },
        { label: 'supply', args: {}, delta: best.supply },
      ],
    });
  }

  const api = { run, fronts, allocate, cuts, field, estimate, WORK, PLAN_ODDS, OFF_ODDS, SUP_OFF };
  T.addLayer({ name: 'operations', every: 24, at: 0, run });
  return api;
});
