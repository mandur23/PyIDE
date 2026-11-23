// The screens' read-only questions about the running game (architecture section 7), answered in the worker by host.js.
// answer(ctx, what, args) -> a plain value (structured-clone safe), or throws an Error whose message is the reason
// ('unknown-query', 'no-such-province', ...). Nothing here writes state; the path search's memo and the relation
// cache it may fill are derived caches (architecture section 2). `args.nation` defaults to the player's nation.
//
//   province  { id }              name, terrain, climate, weather, supply, infra, mil, civ, hub, coal, iron, oil,
//                                 owner, ctrl, cores [nation], coastal, port, sea, works and dug (movement.dugIn; null
//                                 at sea), trench (movement.TRENCH, the works dug needs), divisions [div rows],
//                                 battle | null ({ id, side, att, def, hours, odds,
//                                 from, line: the defending line's division ids, lineMax: combat.LINE })
//   division  { id }              div row plus path, eta, dest, stats (units.stats of its template), template { line,
//                                 support } (branch ids), general and trait of its army, battle (the province of a
//                                 battle it stands in or enters, else null)
//   battle    { prov }            the battle in prov (below); 'no-battle' when there is none
//   army      { id, nation }      { id, name, general, trait, front, offensives, divisions [div rows] }
//   legal     { order }           orders.legal as the player
//   stats     { template }        units.stats(rules, template)
//   route     { div, to }         { path: [province] | null, why, hours } as the division would walk it now
//   attackOdds { army, prov }     { odds, attackers, defenders }: ai/mil-common.js odds() (the generals' estimate, in
//                                 the engine's power numbers) for the player's army's divisions its general may move
//                                 (mil.usable) that stand next to prov, attacking it now; odds 1000 with no defenders,
//                                 null with no such division. Needs the AI modules (the worker).
//   explain   { nation }          ai.explain.recent; another nation's 'operations' and 'general' decisions (where it
//                                 will attack) only once the game is over (plan 5.5)
//   memory    { nation, summary } state.memory[nation]; with summary: { trust: [per nation], grudge: [per nation],
//                                 about: ai.memory.summary (per nation it remembers, its lines newest first) }
//   nation    { nation }          { nation, tag, alive, bloc, major, capital, fatigue, mobilisation, mobTarget, personality,
//                                 goals: [{ id, kind, base, weight, provinces, held, progress, nation, bloc }] } (weight:
//                                 the nation AI's current one, base when it has none; held/progress for take and hold)
//   calls     { to }              who the player's declaration of war on `to` calls in (diplomacy.declareWar's rule):
//                                 { ours: [nation], theirs: [nation], betrayal }
//   peace     { to, provinces }   { take: [{ id, us, them }] (to's provinces the player controls), give: [...] (the
//                                 player's that `to` controls), extra: [{ id, owner, us, them }] (each of `provinces`) };
//                                 us / them = diplomacy.pts for the player / for `to`
//   relations { nation }          [{ nation, tag, war, ally, access, truce, since, bloc }] for every other nation
//   evaluate  { to, action, terms }  diplomacy.evaluate from the player to `to`
//   outcome   {}                  diplomacy.outcome or null
//   plans     { nation }          [{ army, name, front, offensives }]; another nation's only once the game is over
//   hash      {}                  hash.hash(state), 8 hex digits
//   economy   { nation }          what the production screens show, computed as industry.js runs its next day (below)
//   suggestFronts { nation, armies? }  the staff's split of the contact line among the armies (below)
//   decisions { nation }          [{ id, wars: [nation] }]: the scenario events left to the player (skipIfPlayer is
//                                 the nation's tag) that have not fired, whose `when` holds now (events.holds, no
//                                 roll) and that would declare war for the nation; wars are those of them the war
//                                 check allows today. What an AI nation does by event, the player is asked
//   buildable { what }            { provinces: [ids where a build of `what` is legal now], levels: [[id, level]] of
//                                 those, cost, perDay (civil factories × build.perCiv), ahead (points queued before) }
//
// economy -> { mil, civ, used, free, lines: [{ item, factories, used, eff, prog, cost, perDay, R, lacks }], items: [{ id,
// cost, needs, locked, unlock: { branch, from, mil } | null, line }], stock, perDay: { item: tenths made a day },
// reinforce: { item: what reinforcement takes a day at today's losses }, resources: { coal|iron|oil: { own, demand,
// imported, blockade, suff } }, manpower: { pool, recruits, draft, training, casualties }, builds: [{ what, prov,
// prog, cost, days }], perCiv, training: [{ id, tpl, count, at, done, hours (until the daily run that forms it) }], templates: [{ id, name, uses, manpower,
// equip: { item: n }, canEquip }], unlocked, fatigue: { value, capitulate, collapse, collapseBase, collapseSlope } }. perDay of a line is in tenths of a unit (its production points over the
// item's cost × 10, truncated) as the next daily run makes them before efficiency grows; R the sufficiency (0..1000)
// of its scarcest resource; lacks the resources under 1000, and 'locked' when its unlock is missing. canEquip is how
// many divisions of the template the stock and manpower pay for now. recruits are the men core and occupied provinces
// add a day, draft the mobilisation's (diplomacy.js), both before the carry. days is the whole game days until the
// build is done at today's civil factories, the builds ahead of it first (null without civil factories). fatigue is the
// nation's war fatigue with diplomacy.js's thresholds (capitulation and collapse possible from; the collapse chance a day
// in per mille is collapseBase + (value - collapse) / collapseSlope), for the top bar's explanation.
// suggestFronts -> [{ army, provinces, kind: 'front' | 'reserve', against: [nation] }] for each army of args.armies
// (default every army): the fronts operations.fronts gives those of them that have divisions, the path the operations
// AI takes for an AI nation (its contact line with the shared line beside allies, colonies facing an enemy's home, the
// capital guard and the expedition), on a copy of the nation's expedition memory, so nothing changes; an army with no
// division, and every army when there is no contact line, gets the capital and the land the nation holds next to it
// as a reserve. A front's provinces come in chain order (from an end of the line along it), the order the map draws
// the line in. Needs the AI modules (the worker).
// battle -> { id, prov, side, defender, hours, odds, from, terrain, weather, works, dug, trench, line, lineMax, att, def,
// hour, factors }. att and def are div rows of the divisions entering prov on the attackers' side and standing in it
// against them, each with role 'engaged' (fought the last hour), 'waiting' (behind the engaged ones, or a defender in
// the line), 'outside' (a defender outside the line) or 'broken' (org 0). hour is null until the battle has fought an
// hour since the game was loaded; else { hour, A, D, flank, siege, width, dirs, odds, att: [{ id, shellF, power, steps }],
// def: [{ id, power, steps }] }: combat.attackPower and defencePower run again on what that hour was fought with
// (combat.lastHour), steps being every multiply they made ([['base', v], [factor, permille, raw?]]); A = flank × Σ att
// power, D = Σ def power, odds = A × 1000 / (A + D) truncated, which is b.odds. factors = { att, def }: [{ key, effect }]
// sorted by |effect|, effect the signed permille the side's total gains from the factor (its total against its total
// without it): strength, terrain, weather, river, landing, supply, general (with its terrain relief), readiness,
// counters, shells and flank for the attackers; strength, terrain, works, siege (artillery against the works), supply,
// general and readiness for the defenders. Factors with no effect are left out.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).queries = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const G = NODE ? null : globalThis.Conquest;
  const F = NODE ? require('./fixed.js') : G.fixed;
  const M = NODE ? require('./mapdata.js') : G.mapdata;
  const U = NODE ? require('./units.js') : G.units;
  const MV = NODE ? require('./movement.js') : G.movement;
  const CB = NODE ? require('./combat.js') : G.combat;
  const O = NODE ? require('./orders.js') : G.orders;
  const H = NODE ? require('./hash.js') : G.hash;
  const late = (name) => (NODE ? null : G[name]);
  const I = NODE ? require('./industry.js') : G.industry;

  const fail = (reason) => { throw new Error(reason); };
  const isInt = (x) => Number.isInteger(x);
  const nationOf = (ctx, args) => {
    const n = args && args.nation !== undefined ? args.nation : ctx.state.player;
    return isInt(n) && n >= 0 && n < ctx.state.nations.length ? n : fail('no-such-nation');
  };

  const coresOf = new WeakMap();
  function cores(ctx) {
    const { scenario, map } = ctx;
    let c = coresOf.get(scenario);
    if (c && c.map === map) return c;
    const list = Array.from({ length: map.provinces.length }, () => []);
    scenario.nations.forEach((s, i) => {
      const ids = (scenario.cores && scenario.cores[s.tag]) || (scenario.owner && scenario.owner[s.tag]) || [];
      for (const p of ids) if (p > 0 && p < list.length && !list[p].includes(i)) list[p].push(i);
    });
    c = { map, list };
    coresOf.set(scenario, c);
    return c;
  }

  function divRow(ctx, d) {
    const nat = ctx.state.nations[d.nation];
    const army = d.army === null ? null : nat.armies.find((a) => a.id === d.army) || null;
    const t = U.templateOf(ctx.state, d);
    return { id: d.id, nation: d.nation, tpl: d.tpl, tplName: t ? t.name : d.tpl, army: d.army, armyName: army ? army.name : null,
      prov: d.prov, to: d.to, str: d.str, org: d.org, sup: d.sup, dig: d.dig, manual: !!d.manual };
  }

  const traitOf = (ctx, nation, general) => {
    if (!general) return null;
    const s = ctx.scenario.nations[nation];
    const g = s && (s.generals || []).find((x) => x.name === general);
    return g ? g.trait : null;
  };

  const plain = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));

  // The player sees every decision of its own nation; of another nation, the nation layer's until the game is over.
  function visibleDecisions(ctx, n) {
    const ai = late('ai');
    const ex = NODE ? require('./ai/explain.js') : ai && ai.explain;
    if (!ex) return [];
    const list = ex.recent(ctx, n);
    const over = !!(ctx.state.diplo && ctx.state.diplo.outcome);
    return n === ctx.state.player || over ? list : list.filter((d) => d.layer === 'nation');
  }

  const Q = {
    province(ctx, { id }) {
      const { map, state, scenario } = ctx;
      const p = isInt(id) ? map.provinces[id] : null;
      if (!p) fail('no-such-province');
      const sp = (scenario.provinces && scenario.provinces[id]) || {};
      const w = ctx.rules.weather[state.prov.weather[id]];
      const b = state.battles.find((x) => x.prov === id) || null;
      const divs = [];
      for (const d of state.divs) if (d.prov === id) divs.push(divRow(ctx, d));
      return {
        id, name: p.name, sea: !!p.sea, terrain: p.terrain || null, climate: p.climate || null, coastal: !!p.coastal, port: !!p.port,
        weather: w ? w.id : null, supply: state.prov.supply[id], infra: state.prov.infra[id], mil: state.prov.mil[id], civ: state.prov.civ[id],
        hub: !!sp.hub, coal: sp.coal | 0, iron: sp.iron | 0, oil: sp.oil | 0,
        owner: state.prov.owner[id], ctrl: p.sea ? state.sea.ctrl[id] : state.prov.ctrl[id], cores: cores(ctx).list[id].slice(),
        works: p.sea ? null : state.prov.works[id], dug: p.sea ? null : MV.dugIn(state, id), trench: MV.TRENCH,
        divisions: divs,
        battle: b ? { id: b.id, side: b.side, att: b.att.slice(), def: b.def.slice(), hours: b.hours, odds: b.odds, from: b.from.slice(), line: (b.line || []).slice(), lineMax: CB.LINE } : null,
      };
    },
    battle(ctx, { prov }) { return battle(ctx, prov); },
    division(ctx, { id }) {
      const d = isInt(id) ? M.divById(ctx.state, id) : null;
      if (!d) fail('no-such-division');
      const t = U.templateOf(ctx.state, d);
      const army = d.army === null ? null : ctx.state.nations[d.nation].armies.find((a) => a.id === d.army) || null;
      const b = ctx.state.battles.find((x) => x.prov === d.prov || x.prov === d.to);
      return { ...divRow(ctx, d), path: d.path.slice(), eta: d.eta, dest: d.path.length ? d.path[d.path.length - 1] : d.to, stats: t ? plain(U.stats(ctx.rules, t)) : null,
        template: t ? { line: t.line.slice(), support: (t.support || []).slice() } : null, general: army ? army.general || null : null,
        trait: army ? traitOf(ctx, d.nation, army.general) : null, battle: b ? b.prov : null };
    },
    army(ctx, args) {
      const n = nationOf(ctx, args);
      const a = ctx.state.nations[n].armies.find((x) => x.id === args.id);
      if (!a) fail('no-such-army');
      const divisions = [];
      for (const id of a.divs) { const d = M.divById(ctx.state, id); if (d) divisions.push(divRow(ctx, d)); }
      return { id: a.id, nation: n, name: a.name, general: a.general, trait: traitOf(ctx, n, a.general), front: a.front ? a.front.slice() : null, offensives: plain(a.offensives), divisions };
    },
    legal(ctx, { order }) { return O.legal(ctx, ctx.state.player, order); },
    stats(ctx, { template }) { return plain(U.stats(ctx.rules, template)); },
    route(ctx, { div, to }) {
      const d = isInt(div) ? M.divById(ctx.state, div) : null;
      if (!d) fail('no-such-division');
      if (!isInt(to) || to <= 0 || to >= ctx.map.provinces.length) fail('no-such-province');
      if (to === d.prov) return { path: [], why: 'ok', hours: 0 };
      const r = MV.search(ctx, M.relations(ctx.state), d, to);
      if (!r.path) return { path: null, why: r.why, hours: 0 };
      const s = U.statsOf(ctx, d);
      let hours = 0;
      let from = d.prov;
      r.path.forEach((p, i) => {
        hours += i === 0 && d.to === p ? d.eta : MV.hours(ctx, s, from, p);
        from = p;
      });
      return { path: r.path, why: r.why, hours };
    },
    attackOdds(ctx, { army, prov }) {
      const n = ctx.state.player;
      const a = isInt(army) ? ctx.state.nations[n].armies.find((x) => x.id === army) : null;
      if (!a) fail('no-such-army');
      const p = isInt(prov) ? ctx.map.provinces[prov] : null;
      if (!p || p.sea) fail('no-such-province');
      const mil = NODE ? require('./ai/mil-common.js') : late('ai') && late('ai').mil;
      if (!mil) fail('unknown-query');
      const near = new Set(p.adj);
      const all = mil.usable(ctx, a).filter((d) => near.has(d.prov));
      if (!all.length) return { odds: null, attackers: 0, defenders: 0 };
      const r = mil.odds(ctx, mil.view(ctx), M.relations(ctx.state), n, all, prov);
      return { odds: r.p, attackers: all.length, defenders: r.count };
    },
    explain(ctx, args) { return plain(visibleDecisions(ctx, nationOf(ctx, args))); },
    memory(ctx, args) {
      const n = nationOf(ctx, args);
      if (!args.summary) return plain(ctx.state.memory[n] || []);
      const MEM = NODE ? require('./ai/memory.js') : late('ai') && late('ai').memory;
      if (!MEM) fail('not-implemented');
      const f = MEM.feelings(ctx, n);
      return { trust: Array.from(f.trust), grudge: Array.from(f.grudge), about: plain(MEM.summary(ctx, n)) };
    },
    nation(ctx, args) {
      const n = nationOf(ctx, args);
      const { state, scenario } = ctx;
      const nat = state.nations[n];
      const sc = scenario.nations[n] || {};
      const PER = NODE ? require('./ai/personality.js') : late('ai') && late('ai').personality;
      const current = (nat.ai && nat.ai.goals) || [];
      const D = NODE ? require('./diplomacy.js') : late('diplomacy');
      const index = (tag) => state.nations.findIndex((x) => x.tag === tag);
      const goals = (sc.goals || []).map((g) => {
        const kind = g.kind === 'defend-nation' ? 'defend' : g.kind === 'join-when' ? 'join' : g.kind;
        const list = g.provinces || [];
        const held = list.filter((p) => state.prov.ctrl[p] === n).length;
        const cur = current.find((x) => x.id === g.id);
        const base = (g.weight | 0) || 500;
        return { id: g.id, kind, base, weight: cur ? cur.w : base, provinces: list.slice(), held, progress: list.length ? Math.trunc((held * 1000) / list.length) : null,
          nation: g.nation ? index(g.nation) : null, bloc: g.bloc || null };
      });
      for (const c of current) {
        if (goals.some((g) => g.id === c.id)) continue;
        goals.push({ id: c.id, kind: 'take', base: 0, weight: c.w, provinces: [], held: 0, progress: null, nation: null, bloc: null });
      }
      return {
        nation: n, tag: nat.tag, alive: !!nat.alive, bloc: nat.bloc || null, major: !!sc.major, capital: sc.capital || 0,
        fatigue: nat.fatigue | 0, mobilisation: nat.mobilisation | 0, mobTarget: nat.dip ? nat.dip.mobTarget | 0 : 0,
        weak: !!(D && D.weak(state, n)), personality: PER ? plain(PER.of(ctx, n)) : null, goals,
      };
    },
    calls(ctx, { to }) {
      const D = NODE ? require('./diplomacy.js') : late('diplomacy');
      if (!D) fail('not-implemented');
      const { state } = ctx;
      const a = state.player;
      if (!isInt(to) || to < 0 || to >= state.nations.length || to === a) fail('no-such-nation');
      const pending = (from, z) => (state.offers || []).some((o) => o.from === from && o.to === z && o.action === 'call-to-arms');
      // As declareWar: the alliance between the two ends first, then each side's allies are called.
      const callable = (caller, enemy) => D.allies(state, caller).filter((z) => z !== enemy && z !== a && z !== to && !D.atWar(state, z, enemy) && !D.allied(state, z, enemy) && !pending(caller, z));
      const r = D.rel(state, a, to);
      const betrayal = r.brokeBy === a && r.broke >= 0 && state.hour - r.broke < D.TUNING.BETRAYAL_DAYS * 24;
      return { ours: callable(a, to), theirs: callable(to, a), betrayal };
    },
    peace(ctx, { to, provinces }) {
      const D = NODE ? require('./diplomacy.js') : late('diplomacy');
      if (!D) fail('not-implemented');
      const { state } = ctx;
      const a = state.player;
      if (!isInt(to) || to < 0 || to >= state.nations.length || to === a) fail('no-such-nation');
      const P = state.prov;
      const row = (p) => ({ id: p, us: D.pts(ctx, a, p), them: D.pts(ctx, to, p) });
      const take = [];
      const give = [];
      for (let p = 1; p < P.owner.length; p++) {
        if (ctx.map.provinces[p].sea) continue;
        if (P.owner[p] === to && P.ctrl[p] === a) take.push(row(p));
        else if (P.owner[p] === a && P.ctrl[p] === to) give.push(row(p));
      }
      const extra = (Array.isArray(provinces) ? provinces : []).slice(0, 400).filter((p) => isInt(p) && p > 0 && p < P.owner.length && !ctx.map.provinces[p].sea)
        .map((p) => ({ ...row(p), owner: P.owner[p] }));
      return { take, give, extra };
    },
    relations(ctx, args) {
      const n = nationOf(ctx, args);
      const { state } = ctx;
      const me = state.nations[n];
      const out = [];
      state.nations.forEach((x, i) => {
        if (i === n) return;
        const r = state.rel[M.key(me.tag, x.tag)] || {};
        out.push({ nation: i, tag: x.tag, war: !!r.war, ally: !!r.ally, access: !!r.access, truce: r.truce | 0, since: r.since === undefined ? null : r.since, bloc: x.bloc || null });
      });
      return out;
    },
    evaluate(ctx, { to, action, terms }) {
      const D = NODE ? require('./diplomacy.js') : late('diplomacy');
      if (!D) fail('not-implemented');
      return plain(D.evaluate(ctx, ctx.state.player, to, action, terms || {}));
    },
    outcome(ctx) {
      const D = NODE ? require('./diplomacy.js') : late('diplomacy');
      return D ? plain(D.outcome(ctx)) : null;
    },
    plans(ctx, args) {
      const n = nationOf(ctx, args);
      const over = !!(ctx.state.diplo && ctx.state.diplo.outcome);
      if (n !== ctx.state.player && !over) fail('hidden');
      return ctx.state.nations[n].armies.map((a) => ({ army: a.id, name: a.name, front: a.front ? a.front.slice() : null, offensives: plain(a.offensives) }));
    },
    hash(ctx) { return H.hash(ctx.state); },
    economy(ctx, args) { return economy(ctx, nationOf(ctx, args)); },
    buildable(ctx, { what }) {
      const { state, rules } = ctx;
      const n = state.player;
      if (!Object.prototype.hasOwnProperty.call(rules.build.cost, what)) fail('unknown-building');
      const provinces = [];
      const levels = [];
      for (let p = 1; p < state.prov.ctrl.length; p++) {
        if (state.prov.ctrl[p] !== n || state.prov.owner[p] !== n) continue;
        if (!O.legal(ctx, n, { type: 'build', what, province: p }).ok) continue;
        provinces.push(p);
        levels.push([p, state.prov[what][p]]);
      }
      const ahead = state.nations[n].builds.reduce((sum, b) => sum + rules.build.cost[b.what] - b.prog, 0);
      return { provinces, levels, cost: rules.build.cost[what], perDay: I.output(ctx, n, 'civ') * rules.build.perCiv, ahead };
    },
    suggestFronts(ctx, args) { return suggestFronts(ctx, nationOf(ctx, args), Array.isArray(args.armies) ? args.armies : null); },
    decisions(ctx, args) {
      const D = NODE ? require('./diplomacy.js') : late('diplomacy');
      const EV = NODE ? require('./events.js') : late('events');
      if (!D || !EV) fail('not-implemented');
      const { state } = ctx;
      const n = nationOf(ctx, args || {});
      const tag = state.nations[n].tag;
      const index = new Map(state.nations.map((x, i) => [x.tag, i]));
      const out = [];
      for (const ev of ctx.scenario.events || []) {
        if (!ev || typeof ev.id !== 'string' || ev.skipIfPlayer !== tag || (state.fired || []).includes(ev.id)) continue;
        const wars = [];
        for (const e of ev.effects || []) {
          if (!e || !Array.isArray(e.declareWar) || e.declareWar[0] !== tag) continue;
          const b = index.get(e.declareWar[1]);
          if (b !== undefined && state.nations[b].alive && !wars.includes(b) && D.warCheck(ctx, n, b).ok) wars.push(b);
        }
        if (wars.length && EV.holds(ctx, ev.when)) out.push({ id: ev.id, wars });
      }
      return out;
    },
  };

  function economy(ctx, n) {
    const { state, rules, map } = ctx;
    const nat = state.nations[n];
    const fa = M.facts(ctx);
    const T = U.table(rules);
    const ctrl = state.prov.ctrl;
    const core = fa.core[n];
    const own = { coal: 0, iron: 0, oil: 0 };
    let men = 0;
    for (let p = 1; p < ctrl.length; p++) {
      if (ctrl[p] !== n || map.provinces[p].sea) continue;
      men += rules.recruit.perProvince * (core[p] ? 1000 : rules.occupied.manpower);
      for (const r of M.RES) own[r] += fa.res[r][p] * rules.resources.perLevel;
    }
    const mil = I.output(ctx, n, 'mil');
    const civ = I.output(ctx, n, 'civ');
    let left = mil;
    const items = nat.lines.map((l) => rules.items.find((x) => x.id === l.item));
    const used = nat.lines.map((l) => { const u = Math.min(l.factories, left); left -= u; return u; });
    const resources = {};
    const suff = {};
    for (const r of M.RES) {
      let demand = 0;
      nat.lines.forEach((l, i) => { demand += used[i] * ((items[i].needs || {})[r] | 0); });
      const imported = Math.trunc((Math.max(0, demand - own[r]) * (1000 - nat.blockade)) / 1000);
      suff[r] = demand <= 0 ? 1000 : Math.min(1000, Math.trunc(((own[r] + imported) * 1000) / demand));
      resources[r] = { own: own[r], demand, imported, blockade: nat.blockade | 0, suff: suff[r] };
    }
    const perDay = {};
    for (const it of rules.items) perDay[it.id] = 0;
    const lines = nat.lines.map((l, i) => {
      const it = items[i];
      let R = 1000;
      const lacks = [];
      for (const r of Object.keys(it.needs || {})) if (it.needs[r] > 0) { if (suff[r] < R) R = suff[r]; if (suff[r] < 1000) lacks.push(r); }
      if (it.unlock && !nat.unlocked.includes(it.unlock)) lacks.push('locked');
      const pts = Math.trunc((Math.trunc((used[i] * l.eff * rules.industry.perFactory) / 1000) * R) / 1000);
      const tenths = Math.trunc((pts * 10) / it.cost);
      perDay[l.item] += tenths;
      return { item: l.item, factories: l.factories, used: used[i], eff: l.eff, prog: l.prog, cost: it.cost, perDay: tenths, R, lacks };
    });
    const unlocks = rules.unlocks || [];
    const itemList = rules.items.map((it) => {
      const u = it.unlock ? unlocks.find((x) => x.branch === it.unlock) || { branch: it.unlock, from: null, mil: 0 } : null;
      return { id: it.id, cost: it.cost, needs: { ...(it.needs || {}) }, locked: !!(u && !nat.unlocked.includes(u.branch)), unlock: u ? { branch: u.branch, from: u.from, mil: u.mil | 0 } : null,
        line: nat.lines.some((l) => l.item === it.id) };
    });
    const reinforce = {};
    for (const id of T.items) reinforce[id] = 0;
    for (const d of state.divs) {
      if (d.nation !== n || d.str >= 1000 || d.str <= 0) continue;
      const st = U.statsOf(ctx, d);
      const add = Math.min(1000 - d.str, rules.reinforce.perDay);
      T.items.forEach((id, k) => { reinforce[id] += Math.trunc((st.equip[k] * add) / 1000); });
    }
    let inTraining = 0;
    const training = nat.training.map((t) => {
      const tpl = nat.templates.find((x) => x.id === t.tpl);
      if (tpl) inTraining += U.stats(rules, tpl).manpower * t.count;
      return { id: t.id, tpl: t.tpl, count: t.count, at: t.at, done: t.done, hours: Math.max(0, Math.ceil(t.done / 24) * 24 - state.hour) };
    });
    const perCiv = rules.build.perCiv;
    const rate = civ * perCiv;
    let ahead = 0;
    const builds = nat.builds.map((b) => {
      const cost = rules.build.cost[b.what];
      ahead += cost - b.prog;
      return { what: b.what, prov: b.prov, prog: b.prog, cost, days: rate > 0 ? Math.ceil(ahead / rate) : null };
    });
    const uses = new Map();
    for (const d of state.divs) if (d.nation === n) uses.set(d.tpl, (uses.get(d.tpl) || 0) + 1);
    const templates = nat.templates.map((t) => {
      const st = U.stats(rules, t);
      const equip = {};
      let can = st.manpower > 0 ? Math.trunc(nat.manpower / st.manpower) : Infinity;
      T.items.forEach((id, k) => { equip[id] = st.equip[k]; if (st.equip[k] > 0) can = Math.min(can, Math.trunc(nat.stock[id] / st.equip[k])); });
      return { id: t.id, name: t.name, uses: uses.get(t.id) || 0, manpower: st.manpower, equip, canEquip: can === Infinity ? 0 : Math.max(0, can) };
    });
    const D = NODE ? require('./diplomacy.js') : late('diplomacy');
    const bonus = state.settings && state.settings.aiBonus && n !== state.player ? 1250 : 1000;
    const draft = D && D.TUNING ? Math.trunc(Math.trunc((Math.trunc(((ctx.scenario.nations[n].manpower | 0) * (nat.mobilisation | 0)) / 1000) * bonus) / 1000) / D.TUNING.draftDays) : 0;
    return {
      mil, civ, used: mil - left, free: left, lines, items: itemList, stock: { ...nat.stock }, perDay, reinforce, resources,
      manpower: { pool: nat.manpower, recruits: Math.trunc(men / 1000), draft, training: inTraining, casualties: nat.casualties | 0 },
      builds, perCiv, training, templates, unlocked: nat.unlocked.slice(),
      fatigue: { value: nat.fatigue | 0, capitulate: D ? D.TUNING.CAPITULATE_FATIGUE : 600, collapse: D ? D.TUNING.COLLAPSE_FATIGUE : 750,
        collapseBase: D ? D.TUNING.collapseBase : 3, collapseSlope: D ? D.TUNING.collapseSlope : 25 },
    };
  }

  // A division's recorded multiplies ([['base', v], [factor, permille, raw?], ...], combat.js) folded back into its
  // power; `pick(key, m, raw)` may give another permille for a factor, or null to leave it out.
  function fold(rec, pick = null, base = rec[0][1]) {
    let v = base;
    for (let i = 1; i < rec.length; i++) {
      const [k, m, raw] = rec[i];
      const x = pick ? pick(k, m, raw) : m;
      if (x !== null) v = F.mul(v, x);
    }
    return v;
  }
  // The signed permille a side's total gains from a factor: its total now against its total without it.
  const effect = (now, without) => (without > 0 ? Math.round((now * 1000) / without) - 1000 : 0);

  function battle(ctx, prov) {
    const { state, rules, map } = ctx;
    if (!isInt(prov) || !map.provinces[prov]) fail('no-such-province');
    const b = state.battles.find((x) => x.prov === prov);
    if (!b) fail('no-battle');
    const rel = M.relations(state);
    const ctrl = state.prov.ctrl[prov];
    const seen = CB.lastHour(b);
    const engaged = new Set(seen ? seen.att.concat(seen.def).map((x) => x.id) : []);
    const waiting = new Set(seen ? seen.waiting : []);
    const outside = new Set(seen ? seen.outside : []);
    const line = new Set(b.line || []);
    const role = (d, defending) => {
      if (engaged.has(d.id)) return 'engaged';
      if (d.org <= 0) return 'broken';
      if (waiting.has(d.id)) return 'waiting';
      if (outside.has(d.id)) return 'outside';
      return defending && !line.has(d.id) ? 'outside' : 'waiting';
    };
    const att = [];
    const def = [];
    for (const d of state.divs) {
      if (d.str <= 0) continue;
      if (d.to === prov && MV.joins(rel, d.nation, b.side, ctrl)) att.push({ ...divRow(ctx, d), role: role(d, false) });
      else if (d.prov === prov && M.hostile(rel, d.nation, b.side)) def.push({ ...divRow(ctx, d), role: role(d, true) });
    }
    const out = {
      id: b.id, prov, side: b.side, defender: ctrl, hours: b.hours, odds: b.odds, from: b.from.slice(),
      terrain: map.provinces[prov].terrain || null, weather: rules.weather[state.prov.weather[prov]]?.id || null,
      works: state.prov.works[prov], dug: MV.dugIn(state, prov), trench: MV.TRENCH,
      line: (b.line || []).slice(), lineMax: CB.LINE, att, def, hour: null, factors: null,
    };
    if (!seen) return out;
    const zero = new Int32Array(seen.defCounts.length);
    const A = seen.att.map((x) => { const rec = []; CB.attackPower(ctx, x, prov, seen.defCounts, x.shellF, rec); return { x, rec, s: U.statsOf(ctx, x) }; });
    const D = seen.def.map((x) => { const rec = []; CB.defencePower(ctx, x, prov, seen.siege, rec); return { x, rec }; });
    const sum = (list, pick, base) => list.reduce((t, r) => t + fold(r.rec, pick, base ? base(r) : undefined), 0);
    const sumA = sum(A);
    const sumD = sum(D);
    const totalA = F.mul(sumA, seen.flank);
    const keys = (list) => [...new Set(list.flatMap((r) => r.rec.slice(1).map((s) => s[0])))];
    const side = (list, total, extra) => {
      const f = [];
      for (const k of keys(list)) {
        if (k === 'general') {
          f.push({ key: k, effect: effect(total, sum(list, (key, m, raw) => (key === 'general' ? null : key === 'terrain' && raw !== undefined ? raw : m))) });
        } else if (k === 'works') {
          f.push({ key: k, effect: effect(total, sum(list, (key, m) => (key === 'works' ? null : m))) });
          f.push({ key: 'siege', effect: effect(total, sum(list, (key, m, raw) => (key === 'works' ? raw : m))) });
        } else {
          f.push({ key: k, effect: effect(total, sum(list, (key, m) => (key === k ? null : m))) });
        }
      }
      return f.concat(extra).filter((x) => x.effect !== 0).sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect) || (x.key < y.key ? -1 : 1));
    };
    const attExtra = [
      { key: 'counters', effect: effect(sumA, sum(A, null, (r) => U.attackVs(rules, r.s, zero, r.x.shellF))) },
      { key: 'shells', effect: effect(sumA, sum(A, null, (r) => U.attackVs(rules, r.s, seen.defCounts, 1000))) },
      { key: 'flank', effect: seen.flank - 1000 },
    ];
    out.hour = {
      hour: seen.hour, A: totalA, D: sumD, flank: seen.flank, siege: seen.siege, width: seen.width, dirs: seen.dirs.slice(),
      odds: totalA + sumD > 0 ? Math.trunc((totalA * 1000) / (totalA + sumD)) : 0,
      att: A.map((r) => ({ id: r.x.id, shellF: r.x.shellF, power: fold(r.rec), steps: r.rec })),
      def: D.map((r) => ({ id: r.x.id, power: fold(r.rec), steps: r.rec })),
    };
    out.factors = { att: side(A, sumA, attExtra), def: side(D, sumD, []) };
    return out;
  }

  // The provinces in drawing order: from an end of the line (fewest neighbours in it, then lowest id) to the next
  // neighbour in it, lowest id first, else to the nearest one left.
  function chain(ctx, provs) {
    const P = ctx.map.provinces;
    const set = new Set(provs);
    const deg = (p) => P[p].adj.filter((q) => set.has(q)).length;
    let cur = provs.slice().sort((a, b) => deg(a) - deg(b) || a - b)[0];
    const out = [cur];
    set.delete(cur);
    while (set.size) {
      let next = P[cur].adj.filter((q) => set.has(q)).sort((a, b) => a - b)[0];
      if (next === undefined) {
        const d2 = (q) => (Math.trunc(P[q].x) - Math.trunc(P[cur].x)) ** 2 + (Math.trunc(P[q].y) - Math.trunc(P[cur].y)) ** 2;
        next = [...set].sort((a, b) => d2(a) - d2(b) || a - b)[0];
      }
      out.push(next);
      set.delete(next);
      cur = next;
    }
    return out;
  }

  function suggestFronts(ctx, n, only) {
    const ai = late('ai');
    const B = NODE ? require('./ai/mil-common.js') : ai && ai.mil;
    const OPS = NODE ? require('./ai/operations.js') : ai && ai.operations;
    if (!B || !OPS) fail('not-implemented');
    const { state } = ctx;
    const nat = state.nations[n];
    const m = M.of(ctx);
    const rel = M.relations(state);
    const v = B.view(ctx);
    const tg = B.targets(ctx, n, rel);
    const ctrl = state.prov.ctrl;
    const armies = nat.armies.filter((a) => !only || only.includes(a.id));
    const cap = ctx.scenario.nations[n].capital;
    const reserve = [];
    if (cap && ctrl[cap] === n) { reserve.push(cap); for (const q of m.adj[cap]) if (!m.sea[q] && ctrl[q] === n) reserve.push(q); }
    reserve.sort((x, y) => x - y);
    const out = new Map();
    // The operations AI's own fronts (shared line with allies, colonies facing an enemy's home, the capital guard),
    // for the armies that have divisions: an empty army waits in reserve until trained divisions join it.
    const staffed = armies.map((a) => ({ army: a, divs: B.usable(ctx, a) })).filter((a) => a.divs.length);
    if (staffed.length && B.contact(ctx, v, rel, n, tg).length) {
      const budget = { left: OPS.WORK, legs: new Map((nat.ai && nat.ai.legs) || []) };
      const { plan } = OPS.fronts(ctx, v, rel, n, tg, staffed, { exp: (nat.ai && nat.ai.ops && nat.ai.ops.exp) || 0 }, budget);
      for (const { army: a } of staffed) {
        const provs = (plan.get(a.id) || { provs: [] }).provs;
        const against = new Set();
        for (const p of provs) for (const q of m.adj[p]) if (!m.sea[q] && B.faced(tg, rel, n, ctrl[q])) against.add(ctrl[q]);
        if (provs.length) out.set(a.id, { army: a.id, provinces: chain(ctx, provs), kind: 'front', against: [...against].sort((x, y) => x - y) });
      }
    }
    return armies.map((a) => out.get(a.id) || { army: a.id, provinces: reserve.slice(), kind: 'reserve', against: [] });
  }

  function answer(ctx, what, args) {
    if (!ctx) fail('no-game');
    const q = typeof what === 'string' && Object.prototype.hasOwnProperty.call(Q, what) ? Q[what] : null;
    if (!q) fail('unknown-query');
    return q(ctx, args && typeof args === 'object' ? args : {});
  }

  return { answer, visibleDecisions, QUERIES: Object.keys(Q) };
});
