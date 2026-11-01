// The players:* channels, without Electron: main/features/minecraft.js registers them and hands in what it knows about a
// server. One session per running server, one store per server folder. Nothing the tab branches on is thrown.
const path = require('path');
const { createSession, matchData } = require('./session');
const { createStore, UUID } = require('./store');
const { parseSnbt, detailOf, slotIn } = require('./nbt');
const { readUsercache, readFlags, readDetail, extras } = require('./files');
const { createTail, refusal, installed, install, remove } = require('./bridge');

// describe(dir) -> {version, kind, proxy}, throwing for a folder that is not a server.
function createPlayers({ send, describe, log = () => {}, actions = () => require('./actions'), items = () => require('./items'), storeOptions, sessionOptions, tailOptions }) {
  const sessions = new Map();
  const tails = new Map();
  const stores = new Map();
  const stops = new Map(); // a server's last tail, finishing the file after its session ended
  const key = (dir) => path.resolve(dir).toLowerCase();
  const storeOf = (dir) => {
    const k = key(dir);
    if (!stores.has(k)) stores.set(k, createStore(dir, { log, ...storeOptions }));
    return stores.get(k);
  };
  // A tail keeps its offsets in memory until it saves them, so one that started beside the last would read every line again.
  const tailOf = (dir, seen) => {
    const k = key(dir);
    const store = storeOf(dir);
    return createTail(dir, {
      store, log, ...tailOptions, seen, known: (uuid) => store.known()[uuid]?.name ?? undefined, after: tails.get(k)?.stop() ?? stops.get(k),
    });
  };

  // A session for a server about to start, or null for a process that is no server (a mod's Gradle task). Hand its
  // filter to startProcess and the process to attach().
  function begin(dir) {
    let desc;
    try { desc = describe(dir); } catch { return null; }
    const k = key(dir);
    const store = storeOf(dir);
    const tail = desc.proxy ? null : tailOf(dir, () => session.recorded());
    const session = createSession({
      version: desc.version, proxy: desc.proxy, store, log, ...sessionOptions,
      notify: (kind) => send('minecraft:players', { dir, kind }),
      onEnd: () => {
        if (sessions.get(k) === session) sessions.delete(k);
        if (tail && tails.get(k) === tail) {
          tails.delete(k);
          stops.set(k, tail.stop());
        }
      },
    });
    sessions.set(k, session);
    if (tail) { tails.set(k, tail); tail.start(); }
    if (!desc.proxy) readUsercache(dir).then(session.learn, () => {});
    return session;
  }

  // ---------- the plugin ----------
  // {code: why this server cannot take it, or null; installed: 'none'|'current'|'other'; running; active: it has spoken in
  // this run, so the file is being written; stats of what was read}.
  function bridgeStatus(dir) {
    const desc = describe(dir);
    const k = key(dir);
    const stats = tails.get(k)?.stats;
    return {
      code: refusal(desc), installed: installed(dir), running: sessions.has(k), active: typeof stats?.hello === 'string',
      stats: stats ? { events: stats.events, bad: stats.bad, unknown: stats.unknown, dropped: stats.dropped } : null,
    };
  }
  // Written to the admin log like anything else done to the server through the tab.
  const bridgeChange = (dir, type, change) => {
    const r = change();
    storeOf(dir).admin({ action: { type }, commands: [], ok: r.ok, text: r.text ?? '', ...(r.code && { code: r.code }) });
    return { ...r, restart: r.ok && sessions.has(key(dir)) };
  };

  async function list(dir) {
    const desc = describe(dir);
    const session = sessions.get(key(dir));
    const state = session?.state ?? 'stopped';
    if (desc.proxy) return { running: !!session, state, proxy: true, players: [] };
    const [flags, cache] = await Promise.all([readFlags(dir), readUsercache(dir)]);
    const seen = new Map(Object.entries(storeOf(dir).known()).filter(([uuid]) => UUID.test(uuid)).map(([uuid, p]) => [uuid, { ...p }]));
    const blank = (name) => ({ name, firstSeen: null, lastSeen: null, playTimeMs: 0 });
    for (const [name, uuid] of cache) if (!seen.has(uuid)) seen.set(uuid, blank(name));
    for (const e of flags.named) {
      const uuid = String(e.uuid || '').toLowerCase();
      if (UUID.test(uuid) && !seen.has(uuid)) seen.set(uuid, blank(String(e.name || '')));
    }
    const live = new Map((session?.players() ?? []).map((p) => [p.uuid, p]));
    for (const p of live.values()) if (!seen.has(p.uuid)) seen.set(p.uuid, blank(p.name));
    const now = Date.now();
    const players = [...seen].map(([uuid, p]) => {
      const on = live.get(uuid);
      return {
        uuid, name: on?.name ?? p.name, online: !!on, firstSeen: p.firstSeen, lastSeen: on ? new Date(now).toISOString() : p.lastSeen,
        playTimeMs: (Number(p.playTimeMs) || 0) + (on ? now - on.since : 0), ...flags.of(uuid, p.name), pos: on?.pos ?? null,
      };
    });
    players.sort((a, b) => (b.online - a.online) || String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) || String(a.name).localeCompare(String(b.name)));
    return { running: !!session, state, proxy: false, players };
  }

  // Live while the player is on and the server can say; a server that does not answer leaves the saved file.
  async function detail(dir, uuid) {
    if (!UUID.test(uuid || '')) return { source: 'file', code: 'badUuid', error: 'That is not a player id' };
    const session = sessions.get(key(dir));
    const on = session?.find(uuid);
    if (on && session.hasData && session.state === 'running') {
      try {
        const text = await session.query(`data get entity ${on.name}`, matchData(on.name), 5000);
        if (text !== null) return { ...detailOf(parseSnbt(text), { source: 'live' }), ...await extras(dir, uuid) };
      } catch (err) {
        if (err.code !== 'timeout' && err.code !== 'stopped') log(`live player data of ${on.name}: ${err.message}`);
      }
    }
    return readDetail(dir, uuid);
  }

  // Moves one stack through the console. The slots are read right before and must still be what the tab showed; the lines
  // and a last read go as one write; what that read shows decides the result. Nothing is sent twice: after a change that
  // came out wrong only the owner can tell what to do.
  const moving = new Set();
  async function moveItem(session, desc, act, done) {
    const tools = actions();
    const none = (code, text = '') => done({ ok: false, code, text, commands: [] });
    let plan;
    try { plan = tools.checkMove(act, { version: desc.version, kind: desc.kind }); } catch (err) { return none(err.code || 'invalid', err.message); }
    if (!session.players().some((p) => p.name === plan.target)) return none('offline');
    if (moving.has(session)) return none('busy');
    moving.add(session);
    const read = (text) => detailOf(parseSnbt(text), { source: 'live' });
    let commands = [];
    try {
      const first = await session.query(`data get entity ${plan.target}`, matchData(plan.target), 5000);
      if (first === null) return none('offline');
      const before = read(first);
      const at = (slot) => slotIn(before, slot);
      const printAt = (slot) => at(slot)?.print ?? null;
      const stale = Object.keys(plan.shown).filter((side) => printAt(plan[side]) !== plan.shown[side]);
      if (stale.length) return none('changed', stale.join());
      const built = tools.buildMove(plan, desc, at);
      commands = built.commands;
      const { answers, text } = await session.batch(commands, plan.target, built.expects);
      const said = answers.map((a) => a.text).join('\n').slice(0, 2048);
      if (text === null) return done({ ok: false, code: 'unconfirmed', text: said, commands });
      const after = read(text);
      const wrong = tools.moveDiff(built.wanted, (slot) => slotIn(after, slot));
      const whole = tools.sameStacks(plan, before, after);
      if (!wrong.length && whole) return done({ ok: true, text: said, commands });
      // The same stacks where they were: nothing happened, which is another message than a result nobody wanted.
      const untouched = wrong.length > 0 && built.wanted.every(([slot]) => (slotIn(after, slot)?.print ?? null) === printAt(slot));
      if (untouched) return done({ ok: false, code: 'notMoved', text: said, commands });
      return done({ ok: false, code: 'mismatch', text: said, commands, wrong, whole, changed: tools.changedSlots(before, after) });
    } catch (err) {
      if (!commands.length) return none(err.code || 'failed', err.message);
      return done({ ok: false, code: 'unconfirmed', text: err.message, commands });
    } finally { moving.delete(session); }
  }

  // Commands run in order and the first refused one ends the action: a later one may depend on it.
  async function action(dir, act) {
    const desc = describe(dir);
    if (desc.proxy) return { ok: false, code: 'proxy', text: '', commands: [] };
    const session = sessions.get(key(dir));
    const { shown, ...logged } = act ?? {};
    // changed stays in the log: it can hold every page of a book, and only someone restoring a stack needs it.
    const done = ({ changed, ...result }) => {
      const { commands, ok, text, code } = result;
      storeOf(dir).admin({ action: logged, commands, ok, text, ...(code && { code }), ...(changed && { changed }) });
      return result;
    };
    if (session?.state !== 'running') return done({ ok: false, code: 'notRunning', text: '', commands: [] });
    if (act?.type === 'moveItem') return moveItem(session, desc, act, done);
    let built;
    try { built = actions().build(act, { version: desc.version, kind: desc.kind }); } catch (err) {
      return done({ ok: false, code: err.code || 'invalid', text: err.message, commands: [] });
    }
    const note = built.note ? { note: built.note } : {};
    const commands = [];
    const answers = [];
    const text = () => answers.join('\n').slice(0, 2048);
    for (const line of built.commands) {
      commands.push(line);
      let answer;
      try { answer = await session.command(line, built.expects); } catch (err) {
        return done({ ok: false, code: err.code || 'failed', text: text(), commands, ...note });
      }
      if (answer === null) continue;
      answers.push(answer.text);
      if (answer.refused) return done({ ok: false, code: 'refused', text: text(), commands, ...note });
    }
    return done({ ok: true, text: text(), commands, ...(answers.length < commands.length && { code: 'noAnswer' }), ...note });
  }

  const catalogOf = (dir) => ({ dir, version: describe(dir).version });
  // Everything still queued goes to disk: at quit the asynchronous writes would not finish.
  function closeAll() {
    for (const session of [...sessions.values()]) session.end();
    for (const store of stores.values()) store.flushSync();
  }

  return {
    begin, list, detail, action, closeAll, bridgeStatus,
    bridgeInstall: (dir) => bridgeChange(dir, 'bridgeInstall', () => install(dir, describe(dir))),
    bridgeRemove: (dir) => {
      const r = bridgeChange(dir, 'bridgeRemove', () => remove(dir));
      // No server is running to tail the last day's file, and nothing else would take it off the disk.
      if (r.ok && !sessions.has(key(dir))) stops.set(key(dir), tailOf(dir, () => {}).stop());
      return r;
    },
    timeline: (dir, uuid, opts) => storeOf(dir).timeline(uuid, opts),
    search: (dir, opts) => storeOf(dir).search(opts),
    adminLog: (dir, opts) => storeOf(dir).adminLog(opts),
    // The catalog's extra properties on its array do not cross the context bridge, so they go beside the list.
    items: async (dir, query) => {
      const list = await items().catalog(catalogOf(dir), query);
      return { items: [...list], reason: list.reason ?? null, reasonCode: list.reasonCode ?? null, skipped: list.skipped ?? [], coverage: list.coverage ?? null };
    },
    icons: (dir, ids) => items().icons(catalogOf(dir), ids),
    names: (dir) => items().names(catalogOf(dir)),
    // The tab is open (repeat every 10 s), or closed.
    watch: (dir, on) => { sessions.get(key(dir))?.watch(!!on); return true; },
  };
}

module.exports = { createPlayers };
