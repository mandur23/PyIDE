// The mods (or plugins) in a server's folder: what each jar says it is, turning one off and on, and what the jars say
// about each other. Everything comes from the jars' own metadata, read without running anything:
//   Fabric and Quilt    fabric.mod.json / quilt.mod.json (id, version, depends, breaks, conflicts, environment, jars)
//   Forge and NeoForge  META-INF/mods.toml / neoforge.mods.toml ([[mods]], [[dependencies.<id>]]), jars under META-INF/jarjar
//   Paper and Velocity  plugin.yml / paper-plugin.yml (depend), velocity-plugin.json (dependencies)
//
//   describe(file) -> {loaders, mods: [{id, name, version, depends, env}], provides: [{id, version}], error}
//   check(items, server) -> problems     pure: the list of describe()d jars and {kind, mc, java, loader, loaderVersion}
//   createMods({readServer, writeServer, running, kinds}) -> { list(dir), toggle(dir, file, on) }
//
// A mod is turned off by renaming its jar to <name>.jar.disabled, which no loader reads, and on by renaming it back;
// the Market's record of the file follows it, so the Market still knows the project and can remove it.
// The checks say only what the metadata says: a version or a range this file cannot read counts as satisfied, since a
// false alarm about a mod that works is worse than a missed one (the server's own log names those when it starts).
const fs = require('fs');
const path = require('path');
const { openZip, openZipBuffer } = require('./zipfile');

const fail = (message, code) => Object.assign(new Error(message), { expected: true, code });
const OFF = '.disabled';
const NESTED_LIMIT = 16 * 1024 * 1024;
const NESTED_COUNT = 200;
const META_LIMIT = 1024 * 1024;
// What every server of the kind has without a jar in mods/.
const BUILT_IN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mixinextras']);

// ---------- versions ----------
// "1.20.1", "0.92.2+1.20.1", "2.0.0-beta.3" -> {nums, pre}; null for anything that is not numbers and dots.
function parseVersion(text) {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(Number), pre: m[2] ? m[2].split('.') : null };
}
function compare(a, b) {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] || 0) - (b.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) { if (nx !== ny) return nx < ny ? -1 : 1; } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
// Fabric's predicates: "*", ">=1.2", "<2", "^1.2.3", "~1.2.3", "1.20.x", "=1.2.3", "1.2.3"; a space joins with and, a
// list with or. -> true, false, or null when it cannot be read.
function fabricTerm(have, term) {
  const t = term.trim();
  if (!t || t === '*') return true;
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(t);
  const op = m[1] || '=';
  const wild = /^(\d+(?:\.\d+)*)\.[xX*]$/.exec(m[2]);
  if (wild) {
    const base = wild[1].split('.').map(Number);
    return base.every((n, i) => (have.nums[i] || 0) === n);
  }
  const want = parseVersion(m[2]);
  if (!want) return null;
  const c = compare(have, want);
  if (op === '>=') return c >= 0;
  if (op === '>') return c > 0;
  if (op === '<=') return c <= 0;
  if (op === '<') return c < 0;
  if (op === '=') return c === 0;
  const upper = { nums: op === '^' ? [want.nums[0] + 1] : [want.nums[0], (want.nums[1] || 0) + 1], pre: null };
  return c >= 0 && compare({ nums: have.nums, pre: null }, upper) < 0;
}
function fabricMatches(version, range) {
  const have = parseVersion(version);
  if (!have) return null;
  const any = (Array.isArray(range) ? range : [range]).filter((r) => typeof r === 'string');
  if (!any.length) return true;
  let unknown = false;
  for (const r of any) {
    const terms = r.trim().split(/\s+/).map((t) => fabricTerm(have, t));
    if (terms.includes(null)) unknown = true; else if (terms.every(Boolean)) return true;
  }
  return unknown ? null : false;
}
// Maven's ranges, as Forge writes them: "[1.2,)", "[1.0,2.0)", "(,1.5]", "[1.2.3]", "1.2" (that or later), "*", and
// several joined by commas.
function mavenMatches(version, range) {
  const have = parseVersion(version);
  const text = String(range ?? '').trim();
  if (!text || text === '*') return true;
  if (!have) return null;
  const parts = text.match(/[[(][^\])]*[\])]|[^,[\]()]+/g) || [];
  let unknown = false;
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = /^([[(])\s*([^,\])]*)\s*(?:(,)\s*([^\])]*))?\s*([\])])$/.exec(p);
    if (!m) {
      const want = parseVersion(p);
      if (!want) unknown = true; else if (compare(have, want) >= 0) return true;
      continue;
    }
    const lo = m[2].trim() ? parseVersion(m[2]) : undefined;
    const hi = m[3] ? (m[4].trim() ? parseVersion(m[4]) : undefined) : lo;
    if (lo === null || hi === null) { unknown = true; continue; }
    const above = lo === undefined || (m[1] === '[' ? compare(have, lo) >= 0 : compare(have, lo) > 0);
    const below = hi === undefined || (m[5] === ']' ? compare(have, hi) <= 0 : compare(have, hi) < 0);
    if (above && below) return true;
  }
  return unknown ? null : false;
}

// ---------- the small subsets of TOML and YAML these files use ----------
// -> [{table: 'mods' | 'dependencies.<id>' | '', values}] in order; multi-line strings (descriptions) are passed over.
function parseToml(text) {
  const tables = [{ table: '', values: {} }];
  let cur = tables[0];
  let skip = null;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (skip) { if (raw.includes(skip)) skip = null; continue; }
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (head) { cur = { table: head[1].replace(/["']/g, '').replace(/\s*\.\s*/g, '.'), values: {} }; tables.push(cur); continue; }
    const kv = /^([\w.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    const v = kv[2].trim();
    const multi = /^('''|""")/.exec(v);
    if (multi) { if (!v.slice(3).includes(multi[1])) skip = multi[1]; continue; }
    const str = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(v);
    if (str) cur.values[key] = str[1] !== undefined ? str[1].replace(/\\(.)/g, '$1') : str[2];
    else if (/^(true|false)\b/.test(v)) cur.values[key] = v.startsWith('true');
    else cur.values[key] = v.replace(/\s+#.*$/, '');
  }
  return tables;
}
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
const inlineList = (s) => s.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
// plugin.yml's top level: scalars and lists (inline or one "- item" a line). -> {key: string | string[]}
function parseYamlTop(text) {
  const out = {};
  let list = null;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && list) { list.push(unquote(item[1].replace(/\s+#.*$/, ''))); continue; }
    const top = /^([\w-]+):\s*(.*)$/.exec(raw);
    if (!top) { if (!/^\s/.test(raw)) list = null; continue; }
    const v = top[2].replace(/\s+#.*$/, '').trim();
    if (!v) { list = []; out[top[1]] = list; } else { list = null; out[top[1]] = v.startsWith('[') ? inlineList(v) : unquote(v); }
  }
  return out;
}
// paper-plugin.yml's dependencies: server: <Name>: {required: false}. -> [{id, required}]
function paperDependencies(text) {
  const out = [];
  let depth = 0; // 1 inside dependencies, 2 inside server
  let indent = [0, 0, 0];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const at = raw.length - raw.trimStart().length;
    const m = /^\s*([\w.-]+|"[^"]+"|'[^']+'):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = unquote(m[1]);
    if (at === 0) { depth = key === 'dependencies' ? 1 : 0; cur = null; continue; }
    if (!depth) continue;
    if (depth >= 1 && (depth === 1 || at <= indent[1])) { depth = key === 'server' ? 2 : 1; indent[1] = at; cur = null; if (depth === 2) indent[2] = -1; continue; }
    if (indent[2] === -1 || at === indent[2]) { indent[2] = at; cur = { id: key, required: true }; out.push(cur); continue; }
    if (cur && key === 'required') cur.required = !/^false\b/.test(m[2].trim());
  }
  return out;
}

// ---------- what a jar says ----------
const text = (zip, name) => {
  if (!zip.names.includes(name) || zip.size(name) > META_LIMIT) return null;
  try { return zip.read(name)?.toString('utf8') ?? null; } catch { return null; }
};
const json = (s) => {
  if (s === null) return null;
  // Some fabric.mod.json files carry raw line breaks inside their description, which JSON does not allow.
  for (const t of [s, s.replace(/[\r\n\t]+/g, ' ')]) { try { const v = JSON.parse(t.replace(/^﻿/, '')); if (v && typeof v === 'object') return v; } catch {} }
  return null;
};
const depsOf = (map, kind) => Object.entries(map && typeof map === 'object' && !Array.isArray(map) ? map : {}).map(([id, range]) => ({ id: String(id).toLowerCase(), range, kind, syntax: 'fabric' }));
function fabricMod(meta, quilt) {
  if (quilt) {
    const q = meta.quilt_loader || {};
    const dep = (d, kind) => (typeof d === 'string' ? { id: d.toLowerCase(), range: '*', kind, syntax: 'fabric' }
      : d && typeof d.id === 'string' ? { id: d.id.toLowerCase(), range: d.versions ?? '*', kind: d.optional ? 'optional' : kind, syntax: 'fabric' } : null);
    return { id: String(q.id || '').toLowerCase(), name: q.metadata?.name || q.id, version: String(q.version ?? ''), env: meta.minecraft?.environment || '*',
      depends: [...(Array.isArray(q.depends) ? q.depends.map((d) => dep(d, 'required')) : []), ...(Array.isArray(q.breaks) ? q.breaks.map((d) => dep(d, 'breaks')) : [])].filter(Boolean),
      provides: (Array.isArray(q.provides) ? q.provides : []).map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean).map((p) => String(p).toLowerCase()) };
  }
  return { id: String(meta.id || '').toLowerCase(), name: meta.name || meta.id, version: String(meta.version ?? ''), env: meta.environment || '*',
    depends: [...depsOf(meta.depends, 'required'), ...depsOf(meta.breaks, 'breaks'), ...depsOf(meta.conflicts, 'conflicts')],
    provides: (Array.isArray(meta.provides) ? meta.provides : []).map((p) => String(p).toLowerCase()) };
}
function forgeMods(toml, manifestVersion) {
  const tables = parseToml(toml);
  const mods = [];
  for (const t of tables) {
    if (t.table !== 'mods' || typeof t.values.modId !== 'string') continue;
    const v = String(t.values.version ?? '');
    mods.push({ id: t.values.modId.toLowerCase(), name: t.values.displayName || t.values.modId, version: v.includes('${') ? manifestVersion || '' : v, env: '*', depends: [], provides: [] });
  }
  for (const t of tables) {
    const m = /^dependencies\.(.+)$/.exec(t.table);
    const owner = m && mods.find((x) => x.id === m[1].toLowerCase());
    if (!owner || typeof t.values.modId !== 'string') continue;
    // A dependency of the client side alone is not this server's.
    if (String(t.values.side || '').toUpperCase() === 'CLIENT') continue;
    const type = String(t.values.type || '').toLowerCase();
    const kind = type === 'incompatible' ? 'breaks' : type === 'discouraged' ? 'conflicts' : type === 'optional' || t.values.mandatory === false ? 'optional' : 'required';
    owner.depends.push({ id: t.values.modId.toLowerCase(), range: t.values.versionRange ?? '', kind, syntax: 'maven' });
  }
  return mods;
}
function pluginOf(zip) {
  const paper = text(zip, 'paper-plugin.yml');
  const bukkit = text(zip, 'plugin.yml');
  const y = parseYamlTop(paper ?? bukkit ?? '');
  if (typeof y.name !== 'string' || !y.name) return null;
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
  const depends = [...list(y.depend).map((id) => ({ id, required: true })), ...list(y.softdepend).map((id) => ({ id, required: false })), ...(paper ? paperDependencies(paper) : [])];
  return { id: y.name.toLowerCase(), name: y.name, version: String(y.version ?? ''), env: '*', provides: list(y.provides).map((p) => p.toLowerCase()),
    depends: depends.map((d) => ({ id: d.id.toLowerCase(), range: '*', kind: d.required ? 'required' : 'optional', syntax: 'none' })) };
}
function velocityOf(zip) {
  const v = json(text(zip, 'velocity-plugin.json'));
  if (!v || typeof v.id !== 'string') return null;
  return { id: v.id.toLowerCase(), name: v.name || v.id, version: String(v.version ?? ''), env: '*', provides: [],
    depends: (Array.isArray(v.dependencies) ? v.dependencies : []).filter((d) => typeof d?.id === 'string').map((d) => ({ id: d.id.toLowerCase(), range: '*', kind: d.optional ? 'optional' : 'required', syntax: 'none' })) };
}
// The mods of an open jar, and the ids the jars inside it bring along (nested one level after another, to `budget`).
function readZip(zip, budget) {
  const loaders = [];
  const mods = [];
  const provides = [];
  const fabric = json(text(zip, 'fabric.mod.json'));
  const quilt = json(text(zip, 'quilt.mod.json'));
  const manifest = text(zip, 'META-INF/MANIFEST.MF') || '';
  const jarVersion = /^Implementation-Version:\s*(\S+)/m.exec(manifest)?.[1];
  if (fabric && typeof fabric.id === 'string') { loaders.push('fabric'); mods.push(fabricMod(fabric, false)); }
  if (quilt?.quilt_loader?.id) { loaders.push('quilt'); if (!fabric) mods.push(fabricMod(quilt, true)); }
  const neo = text(zip, 'META-INF/neoforge.mods.toml');
  const forge = text(zip, 'META-INF/mods.toml');
  if (neo !== null) loaders.push('neoforge');
  if (forge !== null) loaders.push('forge');
  if (!mods.length && (neo ?? forge) !== null) mods.push(...forgeMods(neo ?? forge, jarVersion));
  if (!mods.length) {
    const plugin = pluginOf(zip);
    if (plugin) { loaders.push('bukkit'); mods.push(plugin); }
    const velocity = velocityOf(zip);
    if (velocity) { loaders.push('velocity'); if (!plugin) mods.push(velocity); }
  }
  const nested = [
    ...(Array.isArray(fabric?.jars) ? fabric.jars.map((j) => j?.file) : []),
    ...(Array.isArray(quilt?.quilt_loader?.jars) ? quilt.quilt_loader.jars : []),
    ...((json(text(zip, 'META-INF/jarjar/metadata.json'))?.jars || []).map((j) => j?.path)),
  ].filter((n) => typeof n === 'string' && zip.names.includes(n));
  for (const name of nested) {
    if (budget.left <= 0 || zip.size(name) > NESTED_LIMIT) continue;
    budget.left--;
    let inner = null;
    try {
      inner = openZipBuffer(zip.read(name), name);
      const r = readZip(inner, budget);
      for (const m of r.mods) { provides.push({ id: m.id, version: m.version }); for (const p of m.provides) provides.push({ id: p, version: m.version }); }
      provides.push(...r.provides);
    } catch {} finally { inner?.close(); }
  }
  return { loaders, mods, provides };
}
function describe(file) {
  let zip = null;
  try {
    zip = openZip(file);
    return readZip(zip, { left: NESTED_COUNT });
  } catch (err) {
    return { loaders: [], mods: [], provides: [], error: err.message };
  } finally { zip?.close(); }
}

// ---------- what the jars say about each other ----------
// items: [{file, enabled, loaders, mods, provides, error}]; server: {kind, mc, java, family: 'fabric' | 'forge' |
// 'neoforge' | 'bukkit' | 'velocity', loaderVersion}. -> [{level: 'error' | 'warn', code, file, mod, ...}]
function check(items, server) {
  const problems = [];
  const on = items.filter((i) => i.enabled);
  const have = new Map(); // id -> [{version, file, name, nested}]
  const put = (map, id, entry) => { if (!map.has(id)) map.set(id, []); map.get(id).push(entry); };
  const fill = (map, list) => {
    for (const i of list) {
      for (const m of i.mods) { put(map, m.id, { version: m.version, file: i.file, name: m.name }); for (const p of m.provides) put(map, p, { version: m.version, file: i.file, name: m.name, nested: true }); }
      for (const p of i.provides) put(map, p.id, { version: p.version, file: i.file, name: p.id, nested: true });
    }
  };
  fill(have, on);
  const off = new Map();
  fill(off, items.filter((i) => !i.enabled));
  const builtIn = { minecraft: server.mc, java: server.java ? String(server.java) : null, fabricloader: server.family === 'fabric' ? server.loaderVersion : null,
    'fabric-loader': server.family === 'fabric' ? server.loaderVersion : null, forge: server.family === 'forge' ? server.loaderVersion : null, neoforge: server.family === 'neoforge' ? server.loaderVersion : null };
  const matches = (version, dep) => (dep.syntax === 'fabric' ? fabricMatches(version, dep.range) : dep.syntax === 'maven' ? mavenMatches(version, dep.range) : true);
  const rangeText = (r) => (Array.isArray(r) ? r.join(' || ') : String(r ?? '')).trim();

  for (const i of on) {
    if (i.error || !i.mods.length) {
      problems.push({ level: 'warn', code: 'unreadable', file: i.file, mod: path.basename(i.file) });
      continue;
    }
    // A jar made for another loader does nothing here or stops the start (a Quilt-only mod on Fabric among them). An
    // older NeoForge reads Forge's mods.toml, so that one passes.
    const fits = { fabric: ['fabric'], forge: ['forge'], neoforge: ['neoforge', 'forge'], bukkit: ['bukkit'], velocity: ['velocity'] }[server.family];
    if (fits && !i.loaders.some((l) => fits.includes(l))) {
      problems.push({ level: 'error', code: 'loader', file: i.file, mod: i.mods[0].name, loaders: i.loaders });
      continue;
    }
    for (const m of i.mods) {
      if (m.env === 'client') problems.push({ level: 'warn', code: 'client', file: i.file, mod: m.name });
      for (const d of m.depends) {
        const fixed = Object.hasOwn(builtIn, d.id) ? builtIn[d.id] : undefined;
        if (d.kind === 'optional') continue;
        if (d.kind === 'breaks' || d.kind === 'conflicts') {
          const there = fixed !== undefined ? (fixed ? [{ version: fixed, name: d.id }] : []) : (have.get(d.id) || []).filter((x) => x.file !== i.file);
          const hit = there.find((x) => matches(x.version, d) === true);
          if (hit) problems.push({ level: d.kind === 'breaks' ? 'error' : 'warn', code: d.kind, file: i.file, mod: m.name, other: hit.name, otherFile: hit.file || null, have: hit.version, range: rangeText(d.range) });
          continue;
        }
        if (fixed !== undefined) {
          if (fixed && matches(fixed, d) === false) problems.push({ level: d.id === 'java' ? 'warn' : 'error', code: d.id === 'minecraft' ? 'minecraft' : d.id === 'java' ? 'java' : 'loaderVersion', file: i.file, mod: m.name, need: d.id, have: fixed, range: rangeText(d.range) });
          continue;
        }
        if (BUILT_IN.has(d.id)) continue;
        const there = have.get(d.id) || [];
        if (!there.length) {
          const asleep = (off.get(d.id) || [])[0];
          if (asleep) problems.push({ level: 'error', code: 'disabled', file: i.file, mod: m.name, need: d.id, other: asleep.name, otherFile: asleep.file, range: rangeText(d.range) });
          else problems.push({ level: 'error', code: 'missing', file: i.file, mod: m.name, need: d.id, range: rangeText(d.range) });
        } else if (there.every((x) => matches(x.version, d) === false)) {
          problems.push({ level: 'error', code: 'version', file: i.file, mod: m.name, need: d.id, other: there[0].name, otherFile: there[0].file, have: there[0].version, range: rangeText(d.range) });
        }
      }
    }
  }
  // The same mod twice: a loader refuses to start with two jars of one id (ids a jar only carries inside are shared).
  for (const [id, list] of have) {
    const own = list.filter((x) => !x.nested);
    // Newest first when the versions can be compared: the window offers to turn off the second, the older one.
    const files = [...new Set(own.map((x) => x.file))].sort((a, b) => {
      const va = parseVersion(own.find((x) => x.file === a).version);
      const vb = parseVersion(own.find((x) => x.file === b).version);
      return va && vb ? compare(vb, va) : 0;
    });
    if (files.length > 1) problems.push({ level: 'error', code: 'duplicate', file: files[0], mod: own[0].name, id, files, versions: files.map((f) => own.find((x) => x.file === f).version) });
  }
  const rank = { error: 0, warn: 1 };
  return problems.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------- a server's folder ----------
function familyOf(kind, kinds) {
  const k = kinds[kind] || {};
  if (k.mods) return { family: /neoforge/.test(k.mods) ? 'neoforge' : /forge/.test(k.mods) ? 'forge' : 'fabric', folder: 'mods' };
  if (k.plugins) return { family: k.plugins === 'velocity' ? 'velocity' : 'bukkit', folder: 'plugins' };
  return null;
}
function createMods({ readServer, writeServer, running = () => false, kinds = {} }) {
  const cache = new Map(); // file -> {stamp, described}
  const read = (file, st) => {
    const stamp = `${st.size}:${st.mtimeMs}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.described;
    const described = describe(file);
    cache.set(file, { stamp, described });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return described;
  };
  // -> {folder, family, items: [{file, name, id, version, enabled, size, market, error}], problems} or {folder: null}
  // for a server that takes neither mods nor plugins.
  function list(dir) {
    const desc = readServer(dir);
    const f = familyOf(desc.kind, kinds);
    if (!f) return { folder: null, family: null, items: [], problems: [] };
    const root = path.join(dir, f.folder);
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile() && /\.jar(\.disabled)?$/i.test(d.name)).map((d) => d.name); } catch {}
    const owned = new Map();
    for (const [pid, rec] of Object.entries(desc.market || {})) for (const rel of Array.isArray(rec?.files) ? rec.files : []) owned.set(String(rel).toLowerCase(), { id: pid, title: rec.title, dependency: !!rec.dependency });
    const full = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      const file = path.join(root, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const rel = `${f.folder}/${name}`;
      full.push({ file: rel, enabled: !name.toLowerCase().endsWith(OFF), size: st.size, market: owned.get(rel.toLowerCase()) || null, ...read(file, st) });
    }
    const loaderVersion = typeof desc.loader === 'string' ? desc.loader : typeof desc.build === 'string' ? desc.build : null;
    const problems = check(full, { kind: desc.kind, mc: desc.mc, java: desc.java, family: f.family, loaderVersion });
    const items = full.map((i) => ({ file: i.file, enabled: i.enabled, size: i.size, market: i.market, error: i.error || null,
      id: i.mods[0]?.id || null, name: i.mods[0]?.name || path.basename(i.file).replace(/\.jar(\.disabled)?$/i, ''), version: i.mods[0]?.version || '', more: Math.max(0, i.mods.length - 1) }));
    return { folder: f.folder, family: f.family, items, problems };
  }
  // Turns the jar at `file` ("mods/<name>") off or on by its name. Java holds the jars of a running server, so that
  // one is stopped first.
  function toggle(dir, file, on) {
    const desc = readServer(dir);
    const f = familyOf(desc.kind, kinds);
    const m = f && new RegExp(`^${f.folder}/([^/\\\\:]+\\.jar)(\\.disabled)?$`, 'i').exec(String(file));
    if (!m || /[. ]$/.test(m[1]) || m[1].startsWith('..')) throw fail('That is not a mod of this server');
    const root = path.join(dir, f.folder);
    const from = path.join(root, m[1] + (m[2] || ''));
    const to = path.join(root, m[1] + (on ? '' : OFF));
    if (path.dirname(path.resolve(from)) !== path.resolve(root) || !fs.existsSync(from)) throw fail(`${m[1]} is not in ${f.folder}/ any more`, 'gone');
    if (path.resolve(from).toLowerCase() !== path.resolve(to).toLowerCase()) {
      if (running(dir)) throw fail(`Stop ${path.basename(dir)} first: while it runs, Java holds its jars, and one cannot be turned ${on ? 'on' : 'off'}`, 'running');
      if (fs.existsSync(to)) throw fail(`${path.basename(to)} is in ${f.folder}/ already`, 'exists');
      fs.renameSync(from, to);
      const was = `${f.folder}/${path.basename(from)}`.toLowerCase();
      const market = desc.market && typeof desc.market === 'object' ? desc.market : null;
      let moved = false;
      const next = market && Object.fromEntries(Object.entries(market).map(([pid, rec]) => {
        if (!Array.isArray(rec?.files) || !rec.files.some((r) => String(r).toLowerCase() === was)) return [pid, rec];
        moved = true;
        return [pid, { ...rec, files: rec.files.map((r) => (String(r).toLowerCase() === was ? `${f.folder}/${path.basename(to)}` : r)) }];
      }));
      if (moved) writeServer(dir, { ...desc, market: next });
    }
    return list(dir);
  }
  return { list, toggle };
}

module.exports = { createMods, describe, check, BUILT_IN, parseVersion, compare, fabricMatches, mavenMatches, parseToml, parseYamlTop, paperDependencies, familyOf };
