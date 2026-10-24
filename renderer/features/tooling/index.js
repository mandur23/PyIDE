// Ruff integration: Reformat Code, Optimize Imports, lint diagnostics with quick fixes, reformat and optimize imports on save.
(() => {
  const { el, basename } = ide.util;
  const monaco = ide.monaco;
  const isPy = (tab) => tab?.kind === 'file' && /\.pyi?$/i.test(tab.path) && !tab.model.isDisposed();
  const lintEnabled = () => ide.settings.get('tools.ruffOnSave', true);
  const opts = () => ({ root: ide.root, lineLength: Number(ide.settings.get('tools.ruffLineLength', 0)) || undefined });

  // ---------- editor hint (PyCharm shows a balloon after reformatting) ----------
  const hint = el('div', 'tooling-hint hidden');
  hint.id = 'toolingHint';
  document.getElementById('editorArea').appendChild(hint);
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

  // Whole strings per case, so each language can phrase the count and the plural its own way.
  const reformattedText = (selection, count) => tr(selection
    ? (count === 1 ? 'Reformatted selected text: {count} line changed' : 'Reformatted selected text: {count} lines changed')
    : (count === 1 ? 'Reformatted code: {count} line changed' : 'Reformatted code: {count} lines changed'), { count });

  async function reformat(tab = ide.activeTab()) {
    if (!isPy(tab)) return showHint(tr('Reformat Code works on Python files'));
    const model = tab.model;
    const version = model.getVersionId();
    const sel = ide.editor.getModel() === model ? ide.editor.getSelection() : null;
    const range = sel && !sel.isEmpty() ? `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}` : undefined;
    const r = await ide.api.invoke('tooling:format', model.getValue(), tab.path, { ...opts(), range });
    if (model.isDisposed() || model.getVersionId() !== version) return;
    if (!r.ok) return showHint(tr('Cannot reformat: {error}', { error: r.error }), true);
    const lines = applyText(model, r.text);
    showHint(lines ? reformattedText(!!range, lines) : tr('No lines changed: content is already properly formatted'));
  }

  async function optimizeImports(tab = ide.activeTab()) {
    if (!isPy(tab)) return showHint(tr('Optimize Imports works on Python files'));
    const model = tab.model;
    const version = model.getVersionId();
    const r = await ide.api.invoke('tooling:optimizeImports', model.getValue(), tab.path, opts());
    if (model.isDisposed() || model.getVersionId() !== version) return;
    if (!r.ok) return showHint(tr('Cannot optimize imports: {error}', { error: r.error }), true);
    showHint(applyText(model, r.text) ? tr('Imports optimized') : tr('Unused imports not found'));
  }

  async function fixAll(tab = ide.activeTab()) {
    if (!isPy(tab)) return;
    const model = tab.model;
    const version = model.getVersionId();
    const r = await ide.api.invoke('tooling:fixAll', model.getValue(), tab.path, opts());
    if (model.isDisposed() || model.getVersionId() !== version) return;
    if (!r.ok) return showHint(tr('Ruff fix failed: {error}', { error: r.error }), true);
    showHint(applyText(model, r.text) ? tr('Applied ruff fixes') : tr('Nothing to fix'));
    lint(tab);
  }

  // Formats a file that is not open (project tree action), then lets open tabs pick up the change. The file is read
  // and written in its own encoding, so a CP949 file keeps its Korean text.
  async function onDisk(path, channel) {
    const failed = (error) => showHint(tr(channel === 'tooling:format' ? 'Cannot reformat: {error}' : 'Cannot optimize imports: {error}', { error }), true);
    try {
      const file = await ide.api.invoke('fs:readText', path);
      if (file.text === undefined) return;
      const r = await ide.api.invoke(channel, file.text, path, opts());
      if (!r.ok) return failed(r.error);
      if (r.text !== file.text) await ide.api.invoke('fs:writeText', path, r.text, file.encoding);
      await ide.reloadFromDisk([path]);
      showHint(tr(r.text !== file.text ? '{name} updated' : '{name}: nothing to change', { name: basename(path) }));
    } catch (err) {
      failed(ide.util.errorText(err));
    }
  }

  // ---------- lint ----------
  const lintState = new Map(); // path lower -> {version, diags}
  const toProblem = (d) => ({
    line: d.location.row, col: d.location.column,
    endLine: d.end_location.row, endCol: d.end_location.column,
    msg: `${d.code} ${d.message}`, severity: 'warning',
  });

  // Ruff that cannot check at all (a configuration it cannot read, ruff.exe blocked) is one problem, on the
  // configuration file at the place ruff names, else on the file being checked; before, every file just looked clean.
  let failure = null; // {path, error} of the problem shown for it
  function setFailure(tab, r) {
    const next = r && { path: r.config || tab.path, error: r.error };
    if (failure && failure.path.toLowerCase() !== next?.path.toLowerCase()) ide.problems.set('ruff', failure.path, []);
    if (next && next.error !== failure?.error) showHint(tr('Ruff cannot check Python files: {error}', { error: next.error }), true);
    failure = next;
    if (next) ide.problems.set('ruff', next.path, [{ line: r.line || 1, col: r.col || 1, msg: tr('Ruff cannot check Python files: {error}', { error: r.error }), severity: 'error' }]);
  }

  async function lint(tab) {
    if (!isPy(tab) || !lintEnabled()) return null;
    const model = tab.model;
    const version = model.getVersionId();
    const r = await ide.api.invoke('tooling:check', model.getValue(), tab.path, opts());
    if (model.isDisposed() || model.getVersionId() !== version || !ide.findTab(tab.path)) return null;
    const diags = Array.isArray(r) ? r.filter((d) => d.code) : [];
    const state = { version, diags };
    lintState.set(tab.path.toLowerCase(), state);
    if (!Array.isArray(r)) {
      if ((r.config || tab.path).toLowerCase() !== tab.path.toLowerCase()) ide.problems.set('ruff', tab.path, []);
      setFailure(tab, r);
      return state;
    }
    setFailure(tab, null);
    ide.problems.set('ruff', tab.path, diags.map(toProblem));
    return state;
  }

  const lintTimers = new Map();
  // Each lint sends the whole buffer to ruff. A file larger than this (in characters) is linted when it opens and when
  // it is saved, not after every pause in typing.
  const LINT_WHILE_TYPING_MAX = 2 * 1024 * 1024;
  function lintSoon(tab, ms = 700) {
    clearTimeout(lintTimers.get(tab.path));
    if (tab.model.getValueLength() > LINT_WHILE_TYPING_MAX) return;
    lintTimers.set(tab.path, setTimeout(() => lint(tab), ms));
  }

  // Actions on Save: the core runs them on the text being saved (explicit and auto saves) and applies the result as
  // one undo step. A file ruff cannot parse is saved as it is.
  const onSave = (key, channel) => async (text, ctx) => {
    if (!/\.pyi?$/i.test(ctx.path) || !ide.settings.get(key, false)) return undefined;
    const r = await ide.api.invoke(channel, text, ctx.path, opts());
    return r.ok ? r.text : undefined;
  };
  ide.registerSaveAction({ id: 'optimizeImports', order: 30, run: onSave('tools.optimizeImportsOnSave', 'tooling:optimizeImports') });
  ide.registerSaveAction({ id: 'reformat', order: 40, run: onSave('tools.formatOnSave', 'tooling:format') });

  ide.on('fileSaved', (tab) => { if (isPy(tab)) lint(tab); });
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
    if (key === 'tools.ruffOnSave' && !lintEnabled()) { lintState.clear(); failure = null; ide.problems.clear('ruff'); return; }
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
            title: tr(d.fix.applicability === 'unsafe' ? 'Fix with ruff: {message} ({code}) [unsafe]' : 'Fix with ruff: {message} ({code})', { message: d.fix.message || d.message, code: d.code }),
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
      // One # noqa action per line and code (a name used twice on a line gives two diagnostics, one comment).
      const suppressed = new Set();
      for (const d of hits) {
        const textEdit = noqaEdit(model, d);
        if (!textEdit || suppressed.has(`${d.location.row}:${d.code}`)) continue;
        suppressed.add(`${d.location.row}:${d.code}`);
        actions.push({
          title: tr('Suppress {code} for line with # noqa', { code: d.code }),
          kind: 'quickfix',
          diagnostics: markersFor(d),
          edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit }] },
        });
      }
      if (state.diags.filter((d) => d.fix).length > 1 && hits.length) {
        actions.push({ title: tr('Fix all ruff problems in file'), kind: 'quickfix', command: { id: 'tooling.ruffFixAll', title: tr('Fix all ruff problems in file') } });
      }
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  // ---------- actions ----------
  ide.registerAction({ id: 'ReformatCode', title: tr('Reformat Code'), keys: 'Ctrl+Alt+L', run: () => reformat() });
  ide.registerAction({ id: 'OptimizeImports', title: tr('Optimize Imports'), keys: 'Ctrl+Alt+O', run: () => optimizeImports() });
  ide.registerAction({ id: 'RuffFixAll', title: tr('Fix All Ruff Problems in File'), run: () => fixAll() });
  const pyFile = (e) => !e.dir && /\.pyi?$/i.test(e.name);
  // The hints follow the keymap: the tree reads them each time its menu opens.
  ide.registerTreeAction({ title: tr('Reformat Code'), keyAction: 'ReformatCode', when: pyFile, run: (e) => (ide.findTab(e.path) ? reformat(ide.findTab(e.path)) : onDisk(e.path, 'tooling:format')) });
  ide.registerTreeAction({ title: tr('Optimize Imports'), keyAction: 'OptimizeImports', when: pyFile, run: (e) => (ide.findTab(e.path) ? optimizeImports(ide.findTab(e.path)) : onDisk(e.path, 'tooling:optimizeImports')) });

  ide.tooling = { reformat, optimizeImports, fixAll, lint };
})();
