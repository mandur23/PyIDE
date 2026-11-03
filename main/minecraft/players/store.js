// What a server's Players tab remembers, in <server>/.nano/players/: one JSONL file per player (<uuid>.jsonl), admin.jsonl
// for what was done through the tab, and index.json for the roster. add() only queues: the server's output path must
// never wait for the disk, so a timer writes the queue in one batch. All writes go through one promise chain, so a prune
// at session start finishes before the first append of that session. A crash can leave a torn last line: readers skip
// any line that does not parse, and the prune repairs the file so the next append does not run into it.
const { once } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { maskAddresses } = require('./logparse');

const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 86400000;
const QUEUE_MAX = 20000; // lines held while the disk refuses them; beyond this the oldest go
const READ_MAX = 1000;
const ADMIN = 'admin.jsonl';
const INDEX = 'index.json';
// Each line starts with its time, so a prune can compare it without parsing the line.
const STAMP_AT = 6; // after {"t":"
const STAMP_LENGTH = 24;
const BLOCK = 64 << 10; // how much of a player's file a search reads between turns of the event loop
const LINE_LIMIT = 1 << 20; // a block run with no line break is damage, not a line
const REBUILD_MAX = 32 << 20; // a player file the synchronous index rebuild still reads
const POINT = /^\s*(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)\s*$/;
// Whether an event happened at this block: a record of a burst lists every block it covers.
const isAt = (e, [x, y, z]) => (Array.isArray(e.at) && e.at.some((p) => Array.isArray(p) && p[0] === x && p[1] === y && p[2] === z))
  || (Math.floor(e.x) === x && Math.floor(e.y) === y && Math.floor(e.z) === z);

// The one way an entry becomes a line, so that no field of any entry reaches a file with a full address in it.
const lineOf = (entry) => JSON.stringify(entry, (_key, value) => (typeof value === 'string' ? maskAddresses(value) : value));

const parsed = (line) => {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && typeof v.t === 'string' ? v : null;
  } catch { return null; }
};
const linesOf = (text) => text.split('\n').map(parsed).filter(Boolean);
const readFile = (file) => fs.promises.readFile(file, 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err; });

// A file's lines from the end, a block at a time, so a search stops without reading the rest. Lines are cut at the byte
// of a line break, which a block's edge cannot split, unlike a character.
async function* linesFromEnd(file) {
  let handle;
  try { handle = await fs.promises.open(file, 'r'); } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    let { size: end } = await handle.stat();
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - BLOCK);
      const block = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(block, 0, block.length, start);
      const joined = Buffer.concat([block.subarray(0, bytesRead), rest]);
      end = start;
      const cut = end > 0 ? joined.indexOf(10) : -1;
      if (end > 0 && cut === -1) {
        rest = joined.length > LINE_LIMIT ? Buffer.alloc(0) : joined;
        continue;
      }
      rest = cut === -1 ? rest : joined.subarray(0, cut);
      yield joined.toString('utf8', cut + 1).split('\n').reverse();
    }
  } finally { await handle.close(); }
}

function createStore(dir, { retentionDays = 30, flushMs = 1000, now = Date.now, log = () => {} } = {}) {
  const folder = path.join(dir, '.nano', 'players');
  const fileOf = (name) => path.join(folder, name);
  let queue = new Map(); // file name -> [line]
  let queued = 0;
  let timer = null;
  let chain = Promise.resolve();
  let index = null; // {players: {uuid: {name, firstSeen, lastSeen, playTimeMs}}}
  let indexDirty = false;
  let lastStamp = 0;
  let warned = false;

  // A junction in place of .nano or .nano/players must not lead the prune, the writes or the reads out of the server
  // folder (bridge.js refuses the same). Asked at each use: the folder can be replaced while the server runs.
  function inside() {
    let base;
    try { base = `${fs.realpathSync.native(dir).toLowerCase()}${path.sep}`; } catch (err) { return err.code === 'ENOENT'; }
    for (const p of [path.dirname(folder), folder]) {
      let real;
      try { real = fs.realpathSync.native(p); } catch {
        // Not there yet: made inside. There but not to be followed (a junction to nowhere): refused.
        try { fs.lstatSync(p); } catch { return true; }
        real = '';
      }
      if (!real.toLowerCase().startsWith(base)) {
        if (!warned) log('.nano/players leads out of the server folder, so no record is kept or read there');
        warned = true;
        return false;
      }
    }
    return true;
  }

  const enqueue = (name, line) => {
    if (!queue.has(name)) queue.set(name, []);
    queue.get(name).push(line);
    // Dropped in a block: one shift per line past the limit would be quadratic on the server's output path.
    if (++queued > QUEUE_MAX) {
      const [file, oldest] = queue.entries().next().value;
      const dropped = oldest.splice(0, Math.ceil(oldest.length / 8));
      queued -= dropped.length;
      if (!oldest.length) queue.delete(file);
    }
    timer ??= setTimeout(() => { timer = null; flush(); }, flushMs);
    timer.unref?.();
  };

  function loadIndexSync() {
    if (index) return index;
    if (!inside()) {
      index = { players: {} };
      return index;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(fileOf(INDEX), 'utf8'));
      index = saved && typeof saved.players === 'object' && saved.players ? saved : null;
    } catch (err) {
      if (err.code !== 'ENOENT') log(`index.json cannot be read, rebuilding it: ${err.message}`);
    }
    index ??= { players: rebuiltPlayers() };
    return index;
  }
  // From the player files: the index is only a summary of them, though played time older than the retention is gone.
  function rebuiltPlayers() {
    const players = {};
    let names = [];
    try { names = fs.readdirSync(folder); } catch { return players; }
    for (const name of names) {
      const uuid = name.replace(/\.jsonl$/, '');
      if (!UUID.test(uuid)) continue;
      let events = [];
      try {
        const { size } = fs.statSync(fileOf(name));
        // Read whole and synchronously, a file of hundreds of MB would hold the main process.
        if (size > REBUILD_MAX) {
          log(`${name}: ${Math.round(size / 1048576)} MB, too large to rebuild the index from, so the player is left out of it`);
          continue;
        }
        events = linesOf(fs.readFileSync(fileOf(name), 'utf8'));
      } catch (err) {
        log(`${name}: ${err.code || err.message}`);
        continue;
      }
      if (!events.length) continue;
      let since = null;
      let playTimeMs = 0;
      for (const e of events) {
        if (e.type === 'join') since = Date.parse(e.t);
        else if (e.type === 'leave' && since != null) { playTimeMs += Math.max(0, Date.parse(e.t) - since); since = null; }
      }
      const last = events[events.length - 1];
      players[uuid] = { name: events.findLast((e) => e.name)?.name ?? null, firstSeen: events[0].t, lastSeen: last.t, playTimeMs };
    }
    return players;
  }

  // The server was deleted: its records went with it. Writing them would bring its folder back, and a folder with no
  // description is neither a server nor a free name. A folder that leads out of it is dropped the same way.
  const deleted = () => {
    if (fs.existsSync(dir) && inside()) return false;
    queue = new Map();
    queued = 0;
    indexDirty = false;
    index = null;
    return true;
  };

  const writeBatch = async () => {
    if ((!queue.size && !indexDirty) || deleted()) return;
    const batch = queue;
    queue = new Map();
    queued = 0;
    await fs.promises.mkdir(folder, { recursive: true }).catch(() => {});
    for (const [name, lines] of batch) {
      try { await fs.promises.appendFile(fileOf(name), `${lines.join('\n')}\n`); } catch (err) {
        log(`${name}: ${err.code || err.message}`);
        // Back in front of what came meanwhile; the next add's timer tries again.
        queue.set(name, [...lines, ...(queue.get(name) || [])]);
        queued += lines.length;
      }
    }
    if (indexDirty && index) {
      indexDirty = false;
      const tmp = fileOf(`${INDEX}.tmp`);
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(index));
        await fs.promises.rename(tmp, fileOf(INDEX));
      } catch (err) {
        indexDirty = true;
        log(`${INDEX}: ${err.code || err.message}`);
      }
    }
  };
  // Resolves when everything queued so far is on disk (or refused by it).
  const flush = () => { chain = chain.then(writeBatch).catch((err) => log(err.message)); return chain; };

  // At app quit no asynchronous write would finish.
  function flushSync() {
    clearTimeout(timer);
    timer = null;
    if ((!queue.size && !indexDirty) || deleted()) return;
    try {
      fs.mkdirSync(folder, { recursive: true });
      for (const [name, lines] of queue) fs.appendFileSync(fileOf(name), `${lines.join('\n')}\n`);
      queue = new Map();
      queued = 0;
      if (indexDirty && index) {
        fs.writeFileSync(fileOf(`${INDEX}.tmp`), JSON.stringify(index));
        fs.renameSync(fileOf(`${INDEX}.tmp`), fileOf(INDEX));
        indexDirty = false;
      }
    } catch (err) { log(err.message); }
  }

  async function pruneFile(name, cutoff) {
    const file = fileOf(name);
    const handle = await fs.promises.open(file, 'r');
    let oldest;
    let last;
    let size;
    try {
      ({ size } = await handle.stat());
      if (!size) return;
      const head = Buffer.alloc(STAMP_AT + STAMP_LENGTH);
      await handle.read(head, 0, head.length, 0);
      oldest = head.toString('utf8', STAMP_AT, STAMP_AT + STAMP_LENGTH);
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      last = tail[0];
    } finally { await handle.close(); }
    // Lines are in time order, so a file whose first line is recent and whose last is whole needs nothing.
    if (oldest >= cutoff && last === 10) return;
    // Line by line: with a plugin's records a month of one player runs to hundreds of MB, past what one string can hold.
    const tmp = `${file}.tmp`;
    const out = fs.createWriteStream(tmp);
    let kept = 0;
    for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
      if (!line || line.slice(STAMP_AT, STAMP_AT + STAMP_LENGTH) < cutoff || !parsed(line)) continue;
      kept++;
      if (!out.write(`${line}\n`)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'close');
    if (!kept) { await fs.promises.rm(tmp, { force: true }); await fs.promises.rm(file, { force: true }); return; }
    await fs.promises.rename(tmp, file);
  }

  async function prune() {
    const cutoff = new Date(now() - retentionDays * DAY).toISOString();
    let names = [];
    try { names = await fs.promises.readdir(folder); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try { await pruneFile(name, cutoff); } catch (err) { log(`${name}: ${err.code || err.message}`); }
    }
  }
  // Session start. The folder ignores itself, so chat logs do not reach a project's git repository.
  const open = () => {
    chain = chain.then(async () => {
      if (!inside()) return;
      await fs.promises.mkdir(folder, { recursive: true });
      await fs.promises.writeFile(path.join(dir, '.nano', '.gitignore'), '*\n');
      await prune();
      // A server deleted and made again under its name must not inherit the old roster from memory.
      if (!indexDirty) index = null;
      loadIndexSync();
    }).catch((err) => log(err.message));
    return chain;
  };

  // Times strictly rise, so `before` pages a timeline without losing events of one millisecond.
  const stamp = () => {
    lastStamp = Math.max(now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  // event: {type, name, uuid, text, ...}, without a time. Returns it with its time.
  function add(event) {
    const entry = { t: stamp(), ...event };
    if (UUID.test(entry.uuid || '')) enqueue(`${entry.uuid}.jsonl`, lineOf(entry));
    return entry;
  }
  function touch(uuid, name, { playTimeMs = 0 } = {}) {
    if (!UUID.test(uuid || '')) return;
    const { players } = loadIndexSync();
    const t = new Date(now()).toISOString();
    const p = players[uuid] ?? (players[uuid] = { name, firstSeen: t, lastSeen: t, playTimeMs: 0 });
    p.name = name;
    p.lastSeen = t;
    p.playTimeMs += playTimeMs;
    indexDirty = true;
    timer ??= setTimeout(() => { timer = null; flush(); }, flushMs);
    timer.unref?.();
  }
  function admin(entry) {
    const line = { t: stamp(), ...entry };
    // A whisper's text is capped by the action itself; this keeps any action from growing the log without bound.
    if (JSON.stringify(line.action ?? null).length > 4096) line.action = { type: line.action?.type, target: line.action?.target };
    enqueue(ADMIN, lineOf(line));
    return line;
  }

  const known = () => loadIndexSync().players;
  const uuidOf = (name) => Object.entries(known()).find(([, p]) => p.name === name)?.[0] ?? null;

  const clamp = (limit, fallback) => Math.min(Math.max(1, Number(limit) || fallback), READ_MAX);
  // q: text, or `x y z`, which finds the events at that block. ids: item ids a name in another language stands for.
  const matcher = ({ types, q, ids } = {}) => {
    const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
    const point = typeof q === 'string' ? POINT.exec(q)?.slice(1).map(Number) : null;
    const needle = typeof q === 'string' && q && !point ? q.toLowerCase() : null;
    const named = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const found = (e) => {
      if (point) return isAt(e, point);
      return !needle || named?.has(e.id) || `${e.name ?? ''} ${e.text ?? ''} ${e.id ?? ''} ${e.other ?? ''} ${e.weapon ?? ''}`.toLowerCase().includes(needle);
    };
    return (e) => (!wanted || wanted.has(e.type)) && found(e);
  };

  // Newest first. before: the t of the last event of the previous page. From the file's end, so a page costs a page.
  async function timeline(uuid, { before, limit, types, q, ids } = {}) {
    if (!UUID.test(uuid || '')) return { events: [], more: false };
    await flush();
    if (!inside()) return { events: [], more: false };
    const wants = matcher({ types, q, ids });
    const max = clamp(limit, 100);
    const events = [];
    for await (const lines of linesFromEnd(fileOf(`${uuid}.jsonl`))) {
      for (const line of lines) {
        const e = line ? parsed(line) : null;
        if (!e || (typeof before === 'string' && e.t >= before) || !wants(e)) continue;
        if (events.length === max) return { events, more: true };
        events.push(e);
      }
    }
    return { events, more: false };
  }
  const newestFirst = (a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0);
  // The newest `max` matches across the players' files. A file's lines are in time order, so reading one stops at the
  // first line older than all of the `max` already held. superseded(): a newer search is waiting, so this one's answer
  // no longer matters. -> null then.
  async function searchFiles({ q, types, ids, limit }, superseded) {
    await flush();
    const wants = matcher({ types, q, ids });
    const max = clamp(limit, 200);
    let names = [];
    if (!inside()) return [];
    try { names = await fs.promises.readdir(folder); } catch { return []; }
    let top = [];
    let floor = ''; // older than this cannot make the list. Set between blocks, while top is in order.
    for (const name of names) {
      if (!name.endsWith('.jsonl') || !UUID.test(name.slice(0, -6))) continue;
      read: for await (const lines of linesFromEnd(fileOf(name))) {
        if (superseded()) return null;
        for (const line of lines) {
          const e = line ? parsed(line) : null;
          if (!e) continue;
          if (e.t < floor) break read;
          if (wants(e)) top.push(e);
        }
        if (top.length >= max) {
          top = top.sort(newestFirst).slice(0, max);
          floor = top[max - 1].t;
        }
      }
    }
    return top.sort(newestFirst).slice(0, max);
  }
  // One run at a time. A push on a busy server can ask faster than a search ends, and each run reads every player's file,
  // so asking while one runs takes the place of whoever waits, and all of them get the newest request's answer.
  let searching = false;
  let waiting = null; // {opts, callers}
  async function runSearches() {
    if (searching) return;
    searching = true;
    while (waiting) {
      const { opts, callers } = waiting;
      waiting = null;
      try {
        const found = await searchFiles(opts, () => waiting !== null);
        if (found) for (const c of callers) c.resolve(found);
        else waiting.callers.push(...callers);
      } catch (err) { for (const c of callers) c.reject(err); }
    }
    searching = false;
  }
  function search(opts = {}) {
    return new Promise((resolve, reject) => {
      waiting = { opts, callers: [...(waiting?.callers ?? []), { resolve, reject }] };
      runSearches();
    });
  }
  async function adminLog({ limit } = {}) {
    await flush();
    if (!inside()) return [];
    return linesOf(await readFile(fileOf(ADMIN))).reverse().slice(0, clamp(limit, 200));
  }

  return { open, add, touch, admin, known, uuidOf, flush, flushSync, timeline, search, adminLog, folder };
}

module.exports = { createStore, UUID };
