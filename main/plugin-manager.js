// Plugins: a folder with plugin.json ({id, name, version, vendor, description, depends?, required?, main?, modes?}).
// Renderer code is index.js / style.css next to plugin.json, translations are locales/<lang>.json, and `main`
// lists main-process modules. Bundled plugins are renderer/features/*; user plugins live in <userData>/plugins.
// Enabling, disabling, installing and uninstalling take effect after a restart, as in PyCharm.
// `modes` lists the app modes a plugin runs in ('code', 'craft'; ['code'] when absent). A process has one mode
// (main.js), and only the plugins of that mode load; required plugins load in every mode.
const fs = require('fs');
const path = require('path');
const { extractZip } = require('./zip');
const market = require('./marketplace');

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
const MODES = ['code', 'craft'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

// Copies a folder tree with the fs calls Electron supports inside app.asar (fs.cpSync is not one of them, so the
// Marketplace's plugins-catalog, packed in the installed app's asar, could not be installed). Symbolic links are skipped.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const st = fs.lstatSync(src);
    if (st.isDirectory()) copyTree(src, dst);
    else if (st.isFile()) fs.writeFileSync(dst, fs.readFileSync(src));
  }
}

function createPluginManager({ appDir, userDataDir, mode: initialMode = 'code' }) {
  let mode = initialMode;
  const bundledDir = path.join(appDir, 'renderer', 'features');
  const bundledMainDir = path.join(appDir, 'main', 'features');
  const catalogDir = path.join(appDir, 'plugins-catalog');
  const userDir = path.join(userDataDir, 'plugins');
  const stateFile = path.join(userDataDir, 'plugin-state.json');

  // Read before the window exists, so a hand-edited file must not throw: a `disabled` that is not a list of ids
  // counts as nothing disabled.
  const state = () => {
    const s = readJson(stateFile, {});
    const saved = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    return { ...saved, disabled: Array.isArray(saved.disabled) ? saved.disabled.filter((id) => typeof id === 'string') : [] };
  };
  const saveState = (s) => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  };

  // An installed plugin whose plugin.json is missing or unreadable is listed by its folder name with `broken`
  // ('missing' | 'invalid') and never loads, so the Plugins page can show it and uninstall it.
  function describe(dir, bundled) {
    const json = readJson(path.join(dir, 'plugin.json'), null);
    const meta = json && typeof json === 'object' && !Array.isArray(json) ? json : null;
    // One listing of the folder instead of a check per file: this runs for every plugin before the window opens.
    const has = filesIn(dir);
    if (!meta && !bundled) {
      const id = path.basename(dir);
      return { id, name: id, version: '', vendor: '', description: '', i18n: {}, depends: [], required: false, detached: false, modes: ['code'], bundled,
        dir, script: null, style: null, mainModules: [], hasLocales: false, broken: has('plugin.json') ? 'invalid' : 'missing' };
    }
    // An installed plugin's plugin.json is read at every start: fields of the wrong kind are left out, not thrown on.
    const strings = (v) => [].concat(v || []).filter((s) => typeof s === 'string');
    const id = (typeof meta?.id === 'string' && meta.id) || path.basename(dir);
    const mains = strings(meta?.main);
    const modes = strings(meta?.modes).filter((m) => MODES.includes(m));
    return {
      id,
      name: meta?.name || id,
      version: meta?.version || '',
      vendor: meta?.vendor || '',
      description: meta?.description || '',
      i18n: meta?.i18n || {},
      depends: strings(meta?.depends),
      required: !!meta?.required,
      detached: !!meta?.detached,
      modes: modes.length ? modes : ['code'],
      bundled,
      dir,
      script: has('index.js') ? path.join(dir, 'index.js') : null,
      style: has('style.css') ? path.join(dir, 'style.css') : null,
      mainModules: mains.map((m) => (bundled ? path.join(bundledMainDir, m) : path.join(dir, m))),
      // Its translations are locales/<lang>.json, read when a language asks for them (localeDictionary).
      hasLocales: has('locales'),
    };
  }

  // Whether a folder holds an entry, by name (ignoring case on Windows, as existsSync does there).
  const caseless = process.platform === 'win32';
  function filesIn(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    const set = new Set(caseless ? names.map((n) => n.toLowerCase()) : names);
    return (name) => set.has(caseless ? name.toLowerCase() : name);
  }

  const subdirs = (root) => (fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)) : []);

  const inMode = (p) => p.required || p.modes.includes(mode);

  // The snapshot taken at startup is what is actually running; later changes show as "restart required". Plugins of
  // another mode are left out: they are neither listed nor loaded, and a plugin depending on one cannot load.
  function discoverAll() {
    const all = [
      ...subdirs(bundledDir).map((d) => describe(d, true)),
      ...subdirs(userDir).map((d) => describe(d, false)),
    ];
    const byId = new Map();
    for (const p of all) if (!byId.has(p.id)) byId.set(p.id, p);
    return byId;
  }
  function discover() {
    const disabled = new Set(state().disabled);
    const byId = discoverAll();
    const plugins = [...byId.values()].filter(inMode);
    for (const p of plugins) p.enabled = !p.broken && (p.required || !disabled.has(p.id));
    // A plugin whose dependency is off or missing cannot load.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of plugins) {
        if (!p.enabled) continue;
        const broken = p.depends.find((d) => !byId.get(d)?.enabled);
        if (broken) { p.enabled = false; p.blockedBy = broken; changed = true; }
      }
    }
    return plugins;
  }

  // Taken on first use (main.js registers the feature modules right after creating the window), so reading every
  // plugin folder does not hold up the window.
  let snapshot = null;
  const loadedList = () => (snapshot ??= discover());
  let loadedIdSet = null;
  const loadedIds = () => (loadedIdSet ??= new Set(loadedList().filter((p) => p.enabled).map((p) => p.id)));
  // The mode is known once the chooser answers, before the feature modules register (main.js).
  function setMode(m) {
    if (!MODES.includes(m) || m === mode) return;
    mode = m;
    snapshot = null;
    loadedIdSet = null;
  }

  // broken: plugin.json is 'missing' or 'invalid'. loadError: why a main module of the running plugin failed to load.
  function list() {
    const disabled = new Set(state().disabled);
    const running = new Map(loadedList().map((p) => [p.id, p]));
    const { loadFailure } = require('./diagnostics');
    return discover().map((p) => ({
      id: p.id, name: p.name, version: p.version, vendor: p.vendor, description: p.description, i18n: p.i18n,
      depends: p.depends, required: p.required, bundled: p.bundled, dir: p.dir, blockedBy: p.blockedBy || null,
      enabled: !p.broken && (p.required || !disabled.has(p.id)),
      loaded: loadedIds().has(p.id),
      broken: p.broken || null,
      loadError: (loadedIds().has(p.id) && running.get(p.id).mainModules.map(loadFailure).find(Boolean)?.split('\n')[0]) || null,
    }));
  }

  function setEnabled(id, enabled) {
    const s = state();
    const disabled = new Set(s.disabled);
    if (enabled) disabled.delete(id); else disabled.add(id);
    saveState({ ...s, disabled: [...disabled] });
    return list();
  }

  // Copies a plugin folder (or a .zip containing one) into the user plugin directory. expect: {id, version} that the
  // archive's plugin.json must have (a Marketplace download, whose index named them).
  function install(source, expect = null) {
    let from = source;
    let temp = null;
    // The extraction folder is removed also when the archive cannot be extracted or holds no plugin.
    try {
      if (/\.zip$/i.test(source)) {
        temp = fs.mkdtempSync(path.join(userDataDir, 'plugin-zip-'));
        extractZip(source, temp);
        const inner = fs.existsSync(path.join(temp, 'plugin.json')) ? temp : subdirs(temp).find((d) => fs.existsSync(path.join(d, 'plugin.json')));
        if (!inner) throw new Error('The archive does not contain a plugin.json');
        from = inner;
      }
      const meta = readJson(path.join(from, 'plugin.json'), null);
      if (!meta) throw new Error('plugin.json is missing or not valid JSON');
      if (!ID.test(meta.id || '')) throw new Error('plugin.json needs an "id" of letters, digits, ".", "_" or "-"');
      if (subdirs(bundledDir).some((d) => describe(d, true).id === meta.id)) throw new Error(`"${meta.id}" is a bundled plugin`);
      if (expect && (meta.id !== expect.id || meta.version !== expect.version)) {
        throw new Error(`The archive holds ${meta.id} ${meta.version || ''}, not ${expect.id} ${expect.version} as the Marketplace lists it`);
      }
      fs.mkdirSync(userDir, { recursive: true });
      sweepLeftovers();
      const staged = fs.mkdtempSync(path.join(userDataDir, 'plugin-new-'));
      try {
        copyTree(from, staged);
        replaceFolder(path.join(userDir, meta.id), staged, meta.id);
      } finally {
        fs.rmSync(staged, { recursive: true, force: true });
      }
      return { id: meta.id, name: meta.name || meta.id };
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  // A plugin folder is replaced or removed only by renaming it aside first: Windows refuses that rename while another
  // program holds something inside (a helper running in it, an antivirus scan), and the plugin is then left complete,
  // where deleting it in place would stop halfway. The staging and old folders live in the user data folder, beside
  // plugins/ (one volume, so renames are atomic) but outside it, so discovery never sees them.
  function replaceFolder(target, staged, id) {
    let old = null;
    if (fs.existsSync(target)) {
      old = path.join(fs.mkdtempSync(path.join(userDataDir, 'plugin-old-')), id);
      try { fs.renameSync(target, old); } catch (err) {
        fs.rmSync(path.dirname(old), { recursive: true, force: true });
        throw inUse(err, id);
      }
    }
    if (staged) {
      try { fs.renameSync(staged, target); } catch (err) {
        if (old) fs.renameSync(old, target);
        throw err;
      }
    }
    // The new version is in place; an old copy that cannot be deleted yet goes with the next install.
    if (old) try { fs.rmSync(path.dirname(old), { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
  const inUse = (err, id) => (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)
    ? new Error(`The folder of ${id} is in use by another program (${err.code}). Close the program and try again.`) : err);
  // What an interrupted install or a still-locked old folder left; a staging folder younger than ten minutes may belong
  // to another PyIDE instance installing right now.
  function sweepLeftovers() {
    for (const name of fs.readdirSync(userDataDir)) {
      if (!/^plugin-(new|old)-/.test(name)) continue;
      const dir = path.join(userDataDir, name);
      try {
        if (name.startsWith('plugin-old-') || Date.now() - fs.statSync(dir).mtimeMs > 600000) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  function uninstall(id) {
    const p = discover().find((x) => x.id === id);
    if (!p || p.bundled) throw new Error('Only installed plugins can be uninstalled');
    replaceFolder(p.dir, null, id);
    const s = state();
    saveState({ ...s, disabled: s.disabled.filter((d) => d !== id) });
  }

  const catalog = () => subdirs(catalogDir).map((d) => describe(d, false)).filter((p) => !p.broken).map((p) => ({
    id: p.id, name: p.name, version: p.version, vendor: p.vendor, description: p.description, i18n: p.i18n, dir: p.dir,
  }));

  // The Marketplace: the sample plugins in plugins-catalog/ plus the online index, one entry per id (the online one when
  // its version is newer). `value` is the index location ('' for none); the online index is read again after ten
  // minutes or with `refresh`. The last listing is what installListed installs from.
  const appVersion = readJson(path.join(appDir, 'package.json'), {}).version || '0.0.0';
  let cached = null; // {href, at, entries}
  let listed = new Map();
  async function marketplace(value, { refresh = false } = {}) {
    const bundledIds = new Set(subdirs(bundledDir).map((d) => describe(d, true).id));
    const byId = new Map(catalog().map((p) => [p.id, { ...p, origin: 'bundled' }]));
    let online = { state: 'off' };
    let source = null;
    try {
      source = market.resolveSource(value);
      if (source) {
        if (refresh || cached?.href !== source.href || Date.now() - cached.at > 600000) {
          cached = { href: source.href, at: Date.now(), entries: await market.fetchIndex(source) };
        }
        const usable = cached.entries.filter((e) => !bundledIds.has(e.id));
        const fits = usable.filter((e) => !e.minIdeVersion || market.compareVersions(e.minIdeVersion, appVersion) <= 0);
        for (const e of fits) {
          const have = byId.get(e.id);
          if (!have || market.compareVersions(e.version, have.version) > 0) byId.set(e.id, { ...e, origin: 'online' });
        }
        online = { state: 'ok', source: source.href, hidden: usable.length - fits.length };
      }
    } catch (err) {
      online = { state: 'error', source: source?.href || String(value), error: err.message };
    }
    listed = byId;
    const have = new Map(subdirs(userDir).map((d) => describe(d, false)).filter((p) => !p.broken).map((p) => [p.id, p.version]));
    const plugins = [...byId.values()].map((p) => ({
      ...p,
      installedVersion: have.get(p.id) ?? null,
      update: have.has(p.id) && market.compareVersions(p.version, have.get(p.id)) > 0,
    }));
    return { plugins, online };
  }

  // Installs a plugin from the last Marketplace listing; an online one is downloaded and checked against the index
  // (size, sha256, then the id and version in its plugin.json) before it is unpacked.
  async function installListed(id) {
    const p = listed.get(id);
    if (!p) throw new Error(`${id} is not in the Marketplace`);
    if (p.origin === 'bundled') return install(p.dir);
    const body = await market.download(p);
    const temp = fs.mkdtempSync(path.join(userDataDir, 'plugin-download-'));
    try {
      const zip = path.join(temp, `${p.id}-${p.version}.zip`);
      fs.writeFileSync(zip, body);
      return install(zip, { id: p.id, version: p.version });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  // Discovery order, except that a plugin's dependencies come before it, so it can use their APIs while it loads.
  function dependencyOrder(list) {
    const byId = new Map(list.map((p) => [p.id, p]));
    const out = [];
    const seen = new Set();
    const visit = (p) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      for (const d of p.depends) if (byId.has(d)) visit(byId.get(d));
      out.push(p);
    };
    list.forEach(visit);
    return out;
  }

  // Renderer assets of the plugins running this session, in a stable order (bundled first, dependencies first).
  const rendererEntries = ({ detached = false } = {}) => dependencyOrder(loadedList().filter((p) => p.enabled && p.script && (!detached || p.detached))).map((p) => ({
    id: p.id,
    name: p.name,
    script: p.bundled ? `features/${path.basename(p.dir)}/index.js` : require('url').pathToFileURL(p.script).href,
    css: p.style ? (p.bundled ? `features/${path.basename(p.dir)}/style.css` : require('url').pathToFileURL(p.style).href) : null,
  }));

  function localeDictionary(lang) {
    const dict = { ...readJson(path.join(appDir, 'renderer', 'locales', `${lang}.json`), {}) };
    for (const p of loadedList()) {
      if (!p.hasLocales || typeof lang !== 'string' || path.basename(lang) !== lang) continue;
      const own = readJson(path.join(p.dir, 'locales', `${lang}.json`), {}); // {} when the plugin has no such language
      if (p.enabled) Object.assign(dict, own);
      // A disabled plugin's strings stay out, except its name and description, which the Plugins page still shows.
      else for (const k of [p.name, p.description]) if (k && typeof own[k] === 'string' && !(k in dict)) dict[k] = own[k];
    }
    return dict;
  }

  // Main modules owned by disabled plugins or plugins of another mode are skipped; modules no plugin claims always load.
  function mainModules() {
    const claimed = new Set([...discoverAll().values()].flatMap((p) => p.mainModules.map((m) => m.toLowerCase())));
    const enabled = loadedList().filter((p) => p.enabled).flatMap((p) => p.mainModules);
    const unclaimed = fs.existsSync(bundledMainDir)
      ? fs.readdirSync(bundledMainDir).filter((f) => f.endsWith('.js')).map((f) => path.join(bundledMainDir, f)).filter((m) => !claimed.has(m.toLowerCase()))
      : [];
    return [...unclaimed, ...enabled].sort();
  }

  // The plugin a source file belongs to (inside its folder, or one of its main modules), for error reports.
  function ownerOf(file) {
    const f = path.resolve(file).toLowerCase();
    const p = loadedList().find((x) => x.mainModules.some((m) => m.toLowerCase() === f) || f.startsWith(x.dir.toLowerCase() + path.sep));
    return p ? { id: p.id, name: p.name, i18n: p.i18n, required: p.required, bundled: p.bundled } : null;
  }

  return { list, setEnabled, install, uninstall, catalog, marketplace, installListed, rendererEntries, localeDictionary, mainModules, ownerOf,
    setMode, mode: () => mode };
}

module.exports = { createPluginManager, copyTree };
