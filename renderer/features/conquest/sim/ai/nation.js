// The nation AI (plan 5.1): once a day per AI nation, utility scores over the strategic choices, carried out only
// through orders.apply and each one explained (explain.record, layer 'nation'). In order:
//   goals     the scenario's goals (take, hold, defend, join) plus revanche goals grown from the ledger (a core held
//             by another nation, land held by another nation) get a weight from their base, the strength of both
//             camps, fatigue and memory; a move of GOAL_SHOW or more is recorded as 'goal-weight' { goal, from, to }.
//   answers   every offer addressed to it is scored by diplomacy.evaluate (the same breakdown the screens show) and
//             accepted or refused.
//   strategy  nation.ai.strategy = { targets: [{ nation, weight, posture }] } over its enemies, in nation order, for
//             the operations AI (posture attack when strong enough, or when it has not fought for STILL_DAYS); a change of main enemy is recorded.
//   war       candidates (neighbours and the enemies of its allies; every living nation on hard) scored on goals,
//             grudge, trust, strength of both camps, wars already fought, fatigue, and, for a nation at peace with
//             everyone, the step from peace to war (AT_PEACE less AT_PEACE_BOLD per point of boldness); the best is
//             declared when it passes the personality's war threshold.
//   join      a `join` goal whose `when` holds joins its bloc.
//   peace     toward each enemy it is tired of, losing to, fighting for nothing, winning against, or at war with
//             while none of its divisions fought for STILL_DAYS (nation.ai.fought: the last hour one did), candidate
//             terms (keep what it holds, keep what it wants, white, give back) are scored by evaluate for both
//             sides; it offers the best for itself that both would accept.
//   doctrine  the training template grows with the days of war (doctrine(): heavy artillery, machine guns, tanks
//             and an air squadron once unlocked), as a new template; raised divisions keep theirs.
//   economy   every 7 days: production lines toward half what a division of the training template costs to equip
//             (and SHELL_STEADY hours of its fire) and half what the army lacks against the stock (shells: SHELL_HOURS
//             of fire for every division at war), moving at most a STEP-th of the factories a week; training of the
//             doctrine() template (the lean one while the stock cannot equip the full one), at most max(2, military
//             factories / TRAIN_PER) a batch and two batches at once, by what manpower and equipment allow;
//             construction, mobilisation.
// Difficulty (state.settings.difficulty): easy adds a seeded -100..100 to each score and considers fewer peace
// terms; hard widens the war candidates to every nation and the peace terms to more partial cessions. The AI reads
// only what the screens show and gets no free resources.
(function (factory) {
  const NODE = typeof module === 'object' && !!module.exports;
  const api = factory();
  if (NODE) module.exports = api;
  else { const C = (globalThis.Conquest = globalThis.Conquest || {}); (C.ai = C.ai || {}).nation = api; }
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const C = NODE ? null : globalThis.Conquest;
  const O = NODE ? require('../orders.js') : C.orders;
  const T = NODE ? require('../tick.js') : C.tick;
  const U = NODE ? require('../units.js') : C.units;
  const I = NODE ? require('../industry.js') : C.industry;
  const M = NODE ? require('../mapdata.js') : C.mapdata;
  const D = NODE ? require('../diplomacy.js') : C.diplomacy;
  const EV = NODE ? require('../events.js') : C.events;
  const X = NODE ? require('./explain.js') : C.ai.explain;
  const MEM = NODE ? require('./memory.js') : C.ai.memory;
  const PER = NODE ? require('./personality.js') : C.ai.personality;

  const DAY = 24;
  const GOAL_SHOW = 150;
  const OFFER_GAP_DAYS = 30;
  const QUIET_DAYS = 30;
  const AT_PEACE = 1200;
  const AT_PEACE_BOLD = 4;
  const SHELL_HOURS = 12;
  const SHELL_STEADY = 72;
  const STEP = 8;
  const TRAIN_PER = 3;
  const STILL_DAYS = 45;
  const DOCTRINE = [270, 720, 1100];
  const ORDER = ['inf', 'cav', 'mg', 'art', 'heavy', 'tank', 'eng', 'air'];

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const record = (ctx, n, chosen, options, factors) => X.record(ctx, n, { layer: 'nation', chosen, options, factors });

  function noise(ctx, n, salt) {
    const { state } = ctx;
    if (!state.settings || state.settings.difficulty !== 'easy') return 0;
    let h = Math.imul(Math.trunc(state.hour / DAY) + 3, 2246822519) ^ Math.imul(n * 977 + salt, 3266489917);
    h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
    return ((h >>> 8) % 201) - 100;
  }
  const hard = (ctx) => !!ctx.state.settings && ctx.state.settings.difficulty === 'hard';

  // ---- goals ----
  function goalsOf(ctx, n, me) {
    const { state, scenario } = ctx;
    const f = D.facts(ctx);
    const P = state.prov;
    const out = [];
    const nat = state.nations[n];
    for (const g of scenario.nations[n].goals || []) {
      const base = clamp(g.weight | 0 || 500, 0, 1000);
      const factors = [];
      let w = base;
      const kind = g.kind === 'defend-nation' ? 'defend' : g.kind === 'join-when' ? 'join' : g.kind;
      if (kind === 'take') {
        const list = g.provinces || [];
        const by = new Int32Array(f.k);
        let mine = 0;
        for (const p of list) { const c = P.ctrl[p]; if (c === n) mine++; else if (c >= 0) by[c]++; }
        let holder = -1;
        for (let b = 0; b < f.k; b++) if (by[b] > 0 && (holder < 0 || by[b] > by[holder])) holder = b;
        let mult = 1000;
        if (holder >= 0 && list.length && mine < list.length) {
          const s = clamp(Math.trunc(((D.ratio(ctx, n, holder) - 1000) * 2) / 5), -600, 400);
          mult += s;
          factors.push({ label: 'strength', args: { nation: holder }, delta: Math.trunc((base * s) / 1000) });
          if (mine > 0) { const pr = Math.trunc((mine * 300) / list.length); mult += pr; factors.push({ label: 'progress', delta: Math.trunc((base * pr) / 1000) }); }
        } else if (list.length && mine === list.length) { mult = 600; factors.push({ label: 'reached', delta: -Math.trunc((base * 400) / 1000) }); }
        if (nat.fatigue > 300) { const fa = -Math.trunc(((nat.fatigue - 300) * 3) / 4); mult += fa; factors.push({ label: 'fatigue', delta: Math.trunc((base * fa) / 1000) }); }
        w = clamp(Math.trunc((base * clamp(mult, 100, 1500)) / 1000), 0, 1000);
        out.push({ id: g.id, kind, w, provinces: list, factors });
      } else if (kind === 'hold') {
        const list = g.provinces || [];
        const lost = list.some((p) => P.ctrl[p] !== n);
        if (lost) factors.push({ label: 'threat', delta: Math.trunc((base * 300) / 1000) });
        w = clamp(Math.trunc((base * (lost ? 1300 : 1000)) / 1000), 0, 1000);
        out.push({ id: g.id, kind, w, provinces: list, factors });
      } else if (kind === 'defend') {
        const t = f.index.has(g.nation) ? f.index.get(g.nation) : -1;
        if (t < 0 || !state.nations[t].alive) { factors.push({ label: 'gone', delta: -base }); w = 0; } else if (D.enemies(state, t).length) { factors.push({ label: 'under-attack', args: { nation: t }, delta: Math.trunc((base * 300) / 1000) }); w = clamp(Math.trunc((base * 1300) / 1000), 0, 1000); } else { factors.push({ label: 'at-peace', args: { nation: t }, delta: -Math.trunc((base * 300) / 1000) }); w = Math.trunc((base * 700) / 1000); }
        out.push({ id: g.id, kind, w, nation: t, factors });
      } else if (kind === 'join') {
        const done = nat.bloc === g.bloc;
        const ready = !done && EV.test(ctx, g.when);
        w = ready ? base : 0;
        factors.push({ label: done ? 'joined' : ready ? 'condition-met' : 'condition-not-met', delta: w - base });
        out.push({ id: g.id, kind, w, bloc: g.bloc, provinces: g.provinces || [], ready, factors });
      }
    }
    const rev = PER.factor(ctx, n, 'revanchism');
    const cores = [];
    const lands = [];
    for (let p = 1; p < P.ctrl.length; p++) {
      const b = P.ctrl[p];
      if (b < 0 || b === n) continue;
      if (f.core[n][p]) (cores[b] || (cores[b] = [])).push(p); else if (f.startOwner[p] === n) (lands[b] || (lands[b] = [])).push(p);
    }
    for (let b = 0; b < f.k; b++) {
      if (b === n || !state.nations[b].alive || D.allied(state, n, b)) continue;
      const core = cores[b] || [];
      const land = lands[b] || [];
      for (const [kind, list, memKind] of [['retake-core', core, 'took-our-core'], ['retake-land', land, 'took-our-land']]) {
        if (!list.length) continue;
        const amount = me.amount(b, memKind);
        const fromMemory = Math.trunc((amount * 700) / 1000);
        const w = clamp(Math.trunc((fromMemory * rev) / 1000), 0, 1000);
        if (w <= 0) continue;
        out.push({ id: `${kind}-${state.nations[b].tag}`, kind: 'take', w, provinces: list, against: b,
          factors: [{ label: 'memory', args: { kind: memKind, nation: b }, delta: fromMemory }, { label: 'revanchism', delta: w - fromMemory }] });
      }
    }
    return out;
  }

  function updateGoals(ctx, n, goals) {
    const ai = ctx.state.nations[n].ai;
    const old = ai.goals || [];
    const next = [];
    for (const g of goals) {
      const prev = old.find((x) => x.id === g.id);
      let shown = prev ? prev.shown : 0;
      if (Math.abs(g.w - shown) >= GOAL_SHOW) {
        record(ctx, n, { label: 'goal-weight', args: { goal: g.id, from: shown, to: g.w } }, [{ label: 'goal-weight', args: { goal: g.id }, score: g.w }], g.factors);
        shown = g.w;
      }
      next.push({ id: g.id, w: g.w, shown });
    }
    for (const prev of old) {
      if (goals.some((g) => g.id === prev.id) || prev.shown < GOAL_SHOW) continue;
      record(ctx, n, { label: 'goal-weight', args: { goal: prev.id, from: prev.shown, to: 0 } }, [], [{ label: 'gone', delta: -prev.shown }]);
    }
    ai.goals = next;
  }

  // What a war with t is worth by the goals.
  function goalValue(ctx, n, goals, t) {
    const P = ctx.state.prov;
    let v = 0;
    for (const g of goals) {
      if (g.kind === 'take' && g.provinces.length) {
        let held = 0;
        for (const p of g.provinces) if (P.ctrl[p] === t) held++;
        v += Math.trunc((g.w * held) / g.provinces.length);
      } else if (g.kind === 'defend' && g.nation >= 0 && D.atWar(ctx.state, g.nation, t)) v += g.w;
      else if (g.kind === 'join' && g.ready && g.provinces.length) {
        let held = 0;
        for (const p of g.provinces) if (P.ctrl[p] === t) held++;
        v += Math.trunc((g.w * held) / g.provinces.length);
      }
    }
    return v;
  }

  // A nation's strength as a threat: its divisions at its readiness (a neighbour still mobilising counts for less).
  const armed = (state, v, a) => Math.trunc((v.str[a] * M.ready(state, a)) / 1000);

  function threat(ctx, n, me) {
    const { state } = ctx;
    const v = D.view(ctx);
    const k = state.nations.length;
    let t = 0;
    for (let b = 0; b < k; b++) {
      if (b === n || !state.nations[b].alive || D.allied(state, n, b) || !v.border[n * k + b]) continue;
      let x = clamp(Math.trunc((armed(state, v, b) * 1000) / Math.max(1, armed(state, v, n))), 0, 2000);
      if (!(me.feel.trust[b] < 0 || me.feel.grudge[b] > 200 || D.atWar(state, n, b))) x >>= 1;
      if (x > t) t = x;
    }
    return clamp(t, 0, 1000);
  }

  // ---- answers ----
  function answerOffers(ctx, n, issue) {
    const { state } = ctx;
    const mine = (state.offers || []).filter((o) => o.to === n);
    for (const o of mine) {
      if (!(state.offers || []).some((x) => x.id === o.id)) continue;
      const ev = D.evaluate(ctx, o.from, n, o.action, o.terms);
      const yes = ev.accept && D.offerCheck(ctx, o.from, o.to, o.action, o.terms).ok;
      record(ctx, n, { label: yes ? 'answer-accept' : 'answer-refuse', args: { action: o.action, nation: o.from, offer: o.id, reply: ev.reply.key } },
        [{ label: 'accept', score: ev.score }, { label: 'refuse', score: ev.threshold }], ev.factors);
      issue({ type: 'diplo', action: yes ? 'accept' : 'refuse', offer: o.id });
    }
  }

  // ---- strategy ----
  function strategy(ctx, n, goals, me) {
    const { state } = ctx;
    const v = D.view(ctx);
    const k = state.nations.length;
    const nat = state.nations[n];
    const targets = [];
    const scored = [];
    const attackAt = PER.threshold(ctx, n, 'attack');
    for (const e of D.enemies(state, n)) {
      const g = goalValue(ctx, n, goals, e);
      const gr = Math.trunc(me.feel.grudge[e] / 2);
      const near = v.border[n * k + e] > 0;
      const th = Math.trunc(clamp(Math.trunc((armed(state, v, e) * 500) / Math.max(1, armed(state, v, n))), 0, 1000) / (near ? 1 : 3));
      const weight = clamp(100 + g + gr + th, 1, 1000);
      const r = D.ratio(ctx, n, e);
      const quiet = state.hour - (nat.ai.fought === undefined ? 0 : nat.ai.fought) > STILL_DAYS * DAY;
      const posture = (r >= attackAt || quiet) && nat.fatigue < 700 && near ? 'attack' : 'hold';
      targets.push({ nation: e, weight, posture });
      scored.push({ e, weight, factors: [{ label: 'goal', delta: g }, { label: 'grudge', args: { nation: e }, delta: gr }, { label: 'threat', args: { nation: e }, delta: th }, { label: 'strength', args: { nation: e }, delta: r - 1000 }] });
    }
    nat.ai.strategy = { targets };
    let main = -1;
    let best = null;
    for (const s of scored) if (!best || s.weight > best.weight) { best = s; main = s.e; }
    if (main !== (nat.ai.main === undefined ? -1 : nat.ai.main)) {
      if (best) record(ctx, n, { label: 'main-enemy', args: { nation: main, posture: targets.find((t) => t.nation === main).posture } },
        scored.map((s) => ({ label: 'target', args: { nation: s.e }, score: s.weight })), best.factors);
      nat.ai.main = main;
    }
  }

  // ---- war ----
  function war(ctx, n, goals, me, issue) {
    const { state } = ctx;
    const nat = state.nations[n];
    if (D.weak(state, n)) return;
    const v = D.view(ctx);
    const k = state.nations.length;
    const p = PER.of(ctx, n);
    const E = D.enemies(state, n);
    const myAllies = D.allies(state, n);
    let busy = 0;
    for (const e of E) busy += v.str[e];
    const options = [];
    const joins = [];
    for (let b = 0; b < k; b++) {
      if (b === n || !state.nations[b].alive || !D.warCheck(ctx, n, b).ok) continue;
      const alliesAtWar = myAllies.filter((a) => D.atWar(state, a, b));
      // Joining an ally's war is the answer to a call it did not make: the same evaluation, so a nation that would
      // refuse the call does not join on its own.
      if (alliesAtWar.length) {
        const ev = D.evaluate(ctx, alliesAtWar[0], n, 'call-to-arms', { against: b });
        joins.push({ b, ally: alliesAtWar[0], ev });
        continue;
      }
      if (!hard(ctx) && !v.border[n * k + b]) continue;
      const factors = [];
      const add = (label, delta, args) => { if (delta) factors.push(args ? { label, args, delta } : { label, delta }); };
      add('goal', goalValue(ctx, n, goals, b));
      add('grudge', Math.trunc((me.feel.grudge[b] * PER.factor(ctx, n, 'revanchism')) / 2000), { nation: b });
      add('trust', -Math.trunc((Math.max(0, me.feel.trust[b]) * 3) / 10), { nation: b });
      const r = Math.trunc((D.campStrength(ctx, n) * 1000) / Math.max(1, D.campStrength(ctx, b) + busy));
      add('strength', clamp(Math.trunc(((r - 1000) * 2) / 5), -400, 400), { nation: b });
      add('busy-us', -Math.trunc((250 * E.length * (p.caution + 50)) / 100));
      if (!E.length) add('at-peace', -(AT_PEACE - AT_PEACE_BOLD * p.boldness));
      if (D.enemies(state, b).length) add('busy-them', 150, { nation: b });
      add('fatigue', -Math.trunc((nat.fatigue * 6) / 10));
      add('noise', noise(ctx, n, b));
      let score = 0;
      for (const x of factors) score += x.delta;
      options.push({ b, score, factors });
    }
    for (const j of joins) {
      if (!j.ev.accept) continue;
      record(ctx, n, { label: 'join-war', args: { nation: j.b, ally: j.ally } }, [{ label: 'join-war', args: { nation: j.b }, score: j.ev.score }, { label: 'stay-out', score: j.ev.threshold }], j.ev.factors);
      issue({ type: 'diplo', action: 'declare-war', to: j.b });
      return;
    }
    if (!options.length) return;
    options.sort((x, y) => y.score - x.score || x.b - y.b);
    const best = options[0];
    const threshold = PER.threshold(ctx, n, 'war');
    const shown = options.slice(0, 2).map((o) => ({ label: 'declare-war', args: { nation: o.b }, score: o.score })).concat([{ label: 'keep-peace', score: threshold }]);
    if (best.score >= threshold) {
      record(ctx, n, { label: 'declare-war', args: { nation: best.b } }, shown, best.factors);
      issue({ type: 'diplo', action: 'declare-war', to: best.b });
    } else if (best.score >= threshold - 150 && state.hour - (nat.ai.quiet === undefined ? -1e9 : nat.ai.quiet) >= QUIET_DAYS * DAY) {
      record(ctx, n, { label: 'keep-peace', args: { nation: best.b } }, shown, best.factors);
      nat.ai.quiet = state.hour;
    }
  }

  function join(ctx, n, goals, issue) {
    const { state } = ctx;
    for (const g of goals) {
      if (g.kind !== 'join' || !g.ready || !g.bloc) continue;
      const enemyOfBloc = state.nations.some((x, b) => x.bloc === g.bloc && D.atWar(state, n, b));
      if (enemyOfBloc) continue;
      record(ctx, n, { label: 'join-bloc', args: { bloc: g.bloc, goal: g.id } }, [{ label: 'join-bloc', args: { bloc: g.bloc }, score: g.w }], g.factors);
      if (state.nations[n].bloc) issue({ type: 'diplo', action: 'leave-bloc' });
      issue({ type: 'diplo', action: 'join-bloc', bloc: g.bloc });
      return;
    }
  }

  // ---- peace ----
  function peace(ctx, n, goals, issue) {
    const { state } = ctx;
    const nat = state.nations[n];
    const f = D.facts(ctx);
    const ai = nat.ai;
    if (!ai.offered || ai.offered.length !== state.nations.length) ai.offered = state.nations.map(() => -1);
    const wantAt = PER.threshold(ctx, n, 'wantPeace');
    for (const e of D.enemies(state, n)) {
      if ((state.offers || []).some((o) => o.action === 'offer-peace' && ((o.from === n && o.to === e) || (o.from === e && o.to === n)))) continue;
      if (ai.offered[e] >= 0 && state.hour - ai.offered[e] < OFFER_GAP_DAYS * DAY) continue;
      const days = Math.trunc((state.hour - (D.rel(state, n, e).since | 0)) / DAY);
      if (days < 30) continue;
      const tired = nat.fatigue >= wantAt;
      const losing = D.ratio(ctx, n, e) < 600 && days > 60;
      const aimless = goalValue(ctx, n, goals, e) < 100 && days > 120;
      const still = days > STILL_DAYS && state.hour - (ai.fought === undefined ? 0 : ai.fought) > STILL_DAYS * DAY;
      const ours = D.occupied(ctx, e, n).slice().sort((x, y) => D.pts(ctx, n, y) - D.pts(ctx, n, x) || x - y);
      const theirs = D.occupied(ctx, n, e).slice().sort((x, y) => D.pts(ctx, e, y) - D.pts(ctx, e, x) || x - y);
      const winning = ours.length > 0 && state.nations[e].fatigue >= 400;
      if (!tired && !losing && !aimless && !winning && !still) continue;
      const wanted = ours.filter((p) => f.core[n][p] || f.goal[n][p]);
      const theyWant = theirs.filter((p) => f.core[e][p] || f.goal[e][p]);
      const cands = [];
      const push = (take, give) => {
        const key = `${take.join(',')}|${give.join(',')}`;
        if (!cands.some((c) => c.key === key)) cands.push({ key, take, give });
      };
      if (state.settings && state.settings.difficulty === 'easy') push([], []);
      else {
        push(ours, []);
        push(wanted, []);
        push(wanted.slice(0, Math.ceil(wanted.length / 2)), []);
        if (hard(ctx)) push(ours.slice(0, Math.ceil(ours.length / 4)), []);
        push([], []);
        push([], theyWant);
        push([], theirs);
      }
      const value = (c) => c.take.reduce((s, p) => s + D.pts(ctx, n, p), 0) - c.give.reduce((s, p) => s + D.pts(ctx, n, p), 0);
      cands.sort((x, y) => value(y) - value(x));
      const player = e === state.player;
      const tried = [];
      let chosen = null;
      for (const c of cands) {
        const them = D.evaluate(ctx, n, e, 'offer-peace', { take: c.take, give: c.give });
        const us = D.evaluate(ctx, e, n, 'offer-peace', { take: c.give, give: c.take });
        tried.push({ c, them, us });
        if (us.accept && (player || them.accept)) { chosen = tried[tried.length - 1]; break; }
      }
      if (!chosen) continue;
      const { c, them } = chosen;
      record(ctx, n, { label: 'offer-peace', args: { nation: e, take: c.take.length, give: c.give.length } },
        tried.slice(-3).map((t) => ({ label: 'peace-terms', args: { take: t.c.take.length, give: t.c.give.length }, score: t.them.score })), them.factors);
      ai.offered[e] = state.hour;
      issue({ type: 'diplo', action: 'offer-peace', to: e, terms: { take: c.take, give: c.give } });
    }
  }

  // ---- doctrine ----
  // The template a nation trains: its scenario's first one while it has fought under DOCTRINE[0] days, then, at each
  // step of DOCTRINE days of war (counted from the oldest war it is still fighting), two more infantry battalions
  // give way to heavy artillery and machine guns, and to tanks and an air squadron once it has them (rules.unlocks).
  // It is a new template ('<id>-w<step>'); divisions already raised keep theirs. With `lean` the tanks and the air
  // squadron are left out (heavy artillery instead of tanks): what it trains while its stock cannot equip the full one.
  function doctrine(ctx, n, issue, lean = false) {
    const { state } = ctx;
    const nat = state.nations[n];
    const base = ctx.scenario.nations[n].templates && ctx.scenario.nations[n].templates[0];
    const first = nat.templates[0];
    if (!base || !first) return first;
    let since = -1;
    for (const e of D.enemies(state, n)) { const h = D.rel(state, n, e).since | 0; if (since < 0 || h < since) since = h; }
    const days = since < 0 ? 0 : Math.trunc((state.hour - since) / DAY);
    let step = 0;
    while (step < DOCTRINE.length && days >= DOCTRINE[step]) step++;
    if (!step) return first;
    const has = (b) => !lean && (nat.unlocked || []).includes(b);
    const line = base.line.slice();
    const support = (base.support || []).slice();
    const swap = (b) => { const i = line.indexOf('inf'); if (i >= 0 && line.filter((x) => x === 'inf').length > 4) line[i] = b; };
    swap('heavy'); swap('mg');
    if (step >= 2) { swap(has('tank') ? 'tank' : 'heavy'); swap('art'); }
    if (step >= 3) { swap(has('tank') ? 'tank' : 'heavy'); swap('mg'); }
    if (has('air') && !support.includes('air') && support.length < ctx.rules.template.maxSupport) support.push('air');
    line.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    const id = `${base.id}-w${step}${has('tank') ? 't' : ''}${has('air') ? 'a' : ''}`;
    let tpl = nat.templates.find((t) => t.id === id);
    if (!tpl) {
      const year = state.year0 + Math.trunc((state.doy0 + Math.trunc(state.hour / DAY)) / 365);
      const name = `${base.name.replace(/\s*\(\d{4}\)\s*$/, '')} (${year})`;
      if (!issue({ type: 'template', template: { id, name, line, support } }).ok) return first;
      tpl = nat.templates.find((t) => t.id === id);
      record(ctx, n, { label: 'template', args: { template: id } }, [], [{ label: 'war-days', delta: days }]);
    }
    return tpl;
  }

  // ---- economy ----
  function economy(ctx, n, me, issue) {
    const { state, rules } = ctx;
    const nat = state.nations[n];
    const items = U.table(rules).items;
    let tpl = doctrine(ctx, n, issue);
    if (!tpl) return;
    const s = U.stats(rules, tpl);
    const atWar = D.enemies(state, n).length > 0;
    const th = threat(ctx, n, me);
    const want = atWar ? 6 : th >= 600 ? 3 : 1;
    const reserve = new Int32Array(items.length);
    for (const d of state.divs) {
      if (d.nation !== n || d.str >= 1000) continue;
      const ds = U.statsOf(ctx, d);
      for (let i = 0; i < items.length; i++) reserve[i] += Math.trunc((ds.equip[i] * (1000 - d.str)) / 1000);
    }
    // Shells are fired, not issued: keep SHELL_HOURS of fire for every division (while at war, or threatened).
    const si = items.indexOf('shells');
    if (si >= 0 && (atWar || th >= 600)) for (const d of state.divs) if (d.nation === n) reserve[si] += U.statsOf(ctx, d).shells * SHELL_HOURS;
    const usable = rules.items.map((it) => !it.unlock || (nat.unlocked || []).includes(it.unlock));
    const value = rules.items.map((it, i) => (usable[i] ? Math.max(0, want * s.equip[i] + reserve[i] - nat.stock[it.id]) * it.cost : 0));
    // The lines follow half what a division of the template costs to equip (and SHELL_STEADY hours of its fire) and
    // half what the army lacks, moving at most a STEP-th of the factories a week, so a line keeps its efficiency.
    const base = rules.items.map((it, i) => (usable[i] ? (i === si ? s.shells * SHELL_STEADY : s.equip[i]) * it.cost : 0));
    const sum = value.reduce((a, b) => a + b, 0);
    const bsum = base.reduce((a, b) => a + b, 0);
    const steady = sum === 0;
    const share = base.map((x, i) => (bsum ? Math.trunc(((steady ? 1000 : 500) * x) / bsum) : 0) + (sum ? Math.trunc((500 * value[i]) / sum) : 0));
    const mil = I.output ? I.output(ctx, n, 'mil') : I.factories(state, n, 'mil');
    const ssum = share.reduce((a, b) => a + b, 0);
    const goal = share.map((x) => (ssum ? Math.trunc((mil * x) / ssum) : 0));
    let left = mil - goal.reduce((a, b) => a + b, 0);
    const order = share.map((x, i) => i).sort((a, b) => share[b] - share[a] || a - b);
    for (let j = 0; left > 0 && ssum; j = (j + 1) % order.length) { if (share[order[j]] > 0) { goal[order[j]]++; left--; } }
    const current = rules.items.map((it) => { const l = nat.lines.find((x) => x.item === it.id); return l ? l.factories : 0; });
    const curSum = current.reduce((a, b) => a + b, 0);
    const step = Math.max(1, Math.trunc((mil + STEP - 1) / STEP));
    const target = goal.map((g, i) => current[i] + Math.max(-step, Math.min(step, g - current[i])));
    let diff = 0;
    for (let i = 0; i < target.length; i++) diff += Math.abs(target[i] - current[i]);
    if (diff > 0 || curSum > mil) {
      // A raise is legal only while the sum stays within the factories, so the cuts go first.
      let total = curSum;
      const set = (i, x) => { issue({ type: 'line', item: rules.items[i].id, factories: x }); total += x - current[i]; current[i] = x; };
      for (let i = 0; i < target.length; i++) if (target[i] < current[i]) set(i, target[i]);
      for (let i = 0; i < target.length; i++) {
        if (target[i] <= current[i] || total > mil) continue;
        const x = Math.min(target[i], mil - (total - current[i]));
        if (x > current[i]) set(i, x);
      }
      const args = {};
      rules.items.forEach((it, i) => { if (current[i]) args[it.id] = current[i]; });
      record(ctx, n, { label: 'production', args }, [], rules.items.map((it, i) => ({ label: steady ? 'steady' : 'lacks', args: { item: it.id }, delta: sum ? Math.trunc((value[i] * 1000) / sum) : 0 })).filter((x) => x.delta));
    }

    const cap = M.facts(ctx).capital[n];
    const P = state.prov;
    const held = (p) => P.owner[p] === n && P.ctrl[p] === n;
    let home = held(cap) ? cap : -1;
    for (let p = 1; home < 0 && p < P.owner.length; p++) if (held(p) && !ctx.map.provinces[p].sea) home = p;
    if (home < 0) return;
    if ((atWar || th >= 600) && nat.training.length < 2) {
      const afford = (t) => {
        const st = U.stats(rules, t);
        let c = st.manpower > 0 ? Math.trunc((nat.manpower * 3) / 4 / st.manpower) : 8;
        for (let i = 0; i < items.length; i++) if (st.equip[i] > 0) c = Math.min(c, Math.trunc((nat.stock[items[i]] * 3) / 4 / st.equip[i]));
        return c;
      };
      let count = afford(tpl);
      if (count < 1) { const lean = doctrine(ctx, n, issue, true); if (lean && lean !== tpl) { tpl = lean; count = afford(tpl); } }
      count = Math.min(count, Math.max(2, Math.trunc(mil / TRAIN_PER)), rules.train.maxCount);
      if (count >= 1) {
        record(ctx, n, { label: 'train', args: { template: tpl.id, count, province: home } }, [], [{ label: 'threat', delta: th }, { label: 'at-war', delta: atWar ? 1000 : 0 }].filter((x) => x.delta));
        issue({ type: 'train', template: tpl.id, count, at: home });
      }
    }
    if (!nat.builds.length && (I.factories(state, n, 'civ') > 0)) {
      const B = rules.build;
      const what = atWar || th >= 600 ? 'mil' : I.factories(state, n, 'civ') < I.factories(state, n, 'mil') ? 'civ' : 'mil';
      let at = -1;
      if (held(home) && P[what][home] < B.max[what]) at = home;
      for (let p = 1; at < 0 && p < P.owner.length; p++) if (held(p) && !ctx.map.provinces[p].sea && P[what][p] < B.max[what]) at = p;
      if (at > 0) issue({ type: 'build', what, province: at });
    }
    const mob = atWar ? 1000 : th >= 600 ? 500 : 0;
    if (nat.dip.mobTarget !== mob) {
      record(ctx, n, { label: 'mobilise', args: { level: mob } }, [], [{ label: atWar ? 'at-war' : 'threat', delta: atWar ? 1000 : th }]);
      issue({ type: 'diplo', action: 'mobilise', level: mob });
    }
  }

  function think(ctx, n) {
    const { state } = ctx;
    D.ensure(state);
    if (!state.nations[n].alive) return;
    const feel = MEM.feelings(ctx, n);
    const me = { feel, amount: (b, kind) => MEM.amount(ctx, n, b, kind) };
    const issue = (o) => {
      const r = O.apply(ctx, n, o);
      if (!r.ok && api.onRefused) api.onRefused(n, o, r);
      return r;
    };
    const nat = state.nations[n];
    if (state.battles.some((b) => b.side === n || b.def.some((id) => { const d = M.divById(state, id); return d && d.nation === n; }))) nat.ai.fought = state.hour;
    const goals = goalsOf(ctx, n, me);
    updateGoals(ctx, n, goals);
    answerOffers(ctx, n, issue);
    if (!state.nations[n].alive) return;
    join(ctx, n, goals, issue);
    war(ctx, n, goals, me, issue);
    strategy(ctx, n, goals, me);
    peace(ctx, n, goals, issue);
    if (Math.trunc(state.hour / DAY) % 7 === n % 7) economy(ctx, n, me, issue);
  }

  const api = { think, goalsOf, onRefused: null };
  T.addLayer({ name: 'nation', every: DAY, at: 0, run: think });
  return api;
});
