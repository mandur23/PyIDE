// Player data as the game writes it: binary NBT (gzip, playerdata/<uuid>.dat) and SNBT, the text `data get entity`
// prints. Both give the same plain values: a compound is an object without a prototype (its keys are a player's to
// choose, through an item's custom data), a list or array an array, a long a number while it is exact and else a decimal
// string. Both readers are strict and bounded: a damaged or hostile file ends in an error with code 'damaged', not in a
// hang or a stack overflow. Read-only: the server owns these files and overwrites them.
const zlib = require('zlib');

// depth: the game's own (NbtAccounter), so whatever a player can carry can be read.
const LIMITS = { depth: 512, size: 16 << 20, nodes: 2_000_000 };
const damaged = (why) => Object.assign(new Error(`The player data is damaged: ${why}`), { expected: true, code: 'damaged' });

// ---------- binary ----------
// Java's modified UTF-8: NUL as C0 80, and each half of a surrogate pair as three bytes of its own.
function mutf8(buf, start, end) {
  let plain = true;
  for (let i = start; i < end; i++) if (buf[i] === 0xc0 || buf[i] === 0xed) { plain = false; break; }
  if (plain) return buf.toString('utf8', start, end);
  const units = [];
  for (let i = start; i < end;) {
    const a = buf[i];
    if (a < 0x80) { units.push(a); i += 1; continue; }
    const size = a >> 5 === 6 ? 2 : a >> 4 === 14 ? 3 : 0;
    if (!size || i + size > end) throw damaged('a text is not valid');
    for (let k = 1; k < size; k++) if (buf[i + k] >> 6 !== 2) throw damaged('a text is not valid');
    units.push(size === 2 ? ((a & 31) << 6) | (buf[i + 1] & 63) : ((a & 15) << 12) | ((buf[i + 1] & 63) << 6) | (buf[i + 2] & 63));
    i += size;
  }
  let out = '';
  for (let i = 0; i < units.length; i += 4096) out += String.fromCharCode(...units.slice(i, i + 4096));
  return out;
}

const long = (v) => { const n = Number(v); return Number.isSafeInteger(n) ? n : String(v); };
// The bytes each element of a list takes at least: a declared length is checked against what is left before anything
// is allocated. An empty list inside a list takes 5, an empty compound 1.
const MIN_SIZE = [0, 1, 2, 4, 8, 4, 8, 4, 2, 5, 1, 4, 4];

// Uncompressed NBT -> the root compound.
function parseNbt(buf, { maxDepth = LIMITS.depth, maxNodes = LIMITS.nodes } = {}) {
  let p = 0;
  let nodes = 0;
  const need = (n) => { if (p + n > buf.length) throw damaged('it ends too early'); };
  const counted = (n, size) => {
    if (n < 0 || n * size > buf.length - p) throw damaged('a list is longer than the file');
    if ((nodes += n) > maxNodes) throw damaged('it holds too many values');
  };
  const take = (n, read) => { need(n); const v = read(p); p += n; return v; };
  const int = () => take(4, (at) => buf.readInt32BE(at));
  const str = () => {
    const n = take(2, (at) => buf.readUInt16BE(at));
    need(n);
    const s = mutf8(buf, p, p + n);
    p += n;
    return s;
  };
  const value = (type, depth) => {
    switch (type) {
      case 1: return take(1, (at) => buf.readInt8(at));
      case 2: return take(2, (at) => buf.readInt16BE(at));
      case 3: return int();
      case 4: return take(8, (at) => long(buf.readBigInt64BE(at)));
      case 5: return take(4, (at) => buf.readFloatBE(at));
      case 6: return take(8, (at) => buf.readDoubleBE(at));
      case 7: case 11: case 12: {
        const n = int();
        const size = type === 7 ? 1 : type === 11 ? 4 : 8;
        counted(n, size);
        return Array.from({ length: n }, () => value(type === 7 ? 1 : type === 11 ? 3 : 4, depth));
      }
      case 8: return str();
      case 9: {
        if (depth >= maxDepth) throw damaged('it is nested too deeply');
        const item = take(1, (at) => buf[at]);
        const n = int();
        if (item > 12 || (item === 0 && n > 0)) throw damaged('a list has no valid type');
        counted(n, MIN_SIZE[item]);
        const out = new Array(Math.max(n, 0));
        for (let i = 0; i < n; i++) out[i] = value(item, depth + 1);
        return out;
      }
      case 10: {
        if (depth >= maxDepth) throw damaged('it is nested too deeply');
        const out = Object.create(null);
        for (;;) {
          const t = take(1, (at) => buf[at]);
          if (t === 0) return out;
          const key = str();
          if (++nodes > maxNodes) throw damaged('it holds too many values');
          out[key] = value(t, depth + 1);
        }
      }
      default: throw damaged(`it has an unknown tag ${type}`);
    }
  };
  if (take(1, (at) => buf[at]) !== 10) throw damaged('it does not start with a compound');
  str();
  const root = value(10, 0);
  if (p !== buf.length) throw damaged('there is data after its end');
  return root;
}

// gzip or plain NBT -> the root compound. The output is bounded before it is held: a small file can inflate to gigabytes.
function readNbt(data, { maxSize = LIMITS.size, ...limits } = {}) {
  if (data[0] !== 0x1f || data[1] !== 0x8b) return Promise.resolve().then(() => parseNbt(data, limits));
  return new Promise((resolve, reject) => {
    zlib.gunzip(data, { maxOutputLength: maxSize }, (err, raw) => {
      if (err) reject(damaged(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'it is too large' : 'its compressed data cannot be read'));
      else { try { resolve(parseNbt(raw, limits)); } catch (e) { reject(e); } }
    });
  });
}

// ---------- SNBT ----------
const BARE_KEY = /[A-Za-z0-9_\-.+]/;
const BARE_VALUE = /[A-Za-z0-9_\-.+:]/; // an unquoted id such as minecraft:stone
const NUMBERS = [
  [/^[-+]?\d+[bB]$/, (s) => parseInt(s, 10)],
  [/^[-+]?\d+[sS]$/, (s) => parseInt(s, 10)],
  [/^[-+]?\d+[lL]$/, (s) => long(BigInt(s.slice(0, -1).replace(/^\+/, '')))],
  [/^[-+]?\d+$/, (s) => parseInt(s, 10)],
  [/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[dDfF]?$/, parseFloat],
  [/^[-+]?(?:Infinity|NaN)[dDfF]?$/, parseFloat],
];

// SNBT text -> the value. Strict about the shape the game prints: one value, nothing after it.
function parseSnbt(text, { maxDepth = LIMITS.depth, maxLength = LIMITS.size, maxNodes = LIMITS.nodes } = {}) {
  if (text.length > maxLength) throw damaged('it is too long');
  let p = 0;
  let nodes = 0;
  const wrong = (what) => damaged(`${what} at character ${p}`);
  const spaces = () => { while (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r') p++; };
  const counted = () => { if (++nodes > maxNodes) throw wrong('too many values'); };
  const quoted = () => {
    const q = text[p++];
    let out = '';
    for (;;) {
      if (p >= text.length) throw wrong('a text does not end');
      const c = text[p++];
      if (c === q) return out;
      if (c !== '\\') { out += c; continue; }
      const e = text[p++];
      const hex = { x: 2, u: 4, U: 8 }[e];
      if (hex) {
        const code = parseInt(text.slice(p, p + hex), 16);
        if (!/^[0-9a-fA-F]+$/.test(text.slice(p, p + hex)) || code > 0x10ffff) throw wrong('a text has a bad escape');
        out += String.fromCodePoint(code);
        p += hex;
      } else out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', s: ' ' }[e] ?? e ?? '';
    }
  };
  const bare = (allowed) => {
    const start = p;
    while (p < text.length && allowed.test(text[p])) p++;
    if (p === start) throw wrong('a value is expected');
    return text.slice(start, p);
  };
  const scalar = () => {
    const word = bare(BARE_VALUE);
    for (const [shape, read] of NUMBERS) if (shape.test(word)) return read(word);
    return word === 'true' ? 1 : word === 'false' ? 0 : word;
  };
  const compound = (depth) => {
    p++;
    const out = Object.create(null);
    spaces();
    if (text[p] === '}') { p++; return out; }
    for (;;) {
      spaces();
      const key = text[p] === '"' || text[p] === "'" ? quoted() : bare(BARE_KEY);
      spaces();
      if (text[p++] !== ':') throw wrong('a colon is expected');
      counted();
      out[key] = value(depth + 1);
      spaces();
      const c = text[p++];
      if (c === '}') return out;
      if (c !== ',') throw wrong('a comma or } is expected');
    }
  };
  const list = (depth) => {
    p++;
    if (/^[BIL];/.test(text.slice(p, p + 2))) p += 2;
    const out = [];
    spaces();
    if (text[p] === ']') { p++; return out; }
    for (;;) {
      counted();
      out.push(value(depth + 1));
      spaces();
      const c = text[p++];
      if (c === ']') return out;
      if (c !== ',') throw wrong('a comma or ] is expected');
    }
  };
  const value = (depth) => {
    spaces();
    const c = text[p];
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) throw wrong('nested too deeply');
      return c === '{' ? compound(depth) : list(depth);
    }
    return c === '"' || c === "'" ? quoted() : scalar();
  };
  const out = value(0);
  spaces();
  if (p !== text.length) throw wrong('there is more after the value');
  return out;
}

// Where SNBT printed on a console ends. Older games print a text's line breaks raw (1.20.1 does, 26.3 escapes them), so
// a page of a book can run over many lines of the console, and those lines are the player's to write. The game breaks a
// line nowhere else, and in a text it escapes \ and the quote that opened it, so a player cannot end a text early: quotes
// alone tell which line breaks are the value's. push() takes the text as it comes and returns the index after the line
// break that ends the value, or -1 when it needs more.
function snbtEnd() {
  let quote = 0;
  let escaped = false;
  return {
    lines: 0,
    push(text, from) {
      for (let i = from; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (!quote) {
          if (c === 10) return i + 1;
          if (c === 34 || c === 39) quote = c;
          continue;
        }
        if (c === 10) this.lines++;
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === quote) quote = 0;
      }
      return -1;
    },
  };
}

// ---------- items and players ----------
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// A display name: JSON text below 1.20.5, a compound from 1.21.5, or a plain string. Only ever shown as text.
function plainName(v, depth = 0) {
  if (depth > 4) return '';
  if (typeof v === 'string') {
    if (depth === 0 && /^[{["]/.test(v)) { try { return plainName(JSON.parse(v), 1); } catch { return v; } }
    return v;
  }
  if (Array.isArray(v)) return v.map((p) => plainName(p, depth + 1)).join('');
  if (!isObject(v)) return '';
  const extra = Array.isArray(v.extra) ? v.extra.map((p) => plainName(p, depth + 1)).join('') : '';
  return `${typeof v.text === 'string' ? v.text : ''}${extra}`;
}
const nameOf = (v) => {
  if (v === undefined) return null;
  const s = plainName(v).replace(/§./gs, '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256);
  return s || null;
};

const enchantList = (list) => (Array.isArray(list) ? list : []).filter((e) => isObject(e) && (typeof e.id === 'string' || typeof e.id === 'number'))
  .map((e) => ({ id: String(e.id), level: num(e.lvl, 1) }));
// {levels: {id: n}} from 1.20.5, {id: n} from 1.21.5.
function enchantMap(v) {
  if (!isObject(v)) return [];
  const levels = isObject(v.levels) ? v.levels : v;
  return Object.entries(levels).filter(([, n]) => typeof n === 'number').map(([id, level]) => ({ id, level }));
}

// An item compound, in either format -> Slot. slot: the game's number, when the compound has none of its own.
function slotOf(item, slot = null) {
  if (!isObject(item) || typeof item.id !== 'string' || item.id === 'minecraft:air') return null;
  const c = isObject(item.components) ? item.components : null;
  const tag = isObject(item.tag) ? item.tag : null;
  return {
    slot: num(item.Slot, slot),
    id: item.id,
    count: num(item.count, num(item.Count, 1)),
    name: nameOf(c ? c['minecraft:custom_name'] ?? c['minecraft:item_name'] : isObject(tag?.display) ? tag.display.Name : undefined),
    enchantments: c ? [...enchantMap(c['minecraft:enchantments']), ...enchantMap(c['minecraft:stored_enchantments'])]
      : [...enchantList(tag?.Enchantments), ...enchantList(tag?.ench), ...enchantList(tag?.StoredEnchantments)],
    damage: num(c ? c['minecraft:damage'] : tag?.Damage ?? item.Damage),
    raw: item,
  };
}

const slotsOf = (list) => (Array.isArray(list) ? list.map((item) => slotOf(item)).filter(Boolean) : []);
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const OLD_DIMENSIONS = { 0: 'minecraft:overworld', [-1]: 'minecraft:the_nether', 1: 'minecraft:the_end' };
// From 1.21.5 armor and the offhand are in `equipment`, not in Inventory.
const EQUIPMENT = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };

function posOf(root) {
  const p = root.Pos;
  if (!Array.isArray(p) || p.length !== 3 || p.some((v) => typeof v !== 'number')) return null;
  const dim = root.Dimension;
  return { x: p[0], y: p[1], z: p[2], dimension: typeof dim === 'string' ? dim : OLD_DIMENSIONS[num(dim)] ?? null };
}

// An entity or playerdata root -> Detail, without the stats and advancements, which come from their own files.
function detailOf(root, { source = 'file' } = {}) {
  if (!isObject(root)) throw damaged('it is not a player');
  const all = slotsOf(root.Inventory);
  if (isObject(root.equipment)) {
    for (const [key, slot] of Object.entries(EQUIPMENT)) {
      const s = slotOf(root.equipment[key], slot);
      if (s) { s.slot = slot; all.push(s); }
    }
  }
  return {
    source,
    health: num(root.Health),
    food: num(root.foodLevel),
    xpLevel: num(root.XpLevel),
    gamemode: GAMEMODES[num(root.playerGameType)] ?? null,
    pos: posOf(root),
    inventory: all.filter((s) => s.slot >= 0 && s.slot <= 35),
    armor: all.filter((s) => s.slot >= 100 && s.slot <= 103),
    offhand: all.find((s) => s.slot === -106) ?? null,
    ender: slotsOf(root.EnderItems),
    selected: num(root.SelectedItemSlot, 0),
    stats: { playTimeTicks: 0, deaths: 0, mobKills: 0, jumps: 0 },
    advancements: 0,
  };
}

module.exports = { parseNbt, readNbt, parseSnbt, snbtEnd, slotOf, detailOf, posOf };
