// Crash recovery of unsaved edits, like VS Code's hot exit (main/features/recovery.js keeps the files). Every window
// backs up its modified documents a moment after an edit and drops the backup once a document is saved, reverted,
// closed or no longer modified. When a project opens after PyIDE did not quit normally (a crash, a killed process, a
// power cut), the main window offers the backups made for that project and those made with no project open; backups
// of other projects wait until their project opens. Restore reopens each file with the backed-up text as an unsaved
// change; a file that changed on disk since is marked as a conflict, so saving it asks first (File Cache Conflict).
// An untitled document, or a file that no longer exists, comes back in a new scratch file. Discard deletes the backups;
// closing the dialog keeps them for the next start.
(() => {
  const { el, basename, isUnder } = ide.util;
  const SETTING = 'recovery.backup';
  const DEFAULTS = { [SETTING]: true };
  const enabled = () => ide.settings.get(SETTING, true) !== false;
  const invoke = (ch, ...args) => ide.api.invoke(`recovery:${ch}`, ...args);
  const log = ide.logger('#recovery');
  // A big document is written less often: each backup copies all of its text.
  const delayFor = (model) => (model.getValueLength() > 2e6 ? 10000 : 2000);

  // ---------- backing up ----------
  const states = new Map(); // model -> {timer, held: backed-up document id | null, version, queue}
  // Documents are keyed by the path they were opened with, which may differ from the model's in its slashes.
  const docOf = (model) => {
    if (model.isDisposed()) return null;
    const doc = ide.getDocument(model.uri.fsPath);
    return doc?.model === model ? doc : ide.tabs.find((t) => t.doc?.model === model)?.doc || null;
  };
  const docId = (doc) => (doc.untitled ? `untitled:${basename(doc.path)}` : doc.path.toLowerCase());

  function stateOf(model) {
    let s = states.get(model);
    if (s) return s;
    s = { timer: 0, held: null, version: 0, queue: Promise.resolve() };
    states.set(model, s);
    model.onWillDispose(() => {
      clearTimeout(s.timer);
      states.delete(model);
      enqueue(s, () => release(s));
    });
    return s;
  }
  // Backups of one document are written and dropped in order. Three failures in a row (a full disk, a user data
  // folder that cannot be written) are told once, in a notification; a backup written again starts the count over.
  let failures = 0;
  const enqueue = (s, fn) => (s.queue = s.queue.then(fn).catch(failed));
  function failed(err) {
    log.warn(`backup failed: ${ide.util.errorText(err)}`);
    if (++failures !== 3) return;
    ide.notifications.notify({
      title: tr('Unsaved changes are not being backed up'), text: ide.util.errorText(err), raw: true, kind: 'error', group: 'Crash Recovery',
    });
  }
  const release = async (s) => {
    if (!s.held) return;
    const id = s.held;
    s.held = null;
    await invoke('drop', id);
  };

  async function backUp(model, s) {
    const doc = docOf(model);
    if (!doc || !enabled() || model.getAlternativeVersionId() === doc.savedVersion) return release(s);
    const version = model.getAlternativeVersionId();
    const id = docId(doc);
    if (s.held === id && s.version === version) return;
    if (s.held && s.held !== id) await release(s);
    await invoke('put', {
      id, path: doc.untitled ? null : doc.path, name: basename(doc.path), untitled: !!doc.untitled,
      language: model.getLanguageId(), encoding: doc.encoding, lineSeparator: doc.lineSeparator, diskHash: doc.diskHash,
      asText: !!doc.forcedText, time: Date.now(), text: model.getValue(),
    });
    failures = 0;
    Object.assign(s, { held: id, version });
  }
  const flush = (model) => {
    if (model.isDisposed()) return Promise.resolve();
    const s = stateOf(model);
    clearTimeout(s.timer);
    return enqueue(s, () => backUp(model, s));
  };
  function schedule(model) {
    if (model.isDisposed() || model.uri.scheme !== 'file') return;
    const s = stateOf(model);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => flush(model), delayFor(model));
  }
  const flushAll = () => Promise.all([...states.keys()].map(flush));

  const follow = (model) => { if (model.uri.scheme === 'file') model.onDidChangeContent(() => schedule(model)); };
  ide.monaco.editor.getModels().forEach(follow);
  ide.monaco.editor.onDidCreateModel(follow);
  // Already modified when it opens: a peek view's edits, a detached window given unsaved text.
  ide.on('fileOpened', (tab) => tab?.model && schedule(tab.model));
  ide.on('fileSaved', (tab) => tab?.model && flush(tab.model));
  ide.on('settingsChanged', (key) => { if (key === SETTING) flushAll(); });
  // Saved in another window: this window's copy turned unmodified without an edit.
  ide.api.on('doc:saved', () => setTimeout(flushAll));
  // A plugin can mark a document saved without changing its text (tab.savedVersion after writing the file).
  setInterval(() => { for (const [model, s] of states) if (s.held) flush(model); }, 5000);
  // The session folder was deleted and made again: every backup this window holds is written again.
  ide.api.on('recovery:lost', () => {
    for (const s of states.values()) s.version = 0;
    flushAll();
  });
  invoke('hello').catch(() => {});

  // ---------- restoring ----------
  const label = (rec) => (rec.untitled ? tr('{name} (untitled)', { name: rec.name })
    : ide.root && isUnder(rec.path, ide.root) ? ide.util.rel(rec.path) : rec.path);

  function ask(list) {
    return new Promise((resolve) => {
      let choice = null;
      const items = el('ul', 'close-confirm-list');
      for (const rec of list) items.appendChild(el('li', null, label(rec)));
      const body = el('div');
      body.append(el('div', null, tr('PyIDE closed unexpectedly. Restore the unsaved changes in these files?')), items);
      const dlg = ide.ui.dialog({
        title: tr('Restore Unsaved Changes'),
        body,
        width: 520,
        onClose: () => resolve(choice),
        buttons: [
          { label: tr('Restore'), primary: true, run: () => { choice = 'restore'; } },
          { label: tr('Discard'), run: () => { choice = 'discard'; } },
        ],
      });
      dlg.el.id = 'recoveryDialog';
    });
  }

  // -> the document holding the backed-up text, or null.
  async function open(path, rec) {
    let tab = await ide.openFile(path, { text: rec.text, focus: false });
    if (!tab?.doc) tab = await ide.openFile(path, { text: rec.text, asText: true, focus: false });
    const doc = tab?.doc;
    if (doc && rec.lineSeparator && rec.lineSeparator !== doc.lineSeparator) ide.lineSeparators.convert?.(doc, rec.lineSeparator);
    return doc || null;
  }
  // -> true once the text is back in an editor.
  async function restoreOne(rec) {
    const text = await invoke('text', rec.ref);
    if (typeof text !== 'string') return false;
    rec = { ...rec, text };
    if (rec.path && !rec.untitled && await ide.api.exists(rec.path)) {
      const doc = await open(rec.path, rec);
      if (doc && rec.diskHash && doc.diskHash !== rec.diskHash) Object.assign(doc, { diskHash: rec.diskHash, conflict: true });
      return !!doc;
    }
    if (!ide.scratches) return false;
    const ext = /\.([a-z0-9]{1,10})$/i.exec(rec.name || '')?.[1] || 'txt';
    return !!(await open(await ide.scratches.create(ext), rec));
  }

  async function restore(list) {
    const failed = [];
    for (const rec of list) {
      let ok = false;
      try { ok = await restoreOne(rec); } catch (err) { log.warn(`cannot restore ${rec.path || rec.name}: ${ide.util.errorText(err)}`); }
      if (!ok) failed.push(rec);
    }
    ide.renderTabs();
    // The restored documents are backed up by this session before the old backups go.
    await flushAll();
    await invoke('consume', list.filter((r) => !failed.includes(r)).flatMap((r) => r.refs));
    if (failed.length) ide.ui.alert(tr('These files could not be restored; their backups are kept: {files}', { files: failed.map(label).join(', ') }));
  }

  let offering = null;
  async function offer() {
    const list = await invoke('pending', ide.root || null);
    if (!list.length) return;
    const choice = await ask(list);
    if (choice === 'restore') await restore(list);
    else if (choice === 'discard') await invoke('consume', list.flatMap((r) => r.refs));
    if (choice && document.activeElement === document.body) focusActiveTab();
  }
  // The dialog had the keyboard, and what it restored opened behind it without taking it. The active tab gets it (its
  // editor, or its page when the page can take it); otherwise the Project view does, as in PyCharm with no editor open.
  function focusActiveTab() {
    const tab = ide.activeTab();
    if (tab?.kind === 'file') ide.editor.focus();
    else if (tab?.host?.hasAttribute('tabindex')) tab.host.focus();
    else document.getElementById('tree')?.focus();
  }
  const offerOnce = () => { offering = (offering || Promise.resolve()).then(offer).catch((err) => log.warn(`recovery: ${ide.util.errorText(err)}`)); };

  if (!ide.detached) {
    const tellProject = () => invoke('project', ide.root || null).catch(() => {});
    let booted = false;
    ide.on('projectOpened', () => { tellProject(); if (booted) offerOnce(); });
    ide.on('projectClosed', tellProject);
    // At startup the last project opens first, so its backups are asked about once, with it.
    const boot = setInterval(() => {
      if (!window.__ideReady) return;
      clearInterval(boot);
      booted = true;
      offerOnce();
    }, 200);
  }

  // ---------- settings ----------
  (ide.settingsPages ||= []).push({
    id: 'recovery', group: 'appearance', title: () => tr('Crash Recovery'), defaults: DEFAULTS,
    keywords: 'crash recovery backup unsaved restore hot exit 비정상 종료 복구 백업 저장되지 않은 복원',
    mount(host, ctx) {
      const s = ctx.ui.section(host, tr('Crash Recovery'));
      s.appendChild(ctx.ui.checkbox(SETTING, tr('Back up unsaved changes and offer to restore them after PyIDE closes unexpectedly')));
      s.appendChild(el('div', 'muted settings-note', tr('Backups are kept in the PyIDE user data folder and removed when files are saved, closed without saving, or PyIDE quits normally.')));
    },
  });
})();
