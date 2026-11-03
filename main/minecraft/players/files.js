// What the server itself keeps about players, read and never written: the server overwrites these files, and a running
// one would not see a change anyway. Anything a damaged or missing file cannot give comes back as a value the tab can
// branch on, since Electron passes only the message of a thrown error.
const fs = require('fs');
const path = require('path');
const { readProperties } = require('../server-settings');
const { readNbt, detailOf } = require('./nbt');
const { UUID } = require('./store');

const FILE_MAX = 16 << 20;

const readJson = async (file) => {
  try {
    const st = await fs.promises.stat(file);
    if (st.size > FILE_MAX) return null;
    const text = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { return null; }
};
const listOf = async (file) => {
  const v = await readJson(file);
  return Array.isArray(v) ? v.filter((e) => e && typeof e === 'object') : [];
};

// The world folder from server.properties, inside the server folder whatever level-name says.
function worldOf(dir) {
  let name = 'world';
  try { name = readProperties(path.join(dir, 'server.properties'))['level-name'] || 'world'; } catch {}
  const world = path.resolve(dir, name);
  return world.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep) ? world : path.join(dir, 'world');
}
const expired = (entry) => {
  const at = Date.parse(entry.expires);
  return Number.isFinite(at) && at < Date.now();
};

// usercache.json -> Map(name -> uuid).
async function readUsercache(dir) {
  const map = new Map();
  for (const e of await listOf(path.join(dir, 'usercache.json'))) {
    const uuid = String(e.uuid || '').toLowerCase();
    if (typeof e.name === 'string' && UUID.test(uuid)) map.set(e.name, uuid);
  }
  return map;
}
// The ids the server's cache gives a name now. It looks names up without case, and an entry past expiresOn, or one whose
// date it cannot parse (yyyy-MM-dd HH:mm:ss Z), it does not use: it asks Mojang instead (GameProfileCache of 1.20.1,
// CachedUserNameToIdResolver of 26.3). It saves the file at each change.
async function cachedIds(dir, name) {
  const lower = String(name).toLowerCase();
  const ids = new Set();
  for (const e of await listOf(path.join(dir, 'usercache.json'))) {
    const uuid = String(e.uuid || '').toLowerCase();
    const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(e.expiresOn) ? Date.parse(e.expiresOn) : NaN;
    if (typeof e.name === 'string' && e.name.toLowerCase() === lower && UUID.test(uuid) && at > Date.now()) ids.add(uuid);
  }
  return [...ids];
}

// ops.json, whitelist.json and banned-players.json -> lookups by uuid or lower-case name, and who they name.
async function readFlags(dir) {
  const [ops, whitelist, banned] = await Promise.all(['ops.json', 'whitelist.json', 'banned-players.json'].map((f) => listOf(path.join(dir, f))));
  const keys = (e) => [String(e.uuid || '').toLowerCase(), String(e.name || '').toLowerCase()].filter(Boolean);
  const levels = new Map(ops.flatMap((e) => keys(e).map((k) => [k, Number(e.level) || 4])));
  const allowed = new Set(whitelist.flatMap(keys));
  const barred = new Set(banned.filter((e) => !expired(e)).flatMap(keys));
  return {
    named: [...ops, ...whitelist, ...banned],
    of(uuid, name) {
      const ids = [uuid, String(name || '').toLowerCase()];
      const level = ids.map((k) => levels.get(k)).find(Boolean) ?? 0;
      return { op: level > 0, opLevel: level, whitelisted: ids.some((k) => allowed.has(k)), banned: ids.some((k) => barred.has(k)) };
    },
  };
}

// stats/<uuid>.json: its layout changed at 1.13, and play_one_minute was renamed play_time at 1.17.
async function readStats(world, uuid) {
  const file = [path.join(world, 'players', 'stats', `${uuid}.json`), path.join(world, 'stats', `${uuid}.json`)];
  const s = await readJson(file[0]) ?? await readJson(file[1]);
  const c = s?.stats?.['minecraft:custom'] ?? {};
  const n = (v) => (typeof v === 'number' ? v : 0);
  return {
    playTimeTicks: n(c['minecraft:play_time'] ?? c['minecraft:play_one_minute'] ?? s?.['stat.playOneMinute']),
    deaths: n(c['minecraft:deaths'] ?? s?.['stat.deaths']),
    mobKills: n(c['minecraft:mob_kills'] ?? s?.['stat.mobKills']),
    jumps: n(c['minecraft:jump'] ?? s?.['stat.jump']),
  };
}
// Recipes unlocked are entries too, but no one earned them.
async function readAdvancements(world, uuid) {
  const a = await readJson(path.join(world, 'players', 'advancements', `${uuid}.json`)) ?? await readJson(path.join(world, 'advancements', `${uuid}.json`));
  if (!a || typeof a !== 'object') return 0;
  return Object.entries(a).filter(([id, v]) => v?.done === true && !id.includes(':recipes/')).length;
}
const extras = async (dir, uuid) => {
  const world = worldOf(dir);
  return { stats: await readStats(world, uuid), advancements: await readAdvancements(world, uuid) };
};

// The saved player -> Detail, or {source: 'file', code: 'missing'|'damaged', error} with what the other files still give.
async function readDetail(dir, uuid) {
  const world = worldOf(dir);
  const candidates = [path.join(world, 'players', 'data', `${uuid}.dat`), path.join(world, 'playerdata', `${uuid}.dat`)];
  const extra = await extras(dir, uuid);
  for (const file of candidates) {
    let data;
    try {
      if ((await fs.promises.stat(file)).size > FILE_MAX) return { source: 'file', code: 'damaged', error: `${path.basename(file)} is too large to be a player file`, ...extra };
      data = await fs.promises.readFile(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { source: 'file', code: 'damaged', error: `${path.basename(file)} cannot be read: ${err.code || err.message}`, ...extra };
    }
    try {
      return { ...detailOf(await readNbt(data)), ...extra };
    } catch (err) {
      return { source: 'file', code: 'damaged', error: `${path.basename(file)}: ${err.message}`, ...extra };
    }
  }
  return { source: 'file', code: 'missing', error: 'The server has saved nothing for this player yet', ...extra };
}

module.exports = { worldOf, readUsercache, cachedIds, readFlags, readDetail, extras };
