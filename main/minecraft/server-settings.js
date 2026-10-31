// A server's settings as the Server Settings tab edits them: server.properties, read and written as Java properties
// (what the server reads), and the players on whitelist.json and ops.json. The tab lays the known properties out; the
// types here check every value before a line is written, and lines the tab does not know are kept as they are.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const bool = (key, def) => ({ key, type: 'bool', def });
const int = (key, min, max, def) => ({ key, type: 'int', min, max, def });
const choice = (key, choices, def) => ({ key, type: 'choice', choices, def });
const text = (key, def = '') => ({ key, type: 'text', def });

// The properties the tab shows, with the value a server uses when the line is missing.
const PROPERTIES = [
  text('motd', 'A Minecraft Server'), int('server-port', 1, 65535, '25565'), int('max-players', 1, 1000, '20'),
  choice('gamemode', ['survival', 'creative', 'adventure', 'spectator'], 'survival'), bool('force-gamemode', 'false'),
  choice('difficulty', ['peaceful', 'easy', 'normal', 'hard'], 'easy'), bool('hardcore', 'false'), bool('pvp', 'true'),
  bool('allow-flight', 'false'), bool('allow-nether', 'true'), bool('enable-command-block', 'false'), int('spawn-protection', 0, 1000, '16'),
  text('level-name', 'world'), text('level-seed'), choice('level-type', ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'], 'minecraft:normal'),
  bool('generate-structures', 'true'), int('max-world-size', 1, 29999984, '29999984'),
  bool('online-mode', 'true'), bool('white-list', 'false'), bool('enforce-whitelist', 'false'), choice('op-permission-level', ['1', '2', '3', '4'], '4'),
  int('player-idle-timeout', 0, 100000, '0'), bool('hide-online-players', 'false'),
  int('view-distance', 3, 32, '10'), int('simulation-distance', 3, 32, '10'), int('entity-broadcast-range-percentage', 10, 1000, '100'),
  int('network-compression-threshold', -1, 65535, '256'), int('max-tick-time', -1, 2147483647, '60000'), bool('sync-chunk-writes', 'true'),
  int('rate-limit', 0, 100000, '0'),
];
const KNOWN = new Map(PROPERTIES.map((p) => [p.key, p]));

// ---------- server.properties ----------
// Java's properties escapes: \uXXXX, \t \n \r \f, and a backslash before any other character stands for it.
const unescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, c) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16))
  : { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c));
// Written ASCII-only (other characters as \uXXXX): older servers read the file as ISO-8859-1, newer ones as UTF-8, and
// both decode the escapes. A leading space is escaped so it stays part of the value; a line break becomes \n.
const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/^ /, '\\ ')
  .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// {key: value} of the file's property lines (comments and blank lines skipped).
function readProperties(file) {
  const out = {};
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([^#!\s=:][^=:]*?)\s*[=:]\s?(.*)$/.exec(line);
    if (m) out[unescape(m[1])] = unescape(m[2]);
  }
  return out;
}
// Each changed line is replaced where it is (or added at the end): comments, order and the other lines stay.
function writeProperties(file, changes) {
  let raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(changes)) {
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*[=:].*$`, 'm');
    const line = `${key}=${escape(value)}`;
    raw = re.test(raw) ? raw.replace(re, () => line) : `${raw.replace(/\n?$/, raw ? '\n' : '')}${line}\n`;
  }
  fs.writeFileSync(file, raw);
}

// The value a property may be given, as the file's text; throws with what is wrong.
// The message of the day may have two lines, as the multiplayer list shows it; any other value is one line.
function checked(key, value, current) {
  const v = key === 'motd' ? String(value ?? '').replace(/\r\n?/g, '\n').split('\n').slice(0, 2).join('\n') : String(value ?? '').replace(/[\r\n]+/g, ' ');
  const p = KNOWN.get(key);
  if (!p) {
    if (current === undefined) throw fail(`${key} is not a line of server.properties`);
    return v;
  }
  if (p.type === 'bool' && v !== 'true' && v !== 'false') throw fail(`${key} is true or false`);
  if (p.type === 'int') {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < p.min || n > p.max) throw fail(`${key} is a whole number from ${p.min} to ${p.max}`);
    return String(n);
  }
  // A value another Minecraft version wrote (an older level-type, say) may stay as it is.
  if (p.type === 'choice' && !p.choices.includes(v) && v !== current) throw fail(`${key} is one of ${p.choices.join(', ')}`);
  return v;
}

// ---------- players ----------
// The UUID an offline-mode server gives a name: version 3, from the MD5 of "OfflinePlayer:<name>".
function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return dashed(h.toString('hex'));
}
const dashed = (hex) => hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const NAME = /^[A-Za-z0-9_]{1,16}$/;

const readList = (file) => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v.filter((e) => e && typeof e === 'object' && typeof e.name === 'string') : [];
  } catch { return []; }
};
function players(dir) {
  return {
    whitelist: readList(path.join(dir, 'whitelist.json')).map((e) => ({ name: e.name, uuid: String(e.uuid || '') })),
    ops: readList(path.join(dir, 'ops.json')).map((e) => ({ name: e.name, uuid: String(e.uuid || ''), level: Number(e.level) || 4,
      bypassesPlayerLimit: !!e.bypassesPlayerLimit })),
  };
}
// The lists as the server writes them; a name given twice is kept once.
function checkedList(list, op) {
  if (!Array.isArray(list)) throw fail('A player list is a list');
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!NAME.test(e?.name || '')) throw fail(`${e?.name} is not a Minecraft name (letters, digits and _, up to 16)`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.uuid || '')) throw fail(`${e.name} has no UUID`);
    if (seen.has(e.name.toLowerCase())) continue;
    seen.add(e.name.toLowerCase());
    out.push(op ? { uuid: e.uuid.toLowerCase(), name: e.name, level: Math.min(4, Math.max(1, Number(e.level) || 4)), bypassesPlayerLimit: !!e.bypassesPlayerLimit }
      : { uuid: e.uuid.toLowerCase(), name: e.name });
  }
  return out;
}

// {name, uuid} for a name: an online-mode server's players are Mojang accounts (lookup(name) -> {name, id} | null),
// an offline-mode server's are the name's offline UUID.
async function player(name, online, lookup) {
  const n = String(name || '').trim();
  if (!NAME.test(n)) throw fail('A Minecraft name has letters, digits and _, up to 16');
  if (!online) return { name: n, uuid: offlineUuid(n) };
  const p = await lookup(n);
  if (!p) throw fail(`No Minecraft account is named ${n}`, 'noAccount');
  return { name: p.name, uuid: dashed(p.id) };
}

// ---------- the whole ----------
function read(dir) {
  return { props: readProperties(path.join(dir, 'server.properties')), ...players(dir) };
}
// changes: {props: {key: value}, whitelist?, ops?}. Everything is checked before anything is written.
function write(dir, { props = {}, whitelist, ops } = {}) {
  const file = path.join(dir, 'server.properties');
  const current = readProperties(file);
  const lines = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, checked(k, v, current[k])]));
  const lists = { whitelist: whitelist && checkedList(whitelist, false), ops: ops && checkedList(ops, true) };
  if (Object.keys(lines).length) writeProperties(file, lines);
  for (const [name, list] of Object.entries(lists)) {
    if (list) fs.writeFileSync(path.join(dir, `${name === 'ops' ? 'ops' : 'whitelist'}.json`), `${JSON.stringify(list, null, 2)}\n`);
  }
}

module.exports = { PROPERTIES, read, write, player, readProperties, writeProperties, offlineUuid };
