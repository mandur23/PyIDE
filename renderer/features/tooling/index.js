// Ruff integration: Reformat Code, Optimize Imports, lint diagnostics with quick fixes, actions on save.
(() => {
  const { el, basename } = ide.util;
  const monaco = ide.monaco;
  const isPy = (tab) => tab?.kind === 'file' && /\.pyi?$/i.test(tab.path) && !tab.model.isDisposed();
  const lintEnabled = () => ide.settings.get('tools.ruffOnSave', true);
  const opts = () => ({ root: ide.root, lineLength: Number(ide.settings.get('tools.ruffLineLength', 0)) || undefined });

  // ---------- editor hint (PyCharm shows a balloon after reformatting) ----------
  const hint = el('div', 'tooling-hint hidden');
  hint.id = 'toolingHint';
  document.getElementById('editorWrap').appendChild(hint);
  let hintTimer;
  function showHint(text, error) {
    hint.textContent = text;
    hint.classList.toggle('error', !!error);
    hint.classList.remove('hidden');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.add('hidden'), 4000);
  }

  // Replaces only the changed middle of the buffer as one undoable edit so the caret and folding mostly survive.
  function applyText(model, text) {
    const old = model.getValue();
    if (old === text) return 0;
    const n = Math.min(old.length, text.length);
    let s = 0;
    while (s < n && old[s] === text[s]) s++;
    let e = 0;
    while (e < n - s && old[old.length - 1 - e] === text[text.length - 1 - e]) e++;
    const range = monaco.Range.fromPositions(model.getPositionAt(s), model.getPositionAt(old.length - e));
    const edit = { range, text: text.slice(s, text.length - e), forceMoveMarkers: true };
    if (ide.editor.getModel() === model) {
      ide.editor.pushUndoStop();
      ide.editor.executeEdits('ruff', [edit]);
      ide.editor.pushUndoStop();
    } else {
      model.pushStackElement();
      model.pushEditOperations([], [edit], () => null);
      model.pushStackElement();
    }
    return Math.max(range.endLineNumber - range.startLineNumber + 1, edit.text.split('\n').length);
  }

  async function reformat(tab = ide.activeTab()) {
    if (!isPy(tab)) return showHint('Reformat Code works on Python files');
    const model = tab.model;
    const version = model.getVersionId();
    const sel = ide.editor.getModel() === model ? ide.editor.getSelection() : null;
    const range = sel && !sel.isEmpty() ? `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}` : undefined;
    const r = await ide.api.invoke('tooling:format', model.getValue(), tab.path, { ...opts(), range });
    if (model.isDisposed() || model.getVersionId() !== version) return;
    if (!r.ok) return showHint(`Cannot reformat: ${r.error}`, true);
    const lines = applyText(model, r.text);
    showHint(lines ? `Reformatted ${range ? 'selected text' : 'code'}: ${lines} line${lines === 1 ? '' : 's'} changed` : 'No lines changed: content is already properly formatted');
  }

  async function optimizeImports(tab = ide.activeTab()) {
    if (!isPy(tab)) return showHint('Optimize Imports works on Python files');
    const model = tab.model;
    const version = model.getVersionId();
    const r = await ide.api.invoke('tooling:optimizeImports', model.getValue(), tab.path, opts());
    if (model.isDisposed() || model.getVersionId() !== version) return;
    if (!r.ok) return showHint(`Cannot optimize imports: ${r.error}`, true);
    showHint(applyText(model, r.text) ? 'Imports optimized' : 'Unused imports not found');
  }

  async function fixAll(tab = ide.activeTab()) {
    if (!isPy(tab)) return;
    const model = tab.model;
    const version = model.getVersionId();
    const r = await ide.api.invoke('tooling:fixAll', model.getValue(), tab.path, opts());
    if (model.isDisposed() || model.getVersionId() !== version) return;
    if (!r.ok) return showHint(`Ruff fix failed: ${r.error}`, true);
    showHint(applyText(model, r.text) ? 'Applied ruff fixes' : 'Nothing to fix');
    lint(tab);
  }

  // Formats a file that is not open (project tree action), then lets open tabs pick up the change.
  async function onDisk(path, channel) {
    const text = await ide.api.read(path);
    const r = await ide.api.invoke(channel, text, path, opts());
    if (!r.ok) return showHint(r.error, true);
    if (r.text !== text) await ide.api.write(path, r.text);
    await ide.reloadFromDisk([path]);
    showHint(r.text !== text ? `${basename(path)} updated` : `${basename(path)}: nothing to change`);
  }

  // ---------- lint ----------
  const lintState = new Map(); // path lower -> {version, diags}
  const toProblem = (d) => ({
    line: d.location.row, col: d.location.column,
    endLine: d.end_location.row, endCol: d.end_location.column,
    msg: `${d.code} ${d.message}`, severity: 'warning',
  });

  async function lint(tab) {
    if (!isPy(tab) || !lintEnabled()) return null;
    const model = tab.model;
    const version = model.getVersionId();
    const diags = (await ide.api.invoke('tooling:check', model.getValue(), tab.path, opts())).filter((d) => d.code);
    if (model.isDisposed() || model.getVersionId() !== version || !ide.findTab(tab.path)) return null;
    const state = { version, diags };
    lintState.set(tab.path.toLowerCase(), state);
    ide.problems.set('ruff', tab.path, diags.map(toProblem));
    return state;
  }

  const lintTimers = new Map();
  function lintSoon(tab, ms = 700) {
    clearTimeout(lintTimers.get(tab.path));
    lintTimers.set(tab.path, setTimeout(() => lint(tab), ms));
  }

  const formatting = new Set();
  ide.on('fileSaved', async (tab) => {
    if (!isPy(tab)) return;
    if (ide.settings.get('tools.formatOnSave', false) && !formatting.has(tab.path)) {
      formatting.add(tab.path);
      try {
        const version = tab.model.getVersionId();
        const r = await ide.api.invoke('tooling:format', tab.model.getValue(), tab.path, opts());
        if (r.ok && !tab.model.isDisposed() && tab.model.getVersionId() === version && applyText(tab.model, r.text)) {
          await ide.saveTab(tab);
          ide.renderTabs();
        }
      } finally { formatting.delete(tab.path); }
    }
    lint(tab);
  });
  ide.on('fileOpened', (tab) => {
    if (!isPy(tab)) return;
    lint(tab);
    tab.model.onDidChangeContent(() => lintEnabled() && lintSoon(tab));
  });
  ide.on('fileClosed', (path) => {
    lintState.delete(path.toLowerCase());
    clearTimeout(lintTimers.get(path));
    ide.problems.set('ruff', path, []);
  });
  ide.on('settingsChanged', (key) => {
    if (key === 'tools.ruffOnSave' && !lintEnabled()) { lintState.clear(); ide.problems.clear('ruff'); return; }
    if (key === 'tools.ruffOnSave' || key === 'tools.ruffLineLength') ide.tabs.filter(isPy).forEach((t) => lint(t));
  });

  // ---------- quick fixes (shown by Monaco's lightbulb / Alt+Enter menu alongside other providers) ----------
  function noqaEdit(model, d) {
    const line = d.noqa_row || d.location.row;
    const text = model.getLineContent(line);
    const existing = /#\s*noqa(?::\s*([A-Z]+[0-9]+(?:[,\s]+[A-Z]+[0-9]+)*))?/i.exec(text);
    if (existing && !existing[1]) return null; // blanket noqa already suppresses everything
    if (existing) {
      const end = existing.index + existing[0].length + 1;
      return { range: new monaco.Range(line, end, line, end), text: `, ${d.code}` };
    }
    const col = model.getLineMaxColumn(line);
    const trimmed = text.replace(/\s+$/, '').length + 1;
    return { range: new monaco.Range(line, trimmed, line, col), text: `  # noqa: ${d.code}` };
  }

  monaco.editor.registerCommand('tooling.ruffFixAll', () => fixAll());

  monaco.languages.registerCodeActionProvider('python', {
    // Synchronous on purpose: stale results return nothing, and the pending lint's marker update makes Monaco ask again.
    provideCodeActions(model, range, context) {
      const tab = ide.tabs.find((t) => t.model === model);
      const state = isPy(tab) && lintEnabled() && lintState.get(tab.path.toLowerCase());
      if (!state || state.version !== model.getVersionId()) {
        if (state) lintSoon(tab, 0);
        return { actions: [], dispose() {} };
      }
      // Narrowest diagnostic first, so the preferred fix is the one under the caret rather than e.g. a whole-block I001.
      const span = (d) => (d.end_location.row - d.location.row) * 1e4 + d.end_location.column - d.location.column;
      const hits = state.diags
        .filter((d) => d.location.row <= range.endLineNumber && d.end_location.row >= range.startLineNumber)
        .sort((a, b) => span(a) - span(b));
      const actions = [];
      const markersFor = (d) => context.markers.filter((m) => m.source === 'ruff' && m.startLineNumber === d.location.row && m.message.startsWith(d.code));
      for (const d of hits) {
        if (d.fix?.edits?.length) {
          actions.push({
            title: `Fix with ruff: ${d.fix.message || d.message} (${d.code})${d.fix.applicability === 'unsafe' ? ' [unsafe]' : ''}`,
            kind: 'quickfix',
            diagnostics: markersFor(d),
            isPreferred: actions.length === 0,
            edit: {
              edits: d.fix.edits.map((e) => ({
                resource: model.uri,
                versionId: model.getVersionId(),
                textEdit: { range: new monaco.Range(e.location.row, e.location.column, e.end_location.row, e.end_location.column), text: e.content || '' },
              })),
            },
          });
        }
      }
      for (const d of hits) {
        const textEdit = noqaEdit(model, d);
        if (!textEdit) continue;
        actions.push({
          title: `Suppress ${d.code} with # noqa`,
          kind: 'quickfix',
          diagnostics: markersFor(d),
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit }] },
        });
      }
      if (state.diags.filter((d) => d.fix).length > 1 && hits.length) {
        actions.push({ title: 'Fix all ruff problems in file', kind: 'quickfix', command: { id: 'tooling.ruffFixAll', title: 'Fix all ruff problems in file' } });
      }
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  // ---------- actions ----------
  ide.registerAction({ id: 'ReformatCode', title: 'Reformat Code', keys: 'Ctrl+Alt+L', run: () => reformat() });
  ide.registerAction({ id: 'OptimizeImports', title: 'Optimize Imports', keys: 'Ctrl+Alt+O', run: () => optimizeImports() });
  ide.registerAction({ id: 'RuffFixAll', title: 'Fix All Ruff Problems in File', run: () => fixAll() });
  const pyFile = (e) => !e.dir && /\.pyi?$/i.test(e.name);
  ide.registerTreeAction({ title: 'Reformat Code', hint: 'Ctrl+Alt+L', when: pyFile, run: (e) => (ide.findTab(e.path) ? reformat(ide.findTab(e.path)) : onDisk(e.path, 'tooling:format')) });
  ide.registerTreeAction({ title: 'Optimize Imports', hint: 'Ctrl+Alt+O', when: pyFile, run: (e) => (ide.findTab(e.path) ? optimizeImports(ide.findTab(e.path)) : onDisk(e.path, 'tooling:optimizeImports')) });

  ide.tooling = { reformat, optimizeImports, fixAll, lint };
})();
