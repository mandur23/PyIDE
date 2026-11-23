// Scenario events (plan 4.1): conditions, not dates. A daily system after diplomacy checks scenario.events in array
// order; an event whose `when` holds fires, its effects apply in order on that hour, its id goes to state.fired
// (once) and the hour it last fired to state.firedAt at the same index, and the firing goes to out.events and the
// log as { kind: 'fired', id }. `once: true` fires at most once; an event without it fires again on a later day its
// `when` holds, at most once every `every` days (default 30). `skipIfPlayer: tag` never fires while the player plays
// that tag. Nations are named by tag.
//
// Conditions (one key per object): { all: [..] } { any: [..] } { not: c } { war: [A, B] } { atWar: A }
// { ally: [A, B] } { bloc: [A, bloc | null] } { controls: [A, [ids]] } { controlsAny: [A, [ids]] }
// { fatigueAbove: [A, n] } { dateAfter: 'YYYY-MM-DD' } { fired: id } { daysSince: [id, n] } { chance: perMille }.
// `chance` rolls state.rng and is evaluated after its siblings, only when they hold. An unknown key is false.
// holds(ctx, when) is the same test without the roll (a `chance` counts as true), for queries, which must not
// touch the rng.
// Effects: { declareWar: [A, B] } { peace: [A, B] } { ally: [A, B] } { joinBloc: [A, bloc | null] } { mobilise: A }
// { collapse: A } { log: key }. They go through the functions the 'diplo' order uses; one that would be refused as
// an order (a war during a truce, peace with someone not at war) is skipped.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).events = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const D = NODE ? require('./diplomacy.js') : globalThis.Conquest.diplomacy;
  const R = NODE ? require('./rng.js') : globalThis.Conquest.rng;
  const ST = NODE ? require('./state.js') : globalThis.Conquest.state;
  const MV = NODE ? require('./movement.js') : globalThis.Conquest.movement;
  const T = NODE ? require('./tick.js') : globalThis.Conquest.tick;

  const DAY = 24;
  const nation = (ctx, tag) => { const i = D.facts(ctx).index.get(tag); return i === undefined ? -1 : i; };
  const day = (year, doy) => year * 365 + doy;
  const today = (state) => day(state.year0, state.doy0) + Math.trunc(state.hour / DAY);

  function firedHour(state, id) {
    const i = (state.fired || []).indexOf(id);
    if (i < 0) return -1;
    return state.firedAt && state.firedAt[i] !== undefined ? state.firedAt[i] : 0;
  }

  function test(ctx, c, dry = false) {
    if (!c || typeof c !== 'object') return false;
    const { state } = ctx;
    const k = Object.keys(c)[0];
    const v = c[k];
    const n = (tag) => nation(ctx, tag);
    const ordered = (list) => list.filter((x) => !(x && 'chance' in x)).concat(list.filter((x) => x && 'chance' in x));
    switch (k) {
      case 'all': return Array.isArray(v) && ordered(v).every((x) => test(ctx, x, dry));
      case 'any': return Array.isArray(v) && ordered(v).some((x) => test(ctx, x, dry));
      case 'not': return !test(ctx, v, dry);
      case 'war': { const a = n(v[0]); const b = n(v[1]); return a >= 0 && b >= 0 && D.atWar(state, a, b); }
      case 'atWar': { const a = n(v); return a >= 0 && D.enemies(state, a).length > 0; }
      case 'ally': { const a = n(v[0]); const b = n(v[1]); return a >= 0 && b >= 0 && D.allied(state, a, b); }
      case 'bloc': { const a = n(v[0]); return a >= 0 && state.nations[a].bloc === (v[1] || null); }
      case 'controls': case 'controlsAny': {
        const a = n(v[0]);
        const list = Array.isArray(v[1]) ? v[1] : [];
        if (a < 0 || !list.length) return false;
        const has = (p) => state.prov.ctrl[p] === a;
        return k === 'controls' ? list.every(has) : list.some(has);
      }
      case 'fatigueAbove': { const a = n(v[0]); return a >= 0 && state.nations[a].fatigue > v[1]; }
      case 'dateAfter': { const d = ST.parseDate(v); return today(state) >= day(d.year, d.doy); }
      case 'fired': return (state.fired || []).includes(v);
      case 'daysSince': { const h = firedHour(state, v[0]); return h >= 0 && state.hour - h >= v[1] * DAY; }
      case 'chance': return dry || R.int(state.rng, 1000) < (v | 0);
      default: return false;
    }
  }

  function effect(ctx, e) {
    const { state } = ctx;
    const k = Object.keys(e)[0];
    const v = e[k];
    const n = (tag) => nation(ctx, tag);
    switch (k) {
      case 'declareWar': { const a = n(v[0]); const b = n(v[1]); if (a >= 0 && b >= 0 && state.nations[a].alive && D.warCheck(ctx, a, b).ok) D.declareWar(ctx, a, b); return; }
      case 'peace': { const a = n(v[0]); const b = n(v[1]); return a >= 0 && b >= 0 && D.atWar(state, a, b) ? D.makePeace(ctx, a, b, {}) : []; }
      case 'ally': { const a = n(v[0]); const b = n(v[1]); if (a >= 0 && b >= 0 && a !== b && !D.atWar(state, a, b)) D.makeAlliance(ctx, a, b); return; }
      case 'joinBloc': {
        const a = n(v[0]);
        if (a < 0 || !state.nations[a].alive) return;
        if (v[1]) D.joinBloc(ctx, a, v[1]); else D.leaveBloc(ctx, a);
        return;
      }
      case 'mobilise': { const a = n(v); if (a >= 0) { state.nations[a].dip.mobTarget = 1000; state.nations[a].mobilisation = 1000; } return; }
      case 'collapse': { const a = n(v); return a >= 0 && state.nations[a].alive ? D.collapse(ctx, a, null) : []; }
      case 'log': MV.log(ctx, { kind: 'event', key: v }); return;
      default: return;
    }
  }

  function daily(ctx, w, out) {
    const { state, scenario } = ctx;
    const list = scenario.events || [];
    if (!list.length) return;
    D.ensure(state);
    const playerTag = state.player >= 0 && state.player < state.nations.length ? state.nations[state.player].tag : null;
    for (const ev of list) {
      if (!ev || typeof ev.id !== 'string') continue;
      const last = firedHour(state, ev.id);
      if (ev.once && last >= 0) continue;
      if (!ev.once && last >= 0 && state.hour - last < (ev.every || 30) * DAY) continue;
      if (ev.skipIfPlayer && ev.skipIfPlayer === playerTag) continue;
      if (!test(ctx, ev.when)) continue;
      for (const e of ev.effects || []) if (e && typeof e === 'object') out.provinces.push(...(effect(ctx, e) || []));
      const i = state.fired.indexOf(ev.id);
      if (i < 0) { state.fired.push(ev.id); state.firedAt.push(state.hour); } else state.firedAt[i] = state.hour;
      MV.log(ctx, { kind: 'fired', id: ev.id });
      out.events.push({ kind: 'fired', id: ev.id });
      out.divs = true;
    }
    D.invalidate(state);
  }

  T.addSystem({ name: 'events', every: DAY, at: 0, run: daily }, { after: 'diplomacy' });

  const holds = (ctx, c) => test(ctx, c, true);

  return { test, holds, effect, daily };
});
