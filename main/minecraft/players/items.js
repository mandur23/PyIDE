// The item catalog of a server: ids, English and Korean names and icons. The server jar has no textures, so the game's
// items come from the client jar and asset index of the server's version, downloaded from Mojang with their sha1 checked,
// and mod items from the jars in mods/. What a jar gives is reduced to one JSON file in a cache shared by this PC's servers
// (<cache>/<version>/items.json, <cache>/mods/<key>.json), and the jar is not kept. Nothing is written under a name that
// came from a jar. catalog() and icons() never throw: what went wrong is a reason next to the list.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { base, standIn, getJson, getText, HEADERS } = require('../sources');
const { openZip } = require('../zipfile');
const { installRoot } = require('../../installer/toolchains');

const FORMAT = 2;
const MAX_RESULTS = 200;
const RETRY_AFTER = 60000;
const LIMITS = {
  clientJar: 256 * 1024 * 1024, assetIndex: 32 * 1024 * 1024, lang: 16 * 1024 * 1024,
  jars: 512, jar: 256 * 1024 * 1024, entries: 50000, namespaces: 256, read: 64 * 1024 * 1024, itemsPerJar: 5000,
  model: 1024 * 1024, png: 512 * 1024, icon: 64 * 1024, pixels: 1024, frames: 16 * 1024 * 1024, modelDepth: 16, text: 120,
};
// 26.3's, for when no language file can be had. A server of another version may have more or fewer of them.
const KNOWN = {
  enchantment: ['aqua_affinity', 'bane_of_arthropods', 'binding_curse', 'blast_protection', 'breach', 'channeling', 'density', 'depth_strider', 'efficiency', 'feather_falling',
    'fire_aspect', 'fire_protection', 'flame', 'fortune', 'frost_walker', 'impaling', 'infinity', 'knockback', 'looting', 'loyalty', 'luck_of_the_sea', 'lunge', 'lure', 'mending',
    'multishot', 'piercing', 'power', 'projectile_protection', 'protection', 'punch', 'quick_charge', 'respiration', 'riptide', 'sharpness', 'silk_touch', 'smite', 'soul_speed',
    'sweeping_edge', 'swift_sneak', 'thorns', 'unbreaking', 'vanishing_curse', 'wind_burst'],
  effect: ['absorption', 'bad_omen', 'blindness', 'breath_of_the_nautilus', 'conduit_power', 'darkness', 'dolphins_grace', 'fire_resistance', 'glowing', 'haste', 'health_boost',
    'hero_of_the_village', 'hunger', 'infested', 'instant_damage', 'instant_health', 'invisibility', 'jump_boost', 'levitation', 'luck', 'mining_fatigue', 'nausea', 'night_vision',
    'oozing', 'poison', 'raid_omen', 'regeneration', 'resistance', 'saturation', 'slow_falling', 'slowness', 'speed', 'strength', 'trial_omen', 'unluck', 'water_breathing',
    'weakness', 'weaving', 'wind_charged', 'wither'],
};
const ASSETS = 'https://resources.download.minecraft.net';
const RELEASE = /^\d+(\.\d+)+$/;
const PLAIN = /[a-z0-9_][a-z0-9_.-]*/;
const DEFINITION = new RegExp(`^assets/(${PLAIN.source})/items/(${PLAIN.source})\\.json$`);
const ITEM_MODEL = new RegExp(`^assets/(${PLAIN.source})/models/item/(${PLAIN.source})\\.json$`);
const LANG_FILE = new RegExp(`^assets/(${PLAIN.source})/lang/en_us\\.json$`);
const LOCATION = /^(?:([a-z0-9_][a-z0-9_.-]*):)?([a-z0-9_./-]+)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fail = (code, message, more) => Object.assign(new Error(message), { expected: true, code, ...more });
const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');
const defaultCacheDir = () => path.join(installRoot(), 'minecraft-items');
const breathe = () => new Promise((r) => { setImmediate(r); });
const label = (value) => (typeof value === 'string' ? value.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim().slice(0, LIMITS.text) : null);

// ------------------------------------------------------------ download

const fromMojang = (u) => {
  try {
    const url = new URL(u);
    return (url.protocol === 'https:' && /(^|\.)mojang\.com$/.test(url.hostname)) || standIn(url.href);
  } catch { return false; }
};
async function fetchOnce(url, { hash, size, max }) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw fail('download', `${url}: HTTP ${res.status}`, { transient: res.status === 429 || res.status >= 500 });
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (got > max) throw fail('download', `${url} is larger than expected`);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  if ((size && data.length !== size) || sha1(data) !== hash) throw fail('download', `Checksum mismatch for ${url}`);
  return data;
}
// A large download from Mojang has broken off mid-file before, so it is tried again. A wrong checksum or a 4xx is an answer.
async function fetchChecked(url, want) {
  for (let attempt = 1; ; attempt++) {
    try { return await fetchOnce(url, want); } catch (err) {
      const again = err.name !== 'TimeoutError' && (!err.expected || err.transient);
      if (attempt === 3 || !again) throw err.expected ? err : fail('download', `${url}: ${err.cause?.message || err.message}`);
      await new Promise((r) => { setTimeout(r, 500 * attempt); });
    }
  }
}
// The chain of checks starts at the version list, which names the sha1 of each version's file.
async function versionFile(version) {
  const entry = (await getJson(base().mojang)).versions?.find((v) => v.id === version);
  if (!entry) throw fail('version', `Minecraft ${version} is not in Mojang's version list`);
  if (!fromMojang(entry.url)) throw fail('download', `Mojang's version list points outside Mojang for ${version}`);
  const text = await getText(entry.url);
  if (sha1(text) !== entry.sha1) throw fail('download', `Checksum mismatch for the version file of ${version}`);
  return JSON.parse(text);
}
async function koreanNames(meta) {
  const { url, sha1: hash, size } = meta.assetIndex || {};
  if (!fromMojang(url) || !/^[0-9a-f]{40}$/.test(hash || '')) throw fail('korean', 'The version file names no usable asset index');
  const index = JSON.parse((await fetchChecked(url, { hash, size, max: LIMITS.assetIndex })).toString('utf8'));
  const object = index.objects?.['minecraft/lang/ko_kr.json'];
  if (!object) return new Map();
  if (!/^[0-9a-f]{40}$/.test(object.hash || '')) throw fail('korean', 'The asset index names no usable Korean language file');
  const data = await fetchChecked(`${(base().mojangAssets || ASSETS).replace(/\/+$/, '')}/${object.hash.slice(0, 2)}/${object.hash}`, { hash: object.hash, size: object.size, max: LIMITS.lang });
  return langMap(data);
}

// ------------------------------------------------------------ reading a jar

// A jar with a budget: an entry is read only if what it declares fits, and read() stops inflating at what it declares.
function budgeted(zip, total) {
  let left = total;
  const names = new Set(zip.names);
  return {
    has: (name) => names.has(name),
    read(name, max) {
      const size = zip.size(name);
      if (!names.has(name) || size > max || size > left) return null;
      left -= size;
      try { return zip.read(name); } catch { return null; }
    },
    json(name, max) {
      const data = this.read(name, max);
      if (!data) return null;
      try { return JSON.parse(data.toString('utf8')); } catch { return null; }
    },
  };
}
function langMap(data) {
  let parsed = null;
  try { parsed = JSON.parse(data.toString('utf8')); } catch {}
  return new Map(parsed && typeof parsed === 'object' ? Object.entries(parsed).filter(([, v]) => typeof v === 'string') : []);
}
const location = (ref, ns) => {
  const m = typeof ref === 'string' ? ref.match(LOCATION) : null;
  return m && !m[2].split('/').some((p) => p === '..' || p === '.') ? { ns: m[1] || ns, path: m[2] } : null;
};
// An item definition (1.21.4 and later) is a tree of models that picks one by the item's state, and any branch of it
// shows the item. The plain state comes first: a fallback or the false side.
function definedModel(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > LIMITS.modelDepth) return null;
  if (typeof node.model === 'string') return node.model;
  if (typeof node.base === 'string') return node.base;
  const next = [node.fallback, node.on_false, node.on_true, ...[].concat(node.models || []), ...[].concat(node.cases || []), ...[].concat(node.entries || []), node.model];
  for (const n of next) {
    const found = definedModel(n, depth + 1);
    if (found) return found;
  }
  return null;
}
// The textures of a model and its parents, a child's naming winning. A parent loop ends at the depth limit.
function modelTextures(jar, start) {
  const textures = new Map();
  let at = start;
  for (let depth = 0; at && depth < LIMITS.modelDepth; depth++) {
    const model = jar.json(`assets/${at.ns}/models/${at.path}.json`, LIMITS.model);
    if (!model) break;
    for (const [key, value] of Object.entries(model.textures || {})) {
      if (typeof value === 'string' && !textures.has(key)) textures.set(key, value);
    }
    at = location(model.parent, at.ns);
  }
  return textures;
}
// One face stands for a block. A layered item shows its base layer, without the tint the game gives it, except where
// the base is only an overlay for the liquid (a potion).
function chosenTexture(textures) {
  const layer0 = textures.get('layer0');
  if (layer0 && /_overlay$/.test(layer0) && textures.has('layer1')) return 'layer1';
  return ['layer0', 'all', 'side', 'front', 'top', 'end', 'texture', 'particle'].find((k) => textures.has(k)) || textures.keys().next().value;
}
function texturePath(textures, ns) {
  let ref = textures.get(chosenTexture(textures));
  for (let i = 0; i < LIMITS.modelDepth && typeof ref === 'string' && ref.startsWith('#'); i++) ref = textures.get(ref.slice(1));
  return location(ref, ns);
}
function iconOf(jar, ns, id) {
  const definition = jar.json(`assets/${ns}/items/${id}.json`, LIMITS.model);
  const start = location(definedModel(definition?.model), ns) || { ns, path: `item/${id}` };
  const texture = texturePath(modelTextures(jar, start), ns);
  const tries = [texture, { ns, path: `item/${id}` }, { ns, path: `block/${id}` }].filter(Boolean);
  for (const t of tries) {
    const png = jar.read(`assets/${t.ns}/textures/${t.path}.png`, LIMITS.png);
    const icon = png && dataUrl(png);
    if (icon) return icon;
  }
  return null;
}
function pngChunks(png) {
  const chunks = [];
  for (let at = 8; at + 12 <= png.length;) {
    const size = png.readUInt32BE(at);
    if (at + 12 + size > png.length) return null;
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + size) });
    at += 12 + size;
  }
  return chunks;
}
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(head.subarray(4))), 0);
  return Buffer.concat([head, data, crc]);
}
// An animated texture is a strip of square frames, top to bottom. PNG filters look only at the row above, so the first
// frame's rows still decode once the rest are cut off.
function firstFrame(chunks, width, height, depth, color) {
  const stride = Math.ceil((width * CHANNELS[color] * depth) / 8) + 1;
  if (stride * height > LIMITS.frames) return null;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)), { maxOutputLength: stride * height });
  if (raw.length < stride * width) return null;
  const ihdr = Buffer.from(chunks[0].data);
  ihdr.writeUInt32BE(width, 4);
  const before = chunks.slice(1).filter((c) => c.type === 'PLTE' || c.type === 'tRNS').map((c) => chunk(c.type, c.data));
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), ...before, chunk('IDAT', zlib.deflateSync(raw.subarray(0, stride * width))), chunk('IEND', Buffer.alloc(0))]);
}
function dataUrl(png) {
  try {
    if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    const chunks = pngChunks(png);
    if (!chunks || chunks[0]?.type !== 'IHDR' || chunks[0].data.length !== 13) return null;
    const head = chunks[0].data;
    const [width, height, depth, color, interlace] = [head.readUInt32BE(0), head.readUInt32BE(4), head[8], head[9], head[12]];
    if (!width || !height || width > LIMITS.pixels || !CHANNELS[color]) return null;
    if (height > width && (height % width || interlace)) return null;
    const out = height > width ? firstFrame(chunks, width, height, depth, color) : png;
    return !out || out.length > LIMITS.icon ? null : `data:image/png;base64,${out.toString('base64')}`;
  } catch { return null; }
}
const langName = (lang, ns, id) => label(lang.get(`item.${ns}.${id}`) ?? lang.get(`block.${ns}.${id}`)) || null;
// A jar's namespaces, each with what it defines, from one pass over its entries: one pass per namespace would be
// quadratic in a jar made to be. ns -> {defined: [id], models: [id]}
function namespaces(entries) {
  const spaces = new Map();
  const space = (ns) => {
    if (!spaces.has(ns)) spaces.set(ns, { defined: [], models: [] });
    return spaces.get(ns);
  };
  for (const entry of entries) {
    let m = entry.match(DEFINITION);
    if (m) { space(m[1]).defined.push(m[2]); continue; }
    m = entry.match(ITEM_MODEL);
    if (m) { space(m[1]).models.push(m[2]); continue; }
    m = entry.match(LANG_FILE);
    if (m) space(m[1]);
  }
  return spaces;
}
// The items of one namespace. An item definition is one item (1.21.4 and later). Below that, models/item also holds
// templates and animation frames, so a model counts only if the language file names an item or block after it.
function idsOf({ defined, models }, ns, lang) {
  const ids = new Set(defined);
  for (const id of models) if (langName(lang, ns, id)) ids.add(id);
  ids.delete('air');
  return [...ids].sort();
}
async function itemsOf(space, jar, ns, { lang, ko, mod }) {
  const items = [];
  for (const id of idsOf(space, ns, lang).slice(0, LIMITS.itemsPerJar)) {
    items.push({ id: `${ns}:${id}`, name: langName(lang, ns, id) || `${ns}:${id}`, ko: ko ? langName(ko, ns, id) : null, icon: iconOf(jar, ns, id), mod });
    if (items.length % 100 === 0) await breathe();
  }
  return items;
}
const idName = (id) => id.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
const named = (id, en) => ({ id: `minecraft:${id}`, name: en || idName(id), ko: null });
// A key the language file keeps after its id was renamed. 26.3 has both under one name, and the game knows only the new id.
const RENAMED = { 'enchantment.minecraft.sweeping': 'enchantment.minecraft.sweeping_edge' };
// What the language file calls `kind`: enchantment or effect. The file has other keys under those words (effect.duration),
// and a dotted key is a description.
function namesOf(lang, kind) {
  const head = `${kind}.minecraft.`;
  return [...lang.keys()].filter((key) => key.startsWith(head) && /^[a-z0-9_]+$/.test(key.slice(head.length)) && !lang.has(RENAMED[key])).sort()
    .map((key) => named(key.slice(head.length), label(lang.get(key))));
}
const withKorean = (list, kind, ko) => list.map((entry) => ({ ...entry, ko: label(ko.get(`${kind}.${entry.id.replace(':', '.')}`)) || null }));

// ------------------------------------------------------------ the cache

const memory = new Map(); // cache file -> what it holds
const waiting = new Map(); // cache file -> the download under way
const failures = new Map(); // cache file -> {until, err}: asked again after a while, not on every key press

function readCache(file) {
  if (memory.has(file)) return memory.get(file);
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (held?.format !== FORMAT || !Array.isArray(held.items)) return null;
    memory.set(file, held);
    return held;
  } catch { return null; }
}
function writeCache(file, held) {
  memory.set(file, held);
  // Unsaved, the list still serves this session.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
    fs.writeFileSync(part, JSON.stringify(held));
    fs.renameSync(part, file);
  } catch {}
}
async function clientItems(meta, folder) {
  const client = meta.downloads?.client;
  if (!fromMojang(client?.url) || !/^[0-9a-f]{40}$/.test(client?.sha1 || '')) throw fail('download', 'The version file names no usable client jar');
  const data = await fetchChecked(client.url, { hash: client.sha1, size: client.size, max: LIMITS.clientJar });
  fs.mkdirSync(folder, { recursive: true });
  const part = path.join(folder, `client.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`);
  fs.writeFileSync(part, data);
  let zip = null;
  try {
    zip = openZip(part);
    const jar = budgeted(zip, LIMITS.clientJar);
    const data = jar.read('assets/minecraft/lang/en_us.json', LIMITS.lang);
    if (!data) throw fail('download', 'The client jar has no English names');
    const lang = langMap(data);
    const space = namespaces(zip.names).get('minecraft') ?? { defined: [], models: [] };
    const items = await itemsOf(space, jar, 'minecraft', { lang, ko: null, mod: null });
    return { items, enchantments: namesOf(lang, 'enchantment'), effects: namesOf(lang, 'effect') };
  } finally {
    zip?.close();
    fs.rmSync(part, { force: true });
  }
}
async function buildVanilla(file, version) {
  const had = readCache(file);
  const meta = await versionFile(version);
  const held = had || { format: FORMAT, version, ...await clientItems(meta, path.dirname(file)) };
  try {
    const ko = await koreanNames(meta);
    held.items = held.items.map((item) => ({ ...item, ko: langName(ko, 'minecraft', item.id.slice('minecraft:'.length)) }));
    held.enchantments = withKorean(held.enchantments, 'enchantment', ko);
    held.effects = withKorean(held.effects, 'effect', ko);
    delete held.noKorean;
  } catch (err) {
    held.noKorean = err.message;
  }
  writeCache(file, held);
  return held;
}
async function vanilla(root, version) {
  if (typeof version !== 'string' || !RELEASE.test(version)) throw fail('version', 'This server has no Minecraft version Nano Studio can look up');
  const [major, minor] = version.split('.').map(Number);
  if (major === 1 && minor < 13) throw fail('version', `Item names of Minecraft ${version} are not supported: they need 1.13 or newer`);
  const file = path.join(root, version, 'items.json');
  const held = readCache(file);
  if (held && !held.noKorean) return held;
  const failed = failures.get(file);
  if (failed && Date.now() < failed.until) {
    if (held) return held;
    throw failed.err;
  }
  if (!waiting.has(file)) {
    waiting.set(file, buildVanilla(file, version).finally(() => waiting.delete(file)));
  }
  try {
    const built = await waiting.get(file);
    if (built.noKorean) failures.set(file, { until: Date.now() + RETRY_AFTER, err: fail('korean', built.noKorean) });
    else failures.delete(file);
    return built;
  } catch (err) {
    const known = err.expected ? err : fail('download', err.message);
    failures.set(file, { until: Date.now() + RETRY_AFTER, err: known });
    if (held) return held;
    throw known;
  }
}

// mods: an array of jars, a folder, or nothing for dir/mods.
function modJars({ dir, mods }) {
  if (Array.isArray(mods)) return mods.filter((m) => typeof m === 'string' && m.toLowerCase().endsWith('.jar'));
  const folder = typeof mods === 'string' ? mods : dir && path.join(dir, 'mods');
  if (!folder) return [];
  try {
    return fs.readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.jar')).sort().map((n) => path.join(folder, n));
  } catch { return []; }
}
async function readModJar(file) {
  const zip = openZip(file);
  try {
    if (zip.names.length > LIMITS.entries) return { items: [], skipped: `${path.basename(file)} holds too many files` };
    const jar = budgeted(zip, LIMITS.read);
    const items = [];
    const spaces = namespaces(zip.names);
    // A mod's own files under minecraft/ describe the game's items, and a mod does not get to rename those.
    spaces.delete('minecraft');
    for (const [ns, space] of [...spaces].slice(0, LIMITS.namespaces)) {
      await breathe();
      const en = jar.read(`assets/${ns}/lang/en_us.json`, LIMITS.lang);
      const ko = jar.read(`assets/${ns}/lang/ko_kr.json`, LIMITS.lang);
      const found = await itemsOf(space, jar, ns, { lang: en ? langMap(en) : new Map(), ko: ko ? langMap(ko) : new Map(), mod: ns });
      items.push(...found.slice(0, LIMITS.itemsPerJar - items.length));
    }
    return spaces.size > LIMITS.namespaces ? { items, skipped: `Only the first ${LIMITS.namespaces} of the ${spaces.size} namespaces of ${path.basename(file)} were read` } : { items };
  } finally { zip.close(); }
}
async function modItems(root, jars) {
  const items = [];
  const skipped = [];
  for (const jar of jars.slice(0, LIMITS.jars)) {
    try {
      const stat = fs.lstatSync(jar);
      if (!stat.isFile()) continue;
      if (stat.size > LIMITS.jar) { skipped.push(`${path.basename(jar)} is too large to read`); continue; }
      const file = path.join(root, 'mods', `${sha1(`${path.basename(jar)}|${stat.size}|${stat.mtimeMs}`)}.json`);
      let held = readCache(file);
      if (!held) {
        held = { format: FORMAT, ...await readModJar(jar) };
        writeCache(file, held);
        await breathe();
      }
      items.push(...held.items);
      if (held.skipped) skipped.push(held.skipped);
    } catch (err) {
      skipped.push(`${path.basename(jar)}: ${err.message}`);
    }
  }
  if (jars.length > LIMITS.jars) skipped.push(`Only the first ${LIMITS.jars} jars were read`);
  return { items, skipped };
}

// ------------------------------------------------------------ the catalog

async function load(opts) {
  const root = opts?.cacheDir || defaultCacheDir();
  const list = new Map();
  let reason = null;
  let reasonCode = null;
  try {
    const held = await vanilla(root, opts?.version);
    for (const item of held.items) list.set(item.id, item);
    if (held.noKorean) { reason = `No Korean names: ${held.noKorean}`; reasonCode = 'korean'; }
  } catch (err) {
    reason = err.message;
    reasonCode = err.code === 'version' ? 'version' : 'download';
  }
  const skipped = [];
  try {
    const mods = await modItems(root, modJars(opts || {}));
    for (const item of mods.items) if (!list.has(item.id)) list.set(item.id, item);
    skipped.push(...mods.skipped);
  } catch (err) {
    skipped.push(err.message);
  }
  const items = [...list.values()];
  const icons = items.filter((i) => i.icon).length;
  return { items, reason, reasonCode, skipped, coverage: { items: items.length, icons, blank: items.length - icons } };
}
function rank(item, q) {
  const id = item.id.toLowerCase();
  const name = item.name.toLowerCase();
  const ko = item.ko || '';
  if (id === q || id.endsWith(`:${q}`) || name === q || ko === q) return 0;
  if (id.includes(`:${q}`) || name.startsWith(q) || ko.startsWith(q)) return 1;
  return id.includes(q) || name.includes(q) || ko.includes(q) ? 2 : -1;
}
function search(items, query) {
  const q = (typeof query === 'string' ? query : '').trim().normalize('NFC').toLowerCase().slice(0, 64);
  if (!q) return items.slice(0, MAX_RESULTS);
  const ranked = [[], [], []];
  for (const item of items) {
    const r = rank(item, q);
    if (r >= 0) ranked[r].push(item);
  }
  return ranked.flat().slice(0, MAX_RESULTS);
}

// {dir, version, mods, cacheDir}, query -> [Item], at most MAX_RESULTS. The list also carries reason, reasonCode and
// skipped (why it is short, as English text and a code) and coverage {items, icons, blank} of the whole catalog.
async function catalog(opts, query) {
  try {
    const { items, reason, reasonCode, skipped, coverage } = await load(opts);
    return Object.assign(search(items, query), { reason, reasonCode, skipped, coverage });
  } catch (err) {
    return Object.assign([], { reason: err.message, reasonCode: 'error', skipped: [], coverage: { items: 0, icons: 0, blank: 0 } });
  }
}
// ids -> {id: Item}, for what an inventory shows. An id the catalog lacks is left out.
async function icons(opts, ids) {
  try {
    const { items } = await load(opts);
    const wanted = new Set([].concat(ids || []).filter((id) => typeof id === 'string').slice(0, 512).map((id) => (id.includes(':') ? id : `minecraft:${id}`)));
    return Object.fromEntries(items.filter((item) => wanted.has(item.id)).map((item) => [item.id, item]));
  } catch { return {}; }
}
async function icon(opts, id) {
  return Object.values(await icons(opts, [id]))[0]?.icon ?? null;
}
// -> {enchantments: [{id, name, ko}], effects: [{id, name, ko}], reason?, reasonCode?}. Never empty for want of a language
// file: the ids known here, named after themselves, keep the owner's lists usable offline.
async function names(opts) {
  try {
    const held = await vanilla(opts?.cacheDir || defaultCacheDir(), opts?.version);
    return { enchantments: held.enchantments, effects: held.effects, ...(held.noKorean && { reason: `No Korean names: ${held.noKorean}`, reasonCode: 'korean' }) };
  } catch (err) {
    return { enchantments: KNOWN.enchantment.map((id) => named(id)), effects: KNOWN.effect.map((id) => named(id)), reason: err.message, reasonCode: err.code === 'version' ? 'version' : 'download' };
  }
}
// Forgets what this process remembers, so the next call reads the cache and asks the network again.
function reset() {
  memory.clear();
  failures.clear();
}

module.exports = { catalog, icons, icon, names, reset, defaultCacheDir, MAX_RESULTS };
