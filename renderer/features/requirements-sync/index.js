// Sync Python Requirements (PyCharm's action of the same name): reads every import of the project with the project
// interpreter (main/features/requirements-sync.js) and compares the third-party ones with the requirements file. A
// dialog lists the packages the code imports that the file does not declare (checked, to add) and the ones the file
// declares that no import uses (unchecked, to remove: a command-line tool or a plugin is used without an import), with
// the version form to write (~=, >=, == or none) from what is installed. The distribution of an import comes from the
// installed packages' metadata (bs4 -> beautifulsoup4), else from import-install's name table. Writing goes to
// requirements.txt (a new one when the project has none) or, for additions, a pyproject.toml with [project]; an open
// file with unsaved edits is edited in its editor. Tools › Sync Python Requirements… and the Python Packages window.
(() => {
  const { el, basename } = ide.util;
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  const VERSION = 'requirementsSync.version';
  const FORMS = [['~=', () => tr('Compatible (~=)')], ['>=', () => tr('Greater or equal (>=)')], ['==', () => tr('Exact (==)')], ['', () => tr("Don't specify")]];

  const ERRORS = {
    remote: () => tr('Sync Python Requirements reads the project with a local Python interpreter.'),
    untrusted: () => tr('The project is open in Safe Mode, where Nano Studio runs nothing from it.'),
  };

  // The requirements file to sync: requirements.txt, else a pyproject.toml with [project], else a new requirements.txt.
  function target(state) {
    return state.files.find((f) => f.kind === 'requirements')
      || state.files.find((f) => f.kind === 'pyproject' && f.editable)
      || { path: ide.util.joinPath(ide.root, 'requirements.txt'), kind: 'requirements', reqs: [], created: true };
  }

  // -> {target, missing: [{name, version, where}], unused: [req]}
  async function compare() {
    await ide.dependencies.check();
    const state = ide.dependencies.state();
    const file = target(state);
    const declaredAll = new Set(state.files.flatMap((f) => f.reqs.map((r) => norm(r.name))));
    const interp = ide.currentInterp();
    if (!interp) throw new Error(tr('No Python interpreter found.'));
    const scan = await ide.api.invoke('requirements-sync:scan', ide.root, interp, file.reqs.map((r) => r.name));
    if (scan.error) throw new Error(ERRORS[scan.error]?.() || scan.error);
    const missing = new Map();
    const used = new Set();
    for (const [top, info] of Object.entries(scan.imports)) {
      // Installed: the metadata says which distribution provides it. Not installed: the usual name for the import.
      const dists = info.dists.length ? info.dists.map(([name, version]) => ({ name, version })) : [{ name: ide.importInstall?.distFor(top) || top.replace(/_/g, '-'), version: null }];
      for (const d of dists) used.add(norm(d.name));
      if (dists.some((d) => declaredAll.has(norm(d.name)))) continue;
      // A namespace shared by several distributions (google: protobuf, google-cloud-storage…): the one named for an
      // imported submodule (google.cloud.storage -> google-cloud-storage), else the first.
      const named = new Set((info.modules || []).map((m) => ide.importInstall?.distFor(m)).filter(Boolean).map(norm));
      const d = dists.find((x) => named.has(norm(x.name))) || dists[0];
      if (!d.name || missing.has(norm(d.name))) continue;
      missing.set(norm(d.name), { ...d, top, where: info.where });
    }
    const imported = new Set(Object.keys(scan.imports));
    const unused = file.kind === 'requirements' ? file.reqs.filter((r) => !used.has(norm(r.name))
      && !(scan.provides[r.name] || []).some((top) => imported.has(top))
      && !imported.has(r.name.replace(/-/g, '_'))) : [];
    return { target: file, missing: [...missing.values()].sort((a, b) => a.name.localeCompare(b.name)), unused };
  }

  // PEP 440: ~= and >= take no local label (2.3.0+cu121 -> 2.3.0), and ~= needs two release parts (5 -> >=5).
  function spec(p, form) {
    if (!form || !p.version) return p.name;
    if (form === '==') return `${p.name}==${p.version}`;
    const release = p.version.replace(/\+.*$/, '');
    return `${p.name}${form === '~=' && !/^\d+(\.\d+)+/.test(release) ? '>=' : form}${release}`;
  }

  // requirements.txt without the given requirements: their lines, with a line continued by a backslash. A line that
  // moved since the dependency check (the file edited while the scan ran) is found again by its text. A requirement
  // continued over lines is the line it starts on: its text begins with that line's.
  function withoutLines(text, reqs) {
    const lines = text.split(/\r?\n/);
    const drop = new Set();
    const head = (l) => l.replace(/\\\s*$/, '').trim();
    for (const r of reqs) {
      const starts = (l = '') => l.includes(r.raw) || (/\\\s*$/.test(l) && !!head(l) && r.raw.startsWith(head(l)));
      let i = starts(lines[r.line - 1]) ? r.line - 1 : lines.findIndex((l) => starts(l));
      if (i < 0) continue;
      drop.add(i);
      while (/\\\s*$/.test(lines[i] || '') && i + 1 < lines.length) drop.add(++i);
    }
    return lines.filter((_l, i) => !drop.has(i)).join(text.includes('\r\n') ? '\r\n' : '\n');
  }

  async function apply(file, add, remove, form) {
    const doc = ide.getDocument(file.path);
    let text = doc ? doc.model.getValue() : file.created ? '' : await ide.api.read(file.path);
    if (remove.length) text = withoutLines(text, remove);
    for (const p of add) text = await ide.api.invoke('packages:depsAdd', file.kind, text, spec(p, form));
    const tab = ide.findTab(file.path);
    if (doc && tab && ide.isDirty(tab)) {
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null);
    } else {
      await ide.api.write(file.path, text);
      if (doc) await ide.reloadFromDisk([file.path]);
      if (file.created) ide.refreshTree?.();
    }
    await ide.dependencies.check();
    // A package the code imports but the interpreter lacks fails at the next run: offer to install it right away.
    const absent = add.filter((p) => !p.version).map((p) => p.name);
    if (absent.length && ide.trusted !== false) {
      ide.notifications?.notify({
        title: tr('{file} updated', { file: basename(file.path) }),
        text: tr('Not installed in the project interpreter: {names}', { names: absent.join(', ') }), group: 'Python Packages', raw: true,
        actions: [{ label: absent.length === 1 ? tr("Install '{name}'", { name: absent[0] }) : tr('Install {count} packages', { count: absent.length }),
          run: (note) => { note.expire(); ide.dependencies.installSpecs(absent); } }],
      });
    }
  }

  function item(id, checked, label, detail, tip) {
    const r = el('label', 'reqsync-item');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.dataset.id = id;
    const name = el('span', 'reqsync-name', label);
    name.dataset.userText = '';
    r.append(box, name, el('span', 'reqsync-detail muted', detail));
    if (tip) r.title = tip;
    return { r, box };
  }

  async function open() {
    if (ide.trusted === false) return ide.ui.alert(ERRORS.untrusted());
    if (!ide.dependencies) return ide.ui.alert(tr('Sync Python Requirements needs the Python Packages plugin.'));
    let result;
    try {
      result = await compare();
    } catch (err) {
      return ide.ui.alert(tr('Could not read the imports of the project: {error}', { error: ide.util.errorText(err) }));
    }
    const { target: file, missing, unused } = result;
    const name = basename(file.path);
    if (!missing.length && !unused.length) {
      return ide.ui.alert(tr('{file} already lists every package the code imports.', { file: name }));
    }
    const body = el('div', 'reqsync');
    body.id = 'reqSync';
    const boxes = [];
    if (missing.length) {
      body.append(el('div', 'reqsync-title', tr('Imported but not in {file}', { file: name })));
      for (const p of missing) {
        const where = p.where.map(([f, line]) => `${f}:${line}`).join(', ');
        const { r, box } = item(`add:${p.name}`, true, p.name, p.version ? tr('installed {version}', { version: p.version }) : tr('not installed'), tr('import {module} in {where}', { module: p.top, where }));
        boxes.push({ box, add: p });
        body.append(r);
      }
    }
    if (unused.length) {
      body.append(el('div', 'reqsync-title', tr('In {file} but not imported', { file: name })));
      for (const req of unused) {
        const { r, box } = item(`remove:${req.name}`, false, req.raw, tr('remove'), tr('No import of the project uses it. A command-line tool or a plugin is used without an import, so check before removing it.'));
        boxes.push({ box, remove: req });
        body.append(r);
      }
    }
    const form = el('select', 'input');
    form.id = 'reqSyncForm';
    for (const [value, label] of FORMS) form.add(new Option(label(), value));
    form.value = ide.settings.get(VERSION, '~=');
    const formRow = el('label', 'reqsync-form');
    formRow.append(el('span', null, tr('Version:')), form);
    if (missing.length) body.append(formRow);
    if (file.created) body.append(el('div', 'reqsync-note muted', tr('The project has no requirements file; {file} is created.', { file: name })));
    ide.ui.dialog({
      title: tr('Sync Python Requirements'),
      body,
      width: 560,
      buttons: [
        { label: tr('Apply'), primary: true, run: async () => {
          const add = boxes.filter((b) => b.add && b.box.checked).map((b) => b.add);
          const remove = boxes.filter((b) => b.remove && b.box.checked).map((b) => b.remove);
          ide.settings.set(VERSION, form.value);
          if (add.length || remove.length) await apply(file, add, remove, form.value);
          return true;
        } },
        { label: tr('Cancel') },
      ],
    });
  }

  ide.registerAction({ id: 'SyncPythonRequirements', title: tr('Sync Python Requirements…'), needsProject: true, run: open });
  ide.packages?.addAction({ id: 'syncRequirements', icon: 'refresh', title: tr('Sync Python Requirements…'), run: open });
  ide.requirementsSync = { compare, open };
})();
