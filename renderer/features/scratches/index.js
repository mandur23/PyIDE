// Scratch files, as in PyCharm: File › New Scratch File (Ctrl+Alt+Shift+Insert) asks for a language and creates
// scratch.<ext>, scratch_1.<ext>, … in <userData>/scratches (main/features/scratches.js), outside every project and
// shared by all of them, and opens it. The project tree lists them under Scratches and Consoles › Scratches, where
// they can be run, debugged, renamed and deleted. A Python scratch runs with the project interpreter in the project
// root (the run and debugger plugins ask ide.scratches.isScratch). Project-wide features (Find in Files, the semantic
// index, Local History) walk only the project, so scratches stay out of them.
(() => {
  const { basename, dirname, isUnder } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(`scratches:${ch}`, ...args);

  // PyCharm's language list starts with the project's language. Names are language names, kept in English.
  const LANGUAGES = [
    { name: 'Python', ext: 'py' },
    { name: 'Markdown', ext: 'md' },
    { name: 'JSON', ext: 'json' },
    { name: 'SQL', ext: 'sql' },
    { name: 'HTML', ext: 'html' },
    { name: tr('Plain Text'), ext: 'txt' },
    { name: 'YAML', ext: 'yaml' },
    { name: 'TOML', ext: 'toml' },
    { name: 'JavaScript', ext: 'js' },
    { name: 'TypeScript', ext: 'ts' },
    { name: 'CSS', ext: 'css' },
    { name: 'XML', ext: 'xml' },
    { name: 'HTTP Request', ext: 'http' },
    { name: 'Shell Script', ext: 'sh' },
    { name: 'PowerShell', ext: 'ps1' },
    { name: 'Batch', ext: 'bat' },
    { name: 'INI', ext: 'ini' },
    { name: 'CSV', ext: 'csv' },
    { name: 'reStructuredText', ext: 'rst' },
  ];

  let dir = null;
  const isScratch = (p) => !!dir && !!p && isUnder(p, dir) && !isUnder(dir, p);
  const isPy = (p) => /\.pyw?$/i.test(p);

  // ---------- creating ----------
  async function create(ext) {
    const path = await invoke('create', ext);
    ide.refreshTree();
    await ide.openFile(path);
    return path;
  }

  async function newScratch() {
    const lang = await ide.ui.pick({
      placeholder: tr('New Scratch File'),
      items: LANGUAGES.map((l) => ({ label: l.name, detail: `.${l.ext}`, icon: ide.fileIcon(`scratch.${l.ext}`), value: l })),
    });
    if (!lang) return null;
    try {
      return await create(lang.ext);
    } catch (err) {
      ide.ui.alert(tr('Could not create a scratch file: {error}', { error: ide.util.errorText(err) }));
      return null;
    }
  }

  ide.registerAction({ id: 'NewScratchFile', title: tr('New Scratch File'), keys: 'Ctrl+Alt+Shift+Insert', run: newScratch });

  // ---------- running ----------
  // As in PyCharm, a scratch runs in the project root (cwd and PYTHONPATH), not in the scratches folder.
  const runConfig = (path) => ({ type: 'python', name: basename(path).replace(/\.pyw?$/i, ''), script: path, cwd: ide.root || dirname(path) });
  const run = (path) => ide.run.runContext(runConfig(path));
  const debug = (path) => ide.run.debugConfig(ide.run.addTemporary(runConfig(path)));

  // ---------- project tree: Scratches and Consoles › Scratches ----------
  function menu(entry) {
    const items = [{ label: tr('New Scratch File'), hint: 'Ctrl+Alt+Shift+Insert', run: newScratch }];
    if (!entry.dir && isPy(entry.path) && ide.run) {
      const name = basename(entry.path).replace(/\.pyw?$/i, '');
      items.push({ separator: true }, { label: tr("Run '{name}'", { name }), run: () => run(entry.path) });
      if (ide.run.canDebug(runConfig(entry.path))) items.push({ label: tr("Debug '{name}'", { name }), run: () => debug(entry.path) });
    }
    if (!entry.dir) items.push({ separator: true }, { label: tr('Show in Explorer'), run: () => ide.api.invoke('shell:showInFolder', entry.path) });
    return items;
  }

  let refreshTimer = null;
  ide.api.on('scratches:changed', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => ide.refreshTree(), 100);
  });

  const ready = invoke('dir').then((d) => {
    dir = d;
    // The node itself is not a folder on disk; its path (the user-data folder) only identifies it.
    const top = dirname(d);
    ide.registerTreeRoot({
      id: 'scratches',
      order: 10,
      entry: { name: 'Scratches and Consoles', label: tr('Scratches and Consoles'), path: top, dir: true, fixed: true, iconType: 'scratches' },
      list: (p) => (ide.util.samePath(p, top) ? [{ name: basename(d), label: tr('Scratches'), path: d, dir: true, fixed: true }] : null),
      menu,
    });
    return d;
  }).catch((err) => { console.error('scratches: cannot open the scratches folder', err); return null; });

  ide.scratches = {
    ready,
    dir: () => dir,
    isScratch,
    // Full paths of the scratch files, for Search Everywhere's Files.
    list: () => invoke('list').catch(() => []),
    create,
    newScratch,
    run,
    debug,
  };
})();
