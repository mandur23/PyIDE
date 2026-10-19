// PyCharm's refactorings: Extract Variable/Constant/Method/Parameter, Inline, Change Signature and Move, with a
// preview before applying and one undo step per refactoring across every file it changed.
// The engine is rope, run by refactor_server.py in the project interpreter (main/features/refactor.js).
(() => {
  const { el, basename, joinPath, samePath, isUnder } = ide.util;
  const monaco = ide.monaco;
  const LF = monaco.editor.EndOfLinePreference.LF;
  const isPy = (p) => /\.pyi?$/i.test(p || '');
  const norm = (text) => text.replace(/\r\n?/g, '\n');
  const rel = (p) => ide.util.rel(p);
  // Code, names and paths are data, not UI text (verify/i18n-lib.mjs skips them).
  const userText = (node) => ((node.dataset.userText = ''), node);

  // ---------- the sidecar ----------
  function overlay() {
    const out = {};
    for (const t of ide.tabs) {
      if (t.kind === 'file' && isPy(t.path) && t.model && !t.model.isDisposed() && ide.isDirty(t)) out[t.path] = t.model.getValue(LF);
    }
    return out;
  }

  class RefactorError extends Error {
    constructor(code, params = {}, message = code) {
      super(message);
      Object.assign(this, { code, params });
    }
  }

  async function call(method, params) {
    const interp = ide.currentInterp();
    if (!interp) throw new RefactorError('no-interpreter');
    if (!ide.root) throw new RefactorError('outside-project');
    const r = await ide.api.invoke('refactor:call', { cmd: interp.cmd, args: interp.args || [], executable: interp.executable },
      method, { root: ide.root, overlay: overlay(), ...params });
    if (r.error) throw new RefactorError(r.error.code, r.error.params || {}, r.error.message);
    return r.result;
  }

  // Every message is a complete entry in the locale files.
  const MESSAGES = {
    'no-interpreter': () => tr('No project interpreter. Choose one in Settings › Python Interpreter.'),
    'no-rope': () => tr('Refactoring needs the rope library in the project interpreter.'),
    'outside-project': () => tr('The file is not inside the project.'),
    'syntax-error': (p) => tr('The file has syntax errors (line {line}).', p),
    'not-expression': () => tr('Cannot perform refactoring using selected element(s).'),
    'not-extractable': () => tr('The selected code cannot be extracted.'),
    'uses-local': (p) => tr("The expression uses local variable '{name}'.", p),
    'not-in-function': () => tr('The selected expression is not inside a function body.'),
    'select-code': () => tr('Select a code fragment to extract.'),
    'invalid-name': (p) => tr("'{name}' is not a valid identifier", p),
    'name-exists': (p) => tr("'{name}' is already defined in this scope.", p),
    'no-inline-target': () => tr('Caret should be positioned at a local variable, function or method to inline.'),
    'assigned-more-than-once': () => tr('The variable is assigned more than once, so it cannot be inlined.'),
    'no-target': () => tr('Cannot perform refactoring using selected element(s).'),
    'no-function': () => tr('Caret should be positioned at the name of a function or method.'),
    'dest-not-python': () => tr('The destination must be a Python file.'),
    'dest-not-folder': () => tr('The destination must be a folder.'),
    'same-destination': () => tr('The destination is the same as the source.'),
    'dest-exists': (p) => tr('{name} already exists in the destination.', p),
    'result-syntax': (p) => tr('The result would not be valid Python (line {line}).', p),
    nothing: () => tr('Nothing to change.'),
    encoding: () => tr('Only UTF-8 files can be refactored.'),
    stale: (p) => tr('{name} changed while the refactoring was prepared. Try again.', p),
    'empty-name': () => tr('Enter a name.'),
  };
  const errorText = (err) => {
    const m = MESSAGES[err?.code];
    if (m) return m(err.params || {});
    if (err?.code === 'rope') return tr('rope could not perform the refactoring: {detail}', { detail: err.params?.detail || err.message });
    if (err?.code === 'sidecar') return tr('The refactoring process stopped: {detail}', { detail: err.message });
    return tr('Refactoring failed: {detail}', { detail: err?.message || String(err) });
  };

  // ---------- errors and the rope install offer ----------
  function hint(text) {
    const ed = ide.editor;
    const ctl = ed?.getContribution('editor.contrib.messageController');
    if (ctl && ed.getPosition()) ctl.showMessage(text, ed.getPosition());
    else ide.ui.dialog({ title: tr('Cannot Perform Refactoring'), body: el('div', 'rf-message', text) });
  }
  const cannot = (err) => tr('Cannot perform refactoring. {reason}', { reason: errorText(err) });

  let ropeItem = null;
  function installItem() {
    if (ropeItem || !ide.installer?.pip) return ropeItem;
    ropeItem = ide.installer.pip({ package: 'rope', name: 'rope', description: tr('Python refactoring library behind Extract, Inline, Change Signature and Move.') });
    ide.installer.register(ropeItem);
    return ropeItem;
  }
  ide.on('installablesChanged', () => { if (!ropeItem && ide.installer?.pip) installItem(); });

  function offerRope(retry) {
    const item = installItem();
    const python = ide.currentInterp()?.executable || '';
    const body = el('div', 'rf-install');
    body.append(el('div', 'rf-message', tr('Refactoring needs the rope library in the project interpreter.')),
      userText(el('div', 'muted rf-python', python)));
    const log = el('pre', 'rf-install-log hidden');
    const status = el('div', 'rf-error');
    body.append(status, log);
    const buttons = [];
    if (item) {
      buttons.push({
        label: tr('Install rope'), primary: true,
        run: async (dlg) => {
          setBusy(dlg, true);
          log.classList.remove('hidden');
          status.textContent = tr('Installing rope…');
          const write = (t) => { log.textContent = (log.textContent + t).slice(-8000); log.scrollTop = log.scrollHeight; };
          const logger = (t) => write(String(t).endsWith('\n') ? String(t) : `${t}\n`);
          logger.raw = write;
          try {
            await item.install(logger, () => {}, new AbortController().signal);
          } catch (e) {
            setBusy(dlg, false);
            status.textContent = tr('Could not install rope: {error}', { error: String(e?.message || e) });
            return false;
          }
          ide.installer.refresh?.();
          dlg.close();
          retry?.();
          return false;
        },
      });
    }
    buttons.push({ label: tr('Cancel') });
    const dlg = ide.ui.dialog({ title: tr('Install rope'), body, width: 520, buttons });
    dlg.el.id = 'rfInstallDialog';
    return dlg;
  }

  // Runs a step that talks to the sidecar from an editor action: errors become an editor hint.
  async function guarded(fn, retry) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code === 'no-rope') offerRope(retry);
      else if (err instanceof RefactorError || err?.code) hint(cannot(err));
      else { console.error(err); hint(cannot(err)); }
      return null;
    }
  }

  // ---------- dialogs ----------
  function setBusy(dlg, busy) {
    for (const b of dlg.el.querySelectorAll('.dialog-buttons button')) b.disabled = busy;
    dlg.el.classList.toggle('rf-busy', busy);
  }

  function field(label, input) {
    const row = el('label', 'field');
    row.append(el('span', null, label), input);
    return row;
  }
  function textInput(value, cls = '') {
    const i = el('input', `input ${cls}`.trim());
    i.value = value ?? '';
    i.spellcheck = false;
    return i;
  }
  function checkRow(label, checked, cls) {
    const row = el('label', `rf-check ${cls || ''}`.trim());
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    row.append(input, el('span', null, label));
    row.input = input;
    return row;
  }

  // A refactoring dialog: Preview, Refactor and Cancel. collect() returns the request or throws a RefactorError,
  // shown inside the dialog, which stays open.
  function refactorDialog({ title, body, width = 520, id, collect, method, label }) {
    const err = el('div', 'rf-error');
    body.appendChild(err);
    let dlg;
    const go = async (wantPreview) => {
      err.textContent = '';
      let result;
      try {
        const params = collect();
        setBusy(dlg, true);
        result = await call(method, params);
      } catch (e) {
        setBusy(dlg, false);
        if (e?.code === 'no-rope') { dlg.close(); offerRope(); return false; }
        err.textContent = e?.code ? errorText(e) : String(e?.message || e);
        if (!e?.code) console.error(e);
        return false;
      }
      dlg.close();
      await finish(result, typeof label === 'function' ? label() : label, wantPreview);
      return false;
    };
    dlg = ide.ui.dialog({
      title, body, width,
      buttons: [
        { label: tr('Preview'), run: () => go(true) },
        { label: tr('Refactor'), primary: true, run: () => go(false) },
        { label: tr('Cancel') },
      ],
    });
    dlg.el.classList.add('rf-dialog');
    if (id) dlg.el.id = id;
    const [preview, refactor, cancel] = dlg.el.querySelectorAll('.dialog-buttons button');
    preview.dataset.action = 'preview';
    refactor.dataset.action = 'refactor';
    cancel.dataset.action = 'cancel';
    const first = body.querySelector('input.input');
    if (first) { first.focus(); first.select(); }
    return dlg;
  }

  // Applies a result, through the preview when asked for or when the refactoring reported problems.
  async function finish(result, label, wantPreview) {
    if (wantPreview || result.warnings?.length) {
      if (!(await preview(result, label))) return false;
    }
    try {
      await applyResult(result, label);
      return true;
    } catch (e) {
      if (e?.code) hint(cannot(e)); else { console.error(e); hint(cannot(e)); }
      return false;
    }
  }

  // ---------- preview ----------
  const WARNINGS = {
    'param-used': (p) => tr("Parameter '{name}' is used in the function body.", p),
    'no-value': (p) => tr("New parameter '{name}' has neither a default value nor a value for calls.", p),
  };

  let previewSeq = 0;
  function preview(result, label) {
    return new Promise((resolve) => {
      const body = el('div', 'rf-preview');
      if (result.warnings?.length) {
        const warn = el('div', 'rf-warnings');
        warn.appendChild(el('div', 'rf-warnings-title', tr('Problems detected')));
        for (const w of result.warnings) warn.appendChild(el('div', 'rf-warning', (WARNINGS[w.code] || (() => w.code))(w)));
        body.appendChild(warn);
      }
      const summary = el('div', 'muted rf-summary', fileCount(result.changes.length + (result.moves?.length || 0)));
      const panes = el('div', 'rf-panes');
      const list = el('div', 'rf-files');
      list.id = 'rfPreviewFiles';
      const diffHost = el('div', 'rf-diff');
      panes.append(list, diffHost);
      body.append(summary, panes);

      const seq = ++previewSeq;
      const models = [];
      const diff = monaco.editor.createDiffEditor(diffHost, {
        automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: true, minimap: { enabled: false },
        fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 13, scrollBeyondLastLine: false,
        renderMarginRevertIcon: false, ignoreTrimWhitespace: false, glyphMargin: false,
      });
      const model = (text, path, side) => {
        const m = monaco.editor.createModel(text ?? '', 'python', monaco.Uri.parse(`pyide-refactor:/${seq}/${side}/${models.length}/${basename(path)}`));
        models.push(m);
        return m;
      };
      const rows = [];
      const show = (row, change) => {
        for (const r of rows) r.classList.toggle('selected', r === row);
        diff.setModel({ original: model(change.old, change.path, 'a'), modified: model(change.new, change.path, 'b') });
      };
      for (const c of result.changes) {
        const row = el('div', 'rf-file');
        row.dataset.path = c.path;
        const tag = c.old === null ? tr('new file') : '';
        row.append(el('span', 'rf-file-icon', '🐍'), userText(el('span', 'rf-file-name', basename(c.path))),
          userText(el('span', 'muted rf-file-dir', rel(c.path))), tag ? el('span', 'rf-file-tag', tag) : '');
        row.onclick = () => show(row, c);
        rows.push(row);
        list.appendChild(row);
      }
      for (const m of result.moves || []) {
        const row = el('div', 'rf-file rf-move');
        row.dataset.path = m.to;
        row.append(el('span', 'rf-file-icon', '↪'), el('span', 'rf-file-tag', tr('move')),
          userText(el('span', 'rf-file-name', `${rel(m.from)} → ${rel(m.to)}`)));
        list.appendChild(row);
      }
      if (rows.length) show(rows[0], result.changes[0]);
      let done = false;
      const dlg = ide.ui.dialog({
        title: tr('Refactoring Preview: {name}', { name: label }), body, width: 1000,
        buttons: [
          { label: tr('Do Refactor'), primary: true, run: () => { done = true; } },
          { label: tr('Cancel') },
        ],
        onClose: () => {
          diff.dispose();
          // Monaco keeps a global hover-delegate factory bound to the last editor's scoped services (see vcs mountDiff).
          monaco.editor.create(el('div')).dispose();
          for (const m of models) m.dispose();
          resolve(done);
        },
      });
      dlg.el.id = 'rfPreview';
      dlg.el.classList.add('rf-preview-dialog');
      const [apply, cancel] = dlg.el.querySelectorAll('.dialog-buttons button');
      apply.dataset.action = 'apply';
      cancel.dataset.action = 'cancel';
      apply.focus();
    });
  }
  const fileCount = (n) => (n === 1 ? tr('1 file will change') : tr('{count} files will change', { count: n }));

  // ---------- applying: one undo step per refactoring ----------
  // Line diff of two texts as Monaco edits, so carets and decorations outside the changes stay put.
  function lineEdits(oldText, newText) {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const am = a.slice(pre, a.length - suf);
    const bm = b.slice(pre, b.length - suf);
    const hunks = [];
    if (am.length * bm.length <= 4e6) {
      // LCS table over the middle part.
      const n = am.length;
      const m = bm.length;
      const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      let i = 0;
      let j = 0;
      let h = null;
      const flush = () => { if (h) { hunks.push(h); h = null; } };
      while (i < n || j < m) {
        if (i < n && j < m && am[i] === bm[j]) { flush(); i++; j++; continue; }
        if (!h) h = { a1: pre + i, a2: pre + i, b1: pre + j, b2: pre + j };
        if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { j++; h.b2 = pre + j; } else { i++; h.a2 = pre + i; }
      }
      flush();
    } else if (am.length || bm.length) {
      hunks.push({ a1: pre, a2: pre + am.length, b1: pre, b2: pre + bm.length });
    }
    const len = a.length;
    const maxCol = (line) => a[line - 1].length + 1;
    return hunks.map(({ a1, a2, b1, b2 }) => {
      const lines = b.slice(b1, b2);
      if (a2 < len) return { range: new monaco.Range(a1 + 1, 1, a2 + 1, 1), text: lines.map((l) => `${l}\n`).join('') };
      if (a1 > 0) return { range: new monaco.Range(a1, maxCol(a1), len, maxCol(len)), text: lines.map((l) => `\n${l}`).join('') };
      return { range: new monaco.Range(1, 1, len, maxCol(len)), text: lines.join('\n') };
    });
  }

  const records = [];
  let replaying = false;

  async function readDisk(path) {
    try { return await ide.api.invoke('fs:readText', path); } catch { return null; }
  }
  const withEol = (text, like) => (like && /\r\n/.test(like) ? text.replace(/\n/g, '\r\n') : text);
  const stale = (path) => new RefactorError('stale', { name: basename(path) });

  function editModel(model, oldText, newText) {
    const pre = model.getAlternativeVersionId();
    model.pushStackElement();
    model.pushEditOperations([], lineEdits(oldText, newText), () => null);
    model.pushStackElement();
    return { model, pre, post: model.getAlternativeVersionId() };
  }

  async function applyResult(result, label) {
    const moves = result.moves || [];
    const underMove = (p) => moves.some((m) => isUnder(p, m.from));
    // A file that moves is written to disk first, so its open tab saves (an unsaved buffer was already in the overlay).
    for (const t of [...ide.tabs]) if (t.kind === 'file' && t.path && underMove(t.path) && ide.isDirty(t)) await ide.saveTab(t);
    const plan = [];
    for (const c of result.changes) {
      const doc = ide.getDocument(c.path);
      if (doc && !doc.model.isDisposed() && !underMove(c.path)) {
        if (c.old !== null && doc.model.getValue(LF) !== c.old) throw stale(c.path);
        plan.push({ c, doc });
      } else {
        const disk = c.old === null ? null : await readDisk(c.path);
        if (c.old !== null && (!disk || norm(disk.text) !== c.old)) throw stale(c.path);
        plan.push({ c, disk });
      }
    }
    try {
      await ide.localHistory?.checkpoint?.('Before Refactoring', { paths: [...result.changes.map((c) => c.path), ...moves.map((m) => m.from)] });
    } catch (e) { console.warn('local history checkpoint failed', e); }
    const rec = { label, models: [], files: [], moves: [], state: 'done', anchors: [], redoAnchors: [] };
    const written = [];
    for (const { c, doc, disk } of plan) {
      if (doc) {
        rec.models.push(editModel(doc.model, c.old, c.new));
      } else {
        const text = withEol(c.new, disk?.text);
        const encoding = disk?.encoding || 'utf-8';
        const dir = ide.util.dirname(c.path);
        if (!disk && !(await ide.api.exists(dir))) await ide.api.create(dir, true);
        await ide.api.invoke('fs:writeText', c.path, text, encoding);
        rec.files.push({ path: c.path, before: disk ? disk.text : null, after: text, encoding });
        written.push(c.path);
      }
    }
    const reopen = [];
    for (const m of moves) reopen.push(...(await moveOnDisk(m.from, m.to)));
    rec.moves = moves.map((m) => ({ from: m.from, to: m.to }));
    if (written.length) await ide.reloadFromDisk(written);
    ide.renderTabs();
    ide.refreshTree?.();
    const created = result.changes.filter((c) => c.old === null).map((c) => c.path);
    if (created.length) ide.emit('filesChanged', { created });
    rec.anchors = await reopenTabs(reopen);
    track(rec);
    placeCaret(result.caret);
    return rec;
  }

  // Moves a file or folder; tabs inside it close first and are returned for reopening at the new place.
  async function moveOnDisk(from, to) {
    const active = ide.activeTab();
    const tabs = ide.tabs.filter((t) => t.kind === 'file' && t.path && isUnder(t.path, from));
    const reopen = tabs.map((t) => ({
      path: to + t.path.slice(from.length), active: t === active,
      pos: t.group?.editor && t === active ? t.group.editor.getPosition() : null,
    }));
    for (const t of tabs) ide.closeTab(t.path, true);
    await ide.api.rename(from, to);
    ide.emit('filesChanged', { renamed: [[from, to]] });
    return reopen;
  }

  async function reopenTabs(list) {
    const anchors = [];
    let active = null;
    for (const r of list) {
      const tab = await ide.openFile(r.path, { focus: false });
      if (tab?.model) anchors.push({ model: tab.model, version: tab.model.getAlternativeVersionId() });
      if (r.active) active = r;
    }
    if (active) await ide.openFile(active.path, { line: active.pos?.lineNumber, col: active.pos?.column });
    return anchors;
  }

  function placeCaret(caret) {
    if (!caret) return;
    const tab = ide.activeTab();
    if (!tab?.model || !samePath(tab.path, caret.path)) return;
    const ed = tab.group?.editor || ide.editor;
    const pos = { lineNumber: caret.line, column: caret.col };
    const word = tab.model.getWordAtPosition(pos);
    ed.setSelection(word ? new monaco.Range(caret.line, word.startColumn, caret.line, word.endColumn) : monaco.Range.fromPositions(pos));
    ed.revealPositionInCenterIfOutsideViewport(pos);
    ed.focus();
  }

  // Undoing the refactoring's edit in any of its files (Ctrl+Z or Edit › Undo) undoes the whole refactoring.
  function track(rec) {
    rec.subs = rec.models.map((m) => m.model.onDidChangeContent((e) => {
      if (replaying) return;
      const v = m.model.getAlternativeVersionId();
      if (e.isUndoing && rec.state === 'done' && v === m.pre) replay(rec, 'undo', m.model);
      else if (e.isRedoing && rec.state === 'undone' && v === m.post) replay(rec, 'redo', m.model);
    }));
    records.push(rec);
    while (records.length > 30) records.shift().subs.forEach((s) => s.dispose());
  }

  async function replay(rec, dir, skip) {
    replaying = true;
    const skipped = [];
    try {
      if (dir === 'undo') {
        const reopen = [];
        for (const m of [...rec.moves].reverse()) reopen.push(...(await moveOnDisk(m.to, m.from)));
        for (const f of rec.files) {
          const disk = await readDisk(f.path);
          if (disk && disk.text !== f.after) { skipped.push(f.path); continue; }
          if (f.before === null) await ide.api.trash(f.path);
          else await ide.api.invoke('fs:writeText', f.path, f.before, f.encoding);
        }
        for (const m of rec.models) {
          if (m.model === skip || m.model.isDisposed()) continue;
          if (m.model.getAlternativeVersionId() === m.post) m.model.undo(); else skipped.push(m.model.uri.fsPath);
        }
        rec.state = 'undone';
        await ide.reloadFromDisk(rec.files.map((f) => f.path));
        rec.redoAnchors = await reopenTabs(reopen);
      } else {
        for (const m of rec.models) {
          if (m.model === skip || m.model.isDisposed()) continue;
          if (m.model.getAlternativeVersionId() === m.pre) m.model.redo(); else skipped.push(m.model.uri.fsPath);
        }
        for (const f of rec.files) {
          const disk = f.before === null ? null : await readDisk(f.path);
          if (f.before !== null && (!disk || disk.text !== f.before)) { skipped.push(f.path); continue; }
          await ide.api.invoke('fs:writeText', f.path, f.after, f.encoding);
        }
        const reopen = [];
        for (const m of rec.moves) reopen.push(...(await moveOnDisk(m.from, m.to)));
        rec.state = 'done';
        await ide.reloadFromDisk(rec.files.map((f) => f.path));
        rec.anchors = await reopenTabs(reopen);
      }
      ide.refreshTree?.();
      ide.renderTabs();
    } finally {
      replaying = false;
    }
    if (skipped.length) hint(tr('Some files changed after the refactoring and were left as they are: {files}', { files: skipped.map((p) => basename(p)).join(', ') }));
  }

  // A file that moved reopens as a new document with no undo history; Ctrl+Z there still undoes the refactoring.
  function anchoredRecord(dir) {
    const model = ide.editor?.hasTextFocus() ? ide.editor.getModel() : null;
    if (!model) return null;
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      const anchors = dir === 'undo' ? (rec.state === 'done' ? rec.anchors : []) : (rec.state === 'undone' ? rec.redoAnchors : []);
      if (anchors.some((a) => a.model === model && !model.isDisposed() && model.getAlternativeVersionId() === a.version)) return rec;
    }
    return null;
  }

  // ---------- the refactorings ----------
  function caretContext() {
    const tab = ide.activeTab();
    const ed = ide.editor;
    if (tab?.kind !== 'file' || !isPy(tab.path) || !ed || ed.getModel() !== tab.model) return null;
    const sel = ed.getSelection();
    return {
      file: tab.path,
      range: { startLine: sel.startLineNumber, startCol: sel.startColumn, endLine: sel.endLineNumber, endCol: sel.endColumn },
      pos: { line: sel.positionLineNumber, col: sel.positionColumn },
      empty: sel.isEmpty(),
    };
  }

  const TITLES = {
    variable: () => tr('Extract Variable'), constant: () => tr('Extract Constant'), parameter: () => tr('Extract Parameter'),
  };
  const METHODS = { variable: 'extractVariable', constant: 'extractConstant', parameter: 'extractParameter' };

  // PyCharm's expression chooser when nothing is selected and several expressions surround the caret.
  async function chooseExpression(choices) {
    const picked = await ide.ui.pick({
      placeholder: tr('Expressions'),
      items: choices.map((c) => ({ label: c.text.length > 80 ? `${c.text.slice(0, 77)}…` : c.text, value: c })),
    });
    return picked || null;
  }

  async function extractExpression(op) {
    const ctx = caretContext();
    if (!ctx) return;
    const retry = () => extractExpression(op);
    let info = await guarded(() => call('prepareExpression', { file: ctx.file, range: ctx.range, op }), retry);
    if (!info) return;
    if (info.choices) {
      const c = await chooseExpression(info.choices);
      if (!c) return;
      ctx.range = { startLine: c.start.line, startCol: c.start.col, endLine: c.end.line, endCol: c.end.col };
      info = await guarded(() => call('prepareExpression', { file: ctx.file, range: ctx.range, op }), retry);
      if (!info) return;
    }
    const r = info.range;
    const range = { startLine: r.start.line, startCol: r.start.col, endLine: r.end.line, endCol: r.end.col };
    ide.editor.setSelection(new monaco.Range(range.startLine, range.startCol, range.endLine, range.endCol));
    const body = el('div', 'rf-form');
    const name = textInput(info.name, 'rf-name');
    body.appendChild(field(tr('Name:'), name));
    const expr = userText(el('code', 'rf-expression', info.expression));
    body.appendChild(field(tr('Expression:'), expr));
    const all = info.occurrences > 1 ? checkRow(tr('Replace all occurrences ({count})', { count: info.occurrences }), true, 'rf-similar') : null;
    if (all) body.appendChild(all);
    refactorDialog({
      title: TITLES[op](), body, id: 'rfExtractDialog', method: METHODS[op], label: TITLES[op],
      collect: () => {
        const n = name.value.trim();
        if (!n) throw new RefactorError('empty-name');
        return { file: ctx.file, range, name: n, similar: !!all?.input.checked };
      },
    });
  }

  async function extractMethod() {
    const ctx = caretContext();
    if (!ctx) return;
    if (ctx.empty) return hint(cannot(new RefactorError('select-code')));
    const ready = await guarded(async () => {
      if (!(await call('ping', {})).rope) throw new RefactorError('no-rope');
      return true;
    }, extractMethod);
    if (!ready) return;
    const body = el('div', 'rf-form');
    const name = textInput('', 'rf-name');
    body.appendChild(field(tr('Name:'), name));
    const similar = checkRow(tr('Also replace similar code fragments'), false, 'rf-similar');
    body.appendChild(similar);
    refactorDialog({
      title: tr('Extract Method'), body, id: 'rfExtractMethodDialog', method: 'extractMethod', label: () => tr('Extract Method'),
      collect: () => {
        const n = name.value.trim();
        if (!n) throw new RefactorError('empty-name');
        return { file: ctx.file, range: ctx.range, name: n, similar: similar.input.checked };
      },
    });
  }

  const INLINE_CHOICES = {
    variable: [['all', () => tr('Inline all and remove the variable')], ['this', () => tr('Inline this only and keep the variable')]],
    method: [['all', () => tr('Inline all and remove the method')], ['keep', () => tr('Inline all and keep the method')], ['this', () => tr('Inline this only and keep the method')]],
    parameter: [['all', () => tr('Inline the default value into all calls')]],
  };
  const INLINE_TITLES = { variable: () => tr('Inline Variable'), method: () => tr('Inline Method'), parameter: () => tr('Inline Parameter') };

  async function inlineElement() {
    const ctx = caretContext();
    if (!ctx) return;
    const info = await guarded(() => call('prepareInline', { file: ctx.file, pos: ctx.pos }), inlineElement);
    if (!info) return;
    const body = el('div', 'rf-form');
    const head = el('div', 'rf-message');
    const [before, after = ''] = tr("Inline '{name}'").split('{name}');
    head.append(before, userText(el('b', null, info.name)), after);
    body.appendChild(head);
    const choices = (INLINE_CHOICES[info.kind] || INLINE_CHOICES.variable).filter(([mode]) => mode !== 'this' || info.onUsage);
    const group = `rf-inline-${Date.now()}`;
    const radios = choices.map(([mode, label], i) => {
      const row = el('label', 'rf-check rf-radio');
      const input = el('input');
      input.type = 'radio';
      input.name = group;
      input.value = mode;
      input.checked = i === 0;
      row.append(input, el('span', null, label()));
      body.appendChild(row);
      return input;
    });
    const title = (INLINE_TITLES[info.kind] || INLINE_TITLES.variable)();
    refactorDialog({
      title, body, id: 'rfInlineDialog', method: 'inline', label: title,
      collect: () => ({ file: ctx.file, pos: ctx.pos, mode: radios.find((r) => r.checked)?.value || 'all' }),
    });
  }

  async function changeSignature() {
    const ctx = caretContext();
    if (!ctx) return;
    const info = await guarded(() => call('prepareSignature', { file: ctx.file, pos: ctx.pos }), changeSignature);
    if (!info) return;
    const body = el('div', 'rf-form rf-signature');
    const name = textInput(info.name, 'rf-name');
    body.appendChild(field(tr('Name:'), name));
    const table = el('div', 'rf-params');
    table.id = 'rfParams';
    const headRow = el('div', 'rf-param rf-param-head');
    headRow.append(el('span', null, tr('Name')), el('span', null, tr('Default value')), el('span', null, tr('Value in calls')));
    const rowsHost = el('div', 'rf-param-rows');
    table.append(headRow, rowsHost);
    const tools = el('div', 'rf-param-tools');
    const tool = (glyph, title, cls, run) => {
      const b = el('button', `secondary ${cls}`, glyph);
      b.title = title;
      b.onclick = (e) => { e.preventDefault(); run(); };
      tools.appendChild(b);
      return b;
    };
    const signature = userText(el('code', 'rf-signature-preview'));
    const rows = [];
    let selected = null;
    const render = () => {
      rowsHost.replaceChildren(...rows.map((r) => r.el));
      for (const r of rows) r.el.classList.toggle('selected', r === selected);
      const params = rows.map((r) => {
        const n = r.name.value.trim() || '?';
        const d = r.def.value.trim();
        return d ? `${n}=${d}` : n;
      });
      signature.textContent = `${name.value.trim() || info.name}(${[...info.hidden, ...params, ...(info.kwonly.length ? ['*', ...info.kwonly] : [])].join(', ')})`;
    };
    const addRow = (p, old) => {
      const r = { old, el: el('div', 'rf-param') };
      r.name = textInput(p.name, 'rf-param-name');
      r.def = textInput(p.default ?? '', 'rf-param-default');
      r.value = textInput('', 'rf-param-value');
      r.value.disabled = old !== null;
      r.value.placeholder = old !== null ? '' : tr('passed by calls');
      r.el.append(r.name, r.def, r.value);
      for (const i of [r.name, r.def, r.value]) {
        i.addEventListener('input', render);
        i.addEventListener('focus', () => { selected = r; render(); });
      }
      r.el.onmousedown = () => { selected = r; render(); };
      rows.push(r);
      return r;
    };
    info.params.forEach((p, i) => addRow(p, i));
    tool('+', tr('Add parameter'), 'rf-add', () => { selected = addRow({ name: '', default: '' }, null); render(); selected.name.focus(); });
    tool('−', tr('Remove parameter'), 'rf-remove', () => {
      if (!selected) return;
      rows.splice(rows.indexOf(selected), 1);
      selected = null;
      render();
    });
    const move = (d) => {
      if (!selected) return;
      const i = rows.indexOf(selected);
      const j = i + d;
      if (j < 0 || j >= rows.length) return;
      [rows[i], rows[j]] = [rows[j], rows[i]];
      render();
    };
    tool('↑', tr('Move up'), 'rf-up', () => move(-1));
    tool('↓', tr('Move down'), 'rf-down', () => move(1));
    name.addEventListener('input', render);
    body.append(el('div', 'rf-label', tr('Parameters:')), table, tools, el('div', 'rf-label', tr('Signature preview:')), signature);
    if (info.kwonly.length) body.appendChild(el('div', 'muted rf-note', tr('Keyword-only parameters are kept as they are.')));
    render();
    const dlg = refactorDialog({
      title: tr('Change Signature'), body, width: 640, id: 'rfSignatureDialog', method: 'changeSignature', label: () => tr('Change Signature'),
      collect: () => {
        const n = name.value.trim();
        if (!n) throw new RefactorError('empty-name');
        return {
          file: ctx.file, pos: ctx.pos, name: n,
          params: rows.map((r) => {
            if (!r.name.value.trim()) throw new RefactorError('empty-name');
            return { name: r.name.value.trim(), old: r.old, default: r.def.value.trim() || null, value: r.value.value.trim() || null };
          }),
        };
      },
    });
    dlg.rows = rows;
  }

  async function moveElement(target) {
    const ctx = target ? null : caretContext();
    if (!target && !ctx) return;
    const file = target || ctx.file;
    const info = await guarded(() => call('prepareMove', { file, pos: ctx?.pos || null, target: target || null }), () => moveElement(target));
    if (!info) return;
    const body = el('div', 'rf-form');
    const head = el('div', 'rf-message');
    let textKey;
    if (info.kind === 'global') textKey = info.symbol === 'class' ? tr("Move class '{name}' from {module}") : tr("Move function '{name}' from {module}");
    else textKey = tr("Move module '{name}'");
    const parts = textKey.split(/(\{name\}|\{module\})/);
    for (const p of parts) {
      if (p === '{name}') head.appendChild(userText(el('b', null, info.name)));
      else if (p === '{module}') head.appendChild(userText(el('code', null, info.module)));
      else if (p) head.append(p);
    }
    body.appendChild(head);
    const relDir = (p) => { const r = rel(p); return r === p ? '' : r; };
    const initial = info.kind === 'global' ? `${relDir(ide.util.dirname(info.path)) ? `${relDir(ide.util.dirname(info.path))}\\` : ''}` : relDir(info.folder);
    const dest = textInput(initial, 'rf-dest');
    body.appendChild(field(info.kind === 'global' ? tr('To file:') : tr('To directory:'), dest));
    body.appendChild(el('div', 'muted rf-note', info.kind === 'global'
      ? tr('A path relative to the project. A file that does not exist is created.')
      : tr('A path relative to the project. Imports of the module are updated across the project.')));
    const title = tr('Move');
    const dlg = refactorDialog({
      title, body, width: 560, id: 'rfMoveDialog', method: 'move', label: title,
      collect: () => {
        const v = dest.value.trim().replace(/\//g, '\\').replace(/^\.?\\/, '');
        const path = /^[a-z]:\\/i.test(v) ? v : v ? joinPath(ide.root, v) : ide.root;
        return { file, pos: ctx?.pos || null, target: target || null, dest: path };
      },
    });
    dest.focus();
    dest.setSelectionRange(dest.value.length, dest.value.length);
    return dlg;
  }

  // ---------- Refactor This (Ctrl+Alt+Shift+T) ----------
  const REFACTORINGS = [
    'RenameElement', 'ChangeSignature', 'Move', 'Inline', null,
    'IntroduceVariable', 'IntroduceConstant', 'IntroduceParameter', 'ExtractMethod',
  ];
  function refactorThis() {
    const ed = ide.editor;
    const pos = ed?.getPosition();
    if (!ed || !pos) return;
    const box = ed.getDomNode().getBoundingClientRect();
    const at = ed.getScrolledVisiblePosition(pos) || { left: 0, top: 0, height: 20 };
    const items = [{ header: tr('Refactor This') }];
    for (const id of REFACTORINGS) {
      if (!id) { items.push({ separator: true }); continue; }
      const a = ide.actions.find((x) => x.id === id);
      if (a) items.push({ label: a.title, hint: a.keys.join(', '), run: () => a.run() });
    }
    const menu = ide.ui.contextMenu(box.left + at.left, box.top + at.top + at.height, items);
    if (menu) menu.id = 'rfRefactorThis';
  }

  // ---------- actions ----------
  const editorPython = () => !!ide.editor?.hasTextFocus() && !!caretContext();
  [
    { id: 'IntroduceVariable', title: tr('Extract Variable…'), keys: 'Ctrl+Alt+V', when: editorPython, run: () => extractExpression('variable') },
    { id: 'IntroduceConstant', title: tr('Extract Constant…'), keys: 'Ctrl+Alt+C', when: editorPython, run: () => extractExpression('constant') },
    { id: 'IntroduceParameter', title: tr('Extract Parameter…'), keys: 'Ctrl+Alt+P', when: editorPython, run: () => extractExpression('parameter') },
    { id: 'ExtractMethod', title: tr('Extract Method…'), keys: 'Ctrl+Alt+M', when: editorPython, run: extractMethod },
    { id: 'Inline', title: tr('Inline…'), keys: 'Ctrl+Alt+N', when: editorPython, run: inlineElement },
    { id: 'ChangeSignature', title: tr('Change Signature…'), keys: 'Ctrl+F6', when: editorPython, run: changeSignature },
    { id: 'Move', title: tr('Move…'), keys: 'F6', when: editorPython, run: () => moveElement() },
    { id: 'Refactorings.QuickListPopupAction', title: tr('Refactor This…'), keys: 'Ctrl+Alt+Shift+T', when: editorPython, run: refactorThis },
    { id: 'Refactor.Undo', title: tr('Undo Refactoring'), keys: 'Ctrl+Z', when: () => !!anchoredRecord('undo'), run: () => replay(anchoredRecord('undo'), 'undo') },
    { id: 'Refactor.Redo', title: tr('Redo Refactoring'), keys: 'Ctrl+Shift+Z', when: () => !!anchoredRecord('redo'), run: () => replay(anchoredRecord('redo'), 'redo') },
  ].forEach(ide.registerAction);

  ide.registerTreeAction({
    title: tr('Move…'),
    when: (entry) => (entry.dir ? !samePath(entry.path, ide.root) : isPy(entry.path)),
    run: (entry) => moveElement(entry.path),
  });

  ide.refactor = { call, applyResult, preview, records: () => records.map(({ label, state, files, moves }) => ({ label, state, files: files.map((f) => f.path), moves })) };
})();
