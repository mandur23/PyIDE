// Diplomacy (plan 3.8, 3.9): relations, war fatigue, mobilisation, capitulation, collapse, peace and the end of the
// game, with every consequence in one place. It defines the 'diplo' order and a daily system after industry.
//
// Relations live in state.rel[key(tagA, tagB)] = { war, ally, access, truce, since, broke, brokeBy }: truce is the
// hour before which neither may declare war on the other, since the hour the war began, broke/brokeBy the hour and
// nation that last ended an alliance between them (a war declared by brokeBy within BETRAYAL_DAYS is a betrayal).
// A bloc is a label on nations (nation.bloc); its members are always allied with one another. Joining one ends the
// joiner's alliances with nations at war with a member of it (it broke them: a war it declares on them within
// BETRAYAL_DAYS is a betrayal).
//
// The 'diplo' order { type: 'diplo', action, to, terms, offer, bloc, against, level } (`to` a nation index or tag):
//   declare-war    { to }              -> self dead weakened already-at-war same-bloc allied truce
//   offer-alliance { to }              -> at-war already-allied already-offered        (an offer; answers { ok, id })
//   break-alliance { to }              -> not-allied same-bloc
//   join-bloc      { bloc }            -> in-bloc at-war-with-member
//   leave-bloc     {}                  -> no-bloc
//   ask-access     { to }              -> at-war already-access already-offered        (an offer)
//   offer-peace    { to, terms: { take: [provinces of `to` for me], give: [mine for `to`] } }
//                                      -> not-at-war bad-terms already-offered        (an offer)
//   call-to-arms   { to, against }     -> not-at-war not-allied already-at-war already-offered   (an offer)
//   accept|refuse  { offer }           -> no-such-offer offer-stale (accept only)
//   mobilise       { level 0..1000 }   -> bad-count
// and bad-order, unknown-action, no-such-nation, dead for any. An offer waits in state.offers
// [{ id, from, to, action, terms, hour, expires }] until its addressee accepts or refuses (an AI nation on its next
// daily think) or OFFER_DAYS pass; a call left unanswered counts as refused.
//
// Consequences: a war declaration ends alliance and access between the two and calls the allies of both sides
// (call-to-arms offers); accepting a call declares war on the enemy; refusing one, or letting it lapse, is a
// broke-promise in the caller's ledger. A peace hands over the named provinces, returns every other province one
// side holds of the other, sends divisions standing where they may no longer be back to their capital, ends the war
// and sets a truce of TRUCE_DAYS.
//
// The daily system: offers expire; provinces lost to someone else are written to the ledger (took-our-core,
// took-our-land; the first run, at hour 0, only counts them, since the borders a scenario starts with are not a loss);
// fatigue (0..1000) rises with men lost (nation.casualties, or the fall of men held when the engine does not count
// them), the share of its own cores (those it owns) held by an enemy, blockade (nation.blockade 0..1000) and every day of war, and falls in
// peace; per day, in thousandths of a point: fatigue.warDay at war (peaceDay at peace), perLoss × men lost / its
// men of the start (pool and armies), cores × its cores an enemy holds / its cores, blockade × nation.blockade /
// 1000. Mobilisation moves toward its target and drafts manpower. Readiness (nation.ready, 0..1000, the weight its
// divisions fight with in combat.js and count with in the AI's threat) starts at the scenario's mob.peace; while the
// nation is at war or its mobilisation target is full it rises by ceil((1000 - peace) / mob.days) a day to 1000, and
// otherwise falls by as much back to peace (a nation without `mob`, or a save without `ready`, stays at 1000). A nation capitulates when its fatigue is
// CAPITULATE_FATIGUE or more and two of these hold: its capital is enemy-held, it holds under half its cores, under
// half its factories, its divisions (strength, training included) are under a third of its armies of the start; or
// when it controls nothing. Its divisions are removed and each province it owns passes to the enemy holding it when
// fits() allows, the rest to its heir (the great power at war with it holding most of its land), and it is dead;
// when some province fits neither its occupier nor the heir, it collapses instead (below) and lives on.
// fits(ctx, a, p): any nation may receive its cores and its goals; a great power also land within MAJOR_HOPS land
// provinces of what it held at the start and colonial land (a core of no nation); any other nation land within
// HAND_HOPS. A peace's terms are held to it too (validTerms). One at war with fatigue COLLAPSE_FATIGUE or more collapses with a seeded daily chance (collapseBase +
// (fatigue - COLLAPSE_FATIGUE) / collapseSlope per mille): peace with every enemy in which each province it owns that
// the enemy controls passes to it when fits() allows (the rest goes back), it leaves its bloc, and cannot declare war for WEAK_DAYS. Then the end of the game
// is checked: one bloc's majors (all members when it has none) all capitulated or collapsed, no war for PEACE_DAYS
// after there was one, or scenario.end; it is kept in state.diplo.outcome and outcome() adds the scores.
//
// Its own state: state.offers, state.diplo { nextOffer, lastWar, warSeen, outcome }, state.settings { difficulty:
// easy|normal|hard, aiBonus } and nation.dip { weak, collapsed, mobTarget, fcarry, dcarry, cas, men, cores: [count
// per nation], land: [count per nation] }, which state.create makes (state.complete; ensure() is the same call for
// a state built by hand). evaluate(ctx, from, to, action, terms) answers how
// `to` would answer an offer, { accept, score, threshold, factors, reply: { key, args } }, without applying it; the
// AI answers with exactly that.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).diplomacy = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;
  const R = NODE ? require('./rng.js') : globalThis.Conquest.rng;
  const ST = NODE ? require('./state.js') : globalThis.Conquest.state;
  const MV = NODE ? require('./movement.js') : globalThis.Conquest.movement;
  const O = NODE ? require('./orders.js') : globalThis.Conquest.orders;
  const T = NODE ? require('./tick.js') : globalThis.Conquest.tick;
  const MEM = NODE ? require('./ai/memory.js') : null;
  const PER = NODE ? require('./ai/personality.js') : null;
  const mem = () => MEM || globalThis.Conquest.ai.memory;
  const per = () => PER || globalThis.Conquest.ai.personality;

  const DAY = 24;
  const TUNING = {
    TRUCE_DAYS: 365, WEAK_DAYS: 365, BETRAYAL_DAYS: 180, OFFER_DAYS: 30, PEACE_DAYS: 30,
    fatigue: { perLoss: 400, warDay: 150, peaceDay: -3000, cores: 1200, blockade: 300 },   // per day, in 1/1000 of a point (cores and blockade at all of them)
    mobStep: 50, draftDays: 1460,
    CAPITULATE_FATIGUE: 600, COLLAPSE_FATIGUE: 750, collapseBase: 3, collapseSlope: 25, HAND_HOPS: 3, MAJOR_HOPS: 8,
  };
  const NO_REL = { war: false, ally: false, access: false, truce: 0, since: 0, broke: -1, brokeBy: -1 };

  const no = (reason) => ({ ok: false, reason });
  const isInt = (x) => Number.isInteger(x);
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  const ensure = (state) => ST.complete(state);

  // ---- static facts of a scenario ----
  const scen = new WeakMap();
  function facts(ctx) {
    const { map, scenario, rules } = ctx;
    let f = scen.get(scenario);
    if (f && f.map === map && f.rules === rules) return f;
    const n = map.provinces.length;
    const k = scenario.nations.length;
    const index = new Map(scenario.nations.map((s, i) => [s.tag, i]));
    const startOwner = new Int16Array(n).fill(-1);
    scenario.nations.forEach((s, i) => { for (const p of scenario.owner[s.tag] || []) startOwner[p] = i; });
    const core = scenario.nations.map((s) => {
      const m = new Uint8Array(n);
      const list = scenario.cores && scenario.cores[s.tag] ? scenario.cores[s.tag] : scenario.owner[s.tag] || [];
      for (const p of list) if (p > 0 && p < n) m[p] = 1;
      return m;
    });
    const goal = scenario.nations.map((s) => {
      const m = new Uint8Array(n);
      for (const g of s.goals || []) if (g.kind !== 'hold') for (const p of g.provinces || []) if (p > 0 && p < n) m[p] = 1;
      return m;
    });
    const sp = scenario.provinces || {};
    const startInd = new Int32Array(k);
    const startLand = new Int32Array(k);
    for (let p = 1; p < n; p++) {
      const o = startOwner[p];
      if (o < 0) continue;
      startLand[o] += 1;
      const e = sp[p];
      if (e) startInd[o] += (e.mil | 0) + (e.civ | 0);
    }
    const startMen = scenario.nations.map((s) => s.manpower | 0);
    const startStr = new Int32Array(k);
    for (const a of scenario.armies || []) {
      const i = index.get(a.nation);
      if (i !== undefined) startStr[i] += 1000 * (a.divisions | 0);
      const tpl = (scenario.nations[i].templates || []).find((t) => t.id === a.template);
      if (tpl) startMen[i] += U.stats(rules, tpl).manpower * (a.divisions | 0);
    }
    const s0 = ST.parseDate(scenario.start);
    const e0 = ST.parseDate(scenario.end || '1920-01-01');
    const blocs = [];
    for (const s of scenario.nations) if (s.bloc && !blocs.includes(s.bloc)) blocs.push(s.bloc);
    f = {
      map, rules, n, k, index, startOwner, core, goal, startInd, startLand, startMen, startStr, reach: [],
      coreCount: core.map((m) => m.reduce((x, y) => x + y, 0)),
      homeCount: core.map((m, a) => { let c = 0; for (let p = 1; p < n; p++) if (m[p] && startOwner[p] === a) c++; return c; }),
      endHour: ((e0.year - s0.year) * 365 + e0.doy - s0.doy) * DAY,
      blocs,
    };
    scen.set(scenario, f);
    return f;
  }

  // ---- the derived picture of the world at this hour (cache; dropped whenever ownership or control changes) ----
  const views = new WeakMap();
  const invalidate = (state) => { views.delete(state); };
  function view(ctx) {
    const { state } = ctx;
    const v0 = views.get(state);
    if (v0 && v0.hour === state.hour) return v0;
    const f = facts(ctx);
    const { k, n } = f;
    const P = state.prov;
    const m = M.of(ctx);
    const v = {
      hour: state.hour, str: new Int32Array(k), men: new Int32Array(k), ctrl: new Int32Array(k), own: new Int32Array(k),
      coreHeld: new Int32Array(k), indCtrl: new Int32Array(k), indOwn: new Int32Array(k), totalPts: new Int32Array(k),
      border: new Int32Array(k * k), occ: new Map(),
    };
    for (const d of state.divs) {
      if (d.str <= 0) continue;
      v.str[d.nation] += d.str;
      const tpl = U.templateOf(state, d);
      if (tpl) v.men[d.nation] += Math.trunc((d.str * U.stats(ctx.rules, tpl).manpower) / 1000);
    }
    state.nations.forEach((nat, a) => {
      for (const t of nat.training) {
        v.str[a] += 1000 * t.count;
        const tpl = nat.templates.find((x) => x.id === t.tpl);
        if (tpl) v.men[a] += U.stats(ctx.rules, tpl).manpower * t.count;
      }
    });
    for (let p = 1; p < n; p++) {
      if (m.sea[p]) continue;
      const o = P.owner[p];
      const c = P.ctrl[p];
      const ind = P.mil[p] + P.civ[p];
      if (c >= 0) { v.ctrl[c] += 1; v.indCtrl[c] += ind; if (f.core[c][p]) v.coreHeld[c] += 1; }
      if (o >= 0) {
        v.own[o] += 1;
        v.indOwn[o] += ind;
        v.totalPts[o] += pts(ctx, o, p);
        if (c >= 0 && c !== o) {
          const key = o * k + c;
          const list = v.occ.get(key);
          if (list) list.push(p); else v.occ.set(key, [p]);
        }
      }
      for (const q of m.adj[p]) {
        if (q <= p || m.sea[q]) continue;
        const cq = P.ctrl[q];
        if (c >= 0 && cq >= 0 && c !== cq) { v.border[c * k + cq] += 1; v.border[cq * k + c] += 1; }
      }
    }
    views.set(state, v);
    return v;
  }

  // Land hops from a nation's land of the scenario's start to every province (-1 out of reach over land), kept.
  function reach(ctx, a) {
    const f = facts(ctx);
    if (f.reach[a]) return f.reach[a];
    const m = M.of(ctx);
    const d = new Int16Array(f.n).fill(-1);
    const q = [];
    for (let p = 1; p < f.n; p++) if (f.startOwner[p] === a) { d[p] = 0; q.push(p); }
    for (let i = 0; i < q.length; i++) for (const r of m.adj[q[i]]) if (!m.sea[r] && d[r] < 0) { d[r] = d[q[i]] + 1; q.push(r); }
    f.reach[a] = d;
    return d;
  }
  // Whether province p may pass to nation a in a peace or a capitulation: its cores and its goals; for a great power
  // also land within MAJOR_HOPS land provinces of what it held at the start and colonial land (a core of no nation);
  // for any other land within HAND_HOPS.
  const colonial = new WeakMap();
  function fits(ctx, a, p) {
    const f = facts(ctx);
    if (f.core[a][p] || f.goal[a][p]) return true;
    const h = reach(ctx, a)[p];
    if (!ctx.scenario.nations[a].major) return h >= 0 && h <= TUNING.HAND_HOPS;
    if (h >= 0 && h <= TUNING.MAJOR_HOPS) return true;
    let c = colonial.get(f);
    if (!c) {
      c = new Uint8Array(f.n).fill(1);
      for (const m of f.core) for (let q = 1; q < f.n; q++) if (m[q]) c[q] = 0;
      colonial.set(f, c);
    }
    return c[p] === 1;
  }

  // What a province is worth to a nation in a peace: its factories, three times for a core, twice for a goal.
  function pts(ctx, nation, p) {
    const f = facts(ctx);
    const P = ctx.state.prov;
    return (1 + P.mil[p] + P.civ[p]) * (f.core[nation][p] ? 3 : 1) * (f.goal[nation][p] ? 2 : 1);
  }

  const occupied = (ctx, owner, by) => view(ctx).occ.get(owner * facts(ctx).k + by) || [];

  // ---- relations ----
  const key = (state, a, b) => M.key(state.nations[a].tag, state.nations[b].tag);
  const rel = (state, a, b) => state.rel[key(state, a, b)] || NO_REL;
  // Every change of state.rel goes through here (mapdata.writeRel drops the relations cache).
  const relSet = (state, a, b, patch = {}) => M.writeRel(state, state.nations[a].tag, state.nations[b].tag, patch);
  const alive = (state, a) => state.nations[a].alive;
  // The relations matrix holds exactly state.rel's war and ally flags (writeRel keeps it current).
  const atWar = (state, a, b) => { if (a === b || !alive(state, a) || !alive(state, b)) return false; const m = M.relations(state); return m.war[a * m.k + b] === 1; };
  const allied = (state, a, b) => { if (a === b) return false; const m = M.relations(state); return m.ally[a * m.k + b] === 1; };
  function enemies(state, a) {
    const out = [];
    for (let b = 0; b < state.nations.length; b++) if (atWar(state, a, b)) out.push(b);
    return out;
  }
  function allies(state, a) {
    const out = [];
    for (let b = 0; b < state.nations.length; b++) if (b !== a && alive(state, b) && allied(state, a, b)) out.push(b);
    return out;
  }
  const weak = (state, a) => !!(state.nations[a].dip && state.nations[a].dip.weak > state.hour);

  // Divisions of a nation and its living allies.
  function campStrength(ctx, a) {
    const v = view(ctx);
    let s = v.str[a];
    for (const b of allies(ctx.state, a)) s += v.str[b];
    return s;
  }
  const ratio = (ctx, a, b) => Math.trunc((campStrength(ctx, a) * 1000) / Math.max(1, campStrength(ctx, b)));

  function log(ctx, entry) { MV.log(ctx, entry); }

  // ---- effects (the order runs and events call these) ----
  function createOffer(ctx, from, to, action, terms) {
    const { state } = ctx;
    ensure(state);
    const id = state.diplo.nextOffer++;
    state.offers.push({ id, from, to, action, terms: terms || {}, hour: state.hour, expires: state.hour + TUNING.OFFER_DAYS * DAY });
    return id;
  }
  const pending = (state, from, to, action) => (state.offers || []).some((o) => o.from === from && o.to === to && o.action === action);

  function declareWar(ctx, a, b, opts = {}) {
    const { state } = ctx;
    ensure(state);
    const r = rel(state, a, b);
    const betrayed = r.brokeBy === a && r.broke >= 0 && state.hour - r.broke < TUNING.BETRAYAL_DAYS * DAY;
    relSet(state, a, b, { war: true, ally: false, access: false, truce: 0, since: state.hour });
    state.diplo.warSeen = true;
    state.diplo.lastWar = state.hour;
    mem().record(ctx, b, a, betrayed ? 'betrayal' : 'attacked-us', opts.joining !== undefined ? 600 : 1000);
    log(ctx, { kind: 'war', a, b, betrayal: betrayed });
    invalidate(state);
    const call = (caller, enemy) => {
      for (const z of allies(state, caller)) {
        if (z === enemy || atWar(state, z, enemy) || allied(state, z, enemy) || pending(state, caller, z, 'call-to-arms')) continue;
        createOffer(ctx, caller, z, 'call-to-arms', { against: enemy });
      }
    };
    call(b, a);
    call(a, b);
  }

  function makeAlliance(ctx, a, b) {
    relSet(ctx.state, a, b, { ally: true, access: true });
  }

  function breakAlliance(ctx, a, b, by) {
    if (!rel(ctx.state, a, b).ally) return;
    relSet(ctx.state, a, b, { ally: false, access: false, broke: ctx.state.hour, brokeBy: by });
  }

  function joinBloc(ctx, a, bloc) {
    const { state } = ctx;
    ensure(state);
    if (state.nations[a].bloc === bloc) return;
    if (state.nations[a].bloc) leaveBloc(ctx, a);
    for (const b of allies(state, a)) {
      if (state.nations.some((x, c) => x.bloc === bloc && c !== a && atWar(state, b, c))) breakAlliance(ctx, a, b, a);
    }
    state.nations[a].bloc = bloc;
    for (let b = 0; b < state.nations.length; b++) if (b !== a && alive(state, b) && state.nations[b].bloc === bloc && !atWar(state, a, b)) makeAlliance(ctx, a, b);
    log(ctx, { kind: 'bloc', nation: a, bloc });
    invalidate(state);
  }

  function leaveBloc(ctx, a) {
    const { state } = ctx;
    const bloc = state.nations[a].bloc;
    if (!bloc) return;
    state.nations[a].bloc = null;
    for (let b = 0; b < state.nations.length; b++) {
      if (b === a || state.nations[b].bloc !== bloc) continue;
      if (alive(state, b) && enemies(state, b).length) mem().record(ctx, b, a, 'broke-promise', 600);
      breakAlliance(ctx, a, b, a);
    }
    log(ctx, { kind: 'bloc', nation: a, bloc: null });
    rehome(ctx);
  }

  // Divisions standing where their nation may no longer be go back to its capital (or its lowest held province).
  function rehome(ctx) {
    const { state } = ctx;
    const relm = M.relations(state);
    const P = state.prov;
    const home = new Int32Array(state.nations.length).fill(0);
    const cap = M.facts(ctx).capital;
    const m = M.of(ctx);
    let removed = false;
    for (const d of state.divs) {
      if (d.str <= 0 || m.sea[d.prov] || MV.passable(ctx, relm, d.nation, d.prov)) continue;
      if (!home[d.nation]) {
        let h = P.ctrl[cap[d.nation]] === d.nation ? cap[d.nation] : -1;
        for (let p = 1; h < 0 && p < P.ctrl.length; p++) if (P.ctrl[p] === d.nation) h = p;
        home[d.nation] = h;
      }
      if (home[d.nation] > 0) { d.prov = home[d.nation]; d.dig = 0; MV.stop(d); } else { d.str = 0; removed = true; }
    }
    for (const d of state.divs) if (d.to !== null && !m.sea[d.to] && !MV.passable(ctx, relm, d.nation, d.to)) MV.stop(d);
    if (removed) dropDead(state);
    invalidate(state);
  }

  function dropDead(state, nation = -1) {
    const dead = new Set();
    state.divs = state.divs.filter((d) => { if (d.str > 0 && d.nation !== nation) return true; dead.add(d.id); return false; });
    for (const nat of state.nations) for (const a of nat.armies) a.divs = a.divs.filter((id) => !dead.has(id));
    state.battles = state.battles.filter((b) => b.side !== nation);
  }

  function validTerms(ctx, a, b, terms) {
    if (!terms || typeof terms !== 'object') return false;
    const take = terms.take || [];
    const give = terms.give || [];
    if (!Array.isArray(take) || !Array.isArray(give) || take.length + give.length > 400) return false;
    const P = ctx.state.prov;
    const seen = new Set();
    const ok = (p, owner) => isInt(p) && p > 0 && p < P.owner.length && !ctx.map.provinces[p].sea && P.owner[p] === owner && !seen.has(p) && seen.add(p);
    return take.every((p) => ok(p, b) && fits(ctx, a, p)) && give.every((p) => ok(p, a) && fits(ctx, b, p));
  }

  // a and b make peace on terms seen from a: `take` passes from b to a, `give` from a to b. Returns the provinces
  // whose owner or controller changed, ascending.
  function makePeace(ctx, a, b, terms = {}) {
    const { state } = ctx;
    ensure(state);
    const P = state.prov;
    const changed = [];
    const hand = (p, to) => { if (P.owner[p] !== to || P.ctrl[p] !== to) changed.push(p); P.owner[p] = to; P.ctrl[p] = to; };
    const take = (terms.take || []).slice();
    const give = (terms.give || []).slice();
    let lostA = 0;
    let lostB = 0;
    for (const p of take) { lostB += pts(ctx, b, p); hand(p, a); }
    for (const p of give) { lostA += pts(ctx, a, p); hand(p, b); }
    for (let p = 1; p < P.owner.length; p++) {
      const o = P.owner[p];
      const c = P.ctrl[p];
      if (o !== c && ((o === a && c === b) || (o === b && c === a))) { P.ctrl[p] = o; changed.push(p); }
    }
    relSet(state, a, b, { war: false, since: 0, truce: state.hour + TUNING.TRUCE_DAYS * DAY });
    state.offers = state.offers.filter((o) => !(o.action === 'offer-peace' && ((o.from === a && o.to === b) || (o.from === b && o.to === a))));
    mem().record(ctx, a, b, 'made-peace');
    mem().record(ctx, b, a, 'made-peace');
    if (lostB > lostA) { mem().record(ctx, b, a, 'defeated-us', Math.min(4000, 1000 * take.length)); mem().record(ctx, a, b, 'defeated-them'); }
    if (lostA > lostB) { mem().record(ctx, a, b, 'defeated-us', Math.min(4000, 1000 * give.length)); mem().record(ctx, b, a, 'defeated-them'); }
    log(ctx, { kind: 'peace', a, b, take, give });
    rehome(ctx);
    return [...new Set(changed)].sort((x, y) => x - y);
  }

  function capitulate(ctx, n, out) {
    const { state } = ctx;
    const P = state.prov;
    const k = state.nations.length;
    const held = new Int32Array(k);
    for (let p = 1; p < P.owner.length; p++) if (P.owner[p] === n && P.ctrl[p] >= 0 && P.ctrl[p] !== n) held[P.ctrl[p]] += 1;
    // The heir of what no fitting occupier holds: the great power at war with n holding most of its land, else any
    // nation holding most of it, else its first enemy.
    const major = (b) => !!ctx.scenario.nations[b].major;
    let heir = -1;
    for (const b of enemies(state, n)) if (major(b) && (heir < 0 || held[b] > held[heir])) heir = b;
    for (let b = 0; heir < 0 && b < k; b++) if (b !== n && alive(state, b) && held[b] > 0 && (heir < 0 || held[b] > held[heir])) heir = b;
    if (heir < 0) for (const b of enemies(state, n)) { heir = b; break; }
    // Land that neither its occupier nor the heir may take keeps the nation alive: it sues for peace instead (a
    // collapse: the occupied land that fits passes, the rest goes back) and stays out of the war.
    for (let p = 1; p < P.owner.length; p++) {
      if (P.owner[p] !== n || ctx.map.provinces[p].sea) continue;
      const c = P.ctrl[p];
      if (!(c >= 0 && c !== n && alive(state, c) && fits(ctx, c, p)) && !(heir >= 0 && fits(ctx, heir, p))) { collapse(ctx, n, out); return; }
    }
    for (let p = 1; p < P.owner.length; p++) {
      if (P.owner[p] === n) {
        const c = P.ctrl[p];
        const to = c >= 0 && c !== n && alive(state, c) && fits(ctx, c, p) ? c : heir;
        P.owner[p] = to; P.ctrl[p] = to;
        if (out) out.provinces.push(p);
      } else if (P.ctrl[p] === n) {
        P.ctrl[p] = P.owner[p];
        if (out) out.provinces.push(p);
      }
    }
    for (const b of enemies(state, n)) mem().record(ctx, b, n, 'defeated-them');
    const nat = state.nations[n];
    for (let b = 0; b < k; b++) {
      if (b === n) continue;
      if (state.rel[key(state, n, b)]) relSet(state, n, b, { war: false, ally: false, access: false });
    }
    nat.alive = false;
    nat.bloc = null;
    nat.training = [];
    nat.builds = [];
    dropDead(state, n);
    for (const a of nat.armies) a.divs = [];
    state.offers = state.offers.filter((o) => o.from !== n && o.to !== n && !(o.terms && o.terms.against === n));
    log(ctx, { kind: 'capitulated', nation: n, to: heir });
    if (out) { out.divs = true; out.events.push({ kind: 'capitulated', nation: n, to: heir }); }
    rehome(ctx);
  }

  function collapse(ctx, n, out) {
    const { state } = ctx;
    ensure(state);
    const changed = [];
    const P = state.prov;
    for (const b of enemies(state, n)) {
      const give = [];
      for (let p = 1; p < P.owner.length; p++) if (P.owner[p] === n && P.ctrl[p] === b && fits(ctx, b, p)) give.push(p);
      changed.push(...makePeace(ctx, n, b, { give }));
    }
    const nat = state.nations[n];
    if (nat.bloc) leaveBloc(ctx, n);
    nat.dip.weak = state.hour + TUNING.WEAK_DAYS * DAY;
    nat.dip.collapsed = state.hour;
    nat.dip.mobTarget = 0;
    nat.mobilisation = 0;
    nat.fatigue = Math.min(nat.fatigue, 500);
    state.offers = state.offers.filter((o) => !(o.to === n && o.action === 'call-to-arms'));
    log(ctx, { kind: 'collapsed', nation: n });
    if (out) { out.provinces.push(...changed); out.divs = true; out.events.push({ kind: 'collapsed', nation: n }); }
    return changed;
  }

  // ---- the order ----
  function target(ctx, to) {
    const f = facts(ctx);
    const i = typeof to === 'string' ? (f.index.has(to) ? f.index.get(to) : -1) : isInt(to) ? to : -1;
    return i >= 0 && i < ctx.state.nations.length ? i : -1;
  }

  function offerCheck(ctx, from, to, action, terms) {
    const { state } = ctx;
    if (!alive(state, from) || !alive(state, to)) return no('dead');
    switch (action) {
      case 'offer-alliance':
        if (atWar(state, from, to)) return no('at-war');
        if (allied(state, from, to)) return no('already-allied');
        return { ok: true };
      case 'ask-access':
        if (atWar(state, from, to)) return no('at-war');
        if (allied(state, from, to) || rel(state, from, to).access) return no('already-access');
        return { ok: true };
      case 'offer-peace':
        if (!atWar(state, from, to)) return no('not-at-war');
        return validTerms(ctx, from, to, terms) ? { ok: true } : no('bad-terms');
      case 'call-to-arms': {
        const e = terms ? target(ctx, terms.against) : -1;
        if (e < 0 || !atWar(state, from, e)) return no('not-at-war');
        if (!allied(state, from, to)) return no('not-allied');
        if (atWar(state, to, e)) return no('already-at-war');
        return { ok: true, against: e };
      }
      default: return no('unknown-action');
    }
  }

  function warCheck(ctx, a, b) {
    const { state } = ctx;
    if (a === b) return no('self');
    if (!alive(state, b)) return no('dead');
    if (weak(state, a)) return no('weakened');
    const r = rel(state, a, b);
    if (r.war) return no('already-at-war');
    if (state.nations[a].bloc && state.nations[a].bloc === state.nations[b].bloc) return no('same-bloc');
    if (r.ally) return no('allied');
    if (r.truce > state.hour) return no('truce');
    return { ok: true };
  }

  function check(ctx, n, o) {
    const { state } = ctx;
    if (!alive(state, n)) return no('dead');
    const needsTo = ['declare-war', 'offer-alliance', 'break-alliance', 'ask-access', 'offer-peace', 'call-to-arms'];
    let to = -1;
    if (needsTo.includes(o.action)) {
      to = target(ctx, o.to);
      if (to < 0) return no('no-such-nation');
      if (to === n) return no('self');
    }
    switch (o.action) {
      case 'declare-war': {
        const r = warCheck(ctx, n, to);
        return r.ok ? { ok: true, to } : r;
      }
      case 'offer-alliance': case 'ask-access': case 'offer-peace': {
        const terms = o.action === 'offer-peace' ? o.terms || {} : {};
        const r = offerCheck(ctx, n, to, o.action, terms);
        if (!r.ok) return r;
        if (pending(state, n, to, o.action)) return no('already-offered');
        return { ok: true, to, terms };
      }
      case 'call-to-arms': {
        const r = offerCheck(ctx, n, to, 'call-to-arms', { against: o.against });
        if (!r.ok) return r;
        if (pending(state, n, to, o.action)) return no('already-offered');
        return { ok: true, to, terms: { against: r.against } };
      }
      case 'break-alliance':
        if (!allied(state, n, to)) return no('not-allied');
        if (state.nations[n].bloc && state.nations[n].bloc === state.nations[to].bloc) return no('same-bloc');
        return { ok: true, to };
      case 'join-bloc': {
        if (typeof o.bloc !== 'string' || !o.bloc || o.bloc.length > 32) return no('bad-order');
        if (state.nations[n].bloc) return no('in-bloc');
        for (let b = 0; b < state.nations.length; b++) if (state.nations[b].bloc === o.bloc && atWar(state, n, b)) return no('at-war-with-member');
        return { ok: true };
      }
      case 'leave-bloc':
        return state.nations[n].bloc ? { ok: true } : no('no-bloc');
      case 'accept': case 'refuse': {
        const offer = (state.offers || []).find((x) => x.id === o.offer && x.to === n);
        if (!offer) return no('no-such-offer');
        if (o.action === 'accept' && !offerCheck(ctx, offer.from, offer.to, offer.action, offer.terms).ok) return no('offer-stale');
        return { ok: true, offer };
      }
      case 'mobilise':
        return isInt(o.level) && o.level >= 0 && o.level <= 1000 ? { ok: true } : no('bad-count');
      default:
        return no('unknown-action');
    }
  }

  function answer(ctx, offer, yes) {
    const { state } = ctx;
    state.offers = state.offers.filter((x) => x.id !== offer.id);
    const { from, to } = offer;
    if (!yes) {
      if (offer.action === 'call-to-arms') mem().record(ctx, from, to, 'broke-promise');
      log(ctx, { kind: 'refused', offer: offer.id, action: offer.action, from, to });
      return { ok: true };
    }
    log(ctx, { kind: 'accepted', offer: offer.id, action: offer.action, from, to });
    switch (offer.action) {
      case 'offer-alliance': makeAlliance(ctx, from, to); return { ok: true };
      case 'ask-access': relSet(state, from, to, { access: true }); return { ok: true };
      case 'offer-peace': return { ok: true, provinces: makePeace(ctx, from, to, offer.terms) };
      case 'call-to-arms': {
        const e = offer.terms.against;
        mem().record(ctx, from, to, 'kept-promise');
        mem().record(ctx, from, to, 'helped-us');
        declareWar(ctx, to, e, { joining: from });
        return { ok: true };
      }
      default: return { ok: true };
    }
  }

  function run(ctx, n, o, c) {
    const { state } = ctx;
    ensure(state);
    switch (o.action) {
      case 'declare-war': declareWar(ctx, n, c.to); return { ok: true };
      case 'offer-alliance': case 'ask-access': case 'offer-peace': case 'call-to-arms': {
        const terms = o.action === 'offer-peace' ? { take: (c.terms.take || []).slice(), give: (c.terms.give || []).slice() } : c.terms;
        return { ok: true, id: createOffer(ctx, n, c.to, o.action, terms) };
      }
      case 'break-alliance': breakAlliance(ctx, n, c.to, n); rehome(ctx); return { ok: true };
      case 'join-bloc': joinBloc(ctx, n, o.bloc); return { ok: true };
      case 'leave-bloc': leaveBloc(ctx, n); return { ok: true };
      case 'accept': return answer(ctx, c.offer, true);
      case 'refuse': return answer(ctx, c.offer, false);
      case 'mobilise': state.nations[n].dip.mobTarget = o.level; return { ok: true };
      default: return { ok: true };
    }
  }

  // Easy difficulty's -100..100: a hash of the day and the pair, so evaluate() and the answer agree.
  function noise(state, salt) {
    let h = Math.imul(Math.trunc(state.hour / DAY) + 1, 2654435761) ^ Math.imul(salt + 7, 40503);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return ((h >>> 8) % 201) - 100;
  }

  // ---- evaluate: how `to` would answer an offer from `from`, applying nothing ----
  function evaluate(ctx, from, to, action, terms = {}) {
    const { state } = ctx;
    from = target(ctx, from);
    to = target(ctx, to);
    const factors = [];
    const add = (label, delta, args) => { if (delta) factors.push(args ? { label, args, delta } : { label, delta }); };
    const legal = from >= 0 && to >= 0 && from !== to ? offerCheck(ctx, from, to, action, terms) : no('no-such-nation');
    const short = { 'offer-alliance': 'alliance', 'ask-access': 'access', 'offer-peace': 'peace', 'call-to-arms': 'call' }[action] || 'offer';
    if (!legal.ok) return { accept: false, score: 0, threshold: 0, factors: [], reason: legal.reason, reply: { key: `reply-${short}-no`, args: { because: legal.reason } } };
    const P = per();
    const p = P.of(ctx, to);
    const feel = mem().feelings(ctx, to);
    const nat = state.nations[to];
    const tr = feel.trust[from];
    const gr = feel.grudge[from];
    let base = 0;
    let threshold = 500;
    if (action === 'call-to-arms') {
      const e = legal.against;
      base = 300;
      threshold = P.threshold(ctx, to, 'call');
      add('loyalty', (p.loyalty - 50) * 8);
      add('memory-trust', Math.trunc(tr * 3 / 10), { nation: from });
      add('memory-grudge', -Math.trunc(gr * 4 / 10), { nation: from });
      add('grudge-against-enemy', Math.trunc(feel.grudge[e] * 3 / 10), { nation: e });
      add('trust-in-enemy', -Math.trunc(Math.max(0, feel.trust[e]) * 2 / 10), { nation: e });
      if (nat.bloc && nat.bloc === state.nations[from].bloc) add('same-bloc', 200);
      add('strength', clamp(Math.trunc((Math.trunc(((campStrength(ctx, from) + view(ctx).str[to]) * 1000) / Math.max(1, campStrength(ctx, e))) - 1000) / 5), -200, 200));
      add('fatigue', -Math.trunc(nat.fatigue / 2));
      if (enemies(state, to).length) add('busy-us', -150);
      else add('at-peace', -p.caution * 4);
      if (!view(ctx).border[to * facts(ctx).k + e]) add('no-front', -250, { nation: e });
      if (allied(state, to, e)) add('allied-both', -1000, { nation: e });
      if (weak(state, to)) add('weakened', -1000);
    } else if (action === 'offer-alliance' || action === 'ask-access') {
      base = action === 'offer-alliance' ? 200 : 300;
      threshold = P.threshold(ctx, to, action === 'offer-alliance' ? 'alliance' : 'access');
      const theirs = enemies(state, from);
      const ours = enemies(state, to);
      const common = theirs.some((x) => ours.includes(x));
      if (common) add('common-enemy', 350);
      else if (action === 'offer-alliance' && theirs.length) add('dragged-into-war', -200);
      if (action === 'offer-alliance') add('loyalty', (p.loyalty - 50) * 2);
      add('memory-trust', Math.trunc(tr * 4 / 10), { nation: from });
      add('memory-grudge', -Math.trunc(gr / 2), { nation: from });
      if (mem().amount(ctx, to, from, 'betrayal') > 100) add('betrayed-us', -600, { nation: from });
      if (action === 'ask-access' && !common && theirs.length) add('their-war', -250);
    } else if (action === 'offer-peace') {
      base = 350;
      threshold = P.threshold(ctx, to, 'peace');
      const total = Math.max(1, view(ctx).totalPts[to]);
      let heldByThem = 0;
      for (const q of occupied(ctx, to, from)) heldByThem += pts(ctx, to, q);
      let heldByUs = 0;
      for (const q of occupied(ctx, from, to)) heldByUs += pts(ctx, to, q);
      // The terms against the war map as it stands: what the receiver ends with under the peace (-take + give)
      // compared with the occupation turning permanent (-held by them + held by us).
      let peaceNet = 0;
      for (const q of terms.take || []) peaceNet -= pts(ctx, to, q);
      for (const q of terms.give || []) peaceNet += pts(ctx, to, q);
      add('fatigue', Math.trunc(nat.fatigue / 2));
      add('terms', clamp(Math.trunc(((peaceNet + heldByThem - heldByUs) * 1500) / total), -600, 400));
      add('strength', clamp(Math.trunc((ratio(ctx, from, to) - 1000) / 4), -250, 250));
      add('memory-trust', Math.trunc(tr / 10), { nation: from });
      add('memory-grudge', -Math.trunc(gr / 8), { nation: from });
      if (allies(state, to).some((x) => atWar(state, x, from))) add('allies-fighting', -p.loyalty * 4);
      const days = Math.trunc((state.hour - (rel(state, from, to).since | 0)) / DAY);
      add('war-length', Math.min(150, Math.trunc(days / 4)));
    }
    if (state.settings && state.settings.difficulty === 'easy') add('noise', noise(state, from * 64 + to));
    let score = base;
    for (const x of factors) score += x.delta;
    factors.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.label < y.label ? -1 : 1));
    const accept = score >= threshold;
    const because = factors.find((x) => (accept ? x.delta > 0 : x.delta < 0));
    return { accept, score, threshold, factors, reply: { key: `reply-${short}-${accept ? 'yes' : 'no'}`, args: { from: state.nations[from].tag, because: because ? because.label : 'base' } } };
  }

  // ---- the daily system ----
  function daily(ctx, w, out) {
    const { state } = ctx;
    ensure(state);
    invalidate(state);
    const f = facts(ctx);
    const k = state.nations.length;
    const P = state.prov;

    const keep = [];
    for (const o of state.offers) {
      if (state.hour >= o.expires) {
        if (o.action === 'call-to-arms' && alive(state, o.from) && alive(state, o.to)) mem().record(ctx, o.from, o.to, 'broke-promise');
        continue;
      }
      if (offerCheck(ctx, o.from, o.to, o.action, o.terms).ok) keep.push(o);
    }
    state.offers = keep;

    const relm = M.relations(state);
    const v = view(ctx);
    const coresBy = new Int32Array(k * k);
    const landBy = new Int32Array(k * k);
    const lostCores = new Int32Array(k);
    for (let p = 1; p < P.owner.length; p++) {
      const c = P.ctrl[p];
      if (c < 0) continue;
      for (let a = 0; a < k; a++) {
        if (a === c || relm.ally[a * k + c]) continue;
        if (f.core[a][p]) { coresBy[a * k + c] += 1; if (relm.war[a * k + c] && P.owner[p] === a) lostCores[a] += 1; } else if (f.startOwner[p] === a) landBy[a * k + c] += 1;
      }
    }
    for (let a = 0; a < k; a++) {
      const nat = state.nations[a];
      if (!nat.alive) continue;
      const dip = nat.dip;
      for (let b = 0; b < k; b++) {
        if (b === a) continue;
        const c = coresBy[a * k + b];
        const l = landBy[a * k + b];
        const news = state.hour > 0 && alive(state, b);
        if (c > dip.cores[b] && news) mem().record(ctx, a, b, 'took-our-core', 1000 * (c - dip.cores[b]));
        if (l > dip.land[b] && news) mem().record(ctx, a, b, 'took-our-land', 1000 * (l - dip.land[b]));
        dip.cores[b] = c;
        dip.land[b] = l;
      }
    }

    const F = TUNING.fatigue;
    for (let a = 0; a < k; a++) {
      const nat = state.nations[a];
      if (!nat.alive) continue;
      const dip = nat.dip;
      const war = enemies(state, a).length > 0;
      let lost = 0;
      if (nat.casualties !== undefined) { if (dip.cas >= 0) lost = Math.max(0, nat.casualties - dip.cas); dip.cas = nat.casualties; } else {
        const men = nat.manpower + v.men[a];
        if (dip.men >= 0) lost = Math.max(0, dip.men - men);
        dip.men = men;
      }
      let d = war ? F.warDay : F.peaceDay;
      d += Math.trunc((lost * F.perLoss * 1000) / Math.max(1, f.startMen[a]));
      d += Math.trunc((lostCores[a] * F.cores) / Math.max(1, f.homeCount[a]));
      if (war) d += Math.trunc(((nat.blockade | 0) * F.blockade) / 1000);
      const total = clamp(nat.fatigue * 1000 + dip.fcarry + d, 0, 1000000);
      nat.fatigue = Math.trunc(total / 1000);
      dip.fcarry = total - nat.fatigue * 1000;

      const goal = dip.mobTarget;
      nat.mobilisation = nat.mobilisation < goal ? Math.min(goal, nat.mobilisation + TUNING.mobStep) : Math.max(goal, nat.mobilisation - TUNING.mobStep);
      const mob = ctx.scenario.nations[a].mob;
      if (mob && nat.ready !== undefined) {
        const peace = clamp(mob.peace | 0, 0, 1000);
        const step = Math.trunc((1000 - peace + Math.max(1, mob.days | 0) - 1) / Math.max(1, mob.days | 0));
        nat.ready = war || goal >= 1000 ? Math.min(1000, nat.ready + step) : Math.max(peace, nat.ready - step);
      }
      const bonus = state.settings.aiBonus && a !== state.player ? 1250 : 1000;
      const draft = Math.trunc((Math.trunc(((ctx.scenario.nations[a].manpower | 0) * nat.mobilisation) / 1000) * bonus) / 1000) + dip.dcarry;
      const men = Math.trunc(draft / TUNING.draftDays);
      dip.dcarry = draft - men * TUNING.draftDays;
      nat.manpower += men;
      if (nat.casualties === undefined && dip.men >= 0) dip.men += men;
    }

    const cap = M.facts(ctx).capital;
    for (let a = 0; a < k; a++) {
      const nat = state.nations[a];
      if (!nat.alive || !enemies(state, a).length) continue;
      const vv = view(ctx);
      const c = P.ctrl[cap[a]];
      const capLost = c !== a && c >= 0 && relm.war[a * k + c] === 1;
      const coresLow = vv.coreHeld[a] * 2 < f.coreCount[a];
      const indLow = vv.indOwn[a] > 0 ? vv.indCtrl[a] * 2 < vv.indOwn[a] : true;
      const broken = vv.str[a] * 3 < f.startStr[a];
      const signs = (capLost ? 1 : 0) + (coresLow ? 1 : 0) + (indLow ? 1 : 0) + (broken ? 1 : 0);
      if ((signs >= 2 && nat.fatigue >= TUNING.CAPITULATE_FATIGUE) || vv.ctrl[a] === 0) { capitulate(ctx, a, out); continue; }
      if (nat.fatigue >= TUNING.COLLAPSE_FATIGUE && !weak(state, a)) {
        const chance = TUNING.collapseBase + Math.trunc((nat.fatigue - TUNING.COLLAPSE_FATIGUE) / TUNING.collapseSlope);
        if (R.int(state.rng, 1000) < chance) collapse(ctx, a, out);
      }
    }

    let anyWar = false;
    for (let a = 0; a < k && !anyWar; a++) anyWar = enemies(state, a).length > 0;
    if (anyWar) { state.diplo.lastWar = state.hour; state.diplo.warSeen = true; }
    if (!state.diplo.outcome) {
      const o = ending(ctx, anyWar);
      if (o) {
        state.diplo.outcome = o;
        log(ctx, { kind: 'game-over', outcome: o.kind, bloc: o.bloc || null });
        out.events.push({ kind: 'game-over', outcome: o.kind, bloc: o.bloc || null });
      }
    }
    invalidate(state);
  }

  const out_ = (state, a) => !state.nations[a].alive || (state.nations[a].dip && state.nations[a].dip.collapsed > 0);

  function ending(ctx, anyWar) {
    const { state, scenario } = ctx;
    const f = facts(ctx);
    if (f.blocs.length >= 2) {
      for (const bloc of f.blocs) {
        const members = [];
        scenario.nations.forEach((s, i) => { if (s.bloc === bloc) members.push(i); });
        const majors = members.filter((i) => scenario.nations[i].major);
        const list = majors.length ? majors : members;
        if (list.length && list.every((i) => out_(state, i))) return { kind: 'bloc-defeated', hour: state.hour, bloc };
      }
    }
    if (!anyWar && state.diplo.warSeen && state.hour - state.diplo.lastWar >= TUNING.PEACE_DAYS * DAY) return { kind: 'general-peace', hour: state.hour };
    if (state.hour >= f.endHour) return { kind: 'end-date', hour: state.hour };
    return null;
  }

  // Scores per nation (plan 3.9), 1000 = as in the scenario's start: goals reached, cores kept, land and industry
  // against the start, men left against the start; total weighs them 300/250/150/150/150 (goals left out when a
  // nation has none).
  function scores(ctx) {
    const { state, scenario } = ctx;
    const f = facts(ctx);
    const v = view(ctx);
    const P = state.prov;
    return state.nations.map((nat, a) => {
      let gw = 0;
      let gs = 0;
      for (const g of scenario.nations[a].goals || []) {
        const w = g.weight | 0 || 500;
        let got = 0;
        if (g.kind === 'take' || g.kind === 'hold') {
          const list = g.provinces || [];
          const mine = list.filter((p) => P.owner[p] === a).length;
          got = list.length ? Math.trunc((mine * 1000) / list.length) : 0;
        } else if (g.kind === 'defend' || g.kind === 'defend-nation') {
          const t = f.index.get(g.nation);
          got = t !== undefined && state.nations[t].alive ? 1000 : 0;
        } else continue;
        gw += w;
        gs += Math.trunc((got * w) / 1000);
      }
      const goals = gw ? Math.trunc((gs * 1000) / gw) : null;
      const cores = f.coreCount[a] ? Math.trunc((v.coreHeld[a] * 1000) / f.coreCount[a]) : 0;
      const land = Math.min(3000, Math.trunc((v.own[a] * 1000) / Math.max(1, f.startLand[a])));
      let ind = 0;
      for (let p = 1; p < P.owner.length; p++) if (P.owner[p] === a && P.ctrl[p] === a) ind += P.mil[p] + P.civ[p];
      const industry = f.startInd[a] ? Math.min(3000, Math.trunc((ind * 1000) / f.startInd[a])) : 1000;
      const manpower = Math.min(3000, Math.trunc(((nat.manpower + v.men[a]) * 1000) / Math.max(1, f.startMen[a])));
      const parts = [[goals, 300], [cores, 250], [land, 150], [industry, 150], [manpower, 150]].filter(([x]) => x !== null);
      const wsum = parts.reduce((s, [, x]) => s + x, 0);
      const total = nat.alive ? Math.trunc(parts.reduce((s, [x, wt]) => s + x * wt, 0) / wsum) : 0;
      return { nation: a, tag: nat.tag, alive: nat.alive, total, goals, cores, land, industry, manpower };
    });
  }

  function outcome(ctx) {
    const o = ctx.state.diplo && ctx.state.diplo.outcome;
    return o ? { ...o, scores: scores(ctx) } : null;
  }

  O.define('diplo', { check, run });
  T.addSystem({ name: 'diplomacy', every: DAY, at: 0, run: daily }, { after: 'industry' });

  return {
    evaluate, outcome, scores, check, ensure, facts, view, invalidate, pts, occupied, rel, relSet, atWar, allied, enemies, allies, weak,
    campStrength, ratio, declareWar, makePeace, makeAlliance, breakAlliance, joinBloc, leaveBloc, collapse, capitulate,
    warCheck, offerCheck, validTerms, rehome, fits, reach, TUNING,
  };
});
