// The general AI (plan 5.3): every EVERY hours, for each living nation including the player's, it carries out each
// army's plan, the `front` and the launched `offensive` that operations.js (or the player) recorded. It is the only
// thing that moves an army's divisions; a division with `manual` set belongs to the player and is never touched.
//
// Strike. While an offensive is launched, the strike group is the army's share (mil.shareOf(trait)) of its usable
// divisions nearest the province the offensive attacks next, never so many that a contact province with a hostile
// division next to it would lose its holder (mil.strikeSize). It masses on up to three provinces next to that target
// (several directions add the engine's flanking bonus), attacks when the hourly odds in combat.js's own numbers reach
// goOdds (earlier under an offence general, later under a defence one or a cautious nation), calls the attack off
// below goOdds - STOP_GAP, walks into the target when it is empty, follows up path province by path province, and
// stops while its mean supply is under SUP_STOP; a division of it under SUP_STOP itself stays back.
//
// Hold. The rest hold the front. Each front province the camp holds wants one division (contact provinces first,
// then by threat, a province already held counting HELD more so a thin line does not reshuffle) and the remainder in
// proportion to 1000 + the strength of the hostile divisions next to it (the capital counts as contact with CAPITAL
// more). A province gives a division away only above what it wants (SLACK above it while no province of the front is
// empty), so it is never stripped bare next to an enemy stack. Empty provinces are filled first, one division each,
// from the nearest spare; provinces more than SLACK short of their share are topped up on the first turn of the day.
// A worn division (low org or strength) leaves the line for a quiet province behind it once a fresh one stands with
// it, and rests until ready. Ready holders strike locally (at most LOCAL a call), all but one of them, or a lone one
// when no other hostile division borders its province: into an empty hostile province next to them, or against a
// garrison when their odds reach goOdds + LOCAL_EDGE. A set piece (operations.js) attacks from PUSH_GO. After the armies, sweep() fills a front's empty contact
// province from a spare division of any army within SWEEP provinces (the player's: of the army holding it).
//
// Garrisons. The rear provinces of n that are its capital, a hub or hold military factories (mil 2 or more), off every
// army's front and with an enemy within GUARD_HOPS provinces, each keep one division (guarded(), at most a
// GUARD_SHARE-th of n's divisions): the lowest-id division bound for or standing in one stays, the armies leave it,
// and one without gets the nearest spare within GUARD_REACH (garrison()).
//
// Overseas. Once a day an army's ready standing divisions that cannot reach its front over its camp's land (another
// island or continent, SHIP_HOPS provinces at most) sail there, at most SHIP a day (twice SHIP tried), to the front
// province nearest them; one with neither a land nor a sea way inside its camp attacks the hostile province next to
// it on its shortest path there (a break-out). A launched offensive against a province with no camp-held land next
// to it is a landing: the strike group gathers in the camp's port nearest the target (at most SHIP standing
// divisions sent a turn) and, once all of it (or LAND_WAIT days of trying) is there, sails and attacks, unless the
// target is a great power's home province with a hostile division in it (then it waits in port). A division already
// at sea that would come ashore on an enemy-held home province of a great power turns for the nearest coast of its
// camp, unless that is the target of a launched landing and still empty of hostile divisions.
//
// Legs. A division sent the long way round (its shortest path crosses hostile land) walks waypoint legs;
// nation.ai.legs ([[div, province]], ascending) keeps where it is really going, so the next turn counts it there and
// sends it on. With nation.ai.landing ([[army, hour]]: when a landing's strike group began to gather) it is all this
// layer keeps between turns.
//
// Rules: orders go through mil.send/halt (orders.apply) only, and only when the division is not already doing it;
// the work per nation per call is capped by WORK units, armies take turns at the front of the queue, and when the
// cap is hit the orders given so far stand.
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).general = api; }
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const G = NODE ? null : globalThis.Conquest;
  const M = NODE ? require('../mapdata.js') : G.mapdata;
  const T = NODE ? require('../tick.js') : G.tick;
  const B = NODE ? require('./mil-common.js') : G.ai.mil;
  const X = NODE ? require('./explain.js') : G.ai.explain;
  const MV = NODE ? require('../movement.js') : G.movement;

  const EVERY = 6;
  const WORK = 60000;
  const ATT_ORG = 450;
  const SUP_STOP = 400;
  const STOP_GAP = 180;
  const LOCAL = 2;
  const CAPITAL = 3000;
  const SWEEP = 3;
  const SLACK = 1;
  const HELD = 1500;
  const LOCAL_EDGE = 150;
  const SHIP = 6;
  const SHIP_HOPS = 60;
  const LAND_WAIT = 10;
  const GUARD_HOPS = 6;
  const GUARD_SHARE = 8;
  const GUARD_REACH = 8;
  const RAID = 20;
  const PUSH_GO = 300;

  function run(ctx, n) {
    const { state } = ctx;
    const nat = state.nations[n];
    const armies = nat.armies;
    if (!armies.length) return;
    const rel = M.relations(state);
    const v = B.view(ctx);
    const legs = new Map(nat.ai.legs || []);
    const budget = { left: WORK, legs, guard: new Set() };
    const m = M.of(ctx);
    for (const [id, to] of [...legs]) {
      const d = M.divById(state, id);
      if (!d || d.manual || d.nation !== n || d.prov === to || m.sea[d.prov]) legs.delete(id);
      else if (d.to === null) B.send(ctx, rel, n, d, to, budget);
    }
    // Cut off (sup 0), a division bound for land the enemy now holds stops short (it was sent before it was cut off).
    for (const d of state.divs) {
      if (d.nation !== n || d.manual || d.to === null || m.sea[d.prov] || m.sea[d.to] || d.sup > 0 || !M.hostile(rel, n, state.prov.ctrl[d.to]) || v.battleAt[d.to]) continue;
      B.halt(ctx, n, d, budget);
    }
    // At sea, a division whose voyage now comes ashore on a great power's home coast an enemy holds (the port it sailed
    // for was retaken on the way) makes for the nearest coast of its camp, unless it is the landing of a launched
    // offensive and no hostile division stands there.
    const landTargets = new Set();
    for (const a of armies) for (const o of a.offensives) if (o.on) for (const p of o.path) landTargets.add(p);
    for (const d of state.divs) {
      if (d.nation !== n || d.manual || !m.sea[d.prov] || d.to === null || budget.left <= 0) continue;
      const end = [d.to].concat(d.path).find((p) => !m.sea[p]);
      if (end === undefined || !hostileHome(ctx, rel, n, end) || (landTargets.has(end) && !defendedHome(ctx, v, rel, n, end))) continue;
      budget.left -= 150;
      const r = MV.search(ctx, rel, d, (p) => M.camp(rel, n, state.prov.ctrl[p]), { own: true }).path;
      if (r && r.length) B.order(ctx, n, { type: 'move', div: d.id, to: r[r.length - 1], by: 'general' });
    }
    const keys = guarded(ctx, rel, v, n, budget);
    const first = Math.trunc(state.hour / EVERY) % armies.length;
    for (let j = 0; j < armies.length && budget.left > 0; j++) command(ctx, rel, v, n, armies[(first + j) % armies.length], budget);
    if (budget.left > 0) sweep(ctx, rel, v, n, budget);
    if (budget.left > 0) garrison(ctx, rel, v, n, keys, budget);
    if (budget.left > 0 && state.hour % 24 === 1) raid(ctx, rel, v, n, budget);
    if (legs.size || nat.ai.legs) nat.ai.legs = [...legs].sort((a, b) => a[0] - b[0]);
  }

  // A home province of a great power (a core it owns) that an enemy of n holds / that also has hostile divisions in it.
  function hostileHome(ctx, rel, n, p) {
    const o = ctx.state.prov.owner[p];
    return o >= 0 && !!ctx.scenario.nations[o].major && M.facts(ctx).core[o][p] === 1 && M.hostile(rel, n, ctx.state.prov.ctrl[p]);
  }
  const defendedHome = (ctx, v, rel, n, p) => hostileHome(ctx, rel, n, p) && B.hostileStr(ctx, v, rel, n, p) > 0;

  // A contact province of a front that no division of the nation holds or is bound for (those touching a hostile
  // division first) gets the nearest spare one within SWEEP provinces, which joins the army holding it. Spare: ready,
  // standing, not fighting, not the capital's garrison, off the contact line or with another standing division of
  // the nation beside it, and not massing next to the target of its army's offensive.
  function sweep(ctx, rel, v, n, budget) {
    const { state } = ctx;
    const nat = state.nations[n];
    const owner = new Map();
    for (const a of nat.armies) for (const p of a.front || []) if (!owner.has(p)) owner.set(p, a);
    if (!owner.size) return;
    const m = M.of(ctx);
    const ctrl = state.prov.ctrl;
    const held = new Set();
    const standing = new Map();
    for (const d of state.divs) {
      if (d.nation !== n) continue;
      held.add(B.goalOf(budget, d));
      if (d.to === null) standing.set(d.prov, (standing.get(d.prov) || 0) + 1);
    }
    const massing = new Set();
    for (const a of nat.armies) {
      const off = a.offensives.find((o) => o.on);
      const t = off ? B.frontier(ctx, rel, n, off, null, budget) : null;
      if (t) for (const q of m.adj[t]) massing.add(a.id * m.n + q);
    }
    const cap = ctx.scenario.nations[n].capital;
    const mine = n === state.player;
    const gaps = [];
    for (const p of [...owner.keys()].sort((a, b) => a - b)) {
      if (held.has(p) || ctrl[p] !== n || !B.touchesHostile(ctx, rel, n, p)) continue;
      let faced = 0;
      for (const q of m.adj[p]) if (!m.sea[q] && B.hostileStr(ctx, v, rel, n, q) > 0) { faced = 1; break; }
      gaps.push([faced, p]);
    }
    gaps.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, p] of gaps) {
      if (budget.left <= 0) return;
      const army = owner.get(p);
      const pick = (d) => d.nation === n && !d.manual && d.army !== null && d.to === null && B.ready(d) && !v.defending.has(d.id) && !budget.guard.has(d.id) &&
        d.prov !== cap && !m.sea[d.prov] && (standing.get(d.prov) >= 2 || !B.touchesHostile(ctx, rel, n, d.prov)) &&
        !massing.has(d.army * m.n + d.prov) && (!mine || d.army === army.id);
      const [d] = B.nearest(ctx, v, rel, n, p, 1, pick, budget, SWEEP);
      if (!d) continue;
      if (d.army !== army.id && !B.order(ctx, n, { type: 'assign', div: d.id, army: army.id }).ok) continue;
      if (B.send(ctx, rel, n, d, p, budget)) { held.add(p); standing.set(d.prov, standing.get(d.prov) - 1); }
    }
  }

  // The rear provinces that keep a garrison: n's own cores it controls that are its capital, a hub or hold military
  // factories (mil 2 or more), off every army's front and not touching hostile land (the line holds those), with
  // land of an enemy within GUARD_HOPS provinces; the capital first, then by factories, at most a GUARD_SHARE-th of
  // n's divisions, and none while a contact province of n has no division of n standing in or bound for it (the
  // line comes first). The lowest-id division of n bound for or standing in each is its garrison (budget.guard): the
  // armies leave it there.
  function guarded(ctx, rel, v, n, budget) {
    const { state } = ctx;
    const m = M.of(ctx);
    const P = state.prov;
    const core = M.facts(ctx).core[n];
    const cap = ctx.scenario.nations[n].capital;
    const onFront = new Set();
    for (const a of state.nations[n].armies) for (const p of a.front || []) onFront.add(p);
    const held = new Set();
    for (const d of state.divs) if (d.nation === n) held.add(B.goalOf(budget, d));
    const cands = [];
    for (let i = v.start[n]; i < v.start[n + 1]; i++) {
      const p = v.owned[i];
      if (!held.has(p) && B.touchesHostile(ctx, rel, n, p)) return [];
      if (!core[p] || P.owner[p] !== n || onFront.has(p) || !(p === cap || M.facts(ctx).hub[p] || P.mil[p] >= 2)) continue;
      if (B.touchesHostile(ctx, rel, n, p)) continue;
      cands.push(p);
    }
    const limit = Math.trunc(v.count[n] / GUARD_SHARE);
    if (!cands.length || !limit) return [];
    cands.sort((a, b) => (b === cap) - (a === cap) || P.mil[b] + P.civ[b] - P.mil[a] - P.civ[a] || a - b);
    const s = B.marks(ctx, 7);
    const keys = [];
    for (const p0 of cands) {
      if (keys.length >= limit || budget.left <= 0) break;
      const g = B.fresh(s);
      let qt = 0;
      let near = false;
      s.mark[p0] = g; s.val[p0] = 0; s.queue[qt++] = p0;
      for (let qh = 0; qh < qt && !near; qh++) {
        budget.left--;
        const p = s.queue[qh];
        if (M.hostile(rel, n, P.ctrl[p])) { near = true; break; }
        if (s.val[p] >= GUARD_HOPS) continue;
        for (const q of m.adj[p]) if (!m.sea[q] && s.mark[q] !== g) { s.mark[q] = g; s.val[q] = s.val[p] + 1; s.queue[qt++] = q; }
      }
      if (near) keys.push(p0);
    }
    const want = new Set(keys);
    const taken = new Set();
    for (const d of state.divs) {
      if (d.nation !== n || d.manual || d.str <= 0 || m.sea[d.prov]) continue;
      const p = B.goalOf(budget, d);
      if (want.has(p) && !taken.has(p)) { taken.add(p); budget.guard.add(d.id); }
    }
    return keys.filter((p) => !taken.has(p));
  }

  // Each key province without its garrison gets the nearest spare division within GUARD_REACH provinces: ready,
  // standing, not fighting, and off the contact line or with another standing division of n beside it.
  function garrison(ctx, rel, v, n, keys, budget) {
    const { state } = ctx;
    const m = M.of(ctx);
    const standing = new Map();
    for (const d of state.divs) if (d.nation === n && d.to === null) standing.set(d.prov, (standing.get(d.prov) || 0) + 1);
    for (const p of keys) {
      if (budget.left <= 0) return;
      const pick = (d) => d.nation === n && !d.manual && d.army !== null && d.to === null && B.ready(d) && !v.defending.has(d.id) &&
        !budget.guard.has(d.id) && !m.sea[d.prov] && (standing.get(d.prov) >= 2 || !B.touchesHostile(ctx, rel, n, d.prov));
      const [d] = B.nearest(ctx, v, rel, n, p, 1, pick, budget, GUARD_REACH);
      if (!d) continue;
      if (d.prov === p || B.send(ctx, rel, n, d, p, budget)) { budget.guard.add(d.id); standing.set(d.prov, standing.get(d.prov) - 1); }
    }
  }

  // A raid: when none of n's divisions has fought for RAID days and none is moving, one division standing in a
  // contact province (a ready one beside another of n's first, then a ready one, then any with org left) attacks the hostile province next to it with the
  // fewest hostile divisions, whatever the odds, so no front at war stays silent for long.
  function raid(ctx, rel, v, n, budget) {
    const { state } = ctx;
    const nat = state.nations[n];
    if (state.hour - (nat.ai.fought === undefined ? 0 : nat.ai.fought) < RAID * 24) return;
    const m = M.of(ctx);
    const best = [null, null, null];
    for (const d of state.divs) {
      if (d.nation !== n) continue;
      if (d.to !== null) return;
      if (d.manual || m.sea[d.prov] || d.org <= 0 || budget.guard.has(d.id) || v.defending.has(d.id)) continue;
      let other = false;
      for (let i = v.head[d.prov]; i >= 0 && !other; i = v.next[i]) { const o = state.divs[i]; other = o !== d && o.nation === n && o.to === null; }
      const slot = !B.ready(d) ? 2 : other ? 0 : 1;
      if (best[slot]) continue;
      for (const q of m.adj[d.prov]) {
        if (m.sea[q] || !M.hostile(rel, n, state.prov.ctrl[q]) || v.battleAt[q]) continue;
        const h = B.hostileStr(ctx, v, rel, n, q);
        if (!best[slot] || h < best[slot].h) best[slot] = { d, q, h };
      }
    }
    const r = best[0] || best[1] || best[2];
    if (r && B.send(ctx, rel, n, r.d, r.q, budget, true)) X.record(ctx, n, { layer: 'general', chosen: { label: 'raid', args: { province: r.q } }, options: [], factors: [{ label: 'quiet-days', delta: Math.trunc((state.hour - (nat.ai.fought | 0)) / 24) }] });
  }

  function command(ctx, rel, v, n, army, budget) {
    const { state } = ctx;
    const divs = B.usable(ctx, army).filter((d) => !budget.guard.has(d.id));
    if (!divs.length) return;
    const tr = B.trait(ctx, n, army);
    const front = frontOf(ctx, rel, n, army);
    const strike = new Set();
    const off = army.offensives.find((o) => o.on) || null;
    if (off) {
      const onFront = new Set(front.list);
      const usable = divs.filter((d) => !v.defending.has(d.id) && (B.ready(d) || (!B.worn(d) && onFront.has(B.goalOf(budget, d))))).length;
      const k = front.length ? B.strikeSize(usable, B.menace(ctx, v, rel, n, front.list), B.shareOf(tr)) : usable;
      const t = B.frontier(ctx, rel, n, off, divs[0], budget);
      // A set piece (operations.js: its plan has push) is attacked from PUSH_GO: the losses are the price of it.
      const ops = state.nations[n].ai.ops;
      const push = !!ops && ops.plans.some((p) => p.army === army.id && p.offensive === off.id && p.push);
      if (t && k > 0) attack(ctx, rel, v, n, army, t, k, divs, strike, push ? PUSH_GO : B.goOdds(ctx, n, tr), budget);
    }
    if (front.length) hold(ctx, rel, v, n, front, divs, strike, B.goOdds(ctx, n, tr), budget);
    if (front.length && state.hour % 24 === 1) ship(ctx, rel, v, n, front, divs, strike, budget);
  }

  function ship(ctx, rel, v, n, front, divs, strike, budget) {
    const P = ctx.map.provinces;
    const cand = divs.filter((d) => d.to === null && B.ready(d) && !strike.has(d.id) && !v.defending.has(d.id) && !front.list.includes(B.goalOf(budget, d)));
    if (!cand.length) return;
    const s = B.marks(ctx, 5);
    const g = B.fresh(s);
    const ctrl = ctx.state.prov.ctrl;
    const m = M.of(ctx);
    const queue = front.list.slice();
    for (const p of queue) { s.mark[p] = g; s.val[p] = 0; }
    for (let i = 0; i < queue.length && budget.left > 0; i++, budget.left--) {
      const p = queue[i];
      if (s.val[p] >= SHIP_HOPS) continue;
      for (const q of m.adj[p]) if (s.mark[q] !== g && !m.sea[q] && M.camp(rel, n, ctrl[q])) { s.mark[q] = g; s.val[q] = s.val[p] + 1; queue.push(q); }
    }
    let sent = 0;
    let tries = 0;
    for (const d of cand) {
      if (sent >= SHIP || tries >= 2 * SHIP || budget.left <= 0) break;
      if (s.mark[d.prov] === g) continue;
      tries++;
      let best = 0;
      let bestD = 0;
      for (const p of front.list) {
        const dx = Math.trunc(P[p].x) - Math.trunc(P[d.prov].x);
        const dy = Math.trunc(P[p].y) - Math.trunc(P[d.prov].y);
        if (!best || dx * dx + dy * dy < bestD) { best = p; bestD = dx * dx + dy * dy; }
      }
      if (B.send(ctx, rel, n, d, best, budget)) { sent++; continue; }
      budget.left -= 150;
      const route = MV.path(ctx, rel, d, best);
      if (route && !m.sea[route[0]] && M.hostile(rel, n, ctrl[route[0]]) && B.send(ctx, rel, n, d, route[0], budget, true)) sent++;
    }
  }

  // A landing: gather at the camp's port nearest t, then sail and attack together.
  function landing(ctx, rel, v, n, army, t, k, divs, strike, budget) {
    const port = B.nearPort(ctx, rel, n, t);
    if (!port) return;
    const P = ctx.map.provinces;
    const far = (d) => { const dx = Math.trunc(P[d.prov].x) - Math.trunc(P[port].x); const dy = Math.trunc(P[d.prov].y) - Math.trunc(P[port].y); return dx * dx + dy * dy; };
    const group = divs.filter((d) => !v.defending.has(d.id) && (d.to === t || B.ready(d))).sort((a, b) => far(a) - far(b) || a.id - b.id).slice(0, k);
    for (const d of group) if (d.prov === port || d.to !== null) strike.add(d.id);
    const there = group.filter((d) => d.prov === port && d.to === null);
    const ai = ctx.state.nations[n].ai;
    const since = (ai.landing || (ai.landing = [])).find((x) => x[0] === army.id);
    if (!since) { ai.landing.push([army.id, ctx.state.hour]); ai.landing.sort((a, b) => a[0] - b[0]); }
    const waited = since ? ctx.state.hour - since[1] >= LAND_WAIT * 24 : false;
    // Ships do not sail against a great power's home coast that has troops on it (operations.js plans none; one
    // that the frontier of an offensive turned toward such a coast waits in port).
    const o = ctx.state.prov.owner[t];
    const held = o >= 0 && ctx.scenario.nations[o].major && M.facts(ctx).core[o][t] === 1 && B.hostileStr(ctx, v, rel, n, t) > 0;
    if (there.length && (there.length === group.length || waited) && !held) {
      for (const d of there) B.send(ctx, rel, n, d, t, budget, true);
      ai.landing = ai.landing.filter((x) => x[0] !== army.id);
      return;
    }
    let tries = 0;
    for (const d of group) if (d.prov !== port && d.to === null && tries++ < SHIP && budget.left > 0 && B.send(ctx, rel, n, d, port, budget)) strike.add(d.id);
  }

  // The army's front provinces its camp holds, with which of them touch hostile land.
  function frontOf(ctx, rel, n, army) {
    const ctrl = ctx.state.prov.ctrl;
    const list = [];
    if (army.front) for (const p of army.front) if (M.camp(rel, n, ctrl[p]) && !list.includes(p)) list.push(p);
    list.sort((a, b) => a - b);
    const cap = ctx.scenario.nations[n].capital;
    const contact = list.map((p) => (p === cap || B.touchesHostile(ctx, rel, n, p) ? 1 : 0));
    return { list, contact, cap, length: list.length };
  }

  function attack(ctx, rel, v, n, army, t, k, divs, strike, go, budget) {
    const m = M.of(ctx);
    const P = ctx.state.prov;
    if (!B.staging(ctx, rel, n, t).length) { landing(ctx, rel, v, n, army, t, k, divs, strike, budget); return; }
    const ai = ctx.state.nations[n].ai;
    if (ai.landing) ai.landing = ai.landing.filter((x) => x[0] !== army.id);
    const mine = new Set(divs.map((d) => d.id));
    const group = B.nearest(ctx, v, rel, n, t, k, (d) => mine.has(d.id) && !v.defending.has(d.id) && (d.to === t || (B.ready(d) && (d.to === null || !v.attacking.has(d.id)))), budget);
    for (const d of group) strike.add(d.id);
    if (!group.length) return;
    let sup = 0;
    for (const d of group) sup += d.sup;
    sup = Math.trunc(sup / group.length);
    const adjT = m.adj[t];
    for (const d of group) if (d.to === t && d.sup < SUP_STOP) B.halt(ctx, n, d, budget);
    const present = group.filter((d) => adjT.includes(d.prov) && M.camp(rel, n, P.ctrl[d.prov]) && (d.to === null || d.to === t) && d.org >= ATT_ORG && d.sup >= SUP_STOP);
    if (sup < SUP_STOP) {
      for (const d of present) if (d.to === t) B.halt(ctx, n, d, budget);
      return;
    }
    const empty = B.hostileStr(ctx, v, rel, n, t) === 0;
    if (present.length) {
      if (empty) {
        for (const d of present) B.send(ctx, rel, n, d, t, budget, true);
      } else {
        const r = B.odds(ctx, v, rel, n, present, t);
        if (r.p >= go) for (const d of present) B.send(ctx, rel, n, d, t, budget, true);
        else if (r.p < go - STOP_GAP) for (const d of present) if (d.to === t) B.halt(ctx, n, d, budget);
      }
    }
    const stage = B.staging(ctx, rel, n, t).slice(0, 3);
    if (!stage.length) return;
    const load = stage.map((s) => group.filter((d) => B.goalOf(budget, d) === s).length);
    for (const d of group) {
      if (present.includes(d) || stage.includes(B.goalOf(budget, d)) || budget.left <= 0) continue;
      let best = 0;
      for (let i = 1; i < stage.length; i++) if (load[i] < load[best]) best = i;
      if (B.send(ctx, rel, n, d, stage[best], budget)) load[best]++;
    }
  }

  function hold(ctx, rel, v, n, front, divs, strike, go, budget) {
    const m = M.of(ctx);
    const P = ctx.state.prov;
    const F = front.list;
    const L = F.length;
    const s = B.marks(ctx, 2);
    const g = B.fresh(s);
    for (let i = 0; i < L; i++) { s.mark[F[i]] = g; s.val[F[i]] = i; }
    const idx = (p) => (s.mark[p] === g ? s.val[p] : -1);
    const threat = new Int32Array(L);
    for (let i = 0; i < L; i++) {
      if (!front.contact[i]) continue;
      for (const q of m.adj[F[i]]) if (!m.sea[q]) threat[i] += B.hostileStr(ctx, v, rel, n, q);
      if (F[i] === front.cap) threat[i] += CAPITAL;
    }
    const have = new Int32Array(L);
    const any = new Int32Array(L);
    const steady = new Int32Array(L);
    const placed = [];
    const wornOn = [];
    const pool = [];
    let fixed = 0;
    for (const d of divs) {
      const here = idx(d.prov);
      if (strike.has(d.id) || v.defending.has(d.id) || v.attacking.has(d.id)) {
        if (here >= 0 && d.to === null) { have[here]++; any[here]++; steady[here]++; fixed++; }
        continue;
      }
      const i = idx(B.goalOf(budget, d));
      if (i >= 0 && !B.worn(d)) {
        have[i]++; any[i]++; placed.push(d);
        if (d.prov === F[i] && d.to === null) steady[i]++;
      } else if (i >= 0) { any[i]++; wornOn.push(d); }
      else if (B.ready(d)) pool.push(d);
    }
    const want = distribute(placed.length + pool.length + fixed, front.contact, threat, any);
    const spare = new Set(pool.map((d) => d.id));
    let gap = false;
    for (let i = 0; i < L; i++) if (want[i] > 0 && have[i] === 0) gap = true;
    placed.sort((a, b) => (a.to === null) - (b.to === null) || a.dig - b.dig || a.id - b.id);
    for (const d of placed) {
      const i = idx(B.goalOf(budget, d));
      if (have[i] > want[i] + (gap ? 0 : SLACK)) { have[i]--; spare.add(d.id); }
    }
    const holders = new Map(placed.concat(pool).map((d) => [d.id, d]));
    const fill = (i, need) => {
      if (need <= 0 || !spare.size) return;
      const got = B.nearest(ctx, v, rel, n, F[i], need, (d) => spare.has(d.id), budget);
      for (const d of got) {
        spare.delete(d.id);
        const was = idx(B.goalOf(budget, d));
        if (was === i) { have[i]++; continue; }
        if (B.send(ctx, rel, n, d, F[i], budget)) have[i]++;
        else if (was >= 0) have[was]++;
      }
    };
    const order = [];
    const balance = ctx.state.hour % 24 === 1;
    for (let i = 0; i < L; i++) if (have[i] === 0 ? want[i] > 0 : balance && want[i] - have[i] > SLACK) order.push(i);
    order.sort((a, b) => (any[a] === 0 ? 0 : 1) - (any[b] === 0 ? 0 : 1) || front.contact[b] - front.contact[a] || threat[b] - threat[a] || F[a] - F[b]);
    for (const i of order) { if (budget.left <= 0) break; if (have[i] === 0) fill(i, 1); }
    for (const i of order) { if (budget.left <= 0) break; fill(i, want[i] - have[i]); }
    const inPool = new Set(pool.map((d) => d.id));
    for (const id of [...spare].sort((a, b) => a - b)) {
      const d = holders.get(id);
      const i = idx(B.goalOf(budget, d));
      if (i >= 0) { have[i]++; continue; }
      // A division of the army off its front that no fill took (the front lacks it by less than SLACK) joins the
      // province that lacks most, so it does not wait in the rear.
      if (!balance || !inPool.has(id) || budget.left <= 0) continue;
      let best = -1;
      for (let j = 0; j < L; j++) if (best < 0 || want[j] - have[j] > want[best] - have[best]) best = j;
      if (best >= 0 && B.send(ctx, rel, n, d, F[best], budget)) have[best]++;
    }
    for (const d of wornOn) {
      if (budget.left <= 0) break;
      const i = idx(d.prov);
      if (i < 0 || d.to !== null || !front.contact[i] || v.defending.has(d.id)) continue;
      if (steady[i] >= 1) { const r = rear(ctx, rel, n, F[i]); if (r) B.send(ctx, rel, n, d, r, budget); }
      else if (have[i] < 1) fill(i, 1);
    }
    let acts = 0;
    for (let i = 0; i < L && acts < LOCAL && budget.left > 0; i++) {
      if (!front.contact[i] || have[i] < want[i]) continue;
      const movers = placed.filter((d) => d.prov === F[i] && d.to === null && B.ready(d) && d.sup >= SUP_STOP).sort((a, b) => b.org - a.org || a.id - b.id);
      if (!movers.length) continue;
      for (const q of m.adj[F[i]]) {
        if (m.sea[q] || !M.hostile(rel, n, P.ctrl[q])) continue;
        const lone = movers.length < 2 || steady[i] < 2;
        if (lone && threat[i] - B.hostileStr(ctx, v, rel, n, q) > 0) continue;
        const force = lone ? movers : movers.slice(0, movers.length - 1);
        if (B.hostileStr(ctx, v, rel, n, q) === 0) {
          if (!v.battleAt[q] && B.send(ctx, rel, n, force[0], q, budget, true)) acts++;
        } else if (B.odds(ctx, v, rel, n, force, q).p >= go + LOCAL_EDGE) {
          for (const d of force) B.send(ctx, rel, n, d, q, budget, true);
          acts++;
        } else continue;
        break;
      }
    }
  }

  // want[i] for `count` divisions over the front: one each in order of need (contact first, then threat, a province a
  // division already holds counting HELD more so a thin line does not reshuffle for small changes), the rest by
  // largest remainder on 1000 + threat (contact) or 200 (behind the line).
  function distribute(count, contact, threat, held) {
    const L = contact.length;
    const want = new Int32Array(L);
    const rank = [];
    for (let i = 0; i < L; i++) rank.push(i);
    const key = (i) => threat[i] + (held[i] > 0 ? HELD : 0);
    rank.sort((a, b) => contact[b] - contact[a] || key(b) - key(a) || a - b);
    if (count <= L) { for (let j = 0; j < count; j++) want[rank[j]] = 1; return want; }
    want.fill(1);
    const rest = count - L;
    const w = rank.map((i) => (contact[i] ? 1000 + threat[i] : 200));
    let W = 0;
    for (const x of w) W += x;
    let given = 0;
    const rem = [];
    rank.forEach((i, j) => {
      const q = Math.trunc((rest * w[j]) / W);
      want[i] += q;
      given += q;
      rem.push([(rest * w[j]) % W, j]);
    });
    rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let j = 0; given < rest; j++, given++) want[rank[rem[j][1]]]++;
    return want;
  }

  // A quiet province next to p (camp-held, touching no hostile land) with the most supply.
  function rear(ctx, rel, n, p) {
    const m = M.of(ctx);
    const P = ctx.state.prov;
    let best = 0;
    for (const q of m.adj[p]) {
      if (m.sea[q] || !M.camp(rel, n, P.ctrl[q]) || B.touchesHostile(ctx, rel, n, q)) continue;
      if (!best || P.supply[q] > P.supply[best] || (P.supply[q] === P.supply[best] && q < best)) best = q;
    }
    return best;
  }

  const api = { run, EVERY };
  T.addLayer({ name: 'general', every: EVERY, at: 1, player: true, run });
  return api;
});
