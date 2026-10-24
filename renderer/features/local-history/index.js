// Local History (PyCharm's): every save and every outside change of a project file is a revision, risky actions put a
// label first, and Show History compares any revision with the current text and reverts the file or single changes.
// The store is main/features/local-history.js. Other plugins label risky actions with
// ide.localHistory?.checkpoint('Before …'): the label is English and translated where it is shown.
(() => {
  const { el, basename, samePath, isUnder } = ide.util;
  const invoke = (ch, ...args) => ide.api.invoke(`localHistory:${ch}`, ...args);
  const key = (p) => p.toLowerCase();
  const dateLocale = i18n.locale === 'ko' ? 'ko-KR' : 'en-US';
  const SETTINGS = { days: 'localHistory.days', maxMB: 'localHistory.maxMB' };
  const limits = () => ({
    days: Number(ide.settings.get(SETTINGS.days, 5)) || 5,
    maxMB: Number(ide.settings.get(SETTINGS.maxMB, 200)) || 200,
  });
  const KIND = {
    initial: tr('Initial content'), save: tr('Saved'), external: tr('External change'), create: tr('Created'),
    delete: tr('Deleted'), revert: tr('Reverted'),
  };
  const userText = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userText = ''; return n; };
  const logError = (what) => (err) => { console.error(`local history: ${what}`, err); return null; };

  let openRoot = null;
  let ready = Promise.resolve(false);
  const reverting = new Set(); // lower-cased paths whose next save is a revert
  const views = new Set();

  ide.on('projectOpened', (root) => {
    openRoot = root;
    ready = invoke('open', root, limits()).catch(logError('cannot open the store'));
  });
  ide.on('projectClosed', () => {
    if (openRoot) invoke('close', openRoot).catch(logError('cannot close the store'));
    openRoot = null;
  });
  ide.on('fileSaved', (tab) => {
    if (!ide.root || !isUnder(tab.path, ide.root)) return;
    const kind = reverting.delete(key(tab.path)) ? 'revert' : 'save';
    invoke('record', ide.root, tab.path, kind).catch(logError('cannot record a save'));
  });
  // As in PyCharm, a file's history starts when it is first opened (or changes).
  ide.on('fileOpened', (tab) => {
    if (!ide.root || !isUnder(tab.path, ide.root) || !tab.doc) return;
    invoke('record', ide.root, tab.path, 'opened', { text: tab.doc.model.getValue(), encoding: tab.doc.encoding }).catch(logError('cannot record an opened file'));
  });
  ide.on('filesChanged', (e) => {
    for (const [from, to] of e?.renamed || []) invoke('rename', ide.root, from, to).catch(logError('cannot follow a rename'));
  });
  ide.on('settingsChanged', (k) => {
    if (openRoot && (k === SETTINGS.days || k === SETTINGS.maxMB)) invoke('limits', openRoot, limits()).catch(logError('cannot apply limits'));
  });
  ide.api.on('localHistory:changed', ({ root }) => {
    if (samePath(root, ide.root)) for (const v of views) v.reload();
  });
  // The user data folder cannot be written (no permission, a full disk): main says so once per project open.
  ide.api.on('localHistory:writeFailed', ({ dir, error }) => {
    ide.notifications.notify({
      title: tr('Local History is not being saved'),
      text: `${tr('Saves and labels are not recorded while this folder cannot be written: {folder}', { folder: dir })}\n${ide.util.errorText(error)}`,
      raw: true, kind: 'warn', group: 'Local History',
    });
  });

  // Unsaved text of open documents now, before the caller changes anything (only `paths`, when given). Saved ones
  // are on disk, where the store already has them.
  function openDocs(paths) {
    const seen = new Set();
    const out = [];
    for (const t of ide.tabs) {
      const doc = t.doc;
      if (!doc || seen.has(doc) || doc.model.isDisposed() || !ide.isDirty(t) || !isUnder(doc.path, ide.root)) continue;
      if (paths && !paths.some((p) => samePath(p, doc.path))) continue;
      seen.add(doc);
      out.push({ path: doc.path, text: doc.model.getValue(), encoding: doc.encoding });
    }
    return out;
  }

  // A labeled point in time. The label is English UI text unless `user` (a name the user typed).
  function checkpoint(label, { paths, user = false } = {}) {
    if (!ide.root) return Promise.resolve(null);
    const docs = openDocs(paths);
    return invoke('checkpoint', ide.root, label, user, docs).catch(logError('cannot put a label'));
  }

  async function putLabel() {
    if (!ide.root) return;
    const name = await ide.ui.prompt(tr('Label name'));
    if (name) await checkpoint(name, { user: true });
  }

  const labelText = (l) => (l.u ? l.l : tr(l.l));

  function fmtTime(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString(dateLocale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? tr('Today {time}', { time }) : `${d.toLocaleDateString(dateLocale)} ${time}`;
  }

  const contentCache = new Map();
  const content = (h) => {
    if (!contentCache.has(h)) contentCache.set(h, invoke('content', ide.root, h).catch((err) => { contentCache.delete(h); throw err; }));
    return contentCache.get(h);
  };

  // Replaces a file with a revision: through the open document (one undoable edit, then saved) or on disk.
  async function revertFile(path, h) {
    const doc = ide.getDocument(path);
    if (doc) {
      const r = await content(h);
      if (r.text === undefined) return;
      replaceDocument(doc, [{ range: doc.model.getFullModelRange(), text: r.text }]);
      await saveReverted(doc);
      return;
    }
    const existed = await ide.api.exists(path);
    await invoke('restore', ide.root, path, h);
    if (!existed) {
      ide.refreshTree();
      ide.emit('filesChanged', { created: [path] });
    }
  }

  function replaceDocument(doc, edits) {
    doc.model.pushStackElement();
    doc.model.pushEditOperations([], edits, () => null);
    doc.model.pushStackElement();
  }

  // A revert writes the revision the user picked, also over a file deleted or changed on disk: no question about it.
  async function saveReverted(doc) {
    reverting.add(key(doc.path));
    await ide.saveTab({ doc }, { overwrite: true });
    reverting.delete(key(doc.path));
  }

  // ---------- history view ----------
  let diffSeq = 0;
  const diffUri = (name) => ide.monaco.Uri.from({ scheme: 'local-history', path: `/${++diffSeq}/${name}` });

  async function showHistory(path, isDir) {
    if (!ide.root) return;
    await ready;
    const id = `${path} [${tr('Local History')}]`;
    if (ide.findTab(id)) return ide.openCustomTab({ id });
    // The current side of a file's history is its live document, so reverting single changes edits what the user sees.
    if (!isDir && !ide.getDocument(path) && await ide.api.exists(path)) await ide.openFile(path, { focus: false });
    let view;
    ide.openCustomTab({
      id, title: tr('Local History: {name}', { name: basename(path) || path }), icon: '🕘',
      mount(host) { view = mountHistory(host, path, isDir); },
      onClose() { view?.dispose(); },
    });
  }

  // Rows are revisions and labels, newest first. A label stands for the state of each file at that moment.
  function mountHistory(host, target, isDir) {
    host.classList.add('lh-view');
    const list = el('div', 'lh-list');
    list.tabIndex = 0;
    const side = el('div', 'lh-side');
    const bar = el('div', 'lh-bar');
    const revertBtn = el('button', 'secondary lh-revert', tr('Revert'));
    const revertSelBtn = el('button', 'secondary lh-revert-selected', tr('Revert Selected Changes'));
    const status = el('span', 'lh-status muted');
    bar.append(revertBtn, revertSelBtn, status);
    const head = el('div', 'lh-diff-head');
    const box = el('div', 'lh-diff');
    const note = el('div', 'lh-note muted hidden');
    side.append(bar, head, box, note);
    host.append(list, side);

    let data = { revisions: [], labels: [] };
    let rows = [];
    let selected = null;
    let diff = null;
    let original = null;
    let ownModified = null;
    let liveDoc = null;
    let liveSub = null;
    let focusedSide = 'modified';
    let showSeq = 0;
    let disposed = false;

    // The state of `path` at time t: its latest revision at or before t.
    const stateAt = (path, t) => data.revisions.find((r) => samePath(r.path, path) && r.t <= t) || null;
    const latest = (path) => data.revisions.find((r) => samePath(r.path, path)) || null;
    const pathsIn = () => [...new Map(data.revisions.map((r) => [key(r.path), r.path])).values()];

    function buildRows() {
      // A checkpoint revision is drawn as its label's row.
      const labelTimes = new Set(data.labels.map((l) => l.t));
      const revs = data.revisions.filter((r) => !(r.k === 'checkpoint' && labelTimes.has(r.t)));
      return [...revs.map((r) => ({ kind: 'rev', t: r.t, rev: r })), ...data.labels.map((l) => ({ kind: 'label', t: l.t, label: l }))]
        .sort((a, b) => b.t - a.t || (a.kind === 'label' ? -1 : 1));
    }

    function render() {
      list.replaceChildren();
      if (!rows.length) list.appendChild(el('div', 'lh-empty muted', tr('No local history yet')));
      for (const row of rows) {
        const n = el('div', `lh-row ${row.kind}${row === selected ? ' selected' : ''}`);
        n.appendChild(el('span', 'lh-time', fmtTime(row.t)));
        if (row.kind === 'label') {
          const l = row.label;
          n.appendChild((l.u ? userText : el)('span', 'lh-label', labelText(l)));
        } else {
          const r = row.rev;
          n.appendChild(el('span', `lh-kind ${r.k}`, r.k === 'checkpoint' ? labelText({ l: r.l, u: r.u }) : KIND[r.k] || r.k));
          if (isDir) n.appendChild(userText('span', 'lh-path', ide.util.rel(r.path)));
        }
        n.onclick = () => select(row);
        list.appendChild(n);
      }
    }

    async function reload() {
      const r = await invoke('list', ide.root, target, isDir).catch(logError('cannot list revisions'));
      if (!r || disposed) return;
      data = r;
      const was = selected;
      rows = buildRows();
      selected = (was && rows.find((x) => x.kind === was.kind && x.t === was.t && (x.kind === 'label' || samePath(x.rev.path, was.rev.path)))) || null;
      render();
      if (!selected && rows.length) select(rows.find((x) => x.kind === 'rev' && x.rev.h) || rows[0]);
      else if (selected) show(selected);
    }

    list.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = rows.indexOf(selected);
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next);
    };

    function select(row) {
      selected = row;
      for (const [i, n] of [...list.children].entries()) n.classList.toggle('selected', rows[i] === row);
      list.children[rows.indexOf(row)]?.scrollIntoView({ block: 'nearest' });
      show(row);
    }

    // The revision a row stands for, for the file shown in the diff: {path, rev}.
    // A deletion stands for the content just before it, so reverting it recovers the file.
    function pick(row) {
      if (row.kind === 'rev') {
        const r = row.rev;
        const before = r.h ? r : data.revisions.slice(data.revisions.indexOf(r) + 1).find((x) => samePath(x.path, r.path) && x.h);
        return { path: r.path, rev: before || null };
      }
      if (!isDir) return { path: target, rev: stateAt(target, row.t) };
      return null;
    }

    // Files a folder label would change back: those whose state then differs from now.
    function labelChanges(row) {
      return pathsIn().map((p) => ({ path: p, then: stateAt(p, row.t), now: latest(p) }))
        .filter((c) => c.then?.h && c.then.h !== c.now?.h);
    }

    function closeDiff() {
      liveSub?.dispose();
      liveSub = null;
      if (!diff) return;
      diff.dispose();
      // Monaco keeps a global hover-delegate factory bound to the last editor's scoped services; a throwaway editor
      // rebinds it to the root after a diff editor goes away (see the vcs plugin).
      ide.monaco.editor.create(el('div')).dispose();
      // A diff computation still in flight fails ("no diff result available") if its models go away first.
      const models = [original, ownModified];
      setTimeout(() => { for (const m of models) m?.dispose(); }, 2000);
      diff = original = ownModified = liveDoc = null;
      host._lhDiff = null;
      box.replaceChildren();
    }

    function setNote(text) {
      note.textContent = text;
      note.classList.toggle('hidden', !text);
      box.classList.toggle('hidden', !!text);
      head.classList.toggle('hidden', !!text);
    }

    async function show(row) {
      const my = ++showSeq;
      const p = pick(row);
      status.textContent = '';
      if (!p) {
        const changes = labelChanges(row);
        closeDiff();
        setNote(changes.length
          ? tr('Reverting to this label restores {n} files: {files}', { n: changes.length, files: changes.map((c) => ide.util.rel(c.path)).join(', ') })
          : tr('No files changed since this label'));
        revertBtn.disabled = !changes.length;
        revertSelBtn.disabled = true;
        return;
      }
      const left = p.rev?.h ? await content(p.rev.h).catch(() => ({ text: '' })) : { text: '' };
      // A file deleted on disk shows as deleted even while an editor still holds its text.
      const exists = await ide.api.exists(p.path);
      const doc = exists ? ide.getDocument(p.path) : null;
      const right = doc || !exists ? '' : (await ide.api.invoke('fs:readText', p.path).catch(() => null))?.text ?? '';
      if (my !== showSeq || disposed) return;
      if (left.binary) {
        closeDiff();
        setNote(tr('This revision is binary and cannot be shown.'));
        revertBtn.disabled = false;
        revertSelBtn.disabled = true;
        return;
      }
      setNote('');
      closeDiff();
      const name = basename(p.path);
      head.replaceChildren(
        el('span', 'lh-side-title', p.rev ? tr('{time} (read-only)', { time: fmtTime(p.rev.t) }) : tr('Did not exist')),
        el('span', 'lh-side-title', doc ? tr('Current') : exists ? tr('Current (read-only)') : tr('Deleted')),
      );
      original = ide.monaco.editor.createModel(left.text ?? '', undefined, diffUri(name));
      const modified = doc ? doc.model : (ownModified = ide.monaco.editor.createModel(right, undefined, diffUri(name)));
      liveDoc = doc;
      // Closing the file's tab disposes its model, which the diff editor must let go of first; the row is then shown
      // against the file on disk.
      if (doc) liveSub = doc.model.onWillDispose(() => { closeDiff(); setTimeout(() => !disposed && selected && show(selected)); });
      diff = ide.monaco.editor.createDiffEditor(box, {
        automaticLayout: true, readOnly: !doc, originalEditable: false, renderSideBySide: true,
        fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 14, lineHeight: 22, minimap: { enabled: false },
        scrollBeyondLastLine: false, ignoreTrimWhitespace: false, renderMarginRevertIcon: !!doc,
      });
      diff.setModel({ original, modified });
      diff.getOriginalEditor().onDidFocusEditorText(() => { focusedSide = 'original'; });
      diff.getModifiedEditor().onDidFocusEditorText(() => { focusedSide = 'modified'; });
      host._lhDiff = diff;
      revertBtn.disabled = !p.rev?.h;
      revertSelBtn.disabled = !doc || !p.rev?.h;
    }

    // Changes (Monaco line changes) touching the selection in the side of the diff that last had the caret.
    function selectedChanges() {
      const orig = focusedSide === 'original';
      const ed = orig ? diff.getOriginalEditor() : diff.getModifiedEditor();
      const sels = (ed.getSelections() || []).map((s) => [s.startLineNumber, s.endLineNumber]);
      return (diff.getLineChanges() || []).filter((c) => {
        const [start, end] = orig ? [c.originalStartLineNumber, c.originalEndLineNumber] : [c.modifiedStartLineNumber, c.modifiedEndLineNumber];
        // A side with no lines (end 0) sits after line `start`: a caret on that line or the next one picks it.
        const [a, b] = end ? [start, end] : [start, start + 1];
        return sels.some(([s, e]) => s <= b && e >= a);
      });
    }

    // Puts the revision's lines back in place of each change (one undoable edit).
    function revertChanges(changes) {
      const model = liveDoc.model;
      const eol = model.getEOL();
      const M = ide.monaco;
      const old = original.getLinesContent();
      const edits = changes.map((c) => {
        const lines = c.originalEndLineNumber ? old.slice(c.originalStartLineNumber - 1, c.originalEndLineNumber) : [];
        const ms = c.modifiedStartLineNumber;
        const me = c.modifiedEndLineNumber;
        if (!me) {
          // Lines the current text lacks: insert them after line ms (0 = at the top).
          return ms === 0
            ? { range: new M.Range(1, 1, 1, 1), text: lines.join(eol) + eol }
            : { range: new M.Range(ms, model.getLineMaxColumn(ms), ms, model.getLineMaxColumn(ms)), text: eol + lines.join(eol) };
        }
        if (!lines.length) {
          if (me < model.getLineCount()) return { range: new M.Range(ms, 1, me + 1, 1), text: '' };
          if (ms > 1) return { range: new M.Range(ms - 1, model.getLineMaxColumn(ms - 1), me, model.getLineMaxColumn(me)), text: '' };
          return { range: model.getFullModelRange(), text: '' };
        }
        return { range: new M.Range(ms, 1, me, model.getLineMaxColumn(me)), text: lines.join(eol) };
      });
      replaceDocument(liveDoc, edits);
    }

    revertBtn.onclick = async () => {
      if (!selected) return;
      const p = pick(selected);
      const targets = p ? (p.rev?.h ? [{ path: p.path, h: p.rev.h }] : []) : labelChanges(selected).map((c) => ({ path: c.path, h: c.then.h }));
      if (!targets.length) return;
      await checkpoint('Before Local History Revert', { paths: targets.map((x) => x.path) });
      // Writing the file can fail (read-only, locked by another program); say so instead of leaving it unexplained.
      try {
        for (const x of targets) await revertFile(x.path, x.h);
      } catch (err) {
        status.textContent = tr('Cannot revert: {error}', { error: ide.util.errorText(err) });
        return;
      }
      status.textContent = tr('Reverted');
    };
    revertSelBtn.onclick = async () => {
      if (!liveDoc || !diff) return;
      const changes = selectedChanges();
      if (!changes.length) { status.textContent = tr('Select the changes to revert in the diff'); return; }
      const doc = liveDoc;
      revertChanges(changes);
      await saveReverted(doc);
      status.textContent = tr('Reverted');
    };

    // Revision texts are kept while a history view is open, not for the rest of the session.
    const view = { reload, dispose() { disposed = true; views.delete(view); if (!views.size) contentCache.clear(); closeDiff(); } };
    views.add(view);
    reload();
    return view;
  }

  // ---------- entry points ----------
  const fileOfTab = (t) => (t && (t.kind === 'file' || t.doc) ? t.path : null);

  ide.onEditor((ed) => {
    ed.addAction({
      id: 'localHistory.show', label: tr('Local History: Show History'), contextMenuGroupId: '9_vcs', contextMenuOrder: 9,
      run: () => {
        const m = ed.getModel();
        const t = m && ide.tabs.find((x) => x.model === m);
        if (fileOfTab(t)) showHistory(t.path, false);
      },
    });
  });
  ide.registerTreeAction({ title: tr('Local History: Show History'), run: (e) => showHistory(e.path, e.dir) });
  ide.registerTreeAction({ title: tr('Local History: Put Label…'), run: putLabel });
  [
    { id: 'LocalHistory.ShowHistory', title: tr('Local History: Show History'), run: () => {
      const p = fileOfTab(ide.activeTab());
      if (p) showHistory(p, false); else if (ide.root) showHistory(ide.root, true);
    } },
    { id: 'LocalHistory.ShowProjectHistory', title: tr('Local History: Show Project History'), run: () => ide.root && showHistory(ide.root, true) },
    { id: 'LocalHistory.PutLabel', title: tr('Local History: Put Label…'), run: putLabel },
  ].forEach(ide.registerAction);

  (ide.settingsPages ||= []).push({
    id: 'local-history', title: () => tr('Local History'), keywords: 'local history revisions revert label 로컬 기록 되돌리기',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Local History'));
      s.appendChild(ctx.ui.fieldRow(tr('Keep revisions for (days):'), ctx.ui.numberInput(SETTINGS.days, { min: 1, max: 365, fallback: 5 })));
      s.appendChild(ctx.ui.fieldRow(tr('Maximum storage (MB):'), ctx.ui.numberInput(SETTINGS.maxMB, { min: 10, max: 10000, fallback: 200 })));
      host.appendChild(el('div', 'muted settings-note', tr('A file is recorded from the first time it is opened or changes. Its latest revision is always kept, so it can be recovered after it is deleted.')));
    },
  });

  ide.localHistory = { checkpoint, show: showHistory, putLabel, ready: () => ready };
})();
