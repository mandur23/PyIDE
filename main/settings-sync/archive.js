// File › Manage IDE Settings › Export / Import Settings: the settings archive (a .zip with a pyide-settings.json
// manifest), what goes into it, and applying one. Plain Node (no Electron), so verify/settings-sync.mjs also calls it
// directly. main/features/settings-sync.js owns the dialogs and IPC; the renderer plugin applies the settings.json keys
// (the renderer owns that file, see ide.settings) and the data sources (through the Database plugin when it runs).
//
// What is exported is decided per key and per file below; FEATURES.md (Settings export and import) has the table.
// Nothing secret or machine-bound leaves the computer: data source passwords (safeStorage blobs, readable only on this
// computer) become hasPassword: false, and interpreter paths, trusted projects, update state, per-project state,
// caches, indexes and logs are never read.
const fs = require('fs');
const path = require('path');
const { zip } = require('../diagnostics/zip');
const { SECRET_KEY } = require('../diagnostics/redact');
const unzip = require('./unzip');
const { sameConnection } = require('./same-connection');

const { ZipError } = unzip;
const FORMAT = 1;
const MANIFEST = 'pyide-settings.json';
const SCRATCH_PREFIX = 'scratches/';
const MB = 2 ** 20;
const SCRATCHES_DEFAULT_MAX = 20 * MB; // larger scratch folders are offered unticked
// Limits on what an archive may hold, checked from the central directory before anything is inflated (a ZIP bomb is
// refused before it costs memory or time). Export refuses scratch folders beyond them, so PyIDE never writes an archive
// it would not import.
const LIMITS = {
  archive: 512 * MB, // the .zip file itself
  entries: 5000,
  total: 512 * MB, // everything unpacked
  entry: 64 * MB, // any one entry
  manifest: MB,
  json: 16 * MB, // each category file
  scratchFiles: 1000,
  scratchBytes: 256 * MB,
};

// In dialog order. recentProjects is offered unticked; scratches unticked above SCRATCHES_DEFAULT_MAX.
const CATEGORIES = ['appearance', 'keymap', 'liveTemplates', 'codeStyle', 'plugins', 'dataSources', 'scratches', 'recentProjects'];
const FILES = {
  appearance: 'settings/appearance.json',
  codeStyle: 'settings/code-style.json',
  keymap: 'keymap.json',
  liveTemplates: 'live-templates.json',
  plugins: 'plugins.json',
  dataSources: 'database/sources.json',
  recentProjects: 'recent-projects.json',
};

// ---------- settings.json keys ----------
const OWN_CATEGORY = {
  'keymap.overrides': 'keymap',
  'liveTemplates.custom': 'liveTemplates',
  'liveTemplates.postfixDisabled': 'liveTemplates',
  recentProjects: 'recentProjects',
};
const CODE_STYLE = new Set(['editor.tabSize', 'editor.detectIndent', 'editor.ruler', 'tools.ruffLineLength', 'editor.lineSeparator']);
// Keys of exported groups that stay on this computer, with the reason.
const EXCLUDED = new Map([
  ['interpreters.extra', 'machine'], // python.exe paths on this computer
  ['interpreters.remote', 'machine'], // WSL / SSH / Docker targets of this computer (their secrets live elsewhere)
  ['terminal.shell', 'machine'], // a shell installed here, or a path to one
  ['updates.feedUrl', 'machine'], // where this installation looks for updates (often a local folder)
  ['updates.skippedVersion', 'machine'],
  ['aiComplete.snoozeUntil', 'transient'],
  ['pyconsole.history', 'private'], // commands typed into the Python Console
  ['database.openConsoles', 'state'],
  ['spellcheck.projectWordsEdit', 'state'],
  ['newProject.location', 'path'],
  ['workspace.recent', 'path'],
  ['projectTree.expanded', 'project'],
  ['projectTree.rootsExpanded', 'machine'],
]);
// Groups whose keys are IDE preferences. A key outside them is not exported: a new feature's keys are left out until
// they are classified here.
const PREFERENCE = /^(appearance|editor|tools|autosave|save|terminal|tests|httpClient|viewers|dataView|plots|coverage|searchNav|sidebar|spellcheck|ai|aiComplete|aiEdit|aiChat|semantic|localHistory|diagnostics|database|newProject|updates|workspace|pyconsole|packages|vcs|fileTemplates|clipboardHistory)\./;
const ABS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const holdsPath = (v, depth = 0) => (typeof v === 'string' ? ABS_PATH.test(v)
  : depth < 8 && !!v && typeof v === 'object' && Object.values(v).some((x) => holdsPath(x, depth + 1)));

// -> {category: id | null, reason?}. Per-project keys carry the project path (`interpreter.C:\…`, `runConfigs:…`).
function classify(key, value) {
  if (OWN_CATEGORY[key]) return { category: OWN_CATEGORY[key] };
  if (SECRET_KEY.test(key)) return { category: null, reason: 'secret' };
  if (/[\\/:]/.test(key)) return { category: null, reason: 'project' };
  if (EXCLUDED.has(key)) return { category: null, reason: EXCLUDED.get(key) };
  if (!PREFERENCE.test(key)) return { category: null, reason: 'unclassified' };
  if (holdsPath(value)) return { category: null, reason: 'path' };
  return { category: CODE_STYLE.has(key) ? 'codeStyle' : 'appearance' };
}

// ---------- sanitizing (export and import) ----------
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const okName = (s, max = 200) => typeof s === 'string' && s.length > 0 && s.length <= max && !BAD_KEYS.has(s);
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

function cleanKeymap(v) {
  const out = {};
  if (!plain(v)) return out;
  for (const [id, keys] of Object.entries(v)) {
    if (okName(id) && Array.isArray(keys) && keys.length <= 20 && keys.every((k) => typeof k === 'string' && k.length <= 64)) out[id] = keys;
  }
  return out;
}

function cleanTemplates(v) {
  const custom = {};
  const src = plain(v) && plain(v.custom) ? v.custom : {};
  for (const [abbr, t] of Object.entries(src)) {
    if (!okName(abbr, 64) || !plain(t)) continue;
    const c = {};
    if (typeof t.description === 'string') c.description = t.description.slice(0, 1000);
    if (typeof t.body === 'string') c.body = t.body.slice(0, 100000);
    if (typeof t.enabled === 'boolean') c.enabled = t.enabled;
    custom[abbr] = c;
  }
  const postfix = plain(v) && Array.isArray(v.postfixDisabled) ? v.postfixDisabled.filter((k) => okName(k, 64)) : [];
  return { custom, postfixDisabled: [...new Set(postfix)] };
}

const cleanRecent = (v) => (Array.isArray(v) ? v : [])
  .filter((p) => plain(p) && typeof p.path === 'string' && p.path)
  .map((p) => ({ path: p.path, opened: Number(p.opened) || 0 }))
  .slice(0, 15);

const cleanDisabled = (v) => [...new Set((Array.isArray(v) ? v : []).filter((id) => typeof id === 'string' && PLUGIN_ID.test(id)))];

// A data source without anything secret: the encrypted password, password fields, credentials inside URLs.
const URL_CREDENTIALS = /^([a-z][\w+.-]*:\/\/[^:@/]*):[^@/]*@/i;
function cleanSource(s) {
  if (!plain(s) || !okName(s.id, 100) || typeof s.kind !== 'string') return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (BAD_KEYS.has(k) || ['secret', 'hasPassword', 'state', 'message'].includes(k) || SECRET_KEY.test(k)) continue;
    if (typeof v === 'string') out[k] = v.replace(URL_CREDENTIALS, '$1@');
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

// ---------- reading the current state ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
const settingsFile = (userData) => path.join(userData, 'settings.json');
const pluginStateFile = (userData) => path.join(userData, 'plugin-state.json');
const sourcesFile = (userData) => path.join(userData, 'database', 'sources.json');
const scratchDir = (userData) => path.join(userData, 'scratches');

// Files under the scratches folder (symbolic links and junctions are not followed), as {rel: 'a/b.py', file, size}.
function scratchFiles(userData) {
  const root = scratchDir(userData);
  const out = [];
  const walk = (dir, rel, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory() && depth < 8) walk(path.join(dir, d.name), r, depth + 1);
      else if (d.isFile() && !unsafeName(`${SCRATCH_PREFIX}${r}`)) {
        try { out.push({ rel: r, file: path.join(dir, d.name), size: fs.statSync(path.join(dir, d.name)).size }); } catch {}
      }
    }
  };
  walk(root, '', 0);
  return out;
}

// Everything exportable now, by category.
function snapshot(userData) {
  const settings = readJson(settingsFile(userData), {});
  const s = plain(settings) ? settings : {};
  const appearance = {};
  const codeStyle = {};
  for (const [k, v] of Object.entries(s)) {
    const { category } = classify(k, v);
    if (category === 'appearance') appearance[k] = v;
    else if (category === 'codeStyle') codeStyle[k] = v;
  }
  const state = readJson(pluginStateFile(userData), {});
  const sources = readJson(sourcesFile(userData), {});
  return {
    appearance,
    codeStyle,
    keymap: cleanKeymap(s['keymap.overrides']),
    liveTemplates: cleanTemplates({ custom: s['liveTemplates.custom'], postfixDisabled: s['liveTemplates.postfixDisabled'] }),
    plugins: { disabled: cleanDisabled(state?.disabled) },
    dataSources: (Array.isArray(sources?.sources) ? sources.sources : []).map(cleanSource).filter(Boolean).map((x) => ({ ...x, hasPassword: false })),
    scratches: scratchFiles(userData),
    recentProjects: cleanRecent(s.recentProjects),
  };
}

function countOf(id, data) {
  if (id === 'liveTemplates') return Object.keys(data.custom).length + data.postfixDisabled.length;
  if (id === 'plugins') return data.disabled.length;
  return Array.isArray(data) ? data.length : Object.keys(data).length;
}

// For the export dialog: [{id, count, bytes?, available, checked}]. Plugins are always available (all enabled is a
// state too); other categories need something to export.
function summary(userData) {
  const snap = snapshot(userData);
  return CATEGORIES.map((id) => {
    const count = countOf(id, snap[id]);
    const bytes = id === 'scratches' ? snap.scratches.reduce((n, f) => n + f.size, 0) : undefined;
    const available = id === 'plugins' || count > 0;
    const checked = available && id !== 'recentProjects' && !(id === 'scratches' && bytes > SCRATCHES_DEFAULT_MAX);
    return { id, count, bytes, available, checked };
  });
}

// -> {buffer, manifest}. categories: ids to include (unavailable ones are skipped).
function build(userData, categories, { version, now = new Date() } = {}) {
  const snap = snapshot(userData);
  const entries = [];
  const included = {};
  for (const id of CATEGORIES) {
    if (!categories.includes(id)) continue;
    const data = snap[id];
    const count = countOf(id, data);
    if (id !== 'plugins' && !count) continue;
    if (id === 'scratches') {
      checkScratches(data.length, data.reduce((n, f) => n + f.size, 0), data.reduce((n, f) => Math.max(n, f.size), 0));
      for (const f of data) {
        try { entries.push({ name: `${SCRATCH_PREFIX}${f.rel}`, data: fs.readFileSync(f.file) }); } catch {}
      }
    } else {
      const json = id === 'dataSources' ? { version: 1, sources: data } : id === 'recentProjects' ? { projects: data } : data;
      entries.push({ name: FILES[id], data: JSON.stringify(json, null, 2) });
    }
    included[id] = { count };
  }
  const manifest = { format: FORMAT, product: 'PyIDE', version: version || null, created: now.toISOString(), categories: included };
  entries.unshift({ name: MANIFEST, data: JSON.stringify(manifest, null, 2) });
  return { buffer: zip(entries, now), manifest };
}

function writeArchive(file, userData, categories, opts) {
  const { buffer, manifest } = build(userData, categories, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, buffer);
  fs.renameSync(`${file}.tmp`, file);
  return manifest;
}

// ---------- reading an archive ----------
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
// Entry names that could leave the target folder or that Windows treats specially: absolute paths, drive letters,
// backslashes, `.` / `..` segments, reserved device names, alternate data streams (`:`), control characters.
function unsafeName(name) {
  if (typeof name !== 'string' || !name || name.length > 400 || name.startsWith('/') || /[\\:*?"<>|\x00-\x1f]/.test(name)) return true;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.some((s) => !s || s === '.' || s === '..' || /[. ]$/.test(s) || RESERVED.test(s));
}

const scratchEntries = (z) => z.entries.filter((e) => !e.dir && e.name.startsWith(SCRATCH_PREFIX));
const tooLarge = (what, size, limit) => new ZipError('tooLarge', `${what}: ${size} bytes (at most ${limit})`, { size, limit });

// Scratch files, on export and import: how many, how many bytes in all, the largest.
function checkScratches(count, bytes, largest) {
  if (count > LIMITS.scratchFiles) throw new ZipError('tooManyEntries', `${count} scratch files (at most ${LIMITS.scratchFiles})`, { count, limit: LIMITS.scratchFiles });
  if (bytes > LIMITS.scratchBytes) throw tooLarge('scratch files', bytes, LIMITS.scratchBytes);
  if (largest > LIMITS.entry) throw tooLarge('a scratch file', largest, LIMITS.entry);
}

// What each part of the archive declares it unpacks to, against LIMITS (unzip.open checked the entry count, overlaps,
// each entry and the total).
function checkSizes(z) {
  const json = new Set(Object.values(FILES));
  for (const e of z.entries) {
    if (e.name === MANIFEST && e.size > LIMITS.manifest) throw tooLarge(MANIFEST, e.size, LIMITS.manifest);
    if (json.has(e.name) && e.size > LIMITS.json) throw tooLarge(e.name, e.size, LIMITS.json);
  }
  const scratches = scratchEntries(z);
  checkScratches(scratches.length, scratches.reduce((n, e) => n + e.size, 0), scratches.reduce((n, e) => Math.max(n, e.size), 0));
}

// -> {z, manifest, present: [ids]}; throws ZipError with code notZip | tooLarge (with .size, .limit) | tooManyEntries
// (with .count, .limit) | overlap | unsafeEntry | noManifest | badManifest | newerFormat (with .version, .format).
// Only the manifest (at most LIMITS.manifest) is inflated here.
function load(file) {
  let size;
  try { size = fs.statSync(file).size; } catch (err) { throw new ZipError('readFailed', err.message); }
  if (size > LIMITS.archive) throw tooLarge('the archive', size, LIMITS.archive);
  const z = unzip.open(fs.readFileSync(file), { maxEntries: LIMITS.entries, maxEntryBytes: LIMITS.entry, maxTotalBytes: LIMITS.total });
  const bad = z.entries.find((e) => unsafeName(e.name));
  if (bad) throw new ZipError('unsafeEntry', bad.name);
  checkSizes(z);
  if (!z.has(MANIFEST)) throw new ZipError('noManifest');
  let manifest;
  try { manifest = JSON.parse(z.read(MANIFEST).toString('utf8')); } catch (err) {
    if (err instanceof ZipError && err.code !== 'notZip') throw err;
    throw new ZipError('badManifest', err.message);
  }
  if (!plain(manifest) || manifest.product !== 'PyIDE' || !Number.isInteger(manifest.format) || manifest.format < 1) throw new ZipError('badManifest');
  if (manifest.format > FORMAT) throw Object.assign(new ZipError('newerFormat'), { version: typeof manifest.version === 'string' ? manifest.version : null, format: manifest.format });
  const listed = plain(manifest.categories) ? manifest.categories : {};
  const present = CATEGORIES.filter((id) => listed[id] && (id === 'scratches'
    ? scratchEntries(z).length > 0
    : z.has(FILES[id])));
  return { z, manifest, present };
}

function inspect(file) {
  const { manifest, present } = load(file);
  return {
    version: typeof manifest.version === 'string' ? manifest.version : null,
    created: typeof manifest.created === 'string' ? manifest.created : null,
    categories: present.map((id) => ({ id, count: Number(manifest.categories[id]?.count) || 0 })),
  };
}

const readEntryJson = async (z, name) => {
  try { return JSON.parse((await z.readAsync(name)).toString('utf8')); } catch (err) {
    if (err instanceof ZipError && err.code === 'tooLarge') throw err;
    throw new ZipError('badEntry', name);
  }
};

// ---------- applying ----------
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

// The current state in the same format, before an import changes it. Scratch files are left out: an import only adds
// scratch files, never overwrites one.
function backup(userData, opts = {}) {
  const now = opts.now || new Date();
  const dir = path.join(userData, 'settings-backups');
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${stamp(now)}.zip`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${stamp(now)}_${i}.zip`);
  const ids = summary(userData).filter((c) => c.available && c.id !== 'scratches').map((c) => c.id);
  writeArchive(file, userData, ids, { ...opts, now });
  return file;
}

// A free name next to an existing different file: a.py -> a_1.py, a_2.py, …
function freeName(file) {
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let i = 1; ; i++) if (!fs.existsSync(`${stem}_${i}${ext}`)) return `${stem}_${i}${ext}`;
}

// Writes the archive's scratch files, inflating one at a time; never more than LIMITS.scratchFiles files or
// LIMITS.scratchBytes bytes (load() refused larger archives already, this keeps the promise where the files are written).
async function writeScratches(userData, z) {
  const root = path.resolve(scratchDir(userData));
  const added = [];
  let same = 0;
  let files = 0;
  let bytes = 0;
  for (const e of scratchEntries(z)) {
    const rel = e.name.slice(SCRATCH_PREFIX.length);
    let target = path.resolve(root, ...rel.split('/'));
    if (!target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new ZipError('unsafeEntry', e.name);
    const data = await z.readAsync(e.name);
    if (fs.existsSync(target)) {
      let current = null;
      try { current = fs.readFileSync(target); } catch {}
      if (current && current.equals(data)) { same++; continue; }
      target = freeName(target);
    }
    if (++files > LIMITS.scratchFiles) throw new ZipError('tooManyEntries', `more than ${LIMITS.scratchFiles} scratch files`, { count: files, limit: LIMITS.scratchFiles });
    if ((bytes += data.length) > LIMITS.scratchBytes) throw tooLarge('scratch files', bytes, LIMITS.scratchBytes);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    added.push(path.relative(root, target).split(path.sep).join('/'));
  }
  return { added, unchanged: same };
}

// Data sources written straight to sources.json, for when the Database plugin is not running (it keeps the list in
// memory while it runs). A source with the same id keeps its local encrypted password only when it still reaches the
// same server as the same user (same-connection.js); otherwise it arrives without one and the user types it again.
function mergeSources(userData, list) {
  const file = sourcesFile(userData);
  const saved = readJson(file, {});
  const current = Array.isArray(saved?.sources) ? saved.sources.filter((s) => plain(s) && typeof s.id === 'string') : [];
  const byId = new Map(current.map((s) => [s.id, s]));
  for (const s of list) {
    const local = byId.get(s.id);
    byId.set(s.id, local?.secret && sameConnection(local, s) ? { ...s, secret: local.secret } : s);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...(plain(saved) ? saved : {}), version: 1, sources: [...byId.values()] }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// Backs up, then applies what main owns (plugin state, scratch files, data sources when the Database plugin is off) and
// returns what the renderer applies: settings keys (imported wins), the keymap overrides (replace), live templates
// (imported wins per abbreviation), recent projects (merged), data sources (when the Database plugin runs).
// Asynchronous: entries inflate on the thread pool one at a time, so a large archive does not block the main process.
async function apply(userData, file, categories, { databaseLoaded = false, version, now } = {}) {
  const { z, present } = load(file);
  const chosen = present.filter((id) => categories.includes(id));
  // Every chosen entry is read and checked before anything is changed. Scratch files are only checked here (size and
  // CRC) and inflated again while they are written, so at most one of them is in memory at a time.
  const data = {};
  for (const id of chosen) if (id !== 'scratches') data[id] = await readEntryJson(z, FILES[id]);
  if (chosen.includes('scratches')) for (const e of scratchEntries(z)) await z.readAsync(e.name);

  const result = { backup: backup(userData, { version, now }), applied: chosen, settings: {}, keymap: null, liveTemplates: null, recentProjects: null, plugins: null, dataSources: null, scratches: null };
  for (const id of ['appearance', 'codeStyle']) {
    if (!chosen.includes(id) || !plain(data[id])) continue;
    for (const [k, v] of Object.entries(data[id])) if (!BAD_KEYS.has(k) && classify(k, v).category === id) result.settings[k] = v;
  }
  if (chosen.includes('keymap')) result.keymap = cleanKeymap(data.keymap);
  if (chosen.includes('liveTemplates')) result.liveTemplates = cleanTemplates(data.liveTemplates);
  if (chosen.includes('recentProjects')) result.recentProjects = cleanRecent(data.recentProjects?.projects);
  if (chosen.includes('plugins')) {
    const disabled = cleanDisabled(data.plugins?.disabled);
    const state = readJson(pluginStateFile(userData), {});
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(pluginStateFile(userData), JSON.stringify({ ...(plain(state) ? state : {}), disabled }, null, 2));
    result.plugins = { disabled };
  }
  if (chosen.includes('dataSources')) {
    const list = (Array.isArray(data.dataSources?.sources) ? data.dataSources.sources : []).map(cleanSource).filter(Boolean);
    if (databaseLoaded) result.dataSources = list;
    else { mergeSources(userData, list); result.dataSources = []; result.dataSourcesWritten = list.length; }
  }
  if (chosen.includes('scratches')) result.scratches = await writeScratches(userData, z);
  return result;
}

module.exports = {
  FORMAT, MANIFEST, CATEGORIES, FILES, SCRATCHES_DEFAULT_MAX, LIMITS,
  classify, unsafeName, snapshot, summary, build, writeArchive, load, inspect, apply, backup, ZipError,
};
