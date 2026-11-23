// The simulation worker's message loop (architecture sections 5 and 7), last in sim/modules.json. createHost(post, timer)
// keeps one game and answers messages; it starts by itself only inside a dedicated worker, so the file is inert in
// Node and in a page. Every message has a `type`.
//   in   init { map, scenario, rules, seed, player, settings?, meta? } | init { map, scenario, rules, save, meta? }
//        generate { id, opts }   (mapgen.generate(opts); opts.war puts every pair of nations at war from the start)
//        order { id, order }  speed { n }  save { id, meta? }  query { id, what, args }  explain { id, nation }
//        fault {}                (the next batch throws: the page's crash handling is tested with it)
//   out  ready { snapshot, meta, divFields, delta }  generated { id, map, scenario }  tick (a delta, below)
//        orderResult { id, ok, reason, value, delta }  saved { id, text }  answer { id, ok, value, reason }
//        explained { id, decisions }  error { id?, reason, message? }
// The whole state goes to the page only in `ready`; after that every batch and every accepted order of the player's
// sends a delta: { type: 'tick', hour, day (the daily systems ran: industry, supply, weather), provinces: [[id, owner, ctrl]] (changed since
// the last delta), divs: Int32Array of DIV_FIELDS per division in id order | null (unchanged), tpls: [[id, template]]
// for divisions the page has not seen, battles | null, nations: [row] (every nation, with war, ally and access towards
// the player), me: the player's nation | null (sent once a game day and after the player's orders) with factories
// { mil, civ } (industry.output) beside it, offers: the
// player's offers | null (unchanged), log: entries added since the last delta (a battle's carries side, the attacker,
// and defender, the controller before it, when the battle was seen starting), outcome | null (sent once), sea:
// [[zone, ctrl]] | null, supply: Int16Array | null and weather: Uint8Array | null (daily), events }.
// Speeds are fixed rates (SPEED[n].rate game hours a real second; speed 5 has none and runs as fast as the machine
// goes). Every FRAME_MS the host runs the whole hours owed since the last frame, one tick.step hour at a time, and
// posts one delta when it ran any; a frame spends at most WORK_MS, and what it could not run is dropped, not queued,
// so a machine too slow for a rate runs slower instead of falling behind. Speed 5 runs CHUNK hours at a time until
// WORK_MS is spent (one chunk when the timer has no clock, as in Node tests). Orders and saves are handled between
// frames, so they apply at an hour boundary. The game pauses itself once, on the hour the outcome appears; after that
// it runs on when the page asks (the end screen's "keep watching").
// Tests: init { test: true } (only when the page runs under PYIDE_CONQUEST_TEST) allows test { id, set: [{ path,
// value }] }, which writes each value at its path in the state (['nations', 0, 'manpower']) and answers testDone
// { id, delta } with a full delta; without that init flag the message is refused.
// A save is save.write's text with the page's meta as its first field ({"meta":{...},"format":...}): the main process
// lists saves from it without reading the state, and save.read ignores the extra field.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (globalThis.Conquest = globalThis.Conquest || {}).host = api;
})(() => {
  const NODE = typeof module === 'object' && !!module.exports;
  const C = NODE ? {
    state: require('./state.js'), tick: require('./tick.js'), orders: require('./orders.js'), save: require('./save.js'),
    mapdata: require('./mapdata.js'), queries: require('./queries.js'), mapgen: require('./mapgen.js'),
  } : globalThis.Conquest;

  const SPEED = [null, { rate: 2 }, { rate: 6 }, { rate: 24 }, { rate: 72 }, { rate: 0 }];
  const FRAME_MS = 50;
  const WORK_MS = 40;
  const CHUNK = 6;
  const DIV_FIELDS = ['id', 'nation', 'prov', 'to', 'str', 'org', 'army', 'sup', 'dig', 'manual', 'eta', 'dest'];
  const NF = DIV_FIELDS.length;

  const seaRows = (state) => { const out = []; state.sea.ctrl.forEach((c, z) => { if (c !== -1) out.push([z, c]); }); return out; };

  function packDivs(divs) {
    const a = new Int32Array(divs.length * NF);
    for (let i = 0, o = 0; i < divs.length; i++, o += NF) {
      const d = divs[i];
      a[o] = d.id; a[o + 1] = d.nation; a[o + 2] = d.prov; a[o + 3] = d.to === null ? -1 : d.to;
      a[o + 4] = d.str; a[o + 5] = d.org; a[o + 6] = d.army === null ? -1 : d.army; a[o + 7] = d.sup | 0; a[o + 8] = d.dig | 0;
      a[o + 9] = d.manual ? 1 : 0; a[o + 10] = d.eta | 0;
      a[o + 11] = d.path.length ? d.path[d.path.length - 1] : d.to === null ? -1 : d.to;
    }
    return a;
  }

  // The timer calls go through arrows: a worker's setTimeout called as a method of another object throws.
  function createHost(post, timer = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h), now: () => performance.now() }) {
    let ctx = null;
    let speed = 0;
    let handle = null;
    let meta = null;
    let fault = false;
    let testing = false;
    let ended = false;
    let owed = 0;
    let last = 0;
    // What the page has seen, to send only what changed.
    let seen = null;

    function forget() {
      const { state } = ctx;
      seen = { owner: state.prov.owner.slice(), ctrl: state.prov.ctrl.slice(), log: state.log.length ? state.log[state.log.length - 1] : null,
        divs: new Set(), offers: '', outcome: false, battleAt: new Map() };
    }

    const offersOf = (state) => (state.offers || []).filter((o) => o.from === state.player || o.to === state.player);

    function nationRows(state) {
      const rel = C.mapdata.relations(state);
      const p = state.player;
      return state.nations.map((n, i) => ({
        index: i, tag: n.tag, alive: n.alive, bloc: n.bloc || null, manpower: n.manpower, fatigue: n.fatigue | 0, mobilisation: n.mobilisation | 0, ready: C.mapdata.ready(state, i),
        stock: { ...n.stock }, casualties: n.casualties, blockade: n.blockade, navy: n.navy, suff: { ...n.suff }, unlocked: n.unlocked.slice(),
        war: rel.war[p * rel.k + i] === 1, ally: i !== p && rel.ally[p * rel.k + i] === 1, access: i !== p && rel.access[p * rel.k + i] === 1,
      }));
    }

    // Battles by province before an hour, so a battle that ends in that hour can be told apart (side, defender).
    function noteBattles() {
      const { state } = ctx;
      for (const b of state.battles) if (!seen.battleAt.has(b.prov)) seen.battleAt.set(b.prov, { side: b.side, defender: state.prov.ctrl[b.prov] });
    }

    function newLog() {
      const log = ctx.state.log;
      // lastIndexOf is -1 once the entry was trimmed from the log: then the whole log is new.
      let i = seen.log ? log.lastIndexOf(seen.log) + 1 : 0;
      const out = [];
      for (; i < log.length; i++) {
        const e = log[i];
        if (e.kind === 'battle') {
          const b = seen.battleAt.get(e.prov);
          out.push(b ? { ...e, side: b.side, defender: b.defender } : { ...e });
          seen.battleAt.delete(e.prov);
        } else out.push({ ...e });
      }
      seen.log = log.length ? log[log.length - 1] : null;
      return out;
    }

    // r: { divs, battles, sea, events, day } gathered over the hours since the last delta.
    function delta(r, { me = false, full = false } = {}) {
      const { state } = ctx;
      const provinces = [];
      const { owner, ctrl } = state.prov;
      for (let p = 1; p < owner.length; p++) {
        if (full || owner[p] !== seen.owner[p] || ctrl[p] !== seen.ctrl[p]) {
          if (!full) provinces.push([p, owner[p], ctrl[p]]);
          seen.owner[p] = owner[p];
          seen.ctrl[p] = ctrl[p];
        }
      }
      let divs = null;
      const tpls = [];
      if (full || r.divs) {
        divs = packDivs(state.divs);
        for (const d of state.divs) if (!seen.divs.has(d.id)) { seen.divs.add(d.id); tpls.push([d.id, d.tpl]); }
        if (seen.divs.size > state.divs.length * 2 + 64) seen.divs = new Set(state.divs.map((d) => d.id));
      }
      const mine = offersOf(state);
      const sig = mine.map((o) => o.id).join();
      const offersChanged = full || sig !== seen.offers;
      seen.offers = sig;
      const D = NODE ? require('./diplomacy.js') : globalThis.Conquest.diplomacy;
      let outcome = null;
      if (!seen.outcome && state.diplo && state.diplo.outcome) { seen.outcome = true; outcome = D ? D.outcome(ctx) : state.diplo.outcome; }
      const day = full || r.day;
      return {
        type: 'tick', hour: state.hour, day: !!r.day,
        provinces,
        divs, tpls,
        battles: full || r.battles ? state.battles.map((b) => ({ ...b, from: b.from.slice(), att: b.att.slice(), def: b.def.slice() })) : null,
        nations: nationRows(state),
        me: full || me || r.day ? state.nations[state.player] : null,
        factories: full || me || r.day ? factories(state.player) : null,
        offers: offersChanged ? mine : null,
        log: full ? state.log.slice() : newLog(),
        outcome,
        sea: full || r.sea ? seaRows(state) : null,
        supply: day ? state.prov.supply.slice() : null,
        weather: day ? state.prov.weather.slice() : null,
        events: r.events || [],
      };
    }

    const factories = (n) => {
      const I = NODE ? require('./industry.js') : globalThis.Conquest.industry;
      return { mil: I.output(ctx, n, 'mil'), civ: I.output(ctx, n, 'civ') };
    };

    const transfer = (m) => [m.divs, m.supply, m.weather].filter(Boolean).map((a) => a.buffer);

    // Runs up to `hours` hours, stopping early once `until` (a timer.now() value) has passed. -> the sum and hours run.
    function batch(hours, sum = { divs: false, battles: false, sea: false, events: [], day: false, ran: 0 }, until = Infinity) {
      for (let h = 0; h < hours; h++) {
        if (h > 0 && timer.now && timer.now() > until) break;
        noteBattles();
        if (fault) { fault = false; throw new Error('fault requested by the page'); }
        const r = C.tick.step(ctx, 1);
        sum.divs = sum.divs || r.divs;
        sum.battles = sum.battles || r.battles || ctx.state.battles.length > 0;
        sum.sea = sum.sea || r.sea;
        if (r.events && r.events.length) sum.events.push(...r.events);
        sum.ran++;
        // The daily systems run in the step from a day's hour 0, so the day is done (and reported) at hour 1.
        if (ctx.state.hour % 24 === 1) sum.day = true;
        if (!ended && ctx.state.diplo && ctx.state.diplo.outcome) { ended = true; setSpeed(0); break; }
      }
      return sum;
    }

    // The hours this frame runs: the whole hours owed at the speed's rate, at most a few frames' worth.
    function due() {
      const rate = SPEED[speed].rate;
      const now = timer.now ? timer.now() : last + FRAME_MS;
      owed = Math.min(owed + (rate * (now - last)) / 1000, Math.max(1, (rate * FRAME_MS * 3) / 1000));
      last = now;
      const h = Math.floor(owed);
      owed -= h;
      return h;
    }

    function run() {
      handle = null;
      if (!ctx || speed <= 0) return;
      let m = null;
      const s = speed;
      try {
        const start = timer.now ? timer.now() : 0;
        const until = start + WORK_MS;
        let sum;
        if (SPEED[s].rate) {
          const hours = due();
          if (hours) sum = batch(hours, undefined, until);
          // Hours a slow frame could not run are dropped: the game slows down instead of queueing them.
          if (sum && sum.ran < hours) owed = 0;
        } else {
          sum = batch(CHUNK);
          while (timer.now && speed === s && timer.now() < until) batch(CHUNK, sum, until);
        }
        if (sum && sum.ran) m = delta(sum);
      } catch (err) {
        speed = 0;
        post({ type: 'error', reason: 'tick-failed', message: String(err && err.stack || err) });
        return;
      }
      if (m) post(m, transfer(m));
      if (speed > 0) handle = timer.set(run, SPEED[speed].rate ? FRAME_MS : 0);
    }

    function setSpeed(n) {
      speed = Number.isInteger(n) && n >= 0 && n < SPEED.length ? n : 0;
      if (handle !== null) { timer.clear(handle); handle = null; }
      owed = 0;
      last = timer.now ? timer.now() : 0;
      if (speed > 0 && ctx) handle = timer.set(run, SPEED[speed].rate ? FRAME_MS : 0);
    }

    const handlers = {
      init(m) {
        setSpeed(0);
        let state;
        if (m.save !== undefined) {
          const r = C.save.read(m.save);
          if (!r.ok) return post({ type: 'error', id: m.id, reason: r.reason });
          state = r.state;
        } else {
          state = C.state.create(m.map, m.scenario, m.rules, { seed: m.seed, player: m.player });
          if (m.settings && typeof m.settings.difficulty === 'string') state.settings = { difficulty: m.settings.difficulty, aiBonus: !!m.settings.aiBonus };
        }
        ctx = { map: m.map, scenario: m.scenario, rules: m.rules, state };
        meta = m.meta || null;
        testing = m.test === true;
        ended = !!(state.diplo && state.diplo.outcome);
        forget();
        const d = delta({}, { full: true });
        return post({ type: 'ready', id: m.id, snapshot: state, meta, divFields: DIV_FIELDS, delta: d });
      },
      generate(m) {
        const g = C.mapgen.generate(m.opts || {});
        if (m.opts && m.opts.war) {
          const tags = g.scenario.nations.map((n) => n.tag);
          g.scenario.wars = [];
          for (let a = 0; a < tags.length; a++) for (let b = a + 1; b < tags.length; b++) g.scenario.wars.push([tags[a], tags[b]]);
        }
        post({ type: 'generated', id: m.id, map: g.map, scenario: g.scenario });
      },
      order(m) {
        const r = ctx ? C.orders.apply(ctx, ctx.state.player, m.order) : { ok: false, reason: 'no-game' };
        const out = { type: 'orderResult', id: m.id, ok: r.ok, reason: r.reason || null, value: r.id === undefined ? null : r.id, delta: null };
        if (r.ok) out.delta = delta({ divs: true, battles: false, sea: false, events: [], day: false }, { me: true });
        post(out, out.delta ? transfer(out.delta) : []);
      },
      speed(m) { setSpeed(m.n); },
      save(m) {
        if (!ctx) return post({ type: 'error', id: m.id, reason: 'no-game' });
        const text = C.save.write(ctx.state);
        const head = m.meta || meta;
        return post({ type: 'saved', id: m.id, text: head ? `{"meta":${JSON.stringify(head)},${text.slice(1)}` : text });
      },
      query(m) {
        let value;
        try { value = C.queries.answer(ctx, m.what, m.args); } catch (err) { return post({ type: 'answer', id: m.id, ok: false, reason: String(err && err.message || err) }); }
        return post({ type: 'answer', id: m.id, ok: true, value });
      },
      explain(m) {
        const ok = ctx && Number.isInteger(m.nation) && m.nation >= 0 && m.nation < ctx.state.nations.length;
        const decisions = ok ? C.queries.visibleDecisions(ctx, m.nation) : [];
        post({ type: 'explained', id: m.id, decisions });
      },
      fault() { fault = true; },
      test(m) {
        if (!testing || !ctx) return post({ type: 'error', id: m.id, reason: 'not-a-test' });
        for (const { path, value } of m.set || []) {
          let o = ctx.state;
          for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
          o[path[path.length - 1]] = value;
        }
        C.mapdata.touchRelations(ctx.state);
        const d = delta({ divs: true, battles: true, sea: true, events: [], day: true }, { me: true });
        return post({ type: 'testDone', id: m.id, delta: d }, transfer(d));
      },
    };

    function receive(m) {
      const h = m && Object.prototype.hasOwnProperty.call(handlers, m.type) ? handlers[m.type] : null;
      if (!h) return post({ type: 'error', reason: 'unknown-message' });
      try { return h(m); } catch (err) { return post({ type: 'error', id: m.id, reason: 'failed', message: String(err && err.stack || err) }); }
    }

    return { receive, get ctx() { return ctx; } };
  }

  if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
    const host = createHost((m, transfer) => self.postMessage(m, transfer || []));
    self.onmessage = (e) => host.receive(e.data);
  }

  return { createHost, SPEED, DIV_FIELDS };
});
