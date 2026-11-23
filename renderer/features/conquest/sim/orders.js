// Orders: the only way anything changes state between ticks, for players and the AI alike. legal(ctx, nation, order)
// answers { ok: true } or { ok: false, reason }; apply() gives the same answer and carries the order out when ok.
// A refused order leaves the state untouched. Each type is one entry of TYPES: check() validates and may hand data
// (a path) to run(); define(type, entry) adds or replaces one (diplomacy.js replaces 'diplo').
//
//   move      { div, to, by, own }        own division; `to` a land province reachable over passable land and open sea
//             zones (movement.js; own: true, only over its camp's land, open sea and `to`, search's own) -> no-such-division not-yours no-such-province sea already-there no-path
//             sea-lane-closed (a route exists but a denied zone or closed strait is in the way) too-far (the search
//             settled rules.move.searchCap provinces). Sets manual, unless by is 'general' (the general AI carrying
//             out its army's plan, which leaves manual as it is); any other by -> bad-order.
//   halt      { div, by }                 stops where it is -> at-sea (a division at sea cannot stop). Sets manual
//             as move does.
//   assign    { div, army }               army id of the same nation, or null to detach. Clears manual.
//   front     { army, provinces }         land provinces for the army's general to hold (null clears) -> bad-province
//   offensive { army, path }              land provinces to the objective; answers { ok, id } -> bad-province
//             { army, offensive, path: null } removes that offensive -> no-such-offensive
//   army      { name, general }           a new army without divisions; general null or one of the nation's
//             scenario generals no other army of it has; answers { ok, id } -> bad-name no-such-general general-busy
//             { army, disband: true }     removes the army; its divisions stay, in no army
//   launch    { army, offensive, on }     starts or stops it -> no-such-offensive
//   template  { template: { id, name, line, support } }   adds or replaces by id
//             -> bad-template unknown-branch locked-branch (not yet in nation.unlocked) support-only (a supportOnly
//             branch, air, in the line) too-large
//   train     { template, count, at }     pays manpower and equipment now, ready after train.days at `at` (owned
//             and controlled) -> no-such-template bad-count bad-province no-manpower no-equipment; answers { ok, id }
//   line      { item, factories }         sets a production line. A cut (no more factories than the line has) is
//             always legal; a raise may not take the sum past the nation's military factories (industry.output)
//             -> unknown-item locked-item (its `unlock` branch is not unlocked) bad-count not-enough-factories
//   build     { what: mil|civ|infra, province }  queues construction in an owned, controlled province
//             -> unknown-building bad-province at-cap
//   diplo     { action, to, terms }       not-implemented until diplomacy.js defines it
// Every order may also be refused with bad-order (not an object, a field of the wrong kind), unknown-order or
// no-such-nation, and every army order with no-such-army. After an order of a type that define() added or replaced
// (and 'diplo') is carried out, the relations cache is invalidated (mapdata.touchRelations).
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).orders = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const M = NODE ? require('./mapdata.js') : globalThis.Conquest.mapdata;
  const U = NODE ? require('./units.js') : globalThis.Conquest.units;
  const MV = NODE ? require('./movement.js') : globalThis.Conquest.movement;
  const I = NODE ? require('./industry.js') : globalThis.Conquest.industry;

  const no = (reason) => ({ ok: false, reason });
  const OK = { ok: true };
  const isInt = (x) => Number.isInteger(x);
  const isLand = (ctx, p) => isInt(p) && p > 0 && p < ctx.map.provinces.length && !ctx.map.provinces[p].sea;

  function ownDiv(ctx, nation, id) {
    if (!isInt(id)) return { err: no('bad-order') };
    const d = M.divById(ctx.state, id);
    if (!d) return { err: no('no-such-division') };
    if (d.nation !== nation) return { err: no('not-yours') };
    return { d };
  }

  function ownArmy(ctx, nation, id) {
    const a = isInt(id) ? ctx.state.nations[nation].armies.find((x) => x.id === id) : null;
    return a ? { a } : { err: no('no-such-army') };
  }

  const byOk = (o) => o.by === undefined || o.by === 'general';
  const mark = (d, o) => { if (o.by !== 'general') d.manual = true; };

  const held = (ctx, nation, p) => isLand(ctx, p) && ctx.state.prov.owner[p] === nation && ctx.state.prov.ctrl[p] === nation;

  const TYPES = {
    move: {
      check(ctx, n, o) {
        const { d, err } = ownDiv(ctx, n, o.div);
        if (err) return err;
        if (!byOk(o)) return no('bad-order');
        if (!isInt(o.to) || o.to <= 0 || o.to >= ctx.map.provinces.length) return no('no-such-province');
        if (ctx.map.provinces[o.to].sea) return no('sea');
        if (o.own !== undefined && typeof o.own !== 'boolean') return no('bad-order');
        if (o.to === d.prov) return no('already-there');
        const rel = M.relations(ctx.state);
        const r = MV.search(ctx, rel, d, o.to, { own: !!o.own });
        if (r.path) return { ok: true, d, path: r.path };
        if (r.why === 'cap') return no('too-far');
        if (r.why === 'sea' && MV.search(ctx, rel, d, o.to, { open: true }).path) return no('sea-lane-closed');
        return no('no-path');
      },
      run(ctx, n, o, { d, path }) {
        const first = path.shift();
        if (d.to !== first) d.eta = MV.hours(ctx, U.statsOf(ctx, d), d.prov, first);
        d.to = first;
        d.path = path;
        mark(d, o);
      },
    },
    halt: {
      check(ctx, n, o) {
        const { d, err } = ownDiv(ctx, n, o.div);
        if (err) return err;
        if (!byOk(o)) return no('bad-order');
        return MV.atSea(ctx, d) ? no('at-sea') : { ok: true, d };
      },
      run(ctx, n, o, { d }) { MV.stop(d); mark(d, o); },
    },
    assign: {
      check(ctx, n, o) {
        const { d, err } = ownDiv(ctx, n, o.div);
        if (err) return err;
        if (o.army === null) return { ok: true, d, a: null };
        const r = ownArmy(ctx, n, o.army);
        return r.err || { ok: true, d, a: r.a };
      },
      run(ctx, n, o, { d, a }) {
        const old = M.armyOf(ctx.state, d);
        if (old) old.divs = old.divs.filter((id) => id !== d.id);
        d.army = a ? a.id : null;
        if (a && !a.divs.includes(d.id)) { a.divs.push(d.id); a.divs.sort((x, y) => x - y); }
        d.manual = false;
      },
    },
    front: {
      check(ctx, n, o) {
        const r = ownArmy(ctx, n, o.army);
        if (r.err) return r.err;
        if (o.provinces === null) return { ok: true, a: r.a };
        if (!Array.isArray(o.provinces) || !o.provinces.length || !o.provinces.every((p) => isLand(ctx, p))) return no('bad-province');
        return { ok: true, a: r.a };
      },
      run(ctx, n, o, { a }) { a.front = o.provinces === null ? null : o.provinces.slice(); },
    },
    offensive: {
      check(ctx, n, o) {
        const r = ownArmy(ctx, n, o.army);
        if (r.err) return r.err;
        if (o.path === null) {
          const i = r.a.offensives.findIndex((x) => x.id === o.offensive);
          return i < 0 ? no('no-such-offensive') : { ok: true, a: r.a, remove: i };
        }
        if (!Array.isArray(o.path) || !o.path.length || !o.path.every((p) => isLand(ctx, p))) return no('bad-province');
        return { ok: true, a: r.a };
      },
      run(ctx, n, o, { a, remove }) {
        if (remove !== undefined) { a.offensives.splice(remove, 1); return OK; }
        const id = ctx.state.next.plan++;
        a.offensives.push({ id, path: o.path.slice(), on: false });
        return { ok: true, id };
      },
    },
    launch: {
      check(ctx, n, o) {
        const r = ownArmy(ctx, n, o.army);
        if (r.err) return r.err;
        if (typeof o.on !== 'boolean') return no('bad-order');
        const off = r.a.offensives.find((x) => x.id === o.offensive);
        return off ? { ok: true, off } : no('no-such-offensive');
      },
      run(ctx, n, o, { off }) { off.on = o.on; },
    },
    army: {
      check(ctx, n, o) {
        const nat = ctx.state.nations[n];
        if (o.disband === true) {
          const r = ownArmy(ctx, n, o.army);
          return r.err || { ok: true, a: r.a };
        }
        if (typeof o.name !== 'string' || !o.name || o.name.length > 48) return no('bad-name');
        const g = o.general === undefined ? null : o.general;
        if (g !== null) {
          if (typeof g !== 'string' || !(ctx.scenario.nations[n].generals || []).some((x) => x.name === g)) return no('no-such-general');
          if (nat.armies.some((a) => a.general === g)) return no('general-busy');
        }
        return { ok: true, g };
      },
      run(ctx, n, o, { a, g }) {
        const { state } = ctx;
        const nat = state.nations[n];
        if (a) {
          for (const id of a.divs) { const d = M.divById(state, id); if (d) d.army = null; }
          nat.armies.splice(nat.armies.indexOf(a), 1);
          return OK;
        }
        const id = state.next.army++;
        nat.armies.push({ id, name: o.name, general: g, divs: [], front: null, offensives: [] });
        return { ok: true, id };
      },
    },
    template: {
      check(ctx, n, o) {
        const t = o.template;
        const T = ctx.rules.template;
        if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 32 || typeof t.name !== 'string' || !Array.isArray(t.line) || (t.support !== undefined && !Array.isArray(t.support))) return no('bad-template');
        const all = t.line.concat(t.support || []);
        if (!t.line.length || t.line.length > T.maxLine || (t.support || []).length > T.maxSupport) return no('too-large');
        const unlocked = ctx.state.nations[n].unlocked;
        for (const b of all) {
          const br = ctx.rules.branches.find((x) => x.id === b);
          if (!br) return no('unknown-branch');
          if (br.locked && !unlocked.includes(b)) return no('locked-branch');
        }
        for (const b of t.line) if (ctx.rules.branches.find((x) => x.id === b).supportOnly) return no('support-only');
        return OK;
      },
      run(ctx, n, o) {
        const t = o.template;
        const tpl = { id: t.id, name: t.name, line: t.line.slice(), support: (t.support || []).slice() };
        const list = ctx.state.nations[n].templates;
        const i = list.findIndex((x) => x.id === t.id);
        if (i >= 0) list[i] = tpl;
        else list.push(tpl);
      },
    },
    train: {
      check(ctx, n, o) {
        const nat = ctx.state.nations[n];
        const tpl = nat.templates.find((x) => x.id === o.template);
        if (!tpl) return no('no-such-template');
        if (!isInt(o.count) || o.count < 1 || o.count > ctx.rules.train.maxCount) return no('bad-count');
        if (!held(ctx, n, o.at)) return no('bad-province');
        const s = U.stats(ctx.rules, tpl);
        if (nat.manpower < s.manpower * o.count) return no('no-manpower');
        const items = U.table(ctx.rules).items;
        for (let k = 0; k < items.length; k++) if (nat.stock[items[k]] < s.equip[k] * o.count) return no('no-equipment');
        return { ok: true, s };
      },
      run(ctx, n, o, { s }) {
        const { state, rules } = ctx;
        const nat = state.nations[n];
        nat.manpower -= s.manpower * o.count;
        U.table(rules).items.forEach((item, k) => { nat.stock[item] -= s.equip[k] * o.count; });
        const id = state.next.batch++;
        nat.training.push({ id, tpl: o.template, count: o.count, at: o.at, done: state.hour + rules.train.days * 24 });
        return { ok: true, id };
      },
    },
    line: {
      check(ctx, n, o) {
        const item = ctx.rules.items.find((x) => x.id === o.item);
        if (!item) return no('unknown-item');
        if (item.unlock && !ctx.state.nations[n].unlocked.includes(item.unlock)) return no('locked-item');
        if (!isInt(o.factories) || o.factories < 0) return no('bad-count');
        const cur = ctx.state.nations[n].lines.find((l) => l.item === o.item);
        if (o.factories <= (cur ? cur.factories : 0)) return OK;
        const others = ctx.state.nations[n].lines.reduce((sum, l) => sum + (l.item === o.item ? 0 : l.factories), 0);
        if (others + o.factories > I.output(ctx, n, 'mil')) return no('not-enough-factories');
        return OK;
      },
      run(ctx, n, o) {
        const lines = ctx.state.nations[n].lines;
        const start = ctx.rules.industry.effStart;
        const l = lines.find((x) => x.item === o.item);
        if (!l) { lines.push({ item: o.item, factories: o.factories, eff: start, prog: 0 }); return; }
        if (o.factories > l.factories) l.eff = Math.trunc((l.factories * l.eff + (o.factories - l.factories) * start) / o.factories);
        l.factories = o.factories;
      },
    },
    build: {
      check(ctx, n, o) {
        const B = ctx.rules.build;
        if (!Object.prototype.hasOwnProperty.call(B.cost, o.what)) return no('unknown-building');
        if (!held(ctx, n, o.province)) return no('bad-province');
        const queued = ctx.state.nations[n].builds.filter((b) => b.what === o.what && b.prov === o.province).length;
        if (ctx.state.prov[o.what][o.province] + queued >= B.max[o.what]) return no('at-cap');
        return OK;
      },
      run(ctx, n, o) { ctx.state.nations[n].builds.push({ what: o.what, prov: o.province, prog: 0 }); },
    },
    diplo: { check: () => no('not-implemented'), run() {} },
  };

  const KEEPS_REL = new Set(['move', 'halt', 'assign', 'army', 'front', 'offensive', 'launch', 'template', 'train', 'line', 'build']);
  const BUILTIN = { ...TYPES };

  function check(ctx, nation, order) {
    if (!isInt(nation) || nation < 0 || nation >= ctx.state.nations.length) return no('no-such-nation');
    if (!order || typeof order !== 'object') return no('bad-order');
    const t = Object.prototype.hasOwnProperty.call(TYPES, order.type) ? TYPES[order.type] : null;
    if (!t) return no('unknown-order');
    return { t, r: t.check(ctx, nation, order) };
  }

  function legal(ctx, nation, order) {
    const c = check(ctx, nation, order);
    if (!c.t) return c;
    return c.r.ok ? OK : no(c.r.reason);
  }

  function apply(ctx, nation, order) {
    const c = check(ctx, nation, order);
    if (!c.t) return c;
    if (!c.r.ok) return no(c.r.reason);
    const r = c.t.run(ctx, nation, order, c.r) || OK;
    if (!KEEPS_REL.has(order.type) || c.t !== BUILTIN[order.type]) M.touchRelations(ctx.state);
    return r;
  }

  const define = (type, entry) => { TYPES[type] = entry; };

  return { legal, apply, define, TYPES };
});
