// PyCharm's code-generating quick fixes and intentions under Alt+Enter (Create function, class or local variable for
// an undefined name; Add method to class for an unresolved method call; Implement abstract methods on a class header;
// Convert to f-string literal on a `%` or `.format` string) and Code › Override Methods… (Ctrl+O) and Implement
// Methods… with a chooser. The refactor plugin's sidecar (refactor_server.py) writes the code with Python's own ast;
// Pyright, through ide.lsp and ide.typeHierarchy, resolves what lives in other files: the class of a receiver and the
// base classes. Edits apply through ide.refactor.applyResult, so each one is a single undo step.
(() => {
  const refactor = ide.refactor;
  if (!refactor) return;
  const { el, samePath, isUnder } = ide.util;
  const monaco = ide.monaco;
  const isPy = (p) => /\.py$/i.test(p || '');
  // file:///c%3A/x.py -> C:\x.py; file://server/share/x.py (UNC) -> \\server\share\x.py
  const toPath = (uri) => decodeURIComponent(String(uri).replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '//'))
    .replace(/\//g, '\\').replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  const IDENTIFIER = /^[\p{ID_Start}_][\p{ID_Continue}]*$/u;
  // Code, names and paths are data, not UI text (verify/i18n-lib.mjs skips them).
  const userText = (node) => ((node.dataset.userText = ''), node);
  const FIX_CODES = new Set(['reportUndefinedVariable', 'reportAttributeAccessIssue']);

  const MESSAGES = {
    'no-class': () => tr('Caret should be inside a class.'),
    'not-convertible': () => tr('The string cannot be converted to an f-string literal.'),
  };
  const errorText = (err) => MESSAGES[err?.code]?.() || refactor.errorText(err);
  const fail = (err) => {
    if (!err?.code) console.error(err);
    refactor.hint(errorText(err));
  };

  const fileTabOf = (model) => (model ? ide.tabs.find((t) => t.kind === 'file' && t.model === model) : null);
  function pythonFile(model) {
    const tab = fileTabOf(model);
    return tab && isPy(tab.path) && ide.root && isUnder(tab.path, ide.root) && ide.currentInterp() ? tab.path : null;
  }

  // Applies a sidecar result as one undo step, then puts the caret where the result says (selecting the word there
  // for `pass` or `None`, as PyCharm does), opening the file when the code went into another one.
  async function applyAndPlace(result, label) {
    const { place, ...rest } = result;
    await refactor.applyResult(rest, label);
    if (!place) return;
    const tab = ide.activeTab();
    if (!tab || !samePath(tab.path, place.path)) await ide.openFile(place.path, { line: place.line, col: place.col });
    const ed = ide.editor;
    const model = ed?.getModel();
    if (!model || !samePath(fileTabOf(model)?.path || '', place.path)) return;
    const pos = { lineNumber: place.line, column: place.col };
    const word = place.select ? model.getWordAtPosition(pos) : null;
    ed.setSelection(word ? new monaco.Range(place.line, word.startColumn, place.line, word.endColumn) : monaco.Range.fromPositions(pos));
    ed.revealPositionInCenterIfOutsideViewport(pos);
    ed.focus();
  }

  // ---------- Alt+Enter ----------
  const TITLES = {
    createFunction: (f) => tr("Create function '{name}'", f),
    createClass: (f) => tr("Create class '{name}'", f),
    createVariable: (f) => tr("Create local variable '{name}'", f),
    addMethod: (f) => tr('Add method {name}() to class {cls}', { name: f.name, cls: f.owner.name }),
    implementAbstract: () => tr('Implement abstract methods'),
    fstring: () => tr('Convert to f-string literal'),
  };

  // The edit being written and applied, for tests that must not move the caret before the result has placed it.
  let busy = Promise.resolve();
  const track = (p) => { busy = p; return p; };

  async function runFix(file, fix) {
    if (fix.kind === 'implementAbstract') return chooseMethods('implement', { file, pos: fix.at });
    try {
      await track(refactor.call('generate', { file, fix }).then((result) => applyAndPlace(result, TITLES[fix.kind](fix))));
    } catch (err) {
      fail(err);
    }
  }
  const COMMAND = 'pyide.codeGeneration.fix';
  monaco.editor.registerCommand(COMMAND, (_accessor, file, fix) => runFix(file, fix));

  // Pyright's diagnostics on the lines of the request, with ranges as the sidecar reads them (1-based, UTF-16 columns).
  function diagnosticsOn(path, range) {
    return (ide.lsp?.diagnostics(path) || [])
      .filter((d) => FIX_CODES.has(d.code) && d.range.start.line + 1 <= range.endLineNumber && d.range.end.line + 1 >= range.startLineNumber)
      .map((d) => ({
        code: d.code, message: d.message,
        range: { startLine: d.range.start.line + 1, startCol: d.range.start.character + 1, endLine: d.range.end.line + 1, endCol: d.range.end.character + 1 },
      }));
  }

  // The class an expression's value is an instance of, when it is a class in a project source file.
  async function receiverClass(model, at, token) {
    if (!ide.lsp) return null;
    const locs = await ide.lsp.request('textDocument/typeDefinition', {
      textDocument: { uri: model.uri.toString() }, position: { line: at.line - 1, character: at.col - 1 },
    }, token);
    for (const loc of [].concat(locs || [])) {
      const path = toPath(loc.targetUri || loc.uri);
      const r = loc.targetSelectionRange || loc.range;
      if (!r || !isPy(path) || !isUnder(path, ide.root) || /[\\/]site-packages[\\/]/i.test(path)) continue;
      const doc = ide.getDocument?.(path)?.model;
      const text = doc && !doc.isDisposed() ? doc.getValue() : await ide.api.read(path).catch(() => '');
      const name = (text.split(/\r?\n/)[r.start.line] || '').slice(r.start.character, r.end.character);
      if (IDENTIFIER.test(name)) return { path, line: r.start.line + 1, name };
    }
    return null;
  }

  monaco.languages.registerCodeActionProvider('python', {
    async provideCodeActions(model, range, context, token) {
      if (context.trigger !== monaco.languages.CodeActionTriggerType.Invoke) return undefined;
      const file = pythonFile(model);
      if (!file) return undefined;
      const pos = range.getStartPosition();
      const diagnostics = diagnosticsOn(file, range);
      let fixes;
      try {
        ({ fixes } = await refactor.call('quickFixes', { file, pos: { line: pos.lineNumber, col: pos.column }, diagnostics }));
      } catch {
        return undefined;
      }
      const actions = [];
      for (const fix of fixes) {
        if (token.isCancellationRequested) return undefined;
        if (fix.kind === 'addMethod' && !fix.owner) {
          const owner = await receiverClass(model, fix.receiver, token).catch(() => null);
          if (!owner) continue;
          fix.owner = owner;
        }
        if (fix.kind === 'implementAbstract') {
          const members = await membersFor(file, fix.at).catch(() => null);
          if (!members?.methods.some((m) => m.abstract)) continue;
        }
        // A fix for a diagnostic is tied to Pyright's marker and preferred, as the proper fix: Monaco then lists it
        // above the suppress actions (ruff's "# noqa" included), as PyCharm does, and after lsp's import, which is
        // preferred too and comes from a later provider.
        const d = diagnostics.find((x) => x.range.startLine === fix.at.line && x.range.startCol === fix.at.col);
        const markers = d ? context.markers.filter((m) => m.source === 'pyright' && m.message === d.message) : [];
        actions.push({
          title: TITLES[fix.kind](fix), kind: 'quickfix', diagnostics: markers.length ? markers : undefined, isPreferred: !!markers.length,
          command: { id: COMMAND, title: TITLES[fix.kind](fix), arguments: [file, fix] },
        });
      }
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  // ---------- Override Methods / Implement Methods ----------
  // The class around `pos` and its base classes as a graph for the sidecar: [{path, line, name, module, bases}], the
  // class itself first. Pyright finds each base's definition (ide.typeHierarchy.supertypes); object is left out, the
  // sidecar always ends the MRO with it. Without the type-hierarchy plugin only object's methods are offered.
  async function classGraph(file, pos) {
    const own = await refactor.call('classEntry', { file, pos });
    const model = ide.getDocument?.(file)?.model;
    const uri = model ? model.uri.toString() : monaco.Uri.file(file).toString();
    const start = { line: own.line - 1, character: own.col - 1 };
    const root = { name: own.name, uri, selectionRange: { start, end: { line: start.line, character: start.character + own.name.length } } };
    const classes = [{ path: file, line: own.line, name: own.name, module: '', bases: [] }];
    const th = ide.typeHierarchy;
    if (!th?.supertypes) return classes;
    const index = new Map([[`${ide.util.pathKey(file)}:${own.line}`, 0]]);
    const queue = [[root, 0]];
    while (queue.length && classes.length < 50) {
      const [item, i] = queue.shift();
      for (const { item: base } of await th.supertypes(item).catch(() => [])) {
        if (base.leaf || !base.uri) continue;
        const path = toPath(base.uri);
        const line = base.selectionRange.start.line + 1;
        if (base.name === 'object' && /builtins\.pyi$/i.test(path)) continue;
        const k = `${ide.util.pathKey(path)}:${line}`;
        if (!index.has(k)) {
          index.set(k, classes.push({ path, line, name: base.name, module: base.detail || '', bases: [] }) - 1);
          queue.push([base, index.get(k)]);
        }
        classes[i].bases.push(index.get(k));
      }
    }
    return classes;
  }

  async function membersFor(file, pos) {
    const classes = await classGraph(file, pos);
    const { methods } = await refactor.call('classMembers', { file, classes });
    return { classes, methods };
  }

  // PyCharm's member chooser: the methods grouped by the class that defines them, each with a checkbox. Resolves to
  // the chosen names, or null.
  function chooser(mode, methods) {
    return new Promise((resolve) => {
      const body = el('div', 'cg-chooser');
      const list = el('div', 'cg-list');
      body.appendChild(list);
      const boxes = [];
      let owner = null;
      for (const m of methods) {
        if (m.owner !== owner) {
          owner = m.owner;
          const head = el('div', 'cg-owner');
          head.append(userText(el('span', 'cg-owner-name', m.owner)));
          if (m.module) head.appendChild(userText(el('span', 'muted cg-owner-module', m.module)));
          list.appendChild(head);
        }
        const row = el('label', 'cg-method');
        row.dataset.name = m.name;
        const box = el('input');
        box.type = 'checkbox';
        box.checked = mode === 'implement' && m.abstract;
        row.append(box, userText(el('code', 'cg-signature', m.signature)));
        list.appendChild(row);
        boxes.push(box);
      }
      let picked = null;
      const title = mode === 'implement' ? tr('Select Methods to Implement') : tr('Select Methods to Override');
      const dlg = ide.ui.dialog({
        title, body, width: 560,
        buttons: [
          { label: tr('OK'), primary: true, run: () => { picked = boxes.filter((b) => b.checked).map((b) => b.closest('.cg-method').dataset.name); } },
          { label: tr('Cancel') },
        ],
        onClose: () => resolve(picked?.length ? picked : null),
      });
      dlg.el.id = 'cgChooser';
      dlg.el.dataset.mode = mode;
      const ok = dlg.el.querySelector('.dialog-buttons .primary');
      const sync = () => { ok.disabled = !boxes.some((b) => b.checked); };
      list.addEventListener('change', sync);
      // Up/Down move between methods, Ctrl+A checks them all; Space checks one and Enter confirms (the dialog's own).
      list.addEventListener('keydown', (e) => {
        const i = boxes.indexOf(document.activeElement);
        if (i < 0) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          boxes[Math.max(0, Math.min(boxes.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
        } else if (e.key === 'a' && e.ctrlKey) {
          e.preventDefault();
          const all = !boxes.every((b) => b.checked);
          for (const b of boxes) b.checked = all;
          sync();
        }
      });
      sync();
      (boxes.find((b) => b.checked) || boxes[0])?.focus();
    });
  }

  async function chooseMethods(mode, at) {
    const ed = ide.editor;
    const target = at || (() => {
      const file = pythonFile(ed?.getModel());
      const p = ed?.getPosition();
      return file && p ? { file, pos: { line: p.lineNumber, col: p.column } } : null;
    })();
    if (!target) return;
    try {
      const { classes, methods } = await membersFor(target.file, target.pos);
      const offered = mode === 'implement' ? methods.filter((m) => m.abstract) : methods;
      if (!offered.length) {
        refactor.hint(mode === 'implement' ? tr('No methods to implement have been found') : tr('No methods to override have been found'));
        return;
      }
      const names = await chooser(mode, offered);
      if (!names) return;
      await track(refactor.call('insertMethods', { file: target.file, pos: target.pos, classes, names, mode })
        .then((result) => applyAndPlace(result, mode === 'implement' ? tr('Implement Methods') : tr('Override Methods'))));
    } catch (err) {
      fail(err);
    }
  }

  const editorPython = () => !!ide.editor?.hasTextFocus() && !!pythonFile(ide.editor.getModel());
  ide.registerAction({ id: 'OverrideMethods', title: tr('Override Methods…'), keys: 'Ctrl+O', context: 'editor', when: editorPython, run: () => chooseMethods('override') });
  ide.registerAction({ id: 'ImplementMethods', title: tr('Implement Methods…'), context: 'editor', when: editorPython, run: () => chooseMethods('implement') });

  // For tests.
  ide.codeGeneration = { classGraph, members: membersFor, settled: () => busy };
})();
