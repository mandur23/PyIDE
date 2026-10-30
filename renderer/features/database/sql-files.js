// Project SQL files with a data source, as in PyCharm and DataGrip: a .sql file of the open project can be attached to a
// data source (and to one of its schemas when it has several) from the status bar widget, the editor's context menu or
// Find Action. The file then completes like a console of that source (completion.js, through completionHost.consoleFor),
// and Ctrl+Enter runs the statement at the caret or the selection through the console's result view, shown in the
// Query Results tool window. Attachments are kept per project in settings (`database.sqlFiles.<project>`: the file's
// path relative to the project, with `/`, -> {source, schema?}); they follow renames and moves made in the IDE, and go
// with a deleted file or a removed data source. Files outside the open project get nothing. In Safe Mode a statement
// from the project runs only after the user confirms it in a dialog that shows it.
(() => {
  const { el, basename, samePath, isUnder, joinPath, pathKey } = ide.util;
  const host = ide.database.fileHost;
  const userEl = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  const KEY_PREFIX = 'database.sqlFiles.';

  // ---------- attachments ----------
  const keyOf = (root) => `${KEY_PREFIX}${root}`;
  const attachments = () => (ide.root && ide.settings.get(keyOf(ide.root), {})) || {};
  const absOf = (rel) => joinPath(ide.root, rel.replace(/\//g, '\\'));
  const relOf = (path) => path.slice(ide.root.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
  const inProject = (path) => !!ide.root && !!path && isUnder(path, ide.root) && !samePath(path, ide.root);
  const sqlSource = (s) => !!s && host.uiOf(s.kind).language === 'sql';

  const isSqlModel = (model) => !!model && !model.isDisposed() && model.uri.scheme === 'file' && model.getLanguageId() === 'sql';
  const pathOf = (model) => ide.tabs.find((t) => t.model === model)?.path || model.uri.fsPath;
  const projectSqlPath = (model) => { const p = isSqlModel(model) && pathOf(model); return p && inProject(p) ? p : null; };

  const entryKey = (path) => Object.keys(attachments()).find((rel) => samePath(absOf(rel), path)) || null;
  // {source, schema?} for a project file whose data source still exists, else null.
  function attachmentOf(path) {
    if (!inProject(path)) return null;
    const k = entryKey(path);
    const a = k && attachments()[k];
    return a && typeof a.source === 'string' && sqlSource(host.sourceOf(a.source)) ? a : null;
  }
  function setAttachment(path, value) {
    const all = { ...attachments() };
    const k = entryKey(path);
    if (k) delete all[k];
    if (value) all[relOf(path)] = value;
    ide.settings.set(keyOf(ide.root), all);
    refresh();
  }

  // ---------- choosing a data source ----------
  async function chooseSchema(source, current) {
    const tree = await ide.database.completionHost.tree(source.id);
    const names = tree.filter((n) => Array.isArray(n.children) && n.kind !== 'info').map((n) => n.name);
    if (names.length < 2) return null;
    const pick = await ide.ui.pick({
      placeholder: tr('Choose a schema of {name}', { name: source.name }),
      items: [
        { label: tr('Default schema'), hint: current?.source === source.id && !current.schema ? '✓' : '', value: { schema: null } },
        ...names.map((n) => ({ label: n, icon: '▤', hint: current?.source === source.id && current.schema === n ? '✓' : '', value: { schema: n } })),
      ],
    });
    return pick ? pick.schema : undefined;
  }

  // The data source picker for a project SQL file; resolves the new attachment, or null (detached, cancelled, none).
  async function choose(path) {
    await host.loaded;
    if (!inProject(path)) {
      ide.ui.alert(tr('Open a SQL file of the project to attach a data source to it.'));
      return null;
    }
    const current = attachmentOf(path);
    const sources = ide.database.list().filter(sqlSource);
    const pick = await ide.ui.pick({
      placeholder: tr('Data source for {name}', { name: basename(path) }),
      items: [
        ...sources.map((s) => ({ label: s.name, detail: host.driverOf(s.kind)?.label || s.kind, icon: '⛁', hint: current?.source === s.id ? '✓' : '', value: { source: s } })),
        { label: tr('<No data source>'), hint: current ? '' : '✓', value: { detach: true } },
        { label: tr('New Data Source…'), icon: '+', value: { add: true } },
      ],
    });
    if (!pick) return null;
    if (pick.add) { host.newDataSource(); return null; }
    if (pick.detach) { setAttachment(path, null); return null; }
    const schema = await chooseSchema(pick.source, current);
    if (schema === undefined || !inProject(path)) return null;
    setAttachment(path, { source: pick.source.id, ...(schema ? { schema } : {}) });
    return attachmentOf(path);
  }

  const activeSqlPath = () => { const t = ide.activeTab(); return t?.kind === 'file' && t.model ? projectSqlPath(t.model) : null; };
  const chooseForActive = () => choose(activeSqlPath());

  // ---------- status bar widget ----------
  const item = el('span', 'db-sql-status hidden');
  item.id = 'statusSqlSource';
  item.title = tr('Data source of this SQL file');
  item.onclick = () => { const p = activeSqlPath(); if (p) choose(p); };
  ide.registerStatusItem({ order: 50, el: item });
  function renderStatus() {
    const path = activeSqlPath();
    item.classList.toggle('hidden', !path);
    if (!path) return item.replaceChildren();
    const a = attachmentOf(path);
    const s = a && host.sourceOf(a.source);
    item.classList.toggle('attached', !!s);
    item.replaceChildren(el('span', 'db-sql-status-icon', '⛁'),
      s ? userEl('span', 'db-sql-status-name', a.schema ? `${s.name} · ${a.schema}` : s.name) : el('span', 'db-sql-status-none', tr('<No data source>')),
      el('span', 'db-sql-status-arrow', '▾'));
  }

  // ---------- Query Results tool window ----------
  const views = new Map(); // pathKey -> {path, view, el, file, source}
  let shown = null;
  let body = null;
  const placeholder = ide.keymap.text(el('div', 'db-placeholder muted'),
    () => tr('Statements run from SQL files show their results here. {action} runs the statement at the caret, or the selection.', { action: ide.keymap.withKeys(tr('Execute'), 'Database.RunStatement') }));
  const tw = ide.registerToolWindow({
    id: 'DatabaseResults', title: tr('Query Results'), icon: '▦', iconName: 'database', side: 'bottom', order: 56,
    mount(container) { container.classList.add('db-file-results'); body = container; renderResults(); },
  });
  function renderEntry(entry) {
    const a = attachmentOf(entry.path);
    const s = a && host.sourceOf(a.source);
    entry.file.textContent = inProject(entry.path) ? relOf(entry.path) : entry.path;
    entry.source.textContent = s ? `${s.name}${a.schema ? ` · ${a.schema}` : ''} · ${host.driverOf(s.kind)?.label || s.kind}` : '';
  }
  function renderResults() {
    if (!body) return;
    if (shown && !views.has(pathKey(shown.path))) shown = null;
    if (shown) renderEntry(shown);
    body.replaceChildren(shown ? shown.el : placeholder);
  }
  function entryFor(path) {
    const k = pathKey(path);
    if (views.has(k)) return views.get(k);
    const entry = { path };
    entry.view = host.resultView(() => attachmentOf(entry.path)?.source || null);
    entry.el = el('div', 'db-file-result');
    const bar = el('div', 'db-console-bar');
    entry.file = userEl('span', 'db-file-result-name');
    entry.source = userEl('span', 'db-console-source');
    bar.append(el('span', 'db-icon', '⛁'), entry.file, entry.source);
    entry.el.append(bar, entry.view.el);
    views.set(k, entry);
    return entry;
  }
  const showEntry = (entry) => { shown = entry; renderResults(); };

  // ---------- running ----------
  function confirmSafeMode(path, source, statements) {
    return new Promise((resolve) => {
      let yes = false;
      const msg = el('div', 'db-safe-run');
      msg.append(el('div', 'dialog-message', tr('This project is open in Safe Mode. Run the statements below from {file} on {source}?', { file: basename(path), source: source.name })),
        userEl('pre', 'db-safe-statements', statements.join(';\n')));
      ide.ui.dialog({
        title: tr('Run Statements from an Untrusted Project?'), body: msg, width: 560, onClose: () => resolve(yes),
        buttons: [{ label: tr('Cancel'), primary: true }, { label: tr('Run'), run: () => { yes = true; } }],
      });
    });
  }

  // Ctrl+Enter in a project SQL file: the statement at the caret or the selection, on the attached data source (one is
  // chosen first when there is none). Resolves the result, or null when nothing ran.
  async function runAtCaret(ed) {
    const model = ed.getModel();
    const path = projectSqlPath(model);
    if (!path) return null;
    let a = attachmentOf(path);
    if (!a) {
      a = await choose(path);
      if (!a || ed.getModel() !== model || model.isDisposed()) return null;
      ed.focus();
    }
    const source = host.sourceOf(a.source);
    const mode = host.uiOf(source.kind).statementSeparator;
    const part = host.partToRun(ed, mode);
    const statements = part ? host.runnable(part.text, mode).map((s) => s.text) : [];
    if (!statements.length) return null;
    if (ide.trusted === false && !(await confirmSafeMode(path, source, statements))) return null;
    if (!model.isDisposed() && ed.getModel() === model) host.flashRange(ed, part.from, part.to);
    const entry = entryFor(path);
    showEntry(entry);
    tw.show();
    return (await entry.view.execute(statements)) || null;
  }

  // ---------- editor context menu ----------
  const contextUpdates = new Set();
  ide.onEditor((ed) => {
    const key = ed.createContextKey('databaseSqlFile', false);
    const update = () => key.set(!!projectSqlPath(ed.getModel()));
    contextUpdates.add(update);
    ed.onDidDispose(() => contextUpdates.delete(update));
    ed.onDidChangeModel(update);
    ed.onDidChangeModelLanguage(() => { update(); renderStatus(); });
    update();
    ed.addAction({ id: 'database.attachDataSource', label: tr('Attach Data Source…'), contextMenuGroupId: '9_database', precondition: 'databaseSqlFile', run: () => choose(projectSqlPath(ed.getModel())) });
  });

  function refresh() {
    for (const update of contextUpdates) update();
    renderStatus();
    renderResults();
  }

  ide.registerAction({ id: 'Database.AttachDataSource', title: tr('Database: Attach Data Source…'), run: chooseForActive });

  // ---------- keeping attachments ----------
  ide.on('filesChanged', (e) => {
    if (!ide.root) return;
    const all = { ...attachments() };
    let dirty = false;
    for (const [from, to] of e?.renamed || []) {
      for (const rel of Object.keys(all)) {
        const abs = absOf(rel);
        if (!isUnder(abs, from)) continue;
        const moved = to + abs.slice(from.replace(/[\\/]+$/, '').length);
        const value = all[rel];
        delete all[rel];
        if (inProject(moved)) all[relOf(moved)] = value;
        dirty = true;
      }
      for (const [k, entry] of [...views]) {
        if (!isUnder(entry.path, from)) continue;
        views.delete(k);
        entry.path = to + entry.path.slice(from.replace(/[\\/]+$/, '').length);
        views.set(pathKey(entry.path), entry);
      }
    }
    for (const gone of e?.deleted || []) {
      for (const rel of Object.keys(all)) if (isUnder(absOf(rel), gone)) { delete all[rel]; dirty = true; }
      for (const [k, entry] of [...views]) if (isUnder(entry.path, gone)) views.delete(k);
    }
    if (dirty) ide.settings.set(keyOf(ide.root), all);
    refresh();
  });

  // A removed data source leaves no attachment behind, in any project.
  function sourceRemoved(id) {
    for (const [key, value] of Object.entries(ide.settings.all())) {
      if (!key.startsWith(KEY_PREFIX) || !value || typeof value !== 'object') continue;
      const kept = Object.fromEntries(Object.entries(value).filter(([, a]) => a?.source !== id));
      if (Object.keys(kept).length !== Object.keys(value).length) ide.settings.set(key, kept);
    }
    refresh();
  }

  ide.on('activeTabChanged', (tab) => {
    renderStatus();
    const entry = tab?.path && views.get(pathKey(tab.path));
    if (entry && entry !== shown) showEntry(entry);
  });
  ide.on('projectOpened', () => { views.clear(); shown = null; refresh(); });
  ide.on('projectClosed', () => { views.clear(); shown = null; refresh(); });
  ide.on('dataSourcesChanged', refresh);
  host.loaded.then(refresh);

  ide.database.sqlFiles = {
    // The completion context of a project SQL file with an attached data source (completionHost.consoleFor's shape).
    contextFor(model) {
      const path = projectSqlPath(model);
      const a = path && attachmentOf(path);
      const source = a && host.sourceOf(a.source);
      if (!source) return null;
      const driver = host.driverOf(source.kind);
      return { id: source.id, source, driver, ui: host.uiOf(source.kind), completion: driver?.ui?.completion || null, schema: a.schema || null, path };
    },
    // The editor with the keyboard when it shows a project SQL file (Database.RunStatement's Ctrl+Enter).
    focusedEditor: () => ide.editors().find((ed) => ed.hasTextFocus() && projectSqlPath(ed.getModel())) || null,
    runAtCaret,
    choose,
    attachmentOf,
    attach: (path, source, schema = null) => (inProject(path) && sqlSource(host.sourceOf(source)) ? (setAttachment(path, { source, ...(schema ? { schema } : {}) }), true) : false),
    detach: (path) => { if (inProject(path)) setAttachment(path, null); },
    sourceRemoved,
    results: (path) => views.get(pathKey(path))?.view || null,
    toolWindow: tw,
  };
})();
