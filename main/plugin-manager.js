// Plugins: a folder with plugin.json ({id, name, version, vendor, description, depends?, required?, main?}).
// Renderer code is index.js / style.css next to plugin.json, translations are locales/<lang>.json, and `main`
// lists main-process modules. Bundled plugins are renderer/features/*; user plugins live in <userData>/plugins.
// Enabling, disabling, installing and uninstalling take effect after a restart, as in PyCharm.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

function createPluginManager({ appDir, userDataDir }) {
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

  function describe(dir, bundled) {
    const json = readJson(path.join(dir, 'plugin.json'), null);
    const meta = json && typeof json === 'object' && !Array.isArray(json) ? json : null;
    if (!meta && !bundled) return null;
    // An installed plugin's plugin.json is read at every start: fields of the wrong kind are left out, not thrown on.
    const strings = (v) => [].concat(v || []).filter((s) => typeof s === 'string');
    const id = (typeof meta?.id === 'string' && meta.id) || path.basename(dir);
    const mains = strings(meta?.main);
    // One listing of the folder instead of a check per file: this runs for every plugin before the window opens.
    const has = filesIn(dir);
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

  // The snapshot taken at startup is what is actually running; later changes show as "restart required".
  function discover() {
    const disabled = new Set(state().disabled);
    const all = [
      ...subdirs(bundledDir).map((d) => describe(d, true)),
      ...subdirs(userDir).map((d) => describe(d, false)),
    ].filter(Boolean);
    const byId = new Map();
    for (const p of all) if (!byId.has(p.id)) byId.set(p.id, p);
    const plugins = [...byId.values()];
    for (const p of plugins) p.enabled = p.required || !disabled.has(p.id);
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

  function list() {
    const disabled = new Set(state().disabled);
    return discover().map((p) => ({
      id: p.id, name: p.name, version: p.version, vendor: p.vendor, description: p.description, i18n: p.i18n,
      depends: p.depends, required: p.required, bundled: p.bundled, dir: p.dir, blockedBy: p.blockedBy || null,
      enabled: p.required || !disabled.has(p.id),
      loaded: loadedIds().has(p.id),
    }));
  }

  function setEnabled(id, enabled) {
    const s = state();
    const disabled = new Set(s.disabled);
    if (enabled) disabled.delete(id); else disabled.add(id);
    saveState({ ...s, disabled: [...disabled] });
    return list();
  }

  // Copies a plugin folder (or a .zip containing one) into the user plugin directory.
  function install(source) {
    let from = source;
    let temp = null;
    // The extraction folder is removed also when the archive cannot be extracted or holds no plugin.
    try {
      if (/\.zip$/i.test(source)) {
        temp = fs.mkdtempSync(path.join(userDataDir, 'plugin-zip-'));
        execFileSync('tar', ['-xf', source, '-C', temp]);
        const inner = fs.existsSync(path.join(temp, 'plugin.json')) ? temp : subdirs(temp).find((d) => fs.existsSync(path.join(d, 'plugin.json')));
        if (!inner) throw new Error('The archive does not contain a plugin.json');
        from = inner;
      }
      const meta = readJson(path.join(from, 'plugin.json'), null);
      if (!meta) throw new Error('plugin.json is missing or not valid JSON');
      if (!ID.test(meta.id || '')) throw new Error('plugin.json needs an "id" of letters, digits, ".", "_" or "-"');
      if (subdirs(bundledDir).some((d) => describe(d, true).id === meta.id)) throw new Error(`"${meta.id}" is a bundled plugin`);
      const target = path.join(userDir, meta.id);
      fs.mkdirSync(userDir, { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(from, target, { recursive: true });
      return { id: meta.id, name: meta.name || meta.id };
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  function uninstall(id) {
    const p = discover().find((x) => x.id === id);
    if (!p || p.bundled) throw new Error('Only installed plugins can be uninstalled');
    fs.rmSync(p.dir, { recursive: true, force: true });
    const s = state();
    saveState({ ...s, disabled: s.disabled.filter((d) => d !== id) });
  }

  const catalog = () => subdirs(catalogDir).map((d) => describe(d, false)).filter(Boolean).map((p) => ({
    id: p.id, name: p.name, version: p.version, vendor: p.vendor, description: p.description, i18n: p.i18n, dir: p.dir,
  }));

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

  // Main modules owned by disabled plugins are skipped; modules no plugin claims always load.
  function mainModules() {
    const claimed = new Set(loadedList().flatMap((p) => p.mainModules.map((m) => m.toLowerCase())));
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

  return { list, setEnabled, install, uninstall, catalog, rendererEntries, localeDictionary, mainModules, ownerOf };
}

module.exports = { createPluginManager };
