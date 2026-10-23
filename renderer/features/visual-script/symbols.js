// The functions and classes a graph can call: the project's own modules (read with `ast` in main, never run) and
// package modules the user asks for by name (imported in the project interpreter in main). VS.symbols:
//   project() -> modules        the project index ([] until read, in Safe Mode and without a project)
//   module(name) -> Promise     a project module, or a package module loaded once per interpreter
//   packages() -> Promise       top-level module names that can be loaded
//   lookup(module, cls, name)   undefined (not known), null (gone) or the function / class / method
//   isProject(name), refresh(), onChange(fn) -> unsubscribe, use() (start reading the project; the editor calls it)
// A module: {name, doc, functions: [fn], classes: [{name, params, doc, methods: [fn + {kind}]}], submodules?, error?};
// fn: {name, params, returns, doc, async} (see python/vs_symbols.py).
(function (root) {
  const VS = root.PyideVisualScript || (root.PyideVisualScript = {});
  const ide = root.ide;

  let project = [];
  let projectByName = new Map();
  let projectTops = new Set();
  let ready = false;
  let used = false;
  let loading = null;
  let again = false;
  let generation = 0;
  const loaded = new Map(); // package module name -> Promise<module>
  const loadedValue = new Map(); // package module name -> module, once loaded
  let packageList = null;
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } };

  // The project interpreter, or a local one when the project runs remotely (the helper runs here).
  function localInterp() {
    const cur = ide.currentInterp?.();
    const pick = cur && !cur.target ? cur : (ide.interps || []).find((i) => !i.target && i.cmd);
    return pick ? { cmd: pick.cmd, args: pick.args || [] } : null;
  }
  const enabled = () => !!(ide && ide.root && ide.trusted !== false);

  function setProject(list) {
    project = list;
    projectByName = new Map(list.map((m) => [m.name, m]));
    projectTops = new Set(list.map((m) => m.name.split('.')[0]));
  }
  function clearPackages() {
    loaded.clear();
    loadedValue.clear();
    packageList = null;
  }

  async function refresh() {
    if (!ide) return [];
    if (loading) { again = true; return loading; }
    const my = ++generation;
    loading = (async () => {
      if (!enabled()) { setProject([]); ready = false; return project; }
      const r = await ide.api.invoke('visual-script:symbols', { root: ide.root, interp: localInterp() }).catch((err) => ({ error: String(err.message || err), modules: [] }));
      if (my !== generation) return project;
      if (r.error) console.warn('visual-script: reading the project symbols failed', r.error);
      setProject(r.trusted ? r.modules || [] : []);
      ready = !!r.trusted && !r.error;
      return project;
    })();
    try { return await loading; } finally {
      loading = null;
      changed();
      if (again) { again = false; refresh(); }
    }
  }

  function loadModule(name) {
    if (projectByName.has(name)) return Promise.resolve(projectByName.get(name));
    if (!loaded.has(name)) {
      const p = (async () => {
        if (!enabled()) throw new Error(VS.tr('Packages are not loaded in Safe Mode.'));
        const r = await ide.api.invoke('visual-script:module', { root: ide.root, interp: localInterp(), name });
        if (!r.ok) {
          const messages = {
            missing: VS.tr('No module named {name}.', { name }),
            project: VS.tr('{name} is part of this project. Its functions are listed under Project.', { name }),
            timeout: VS.tr('Loading {name} took longer than 10 seconds.', { name }),
          };
          throw new Error(messages[r.reason] || r.error);
        }
        loadedValue.set(name, r.module);
        changed();
        return r.module;
      })();
      // A failed load is asked again next time (the package may have been installed meanwhile).
      p.catch(() => { if (loaded.get(name) === p) loaded.delete(name); });
      loaded.set(name, p);
    }
    return loaded.get(name);
  }

  async function packages() {
    if (!enabled()) return [];
    if (!packageList) {
      const r = await ide.api.invoke('visual-script:packages', { root: ide.root, interp: localInterp() });
      if (!r.ok) throw new Error(r.error);
      packageList = r.packages;
    }
    return packageList;
  }

  function lookup(moduleName, cls, name) {
    const mod = projectByName.get(moduleName) || loadedValue.get(moduleName);
    if (!mod) {
      // A project module that is gone (renamed, deleted): its package is still the project's.
      return ready && projectTops.has(String(moduleName || '').split('.')[0]) ? null : undefined;
    }
    if (mod.error) return undefined;
    if (cls == null) return (mod.functions || []).find((f) => f.name === name) || null;
    const c = (mod.classes || []).find((x) => x.name === cls);
    if (!c || name == null) return c || null;
    return (c.methods || []).find((m) => m.name === name) || null;
  }

  VS.symbols = {
    project: () => project,
    module: loadModule,
    packages,
    lookup,
    isProject: (name) => projectByName.has(name) || projectTops.has(String(name || '').split('.')[0]),
    ready: () => ready,
    refresh,
    use() { if (!used) { used = true; refresh(); } },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  if (ide) {
    let timer = 0;
    const later = (ms = 800) => { if (!used) return; clearTimeout(timer); timer = setTimeout(refresh, ms); };
    ide.on('projectOpened', () => { setProject([]); ready = false; clearPackages(); changed(); later(0); });
    ide.on('projectClosed', () => { generation++; setProject([]); ready = false; clearPackages(); changed(); });
    ide.on('interpreterChanged', () => { clearPackages(); changed(); later(100); });
    ide.on('fileSaved', (tab) => { if (/\.py$/i.test(tab?.path || '')) later(); });
    ide.on('filesChanged', () => later());
    ide.on('packagesChanged', () => { clearPackages(); ide.api.invoke('visual-script:forgetPackages').catch(() => {}); changed(); });
  }

  if (typeof module === 'object' && module.exports) module.exports = VS;
})(typeof window !== 'undefined' ? window : globalThis);
