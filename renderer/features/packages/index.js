// Python Packages tool window: pip list / install / upgrade / uninstall for the current interpreter. Nothing runs pip
// except list until the user clicks.
// Project dependencies: the requirements of requirements*.txt, pyproject.toml and Pipfile checked against the
// interpreter, shown as warnings on their lines, an editor banner with Install, and a summary in the tool window.
(() => {
  const { el, samePath } = ide.util;
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  // Package names and versions are user data, not UI text.
  const userText = (n) => { n.dataset.userText = ''; return n; };
  let packages = [];
  let selected = null;
  let busy = false;
  let search, listEl, details, con, interpLabel, depsRow, notes;
  // Extension points for other plugins (ide.packages below): row marks, details sections, toolbar actions.
  const rowDecorators = [];
  const detailSections = [];
  const extraActions = [];
  const baseActions = [{ icon: '⟳', title: tr('Refresh'), run: () => { refresh(); checkDeps({ fresh: true }); } }];

  const tw = ide.registerToolWindow({
    id: 'PythonPackages', title: tr('Python Packages'), icon: '📦', side: 'bottom', order: 60,
    mount(container, tw) {
      const root = el('div', 'pkgs');
      const left = el('div', 'pkgs-left');
      search = el('input', 'input pkgs-search');
      search.id = 'pkgSearch';
      search.placeholder = tr('Search or type a package name to install');
      search.oninput = renderList;
      search.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const q = search.value.trim();
        const hit = packages.find((p) => norm(p.name) === norm(q));
        if (hit) select(hit.name); else if (q) install(q);
      };
      interpLabel = el('div', 'pkgs-interp muted');
      depsRow = el('div', 'pkgs-deps hidden');
      depsRow.id = 'depsSummary';
      notes = el('div', 'pkgs-notes');
      listEl = el('div', 'list pkgs-list');
      listEl.id = 'pkgList';
      left.append(search, interpLabel, depsRow, notes, listEl);
      const right = el('div', 'pkgs-right');
      details = el('div', 'pkgs-details');
      details.id = 'pkgDetails';
      const out = el('div', 'pkgs-out');
      con = ide.ui.console(out);
      con.out.id = 'pkgOut';
      right.append(details, out);
      root.append(left, right);
      container.appendChild(root);
      tw.setActions([...baseActions, ...extraActions]);
    },
  });

  let seq = 0;
  async function refresh() {
    const interp = ide.currentInterp();
    interpLabel.textContent = interp ? tr('Installed in {interpreter}', { interpreter: interp.label }) : tr('No interpreter');
    const my = ++seq;
    if (!interp) { packages = []; renderList(); return; }
    listEl.replaceChildren(el('div', 'list-row muted', tr('Loading…')));
    const r = await ide.api.invoke('packages:list', interp);
    if (my !== seq) return;
    packages = r.ok ? r.packages.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : [];
    if (!r.ok) con.append(`${r.error}\n`, 'err'); // pip's own stderr
    if (selected && !packages.some((p) => norm(p.name) === norm(selected))) selected = null;
    renderList();
    renderDetails();
    if (r.ok) ide.emit('packagesListed', { interp, packages });
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    listEl.replaceChildren();
    const shown = packages.filter((p) => !q || p.name.toLowerCase().includes(q));
    for (const p of shown) {
      const row = el('div', 'list-row pkg-row' + (selected && norm(selected) === norm(p.name) ? ' selected' : ''));
      row.dataset.name = p.name;
      row.append(userText(el('span', 'pkg-name', p.name)), userText(el('span', 'pkg-ver', p.version)));
      row.onclick = () => select(p.name);
      for (const fn of rowDecorators) fn(row, p);
      listEl.appendChild(row);
    }
    if (q && !packages.some((p) => norm(p.name) === norm(q))) {
      const row = el('div', 'list-row pkg-install-row');
      row.id = 'pkgInstallRow';
      row.append(el('span', null, tr("Install '{name}'", { name: search.value.trim() })), el('span', 'pkg-ver', tr('from PyPI')));
      row.onclick = () => install(search.value.trim());
      listEl.appendChild(row);
    } else if (!shown.length) listEl.appendChild(el('div', 'list-row muted', tr('No packages')));
  }

  function select(name) {
    selected = name;
    renderList();
    renderDetails();
  }

  function renderDetails() {
    details.replaceChildren();
    const p = selected && packages.find((x) => norm(x.name) === norm(selected));
    if (!p) { details.appendChild(el('div', 'muted', tr('Select a package to see actions'))); return; }
    const head = el('div', 'pkg-title');
    head.append(userText(el('span', null, p.name)), userText(el('span', 'pkg-ver', p.version)));
    const btns = el('div', 'pkg-buttons');
    const upgrade = el('button', 'secondary', tr('Upgrade'));
    upgrade.id = 'pkgUpgrade';
    const remove = el('button', 'secondary', tr('Uninstall'));
    remove.id = 'pkgUninstall';
    upgrade.disabled = remove.disabled = busy;
    upgrade.onclick = () => runPip('packages:upgrade', p.name);
    remove.onclick = () => ide.ui.dialog({
      title: tr('Uninstall Package'),
      body: el('div', null, tr("Uninstall '{name}' {version} from {interpreter}?", { name: p.name, version: p.version, interpreter: ide.currentInterp()?.label })),
      width: 420,
      buttons: [{ label: tr('Uninstall'), primary: true, run: () => { runPip('packages:uninstall', p.name); } }, { label: tr('Cancel') }],
    });
    btns.append(upgrade, remove);
    const target = ide.root && !declared(p.name) && requirementsTarget();
    if (target) {
      const add = el('button', 'secondary', tr('Add to requirements'));
      add.id = 'pkgAddReq';
      add.title = tr('Add {requirement} to {file}', { requirement: pinned(p), file: ide.util.basename(target.path) });
      add.onclick = () => addToRequirements(p, target);
      btns.appendChild(add);
    }
    details.append(head, btns);
    for (const fn of detailSections) { const n = fn(p, { busy }); if (n) details.appendChild(n); }
  }

  function install(spec) {
    const name = spec.split(/[<>=!~\[; ]/)[0];
    selected = /[\\/]/.test(name) ? null : name;
    return runPip('packages:install', spec);
  }

  // Console headers per pip command, as whole sentences so a translation can order the words freely.
  const MESSAGES = {
    'packages:install': { start: 'Installing {name} into {interpreter}', done: 'Installed {name}', failed: 'Failed to install {name} (exit code {code})' },
    'packages:upgrade': { start: 'Upgrading {name} in {interpreter}', done: 'Upgraded {name}', failed: 'Failed to upgrade {name} (exit code {code})' },
    'packages:uninstall': { start: 'Uninstalling {name} from {interpreter}', done: 'Uninstalled {name}', failed: 'Failed to uninstall {name} (exit code {code})' },
  };

  async function runPip(channel, arg) {
    const interp = ide.currentInterp();
    if (!interp || busy) return;
    const msg = MESSAGES[channel];
    await runInConsole(tr(msg.start, { name: arg, interpreter: interp.label }), async () => ({ id: await ide.api.invoke(channel, interp, arg) }), async (code) => {
      con.append(`\n${code === 0 ? tr(msg.done, { name: arg }) : tr(msg.failed, { name: arg, code })}\n`, code === 0 ? 'ok' : 'err');
      if (code === 0 && channel === 'packages:install') search.value = '';
    });
  }

  // Runs a process in the tool window's console, then lists the packages and checks the dependencies again.
  // start() -> {id, command?} | {error}; exit(code) writes the closing line.
  async function runInConsole(header, start, exit) {
    busy = true;
    renderDetails();
    renderBusy();
    con.clear();
    con.append(`${header}\n`, 'sys');
    let r;
    try { r = await start(); } catch (err) { r = { error: err.message }; }
    if (r.error) {
      busy = false;
      con.append(`${r.error}\n`, 'err');
      renderDetails();
      renderBusy();
      return;
    }
    if (r.command) con.append(`> ${r.command}\n`, 'sys'); // the command line is user data
    ide.proc.attach(r.id, {
      data: (text, stream) => con.append(text, stream === 'err' && !/^\s*(WARNING|DEPRECATION)/.test(text) ? 'err' : null),
      async exit(code) {
        busy = false;
        await exit(code);
        await Promise.all([refresh(), checkDeps({ fresh: true })]);
      },
    });
  }

  ide.on('interpreterChanged', () => {
    selected = null;
    if (tw.isVisible()) refresh(); else packages = [];
    checkDeps();
  });
  ide.on('toolWindowShown', (id) => id === 'PythonPackages' && refresh());

  // ---------- project dependencies ----------
  const SOURCE = 'dependencies';
  const DEP_FILE = /(^|[\\/])(requirements[^\\/]*\.txt|pyproject\.toml|pipfile)$/i;
  const EMPTY = { manager: 'pip', tool: null, files: [] };
  let deps = EMPTY; // last packages:deps result
  let flagged = new Set(); // paths with problems set
  let depsSeq = 0;

  const unsatisfied = (f) => f.reqs.filter((r) => r.status !== 'ok');
  const depFile = (path) => path && deps.files.find((f) => samePath(f.path, path));
  const tabOf = (model) => model && ide.tabs.find((t) => t.kind === 'file' && t.model === model);
  const declared = (name) => deps.files.some((f) => f.reqs.some((r) => norm(r.name) === norm(name)));
  const toolMissing = () => !!deps.tool && !deps.tool.path;
  const countText = (n) => (n === 1 ? tr('1 package not installed / outdated') : tr('{count} packages not installed / outdated', { count: n }));

  // Checks the project's dependency files against the current interpreter; unsaved editor text counts.
  async function checkDeps({ fresh = false } = {}) {
    const my = ++depsSeq;
    const root = ide.root;
    if (!root) { deps = EMPTY; applyDeps(); return deps; }
    const texts = {};
    for (const t of ide.tabs) if (t.kind === 'file' && DEP_FILE.test(t.path) && ide.isDirty(t)) texts[t.path] = t.model.getValue();
    let r;
    try { r = await ide.api.invoke('packages:deps', root, ide.currentInterp() || null, { texts, fresh }); } catch (err) { r = { ...EMPTY, error: err.message }; }
    if (my !== depsSeq) return deps;
    deps = r;
    if (r.error) ide.log.warn(`dependencies: ${r.error}`);
    applyDeps();
    ide.emit('dependenciesChecked', deps);
    return deps;
  }
  let checkTimer = null;
  const checkSoon = (ms = 600) => { clearTimeout(checkTimer); checkTimer = setTimeout(() => checkDeps(), ms); };

  function problemText(r) {
    if (r.status === 'missing') return tr("Package '{name}' is not installed", { name: r.name });
    return tr("Package requirement '{requirement}' is not satisfied: {version} is installed", { requirement: r.raw, version: r.installed });
  }

  const problemsOf = (f) => unsatisfied(f).map((r) => ({ line: r.line, col: r.col, endCol: r.endCol, msg: problemText(r), severity: 'warning' }));
  function applyDeps() {
    const next = new Set();
    for (const f of deps.files) {
      const items = problemsOf(f);
      if (items.length) next.add(f.path);
      ide.problems.set(SOURCE, f.path, items);
    }
    for (const p of flagged) if (![...next].some((n) => samePath(n, p))) ide.problems.set(SOURCE, p, []);
    flagged = next;
    renderBusy();
  }
  function renderBusy() {
    renderDeps();
    for (const b of banners.values()) b.render();
  }

  // The tool window's summary row and badge.
  function renderDeps() {
    const files = deps.files.filter((f) => unsatisfied(f).length);
    const count = new Set(files.flatMap((f) => unsatisfied(f).map((r) => norm(r.name)))).size;
    tw.setBadge(count ? String(count) : '');
    if (!depsRow) return;
    depsRow.classList.toggle('hidden', !count);
    depsRow.replaceChildren();
    if (!count) return;
    const text = el('span', 'pkgs-deps-text', `⚠ ${countText(count)} `);
    text.appendChild(userText(el('span', 'muted', [...new Set(files.flatMap((f) => unsatisfied(f).map((r) => r.name)))].join(', '))));
    text.onclick = () => ide.openFile(files[0].path, { line: unsatisfied(files[0])[0].line });
    const btn = el('button', 'link', tr('Install'));
    btn.id = 'depsSummaryInstall';
    btn.disabled = busy;
    btn.onclick = () => installDeps(files[0]);
    depsRow.append(text, btn);
  }

  // Installs a file's requirements with the project's manager (pip -r, uv sync / uv pip install, poetry install).
  // specs: only these requirement strings (a quick fix); pip: use pip even in a uv or Poetry project.
  async function installDeps(f, { specs, pip = false } = {}) {
    const interp = ide.currentInterp();
    if (!f || !interp || busy) return;
    const names = specs ? specs.join(' ') : ide.util.basename(f.path);
    tw.show();
    await runInConsole(tr('Installing {name} into {interpreter}', { name: names, interpreter: interp.label }),
      () => ide.api.invoke('packages:depsInstall', ide.root, interp, { file: f.path, kind: f.kind, specs, pip, unsatisfied: unsatisfied(f).map((r) => r.raw) }),
      async (code) => con.append(`\n${code === 0 ? tr('Installed {name}', { name: names }) : tr('Failed to install {name} (exit code {code})', { name: names, code })}\n`, code === 0 ? 'ok' : 'err'));
  }

  // "Add to requirements": requirements.txt first, then [project].dependencies, else a new requirements.txt.
  function requirementsTarget() {
    return deps.files.find((f) => f.kind === 'requirements')
      || deps.files.find((f) => f.kind === 'pyproject' && f.editable)
      || { path: ide.util.joinPath(ide.root, 'requirements.txt'), kind: 'requirements', created: true };
  }
  const pinned = (p) => (/^\d+(\.\d+)+/.test(p.version) ? `${p.name}~=${p.version}` : `${p.name}>=${p.version}`);

  async function addToRequirements(p, target) {
    const doc = ide.getDocument(target.path);
    const text = doc ? doc.model.getValue() : target.created ? '' : await ide.api.read(target.path);
    const next = await ide.api.invoke('packages:depsAdd', target.kind, text, pinned(p));
    const tab = ide.findTab(target.path);
    if (doc && tab && ide.isDirty(tab)) {
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: next }], () => null);
    } else {
      await ide.api.write(target.path, next);
      if (doc) await ide.reloadFromDisk([target.path]);
      if (target.created) ide.refreshTree();
    }
    await checkDeps();
    renderDetails();
  }

  // ---------- editor banner ----------
  // A bar above the editor of a dependency file, like PyCharm's editor notifications. It sits in the editor
  // group's body and pushes the editor down, so nothing is covered; embedded editors get none.
  const banners = new Map(); // editor -> {render}
  ide.onEditor((editor) => {
    const host = editor.getContainerDomNode();
    if (!host.classList.contains('editor-host') || !host.parentElement) return undefined;
    const bar = el('div', 'deps-banner hidden');
    host.parentElement.insertBefore(bar, host);
    const setTop = (px) => {
      if (host.style.top === (px ? `${px}px` : '')) return;
      host.style.top = px ? `${px}px` : '';
      editor.layout();
    };
    const render = () => {
      const tab = tabOf(editor.getModel());
      const f = depFile(tab?.path);
      const bad = f ? unsatisfied(f) : [];
      const usesTool = f && toolMissing() && (f.kind === 'pyproject' || deps.manager === 'uv');
      if (!bad.length || host.classList.contains('hidden')) {
        bar.classList.add('hidden');
        bar.replaceChildren();
        setTop(0);
        return;
      }
      bar.classList.remove('hidden');
      const text = el('span', 'deps-banner-text', countText(bad.length));
      const list = userText(el('span', 'deps-banner-names', bad.map((r) => r.name).join(', ')));
      const actions = el('span', 'deps-banner-actions');
      const button = (label, id, run) => {
        const b = el('a', 'deps-banner-link', label);
        b.dataset.action = id;
        b.onclick = () => { if (!busy) run(); };
        actions.appendChild(b);
      };
      if (busy) actions.appendChild(el('span', 'muted', tr('Installing…')));
      else if (usesTool) {
        text.textContent = `${countText(bad.length)}. ${tr('This project uses {tool}, but {tool} was not found.', { tool: deps.tool.name })}`;
        if (deps.tool.name === 'uv' && ide.installer) button(tr('Install uv…'), 'install-tool', () => ide.installer.open('python'));
        button(tr('Install with pip'), 'install-pip', () => installDeps(f, { pip: true }));
      } else button(tr('Install'), 'install', () => installDeps(f));
      bar.replaceChildren(el('span', 'deps-banner-icon', '⚠'), text, list, actions);
      setTop(bar.offsetHeight);
    };
    banners.set(editor, { render });
    const subs = [editor.onDidChangeModel(render), editor.onDidDispose(() => { banners.delete(editor); bar.remove(); })];
    render();
    return () => { subs.forEach((s) => s.dispose()); banners.delete(editor); bar.remove(); setTop(0); };
  });
  // A custom tab hides the editor host without changing its model.
  ide.on('activeTabChanged', () => { for (const b of banners.values()) b.render(); });

  // ---------- quick fix: Install <package> ----------
  const { monaco } = ide;
  const INSTALL_ONE = 'pyide.packages.installRequirement';
  monaco.editor.registerCommand(INSTALL_ONE, (_accessor, path, raw) => installDeps(depFile(path), { specs: [raw], pip: deps.manager === 'poetry' }));
  const provider = {
    provideCodeActions(model, range, context) {
      const f = depFile(tabOf(model)?.path);
      if (!f) return undefined;
      const actions = unsatisfied(f).filter((r) => r.line >= range.startLineNumber && r.line <= range.endLineNumber).map((r) => ({
        title: tr('Install {name}', { name: r.name }),
        kind: 'quickfix',
        isPreferred: true,
        diagnostics: context.markers.filter((m) => m.source === SOURCE && m.startLineNumber === r.line),
        command: { id: INSTALL_ONE, title: tr('Install {name}', { name: r.name }), arguments: [f.path, r.raw] },
      }));
      return { actions, dispose() {} };
    },
  };
  for (const lang of ['plaintext', 'ini']) monaco.languages.registerCodeActionProvider(lang, provider);
  // Alt+Enter outside Python (the lsp feature's Alt+Enter is for Python files).
  const depFileFocused = () => !!ide.editor?.hasTextFocus() && !!depFile(tabOf(ide.editor.getModel())?.path);
  ide.registerAction({ id: 'ShowDependencyActions', title: tr('Show Context Actions'), keys: 'Alt+Enter', when: depFileFocused, run: () => ide.editor.trigger('packages', 'editor.action.quickFix', null) });

  // ---------- when to check ----------
  ide.on('projectOpened', () => checkDeps());
  ide.on('projectClosed', () => { deps = EMPTY; applyDeps(); });
  ide.on('fileSaved', (tab) => { if (DEP_FILE.test(tab.path)) checkDeps(); });
  // Problems become markers when they are set; a file opened later gets its markers here.
  ide.on('fileOpened', (tab) => { const f = depFile(tab.path); if (f) ide.problems.set(SOURCE, f.path, problemsOf(f)); });
  ide.on('filesChanged', (c) => {
    const paths = [...(c.created || []), ...(c.deleted || []), ...(c.renamed || []).flat()].filter((p) => typeof p === 'string');
    if (paths.some((p) => DEP_FILE.test(p) || /(^|[\\/])(uv|poetry)\.lock$/i.test(p))) checkDeps();
  });
  ide.onEditor((editor) => editor.onDidChangeModelContent(() => {
    if (DEP_FILE.test(tabOf(editor.getModel())?.path || '')) checkSoon();
  }));
  // The uv item of the Install Manager installs uv next to the interpreter; check again once it is there.
  ide.on('installablesChanged', () => { if (toolMissing()) checkSoon(1500); });
  // Back from a terminal or another program: packages may have changed (read again at most every 20 s).
  let lastFresh = 0;
  window.addEventListener('focus', () => {
    if (!deps.files.length || busy) return;
    const fresh = Date.now() - lastFresh > 20000;
    if (fresh) lastFresh = Date.now();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => checkDeps({ fresh }), 300);
  });
  if (ide.root) checkDeps();

  ide.dependencies = { check: checkDeps, state: () => deps, install: (path, opts) => installDeps(depFile(path), opts) };
  // The Python Packages window for other plugins (vulnerabilities). Event packagesListed({interp, packages}) follows
  // every successful listing, dependenciesChecked(state) every dependency check.
  ide.packages = {
    list: () => packages,
    busy: () => busy,
    toolWindow: tw,
    notes: () => notes,
    install,
    select,
    render: () => { renderList(); renderDetails(); },
    decorateRow: (fn) => { rowDecorators.push(fn); renderList(); },
    addDetails: (fn) => { detailSections.push(fn); renderDetails(); },
    addAction: (action) => { extraActions.push(action); tw.setActions([...baseActions, ...extraActions]); },
  };
})();
