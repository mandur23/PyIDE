// The NanoBridge plugin (tools/nano-bridge), seen from main: installing it in a server's plugins/, and tailing what it
// writes to <server>/.nano/bridge/<yyyy-mm-dd>.jsonl into the players' records through store.js.
//
// Any plugin on the server, and anyone with the folder, can write that file, so nothing in it is believed by default. A
// line becomes an event only if its type is on the list, each field has the shape that type has, and its uuid is a player
// this server has seen. The name comes from the store, never from the line, and only the fields named here are copied, so
// a line cannot pass as chat or a join, or carry a field of its own. The file holds what a server plugin claims: forged
// activity for a real player stays possible, and only the badge says where a record came from.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atLeast } = require('./actions');
const { UUID } = require('./store');

const JAR = path.join(__dirname, 'NanoBridge.jar');
const JAR_NAME = 'NanoBridge.jar';
const FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const RESOURCE = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,128}$/;
const NAME = /^[A-Za-z0-9_.]{1,16}$/;
const COMMAND = /^\/[^\s\p{Cc}]{1,63}$/u;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const MIN_VERSION = '1.20';
const DAY = 86400000;
const FUTURE_MS = DAY;
const MAX_XZ = 30000000;
const MAX_Y = 20000000;
const MAX_COUNT = 1000000;
const MAX_SPOTS = 64;
const MAX_WORLD = 64;
const MAX_TEXT = 512;
const LINE_MAX = 64 << 10; // the plugin's longest line is a record of 64 positions or a full sign
const CHUNK = 1 << 20; // read in one go
const LINES_PER_TICK = 4000;
const LINES_PER_CHUNK = 500; // what a chunk costs however few lines it held, so a tick reads a few MB at most
const BACKLOG_MAX = 256 << 20; // a file further ahead than this was not written by the plugin at any sane rate
const POLL_MS = 1500;
const STATE = 'bridge-state.json';

// type -> the fields it has beside its place. Everything else on a line is ignored.
const SHAPES = {
  break: ['id'], place: ['id'], ignite: ['id'], open: ['id'], pickup: ['id'], drop: ['id'], sign: ['id', 'text'],
  take: ['id', 'other'], put: ['id', 'other'], bucket: ['id', 'other'],
  hit: ['other', 'weapon', 'amount'], hurt: ['other', 'weapon', 'amount'], kill: ['other', 'weapon'], pvp: ['other', 'weapon'],
  cmd: ['text'],
};
const cleanText = (v, max) => (typeof v === 'string' && v.length <= max * 4 ? v.replace(CONTROL, ' ').trim().slice(0, max) : null);
const FIELDS = {
  id: (v) => (typeof v === 'string' && RESOURCE.test(v) ? v : null),
  weapon: (v) => (typeof v === 'string' && RESOURCE.test(v) ? v : null),
  other: (v) => (typeof v === 'string' && (RESOURCE.test(v) || NAME.test(v)) ? v : null),
  amount: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COUNT ? v : null),
  text: (v) => cleanText(v, MAX_TEXT),
};
const OPTIONAL = new Set(['other', 'weapon', 'amount']);
const inRange = (x, y, z) => [x, z].every((n) => Number.isInteger(n) && Math.abs(n) <= MAX_XZ) && Number.isInteger(y) && Math.abs(y) <= MAX_Y;
function spotsOf(at) {
  if (at === undefined) return [];
  if (!Array.isArray(at) || at.length > MAX_SPOTS) return null;
  return at.every((p) => Array.isArray(p) && p.length === 3 && inRange(...p)) ? at : null;
}
// A time that cannot be true is left out: the store's own arrival time stands.
function timeOf(v, now, retentionDays) {
  if (typeof v !== 'string' || v.length > 32) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) && at <= now + FUTURE_MS && at >= now - retentionDays * DAY ? new Date(at).toISOString() : null;
}

// One line -> {event} | {hello} | {dropped} | {bad: true} | {unknown: true}. nameOf(uuid): the store's name of a player, or
// undefined for one this server never saw.
function parseLine(line, nameOf, { now = Date.now(), retentionDays = 30 } = {}) {
  if (line.length > LINE_MAX) return { bad: true };
  let v;
  try { v = JSON.parse(line); } catch { return { bad: true }; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.type !== 'string') return { bad: true };
  if (v.type === 'hello') return { hello: cleanText(v.plugin, 32) ?? '' };
  if (v.type === 'dropped') return Number.isInteger(v.n) && v.n > 0 ? { dropped: v.n } : { bad: true };
  if (!Object.hasOwn(SHAPES, v.type) || typeof v.uuid !== 'string' || !UUID.test(v.uuid)) return { bad: true };
  const world = cleanText(v.world, MAX_WORLD);
  const at = spotsOf(v.at);
  if (world === null || !inRange(v.x, v.y, v.z) || !at) return { bad: true };
  const n = v.n === undefined ? 1 : v.n;
  if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return { bad: true };
  const name = nameOf(v.uuid);
  if (name === undefined) return { unknown: true };
  const event = { type: v.type, name, uuid: v.uuid, text: '', world, x: v.x, y: v.y, z: v.z, n };
  for (const field of SHAPES[v.type]) {
    if (v[field] === undefined) {
      if (!OPTIONAL.has(field)) return { bad: true };
      continue;
    }
    const value = FIELDS[field](v[field]);
    if (value === null) return { bad: true };
    event[field] = value;
  }
  if ((v.type === 'cmd' && !COMMAND.test(event.text)) || (v.type === 'sign' && !event.text)) return { bad: true };
  if (at.length) event.at = at;
  const time = timeOf(v.time, now, retentionDays);
  if (time) event.time = time;
  return { event };
}

// Follows .nano/bridge for one session. store: the server's store. known(uuid) -> a name or undefined. seen(): new events
// are on the record. after: the promise of the tail before this one, which it must not run beside. What has been read is
// kept per file in the players' folder, so a restart of the server or the app goes on where it stopped; a day's file is
// deleted once it is read to its end and nothing more can come to it (a later file exists, or the plugin is gone), so the
// unmasked copy does not outlive its use.
function createTail(dir, { store, known, seen = () => {}, log = () => {}, pollMs = POLL_MS, retentionDays = 30, now = Date.now, after = Promise.resolve() }) {
  const folder = path.join(dir, '.nano', 'bridge');
  const stateFile = path.join(store.folder, STATE);
  let offsets = null;
  const skipping = new Set(); // files in the middle of a line too long to take
  let timer = null;
  let running = null;
  let stopped = false;
  let ending = null;
  let saved = '';
  const stats = { events: 0, bad: 0, unknown: 0, skippedBytes: 0, dropped: 0, hello: null };

  async function load() {
    if (offsets) return;
    const held = new Map();
    try {
      const state = JSON.parse(await fs.promises.readFile(stateFile, 'utf8'));
      for (const [name, offset] of Object.entries(state.offsets ?? {})) if (FILE.test(name) && Number.isSafeInteger(offset) && offset >= 0) held.set(name, offset);
    } catch (err) {
      // No file, or a damaged one, starts over. A read that failed for now must not: it would record every line twice.
      if (err.code && err.code !== 'ENOENT') throw err;
    }
    offsets = held;
  }
  async function save() {
    const text = JSON.stringify({ offsets: Object.fromEntries(offsets) });
    if (text === saved) return;
    // After the events are on disk: a crash in between reads a few lines twice instead of losing them.
    await store.flush();
    try {
      await fs.promises.mkdir(store.folder, { recursive: true });
      await fs.promises.writeFile(`${stateFile}.tmp`, text);
      await fs.promises.rename(`${stateFile}.tmp`, stateFile);
      saved = text;
    } catch (err) { log(`${STATE}: ${err.code || err.message}`); }
  }
  // A junction in place of .nano or .nano/bridge must not walk the tail out of the server folder.
  async function realFolder() {
    try {
      const [real, base] = await Promise.all([fs.promises.realpath(folder), fs.promises.realpath(dir)]);
      if (real.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return real;
      log('.nano/bridge leads out of the server folder, so it is not read');
    } catch {}
    return null;
  }
  function take(text) {
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      count++;
      const r = parseLine(line, known, { now: now(), retentionDays });
      if (r.event) { store.add(r.event); stats.events++; } else if (r.hello !== undefined) stats.hello = r.hello;
      else if (r.dropped) stats.dropped += r.dropped;
      else if (r.unknown) stats.unknown++;
      else stats.bad++;
    }
    return count;
  }
  // One read from where the file was left. -> {lines: how many were taken, more: there is more of the file to read, failed:
  // it could not be read now, so what is in it is still unknown}.
  async function readChunk(file, name) {
    const idle = { lines: 0, more: false };
    let handle;
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) return idle;
      let offset = offsets.get(name) ?? 0;
      if (st.size < offset) offset = 0;
      if (st.size - offset > BACKLOG_MAX) {
        stats.skippedBytes += st.size - BACKLOG_MAX - offset;
        offset = st.size - BACKLOG_MAX;
        skipping.add(name);
      }
      offsets.set(name, offset);
      if (st.size === offset) return idle;
      handle = await fs.promises.open(file, 'r');
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK, st.size - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      const body = chunk.subarray(0, bytesRead);
      const lastBreak = body.lastIndexOf(10);
      if (lastBreak === -1) {
        // Half a line at the end waits for the rest. A whole chunk without a line break is damage.
        if (bytesRead < CHUNK) return idle;
        if (!skipping.has(name)) stats.bad++;
        skipping.add(name);
        offsets.set(name, offset + bytesRead);
        return { lines: 0, more: true };
      }
      const start = skipping.delete(name) ? body.indexOf(10) + 1 : 0;
      const lines = take(body.toString('utf8', start, lastBreak));
      const next = offset + lastBreak + 1;
      offsets.set(name, next);
      return { lines, more: next < st.size };
    } catch (err) {
      if (err.code === 'ENOENT') return idle;
      log(`${name}: ${err.code || err.message}`);
      return { lines: 0, more: false, failed: true };
    } finally { await handle?.close(); }
  }
  // -> whether a file has more than this pass could read.
  async function pass() {
    await load();
    const real = await realFolder();
    if (!real) return false;
    let names = [];
    try { names = (await fs.promises.readdir(real)).filter((n) => FILE.test(n)).sort(); } catch { return false; }
    const before = stats.events;
    const said = stats.hello;
    const oldest = new Date(now() - retentionDays * DAY).toISOString().slice(0, 10);
    // A hello in this session means the plugin runs, whatever its jar is called now.
    const pluginGone = () => stats.hello === null && installed(dir) === 'none';
    let budget = LINES_PER_TICK;
    for (const name of names) {
      const expired = name.slice(0, 10) < oldest;
      let unread = false;
      while (!expired && budget > 0) {
        const { lines, more, failed } = await readChunk(path.join(real, name), name);
        unread = failed === true;
        budget -= Math.max(lines, LINES_PER_CHUNK);
        if (!more) break;
      }
      if (budget <= 0) break;
      if (unread) continue;
      // Nothing more comes to this file: anything left past the offset is a line a crash tore.
      if (!expired && name === names.at(-1) && !pluginGone()) continue;
      await fs.promises.rm(path.join(real, name), { force: true }).then(() => offsets.delete(name), () => {});
    }
    for (const name of [...offsets.keys()]) if (!names.includes(name)) offsets.delete(name);
    if (stats.events > before || stats.hello !== said) seen();
    await save();
    return budget <= 0;
  }
  const tick = () => {
    if (running) return running;
    running = after.then(pass).catch((err) => { log(`the bridge tail failed: ${err.message}`); return false; }).finally(() => { running = null; });
    return running;
  };
  const finish = async () => {
    await running;
    for (let i = 0; i < 64 && await tick(); i++);
  };
  return {
    stats,
    start() {
      if (timer || stopped) return;
      timer = setInterval(tick, pollMs);
      timer.unref?.();
    },
    tick,
    // The last lines the plugin wrote as the server went down. A second call is the first one's promise: its passes must
    // not run again beside the next tail.
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      ending ??= finish();
      return ending;
    },
  };
}

// ---------- the plugin in a server ----------
// desc: {version, kind, proxy} -> null when the server can take the plugin, or the code of why not.
function refusal({ kind, version }) {
  if (kind === 'velocity') return 'proxy';
  if (kind === 'vanilla') return 'noPlugins';
  if (kind === 'fabric' || kind === 'forge' || kind === 'neoforge') return 'modded';
  if (kind !== 'paper' && kind !== 'purpur') return 'kind';
  return /^\d+(\.\d+)+$/.test(version || '') && atLeast(version, MIN_VERSION) ? null : 'oldVersion';
}
const jarIn = (dir) => path.join(dir, 'plugins', JAR_NAME);
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
let bundled = null;
const bundledJar = () => { bundled ??= fs.readFileSync(JAR); return bundled; };
// -> 'none' | 'current' | 'other'. A link in plugins/ counts as what it is: nothing of ours.
function installed(dir) {
  let st;
  try { st = fs.lstatSync(jarIn(dir)); } catch { return 'none'; }
  if (!st.isFile()) return 'other';
  try { return sha(fs.readFileSync(jarIn(dir))) === sha(bundledJar()) ? 'current' : 'other'; } catch { return 'other'; }
}
function lockCode(err) { return err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' ? 'locked' : 'failed'; }
// Written beside it first: a half-copied jar in plugins/ would be a failing plugin at the next start.
function install(dir, desc) {
  const code = refusal(desc);
  if (code) return { ok: false, code };
  const file = jarIn(dir);
  const tmp = `${file}.part`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, bundledJar());
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, code: lockCode(err), text: err.message };
  }
}
function remove(dir) {
  try {
    fs.rmSync(jarIn(dir), { force: true });
    return { ok: true };
  } catch (err) { return { ok: false, code: lockCode(err), text: err.message }; }
}

// A server just created, with the app's settings: the plugin goes in only if the owner turned the default on, which stays
// off until they do, because it records people. A server that cannot take it says nothing: nobody asked this of it.
const NEW_SERVERS = 'minecraft.detailedLogNewServers';
function forNewServer(settings, dir, desc, log) {
  if (settings?.[NEW_SERVERS] !== true || refusal(desc)) return null;
  const r = install(dir, desc);
  log(r.ok ? 'NanoBridge is in plugins/: detailed logging is on for this server\n' : `NanoBridge could not be added: ${r.text}\n`);
  return r;
}

module.exports = { parseLine, createTail, refusal, installed, install, remove, forNewServer, FILE, JAR_NAME };
