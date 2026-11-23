// Conquest.game (architecture section 7): the one owner of the simulation worker and the mirror every screen reads.
// The worker is built from conquest:workerSource text through a Blob URL (the CSP allows workers only from blob:). The
// page gets the whole state once (ready) and then deltas (sim/host.js); a delta is applied to the mirror as it arrives
// (province rows, nations, the latest packed division array), and the screens hear one coalesced 'tick' per animation
// frame however many batches came in it. order() and query() are promises matched by id, with timeouts. Saves go
// through conquest:save as the worker's save text with a meta head ({ scenario, gen, tag, nation, hour, date,
// difficulty, seed, game, aiBonus, and what screens keep there, such as staff }). Each game has its own autosave,
// "Autosave <game>" (game.autosaveName; save(AUTOSAVE) writes it), so a new game never overwrites the last one's; it
// is written on the first hour of each game month and when the window closes (main/features/conquest.js asks with
// conquest:quitSave, and keeps the newest autosaves only), unless the conquest.autosave setting is off. A worker that
// throws or dies is reported once ('crashed', status 'crashed') and nothing is posted to it again; reloadLast() starts
// a fresh one from the last save. Under PYIDE_CONQUEST_TEST (conquest:testHooks) a game starts with the worker's test
// message allowed: debug.setState([{ path, value }]) writes into the state (sim/host.js).
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const log = ide.logger('#conquest');
  const ORDER_MS = 15000;
  const QUERY_MS = 15000;
  const LOAD_MS = 120000;
  const AUTOSAVE = 'Autosave';
  const LOG_KEEP = 500;
  const MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const listeners = new Map();
  const emit = (name, arg) => { for (const fn of listeners.get(name) || []) try { fn(arg); } catch (err) { log.error(`${name} listener: ${err?.stack || err}`); } };

  let worker = null;
  let workerUrl = null;
  let sourceText = null;
  let nextId = 1;
  const pending = new Map();
  let fields = null;
  const tplOf = new Map();
  let world = null;
  let pendingDivs = null;
  let dirty = null;
  let flushHandle = 0;
  let flushTimer = 0;
  let lastMonth = -1;
  let lastSpeed = 3;

  const blank = () => ({ provinces: new Set(), divs: false, battles: false, sea: false, day: false, supply: false, me: false, nations: false, log: [], events: [] });

  const game = (Conquest.game = {
    map: null, scenario: null, rules: null, idSource: null, source: null, factories: null,
    status: 'none', // none | starting | running | crashed
    player: -1, hour: 0, speed: 0, meta: null,
    prov: { owner: null, ctrl: null }, supply: null, weather: null,
    divs: new Map(), battles: [], sea: null, nations: [], me: null, offers: [], log: [], outcome: null,
    selection: { province: 0, army: null, division: null, divisions: [] },
    lastError: null,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    get running() { return game.status === 'running'; },
    // The simulation's calendar (sim/weather.js): 365-day years, no 29 February.
    date(hour = game.hour) {
      const [y, m, d] = (game.scenario?.start || '1914-06-28').split('-').map(Number);
      let doy = d - 1;
      for (let i = 0; i < m - 1; i++) doy += MONTHS[i];
      const t = doy + Math.floor(hour / 24);
      let rest = t % 365;
      let mo = 0;
      while (rest >= MONTHS[mo]) rest -= MONTHS[mo++];
      return { y: y + Math.floor(t / 365), m: mo + 1, d: rest + 1, h: ((hour % 24) + 24) % 24 };
    },
    nationName(i) {
      const n = game.scenario?.nations[i];
      return n ? Conquest.ui.text.nation(n.name) : '';
    },
    setSelection(patch) {
      const next = { ...game.selection, ...patch };
      if (patch.divisions && !('division' in patch)) next.division = patch.divisions[0] ?? null;
      if ('division' in patch && !patch.divisions) next.divisions = patch.division === null ? [] : [patch.division];
      game.selection = next;
      emit('select', next);
    },
    order(order) {
      if (!game.running) return Promise.resolve({ ok: false, reason: 'no-game' });
      return request({ type: 'order', order }, ORDER_MS).then((m) => {
        const provinces = m.delta ? m.delta.provinces.map((r) => r[0]) : [];
        if (m.delta) { applyDelta(m.delta); decodeDivs(); flush(); }
        const r = { ok: m.ok, reason: m.reason, id: m.value, provinces };
        emit('ordered', { order, result: r });
        return r;
      }, (err) => ({ ok: false, reason: err.message || 'no-answer' }));
    },
    query(what, args = {}) {
      if (!worker || game.status === 'crashed') return Promise.reject(new Error('no-game'));
      return request({ type: 'query', what, args }, QUERY_MS).then((m) => (m.ok ? m.value : Promise.reject(new Error(m.reason))));
    },
    setSpeed(n) {
      if (!game.running) return;
      const s = Math.max(0, Math.min(5, n | 0));
      if (s > 0) lastSpeed = s;
      game.speed = s;
      post({ type: 'speed', n: s });
      emit('speed', s);
    },
    togglePause() { game.setSpeed(game.speed > 0 ? 0 : lastSpeed); },
    // -> Promise<{ ok, code?, reason? }>; AUTOSAVE (or autosaveName) is this game's autosave.
    async save(name) {
      if (!game.running) return { ok: false, code: 'no-game' };
      const auto = name === AUTOSAVE || name === game.autosaveName;
      const file = auto ? game.autosaveName : name;
      let m;
      try { m = await request({ type: 'save', meta: metaNow() }, ORDER_MS); } catch (err) { return { ok: false, code: 'no-answer', reason: err.message }; }
      const r = await ide.api.invoke('conquest:save', file, m.text).catch((err) => ({ ok: false, code: 'failed', message: err.message }));
      if (r.ok) emit('saved', { name: file, auto });
      return r;
    },
    // The autosave of the running game, when autosaving is on.
    autosave() {
      if (!game.running || ide.settings.get('conquest.autosave', true) === false) return Promise.resolve({ ok: false, code: 'off' });
      return game.save(AUTOSAVE);
    },
    get autosaveName() { return game.meta?.game ? `${AUTOSAVE} ${game.meta.game}` : AUTOSAVE; },
    isAutosave: (name) => name === AUTOSAVE || (typeof name === 'string' && name.startsWith(`${AUTOSAVE} `)),
    list: () => ide.api.invoke('conquest:list').catch(() => ({ ok: false, items: [] })),
    AUTOSAVE,
    // opts: { scenario: 'world' } or { scenario: 'generated', gen }, plus player (nation index), seed, difficulty, and
    // data ({ map, scenario, idSource, source }) when the caller has the map loaded already.
    async newGame(opts) {
      const data = await scenarioData(opts);
      const aiBonus = opts.aiBonus ?? ide.settings.get('conquest.aiBonus', false) === true;
      const meta = { scenario: opts.scenario, gen: opts.gen || null, seed: opts.seed | 0, difficulty: opts.difficulty || 'normal', tag: data.scenario.nations[opts.player]?.tag, game: newGameId(data.scenario.nations[opts.player]?.tag), aiBonus };
      return start(data, { type: 'init', map: data.map, scenario: data.scenario, rules: data.rules, seed: opts.seed | 0, player: opts.player, settings: { difficulty: meta.difficulty, aiBonus }, meta, test: await testHooks() });
    },
    // -> Promise<{ ok, reason? }>; reason is save.js's (not-json, not-a-save, newer-version, bad-state) or the IPC code.
    async load(name) {
      const file = await ide.api.invoke('conquest:load', name).catch((err) => ({ ok: false, code: 'failed', message: err.message }));
      if (!file.ok) return { ok: false, reason: file.code };
      const meta = file.meta ? { ...file.meta } : null;
      if (meta && !meta.game) meta.game = newGameId(meta.tag);
      let data;
      try {
        data = await scenarioData(meta?.scenario === 'generated' && meta.gen ? { scenario: 'generated', gen: meta.gen } : { scenario: 'world' });
      } catch (err) {
        return { ok: false, reason: err.message || 'failed' };
      }
      return start(data, { type: 'init', map: data.map, scenario: data.scenario, rules: data.rules, save: file.text, meta: meta || { scenario: 'world', game: newGameId() }, test: await testHooks() }, name);
    },
    reloadLast: () => game.load(game.lastSave || game.autosaveName),
    lastSave: null,
    // Back to the start screen: the worker is kept for generating maps, the game is dropped.
    close() {
      if (game.status === 'none') return;
      post({ type: 'speed', n: 0 });
      game.status = 'none';
      game.speed = 0;
      ide.api.send('conquest:running', false);
      emit('closed');
    },
    loadWorld,
    // A generated map from the worker: { map, scenario } (sim/mapgen.js), ids drawn by Conquest.view.rasterize.
    async generate(gen) {
      const m = await request({ type: 'generate', opts: gen }, LOAD_MS);
      return { map: m.map, scenario: m.scenario };
    },
    debug: {
      get worker() { return worker; },
      fault: () => post({ type: 'fault' }),
      get pending() { return pending.size; },
      // Tests only (the worker refuses it otherwise): writes values into the state, then the mirror takes the delta.
      async setState(set) {
        const m = await request({ type: 'test', set }, ORDER_MS);
        applyDelta(m.delta);
        decodeDivs();
        flush();
        return true;
      },
    },
  });

  // "<tag> <time in base 36>": unique per game on this machine, and a valid save name after "Autosave ".
  const newGameId = (tag) => `${tag || 'Game'} ${Date.now().toString(36)}`;
  let hooks = null;
  const testHooks = async () => {
    if (hooks === null) hooks = !!(await ide.api.invoke('conquest:testHooks').catch(() => null))?.on;
    return hooks;
  };

  function metaNow() {
    const d = game.date();
    return { ...game.meta, tag: game.scenario.nations[game.player]?.tag, nation: game.scenario.nations[game.player]?.name, hour: game.hour, date: [d.y, d.m, d.d] };
  }

  async function loadWorld() {
    if (world) return world;
    const read = async (f) => {
      const r = await ide.api.invoke('conquest:data', f);
      if (!r?.ok) throw new Error(r?.code || 'missing');
      return JSON.parse(r.text);
    };
    const [map, scenario, rules] = await Promise.all([read('world-1914/map.json'), read('world-1914/scenario.json'), read('units.json')]);
    const img = new Image();
    img.src = `${Conquest.base}data/world-1914/${encodeURIComponent(map.texture?.file || 'ids.png')}`;
    await img.decode();
    world = { source: 'world-1914', map, scenario, rules, idSource: img };
    return world;
  }

  const generated = new Map();
  const rulesOnly = async () => (world?.rules) || JSON.parse((await ide.api.invoke('conquest:data', 'units.json')).text);
  async function scenarioData(opts) {
    if (opts.data) return { ...opts.data, rules: opts.data.rules || await rulesOnly() };
    if (opts.scenario !== 'generated') return loadWorld();
    const key = JSON.stringify(opts.gen);
    if (generated.has(key)) return generated.get(key);
    const rules = await rulesOnly();
    await ensureWorker();
    const g = await game.generate(opts.gen);
    const data = { source: 'generated', map: g.map, scenario: g.scenario, rules, idSource: Conquest.view.rasterize(g.map) };
    generated.clear();
    generated.set(key, data);
    return data;
  }

  // ---------- the worker ----------
  async function ensureWorker() {
    if (worker) return worker;
    if (!sourceText) {
      const r = await ide.api.invoke('conquest:workerSource');
      if (!r?.ok) throw new Error(r?.code || 'no-worker-source');
      sourceText = r.text;
    }
    workerUrl = workerUrl || URL.createObjectURL(new Blob([sourceText], { type: 'text/javascript' }));
    worker = new Worker(workerUrl);
    worker.onmessage = (e) => receive(e.data);
    worker.onerror = (e) => { e.preventDefault?.(); crashed(`${e.message || 'worker error'}${e.lineno ? ` (line ${e.lineno})` : ''}`); };
    worker.onmessageerror = () => crashed('a message from the simulation could not be read');
    return worker;
  }

  function post(m, transfer) {
    if (!worker) return false;
    worker.postMessage(m, transfer || []);
    return true;
  }

  function request(m, ms) {
    return ensureWorker().then(() => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('no-answer')); }, ms);
      pending.set(id, { resolve, reject, timer });
      if (!post({ ...m, id })) { clearTimeout(timer); pending.delete(id); reject(new Error('no-game')); }
    }));
  }

  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  function crashed(message) {
    if (game.status === 'crashed') return;
    log.error(`the simulation stopped: ${message}`);
    game.lastError = message;
    const had = game.status === 'running';
    game.status = 'crashed';
    game.speed = 0;
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new Error('crashed')));
    try { worker?.terminate(); } catch {}
    worker = null;
    ide.api.send('conquest:running', false);
    emit('crashed', { message, hadGame: had });
  }

  function receive(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'tick': applyDelta(m); schedule(); return;
      case 'orderResult': case 'saved': case 'answer': case 'generated': case 'explained': case 'ready': case 'testDone':
        return settle(m.id, (p) => p.resolve(m));
      case 'error':
        if (m.reason === 'tick-failed') return crashed(m.message || m.reason);
        if (m.id) return settle(m.id, (p) => p.reject(new Error(m.reason || 'failed')));
        log.warn(`the simulation answered an error: ${m.reason}${m.message ? ` ${m.message}` : ''}`);
        return;
      default:
    }
  }

  // ---------- starting a game ----------
  async function start(data, init, saveName = null) {
    if (game.status === 'crashed') game.status = 'none';
    await ensureWorker();
    if (game.running) post({ type: 'speed', n: 0 });
    game.status = 'starting';
    let ready;
    try {
      ready = await request(init, LOAD_MS);
    } catch (err) {
      if (game.status === 'starting') game.status = 'none';
      return { ok: false, reason: err.message || 'failed' };
    }
    const s = ready.snapshot;
    fields = Object.fromEntries((ready.divFields || DEFAULT_FIELDS).map((f, i) => [f, i]));
    Object.assign(game, { map: data.map, scenario: data.scenario, rules: data.rules, idSource: data.idSource, source: data.source,
      player: s.player, hour: s.hour, speed: 0, meta: ready.meta || init.meta || {}, outcome: null, log: [], offers: [], battles: [], me: null });
    const n = data.map.provinces.length;
    game.prov = { owner: Int16Array.from(s.prov.owner), ctrl: Int16Array.from(s.prov.ctrl) };
    game.supply = new Int16Array(n);
    game.weather = new Uint8Array(n);
    game.sea = new Int16Array(n).fill(-1);
    game.divs = new Map();
    tplOf.clear();
    game.selection = { province: 0, army: null, division: null, divisions: [] };
    game.lastSave = saveName;
    dirty = blank();
    applyDelta(ready.delta);
    decodeDivs();
    lastMonth = game.date().m;
    game.status = 'running';
    ide.api.send('conquest:running', true);
    flush();
    emit('loaded', { save: saveName });
    return { ok: true };
  }
  const DEFAULT_FIELDS = ['id', 'nation', 'prov', 'to', 'str', 'org', 'army', 'sup', 'dig', 'manual', 'eta', 'dest'];

  // ---------- deltas ----------
  function applyDelta(d) {
    if (!dirty) dirty = blank();
    // A game day's industry, supply and weather run in its first hour, so its 'day' is at hour 1 (sim/host.js).
    const crossedDay = Math.floor((d.hour - 1) / 24) !== Math.floor((game.hour - 1) / 24);
    game.hour = d.hour;
    for (const [id, owner, ctrl] of d.provinces || []) {
      game.prov.owner[id] = owner;
      game.prov.ctrl[id] = ctrl;
      dirty.provinces.add(id);
    }
    if (d.tpls) for (const [id, tpl] of d.tpls) tplOf.set(id, tpl);
    if (d.divs) { pendingDivs = d.divs; dirty.divs = true; }
    if (d.battles) { game.battles = d.battles; dirty.battles = true; }
    if (d.nations) {
      const sc = game.scenario;
      game.nations = d.nations.map((r) => ({ ...r, name: sc?.nations[r.index]?.name || r.tag, color: sc?.nations[r.index]?.color || '#888888' }));
      dirty.nations = true;
    }
    if (d.me) { game.me = d.me; dirty.me = true; }
    if (d.factories) game.factories = d.factories;
    if (d.offers) { game.offers = d.offers; emitLater('offers'); }
    if (d.log?.length) {
      game.log.push(...d.log);
      if (game.log.length > LOG_KEEP) game.log.splice(0, game.log.length - LOG_KEEP);
      dirty.log.push(...d.log);
    }
    if (d.events?.length) dirty.events.push(...d.events);
    if (d.outcome) { game.outcome = d.outcome; emitLater('over'); }
    if (d.sea) {
      game.sea.fill(-1);
      for (const [z, c] of d.sea) game.sea[z] = c;
      dirty.sea = true;
    }
    if (d.supply) { game.supply.set(d.supply); dirty.supply = true; }
    if (d.weather) game.weather.set(d.weather);
    if (crossedDay || d.day) dirty.day = true;
  }

  const later = new Set();
  const emitLater = (name) => later.add(name);

  function decodeDivs() {
    const a = pendingDivs;
    if (!a) return;
    pendingDivs = null;
    const F = fields;
    const stride = Object.keys(F).length;
    const seen = new Set();
    for (let o = 0; o < a.length; o += stride) {
      const id = a[o + F.id];
      seen.add(id);
      let d = game.divs.get(id);
      if (!d) { d = { id }; game.divs.set(id, d); }
      d.nation = a[o + F.nation];
      d.prov = a[o + F.prov];
      d.to = a[o + F.to];
      d.str = a[o + F.str];
      d.org = a[o + F.org];
      d.army = a[o + F.army] < 0 ? null : a[o + F.army];
      d.sup = a[o + F.sup];
      d.dig = a[o + F.dig];
      d.manual = a[o + F.manual] === 1;
      d.eta = a[o + F.eta];
      d.dest = a[o + F.dest];
      d.tpl = tplOf.get(id) || null;
    }
    if (seen.size !== game.divs.size) for (const id of [...game.divs.keys()]) if (!seen.has(id)) { game.divs.delete(id); tplOf.delete(id); }
  }

  function schedule() {
    if (flushHandle) return;
    flushHandle = requestAnimationFrame(flush);
    // A hidden window gets no animation frames; the mirror's listeners still hear about the game a few times a second.
    flushTimer = setTimeout(flush, 250);
  }

  function flush() {
    if (flushHandle) cancelAnimationFrame(flushHandle);
    clearTimeout(flushTimer);
    flushHandle = 0;
    flushTimer = 0;
    if (!dirty) return;
    decodeDivs();
    const d = dirty;
    dirty = blank();
    emit('tick', d);
    if (d.day) {
      emit('day', game.date());
      const m = game.date().m;
      if (m !== lastMonth && game.running) {
        lastMonth = m;
        game.autosave().then((r) => { if (!r.ok && r.code !== 'off') log.warn(`autosave failed: ${r.code}`); });
      }
    }
    for (const e of d.log) emit('event', e);
    for (const e of d.events) emit('event', { ...e, hour: game.hour, live: true });
    for (const name of later) emit(name, game[name === 'over' ? 'outcome' : name]);
    later.clear();
  }

  ide.api.on('conquest:quitSave', async () => {
    try {
      if (game.running) await Promise.race([game.autosave(), new Promise((r) => { setTimeout(r, 8000); })]);
    } finally {
      ide.api.send('conquest:quitSaved');
    }
  });
})();
